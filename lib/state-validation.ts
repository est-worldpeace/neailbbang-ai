import {z} from "zod";
import {addDays,localDate,MODELS,type AppState,type Space} from "./bakery-types";
import {dateSchema,productSchema,recordSchema} from "./validation";

const id=z.string().min(1).max(120).refine(value=>!value.includes("|"),"상품 식별자가 올바르지 않습니다.");
const count=z.number().finite().int().min(0).max(100000);
const nonnegative=z.number().finite().min(0);
const timestamp=z.string().datetime({offset:true});
const context=z.object({inventory:count,reservations:count,batch:z.number().int().min(1).max(1000),capacity:count.nullable()}).strict();
const model=z.object({key:z.enum(["final","et","ensemble","selector","weekday"]),p50:nonnegative,q75:nonnegative,quantity:nonnegative.int().max(Number.MAX_SAFE_INTEGER),capacityShortfall:nonnegative,selected:z.enum(["et","ensemble"]).optional()}).strict();
const forecast=z.object({
 id:z.string().min(1).max(300),productId:id,target:dateSchema,origin:dateSchema,issuedAt:timestamp,
 version:z.string().min(1).max(200),context,historyCount:count,mode:z.enum(["research","fallback"]),
 experts:z.array(z.array(nonnegative).length(4)).length(5),shape:z.array(z.number().finite()).length(16),
 scale:z.number().finite().min(1),weights:z.array(z.number().finite().min(0).max(1)).length(5),
 models:z.array(model).length(5),actualKnownAtIssue:z.literal(false),source:z.enum(["live","synthetic"]),
 calibrationCount:count,warnings:z.array(z.string().max(1000)).max(20),
}).strict();
const schema=z.object({
 space:z.enum(["real","demo"]),
 products:z.array(productSchema.extend({id}).strict()).max(20000),
 records:z.array(recordSchema.extend({id:z.string().min(1).max(300),productId:id,source:z.enum(["manual","import","synthetic"]),updatedAt:timestamp}).strict()).max(20000),
 forecasts:z.array(forecast).max(20000),
 plans:z.array(z.object({id:z.string().min(1).max(300),forecastId:z.string().min(1).max(300),productId:id,target:dateSchema,quantity:nonnegative.int().max(Number.MAX_SAFE_INTEGER),updatedAt:timestamp}).strict()).max(20000),
}).strict();
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

/** Match the previous database ordering without keeping any server-side state. */
export function sortAppState(state:AppState):AppState{
 state.products.sort((a,b)=>compare(a.name,b.name));
 state.records.sort((a,b)=>compare(a.date,b.date)||compare(a.productId,b.productId));
 state.forecasts.sort((a,b)=>compare(a.target,b.target)||compare(a.productId,b.productId));
 state.plans.sort((a,b)=>compare(a.target,b.target)||compare(a.productId,b.productId));
 return state;
}

/** Validate and clone browser storage or a request snapshot; safe to use in the browser. */
export function parseAppState(value:unknown,space:Space):AppState{
 const result=schema.safeParse(value);
 if(!result.success)throw new Error("저장된 데이터 형식이 올바르지 않습니다. 올바른 전체 백업 파일인지 확인해 주세요.");
 const state:AppState=result.data;
 if(state.space!==space)throw new Error("실제 매장 기록과 예시 기록을 섞어 사용할 수 없습니다. 현재 공간에 맞는 데이터를 선택해 주세요.");
 const products=new Map(state.products.map(p=>[p.id,p]));
 if(products.size!==state.products.length||new Set(state.products.map(p=>p.name)).size!==state.products.length)throw new Error("저장된 상품에 중복된 식별자 또는 이름이 있습니다.");
 const recordIds=new Set<string>(),forecastIds=new Set<string>(),planIds=new Set<string>();
 const today=localDate();
 for(const record of state.records){
  if(!products.has(record.productId))throw new Error("판매 기록에 등록되지 않은 상품이 포함되어 있습니다.");
  const expected=`${space}|${record.productId}|${record.date}`;
  if(record.id!==expected||(space==="real"&&record.source==="synthetic")||(space==="demo"&&record.source==="manual"))throw new Error("판매 기록의 공간이 현재 공간과 일치하지 않습니다.");
  if(recordIds.has(expected))throw new Error("같은 상품과 날짜의 판매 기록이 중복되어 있습니다.");
  recordIds.add(expected);
  if(record.date>today)throw new Error("미래 날짜의 실제 판매 기록은 사용할 수 없습니다.");
  if(record.carry!==null&&record.closing!==null&&record.carry>record.closing)throw new Error("이월재고가 마감 재고보다 많은 판매 기록이 있습니다.");
 }
 for(const item of state.forecasts){
  if(!products.has(item.productId))throw new Error("예측 기록에 등록되지 않은 상품이 포함되어 있습니다.");
  if(item.id!==`${space}|${item.productId}|${item.target}`||item.source!==(space==="demo"?"synthetic":"live"))throw new Error("예측 기록의 공간이 현재 공간과 일치하지 않습니다.");
  if(forecastIds.has(item.id))throw new Error("같은 상품과 날짜의 예측이 중복되어 있습니다.");
  forecastIds.add(item.id);
  if(item.origin!==addDays(item.target,-1)||item.models.some((m,index)=>m.key!==MODELS[index].key||m.p50>m.q75)||item.models[3].selected===undefined||Math.abs(item.weights.reduce((sum,w)=>sum+w,0)-1)>1e-6)throw new Error("저장된 예측의 날짜 또는 모델 계산값이 올바르지 않습니다.");
 }
 const forecasts=new Map(state.forecasts.map(item=>[item.id,item]));
 for(const plan of state.plans){
  const saved=forecasts.get(plan.forecastId);
  if(!saved||plan.id!==saved.id||plan.productId!==saved.productId||plan.target!==saved.target)throw new Error("생산계획과 연결된 예측 기록이 일치하지 않습니다.");
  if(planIds.has(plan.id))throw new Error("같은 상품과 날짜의 생산계획이 중복되어 있습니다.");
  planIds.add(plan.id);
  if(plan.quantity%saved.context.batch!==0||(saved.context.capacity!==null&&plan.quantity>saved.context.capacity))throw new Error("저장된 생산계획이 생산 단위 또는 최대 생산량에 맞지 않습니다.");
 }
 if(planIds.size!==forecastIds.size)throw new Error("확정된 예측에 연결된 생산계획이 없습니다.");
 return sortAppState(state);
}
