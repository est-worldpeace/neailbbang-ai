import {MODELS,ModelKey,Forecast,DayRecord} from "./bakery-types";
export function ceilQuantity(v:number){const n=Math.round(v);return Math.ceil(Math.abs(v-n)<1e-9?n:v);}
export function productionFor(q:number,c:{inventory:number;reservations:number;batch:number;capacity:number|null}){
 const need=Math.max(0,Math.max(q,c.reservations)-c.inventory);
 const unrestricted=ceilQuantity(need/c.batch)*c.batch;
 const quantity=c.capacity===null?unrestricted:Math.min(unrestricted,Math.floor(c.capacity/c.batch)*c.batch);
 return {quantity,capacityShortfall:Math.max(0,Math.max(q,c.reservations)-c.inventory-quantity)};
}
export function loss3(available:number,y:number){return Math.max(0,available-y)+3*Math.max(0,y-available);}
export function metrics(forecasts:Forecast[],records:DayRecord[],productId?:string){
 const lookup=new Map(records.map(r=>[r.productId+"|"+r.date,r]));
 const all=forecasts.filter(f=>(!productId||f.productId===productId)&&lookup.has(f.productId+"|"+f.target));
 const pairs=all.map(f=>({f,r:lookup.get(f.productId+"|"+f.target)!}));
 const usable=pairs.filter(p=>!p.r.stockout);
 const rows=MODELS.map(m=>{
  let abs=0,y=0,over=0,under=0;
  for(const {f,r} of usable){const p=f.models.find(x=>x.key===m.key)!;abs+=Math.abs(p.p50-r.sales);y+=r.sales;over+=Math.max(0,f.context.inventory+p.quantity-r.sales);under+=Math.max(0,r.sales-f.context.inventory-p.quantity);}
  return {key:m.key,n:usable.length,mae:usable.length?abs/usable.length:null,wape:y?100*abs/y:null,over,under,loss:over+3*under};
 });
 return {rows,pairs,usable,n:usable.length,stockoutExcluded:pairs.length-usable.length,unknownStockout:usable.filter(p=>p.r.stockout===null).length,researchCount:usable.filter(p=>p.f.mode==="research").length};
}
