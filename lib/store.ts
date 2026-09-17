import {env} from "cloudflare:workers";
import type {AppState,Space,Product,DayRecord,Forecast,Plan} from "./bakery-types";
export function database(){const db=(env as unknown as {DB?:D1Database}).DB;if(!db)throw new Error("기록 저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");return db;}
export async function readState(space:Space):Promise<AppState>{
 const db=database();
 const results=await db.batch([
  db.prepare("SELECT payload FROM bakery_products WHERE space=? ORDER BY name").bind(space),
  db.prepare("SELECT payload FROM bakery_records WHERE space=? ORDER BY date,product_id LIMIT 20000").bind(space),
  db.prepare("SELECT payload FROM bakery_forecasts WHERE space=? ORDER BY target,product_id LIMIT 20000").bind(space),
  db.prepare("SELECT payload FROM bakery_plans WHERE space=? ORDER BY target,product_id LIMIT 20000").bind(space),
 ]);
 const unpack=(i:number)=>results[i].results.map(r=>JSON.parse((r as {payload:string}).payload));
 return {space,products:unpack(0),records:unpack(1),forecasts:unpack(2),plans:unpack(3)};
}
export function productStatement(space:Space,p:Product){return database().prepare("INSERT INTO bakery_products(id,space,name,payload,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,payload=excluded.payload,updated_at=excluded.updated_at WHERE bakery_products.space=excluded.space").bind(p.id,space,p.name,JSON.stringify(p),new Date().toISOString());}
export function recordStatement(space:Space,r:DayRecord){return database().prepare("INSERT INTO bakery_records(id,space,product_id,date,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space,product_id,date) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").bind(r.id,space,r.productId,r.date,JSON.stringify(r),r.updatedAt);}
export function recordImportStatements(space:Space,records:DayRecord[]){
 const out:D1PreparedStatement[]=[];
 for(let i=0;i<records.length;i+=16){const group=records.slice(i,i+16);out.push(database().prepare(`INSERT INTO bakery_records(id,space,product_id,date,payload,updated_at) VALUES ${group.map(()=>"(?,?,?,?,?,?)").join(",")} ON CONFLICT(space,product_id,date) DO NOTHING`).bind(...group.flatMap(r=>[r.id,space,r.productId,r.date,JSON.stringify(r),r.updatedAt])));}
 return out;
}
export function forecastStatement(space:Space,f:Forecast){return database().prepare("INSERT INTO bakery_forecasts(id,space,product_id,target,payload,issued_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space,product_id,target) DO NOTHING").bind(f.id,space,f.productId,f.target,JSON.stringify(f),f.issuedAt);}
export function planStatement(space:Space,p:Plan,ignore=false){return database().prepare(`INSERT INTO bakery_plans(id,space,product_id,target,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space,product_id,target) ${ignore?"DO NOTHING":"DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at"}`).bind(p.id,space,p.productId,p.target,JSON.stringify(p),p.updatedAt);}
export async function batchStatements(statements:D1PreparedStatement[]){for(let i=0;i<statements.length;i+=50)await database().batch(statements.slice(i,i+50));}
