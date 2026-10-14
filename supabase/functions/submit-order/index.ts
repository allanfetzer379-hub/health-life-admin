const allowedOrigins=new Set(['https://allanfetzer379-hub.github.io','https://novifors.com','https://www.novifors.com']);
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get('origin')||'';
 const headers={'Access-Control-Allow-Origin':allowedOrigins.has(origin)?origin:'null','Access-Control-Allow-Headers':'content-type,apikey,authorization,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin','Content-Type':'application/json'};
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(!allowedOrigins.has(origin))return reply({ok:false,error:'Forbidden'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({ok:false,error:'Method not allowed'},405);
 try{
  const text=await req.text();if(text.length>12000)return reply({ok:false,error:'请求过大'},413);
  const p=JSON.parse(text);if(p.website)return reply({ok:false,error:'请求无效'},400);
  if(typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.phone!=='string'||!/^[a-f0-9-]{36}$/i.test(p.request_id||''))return reply({ok:false,error:'请检查姓名和电话'},400);
  // Hosted gateway overwrite verified with a spoofed X-Forwarded-For on 2026-10-11.
  const ip=(req.headers.get('x-forwarded-for')||'').split(',')[0].trim();
  const url=Deno.env.get('SUPABASE_URL')!;const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const result=await fetch(url+'/rest/v1/rpc/submit_order',{method:'POST',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({p,p_ip:ip,p_device:req.headers.get('user-agent')||''})});
  if(!result.ok){const error=await result.json();const limited=String(error.message).includes('提交频繁');return reply({ok:false,error:limited?'提交频繁，请稍后再试':'提交失败，请检查资料后重试'},limited?429:400);}
  return reply(await result.json());
 }catch{return reply({ok:false,error:'提交失败，请稍后再试'},400);}
});
