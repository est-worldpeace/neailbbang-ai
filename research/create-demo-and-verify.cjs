const fs=require('node:fs');const assert=require('node:assert/strict');
const engine=require('../work/test-cjs/model-engine.js');
const {addDays,localDate,weekday}=require('../work/test-cjs/bakery-types.js');
const {metrics}=require('../work/test-cjs/metrics.js');
const pack=JSON.parse(fs.readFileSync('public/models/research-v1.json','utf8'));
let seed=9132026;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const state={space:'demo',products:[{id:'demo-salt',name:'소금빵',batch:6,capacity:150,active:true},{id:'demo-croissant',name:'크루아상',batch:4,capacity:100,active:true},{id:'demo-loaf',name:'우유식빵',batch:2,capacity:60,active:true}],records:[],forecasts:[],plans:[]};
const levels=[65,40,24],today=localDate(),start=addDays(today,-42);let frozenAtStart=null;
for(let day=0;day<=42;day++){
 const date=addDays(start,day),pending=[];
 for(let p=0;p<3;p++){
  const product=state.products[p],prior=state.records.filter(r=>r.productId===product.id),opening=prior.at(-1)?.carry??0;
  const recent=prior.slice(-7),average=recent.length?recent.reduce((s,r)=>s+r.sales,0)/recent.length:levels[p];
  const produced=Math.max(product.batch,Math.ceil((average*(weekday(date)>=5?1.22:1.07)-opening)/product.batch)*product.batch);
  if(day>=21){const f=engine.buildForecast(pack,state,product,date,{inventory:opening,reservations:day%11===0?Math.round(levels[p]*.2):0,batch:product.batch,capacity:product.capacity});f.issuedAt=addDays(date,-1)+'T12:00:00.000Z';f.source='synthetic';state.forecasts.push(f);state.plans.push({id:f.id,forecastId:f.id,productId:product.id,target:date,quantity:produced,updatedAt:f.issuedAt});}
  if(day===42)continue;
  const demand=Math.max(0,Math.round(levels[p]*(weekday(date)>=5?1.28:.94)*(0.75+.5*random())+(day%13===0?10:0)));
  const available=opening+produced,sales=Math.min(demand,available),left=available-sales,waste=Math.round(left*(.35+.3*random())),closing=left-waste;
  pending.push({id:`demo|${product.id}|${date}`,productId:product.id,date,sales,opening,produced,closing,waste,carry:closing,adjustment:0,stockout:demand>available,temperature:Math.round((24+4*Math.sin(day/5))*10)/10,rain:day%6===0,event:day%13===0?'동네 행사':'',note:'가상 예시 데이터',source:'synthetic',updatedAt:date+'T12:00:00.000Z'});
 }
 // Reveal the day's outcomes only after every product has a forecast.
 state.records.push(...pending);
}
fs.writeFileSync('public/models/demo-state.json',JSON.stringify(state));
const score=metrics(state.forecasts,state.records);
assert(score.n>0&&score.stockoutExcluded>0);assert(state.records.every(r=>r.closing===r.opening+r.produced-r.sales-r.waste));
const before=JSON.stringify(state.forecasts);const target=addDays(today,1),product=state.products[0],context={inventory:4,reservations:10,batch:6,capacity:150};
const base=engine.buildForecast(pack,state,product,target,context);
const withFuture=structuredClone(state);
withFuture.records.push({...state.records[0],id:'future',date:target,sales:99999},{...state.records[0],id:'later',date:addDays(target,5),sales:123456});
const mutated=engine.buildForecast(pack,withFuture,product,target,context);
assert.deepEqual(base.models,mutated.models);assert.deepEqual(base.weights,mutated.weights);assert.deepEqual(base.experts,mutated.experts);assert.equal(JSON.stringify(state.forecasts),before);
const cold={...state,records:[state.records[0]],forecasts:[],plans:[]};const fallback=engine.buildForecast(pack,cold,product,addDays(state.records[0].date,1),context);assert.equal(fallback.mode,'fallback');assert(fallback.models.every(m=>m.p50===fallback.models[0].p50));
const checkForecast=state.forecasts.find(f=>state.records.some(r=>r.productId===f.productId&&r.date===f.target));
const unknownRecords=state.records.map(r=>r.productId===checkForecast.productId&&r.date===checkForecast.target?{...r,stockout:null}:r);
const knownStockout=state.records.map(r=>r.productId===checkForecast.productId&&r.date===checkForecast.target?{...r,stockout:true}:r);
assert.equal(metrics([checkForecast],unknownRecords).unknownStockout,1);assert.equal(metrics([checkForecast],knownStockout).n,0);
const report={synthetic:true,rows:state.records.length,frozenForecasts:state.forecasts.length,compared:score.n,stockoutExcluded:score.stockoutExcluded,
 futureAndSameDayOutcomeInvariant:true,frozenForecastsUnmodified:true,inventoryBalanced:true,coldStartLabeled:true,stockoutExclusion:true};
fs.writeFileSync('research/workflow-verification.json',JSON.stringify(report,null,2));console.log(report);
