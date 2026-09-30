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
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res, filePath) => {
    const base = path.basename(filePath);
    // topic PDFs are stored without an extension — serve them as inline PDFs
    if (!path.extname(base) && db.get('topics').find({ pdfFile: base }).value()) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
    }
  }
}));

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

// images + voice notes attached to messages
const ATT_TYPES = {
  'image/jpeg': ['image', '.jpg'], 'image/png': ['image', '.png'], 'image/gif': ['image', '.gif'], 'image/webp': ['image', '.webp'],
  'audio/webm': ['audio', '.webm'], 'audio/ogg': ['audio', '.ogg'], 'audio/mpeg': ['audio', '.mp3'], 'audio/mp3': ['audio', '.mp3'],
  'audio/mp4': ['audio', '.m4a'], 'audio/x-m4a': ['audio', '.m4a'], 'audio/aac': ['audio', '.aac'],
  'audio/wav': ['audio', '.wav'], 'audio/x-wav': ['audio', '.wav']
};
const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const attUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, uuid().replace(/-/g, '') + ATT_TYPES[baseMime(file.mimetype)][1])
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ATT_TYPES[baseMime(file.mimetype)]) return cb(new Error('فقط عکس (JPG/PNG/GIF/WEBP) و فایل صوتی مجاز است'));
    cb(null, true);
  }
});
function runUpload(mw, field) {
  return (req, res, next) => mw.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'حجم فایل بیش از حد مجاز است' : err.message });
    next();
  });
}
// resolve an attachment id the current user uploaded into the snapshot stored on a message
function takeAttachment(id, user) {
  if (!id) return null;
  const a = db.get('attachments').find({ id }).value();
  if (!a || a.by !== user.id) return null;
  return { url: '/uploads/' + a.file, kind: a.kind, name: a.name };
}

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
  return {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role,
    isOwner: !!first && first.id === u.id,
    bio: { education: u.education || '', experience: u.experience || '', skills: u.skills || '' }
  };
}
// full profile for the user themself, and for admins verifying identity —
// includes fields nobody else should see (real name, email, phone)
function privateProfile(u) {
  if (!u) return null;
  return { ...publicUser(u), realName: u.realName || '', email: u.email || '', phone: u.phone || '' };
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

// one-time: make sure a general discussion hall exists and is listed first
(function seedGeneralHall() {
  if (db.get('meta').value().generalSeeded) return;
  if (!db.get('topics').find({ title: 'گفتگوی عمومی' }).value()) {
    db.get('topics').unshift({ id: uuid(), title: 'گفتگوی عمومی', description: 'بحث آزاد همه اعضا', pdfFile: null, pdfName: null, createdAt: Date.now() }).write();
  }
  db.set('meta.generalSeeded', true).write();
})();

// mark the general discussion room so it can be shown first and protected from deletion
(function markGeneralTopic() {
  const g = db.get('topics').find(t => t.title === 'گفتگوی عمومی' && !t.hallId).value()
    || db.get('topics').find(t => !t.hallId).value();
  if (g && !g.general && !db.get('topics').find({ general: true }).value()) {
    db.get('topics').find({ id: g.id }).assign({ general: true }).write();
  }
})();

const PHONE_REGEX = /^(0|\+98|0098)?9\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- email (for password reset) ----------
// Configure via env vars on Railway: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, PUBLIC_URL.
// If any of these are missing, we don't crash — we just skip actually sending the
// email and log a warning, so "forgot password" still works logically (admin can
// always set a new password from the admin panel as a fallback).
const nodemailer = require('nodemailer');
let mailTransport = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else {
  console.warn('⚠️  SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — password-reset emails will not actually be sent. Admin can still reset a member\'s password from the admin panel.');
}
async function sendResetEmail(user, link) {
  if (!mailTransport || !user.email) return false;
  try {
    await mailTransport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: 'بازیابی رمز عبور — راه بادیه مجازی',
      text: `برای تعیین رمز عبور جدید روی این لینک بزنید (تا ۱ ساعت معتبر است):\n${link}\n\nاگر این درخواست را شما نداده‌اید، این ایمیل را نادیده بگیرید.`
    });
    return true;
  } catch (e) {
    console.error('sendResetEmail failed:', e.message);
    return false;
  }
}
function publicUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}


app.post('/api/auth/register', (req, res) => {
  const { username, password, confirmPassword, displayName, phone, email } = req.body || {};
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
  const emailNormalized = (email || '').trim();
  if (emailNormalized && !EMAIL_REGEX.test(emailNormalized)) {
    return res.status(400).json({ error: 'ایمیل معتبر وارد کنید یا خالی بگذارید' });
  }
  if (db.get('users').find({ username }).value()) {
    return res.status(400).json({ error: 'این نام کاربری قبلا ثبت شده' });
  }
  const isFirstUser = db.get('users').size().value() === 0;
  const user = {
    id: uuid(),
    username,
    phone: phoneNormalized,
    email: emailNormalized,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: displayName || username,
    role: isFirstUser ? 'admin' : 'pending', // first registered user becomes admin automatically
    createdAt: Date.now()
  };
  db.get('users').push(user).write();
  req.session.userId = user.id;
  if (!isFirstUser) {
    io.to('admins').emit('newMember', { id: user.id, displayName: user.displayName, username: user.username });
    emitPendingCount();
  }
  res.json({ user: publicUser(user) });
});

// ---------- forgot / reset password ----------
app.post('/api/auth/forgot', (req, res) => {
  const identifier = String((req.body || {}).identifier || '').trim();
  const generic = { ok: true, message: 'اگر چنین حسابی وجود داشته باشد، ایمیل بازیابی برایش ارسال شد. اگر ایمیلی ثبت نکرده‌اید یا ایمیل نرسید، از بخش «ارتباط با مدیر» کمک بگیرید.' };
  if (!identifier) return res.json(generic);
  const user = db.get('users').find(u => u.username === identifier || (u.email && u.email.toLowerCase() === identifier.toLowerCase())).value();
  if (!user) return res.json(generic); // don't reveal whether the account exists
  const token = uuid();
  db.get('resetTokens').push({ token, userId: user.id, expires: Date.now() + 60 * 60 * 1000 }).write();
  const link = `${publicUrl(req)}/?reset=${token}`;
  sendResetEmail(user, link); // fire-and-forget; missing SMTP config just means no email goes out
  res.json(generic);
});

app.post('/api/auth/reset', (req, res) => {
  const { token, newPassword, confirmPassword } = req.body || {};
  if (!token) return res.status(400).json({ error: 'لینک نامعتبر است' });
  const rec = db.get('resetTokens').find({ token }).value();
  if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: 'لینک منقضی یا نامعتبر است — دوباره درخواست بازیابی رمز بدهید' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'رمز جدید حداقل ۴ کاراکتر باشد' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'رمز جدید و تکرار آن یکسان نیستند' });
  const user = db.get('users').find({ id: rec.userId });
  if (!user.value()) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  user.assign({ passwordHash: bcrypt.hashSync(newPassword, 10) }).write();
  db.get('resetTokens').remove(t => t.userId === rec.userId).write();
  req.session.userId = user.value().id;
  res.json({ ok: true, user: publicUser(user.value()) });
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
  const u = currentUser(req);
  res.json({ user: u ? privateProfile(u) : null });
});

// admin-only: who to contact if you forget your password / need help — shown
// on the login screen, no auth required so a locked-out person can still see it
app.get('/api/public/admin-contact', (req, res) => {
  const first = db.get('users').first().value();
  if (!first) return res.json({ contact: null });
  res.json({ contact: { displayName: first.displayName, phone: first.phone || '' } });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const { displayName, phone, email, realName, education, experience, skills, currentPassword, newPassword, confirmPassword } = req.body || {};
  const changes = {};
  if (displayName !== undefined) {
    const n = String(displayName).trim();
    if (n.length < 2 || n.length > 40) return res.status(400).json({ error: 'نام نمایشی باید بین ۲ تا ۴۰ کاراکتر باشد' });
    changes.displayName = n;
  }
  if (phone !== undefined) {
    const ph = String(phone).replace(/[^\d+]/g, '');
    if (!PHONE_REGEX.test(ph)) return res.status(400).json({ error: 'شماره موبایل معتبر وارد کنید (مثال: 0912xxxxxxx)' });
    changes.phone = ph;
  }
  if (email !== undefined) {
    const em = String(email).trim();
    if (em && !EMAIL_REGEX.test(em)) return res.status(400).json({ error: 'ایمیل معتبر وارد کنید' });
    changes.email = em;
  }
  if (realName !== undefined) changes.realName = String(realName).trim().slice(0, 80);
  if (education !== undefined) changes.education = String(education).trim().slice(0, 300);
  if (experience !== undefined) changes.experience = String(experience).trim().slice(0, 500);
  if (skills !== undefined) changes.skills = String(skills).trim().slice(0, 300);
  if (newPassword) {
    if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) return res.status(400).json({ error: 'رمز عبور فعلی اشتباه است' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'رمز جدید حداقل ۴ کاراکتر باشد' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'رمز جدید و تکرار آن یکسان نیستند' });
    changes.passwordHash = bcrypt.hashSync(newPassword, 10);
  }
  const u = db.get('users').find({ id: req.user.id });
  u.assign(changes).write();
  if (changes.displayName) {
    db.get('messages').filter({ userId: req.user.id }).forEach(m => { m.authorName = changes.displayName; }).value();
    db.get('chatMessages').filter({ from: req.user.id }).forEach(m => { m.fromName = changes.displayName; }).value();
    db.write();
    const on = onlineUsers.get(req.user.id);
    if (on) { on.displayName = changes.displayName; io.emit('presence', presenceList()); }
  }
  io.emit('userUpdated', publicUser(u.value()));
  res.json({ user: privateProfile(u.value()) });
});

app.get('/api/messages/:id', requireAuth, (req, res) => {
  const m = db.get('messages').find({ id: req.params.id }).value();
  if (!m) return res.status(404).json({ error: 'این پست پیدا نشد (شاید حذف شده باشد)' });
  res.json({ message: m });
});

app.post('/api/attachments', requireAuth, requireRole('admin', 'member'), runUpload(attUpload, 'file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی انتخاب نشده' });
  const [kind] = ATT_TYPES[baseMime(req.file.mimetype)];
  const a = { id: uuid(), file: req.file.filename, kind, name: fixFileName(req.file.originalname), by: req.user.id, time: Date.now() };
  db.get('attachments').push(a).write();
  res.json({ attachment: { id: a.id, url: '/uploads/' + a.file, kind, name: a.name } });
});

// ---------- users / admin ----------
app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  // admins get the identity-verification fields (real name, phone, email) too
  res.json({ users: db.get('users').map(privateProfile).value() });
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
  emitPendingCount();
  res.json({ ok: true });
});

// admin sets a brand-new password for a member (e.g. they forgot theirs and
// contacted the admin directly) — the admin never sees the old password,
// since it's hashed and unrecoverable; this issues a fresh one instead
app.post('/api/users/:id/set-password', requireAuth, requireRole('admin'), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'رمز جدید حداقل ۴ کاراکتر باشد' });
  const target = db.get('users').find({ id: req.params.id });
  if (!target.value()) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  target.assign({ passwordHash: bcrypt.hashSync(newPassword, 10) }).write();
  res.json({ ok: true });
});

app.get('/api/pending-count', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ count: db.get('users').filter({ role: 'pending' }).size().value() });
});
function emitPendingCount() {
  io.to('admins').emit('pendingCount', { count: db.get('users').filter({ role: 'pending' }).size().value() });
}

// ---------- site settings (chosen by the main admin) ----------
const SETTING_DEFAULTS = { topicOpenMode: 'scroll' };   // 'scroll' = jump to content, 'page' = separate page on phones
function readSettings() {
  const st = (db.get('meta').value() || {}).settings || {};
  return { ...SETTING_DEFAULTS, ...st };
}
app.get('/api/settings', requireAuth, (req, res) => res.json({ settings: readSettings() }));
app.patch('/api/settings', requireAuth, (req, res) => {
  if (!isOwnerUser(req.user)) return res.status(403).json({ error: 'فقط مدیر اصلی سایت می‌تواند تنظیمات را تغییر دهد' });
  const { topicOpenMode } = req.body || {};
  const next = readSettings();
  if (topicOpenMode !== undefined) {
    if (!['scroll', 'page'].includes(topicOpenMode)) return res.status(400).json({ error: 'مقدار نامعتبر' });
    next.topicOpenMode = topicOpenMode;
  }
  db.set('meta.settings', next).write();
  io.emit('settingsChanged', next);
  res.json({ settings: next });
});

// ---------- halls (categories that group several topics/threads) ----------
app.get('/api/halls', requireAuth, (req, res) => {
  res.json({ halls: db.get('halls').value() });
});
app.post('/api/halls', requireAuth, requireRole('admin'), (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'عنوان تالار لازم است' });
  const hall = { id: uuid(), title: title.trim().slice(0, 100), description: (description || '').trim().slice(0, 200), createdAt: Date.now() };
  db.get('halls').push(hall).write();
  io.emit('hallsChanged');
  res.json({ hall });
});
app.patch('/api/halls/:id', requireAuth, requireRole('admin'), (req, res) => {
  const hall = db.get('halls').find({ id: req.params.id });
  if (!hall.value()) return res.status(404).json({ error: 'تالار پیدا نشد' });
  const { title, description } = req.body || {};
  const changes = {};
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: 'عنوان نمی‌تواند خالی باشد' });
    changes.title = String(title).trim().slice(0, 100);
  }
  if (description !== undefined) changes.description = String(description).trim().slice(0, 200);
  hall.assign(changes).write();
  io.emit('hallsChanged');
  res.json({ hall: hall.value() });
});

// ---------- topics (threads) — optionally nested under a hall ----------
app.get('/api/topics', requireAuth, (req, res) => {
  res.json({ topics: db.get('topics').value() });
});

// who should hear about activity in a topic: admins + people who wrote in it
function topicAudience(topicId, extraUserId) {
  const ids = new Set(db.get('users').filter(u => u.role === 'admin').map('id').value());
  db.get('messages').filter({ topicId }).forEach(m => ids.add(m.userId)).value();
  if (extraUserId) ids.add(extraUserId);
  return ids;
}
function notifyUsers(ids, exceptId, payload) {
  ids.forEach(id => { if (id !== exceptId) io.to(`user:${id}`).emit('notify', payload); });
}

app.post('/api/topics', requireAuth, requireRole('admin'), (req, res) => {
  const { title, description, hallId } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'عنوان لازم است' });
  if (!hallId) return res.status(400).json({ error: 'زیرموضوع باید داخل یک تالار اختصاصی ساخته شود' });
  if (!db.get('halls').find({ id: hallId }).value()) return res.status(400).json({ error: 'تالار انتخاب‌شده پیدا نشد' });
  const topic = { id: uuid(), hallId: hallId, title: title.trim().slice(0, 100), description: (description || '').trim().slice(0, 200), pdfFile: null, pdfName: null, createdAt: Date.now() };
  db.get('topics').push(topic).write();
  io.emit('newTopic', topic);
  res.json({ topic });
});

app.patch('/api/topics/:id', requireAuth, requireRole('admin'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id });
  if (!topic.value()) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  const { title, description, hallId } = req.body || {};
  const changes = {};
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: 'عنوان نمی‌تواند خالی باشد' });
    changes.title = String(title).trim().slice(0, 100);
  }
  if (description !== undefined) changes.description = String(description).trim().slice(0, 200);
  if (hallId !== undefined && !topic.value().general) {
    if (hallId && !db.get('halls').find({ id: hallId }).value()) return res.status(400).json({ error: 'تالار انتخاب‌شده پیدا نشد' });
    changes.hallId = hallId || null;
  }
  topic.assign(changes).write();
  io.emit('topicUpdated', topic.value());
  notifyUsers(topicAudience(req.params.id), req.user.id, { kind: 'topic', topicId: req.params.id, topicTitle: topic.value().title, from: req.user.displayName, text: 'عنوان یا توضیح این تالار تغییر کرد' });
  res.json({ topic: topic.value() });
});

app.delete('/api/topics/:id', requireAuth, requireRole('admin'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id });
  const t = topic.value();
  if (!t) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  if (t.general) return res.status(400).json({ error: 'گفتگوی عمومی قابل حذف نیست' });
  const msgs = db.get('messages').filter({ topicId: t.id }).value();
  msgs.forEach(m => {
    if (m.attachment && m.attachment.url) {
      const file = path.basename(m.attachment.url);
      removeUploadedFile(file);
      db.get('attachments').remove({ file }).write();
    }
  });
  db.get('messages').remove({ topicId: t.id }).write();
  if (t.pdfFile) removeUploadedFile(t.pdfFile);
  db.get('topics').remove({ id: t.id }).write();
  io.emit('topicDeleted', { id: t.id });
  res.json({ ok: true, removedMessages: msgs.length });
});

function removeUploadedFile(name) {
  if (!name || name !== path.basename(name)) return;
  fs.unlink(path.join(uploadsDir, name), () => {});
}

app.post('/api/topics/:id/pdf', requireAuth, requireRole('admin'), runUpload(upload, 'pdf'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id });
  if (!topic.value()) { if (req.file) removeUploadedFile(req.file.filename); return res.status(404).json({ error: 'تاپیک پیدا نشد' }); }
  if (!req.file) return res.status(400).json({ error: 'فایلی انتخاب نشده' });
  const old = topic.value().pdfFile;
  topic.assign({ pdfFile: req.file.filename, pdfName: fixFileName(req.file.originalname) }).write();
  if (old) removeUploadedFile(old);
  io.emit('topicUpdated', topic.value());
  notifyUsers(topicAudience(req.params.id), req.user.id, { kind: 'topic', topicId: req.params.id, topicTitle: topic.value().title, from: req.user.displayName, text: 'فایل جدیدی بارگذاری شد' });
  res.json({ topic: topic.value() });
});

app.delete('/api/topics/:id/pdf', requireAuth, requireRole('admin'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id });
  if (!topic.value()) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  const old = topic.value().pdfFile;
  topic.assign({ pdfFile: null, pdfName: null }).write();
  if (old) removeUploadedFile(old);
  io.emit('topicUpdated', topic.value());
  res.json({ topic: topic.value() });
});

// ---------- messages ----------
app.get('/api/topics/:id/messages', requireAuth, (req, res) => {
  res.json({ messages: db.get('messages').filter({ topicId: req.params.id }).value() });
});

app.post('/api/topics/:id/messages', requireAuth, requireRole('admin', 'member'), (req, res) => {
  const topic = db.get('topics').find({ id: req.params.id }).value();
  if (!topic) return res.status(404).json({ error: 'تاپیک پیدا نشد' });
  const { text, replyTo, attachmentId } = req.body || {};
  const attachment = takeAttachment(attachmentId, req.user);
  const clean = (text || '').trim();
  if (!clean && !attachment) return res.status(400).json({ error: 'متن پیام خالی است' });
  if (clean.length > 4000) return res.status(400).json({ error: 'پیام خیلی طولانی است' });
  const ref = replyTo ? db.get('messages').find({ id: replyTo, topicId: topic.id }).value() : null;
  const msg = {
    id: uuid(),
    topicId: topic.id,
    userId: req.user.id,
    authorName: req.user.displayName,
    text: clean,
    attachment,
    time: Date.now(),
    likes: 0, dislikes: 0, thanks: 0,
    pinned: false,
    replyTo: ref ? ref.id : null
  };
  const audience = topicAudience(topic.id, ref && ref.userId);
  db.get('messages').push(msg).write();
  io.emit('newMessage', msg);
  const snippet = clean ? clean.slice(0, 80) : (attachment ? (attachment.kind === 'image' ? '📷 عکس' : '🎤 پیام صوتی') : '');
  audience.forEach(id => {
    if (id === req.user.id) return;
    const isReplyToMe = !!ref && ref.userId === id;
    io.to(`user:${id}`).emit('notify', { kind: isReplyToMe ? 'reply' : 'message', topicId: topic.id, topicTitle: topic.title, from: req.user.displayName, text: snippet });
  });
  res.json({ message: msg });
});

const REACTION_KINDS = ['likes', 'dislikes', 'thanks'];
app.post('/api/messages/:id/react', requireAuth, requireRole('admin', 'member'), (req, res) => {
  const { kind } = req.body || {};
  if (!REACTION_KINDS.includes(kind)) return res.status(400).json({ error: 'نوع واکنش نامعتبر' });
  const m = db.get('messages').find({ id: req.params.id });
  const cur = m.value();
  if (!cur) return res.status(404).json({ error: 'پیام پیدا نشد' });
  // reactions: { userId: kind }  — old messages only have plain counters; keep those as a fixed base
  const legacy = cur.legacy || (cur.reactions ? { likes: 0, dislikes: 0, thanks: 0 } : { likes: cur.likes || 0, dislikes: cur.dislikes || 0, thanks: cur.thanks || 0 });
  const reactions = { ...(cur.reactions || {}) };
  if (reactions[req.user.id] === kind) delete reactions[req.user.id];   // same one again = take it back
  else reactions[req.user.id] = kind;                                    // new or switched
  const counts = { ...legacy };
  Object.values(reactions).forEach(k => { counts[k] = (counts[k] || 0) + 1; });
  const updated = { ...cur, legacy, reactions, likes: counts.likes, dislikes: counts.dislikes, thanks: counts.thanks };
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
// Persian text is typed with many look-alike characters (Arabic ي/ك, ZWNJ, digits, diacritics),
// so both the query and the messages are normalised before comparing.
function normFa(s) {
  return String(s || '')
    .replace(/[\u064A\u0649]/g, '\u06CC')          // ي ى -> ی
    .replace(/\u0643/g, '\u06A9')                   // ك -> ک
    .replace(/[\u0629]/g, '\u06C1')                 // ة -> ه (close enough for search)
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')     // آ أ إ -> ا
    .replace(/[\u064B-\u065F\u0670\u0640\u200C\u200D]/g, '') // diacritics, tatweel, ZWNJ
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase();
}
app.get('/api/search', requireAuth, (req, res) => {
  const q = normFa((req.query.q || '').trim());
  if (!q) return res.json({ results: [] });
  const words = q.split(/\s+/).filter(Boolean);
  const topicTitle = {};
  db.get('topics').value().forEach(t => { topicTitle[t.id] = t.title; });
  const results = db.get('messages').value()
    .filter(m => m.text && topicTitle[m.topicId] && words.every(w => normFa(m.text).includes(w)))
    .sort((a, b) => b.time - a.time)
    .slice(0, 60)
    .map(m => ({ id: m.id, topicId: m.topicId, topicTitle: topicTitle[m.topicId], authorName: m.authorName, time: m.time, snippet: m.text.slice(0, 160) }));
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
  const attachment = takeAttachment((req.body || {}).attachmentId, req.user);
  if (!text && !attachment) return res.status(400).json({ error: 'متن خالی است' });
  if (text.length > 4000) return res.status(400).json({ error: 'پیام خیلی طولانی است' });
  const msg = { id: uuid(), convId: c.id, from: req.user.id, fromName: req.user.displayName, text, attachment, time: Date.now() };
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
function presenceList() { return Array.from(onlineUsers.entries()).map(([id, v]) => ({ id, ...v })); }

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const userId = sess && sess.userId;
  if (!userId) { socket.disconnect(); return; }
  const user = db.get('users').find({ id: userId }).value();
  if (!user) { socket.disconnect(); return; }

  socket.join(`user:${userId}`);
  if (isOwnerUser(user)) socket.join('owner');
  if (user.role === 'admin') socket.join('admins');
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
