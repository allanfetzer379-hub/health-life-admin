import {config} from './config.js';
import {sourceLabel} from './model.js?v=20261011-source';
const SESSION='nk-admin-auth-v1';
let session;try{session=JSON.parse(sessionStorage.getItem(SESSION)||'null');}catch{}
function save(s){session=s;if(s)sessionStorage.setItem(SESSION,JSON.stringify(s));else sessionStorage.removeItem(SESSION);}
export function configured(){return config.ready&&/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)&&!!config.publishableKey;}
let refreshing;
async function getAccessToken(){
  if(!session?.access_token)throw Error('登录已过期，请重新登录。');
  if(!session.expires_at||session.expires_at>=Date.now()/1000+60)return session.access_token;
  if(!refreshing){
    const previous=session;
    refreshing=request('/auth/v1/token?grant_type=refresh_token',{
      method:'POST',body:{refresh_token:previous.refresh_token}
    }).then(next=>{
      if(session!==previous||!next?.access_token)throw Error('登录已过期，请重新登录。');
      save(next);
      return next.access_token;
    }).catch(error=>{
      if(session===previous&&[400,401,403].includes(error.status))save(null);
      throw error;
    }).finally(()=>{refreshing=undefined;});
  }
  return refreshing;
}
export function realtimeSession(){
  let userId=session?.user?.id;
  if(!userId&&session?.access_token){
    try{
      const claims=session.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      userId=JSON.parse(atob(claims)).sub;
    }catch{}
  }
  return {url:config.url,apiKey:config.publishableKey,userId,getAccessToken};
}
async function request(path,{method='GET',body,auth=false}={}){
  if(!configured())throw Error('数据库正在配置，暂时无法登录。');
  const accessToken=auth?await getAccessToken():null;
  const response=await fetch(config.url+path,{
    method,
    headers:{apikey:config.publishableKey,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+accessToken}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{})
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok){
    if(auth&&response.status===401&&session?.access_token===accessToken)save(null);
    const message=typeof result?.error==='string'?result.error:'';
    throw Object.assign(Error(result?.message||result?.msg||result?.error_description||message||'请求失败，请稍后重试。'),{
      code:result?.code,status:response.status
    });
  }
  return result;
}
export async function sendLogin(email){return request('/auth/v1/otp?redirect_to='+encodeURIComponent(location.origin+location.pathname),{method:'POST',body:{email,create_user:true}});}
export async function verifyLogin(email,token){const s=await request('/auth/v1/verify',{method:'POST',body:{email,token,type:'email'}});save(s);}
export async function restoreLogin(){
  const params=new URLSearchParams(location.hash.slice(1));
  if(params.has('access_token')){
    save({access_token:params.get('access_token'),refresh_token:params.get('refresh_token'),expires_at:Number(params.get('expires_at'))||Date.now()/1000+Number(params.get('expires_in')||3600)});
    history.replaceState(null,'',location.pathname+location.search);
  }
  if(!session)return null;
  try{
    const role=await rpc('nk_current_role');
    if(role==='admin'||role==='staff')return role;
    await signOut();
    throw Error('此账号未获授权或已停用。');
  }catch(error){save(null);throw error;}
}
export async function signOut(){try{if(session)await request('/auth/v1/logout?scope=local',{method:'POST',auth:true});}finally{save(null);}}
export const rpc=(name,body={})=>request('/rest/v1/rpc/'+name,{method:'POST',body,auth:true});
const adminOrderColumns='id,name,phone,created_at,source,ad_id,ip,device,ip_country,ip_city,product,quantity,price,status,notes,invalid_reason,matches,logs,assigned_staff_id';
function normalizeOrder(o){
  return {
    id:o.id,displayId:o.display_id,name:o.name,phone:o.phone,createdAt:o.created_at,
    source:sourceLabel(o.source),adId:o.ad_id,ip:o.ip,device:o.device,
    ipCountry:o.ip_country||'',ipCity:o.ip_city||'',
    product:o.product,quantity:o.quantity,price:o.price,status:o.status,notes:o.notes,
    invalidReason:o.invalid_reason,matches:o.matches||[],logs:o.logs||[],
    isDuplicate:o.is_duplicate??Boolean(o.matches?.length),assignedStaffId:o.assigned_staff_id
  };
}
export async function loadOrders(role){
  const all=[];
  const limit=500;
  for(let offset=0;;offset+=limit){
    const rows=role==='staff'
      ?await rpc('staff_load_orders_v2',{p_limit:limit,p_offset:offset})
      :await request('/rest/v1/orders?select='+adminOrderColumns+'&order=created_at.desc,id.asc&limit='+limit+'&offset='+offset,{auth:true});
    all.push(...rows);
    if(rows.length<limit)break;
  }
  return all.map(normalizeOrder);
}
export async function loadChangedOrders(role,ids){
  const keys=[...new Set(ids)];
  const changed=[];
  for(let start=0;start<keys.length;start+=50){
    const batch=keys.slice(start,start+50);
    const query=new URLSearchParams({
      select:adminOrderColumns,id:'in.('+batch.map(id=>JSON.stringify(id)).join(',')+')'
    });
    const rows=role==='staff'
      ?await rpc('staff_load_orders_by_ids',{p_ids:batch})
      :await request('/rest/v1/orders?'+query,{auth:true});
    changed.push(...rows.map(normalizeOrder));
  }
  return changed;
}
export const loadStaff=()=>rpc('admin_list_staff');
export const assignOrder=(id,staffId)=>rpc('admin_assign_order',{p_id:id,p_staff_id:staffId||null});
export const setStaffEnabled=(id,enabled)=>rpc('admin_set_staff_enabled',{p_user_id:id,p_enabled:enabled});
export const saveOrder=(id,status,notes,reason)=>rpc('update_order',{p_id:id,p_status:status,p_notes:notes,p_reason:reason||''});
export const saveNote=(id,note,expectedNotes)=>rpc('save_order_notes',{p_id:id,p_notes:note,p_expected_notes:expectedNotes});
export const saveStatus=(id,status,reason)=>rpc('save_order_status',{p_id:id,p_status:status,p_reason:reason||''});
export async function loadSettings(){return rpc('admin_pixel_config');}
export const saveSettings=value=>rpc('save_pixel_config',{p_value:value});

const siteProtectionPath = '/functions/v1/manage-site-protection';
export const loadSiteProtection = () => request(siteProtectionPath, { auth: true });
export const saveSiteProtection = value => request(siteProtectionPath, { method: 'PUT', body: value, auth: true });

export async function passwordLogin(email,password){save(await request('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}}));}
