# 과거 실적을 날짜마다 반영한 순차 보정 비교

기존 35개 고정 결과는 보존하고, 같은 974개 상품·날짜에서 후보34개 일일 보정과 최종 모델8개 변형을 계산했습니다. 기본 모델 재학습은 없습니다.

기존 대화의 970개 관측 실험 또는 기존 체크포인트를 재현한 결과가 아닙니다.

## 방법

- **primaryVariantId**: custom-weekly-daily
- **weightLoss**: P50/P75 scale-normalized pinball mean + 0.01*sum((w-0.2)^2); nonnegative weights summing to one
- **weeklyCutoff**: Monday 00:00, outcomes strictly before that Monday; previous 56 calendar days across all six products
- **residualCutoff**: Strictly before each target date; previous 56 calendar days for the same product, recomputed using current weights; fewer than 10 rows falls back to at most 56 earlier available out-of-training predictions
- **fixedExtraTrees**: The external ET branch retains original pre-test 56-day per-product fixed calibration in every custom variant
- **initialHistory**: Caches start at each fold calibration start. The first partial week can have fewer than 56 calendar days before Monday; no in-sample predictions are invented.
- **candidateFairness**: All 34 candidates use daily per-product residual quantile updates with the same prior-56-calendar-day window and sparse-history rule. Candidate offsets use unweighted residual quantiles; the custom ensemble retains its scale normalization and FFT-similarity weighting. Raw models and coefficients are never retrained.
- **fixed56Control**: Uses all pre-test 56 days for both fitting expert weights and residual calibration. These sets overlap; this is a stated control, not a new independent validation set.
- **originalResidualPool**: weights-only retains the original last-28-day calibration residual pool; residual-only retains the original first-28-day fitted weights
- **matchedFactorial**: matched-fixed, matched-residual, matched-weights and primary use exactly the same initial first-week pre-Monday56-day weights and pre-test56-day residual pool. Only the two subsequent update schedules differ. The initial weight history may be shorter than56 days as explicitly audited.
- **scoring**: P50 WAPE and MAE; ceil(P75) with near-integer tolerance 1e-9; loss=over+3*under, inventory0,batch1,no capacity limit
- **bootstrap**: 1000 paired circular calendar-day block samples separately per fold; all products kept together; 7- and 14-day lengths; percentile95% CI; descriptive repeated-data analysis, no multiplicity-adjusted confirmatory claims
- **variantSelection**: The primary schedule and first five variants were specified before their rolling scores. After those scores were observed, three matched-initial-condition controls were added to separate mechanisms, with their definitions fixed before scoring those controls. No score-based variant selection or parameter retuning followed.
- **interpretation**: Same 974 observations as the frozen rebuilt benchmark. Restores the documented update schedule, not the old 970-observation original experiment or its model checkpoints. This is explanatory analysis of previously explored data, not an untouched confirmatory test.

## 전체 결과

| 방식 | WAPE | MAE | 과다 | 부족 | 과다+3×부족 | 고정34개 대비 순위 | 일일보정34개 대비 순위 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Extra Trees 분위수숲 · 고정 보정 | 31.8402% | 7.6407 | 6187 | 2229 | 12874 | 17 | 31 |
| 내 최종 결합 모델 · 고정 보정 | 29.2991% | 7.0309 | 4978 | 2501 | 12481 | 11 | 27 |
| Extra Trees 분위수숲 · 매일 보정 | 27.4077% | 6.5770 | 5736 | 1735 | 10941 | 2 | 6 |
| 최종 모델 · 매주 비중 + 매일 보정 | 25.8157% | 6.1950 | 5915 | 1455 | 10280 | 1 | 1 |
| 매일 비중 + 매일 보정 | 25.8184% | 6.1956 | 5944 | 1452 | 10300 | 1 | 1 |
| 기존 고정 비중 + 매일 보정 | 26.0051% | 6.2404 | 5711 | 1535 | 10316 | 1 | 1 |
| 매주 비중 + 기존 고정 보정자료 | 28.2286% | 6.7740 | 5464 | 2013 | 11503 | 3 | 14 |
| 56일 고정 비중 + 56일 고정 보정자료 | 28.4903% | 6.8368 | 5845 | 1766 | 11143 | 2 | 13 |
| 동일 초기조건 · 비중·보정자료 고정 | 28.4369% | 6.8240 | 5833 | 1761 | 11116 | 2 | 13 |
| 동일 초기조건 · 보정자료만 매일 갱신 | 25.8503% | 6.2033 | 5847 | 1479 | 10284 | 1 | 1 |
| 동일 초기조건 · 비중만 매주 갱신 | 28.0734% | 6.7367 | 6186 | 1573 | 10905 | 2 | 5 |

## 검증

{
  "status": "passed",
  "series": 77,
  "observationsPerSeries": 974,
  "predictionRows": 74998,
  "frozenModelsPreserved": 35,
  "dailyCalibratedCandidates": 34,
  "customVariants": 8,
  "sameObservationKeysForAllSeries": true,
  "duplicatePredictionKeys": 0,
  "previouslyComputedSeriesUnchanged": 77,
  "allFinite": true,
  "everyMetricComputedFromExportedCsv": true,
  "csvMetricsReconciledWithMemory": true,
  "original35MetricsPreserved": true,
  "actualDateCutoffsAssertedForEveryUpdate": true,
  "sameDayAndFutureCalibrationTargetMutationInvariant": true,
  "mutationScope": "Recalibration only: raw base predictions, lag features and sequences stay fixed; original archived feature-causality verification remains the source for base inputs.",
  "baseModelsRetrained": false,
  "checks": [
    {
      "splitId": "split-1",
      "n": 370,
      "dateCutoffAssertions": 20054,
      "matchedFactorialFirstDatePredictionsExactlyEqual": true,
      "mutationTargetDates": [
        "2023-07-01",
        "2023-07-03",
        "2023-08-01",
        "2023-08-31"
      ],
      "mutationVariantCases": 168,
      "sameDayAndFutureTargetMutationInvariant": true
    },
    {
      "splitId": "split-2",
      "n": 366,
      "dateCutoffAssertions": 19837,
      "matchedFactorialFirstDatePredictionsExactlyEqual": true,
      "mutationTargetDates": [
        "2023-09-01",
        "2023-09-03",
        "2023-10-01",
        "2023-10-31"
      ],
      "mutationVariantCases": 168,
      "sameDayAndFutureTargetMutationInvariant": true
    },
    {
      "splitId": "split-3",
      "n": 238,
      "dateCutoffAssertions": 12901,
      "matchedFactorialFirstDatePredictionsExactlyEqual": true,
      "mutationTargetDates": [
        "2023-11-01",
        "2023-11-03",
        "2023-11-22",
        "2023-12-11"
      ],
      "mutationVariantCases": 168,
      "sameDayAndFutureTargetMutationInvariant": true
    }
  ],
  "originalVerificationSha256": "d8b9ff427b3970f7cebf22901ead50b9d7602f1f06f7b1d0ff8ee5f733eb30c4"
}
