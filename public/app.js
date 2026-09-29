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
let recognizer = null, recognizerTarget = null;

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
async function adminContact(){
  try{ const { contact } = await api('/api/public/admin-contact'); return contact; }catch(e){ return null; }
}
function openForgot(){
  openModal(`<h3>فراموشی رمز عبور</h3>
    <p class="mutedNote">نام کاربری یا ایمیل خود را وارد کنید</p>
    <input id="forgotId" placeholder="نام کاربری یا ایمیل">
    <p class="err" id="forgotErr"></p>
    <p id="forgotMsg" class="mutedNote"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">بستن</button><button onclick="submitForgot()">ارسال درخواست</button></div>`);
}
async function submitForgot(){
  const id = $('#forgotId').value.trim(); if(!id){ $('#forgotErr').textContent='نام کاربری یا ایمیل را وارد کنید'; return; }
  try{
    const { message } = await api('/api/auth/forgot', { method:'POST', body:{ identifier: id } });
    $('#forgotErr').textContent='';
    $('#forgotMsg').textContent = message;
  }catch(e){ $('#forgotErr').textContent = e.message; }
}
async function openContactAdmin(){
  const c = await adminContact();
  openModal(`<h3>ارتباط با مدیر</h3>
    ${c ? `<p>می‌توانید برای کمک (مثلاً بازیابی رمز عبور) با مدیر سایت تماس بگیرید:</p><p style="font-size:18px;font-weight:bold;color:var(--accent)">${esc(c.displayName)} — ${esc(c.phone||'—')}</p>` : `<p class="mutedNote">اطلاعات تماس مدیر هنوز ثبت نشده.</p>`}
    <div style="text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
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
  if(me.role==='admin'){ $('#newTopicBtn').style.display='inline-block'; $('#newHallBtn').style.display='inline-block'; $('#adminBtn').style.display='inline-block'; api('/api/pending-count').then(d=>updatePendingBadge(d.count)).catch(()=>{}); }
  connectSocket();
  loadHalls();
  loadTopics().then(()=>jumpToMsgFromUrl());
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
  socket.on('notify', (n)=>{
    const icon = n.kind==='reply' ? '↩️' : (n.kind==='topic' ? '📌' : '💬');
    toast(`${icon} ${esc(n.from)} — ${esc(n.topicTitle||'')}${n.text?': '+esc(n.text):''}`);
  });
}

// ---------------- topics ----------------
async function loadTopics(){
  const { topics: t } = await api('/api/topics');
  topics = t;
  renderTopics();
  if(topics[0]) await selectTopic(topics[0].id);
}
function topicItemHtml(t){
  return `<div class="topic ${t.id===currentTopic?'active':''}" data-id="${t.id}">${esc(t.title)}${t.pdfFile?' 📎':''}</div>`;
}
function renderTopics(){
  const standalone = topics.filter(t=>!t.hallId);
  let html = standalone.map(topicItemHtml).join('');
  html += halls.map(h=>{
    const kids = topics.filter(t=>t.hallId===h.id);
    return `<div class="hallGroup">
      <div class="hallHead">📁 ${esc(h.title)}${me.role==='admin'?` <span class="iconbtn hsm" onclick="editHall('${h.id}')">✏️</span><span class="iconbtn hsm" onclick="newTopicIn('${h.id}')">＋</span>`:''}</div>
      <div class="hallKids">${kids.map(topicItemHtml).join('') || '<p class="mutedNote" style="margin:2px 10px">هنوز جلسه‌ای نیست.</p>'}</div>
    </div>`;
  }).join('');
  $('#topicList').innerHTML = html || '<p style="font-size:12px;color:var(--muted)">هنوز اتاقی نیست.</p>';
  document.querySelectorAll('.topic').forEach(el=>el.onclick=()=>selectTopic(el.dataset.id));
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
function attachHtml(a){
  if(!a) return '';
  if(a.kind==='image') return `<div class="attach"><img src="${a.url}" onclick="window.open('${a.url}','_blank')" alt="${esc(a.name||'')}"></div>`;
  return `<div class="attach"><audio controls src="${a.url}"></audio></div>`;
}
function msgRowHtml(m, ref, extraActions){
  const canSpeak = !!(window.speechSynthesis && m.text);
  return `<div class="msg ${m.pinned?'pinned':''}" id="m_${m.id}">
      <div class="meta">${avatar(m.authorName)}<b>${esc(m.authorName)}</b> ${m.pinned?'<span class="badge">پین‌شده</span>':''} <span>${fmtTime(m.time)}</span></div>
      ${ref?`<div class="reply-ref">در پاسخ به ${esc(ref.authorName)}: ${esc(ref.text.slice(0,60))}</div>`:''}
      ${m.text?`<div>${esc(m.text)}</div>`:''}
      ${attachHtml(m.attachment)}
      <div class="actions">
        <span onclick="react('${m.id}','likes')">👍 ${m.likes||0}</span>
        <span onclick="react('${m.id}','dislikes')">👎 ${m.dislikes||0}</span>
        <span onclick="react('${m.id}','thanks')">🙏 ${m.thanks||0}</span>
        ${canWrite()?`<span onclick="setReply('${m.id}')">پاسخ</span>`:''}
        ${(me.role==='admin'||m.userId===me.id)?`<span onclick="delMsg('${m.id}')">حذف</span>`:''}
        ${me.role==='admin'?`<span onclick="togglePin('${m.id}',${!m.pinned})">${m.pinned?'برداشتن پین':'پین کردن'}</span>`:''}
        <span onclick="shareMsgLink('${m.id}')">🔗 لینک</span>
        ${canSpeak?`<span onclick="speakText('${esc(m.text).replace(/'/g,"&#39;")}')">🔊 خواندن</span>`:''}
      </div>
    </div>`;
}
function renderMain(filter){
  if(currentConv){ renderChat(); return; }
  const t = topics.find(x=>x.id===currentTopic);
  if(!t){ $('#mainArea').innerHTML='<div class="welcome"><h2>🌵 به راه بادیه مجازی خوش آمدید</h2><p>فضایی برای گفتگو، تبادل نظر و اشتراک‌گذاری دانش<br>در مسیر بی‌انتهای بیابان اندیشه</p><p>یک تالار را انتخاب کنید یا از فهرست اعضای آنلاین، گفتگوی خصوصی شروع کنید.</p></div>'; return; }
  let list = filter ? messages.filter(m=>m.text.includes(filter)) : messages;
  list = [...list].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || a.time-b.time);
  let html = `<div class="topicHead"><h2>${esc(t.title)}</h2>${me.role==='admin'?`<button class="iconbtn" onclick="editTopic('${t.id}')">✏️ ویرایش تالار</button>`:''}</div>`;
  if(t.description) html += `<p class="mutedNote">${esc(t.description)}</p>`;
  if(t.pdfFile) html += `<p>📎 <a href="/uploads/${t.pdfFile}" target="_blank">${esc(t.pdfName||'فایل PDF')}</a>${me.role==='admin'?` <span class="iconbtn" style="cursor:pointer" onclick="deleteTopicPdf('${t.id}')">🗑 حذف فایل</span>`:''}</p>`;
  if(me.role==='admin') html += `<p><label class="iconbtn" style="cursor:pointer">📎 ${t.pdfFile?'جایگزینی فایل PDF':'بارگذاری فایل PDF'}<input type="file" id="pdfInput" accept="application/pdf" style="display:none"></label></p>`;
  html += `<div id="msgList">` + (list.map(m=>{
    const ref = m.replyTo ? messages.find(x=>x.id===m.replyTo) : null;
    return msgRowHtml(m, ref);
  }).join('') || '<p style="color:var(--muted)">پیامی نیست.</p>') + `</div>`;

  if(canWrite()){
    html += `<div style="display:${replyTo?'block':'none'};font-size:12px;color:var(--muted)">در حال پاسخ <span onclick="clearReply()" style="cursor:pointer;color:var(--accent)">✕ لغو</span></div>
    <div class="composerRow">
      <div class="composer">
        <textarea id="composerInput" placeholder="پیام خود را بنویسید..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg();}"></textarea>
        <div class="composerTools">
          <label class="iconbtn" style="cursor:pointer" title="پیوست عکس یا صدا">📷🎤<input type="file" id="msgAttachInput" accept="image/*,audio/*" style="display:none"></label>
          <button type="button" class="iconbtn" id="micBtn" onclick="toggleMic('composerInput')" style="display:none" title="گفتار به نوشتار">🎙️</button>
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
  setupMicButton('micBtn','composerInput');
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
async function react(id, kind){ await api(`/api/messages/${id}/react`, { method:'POST', body:{ kind } }); }
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
  openModal(`<h3>ویرایش تالار</h3>
    <input id="editTopicTitle" value="${esc(t.title)}" placeholder="عنوان">
    <textarea id="editTopicDesc" placeholder="توضیح کوتاه (اختیاری)" style="min-height:70px">${esc(t.description||'')}</textarea>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="ghost" onclick="closeModal()">انصراف</button><button onclick="saveTopicEdit('${id}')">ذخیره</button></div>`);
}
async function saveTopicEdit(id){
  try{
    await api(`/api/topics/${id}`, { method:'PATCH', body:{ title: $('#editTopicTitle').value, description: $('#editTopicDesc').value } });
    closeModal();
  }catch(e){ alert(e.message); }
}
$('#searchBox').oninput = e=> renderMain(e.target.value.trim());

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

// ---------------- voice typing (speech-to-text) + text-to-speech ----------------
function setupMicButton(btnId, targetId){
  const btn = $('#'+btnId); if(!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ btn.style.display='none'; return; }
  btn.style.display='inline-block';
  btn.onclick = ()=>toggleMic(targetId, btnId);
}
function toggleMic(targetId, btnId){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return;
  const btn = btnId ? $('#'+btnId) : null;
  if(recognizer && recognizerTarget===targetId){ recognizer.stop(); return; }
  if(recognizer) recognizer.stop();
  recognizer = new SR();
  recognizer.lang = 'fa-IR';
  recognizer.interimResults = false;
  recognizerTarget = targetId;
  if(btn) btn.classList.add('on');
  recognizer.onresult = (ev)=>{
    const text = Array.from(ev.results).map(r=>r[0].transcript).join(' ');
    const el = $('#'+targetId); if(el) el.value = (el.value ? el.value+' ' : '') + text;
  };
  recognizer.onend = ()=>{ if(btn) btn.classList.remove('on'); recognizer=null; };
  recognizer.onerror = ()=>{ if(btn) btn.classList.remove('on'); recognizer=null; };
  recognizer.start();
}
function getVoicesAsync(){
  return new Promise(resolve=>{
    let voices = window.speechSynthesis.getVoices();
    if(voices.length) return resolve(voices);
    const timer = setTimeout(()=>resolve(window.speechSynthesis.getVoices()), 600);
    window.speechSynthesis.onvoiceschanged = ()=>{ clearTimeout(timer); resolve(window.speechSynthesis.getVoices()); };
  });
}
async function speakText(text){
  if(!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = await getVoicesAsync();
  const fa = voices.find(v=>v.lang && v.lang.toLowerCase().startsWith('fa'));
  if(fa){ u.voice = fa; u.lang = fa.lang; }
  else { console.warn('هیچ صدای فارسی روی این مرورگر/سیستم نصب نیست؛ با صدای پیش‌فرض خوانده می‌شود.'); }
  window.speechSynthesis.speak(u);
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
  $('#onlineList').innerHTML = items.join('') || '<div style="font-size:12px;color:var(--muted)">کسی آنلاین نیست</div>';
}

// ---------------- modal helper ----------------
function openModal(html){ $('#modalRoot').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`; }
function closeModal(){ $('#modalRoot').innerHTML=''; }

// ---------------- admin panel ----------------
$('#adminBtn').onclick = async ()=>{
  const { users } = await api('/api/users');
  openModal(`<h3>مدیریت اعضا</h3>${users.map(u=>`
    <div class="userRow" style="flex-wrap:wrap">
      <span>${esc(u.displayName)} (${esc(u.username)})${u.realName?` — نام واقعی: ${esc(u.realName)}`:''}${u.phone?` — ${esc(u.phone)}`:''}</span>
      <span style="display:flex;gap:6px;align-items:center">
        <select onchange="setRole('${u.id}', this.value)" ${u.id===me.id?'disabled':''}>
          ${['admin','member','pending','blocked'].map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${roleLabel(r)}</option>`).join('')}
        </select>
        <span class="iconbtn" style="cursor:pointer;font-size:11px" onclick="adminSetPassword('${u.id}','${esc(u.displayName)}')">تعیین رمز جدید</span>
      </span>
    </div>`).join('')}<div style="margin-top:12px;text-align:left"><button class="ghost" onclick="closeModal()">بستن</button></div>`);
};
async function setRole(id, role){ await api(`/api/users/${id}/role`, { method:'POST', body:{ role } }); $('#adminBtn').click(); }
async function adminSetPassword(id, name){
  const np = prompt(`رمز عبور جدید برای ${name}:`); if(!np) return;
  try{ await api(`/api/users/${id}/set-password`, { method:'POST', body:{ newPassword: np } }); alert('رمز جدید تنظیم شد. آن را به کاربر اطلاع دهید.'); }
  catch(e){ alert(e.message); }
}
function updatePendingBadge(n){
  const btn = $('#adminBtn'); if(!btn) return;
  const existing = btn.querySelector('.badge'); if(existing) existing.remove();
  if(n>0) btn.insertAdjacentHTML('beforeend', ` <span class="badge">${n}</span>`);
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
  currentConv = id; convReadOnly = !!all; currentTopic = null; replyTo = null; unread[id] = 0;
  renderTopics(); renderConvLists();
  try{ convMsgs = (await api(`/api/convs/${id}/messages${all?'?all=1':''}`)).messages; }catch(e){ alert(e.message); return; }
  renderChat(); window.scrollTo(0, document.body.scrollHeight);
}
function chatRowHtml(m){
  const mine = m.from===me.id;
  const canSpeak = !!(window.speechSynthesis && m.text);
  return `<div class="msg ${mine?'mine':''}">
    <div class="meta">${avatar(m.fromName)}<b>${esc(m.fromName)}</b> <span>${fmtTime(m.time)}</span></div>
    ${m.text?`<div>${esc(m.text)}</div>`:''}
    ${attachHtml(m.attachment)}
    <div class="actions">
      ${(mine && !convReadOnly)?`<span onclick="delChatMsg('${m.id}')">حذف</span>`:''}
      ${canSpeak?`<span onclick="speakText('${esc(m.text).replace(/'/g,"&#39;")}')">🔊 خواندن</span>`:''}
    </div>
  </div>`;
}
function renderChat(){
  const c = (convReadOnly ? allConvs : convs).find(x=>x.id===currentConv);
  if(!c){ $('#mainArea').innerHTML = ''; return; }
  const prev = $('#chatInput') ? $('#chatInput').value : '';
  const names = c.members.map(m=>esc(m.displayName)).join('، ');
  let html = `<h2>${c.type==='group'?'👥':'💬'} ${convReadOnly ? names : esc(convName(c))}</h2>`;
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
  setupMicButton('chatMicBtn','chatInput');
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
