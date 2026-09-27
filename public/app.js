let me = null;
let topics = [];
let currentTopic = null;
let messages = [];
let replyTo = null;
let onlineMap = {};
let socket = null;

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
  try{
    const { user } = await api('/api/auth/register', { method:'POST', body:{ username: $('#regUsername').value, password: $('#regPassword').value, displayName: $('#regDisplayName').value }});
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
  socket.on('newDM', m=>{ if(window.__dmWith && (m.from===window.__dmWith || m.to===window.__dmWith)) appendDmMsg(m); });
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
  currentTopic = id; renderTopics(); replyTo=null;
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
  const items = Object.entries(onlineMap).map(([id,u])=>`<div><span class="dot ${u.offline?'off':''}"></span>${esc(u.displayName)}${u.offline?` — آخرین بازدید ${fmtTime(u.lastSeen)}`:''}</div>`);
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

// ---------------- direct messages ----------------
$('#dmBtn').onclick = async ()=>{
  const { users } = await api('/api/users').catch(()=>({users:[]}));
  let list = users;
  if(!users.length){
    // non-admins can't list all users via /api/users; fall back to online users
    list = Object.entries(onlineMap).map(([id,u])=>({id, displayName:u.displayName}));
  }
  openModal(`<h3>پیام خصوصی</h3>
    <div>${list.filter(u=>u.id!==me.id).map(u=>`<div class="userRow" style="cursor:pointer" onclick="openDm('${u.id}','${esc(u.displayName)}')">${esc(u.displayName)}</div>`).join('') || '<p style="font-size:12px;color:var(--muted)">کاربر دیگری یافت نشد</p>'}</div>
    <div style="margin-top:12px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
async function openDm(userId, name){
  window.__dmWith = userId;
  const { messages: dms } = await api(`/api/dms/${userId}`);
  openModal(`<h3>گفتگو با ${esc(name)}</h3>
    <div class="dmList" id="dmList">${dms.map(dmRowHtml).join('')}</div>
    <div class="composer"><textarea id="dmInput" placeholder="پیام..."></textarea><button onclick="sendDm('${userId}')">ارسال</button></div>
    <div style="margin-top:10px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
  $('#dmList').scrollTop = $('#dmList').scrollHeight;
}
function dmRowHtml(m){ return `<div class="dmMsg"><b>${esc(m.fromName||(m.from===me.id?me.displayName:''))}</b>: ${esc(m.text)} <span style="color:var(--muted);font-size:10px">${fmtTime(m.time)}</span></div>`; }
async function sendDm(userId){
  const el = $('#dmInput'); const val = el.value.trim(); if(!val) return;
  await api(`/api/dms/${userId}`, { method:'POST', body:{ text: val } });
  el.value='';
}
function appendDmMsg(m){
  const list = $('#dmList'); if(!list) return;
  list.insertAdjacentHTML('beforeend', dmRowHtml(m));
  list.scrollTop = list.scrollHeight;
}
