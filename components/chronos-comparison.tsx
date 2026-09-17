"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { CHRONOS, type ChronosScore } from "@/lib/chronos-comparison";
import { ROLLING } from "@/lib/rolling-comparison";
import { BENCHMARK } from "@/lib/research-comparison";

const number = (value: number, digits = 2) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
const OWN_ID = "custom/custom-weekly-daily";
const NAMES: Record<string, string> = {
  [OWN_ID]: "내 최종 모델 · 매주 비중 + 매일 보정",
  "chronos/raw": "Chronos-Bolt Small · 원본",
  "chronos/daily56": "Chronos-Bolt Small · 매일 보정",
};

export default function ChronosComparison() {
  const [period, setPeriod] = useState("all");
  const referenceRows = period === "all" ? ROLLING.aggregate : ROLLING.bySplit.filter(row => row.splitId === period);
  const chronosRows = (period === "all" ? CHRONOS.aggregate : CHRONOS.bySplit.filter(row => row.splitId === period)).filter(row => row.seriesId.startsWith("chronos/"));
  const own = referenceRows.find(row => row.seriesId === OWN_ID)!;
  const best = referenceRows.filter(row => row.group === "rolling").toSorted((a, b) => a.loss - b.loss)[0];
  const extraTrees = referenceRows.find(row => row.seriesId === "rolling/extra-trees")!;
  const rows: ChronosScore[] = [own, ...chronosRows, best, ...(best.seriesId === extraTrees.seriesId ? [] : [extraTrees])];
  const daily = chronosRows.find(row => row.seriesId === "chronos/daily56")!;
  const difference = daily.loss - own.loss;
  const pair = CHRONOS.pairedComparisons.find(row => row.variantSeriesId === "chronos/daily56" && row.referenceSeriesId === OWN_ID && row.blockDays === 14)!;

  return <section id="chronos-comparison" className="panel chronos-comparison" aria-labelledby="chronos-heading">
    <div className="panel-heading">
      <div><p className="eyebrow">CHRONOS-BOLT SMALL</p><h2 id="chronos-heading">내 모델과 Chronos, 같은 날짜로 비교했습니다</h2></div>
      <a className="rolling-download" href="/research/chronos/chronos-comparison.pptx" download><Download size={16}/>발표용 PPT</a>
    </div>
    <p className="chronos-intro">사전학습 모델을 그대로 사용한 원본과, 최근 56일의 예측오차를 매일 보정한 버전입니다. 이전 날짜까지의 실적을 입력하고 다음 하루를 예측했습니다.</p>
    <div className="chronos-controls"><label>비교 기간<select aria-label="Chronos 비교 기간" value={period} onChange={event => setPeriod(event.target.value)}><option value="all">전체 3개 구간 · 974건</option>{BENCHMARK.splits.map(split => <option key={split.id} value={split.id}>{split.label} · {split.n}건</option>)}</select></label><span>{number(own.n, 0)}개 상품·날짜에서 비교 · 낮을수록 좋습니다</span></div>
    <p className="chronos-result" aria-live="polite">매일 보정한 두 모델의 가중 손실은 <strong>{difference === 0 ? "같습니다" : `${difference > 0 ? "내 최종 모델" : "Chronos-Bolt Small"}이 ${number(Math.abs(difference), 0)} 낮습니다`}</strong>.</p>
    <div className="table-wrap"><table className="research-table"><caption className="sr-only">Chronos 원본과 일일 보정, 사용자 최종 모델 및 주요 후보의 같은 기간 성적</caption><thead><tr><th>비교 모델</th><th className="text-right">WAPE</th><th className="text-right">MAE</th><th className="text-right">과다</th><th className="text-right">부족</th><th className="text-right">가중 손실</th></tr></thead><tbody>{rows.map(row => <tr key={row.seriesId} className={row.seriesId === OWN_ID ? "highlight" : ""}><td>{NAMES[row.seriesId] ?? row.name}{row.seriesId === best.seriesId && <small className="chronos-row-note">기존 34개 후보 중 이 기간의 최저 손실</small>}</td><td className="text-right number">{number(row.wape)}%</td><td className="text-right number">{number(row.mae)}</td><td className="text-right number">{number(row.over, 0)}</td><td className="text-right number">{number(row.under, 0)}</td><td className="text-right number">{number(row.loss, 0)}</td></tr>)}</tbody></table></div>
    <p className="table-note">WAPE·MAE는 중앙 예측값(P50), 가중 손실은 생산 권고(P75 올림)의 과다 + 3 × 부족으로 계산합니다. Chronos는 별도 추가 학습을 하지 않았으며, 보정 버전은 과거 오차를 반영합니다.</p>
    <details className="details-box"><summary>비교 조건과 결과의 확실성</summary><p>이번 비교에서는 최대 512일의 일별 판매 이력을 입력합니다. 빠진 날짜는 결측으로 유지하며, 판매 0으로 채우거나 날짜를 압축하지 않았습니다. P75는 공식 구현이 제공하는 분위수 보간값입니다. 기존 모델과 입력 표현·사전학습 방식은 다르지만, 평가 날짜와 오차 지표는 같습니다.</p><p>전체 974건에서 ‘매일 보정 Chronos − 내 최종 모델’의 손실 차이는 {number(pair.lossDelta, 0)}입니다. 14일 묶음으로 재표집한 차이의 95% 구간은 [{number(pair.confidence95[0])}, {number(pair.confidence95[1])}]입니다. {pair.confidenceIncludesZero ? "구간에 0이 포함되어 확실한 우위로 단정하기 어렵습니다." : "이번 재표집 분석에서는 구간에 0이 포함되지 않았습니다. 새로운 매장이나 미래 기간에서 같은 차이를 보장하지는 않습니다."} 이 진단은 위 기간 선택과 별도로 전체 기간을 기준으로 합니다.</p><p>이미 살펴본 공개 판매자료를 사용한 사후 비교입니다. 이 판매자료가 Chronos의 사전학습 자료와 겹치는지는 확인되지 않았습니다. 과다·부족 수량은 실제 폐기량이나 미충족 수요의 측정값이 아닙니다.</p></details>
    <div className="research-downloads"><a href="/research/chronos/chronos-comparison.pdf" target="_blank" rel="noreferrer">발표자료 PDF</a><a href="/research/chronos/predictions.csv" download>날짜별 실제값·예측값</a><a href="/research/chronos/analysis.json" target="_blank" rel="noreferrer">구간·상품별 결과</a><a href="/research/chronos/methodology.md" target="_blank" rel="noreferrer">평가 방법·출처</a><a href="/research/chronos/verification.json" target="_blank" rel="noreferrer">검증 결과</a></div>
  </section>;
}
