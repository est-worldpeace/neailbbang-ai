const assert=require('node:assert/strict');const fs=require('node:fs');
const engine=require('../work/test-cjs/model-engine.js');const {productionFor,metrics}=require('../work/test-cjs/metrics.js');
const pack=JSON.parse(fs.readFileSync('public/models/research-v1.json','utf8'));
const fixture=JSON.parse(fs.readFileSync('research/port-fixtures.json','utf8'));
let maxPrediction=0,maxFeature=0,maxShape=0;const per=[0,0,0,0];
for(const row of fixture.rows){const result=engine.predictBase(pack,row.x,row.shape,row.scale);result.forEach((q,m)=>q.forEach((value,k)=>{const difference=Math.abs(value-row.expected[m][k]);per[m]=Math.max(per[m],difference);maxPrediction=Math.max(maxPrediction,difference);}));}
console.log('Python vs portable inference maximum absolute difference',per);
assert(maxPrediction<1e-7,`prediction difference ${maxPrediction}`);
for(const row of fixture.feature_rows){const f=engine.makeFeatures(row.history,row.target,pack,row.product);for(const c of pack.columns){if(row.x[c]===null)assert.equal(f.x[c],null,c);else maxFeature=Math.max(maxFeature,Math.abs(f.x[c]-row.x[c]));}f.shape.forEach((x,i)=>maxShape=Math.max(maxShape,Math.abs(x-row.shape[i])));}
assert(maxFeature<1e-8);assert(maxShape<1e-8);console.log('Feature / FFT parity',maxFeature,maxShape);
let maxObjective=0;for(const c of fixture.weight_cases??[]){const w=engine.learnWeights(c.samples);const objective=engine.weightObjective(c.samples,w);const gap=objective-c.objective;maxObjective=Math.max(maxObjective,gap);console.log('Weight optimizer vs scipy SLSQP objective gap',gap);assert(gap<.00015);assert(Math.abs(w.reduce((a,b)=>a+b,0)-1)<1e-9);assert(w.every(x=>x>=0));}
assert.deepEqual(productionFor(101,{inventory:12,reservations:0,batch:6,capacity:null}),{quantity:90,capacityShortfall:0});
assert.deepEqual(productionFor(101,{inventory:12,reservations:0,batch:6,capacity:80}),{quantity:78,capacityShortfall:11});
assert.equal(productionFor(50,{inventory:10,reservations:70,batch:1,capacity:null}).quantity,60);
assert.equal(productionFor(30.000000000000004,{inventory:0,reservations:0,batch:1,capacity:null}).quantity,30);
console.log('Batch, reservations, available inventory, capacity, integer tolerance PASS');
fs.writeFileSync('research/engine-verification.json',JSON.stringify({pythonFixtures:fixture.rows.length,maxPredictionDifference:maxPrediction,maxFeatureDifference:maxFeature,maxShapeDifference:maxShape,maxWeightObjectiveGap:maxObjective,inventoryChecks:'passed'},null,2));
