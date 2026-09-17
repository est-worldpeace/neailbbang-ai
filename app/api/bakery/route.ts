import {z} from "zod";
import {MODEL_GZIP_B64,DEMO_GZIP_B64} from "@/lib/embedded-models";
import {productSchema,parseRecord,planSchema,validateManualQuantity,errorMessage,balanceDifference} from "@/lib/validation";
import {parseAppState,sortAppState} from "@/lib/state-validation";
import {prepareImport} from "@/lib/csv";
import {buildForecast,type ModelPack} from "@/lib/model-engine";
import {localDate,addDays,type Product,type DayRecord,type Plan,type AppState} from "@/lib/bakery-types";

export const dynamic="force-dynamic";
export const runtime="nodejs";
export const maxDuration=60;
const MAX_REQUEST_BYTES=4_000_000;
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
class RequestTooLarge extends Error {}
// Only the public, immutable research model is cached between requests.
let packPromise:Promise<ModelPack>|null=null;
async function unpack<T>(text:string):Promise<T>{const bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));return await new Response(stream).json() as T;}
async function getPack(){if(!packPromise)packPromise=unpack<ModelPack>(MODEL_GZIP_B64).catch(e=>{packPromise=null;throw e;});return packPromise;}
async function readBody(request:Request):Promise<unknown>{
 const declared=Number(request.headers.get("content-length"));
 if(declared>MAX_REQUEST_BYTES)throw new RequestTooLarge();
 const reader=request.body?.getReader();if(!reader)throw new Error("요청에 저장된 기록과 입력값을 포함해 주세요.");
 const decoder=new TextDecoder("utf-8",{fatal:true});let size=0,text="";
 try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_REQUEST_BYTES){await reader.cancel();throw new RequestTooLarge();}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}
 finally{reader.releaseLock();}
 try{return JSON.parse(text);}catch{throw new Error("올바른 JSON 입력 형식이 아닙니다.");}
}
export async function GET(){return reply({storage:"browser",status:"ok",models:5});}
export async function POST(request:Request){
 try{
  const origin=request.headers.get("origin");
  if(origin){
   let allowed=false;
   try{const caller=new URL(origin),host=request.headers.get("host")??new URL(request.url).host;allowed=(caller.protocol==="http:"||caller.protocol==="https:")&&caller.origin===origin&&caller.host===host;}catch{}
   if(!allowed)return reply({error:"같은 앱 화면에서 요청해 주세요."},403);
  }
  if(!(request.headers.get("content-type")??"").includes("application/json"))return reply({error:"올바른 입력 형식이 아닙니다."},415);
  const body=z.object({space:z.enum(["real","demo"]),action:z.string(),state:z.unknown()}).passthrough().parse(await readBody(request));
  const space=body.space;let state=parseAppState(body.state,space);
  const respond=(data:Record<string,unknown>)=>reply({...data,state:sortAppState(state)});
  const now=new Date().toISOString();
  if(body.action==="product_save"){
   const parsed=productSchema.parse(body.product);const existing=parsed.id?state.products.find(p=>p.id===parsed.id):null;
   if(parsed.id&&!existing)throw new Error("상품을 찾을 수 없습니다.");if(state.products.some(p=>p.name===parsed.name&&p.id!==parsed.id))throw new Error("같은 이름의 상품이 있습니다.");
   const product:Product={...parsed,id:existing?.id??crypto.randomUUID()};state.products=state.products.filter(p=>p.id!==product.id);state.products.push(product);return respond({product});
  }
  if(body.action==="record_save"){
   const parsed=parseRecord(body.record);if(!state.products.some(p=>p.id===parsed.productId))throw new Error("상품을 먼저 등록해 주세요.");
   const record:DayRecord={...parsed,id:`${space}|${parsed.productId}|${parsed.date}`,source:space==="demo"?"synthetic":"manual",updatedAt:now};
   state.records=state.records.filter(r=>r.id!==record.id);state.records.push(record);return respond({record,balanceDifference:balanceDifference(record)});
  }
  if(body.action==="plan_preview"||body.action==="plan_commit"){
   const input=planSchema.parse(body.plan),product=state.products.find(p=>p.id===input.productId);if(!product)throw new Error("상품을 선택해 주세요.");
   const existing=state.forecasts.find(f=>f.productId===input.productId&&f.target===input.target);
   if(existing)return respond({forecast:existing,plan:state.plans.find(p=>p.forecastId===existing.id),frozen:true});
   if(state.records.some(r=>r.productId===input.productId&&r.date>=input.target))throw new Error("이미 실제 판매를 알고 있는 날짜에는 새 예측을 저장할 수 없습니다. 저장해 둔 예측과만 비교합니다.");
   if(input.target<=localDate()&&space==="real")throw new Error("지난 날짜의 예측을 뒤늦게 만들 수 없습니다. 오늘 날짜를 선택하고 내일 생산계획을 만들어 주세요.");
   if(input.target>addDays(localDate(),1))throw new Error("이번 앱은 다음 날 생산계획을 계산합니다. 내일 날짜를 선택해 주세요.");
   const context={inventory:input.inventory,reservations:input.reservations,batch:product.batch,capacity:product.capacity};
   const forecast=buildForecast(await getPack(),state,product,input.target,context);
   if(body.action==="plan_preview")return respond({forecast,frozen:false});
   const quantity=body.quantity===undefined?forecast.models[0].quantity:validateManualQuantity(body.quantity,product);
   const plan:Plan={id:forecast.id,forecastId:forecast.id,productId:product.id,target:input.target,quantity,updatedAt:now};
   state.forecasts.push(forecast);state.plans.push(plan);return respond({forecast,plan,frozen:true});
  }
  if(body.action==="plan_quantity"){
   const id=z.string().max(300).parse(body.id),plan=state.plans.find(p=>p.id===id);if(!plan)throw new Error("저장한 생산계획이 없습니다.");
   if(state.records.some(r=>r.productId===plan.productId&&r.date>=plan.target))throw new Error("실제 기록이 입력된 생산계획은 바꿀 수 없습니다. 실제 생산량을 마감 기록에 입력해 주세요.");
   const forecast=state.forecasts.find(f=>f.id===plan.forecastId)!;
   const quantity=validateManualQuantity(body.quantity,forecast.context),updated={...plan,quantity,updatedAt:now};state.plans=state.plans.map(p=>p.id===id?updated:p);return respond({plan:updated});
  }
  if(body.action==="import_preview"||body.action==="import_commit"){
   const csv=z.string().min(1).max(1000000).parse(body.csv),result=prepareImport(csv,state.products,state.records);
   if(body.action==="import_preview")return respond({count:result.records.length,newProducts:result.newProducts.map(p=>p.name),errors:result.errors.slice(0,30),errorCount:result.errors.length,warnings:result.warnings,preview:result.records.slice(0,5).map(r=>({...r,product:result.newProducts.find(p=>p.id===r.productId)?.name??state.products.find(p=>p.id===r.productId)?.name}))});
   if(result.errors.length)throw new Error(`가져오기 전에 ${result.errors.length}개 오류를 수정해 주세요. ${result.errors[0]}`);
   const records:DayRecord[]=result.records.map(r=>({...r,id:`${space}|${r.productId}|${r.date}`,source:"import",updatedAt:now}));
   state.products.push(...result.newProducts);state.records.push(...records);return respond({count:records.length,warnings:result.warnings});
  }
  if(body.action==="demo_seed"){
   if(space!=="demo")throw new Error("예시 기록은 예시 공간에서만 사용할 수 있습니다.");
   if(!state.products.length)state=parseAppState(await unpack<AppState>(DEMO_GZIP_B64),"demo");
   return respond({ready:true});
  }
  return reply({error:"지원하지 않는 요청입니다."},400);
 }catch(e){
  if(e instanceof RequestTooLarge)return reply({error:"저장된 기록과 입력값의 합계가 4MB를 초과했습니다. 전체 백업을 내보낸 뒤 기록량을 줄여 주세요."},413);
  return reply({error:errorMessage(e)},400);
 }
}
