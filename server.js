const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const uploadsDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ---------- middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // share session with socket.io (socket.io >= 4.6)

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('فقط فایل PDF مجاز است'));
    cb(null, true);
  }
});

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.get('users').find({ id: req.session.userId }).value() || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'ابتدا وارد شوید' });
  req.user = u;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'دسترسی غیرمجاز' });
    next();
  };
}
function publicUser(u) {
  if (!u) return null;
  const first = db.get('users').first().value();
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, isOwner: !!first && first.id === u.id };
}
// the "main admin" is the first person who ever registered
function isOwnerUser(u) {
  const first = db.get('users').first().value();
  return !!u && !!first && first.id === u.id;
}

// ---------- auth ----------
// multer/busboy read non-ASCII filenames as latin1, which garbles Persian names
// (mojibake like "Ù\u0081Ø..."). Re-decode as UTF-8 when the text is clearly
// mis-decoded; leave already-correct names (or plain ASCII) untouched.
function fixFileName(name) {
  if (!name) return name;
  if (/[^\u0000-\u00ff]/.test(name)) return name;      // already real Unicode
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? name : decoded;
}
// repair names that were already saved garbled before this fix
db.get('topics').forEach(t => { if (t.pdfName) t.pdfName = fixFileName(t.pdfName); }).value();
db.write();

const PHONE_REGEX = /^(0|\+98|0098)?9\d{9}$/;

app.post('/api/auth/register', (req, res) => {
  const { username, password, confirmPassword, displayName, phone } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'نام کاربری و رمز عبور (حداقل ۴ کاراکتر) لازم است' });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'رمز عبور و تکرار آن یکسان نیستند' });
  }
  const phoneNormalized = (phone || '').replace(/[^\d+]/g, '');
  if (!phoneNormalized || !PHONE_REGEX.test(phoneNormalized)) {
    return res.status(400).json({ error: 'شماره موبایل معتبر وارد کنید (مثال: 0912xxxxxxx)' });
  }
  if (db.get('users').find({ username }).value()) {
    return res.status(400).json({ error: 'این نام کاربری قبلا ثبت شده' });
  }
  const isFirstUser = db.get('users').size().value() === 0;
  const user = {
    id: uuid(),
    username,
    phone: phoneNormalized,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: displayName || username,
    role: isFirstUser ? 'admin' : 'pending', // first registered user becomes admin automatically
    createdAt: Date.now()
  };
  db.get('users').push(user).write();
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.get('users').find({ username }).value();
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }
  if (user.role === 'blocked') return res.status(403).json({ error: 'دسترسی شما مسدود شده است' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});

// ---------- users / admin ----------
app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ users: db.get('users').map(publicUser).value() });
});

// list of approved members (admin + member), for anyone to start a DM with —
// unlike /api/users this is not admin-only, so regular members can message
// people who are currently offline too.
app.get('/api/members', requireAuth, (req, res) => {
  const members = db.get('users')
    .filter(u => ['admin', 'member'].includes(u.role))
    .map(publicUser)
    .value();
  res.json({ users: members });
});

app.post('/api/users/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'member', 'pending', 'blocked'].includes(role)) {
    return res.status(400).json({ error: 'نقش نامعتبر' });
  }
  const target = db.get('users').find({ id: req.params.id });
  if (!target.value()) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  target.assign({ role }).write();
  io.emit('userUpdated', publicUser(target.value()));
  res.json({ ok: true });
});

// ---------- topics ----------
app.get('/api/topics', requireAuth, (req, res) => {
  res.json({ topics: db.get('topics').value() });
});

app.post('/api/topics', requireAuth, requireRole('admin'), (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'عنوان لازم است' });
  const topic = { id: uuid(), title: title.trim(), pdfFile: null, pdfName: null, createdAt: Date.now() };
  db.get('topics').push(topic).write();
  io.emit('newTopic', topic);
  res.json({ topic });
});

app.post('/api/topics/:id/pdf', requireAuth, requireRole('admin'), upload.single('pdf'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id });
  if (!topic.value()) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  topic.assign({ pdfFile: req.file.filename, pdfName: fixFileName(req.file.originalname) }).write();
  io.emit('topicUpdated', topic.value());
  res.json({ topic: topic.value() });
});

// ---------- messages ----------
app.get('/api/topics/:id/messages', requireAuth, (req, res) => {
  res.json({ messages: db.get('messages').filter({ topicId: req.params.id }).value() });
});

app.post('/api/topics/:id/messages', requireAuth, requireRole('admin', 'member'), (req, res) => {
  const { text, replyTo } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'متن پیام خالی است' });
  const msg = {
    id: uuid(),
    topicId: req.params.id,
    userId: req.user.id,
    authorName: req.user.displayName,
    text: text.trim(),
    time: Date.now(),
    likes: 0, dislikes: 0, thanks: 0,
    pinned: false,
    replyTo: replyTo || null
  };
  db.get('messages').push(msg).write();
  io.emit('newMessage', msg);
  res.json({ message: msg });
});

app.post('/api/messages/:id/react', requireAuth, (req, res) => {
  const { kind } = req.body || {};
  if (!['likes', 'dislikes', 'thanks'].includes(kind)) return res.status(400).json({ error: 'نوع واکنش نامعتبر' });
  const m = db.get('messages').find({ id: req.params.id });
  if (!m.value()) return res.status(404).json({ error: 'پیام پیدا نشد' });
  const updated = { ...m.value(), [kind]: (m.value()[kind] || 0) + 1 };
  m.assign(updated).write();
  io.emit('messageUpdated', updated);
  res.json({ message: updated });
});

app.post('/api/messages/:id/pin', requireAuth, requireRole('admin'), (req, res) => {
  const { pinned } = req.body || {};
  const m = db.get('messages').find({ id: req.params.id });
  if (!m.value()) return res.status(404).json({ error: 'پیام پیدا نشد' });
  m.assign({ pinned: !!pinned }).write();
  io.emit('messageUpdated', m.value());
  res.json({ message: m.value() });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const m = db.get('messages').find({ id: req.params.id }).value();
  if (!m) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (req.user.role !== 'admin' && m.userId !== req.user.id) {
    return res.status(403).json({ error: 'دسترسی غیرمجاز' });
  }
  db.get('messages').remove({ id: req.params.id }).write();
  io.emit('messageDeleted', { id: req.params.id, topicId: m.topicId });
  res.json({ ok: true });
});

// ---------- search ----------
app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = db.get('messages').filter(m => m.text.includes(q)).value();
  res.json({ results });
});

// ---------- private conversations (1:1 and group) ----------
// conversations: { id, type:'dm'|'group', title, members:[userId], createdBy, createdAt, clearedAt:{userId:ts} }
// chatMessages : { id, convId, from, fromName, text, time }
// Everything is stored permanently. A user can "clear" a conversation for
// themselves (they stop seeing older messages) or delete their own messages.
// Only the main admin (first registered user) can read all conversations.

// one-time migration of the old 1:1 "dms" collection into conversations
(function migrateLegacyDms() {
  const legacy = db.get('dms').value() || [];
  if (!legacy.length) return;
  const byKey = {};
  legacy.forEach(m => { (byKey[m.key] = byKey[m.key] || []).push(m); });
  Object.values(byKey).forEach(list => {
    const first = list[0];
    const conv = { id: uuid(), type: 'dm', title: '', members: [first.from, first.to], createdBy: first.from, createdAt: first.time || Date.now(), clearedAt: {} };
    db.get('conversations').push(conv).write();
    list.forEach(m => db.get('chatMessages').push({ id: m.id || uuid(), convId: conv.id, from: m.from, fromName: m.fromName, text: m.text, time: m.time }).write());
  });
  db.set('dms', []).write();
})();

function userById(id) { return db.get('users').find({ id }).value(); }

function convView(c, viewerId) {
  const cleared = viewerId ? ((c.clearedAt || {})[viewerId] || 0) : 0;
  const msgs = db.get('chatMessages').filter(m => m.convId === c.id && m.time > cleared).value();
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return {
    id: c.id, type: c.type, title: c.title,
    members: c.members.map(id => publicUser(userById(id))).filter(Boolean),
    lastTime: last ? last.time : 0,
    createdAt: c.createdAt,
    visible: !cleared || !!last   // a cleared chat reappears only when a newer message arrives
  };
}
function convRooms(c) {
  let target = io;
  c.members.forEach(id => { target = target.to(`user:${id}`); });
  return target.to('owner');
}

// conversations I am a member of
app.get('/api/convs', requireAuth, (req, res) => {
  const list = db.get('conversations').filter(c => c.members.includes(req.user.id)).value()
    .map(c => convView(c, req.user.id)).filter(v => v.visible)
    .sort((a, b) => (b.lastTime || b.createdAt) - (a.lastTime || a.createdAt));
  res.json({ conversations: list });
});

// ALL conversations — main admin only
app.get('/api/convs/all', requireAuth, (req, res) => {
  if (!isOwnerUser(req.user)) return res.status(403).json({ error: 'دسترسی غیرمجاز' });
  const list = db.get('conversations').value().map(c => convView(c, null))
    .sort((a, b) => (b.lastTime || b.createdAt) - (a.lastTime || a.createdAt));
  res.json({ conversations: list });
});

// start a 1:1 chat (one person) or a group (several people)
app.post('/api/convs', requireAuth, requireRole('admin', 'member'), (req, res) => {
  const { memberIds, title } = req.body || {};
  const ids = Array.from(new Set((Array.isArray(memberIds) ? memberIds : []).filter(id => id !== req.user.id)))
    .filter(id => { const u = userById(id); return u && ['admin', 'member'].includes(u.role); });
  if (!ids.length) return res.status(400).json({ error: 'حداقل یک عضو معتبر انتخاب کنید' });
  if (ids.length > 19) return res.status(400).json({ error: 'حداکثر ۲۰ نفر در یک گروه' });
  const members = [req.user.id, ...ids];
  if (members.length === 2) {
    const existing = db.get('conversations').find(c => c.type === 'dm' && c.members.length === 2 && c.members.every(m => members.includes(m))).value();
    if (existing) return res.json({ conversation: convView(existing, req.user.id) });
  }
  const names = members.map(id => (userById(id) || {}).displayName).filter(Boolean);
  const conv = {
    id: uuid(), type: members.length === 2 ? 'dm' : 'group',
    title: members.length === 2 ? '' : ((title || '').trim().slice(0, 60) || names.join('، ').slice(0, 60)),
    members, createdBy: req.user.id, createdAt: Date.now(), clearedAt: {}
  };
  db.get('conversations').push(conv).write();
  convRooms(conv).emit('convChanged', { id: conv.id });
  res.json({ conversation: convView(conv, req.user.id) });
});

app.get('/api/convs/:id/messages', requireAuth, (req, res) => {
  const c = db.get('conversations').find({ id: req.params.id }).value();
  if (!c) return res.status(404).json({ error: 'گفتگو پیدا نشد' });
  const isMember = c.members.includes(req.user.id);
  const ownerView = isOwnerUser(req.user) && req.query.all === '1';
  if (!isMember && !isOwnerUser(req.user)) return res.status(403).json({ error: 'دسترسی غیرمجاز' });
  const cleared = (isMember && !ownerView) ? ((c.clearedAt || {})[req.user.id] || 0) : 0;
  res.json({ messages: db.get('chatMessages').filter(m => m.convId === c.id && m.time > cleared).value() });
});

app.post('/api/convs/:id/messages', requireAuth, requireRole('admin', 'member'), (req, res) => {
  const c = db.get('conversations').find({ id: req.params.id }).value();
  if (!c) return res.status(404).json({ error: 'گفتگو پیدا نشد' });
  if (!c.members.includes(req.user.id)) return res.status(403).json({ error: 'شما عضو این گفتگو نیستید' });
  const text = ((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'متن خالی است' });
  if (text.length > 4000) return res.status(400).json({ error: 'پیام خیلی طولانی است' });
  const msg = { id: uuid(), convId: c.id, from: req.user.id, fromName: req.user.displayName, text, time: Date.now() };
  db.get('chatMessages').push(msg).write();
  convRooms(c).emit('chatMessage', { msg, conv: { id: c.id, type: c.type, title: c.title, memberIds: c.members } });
  res.json({ message: msg });
});

// delete one of MY OWN messages (permanent)
app.delete('/api/chatmsg/:id', requireAuth, (req, res) => {
  const m = db.get('chatMessages').find({ id: req.params.id }).value();
  if (!m) return res.status(404).json({ error: 'پیام پیدا نشد' });
  if (m.from !== req.user.id) return res.status(403).json({ error: 'فقط پیام‌های خودتان را می‌توانید حذف کنید' });
  db.get('chatMessages').remove({ id: m.id }).write();
  const c = db.get('conversations').find({ id: m.convId }).value();
  if (c) convRooms(c).emit('chatMessageDeleted', { id: m.id, convId: m.convId });
  res.json({ ok: true });
});

// "delete chat for me": hides older messages from my view only
app.post('/api/convs/:id/clear', requireAuth, (req, res) => {
  const c = db.get('conversations').find({ id: req.params.id });
  if (!c.value()) return res.status(404).json({ error: 'گفتگو پیدا نشد' });
  if (!c.value().members.includes(req.user.id)) return res.status(403).json({ error: 'دسترسی غیرمجاز' });
  const clearedAt = { ...(c.value().clearedAt || {}), [req.user.id]: Date.now() };
  c.assign({ clearedAt }).write();
  io.to(`user:${req.user.id}`).emit('convChanged', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- socket.io: presence + private rooms ----------
const onlineUsers = new Map(); // userId -> {displayName, lastSeen}

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const userId = sess && sess.userId;
  if (!userId) { socket.disconnect(); return; }
  const user = db.get('users').find({ id: userId }).value();
  if (!user) { socket.disconnect(); return; }

  socket.join(`user:${userId}`);
  if (isOwnerUser(user)) socket.join('owner');
  onlineUsers.set(userId, { displayName: user.displayName, lastSeen: Date.now() });
  io.emit('presence', Array.from(onlineUsers.entries()).map(([id, v]) => ({ id, ...v })));

  socket.on('disconnect', () => {
    const still = Array.from(io.sockets.sockets.values()).some(s => s.request.session && s.request.session.userId === userId);
    if (!still) {
      onlineUsers.set(userId, { displayName: user.displayName, lastSeen: Date.now(), offline: true });
      io.emit('presence', Array.from(onlineUsers.entries()).map(([id, v]) => ({ id, ...v })));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Forum app running on http://localhost:${PORT}`);
});
