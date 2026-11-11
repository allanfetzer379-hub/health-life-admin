import * as api from './api.js?v=20261112-orders-session';
import { createSiteProtectionSettings } from './site-protection.js?v=20261111-vpn';
import { startOrderRealtime } from './order-realtime.js?v=20261112-orders';
import {statuses,dateKey,normalizePhone,csv} from './model.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const employeeEntry=document.body.dataset.entry==='staff';
const siteProtection = createSiteProtectionSettings(document, api);
let orders=[];let page=1,view='orders',selected=new Set(),activeId=null,toastTimer,listMode='all',displayIds=new Map();const PAGE=10;
let currentRole=null;
let staffAccounts=[];
const noteDrafts=new Map();
const expandedNotes=new Set();
const highlightedOrders=new Set();
let highlightTimer;
let orderLoadQueue=Promise.resolve();
let stopOrderRealtime;
let connectedOnce=false;
const isAdmin=()=>currentRole==='admin';
const ordersLabel=()=>currentRole==='staff'?'我的订单':'全部订单';
const time=d=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d));
function makeDisplayIds(rows){const map=new Map(),counts=new Map();[...rows].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).forEach(o=>{const day=dateKey(o.createdAt),next=(counts.get(day)||0)+1;counts.set(day,next);map.set(o.id,`NK-${day.replaceAll('-','')}-${String(next).padStart(3,'0')}`);});return map;}
const displayId=o=>o.displayId||displayIds.get(o.id)||o.id;
function staffFeedback(message,error=false){
  $('#staff-feedback').textContent=message;
  $('#staff-feedback').classList.toggle('error',error);
}
function renderStaff(){
  $('#staff-list').innerHTML=staffAccounts.length?staffAccounts.map(account=>`
    <div class="staff-row">
      <div><strong>${esc(account.email)}</strong><small>${account.enabled?'已启用':'已停用'}</small></div>
      <button type="button" data-staff-id="${esc(account.id)}">${account.enabled?'停用':'启用'}</button>
    </div>`).join(''):'<p class="muted">暂无员工账号。</p>';
}
async function refreshStaff(){
  staffAccounts=await api.loadStaff();
  renderStaff();
}
$('#staff-list').onclick=async event=>{
  const button=event.target.closest('[data-staff-id]');
  const account=staffAccounts.find(item=>item.id===button?.dataset.staffId);
  if(!isAdmin()||!account)return;
  button.disabled=true;
  try{
    await api.setStaffEnabled(account.id,!account.enabled);
    await refreshStaff();
    staffFeedback(account.enabled?'员工账号已停用。':'员工账号已启用。');
  }catch(error){staffFeedback(error.message,true);}
  finally{button.disabled=false;}
};
function assignmentForm(order){
  if(!isAdmin())return '';
  const options=staffAccounts.filter(account=>account.enabled||account.id===order.assignedStaffId);
  return `<form id="assignment-form" class="detail-section">
    <h3>订单分配</h3>
    <div class="assignment-row">
      <label for="order-assignee">处理员工<select id="order-assignee" data-saved-assignee="${esc(order.assignedStaffId||'')}">
        <option value="">未分配</option>
        ${options.map(account=>`<option value="${esc(account.id)}" ${order.assignedStaffId===account.id?'selected':''}>
          ${esc(account.email)}${account.enabled?'':'（已停用）'}
        </option>`).join('')}
      </select></label>
      <button type="submit" ${options.length?'':'disabled'}>保存分配</button>
    </div>
  </form>`;
}
function bindAssignment(order){
  const form=$('#assignment-form');
  if(!form)return;
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=form.querySelector('button');
    const staffId=$('#order-assignee').value;
    if(staffId===(order.assignedStaffId||''))return;
    button.disabled=true;
    try{
      await api.assignOrder(order.id,staffId);
      await applyOrderChanges({ids:[order.id]});
      toast('订单分配已保存');
    }catch(error){toast(error.message);}
    finally{button.disabled=false;}
  };
}
function activityActor(log){
  if(!log.actor)return '';
  const staff=staffAccounts.find(account=>account.id===log.actor);
  return staff?.email||'账号 '+log.actor;
}
function setTodayFilter(){const today=dateKey(Date.now());$('#from').value=today;$('#to').value=today;
document.querySelectorAll('[data-days]').forEach(b=>b.classList.toggle('chosen',b.dataset.days==='0'));page=1;listMode='all';
document.querySelectorAll('[data-list]').forEach(b=>b.classList.toggle('active',b.dataset.list==='all'));selected.clear();}
function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2800);}

function enqueueOrderLoad(task){
  const result=orderLoadQueue.then(task);
  orderLoadQueue=result.catch(()=>{});
  return result;
}

function setOrderLiveState(state){
  if(state==='live')connectedOnce=true;
  const current=state==='connecting'&&connectedOnce?'reconnecting':state;
  const labels={connecting:'正在连接',live:'实时同步',offline:'同步已断开',reconnecting:'正在重连'};
  $('#order-live-state').dataset.state=current;
  $('#order-live-label').textContent=labels[current]||labels.offline;
}

function markOrdersSynced(){
  const status=$('#order-sync-time');
  status.textContent='已同步 '+time(Date.now());
  status.hidden=false;
}

function renderUpdatedOrders(changedIds){
  displayIds=isAdmin()?makeDisplayIds(orders):new Map();
  const allowedIds=new Set(orders.map(order=>order.id));
  for(const id of selected)if(!allowedIds.has(id))selected.delete(id);
  for(const id of noteDrafts.keys())if(!allowedIds.has(id))noteDrafts.delete(id);
  for(const id of expandedNotes)if(!allowedIds.has(id))expandedNotes.delete(id);
  render();
  if(!$('#detail').open||!activeId||(changedIds&&!changedIds.has(activeId)))return;
  if(allowedIds.has(activeId))openDetail(activeId,true);
  else $('#detail').close();
}

function reloadOrders(){
  return enqueueOrderLoad(async()=>{
    orders=await api.loadOrders(currentRole);
    renderUpdatedOrders();
    markOrdersSynced();
  });
}

function applyOrderChanges({ids,newIds=[]}){
  if(!ids.length)return Promise.resolve();
  return enqueueOrderLoad(async()=>{
    const updates=await api.loadChangedOrders(currentRole,ids);
    const current=new Map(orders.map(order=>[order.id,order]));
    const added=new Set(newIds);
    const incoming=updates.filter(order=>added.has(order.id)&&!current.has(order.id));
    for(const id of ids)current.delete(id);
    for(const order of updates)current.set(order.id,order);
    orders=[...current.values()];
    if(incoming.length){
      for(const order of incoming)highlightedOrders.add(order.id);
      clearTimeout(highlightTimer);
      highlightTimer=setTimeout(()=>{
        highlightedOrders.clear();
        $('#rows').querySelectorAll('.is-new-order').forEach(row=>row.classList.remove('is-new-order'));
      },7000);
      toast('收到 '+incoming.length+' 笔新订单');
    }
    renderUpdatedOrders(new Set(ids));
    markOrdersSynced();
  });
}

async function connectOrderRealtime(role){
  setOrderLiveState('connecting');
  try{
    stopOrderRealtime?.();
    const session=await api.realtimeSession();
    stopOrderRealtime=startOrderRealtime({...session,role,applyChanges:applyOrderChanges,syncOrders:reloadOrders,setStatus:setOrderLiveState});
  }catch{setOrderLiveState('offline');}
}

const countryNames=new Intl.DisplayNames(['zh-CN'],{type:'region',fallback:'none'});
function orderLocation(order){
  const country=String(order.ipCountry??'').trim();
  const city=String(order.ipCity??'').trim();
  const countryName=/^[A-Z]{2}$/i.test(country)
    ?(country.toUpperCase()==='TW'?'台湾':countryNames.of(country.toUpperCase())||country)
    :country;
  return [...new Set([countryName,city].filter(Boolean))].join(' · ');
}

function noteInputFocus(scope){
  const input=document.activeElement;
  if(!input?.dataset.noteInput||input.dataset.noteScope!==scope)return null;
  return {id:input.dataset.noteInput,start:input.selectionStart,end:input.selectionEnd,
    direction:input.selectionDirection,scroll:input.scrollTop};
}

function focusNoteInput(scope,id,position){
  const container=$(scope==='detail'?'#detail-body':'#rows');
  const input=[...container.querySelectorAll('[data-note-input]')].find(field=>field.dataset.noteInput===id);
  if(!input)return;
  input.focus({preventScroll:true});
  if(position){
    input.setSelectionRange(position.start,position.end,position.direction);
    input.scrollTop=position.scroll;
  }else input.setSelectionRange(input.value.length,input.value.length);
}

function notePanel(order,scope='list'){
  const saved=order.notes||'';
  const draft=noteDrafts.get(order.id);
  const id=esc(order.id);
  const textId='order-note-'+scope+'-'+id;
  const expanded=scope==='detail'||expandedNotes.has(order.id);
  const conflict=draft&&!draft.saving&&draft.expected!==saved;
  const editor=draft
    ? '<div class="order-note-editor">'+
      '<textarea data-note-input="'+id+'" data-note-scope="'+scope+'" aria-label="订单备注" maxlength="2000" rows="3" placeholder="例如：收货地址、方便联系的时间" '+(draft.saving?'readonly':'')+'>'+esc(draft.value)+'</textarea>'+
      (conflict?'<div class="order-note-conflict"><strong>当前已保存的备注</strong><p class="order-note-text">'+esc(saved||'暂无备注')+'</p><button type="button" data-note-rebase="'+id+'" data-note-scope="'+scope+'">保留草稿并继续编辑</button></div>':'')+
      (draft.error||conflict?'<p class="order-note-error" role="status">'+esc(conflict?'这笔备注已有更新，请先核对当前内容。':draft.error)+'</p>':'')+
      '<div class="order-note-actions">'+
      '<button type="button" class="primary" data-note-save="'+id+'" data-note-scope="'+scope+'" '+(draft.saving||conflict||draft.value===saved?'disabled':'')+'>'+(draft.saving?'保存中…':'保存备注')+'</button>'+
      '<button type="button" data-note-cancel="'+id+'" data-note-scope="'+scope+'" '+(draft.saving?'disabled':'')+'>取消</button></div></div>'
    : '<p id="'+textId+'" class="order-note-text'+(!expanded?' is-collapsed':'')+(!saved?' is-empty':'')+'" data-note-preview>'+esc(saved||'暂无备注')+'</p>'+
      (saved&&scope==='list'?'<button type="button" class="note-expand" data-note-expand="'+id+'" aria-expanded="'+expanded+'" aria-controls="'+textId+'" '+(expanded?'':'hidden')+'>'+(expanded?'收起':'展开')+'</button>':'');
  return '<section class="order-note" aria-label="订单备注"><div class="order-note-heading"><strong>订单备注</strong>'+
    (draft?'':'<button type="button" class="note-edit" data-note-edit="'+id+'" data-note-scope="'+scope+'">'+(saved?'编辑':'写备注')+'</button>')+
    '</div>'+editor+'</section>';
}

function showExpandableNotes(){
  $('#rows').querySelectorAll('[data-note-expand]').forEach(button=>{
    const preview=document.getElementById(button.getAttribute('aria-controls'));
    button.hidden=button.getAttribute('aria-expanded')==='false'&&(!preview||preview.scrollHeight<=preview.clientHeight+1);
  });
}

function updateNoteUI(id,scope,focus=false){
  render();
  if($('#detail').open&&activeId===id)openDetail(id,true);
  if(focus)focusNoteInput(scope,id);
}

async function saveInlineNote(id,scope){
  const draft=noteDrafts.get(id);
  const order=orders.find(item=>item.id===id);
  if(!draft||!order||draft.saving||draft.expected!==(order.notes||'')||draft.value===(order.notes||''))return;
  const savedValue=draft.value;
  draft.saving=true;
  draft.error='';
  updateNoteUI(id,scope);
  try{
    await api.saveNote(id,savedValue,draft.expected);
  }catch(error){
    draft.saving=false;
    draft.error=error.message;
    if(error.code==='PT409'){
      try{await applyOrderChanges({ids:[id]});}catch{}
    }
    updateNoteUI(id,scope);
    return;
  }
  const current=orders.find(item=>item.id===id);
  if(current)current.notes=savedValue;
  noteDrafts.delete(id);
  updateNoteUI(id,scope);
  try{
    await applyOrderChanges({ids:[id]});
    toast('备注已保存');
  }catch{toast('备注已保存，列表同步失败');}
}

function bindNoteActions(){
  document.addEventListener('input',event=>{
    const input=event.target;
    const id=input.dataset.noteInput;
    const draft=noteDrafts.get(id);
    const saved=orders.find(item=>item.id===id)?.notes||'';
    if(!draft)return;
    draft.value=input.value;
    const save=input.closest('.order-note').querySelector('[data-note-save]');
    save.disabled=draft.saving||draft.expected!==saved||draft.value===saved;
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-note-edit],[data-note-expand],[data-note-save],[data-note-cancel],[data-note-rebase]');
    if(!button)return;
    const {noteEdit,noteExpand,noteSave,noteCancel,noteRebase,noteScope='list'}=button.dataset;
    const id=noteEdit||noteExpand||noteSave||noteCancel||noteRebase;
    const order=orders.find(item=>item.id===id);
    if(!order)return;
    const draft=noteDrafts.get(id);
    if(noteSave){void saveInlineNote(id,noteScope);return;}
    if(noteEdit)noteDrafts.set(id,{value:order.notes||'',expected:order.notes||'',error:'',saving:false});
    if(noteCancel)noteDrafts.delete(id);
    if(noteRebase&&draft){
      draft.expected=order.notes||'';
      draft.error='';
    }
    if(noteExpand){
      if(expandedNotes.has(id))expandedNotes.delete(id);
      else expandedNotes.add(id);
    }
    updateNoteUI(id,noteScope,Boolean(noteEdit||noteRebase));
  });
  window.addEventListener('resize',showExpandableNotes);
}

function filtered(){const q=$('#search').value.trim().toLowerCase();return orders.filter(o=>(listMode==='all'||(listMode==='pending'?['new','contacted'].includes(o.status):o.status==='completed'))&&(!q||[o.name,o.phone,o.id,displayId(o),normalizePhone(o.phone)].some(v=>v.toLowerCase().includes(q))||(/[0-9]/.test(q)&&normalizePhone(o.phone).includes(normalizePhone(q))))&&(!$('#status').value||o.status===$('#status').value)&&(!$('#source').value||o.source===$('#source').value)&&(!$('#ad-id').value.trim()||String(o.adId||'').toLowerCase().includes($('#ad-id').value.trim().toLowerCase()))&&($('#duplicate').value!=='yes'||o.isDuplicate)&&($('#duplicate').value!=='no'||!o.isDuplicate)&&(!$('#from').value||dateKey(o.createdAt)>=$('#from').value)&&(!$('#to').value||dateKey(o.createdAt)<=$('#to').value)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
function renderOrderRow(order){
  const id=esc(order.id);
  const location=orderLocation(order);
  const reasons=['重粉','电话错误','无法联系','无购买意愿','其他'];
  const duplicateReasons=[...new Set(order.matches.map(match=>match.reason))].join(' / ');
  const statusText=statuses[order.status]+(order.status==='invalid'&&order.invalidReason?' · '+order.invalidReason:'');
  const quickStatuses=['contacted','confirmed','shipped','completed'].map(status=>
    `<button data-status="${status}" data-id="${id}" class="quick-status${order.status===status?' is-current':''}" aria-pressed="${order.status===status}">${statuses[status]}</button>`).join('');
  return `<article class="order-row${highlightedOrders.has(order.id)?' is-new-order':''}" data-order="${id}">
    <input class="order-check" type="checkbox" data-select="${id}" aria-label="选择 ${id}" ${selected.has(order.id)?'checked':''} ${isAdmin()?'':'hidden'}>
    <div class="order-summary">
      <div class="order-title">
        <span class="short-id">${esc(displayId(order))}</span><button class="customer" data-detail="${id}">${esc(order.name)}</button>
        <span class="badge ${order.isDuplicate?'dup':'fresh'}" title="${esc(duplicateReasons)}">${order.isDuplicate?'重粉':'新客户'}</span>
        <span class="source-chip">${esc(order.source)}</span><span class="ad-chip">广告 ID：${esc(order.adId||'未记录')}</span>
      </div>
      <div class="order-meta">
        <span>电话 <strong class="mono">${esc(order.phone)}</strong></span><span>${esc(order.product)} × ${order.quantity}</span>
        <span>金额 <strong>NT$ ${order.price.toLocaleString()}</strong></span><span class="status ${esc(order.status)}">${esc(statusText)}</span>
      </div>
      <div class="order-date"><span>${dateKey(order.createdAt)} ${time(order.createdAt)}</span>
        ${location?`<span class="order-location">IP 地区 · ${esc(location)}</span>`:''}
      </div>
      ${notePanel(order)}
    </div>
    <div class="row-actions">
      <div class="status-actions">${quickStatuses}
        <select class="invalid-reason" data-reason="${id}" aria-label="${id} 无效原因">
          <option value="">无效原因</option>${reasons.map(reason=>`<option ${order.invalidReason===reason?'selected':''}>${reason}</option>`).join('')}
        </select>
        <button data-invalid="${id}" class="quick-status${order.status==='invalid'?' is-current invalid-active':''}">无效</button>
      </div>
      <div class="utility-actions">
        <select class="other-status" data-other-status="${id}" aria-label="${id} 其他状态"><option value="">其他状态</option><option value="new">待联系</option><option value="cancelled">已取消</option></select>
        <button class="copy-order" data-copy="${id}">一键复制</button><button class="detail-button" data-detail="${id}">详情</button>
      </div>
    </div>
  </article>`;
}

function render(){
  const all=filtered();
  const pages=Math.max(1,Math.ceil(all.length/PAGE));
  page=Math.max(1,Math.min(page,pages));
  const rows=all.slice((page-1)*PAGE,page*PAGE);
  const today=dateKey(Date.now());
  const stats=[
    ['今日订单',orders.filter(order=>dateKey(order.createdAt)===today).length,isAdmin()?'今日收到的全部订单':'今日分配给我的订单','▤'],
    ['待联系',orders.filter(order=>order.status==='new').length,'及时联系，把握每次机会','◷'],
    ['首次提交',orders.filter(order=>!order.isDuplicate).length,'独立客户首次下单','↗'],
    ['已确认',orders.filter(order=>order.status==='confirmed').length,'已确认的客户订单','✓'],
    ['已完成',orders.filter(order=>order.status==='completed').length,'订单跟进已完成','✓']
  ];
  $('#nav-total').textContent=orders.length;
  $('#stats').innerHTML=stats.map(([label,total,detail,icon],index)=>
    `<div class="stat ${index===3?'stat-dup':''}"><span class="stat-label">${label}</span><span class="stat-symbol">${icon}</span><b>${String(total).padStart(2,'0')}</b><small>${detail}</small></div>`).join('');
  $('#result-count').textContent=all.length;
  const focus=noteInputFocus('list');
  $('#rows').innerHTML=rows.map(renderOrderRow).join('');
  showExpandableNotes();
  if(focus)focusNoteInput('list',focus.id,focus);
  $('#empty').hidden=!!all.length;
  $('#empty b').textContent=orders.length?'没有符合条件的订单':'暂无订单';
  $('#empty p').textContent=orders.length?'试着调整搜索内容或清除筛选。':isAdmin()?'客户提交订单后将显示在这里。':'分配给你的订单会显示在这里。';
  $('#empty-clear').hidden=!orders.length;
  $('#page-label').textContent=`共 ${all.length} 笔${all.length?` · 显示 ${(page-1)*PAGE+1}–${Math.min(page*PAGE,all.length)} 笔`:''}`;
  $('#page-number').textContent=`${page} / ${pages}`;
  $('#prev').disabled=page===1;
  $('#next').disabled=page===pages;
  $('#selected-label').textContent=selected.size?`已选择 ${selected.size} 笔 · 导出选择订单`:'未勾选时，导出目前筛选结果';
  $('#select-page').checked=!!rows.length&&rows.every(order=>selected.has(order.id));
  $('#select-page').indeterminate=rows.some(order=>selected.has(order.id))&&!$('#select-page').checked;
}
function clear(){for(const id of ['search','ad-id','status','duplicate','source','from','to'])$('#'+id).value='';
document.querySelectorAll('[data-days]').forEach(b=>b.classList.toggle('chosen',b.dataset.days==='all'));page=1;listMode='all';
document.querySelectorAll('[data-list]').forEach(b=>b.classList.toggle('active',b.dataset.list==='all'));selected.clear();render();}
function duplicateDetails(order){
  if(!isAdmin())return '';
  const matches=order.matches.map(match=>{
    const previous=orders.find(item=>item.id===match.id);
    return `<div class="match-item"><button data-detail="${esc(match.id)}">${esc(displayId({id:match.id}))} ↗</button>
      · ${esc(match.reason)}重复<p>${esc(previous?.name)} · ${previous?dateKey(previous.createdAt)+' '+time(previous.createdAt):''}</p></div>`;
  }).join('');
  return `<div class="detail-section"><h3>重粉比对${order.matches.length?` · ${order.matches.length} 笔历史纪录`:''}</h3>
    ${matches||'<p class="muted">提交时没有相同姓名或电话的历史订单。</p>'}</div>`;
}

function activityDetails(order){
  if(!isAdmin())return '';
  const logs=order.logs.slice().reverse().map(log=>
    `<div class="log">${esc(log.text)}<br>${dateKey(log.at)} ${time(log.at)}${log.actor?' · '+esc(activityActor(log)):''}</div>`).join('');
  return `<div class="detail-section"><h3>操作纪录</h3>${logs||'<p class="muted">尚无跟进修改纪录。</p>'}</div>`;
}

function openDetail(id,preserve=false){
  const order=orders.find(item=>item.id===id);
  if(!order)return;
  const focus=preserve?noteInputFocus('detail'):null;
  const previousStatus=preserve?$('#detail-status'):null;
  const statusDraft=previousStatus&&previousStatus.value!==previousStatus.dataset.savedStatus?previousStatus.value:null;
  const previousAssignee=preserve?$('#order-assignee'):null;
  const assignmentDraft=previousAssignee&&previousAssignee.value!==previousAssignee.dataset.savedAssignee?previousAssignee.value:null;
  activeId=id;
  $('#detail-body').innerHTML=`
    <div class="dialog-heading"><div><p class="eyebrow">订单信息</p><h2>订单详情</h2></div><button class="icon-button" data-close="detail" aria-label="关闭详情">×</button></div>
    <div class="detail-identity"><span class="avatar">${esc(order.name.slice(0,1))}</span><div><h2>${esc(order.name)}</h2><p>${esc(displayId(order))}</p></div></div>
    <span class="badge ${order.isDuplicate?'dup':'fresh'}">${order.isDuplicate?'重粉订单':'首次提交'}</span>
    <dl>
      <dt>手机号码</dt><dd>${esc(order.phone)} <button class="detail-button" id="copy-phone">复制</button></dd>
      <dt>下单时间</dt><dd>${dateKey(order.createdAt)} ${time(order.createdAt)}</dd>
      <dt>商品</dt><dd>${esc(order.product)} × ${order.quantity}</dd>
      <dt>订单金额</dt><dd>NT$ ${order.price.toLocaleString()}</dd>
      <dt>来源</dt><dd>${esc(order.source)}</dd><dt>广告来源 ID</dt><dd>${esc(order.adId||'未记录')}</dd>
      <dt>IP 地区</dt><dd>${esc(orderLocation(order)||'未识别')} <a class="geo-credit" href="https://db-ip.com/" target="_blank" rel="noopener noreferrer">DB-IP</a></dd>
      ${isAdmin()?`<dt>下单 IP</dt><dd class="mono">${esc(order.ip||'未记录')}</dd><dt>下单设备</dt><dd>${esc(order.device||'未记录')}</dd>`:''}
    </dl>
    ${assignmentForm(order)}
    ${duplicateDetails(order)}
    <div class="detail-section">${notePanel(order,'detail')}</div>
    <form id="detail-form" class="detail-section">
      <h3>跟进管理</h3><label for="detail-status">订单状态</label>
      <select id="detail-status" aria-label="订单状态" data-saved-status="${esc(order.status)}">${Object.entries(statuses).map(([value,label])=>
        `<option value="${value}" ${value===(statusDraft??order.status)?'selected':''}>${label}</option>`).join('')}</select>
      <button class="primary full">保存状态</button>
    </form>
    ${activityDetails(order)}`;
  bindAssignment(order);
  if(assignmentDraft!==null){
    const assignee=$('#order-assignee');
    if(assignee&&[...assignee.options].some(option=>option.value===assignmentDraft))assignee.value=assignmentDraft;
  }
  if(!$('#detail').open)$('#detail').showModal();
  if(focus)focusNoteInput('detail',id,focus);
  $('#detail-form').onsubmit=event=>{
    event.preventDefault();
    const status=$('#detail-status').value;
    if(status==='invalid'&&!order.invalidReason){toast('请先在订单列表选择无效原因');return;}
    void updateStatus(id,status,status==='invalid'?order.invalidReason:'');
  };
  $('#copy-phone').onclick=async()=>{
    try{await navigator.clipboard.writeText(order.phone);toast('电话已复制');}
    catch{toast('无法存取剪贴板，请手动选择电话复制。');}
  };
}
$('#today').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Taipei',month:'long',day:'numeric',weekday:'long'}).format(Date.now());Object.entries(statuses).forEach(([v,l])=>$('#status').add(new Option(l,v)));
document.addEventListener('click',e=>{const statusButton=e.target.closest('[data-status]');if(statusButton)updateStatus(statusButton.dataset.id,statusButton.dataset.status);const invalid=e.target.closest('[data-invalid]');if(invalid){const reason=invalid.closest('.order-row').querySelector('[data-reason]').value;if(!reason){toast('请先选择无效原因');return;}updateStatus(invalid.dataset.invalid,'invalid',reason);}const copy=e.target.closest('[data-copy]');if(copy){const o=orders.find(x=>x.id===copy.dataset.copy);copyText(`订单编号：${displayId(o)}\n下单时间：${dateKey(o.createdAt)} ${time(o.createdAt)}\n商品：${o.product} × ${o.quantity}\n订单金额：NT$ ${o.price.toLocaleString()}\n姓名：${o.name}\n电话：${o.phone}`);}const tab=e.target.closest('[data-list]');if(tab){listMode=tab.dataset.list;page=1;selected.clear();
document.querySelectorAll('[data-list]').forEach(b=>b.classList.toggle('active',b===tab));if(tab.dataset.list==='all')setTodayFilter();render();}const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();const detail=e.target.closest('[data-detail]');if(detail)openDetail(detail.dataset.detail);const nav=e.target.closest('[data-view]');if(nav&&(nav.dataset.view==='orders'||isAdmin())){view=nav.dataset.view;
document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===nav));$('#orders-view').hidden=view==='settings';$('#settings-view').hidden=view!=='settings';$('#crumb').textContent=view==='settings'?'系统设置':ordersLabel();$('#page-title').textContent='订单工作台';$('#list-title').firstChild.textContent=ordersLabel()+' ';clear();if(view==='settings'){siteProtection.open();refreshStaff().catch(error=>staffFeedback(error.message,true));}else{setTodayFilter();render();}}const quick=e.target.closest('[data-days]');if(quick){const d=quick.dataset.days;const now=new Date();const end=dateKey(now);let start=end;if(d!=='all'){now.setDate(now.getDate()-(d==='1'?1:d==='7'?6:0));start=dateKey(now);}$('#from').value=d==='all'?'':start;$('#to').value=d==='all'?'':d==='1'?start:end;
document.querySelectorAll('[data-days]').forEach(b=>b.classList.toggle('chosen',b===quick));page=1;selected.clear();render();}});
for(const id of ['search','ad-id','status','duplicate','source','from','to'])$('#'+id).addEventListener(['search','ad-id'].includes(id)?'input':'change',()=>{page=1;selected.clear();if(['from','to'].includes(id))document.querySelectorAll('[data-days]').forEach(b=>b.classList.remove('chosen'));render();});
$('#rows').onchange=e=>{if(e.target.dataset.otherStatus&&e.target.value){updateStatus(e.target.dataset.otherStatus,e.target.value);return;}const id=e.target.dataset.select;if(id){e.target.checked?selected.add(id):selected.delete(id);render();}};$('#select-page').onchange=e=>{filtered().slice((page-1)*PAGE,page*PAGE).forEach(o=>e.target.checked?selected.add(o.id):selected.delete(o.id));render();};$('#prev').onclick=()=>{page--;render();};$('#next').onclick=()=>{page++;render();};$('#clear').onclick=clear;$('#empty-clear').onclick=clear;$('#refresh').onclick=refreshOrdersManually;$('#export').onclick=()=>{if(!isAdmin())return;const rows=selected.size?orders.filter(o=>selected.has(o.id)):filtered();if(!rows.length){toast('目前没有可导出的订单');return;}const a=document.createElement('a'),url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}));a.href=url;a.download=`NK-orders-${dateKey(Date.now())}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`已导出 ${rows.length} 笔订单`);};render();



function setRefreshButton(busy){
  const button=$('#refresh');
  button.disabled=busy;
  button.setAttribute('aria-busy',String(busy));
  $('#order-refresh-label').textContent=busy?'同步中…':'刷新订单';
}

async function refreshOrdersManually(){
  if($('#refresh').disabled)return;
  setRefreshButton(true);
  try{
    await reloadOrders();
    toast('订单已同步');
  }catch{toast('同步失败，请重试');}
  finally{setRefreshButton(false);}
}

let savingOrder=false;
async function updateStatus(id,status,reason=''){
  if(savingOrder)return;
  const order=orders.find(item=>item.id===id);
  if(!order||!statuses[status])return;
  if(order.status===status&&(order.invalidReason||'')===reason){toast('当前已是此状态');return;}
  savingOrder=true;
  try{
    await api.saveStatus(id,status,reason);
  }catch(error){
    toast(error.message);
    savingOrder=false;
    return;
  }
  const current=orders.find(item=>item.id===id);
  if(current){
    current.status=status;
    current.invalidReason=reason;
    renderUpdatedOrders(new Set([id]));
  }
  try{
    await applyOrderChanges({ids:[id]});
    toast('已保存 '+statuses[status]);
  }catch{toast('状态已保存，列表同步失败');}
  finally{savingOrder=false;}
}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('客户信息已复制');}catch{toast('复制未成功，请在详情中手动复制。');}}

let pixelSettings={facebook:[],tiktok:[]};
function renderPixels(){for(const platform of ['facebook','tiktok']){$('#'+platform+'-pixels').innerHTML=pixelSettings[platform].length?pixelSettings[platform].map((p,i)=>`<div class="pixel-row"><div class="pixel-fields"><label>像素 ID<input data-pixel-platform="${platform}" data-pixel-index="${i}" aria-label="${platform==='facebook'?'FB':'TK'} 像素 ID ${i+1}" placeholder="${platform==='facebook'?'输入数字像素 ID':'输入 TikTok 像素 ID'}" value="${esc(p.id)}" maxlength="100" autocomplete="off"></label></div><label class="pixel-toggle"><input type="checkbox" data-pixel-toggle="${platform}" data-pixel-index="${i}" ${p.enabled?'checked':''}>启用</label><button data-delete-pixel="${platform}" data-pixel-index="${i}" class="delete-pixel" aria-label="删除 ${platform==='facebook'?'FB':'TK'} 像素 ${i+1}">删除</button></div>`).join(''):'<div class="pixel-empty">暂无像素<div>点击「添加」填写像素 ID</div></div>';}}
function settingsChanged(){$('#settings-feedback').textContent='有未保存的修改';$('#settings-feedback').classList.remove('error');}
document.addEventListener('click',e=>{const add=e.target.closest('[data-add-pixel]');if(add){const platform=add.dataset.addPixel;pixelSettings[platform].push({id:'',enabled:true});renderPixels();settingsChanged();$('#'+platform+'-pixels input[data-pixel-platform]:last-of-type')?.focus();}const del=e.target.closest('[data-delete-pixel]');if(del){pixelSettings[del.dataset.deletePixel].splice(Number(del.dataset.pixelIndex),1);renderPixels();settingsChanged();}});
document.addEventListener('input',e=>{if(e.target.dataset.pixelPlatform){pixelSettings[e.target.dataset.pixelPlatform][Number(e.target.dataset.pixelIndex)].id=e.target.value;settingsChanged();}});
document.addEventListener('change',e=>{if(e.target.dataset.pixelToggle){pixelSettings[e.target.dataset.pixelToggle][Number(e.target.dataset.pixelIndex)].enabled=e.target.checked;settingsChanged();}});
$('#save-settings').onclick=async()=>{for(const platform of ['facebook','tiktok']){const seen=new Set();
for(const p of pixelSettings[platform]){const id=p.id.trim();const label=platform==='facebook'?'FB':'TikTok';if(!id||!(platform==='facebook'?/^\d+$/:/^[A-Za-z0-9]+$/).test(id)){$('#settings-feedback').textContent=`请填写有效的 ${label} 像素 ID（${platform==='facebook'?'仅数字':'字母或数字'}），或删除空白配置。`;$('#settings-feedback').classList.add('error');return;}if(seen.has(id)){$('#settings-feedback').textContent=`${label} 像素 ID 重复，请检查。`;$('#settings-feedback').classList.add('error');return;}seen.add(id);}}const saved=Object.fromEntries(['facebook','tiktok'].map(platform=>[platform,pixelSettings[platform].map(p=>({...p,id:p.id.trim()}))]));try{await api.saveSettings(saved);pixelSettings=saved;renderPixels();$('#settings-feedback').textContent='已保存 · 客户下次打开页面时生效';$('#settings-feedback').classList.remove('error');toast('像素设置已保存');}catch{$('#settings-feedback').textContent='保存失败，请检查网络或重新登录。';$('#settings-feedback').classList.add('error');}};
renderPixels();if(pixelSettings.facebook.length||pixelSettings.tiktok.length)$('#settings-feedback').textContent='已加载像素配置';

async function enterWorkspace(role){
  if(employeeEntry&&role!=='staff')throw Error('此入口供订单处理员工使用。管理员请返回后台首页。');
  currentRole=role;
  document.body.dataset.role=role;
  $('[data-view="settings"]').hidden=!isAdmin();
  $('.export-tools').hidden=!isAdmin();
  $('#role-avatar').textContent=isAdmin()?'管':'员';
  $('#role-label').textContent=isAdmin()?'管理员':'订单处理';
  $('#orders-nav-label').textContent=ordersLabel();
  $('#crumb').textContent=ordersLabel();
  $('#list-title').firstChild.textContent=ordersLabel()+' ';
  $('[data-list="all"]').textContent=ordersLabel();
  if(isAdmin()){
    [pixelSettings,staffAccounts]=await Promise.all([api.loadSettings(),api.loadStaff()]);
    renderPixels();
    renderStaff();
  }
  setTodayFilter();
  await reloadOrders();
  document.body.classList.remove('locked');
  $('#auth-panel').hidden=true;
  void connectOrderRealtime(role);
}
$('#login-form').onsubmit=async e=>{e.preventDefault();$('#send-login').disabled=true;try{await api.passwordLogin($('#login-email').value.trim(),$('#login-password').value);$('#login-password').value='';const role=await api.restoreLogin();if(role)await enterWorkspace(role);}catch(error){$('#login-message').textContent=error.message;}finally{$('#send-login').disabled=false;}};
bindNoteActions();
$('#logout').onclick=async()=>{
  stopOrderRealtime?.();
  try{await api.signOut();}
  finally{location.reload();}
};
(async()=>{if(!api.configured()){$('#login-message').textContent='后台已部署，数据库正在初始化，完成后即可登录。';$('#send-login').disabled=true;return;}try{const role=await api.restoreLogin();if(role)await enterWorkspace(role);else $('#login-message').textContent=employeeEntry?'请使用已启用的员工账号登录。':'请使用已授权的后台账号登录。';}catch(error){$('#login-message').textContent=error.message;}})();
