let me = null;
let topics = [];
let currentTopic = null;
let messages = [];
let replyTo = null;
let onlineMap = {};
let socket = null;
let convs = [], allConvs = [], currentConv = null, convReadOnly = false, convMsgs = [];
const unread = {};

const $ = (sel) => document.querySelector(sel);
function esc(s){ const d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }
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
    const { user } = await api('/api/auth/register', { method:'POST', body:{ username: $('#regUsername').value, password, confirmPassword, phone, displayName: $('#regDisplayName').value }});
    startApp(user);
  }catch(err){ $('#regErr').textContent = err.message; }
};
$('#logoutBtn').onclick = async ()=>{ await api('/api/auth/logout', {method:'POST'}); location.reload(); };

// ---------------- bootstrap ----------------
(async function init(){
  const { user } = await api('/api/me');
  if(user) startApp(user); else { $('#authScreen').style.display='flex'; }
})();

function startApp(user){
  me = user;
  $('#authScreen').style.display='none';
  $('#appScreen').style.display='block';
  $('#whoami').textContent = `${me.displayName} (${roleLabel(me.role)})`;
  if(me.role==='admin'){ $('#newTopicBtn').style.display='inline-block'; $('#adminBtn').style.display='inline-block'; }
  connectSocket();
  loadTopics();
  loadConvs();
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
  socket.on('userUpdated', u=>{ if(u.id===me.id){ me=u; $('#whoami').textContent = `${me.displayName} (${roleLabel(me.role)})`; renderMain(); } });
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
}

// ---------------- topics ----------------
async function loadTopics(){
  const { topics: t } = await api('/api/topics');
  topics = t;
  renderTopics();
  if(topics[0]) selectTopic(topics[0].id);
}
function renderTopics(){
  $('#topicList').innerHTML = topics.map(t=>`<div class="topic ${t.id===currentTopic?'active':''}" data-id="${t.id}">${esc(t.title)}${t.pdfFile?' 📎':''}</div>`).join('') || '<p style="font-size:12px;color:var(--muted)">هنوز اتاقی نیست.</p>';
  document.querySelectorAll('.topic').forEach(el=>el.onclick=()=>selectTopic(el.dataset.id));
}
async function selectTopic(id){
  currentTopic = id; currentConv = null; convReadOnly = false; renderTopics(); renderConvLists(); replyTo=null;
  const { messages: m } = await api(`/api/topics/${id}/messages`);
  messages = m; renderMain();
}
$('#newTopicBtn').onclick = async ()=>{
  const title = prompt('عنوان تاپیک جدید:'); if(!title) return;
  const { topic } = await api('/api/topics', { method:'POST', body:{ title } });
  selectTopic(topic.id);
};

// ---------------- messages ----------------
function renderMain(filter){
  if(currentConv){ renderChat(); return; }
  const t = topics.find(x=>x.id===currentTopic);
  if(!t){ $('#mainArea').innerHTML=''; return; }
  let list = filter ? messages.filter(m=>m.text.includes(filter)) : messages;
  list = [...list].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || a.time-b.time);
  let html = `<h2>${esc(t.title)}</h2>`;
  if(t.pdfFile) html += `<p><a href="/uploads/${t.pdfFile}" target="_blank">📎 ${esc(t.pdfName||'فایل PDF')}</a></p>`;
  if(me.role==='admin') html += `<p><input type="file" id="pdfInput" accept="application/pdf" style="font-size:12px"></p>`;
  html += list.map(m=>{
    const ref = m.replyTo ? messages.find(x=>x.id===m.replyTo) : null;
    return `<div class="msg ${m.pinned?'pinned':''}">
      <div class="meta"><b>${esc(m.authorName)}</b> ${m.pinned?'<span class="badge">پین‌شده</span>':''} <span>${fmtTime(m.time)}</span></div>
      ${ref?`<div class="reply-ref">در پاسخ به ${esc(ref.authorName)}: ${esc(ref.text.slice(0,60))}</div>`:''}
      <div>${esc(m.text)}</div>
      <div class="actions">
        <span onclick="react('${m.id}','likes')">👍 ${m.likes||0}</span>
        <span onclick="react('${m.id}','dislikes')">👎 ${m.dislikes||0}</span>
        <span onclick="react('${m.id}','thanks')">🙏 ${m.thanks||0}</span>
        ${canWrite()?`<span onclick="setReply('${m.id}')">پاسخ</span>`:''}
        ${(me.role==='admin'||m.userId===me.id)?`<span onclick="delMsg('${m.id}')">حذف</span>`:''}
        ${me.role==='admin'?`<span onclick="togglePin('${m.id}',${!m.pinned})">${m.pinned?'برداشتن پین':'پین کردن'}</span>`:''}
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--muted)">پیامی نیست.</p>';

  if(canWrite()){
    html += `<div style="display:${replyTo?'block':'none'};font-size:12px;color:var(--muted)">در حال پاسخ <span onclick="clearReply()" style="cursor:pointer;color:var(--accent)">✕ لغو</span></div>
    <div class="composer"><textarea id="composerInput" placeholder="پیام خود را بنویسید..."></textarea><button onclick="sendMsg()">ارسال</button></div>`;
  } else {
    html += `<div class="locked">${me.role==='pending' ? 'حساب شما هنوز توسط مدیر تایید نشده — فقط امکان مشاهده دارید.' : 'دسترسی نوشتن ندارید.'}</div>`;
  }
  $('#mainArea').innerHTML = html;
  const pdfInput = $('#pdfInput');
  if(pdfInput) pdfInput.onchange = uploadPdf;
}
function setReply(id){ replyTo=id; renderMain(); }
function clearReply(){ replyTo=null; renderMain(); }
async function sendMsg(){
  const el = $('#composerInput'); const val = el.value.trim(); if(!val) return;
  await api(`/api/topics/${currentTopic}/messages`, { method:'POST', body:{ text: val, replyTo } });
  replyTo=null; el.value='';
}
async function react(id, kind){ await api(`/api/messages/${id}/react`, { method:'POST', body:{ kind } }); }
async function togglePin(id, val){ await api(`/api/messages/${id}/pin`, { method:'POST', body:{ pinned: val } }); }
async function delMsg(id){ if(confirm('حذف شود؟')) await api(`/api/messages/${id}`, { method:'DELETE' }); }
async function uploadPdf(e){
  const file = e.target.files[0]; if(!file) return;
  const fd = new FormData(); fd.append('pdf', file);
  await fetch(`/api/topics/${currentTopic}/pdf`, { method:'POST', body: fd });
}
$('#searchBox').oninput = e=> renderMain(e.target.value.trim());

// ---------------- online list ----------------
function renderOnline(){
  const items = Object.entries(onlineMap).map(([id,u])=>{
    const click = (me && id!==me.id) ? ` onclick="startDm('${id}')" style="cursor:pointer" title="شروع گفتگوی خصوصی"` : '';
    return `<div${click}><span class="dot ${u.offline?'off':''}"></span>${esc(u.displayName)}${u.offline?` — آخرین بازدید ${fmtTime(u.lastSeen)}`:''}</div>`;
  });
  $('#onlineList').innerHTML = items.join('') || '<div style="font-size:12px;color:var(--muted)">کسی آنلاین نیست</div>';
}

// ---------------- modal helper ----------------
function openModal(html){ $('#modalRoot').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`; }
function closeModal(){ $('#modalRoot').innerHTML=''; }

// ---------------- admin panel ----------------
$('#adminBtn').onclick = async ()=>{
  const { users } = await api('/api/users');
  openModal(`<h3>مدیریت اعضا</h3>${users.map(u=>`
    <div class="userRow">
      <span>${esc(u.displayName)} (${esc(u.username)})</span>
      <select onchange="setRole('${u.id}', this.value)" ${u.id===me.id?'disabled':''}>
        ${['admin','member','pending','blocked'].map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${roleLabel(r)}</option>`).join('')}
      </select>
    </div>`).join('')}<div style="margin-top:12px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
async function setRole(id, role){ await api(`/api/users/${id}/role`, { method:'POST', body:{ role } }); $('#adminBtn').click(); }

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
  currentConv = id; convReadOnly = !!all; currentTopic = null; replyTo = null; unread[id] = 0;
  renderTopics(); renderConvLists();
  try{ convMsgs = (await api(`/api/convs/${id}/messages${all?'?all=1':''}`)).messages; }catch(e){ alert(e.message); return; }
  renderChat(); window.scrollTo(0, document.body.scrollHeight);
}
function chatRowHtml(m){
  const mine = m.from===me.id;
  return `<div class="msg ${mine?'mine':''}">
    <div class="meta"><b>${esc(m.fromName)}</b> <span>${fmtTime(m.time)}</span></div>
    <div>${esc(m.text)}</div>
    ${(mine && !convReadOnly)?`<div class="actions"><span onclick="delChatMsg('${m.id}')">حذف</span></div>`:''}
  </div>`;
}
function renderChat(){
  const c = (convReadOnly ? allConvs : convs).find(x=>x.id===currentConv);
  if(!c){ $('#mainArea').innerHTML = ''; return; }
  const prev = $('#chatInput') ? $('#chatInput').value : '';
  const names = c.members.map(m=>esc(m.displayName)).join('، ');
  let html = `<h2>${c.type==='group'?'👥':'💬'} ${convReadOnly ? names : esc(convName(c))}</h2>`;
  if(c.type==='group') html += `<p class="mutedNote">اعضا: ${names}</p>`;
  html += `<p class="mutedNote">🔒 مدیر اصلی سایت به همه‌ی گفتگوهای خصوصی دسترسی دارد.</p>`;
  if(convReadOnly) html += `<p class="mutedNote">حالت نظارت مدیر اصلی — فقط خواندنی</p>`;
  html += `<div id="chatList">${convMsgs.map(chatRowHtml).join('') || '<p style="color:var(--muted)">هنوز پیامی نیست.</p>'}</div>`;
  if(!convReadOnly){
    html += `<div class="composer"><textarea id="chatInput" placeholder="پیام خود را بنویسید... (Enter = ارسال)" onkeydown="chatKey(event)"></textarea><button onclick="sendChat()">ارسال</button></div>
      <p style="margin-top:12px"><button class="ghost" onclick="clearConv()">حذف این گفتگو از لیست من</button></p>`;
  }
  $('#mainArea').innerHTML = html;
  if($('#chatInput')) $('#chatInput').value = prev;
}
function chatKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } }
async function sendChat(){
  const el = $('#chatInput'); if(!el) return;
  const v = el.value.trim(); if(!v) return;
  el.value = '';
  try{ await api(`/api/convs/${currentConv}/messages`, { method:'POST', body:{ text: v } }); }
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
  {n:'پیش‌فرض', l:{bg:'#f7f6f3',card:'#ffffff',accent:'#a8562f'}, d:{bg:'#171512',card:'#221f1c',accent:'#d97a4d'}},
  {n:'آبی',     l:{bg:'#eaf2fb',card:'#ffffff',accent:'#2f6ea8'}, d:{bg:'#0f1722',card:'#182231',accent:'#5aa0e0'}},
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
  const btn = $('#themeToggleBtn');
  if(btn) btn.textContent = mode==='dark' ? '☀️ حالت روز' : '🌙 حالت شب';
}
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
      ${PALETTES.map((p,i)=>{ const c = mode==='dark'?p.d:p.l; return `<div onclick="setPalette(${i})" style="cursor:pointer;text-align:center;font-size:12px">
        <div style="height:44px;border-radius:10px;background:${c.bg};border:3px solid ${i===sel?c.accent:'var(--line)'};display:flex;align-items:center;justify-content:center"><span style="width:18px;height:18px;border-radius:50%;background:${c.accent}"></span></div>${p.n}</div>`; }).join('')}
    </div>
    <div style="text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
function setPalette(i){ localStorage.setItem('themePalette', String(i)); applyTheme(); closeModal(); }
