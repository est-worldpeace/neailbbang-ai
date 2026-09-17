const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const root=path.resolve(__dirname,'..'),modules=new Map();

// Exercise the real route and validation modules, compiling TypeScript only in memory.
function load(relative){
 const filename=path.resolve(root,relative.endsWith('.ts')?relative:relative+'.ts');
 if(modules.has(filename))return modules.get(filename).exports;
 const source=fs.readFileSync(filename,'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};modules.set(filename,module);
 const fromModule=id=>id.startsWith('@/')?load(id.slice(2)):id.startsWith('.')?load(path.resolve(path.dirname(filename),id)):require(id);
 new Function('require','module','exports',compiled)(fromModule,module,module.exports);
 return module.exports;
}
const api=load('app/api/bakery/route.ts');
const {parseAppState}=load('lib/state-validation.ts');
const {metrics}=load('lib/metrics.ts');
const {addDays,localDate}=load('lib/bakery-types.ts');
const empty=space=>({space,products:[],records:[],forecasts:[],plans:[]});
const request=body=>new Request('https://bakery.test/api/bakery',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://bakery.test'},body:JSON.stringify(body)});
async function post(state,action,payload={},expected=200){
 const before=JSON.stringify(state);
 const response=await api.POST(request({space:state.space,action,state,...payload}));
 const data=await response.json();
 assert.equal(response.status,expected,JSON.stringify(data));
 assert.equal(JSON.stringify(state),before,'Caller-owned state must remain unchanged');
 if(expected===200){assert(data.state,'Every successful action returns state');assert.deepEqual(data.state,parseAppState(data.state,state.space));}
 return data;
}

test('independent browser states never share records or products',async()=>{
 const [a,b]=await Promise.all([
  post(empty('real'),'product_save',{product:{name:'A 빵집',batch:2,capacity:20}}),
  post(empty('real'),'product_save',{product:{name:'B 빵집',batch:3,capacity:30}}),
 ]);
 assert.deepEqual(a.state.products.map(p=>p.name),['A 빵집']);
 assert.deepEqual(b.state.products.map(p=>p.name),['B 빵집']);
 const health=await api.GET();assert.deepEqual(await health.json(),{storage:'browser',status:'ok',models:5});
 const fresh=await post(empty('real'),'import_preview',{csv:'날짜,상품명,판매수량\n2026-09-01,새 빵,10'});
 assert.equal(fresh.state.products.length,0);
 const renamed=await post(a.state,'product_save',{product:{...a.product,name:'수정된 빵집'}});
 assert.equal(renamed.state.products.length,1);assert.equal(renamed.product.id,a.product.id);
 assert.equal(b.state.products[0].name,'B 빵집');
});

test('daily workflow preserves forecasts, imports, plan edits and stockout semantics',async()=>{
 const OriginalDate=Date;let clock=Date.parse('2026-09-14T03:00:00Z');
 global.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
 try{
  let state=empty('real');
  const created=await post(state,'product_save',{product:{name:'소금빵',batch:6,capacity:150}});state=created.state;
  const product=created.product,date=localDate(),target=addDays(date,1);
  const record={productId:product.id,date,sales:72,produced:90,opening:0,closing:12,waste:6,carry:8,adjustment:0,stockout:false,temperature:23,rain:false,event:'',note:''};
  const recorded=await post(state,'record_save',{record});state=recorded.state;assert.equal(recorded.balanceDifference,0);
  const preview=await post(state,'plan_preview',{plan:{productId:product.id,target,inventory:8,reservations:20}});
  assert.equal(preview.forecast.mode,'fallback');assert.equal(preview.forecast.models.length,5);assert.equal(preview.forecast.models[0].quantity,66);assert.equal(preview.state.forecasts.length,0);
  const saved=await post(state,'plan_commit',{plan:{productId:product.id,target,inventory:8,reservations:20},quantity:72});state=saved.state;
  const frozen=JSON.stringify(saved.forecast);
  const duplicate=await post(state,'plan_commit',{plan:{productId:product.id,target,inventory:0,reservations:999},quantity:150});state=duplicate.state;
  assert.equal(JSON.stringify(duplicate.forecast),frozen);assert.equal(duplicate.plan.quantity,72);assert.equal(state.forecasts.length,1);
  const changed=await post(state,'plan_quantity',{id:saved.plan.id,quantity:78});state=changed.state;
  assert.equal(changed.plan.quantity,78);assert.equal(JSON.stringify(state.forecasts[0]),frozen);
  await post(state,'plan_quantity',{id:saved.plan.id,quantity:79},400);
  await post(state,'record_save',{record:{...record,sales:-1}},400);
  await post(state,'record_save',{record:{...record,carry:13}},400);
  await post(state,'record_save',{record:{...record,date:target}},400);
  await post(state,'plan_preview',{plan:{productId:product.id,target:addDays(date,2),inventory:8,reservations:20}},400);
  const csv=`날짜,상품명,판매수량,품절\n${addDays(date,-2)},크루아상,20,\n${addDays(date,-1)},크루아상,25,예\n`;
  const importPreview=await post(state,'import_preview',{csv});assert.equal(importPreview.count,2);assert.equal(importPreview.state.records.length,1);
  const imported=await post(state,'import_commit',{csv});state=imported.state;
  assert.equal(state.records[0].stockout,null);assert.equal(state.records[1].stockout,true);assert.equal(state.records[0].produced,null);
  const importAgain=await post(state,'import_preview',{csv});assert.equal(importAgain.errorCount,2);await post(state,'import_commit',{csv},400);
  const badCsv=`날짜,상품명,판매수량\n${date},잘못된 빵,5\n${date},잘못된 빵,6`;
  const badPreview=await post(state,'import_preview',{csv:badCsv});assert.equal(badPreview.errorCount,1);await post(state,'import_commit',{csv:badCsv},400);
  clock+=86400000;
  state=(await post(state,'record_save',{record:{...record,date:target,sales:68,opening:8,produced:72,closing:9,waste:3,carry:4}})).state;
  const score=metrics(state.forecasts,state.records);assert.equal(score.n,1);assert.equal(score.rows[0].mae,4);assert.equal(score.rows[0].over,6);assert.equal(score.rows[0].loss,6);
  await post(state,'plan_quantity',{id:saved.plan.id,quantity:84},400);
  state=(await post(state,'record_save',{record:{...record,sales:70,closing:14}})).state;
  assert.equal(JSON.stringify(state.forecasts[0]),frozen);assert.equal(state.records.length,4);
  const withStockout=structuredClone(state);withStockout.records.find(r=>r.productId===product.id&&r.date===target).stockout=true;
  assert.equal(metrics(withStockout.forecasts,withStockout.records).n,0);
  const unknown=structuredClone(state);unknown.records.find(r=>r.productId===product.id&&r.date===target).stockout=null;
  assert.equal(metrics(unknown.forecasts,unknown.records).unknownStockout,1);
  const realSnapshot=JSON.stringify(state),demo=await post(empty('demo'),'demo_seed');
  assert(demo.state.records.length>=100);assert.equal(demo.state.space,'demo');assert.equal(JSON.stringify(state),realSnapshot);
  const demoAgain=await post(demo.state,'demo_seed');assert.deepEqual(demoAgain.state,demo.state);
  await post(empty('real'),'demo_seed',{},400);
 }finally{global.Date=OriginalDate;}
});

test('state validation rejects malformed, duplicated and cross-space snapshots',async()=>{
 const product={id:'test',name:'검증 빵',batch:1,capacity:null,active:true};
 const valid={...empty('real'),products:[product]};
 assert.notEqual(parseAppState(valid,'real'),valid);
 assert.throws(()=>parseAppState({...valid,space:'demo'},'real'),/공간/);
 assert.throws(()=>parseAppState({...valid,products:[product,product]},'real'),/중복/);
 assert.throws(()=>parseAppState({...valid,plans:[{}]},'real'),/형식/);
 const demo=await post(empty('demo'),'demo_seed');
 assert.throws(()=>parseAppState({...demo.state,space:'real'},'real'),/공간/);
 const duplicate=structuredClone(demo.state);duplicate.records.push(duplicate.records[0]);assert.throws(()=>parseAppState(duplicate,'demo'),/중복/);
 const dangling=structuredClone(demo.state);dangling.plans[0].forecastId='missing';assert.throws(()=>parseAppState(dangling,'demo'),/일치/);
 const broken=structuredClone(demo.state);broken.forecasts[0].models.pop();assert.throws(()=>parseAppState(broken,'demo'),/형식/);
 const missing=await api.POST(request({space:'real',action:'product_save',product}));assert.equal(missing.status,400);
 const mismatch=await api.POST(request({space:'real',action:'demo_seed',state:demo.state}));assert.equal(mismatch.status,400);
});

test('request guards enforce same origin, JSON and byte-based 4MB limit',async()=>{
 const wrongOrigin=await api.POST(new Request('https://bakery.test/api/bakery',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://elsewhere.test'},body:'{}'}));assert.equal(wrongOrigin.status,403);
 const wrongType=await api.POST(new Request('https://bakery.test/api/bakery',{method:'POST',body:'{}'}));assert.equal(wrongType.status,415);
 const malformed=await api.POST(new Request('https://bakery.test/api/bakery',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}));assert.equal(malformed.status,400);
 const over=JSON.stringify({space:'real',action:'unknown',state:empty('real'),padding:'한'.repeat(1_340_000)});
 assert(over.length<4_000_000);assert(Buffer.byteLength(over)>4_000_000);
 const tooLarge=await api.POST(new Request('https://bakery.test/api/bakery',{method:'POST',headers:{'Content-Type':'application/json'},body:over}));assert.equal(tooLarge.status,413);
 const lyingLength=await api.POST(new Request('https://bakery.test/api/bakery',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'4000001'},body:'{}'}));assert.equal(lyingLength.status,413);
});

test('proxied request URLs use the exact public Host header for origin validation',async()=>{
 const body=JSON.stringify({space:'real',action:'product_save',state:empty('real'),product:{name:'프록시 검증 빵',batch:1,capacity:100}});
 const proxied=origin=>new Request('http://127.0.0.1:3000/api/bakery',{method:'POST',headers:{'Content-Type':'application/json',Host:'localhost:3210',Origin:origin},body});
 for(const origin of ['http://localhost:3210','https://localhost:3210']){
  const response=await api.POST(proxied(origin));assert.equal(response.status,200);assert.equal((await response.json()).product.name,'프록시 검증 빵');
 }
 for(const origin of ['http://localhost:3211','https://elsewhere.test','ftp://localhost:3210','null','http://localhost:3210/'])assert.equal((await api.POST(proxied(origin))).status,403,origin);
});
