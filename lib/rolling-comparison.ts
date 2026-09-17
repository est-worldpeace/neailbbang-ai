import data from "@/public/research/rolling/comparison.json";
import { BENCHMARK, type ResearchBenchmark } from "./research-comparison";

export type ResearchMetric = "loss" | "wape" | "mae";
export type RollingScore = {
  seriesId: string; variantId: string; modelId: string; name: string;
  group: "fixed" | "rolling" | "custom"; splitId?: string;
  n: number; actualTotal: number; absoluteError: number;
  wape: number; mae: number; over: number; under: number; loss: number;
  rankVsFixed34: Record<ResearchMetric, number>;
  rankVsRolling34: Record<ResearchMetric, number>;
};
export type PairedComparison = {
  variantSeriesId: string; referenceSeriesId: string; blockDays: number;
  lossDelta: number; overDelta: number; underDelta: number;
  relativeLossDeltaPercent: number; confidence95: number[]; confidenceIncludesZero: boolean;
};
export type RollingData = {
  version: string; status: string; generatedAt: string; primarySeriesId: string;
  aggregate: RollingScore[]; bySplit: RollingScore[]; pairedComparisons: PairedComparison[];
};
export const ROLLING = data as RollingData;
export type ModelUpdate = "weekly" | "daily" | "frozen";
export type ComparisonUpdate = "rolling" | "fixed";
export const UPDATE_OPTIONS: Record<ModelUpdate, { seriesId: string; label: string; description: string }> = {
  weekly: { seriesId: "custom/custom-weekly-daily", label: "원설계 복원 · 매일 실적 반영", description: "내부 비중은 매주, 오차 보정 자료는 매일 갱신합니다. 당일 판매는 예측 후에 반영합니다." },
  daily: { seriesId: "custom/custom-daily-daily", label: "매일 비중까지 갱신", description: "전날까지의 최근 56일 실적으로 내부 비중과 오차 보정 자료를 매일 갱신합니다." },
  frozen: { seriesId: "fixed/custom-final", label: "갱신 전 · 기존 11위 결과", description: "평가 전 28일의 비중 학습 자료와 별도 28일의 보정 자료를 고정했던 재구현입니다." },
};

export function comparisonBenchmark(update: ModelUpdate, comparison: ComparisonUpdate): ResearchBenchmark {
  const choice = UPDATE_OPTIONS[update];
  const seriesFor = (modelId: string) => modelId === "custom-final" ? choice.seriesId : `${comparison}/${modelId}`;
  const models = BENCHMARK.models.map(model => model.role === "custom"
    ? { ...model, name: update === "frozen" ? "내 모델 · 갱신 전" : update === "weekly" ? "내 모델 · 원설계 복원" : "내 모델 · 매일 비중 갱신", description: choice.description, parameters: `${model.parameters}; ${choice.label}; 학습된 기초 예측기는 고정` }
    : { ...model, parameters: `${model.parameters}; ${comparison === "rolling" ? "직전 56일 잔차 매일 갱신" : "평가 전 잔차 고정"}` });
  const rows = new Map(ROLLING.bySplit.map(row => [`${row.seriesId}|${row.splitId}`, row]));
  const runs = BENCHMARK.runs.map(run => {
    const row = rows.get(`${seriesFor(run.modelId)}|${run.splitId}`);
    if (!row) throw new Error(`검증된 비교 결과가 없습니다: ${run.modelId}/${run.splitId}`);
    return { ...run, n: row.n, actualTotal: row.actualTotal, wape: row.wape, mae: row.mae,
      over: row.over, under: row.under, loss: row.loss,
      fitSeconds: comparison === "fixed" && run.modelId !== "custom-final" ? run.fitSeconds : null,
      weights: undefined, warnings: comparison === "fixed" && run.modelId !== "custom-final" ? run.warnings : undefined };
  });
  return {
    ...BENCHMARK, version: `${ROLLING.version}-${update}-${comparison}`, generatedAt: ROLLING.generatedAt, models, runs,
    protocol: {
      ...BENCHMARK.protocol,
      description: "같은 974개 상품·날짜에서 학습된 기초 예측기를 유지하고 갱신 방식만 비교했습니다. 과거 대화의 970건과는 별도 실험입니다.",
      calibration: `내 모델: ${choice.description} 비교 후보 34개: ${comparison === "rolling" ? "전날까지 최근 56일의 상품별 예측오차를 매일 반영합니다." : "각 평가 구간 시작 전 56일의 상품별 예측오차를 고정합니다."}`,
      notes: [
        "모든 예측은 해당 날짜 이전 실적만 사용합니다. 평가기간에 새로 관측한 전날 실적은 다음 날짜 예측부터 사용할 수 있습니다.",
        "원설계 복원은 앙상블의 주간 비중·일일 보정 갱신을 복원한 것입니다. 기존 대화의 원본 체크포인트나 970건 실험을 재현한 결과는 아닙니다.",
        `최종 결합의 Extra Trees 구성요소는 원설계대로 평가 전 고정 보정입니다. ${update === "frozen" ? "선택한 갱신 전 모델은 내부 앙상블의 보정도 고정합니다." : "내부 앙상블의 보정만 날짜마다 갱신합니다."} 별도 비교용 Extra Trees는 선택한 비교군의 보정 방식을 따릅니다.`,
        "내부 비중은 5개 기초 예측기의 P50/P75 오차로 학습합니다. 최종 외부 비율 ET 26.7543% + 앙상블 73.2457%는 모든 날짜에 고정합니다.",
        "갱신은 모델 비중과 잔차 보정에 적용합니다. 나무·신경망 등 기초 예측기를 매일 다시 학습하지 않습니다. 과거 일자에 만들어 둔 예측은 수정하지 않습니다.",
        "원설계 주간 비중은 월요일 직전 56일 자료를 사용합니다. 첫 주는 보관된 학습 외 예측이 시작되는 날짜까지로 이력이 제한될 수 있습니다.",
        "원자료의 판매량은 실제 수요의 대리값입니다. 미기록일은 0으로 채우지 않았고, 실제 폐기량이나 품절로 놓친 수요의 정답은 없습니다.",
        "가중 손실은 올림한 P75의 과다 + 3 × 부족입니다. WAPE·MAE는 P50으로 계산합니다. 재고 0, 낱개 생산, 한도 없음의 모의 조건입니다.",
        "점수 1위가 새 매장에서의 확정적 우위를 뜻하지 않습니다. 기존에 살펴본 자료를 재사용했습니다. 기본 주간 복원 모델의 전체 974개 관측에서는 일일 보정 후보 중 손실이 가장 낮은 모델과의 손실 차이 신뢰구간이 0을 포함합니다.",
      ],
    },
    artifacts: { resultsCsv: "/research/rolling/results.csv", predictionsCsv: "/research/rolling/predictions.csv", methodologyUrl: "/research/rolling/methodology.md", verificationUrl: "/research/rolling/verification.json", sourceManifestUrl: "/research/rolling/analysis.json" },
  };
}
