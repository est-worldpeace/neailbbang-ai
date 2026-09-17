"""Export the real research estimators to portable, inference-only numeric data.

This re-fits the existing German-data experiment settings. It does not train on
the app user's store. New store forecasts must be evaluated prospectively.
Run with --source-root pointing to the original analysis_cache directory.
"""
from pathlib import Path
import sys, json, argparse, hashlib

parser=argparse.ArgumentParser()
parser.add_argument('--source-root',type=Path,required=True)
args=parser.parse_args()
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(args.source_root/'math_suite'))
from common import *
import classical
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler,SplineTransformer
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import Ridge
from scipy.interpolate import BSpline,PPoly
sys.path.insert(0,str(ROOT/"work/python-deps"))
from catboost import CatBoostRegressor
sys.path.insert(0,str(args.source_root/'challenger'))
import experiment as challenger

raw=load_data('development')
fold=prepare_fold(raw,'2023-07-01','2023-08-31')
a=fold['fit'];v=fold['cp'];cols=fold['cols'];y=a.y.to_numpy()
imp=SimpleImputer(strategy='median');sx=StandardScaler()
xs=sx.fit_transform(imp.fit_transform(a[cols]));vs=sx.transform(imp.transform(v[cols]))
pack={'version':'bakery-research-port-1.0','training_source':'German bakery public sales; original experiment development SKUs',
      'source_url':'https://github.com/lleisner/bakery_sales_forecasting/tree/d4c8fb84140964a122bbbd851e712b1f11ef3a69/data/raw_sources/sales',
      'train_start':str(a.date.min().date()),'train_end':str(a.date.max().date()),'training_rows':len(a),
      'products':[int(x) for x in sorted(a['product'].unique())], 'quantiles':QS.tolist(),'seed':SEED,'columns':cols,
      'impute':imp.statistics_.tolist(),'mean':sx.mean_.tolist(),'scale':sx.scale_.tolist(),
      'final_ensemble_weight':0.7324572088988475,
      'scope':'Fitted research base estimators. Unseen app product IDs have all-zero product indicators. Store transfer is unvalidated. App uses rolling historical residual correction; no automatic base-model retraining.'}

print('Training Extra Trees',len(a),flush=True)
et=ExtraTreesRegressor(n_estimators=200,min_samples_leaf=10,max_depth=12,max_features=.8,random_state=SEED,n_jobs=1).fit(xs,y)
trees=[]
for tree in et.estimators_:
    leaves=tree.apply(xs);z=tree.tree_;nodes=[]
    for n in range(z.node_count):
        if z.children_left[n]<0:
            values,counts=np.unique(y[leaves==n].astype(int),return_counts=True)
            nodes.append([-1,values.tolist(),(counts/counts.sum()).tolist()])
        else:nodes.append([int(z.feature[n]),float(z.threshold[n]),int(z.children_left[n]),int(z.children_right[n])])
    trees.append(nodes)
pack['et']={'trees':trees}

print('Training spline Ridge',flush=True)
cont=[i for i,c in enumerate(cols) if not c.startswith(('prod','dow'))]
other=[i for i in range(len(cols)) if i not in cont]
tr=ColumnTransformer([('splines',SplineTransformer(n_knots=4,degree=2,include_bias=False,extrapolation='linear'),cont),('other','passthrough',other)])
xx=tr.fit_transform(xs);ridge=Ridge(alpha=10).fit(xx,y)
sp=tr.named_transformers_['splines'];pieces=[];offset=0
for j,bs in enumerate(sp.bsplines_):
    n=bs.c.shape[0]-1
    spline=BSpline(bs.t,np.r_[ridge.coef_[offset:offset+n],0],bs.k)
    pp=PPoly.from_spline(spline)
    low=float(bs.t[bs.k]);high=float(bs.t[-bs.k-1])
    pieces.append({'feature':cont[j],'knots':pp.x.tolist(),'coefficients':pp.c.T.tolist(),
                   'low':low,'high':high,'left_value':float(spline(low)),'left_slope':float(spline(low,1)),
                   'right_value':float(spline(high)),'right_slope':float(spline(high,1))})
    offset+=n
pack['ridge']={'intercept':float(ridge.intercept_),'splines':pieces,'other':other,'coef':ridge.coef_[offset:].tolist()}

def export_cat(model,tag):
    temp=ROOT/'research'/f'{tag}.temp.json';model.save_model(str(temp),format='json')
    z=json.loads(temp.read_text());temp.unlink()
    mapping={i:int(f['flat_feature_index']) for i,f in enumerate(z['features_info']['float_features'])}
    return {'columns':model.feature_names_,'scale':z['scale_and_bias'][0],'bias':z['scale_and_bias'][1],
            'trees':[{'splits':[[mapping[s['float_feature_index']],s['border']] for s in t.get('splits',[])],
                      'values':t['leaf_values']} for t in z['oblivious_trees']]}

print('Training CatBoost',flush=True)
cat=CatBoostRegressor(loss_function='MultiQuantile:alpha=0.1,0.5,0.75,0.9',iterations=250,depth=4,learning_rate=.05,l2_leaf_reg=3,random_seed=SEED,thread_count=1,verbose=False,allow_writing_files=False).fit(a[cols],y)
pack['cat']=export_cat(cat,'cat')

print('Training scaled recent CatBoost',flush=True)
sa=np.maximum(a.mean28.fillna(a.median56).fillna(1).values,1.)
sv=np.maximum(v.mean28.fillna(v.median56).fillna(1).values,1.)
xa=a[cols].copy();xv=v[cols].copy()
for c in cols:
    if c.startswith(('lag','mean','std','median','weekday_med')) or c=='trend':
        xa[c]/=sa;xv[c]/=sv
xa['loglevel']=np.log1p(sa);xv['loglevel']=np.log1p(sv)
sha=challenger.shape_features(a);shv=challenger.shape_features(v)
for j in range(sha.shape[1]):xa[f'psd{j}']=sha[:,j];xv[f'psd{j}']=shv[:,j]
sw=np.exp2(-(fold['fit_end']-a.date).dt.days.to_numpy()/180)
scaled=CatBoostRegressor(loss_function='MultiQuantile:alpha=0.1,0.5,0.75,0.9',iterations=500,depth=4,learning_rate=.03,l2_leaf_reg=5,random_seed=SEED,thread_count=1,verbose=False,allow_writing_files=False).fit(xa,y/sa,sample_weight=sw)
pack['scaled']=export_cat(scaled,'scaled')

ROOT.joinpath('public/models').mkdir(parents=True,exist_ok=True)
dest=ROOT/'public/models/research-v1.json'
dest.write_text(json.dumps(pack,separators=(',',':'),allow_nan=False))

# Portable inference is checked against Python, including sparse/unknown SKU features.
ix=np.linspace(0,len(v)-1,20).astype(int)
X=v[cols].iloc[ix].copy()
X.loc[X.index[::2],[c for c in cols if c.startswith('prod')]]=0
X.iloc[1,0]=np.nan
Xstd=sx.transform(imp.transform(X))
Xsc=X.copy();scale=sv[ix];shape=shv[ix]
for c in cols:
    if c.startswith(('lag','mean','std','median','weekday_med')) or c=='trend':Xsc[c]/=scale
Xsc['loglevel']=np.log1p(scale)
for j in range(shape.shape[1]):Xsc[f'psd{j}']=shape[:,j]
hist=np.zeros((len(ix),int(y.max())+1))
for tree in et.estimators_:
    trainleaf=tree.apply(xs);testleaf=tree.apply(Xstd)
    for leaf in np.unique(testleaf):
        yy=y[trainleaf==leaf].astype(int)
        hist[testleaf==leaf]+=np.bincount(yy,minlength=hist.shape[1])/len(yy)
fixtures={'rows':[]}
expected=[coherent(classical.quant_cdf(hist)),coherent(cat.predict(X)),coherent(np.repeat(ridge.predict(tr.transform(Xstd))[:,None],4,axis=1)),coherent(scaled.predict(Xsc)*scale[:,None])]
for j in range(len(ix)):
    fixtures['rows'].append({'x':{c:None if pd.isna(X.iloc[j][c]) else float(X.iloc[j][c]) for c in cols},
       'shape':shape[j].tolist(),'scale':float(scale[j]),'expected':[e[j].tolist() for e in expected]})
fixtures['feature_rows']=[]
for j in ix[::4]:
    row=v.iloc[j];h=raw[(raw['product']==row['product']) & (raw.date<row.date) & (raw.date>=row.date-pd.Timedelta(days=70))].copy()
    fixtures['feature_rows'].append({'target':str(row.date.date()),'product':int(row['product']),
       'history':[{'date':str(r.date.date()),'sales':None if pd.isna(r.y) else float(r.y)} for r in h.itertuples()],
       'x':{c:None if pd.isna(row[c]) else float(row[c]) for c in cols},'shape':shv[j].tolist()})
(ROOT/'research/port-fixtures.json').write_text(json.dumps(fixtures,allow_nan=False,separators=(',',':')))
(ROOT/'research/model-provenance.json').write_text(json.dumps({k:pack[k] for k in ['version','source_url','train_start','train_end','training_rows','products','scope']}|{'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size},indent=2))
print('EXPORTED',dest.stat().st_size,'bytes',flush=True)
