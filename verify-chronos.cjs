// Independently reconcile exported forecasts and the presentation/browser scores.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, 'public/research/chronos');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
const rolling = JSON.parse(fs.readFileSync(path.join(dir, '../rolling/analysis.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(dir, '../benchmark.json'), 'utf8'));
assert.equal(data.status, 'completed');
const verification = JSON.parse(fs.readFileSync(path.join(dir, 'verification.json'), 'utf8'));
assert.equal(verification.status, 'passed');
for (const field of ['same974ObservationKeysForEverySeries', 'everyContextEndsTargetMinusOneDay', 'everyScoredDayResidualMutationInvariant', 'originalSourceHashesPreserved', 'checkpointWeightSha256Verified', 'officialQuantileInterpolationIndependentlyReconstructed']) assert.equal(verification[field], true);
assert.equal(verification.fineTuned, false);
const same = (a, b, label) => assert(Number.isFinite(a) && Math.abs(a - b) < 1e-7 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
function csv(file) {
  const records = [], rows = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  function cells(line) {
    const result = []; let value = '', quote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { if (quote && line[i + 1] === '"') { value += '"'; i++; } else quote = !quote; }
      else if (line[i] === ',' && !quote) { result.push(value); value = ''; }
      else value += line[i];
    }
    assert(!quote); result.push(value); return result;
  }
  const header = cells(rows.shift());
  for (const line of rows) { const values = cells(line); assert.equal(values.length, header.length); records.push(Object.fromEntries(header.map((key, i) => [key, values[i]]))); }
  return records;
}
const ownId = 'custom/custom-weekly-daily';
const sourceRows = csv(path.join(dir, '../rolling/predictions.csv'));
const canonical = new Map(sourceRows.filter(row => row.seriesId === ownId).map(row => [`${row.splitId}|${row.date}|${row.product}`, Number(row.y)]));
assert.equal(canonical.size, 974);
const predictions = csv(path.join(dir, 'predictions.csv'));
assert.equal(predictions.length, 5 * 974);
const seriesIds = ['chronos/raw', 'chronos/daily56'];
const measure = rows => {
  const n = rows.length, actualTotal = rows.reduce((sum, row) => sum + Number(row.y), 0);
  const absoluteError = rows.reduce((sum, row) => sum + Math.abs(Number(row.y) - Number(row.p50)), 0);
  const over = rows.reduce((sum, row) => sum + Math.max(Number(row.quantity) - Number(row.y), 0), 0);
  const under = rows.reduce((sum, row) => sum + Math.max(Number(row.y) - Number(row.quantity), 0), 0);
  return { n, actualTotal, absoluteError, wape: 100 * absoluteError / actualTotal, mae: absoluteError / n, over, under, loss: over + 3 * under };
};
function check(row, rows) {
  assert(row && rows.length, 'Missing metric row');
  const measured = measure(rows);
  for (const field of ['n', 'actualTotal', 'wape', 'mae', 'over', 'under', 'loss']) same(row[field], measured[field], `${row.seriesId} ${field}`);
}
for (const id of seriesIds) {
  const rows = predictions.filter(row => row.seriesId === id), keys = new Set();
  assert.equal(rows.length, 974);
  for (const row of rows) {
    const key = `${row.splitId}|${row.date}|${row.product}`;
    assert(canonical.has(key) && !keys.has(key)); keys.add(key);
    assert.equal(Number(row.y), canonical.get(key));
    const values = ['p50', 'q75', 'quantity'].map(name => Number(row[name]));
    assert(values.every(Number.isFinite));
    const [p50, q75, quantity] = values;
    assert(p50 >= 0 && q75 >= p50 - 1e-8 && Number.isInteger(quantity));
    const nearest = Math.round(q75);
    assert.equal(quantity, Math.ceil(Math.abs(q75 - nearest) < 1e-9 ? nearest : q75));
  }
  const row = data.aggregate.find(row => row.seriesId === id);
  check(row, rows);
  for (const split of baseline.splits) check(data.bySplit.find(row => row.seriesId === id && row.splitId === split.id), rows.filter(row => row.splitId === split.id));
  for (const product of baseline.dataset.products) check(data.byProduct.find(row => row.seriesId === id && String(row.product) === String(product.id)), rows.filter(row => Number(row.product) === product.id));
  if (row.rankVsRolling35) {
    const references = rolling.aggregate.filter(row => row.group === 'rolling' || row.seriesId === ownId);
    assert.equal(references.length, 35);
    for (const metric of ['loss', 'wape', 'mae']) assert.equal(row.rankVsRolling35[metric], 1 + references.filter(other => other[metric] < row[metric]).length);
  }
}
for (const row of data.aggregate.filter(row => !seriesIds.includes(row.seriesId))) {
  const source = rolling.aggregate.find(other => other.seriesId === row.seriesId); assert(source);
  for (const key of ['n', 'actualTotal', 'wape', 'mae', 'over', 'under', 'loss']) same(row[key], source[key], `Preserved reference ${key}`);
}
for (const [key, field] of [['bySplit', 'splitId'], ['byProduct', 'product']]) for (const row of data[key].filter(row => !seriesIds.includes(row.seriesId))) {
  const source = rolling[key].find(other => other.seriesId === row.seriesId && other[field] === row[field]); assert(source);
  for (const metric of ['n', 'actualTotal', 'wape', 'mae', 'over', 'under', 'loss']) same(row[metric], source[metric], `Preserved ${key} ${metric}`);
}
const referenceIds = new Set(data.aggregate.filter(row => !seriesIds.includes(row.seriesId)).map(row => row.seriesId));
const originalForecasts = new Map(sourceRows.filter(row => referenceIds.has(row.seriesId)).map(row => [`${row.seriesId}|${row.splitId}|${row.date}|${row.product}`, row]));
for (const row of predictions.filter(row => referenceIds.has(row.seriesId))) {
  const source = originalForecasts.get(`${row.seriesId}|${row.splitId}|${row.date}|${row.product}`); assert(source);
  for (const field of ['y', 'p50', 'q75', 'quantity']) assert.equal(Number(row[field]), Number(source[field]));
}
const contexts = csv(path.join(dir, 'contexts.csv'));
assert.equal(contexts.length, verification.uniqueActualInferenceContexts);
assert(contexts.length > 974);
const contextKeys = new Set();
for (const row of contexts) {
  const key = `${row.date}|${row.product}`; assert(!contextKeys.has(key)); contextKeys.add(key);
  assert.equal(Number(row.calendarSlots), 512);
  assert.equal(Number(row.observedSlots) + Number(row.nanSlots), 512);
  const end = new Date(`${row.contextLastDate}T00:00:00Z`).getTime(), start = new Date(`${row.contextFirstDate}T00:00:00Z`).getTime(), target = new Date(`${row.date}T00:00:00Z`).getTime();
  assert.equal(target - end, 86400000); assert.equal(end - start, 511 * 86400000);
  assert(/^[0-9a-f]{64}$/.test(row.contextSha256));
}
const updates = csv(path.join(dir, 'daily-updates.csv'));
assert.equal(updates.length, 974);
for (const row of updates) {
  assert(canonical.has(`${row.splitId}|${row.date}|${row.product}`));
  assert(row.residualFirstOutcome <= row.residualLatestOutcome && row.residualLatestOutcome < row.date);
  assert(Number(row.residualRows) > 0);
}
assert(data.pairedComparisons.length >= 12);
for (const pair of data.pairedComparisons) {
  const a = data.aggregate.find(row => row.seriesId === pair.variantSeriesId), b = data.aggregate.find(row => row.seriesId === pair.referenceSeriesId); assert(a && b);
  same(pair.lossDelta, a.loss - b.loss, 'Paired delta');
  assert([7, 14].includes(pair.blockDays) && pair.confidence95.length === 2);
  assert(pair.confidence95.every(Number.isFinite) && pair.confidence95[0] <= pair.confidence95[1]);
  assert.equal(pair.confidenceIncludesZero, pair.confidence95[0] <= 0 && pair.confidence95[1] >= 0);
}
const compact = Object.fromEntries(['version', 'status', 'generatedAt', 'aggregate', 'bySplit', 'pairedComparisons'].map(key => [key, data[key]]));
fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify(compact) + '\n');
console.log('Verified both Chronos variants on the same 974 observations, all split/product scores and preserved references; browser data generated.');
