"""Train 34 reconstructed settings on three chronological blocks, plus the user's model.

Run: python research/rebuild/run_benchmark.py
Every exported score is recomputed from persisted held-out predictions. No test
outcomes select architecture, epochs, hyperparameters, calibration, or weights.
"""
from pathlib import Path
import hashlib
import json
import os
import sys
import time
import warnings
from datetime import datetime,timezone

HERE=Path(__file__).resolve().parent
if (HERE/'python-deps').exists():sys.path.insert(0,str(HERE/'python-deps'))
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('MKL_NUM_THREADS','2')
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from threadpoolctl import threadpool_limits
from prepare_data import prepare,make_features,SEED
from classical_models import fit_predict,coherent,shape_features,scales,QS

ROOT=HERE.parents[1];PUBLIC=ROOT/'public'/'research';FINAL_WEIGHT=.7324572088988475
DEEP={'mlp','lstm','gru','tcn','transformer','neural-ode'}

def hash_file(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def calibrate(raw,bundle):
    n=int(bundle['cal_count']);test=raw[n:].copy();count={}
    for product in np.unique(bundle['product_eval']):
        available=np.flatnonzero(bundle['product_eval'][:n]==product);target=bundle['product_eval'][n:]==product
        assert len(available)>=7
        offset=np.array([np.quantile(bundle['y_eval'][available]-raw[available,k],tau) for k,tau in enumerate(QS)])
        test[target]+=offset;count[str(product)]=len(available)
    return coherent(test),count

def weighted_quantile(values,weights,tau):
    order=np.argsort(values,kind='stable');cumulative=np.cumsum(weights[order])/weights.sum()
    return values[order[min(int(np.searchsorted(cumulative,tau)),len(order)-1)]]

def custom_prediction(raw,bundle):
    n=int(bundle['cal_count']);columns=bundle['columns'].tolist();levels=scales(bundle['raw_X_eval'],columns)
    experts=np.stack([raw[k] for k in ['extra-trees','catboost','scaled-catboost','spline-ridge','weekday-8']],axis=1)
    dates=pd.to_datetime(bundle['dates_eval']);cal_start=dates[:n].min();weight_end=cal_start+pd.Timedelta(days=28)
    fit_rows=np.flatnonzero((dates<weight_end)&(np.arange(len(dates))<n))
    residual_rows=np.flatnonzero((dates>=weight_end)&(np.arange(len(dates))<n))
    assert len(fit_rows)>0 and len(residual_rows)>0
    def objective(w):
        point=np.einsum('nmk,m->nk',experts[fit_rows],w)
        error=(bundle['y_eval'][fit_rows,None]-point[:,[1,2]])/levels[fit_rows,None]
        tau=np.array([.5,.75]);return float(np.mean(np.maximum(tau*error,(tau-1)*error))+.01*np.sum((w-.2)**2))
    solution=minimize(objective,np.full(5,.2),method='SLSQP',bounds=[(0,1)]*5,constraints=[{'type':'eq','fun':lambda w:np.sum(w)-1}],options={'maxiter':1000,'ftol':1e-10})
    assert solution.success,solution.message
    weights=solution.x;assert np.min(weights)>=-1e-7 and abs(weights.sum()-1)<1e-6
    mix=np.einsum('nmk,m->nk',experts,weights);shape=shape_features(bundle['seq_eval']);ensemble=mix[n:].copy()
    for j,index in enumerate(range(n,len(dates))):
        rows=residual_rows[bundle['product_eval'][residual_rows]==bundle['product_eval'][index]]
        assert len(rows)>=7
        distance=np.sum((shape[rows]-shape[index])**2,axis=1);bandwidth=max(.001,float(np.median(distance)));similarity=.5+.5*np.exp(-distance/bandwidth)
        for k,tau in enumerate(QS):
            residual=(bundle['y_eval'][rows]-mix[rows,k])/levels[rows]
            ensemble[j,k]+=levels[index]*weighted_quantile(residual,similarity,tau)
    ensemble=coherent(ensemble);et,_=calibrate(raw['extra-trees'],bundle)
    final=coherent((1-FINAL_WEIGHT)*et+FINAL_WEIGHT*ensemble)
    return final,{'weights':weights.tolist(),'objective':float(solution.fun),'weightRows':len(fit_rows),'residualRows':len(residual_rows),'weightCutoff':str(dates[fit_rows].max().date()),'residualCutoff':str(dates[residual_rows].max().date()),'finalEnsembleWeight':FINAL_WEIGHT,'weightOptimizationSuccess':bool(solution.success)}

def scores(prediction,actual):
    p50=prediction[:,1];q75=prediction[:,2]
    rounded=np.rint(q75);quantity=np.ceil(np.where(np.abs(q75-rounded)<1e-9,rounded,q75)).astype(np.int64)
    error=np.abs(actual-p50);over=np.maximum(quantity-actual,0);under=np.maximum(actual-quantity,0)
    return {'n':len(actual),'actualTotal':float(actual.sum()),'wape':float(100*error.sum()/actual.sum()),'mae':float(error.mean()),'over':int(over.sum()),'under':int(under.sum()),'loss':int(over.sum()+3*under.sum())},quantity

def verify_outputs(benchmark,predictions,frame,metadata):
    assert len(benchmark['models'])==35
    assert sum(m['role']=='candidate' for m in benchmark['models'])==34
    assert len(benchmark['runs'])==105
    assert not predictions.duplicated(['modelId','splitId','date','product']).any()
    assert np.isfinite(predictions[['y','p50','q75','quantity']].to_numpy()).all()
    checks=[]
    for split in benchmark['splits']:
        expected=frame[(frame.date>=pd.Timestamp(split['testStart']))&(frame.date<=pd.Timestamp(split['testEnd']))]
        expected_keys=set(zip(expected.date.dt.strftime('%Y-%m-%d'),expected['product'].astype(int)))
        assert pd.Timestamp(split['trainEnd'])<pd.Timestamp(split['calibrationStart'])<=pd.Timestamp(split['calibrationEnd'])<pd.Timestamp(split['testStart'])
        for model in benchmark['models']:
            p=predictions[(predictions.modelId==model['id'])&(predictions.splitId==split['id'])]
            assert set(zip(p.date,p['product']))==expected_keys
            assert len(p)==split['n']
            row=next(r for r in benchmark['runs'] if r['modelId']==model['id'] and r['splitId']==split['id'])
            error=np.abs(p.y.to_numpy()-p.p50.to_numpy());over=np.maximum(p.quantity-p.y,0).sum();under=np.maximum(p.y-p.quantity,0).sum()
            assert abs(row['wape']-100*error.sum()/p.y.sum())<1e-9
            assert abs(row['mae']-error.mean())<1e-9
            assert row['over']==over and row['under']==under and row['loss']==over+3*under
            assert row['actualTotal']==p.y.sum()
        checks.append({'splitId':split['id'],'sameObservationKeysForAll35Models':True,'n':len(expected_keys),'trainingAndCalibrationBeforeTest':True})
    daily=pd.read_csv(HERE/'daily-sales.csv',parse_dates=['date']);original,seq,columns=make_features(daily)
    cutoff=pd.Timestamp('2023-09-01');mutated=daily.copy();mutated.loc[mutated.date>=cutoff,'y']+=100000
    changed,changed_seq,_=make_features(mutated);before=original.date<=cutoff
    np.testing.assert_allclose(original.loc[before,columns].to_numpy(float),changed.loc[before,columns].to_numpy(float),equal_nan=True)
    np.testing.assert_array_equal(seq[before],changed_seq[before])
    return {'status':'passed','candidateSettings':34,'timeBlocks':3,'candidateRuns':102,'customModelRuns':3,'totalCompletedRuns':105,'predictionRows':len(predictions),'allFinite':True,'duplicatePredictionKeys':0,'metricsIndependentlyRecomputedFromPredictions':True,'sameDayAndFutureOutcomeFeatureInvariance':True,'featureInputDatesStrictlyBeforeTarget':metadata['featureDateCheck'],'testDataUsedForParameterSelection':False,'historicalDatasetPreviouslyExplored':True,'checks':checks}

def main():
    started=time.time();PUBLIC.mkdir(parents=True,exist_ok=True)
    metadata=prepare();daily=pd.read_csv(HERE/'daily-sales.csv',parse_dates=['date']);frame=pd.read_csv(HERE/'feature-rows.csv',parse_dates=['date'])
    models=json.loads((HERE/'configs.json').read_text(encoding='utf-8'));runs=[];all_predictions=[];training=[]
    code_hashes={p.name:hash_file(p) for p in sorted(HERE.glob('*.py'))};code_hashes['configs.json']=hash_file(HERE/'configs.json')
    code_signature=hashlib.sha256(json.dumps(code_hashes,sort_keys=True).encode()).hexdigest()
    for split in metadata['splits']:
        with np.load(HERE/f"{split['id']}.npz",allow_pickle=False) as stored:bundle={key:stored[key] for key in stored.files}
        n=int(bundle['cal_count']);raw={};timings={}
        for number,model in enumerate([m for m in models if m['role']=='candidate']+[{'id':'scaled-catboost'}]):
            model_id=model['id'];cache=HERE/'cache'/f"{split['id']}-{model_id}.npz";begin=time.perf_counter();captured=[];detail={}
            print(f"START {split['id']} {model_id}",flush=True)
            if cache.exists():
                with np.load(cache,allow_pickle=False) as saved:
                    if str(saved['code_signature'])==code_signature and str(saved['feature_hash'])==split['featureHash']:
                        prediction=saved['prediction'];seconds=float(saved['seconds']);detail=json.loads(str(saved['detail']));captured=json.loads(str(saved['warnings']))
                    else:cache.unlink()
            if not cache.exists():
                with warnings.catch_warnings(record=True) as issued,threadpool_limits(limits=2):
                    warnings.simplefilter('always')
                    if model_id in DEEP:
                        import deep_models
                        prediction=deep_models.fit_predict(model_id,bundle['X_train'],bundle['seq_train'],bundle['y_train'],bundle['X_eval'],bundle['seq_eval'],seed=SEED,epochs=80)
                        detail=dict(deep_models.LAST_TRAINING_RUN)
                    else:prediction=fit_predict(model_id,bundle,daily,SEED)
                    captured=list(dict.fromkeys(str(w.message) for w in issued))[:20]
                seconds=time.perf_counter()-begin;prediction=coherent(prediction)
                np.savez_compressed(cache,prediction=prediction,seconds=seconds,detail=json.dumps(detail),warnings=json.dumps(captured),code_signature=code_signature,feature_hash=split['featureHash'])
            assert prediction.shape==(len(bundle['y_eval']),4)
            raw[model_id]=prediction;timings[model_id]=seconds
            training.append({'splitId':split['id'],'modelId':model_id,'seconds':seconds,'warnings':captured,**detail})
            if model_id=='scaled-catboost':continue
            corrected,counts=calibrate(prediction,bundle);metric,quantity=scores(corrected,bundle['y_eval'][n:])
            runs.append({'id':f"{split['id']}:{model_id}",'modelId':model_id,'splitId':split['id'],**metric,'fitSeconds':seconds,'status':'completed','warnings':captured})
            all_predictions.append(pd.DataFrame({'modelId':model_id,'splitId':split['id'],'date':bundle['dates_eval'][n:],'product':bundle['product_eval'][n:],'y':bundle['y_eval'][n:],'p50':corrected[:,1],'q75':corrected[:,2],'quantity':quantity}))
            print(f"DONE {split['id']} {model_id}: n={metric['n']} WAPE={metric['wape']:.4f} loss={metric['loss']} seconds={seconds:.2f}",flush=True)
        begin=time.perf_counter();final,details=custom_prediction(raw,bundle);seconds=time.perf_counter()-begin+sum(timings[k] for k in ['extra-trees','catboost','scaled-catboost','spline-ridge','weekday-8']);metric,quantity=scores(final,bundle['y_eval'][n:])
        runs.append({'id':f"{split['id']}:custom-final",'modelId':'custom-final','splitId':split['id'],**metric,'fitSeconds':seconds,'status':'completed','weights':details['weights']})
        all_predictions.append(pd.DataFrame({'modelId':'custom-final','splitId':split['id'],'date':bundle['dates_eval'][n:],'product':bundle['product_eval'][n:],'y':bundle['y_eval'][n:],'p50':final[:,1],'q75':final[:,2],'quantity':quantity}))
        training.append({'splitId':split['id'],'modelId':'custom-final',**details})
        print(f"DONE {split['id']} custom-final: n={metric['n']} WAPE={metric['wape']:.4f} loss={metric['loss']}",flush=True)
        (HERE/'progress.json').write_text(json.dumps({'completedSplits':len(runs)//35,'runs':runs},ensure_ascii=False,indent=2),encoding='utf-8')
    manifest=json.loads((HERE/'raw-manifest.json').read_text(encoding='utf-8'))
    benchmark={'version':'bakery-rebuild-2026-09-14-v1','generatedAt':datetime.now(timezone.utc).isoformat(),'seed':SEED,'status':'completed',
      'dataset':{'title':'독일 빵집 공개 일별 순판매수량 · 6개 상품','url':'https://github.com/lleisner/bakery_sales_forecasting/tree/'+manifest['ref']+'/data/raw_sources/sales','target':'관측 순판매수량(수요의 대리값)','unit':'개','rows':metadata['rows'],'products':metadata['products'],'start':metadata['start'],'end':metadata['end']},
      'protocol':{'description':'34개 후보 설정 × 3개 시간순 평가 구간 = 102회 실제 학습·평가, 내 최종 결합 모델 3회 별도 비교','features':metadata['columns'],'calibration':'평가 시작 전 56일의 상품별 오차로 고정 보정. 최종 모델은 보정기간 앞 28일로 5전문가 가중치를 학습하고 뒤 28일로 패턴 가중 오차를 보정. 평가 중에는 파라미터를 다시 선택하지 않습니다.',
        'notes':['이전 대화의 모델 계열을 이번 명시 설정으로 새로 구현·학습했습니다. 이전 102개 실행의 원본 재현이나 현재 앱에 내장된 체크포인트의 평가가 아닙니다.','같은 6개 상품을 세 구간에서 시간순 비교합니다. 이전의 개발 상품/새 상품 검증 설계와 다릅니다. 이미 이전 탐색에 사용된 공개 자료이므로 독립 미사용 검증 또는 최종 우위 입증으로 해석할 수 없습니다.','판매 없는 날짜를 0으로 만들지 않습니다. 원자료의 관측 날짜만 채점하며 결측 날짜는 입력 마스크로 보존합니다. 시간대 음수는 반품·취소가 반영된 순수량으로 합산하고 일합계 음수 3행은 제외했습니다.','모든 모델이 같은 날짜·상품의 실적을 사용합니다. P50으로 WAPE/MAE를 계산하고 P75를 정수로 올려 과다+3×부족을 계산합니다. 초기 재고 0, 낱개 생산, 생산 한도 없음의 공통 모의 조건입니다.','평가일 이전 실제 판매는 다음 날 예측 입력에 사용할 수 있습니다. 당일 및 미래 판매는 입력에서 제외합니다. 시계열 상태는 과거 관측으로만 갱신하고 계수는 재학습하지 않습니다.','3:1은 사용자가 선택한 가정이며 실제 금전 손실이나 실측 폐기량이 아닙니다. 품절 표시는 원자료에 없어 판매량을 미충족 수요와 구분할 수 없습니다.','고정 최종 결합 비율은 ET 0.2675427911011525 + 보정 앙상블 0.7324572088988475이며 새 평가 점수로 조정하지 않았습니다.','fitSeconds는 학습·추론 수행시간입니다. 최종 모델 시간은 재사용한 구성모델 실행시간을 포함합니다. 원자료 필터와 원 연구 추가필터가 달라 기존 2,111행 학습팩과 일치시키지 않았습니다.']},
      'splits':metadata['splits'],'models':models,'runs':runs,'artifacts':{'predictionsCsv':'/research/predictions.csv','resultsCsv':'/research/results.csv','methodologyUrl':'/research/methodology.md','verificationUrl':'/research/verification.json','sourceManifestUrl':'/research/source-manifest.json'}}
    predictions=pd.concat(all_predictions,ignore_index=True);verification=verify_outputs(benchmark,predictions,frame,metadata)
    predictions.to_csv(PUBLIC/'predictions.csv',index=False,float_format='%.12g');pd.DataFrame(runs).drop(columns=['weights','warnings'],errors='ignore').to_csv(PUBLIC/'results.csv',index=False,float_format='%.12g')
    import importlib.metadata
    versions={p:importlib.metadata.version(p) for p in ['numpy','pandas','scipy','scikit-learn','statsmodels','lightgbm','xgboost','catboost','torch']}
    provenance={'source':manifest,'codeSha256':code_hashes,'codeSignature':code_signature,'packages':versions,'dataQuality':metadata['quality'],'seed':SEED,'elapsedSeconds':time.time()-started,'training':training,'disclosure':'Only selected public product/date sales and derived predictions are exported; no user store data is included.'}
    (PUBLIC/'benchmark.json').write_text(json.dumps(benchmark,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (PUBLIC/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (PUBLIC/'source-manifest.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    methodology='# 새로 구성한 102회 비교 실험\n\n'+benchmark['protocol']['description']+'\n\n'+''.join('- '+note+'\n' for note in benchmark['protocol']['notes'])+'\n## 원자료\n\n'+benchmark['dataset']['url']+'\n\n'+'시간대 판매수량 열을 날짜·상품별 합산했습니다. 원본 자료의 출처와 SHA-256은 source-manifest.json에 있습니다. 결과는 관측 순판매수량의 파생 연구 자료이며 원본 Excel 파일은 이 다운로드에 포함하지 않습니다.\n\n## 검증\n\n'+json.dumps(verification,ensure_ascii=False,indent=2)+'\n\n## 모델 설정\n\n'+''.join(f"- **{m['name']}**: {m['parameters']}\n" for m in models)
    (PUBLIC/'methodology.md').write_text(methodology,encoding='utf-8')
    print(json.dumps({'status':'completed','runs':len(runs),'predictionRows':len(predictions),'seconds':time.time()-started,'verification':verification},ensure_ascii=True),flush=True)

if __name__=='__main__':main()
