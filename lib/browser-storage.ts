import {EMPTY_STATE,type AppState,type Space} from "./bakery-types";
import {parseAppState} from "./state-validation";

export const STORAGE_PREFIX="bread-daily-planner:v1:";
export const storageKey=(space:Space)=>STORAGE_PREFIX+space;

function readRaw(space:Space):string|null {
  try { return window.localStorage.getItem(storageKey(space)); }
  catch { throw new Error("브라우저 저장 기능을 사용할 수 없습니다. 일반 창에서 저장을 허용해 주세요."); }
}
export function readBrowserState(space:Space):AppState {
  const raw=readRaw(space);
  if(raw===null)return {...EMPTY_STATE,space,products:[],records:[],forecasts:[],plans:[]};
  try {
    const saved=JSON.parse(raw);
    if(saved.version!==1)throw new Error("version");
    return parseAppState(saved.state,space);
  } catch { throw new Error("저장된 기록을 읽을 수 없습니다. 기존 데이터를 삭제하지 말고 전체 백업 파일을 확인해 주세요."); }
}
export function writeBrowserState(space:Space,state:AppState) {
  const checked=parseAppState(state,space);
  try { window.localStorage.setItem(storageKey(space),JSON.stringify({version:1,state:checked})); }
  catch { throw new Error("브라우저에 저장하지 못했습니다. 저장 공간을 확인하고 전체 백업을 내려받아 주세요."); }
}
export async function withBrowserLock<T>(space:Space,fn:()=>Promise<T>):Promise<T> {
  if(navigator.locks)return navigator.locks.request(storageKey(space),fn);
  return fn();
}
const readOnlyActions=new Set(["plan_preview","import_preview"]);
export async function requestBakery<T>(space:Space,action:string,payload:Record<string,unknown>={}):Promise<T> {
  return withBrowserLock(space,async()=>{
    const before=readRaw(space);
    const state=readBrowserState(space);
    const body=JSON.stringify({space,action,state,...payload});
    if(new TextEncoder().encode(body).byteLength>4_000_000)throw new Error("테스트 버전의 한 번에 처리할 수 있는 기록 크기를 넘었습니다. 전체 백업을 내려받아 주세요.");
    let response:Response;
    try { response=await fetch("/api/bakery",{method:"POST",headers:{"Content-Type":"application/json"},body}); }
    catch { throw new Error("계산 서버에 연결할 수 없습니다. 저장된 기록은 그대로 있습니다. 인터넷 연결을 확인해 주세요."); }
    let data:Record<string,unknown>;
    try { data=await response.json() as Record<string,unknown>; }
    catch { throw new Error("계산 응답을 읽지 못했습니다. 기록은 변경하지 않았습니다."); }
    if(!response.ok)throw new Error(typeof data.error==="string"?data.error:"요청을 완료하지 못했습니다.");
    if(!readOnlyActions.has(action)){
      if(readRaw(space)!==before)throw new Error("다른 창에서 기록이 변경되었습니다. 최신 기록을 확인하고 다시 저장해 주세요.");
      writeBrowserState(space,parseAppState(data.state,space));
    }
    return data as T;
  });
}
export function createBackup(space:Space):string {
  return JSON.stringify({format:"bread-daily-planner",version:1,savedAt:new Date().toISOString(),state:readBrowserState(space)},null,2);
}
export function parseBackup(text:string,space:Space):AppState {
  const backup=JSON.parse(text);
  if(backup.format!=="bread-daily-planner"||backup.version!==1)throw new Error("내일의 빵 전체 백업 파일을 선택해 주세요.");
  return parseAppState(backup.state,space);
}
