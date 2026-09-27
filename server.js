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
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}

// ---------- auth ----------
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
  // multer/busboy decode non-ASCII original filenames as latin1 by default,
  // which garbles Persian/UTF-8 names — re-decode them correctly here.
  const fixedName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  topic.assign({ pdfFile: req.file.filename, pdfName: fixedName }).write();
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

// ---------- direct messages ----------
function dmKey(a, b) { return [a, b].sort().join('_'); }

app.get('/api/dms/:userId', requireAuth, (req, res) => {
  const key = dmKey(req.user.id, req.params.userId);
  res.json({ messages: db.get('dms').filter({ key }).value() });
});

app.post('/api/dms/:userId', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'متن خالی است' });
  const other = db.get('users').find({ id: req.params.userId }).value();
  if (!other) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const msg = {
    id: uuid(),
    key: dmKey(req.user.id, req.params.userId),
    from: req.user.id, fromName: req.user.displayName,
    to: req.params.userId,
    text: text.trim(), time: Date.now()
  };
  db.get('dms').push(msg).write();
  io.to(`user:${req.params.userId}`).to(`user:${req.user.id}`).emit('newDM', msg);
  res.json({ message: msg });
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
