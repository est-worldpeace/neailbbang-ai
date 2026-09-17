"""Parse the six public workbooks and prepare causal one-day-ahead features."""
from pathlib import Path
import hashlib
import json
import sys
from datetime import time as dt_time

HERE=Path(__file__).resolve().parent
if (HERE/'python-deps').exists():sys.path.insert(0,str(HERE/'python-deps'))
import numpy as np
import pandas as pd

PRODUCTS=[11,12,13,21,35,82]
SEED=20260914
SPLIT_DATES=[('split-1','2023년 7–8월','2023-07-01','2023-08-31'),('split-2','2023년 9–10월','2023-09-01','2023-10-31'),('split-3','2023년 11–12월','2023-11-01','2023-12-11')]

def parse_raw():
    parts=[];negative_cells=0
    for filename in sorted((HERE/'raw').glob('*.xlsx')):
        book_file=pd.ExcelFile(filename)
        first=pd.read_excel(book_file,sheet_name=0)
        sheets={book_file.sheet_names[0]:first}
        for sheet_name in book_file.sheet_names[1:]:
            sheets[sheet_name]=pd.read_excel(book_file,sheet_name=sheet_name,header=None,names=first.columns)
        tables=[]
        for sheet,frame in sheets.items():
            columns=[column for column in frame.columns if isinstance(column,dt_time) or (':' in str(column) and str(column)[0].isdigit())]
            if 'Nummer' not in frame or not columns:continue
            numeric=frame[columns].apply(pd.to_numeric,errors='coerce')
            part=pd.DataFrame({'date':frame.iloc[:,0],'product':pd.to_numeric(frame['Nummer'],errors='coerce'),'name':frame['Name'],'y':numeric.sum(axis=1,min_count=1),'sourceFile':filename.name,'sourceSheet':sheet})
            selected=part['product'].isin(PRODUCTS)
            negative_cells+=int((numeric[selected]<0).sum().sum())
            tables.append(part)
        book=pd.concat(tables,ignore_index=True)
        book['date']=pd.to_datetime(book['date'].ffill(),dayfirst=True,errors='coerce')
        parts.append(book[book['product'].isin(PRODUCTS)&book['date'].notna()])
    raw=pd.concat(parts,ignore_index=True).sort_values(['date','product'])
    assert not raw.duplicated(['date','product']).any(),'Unexpected duplicate product/date in source'
    negative=raw[raw.y<0]
    report={'rawSelectedRows':len(raw),'allHoursMissingRows':int(raw.y.isna().sum()),'negativeHourlyCells':negative_cells,'negativeDailyRowsExcluded':len(negative),'negativeDailyRecords':json.loads(negative[['date','product','y']].to_json(orient='records',date_format='iso')),'duplicateProductDates':0}
    clean=raw[raw.y.notna()&(raw.y>=0)].copy();clean['product']=clean['product'].astype(int)
    assert len(clean)==3505,'Independent workbook audit expects 3,505 nonnegative observed rows'
    assert (clean.y%1==0).all()
    clean.to_csv(HERE/'daily-sales.csv',index=False)
    (HERE/'raw-quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return clean,report

def make_features(daily):
    frames=[];sequences=[]
    for product in PRODUCTS:
        one=daily[daily['product']==product].set_index('date').sort_index()
        y=one.y.reindex(pd.date_range(daily.date.min(),daily.date.max(),freq='D'))
        x=pd.DataFrame(index=y.index)
        for lag in [1,2,3,7,14,21,28]:x[f'lag{lag}']=y.shift(lag)
        for window in [7,14,28,56]:
            past=y.shift(1).rolling(window,min_periods=2)
            x[f'mean{window}']=past.mean();x[f'median{window}']=past.median();x[f'std{window}']=past.std()
        same=pd.concat([y.shift(7*k) for k in range(1,9)],axis=1)
        x['weekday_med8']=same.median(axis=1);x['trend']=x.mean7-x.mean28
        day=(x.index-pd.to_datetime(x.index.year.astype(str)+'-01-01')).days
        for k in [1,2]:x[f'sin{k}']=np.sin(k*2*np.pi*day/365.25);x[f'cos{k}']=np.cos(k*2*np.pi*day/365.25)
        for k in range(7):x[f'dow_{k}']=(x.index.dayofweek==k).astype(float)
        for p in PRODUCTS:x[f'prod{p}']=float(p==product)
        x['date']=x.index;x['product']=product;x['y']=y
        x['history_count']=y.notna().astype(int).cumsum().shift(1,fill_value=0)
        seen=pd.Series(pd.NaT,index=y.index,dtype='datetime64[ns]');seen[y.notna()]=y.index[y.notna()]
        x['latest_input_date']=seen.ffill().shift(1)
        x['eligible']=y.notna()&(x.history_count>=7)
        selected=x[x.eligible].copy()
        indices=y.index.get_indexer(selected.index);values=y.to_numpy(dtype=float)
        seq=np.zeros((len(indices),28,2),dtype=np.float64)
        for j,i in enumerate(indices):
            past=values[max(0,i-28):i];offset=28-len(past)
            seq[j,offset:,0]=np.nan_to_num(past,nan=0.0);seq[j,offset:,1]=np.isfinite(past)
        frames.append(selected);sequences.append(seq)
    result=pd.concat(frames,ignore_index=True);seq=np.concatenate(sequences)
    order=np.lexsort((result['product'].to_numpy(),result.date.to_numpy()))
    result=result.iloc[order].reset_index(drop=True);seq=seq[order]
    assert (result.latest_input_date<result.date).all()
    columns=[c for c in result if c not in ['date','product','y','history_count','latest_input_date','eligible']]
    assert len(columns)==38
    return result,seq,columns

def prepare():
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import StandardScaler
    (HERE/'cache').mkdir(exist_ok=True)
    daily,quality=parse_raw();frame,seq,columns=make_features(daily)
    frame.to_csv(HERE/'feature-rows.csv',index=False)
    splits=[]
    for split_id,label,start,end in SPLIT_DATES:
        test_start=pd.Timestamp(start);test_end=pd.Timestamp(end)
        cal_start=test_start-pd.Timedelta(days=56);train_end=cal_start-pd.Timedelta(days=1)
        train=(frame.date<=train_end).to_numpy();cal=((frame.date>=cal_start)&(frame.date<test_start)).to_numpy();test=((frame.date>=test_start)&(frame.date<=test_end)).to_numpy();evaluate=cal|test
        assert frame.loc[train,'date'].max()<frame.loc[cal,'date'].min()<frame.loc[test,'date'].min()
        imp=SimpleImputer(strategy='median');scaler=StandardScaler()
        xtrain=scaler.fit_transform(imp.fit_transform(frame.loc[train,columns]));xeval=scaler.transform(imp.transform(frame.loc[evaluate,columns]))
        feature_hash=hashlib.sha256(xtrain.astype('<f8').tobytes()+xeval.astype('<f8').tobytes()).hexdigest()
        meta={'id':split_id,'label':label,'trainStart':str(frame.loc[train,'date'].min().date()),'trainEnd':str(train_end.date()),'calibrationStart':str(cal_start.date()),'calibrationEnd':str((test_start-pd.Timedelta(days=1)).date()),'testStart':start,'testEnd':end,'n':int(test.sum()),'trainN':int(train.sum()),'calibrationN':int(cal.sum()),'featureHash':feature_hash}
        np.savez_compressed(HERE/f'{split_id}.npz',X_train=xtrain,X_eval=xeval,seq_train=seq[train],seq_eval=seq[evaluate],y_train=frame.loc[train,'y'].to_numpy(float),y_eval=frame.loc[evaluate,'y'].to_numpy(float),product_train=frame.loc[train,'product'].to_numpy(int),product_eval=frame.loc[evaluate,'product'].to_numpy(int),dates_train=frame.loc[train,'date'].dt.strftime('%Y-%m-%d').to_numpy(str),dates_eval=frame.loc[evaluate,'date'].dt.strftime('%Y-%m-%d').to_numpy(str),raw_X_train=frame.loc[train,columns].to_numpy(float),raw_X_eval=frame.loc[evaluate,columns].to_numpy(float),cal_count=int(cal.sum()),columns=np.array(columns),meta=json.dumps(meta),impute=imp.statistics_,mean=scaler.mean_,scale=scaler.scale_)
        splits.append(meta)
    names=[{'id':product,'name':str(daily.loc[daily['product']==product,'name'].mode().iloc[0])} for product in PRODUCTS]
    metadata={'splits':splits,'columns':columns,'rows':len(daily),'featureRows':len(frame),'products':names,'start':str(daily.date.min().date()),'end':str(daily.date.max().date()),'quality':quality,'featureDateCheck':bool((frame.latest_input_date<frame.date).all()),'seed':SEED}
    (HERE/'prepared.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(metadata,ensure_ascii=True,indent=2),flush=True)
    return metadata

if __name__=='__main__':prepare()
