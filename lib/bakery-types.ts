export type Space = "real" | "demo";
export type Product = { id: string; name: string; batch: number; capacity: number | null; active: boolean };
export type DayRecord = {
  id: string; productId: string; date: string; sales: number;
  opening: number | null; produced: number | null; closing: number | null;
  waste: number | null; carry: number | null; adjustment: number;
  stockout: boolean | null; temperature: number | null; rain: boolean; event: string; note: string;
  source: "manual" | "import" | "synthetic"; updatedAt: string;
};
export type ModelKey = "final" | "et" | "ensemble" | "selector" | "weekday";
export const MODELS: {key: ModelKey; name: string; short: string; color: string}[] = [
  {key:"final", name:"최종 결합 모델", short:"최종 결합", color:"#e45b22"},
  {key:"et", name:"Extra Trees", short:"Extra Trees", color:"#406ab4"},
  {key:"ensemble", name:"보정 앙상블", short:"보정 앙상블", color:"#8b5db2"},
  {key:"selector", name:"메뉴별 선택형", short:"메뉴별 선택", color:"#168573"},
  {key:"weekday", name:"요일 기준 모델", short:"요일 기준", color:"#8391a4"},
];
export type ModelOutput = {key:ModelKey; p50:number; q75:number; quantity:number; selected?:"et"|"ensemble"; capacityShortfall:number};
export type PlanContext = {inventory:number; reservations:number; batch:number; capacity:number|null};
export type Forecast = {
  id:string; productId:string; target:string; origin:string; issuedAt:string;
  version:string; context:PlanContext; historyCount:number; mode:"research"|"fallback";
  experts:number[][]; shape:number[]; scale:number; weights:number[];
  models:ModelOutput[]; actualKnownAtIssue:false; source:"live"|"synthetic";
  calibrationCount:number; warnings:string[];
};
export type Plan = {id:string; forecastId:string; productId:string; target:string; quantity:number; updatedAt:string};
export type AppState = {products:Product[]; records:DayRecord[]; forecasts:Forecast[]; plans:Plan[]; space:Space};
export const EMPTY_STATE:AppState = {products:[],records:[],forecasts:[],plans:[],space:"real"};
export function localDate(d=new Date()) { const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);const get=(t:string)=>p.find(v=>v.type===t)!.value;return `${get("year")}-${get("month")}-${get("day")}`; }
export function addDays(date:string,n:number) { const d=new Date(date+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
export function weekday(date:string) {return (new Date(date+"T12:00:00Z").getUTCDay()+6)%7;}
export function dateLabel(date:string) { const d=new Date(date+"T12:00:00Z");return `${d.getUTCMonth()+1}월 ${d.getUTCDate()}일 (${["월","화","수","목","금","토","일"][weekday(date)]})`; }
