// Recompute published rolling scores independently before shipping the app.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, 'public/research/rolling');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const data = read('analysis.json');
const verification = read('verification.json');
const original = JSON.parse(fs.readFileSync(path.join(dir, '../benchmark.json'), 'utf8'));
assert.equal(data.status, 'completed');
assert.equal(verification.status, 'passed');
assert.equal(verification.original35MetricsPreserved, true);
assert.equal(verification.sameDayAndFutureCalibrationTargetMutationInvariant, true);
assert.equal(verification.actualDateCutoffsAssertedForEveryUpdate, true);
assert.equal(data.series.filter(s => s.group === 'fixed').length, 35);
assert.equal(data.series.filter(s => s.group === 'rolling').length, 34);
assert.equal(data.series.length, verification.series);
const series = new Map(data.series.map(s => [s.seriesId, s]));
const splits = new Map(original.splits.map(s => [s.id, s]));
const same = (a, b, label) => assert(Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
const group = () => ({ n: 0, actualTotal: 0, absoluteError: 0, over: 0, under: 0, keys: new Set() });
const aggregate = new Map(), bySplit = new Map(), byProduct = new Map(), actuals = new Map();
const csv = fs.readFileSync(path.join(dir, 'predictions.csv'), 'utf8').trim().split(/\r?\n/);
assert.deepEqual(csv.shift().split(','), ['seriesId', 'variantId', 'modelId', 'group', 'splitId', 'date', 'product', 'y', 'p50', 'q75', 'quantity']);
for (const line of csv) {
  const [id, variant, model, kind, splitId, date, product, ...numbers] = line.split(',');
  const [y, p50, q75, quantity] = numbers.map(Number);
  const definition = series.get(id), split = splits.get(splitId);
  assert(definition && split);
  assert.equal(definition.variantId, variant); assert.equal(definition.modelId, model); assert.equal(definition.group, kind);
  assert.equal(numbers.length, 4);
  assert([y, p50, q75, quantity].every(Number.isFinite));
  assert(y >= 0 && p50 >= 0 && q75 >= p50 - 1e-8 && Number.isInteger(quantity));
  assert(quantity >= q75 - 1e-8 && quantity < q75 + 1 + 1e-8);
  assert(date >= split.testStart && date <= split.testEnd);
  const key = `${splitId}|${date}|${product}`;
  if (actuals.has(key)) assert.equal(actuals.get(key), y); else actuals.set(key, y);
  for (const [map, mapKey] of [[aggregate, id], [bySplit, `${id}|${splitId}`], [byProduct, `${id}|${product}`]]) {
    const g = map.get(mapKey) ?? group();
    assert(!g.keys.has(key), `Repeated observation: ${mapKey}/${key}`);
    g.keys.add(key); g.n++; g.actualTotal += y; g.absoluteError += Math.abs(y - p50);
    g.over += Math.max(quantity - y, 0); g.under += Math.max(y - quantity, 0);
    map.set(mapKey, g);
  }
}
assert.equal(csv.length, verification.predictionRows);
assert.equal(actuals.size, 974);
assert.equal(aggregate.size, series.size);
const evaluate = g => ({ ...g, wape: 100 * g.absoluteError / g.actualTotal, mae: g.absoluteError / g.n, loss: g.over + 3 * g.under });
function check(row, g) {
  assert(g);
  const m = evaluate(g);
  for (const key of ['n', 'actualTotal', 'absoluteError', 'wape', 'mae', 'over', 'under', 'loss']) same(row[key], m[key], `${row.seriesId} ${key}`);
}
for (const row of data.aggregate) {
  const g = aggregate.get(row.seriesId); check(row, g);
  assert.equal(g.n, 974);
  assert([...actuals.keys()].every(key => g.keys.has(key)));
  for (const [kind, rankKey] of [['fixed', 'rankVsFixed34'], ['rolling', 'rankVsRolling34']]) {
    const competitors = data.aggregate.filter(r => r.group === kind && r.modelId !== 'custom-final' && r.seriesId !== row.seriesId);
    for (const metric of ['loss', 'wape', 'mae']) assert.equal(row[rankKey][metric], 1 + competitors.filter(r => r[metric] < row[metric]).length);
  }
}
for (const row of data.bySplit) check(row, bySplit.get(`${row.seriesId}|${row.splitId}`));
for (const row of data.byProduct) check(row, byProduct.get(`${row.seriesId}|${row.product}`));
for (const run of original.runs) {
  const m = evaluate(bySplit.get(`fixed/${run.modelId}|${run.splitId}`));
  for (const key of ['n', 'actualTotal', 'wape', 'mae', 'over', 'under', 'loss']) same(run[key], m[key], `Preserved ${run.id} ${key}`);
}
for (const pair of data.pairedComparisons) {
  const a = evaluate(aggregate.get(pair.variantSeriesId)), b = evaluate(aggregate.get(pair.referenceSeriesId));
  same(pair.lossDelta, a.loss - b.loss, 'Paired loss delta');
  same(pair.overDelta + 3 * pair.underDelta, pair.lossDelta, 'Loss decomposition');
  assert(pair.confidence95.length === 2 && pair.confidence95[0] <= pair.confidence95[1]);
  assert.equal(pair.confidenceIncludesZero, pair.confidence95[0] <= 0 && pair.confidence95[1] >= 0);
}
const updates = fs.readFileSync(path.join(dir, 'daily-updates.csv'), 'utf8').trim().split(/\r?\n/);
const columns = updates.shift().split(',');
const field = (cells, name) => cells[columns.indexOf(name)];
for (const line of updates) {
  const cells = line.split(','), date = field(cells, 'date');
  assert(field(cells, 'weightLatestOutcome') < field(cells, 'weightCutoffExclusive'));
  assert(field(cells, 'weightCutoffExclusive') <= date);
  assert(field(cells, 'residualLatestOutcome') < date);
  const weights = columns.flatMap((name, i) => name.startsWith('weight_') ? [Number(cells[i])] : []);
  assert.equal(weights.length, 5); assert(weights.every(w => Number.isFinite(w) && w >= -1e-7));
  same(weights.reduce((a, b) => a + b, 0), 1, 'Expert weights');
}
assert.equal(updates.length, data.variants.length * 974);
// Keep the browser payload small. Full source, update logs and results remain downloadable.
const compact = Object.fromEntries(['version', 'status', 'generatedAt', 'primarySeriesId', 'aggregate', 'bySplit', 'pairedComparisons'].map(key => [key, data[key]]));
fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify(compact) + '\n');
console.log(`Verified ${series.size} preserved and rolling series, ${csv.length} predictions, ${updates.length} causal update records; browser data generated.`);
