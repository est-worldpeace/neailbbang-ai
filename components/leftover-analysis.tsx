"use client";

import { useMemo, useState } from "react";
import { Download, Save, Package, ChartNoAxesCombined, CalendarDays, Info } from "lucide-react";
import { Line, LineChart, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import { ChartContainer } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { LEFTOVER_MODELS, LEFTOVER_STORAGE_KEY, PROVIDED_LEFTOVERS, analyzeLeftovers, leftoverText, parseLeftoverText, validateLeftovers, weekdayLabel, type LeftoverModel } from "@/lib/leftover-analysis";

const fmt = (n: number | null, digits = 1) => n === null ? "—" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(n);
const shortDate = (date: string) => date.slice(5).replace("-", "/");
const chartConfig = { actual: { label: "실제 잔량", color: "#25354b" }, forecast: { label: "예측 잔량", color: "#c74916" } };
function initialData() {
  try {
    const stored = window.localStorage.getItem(LEFTOVER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.version !== 1) throw new Error("저장 형식");
      return { rows: validateLeftovers(parsed.rows), local: true, error: "" };
    }
    return { rows: PROVIDED_LEFTOVERS, local: false, error: "" };
  } catch {
    return { rows: PROVIDED_LEFTOVERS, local: false, error: "기기의 저장 기록을 읽지 못해 제공된 25일 기록을 표시합니다. 기존 저장 내용은 자동으로 바꾸지 않습니다." };
  }
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function LeftoverAnalysis() {
  const [data, setData] = useState(initialData);
  const [draft, setDraft] = useState(() => leftoverText(data.rows));
  const [error, setError] = useState(data.error);
  const [windowSize, setWindowSize] = useState<10 | 15 | "all">(10);
  const [selected, setSelected] = useState<LeftoverModel | "winner">("winner");
  const analysis = useMemo(() => analyzeLeftovers(data.rows, windowSize), [data.rows, windowSize]);
  const { rows, total, average, weekdays, weeks, daily, scores, winner } = analysis;
  const model = selected === "winner" ? winner?.key ?? "ridgeCalendar" : selected;
  const modelName = LEFTOVER_MODELS.find(m => m.key === model)!.name;
  const chartData = daily.map(r => ({ date: r.date, actual: r.actual, forecast: r.predictions[model] }));
  const biggest = [...weekdays].sort((a, b) => b.average - a.average)[0];
  const maximumWeekday = Math.max(...weekdays.map(w => w.average), 1);
  const maximumWeek = Math.max(...weeks.map(w => w.total), 1);
  const dirty = draft.trim() !== leftoverText(rows);

  function save() {
    try {
      const next = parseLeftoverText(draft);
      window.localStorage.setItem(LEFTOVER_STORAGE_KEY, JSON.stringify({ version: 1, rows: next }));
      setData({ rows: next, local: true, error: "" });
      setDraft(leftoverText(next)); setError("");
      toast.success(`${next.length}일의 기록으로 비교를 갱신했습니다.`);
    } catch (e) { setError(e instanceof Error ? e.message : "기록을 저장하지 못했습니다. 브라우저 저장 권한을 확인해 주세요."); }
  }

  function exportComparison() {
    const header = "날짜,방법,실제잔량,예측잔량,절대오차,학습기록수,마지막학습일";
    const lines = daily.flatMap(r => LEFTOVER_MODELS.map(m => [r.date, m.name, r.actual, r.predictions[m.key].toFixed(6), Math.abs(r.predictions[m.key] - r.actual).toFixed(6), r.trainingDays, r.latestTrainingDate].join(",")));
    download("남은빵_모델별_예측비교.csv", [header, ...lines].join("\n"));
  }

  return <div className="leftover-lab">
    <div className="leftover-source"><span className="tag">{data.local ? "이 기기에 저장한 기록" : "제공된 실제 매장 기록"}</span><span>{rows[0].date} ~ {rows[rows.length - 1].date} · {rows.length}일</span><span>매장 전체 · 마감 후 남은 빵</span></div>
    <div className="summary-stats">
      <div className="stat"><p className="stat-label"><Package size={16} />일별 잔량 합계</p><p className="stat-value" data-testid="leftover-total">{fmt(total, 0)}<small>개</small></p><p className="stat-foot">일별 기록의 합계 · 실제 폐기와 구분</p></div>
      <div className="stat"><p className="stat-label"><CalendarDays size={16} />하루 평균 잔량</p><p className="stat-value">{fmt(average, 2)}<small>개</small></p><p className="stat-foot">기록이 있는 {rows.length}일 기준</p></div>
      <div className="stat"><p className="stat-label"><ChartNoAxesCombined size={16} />가장 많이 남는 요일</p><p className="stat-value">{biggest.name}요일<small>{fmt(biggest.average)}개</small></p><p className="stat-foot">같은 요일 {biggest.count}회 평균</p></div>
    </div>

    <div className="leftover-two-columns">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">요일별 잔량</p><h2>{biggest.name}요일 생산·마감을 먼저 점검해요</h2></div></div><div className="leftover-bars">{weekdays.map(w => <div className="leftover-bar-row" key={w.day}><span>{w.name}요일<small>{w.count}회</small></span><div className="leftover-track"><div style={{ width: `${w.average / maximumWeekday * 100}%` }} className={w.day === biggest.day ? "leftover-bar accent" : "leftover-bar"} /></div><strong>{fmt(w.average)}<small>개</small></strong></div>)}</div><p className="table-note">요일별 하루 평균입니다. {biggest.name}요일의 일별 잔량 합계는 {fmt(biggest.total, 0)}개{total > 0 ? `로, 전체 합계의 ${fmt(biggest.total / total * 100)}%입니다.` : "입니다."} 평균 잔량만큼 바로 감산하라는 뜻은 아닙니다.</p></section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">주별 변화</p><h2>남는 수량이 늘었는지 확인해요</h2></div></div><div className="leftover-bars">{weeks.map(w => <div className="leftover-bar-row week" key={w.key}><span>{shortDate(w.start)}–{shortDate(w.end)}<small>{w.count}일 기록</small></span><div className="leftover-track"><div className="leftover-bar" style={{ width: `${w.total / maximumWeek * 100}%` }} /></div><strong>{fmt(w.total, 0)}<small>개</small></strong></div>)}</div><p className="table-note">월~일 기준 주별 합계입니다. 기록일 수가 다르면 합계만으로 증감을 판단하지 마세요. 기록이 없는 날짜는 0으로 채우지 않습니다.</p></section>
    </div>

    <section className="panel">
      <div className="panel-heading leftover-heading"><div><p className="eyebrow">같은 날짜에서 예측 비교</p><h2>어떤 방법이 잔량을 잘 맞혔을까요?</h2></div><label className="leftover-select">평가기간<select aria-label="잔량 예측 평가기간" value={String(windowSize)} onChange={e => setWindowSize(e.target.value === "all" ? "all" : Number(e.target.value) as 10 | 15)}><option value="10">최근 10기록일</option><option value="15">최근 15기록일</option><option value="all">첫 10일 학습 후 전체</option></select></label></div>
      {winner ? <>
        <div className="leftover-winner"><div><span className="leftover-winner-label">이번 평가의 최저 오차</span><h3 data-testid="leftover-winner">{winner.name}</h3><p>{daily[0].date} ~ {daily[daily.length - 1].date} · {daily.length}일 · 9가지 방법</p></div><div><strong>{fmt(winner.mae, 2)}<small>개 / 일</small></strong><span>평균 절대오차 · 작을수록 좋아요</span></div></div>
        <p className="operation-note">각 날짜를 예측할 때 그 날짜 이전의 실제 기록만 사용했습니다. 결과는 잔량 예측의 과거 검증이며, 실제 폐기 감소 효과나 판매 수요 예측 성적이 아닙니다.</p>
        <div className="table-wrap leftover-ranking"><table><caption className="sr-only">남은 빵 예측 방법별 오차 순위</caption><thead><tr><th>순위</th><th>예측 방법</th><th className="text-right">하루 평균 오차</th><th className="text-right">WAPE</th><th>차트</th></tr></thead><tbody>{scores.map(s => <tr key={s.key} className={s.rank === 1 ? "leftover-best" : ""}><td>{s.rank}위</td><td><strong>{s.name}</strong></td><td className="text-right number">{fmt(s.mae, 2)}개</td><td className="text-right number">{fmt(s.wape, 2)}{s.wape === null ? "" : "%"}</td><td><button className="leftover-chart-button" aria-label={`${s.name} 날짜별 비교`} aria-pressed={model === s.key} onClick={() => setSelected(s.key)}>{model === s.key ? "보는 중" : "보기"}</button></td></tr>)}</tbody></table></div>
        <p className="table-note">평균 절대오차가 작은 순서입니다. 짧은 평가기간의 잠정 순위이며 앞으로도 같은 방법이 1위라는 뜻은 아닙니다. WAPE는 절대오차 합계 ÷ 실제 잔량 합계이며 정확도와 다릅니다. 실제 합계가 0이면 표시하지 않습니다. 같은 점수는 공동 순위입니다.</p>
      </> : <div className="intro-callout"><strong>예측 비교는 11일째 기록부터 가능해요.</strong><p className="operation-note">처음 10일을 학습한 뒤 나머지 날짜를 예측합니다. 현재 {rows.length}일의 기록이 있습니다.</p></div>}
      <div className="leftover-scope"><Info size={18} /><p><strong>기존 최종 모델·Chronos-Bolt Small은 이번 잔량 평가에 포함하지 않았습니다.</strong> 기존 공개자료의 판매예측 성적은 ‘전체 모델 비교’에서 확인할 수 있습니다. 평가 대상과 날짜가 달라 이 표에 순위를 섞지 않습니다.</p></div>
    </section>

    {daily.length > 0 && <section className="panel"><div className="panel-heading leftover-heading"><div><p className="eyebrow">날짜별 실제와 예측</p><h2>어느 날 차이가 컸는지 살펴봐요</h2></div><label className="leftover-select">비교 방법<select aria-label="날짜별 비교 방법" value={selected} onChange={e => setSelected(e.target.value as LeftoverModel | "winner")}><option value="winner">현재 1위 방법</option>{LEFTOVER_MODELS.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}</select></label></div>
      <p className="quiet">{modelName} · {LEFTOVER_MODELS.find(m => m.key === model)!.explanation}</p>
      <ChartContainer config={chartConfig} className="leftover-chart !aspect-auto"><LineChart data={chartData} margin={{ top: 20, right: 16, bottom: 4, left: 0 }} accessibilityLayer><CartesianGrid vertical={false} strokeDasharray="3 4" /><XAxis dataKey="date" tickFormatter={shortDate} minTickGap={22} tickLine={false} axisLine={false} /><YAxis width={40} domain={[0, "auto"]} tickLine={false} axisLine={false} /><Tooltip labelFormatter={v => String(v)} formatter={(v, name) => [`${fmt(Number(v), 2)}개`, name]} contentStyle={{ borderRadius: 12, border: "1px solid #dce3eb" }} /><Line type="linear" dataKey="actual" name="실제 잔량" stroke="#25354b" strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} /><Line type="linear" dataKey="forecast" name="예측 잔량" stroke="#c74916" strokeWidth={2.5} strokeDasharray="6 4" dot={false} isAnimationActive={false} /></LineChart></ChartContainer>
      <div className="chart-legend"><span><i className="legend-line" style={{ background: "#25354b" }} />실제 잔량</span><span><i className="legend-line" style={{ background: "#c74916" }} />예측 잔량 (점선)</span></div>
      <details className="leftover-details"><summary>날짜별 수치와 오차 보기</summary><div className="table-wrap"><table><thead><tr><th>날짜</th><th className="text-right">실제 잔량</th><th className="text-right">예측 잔량</th><th className="text-right">절대오차</th><th>학습 기록</th></tr></thead><tbody>{daily.map(r => <tr key={r.date}><td>{r.date} ({weekdayLabel(r.date)})</td><td className="text-right">{r.actual}개</td><td className="text-right">{fmt(r.predictions[model], 2)}개</td><td className="text-right">{fmt(Math.abs(r.predictions[model] - r.actual), 2)}개</td><td>{r.trainingDays}일 · {r.latestTrainingDate}까지</td></tr>)}</tbody></table></div></details>
      <Button variant="outline" className="mt-4" onClick={exportComparison}><Download size={16} />9가지 방법의 날짜별 비교 CSV</Button>
    </section>}

    <section className="panel"><div className="panel-heading leftover-heading"><div><p className="eyebrow">분석에 쓰는 기록</p><h2>기록을 추가하면 비교도 갱신돼요</h2></div><Button variant="outline" onClick={() => download("남은빵_일별기록.csv", "날짜,남은빵\n" + leftoverText(rows))}><Download size={16} />잔량 기록 CSV</Button></div><p className="quiet">처음에는 제공해 주신 2026년 8월 12일~9월 13일의 25일 기록을 표시합니다. 수정·추가한 기록은 이 기기의 브라우저에 저장됩니다. 판매·생산 기록과는 별도로 관리합니다.</p>
      <details className="leftover-details"><summary>일별 잔량 {rows.length}일 확인</summary><div className="table-wrap leftover-record-table"><table><thead><tr><th>날짜</th><th>요일</th><th className="text-right">남은 빵</th></tr></thead><tbody>{rows.map(r => <tr key={r.date}><td>{r.date}</td><td>{weekdayLabel(r.date)}요일</td><td className="text-right">{r.leftover}개</td></tr>)}</tbody></table></div></details>
      <details className="leftover-details"><summary>기록 수정·추가</summary><label htmlFor="leftover-records" className="block mt-4 mb-2">한 줄에 날짜,남은 빵 수를 입력해 주세요.</label><Textarea id="leftover-records" className="leftover-input" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} /><p className="table-note">예: 2026-09-16,12 · 빈 수량이나 중복 날짜는 저장하지 않습니다. 휴무·누락 날짜는 줄을 추가하지 마세요.</p><Button onClick={save} disabled={!dirty}><Save size={16} />이 기기에 저장하고 재분석</Button>{dirty && <p className="operation-note">저장 전까지 위 결과는 이전 기록을 기준으로 표시합니다.</p>}</details>
      {error && <p role="alert" className="leftover-error">{error}</p>}
      <div className="leftover-scope"><Info size={18} /><p>남은 빵의 실제 폐기·러스크 전환·다음 날 이월 여부는 확인되지 않았습니다. 이월품이 반복 집계되면 합계는 서로 다른 빵의 개수와 다를 수 있습니다. 생산량·전체 판매수량·품절 기록을 더 모아야 폐기율과 적절한 생산량까지 판단할 수 있습니다.</p></div>
    </section>
  </div>;
}
