export type LeftoverRecord = { date: string; leftover: number };
export type LeftoverModel = "last" | "mean3" | "mean5" | "mean10" | "ewma03" | "weekdayLast" | "weekdayMean" | "weekday2" | "ridgeCalendar";
export const LEFTOVER_STORAGE_KEY = "naeil-bbang:leftovers:v1";
export const LEFTOVER_MODELS: { key: LeftoverModel; name: string; explanation: string }[] = [
  { key: "ridgeCalendar", name: "요일·최근 추세 보정", explanation: "요일 차이와 시간에 따른 변화를 함께 반영합니다. 작은 표본의 과도한 보정을 줄입니다." },
  { key: "weekdayMean", name: "같은 요일 누적평균", explanation: "예측일 이전의 같은 요일 기록을 모두 평균합니다." },
  { key: "weekday2", name: "최근 같은 요일 2회 평균", explanation: "가장 최근 두 번의 같은 요일 기록을 평균합니다." },
  { key: "weekdayLast", name: "지난 같은 요일", explanation: "가장 최근 같은 요일의 잔량을 그대로 예측합니다." },
  { key: "mean5", name: "최근 5영업일 평균", explanation: "요일과 관계없이 직전 다섯 관측일의 잔량을 평균합니다." },
  { key: "mean10", name: "최근 10영업일 평균", explanation: "직전 열 관측일의 잔량을 평균합니다." },
  { key: "mean3", name: "최근 3영업일 평균", explanation: "직전 세 관측일의 잔량을 평균합니다." },
  { key: "ewma03", name: "지수평활", explanation: "최근 관측에 30%, 그 전까지의 추정에 70%를 반영합니다." },
  { key: "last", name: "직전 영업일", explanation: "바로 이전 관측일의 잔량을 그대로 예측합니다." },
];

// User-supplied store-wide closing counts, 2026-08-12 to 2026-09-13.
// These are remaining bread, not sales, production, or confirmed disposal.
export const PROVIDED_LEFTOVERS: LeftoverRecord[] = [
  ["2026-08-12", 3], ["2026-08-13", 8], ["2026-08-14", 10], ["2026-08-15", 23], ["2026-08-16", 30],
  ["2026-08-19", 7], ["2026-08-20", 15], ["2026-08-21", 20], ["2026-08-22", 15], ["2026-08-23", 20],
  ["2026-08-26", 12], ["2026-08-27", 10], ["2026-08-28", 14], ["2026-08-29", 10], ["2026-08-30", 40],
  ["2026-09-02", 8], ["2026-09-03", 20], ["2026-09-04", 10], ["2026-09-05", 20], ["2026-09-06", 25],
  ["2026-09-09", 21], ["2026-09-10", 23], ["2026-09-11", 20], ["2026-09-12", 10], ["2026-09-13", 30],
].map(([date, leftover]) => ({ date: String(date), leftover: Number(leftover) }));

const DAY = 86_400_000;
const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`);
const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
export const weekdayIndex = (date: string) => new Date(epoch(date)).getUTCDay();
export const weekdayLabel = (date: string) => "일월화수목금토"[weekdayIndex(date)];

export function validateLeftovers(value: unknown): LeftoverRecord[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("1~1,000일의 잔량을 입력해 주세요.");
  const seen = new Set<string>();
  const result = value.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`${i + 1}번째 기록을 확인해 주세요.`);
    const { date, leftover } = item as LeftoverRecord;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(epoch(date)) || new Date(epoch(date)).toISOString().slice(0, 10) !== date) throw new Error(`${i + 1}번째 날짜가 올바르지 않습니다.`);
    if (typeof leftover !== "number" || !Number.isSafeInteger(leftover) || leftover < 0 || leftover > 100000) throw new Error(`${date}: 잔량은 0~100,000 사이의 정수여야 합니다.`);
    if (seen.has(date)) throw new Error(`${date}가 중복되어 있습니다. 날짜마다 한 줄만 남겨 주세요.`);
    seen.add(date);
    return { date, leftover };
  });
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseLeftoverText(text: string): LeftoverRecord[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (/^(날짜|date)[,\t]/i.test(lines[0] ?? "")) lines.shift();
  return validateLeftovers(lines.map((line, i) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2})\s*[,\t ]\s*(\d+)\s*(?:개)?$/);
    if (!match) throw new Error(`${i + 1}번째 줄을 '2026-08-12,3' 형태로 입력해 주세요. 빈 수량은 0으로 처리하지 않습니다.`);
    return { date: match[1], leftover: Number(match[2]) };
  }));
}

export function leftoverText(rows: LeftoverRecord[]): string {
  return rows.map(r => `${r.date},${r.leftover}`).join("\n");
}

function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-12) throw new Error("요일·추세 계산에 필요한 기록이 부족합니다.");
    const scale = a[i][i];
    for (let c = i; c <= n; c++) a[i][c] /= scale;
    for (let r = 0; r < n; r++) if (r !== i) {
      const factor = a[r][i];
      for (let c = i; c <= n; c++) a[r][c] -= factor * a[i][c];
    }
  }
  return a.map(row => row[n]);
}

export function predictLeftovers(history: LeftoverRecord[], target: string): Record<LeftoverModel, number> {
  if (!history.length || history.some(r => r.date >= target)) throw new Error("예측일보다 이전의 기록만 사용할 수 있습니다.");
  const y = history.map(r => r.leftover);
  const same = history.filter(r => weekdayIndex(r.date) === weekdayIndex(target)).map(r => r.leftover);
  let smoothed = y[0];
  for (const value of y.slice(1)) smoothed = .3 * value + .7 * smoothed;
  // All seven weekday columns allow future Monday/Tuesday observations too.
  // Unobserved weekday columns are regularized to zero; existing Wed-Sun scores stay identical.
  const features = (date: string) => [1, ...Array.from({ length: 7 }, (_, i) => Number(weekdayIndex(date) === i)), (epoch(date) - epoch(history[0].date)) / (7 * DAY)];
  const x = history.map(r => features(r.date));
  const width = x[0].length;
  const matrix = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) => (i === j && i > 0 ? 1 : 0) + x.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const vector = Array.from({ length: width }, (_, i) => x.reduce((sum, row, j) => sum + row[i] * y[j], 0));
  const beta = solve(matrix, vector);
  const prediction = features(target).reduce((sum, v, i) => sum + v * beta[i], 0);
  return {
    last: y[y.length - 1], mean3: mean(y.slice(-3)), mean5: mean(y.slice(-5)), mean10: mean(y.slice(-10)), ewma03: smoothed,
    weekdayLast: same.length ? same[same.length - 1] : mean(y), weekdayMean: same.length ? mean(same) : mean(y),
    weekday2: same.length ? mean(same.slice(-2)) : mean(y), ridgeCalendar: Math.max(0, prediction),
  };
}

export type LeftoverPrediction = { date: string; actual: number; trainingDays: number; latestTrainingDate: string; predictions: Record<LeftoverModel, number> };
export function analyzeLeftovers(input: LeftoverRecord[], window: 10 | 15 | "all" = 10) {
  const rows = validateLeftovers(input);
  const total = rows.reduce((sum, row) => sum + row.leftover, 0);
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map(day => {
    const group = rows.filter(r => weekdayIndex(r.date) === day);
    const subtotal = group.reduce((sum, r) => sum + r.leftover, 0);
    return { day, name: "일월화수목금토"[day], count: group.length, total: subtotal, average: group.length ? subtotal / group.length : 0 };
  }).filter(r => r.count);
  const groups = new Map<string, LeftoverRecord[]>();
  for (const r of rows) {
    const monday = new Date(epoch(r.date) - ((weekdayIndex(r.date) + 6) % 7) * DAY).toISOString().slice(0, 10);
    groups.set(monday, [...(groups.get(monday) ?? []), r]);
  }
  const weeks = [...groups].map(([key, group]) => ({ key, start: group[0].date, end: group[group.length - 1].date, count: group.length, total: group.reduce((sum, r) => sum + r.leftover, 0) }));
  const start = window === "all" ? 10 : Math.max(10, rows.length - window);
  const daily: LeftoverPrediction[] = [];
  for (let i = start; i < rows.length; i++) daily.push({ date: rows[i].date, actual: rows[i].leftover, trainingDays: i, latestTrainingDate: rows[i - 1].date, predictions: predictLeftovers(rows.slice(0, i), rows[i].date) });
  const actualTotal = daily.reduce((sum, row) => sum + row.actual, 0);
  const scores = daily.length ? LEFTOVER_MODELS.map(model => {
    const absoluteError = daily.reduce((sum, r) => sum + Math.abs(r.predictions[model.key] - r.actual), 0);
    return { ...model, n: daily.length, mae: absoluteError / daily.length, wape: actualTotal ? absoluteError / actualTotal * 100 : null, bias: daily.reduce((sum, r) => sum + r.predictions[model.key] - r.actual, 0) / daily.length };
  }).sort((a, b) => a.mae - b.mae || a.key.localeCompare(b.key)).map((r, _, all) => ({ ...r, rank: 1 + all.filter(other => other.mae < r.mae - 1e-9).length })) : [];
  return { rows, total, average: total / rows.length, weekdays, weeks, daily, scores, winner: scores[0] ?? null };
}
