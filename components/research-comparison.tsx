"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Download, FileText, FlaskConical, Search, SlidersHorizontal, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { BENCHMARK as FROZEN_BENCHMARK, HISTORICAL_COMPARISONS, type ResearchBenchmark } from "@/lib/research-comparison";

type Metric = "loss" | "wape" | "mae";
type Model = (typeof FROZEN_BENCHMARK.models)[number];
type Run = (typeof FROZEN_BENCHMARK.runs)[number];
type Score = {
  model: Model;
  runs: Run[];
  n: number;
  actualTotal: number;
  wape: number;
  mae: number;
  over: number;
  under: number;
  loss: number;
  fitSeconds: number | null;
};

const number = (value: number, digits = 1) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
const metricLabels: Record<Metric, string> = { loss: "가중 손실", wape: "판매오차 WAPE", mae: "평균오차 MAE" };
const splitNames = new Map(FROZEN_BENCHMARK.splits.map(split => [split.id, split.label]));
const candidateCount = FROZEN_BENCHMARK.models.filter(model => model.role === "candidate").length;
const familyNames = [...new Set(FROZEN_BENCHMARK.models.map(model => model.family))];

function aggregate(model: Model, runs: Run[]): Score {
  const n = runs.reduce((sum, run) => sum + run.n, 0);
  const absolute = runs.reduce((sum, run) => sum + run.mae * run.n, 0);
  const actualTotal = runs.reduce((sum, run) => sum + run.actualTotal, 0);
  return {
    model, runs, n, actualTotal,
    wape: actualTotal > 0 ? absolute / actualTotal * 100 : 0,
    mae: n > 0 ? absolute / n : 0,
    over: runs.reduce((sum, run) => sum + run.over, 0),
    under: runs.reduce((sum, run) => sum + run.under, 0),
    loss: runs.reduce((sum, run) => sum + run.loss, 0),
    fitSeconds: runs.every(run => run.fitSeconds !== null) ? runs.reduce((sum, run) => sum + (run.fitSeconds ?? 0), 0) : null,
  };
}

function scoreText(score: Pick<Score, Metric>, metric: Metric) {
  return `${number(score[metric], metric === "loss" ? 0 : 2)}${metric === "wape" ? "%" : ""}`;
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadVisibleScores(scores: Score[], scope: string) {
  const rows: Array<Array<string | number>> = [
    ["모델ID", "모델", "계열", "역할", "평가범위", "실험수", "관측수", "실제합계", "WAPE_pct", "MAE", "과다예측", "부족예측", "가중손실", "실행초"],
    ...scores.map(score => [score.model.id, score.model.name, score.model.family, score.model.role, scope, score.runs.length, score.n, score.actualTotal, score.wape, score.mae, score.over, score.under, score.loss, score.fitSeconds ?? "미측정"]),
  ];
  downloadCsv(rows, `내일의빵_모델비교_${scope}.csv`);
}

function downloadVisibleRuns(runs: Run[], scope: string) {
  const rows: Array<Array<string | number>> = [
    ["실험ID", "모델ID", "모델", "평가구간", "관측수", "실제합계", "WAPE_pct", "MAE", "과다예측", "부족예측", "가중손실", "실행초"],
    ...runs.map(run => [run.id, run.modelId, FROZEN_BENCHMARK.models.find(model => model.id === run.modelId)!.name, splitNames.get(run.splitId)!, run.n, run.actualTotal, run.wape, run.mae, run.over, run.under, run.loss, run.fitSeconds ?? "미측정"]),
  ];
  downloadCsv(rows, `내일의빵_전체실험_${scope}.csv`);
}

function downloadCsv(rows: Array<Array<string | number>>, filename: string) {
  const blob = new Blob(["\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ResearchComparison({ onOpenStore, benchmark = FROZEN_BENCHMARK }: { onOpenStore: () => void; benchmark?: ResearchBenchmark }) {
  const BENCHMARK = benchmark;
  const customModel = BENCHMARK.models.find(model => model.role === "custom")!;
  const candidateRuns = BENCHMARK.runs.filter(run => run.modelId !== customModel.id);
  const [split, setSplit] = useState("all");
  const [metric, setMetric] = useState<Metric>("loss");
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("all");
  const [view, setView] = useState<"models" | "runs">("models");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const scores = useMemo(() => BENCHMARK.models.map(model => aggregate(model, BENCHMARK.runs.filter(run => run.modelId === model.id && (split === "all" || run.splitId === split))))
    .filter(score => score.n > 0).sort((a, b) => a[metric] - b[metric] || a.model.name.localeCompare(b.model.name)), [BENCHMARK, split, metric]);
  const own = scores.find(score => score.model.role === "custom")!;
  const winner = scores[0];
  const ranks = new Map(scores.map(score => [score.model.id, scores.findIndex(other => other[metric] === score[metric]) + 1]));
  const ownRank = ranks.get(customModel.id) ?? 0;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (model: Model) => (family === "all" || model.family === family) && (!normalizedQuery || `${model.name} ${model.family} ${model.description} ${model.parameters}`.toLowerCase().includes(normalizedQuery));
  const visibleScores = scores.filter(score => matches(score.model));
  const visibleRuns = candidateRuns.filter(run => (split === "all" || run.splitId === split) && matches(BENCHMARK.models.find(model => model.id === run.modelId)!))
    .toSorted((a, b) => a.splitId.localeCompare(b.splitId) || a[metric] - b[metric]);
  const pageCount = Math.max(1, Math.ceil(visibleRuns.length / 18));
  const safePage = Math.min(page, pageCount);
  const pagedRuns = visibleRuns.slice((safePage - 1) * 18, safePage * 18);
  const chartIds = new Set([...scores.slice(0, 5).map(score => score.model.id), customModel.id, ...[/extra.?trees/i, /요일|weekday/i, /catboost/i].map(pattern => scores.find(score => pattern.test(score.model.name))?.model.id)]);
  const chartModels = scores.filter(score => chartIds.has(score.model.id));
  const maxBar = Math.max(...chartModels.map(score => score[metric]), 1);
  const detail = scores.find(score => score.model.id === detailId);
  const selectedSplit = BENCHMARK.splits.find(item => item.id === split);
  const detailWarnings = detail ? BENCHMARK.runs.filter(run => run.modelId === detail.model.id).flatMap(run => (run.warnings ?? []).map(message => ({ split: splitNames.get(run.splitId), message }))) : [];
  const unit = BENCHMARK.dataset.unit;

  if (!own || !winner) return <section className="panel"><h2>연구 결과를 준비하고 있습니다.</h2><p>실험이 끝나면 실제 계산한 성적이 표시됩니다.</p></section>;

  return <div className="research-lab">
    <div className="research-controls">
      <div className="research-complete"><span><Check size={14}/></span><strong>{candidateRuns.length}개 비교 결과</strong><span className="quiet">최종 모델 {BENCHMARK.splits.length}개 구간 평가</span></div>
      <label className="research-select"><span>평가 범위</span><select aria-label="연구 평가 범위" value={split} onChange={event => { setSplit(event.target.value); setPage(1); }}><option value="all">전체 {BENCHMARK.splits.length}개 구간 합산</option>{BENCHMARK.splits.map(item => <option key={item.id} value={item.id}>{item.label} · {item.testStart}~{item.testEnd}</option>)}</select></label>
    </div>

    <div className="research-hero-grid">
      <section className="my-model-card" aria-labelledby="my-model-title">
        <div className="my-model-top"><span className="research-kicker">MY FINAL MODEL</span><span className="my-model-label">내가 만든 모델</span></div>
        <h2 id="my-model-title">{customModel.name}</h2>
        <p className="my-model-description">{customModel.description}</p>
        <div className="my-model-scores"><div><p>판매오차 WAPE</p><strong>{number(own.wape, 2)}<small>%</small></strong></div><div><p>{metricLabels[metric]} 순위</p><strong>{ownRank}<small>/ {scores.length}</small></strong></div><div><p>가중 손실</p><strong>{number(own.loss, 0)}</strong></div></div>
        <div className="weight-track" aria-label="Extra Trees 26.75%, 보정 앙상블 73.25%"><span/><span/></div>
        <div className="weight-labels"><span>Extra Trees <strong>26.75%</strong></span><span>보정 앙상블 <strong>73.25%</strong></span></div>
        <p className="my-model-note">동일한 {number(own.n, 0)}개 관측으로 비교 · 순위는 선택한 평가 범위와 지표에 따라 달라집니다.</p>
      </section>
      <div className="research-hero-aside">
        <section className="research-winner-card">
          <div className="research-winner-heading"><Trophy size={19}/><span>이번 비교의 1위</span><span className="tag">{metricLabels[metric]} 기준</span></div>
          <h3>{winner.model.name}</h3>
          <div className="winner-value">{scoreText(winner, metric)}<small>{metric === "wape" ? "낮을수록 좋음" : `${unit} 기준 · 낮을수록 좋음`}</small></div>
          <p>{winner.model.role === "custom" ? "최종 결합 모델이 선택한 지표에서 가장 낮은 오차를 기록했습니다." : `내 최종 모델과 ${number(Math.abs(own[metric] - winner[metric]), metric === "loss" ? 0 : 2)}${metric === "wape" ? "%p" : ""} 차이입니다.`}</p>
        </section>
        <section className="research-scale-card"><div><strong>{candidateCount}</strong><span>비교 설정</span></div><span>×</span><div><strong>{BENCHMARK.splits.length}</strong><span>시간 구간</span></div><span>=</span><div><strong>{candidateRuns.length}</strong><span>평가 결과</span></div></section>
      </div>
    </div>

    <div className="research-provenance"><FlaskConical size={19}/><p><strong>공개 자료로 실제 계산한 비교입니다.</strong> {BENCHMARK.protocol.description} {BENCHMARK.dataset.title}의 {BENCHMARK.dataset.target}를 예측하며, 실제 매장 성과는 <button onClick={onOpenStore}>매장 실적 비교 <ArrowUpRight size={13}/></button>에서 확인합니다.</p></div>

    <section className="panel research-chart-panel">
      <div className="panel-heading"><div><p className="eyebrow">SAME DATA, SAME RULES</p><h2>내 모델과 주요 모델, 얼마나 차이 날까요?</h2></div><div className="metric-switch" role="group" aria-label="연구 순위 지표">{(["loss", "wape", "mae"] as Metric[]).map(item => <button key={item} aria-pressed={metric === item} onClick={() => setMetric(item)}>{item === "loss" ? "가중 손실" : item.toUpperCase()}</button>)}</div></div>
      <div className="research-chart" aria-label={`${metricLabels[metric]} 비교 그래프`}>
        {chartModels.map(score => <button type="button" key={score.model.id} className={`research-bar-row ${score.model.role === "custom" ? "is-custom" : ""}`} onClick={() => setDetailId(score.model.id)} aria-label={`${score.model.name}, ${metricLabels[metric]} ${scoreText(score, metric)}, 상세 보기`}><span className="research-bar-name"><span>{ranks.get(score.model.id)}</span>{score.model.name}{score.model.role === "custom" && <b>내 모델</b>}</span><span className="research-bar-track"><span style={{ width: `${Math.max(score[metric] / maxBar * 100, 1)}%` }}/></span><strong>{scoreText(score, metric)}</strong></button>)}
      </div>
      <p className="table-note">상위 5개와 최종 결합·Extra Trees·요일 기준·CatBoost 대표 모델을 함께 표시합니다. 막대나 모델 이름을 누르면 조건과 구간별 성적을 볼 수 있습니다. 가중 손실 = P75 기준 과다 예측 + 3 × 부족 예측. WAPE·MAE는 P50 기준입니다.</p>
    </section>

    <section className="panel research-all-models">
      <div className="panel-heading"><div><p className="eyebrow">THE COMPLETE BENCHMARK</p><h2>전체 모델과 {candidateRuns.length}회 실험을 살펴보세요</h2></div><Button variant="outline" size="sm" onClick={() => view === "models" ? downloadVisibleScores(visibleScores, `${BENCHMARK.version}_${split}`) : downloadVisibleRuns(visibleRuns, `${BENCHMARK.version}_${split}`)}><Download size={15}/>현재 비교 CSV</Button></div>
      <div className="research-table-top"><div className="research-view-switch" role="group" aria-label="연구 결과 표시 방식"><button aria-pressed={view === "models"} onClick={() => setView("models")}>모델별 종합 <span>{BENCHMARK.models.length}</span></button><button aria-pressed={view === "runs"} onClick={() => { setView("runs"); setPage(1); }}>전체 실험 <span>{candidateRuns.length}</span></button></div><p className="quiet">최종 모델은 기본 {candidateRuns.length}회와 별도로 평가했습니다.</p></div>
      <div className="research-filter-row"><label className="research-search"><Search size={17}/><Input aria-label="연구 모델 검색" placeholder="모델명, 계열, 설정 검색" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }}/></label><label className="research-family"><SlidersHorizontal size={16}/><select aria-label="연구 모델 계열" value={family} onChange={event => { setFamily(event.target.value); setPage(1); }}><option value="all">모든 계열</option>{familyNames.map(name => <option key={name} value={name}>{name}</option>)}</select></label><span className="quiet" role="status">{view === "models" ? visibleScores.length : visibleRuns.length}개 결과</span></div>
      <div className="table-wrap research-table-wrap">
        {view === "models" ? <table className="research-table"><caption className="sr-only">{selectedSplit?.label ?? "전체 구간 합산"} 모델별 성적, {metricLabels[metric]} 오름차순</caption><thead><tr><th>순위</th><th>비교 모델</th><th>계열</th><th className="text-right">WAPE</th><th className="text-right">MAE</th><th className="text-right">가중 손실 <ArrowDown size={12} className={metric === "loss" ? "inline" : "hidden"}/></th><th className="text-right">관측 수</th></tr></thead><tbody>{visibleScores.map(score => <tr key={score.model.id} className={score.model.role === "custom" ? "highlight" : ""}><td className="number">{ranks.get(score.model.id)}</td><td><button className="research-model-link" onClick={() => setDetailId(score.model.id)}>{score.model.name}<ArrowUpRight size={13}/></button>{score.model.role === "custom" && <span className="badge-small ml-2">내 모델</span>}<div className="research-parameter-preview">{score.model.parameters}</div></td><td><span className="research-family-tag">{score.model.family}</span></td><td className="text-right number">{number(score.wape, 2)}%</td><td className="text-right number">{number(score.mae, 2)}</td><td className={`text-right number ${metric === "loss" ? "number-strong" : ""}`}>{number(score.loss, 0)}</td><td className="text-right number">{number(score.n, 0)}</td></tr>)}</tbody></table> : <table className="research-table"><caption className="sr-only">전체 기본 실험 결과</caption><thead><tr><th>실험</th><th>비교 모델</th><th>평가 구간</th><th className="text-right">WAPE</th><th className="text-right">MAE</th><th className="text-right">가중 손실</th><th className="text-right">관측 수</th></tr></thead><tbody>{pagedRuns.map(run => { const model = BENCHMARK.models.find(item => item.id === run.modelId)!; return <tr key={run.id}><td className="research-run-id">{run.id}</td><td><button className="research-model-link" onClick={() => setDetailId(model.id)}>{model.name}<ArrowUpRight size={13}/></button></td><td>{splitNames.get(run.splitId)}</td><td className="text-right number">{number(run.wape, 2)}%</td><td className="text-right number">{number(run.mae, 2)}</td><td className="text-right number number-strong">{number(run.loss, 0)}</td><td className="text-right number">{number(run.n, 0)}</td></tr>; })}</tbody></table>}
        {(view === "models" ? visibleScores.length : visibleRuns.length) === 0 && <div className="research-empty"><Search size={23}/><p>조건에 맞는 모델이 없습니다.</p><Button variant="ghost" onClick={() => { setQuery(""); setFamily("all"); }}>필터 초기화</Button></div>}
      </div>
      {view === "runs" && <div className="research-pagination"><span className="quiet">{visibleRuns.length ? (safePage - 1) * 18 + 1 : 0}–{Math.min(safePage * 18, visibleRuns.length)} / {visibleRuns.length}개</span><div><Button size="sm" variant="outline" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>이전</Button><span>{safePage} / {pageCount}</span><Button size="sm" variant="outline" disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>다음</Button></div></div>}
      <p className="table-note">{selectedSplit ? `${selectedSplit.testStart}~${selectedSplit.testEnd}` : "서로 겹치지 않는 3개 평가 구간 합산"} · {unit} 기준 · 전체 WAPE는 절대오차 합계 ÷ 실제값 합계로 계산합니다. 작은 성적 차이는 반복 실험에서 달라질 수 있습니다.</p>
    </section>

    {detail && <Dialog open onOpenChange={open => { if (!open) setDetailId(null); }}><DialogContent className="research-detail dialog-content-scroll sm:max-w-3xl"><DialogHeader><p className="eyebrow">MODEL DETAILS</p><DialogTitle>{detail.model.name}</DialogTitle><DialogDescription>{detail.model.description}</DialogDescription></DialogHeader><div className="research-settings"><strong>이번 실험 설정</strong><span>{detail.model.parameters}</span></div><div className="table-wrap"><table className="research-table"><thead><tr><th>평가 구간</th><th className="text-right">WAPE</th><th className="text-right">MAE</th><th className="text-right">과다 예측</th><th className="text-right">부족 예측</th><th className="text-right">가중 손실</th></tr></thead><tbody>{BENCHMARK.runs.filter(run => run.modelId === detail.model.id).map(run => <tr key={run.id}><td>{splitNames.get(run.splitId)}</td><td className="text-right number">{number(run.wape, 2)}%</td><td className="text-right number">{number(run.mae, 2)}</td><td className="text-right number">{number(run.over, 0)}</td><td className="text-right number">{number(run.under, 0)}</td><td className="text-right number">{number(run.loss, 0)}</td></tr>)}</tbody></table></div><p className="table-note">동일한 {unit} 단위 관측 기준. 과다·부족은 예측과 관측 판매량의 차이이며 실제 폐기나 미충족 수요가 아닙니다.</p>{detailWarnings.length > 0 && <details className="details-box"><summary>학습 진단 {detailWarnings.length}건 확인</summary><ul>{detailWarnings.map((item, index) => <li key={index}><strong>{item.split}</strong>: {item.message}</li>)}</ul></details>}</DialogContent></Dialog>}

    <section className="research-methodology panel"><div className="panel-heading"><div><p className="eyebrow">REPRODUCIBLE RESEARCH</p><h2>같은 조건으로, 미래를 보지 않고</h2></div><FileText size={22} className="micro-icon"/></div><p className="research-method-intro">{BENCHMARK.protocol.description}</p><div className="research-method-grid"><div><strong>데이터</strong><p>{BENCHMARK.dataset.title}</p><p>{BENCHMARK.dataset.start} ~ {BENCHMARK.dataset.end} · {number(BENCHMARK.dataset.rows, 0)}행 · {BENCHMARK.dataset.products.length}개 상품</p><a href={BENCHMARK.dataset.url} target="_blank" rel="noreferrer">공개 원자료 확인 <ArrowUpRight size={13}/></a></div><div><strong>예측 대상</strong><p>{BENCHMARK.dataset.target} · 단위 {unit}</p><p>{BENCHMARK.protocol.calibration}</p></div><div><strong>재현 정보</strong><p>실행 버전 {BENCHMARK.version}</p><p>난수 시드 {BENCHMARK.seed} · {BENCHMARK.generatedAt.slice(0, 10)} 계산</p><a href="https://github.com/SengangLemon/naeil-bbang" target="_blank" rel="noreferrer">GitHub 코드 <ArrowUpRight size={13}/></a></div></div><div className="research-split-grid">{BENCHMARK.splits.map(item => <div key={item.id}><strong>{item.label}</strong><p>학습 {item.trainStart} ~ {item.trainEnd}</p><p>보정 {item.calibrationStart} ~ {item.calibrationEnd}</p><p className="research-test-period">평가 {item.testStart} ~ {item.testEnd}</p><span>{number(item.n, 0)}개 관측</span></div>)}</div><details className="details-box"><summary>특징·평가 기준·해석할 때 알아둘 점</summary><p>{BENCHMARK.protocol.features.join(" · ")}</p><ul>{BENCHMARK.protocol.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details><div className="research-downloads"><a href={BENCHMARK.artifacts.resultsCsv} download><Download size={15}/>전체 실험 결과</a><a href={BENCHMARK.artifacts.predictionsCsv} download><Download size={15}/>실제값·예측값 원본</a><a href={BENCHMARK.artifacts.methodologyUrl} target="_blank" rel="noreferrer"><FileText size={15}/>실험 방법</a>{BENCHMARK.artifacts.verificationUrl && <a href={BENCHMARK.artifacts.verificationUrl} target="_blank" rel="noreferrer"><Check size={15}/>검증 결과</a>}{BENCHMARK.artifacts.sourceManifestUrl && <a href={BENCHMARK.artifacts.sourceManifestUrl} target="_blank" rel="noreferrer"><FileText size={15}/>출처·계산 기록</a>}</div></section>

    <details className="panel research-history"><summary>이전 대화의 비교 성적도 보기 <span>이번 실험과 별도</span></summary>{HISTORICAL_COMPARISONS.map(comparison => <div key={comparison.id}><p className="table-note">{comparison.note}</p><p className="table-note">{comparison.period} · {comparison.n}개 관측 · 원 대화 {comparison.sourceTurn}</p><div className="table-wrap"><table className="research-table"><thead><tr><th>비교 모델</th><th className="text-right">WAPE</th><th className="text-right">가중 손실</th></tr></thead><tbody>{comparison.rows.map(row => <tr key={row.model}><td>{row.model}</td><td className="text-right number">{row.wape === null ? "미확인" : number(row.wape, 2) + "%"}</td><td className="text-right number">{row.loss === null ? "미확인" : number(row.loss, 0)}</td></tr>)}</tbody></table></div></div>)}</details>

    <div className="research-store-link"><div><strong>이제 내 매장에서도 비교해 보세요.</strong><p>저장한 예측과 실제 판매를 비교하며 운영용 5개 모델의 성적을 쌓습니다.</p></div><Button onClick={onOpenStore}>매장 실적 비교 <ArrowRight size={16}/></Button></div>
  </div>;
}
