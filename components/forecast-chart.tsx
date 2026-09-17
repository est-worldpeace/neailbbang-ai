"use client";
import {LineChart,Line,CartesianGrid,XAxis,YAxis,Tooltip} from "recharts";
import {ChartContainer} from "@/components/ui/chart";
import {MODELS,type ModelKey} from "@/lib/bakery-types";
const config=Object.fromEntries([{key:"actual",name:"실제 판매",color:"#24344b"},...MODELS].map(m=>[m.key,{label:m.name,color:m.color}]));
const fmt=(n:number)=>new Intl.NumberFormat("ko-KR",{maximumFractionDigits:1}).format(n);
export default function ForecastChart({data,models}:{data:Record<string,string|number>[];models:ModelKey[]}){
 return <ChartContainer config={config} className="comparison-chart !aspect-auto"><LineChart data={data} margin={{left:0,right:12,top:14,bottom:5}}><CartesianGrid vertical={false} strokeDasharray="3 4"/><XAxis dataKey="date" tickFormatter={v=>String(v).slice(5).replace("-","/")} tickLine={false} axisLine={false} minTickGap={28} tickMargin={12}/><YAxis tickLine={false} axisLine={false} width={45}/><Tooltip labelFormatter={v=>String(v)} formatter={(v,name)=>[`${fmt(Number(v))}개`,name]} contentStyle={{borderRadius:12,border:"1px solid #e1e6ed",fontSize:14}}/><Line name="실제 판매" type="linear" dataKey="actual" stroke="#24344b" strokeWidth={2.7} dot={data.length<5} isAnimationActive={false}/>{MODELS.filter(m=>models.includes(m.key)).map(m=><Line key={m.key} name={m.name} type="linear" dataKey={m.key} stroke={m.color} strokeWidth={m.key==="final"?2.5:1.8} strokeDasharray={m.key==="final"?undefined:"5 4"} dot={false} isAnimationActive={false}/>)}</LineChart></ChartContainer>;
}
