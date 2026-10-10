import {config} from './config.js';
const SESSION='nk-admin-auth-v1';
let session;try{session=JSON.parse(sessionStorage.getItem(SESSION)||'null');}catch{}
function save(s){session=s;if(s)sessionStorage.setItem(SESSION,JSON.stringify(s));else sessionStorage.removeItem(SESSION);}
export function configured(){return config.ready&&/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)&&!!config.publishableKey;}
async function request(path,{method='GET',body,auth=false}={}){if(!configured())throw Error('数据库正在配置，暂时无法登录。');if(auth&&session?.expires_at&&session.expires_at<Date.now()/1000+60){const r=await fetch(config.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:config.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});if(!r.ok){save(null);throw Error('登录已过期，请重新登录。');}save(await r.json());}const r=await fetch(config.url+path,{method,headers:{apikey:config.publishableKey,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+(session?.access_token||'')}: {})},...(body!==undefined?{body:JSON.stringify(body)}:{})});let result;try{result=await r.json();}catch{}if(!r.ok){if(auth&&r.status===401)save(null);throw Error(result?.message||result?.msg||result?.error_description||'请求失败，请稍后重试。');}return result;}
export async function sendLogin(email){return request('/auth/v1/otp?redirect_to='+encodeURIComponent(location.origin+location.pathname),{method:'POST',body:{email,create_user:true}});}
export async function verifyLogin(email,token){const s=await request('/auth/v1/verify',{method:'POST',body:{email,token,type:'email'}});save(s);}
export async function restoreLogin(){const params=new URLSearchParams(location.hash.slice(1));if(params.has('access_token')){save({access_token:params.get('access_token'),refresh_token:params.get('refresh_token'),expires_at:Number(params.get('expires_at'))||Date.now()/1000+Number(params.get('expires_in')||3600)});history.replaceState(null,'',location.pathname+location.search);}if(!session)return false;try{const allowed=await rpc('is_admin');if(!allowed){await signOut();throw Error('此账号没有后台管理权限。');}return true;}catch(e){save(null);throw e;}}
export async function signOut(){try{if(session)await request('/auth/v1/logout',{method:'POST',auth:true});}finally{save(null);}}
export const rpc=(name,body={})=>request('/rest/v1/rpc/'+name,{method:'POST',body,auth:true});
export async function loadOrders(){let all=[];for(let offset=0;;offset+=500){const rows=await request('/rest/v1/orders?select=*&order=created_at.desc,id.asc&limit=500&offset='+offset,{auth:true});all.push(...rows);if(rows.length<500)break;}return all.map(o=>({id:o.id,name:o.name,phone:o.phone,createdAt:o.created_at,source:o.source,adId:o.ad_id,ip:o.ip,device:o.device,product:o.product,quantity:o.quantity,price:o.price,status:o.status,notes:o.notes,invalidReason:o.invalid_reason,matches:o.matches||[],logs:o.logs||[]}));}
export const saveOrder=(id,status,notes,reason)=>rpc('update_order',{p_id:id,p_status:status,p_notes:notes,p_reason:reason||''});
export async function loadSettings(){return rpc('admin_pixel_config');}
export const saveSettings=value=>rpc('save_pixel_config',{p_value:value});

export async function passwordLogin(email,password){save(await request('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}}));}
