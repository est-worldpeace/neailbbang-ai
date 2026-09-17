import type {DayRecord,Product} from "./bakery-types";
import {parseRecord} from "./validation";
export function parseCSV(text:string){
 const out:string[][]=[];let row:string[]=[],value="",quoted=false;const s=text.replace(/^\uFEFF/,"");
 for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
 else if(c===","&&!quoted){row.push(value);value="";}else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&s[i+1]==="\n")i++;row.push(value);if(row.some(x=>x.trim()))out.push(row);row=[];value="";}else value+=c;}
 if(quoted)throw new Error("CSV의 따옴표가 닫히지 않았습니다.");row.push(value);if(row.some(x=>x.trim()))out.push(row);return out;
}
const aliases:Record<string,string>={"날짜":"date","일자":"date","상품":"product","상품명":"product","품목":"product","판매량":"sales","판매수량":"sales","생산량":"produced","기초재고":"opening","시작재고":"opening","마감재고":"closing","폐기량":"waste","이월재고":"carry","판매가능이월재고":"carry","품절":"stockout","품절여부":"stockout","기온":"temperature","비":"rain","행사":"event","메모":"note","조정":"adjustment"};
export function prepareImport(text:string,products:Product[],existing:DayRecord[]){
 const rows=parseCSV(text);if(rows.length<2)throw new Error("머리글과 최소 1개의 기록이 필요합니다.");if(rows.length>3001)throw new Error("한 번에 최대 3,000개 기록을 가져올 수 있습니다.");
 const headers=rows[0].map(v=>{const s=v.trim().toLowerCase().replace(/\s/g,"");return aliases[s]??s;});
 for(const required of ["date","product","sales"])if(!headers.includes(required))throw new Error(`필수 열이 없습니다: ${required} (날짜·상품명·판매수량)`);
 const errors:string[]=[],warnings:string[]=[],known=new Set(existing.map(r=>r.productId+"|"+r.date)),seen=new Set<string>();
 const names=new Map(products.map(p=>[p.name.trim().normalize("NFC"),p.id]));const newProducts:Product[]=[];const records:ReturnType<typeof parseRecord>[]=[];
 rows.slice(1).forEach((row,index)=>{try{
  if(row.length!==headers.length)throw new Error("열 개수가 머리글과 다릅니다.");const r=Object.fromEntries(headers.map((h,i)=>[h,row[i]?.trim()??""]));
  const name=r.product.normalize("NFC");if(!name||name.length>60)throw new Error("상품명을 확인해 주세요.");
  let productId=names.get(name);if(!productId){productId=crypto.randomUUID();names.set(name,productId);newProducts.push({id:productId,name,batch:1,capacity:null,active:true});}
  const number=(key:string,required=false)=>{const v=r[key];if(v===undefined||v===""){if(required)throw new Error(`${key} 수량이 비었습니다. 누락은 0개로 처리하지 않습니다.`);return null;}const n=Number(v.replace(/,/g,""));if(!Number.isFinite(n))throw new Error(`${key} 숫자를 확인해 주세요.`);return n;};
  const bool=(key:string)=>{const v=(r[key]??"").toLowerCase();if(["","0","false","아니오","아니요","n","no"].includes(v))return false;if(["1","true","예","y","yes","품절","비"].includes(v))return true;throw new Error(`${key} 값은 예/아니오 또는 1/0으로 입력해 주세요.`);};
  const date=r.date.replace(/[./]/g,"-").replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/,(_,y,m,d)=>`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
  const record=parseRecord({productId,date,sales:number("sales",true),opening:number("opening"),produced:number("produced"),closing:number("closing"),waste:number("waste"),carry:number("carry"),adjustment:number("adjustment")??0,stockout:headers.includes("stockout")&&r.stockout!==""&&!(["모름","unknown"].includes(r.stockout))?bool("stockout"):null,temperature:number("temperature"),rain:bool("rain"),event:r.event??"",note:r.note??""});
  const key=productId+"|"+date;if(seen.has(key))throw new Error("같은 상품·날짜가 파일 안에 중복됩니다. 하루 1행으로 정리해 주세요.");if(known.has(key))throw new Error("이미 저장된 상품·날짜입니다. 기존 기록은 마감 화면에서 수정해 주세요.");seen.add(key);records.push(record);
 }catch(e){errors.push(`${index+2}행: ${e instanceof Error?e.message:"입력을 확인해 주세요."}`);}});
 if(!headers.includes("stockout"))warnings.push("품절 정보가 없어 ‘모름’으로 처리합니다. 품절이 있었다면 기록을 보완해 주세요.");
 if(!headers.includes("produced")||!headers.includes("closing"))warnings.push("생산량 또는 마감 재고가 없어 해당 기록의 재고 검산은 생략합니다.");
 return {records,newProducts,errors,warnings};
}
export function csvText(rows:(string|number|null)[][]){const cell=(v:string|number|null)=>{let s=v===null?"":String(v);if(typeof v==="string"&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return "\uFEFF"+rows.map(r=>r.map(cell).join(",")).join("\r\n");}
