// A production build must contain complete, independently recomputed results.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "public", "research");
const benchmark = JSON.parse(fs.readFileSync(path.join(root, "benchmark.json"), "utf8"));
const verification = JSON.parse(fs.readFileSync(path.join(root, "verification.json"), "utf8"));
const models = new Map(benchmark.models.map(model => [model.id, model]));
const splits = new Map(benchmark.splits.map(split => [split.id, split]));
assert.equal(benchmark.status, "completed", "Benchmark is still being calculated");
assert.equal(verification.status, "passed");
assert.equal(models.size, 35);
assert.equal(benchmark.models.filter(model => model.role === "candidate").length, 34);
assert.equal(benchmark.models.filter(model => model.role === "custom").length, 1);
assert.equal(splits.size, 3);
assert.equal(benchmark.runs.length, 105);
assert(benchmark.dataset.rows > 0 && benchmark.dataset.products.length === 6);

const same = (actual, expected, label) => assert(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
const groups = new Map();
const observed = new Map();
const csv = fs.readFileSync(path.join(root, "predictions.csv"), "utf8").trim().split(/\r?\n/);
const header = csv.shift().split(",");
assert.deepEqual(header, ["modelId", "splitId", "date", "product", "y", "p50", "q75", "quantity"]);
for (const line of csv) {
  const [modelId, splitId, date, product, ...numeric] = line.split(",");
  assert(models.has(modelId) && splits.has(splitId));
  const [y, p50, q75, quantity] = numeric.map(Number);
  assert.equal(numeric.length, 4);
  assert([y, p50, q75, quantity].every(Number.isFinite));
  assert(y >= 0 && p50 >= 0 && q75 >= p50 - 1e-8 && quantity >= 0 && Number.isInteger(quantity));
  // CSV decimal serialization may lie extremely close to an integer boundary.
  assert(quantity >= q75 - 1e-8 && quantity < q75 + 1 + 1e-8);
  const split = splits.get(splitId);
  assert(split.trainEnd < split.calibrationStart && split.calibrationEnd < split.testStart);
  assert(date >= split.testStart && date <= split.testEnd);
  const key = `${splitId}|${date}|${product}`;
  if (observed.has(key)) assert.equal(y, observed.get(key));
  else observed.set(key, y);
  const groupKey = `${modelId}|${splitId}`;
  const group = groups.get(groupKey) ?? { keys: new Set(), n: 0, actual: 0, absolute: 0, over: 0, under: 0 };
  assert(!group.keys.has(key), `Duplicate prediction ${groupKey}|${key}`);
  group.keys.add(key);
  group.n++;
  group.actual += y;
  group.absolute += Math.abs(p50 - y);
  group.over += Math.max(0, quantity - y);
  group.under += Math.max(0, y - quantity);
  groups.set(groupKey, group);
}
assert.equal(groups.size, 105);
const runKeys = new Set();
for (const run of benchmark.runs) {
  const key = `${run.modelId}|${run.splitId}`;
  assert(!runKeys.has(key));
  runKeys.add(key);
  const group = groups.get(key);
  assert(group);
  assert.equal(run.status, "completed");
  assert.equal(run.n, splits.get(run.splitId).n);
  assert.equal(run.n, group.n);
  same(run.actualTotal, group.actual, `${key} actual total`);
  same(run.mae, group.absolute / group.n, `${key} MAE`);
  same(run.wape, 100 * group.absolute / group.actual, `${key} WAPE`);
  same(run.over, group.over, `${key} over`);
  same(run.under, group.under, `${key} under`);
  same(run.loss, group.over + 3 * group.under, `${key} loss`);
  assert(Number.isFinite(run.fitSeconds) && run.fitSeconds >= 0);
}
for (const splitId of splits.keys()) {
  const expected = [...observed.keys()].filter(key => key.startsWith(`${splitId}|`));
  assert.equal(expected.length, splits.get(splitId).n);
  for (const modelId of models.keys()) {
    const group = groups.get(`${modelId}|${splitId}`);
    assert(expected.every(key => group.keys.has(key)));
  }
}
console.log(`Verified 102 candidate runs + 3 custom runs; ${csv.length} predictions; every metric recomputed from exported CSV.`);
