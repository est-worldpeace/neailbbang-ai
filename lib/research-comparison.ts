import data from "@/public/research/benchmark.json";

export type BenchmarkModel = {id:string;name:string;family:string;role:"candidate"|"custom";parameters:string;description:string};
export type BenchmarkSplit = {id:string;label:string;trainStart:string;trainEnd:string;calibrationStart:string;calibrationEnd:string;testStart:string;testEnd:string;n:number;trainN?:number;calibrationN?:number;featureHash?:string};
export type BenchmarkRun = {id:string;modelId:string;splitId:string;n:number;actualTotal:number;wape:number;mae:number;over:number;under:number;loss:number;fitSeconds:number|null;status:"completed";weights?:number[];warnings?:string[]};
export type ResearchBenchmark = {
 version:string;generatedAt:string;seed:number;status?:string;
 dataset:{title:string;url:string;target:string;unit:string;rows:number;products:{id:number;name:string}[];start:string;end:string};
 protocol:{description:string;features:string[];calibration:string;notes:string[]};
 splits:BenchmarkSplit[];models:BenchmarkModel[];runs:BenchmarkRun[];
 artifacts:{predictionsCsv:string;resultsCsv:string;methodologyUrl:string;verificationUrl?:string;sourceManifestUrl?:string};
};
export const BENCHMARK=data as ResearchBenchmark;
export type HistoricalComparison = {id:string;label:string;n:number;period:string;sourceTurn:string;sourceUrl:string;note:string;rows:{model:string;wape:number|null;over:number|null;under:number|null;loss:number|null;lossIndex?:number|null}[]};
export const HISTORICAL_COMPARISONS:HistoricalComparison[]=[{
 id:"historical-final-970",label:"이전 대화에서 보고된 최종 비교",n:970,period:"2023-07-01 ~ 2023-12-12",
 sourceTurn:"064·071·073",sourceUrl:"https://chatgpt.com/c/6aa1458c-36f4-83ee-8d90-3759a85d6f75",
 note:"이전 대화에 남은 합산 수치입니다. 해당 실험의 개별 예측 파일을 복구하지 못해 이번 새 실험과 분리해 표시합니다. 재사용 자료의 탐색 결과이며 독립 검증 성적이 아닙니다.",
 rows:[
  {model:"Extra Trees",wape:25.73,over:8979,under:3789,loss:20346},
  {model:"보정 앙상블",wape:null,over:11311,under:2693,loss:19390},
  {model:"50:50 결합",wape:23.87,over:10115,under:3069,loss:19322},
  {model:"메뉴별 선택형",wape:null,over:null,under:null,loss:19742},
  {model:"메뉴별 적응형 선형결합",wape:23.51,over:10675,under:2971,loss:19588},
  {model:"내 최종 결합 모델",wape:23.61,over:10647,under:2851,loss:19200},
 ],
}];
