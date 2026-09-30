let me = null;
let topics = [];
let halls = [];
let currentTopic = null;
let messages = [];
let replyTo = null;
let onlineMap = {};
let socket = null;
let convs = [], allConvs = [], currentConv = null, convReadOnly = false, convMsgs = [];
const unread = {};
let pendingAtt = null;       // {id, kind, name, url} staged for the topic composer
let pendingChatAtt = null;   // same, for the chat composer
let settings = { topicOpenMode: 'scroll', recoveryMethod: 'admin' }, emailAvailable = false;
let pendingMembers = 0, pendingMsgs = 0;
let searchQuery = '', searchTimer = null;
let mobileView = 'content';   // only matters in "separate page" mode on phones: 'list' | 'content'
const isNarrow = () => window.matchMedia('(max-width:1000px)').matches;

const $ = (sel) => document.querySelector(sel);
function esc(s){ const d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }
function avatar(name){
  const n=(name||'?').trim(); let h=0; for(const ch of n) h=(h*31+ch.codePointAt(0))%360;
  return `<span class="avatar" style="background:hsl(${h},42%,42%)">${esc([...n][0]||'?')}</span>`;
}
function fmtTime(ts){ return new Date(ts).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}); }

async function api(url, opts={}){
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? {'Content-Type':'application/json'} : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || 'خطا');
  return data;
}

// ---------------- auth screen ----------------
$('#tabLogin').onclick = ()=>{ $('#tabLogin').classList.add('active'); $('#tabRegister').classList.remove('active'); $('#loginForm').style.display='block'; $('#registerForm').style.display='none'; };
$('#tabRegister').onclick = ()=>{ $('#tabRegister').classList.add('active'); $('#tabLogin').classList.remove('active'); $('#registerForm').style.display='block'; $('#loginForm').style.display='none'; };

$('#loginForm').onsubmit = async (e)=>{
  e.preventDefault();
  $('#loginErr').textContent='';
  try{
    const { user } = await api('/api/auth/login', { method:'POST', body:{ username: $('#loginUsername').value, password: $('#loginPassword').value }});
    startApp(user);
  }catch(err){ $('#loginErr').textContent = err.message; }
};
$('#registerForm').onsubmit = async (e)=>{
  e.preventDefault();
  $('#regErr').textContent='';
  const password = $('#regPassword').value;
  const confirmPassword = $('#regConfirmPassword').value;
  const phone = $('#regPhone').value.trim();
  if(password !== confirmPassword){ $('#regErr').textContent = 'رمز عبور و تکرار آن یکسان نیستند'; return; }
  if(!/^(0|\+98|0098)?9\d{9}$/.test(phone.replace(/[^\d+]/g,''))){ $('#regErr').textContent = 'شماره موبایل معتبر وارد کنید (مثال: 0912xxxxxxx)'; return; }
  try{
    const { user } = await api('/api/auth/register', { method:'POST', body:{ username: $('#regUsername').value, password, confirmPassword, phone, email: $('#regEmail').value.trim(), displayName: $('#regDisplayName').value }});
    startApp(user);
  }catch(err){ $('#regErr').textContent = err.message; }
};

// ---------------- forgot password / reset password / contact admin ----------------
async function recoveryInfo(){
  try{ return await api('/api/public/recovery-info'); }catch(e){ return { method:'admin', contact:null }; }
}
async function openForgot(){
  const info = await recoveryInfo();
  if(info.method==='admin'){ openContactAdmin(true); return; }   // email is not the chosen method: go straight to the admin
  openModal(`<h3>فراموشی رمز عبور</h3>
    <p class="mutedNote">نام کاربری یا ایمیل خود را وارد کنید تا لینک بازیابی برایتان ایمیل شود.</p>
    <input id="forgotId" placeholder="نام کاربری یا ایمیل">
    <p class="err" id="forgotErr"></p>
    <p id="forgotMsg" class="mutedNote"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="ghost" style="margin-left:auto" onclick="openContactAdmin(true)">ایمیل ندارم / ایمیل نرسید</button><button class="ghost" onclick="closeModal()">بستن</button><button onclick="submitForgot()">ارسال لینک</button></div>`);
}
async function submitForgot(){
  const id = $('#forgotId').value.trim(); if(!id){ $('#forgotErr').textContent='نام کاربری یا ایمیل را وارد کنید'; return; }
  try{
    const { message } = await api('/api/auth/forgot', { method:'POST', body:{ identifier: id } });
    $('#forgotErr').textContent='';
    $('#forgotMsg').textContent = message;
  }catch(e){ $('#forgotErr').textContent = e.message; }
}
let contactOpenedAt = 0;
async function openContactAdmin(forgot){
  const { contact: c } = await recoveryInfo();
  const phoneHtml = (c && c.phone)
    ? `<p>تماس تلفنی با ${esc(c.displayName)}:</p><p><a class="phoneLink" href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a></p>`
    : `<p class="mutedNote">شماره‌ی تماس مدیر هنوز ثبت نشده.</p>`;
  contactOpenedAt = Date.now();
  openModal(`<h3>${forgot?'فراموشی رمز عبور — ارتباط با مدیر':'ارتباط با مدیر'}</h3>
    ${forgot?'<p class="mutedNote">برای رمز جدید، مدیر باید هویت شما را تایید کند. یا تماس بگیرید یا پیام بفرستید.</p>':''}
    ${phoneHtml}
    <hr style="border-color:var(--line)">
    <p class="mutedNote">یا همین‌جا پیام بفرستید (مدیر در سایت می‌بیند):</p>
    <input id="cmName" placeholder="نام شما">
    <input id="cmUser" placeholder="نام کاربری (اگر دارید)" autocapitalize="none" autocomplete="off">
    <input id="cmContact" type="tel" placeholder="شماره‌ی تماس برای پاسخ (اختیاری)">
    <textarea id="cmText" maxlength="500" placeholder="پیام شما (حداکثر ۵۰۰ کاراکتر)" style="min-height:90px"></textarea>
    <input id="cmWebsite" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
    <p class="err" id="cmErr"></p><p id="cmOk" class="mutedNote" style="color:var(--accent);font-weight:bold"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">بستن</button><button id="cmSend" onclick="sendContactAdmin()">ارسال پیام</button></div>`);
}
async function sendContactAdmin(){
  $('#cmErr').textContent=''; $('#cmOk').textContent='';
  const btn=$('#cmSend'); btn.disabled=true;
  try{
    await api('/api/public/contact-admin', { method:'POST', body:{
      name:$('#cmName').value, username:$('#cmUser').value, contact:$('#cmContact').value, text:$('#cmText').value,
      website:$('#cmWebsite').value, elapsed: Date.now()-contactOpenedAt } });
    $('#cmOk').textContent = '✅ پیام شما برای مدیر فرستاده شد. مدیر پس از بررسی با شما هماهنگ می‌کند.';
    $('#cmText').value='';
  }catch(e){ $('#cmErr').textContent = e.message; btn.disabled=false; return; }
  setTimeout(()=>{ const b=$('#cmSend'); if(b) b.disabled=false; }, 4000);
}
$('#resetForm').onsubmit = async (e)=>{
  e.preventDefault();
  $('#resetErr').textContent = '';
  const p1 = $('#resetNewPass').value, p2 = $('#resetNewPass2').value;
  const token = new URLSearchParams(location.search).get('reset');
  try{
    const { user } = await api('/api/auth/reset', { method:'POST', body:{ token, newPassword:p1, confirmPassword:p2 } });
    history.replaceState(null, '', location.pathname);
    startApp(user);
  }catch(err){ $('#resetErr').textContent = err.message; }
};
$('#logoutBtn').onclick = async ()=>{ await api('/api/auth/logout', {method:'POST'}); location.reload(); };

// ---------------- bootstrap ----------------
(async function init(){
  const resetToken = new URLSearchParams(location.search).get('reset');
  const { user } = await api('/api/me');
  if(user && !resetToken) startApp(user);
  else {
    $('#authScreen').style.display='flex';
    if(resetToken){ $('#loginForm').style.display='none'; $('#registerForm').style.display='none'; $('#tabLogin').style.display='none'; $('#tabRegister').style.display='none'; $('#resetForm').style.display='block'; }
  }
})();

function startApp(user){
  me = user;
  $('#authScreen').style.display='none';
  $('#appScreen').style.display='block';
  $('#whoami').textContent = `${me.displayName} (${roleLabel(me.role)})`;
  if(me.role==='admin'){ $('#newHallBtn').style.display='inline-block'; $('#adminBtn').style.display='inline-block'; api('/api/pending-count').then(d=>updatePendingBadge(d.count)).catch(()=>{}); if(me.isOwner) api('/api/admin-messages').then(d=>{ pendingMsgs=d.unhandled; refreshAdminBadge(); }).catch(()=>{}); }
  connectSocket();
  loadHalls();
  loadSettings().then(()=>loadTopics()).then(()=>jumpToMsgFromUrl());
  loadConvs();
}

// ---------------- site settings + how a topic opens on phones ----------------
async function loadSettings(){
  try{ const r = await api('/api/settings'); settings = r.settings; emailAvailable = !!r.emailAvailable; }catch(e){}
  applyViewMode();
}
function applyViewMode(){
  const page = settings.topicOpenMode==='page' && isNarrow();
  document.body.classList.toggle('pm', page);
  document.body.classList.toggle('pm-content', page && mobileView==='content');
  document.body.classList.toggle('pm-list', page && mobileView==='list');
}
window.addEventListener('resize', applyViewMode);
function showList(){ mobileView='list'; applyViewMode(); window.scrollTo(0,0); }
function backBtnHtml(){ return `<button type="button" class="ghost backBtn" onclick="showList()">→ بازگشت به فهرست تالارها</button>`; }
// make it obvious that something opened: jump to it (phones) and flash it briefly
function revealMain(){
  if(!isNarrow()) return;
  const el = $('#mainArea');
  if(document.body.classList.contains('pm')) window.scrollTo(0,0);
  else if(el.scrollIntoView) el.scrollIntoView({behavior:'smooth', block:'start'});
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
async function saveSetting(key, value){
  try{ await api('/api/settings', { method:'PATCH', body:{ [key]: value } }); settings[key] = value; toast('✅ تنظیمات ذخیره شد'); }
  catch(e){ alert(e.message); if($('#modalRoot').innerHTML) openSettings(); }
}
function roleLabel(r){ return {admin:'مدیر', member:'عضو', pending:'در انتظار تایید', blocked:'مسدود'}[r] || r; }
function canWrite(){ return me && (me.role==='admin' || me.role==='member'); }

function connectSocket(){
  socket = io();
  socket.on('presence', list=>{ onlineMap={}; list.forEach(u=>onlineMap[u.id]=u); renderOnline(); });
  socket.on('newTopic', t=>{ topics.push(t); renderTopics(); });
  socket.on('topicUpdated', t=>{ const i=topics.findIndex(x=>x.id===t.id); if(i>-1) topics[i]=t; renderTopics(); if(currentTopic===t.id) renderMain(); });
  socket.on('newMessage', m=>{ if(m.topicId===currentTopic){ messages.push(m); renderMain(); } });
  socket.on('messageUpdated', m=>{ const i=messages.findIndex(x=>x.id===m.id); if(i>-1){ messages[i]=m; if(m.topicId===currentTopic) renderMain(); } });
  socket.on('messageDeleted', ({id, topicId})=>{ messages = messages.filter(x=>x.id!==id); if(topicId===currentTopic) renderMain(); });
  socket.on('userUpdated', u=>{
    messages.forEach(m=>{ if(m.userId===u.id) m.authorName = u.displayName; });
    convMsgs.forEach(m=>{ if(m.from===u.id) m.fromName = u.displayName; });
    if(u.id===me.id){ me={...me, ...u}; $('#whoami').textContent = `${me.displayName} (${roleLabel(me.role)})`; }
    if(currentTopic) renderMain(); else if(currentConv) renderChat();
  });
  socket.on('chatMessage', ({msg, conv})=>{
    if(msg.convId===currentConv){ convMsgs.push(msg); renderChat(); window.scrollTo(0, document.body.scrollHeight); }
    else if(msg.from!==me.id && conv.memberIds.includes(me.id)){
      unread[msg.convId] = (unread[msg.convId]||0) + 1;
      toast(`💬 پیام جدید از ${msg.fromName}`);
    }
    loadConvs();
  });
  socket.on('chatMessageDeleted', ({id, convId})=>{ if(convId===currentConv){ convMsgs = convMsgs.filter(x=>x.id!==id); renderChat(); } loadConvs(); });
  socket.on('convChanged', ()=>loadConvs());
  socket.on('newMember', (n)=>{ toast(`🆕 عضو جدید: ${n.displayName} — منتظر تایید`); });
  socket.on('pendingCount', ({count})=> updatePendingBadge(count));
  socket.on('hallsChanged', ()=> loadHalls());
  socket.on('settingsChanged', (st)=>{ settings = { ...settings, ...st }; applyViewMode(); });
  socket.on('topicDeleted', ({id})=>{
    topics = topics.filter(x=>x.id!==id);
    if(currentTopic===id){
      currentTopic = null; messages = []; closeModal();
      const g = topics.find(t=>t.general) || topics[0];
      if(g) selectTopic(g.id); else { renderTopics(); renderMain(); }
    } else renderTopics();
  });
  socket.on('adminMessage', (n)=>{ pendingMsgs++; refreshAdminBadge(); toast(`📨 پیام تازه برای مدیر از ${n.name||'یک کاربر'}`); });
  socket.on('chatMessageUpdated', ({msg})=>{
    if(msg.convId!==currentConv) return;
    const i = convMsgs.findIndex(x=>x.id===msg.id);
    if(i>-1){ convMsgs[i] = msg; renderChat(); }
  });
  socket.on('notify', (n)=>{
    if(n.kind==='reaction'){ toast(`${n.icon} ${n.from} به پیام شما در «${n.topicTitle||''}» واکنش داد${n.text?': '+n.text:''}`); return; }
    const icon = n.kind==='reply' ? '↩️' : (n.kind==='topic' ? '📌' : '💬');
    toast(`${icon} ${esc(n.from)} — ${esc(n.topicTitle||'')}${n.text?': '+esc(n.text):''}`);
  });
}

// ---------------- topics ----------------
async function loadTopics(){
  const { topics: t } = await api('/api/topics');
  topics = t;
  renderTopics();
  const first = topics.find(t=>t.general) || topics[0];
  if(!first) return;
  if(settings.topicOpenMode==='page' && isNarrow()){ mobileView='list'; applyViewMode(); }
  else await selectTopic(first.id);
}
function topicItemHtml(t){
  const admin = me && me.role==='admin';
  const tools = admin ? `<span class="topicTools"><span class="iconbtn hsm" title="ویرایش" onclick="event.stopPropagation();editTopic('${t.id}')">✏️</span>${t.general?'':`<span class="iconbtn hsm" title="حذف" onclick="event.stopPropagation();deleteTopic('${t.id}')">🗑</span>`}</span>` : '';
  return `<div class="topic hasTools ${t.id===currentTopic?'active':''}" data-id="${t.id}"><span class="topicName">${t.general?'🏛️ ':''}${esc(t.title)}${t.pdfFile?' 📎':''}</span>${tools}</div>`;
}
function renderTopics(){
  const standalone = topics.filter(t=>!t.hallId).sort((a,b)=>(b.general?1:0)-(a.general?1:0));
  let html = standalone.map(topicItemHtml).join('');
  html += halls.map(h=>{
    const kids = topics.filter(t=>t.hallId===h.id);
    return `<div class="hallGroup">
      <div class="hallHead">📁 ${esc(h.title)}${me.role==='admin'?` <span class="iconbtn hsm" onclick="editHall('${h.id}')">✏️</span><span class="iconbtn hsm" onclick="newTopicIn('${h.id}')">＋</span>`:''}</div>
      <div class="hallKids">${kids.map(topicItemHtml).join('') || '<p class="mutedNote" style="margin:2px 10px">هنوز جلسه‌ای نیست.</p>'}</div>
    </div>`;
  }).join('');
  $('#topicList').innerHTML = html || '<p style="font-size:0.75rem;color:var(--muted)">هنوز اتاقی نیست.</p>';
  document.querySelectorAll('#topicList .topic').forEach(el=>el.onclick=()=>selectTopic(el.dataset.id,{reveal:true}));
}
async function loadHalls(){ try{ const { halls: h } = await api('/api/halls'); halls = h; renderTopics(); }catch(e){} }
$('#newHallBtn') && ($('#newHallBtn').onclick = async ()=>{
  const title = prompt('عنوان تالار اختصاصی جدید (مثلاً «تالار نماز»):'); if(!title) return;
  try{ await api('/api/halls', { method:'POST', body:{ title } }); await loadHalls(); }catch(e){ alert(e.message); }
});
async function newTopicIn(hallId){
  const title = prompt('عنوان زیرموضوع/جلسه جدید:'); if(!title) return;
  try{ const { topic } = await api('/api/topics', { method:'POST', body:{ title, hallId } }); selectTopic(topic.id); }catch(e){ alert(e.message); }
}
async function editHall(id){
  const h = halls.find(x=>x.id===id); if(!h) return;
  const title = prompt('عنوان تالار:', h.title); if(!title) return;
  try{ await api(`/api/halls/${id}`, { method:'PATCH', body:{ title } }); }catch(e){ alert(e.message); }
}
async function selectTopic(id, opts={}){
  clearSearch();
  currentTopic = id; currentConv = null; convReadOnly = false; renderTopics(); renderConvLists(); replyTo=null;
  mobileView='content'; applyViewMode();
  const { messages: m } = await api(`/api/topics/${id}/messages`);
  messages = m; renderMain();
  if(opts.reveal) revealMain();
}

// ---------------- messages ----------------
function attachHtml(a){
  if(!a) return '';
  if(a.kind==='image') return `<div class="attach"><img src="${a.url}" onclick="window.open('${a.url}','_blank')" alt="${esc(a.name||'')}"></div>`;
  return `<div class="attach"><audio controls src="${a.url}"></audio></div>`;
}
function msgRowHtml(m, ref, extraActions){
  const canSpeak = !!(window.speechSynthesis && m.text);
  const mineRx = (m.reactions||{})[me.id];
  const rx = (kind, icon, n)=>`<span class="rx ${mineRx===kind?'mine':''}" data-kind="${kind}" onmouseenter="rxHover(this,'${m.id}')" onclick="react('${m.id}','${kind}')">${icon} ${n||0}</span>`;
  const anyRx = (m.likes||0)+(m.dislikes||0)+(m.thanks||0) > 0;
  return `<div class="msg ${m.pinned?'pinned':''}" id="m_${m.id}">
      <div class="meta">${avatar(m.authorName)}<b>${esc(m.authorName)}</b> ${m.pinned?'<span class="badge">پین‌شده</span>':''} <span>${fmtTime(m.time)}</span>${m.edited?'<span class="editedTag">(ویرایش‌شده)</span>':''}</div>
      ${ref?`<div class="reply-ref">در پاسخ به ${esc(ref.authorName)}: ${esc(ref.text.slice(0,60))}</div>`:''}
      ${m.text?`<div>${esc(m.text)}</div>`:''}
      ${attachHtml(m.attachment)}
      <div class="actions">
        ${rx('likes','👍',m.likes)}${rx('dislikes','👎',m.dislikes)}${rx('thanks','🙏',m.thanks)}
        ${anyRx?`<span onclick="showReactors('${m.id}')">👥 چه کسانی؟</span>`:''}
        ${canWrite()?`<span onclick="setReply('${m.id}')">پاسخ</span>`:''}
        ${(canWrite() && m.userId===me.id)?`<span onclick="editMsg('${m.id}','topic')">✏️ ویرایش</span>`:''}
        ${(me.role==='admin'||m.userId===me.id)?`<span onclick="delMsg('${m.id}')">حذف</span>`:''}
        ${me.role==='admin'?`<span onclick="togglePin('${m.id}',${!m.pinned})">${m.pinned?'برداشتن پین':'پین کردن'}</span>`:''}
        <span onclick="shareMsgLink('${m.id}')">🔗 لینک</span>
        ${canSpeak?`<span onclick="speakMsgById('${m.id}')">🔊 خواندن</span>`:''}
      </div>
    </div>`;
}
function renderMain(){
  if(searchQuery) return;   // search results are on screen; they are replaced when the search is closed
  if(currentConv){ renderChat(); return; }
  const t = topics.find(x=>x.id===currentTopic);
  if(!t){ $('#mainArea').innerHTML=backBtnHtml()+'<div class="welcome"><h2>🌵 به راه بادیه مجازی خوش آمدید</h2><p>فضایی برای گفتگو، تبادل نظر و اشتراک‌گذاری دانش<br>در مسیر بی‌انتهای بیابان اندیشه</p><p>یک تالار را انتخاب کنید یا از فهرست اعضای آنلاین، گفتگوی خصوصی شروع کنید.</p></div>'; return; }
  let list = [...messages].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || a.time-b.time);
  let html = backBtnHtml() + `<div class="topicHead"><h2>${esc(t.title)}</h2>${me.role==='admin'?`<button class="iconbtn" onclick="editTopic('${t.id}')">✏️ ویرایش</button>${t.general?'':`<button class="iconbtn" onclick="deleteTopic('${t.id}')">🗑 حذف</button>`}`:''}</div>`;
  if(t.description) html += `<p class="mutedNote">${esc(t.description)}</p>`;
  if(t.pdfFile) html += `<p>📎 <a href="/uploads/${t.pdfFile}" target="_blank">${esc(t.pdfName||'فایل PDF')}</a>${me.role==='admin'?` <span class="iconbtn" style="cursor:pointer" onclick="deleteTopicPdf('${t.id}')">🗑 حذف فایل</span>`:''}</p>`;
  if(me.role==='admin') html += `<p><label class="iconbtn" style="cursor:pointer">📎 ${t.pdfFile?'جایگزینی فایل PDF':'بارگذاری فایل PDF'}<input type="file" id="pdfInput" accept="application/pdf" style="display:none"></label></p>`;
  html += `<div id="msgList">` + (list.map(m=>{
    const ref = m.replyTo ? messages.find(x=>x.id===m.replyTo) : null;
    return msgRowHtml(m, ref);
  }).join('') || '<p style="color:var(--muted)">پیامی نیست.</p>') + `</div>`;

  if(canWrite()){
    html += `<div style="display:${replyTo?'block':'none'};font-size:0.75rem;color:var(--muted)">در حال پاسخ <span onclick="clearReply()" style="cursor:pointer;color:var(--accent)">✕ لغو</span></div>
    <div class="composerRow">
      <div class="composer">
        <textarea id="composerInput" placeholder="پیام خود را بنویسید..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg();}"></textarea>
        <div class="composerTools">
          <label class="iconbtn" style="cursor:pointer" title="پیوست عکس یا صدا">📷🎤<input type="file" id="msgAttachInput" accept="image/*,audio/*" style="display:none"></label>
          <button type="button" class="iconbtn" id="micBtn" style="display:none" title="گفتار به نوشتار">🎙️</button>
          <button onclick="sendMsg()">ارسال</button>
        </div>
      </div>
      <div id="attachPreviewBox"></div>
    </div>`;
  } else {
    html += `<div class="locked">${me.role==='pending' ? 'حساب شما هنوز توسط مدیر تایید نشده — فقط امکان مشاهده دارید.' : 'دسترسی نوشتن ندارید.'}</div>`;
  }
  $('#mainArea').innerHTML = html;
  const pdfInput = $('#pdfInput');
  if(pdfInput) pdfInput.onchange = uploadPdf;
  const attInput = $('#msgAttachInput');
  if(attInput) attInput.onchange = (e)=>stageAttachment(e, 'topic');
  renderAttachPreview();
  setupMicButton('micBtn','topic');
}
function setReply(id){ replyTo=id; renderMain(); }
function clearReply(){ replyTo=null; renderMain(); }
async function sendMsg(){
  const el = $('#composerInput'); const val = el.value.trim();
  if(!val && !pendingAtt) return;
  const body = { text: val, replyTo };
  if(pendingAtt) body.attachmentId = pendingAtt.id;
  try{
    await api(`/api/topics/${currentTopic}/messages`, { method:'POST', body });
    replyTo=null; el.value=''; pendingAtt=null; renderAttachPreview();
  }catch(e){ alert(e.message); }
}
async function react(id, kind){
  if(!canWrite()){ toast('برای واکنش دادن باید حساب شما توسط مدیر تایید شود'); return; }
  try{ await api(`/api/messages/${id}/react`, { method:'POST', body:{ kind } }); }catch(e){ toast(e.message); }
}
async function togglePin(id, val){ await api(`/api/messages/${id}/pin`, { method:'POST', body:{ pinned: val } }); }
async function delMsg(id){ if(confirm('حذف شود؟')) await api(`/api/messages/${id}`, { method:'DELETE' }); }
async function uploadPdf(e){
  const file = e.target.files[0]; if(!file) return;
  const fd = new FormData(); fd.append('pdf', file);
  try{
    const res = await fetch(`/api/topics/${currentTopic}/pdf`, { method:'POST', body: fd });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'خطا در بارگذاری فایل');
  }catch(err){ alert(err.message); }
}
async function deleteTopicPdf(id){
  if(!confirm('فایل PDF این تالار حذف شود؟')) return;
  await api(`/api/topics/${id}/pdf`, { method:'DELETE' }).catch(e=>alert(e.message));
}
async function editTopic(id){
  const t = topics.find(x=>x.id===id); if(!t) return;
  const hallPick = t.general ? '' : `<p class="mutedNote">این تاپیک داخل کدام تالار باشد؟</p>
    <select id="editTopicHall">${t.hallId?'':'<option value="">— بدون تالار —</option>'}${halls.map(h=>`<option value="${h.id}" ${t.hallId===h.id?'selected':''}>${esc(h.title)}</option>`).join('')}</select>`;
  openModal(`<h3>ویرایش تاپیک</h3>
    <input id="editTopicTitle" value="${esc(t.title)}" placeholder="عنوان">
    <textarea id="editTopicDesc" placeholder="توضیح کوتاه (اختیاری)" style="min-height:70px">${esc(t.description||'')}</textarea>
    ${hallPick}
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">${t.general?'':`<button class="ghost" style="margin-left:auto" onclick="deleteTopic('${id}')">🗑 حذف تاپیک</button>`}<button class="ghost" onclick="closeModal()">انصراف</button><button onclick="saveTopicEdit('${id}')">ذخیره</button></div>`);
}
async function saveTopicEdit(id){
  const body = { title: $('#editTopicTitle').value, description: $('#editTopicDesc').value };
  const hallSel = $('#editTopicHall'); if(hallSel) body.hallId = hallSel.value || null;
  try{
    await api(`/api/topics/${id}`, { method:'PATCH', body });
    closeModal();
  }catch(e){ alert(e.message); }
}
async function deleteTopic(id){
  const t = topics.find(x=>x.id===id); if(!t || t.general) return;
  if(!confirm(`تاپیک «${t.title}» با همه‌ی پیام‌ها و فایل‌هایش برای همیشه حذف شود؟\nاین کار قابل بازگشت نیست.`)) return;
  try{ await api(`/api/topics/${id}`, { method:'DELETE' }); closeModal(); }catch(e){ alert(e.message); }
}

// ---------------- who reacted ----------------
const RX_ICON = { likes:'👍', dislikes:'👎', thanks:'🙏' };
async function fetchReactors(id){ return api(`/api/messages/${id}/reactors`); }
// desktop: hovering a reaction shows the names as a tooltip
async function rxHover(el, id){
  if(el._loading) return; el._loading = true;
  try{
    const d = await fetchReactors(id); const k = el.dataset.kind;
    const names = d[k] || [], anon = (d.unnamed||{})[k]||0;
    el.title = names.length || anon ? [...names, ...(anon?[`${anon} نفر (قدیمی، بدون نام)`]:[])].join('، ') : 'هنوز کسی نداده';
  }catch(e){}
  setTimeout(()=>{ el._loading=false; }, 1500);
}
// phone/tablet (and desktop): "چه کسانی؟" lists every name per reaction
async function showReactors(id){
  let d; try{ d = await fetchReactors(id); }catch(e){ toast(e.message); return; }
  const rows = ['likes','dislikes','thanks'].map(k=>{
    const names = d[k]||[], anon = (d.unnamed||{})[k]||0;
    if(!names.length && !anon) return '';
    return `<div class="rxRow"><b>${RX_ICON[k]}</b> ${names.map(esc).join('، ')}${anon?`${names.length?'، ':''}<span class="mutedNote">${anon} نفر (قدیمی، بدون نام)</span>`:''}</div>`;
  }).join('');
  openModal(`<h3>واکنش‌ها</h3>${rows || '<p class="mutedNote">هنوز واکنشی نیست.</p>'}<div style="margin-top:12px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
}

// ---------------- edit my own message (topic or chat) ----------------
function editMsg(id, where){
  const m = (where==='chat' ? convMsgs : messages).find(x=>x.id===id); if(!m) return;
  openModal(`<h3>ویرایش پیام</h3>
    <textarea id="editMsgText" style="min-height:120px" maxlength="4000">${esc(m.text||'')}</textarea>
    <p class="err" id="editMsgErr"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">انصراف</button><button onclick="saveMsgEdit('${id}','${where}')">ذخیره</button></div>`);
  const ta = $('#editMsgText'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
async function saveMsgEdit(id, where){
  const text = $('#editMsgText').value;
  try{
    await api(where==='chat' ? `/api/chatmsg/${id}` : `/api/messages/${id}`, { method:'PATCH', body:{ text } });
    closeModal();
  }catch(e){ $('#editMsgErr').textContent = e.message; }
}

// ---------------- search (all topics, with results list) ----------------
function fmtDate(ts){ return new Date(ts).toLocaleDateString('fa-IR'); }
function clearSearch(){ searchQuery=''; clearTimeout(searchTimer); const b=$('#searchBox'); if(b) b.value=''; }
function leaveSearch(){ clearSearch(); if(currentConv) renderChat(); else renderMain(); }
$('#searchBox').oninput = (e)=>{
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(()=>runSearch(q), 350);
};
$('#searchBox').onkeydown = (e)=>{ if(e.key==='Enter'){ e.preventDefault(); clearTimeout(searchTimer); runSearch(e.target.value.trim()); } };
async function runSearch(q){
  if(!q){ if(searchQuery){ leaveSearch(); } return; }
  if(q.length<2){ return; }
  let results = [];
  try{ results = (await api('/api/search?q='+encodeURIComponent(q))).results; }catch(err){ toast(err.message); return; }
  if($('#searchBox').value.trim()!==q) return;   // typed something else meanwhile
  searchQuery = q;
  mobileView='content'; applyViewMode();
  $('#mainArea').innerHTML = backBtnHtml() + `<div class="topicHead"><h2>🔍 نتایج جستجو</h2><button class="iconbtn" onclick="leaveSearch()">✕ بستن جستجو</button></div>
    <p class="mutedNote">«${esc(q)}» — ${results.length ? results.length+' پیام پیدا شد (تازه‌ترین‌ها اول)' : 'پیامی پیدا نشد'}</p>
    <div>${results.map(r=>`<div class="msg searchHit" onclick="openSearchHit('${r.topicId}','${r.id}')">
      <div class="meta">${avatar(r.authorName)}<b>${esc(r.authorName)}</b><span>در «${esc(r.topicTitle)}»</span><span>${fmtDate(r.time)}</span></div>
      <div>${esc(r.snippet)}</div></div>`).join('')}</div>`;
  revealMain();
}
async function openSearchHit(topicId, msgId){
  await selectTopic(topicId);
  setTimeout(()=>{
    const el = document.getElementById('m_'+msgId);
    if(el){ el.scrollIntoView({behavior:'smooth', block:'center'}); el.classList.add('highlight'); setTimeout(()=>el.classList.remove('highlight'), 2500); }
  }, 250);
}

// ---------------- attachments (images / voice notes) ----------------
async function stageAttachment(e, target){
  const file = e.target.files[0]; if(!file) return;
  const fd = new FormData(); fd.append('file', file);
  try{
    const res = await fetch('/api/attachments', { method:'POST', body: fd });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'خطا در بارگذاری فایل');
    if(target==='topic'){ pendingAtt = data.attachment; renderAttachPreview(); }
    else { pendingChatAtt = data.attachment; renderAttachPreview(); }
  }catch(err){ alert(err.message); }
  e.target.value = '';
}
function renderAttachPreview(){
  const box = $('#attachPreviewBox');
  if(box){
    const a = pendingAtt;
    box.innerHTML = a ? `<div class="attachPreview">${a.kind==='image'?`<img src="${a.url}">`:'🎤'} <span>${esc(a.name)}</span><span class="rm" onclick="pendingAtt=null;renderAttachPreview()">✕ حذف</span></div>` : '';
  }
  const cbox = $('#chatAttachPreviewBox');
  if(cbox){
    const a = pendingChatAtt;
    cbox.innerHTML = a ? `<div class="attachPreview">${a.kind==='image'?`<img src="${a.url}">`:'🎤'} <span>${esc(a.name)}</span><span class="rm" onclick="pendingChatAtt=null;renderAttachPreview()">✕ حذف</span></div>` : '';
  }
}

// ---------------- voice typing (speech-to-text): full-screen panel ----------------
const SR_API = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const vp = { rec:null, target:'topic', wantOn:false, lastStart:0, gotResult:false, quickFails:0 };
const VP_ERRORS = {
  'not-allowed': 'اجازه‌ی استفاده از میکروفون داده نشده. در Chrome روی آیکون کنار آدرس سایت بزنید و میکروفون را روی «اجازه» بگذارید.',
  'service-not-allowed': 'سرویس تشخیص گفتار روی این دستگاه فعال نیست (تنظیمات اپ Google و Speech Services را بررسی کنید).',
  'audio-capture': 'میکروفون پیدا نشد یا برنامه‌ی دیگری از آن استفاده می‌کند.',
  'network': 'اتصال به سرویس تشخیص گفتار گوگل برقرار نشد. اینترنت را بررسی کنید؛ ممکن است این سرویس بدون VPN در دسترس نباشد.',
  'language-not-supported': 'تشخیص گفتار فارسی روی این دستگاه پشتیبانی نمی‌شود.'
};
function setupMicButton(btnId, target){
  const btn = $('#'+btnId); if(!btn) return;
  if(!SR_API){ btn.style.display='none'; return; }
  btn.style.display='inline-block';
  btn.onclick = ()=>openVoicePanel(target);
}
function openVoicePanel(target){
  if(!SR_API){ toast('این مرورگر گفتار به نوشتار را پشتیبانی نمی‌کند (Chrome را امتحان کنید)'); return; }
  vp.target = target; vp.quickFails = 0;
  const existing = ($(target==='chat' ? '#chatInput' : '#composerInput') || {}).value || '';   // keep what was already typed
  $('#modalRoot').innerHTML = `<div class="voice-backdrop"><div class="voicePanel">
    <h3>🎙️ گفتار به نوشتار</h3>
    <div class="vpStatus"><span class="vpDot" id="vpDot"></span><span id="vpStatusText"></span></div>
    <textarea id="vpText" placeholder="هر چه بگویید اینجا نوشته می‌شود. هر وقت خواستید متن را ویرایش کنید."></textarea>
    <div id="vpInterim" class="vpInterim"></div>
    <p class="err" id="vpErr"></p>
    <div class="vpBtns">
      <button type="button" id="vpToggle" class="vpMain" onclick="vpToggle()">⏹ قطع</button>
      <button type="button" onclick="vpSend()">ارسال</button>
      <button type="button" class="ghost" onclick="vpToComposer()">انتقال به کادر پیام</button>
      <button type="button" class="ghost" onclick="vpCancel()">انصراف</button>
    </div></div></div>`;
  $('#vpText').value = existing;
  vpStart();
}
function vpSetState(on){
  const dot=$('#vpDot'), txt=$('#vpStatusText'), tg=$('#vpToggle'); if(!dot) return;
  dot.classList.toggle('on', on);
  txt.textContent = on ? 'در حال گوش دادن… هر وقت تمام شد «قطع» را بزنید' : 'متوقف شد — می‌توانید متن را ویرایش کنید یا دوباره ادامه دهید';
  tg.textContent = on ? '⏹ قطع' : '🎙️ ادامه';
}
function vpShowErr(m){ const e=$('#vpErr'); if(e) e.textContent=m||''; }
function vpAppend(t){
  const ta=$('#vpText'); t=(t||'').trim(); if(!ta||!t) return;
  ta.value = ta.value && !/\s$/.test(ta.value) ? ta.value+' '+t : ta.value+t;
  ta.scrollTop = ta.scrollHeight;
}
function vpStart(){
  vpShowErr('');
  const rec = new SR_API();
  rec.lang = 'fa-IR'; rec.interimResults = true; rec.maxAlternatives = 1;
  rec.continuous = !IS_ANDROID;            // Chrome on Android duplicates text in continuous mode; there we restart after every phrase instead
  vp.rec = rec; vp.wantOn = true;
  rec.onstart = ()=>{ vp.lastStart = Date.now(); vp.gotResult = false; vpSetState(true); };
  rec.onresult = (ev)=>{
    let interim = '';
    for(let i=ev.resultIndex; i<ev.results.length; i++){
      const r = ev.results[i];
      if(r.isFinal){ vpAppend(r[0].transcript); vp.gotResult = true; vp.quickFails = 0; }
      else interim += r[0].transcript;
    }
    const el = $('#vpInterim'); if(el) el.textContent = interim;
  };
  rec.onerror = (ev)=>{
    const msg = VP_ERRORS[ev.error];
    if(msg){ vp.wantOn = false; vpShowErr(msg); vpSetState(false); }   // real problem: stop and explain
  };
  rec.onend = ()=>{
    const el = $('#vpInterim'); if(el) el.textContent = '';
    if(!vp.wantOn || vp.rec!==rec){ vpSetState(false); return; }
    // the browser ended the session by itself (a pause, or Android's one-phrase limit): keep listening
    const quick = Date.now()-vp.lastStart < 800 && !vp.gotResult;
    vp.quickFails = quick ? vp.quickFails+1 : 0;
    if(vp.quickFails >= 4){ vp.wantOn = false; vpShowErr('میکروفون یا سرویس تشخیص گفتار پاسخ نمی‌دهد. کمی بعد دوباره امتحان کنید.'); vpSetState(false); return; }
    setTimeout(()=>{ if(vp.wantOn && vp.rec===rec){ try{ rec.start(); }catch(e){} } }, 250);
  };
  try{ rec.start(); }catch(e){ vpShowErr('شروع میکروفون ممکن نشد. دوباره امتحان کنید.'); vpSetState(false); }
}
function vpStop(hard){
  vp.wantOn = false;
  const r = vp.rec;
  try{ if(r) (hard ? r.abort() : r.stop()); }catch(e){}
}
function vpToggle(){ if(vp.wantOn) vpStop(false); else vpStart(); }
function vpCancel(){ vpStop(true); vp.rec=null; closeModal(); }
function vpFinish(){
  const text = ($('#vpText').value||'').trim();
  vpStop(true); vp.rec = null; closeModal();
  return text;
}
function vpToComposer(){
  const text = vpFinish();
  const el = $(vp.target==='chat' ? '#chatInput' : '#composerInput');
  if(el){ el.value = text; el.focus(); }
}
async function vpSend(){
  const text = ($('#vpText').value||'').trim();
  if(!text){ vpShowErr('متنی برای ارسال نیست'); return; }
  vpFinish();
  const el = $(vp.target==='chat' ? '#chatInput' : '#composerInput');
  if(!el) return;
  el.value = text;
  if(vp.target==='chat') sendChat(); else sendMsg();
}

// ---------------- text-to-speech (🔊) ----------------
function speakMsgById(id){
  const m = messages.find(x=>x.id===id) || convMsgs.find(x=>x.id===id);
  if(m) speakText(m.text);
}
function getVoicesAsync(){
  return new Promise(resolve=>{
    const synth = window.speechSynthesis;
    const v = synth.getVoices();
    if(v.length) return resolve(v);
    const timer = setTimeout(()=>resolve(synth.getVoices()), 800);
    synth.onvoiceschanged = ()=>{ clearTimeout(timer); resolve(synth.getVoices()); };
  });
}
// long texts are read in short pieces: Chrome silently stops long utterances
function speechChunks(text){
  const parts = text.replace(/\s+/g,' ').split(/(?<=[.!؟?،؛:\n])\s*/).filter(Boolean);
  const out = []; let cur = '';
  parts.forEach(p=>{
    if((cur+' '+p).length > 170 && cur){ out.push(cur); cur = p; } else cur = cur ? cur+' '+p : p;
  });
  if(cur) out.push(cur);
  return out.flatMap(c=> c.length>220 ? c.match(/.{1,200}(\s|$)/g) : [c]);
}
let ttsCurrent = '';
async function speakText(text){
  const synth = window.speechSynthesis;
  if(!synth || !text) return;
  if((synth.speaking || synth.pending) && ttsCurrent===text){ synth.cancel(); ttsCurrent=''; return; }   // tap again = stop
  synth.cancel(); ttsCurrent = text;
  const voices = await getVoicesAsync();
  const fa = voices.find(v=>v.lang && /^fa/i.test(v.lang.replace('_','-'))) || voices.find(v=>/persian|farsi|فارسی/i.test(v.name||''));
  let started = false;
  const chunks = speechChunks(text);
  setTimeout(()=>{                                   // a short pause after cancel() — Chrome sometimes drops speak() called immediately after it
    chunks.forEach((c, i)=>{
      const u = new SpeechSynthesisUtterance(c);
      u.lang = fa ? fa.lang : 'fa-IR';
      if(fa) u.voice = fa;
      u.onstart = ()=>{ started = true; };
      u.onerror = (ev)=>{ if(ev.error && ev.error!=='canceled' && ev.error!=='interrupted') toast('🔊 خواندن ممکن نشد ('+ev.error+')'); };
      if(i===chunks.length-1) u.onend = ()=>{ ttsCurrent=''; };
      synth.speak(u);
    });
  }, 150);
  setTimeout(()=>{ if(!started && !fa) toast('🔊 صدای فارسی روی این دستگاه پیدا نشد، پس خواندن متن فارسی ممکن نیست.'); }, 2500);
}

// ---------------- profile ----------------
function openProfile(){
  openModal(`<h3>پروفایل من</h3>
    <div class="profileForm">
      <p class="mutedNote">نام مستعار (عمومی، بقیه این را می‌بینند)</p>
      <input id="pfName" value="${esc(me.displayName)}" placeholder="نام نمایشی">
      <p class="mutedNote">نام واقعی (فقط برای احراز هویت — تنها مدیر می‌بیند)</p>
      <input id="pfRealName" value="${esc(me.realName||'')}" placeholder="نام و نام خانوادگی واقعی">
      <input id="pfPhone" value="${esc(me.phone||'')}" placeholder="شماره موبایل">
      <input id="pfEmail" value="${esc(me.email||'')}" placeholder="ایمیل (برای بازیابی رمز عبور)">
      <p class="mutedNote">درباره‌ی من (تحصیلات، تجربه، مهارت — برای بقیه اعضا قابل مشاهده است)</p>
      <input id="pfEducation" value="${esc(me.bio?.education||'')}" placeholder="تحصیلات">
      <textarea id="pfExperience" placeholder="تجربه‌ها" style="min-height:50px">${esc(me.bio?.experience||'')}</textarea>
      <input id="pfSkills" value="${esc(me.bio?.skills||'')}" placeholder="مهارت‌ها">
      <hr style="border-color:var(--line)">
      <p class="mutedNote">برای تغییر رمز عبور (اختیاری):</p>
      <input id="pfCurPass" type="password" placeholder="رمز عبور فعلی">
      <input id="pfNewPass" type="password" placeholder="رمز عبور جدید">
      <input id="pfNewPass2" type="password" placeholder="تکرار رمز عبور جدید">
      <p class="err" id="pfErr"></p>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">انصراف</button><button onclick="saveProfile()">ذخیره</button></div>`);
}
async function saveProfile(){
  const body = {
    displayName: $('#pfName').value, phone: $('#pfPhone').value, email: $('#pfEmail').value,
    realName: $('#pfRealName').value, education: $('#pfEducation').value, experience: $('#pfExperience').value, skills: $('#pfSkills').value
  };
  const np = $('#pfNewPass').value;
  if(np){ body.currentPassword = $('#pfCurPass').value; body.newPassword = np; body.confirmPassword = $('#pfNewPass2').value; }
  try{
    const { user } = await api('/api/me', { method:'PATCH', body });
    me = { ...me, ...user };
    $('#whoami').textContent = `${me.displayName} (${roleLabel(me.role)})`;
    closeModal();
  }catch(e){ $('#pfErr').textContent = e.message; }
}

// ---------------- cross-post links ----------------
function shareMsgLink(id){
  const url = `${location.origin}${location.pathname}?topic=${currentTopic}&msg=${id}`;
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(()=>toast('🔗 لینک این پیام کپی شد')).catch(()=>toast(url));
  else toast(url);
}
async function jumpToMsgFromUrl(){
  const p = new URLSearchParams(location.search);
  let topicId = p.get('topic'); const msgId = p.get('msg');
  if(!msgId) return;
  if(!topicId){
    try{ const { message } = await api(`/api/messages/${msgId}`); topicId = message.topicId; }catch(e){ return; }
  }
  await selectTopic(topicId);
  setTimeout(()=>{
    const el = document.getElementById('m_'+msgId);
    if(el){ if(el.scrollIntoView) el.scrollIntoView({behavior:'smooth', block:'center'}); el.classList.add('highlight'); setTimeout(()=>el.classList.remove('highlight'), 2500); }
  }, 300);
}

// ---------------- online list ----------------
function renderOnline(){
  const items = Object.entries(onlineMap).map(([id,u])=>{
    const click = (me && id!==me.id) ? ` onclick="startDm('${id}')" style="cursor:pointer" title="شروع گفتگوی خصوصی"` : '';
    return `<div${click}><span class="dot ${u.offline?'off':''}"></span>${esc(u.displayName)}${u.offline?` — آخرین بازدید ${fmtTime(u.lastSeen)}`:''}</div>`;
  });
  $('#onlineList').innerHTML = items.join('') || '<div style="font-size:0.75rem;color:var(--muted)">کسی آنلاین نیست</div>';
}

// ---------------- modal helper ----------------
function openModal(html){ $('#modalRoot').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`; }
function closeModal(){ $('#modalRoot').innerHTML=''; }

// ---------------- admin panel ----------------
$('#adminBtn').onclick = async ()=>{
  const { users } = await api('/api/users');
  openModal(`<h3>مدیریت اعضا</h3>${me.isOwner?`<div class="adminTools"><button class="ghost" onclick="openInbox()">📨 صندوق پیام‌ها${pendingMsgs?` <span class="badge">${pendingMsgs}</span>`:''}</button><button class="ghost" onclick="openSettings()">⚙️ تنظیمات سایت</button></div>`:''}${users.map(u=>`
    <div class="userRow" style="flex-wrap:wrap">
      <span>${esc(u.displayName)} (${esc(u.username)})${u.realName?` — نام واقعی: ${esc(u.realName)}`:''}${u.phone?` — ${esc(u.phone)}`:''}</span>
      <span style="display:flex;gap:6px;align-items:center">
        <select onchange="setRole('${u.id}', this.value)" ${u.id===me.id?'disabled':''}>
          ${['admin','member','pending','blocked'].map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${roleLabel(r)}</option>`).join('')}
        </select>
        <span class="iconbtn" style="cursor:pointer;font-size:0.6875rem" onclick="adminSetPassword('${u.id}','${esc(u.displayName)}')">تعیین رمز جدید</span>
      </span>
    </div>`).join('')}<div style="margin-top:12px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
async function setRole(id, role){ await api(`/api/users/${id}/role`, { method:'POST', body:{ role } }); $('#adminBtn').click(); }
async function adminSetPassword(id, name){
  const np = prompt(`رمز عبور جدید برای ${name}:`); if(!np) return;
  try{ await api(`/api/users/${id}/set-password`, { method:'POST', body:{ newPassword: np } }); alert('رمز جدید تنظیم شد. آن را به کاربر اطلاع دهید.'); }
  catch(e){ alert(e.message); }
}
function openSettings(){
  if(!me.isOwner) return;
  const rm = settings.recoveryMethod || 'admin';
  const dis = emailAvailable ? '' : 'disabled';
  openModal(`<h3>⚙️ تنظیمات سایت</h3>
    <p class="mutedNote">روش بازیابی رمز عبور (وقتی کاربر رمزش را فراموش می‌کند):</p>
    <select onchange="saveSetting('recoveryMethod',this.value)">
      <option value="admin" ${rm==='admin'?'selected':''}>فقط تماس با مدیر (تلفن + پیام داخل سایت)</option>
      <option value="email" ${rm==='email'?'selected':''} ${dis}>فقط ایمیل خودکار</option>
      <option value="both" ${rm==='both'?'selected':''} ${dis}>هر دو (ایمیل و تماس با مدیر)</option>
    </select>
    ${emailAvailable?'':'<p class="mutedNote">گزینه‌های ایمیل فعلاً غیرفعال‌اند چون ارسال ایمیل روی سرور راه‌اندازی نشده.</p>'}
    <p class="mutedNote" style="margin-top:14px">نحوه‌ی باز شدن تاپیک روی گوشی:</p>
    <select onchange="saveSetting('topicOpenMode',this.value)">
      <option value="scroll" ${settings.topicOpenMode!=='page'?'selected':''}>اسکرول خودکار به محتوا (پیشنهادی)</option>
      <option value="page" ${settings.topicOpenMode==='page'?'selected':''}>صفحه‌ی جدا با دکمه‌ی بازگشت</option>
    </select>
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="$('#adminBtn').click()">← مدیریت</button><button class="ghost" onclick="closeModal()">بستن</button></div>`);
}
async function openInbox(){
  if(!me.isOwner) return;
  let list = [];
  try{ const d = await api('/api/admin-messages'); list = d.messages; pendingMsgs = d.unhandled; refreshAdminBadge(); }catch(e){ alert(e.message); return; }
  openModal(`<h3>📨 صندوق پیام‌ها</h3>
    ${list.map(m=>`<div class="inboxItem ${m.handled?'done':''}">
      <div class="mutedNote"><b>${esc(m.name||m.username)}</b>${m.username?` (${esc(m.username)})`:''}${m.loggedIn?' ✔️ واردشده':''}${m.contact?` — ${esc(m.contact)}`:''} · ${fmtDate(m.time)} ${fmtTime(m.time)}</div>
      <div style="margin:6px 0;white-space:pre-wrap">${esc(m.text)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${m.userId?`<button class="iconbtn" onclick="adminSetPassword('${m.userId}','${esc(m.name||m.username).replace(/'/g,'&#39;')}')">🔑 تعیین رمز جدید</button>`:''}
        <button class="iconbtn" onclick="markMsgHandled('${m.id}',${!m.handled})">${m.handled?'↩︎ بازگردانی':'✓ رسیدگی شد'}</button>
        <button class="iconbtn" onclick="deleteAdminMsg('${m.id}')">🗑 حذف</button>
      </div></div>`).join('') || '<p class="mutedNote">پیامی نیست.</p>'}
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="$('#adminBtn').click()">← مدیریت</button><button class="ghost" onclick="closeModal()">بستن</button></div>`);
}
async function markMsgHandled(id, val){ await api(`/api/admin-messages/${id}/handled`, { method:'POST', body:{ handled: val } }).catch(e=>alert(e.message)); openInbox(); }
async function deleteAdminMsg(id){ if(!confirm('این پیام حذف شود؟')) return; await api(`/api/admin-messages/${id}`, { method:'DELETE' }).catch(e=>alert(e.message)); openInbox(); }
function updatePendingBadge(n){ if(typeof n==='number') pendingMembers = n; refreshAdminBadge(); }
function refreshAdminBadge(){
  const btn = $('#adminBtn'); if(!btn) return;
  const existing = btn.querySelector('.badge'); if(existing) existing.remove();
  const t = pendingMembers + pendingMsgs;
  if(t>0) btn.insertAdjacentHTML('beforeend', ` <span class="badge">${t}</span>`);
}

// ---------------- private conversations (inline in the main area) ----------------
function toast(t){
  let el = $('#toast'); if(!el){ el = document.createElement('div'); el.id='toast'; document.body.appendChild(el); }
  el.textContent = t; el.style.opacity = '1';
  clearTimeout(toast._t); toast._t = setTimeout(()=>{ el.style.opacity='0'; }, 4000);
}
function convName(c){
  if(c.type==='dm'){ const o = c.members.find(m=>m.id!==me.id) || c.members[0]; return o ? o.displayName : 'گفتگو'; }
  return c.title || 'گروه';
}
async function loadConvs(){
  try{ convs = (await api('/api/convs')).conversations; }catch(e){ convs = []; }
  if(me && me.isOwner){ try{ allConvs = (await api('/api/convs/all')).conversations; }catch(e){ allConvs = []; } }
  renderConvLists();
}
function convItemHtml(c, all){
  const n = unread[c.id] || 0;
  const label = all ? c.members.map(m=>esc(m.displayName)).join(' ↔ ') : esc(convName(c));
  const active = currentConv===c.id && convReadOnly===!!all;
  return `<div class="topic ${active?'active':''}" onclick="openConv('${c.id}',${all?'true':'false'})">${c.type==='group'?'👥 ':'💬 '}${label}${n?` <span class="badge">${n}</span>`:''}</div>`;
}
function renderConvLists(){
  const el = $('#convList'); if(!el) return;
  el.innerHTML = convs.map(c=>convItemHtml(c,false)).join('') || '<p class="mutedNote">هنوز گفتگویی ندارید.</p>';
  const box = $('#allConvsBox');
  if(me && me.isOwner){
    box.style.display = 'block';
    $('#allConvList').innerHTML = allConvs.map(c=>convItemHtml(c,true)).join('') || '<p class="mutedNote">گفتگویی نیست.</p>';
  } else box.style.display = 'none';
}
async function openConv(id, all){
  clearSearch();
  currentConv = id; convReadOnly = !!all; currentTopic = null; replyTo = null; unread[id] = 0;
  mobileView='content'; applyViewMode();
  renderTopics(); renderConvLists();
  try{ convMsgs = (await api(`/api/convs/${id}/messages${all?'?all=1':''}`)).messages; }catch(e){ alert(e.message); return; }
  renderChat();
  if(isNarrow()) revealMain(); else window.scrollTo(0, document.body.scrollHeight);
}
function chatRowHtml(m){
  const mine = m.from===me.id;
  const canSpeak = !!(window.speechSynthesis && m.text);
  return `<div class="msg ${mine?'mine':''}">
    <div class="meta">${avatar(m.fromName)}<b>${esc(m.fromName)}</b> <span>${fmtTime(m.time)}</span>${m.edited?'<span class="editedTag">(ویرایش‌شده)</span>':''}</div>
    ${m.text?`<div>${esc(m.text)}</div>`:''}
    ${attachHtml(m.attachment)}
    <div class="actions">
      ${(mine && !convReadOnly)?`<span onclick="editMsg('${m.id}','chat')">✏️ ویرایش</span><span onclick="delChatMsg('${m.id}')">حذف</span>`:''}
      ${canSpeak?`<span onclick="speakMsgById('${m.id}')">🔊 خواندن</span>`:''}
    </div>
  </div>`;
}
function renderChat(){
  if(searchQuery) return;
  const c = (convReadOnly ? allConvs : convs).find(x=>x.id===currentConv);
  if(!c){ $('#mainArea').innerHTML = ''; return; }
  const prev = $('#chatInput') ? $('#chatInput').value : '';
  const names = c.members.map(m=>esc(m.displayName)).join('، ');
  let html = backBtnHtml() + `<h2>${c.type==='group'?'👥':'💬'} ${convReadOnly ? names : esc(convName(c))}</h2>`;
  if(c.type==='group') html += `<p class="mutedNote">اعضا: ${names}</p>`;
  if(convReadOnly) html += `<p class="mutedNote">حالت نظارت مدیر اصلی — فقط خواندنی</p>`;
  html += `<div id="chatList">${convMsgs.map(chatRowHtml).join('') || '<p style="color:var(--muted)">هنوز پیامی نیست.</p>'}</div>`;
  if(!convReadOnly){
    html += `<div class="composerRow">
      <div class="composer">
        <textarea id="chatInput" placeholder="پیام خود را بنویسید... (Enter = ارسال)" onkeydown="chatKey(event)"></textarea>
        <div class="composerTools">
          <label class="iconbtn" style="cursor:pointer" title="پیوست عکس یا صدا">📷🎤<input type="file" id="chatAttachInput" accept="image/*,audio/*" style="display:none"></label>
          <button type="button" class="iconbtn" id="chatMicBtn" style="display:none" title="گفتار به نوشتار">🎙️</button>
          <button onclick="sendChat()">ارسال</button>
        </div>
      </div>
      <div id="chatAttachPreviewBox"></div>
    </div>
      <p style="margin-top:12px"><button class="ghost" onclick="clearConv()">حذف این گفتگو از لیست من</button></p>`;
  }
  $('#mainArea').innerHTML = html;
  if($('#chatInput')) $('#chatInput').value = prev;
  const attInput = $('#chatAttachInput');
  if(attInput) attInput.onchange = (e)=>stageAttachment(e, 'chat');
  renderAttachPreview();
  setupMicButton('chatMicBtn','chat');
}
function chatKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } }
async function sendChat(){
  const el = $('#chatInput'); if(!el) return;
  const v = el.value.trim();
  if(!v && !pendingChatAtt) return;
  const body = { text: v };
  if(pendingChatAtt) body.attachmentId = pendingChatAtt.id;
  el.value = '';
  try{
    await api(`/api/convs/${currentConv}/messages`, { method:'POST', body });
    pendingChatAtt = null; renderAttachPreview();
  }
  catch(e){ el.value = v; alert(e.message); }
}
async function delChatMsg(id){ if(confirm('این پیام برای همیشه حذف شود؟')) await api(`/api/chatmsg/${id}`, { method:'DELETE' }).catch(e=>alert(e.message)); }
async function clearConv(){
  if(!confirm('این گفتگو از لیست شما پاک شود؟ پیام‌های قبلی دیگر برای شما نمایش داده نمی‌شوند (برای مدیر اصلی سایت همچنان قابل مشاهده‌اند).')) return;
  await api(`/api/convs/${currentConv}/clear`, { method:'POST' }).catch(e=>alert(e.message));
  currentConv = null; await loadConvs();
  if(topics[0]) selectTopic(topics[0].id); else $('#mainArea').innerHTML = '';
}
async function openNewConv(){
  if(!canWrite()){ alert('برای شروع گفتگو باید حساب شما توسط مدیر تایید شود.'); return; }
  const { users } = await api('/api/members').catch(()=>({users:[]}));
  const list = users.filter(u=>u.id!==me.id);
  openModal(`<h3>گفتگوی جدید</h3>
    <p class="mutedNote">یک نفر انتخاب کنید = گفتگوی دونفره، چند نفر = گروه</p>
    <div>${list.map(u=>`<label class="userRow" style="cursor:pointer"><span><span class="dot ${(onlineMap[u.id] && !onlineMap[u.id].offline)?'':'off'}"></span> ${esc(u.displayName)}</span><input type="checkbox" class="convPick" value="${u.id}" style="width:auto"></label>`).join('') || '<p class="mutedNote">کاربر دیگری یافت نشد</p>'}</div>
    <input id="convTitle" placeholder="نام گروه (اختیاری)" style="margin-top:10px">
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">بستن</button><button onclick="createConv()">شروع گفتگو</button></div>`);
}
async function createConv(){
  const ids = [...document.querySelectorAll('.convPick:checked')].map(x=>x.value);
  if(!ids.length){ alert('حداقل یک نفر را انتخاب کنید'); return; }
  try{
    const { conversation } = await api('/api/convs', { method:'POST', body:{ memberIds: ids, title: $('#convTitle').value } });
    closeModal(); await loadConvs(); openConv(conversation.id, false);
  }catch(e){ alert(e.message); }
}
async function startDm(userId){
  if(!me || userId===me.id) return;
  if(!canWrite()){ alert('برای شروع گفتگو باید حساب شما توسط مدیر تایید شود.'); return; }
  try{
    const { conversation } = await api('/api/convs', { method:'POST', body:{ memberIds:[userId] } });
    await loadConvs(); openConv(conversation.id, false);
  }catch(e){ alert(e.message); }
}
$('#dmBtn').onclick = openNewConv;
$('#newConvBtn').onclick = openNewConv;

// ---------------- theme (day/night + color palette) ----------------
const PALETTES = [
  {n:'آبی',     l:{bg:'#eaf2fb',card:'#ffffff',accent:'#2f6ea8'}, d:{bg:'#0f1722',card:'#182231',accent:'#5aa0e0'}},
  {n:'بیابان', l:{bg:'#f4e6d4',card:'#fff8ee',accent:'#c17a3a'}, d:{bg:'#1b140e',card:'#2a2018',accent:'#d9944f'}},
  {n:'سبز',     l:{bg:'#eaf6ee',card:'#ffffff',accent:'#2f8a55'}, d:{bg:'#0f1a13',card:'#17251c',accent:'#5cc487'}},
  {n:'بنفش',    l:{bg:'#f4ecfa',card:'#ffffff',accent:'#8a2f8a'}, d:{bg:'#1a1220',card:'#251a2d',accent:'#c76fc7'}},
  {n:'کرم',     l:{bg:'#fbf1dc',card:'#fffdf8',accent:'#b8860b'}, d:{bg:'#1c1710',card:'#292216',accent:'#e0b04a'}},
  {n:'خاکستری', l:{bg:'#ececec',card:'#ffffff',accent:'#444444'}, d:{bg:'#111111',card:'#1c1c1c',accent:'#bbbbbb'}}
];
function currentMode(){
  const m = localStorage.getItem('themeMode');
  if(m==='light' || m==='dark') return m;
  return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(){
  const mode = currentMode();
  const pal = PALETTES[parseInt(localStorage.getItem('themePalette')||'0',10)] || PALETTES[0];
  const c = mode==='dark' ? pal.d : pal.l;
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.style.setProperty('--bg', c.bg);
  root.style.setProperty('--card', c.card);
  root.style.setProperty('--accent', c.accent);
  const rgb=[1,3,5].map(i=>parseInt(c.accent.slice(i,i+2),16));
  root.style.setProperty('--on-accent', (0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2])>150 ? '#1a120b' : '#ffffff');
  const btn = $('#themeToggleBtn');
  if(btn) btn.textContent = mode==='dark' ? '☀️ حالت روز' : '🌙 حالت شب';
}
const FONT_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75];
function fontIndex(){ const i = parseInt(localStorage.getItem('fontStep'),10); return Number.isInteger(i) && i>=0 && i<FONT_STEPS.length ? i : 1; }
function applyFont(){
  document.documentElement.style.fontSize = (16*FONT_STEPS[fontIndex()])+'px';
  document.querySelectorAll('[data-font]').forEach(b=>{
    const d = parseInt(b.dataset.font,10), i = fontIndex();
    b.disabled = (d<0 && i===0) || (d>0 && i===FONT_STEPS.length-1);
  });
}
function changeFont(d){
  const i = Math.min(FONT_STEPS.length-1, Math.max(0, fontIndex()+d));
  localStorage.setItem('fontStep', String(i)); applyFont();
  try{ toast(`اندازه‌ی نوشته‌ها: ${Math.round(FONT_STEPS[i]*100)}٪`); }catch(e){}
}
document.querySelectorAll('[data-font]').forEach(b=>b.onclick=()=>changeFont(parseInt(b.dataset.font,10)));
applyFont();
applyTheme();
$('#themeToggleBtn').onclick = ()=>{
  localStorage.setItem('themeMode', currentMode()==='dark' ? 'light' : 'dark');
  applyTheme();
};
$('#themeColorBtn').onclick = ()=>{
  const mode = currentMode();
  const sel = parseInt(localStorage.getItem('themePalette')||'0',10);
  openModal(`<h3>رنگ و پس‌زمینه</h3>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      ${PALETTES.map((p,i)=>{ const c = mode==='dark'?p.d:p.l; return `<div onclick="setPalette(${i})" style="cursor:pointer;text-align:center;font-size:0.75rem">
        <div style="height:44px;border-radius:10px;background:${c.bg};border:3px solid ${i===sel?c.accent:'var(--line)'};display:flex;align-items:center;justify-content:center"><span style="width:18px;height:18px;border-radius:50%;background:${c.accent}"></span></div>${p.n}</div>`; }).join('')}
    </div>
    <div style="text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
function setPalette(i){ localStorage.setItem('themePalette', String(i)); applyTheme(); closeModal(); }
