import data from "@/public/research/chronos/comparison.json";

export type ChronosScore = {
  seriesId: string; name: string; splitId?: string;
  n: number; actualTotal: number; wape: number; mae: number;
  over: number; under: number; loss: number;
};
export type ChronosPair = {
  variantSeriesId: string; referenceSeriesId: string; blockDays: number;
  lossDelta: number; confidence95: number[]; confidenceIncludesZero: boolean;
};
export type ChronosData = {
  version: string; status: string; generatedAt: string;
  aggregate: ChronosScore[]; bySplit: ChronosScore[]; pairedComparisons: ChronosPair[];
};
export const CHRONOS = data as ChronosData;
