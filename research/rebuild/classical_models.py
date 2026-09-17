"""Actual estimators for the 28 non-neural settings, reconstructed for this run."""
from pathlib import Path
import warnings
import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import lsq_linear
from sklearn.linear_model import Ridge,ElasticNet,HuberRegressor,QuantileRegressor,PoissonRegressor
from sklearn.preprocessing import SplineTransformer
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesRegressor,RandomForestRegressor,HistGradientBoostingRegressor
from sklearn.neighbors import KNeighborsRegressor
from sklearn.svm import SVR

QS=np.array([.1,.5,.75,.9])
HERE=Path(__file__).resolve().parent

def coherent(values):
    q=np.maximum(0,np.asarray(values,dtype=float))
    q[:,0]=np.minimum(q[:,0],q[:,1]);q[:,2]=np.maximum(q[:,2],q[:,1]);q[:,3]=np.maximum(q[:,3],q[:,2])
    assert np.isfinite(q).all(),'Nonfinite predictions'
    return q

def constant_quantiles(point):return np.repeat(np.asarray(point)[:,None],4,axis=1)

def forest_quantiles(model,xtrain,y,xeval):
    maximum=int(np.max(y));hist=np.zeros((len(xeval),maximum+1))
    for tree in model.estimators_:
        train_leaf=tree.apply(xtrain);eval_leaf=tree.apply(xeval)
        for leaf in np.unique(eval_leaf):
            observed=y[train_leaf==leaf].astype(int)
            mass=np.bincount(observed,minlength=maximum+1)/len(observed)
            hist[eval_leaf==leaf]+=mass
    cdf=hist.cumsum(axis=1)/len(model.estimators_)
    return np.column_stack([(cdf>=q).argmax(axis=1) for q in QS])

def shape_features(seq):
    observed=seq[:,:,1]>0;count=observed.sum(axis=1)
    mu=np.divide((seq[:,:,0]*observed).sum(axis=1),np.maximum(count,1))
    z=np.where(observed,seq[:,:,0],mu[:,None])-mu[:,None]
    z=z/np.maximum(1,np.sqrt(np.mean(z*z,axis=1)))[:,None]
    power=np.abs(np.fft.rfft(z,axis=1)[:,1:15])**2
    spectrum=np.sqrt(power/np.maximum(1,power.sum(axis=1))[:,None])
    return np.column_stack([spectrum,z[:,-7:].mean(axis=1),z[:,-14:-7].mean(axis=1)])

def scales(raw,columns):
    a=raw[:,columns.index('mean28')];b=raw[:,columns.index('median56')]
    return np.maximum(1,np.where(np.isfinite(a),a,np.where(np.isfinite(b),b,1)))

def baseline(name,bundle,daily):
    output=[];by_product={p:group.set_index('date').y for p,group in daily.groupby('product')}
    for product,date in zip(bundle['product_eval'],bundle['dates_eval']):
        date=pd.Timestamp(str(date));history=by_product[product]
        if name=='recent-7':values=history.reindex(pd.date_range(date-pd.Timedelta(days=7),date-pd.Timedelta(days=1))).dropna().to_numpy()
        elif name=='weekday-8':values=history.reindex([date-pd.Timedelta(days=7*k) for k in range(1,9)]).dropna().to_numpy()
        else:
            lag=1 if name=='last-day' else 7;value=history.get(date-pd.Timedelta(days=lag),np.nan)
            values=np.array([value]) if np.isfinite(value) else np.array([])
        if not len(values):values=history[history.index<date].tail(7).to_numpy()
        assert len(values)
        output.append(np.quantile(values,QS))
    return coherent(output)

def time_series(name,bundle,daily):
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    from statsmodels.tsa.statespace.structural import UnobservedComponents
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    meta=__import__('json').loads(str(bundle['meta']));train_end=pd.Timestamp(meta['trainEnd']);last_date=pd.Timestamp(meta['testEnd'])
    prediction=np.zeros((len(bundle['dates_eval']),4))
    for product in np.unique(bundle['product_eval']):
        observed=daily[daily['product']==product].set_index('date').y.sort_index()
        calendar=observed.reindex(pd.date_range(observed.index.min(),last_date,freq='D'))
        train=np.log1p(calendar[calendar.index<=train_end].to_numpy(float))
        by_date={str(date):i for i,(p,date) in enumerate(zip(bundle['product_eval'],bundle['dates_eval'])) if p==product}
        if name=='holt':
            filled=pd.Series(train).ffill().to_numpy()
            fit=ExponentialSmoothing(filled,trend='add',damped_trend=True,initialization_method='estimated').fit(optimized=True,remove_bias=False)
            alpha=fit.params['smoothing_level'];beta=fit.params['smoothing_trend'];phi=fit.params['damping_trend'];level=float(fit.level[-1]);trend=float(fit.trend[-1]);sd=max(float(np.nanstd(fit.resid)),.001)
        else:
            model=SARIMAX(train,order=(1,0,1),seasonal_order=(1,0,0,7),trend='c',enforce_stationarity=True,enforce_invertibility=True) if name=='sarima' else UnobservedComponents(train,level='local linear trend',seasonal=7,stochastic_seasonal=True)
            fit=model.fit(disp=False,maxiter=100)
        for date in pd.date_range(train_end+pd.Timedelta(days=1),last_date,freq='D'):
            if name=='holt':mu=level+phi*trend
            else:
                forecast=fit.get_forecast(1);mu=float(np.asarray(forecast.predicted_mean)[0]);sd=np.sqrt(max(float(np.asarray(forecast.var_pred_mean)[0]),1e-8))
            key=str(date.date())
            if key in by_date:prediction[by_date[key]]=np.maximum(0,np.expm1(np.clip(mu+stats.norm.ppf(QS)*sd,-20,20)))
            actual=calendar.get(date,np.nan);value=np.log1p(actual) if np.isfinite(actual) else np.nan
            if name=='holt':
                if np.isfinite(value):new_level=alpha*value+(1-alpha)*(level+phi*trend);trend=beta*(new_level-level)+(1-beta)*phi*trend;level=new_level
                else:level=mu;trend*=phi
            else:fit=fit.append(np.array([value]),refit=False)
    return coherent(prediction)

def differential(name,bundle,daily,seed):
    columns=bundle['columns'].tolist();calendar_cols=[j for j,c in enumerate(columns) if c.startswith(('sin','cos','dow_'))]
    output=np.zeros((len(bundle['dates_eval']),4));rng=np.random.default_rng(seed)
    for product in np.unique(bundle['product_eval']):
        train=bundle['product_train']==product;evaluate=bundle['product_eval']==product
        calendar=Ridge(alpha=1).fit(bundle['X_train'][train][:,calendar_cols],np.log1p(bundle['y_train'][train]))
        tr_dates=pd.to_datetime(bundle['dates_train'][train]);residual=np.log1p(bundle['y_train'][train])-calendar.predict(bundle['X_train'][train][:,calendar_cols])
        consecutive=np.diff(tr_dates.values).astype('timedelta64[D]').astype(int)==1
        z=residual[:-1][consecutive];delta=np.diff(residual)[consecutive]
        if name=='ou-sde':
            drift=lsq_linear(np.column_stack([np.ones(len(z)),-z]),delta,bounds=([-np.inf,.001],[np.inf,5])).x
            a,k=drift;g=0.;fitted=a-k*z
        else:
            drift=lsq_linear(np.column_stack([np.ones(len(z)),-z,-z**3]),delta,bounds=([-np.inf,0,0],[np.inf,5,5])).x
            a,k,g=drift;fitted=a-k*z-g*z**3
        sigma=max(float(np.std(delta-fitted)),.001)
        observed=daily[daily['product']==product].set_index('date').y.sort_index()
        # Calendar regression is evaluated with each past day's known calendar fields.
        def cal_x(date):
            date=pd.Timestamp(str(date));doy=(date-pd.Timestamp(f'{date.year}-01-01')).days
            raw={**{f'sin{j}':np.sin(j*2*np.pi*doy/365.25) for j in [1,2]},**{f'cos{j}':np.cos(j*2*np.pi*doy/365.25) for j in [1,2]},**{f'dow_{j}':float(date.dayofweek==j) for j in range(7)}}
            return np.array([(raw[columns[c]]-bundle['mean'][c])/bundle['scale'][c] for c in calendar_cols])[None,:]
        for i in np.flatnonzero(evaluate):
            date=pd.Timestamp(str(bundle['dates_eval'][i]));past=observed[observed.index<date];previous_date=past.index[-1]
            start=float(np.log1p(past.iloc[-1])-calendar.predict(cal_x(previous_date))[0]);duration=max(1,(date-previous_date).days);base=float(calendar.predict(bundle['X_eval'][i:i+1,calendar_cols])[0])
            if name=='ou-sde':
                equilibrium=a/k;decay=np.exp(-k*duration);mu=equilibrium+(start-equilibrium)*decay;sd=sigma*np.sqrt((1-decay*decay)/(2*k));samples=mu+stats.norm.ppf(QS)*sd
            else:
                steps=20*duration;dt=duration/steps
                values=np.full(256 if name=='nonlinear-sde' else 1,start)
                for _ in range(steps):
                    drift=a-k*values-g*values**3
                    values+=drift*dt/(1+np.abs(drift)*dt)
                    if name=='nonlinear-sde':values+=sigma*np.sqrt(dt)*rng.standard_normal(len(values))
                samples=np.quantile(values,QS)
            output[i]=np.maximum(0,np.expm1(np.clip(base+samples,-20,20)))
    return coherent(output)

def fit_predict(name,bundle,daily,seed):
    X=bundle['X_train'];V=bundle['X_eval'];y=bundle['y_train'];columns=bundle['columns'].tolist()
    if name in ['last-day','last-week','recent-7','weekday-8']:return baseline(name,bundle,daily)
    if name in ['sarima','state-space','holt']:return time_series(name,bundle,daily)
    if name in ['ou-sde','nonlinear-ode','nonlinear-sde']:return differential(name,bundle,daily,seed)
    if name=='ridge':model=Ridge(alpha=10)
    elif name=='elastic-net':model=ElasticNet(alpha=.1,l1_ratio=.25,max_iter=5000,random_state=seed)
    elif name=='huber':model=HuberRegressor(epsilon=1.35,alpha=.0001,max_iter=500)
    elif name=='svr':model=SVR(C=10,epsilon=.1)
    elif name=='knn':model=KNeighborsRegressor(n_neighbors=15,weights='distance',n_jobs=2)
    elif name=='spline-ridge':
        continuous=[i for i,c in enumerate(columns) if not c.startswith(('prod','dow'))];other=[i for i in range(len(columns)) if i not in continuous]
        transform=ColumnTransformer([('spline',SplineTransformer(n_knots=4,degree=2,include_bias=False,extrapolation='linear'),continuous),('other','passthrough',other)])
        X=transform.fit_transform(X);V=transform.transform(V);model=Ridge(alpha=10)
    elif name in ['linear-quantile-0','linear-quantile-1']:
        alpha=0 if name.endswith('-0') else 1
        return coherent(np.column_stack([QuantileRegressor(quantile=q,alpha=alpha,solver='highs').fit(X,y).predict(V) for q in QS]))
    elif name=='poisson':
        mu=PoissonRegressor(alpha=1,max_iter=500).fit(X,y).predict(V)
        return coherent(np.column_stack([stats.poisson.ppf(q,np.maximum(mu,.001)) for q in QS]))
    elif name=='negative-binomial':
        import statsmodels.api as sm
        train=sm.add_constant(X,has_constant='add');test=sm.add_constant(V,has_constant='add')
        poisson=PoissonRegressor(alpha=1,max_iter=500).fit(X,y);mu=poisson.predict(X)
        alpha=max(.001,float(np.sum((y-mu)**2-y)/np.sum(mu**2)))
        model=sm.GLM(y,train,family=sm.families.NegativeBinomial(alpha=alpha)).fit_regularized(alpha=.01,L1_wt=0,maxiter=1000)
        prediction=np.maximum(model.predict(test),.001);n=1/alpha;p=n/(n+prediction)
        return coherent(np.column_stack([stats.nbinom.ppf(q,n,p) for q in QS]))
    elif name in ['extra-trees','random-forest']:
        model=ExtraTreesRegressor(n_estimators=200,min_samples_leaf=10,max_depth=12,max_features=.8,random_state=seed,n_jobs=2) if name=='extra-trees' else RandomForestRegressor(n_estimators=150,min_samples_leaf=8,max_depth=12,random_state=seed,n_jobs=2)
        model.fit(X,y);return coherent(forest_quantiles(model,X,y,V))
    elif name.startswith('histogram-'):
        leaves,iterations={'histogram-small':(7,150),'histogram-medium':(15,200),'histogram-large':(31,250)}[name]
        return coherent(np.column_stack([HistGradientBoostingRegressor(loss='quantile',quantile=q,max_leaf_nodes=leaves,max_iter=iterations,learning_rate=.05,early_stopping=False,random_state=seed).fit(X,y).predict(V) for q in QS]))
    elif name=='lightgbm':
        from lightgbm import LGBMRegressor
        return coherent(np.column_stack([LGBMRegressor(objective='quantile',alpha=q,n_estimators=200,num_leaves=15,learning_rate=.05,random_state=seed,n_jobs=2,verbosity=-1).fit(X,y).predict(V) for q in QS]))
    elif name=='xgboost':
        from xgboost import XGBRegressor
        return coherent(XGBRegressor(objective='reg:quantileerror',quantile_alpha=QS,n_estimators=200,max_depth=4,learning_rate=.05,tree_method='hist',random_state=seed,n_jobs=2).fit(X,y).predict(V))
    elif name in ['catboost','scaled-catboost']:
        from catboost import CatBoostRegressor
        raw_train=bundle['raw_X_train'].copy();raw_eval=bundle['raw_X_eval'].copy();target=y;weights=None
        if name=='scaled-catboost':
            train_scale=scales(raw_train,columns);eval_scale=scales(raw_eval,columns)
            for j,c in enumerate(columns):
                if c.startswith(('lag','mean','std','median','weekday_med')) or c=='trend':raw_train[:,j]/=train_scale;raw_eval[:,j]/=eval_scale
            raw_train=np.column_stack([raw_train,np.log1p(train_scale),shape_features(bundle['seq_train'])]);raw_eval=np.column_stack([raw_eval,np.log1p(eval_scale),shape_features(bundle['seq_eval'])]);target=y/train_scale
            dates=pd.to_datetime(bundle['dates_train']);weights=np.exp2(-(dates.max()-dates).days.to_numpy()/180)
        model=CatBoostRegressor(loss_function='MultiQuantile:alpha=0.1,0.5,0.75,0.9',iterations=500 if name=='scaled-catboost' else 250,depth=4,learning_rate=.03 if name=='scaled-catboost' else .05,l2_leaf_reg=5 if name=='scaled-catboost' else 3,random_seed=seed,thread_count=2,verbose=False,allow_writing_files=False)
        model.fit(raw_train,target,sample_weight=weights);prediction=model.predict(raw_eval)
        if name=='scaled-catboost':prediction*=eval_scale[:,None]
        return coherent(prediction)
    else:raise ValueError(f'Unknown classical model {name}')
    return coherent(constant_quantiles(model.fit(X,y).predict(V)))
