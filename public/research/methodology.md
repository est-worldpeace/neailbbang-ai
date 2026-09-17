# 새로 구성한 102회 비교 실험

34개 후보 설정 × 3개 시간순 평가 구간 = 102회 실제 학습·평가, 내 최종 결합 모델 3회 별도 비교

- 이전 대화의 모델 계열을 이번 명시 설정으로 새로 구현·학습했습니다. 이전 102개 실행의 원본 재현이나 현재 앱에 내장된 체크포인트의 평가가 아닙니다.
- 같은 6개 상품을 세 구간에서 시간순 비교합니다. 이전의 개발 상품/새 상품 검증 설계와 다릅니다. 이미 이전 탐색에 사용된 공개 자료이므로 독립 미사용 검증 또는 최종 우위 입증으로 해석할 수 없습니다.
- 판매 없는 날짜를 0으로 만들지 않습니다. 원자료의 관측 날짜만 채점하며 결측 날짜는 입력 마스크로 보존합니다. 시간대 음수는 반품·취소가 반영된 순수량으로 합산하고 일합계 음수 3행은 제외했습니다.
- 모든 모델이 같은 날짜·상품의 실적을 사용합니다. P50으로 WAPE/MAE를 계산하고 P75를 정수로 올려 과다+3×부족을 계산합니다. 초기 재고 0, 낱개 생산, 생산 한도 없음의 공통 모의 조건입니다.
- 평가일 이전 실제 판매는 다음 날 예측 입력에 사용할 수 있습니다. 당일 및 미래 판매는 입력에서 제외합니다. 시계열 상태는 과거 관측으로만 갱신하고 계수는 재학습하지 않습니다.
- 3:1은 사용자가 선택한 가정이며 실제 금전 손실이나 실측 폐기량이 아닙니다. 품절 표시는 원자료에 없어 판매량을 미충족 수요와 구분할 수 없습니다.
- 고정 최종 결합 비율은 ET 0.2675427911011525 + 보정 앙상블 0.7324572088988475이며 새 평가 점수로 조정하지 않았습니다.
- fitSeconds는 학습·추론 수행시간입니다. 최종 모델 시간은 재사용한 구성모델 실행시간을 포함합니다. 원자료 필터와 원 연구 추가필터가 달라 기존 2,111행 학습팩과 일치시키지 않았습니다.

## 원자료

https://github.com/lleisner/bakery_sales_forecasting/tree/d4c8fb84140964a122bbbd851e712b1f11ef3a69/data/raw_sources/sales

시간대 판매수량 열을 날짜·상품별 합산했습니다. 원본 자료의 출처와 SHA-256은 source-manifest.json에 있습니다. 결과는 관측 순판매수량의 파생 연구 자료이며 원본 Excel 파일은 이 다운로드에 포함하지 않습니다.

## 검증

{
  "status": "passed",
  "candidateSettings": 34,
  "timeBlocks": 3,
  "candidateRuns": 102,
  "customModelRuns": 3,
  "totalCompletedRuns": 105,
  "predictionRows": 34090,
  "allFinite": true,
  "duplicatePredictionKeys": 0,
  "metricsIndependentlyRecomputedFromPredictions": true,
  "sameDayAndFutureOutcomeFeatureInvariance": true,
  "featureInputDatesStrictlyBeforeTarget": true,
  "testDataUsedForParameterSelection": false,
  "historicalDatasetPreviouslyExplored": true,
  "checks": [
    {
      "splitId": "split-1",
      "sameObservationKeysForAll35Models": true,
      "n": 370,
      "trainingAndCalibrationBeforeTest": true
    },
    {
      "splitId": "split-2",
      "sameObservationKeysForAll35Models": true,
      "n": 366,
      "trainingAndCalibrationBeforeTest": true
    },
    {
      "splitId": "split-3",
      "sameObservationKeysForAll35Models": true,
      "n": 238,
      "trainingAndCalibrationBeforeTest": true
    }
  ]
}

## 모델 설정

- **전날 판매**: lag1, 누락 시 과거 평균
- **전주 같은 요일**: lag7, 누락 시 과거 평균
- **최근 7일 판매분포**: calendar window=7, empirical quantiles
- **최근 8주 같은 요일**: 8 weekly lags, empirical quantiles
- **Ridge 회귀**: alpha=10
- **Elastic Net**: alpha=0.1,l1_ratio=0.25,max_iter=5000
- **Huber 회귀**: epsilon=1.35,alpha=0.0001,max_iter=500
- **선형 분위수 · 비정규화**: alpha=0,quantiles=0.1/0.5/0.75/0.9,solver=highs
- **선형 분위수 · L1 정규화**: alpha=1,quantiles=0.1/0.5/0.75/0.9,solver=highs
- **스플라인 Ridge**: 4 knots,degree=2,alpha=10,linear extrapolation
- **Poisson 회귀**: alpha=1,max_iter=500
- **음이항 회귀**: GLM negative-binomial,dispersion from training,alpha ridge=0.01
- **SVR**: kernel=rbf,C=10,epsilon=0.1
- **kNN**: n_neighbors=15,weights=distance
- **Random Forest 분위수숲**: n_estimators=150,min_samples_leaf=8,max_depth=12
- **Extra Trees 분위수숲**: n_estimators=200,min_samples_leaf=10,max_depth=12,max_features=0.8
- **히스토그램 부스팅 · 작은 나무**: max_leaf_nodes=7,max_iter=150,learning_rate=0.05
- **히스토그램 부스팅 · 중간 나무**: max_leaf_nodes=15,max_iter=200,learning_rate=0.05
- **히스토그램 부스팅 · 큰 나무**: max_leaf_nodes=31,max_iter=250,learning_rate=0.05
- **LightGBM**: objective=quantile,n_estimators=200,num_leaves=15,learning_rate=0.05
- **XGBoost**: objective=reg:quantileerror,n_estimators=200,max_depth=4,learning_rate=0.05
- **CatBoost 분위수**: MultiQuantile,iterations=250,depth=4,learning_rate=0.05,l2_leaf_reg=3
- **SARIMA**: log1p(y),order=(1,0,1),seasonal_order=(1,0,0,7)
- **구조적 상태공간**: log1p(y),local linear trend,stochastic seasonal=7
- **감쇠 추세 Holt**: log1p(y),additive damped trend
- **OU 확률미분방정식**: calendar-residual log sales,mean-reverting OU,Gaussian transition
- **비선형 3차 ODE**: dz/dt=a-k*z-g*z^3,g>=0,Euler 20 steps/day
- **비선형 3차 SDE**: cubic drift,Euler-Maruyama 20 steps/day,256 paths
- **MLP**: PyTorch,2 seeds,80 epochs,batch=64
- **LSTM**: PyTorch,hidden=24,2 seeds,80 epochs,batch=64
- **GRU**: PyTorch,hidden=24,2 seeds,80 epochs,batch=64
- **TCN**: PyTorch,causal temporal convolutions,2 seeds,80 epochs
- **Transformer**: PyTorch,d_model=16,2 heads,1 layer,2 seeds,80 epochs
- **Neural ODE**: PyTorch,learned drift,Euler integration,2 seeds,80 epochs
- **내 최종 결합 모델**: 0.2675427911011525 × Extra Trees + 0.7324572088988475 × 보정 앙상블
