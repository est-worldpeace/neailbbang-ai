import {addDays,weekday,type AppState,type DayRecord,type Forecast,type PlanContext,type Product,type ModelOutput} from "./bakery-types";
import {productionFor,loss3} from "./metrics";

export type FeatureMap=Record<string,number|null>;
type TreeNode=[number,number|number[],number|number[],number?];
type Cat={columns:string[];scale:number;bias:number[];trees:{splits:number[][];values:number[]}[]};
export type ModelPack={version:string;train_start:string;train_end:string;training_rows:number;columns:string[];products:number[];
 impute:number[];mean:number[];scale:number[];final_ensemble_weight:number;et:{trees:TreeNode[][]};cat:Cat;scaled:Cat;
 ridge:{intercept:number;other:number[];coef:number[];splines:{feature:number;knots:number[];coefficients:number[][];low:number;high:number;left_value:number;left_slope:number;right_value:number;right_slope:number}[]}};
export const QUANTILES=[.1,.5,.75,.9];
export const APP_MODEL_VERSION="daily-bakery-1.0 / research-base + rolling-store-calibration";
const finite=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x);
export const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length;
export function quantile(v:number[],q:number){if(!v.length)return 0;const a=[...v].sort((x,y)=>x-y),p=(a.length-1)*q,l=Math.floor(p);return a[l]+(a[Math.min(l+1,a.length-1)]-a[l])*(p-l);}
export function weightedQuantile(values:number[],weights:number[],q:number){
 if(!values.length)return 0;
 const order=values.map((value,i)=>({value,w:weights[i]})).sort((a,b)=>a.value-b.value);
 const total=weights.reduce((a,b)=>a+b,0);let cumulative=0;
 for(const r of order){cumulative+=r.w;if(cumulative/total>=q)return r.value;}return order.at(-1)!.value;
}
export function coherent(v:number[]){const a=v.map(x=>Math.max(0,x));a[0]=Math.min(a[0],a[1]);a[2]=Math.max(a[2],a[1]);a[3]=Math.max(a[3],a[2]);return a;}
export function shapeFeatures(sequence:(number|null)[]){
 const observed=sequence.filter(finite),mu=observed.length?mean(observed):1;
 let z=sequence.map(v=>(v===null?mu:v)-mu);
 const sd=Math.max(1,Math.sqrt(mean(z.map(x=>x*x))));z=z.map(v=>v/sd);
 const power:number[]=[];
 for(let k=1;k<=14;k++){let re=0,im=0;for(let j=0;j<28;j++){const a=2*Math.PI*k*j/28;re+=z[j]*Math.cos(a);im-=z[j]*Math.sin(a);}power.push(re*re+im*im);}
 const total=Math.max(1,power.reduce((a,b)=>a+b,0));
 return [...power.map(v=>Math.sqrt(v/total)),mean(z.slice(-7)),mean(z.slice(-14,-7))];
}
export function makeFeatures(history:{date:string;sales:number|null}[],target:string,pack:ModelPack,knownResearchProduct?:number){
 const h=history.filter(r=>r.date<target&&finite(r.sales)).sort((a,b)=>a.date.localeCompare(b.date));
 const byDate=new Map(h.map(r=>[r.date,r.sales as number]));const get=(lag:number)=>byDate.get(addDays(target,-lag))??null;
 const x:FeatureMap={};for(const k of [1,2,3,7,14,21,28])x[`lag${k}`]=get(k);
 for(const k of [7,14,28,56]){const v=Array.from({length:k},(_,i)=>get(i+1)).filter(finite);const mu=v.length?mean(v):0;
  x[`mean${k}`]=v.length>=2?mu:null;x[`median${k}`]=v.length>=2?quantile(v,.5):null;x[`std${k}`]=v.length>=2?Math.sqrt(v.reduce((a,b)=>a+(b-mu)**2,0)/(v.length-1)):null;
 }
 const sameDay=Array.from({length:8},(_,k)=>get((k+1)*7)).filter(finite);
 x.weekday_med8=sameDay.length?quantile(sameDay,.5):null;
 x.trend=x.mean7!==null&&x.mean28!==null?x.mean7-x.mean28:null;
 const date=new Date(target+"T12:00:00Z"),doy=(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate())-Date.UTC(date.getUTCFullYear(),0,1))/86400000;
 for(const k of [1,2]){x[`sin${k}`]=Math.sin(k*2*Math.PI*doy/365.25);x[`cos${k}`]=Math.cos(k*2*Math.PI*doy/365.25);}
 for(let i=0;i<7;i++)x[`dow_${i}`]=weekday(target)===i?1:0;
 for(const p of pack.products)x[`prod${p}`]=p===knownResearchProduct?1:0;
 const seq=Array.from({length:28},(_,i)=>get(28-i));const shape=shapeFeatures(seq);
 const scale=Math.max(1,x.mean28??1),catScale=Math.max(1,x.mean28??x.median56??1);
 const base= sameDay.length?sameDay:h.slice(-7).map(r=>r.sales as number);
 return {x,shape,scale,catScale,historyCount:h.length,weekday:QUANTILES.map(q=>quantile(base,q))};
}
function catPredict(model:Cat,x:FeatureMap){
 const f=model.columns.map(c=>x[c]===null||x[c]===undefined?-Infinity:Math.fround(x[c]!));
 const out=[0,0,0,0];
 for(const tree of model.trees){let leaf=0;tree.splits.forEach(([feature,border],bit)=>{if(f[feature]>border)leaf|=1<<bit;});for(let q=0;q<4;q++)out[q]+=tree.values[leaf*4+q];}
 return out.map((v,k)=>v*model.scale+(model.bias[k]??0));
}
export function predictBase(pack:ModelPack,x:FeatureMap,shape:number[],catScale:number){
 const xs=pack.columns.map((c,i)=>((x[c]===null||x[c]===undefined?pack.impute[i]:x[c]!)-pack.mean[i])/pack.scale[i]);
 const f32=xs.map(Math.fround),hist:number[]=[];
 for(const nodes of pack.et.trees){let i=0;while(nodes[i][0]>=0){const n=nodes[i];i=f32[n[0]]<=(n[1] as number)?n[2] as number:n[3]!;}
  const leaf=nodes[i];(leaf[1] as number[]).forEach((v,j)=>hist[v]=(hist[v]??0)+(leaf[2] as number[])[j]);
 }
 let total=0;const cdf=Array.from({length:hist.length},(_,i)=>{total+=hist[i]??0;return total;});
 const et=QUANTILES.map(q=>{const i=cdf.findIndex(v=>v/total>=q);return i<0?cdf.length-1:i;});
 let ridge=pack.ridge.intercept;
 for(const p of pack.ridge.splines){const v=xs[p.feature];if(v<p.low){ridge+=p.left_value+(v-p.low)*p.left_slope;continue;}if(v>p.high){ridge+=p.right_value+(v-p.high)*p.right_slope;continue;}
  let j=0;while(j<p.knots.length-2&&v>=p.knots[j+1])j++;
  const dx=v-p.knots[j];ridge+=p.coefficients[j].reduce((out,c)=>out*dx+c,0);
 }
 pack.ridge.other.forEach((f,j)=>ridge+=xs[f]*pack.ridge.coef[j]);
 const scaled:FeatureMap={...x};for(const c of pack.columns)if(/^(lag|mean|std|median|weekday_med)/.test(c)||c==="trend")scaled[c]=x[c]===null?null:x[c]!/catScale;
 scaled.loglevel=Math.log1p(catScale);shape.forEach((v,j)=>scaled[`psd${j}`]=v);
 return [coherent(et),coherent(catPredict(pack.cat,x)),coherent([ridge,ridge,ridge,ridge]),coherent(catPredict(pack.scaled,scaled).map(v=>v*catScale))];
}
export type CalibrationSample={experts:number[][];y:number;scale:number;shape:number[];date:string;productId:string};
export function weightObjective(samples:CalibrationSample[],w:number[]){
 let loss=0;for(const s of samples)for(const [k,tau] of [[1,.5],[2,.75]]){const e=(s.y-w.reduce((a,v,m)=>a+v*s.experts[m][k],0))/s.scale;loss+=Math.max(tau*e,(tau-1)*e);}
 return loss/Math.max(1,2*samples.length)+.01*w.reduce((a,v)=>a+(v-.2)**2,0);
}
function simplex(v:number[]){const s=[...v].sort((a,b)=>b-a);let sum=0,theta=0;for(let j=0;j<s.length;j++){sum+=s[j];const t=(sum-1)/(j+1);if(j===s.length-1||s[j+1]<=t){theta=t;break;}}return v.map(x=>Math.max(0,x-theta));}
/** Primal-dual solution of the same convex regularized joint-pinball objective.
 * Dual clipping is the exact proximal map of pinball's conjugate. It avoids a
 * replacement regression or an arbitrary five-model weight formula.
 */
export function learnWeights(samples:CalibrationSample[],iterations=7000){
 if(samples.length<7)return [.2,.2,.2,.2,.2];
 const X:number[][]=[],Y:number[]=[],T:number[]=[];
 for(const s of samples)for(const [k,tau] of [[1,.5],[2,.75]]){
  const row=s.experts.map(q=>q[k]/s.scale),center=mean(row);X.push(row.map(v=>v-center));Y.push(s.y/s.scale-center);T.push(tau);
 }
 const N=X.length,norm=X.reduce((sum,row)=>sum+row.reduce((a,v)=>a+v*v,0),0);
 if(norm<1e-20)return [.2,.2,.2,.2,.2];
 const step=2,dualStep=.99/(step*norm),u=new Float64Array(N);let w=[.2,.2,.2,.2,.2],bar=[...w];
 for(let it=0;it<iterations;it++){
  const grad=[0,0,0,0,0];
  for(let i=0;i<N;i++){const r=Y[i]-X[i].reduce((a,v,m)=>a+v*bar[m],0);u[i]=Math.max((T[i]-1)/N,Math.min(T[i]/N,u[i]+dualStep*r));for(let m=0;m<5;m++)grad[m]+=X[i][m]*u[i];}
  const next=simplex(w.map((v,m)=>(v+step*grad[m]+step*.02*.2)/(1+step*.02)));
  bar=next.map((v,m)=>2*v-w[m]);w=next;
 }
 return w;
}
const mix=(experts:number[][],weights:number[])=>QUANTILES.map((_,k)=>experts.reduce((s,q,m)=>s+q[k]*weights[m],0));
function weekStart(date:string){return addDays(date,-weekday(date));}
export function buildForecast(pack:ModelPack,state:AppState,product:Product,target:string,context:PlanContext):Forecast{
 const origin=addDays(target,-1),all=state.records.filter(r=>r.date<target),history=all.filter(r=>r.productId===product.id);
 if(!history.length)throw new Error("판매 기록을 먼저 저장해 주세요. 판매 0개인 날도 기록할 수 있습니다.");
 const features=makeFeatures(history,target,pack);
 const mode=features.historyCount>=7&&target>pack.train_end?"research":"fallback";
 const raws=new Map<string,{features:ReturnType<typeof makeFeatures>;experts:number[][]}>();
 const getRaw=(productId:string,date:string)=>{
  const key=productId+"|"+date;let result=raws.get(key);if(result)return result;
  const f=makeFeatures(all.filter(r=>r.productId===productId),date,pack);
  result={features:f,experts:[...predictBase(pack,f.x,f.shape,f.catScale),f.weekday]};raws.set(key,result);return result;
 };
 let experts=mode==="research"?getRaw(product.id,target).experts:Array.from({length:5},()=>[...features.weekday]);
 let weights=[.2,.2,.2,.2,.2],et=[...experts[0]],ensemble=[...features.weekday],calibrationCount=0;
 const warnings:string[]=[];
 const start=addDays(target,-56),review=weekStart(target),weightStart=addDays(review,-56);
 if(mode==="research"){
  const candidates=all.filter(r=>r.date>=weightStart&&!r.stockout),samples:CalibrationSample[]=[];
  for(const r of candidates){
   const saved=state.forecasts.find(f=>f.productId===r.productId&&f.target===r.date&&f.mode==="research"&&f.target<target);
   if(saved){samples.push({experts:saved.experts,y:r.sales,scale:saved.scale,shape:saved.shape,date:r.date,productId:r.productId});continue;}
   const f=makeFeatures(all.filter(x=>x.productId===r.productId),r.date,pack);
   if(f.historyCount<7||r.date<=pack.train_end)continue;
   const raw=getRaw(r.productId,r.date);samples.push({experts:raw.experts,y:r.sales,scale:f.scale,shape:f.shape,date:r.date,productId:r.productId});
  }
  weights=learnWeights(samples.filter(s=>s.date<review&&s.date>=weightStart));
  let cal=samples.filter(s=>s.productId===product.id&&s.date>=start);
  if(cal.length<10)cal=samples.filter(s=>s.productId===product.id).slice(-56);
  calibrationCount=cal.length;
  const raw=mix(experts,weights);ensemble=[...raw];
  if(cal.length>=7){
   const distances=cal.map(s=>s.shape.reduce((v,x,k)=>v+(x-features.shape[k])**2,0));
   const bw=Math.max(.001,quantile(distances,.5));const similarities=distances.map(d=>.5+.5*Math.exp(-d/bw));
   ensemble=coherent(QUANTILES.map((tau,k)=>raw[k]+features.scale*weightedQuantile(cal.map(s=>(s.y-mix(s.experts,weights)[k])/s.scale),similarities,tau)));
  }
  // Explicit app adaptation: rolling store residuals instead of the experiment's fixed test-block calibration.
  if(cal.length>=14)et=coherent(QUANTILES.map((tau,k)=>experts[0][k]+quantile(cal.map(s=>s.y-s.experts[0][k]),tau)));
  warnings.push("독일 판매 자료로 학습한 연구모델입니다. 이 매장의 성능은 기록을 쌓으며 확인해야 합니다.");
  if(cal.length<14)warnings.push(`상품별 보정에 쓸 기록 ${cal.length}일 · 초기 보정 단계입니다.`);
 }else warnings.push(`과거 기록 ${features.historyCount}일 · AI 모델 대신 요일 기준 예측을 함께 표시합니다. 7일 기록부터 연구모델 계산을 시작합니다.`);
 if(history.some(r=>r.stockout))warnings.push("품절일 판매량은 실제 수요보다 적을 수 있습니다. 품절일은 오차 보정과 성능 집계에서 제외합니다.");
 const final=coherent(et.map((v,k)=>(1-pack.final_ensemble_weight)*v+pack.final_ensemble_weight*ensemble[k]));
 const earlier=state.forecasts.filter(f=>f.productId===product.id&&f.target<target).sort((a,b)=>a.target.localeCompare(b.target));
 const last=earlier.at(-1);let selected=last?.models.find(x=>x.key==="selector")?.selected??"ensemble";
 const scoring=earlier.filter(f=>f.target>=start).map(f=>({f,r:history.find(r=>r.date===f.target)})).filter(p=>p.r&&!p.r.stockout);
 if(scoring.length<7)selected="ensemble";
 else if(!last||weekStart(last.target)<review){
  const score=(key:"et"|"ensemble")=>scoring.reduce((sum,{f,r})=>sum+loss3(f.context.inventory+f.models.find(m=>m.key===key)!.quantity,r!.sales),0);
  const a=score("et"),b=score("ensemble"),best=a<b?"et":"ensemble";
  const current=selected==="et"?a:b,min=Math.min(a,b);if(current-min>.05*current+1e-9)selected=best;
 }
 const rawModels=[{key:"final" as const,q:final},{key:"et" as const,q:et},{key:"ensemble" as const,q:ensemble},{key:"selector" as const,q:selected==="et"?et:ensemble},{key:"weekday" as const,q:features.weekday}];
 const models:ModelOutput[]=rawModels.map(({key,q})=>({key,p50:q[1],q75:q[2],...productionFor(q[2],context),...(key==="selector"?{selected}:{})}));
 if(models.some(m=>!Number.isFinite(m.p50)||!Number.isFinite(m.q75)||!Number.isFinite(m.quantity)))throw new Error("예측 계산을 완료하지 못했습니다. 입력 수량과 기록을 확인해 주세요.");
 return {id:`${state.space}|${product.id}|${target}`,productId:product.id,target,origin,issuedAt:new Date().toISOString(),version:APP_MODEL_VERSION,context,historyCount:features.historyCount,mode,experts,shape:features.shape,scale:features.scale,weights,models,actualKnownAtIssue:false,source:state.space==="demo"?"synthetic":"live",calibrationCount,warnings};
}
