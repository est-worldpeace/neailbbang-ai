# Chronos-Bolt Small과 베이커리 모델 비교

추론 전에 고정한 공식 체크포인트·CPU FP32·512달력일 문맥·다음날1일 예측으로 평가했습니다. 모델 가중치 미세조정은 하지 않았습니다.

두 방식은 원시 zero-shot과 최근56일의 관측 오차로 날짜마다 보정한 방식입니다. 같은974개 관측을 채점하며 기존 결과는 보존했습니다.

## 평가 규칙

- **version**: chronos-bolt-small-bakery-preregistered-v1
- **registeredDate**: 2026-09-15
- **registeredBeforeInference**: True
- **modelId**: amazon/chronos-bolt-small
- **modelRevision**: 772f3d25d38aec6d914c8949dab4462e2d46f5d8
- **weightsSha256**: 06a6a19bbe74bc10a9cd193bd4bf2bf638ae07f7e0d51653ae7ab8ea968a21dd
- **weightsBytes**: 190888824
- **chronosPackage**: 2.3.2
- **chronosWheelSha256**: 0f0d9a1972f252d6cf584b9fa749bd1b389b3c1cf05a889c4130cb10652c2117
- **torchPackage**: 2.8.0+cpu
- **transformersPackage**: 4.57.6
- **numpyPackage**: 2.3.5
- **pandasPackage**: 3.0.1
- **device**: cpu
- **dtype**: float32
- **batchSize**: 32
- **cpuThreads**: 2
- **seed**: 20260915
- **fineTune**: False
- **predictionLength**: 1
- **studyContextCalendarDays**: 512
- **checkpointSupportedContextLength**: 2048
- **missingDates**: Preserve daily calendar positions as NaN; never compress missing dates or replace sales with zero. Left pad with NaN only when fewer than512 calendar days precede the target.
- **contextCutoff**: Every target t uses only dates t-512 through t-1, bounded by the source start. Never input actual sales at t or later.
- **quantileMethod**: Official ChronosBoltPipeline.predict_quantiles: because P75 is not native, duplicate native endpoint quantiles to cover levels0/1 then torch.quantile(..., interpolation=linear) along the quantile axis (sorting included). Use returned requested P50/P75, not its second native-median mean output.
- **rawVariant**: chronos/raw: zero-shot, with only the same nonnegative and quantile-order postprocessing as the existing experiment.
- **primaryVariant**: chronos/daily56: zero-shot forecasts followed by causal daily same-product residual quantile calibration using prior56 calendar days; if fewer than10 rows use at most56 earlier available out-of-training forecasts, matching the existing rolling candidate protocol.
- **calibrationHistory**: Infer every observed calibration-period date plus every test date using its own strictly prior context. Fold calibration histories start exactly at their existing56-day calibration boundaries. No in-sample forecasts are fabricated.
- **observations**: 974
- **scoring**: WAPE and MAE use P50. quantity=ceil(P75), with near-integer tolerance1e-9 as before. Over=max(quantity-y,0), under=max(y-quantity,0), loss=over+3under. inventory0,batch1,no capacity limit.
- **rankReference**: 34 previously evaluated daily-calibrated candidates plus the restored custom model; each Chronos variant is compared separately, denominator36.
- **bootstrap**: 1000 paired circular calendar-day block resamples within each fold, all products kept together; lengths7 and14days; fixed seed20260915+blockDays; delta=Chronos-reference; percentile95% intervals.
- **noRetuning**: All choices above were fixed before running Chronos. Do not search for settings that improve its rank, alter existing results, or select a favorable test subset.
- **limitations**: Same previously explored bakery data; observed net sales are a demand proxy and do not measure stockouts, real waste or monetary costs. Chronos pretraining overlap with these public source records is not independently established. Zero-shot means no task-specific weight training here, not proof of an unseen pretraining dataset.

## 전체 결과

| 방식 | WAPE | MAE | 과다 | 부족 | 가중손실 | 36개 중 손실 순위 |
|---|---:|---:|---:|---:|---:|---:|
| Chronos-Bolt Small · 원시 zero-shot | 26.6814% | 6.4027 | 6202 | 1682 | 11248 | 14 |
| Chronos-Bolt Small · 매일 56일 보정 | 26.9800% | 6.4744 | 6295 | 1630 | 11185 | 14 |
| Extra Trees 분위수숲 · 매일 보정 | 27.4077% | 6.5770 | 5736 | 1735 | 10941 | 참조 |
| 히스토그램 부스팅 · 작은 나무 · 매일 보정 | 27.5598% | 6.6135 | 5814 | 1585 | 10569 | 참조 |
| 최종 모델 · 매주 비중 + 매일 보정 | 25.8157% | 6.1950 | 5915 | 1455 | 10280 | 참조 |

## 해석 범위

Chronos − 기존 참조의 차이를 보고하므로 음수 손실차가 Chronos에 유리합니다. 7일·14일 블록 신뢰구간을 함께 보며, 이미 탐색한 단일 매장 자료의 결과를 모든 매장의 우위로 일반화하지 않습니다.
zero-shot은 이번 평가에서 가중치를 학습하지 않았다는 뜻입니다. 사전학습에 이 공개자료가 포함되지 않았음까지 확인한 것은 아닙니다.

## 공식 자료

- https://huggingface.co/amazon/chronos-bolt-small
- https://huggingface.co/amazon/chronos-bolt-small/blob/772f3d25d38aec6d914c8949dab4462e2d46f5d8/config.json
- https://github.com/amazon-science/chronos-forecasting/blob/4dbf163c2734c089cdf7da2b86fde48862ff9c6f/src/chronos/chronos_bolt.py
- https://pypi.org/project/chronos-forecasting/2.3.2/
