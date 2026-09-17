"use client";

import { useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import ResearchComparison from "./research-comparison";
import ChronosComparison from "./chronos-comparison";
import { ROLLING, UPDATE_OPTIONS, comparisonBenchmark, type ModelUpdate, type ComparisonUpdate } from "@/lib/rolling-comparison";

const format = (n: number, digits = 2) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(n);
const scoreById = new Map(ROLLING.aggregate.map(row => [row.seriesId, row]));
const primary = scoreById.get(ROLLING.primarySeriesId)!;
const frozen = scoreById.get("fixed/custom-final")!;
const deltaText = (change: number, unit: string) => `${format(Math.abs(change))}${unit} ${change < 0 ? "감소" : change > 0 ? "증가" : "변화 없음"}`;
const diagnosticRows = [
  ["custom/custom-matched-fixed", "비중·보정 자료 고정"],
  ["custom/custom-matched-residual", "오차 보정 자료만 매일 갱신"],
  ["custom/custom-matched-weights", "내부 비중만 매주 갱신"],
  ["custom/custom-weekly-daily", "매주 비중 + 매일 보정"],
];

export default function RollingResearchLab({ onOpenStore }: { onOpenStore: () => void }) {
  const [update, setUpdate] = useState<ModelUpdate>("weekly");
  const [comparison, setComparison] = useState<ComparisonUpdate>("rolling");
  const [viewReset, setViewReset] = useState(0);
  const benchmark = useMemo(() => comparisonBenchmark(update, comparison), [update, comparison]);
  const selected = scoreById.get(UPDATE_OPTIONS[update].seriesId)!;
  const strongest = ROLLING.aggregate.filter(row => row.group === "rolling").toSorted((a, b) => a.loss - b.loss)[0];
  const uncertainty = ROLLING.pairedComparisons.find(pair => pair.variantSeriesId === primary.seriesId && pair.referenceSeriesId === strongest.seriesId && pair.blockDays === 14)!;
  return <div className="rolling-lab">
    <ChronosComparison/>
    <section className="rolling-setup" aria-label="날짜별 갱신 비교 설정">
      <div className="rolling-setup-heading"><div><RefreshCw size={18}/><strong>전날까지의 실적으로, 날짜마다 다시 예측</strong></div><a href="/research/rolling/model-evidence.pptx" download><Download size={15}/>근거자료 PPT</a></div>
      <div className="rolling-options">
        <label>내 모델 갱신 방식<select aria-label="내 모델 갱신 방식" value={update} onChange={event => setUpdate(event.target.value as ModelUpdate)}>{Object.entries(UPDATE_OPTIONS).map(([key, option]) => <option key={key} value={key}>{option.label}</option>)}</select></label>
        <label>비교할 34개 모델<select aria-label="다른 모델 보정 방식" value={comparison} onChange={event => setComparison(event.target.value as ComparisonUpdate)}><option value="rolling">다른 모델도 매일 오차 보정</option><option value="fixed">이전처럼 평가 전 오차 보정 고정</option></select></label>
      </div>
      <p className="rolling-explanation">{update === "frozen" ? "갱신이 빠졌던 이전 재구현의 성적입니다. " : "학습된 기초 예측기는 유지하고, 과거 실적에 따른 비중과 보정 자료를 갱신했습니다. "}전체 구간의 이전 고정 모델 대비 가중 손실 {deltaText((selected.loss / frozen.loss - 1) * 100, "%")}, WAPE {deltaText(selected.wape - frozen.wape, "%p")}.</p>
      <p className="rolling-explanation">순위는 이번 자료의 점수 기준입니다. 가장 가까운 경쟁 모델과의 확정적인 우위는 확인하지 못했습니다.</p>
      <div className="rolling-quick-links"><a href="#rolling-evidence">무엇을 갱신해서 좋아졌는지 보기</a><button type="button" onClick={() => { setUpdate("frozen"); setComparison("fixed"); setViewReset(value => value + 1); }}>이전 11위 결과 보기</button></div>
    </section>

    <ResearchComparison key={viewReset} benchmark={benchmark} onOpenStore={onOpenStore}/>

    <section id="rolling-evidence" className="panel rolling-evidence">
      <div className="panel-heading"><div><p className="eyebrow">DAILY UPDATE EVIDENCE</p><h2>원설계 복원으로 달라진 성적</h2></div><a className="rolling-download" href="/research/rolling/model-evidence.pptx" download><Download size={16}/>PPT 내려받기</a></div>
      <p className="table-note">아래는 원설계 복원 모델의 전체 974개 관측 결과입니다. 화면 위의 기간·비교 선택과 별도로 고정한 진단표입니다.</p>
      <div className="table-wrap"><table className="research-table"><caption className="sr-only">갱신 전과 원설계 복원 후 비교</caption><thead><tr><th>방식</th><th className="text-right">WAPE</th><th className="text-right">과다 예측</th><th className="text-right">부족 예측</th><th className="text-right">가중 손실</th></tr></thead><tbody>{[frozen, primary].map(row => <tr key={row.seriesId} className={row === primary ? "highlight" : ""}><td>{row === primary ? "매주 비중 + 매일 오차 보정" : "갱신 전 고정 모델"}</td><td className="text-right number">{format(row.wape)}%</td><td className="text-right number">{format(row.over, 0)}</td><td className="text-right number">{format(row.under, 0)}</td><td className="text-right number">{format(row.loss, 0)}</td></tr>)}</tbody></table></div>
      <p className="rolling-finding">부족 예측은 {format(frozen.under - primary.under, 0)}개 줄고 과다 예측은 {format(primary.over - frozen.over, 0)}개 늘었습니다. 부족에 3배의 벌점을 주므로 총손실은 {format(frozen.loss - primary.loss, 0)} 줄었습니다. 실제 폐기량이 줄었다는 의미는 아닙니다.</p>
      <h3>같은 출발점에서 갱신 기능만 바꿨습니다</h3>
      <div className="table-wrap"><table className="research-table"><caption className="sr-only">동일 초기 조건에서 비중과 잔차 갱신 효과 비교</caption><thead><tr><th>갱신 기능</th><th className="text-right">WAPE</th><th className="text-right">가중 손실</th></tr></thead><tbody>{diagnosticRows.map(([id, name]) => { const row = scoreById.get(id)!; return <tr key={id} className={id === primary.seriesId ? "highlight" : ""}><td>{name}</td><td className="text-right number">{format(row.wape)}%</td><td className="text-right number">{format(row.loss, 0)}</td></tr>; })}</tbody></table></div>
      <p className="rolling-finding">개선의 큰 부분은 최근 오차 자료를 매일 반영하면서 나타났습니다. 매일 보정한 뒤 주간 비중 갱신을 추가한 손실 차이는 {format(scoreById.get("custom/custom-matched-residual")!.loss - primary.loss, 0)}이며, 반복 표본 검사에서 확실한 추가 우위는 확인하지 못했습니다.</p>
      <details className="details-box"><summary>1위라는 결과를 해석할 때</summary><p>원설계 복원 모델은 다른 34개 모델도 매일 보정한 이번 비교에서 WAPE와 가중 손실 점수가 가장 낮았습니다. 가장 가까운 손실 비교 모델은 {strongest.name}이며 차이는 {format(primary.loss - strongest.loss, 0)}입니다. 14일 묶음으로 다시 표본을 뽑았을 때 차이의 95% 구간은 [{format(uncertainty.confidence95[0])}, {format(uncertainty.confidence95[1])}]로 0을 포함합니다. 이 자료의 점수 1위를 미래 성능이나 확정적 우위로 해석할 수는 없습니다.</p><p>비중도 매일 갱신한 변형의 손실은 {format(scoreById.get("custom/custom-daily-daily")!.loss, 0)}입니다. 더 자주 비중을 바꾸는 것의 추가 이득은 확인하지 못했습니다.</p></details>
      <div className="research-downloads"><a href="/research/rolling/daily-updates.csv" download>날짜별 갱신 기록</a><a href="/research/rolling/analysis.json" target="_blank" rel="noreferrer">전체 진단·구간·상품별 결과</a><a href="/research/rolling/methodology.md" target="_blank" rel="noreferrer">평가 방법</a><a href="/research/rolling/model-evidence.pdf" target="_blank" rel="noreferrer">발표자료 PDF</a></div>
    </section>
  </div>;
}
