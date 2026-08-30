'use strict';
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const util = require('util');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { getDb, prepare, persist, persistNow, genUid } = require('./db');
const P = require('../shared/protocol');
const execFile = util.promisify(childProcess.execFile);

// 轻量 .env 加载：从 server/.env（或 cwd/.env）读取 KEY=VALUE，已存在的环境变量优先。
// 用途：SMTP 邮箱/授权码等可在不改代码的情况下配置。
(function loadDotEnv() {
  const candidates = [path.join(__dirname, '.env'), path.join(process.cwd(), '.env')];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line[0] === '#') continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k && process.env[k] === undefined) process.env[k] = v;
      }
      console.log('[env] loaded ' + f);
      break;
    } catch (e) { console.error('[env] 加载失败 ' + f + ' : ' + (e.message || e)); }
  }
})();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
const PORT = parseInt(process.env.PORT || '8080', 10);
const QR_LOGIN_TTL = 2 * 60 * 1000;
const qrLoginSessions = new Map();

function newQrLoginSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const session = { token, createdAt: Date.now(), expiresAt: Date.now() + QR_LOGIN_TTL, status: 'pending', userId: null, loginToken: null, consumed: false };
  qrLoginSessions.set(token, session);
  return session;
}

function getQrLoginSession(token) {
  const session = qrLoginSessions.get(String(token || ''));
  if (!session) return null;
  if (session.expiresAt <= Date.now() || session.consumed) {
    qrLoginSessions.delete(session.token);
    return null;
  }
  return session;
}

setInterval(() => {
  for (const [token, session] of qrLoginSessions) {
    if (session.expiresAt <= Date.now() || session.consumed) qrLoginSessions.delete(token);
  }
}, 30 * 1000);

// ---------- 管理员后台白名单 ----------
// 仅 3529403074@qq.com 拥有管理员后台权限
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '3529403074@qq.com').split(',').map(s => s.trim().toLowerCase());
function isAdmin(user) { return !!(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())); }
// adminGuard：校验 Authorization Bearer，且必须是 ADMIN_EMAILS 里的账号；返回 {payload, u, sent}。sent=true 表示已写响应
function adminGuard(req, res) {
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) { res.status(401).json({ error: '未授权' }); return { payload: null, u: null, sent: true }; }
  const u = prepare('SELECT id,username,email FROM users WHERE id=?').get(payload.id);
  if (!u || !isAdmin(u)) { res.status(403).json({ error: '需要管理员权限' }); return { payload: null, u: null, sent: true }; }
  return { payload, u, sent: false };
}

// ---------- 实时计数（内存，非持久化）----------
// 供 /api/admin/overview 实时统计读取
const START_AT = Date.now();
let sentMsgsLastMinCounter = 0;       // 上一分钟的发送数（每 60s 重置）
let recvMsgsLastMinCounter = 0;
let sentMsgsThisMinCounter = 0;       // 当前分钟累计
let recvMsgsThisMinCounter = 0;
let peakConcurrentUsers = 0;          // 历史峰值并发
let peakMsgsPerMin = 0;
setInterval(() => {
  if (sentMsgsThisMinCounter > peakMsgsPerMin) peakMsgsPerMin = sentMsgsThisMinCounter;
  sentMsgsLastMinCounter = sentMsgsThisMinCounter;
  recvMsgsLastMinCounter = recvMsgsThisMinCounter;
  sentMsgsThisMinCounter = 0;
  recvMsgsThisMinCounter = 0;
}, 60 * 1000);

function parseExtra(s){ try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

const app = express();

// ---------- 强制HTTPS：TLS启用时，非本地明文访问一律301跳转到HTTPS ----------
// 本地回环豁免（epaygw/Cloudreve等本机服务回调走127.0.0.1的HTTP端口，不能被重定向破坏）
let __tlsEnabled = null;
app.use((req, res, next) => {
  if (__tlsEnabled === null) {
    const certPath = process.env.CERT_PATH || path.join(process.cwd(), 'portable', 'le.crt');
    const keyPath = process.env.KEY_PATH || path.join(process.cwd(), 'portable', 'le.key');
    const pfxPath = process.env.PFX_PATH || path.join(process.cwd(), 'portable', 'le.pfx');
    __tlsEnabled = process.env.USE_HTTPS === '1' &&
      ((fs.existsSync(certPath) && fs.existsSync(keyPath)) || fs.existsSync(pfxPath));
  }
  if (!__tlsEnabled) return next();
  const xf = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (req.secure || xf === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return next();
  }
  const ra = (req.socket && req.socket.remoteAddress) || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return next();
  const hostHdr = String(req.headers.host || '');
  const host = hostHdr.split(':')[0] || 'mc.32768.top';
  return res.redirect(301, 'https://' + host + ':8888' + req.originalUrl);
});

// ---------- CORS：允许网页端独立部署（不同域名）访问 API ----------
const ALLOWED_ORIGINS = ['https://mc.32768.top', 'http://mc.32768.top', 'http://localhost', 'http://127.0.0.1'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS,PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 安全头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

function publicUser(u) {
  return {
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
    uid: u.uid, email: u.email || '',
    country: u.country || '', province: u.province || '', city: u.city || '',
    extra: parseExtra(u.extra),
    pubkey: u.pubkey || '',
    lastSeen: u.last_seen || null
  };
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, tv: user.token_version || 0 }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p || !p.id) return null;
    // 检查 token_version 是否匹配（密码重置/封禁后废除旧 token）
    const u = prepare('SELECT token_version, banned FROM users WHERE id=?').get(p.id);
    if (!u) return null;
    if ((p.tv || 0) !== (u.token_version || 0)) return null;
    // 封禁账号拒绝所有已签发 token（防止封禁后仍能通过 REST 操作）
    if (u.banned) return null;
    return p;
  } catch { return null; }
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload, v: P.VERSION }));
  }
}

let ready = false;

// ---------- REST ----------
// ---------- 限流器（滑动窗口，内存） ----------
const _rateBuckets = new Map(); // key -> {count, resetAt}
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
  b.count++;
  return b.count > max;
}
function getIp(req) {
  // 仅在显式配置 TRUST_PROXY=1 时信任 X-Forwarded-For，防止客户端伪造 IP 绕过限流。
  // 未配置时直接使用 socket 地址（单机直连场景），避免 XFF 被随意伪造。
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim() || req.socket.remoteAddress || '';
  }
  return req.socket.remoteAddress || '';
}
// 限流桶定期清理（60秒），防止内存无限增长
setInterval(() => { const now = Date.now(); for (const [k, b] of _rateBuckets) { if (now > b.resetAt) _rateBuckets.delete(k); } }, 60000);

const MAX_MSG_CONTENT = 100 * 1024; // 100KB
// ---------- 验证码池（内存，按 email -> {code, expireAt, used}） ----------
const emailCodes = new Map();
function genCode() { return String(crypto.randomInt(100000, 1000000)); }
function cleanCode() { const now = Date.now(); for (const [k, v] of emailCodes) if (v.expireAt < now) emailCodes.delete(k); }
// 验证码校验尝试限制：防6位码在有效期内的暴力枚举
const codeAttemptFail = new Map();
function codeAttemptKey(email) { return 'codetry:' + String(email).toLowerCase(); }
function codeAttemptsExceeded(email) {
  const k = codeAttemptKey(email);
  const v = codeAttemptFail.get(k);
  if (v && v.count >= 8 && Date.now() - v.first < 10 * 60 * 1000) return true;
  return false;
}
function recordCodeFail(email) {
  // 防膨胀：超过5000条时先清理过期项
  if (codeAttemptFail.size > 5000) {
    const now = Date.now();
    for (const [k, v] of codeAttemptFail) if (now - v.first > 10 * 60 * 1000) codeAttemptFail.delete(k);
  }
  const k = codeAttemptKey(email);
  const v = codeAttemptFail.get(k);
  if (!v || Date.now() - v.first > 10 * 60 * 1000) codeAttemptFail.set(k, { count: 1, first: Date.now() });
  else v.count += 1;
}
function clearCodeFails(email) { codeAttemptFail.delete(codeAttemptKey(email)); }

// ---------- SMTP 邮件发送（163 邮箱） ----------
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.163.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'andy130305@163.com',
    pass: process.env.SMTP_PASS
  }
});

async function sendMail(to, subject, html) {
  return new Promise((resolve) => {
    mailer.sendMail({
      from: '"SecureChat" <' + (process.env.SMTP_USER || 'andy130305@163.com') + '>',
      to, subject, html
    }, (err, info) => {
      if (err) console.error('[mail] 发送失败 to=' + to + ' subject=' + subject + ' : ' + (err.message || err));
      resolve({ ok: !err, err: err && err.message, info });
    });
  });
}

// 请求验证码：POST /api/email/code { email, purpose: "register"|"bind" }
app.post('/api/email/code', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  cleanCode();
  const ip = getIp(req);
  if (rateLimit('email:' + ip, 5, 10 * 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请10分钟后再试' });
  const { email, purpose } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式错误' });
  }
  // 邮箱已被占用？（register/bind 时已占用则拒绝；login 时需已注册）
  const taken = prepare('SELECT id FROM users WHERE email=?').get(email);
  if (purpose === 'login' || purpose === 'reset') {
    if (!taken) return res.status(400).json({ error: '该邮箱未注册，请先注册再使用验证码登录' });
  } else if (taken) {
    return res.status(409).json({ error: '该邮箱已被绑定' });
  }

  const code = genCode();
  emailCodes.set(email, { code, expireAt: Date.now() + 10 * 60 * 1000, purpose: purpose || 'register', used: false });

  const subject = 'SecureChat 验证码';
  const html = `<div style="font-family:'Microsoft YaHei',Arial;background:#f7f8fa;padding:24px;color:#222">
    <h2 style="color:#07c160;margin:0 0 12px">SecureChat</h2>
    <p>你的验证码是：</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:4px;color:#07c160;margin:10px 0">${code}</div>
    <p style="color:#888;font-size:12px">10 分钟内有效。如果不是你本人请求的，请忽略此邮件。</p>
  </div>`;
  const r = await sendMail(email, subject, html);
  if (!r.ok) return res.status(500).json({ error: '邮件发送失败：' + (r.err || '未知错误') });
  res.json({ ok: true });
});

function checkCode(email, code, purpose) {
  const v = emailCodes.get(email);
  if (!v) return '验证码无效';
  if (v.expireAt < Date.now()) { emailCodes.delete(email); return '验证码已过期'; }
  if (v.used) return '验证码已使用';
  if (code !== v.code) return '验证码错误';
  if (purpose && v.purpose && v.purpose !== purpose) return '验证码用途不符';
  v.used = true;
  return null;
}

// 注册（必须带 email + 邮箱验证码）
// UID 合法性：4-16 位 字母+数字（不区分大小写但保留原样）
function validUid(s) { return /^[A-Za-z0-9]{4,16}$/.test(s || ''); }

// 注册（必须带 email + 邮箱验证码；可选 customUid 自定义ID）
app.post('/api/register', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const ip = getIp(req);
  if (rateLimit('register:' + ip, 5, 60 * 60 * 1000)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const { username, password, nickname, email, code, customUid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度需2-20' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'register');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const exists = prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  const emailTaken = prepare('SELECT id FROM users WHERE email=?').get(email);
  if (emailTaken) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
  // UID：若用户提供则用，否则随机生成
  let uid;
  if (customUid) {
    if (!validUid(customUid)) return res.status(400).json({ error: 'ID需4-16位字母或数字' });
    if (prepare('SELECT id FROM users WHERE uid=?').get(customUid)) return res.status(409).json({ error: '该ID已被占用' });
    uid = customUid;
  } else {
    do { uid = genUid(); } while (prepare('SELECT id FROM users WHERE uid=?').get(uid));
  }
  const hash = bcrypt.hashSync(password, 10);
  const nick = nickname || username;
  const now = Date.now();
  prepare('INSERT INTO users(username,nickname,password,uid,email,uid_changed_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(username, nick, hash, uid, email, now, now);
  const user = prepare('SELECT * FROM users WHERE username=?').get(username);
  const token = signToken(user);
  res.json({ token, user: publicUser(user), uidChangedAt: now });
});

// 修改自己的 ID：一个月只能改一次
app.post('/api/uid', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const newUid = (req.body || {}).uid;
  if (!validUid(newUid)) return res.status(400).json({ error: 'ID需4-16位字母或数字' });
  const me = prepare('SELECT uid, uid_changed_at FROM users WHERE id=?').get(payload.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });
  const last = me.uid_changed_at || 0;
  const days30 = 30 * 24 * 3600 * 1000;
  if (Date.now() - last < days30) {
    const remain = Math.ceil((days30 - (Date.now() - last)) / (24 * 3600 * 1000));
    return res.status(429).json({ error: '一个月只能改一次ID，剩余 ' + remain + ' 天' });
  }
  if (newUid === me.uid) return res.status(400).json({ error: '新ID与当前相同' });
  if (prepare('SELECT id FROM users WHERE uid=?').get(newUid)) return res.status(409).json({ error: '该ID已被占用' });
  prepare('UPDATE users SET uid=?, uid_changed_at=? WHERE id=?').run(newUid, Date.now(), payload.id);
  const u = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
  res.json({ ok: true, user: publicUser(u) });
});

// 登录后再绑定/改邮箱：POST /api/email/bind { email, code }
app.post('/api/email/bind', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: '请填写邮箱和验证码' });
  const codeErr = checkCode(email, code, 'bind');
  if (codeErr) return res.status(400).json({ error: codeErr });
  const emailTaken = prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, payload.id);
  if (emailTaken) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
  prepare('UPDATE users SET email=? WHERE id=?').run(email, payload.id);
  const u = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/login', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const ip = getIp(req);
  if (rateLimit('login:' + ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: '登录尝试过多，请15分钟后再试' });
  // account 可为用户名或邮箱（兼容旧字段 username）
  const account = String((req.body || {}).account || (req.body || {}).username || '').trim();
  const password = (req.body || {}).password;
  if (!account || !password) return res.status(400).json({ error: '用户名/邮箱和密码不能为空' });
  let user = prepare('SELECT * FROM users WHERE username=?').get(account);
  if (!user && account.indexOf('@') > -1) {
    user = prepare('SELECT * FROM users WHERE email=?').get(account);
  }
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名/邮箱或密码错误' });
  }
  if (user.banned) {
    return res.status(403).json({ error: '该账号已被封禁' + (user.ban_reason ? '：' + user.ban_reason : '') });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// 邮箱验证码登录：POST /api/login/code { email, code }
app.post('/api/login/code', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { email, code } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式错误' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'login');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const user = prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  if (user.banned) {
    return res.status(403).json({ error: '该账号已被封禁' + (user.ban_reason ? '：' + user.ban_reason : '') });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// 忘记密码：POST /api/password/reset { email, code, newPassword }
// 先向邮箱发送 purpose=reset 的验证码，再凭邮箱+验证码重置密码。
app.post('/api/password/reset', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { email, code, newPassword } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式错误' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少6位' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'reset');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const user = prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  const hash = bcrypt.hashSync(String(newPassword), 10);
  prepare('UPDATE users SET password=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').run(hash, user.id);
  res.json({ ok: true });
});

// 自助修改密码：POST /api/password/change { oldPassword, newPassword }
app.post('/api/password/change', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '参数缺失' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少6位' });
  const user = prepare('SELECT id,password FROM users WHERE id=?').get(payload.id);
  if (!user || !user.password) return res.status(400).json({ error: '账号未设置密码' });
  if (!bcrypt.compareSync(String(oldPassword), user.password)) return res.status(403).json({ error: '原密码错误' });
  const hash = bcrypt.hashSync(String(newPassword), 10);
  prepare('UPDATE users SET password=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').run(hash, user.id);
  logAudit(payload.id, 'password_change', null, 'user', '自助修改密码', clientIp(req));
  res.json({ ok: true });
});

// 扫码登录（微信式）：未登录端（电脑）生成二维码 → 已登录端（手机）扫码确认 → 电脑端轮询后登录。
// 已登录设备调用 create 时（网页「扫码登录授权」），直接绑定自身身份并置为 confirmed，兼容旧流程。
app.post('/api/login/qr/create', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const session = newQrLoginSession();
  const payload = apiUser(req);
  if (payload) {
    const user = prepare('SELECT * FROM users WHERE id=?').get(payload.id);
    if (user) {
      session.userId = user.id;
      session.loginToken = signToken(user);
      session.status = 'confirmed';
    }
  }
  res.json({ token: session.token, expiresAt: session.expiresAt, status: session.status, qrText: 'securechat://login?token=' + encodeURIComponent(session.token) });
});

app.get('/api/login/qr/image', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const session = getQrLoginSession(req.query.token);
  if (!session) return res.status(410).json({ error: '二维码已过期，请重新生成' });
  try {
    const png = await QRCode.toBuffer('securechat://login?token=' + encodeURIComponent(session.token), { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').send(png);
  } catch (e) { res.status(500).json({ error: '二维码生成失败' }); }
});

app.get('/api/login/qr/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const session = getQrLoginSession(req.query.token);
  if (!session) return res.status(410).json({ error: '二维码已过期，请重新生成' });
  res.json({ status: session.status, expiresAt: session.expiresAt });
});

// 已登录设备扫码确认：用扫描端自己的 Authorization 把身份写入会话，二维码端即可登录。
app.post('/api/login/qr/confirm', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '请先登录后扫码确认' });
  const session = getQrLoginSession(req.body && req.body.token);
  if (!session) return res.status(410).json({ error: '二维码已过期，请重新生成' });
  if (session.status !== 'pending') return res.status(409).json({ error: '二维码已处理' });
  const user = prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  session.status = 'confirmed';
  session.userId = user.id;
  session.loginToken = signToken(user);
  res.json({ ok: true, status: session.status, user: publicUser(user) });
});

// 二维码端轮询：未登录时由网页/客户端发起，拿到一次性登录凭证后即登录成功。
app.post('/api/login/qr/consume', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const session = getQrLoginSession(req.body && req.body.token);
  if (!session) return res.status(410).json({ error: '二维码已过期' });
  if (session.status !== 'confirmed' || !session.loginToken) return res.json({ status: session.status });
  session.consumed = true;
  res.json({ status: 'ok', token: session.loginToken, user: publicUser(prepare('SELECT * FROM users WHERE id=?').get(session.userId)) });
});

// 通用二维码渲染：GET /api/qrcode/render?text=...&w=...（返回 PNG，用于网页端展示名片等）
app.get('/api/qrcode/render', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const text = (req.query.text || '').toString().slice(0, 1024);
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });
  try {
    const w = Math.min(parseInt(req.query.w, 10) || 320, 800);
    const png = await QRCode.toBuffer(text, { width: w, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').send(png);
  } catch (e) {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

// 我的名片：返回当前登录用户的 uid 等信息，客户端据此生成「加好友」二维码 securechat://friend?uid=xxx
app.get('/api/qrcode/mycard', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const user = prepare('SELECT id, username, nickname, avatar, uid, email FROM users WHERE id=?').get(payload.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ card: { uid: user.uid, name: user.nickname || user.username, nickname: user.nickname, username: user.username, avatar: user.avatar, email: user.email } });
});

// 小程序目录：只返回受控的 SecureChat 官方入口，后续包下载仍需扩展签名校验。
app.get('/api/mini-programs', (req, res) => {
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  res.json({ programs: [
    { id: 'securechat.tools', name: '安全工具', version: '1.0.0', icon: '/icons/icon-192.png', entry: '/mini-programs/tools/index.html', permissions: [] },
    { id: 'securechat.notes', name: '安全便签', version: '1.0.0', icon: '/icons/icon-192.png', entry: '/mini-programs/notes/index.html', permissions: ['storage'] }
  ] });
});

app.get('/api/users', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const users = prepare('SELECT id,username,nickname,avatar,uid,country,province,city,pubkey FROM users WHERE id<>? ORDER BY nickname').all(payload.id);
  res.json({ users });
});

// ---------- 好友 ----------
// 加好友（发送请求）：POST /api/friend/add { friendUid: "xY7mK3n" }
app.post('/api/friend/add', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const friendUid = (req.body || {}).friendUid;
  if (!friendUid) return res.status(400).json({ error: '好友UID不能为空' });
  const target = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE uid=?').get(friendUid);
  if (!target) return res.status(404).json({ error: '该ID不存在' });
  const friendId = target.id;
  if (friendId === payload.id) return res.status(400).json({ error: '不能加自己' });
  // 黑名单检查：被拉黑方不得添加对方为好友
  const isBlocked = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)')
    .get(payload.id, friendId, friendId, payload.id);
  if (isBlocked) return res.status(403).json({ error: '无法添加该用户' });
  const existing = prepare('SELECT id,status FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)')
    .get(payload.id, friendId, friendId, payload.id);
  if (existing && existing.status === 1) return res.status(409).json({ error: '已经是好友' });
  if (existing && existing.status === 0) return res.status(409).json({ error: '已发送请求，待对方接受' });
  prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,0,?)')
    .run(payload.id, friendId, Date.now());
  res.json({ ok: true, friend: publicUser(target) });
  if (onlineAny(friendId)) {
    const me = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
    sendToUser(friendId, P.S_FRIEND_REQ, { from: payload.id, fromUser: publicUser(me) });
  }
});

// 接受好友请求：POST /api/friend/accept { friendId }（friendId = 请求发起者）
app.post('/api/friend/accept', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const friendId = parseInt((req.body || {}).friendId, 10);
  if (!friendId) return res.status(400).json({ error: '好友ID不能为空' });
  const row = prepare('SELECT id,status FROM friends WHERE user_id=? AND friend_id=?').get(friendId, payload.id);
  if (!row) return res.status(404).json({ error: '没有该好友请求' });
  if (row.status === 1) return res.json({ ok: true });
  // 标记请求为已接受 + 插入反向记录 (我 -> 对方, status=1)
  prepare('UPDATE friends SET status=1 WHERE id=?').run(row.id);
  prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,1,?)')
    .run(payload.id, friendId, Date.now());
  res.json({ ok: true });
  // 推送好友列表更新给双方
  pushFriendList(payload.id);
  pushFriendList(friendId);
});

// 拒绝好友请求：POST /api/friend/reject { friendId }
app.post('/api/friend/reject', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const friendId = parseInt((req.body || {}).friendId, 10);
  if (!friendId) return res.status(400).json({ error: '好友ID不能为空' });
  prepare('DELETE FROM friends WHERE user_id=? AND friend_id=? AND status=0').run(friendId, payload.id);
  res.json({ ok: true });
});

// 好友备注：表 + 接口

// 设置好友备注：POST /api/friend/remark { friendId, remark }
app.post('/api/friend/remark', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const friendId = parseInt((req.body || {}).friendId, 10);
  const remark = String((req.body || {}).remark || '').trim().slice(0, 30);
  if (!Number.isInteger(friendId)) return res.status(400).json({ error: '参数错误' });
  const isFriend = prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=1').get(payload.id, friendId);
  if (!isFriend) return res.status(403).json({ error: '仅可备注自己的好友' });
  if (remark) {
    prepare('INSERT INTO friend_remarks(user_id,friend_id,remark,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO UPDATE SET remark=excluded.remark, updated_at=excluded.updated_at')
      .run(payload.id, friendId, remark, Date.now());
  } else {
    prepare('DELETE FROM friend_remarks WHERE user_id=? AND friend_id=?').run(payload.id, friendId);
  }
  persist();
  res.json({ ok: true, friendId, remark });
});

// 我的好友列表：GET /api/friends
app.get('/api/friends', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen,fr.remark AS remark
     FROM friends f JOIN users u ON u.id = f.friend_id
     LEFT JOIN friend_remarks fr ON fr.user_id=? AND fr.friend_id=u.id
     WHERE f.user_id=? AND f.status=1 ORDER BY u.nickname`
  ).all(payload.id, payload.id);
  res.json({ friends: rows.map(r => ({ ...publicUser(r), online: onlineHas(r.id), remark: r.remark || '' })) });
});

// 待处理好友请求列表：GET /api/friend/requests
app.get('/api/friend/requests', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen
     FROM friends f JOIN users u ON u.id = f.user_id
     WHERE f.friend_id=? AND f.status=0 ORDER BY f.created_at DESC`
  ).all(payload.id);
  res.json({ requests: rows });
});

function pushFriendList(uid) {
  if (!onlineAny(uid)) return;
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id=? AND f.status=1 ORDER BY u.nickname`
  ).all(uid);
  const list = rows.map(r => ({ ...publicUser(r), online: onlineHas(r.id) }));
  sendToUser(uid, P.S_FRIEND_LIST, { friends: list });
}

// 设置头像：POST /api/avatar { avatar: "<data-uri base64>" }
app.post('/api/avatar', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const avatar = (req.body || {}).avatar;
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) {
    return res.status(400).json({ error: '头像格式错误' });
  }
  // 仅允许安全的光栅图片格式；拒绝 svg（可携带脚本）与可解析为 HTML 的格式
  const avatarMime = avatar.slice(0, 40).match(/^data:image\/([a-zA-Z0-9.+-]+)[;,]/);
  const safeAvatar = avatarMime && /^(png|jpe?g|gif|webp|bmp|avif)$/i.test(avatarMime[1]);
  if (!safeAvatar) return res.status(400).json({ error: '头像仅支持 PNG/JPG/GIF/WebP/BMP' });
  // 限制 256K base64（避免数据库爆）
  if (avatar.length > 256 * 1024) return res.status(400).json({ error: '图片过大（限256KB）' });
  prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar, payload.id);
  const u = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
  res.json({ ok: true, user: publicUser(u) });
  // 推送在线更新给所有用户
  broadcastUserList();
});

// 上传/更新公钥：POST /api/keys { pubkey: "<base64 ECDH P-256 public key spki>" }
app.post('/api/keys', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const pubkey = (req.body || {}).pubkey;
  if (typeof pubkey !== 'string' || pubkey.length < 30 || pubkey.length > 1000) {
    return res.status(400).json({ error: '公钥格式错误' });
  }
  prepare('UPDATE users SET pubkey=? WHERE id=?').run(pubkey, payload.id);
  broadcastUserList();
  res.json({ ok: true });
});

// 上传/更新签名预钥：POST /api/keys/signed-prekey { keyId, pubKey, signature }
app.post('/api/keys/signed-prekey', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { keyId, pubKey, signature } = req.body || {};
  if (typeof keyId !== 'string' || !keyId) return res.status(400).json({ error: 'keyId 不能为空' });
  if (typeof pubKey !== 'string' || pubKey.length < 30 || pubKey.length > 1000) return res.status(400).json({ error: '公钥格式错误' });
  if (typeof signature !== 'string' || !signature) return res.status(400).json({ error: 'signature 不能为空' });
  const now = Date.now();
  const existing = prepare('SELECT id FROM signed_prekeys WHERE user_id=? AND key_id=?').get(payload.id, keyId);
  if (existing) {
    prepare('UPDATE signed_prekeys SET pub_key=?, signature=?, updated_at=? WHERE id=?').run(pubKey, signature, now, existing.id);
  } else {
    prepare('INSERT INTO signed_prekeys (user_id, key_id, pub_key, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(payload.id, keyId, pubKey, signature, now, now);
  }
  res.json({ ok: true });
});

// 批量上传一次性预钥：POST /api/keys/prekeys { prekeys: [{ keyId, pubKey }, ...] }
app.post('/api/keys/prekeys', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const list = (req.body || {}).prekeys;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'prekeys 必须是数组' });
  if (list.length > 50) return res.status(400).json({ error: '一次最多 50 条预钥' });
  for (const item of list) {
    if (!item || typeof item.keyId !== 'string' || !item.keyId) return res.status(400).json({ error: 'keyId 不能为空' });
    if (typeof item.pubKey !== 'string' || item.pubKey.length < 30 || item.pubKey.length > 1000) return res.status(400).json({ error: '公钥格式错误' });
  }
  const now = Date.now();
  for (const item of list) {
    const existing = prepare('SELECT id FROM prekeys WHERE user_id=? AND key_id=?').get(payload.id, item.keyId);
    if (existing) {
      prepare('UPDATE prekeys SET pub_key=?, used=0, created_at=? WHERE id=?').run(item.pubKey, now, existing.id);
    } else {
      prepare('INSERT INTO prekeys (user_id, key_id, pub_key, created_at) VALUES (?, ?, ?, ?)').run(payload.id, item.keyId, item.pubKey, now);
    }
  }
  // 防膨胀：仅保留每用户最新 200 条预钥，并清理 30 天前的已用预钥
  try {
    prepare('DELETE FROM prekeys WHERE user_id=? AND id NOT IN (SELECT id FROM prekeys WHERE user_id=? ORDER BY created_at DESC LIMIT 200)').run(payload.id, payload.id);
    prepare('DELETE FROM prekeys WHERE user_id=? AND used=1 AND created_at < ?').run(payload.id, now - 30 * 24 * 3600 * 1000);
  } catch (e) { console.error('[keys] prune failed: ' + (e && e.message || e)); }
  res.json({ ok: true, count: list.length });
});

// 取对方 X3DH bundle：GET /api/keys/bundle/:userId
app.get('/api/keys/bundle/:userId', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'userId 无效' });
  const u = prepare('SELECT id, pubkey FROM users WHERE id=?').get(targetId);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const spk = prepare('SELECT key_id AS keyId, pub_key AS pubKey, signature FROM signed_prekeys WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(targetId) || null;
  let oneTimePreKey = null;
  try {
    db.run('BEGIN IMMEDIATE');
    const opk = prepare('SELECT id, key_id AS keyId, pub_key AS pubKey FROM prekeys WHERE user_id=? AND used=0 ORDER BY created_at ASC LIMIT 1').get(targetId) || null;
    if (opk) {
      prepare('UPDATE prekeys SET used=1 WHERE id=?').run(opk.id);
      oneTimePreKey = { keyId: opk.keyId, pubKey: opk.pubKey };
    }
    db.run('COMMIT');
  } catch (e) { try { db.run('ROLLBACK'); } catch {} }
  res.json({
    identityKey: u.pubkey || null,
    signedPreKey: spk ? { keyId: spk.keyId, pubKey: spk.pubKey, signature: spk.signature } : null,
    oneTimePreKey,
    registrationId: u.id
  });
});

// 修改个人资料：POST /api/profile { nickname?, country?, province?, city?, extra? }
// 只更新请求体中提供的字段；返回更新后的 publicUser
app.post('/api/profile', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const body = req.body || {};
  // 允许更新的字段白名单（nickname/country/province/city 维持单独列，extra 存 JSON 字符串）
  const fields = [];
  const args = [];
  if (typeof body.nickname === 'string') {
    const nick = body.nickname.trim();
    if (!nick) return res.status(400).json({ error: '昵称不能为空' });
    if (nick.length > 30) return res.status(400).json({ error: '昵称过长（限30字）' });
    fields.push('nickname=?'); args.push(nick);
  }
  if (typeof body.country === 'string') { if (body.country.length > 60) return res.status(400).json({ error: '国家/地区过长' }); fields.push('country=?'); args.push(body.country); }
  if (typeof body.province === 'string') { if (body.province.length > 60) return res.status(400).json({ error: '省份过长' }); fields.push('province=?'); args.push(body.province); }
  if (typeof body.city === 'string') { if (body.city.length > 60) return res.status(400).json({ error: '城市过长' }); fields.push('city=?'); args.push(body.city); }
  // extra：任意键值对象，整体写入（覆盖）
  if (body.extra !== undefined) {
    if (body.extra === null || typeof body.extra !== 'object' || Array.isArray(body.extra)) {
      return res.status(400).json({ error: 'extra 必须是对象' });
    }
    const cleaned = {};
    let extraBudget = 4096;
    for (const k of Object.keys(body.extra)) {
      if (Object.prototype.hasOwnProperty.call(body.extra, k)) {
        const v = body.extra[k];
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') continue; // 不存嵌套对象/数组，保持扁平
        const sv = String(v).slice(0, Math.max(0, extraBudget));
        extraBudget -= sv.length;
        if (extraBudget < 0) break;
        if (!sv) continue;
        cleaned[String(k).slice(0, 60)] = sv;
      }
    }
    fields.push('extra=?'); args.push(JSON.stringify(cleaned));
  }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  args.push(payload.id);
  prepare('UPDATE users SET ' + fields.join(',') + ' WHERE id=?').run(...args);
  const u = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
  res.json({ ok: true, user: publicUser(u) });
  // 昵称可能变化，刷新在线列表给所有用户
  broadcastUserList();
  // 同步刷新自己的好友列表（好友侧 nickname 也会变）
  pushFriendList(payload.id);
});
// （背景自定义由前端 localStorage 处理；不需要服务端）

function messageForUser(messageId, userId) {
  return prepare(`
    SELECT m.id,m.from_id AS from,m.to_id AS to,m.content,m.created_at AS createdAt,m.read,
      mm.reply_to AS replyTo,mm.forwarded_from AS forwardedFrom,
      mm.burn_after_reading AS burnAfterReading,mm.pinned
    FROM messages m LEFT JOIN message_meta mm ON mm.message_id=m.id
    WHERE m.id=? AND (m.from_id=? OR m.to_id=?)
  `).get(messageId, userId, userId);
}

const _ALLOWED_META_FIELDS = new Set(['reply_to', 'forwarded_from', 'burn_after_reading', 'pinned']);
function messageMetaUpdate(messageId, userId, field, value) {
  if (!_ALLOWED_META_FIELDS.has(field)) throw new Error('invalid meta field');
  const message = messageForUser(messageId, userId);
  if (!message) return null;
  const now = Date.now();
  const storedValue = field === 'reply_to' || field === 'forwarded_from' ? (Number(value) || null) : (value ? 1 : 0);
  prepare(`INSERT INTO message_meta(message_id,${field},updated_at) VALUES(?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET ${field}=excluded.${field},updated_at=excluded.updated_at`)
    .run(messageId, storedValue, now);
  return messageForUser(messageId, userId);
}

app.post('/api/messages/:id/reply', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id); const message = messageForUser(id, payload.id);
  if (!message) return res.status(404).json({ error: '消息不存在' });
  const meta = messageMetaUpdate(id, payload.id, 'reply_to', Number(req.body && req.body.replyTo) || 0);
  res.json({ ok: true, message: meta });
});

app.post('/api/messages/:id/pin', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const meta = messageMetaUpdate(Number(req.params.id), payload.id, 'pinned', !!(req.body && req.body.pinned));
  if (!meta) return res.status(404).json({ error: '消息不存在' });
  res.json({ ok: true, message: meta });
});

app.post('/api/messages/:id/favorite', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id); if (!messageForUser(id, payload.id)) return res.status(404).json({ error: '消息不存在' });
  if (req.body && req.body.favorite === false) prepare('DELETE FROM message_favorites WHERE user_id=? AND message_id=?').run(payload.id, id);
  else prepare('INSERT OR IGNORE INTO message_favorites(user_id,message_id,created_at) VALUES(?,?,?)').run(payload.id, id, Date.now());
  res.json({ ok: true, favorite: !(req.body && req.body.favorite === false) });
});

app.get('/api/favorites', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(`SELECT m.id,m.from_id AS from,m.to_id AS to,m.content,m.created_at AS createdAt,f.created_at AS favoritedAt
    FROM message_favorites f JOIN messages m ON m.id=f.message_id WHERE f.user_id=? ORDER BY f.created_at DESC`).all(payload.id);
  res.json({ messages: rows });
});

app.post('/api/chats/:peerId/settings', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = Number(req.params.peerId); if (!Number.isInteger(peerId)) return res.status(400).json({ error: '联系人无效' });
  const body = req.body || {}; const now = Date.now();
  const current = prepare('SELECT muted,pinned FROM user_chat_settings WHERE user_id=? AND peer_id=?').get(payload.id, peerId) || { muted: 0, pinned: 0 };
  const muted = body.muted === undefined ? current.muted : (body.muted ? 1 : 0);
  const pinned = body.pinned === undefined ? current.pinned : (body.pinned ? 1 : 0);
  prepare(`INSERT INTO user_chat_settings(user_id,peer_id,muted,pinned,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,peer_id) DO UPDATE SET muted=excluded.muted,pinned=excluded.pinned,updated_at=excluded.updated_at`)
    .run(payload.id, peerId, muted, pinned, now);
  res.json({ ok: true, peerId, muted: !!muted, pinned: !!pinned });
});

app.get('/api/chats/settings', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare('SELECT peer_id AS peerId,muted,pinned,updated_at AS updatedAt FROM user_chat_settings WHERE user_id=? ORDER BY pinned DESC,updated_at DESC').all(payload.id);
  res.json({ settings: rows });
});

app.post('/api/webhooks', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const url = String(req.body && req.body.url || '').trim();
  if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'Webhook 必须使用 HTTPS' });
  const secret = crypto.randomBytes(24).toString('hex');
  const info = prepare('INSERT OR IGNORE INTO webhooks(user_id,url,secret,enabled,created_at) VALUES(?,?,?,?,?)').run(payload.id, url, secret, 1, Date.now());
  const row = prepare('SELECT id,url,enabled,created_at AS createdAt FROM webhooks WHERE user_id=? AND url=?').get(payload.id, url);
  res.status(info.changes === 0 ? 200 : 201).json({ webhook: row, secret });
});

app.get('/api/webhooks', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  res.json({ webhooks: prepare('SELECT id,url,enabled,created_at AS createdAt FROM webhooks WHERE user_id=? ORDER BY id DESC').all(payload.id) });
});

app.get('/api/history/:peerId', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = parseInt(req.params.peerId, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = prepare(`SELECT m.*,mm.reply_to,mm.forwarded_from,mm.burn_after_reading,mm.pinned,
    pm.content AS reply_content,pm.from_id AS reply_from,pm.recalled AS reply_recalled
    FROM messages m LEFT JOIN message_meta mm ON mm.message_id=m.id
    LEFT JOIN messages pm ON pm.id=mm.reply_to
    WHERE (m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`)
    .all(payload.id, peerId, peerId, payload.id, limit, offset);
  const msgs = rows.reverse().map(r => ({ id: r.id, from: r.from_id, to: r.to_id, content: r.content, createdAt: r.created_at, read: r.read, replyTo: r.reply_to, forwardedFrom: r.forwarded_from, burnAfterReading: !!r.burn_after_reading, pinned: !!r.pinned, recalled: !!r.recalled, replyContent: r.reply_content || null, replyFrom: r.reply_from || null, replyRecalled: !!r.reply_recalled }));
  res.json({ messages: msgs });
});

app.get('/api/search/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ messages: [] });
  const qs = q.replace(/[\\%_]/g, '\\$&');
  const rows = prepare(`SELECT m.id,m.from_id,m.to_id,m.content,m.created_at FROM messages m
    WHERE (m.from_id=? OR m.to_id=?) AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 50`)
    .all(payload.id, payload.id, '%' + qs + '%');
  const messages = rows.map(r => {
    const peerId = r.from_id === payload.id ? r.to_id : r.from_id;
    const peer = prepare('SELECT username,nickname FROM users WHERE id=?').get(peerId);
    return { id: r.id, content: r.content, createdAt: r.created_at, peerId, peerName: peer ? (peer.nickname || peer.username) : '' };
  });
  res.json({ messages });
});

// 导出聊天记录：GET /api/export/messages?peerId=&format=json|txt
app.get('/api/export/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = parseInt(req.query.peerId, 10);
  if (!Number.isInteger(peerId)) return res.status(400).json({ error: '联系人ID无效' });
  const format = req.query.format === 'txt' ? 'txt' : 'json';
  const rows = prepare(
    `SELECT m.*,u1.nickname AS fromName,u2.nickname AS toName FROM messages m
     LEFT JOIN users u1 ON u1.id=m.from_id LEFT JOIN users u2 ON u2.id=m.to_id
     WHERE (m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?)
     ORDER BY m.created_at ASC`
  ).all(payload.id, peerId, peerId, payload.id);
  if (format === 'txt') {
    const lines = rows.map(r => {
      const time = new Date(r.created_at).toLocaleString('zh-CN');
      const name = r.from_id === payload.id ? (r.fromName || '我') : (r.toName || '对方');
      return `[${time}] ${name}: ${r.content}`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${peerId}.txt"`);
    res.send(lines.join('\n'));
  } else {
    const msgs = rows.map(r => ({ id: r.id, from: r.from_id, to: r.to_id, fromName: r.fromName, toName: r.toName, content: r.content, createdAt: r.created_at, read: r.read }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${peerId}.json"`);
    res.json({ messages: msgs, exportedAt: Date.now() });
  }
});

app.delete('/api/history/:peerId', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = parseInt(req.params.peerId, 10);
  if (!Number.isInteger(peerId)) return res.status(400).json({ error: '联系人无效' });
  const ids = prepare('SELECT id FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)')
    .all(payload.id, peerId, peerId, payload.id).map(r => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    // 清理关联的磁盘文件（__FILE__ 消息）
    try {
      const fileRows = prepare(`SELECT content FROM messages WHERE id IN (${ph})`).all(...ids);
      for (const r of fileRows) {
        if (typeof r.content === 'string' && r.content.startsWith('__FILE__')) {
          try {
            const meta = JSON.parse(r.content.slice('__FILE__'.length));
            // 仅清理合法 UUID 格式的文件 ID，防止路径遍历
            if (meta.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.id)) {
              try { fs.unlinkSync(path.join(FILES_DIR, meta.id + '.bin')); } catch (_) {}
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    try { prepare(`DELETE FROM message_meta WHERE message_id IN (${ph})`).run(...ids); } catch {}
    try { prepare(`DELETE FROM message_favorites WHERE message_id IN (${ph})`).run(...ids); } catch {}
    try { prepare(`DELETE FROM message_reads WHERE message_id IN (${ph})`).run(...ids); } catch {}
    try { prepare(`DELETE FROM chat_ext WHERE message_id IN (${ph})`).run(...ids); } catch {}
    try { prepare(`DELETE FROM message_timers WHERE message_id IN (${ph})`).run(...ids); } catch {}
  }
  const result = prepare('DELETE FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)')
    .run(payload.id, peerId, peerId, payload.id);
  persist();
  res.json({ ok: true, deleted: result.changes || 0 });
});

// ---------- 消息撤回 ----------
// 发送者 5 分钟内可撤回自己的单聊消息；撤回后双方历史显示"撤回了一条消息"。
app.post('/api/messages/:id/recall', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = parseInt(req.params.id, 10);
  const row = prepare('SELECT id,from_id,to_id,content,created_at,recalled FROM messages WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '消息不存在' });
  if (row.from_id !== payload.id) return res.status(403).json({ error: '只能撤回自己发送的消息' });
  if (row.recalled) return res.json({ ok: true, alreadyRecalled: true });
  if (Date.now() - row.created_at > 5 * 60 * 1000) return res.status(400).json({ error: '发送超过5分钟，无法撤回' });
  prepare('UPDATE messages SET recalled=1 WHERE id=?').run(id);
  persist();
  if (onlineAny(row.to_id)) sendToUser(row.to_id, P.S_MSG_RECALL, { messageId: id, from: row.from_id, to: row.to_id });
  res.json({ ok: true, messageId: id });
});

// ---------- 消息编辑 ----------
app.post('/api/messages/:id/edit', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = parseInt(req.params.id, 10);
  const row = prepare('SELECT id,from_id,to_id,content,recalled FROM messages WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '消息不存在' });
  if (row.from_id !== payload.id) return res.status(403).json({ error: '只能编辑自己发送的消息' });
  if (row.recalled) return res.status(400).json({ error: '已撤回的消息无法编辑' });
  const content = (req.body || {}).content;
  if (!content || typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > MAX_MSG_CONTENT) return res.status(413).json({ error: '消息内容过长（最大100KB）' });
  prepare('UPDATE messages SET content=? WHERE id=?').run(content.trim(), id);
  persist();
  const editPayload = { messageId: id, from: row.from_id, to: row.to_id, content: content.trim() };
  if (onlineAny(row.to_id)) sendToUser(row.to_id, P.S_MSG_EDIT, editPayload);
  sendToUser(payload.id, P.S_MSG_EDIT, editPayload);
  res.json({ ok: true, messageId: id, content: content.trim() });
});

// 文字消息 REST 发送入口：不依赖发送方浏览器的 WebSocket 状态。
// ---------- 拉黑（黑名单）----------
// 拉黑：POST /api/block { targetId }；解除：POST /api/unblock { targetId }；列表：GET /api/blocklist
app.post('/api/block', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const targetId = parseInt((req.body || {}).targetId, 10);
  if (!Number.isInteger(targetId) || targetId === payload.id) return res.status(400).json({ error: '目标无效' });
  if (!prepare('SELECT id FROM users WHERE id=?').get(targetId)) return res.status(404).json({ error: '用户不存在' });
  prepare('INSERT OR IGNORE INTO blocklist(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(payload.id, targetId, Date.now());
  persist();
  res.json({ ok: true, blocked: targetId });
});

app.post('/api/unblock', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const targetId = parseInt((req.body || {}).targetId, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: '目标无效' });
  prepare('DELETE FROM blocklist WHERE blocker_id=? AND blocked_id=?').run(payload.id, targetId);
  persist();
  res.json({ ok: true, unblocked: targetId });
});

app.get('/api/blocklist', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
    'SELECT b.blocked_id AS id, u.nickname, u.username, u.avatar, u.uid, b.created_at AS createdAt FROM blocklist b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC'
  ).all(payload.id);
  res.json({ blocked: rows });
});

app.post('/api/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { to, content, clientMsgId, replyTo, forwardedFrom, burnAfterReading } = req.body || {};
  const toId = parseInt(to, 10);
  if (!Number.isInteger(toId) || !content || typeof content !== 'string') return res.status(400).json({ error: '消息内容无效' });
  if (toId === payload.id) return res.status(400).json({ error: '不能给自己发送消息' });
  if (!prepare('SELECT 1 FROM users WHERE id=?').get(toId)) return res.status(404).json({ error: '目标用户不存在' });
  if (content.length > MAX_MSG_CONTENT) return res.status(413).json({ error: '消息内容过长（最大100KB）' });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(payload.id, toId)) return res.status(403).json({ error: '你已拉黑对方，无法发送消息' });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(toId, payload.id)) return res.status(403).json({ error: '对方已把你拉黑，无法发送消息' });
  if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) return res.status(400).json({ error: '消息标识无效' });
  if (clientMsgId) {
    const existing = prepare('SELECT id,from_id AS senderId,to_id AS recipientId,content,created_at AS createdAt FROM messages WHERE client_msg_id=? AND from_id=?').get(clientMsgId, payload.id);
    if (existing) return res.json({ ok: true, message: { id: existing.id, from: existing.senderId, to: existing.recipientId, content: existing.content, createdAt: existing.createdAt, clientMsgId } });
  }
  const createdAt = Date.now();
  const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)').run(payload.id, toId, content, clientMsgId || null, createdAt);
  if (replyTo || forwardedFrom || burnAfterReading) {
    prepare('INSERT INTO message_meta(message_id,reply_to,forwarded_from,burn_after_reading,updated_at) VALUES(?,?,?,?,?)')
      .run(info.lastInsertRowid, Number(replyTo) || null, Number(forwardedFrom) || null, burnAfterReading ? 1 : 0, createdAt);
  }
  const message = { id: info.lastInsertRowid, from: payload.id, to: toId, content, createdAt, clientMsgId: clientMsgId || null, replyTo: Number(replyTo) || null, forwardedFrom: Number(forwardedFrom) || null, burnAfterReading: !!burnAfterReading, read: 0 };
  const peer = onlineAny(toId);
  if (peer) sendToUser(toId, P.S_MSG, message);
  sentMsgsThisMinCounter += 1;
  if (peer) recvMsgsThisMinCounter += 1;
  res.json({ ok: true, message });
});

// ---------- 离线文件中转 ----------
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, 'files');
const CALLS_DIR = process.env.CALLS_DIR || path.join(__dirname, 'call-recordings');
try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(CALLS_DIR, { recursive: true }); } catch {}

function apiUser(req) {
  const auth = req.headers.authorization || '';
  return verifyToken(auth.replace(/^Bearer\s+/i, ''));
}

app.post('/api/files', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '文件为空' });
  const toId = parseInt(req.query.to, 10);
  if (!Number.isInteger(toId) || !prepare('SELECT id FROM users WHERE id=?').get(toId)) return res.status(400).json({ error: '接收方无效' });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(payload.id, toId) || prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(toId, payload.id)) return res.status(403).json({ error: '你与对方处于拉黑状态，无法发送文件' });
  const name = String(req.query.name || 'file').trim().slice(0, 240) || 'file';
  const mime = String(req.query.mime || 'application/octet-stream').slice(0, 120);
  const id = crypto.randomUUID();
  const filePath = path.join(FILES_DIR, id + '.bin');
  try {
    fs.writeFileSync(filePath, req.body);
    prepare('INSERT INTO file_transfers(id,from_id,to_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, payload.id, toId, name, mime, req.body.length, filePath, Date.now());
    res.json({ ok: true, id, name, mime, size: req.body.length });
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: '文件保存失败' });
  }
});

// 文件仓库：列出当前用户收发过的文件（云端存储，随取随用，不解压）
app.get('/api/files', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare('SELECT id,from_id,to_id,name,mime,size,created_at FROM file_transfers WHERE from_id=? OR to_id=? ORDER BY created_at DESC LIMIT 500').all(payload.id, payload.id);
  const files = [];
  const meId = payload.id;
  for (const r of rows) {
    if (!fs.existsSync(path.join(FILES_DIR, r.id + '.bin'))) continue;
    const otherId = r.from_id === meId ? r.to_id : r.from_id;
    const other = otherId ? prepare('SELECT username,nickname FROM users WHERE id=?').get(otherId) : null;
    files.push({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      kind: r.from_id === meId ? 'sent' : 'received',
      peer: other ? (other.nickname || other.username) : '未知',
      time: r.created_at,
    });
  }
  res.json({ files });
});

app.get('/api/files/:id', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const file = prepare('SELECT * FROM file_transfers WHERE id=? AND (from_id=? OR to_id=?)').get(req.params.id, payload.id, payload.id);
  if (!file || !fs.existsSync(file.path)) return res.status(404).json({ error: '文件不存在' });
  // 路径遍历防护：验证文件路径在允许目录内
  const resolved = path.resolve(file.path);
  if (!resolved.startsWith(path.resolve(FILES_DIR)) && !resolved.startsWith(path.resolve(CALLS_DIR))) {
    return res.status(403).json({ error: '路径非法' });
  }
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/["\\\r\n]/g, '_')}"`);
  fs.createReadStream(file.path).pipe(res);
});

// ---------- 语音转文字（STT）----------
// 启用方式（任一）：
//   1) 安装 faster-whisper：pip install faster-whisper，并放置 server/stt_whisper.py
//   2) whisper.cpp：设置 STT_WHISPER_CLI（可执行路径）+ STT_WHISPER_MODEL（模型路径）
// 未配置时接口返回 501，客户端降级为纯语音消息。

async function runStt(filePath) {
  const cli = process.env.STT_WHISPER_CLI;
  if (cli) {
    const model = process.env.STT_WHISPER_MODEL || 'ggml-small.bin';
    try {
      await execFile(cli, ['-m', model, '-f', filePath, '-l', 'zh', '-otxt', '-np', '-nt'], { timeout: 120000 });
      return fs.readFileSync(filePath + '.txt', 'utf8').trim() || '…';
    } catch (e) {
      throw new Error(String(e && e.stderr || e && e.message || e).slice(0, 200));
    }
  }
  const script = path.join(__dirname, 'stt_whisper.py');
  if (fs.existsSync(script)) {
    try {
      const { stdout } = await execFile('python', [script, filePath], { timeout: 120000 });
      return String(stdout).trim() || '…';
    } catch (e) {
      throw new Error(String(e && e.stderr || e && e.message || e).slice(0, 200));
    }
  }
  throw new Error('未配置 STT_WHISPER_CLI，或缺少 server/stt_whisper.py');
}

app.post('/api/stt', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = String((req.body && req.body.id) || '');
  const audioB64 = req.body && req.body.audioB64;
  let filePath = null;
  let tmpFile = null;
  if (audioB64 && typeof audioB64 === 'string') {
    try {
      const buf = Buffer.from(audioB64, 'base64');
      if (!buf.length) return res.status(400).json({ error: '音频数据为空' });
      tmpFile = path.join(require('os').tmpdir(), 'scstt-' + crypto.randomUUID() + '.webm');
      fs.writeFileSync(tmpFile, buf);
      filePath = tmpFile;
    } catch (e) { return res.status(400).json({ error: '音频数据无效' }); }
  } else {
    if (!/^[0-9a-f-]{8,}$/.test(id)) return res.status(400).json({ error: '文件 id 无效' });
    const file = prepare('SELECT * FROM file_transfers WHERE id=? AND (from_id=? OR to_id=?)').get(id, payload.id, payload.id);
    if (!file || !fs.existsSync(file.path)) return res.status(404).json({ error: '语音文件不存在' });
    filePath = file.path;
  }
  runStt(filePath)
    .then(text => res.json({ ok: true, text }))
    .catch(e => { console.error('[stt]', e.message); res.status(501).json({ error: '语音转文字服务未启用' }); })
    .finally(() => { if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} } });
});

app.get('/api/call-recordings', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  // 管理员可查看全部用户的通话回放
  const me = prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  const adminOk = !!me && !!me.email && String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').includes(me.email.toLowerCase()) && req.query.all === '1';
  if (adminOk) {
    const rows = prepare(`SELECT r.id,r.from_id AS fromId,r.to_id AS toId,r.kind,r.size,r.created_at AS createdAt,
      uf.username AS fromUsername,uf.nickname AS fromNickname,ut.username AS toUsername,ut.nickname AS toNickname
      FROM call_recordings r LEFT JOIN users uf ON uf.id=r.from_id LEFT JOIN users ut ON ut.id=r.to_id
      ORDER BY r.created_at DESC LIMIT 500`).all();
    return res.json({ recordings: rows, admin: true });
  }
  const peerId = req.query.peer ? parseInt(req.query.peer, 10) : null;
  const rows = peerId
    ? prepare('SELECT id,from_id AS fromId,to_id AS toId,kind,size,created_at AS createdAt FROM call_recordings WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY created_at DESC').all(payload.id, peerId, peerId, payload.id)
    : prepare('SELECT id,from_id AS fromId,to_id AS toId,kind,size,created_at AS createdAt FROM call_recordings WHERE from_id=? OR to_id=? ORDER BY created_at DESC').all(payload.id, payload.id);
  res.json({ recordings: rows });
});

app.post('/api/call-recordings', express.raw({
    // type-is 对带 codecs 参数（如 video/webm;codecs=vp8,opus）的匹配有 bug，改用自定义类型判定
    type: (req) => { const ct = String(req.headers['content-type'] || '').split(';')[0].trim(); return ct === 'video/webm' || ct === 'audio/webm'; },
    limit: '500mb'
  }), (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '回放为空' });
  const toId = parseInt(req.query.to, 10);
  const kind = req.query.kind === 'video' ? 'video' : 'audio';
  if (!Number.isInteger(toId) || !prepare('SELECT id FROM users WHERE id=?').get(toId)) return res.status(400).json({ error: '接收方无效' });
  const areFriends = prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=1').get(payload.id, toId);
  if (!areFriends) return res.status(403).json({ error: '只能录制好友通话' });
  const id = crypto.randomUUID();
  const filePath = path.join(CALLS_DIR, id + '.webm');
  try {
    fs.writeFileSync(filePath, req.body);
    prepare('INSERT INTO call_recordings(id,from_id,to_id,kind,size,path,created_at) VALUES(?,?,?,?,?,?,?)').run(id, payload.id, toId, kind, req.body.length, filePath, Date.now());
    res.json({ ok: true, id, kind, size: req.body.length });
  } catch (e) { try { fs.unlinkSync(filePath); } catch {} ; res.status(500).json({ error: '回放保存失败' }); }
});

app.get('/api/call-recordings/:id', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const row = prepare('SELECT * FROM call_recordings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '回放不存在' });
  // 通话录像仅通话双方可见；被直播间 replay_url 引用的录像视为直播回放，对登录用户开放
  let liveRef = null;
  try {
    liveRef = prepare('SELECT 1 FROM live_rooms WHERE replay_url=? OR replay_url LIKE ?').get('/api/call-recordings/' + req.params.id, '/api/call-recordings/' + req.params.id + '%');
  } catch (e) { /* live_rooms 未建表（直播模块未挂载）时视为无引用 */ }
  if (row.from_id !== payload.id && row.to_id !== payload.id && !liveRef) {
    // 管理员可查看所有回放
    const meA = prepare('SELECT * FROM users WHERE id=?').get(payload.id);
    const adminOk = !!meA && !!meA.email && String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').includes(meA.email.toLowerCase());
    if (!adminOk) return res.status(404).json({ error: '回放不存在' });
  }
  if (!fs.existsSync(row.path)) return res.status(404).json({ error: '回放不存在' });
  const resolved = path.resolve(row.path);
  if (!resolved.startsWith(path.resolve(CALLS_DIR))) return res.status(403).json({ error: '路径非法' });
  res.setHeader('Content-Type', row.kind === 'audio' ? 'audio/webm' : 'video/webm');
  fs.createReadStream(resolved).pipe(res);
});

// ---------- 群组 ----------
// 建群：POST /api/group/create { name }
app.post('/api/group/create', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const name = (req.body || {}).name;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '群名不能为空' });
  const groupName = String(name).trim().slice(0, 50);
  const sw = checkSensitive(groupName);
  if (sw) return res.status(400).json({ error: '群名包含敏感词：' + sw });
  const now = Date.now();
  const info = prepare('INSERT INTO groups(name,owner_id,created_at) VALUES(?,?,?)')
    .run(groupName, payload.id, now);
  const groupId = info.lastInsertRowid;
  prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)')
    .run(groupId, payload.id, now);
  res.json({ ok: true, group: { id: groupId, name: groupName, ownerId: payload.id } });
  broadcastGroups();
});

// 加群：POST /api/group/join { groupId }
// 要求：请求者必须是群成员（或由群主/管理员操作）
app.post('/api/group/join', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const groupId = parseInt((req.body || {}).groupId, 10);
  if (!groupId) return res.status(400).json({ error: '群ID不能为空' });
  const g = prepare('SELECT id FROM groups WHERE id=?').get(groupId);
  if (!g) return res.status(404).json({ error: '群不存在' });
  const member = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!member) return res.status(403).json({ error: '你不是该群成员' });
  prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)')
    .run(groupId, payload.id, Date.now());
  res.json({ ok: true });
  broadcastGroups();
});

// 邀请入群：POST /api/group/invite { groupId, uid }
// 要求：请求者必须是群成员
app.post('/api/group/invite', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const body = req.body || {};
  const groupId = parseInt(body.groupId, 10);
  const uid = body.uid;
  if (!groupId) return res.status(400).json({ error: '群ID不能为空' });
  if (!uid) return res.status(400).json({ error: '对方UID不能为空' });
  const g = prepare('SELECT id FROM groups WHERE id=?').get(groupId);
  if (!g) return res.status(404).json({ error: '群不存在' });
  const inviter = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!inviter) return res.status(403).json({ error: '你不是该群成员，无法邀请' });
  const target = prepare('SELECT id FROM users WHERE uid=?').get(uid);
  if (!target) return res.status(404).json({ error: '该UID不存在' });
  const exists = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, target.id);
  if (exists) return res.status(409).json({ error: '该用户已是群成员' });
  prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)')
    .run(groupId, target.id, Date.now());
  res.json({ ok: true, userId: target.id });
  broadcastGroups();
});

// 群消息历史：返回全部历史记录，不删除、不截断
app.get('/api/group/:id/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const groupId = parseInt(req.params.id, 10);
  if (!groupId) return res.status(400).json({ error: '群ID错误' });
  const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!isMember) return res.status(403).json({ error: '你不在此群' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = prepare(
    `SELECT gm.id, gm.group_id AS groupId, gm.from_id AS fromId, gm.content, gm.created_at AS createdAt,
            u.id AS userId, u.username, u.nickname, u.avatar, u.uid AS userUid
      FROM group_messages gm LEFT JOIN users u ON u.id = gm.from_id
      LEFT JOIN group_message_meta gmm ON gmm.message_id = gm.id
      WHERE gm.group_id=? ORDER BY gm.created_at DESC LIMIT ? OFFSET ?`
  ).all(groupId, limit, offset);
  const msgs = rows.reverse().map(r => ({
    id: r.id, groupId: r.groupId, from: r.fromId, content: r.content, createdAt: r.createdAt,
    fromUser: { id: r.userId, username: r.username, nickname: r.nickname, avatar: r.avatar, uid: r.userUid },
    pinned: !!r.pinned, replyTo: r.replyTo || null
  }));
  res.json({ messages: msgs });
});

// 群成员列表：GET /api/group/:id/members
app.get('/api/group/:id/members', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const groupId = parseInt(req.params.id, 10);
  if (!groupId) return res.status(400).json({ error: '群ID错误' });
  const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!isMember) return res.status(403).json({ error: '你不在此群' });
  const members = prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.uid AS uid FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id=? ORDER BY gm.joined_at ASC`
  ).all(groupId).map(m => ({ ...m, online: onlineHas(m.id) }));
  const group = prepare('SELECT g.id, g.name, g.owner_id AS ownerId FROM groups g WHERE g.id=?').get(groupId);
  const memberIds = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId).map(r => r.user_id);
  res.json({ members, group: { id: group.id, name: group.name, ownerId: group.ownerId, memberCount: memberIds.length } });
});

// 我所在的所有群（初始加载用）：GET /api/groups
app.get('/api/groups', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  res.json({ groups: buildGroupsForUser(payload.id) });
});

// =============================== 朋友圈 ===============================
// 发布动态：POST /api/moments { content, images:[] }
app.post('/api/moments', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { content, images } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: '内容不能为空' });
  }
  if (content.length > 10000) return res.status(400).json({ error: '内容过长（限1万字）' });
  const img = Array.isArray(images) ? JSON.stringify(images.slice(0, 9).map(s => String(s).slice(0, 500))) : '[]';
  const info = prepare('INSERT INTO moments(user_id,content,images,visibility,created_at) VALUES(?,?,?,?,?)')
    .run(payload.id, content.trim(), img, 'all', Date.now());
  persist();
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 朋友圈 feed：GET /api/moments?offset=&limit=  （返回好友 + 自己，按时间倒序）
app.get('/api/moments', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  // 好友 id 集合 + 自己
  const friendIds = prepare('SELECT friend_id FROM friends WHERE user_id=? AND status=1').all(payload.id).map(r => r.friend_id);
  friendIds.push(payload.id);
  // 取可见的动态（ALL；私密 nobody/just 暂只返回自己发的）
  const rows = prepare(
    `SELECT m.id,m.user_id AS userId,m.content AS content,m.images,m.created_at AS createdAt,
            u.nickname,u.avatar,u.uid
     FROM moments m JOIN users u ON u.id=m.user_id
     WHERE m.user_id IN (${friendIds.map(()=>'?').join(',')})
     ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
  ).all(...friendIds, limit, offset);
  // 补点赞与评论
  // 批量查点赞/评论，避免 N+1
  const momentIds = rows.map(m => m.id);
  const allLikes = momentIds.length ? prepare('SELECT moment_id,user_id FROM moment_likes WHERE moment_id IN (' + momentIds.map(()=>'?').join(',') + ') ORDER BY created_at').all(...momentIds) : [];
  const allComments = momentIds.length ? prepare(
    `SELECT c.id,c.moment_id AS momentId,c.user_id AS userId,c.content AS content,c.created_at AS createdAt,u.nickname
     FROM moment_comments c JOIN users u ON u.id=c.user_id WHERE c.moment_id IN (` + momentIds.map(()=>'?').join(',') + `) ORDER BY c.created_at ASC`
  ).all(...momentIds) : [];
  const likesByMoment = new Map(); const commentsByMoment = new Map();
  for (const l of allLikes) { if (!likesByMoment.has(l.moment_id)) likesByMoment.set(l.moment_id, []); likesByMoment.get(l.moment_id).push(l.user_id); }
  for (const c of allComments) { if (!commentsByMoment.has(c.momentId)) commentsByMoment.set(c.momentId, []); commentsByMoment.get(c.momentId).push(c); }
  const data = rows.map(m => {
    const likes = likesByMoment.get(m.id) || [];
    const comments = commentsByMoment.get(m.id) || [];
    try { m.images = JSON.parse(m.images || '[]'); } catch { m.images = []; }
    m.likeCount = likes.length;
    m.likedByMe = likes.includes(payload.id);
    m.comments = comments;
    return m;
  });
  res.json({ moments: data, hasMore: rows.length === limit });
});

// 点赞/取消：POST /api/moments/:id/like { on:true|false }
// 朋友圈互动权限：仅好友可点赞/评论，且双方不在黑名单
function momentInteractGuard(req, res, id) {
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) { res.status(401).json({ error: '未授权' }); return null; }
  const m = prepare('SELECT id,user_id FROM moments WHERE id=?').get(id);
  if (!m) { res.status(404).json({ error: '动态不存在' }); return null; }
  if (m.user_id !== payload.id) {
    const isFriend = !!prepare('SELECT 1 FROM friends WHERE status=1 AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))').get(payload.id, m.user_id, m.user_id, payload.id);
    if (!isFriend) { res.status(403).json({ error: '仅好友可互动' }); return null; }
  }
  const blocked = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(payload.id, m.user_id, m.user_id, payload.id);
  if (blocked) { res.status(403).json({ error: '无法互动' }); return null; }
  return payload;
}

app.post('/api/moments/:id/like', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const id = parseInt(req.params.id, 10);
  const payload = momentInteractGuard(req, res, id);
  if (!payload) return;
  const on = req.body && req.body.on !== false;
  if (on) prepare('INSERT OR IGNORE INTO moment_likes(moment_id,user_id,created_at) VALUES(?,?,?)').run(id, payload.id, Date.now());
  else prepare('DELETE FROM moment_likes WHERE moment_id=? AND user_id=?').run(id, payload.id);
  persist();
  res.json({ ok: true, liked: on });
});

// 评论：POST /api/moments/:id/comment { content, replyToId? }
app.post('/api/moments/:id/comment', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const id = parseInt(req.params.id, 10);
  const payload = momentInteractGuard(req, res, id);
  if (!payload) return;
  const { content, replyToId } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '评论不能为空' });
  let replyTo = null;
  if (replyToId) {
    const parent = prepare('SELECT id FROM moment_comments WHERE id=? AND moment_id=?').get(Number(replyToId), id);
    if (!parent) return res.status(400).json({ error: '被回复的评论不存在' });
    replyTo = parent.id;
  }
  prepare('INSERT INTO moment_comments(moment_id,user_id,reply_to_id,content,created_at) VALUES(?,?,?,?,?)')
    .run(id, payload.id, replyTo, content.trim(), Date.now());
  persist();
  res.json({ ok: true });
});

// =============================== 钱包 / 兑换码 ===============================
// 我的钱包：GET /api/wallet
app.get('/api/wallet', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  let w = prepare('SELECT balance,total_received FROM wallets WHERE user_id=?').get(payload.id);
  if (!w) { prepare('INSERT INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(payload.id, Date.now()); w = { balance: 0, total_received: 0 }; }
  res.json({ balance: w.balance, totalReceived: w.total_received });
});

// 兑换码充值：POST /api/wallet/redeem { code }
app.post('/api/wallet/redeem', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const ip = getIp(req);
  if (rateLimit('redeem:' + ip, 20, 60 * 1000)) return res.status(429).json({ error: '尝试过于频繁' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入兑换码' });
  try {
    db.run('BEGIN IMMEDIATE');
    const c = prepare('SELECT code,value,claimed_by FROM redeem_codes WHERE code=?').get(code);
    if (!c) { db.run('ROLLBACK'); return res.status(404).json({ error: '兑换码不存在' }); }
    if (c.claimed_by) { db.run('ROLLBACK'); return res.status(409).json({ error: '兑换码已被使用' }); }
    prepare('UPDATE redeem_codes SET claimed_by=?,claimed_at=? WHERE code=?').run(payload.id, Date.now(), code);
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(payload.id, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(c.value, c.value, Date.now(), payload.id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)').run(payload.id, 'recharge', c.value, '兑换码充值', Date.now());
    db.run('COMMIT');
    persist();
    const w = prepare('SELECT balance FROM wallets WHERE user_id=?').get(payload.id);
    res.json({ ok: true, balance: w.balance, value: c.value });
  } catch (e) { try { db.run('ROLLBACK'); } catch {} res.status(500).json({ error: '兑换失败' }); }
});

// 转账：POST /api/wallet/transfer { toUid, amount, remark }
app.post('/api/wallet/transfer', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { toUid, amount, remark } = req.body || {};
  const target = prepare('SELECT id FROM users WHERE uid=?').get(String(toUid || ''));
  if (!target) return res.status(404).json({ error: '收款人不存在' });
  if (target.id === payload.id) return res.status(400).json({ error: '不能转给自己' });
  const value = parseFloat(amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: '金额无效' });
  try {
    db.run('BEGIN IMMEDIATE');
    const my = prepare('SELECT balance FROM wallets WHERE user_id=?').get(payload.id);
    if (!my || my.balance < value) { db.run('ROLLBACK'); return res.status(400).json({ error: '余额不足' }); }
    prepare('UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=?').run(value, Date.now(), payload.id);
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,?,?,?)').run(target.id, 0, 0, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(value, value, Date.now(), target.id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)').run(payload.id, 'out', value, target.id, remark || '转账', Date.now());
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)').run(target.id, 'in', value, payload.id, remark || '收到转账', Date.now());
    db.run('COMMIT');
    persist();
    res.json({ ok: true, balance: (prepare('SELECT balance FROM wallets WHERE user_id=?').get(payload.id)).balance });
  } catch (e) { try { db.run('ROLLBACK'); } catch {} res.status(500).json({ error: '转账失败' }); }
});

// 我的交易记录：GET /api/wallet/txn
app.get('/api/wallet/txn', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
    `SELECT t.id,t.kind,t.amount,t.remark,t.created_at AS createdAt,u.nickname AS peerName,u.uid AS peerUid
     FROM wallet_txn t LEFT JOIN users u ON u.id=t.peer_id WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 200`
  ).all(payload.id);
  res.json({ txn: rows });
});

// ============ 在线充值（EPay 真实支付）============
let _rechargeTableReady = false;
function ensureRechargeTable() {
  if (_rechargeTableReady) return;
  try {
    prepare(`CREATE TABLE IF NOT EXISTS wallet_recharges (
      order_no TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount FLOAT NOT NULL,
      type TEXT NOT NULL DEFAULT 'alipay', status TEXT NOT NULL DEFAULT 'pending',
      trade_no TEXT, created_at INTEGER NOT NULL, paid_at INTEGER
    )`).run();
    _rechargeTableReady = true;
  } catch (e) { console.error('[wallet] create recharge table failed: ' + (e && e.message || e)); }
}

function epayConfigRead() {
  try {
    const row = prepare('SELECT value FROM settings WHERE key=?').get('epay_config');
    return row ? JSON.parse(row.value) : {};
  } catch (e) { return {}; }
}
function epaySignOf(params, key) {
  const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null).sort();
  const qs = keys.map(k => k + '=' + params[k]).join('&');
  return crypto.createHash('md5').update(qs + key, 'utf8').digest('hex');
}

// 用户发起在线充值：POST /api/wallet/recharge { amount, type }
app.post('/api/wallet/recharge', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const c = epayConfigRead();
  if (!c.enabled || !c.key || !c.merchantPid) return res.status(503).json({ error: '在线充值暂未开启，可使用兑换码充值' });
  const amount = Math.round(parseFloat((req.body || {}).amount) * 100) / 100;
  const type = ['alipay', 'wxpay', 'qqpay'].includes((req.body || {}).type) ? req.body.type : 'alipay';
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 50000) return res.status(400).json({ error: '金额无效（0.01 ~ 50000）' });
  const orderNo = 'WR' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
  ensureRechargeTable();
  prepare('INSERT INTO wallet_recharges(order_no,user_id,amount,type,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(orderNo, payload.id, amount, type, 'pending', Date.now());
  persist();
  const base = process.env.PUBLIC_BASE_URL || ('https://' + (req.headers.host || 'mc.32768.top:8888'));
  const params = {
    pid: String(c.merchantPid),
    type,
    out_trade_no: orderNo,
    notify_url: base + '/api/wallet/recharge/notify',
    return_url: base + '/wallet-pay.html',
    name: 'SecureChat钱包充值',
    money: amount.toFixed(2)
  };
  params.sign = epaySignOf(params, c.key);
  params.sign_type = 'MD5';
  const gateway = (c.gatewayUrl || ((c.baseUrl || '').replace(/\/$/, '') + '/submit.php'));
  const query = Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  res.json({ ok: true, orderNo, amount, payUrl: gateway + (gateway.includes('?') ? '&' : '?') + query });
});

// 充值状态轮询：GET /api/wallet/recharge/status?orderNo=
app.get('/api/wallet/recharge/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  ensureRechargeTable();
  const r = prepare('SELECT * FROM wallet_recharges WHERE order_no=? AND user_id=?').get(String(req.query.orderNo || ''), payload.id);
  if (!r) return res.status(404).json({ error: '订单不存在' });
  res.json({ status: r.status, amount: r.amount });
});

// 易支付异步回调：验签 → 幂等入账。标准协议响应纯文本 success
app.all('/api/wallet/recharge/notify', (req, res) => {
  if (!ready) return res.status(503).send('fail');
  const p = Object.assign({}, req.query || {}, req.body || {});
  const c = epayConfigRead();
  if (!c.key) return res.status(503).send('fail');
  // 兼容两种签名密钥：商户密钥（外部易支付）与内置网关密钥（.epaygw_key.json）
  let signOk = epaySignOf(p, c.key) === String(p.sign || '').toLowerCase();
  if (!signOk) {
    try {
      const gw = JSON.parse(fs.readFileSync(path.join(__dirname, '.epaygw_key.json'), 'utf8'));
      if (gw && gw.key) signOk = epaySignOf(p, gw.key) === String(p.sign || '').toLowerCase();
    } catch (e) {}
  }
  if (!signOk) {
    console.log('[wallet] recharge notify sign mismatch: ' + JSON.stringify(p).slice(0, 300));
    return res.send('sign error');
  }
  if (String(p.trade_status || '') !== 'TRADE_SUCCESS') return res.send('success');
  ensureRechargeTable();
  try {
    db.run('BEGIN IMMEDIATE');
    const r = prepare('SELECT * FROM wallet_recharges WHERE order_no=?').get(String(p.out_trade_no || ''));
    if (!r) { db.run('ROLLBACK'); return res.send('order not found'); }
    if (r.status === 'paid') { db.run('ROLLBACK'); return res.send('success'); }
    if (Math.abs(Number(r.amount) - Number(p.money)) > 0.001) {
      console.log('[wallet] recharge money mismatch: order=' + r.amount + ' notify=' + p.money);
      db.run('ROLLBACK'); return res.send('money mismatch');
    }
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(r.user_id, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(r.amount, r.amount, Date.now(), r.user_id);
    prepare('UPDATE wallet_recharges SET status=?,trade_no=?,paid_at=? WHERE order_no=?').run('paid', String(p.trade_no || ''), Date.now(), r.order_no);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)')
      .run(r.user_id, 'recharge', r.amount, '在线充值(' + (p.trade_no || '') + ')', Date.now());
    db.run('COMMIT');
    persist();
    console.log('[wallet] recharged: user=' + r.user_id + ' +' + r.amount);
    res.send('success');
  } catch (e) { try { db.run('ROLLBACK'); } catch {} res.send('error'); }
});

// 状态：GET my status / SET 状态（微信『我的状态』）
app.get('/api/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const s = prepare('SELECT text,icon,emoji,updated_at AS updatedAt FROM user_status WHERE user_id=?').get(payload.id);
  res.json({ status: s || null });
});
app.post('/api/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { text, icon, emoji } = req.body || {};
  const stText = String(text || '').slice(0, 100);
  const stIcon = String(icon || '').slice(0, 10);
  const stEmoji = String(emoji || '').slice(0, 10);
  prepare('INSERT INTO user_status(user_id,text,icon,emoji,updated_at) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET text=excluded.text,icon=excluded.icon,emoji=excluded.emoji,updated_at=excluded.updated_at')
    .run(payload.id, stText, stIcon, stEmoji, Date.now());
  persist();
  res.json({ ok: true });
});

// =============================== 视频号 ===============================
// 发布短视频：POST /api/videos { title, cover, content }
app.post('/api/videos', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { title, cover, content } = req.body || {};
  const t = String(title || '').trim();
  if (!t) return res.status(400).json({ error: '标题不能为空' });
  if (t.length > 120) return res.status(400).json({ error: '标题过长（限120字）' });
  if (String(cover || '').length > 2048) return res.status(400).json({ error: '封面地址过长' });
  if (String(content || '').length > 20000) return res.status(400).json({ error: '内容过长（限2万字）' });
  prepare('INSERT INTO videos(user_id,title,cover,content,created_at) VALUES(?,?,?,?,?)')
    .run(payload.id, t, String(cover || ''), String(content || ''), Date.now());
  persist();
  res.json({ ok: true });
});
// 视频流：GET /api/videos
app.get('/api/videos', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
    `SELECT v.id,v.user_id AS userId,v.title,v.cover,v.content,v.created_at AS createdAt,v.likes AS likeCount,
            u.nickname,u.avatar
     FROM videos v JOIN users u ON u.id=v.user_id ORDER BY v.created_at DESC LIMIT 100`
  ).all();
  // 批量查点赞状态，避免 N+1
  const videoIds = rows.map(v => v.id);
  const likedIds = videoIds.length ? prepare('SELECT video_id FROM video_likes WHERE user_id=? AND video_id IN (' + videoIds.map(()=>'?').join(',') + ')').all(payload.id, ...videoIds).map(r => r.video_id) : new Set();
  const likedSet = new Set(likedIds);
  const data = rows.map(v => ({ ...v, likedByMe: likedSet.has(v.id) }));
  res.json({ videos: data });
});
// 点赞：POST /api/videos/:id/like { on }
app.post('/api/videos/:id/like', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id);
  if (!prepare('SELECT id FROM videos WHERE id=?').get(id)) return res.status(404).json({ error: '视频不存在' });
  const on = req.body && req.body.on !== false;
  if (on) {
    const r = prepare('INSERT OR IGNORE INTO video_likes(video_id,user_id,created_at) VALUES(?,?,?)').run(id, payload.id, Date.now());
    if (r.changes > 0) prepare('UPDATE videos SET likes=likes+1 WHERE id=?').run(id);
  } else { const d = prepare('DELETE FROM video_likes WHERE video_id=? AND user_id=?').run(id, payload.id); if (d.changes > 0) prepare('UPDATE videos SET likes=MAX(0,likes-1) WHERE id=?').run(id); }
  persist();
  res.json({ ok: true, liked: on });
});
// 评论：POST /api/videos/:id/comment { content }
app.post('/api/videos/:id/comment', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id);
  if (!prepare('SELECT id FROM videos WHERE id=?').get(id)) return res.status(404).json({ error: '视频不存在' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '评论不能为空' });
  if (content.length > 1000) return res.status(400).json({ error: '评论过长（限1000字）' });
  prepare('INSERT INTO video_comments(video_id,user_id,content,created_at) VALUES(?,?,?,?)').run(id, payload.id, content, Date.now());
  persist();
  res.json({ ok: true });
});

// =============================== 公众号 ===============================
// 关注列表：GET /api/accounts
app.get('/api/accounts', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const accounts = prepare(
    `SELECT a.id,a.name,a.avatar,a.intro, (SELECT COUNT(*) FROM account_follows af WHERE af.account_id=a.id AND af.user_id=?) AS followed
     FROM official_accounts a ORDER BY a.id`
  ).all(payload.id);
  res.json({ accounts });
});
// 账号文章：GET /api/accounts/:id/posts ; 关注/取关：POST /api/accounts/:id/follow { on }
app.post('/api/accounts/:id/follow', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id);
  if (!prepare('SELECT id FROM official_accounts WHERE id=?').get(id)) return res.status(404).json({ error: '公众号不存在' });
  const on = req.body && req.body.on !== false;
  if (on) prepare('INSERT OR IGNORE INTO account_follows(account_id,user_id,created_at) VALUES(?,?,?)').run(id, payload.id, Date.now());
  else prepare('DELETE FROM account_follows WHERE account_id=? AND user_id=?').run(id, payload.id);
  persist();
  res.json({ ok: true, followed: on });
});
app.get('/api/accounts/:id/posts', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id);
  const posts = prepare('SELECT id,title,content,created_at AS createdAt FROM account_posts WHERE account_id=? ORDER BY created_at DESC').all(id);
  res.json({ posts });
});
// 管理端发文章：POST /api/accounts/:id/post { title, content }
app.post('/api/accounts/:id/post', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number(req.params.id);
  const title = String((req.body || {}).title || '').trim();
  const content = String((req.body || {}).content || '').trim();
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
  prepare('INSERT INTO account_posts(account_id,title,content,created_at) VALUES(?,?,?,?)').run(id, title, content, Date.now());
  persist();
  res.json({ ok: true });
});

// =============================== 小程序 ===============================
app.get('/api/mini-apps', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const apps = prepare('SELECT id,name,icon,desc AS description,url FROM mini_apps ORDER BY id').all();
  res.json({ apps });
});

// =============================== 拍一拍 ===============================
// POST /api/poke { to }  —— 好友拍一拍
app.post('/api/poke', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const to = Number((req.body || {}).to);
  if (!to || !prepare('SELECT id FROM users WHERE id=?').get(to)) return res.status(404).json({ error: '用户不存在' });
  if (to === payload.id) return res.status(400).json({ error: '不能拍自己' });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(payload.id, to) || prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(to, payload.id)) return res.status(403).json({ error: '你与对方处于拉黑状态，无法拍一拍' });
  prepare('INSERT INTO pokes(from_id,to_id,created_at) VALUES(?,?,?)').run(payload.id, to, Date.now());
  persist();
  const me = prepare('SELECT nickname FROM users WHERE id=?').get(payload.id);
  sendToUser(to, 'poke', { fromId: payload.id, fromNick: me.nickname, at: Date.now() });
  res.json({ ok: true });
});

// =============================== 收藏 · 笔记 ===============================
// 我的收藏/笔记列表：GET /api/favorites?type=note|message|file
// 新建笔记：POST /api/notes { content }  删除：DELETE /api/notes/:id
app.post('/api/notes', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  prepare('INSERT INTO favorites(user_id,type,content,created_at) VALUES(?,?,?,?)').run(payload.id, 'note', content, Date.now());
  persist();
  res.json({ ok: true });
});
app.get('/api/notes', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare('SELECT id,content,created_at AS createdAt FROM favorites WHERE user_id=? AND type="note" ORDER BY created_at DESC').all(payload.id);
  res.json({ notes: rows });
});
app.delete('/api/notes/:id', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  prepare('DELETE FROM favorites WHERE id=? AND user_id=? AND type="note"').run(Number(req.params.id), payload.id);
  persist();
  res.json({ ok: true });
});

// ---------- 反馈 / Bug 上报 ----------
// 提交反馈：POST /api/feedback { kind, content }
app.post('/api/feedback', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { kind, content } = req.body || {};
  const validKinds = ['bug', 'suggestion', 'complaint', 'other'];
  if (!kind || !validKinds.includes(kind)) {
    return res.status(400).json({ error: '反馈类型无效（bug/suggestion/complaint/other）' });
  }
  if (typeof content !== 'string' || content.trim().length < 10) {
    return res.status(400).json({ error: '内容至少 10 字' });
  }
  const sw = checkSensitive(content);
  if (sw) return res.status(400).json({ error: '内容包含敏感词：' + sw });
  const now = Date.now();
  prepare('INSERT INTO feedbacks(user_id,kind,content,status,created_at) VALUES(?,?,?,?,?)')
    .run(payload.id, kind, content.trim(), 'open', now);
  res.json({ ok: true });
});

// 我的反馈列表：GET /api/feedback
app.get('/api/feedback', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare('SELECT id, kind, content, status, created_at FROM feedbacks WHERE user_id=? ORDER BY created_at DESC')
    .all(payload.id);
  res.json({ feedbacks: rows });
});

// 管理员更新反馈状态：open / processing / closed
app.post('/api/admin/feedback/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = parseInt((req.body || {}).id, 10);
  const status = (req.body || {}).status;
  if (!id || !['open', 'processing', 'closed'].includes(status)) {
    return res.status(400).json({ error: '反馈编号或状态无效' });
  }
  const row = prepare('SELECT id FROM feedbacks WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '反馈不存在' });
  prepare('UPDATE feedbacks SET status=? WHERE id=?').run(status, id);
  res.json({ ok: true, id, status });
});

// 构造某用户所在的所有群（含成员名单 + 最近一条消息预览）
function buildGroupsForUser(userId) {
  const groups = prepare(
    `SELECT g.id, g.name, g.owner_id AS ownerId, g.created_at AS createdAt
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id=? ORDER BY g.id`
  ).all(userId);
  return groups.map(g => {
    const members = prepare(
      `SELECT u.id, u.username, u.nickname, u.avatar, u.uid, u.email, u.country, u.province, u.city, u.extra
       FROM group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id=? ORDER BY m.joined_at`
    ).all(g.id).map(m => ({ ...publicUser(m), online: onlineHas(m.id) }));
    const last = prepare(
      `SELECT gm.id, gm.from_id AS fromId, gm.content, gm.created_at AS createdAt,
              u.id AS userId, u.username, u.nickname, u.avatar, u.uid AS userUid
       FROM group_messages gm LEFT JOIN users u ON u.id = gm.from_id
       WHERE gm.group_id=? ORDER BY gm.created_at DESC LIMIT 1`
    ).get(g.id);
    let lastMessage = null;
    if (last) {
      lastMessage = {
        id: last.id, from: last.fromId, content: last.content, createdAt: last.createdAt,
        fromUser: { id: last.userId, username: last.username, nickname: last.nickname, avatar: last.avatar, uid: last.userUid }
      };
    }
    return { id: g.id, name: g.name, ownerId: g.ownerId, members, lastMessage, unread: 0 };
  });
}

// 给所有在线用户推送其所在群列表
function broadcastGroups() {
  for (const [uid, list] of online.entries()) {
    for (const ws of list) {
      if (ws.uid == null) continue;
      send(ws, P.S_GROUP_LIST, { groups: buildGroupsForUser(ws.uid) });
    }
  }
}

// ---------- 版本信息 / 自动更新 ----------
// 版本配置持久化到 {DATA_DIR}/version.json；/downloads 目录中的安装包会被动态扫描。
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data'); // 与 db.js 保持一致（随工作目录定位）
const VERSION_FILE = path.join(DATA_DIR, 'version.json');
// In an EXE, __dirname points into pkg's read-only snapshot.  Downloads are
// deliberately external so administrators can upload/replace packages.
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');
const DEFAULT_VERSION_CONFIG = { current: '1.0.0', latest: '1.0.0', releaseNotes: '首次发布', updatedAt: 0 };
// platform -> 文件名段 + 扩展名（windowsPortable 的段是 windows，用扩展名 zip 与 exe 区分）
const PLATFORM_FILES = {
  windows:         { seg: 'windows', ext: 'exe' },
  macos:           { seg: 'macos',   ext: 'dmg' },
  android:         { seg: 'android', ext: 'apk' },
  harmony:         { seg: 'harmony', ext: 'hap' },
  ios:             { seg: 'ios',     ext: 'ipa' },
  windowsPortable: { seg: 'windows', ext: 'zip' }
};

// ---------- 管理员整包更新（上传与应用分离，避免上传请求中途重启） ----------
const UPDATE_PACKAGES_DIR = path.join(__dirname, 'update-packages');
const UPDATE_BACKUPS_DIR = path.join(UPDATE_PACKAGES_DIR, 'backups');
const UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
let updateStatus = { state: 'idle', updatedAt: 0 };

function zipEntryNames(buf) {
  // Read the central directory ourselves before invoking Expand-Archive. This is
  // important because extraction tools must never be trusted with ../ names.
  if (buf.length < 22) throw new Error('不是有效的 ZIP 文件');
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 更新包');
  }
  if (cdOffset + cdSize > eocd || cdOffset + cdSize > buf.length) throw new Error('ZIP 中央目录越界');
  const names = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.split('/').includes('..')) {
      throw new Error('ZIP 包含不安全路径: ' + name);
    }
    // Unix mode 0120000 denotes a symbolic link. Reject links even when their
    // names look safe: they could redirect extraction outside the temp folder.
    const externalAttrs = buf.readUInt32LE(at + 38);
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) throw new Error('ZIP 不允许符号链接');
    names.push(name);
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.some(n => n === 'server/index.js' || n === 'web/index.html')) {
    throw new Error('更新包必须包含 server/index.js 或 web/index.html');
  }
  for (const name of names) {
    if (!(name.startsWith('web/') || name.startsWith('server/') || name.startsWith('portable/') || name === 'data/version.json')) {
      throw new Error('ZIP 含有不允许更新的路径: ' + name);
    }
    if (name.startsWith('server/update-packages/')) throw new Error('不允许更新包覆盖自身存储目录');
    if (name.startsWith('data/') && name !== 'data/version.json') throw new Error('只允许更新 data/version.json');
  }
  return names;
}

function quotePowerShell(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
async function extractZip(zipPath, destination) {
  const command = 'Expand-Archive -LiteralPath ' + quotePowerShell(zipPath) + ' -DestinationPath ' + quotePowerShell(destination) + ' -Force';
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

function copyTree(source, destination, preserveUpdatePackages) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (preserveUpdatePackages && entry.name === 'update-packages') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, false);
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}

function clearTree(source, preserveUpdatePackages) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source)) {
    if (preserveUpdatePackages && entry === 'update-packages') continue;
    fs.rmSync(path.join(source, entry), { recursive: true, force: true });
  }
}

function backupAndApply(extracted, backup) {
  fs.mkdirSync(backup, { recursive: true });
  const targets = [
    ['web', path.join(__dirname, '..', 'web'), false],
    ['server', __dirname, true],
    ['portable', path.join(__dirname, '..', 'portable'), false]
  ];
  for (const [name, target, preserve] of targets) {
    if (fs.existsSync(target)) copyTree(target, path.join(backup, name), preserve);
    const incoming = path.join(extracted, name);
    if (fs.existsSync(incoming)) {
      // Replacement is intentional: stale files from the previous release must
      // not remain active. The package archive itself stays outside this clear.
      clearTree(target, preserve);
      copyTree(incoming, target, preserve);
    }
  }
  if (fs.existsSync(VERSION_FILE)) {
    fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
    fs.copyFileSync(VERSION_FILE, path.join(backup, 'data', 'version.json'));
  }
  const incomingVersion = path.join(extracted, 'data', 'version.json');
  if (fs.existsSync(incomingVersion)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(incomingVersion, VERSION_FILE);
  }
}

function scheduleRestart() {
  setTimeout(() => {
    persist();
    // Release the listening socket before starting the replacement process;
    // otherwise Windows commonly lets the child lose the port race.
    server.close(() => {
      const child = childProcess.spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: 'ignore', windowsHide: true, env: process.env
      });
      child.unref();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }, 250).unref();
}

app.get('/api/admin/update-status', (req, res) => {
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  res.json({ ok: true, update: updateStatus });
});

app.post('/api/admin/update-package', express.raw({ type: 'application/octet-stream', limit: '1gb' }), async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '上传内容为空' });
  if (req.body.length > UPDATE_MAX_BYTES) return res.status(413).json({ error: '更新包超过 1GB 限制' });
  const id = Date.now() + '-' + process.pid;
  const zipPath = path.join(UPDATE_PACKAGES_DIR, id + '.zip');
  const extracted = path.join(UPDATE_PACKAGES_DIR, id + '-extracted');
  try {
    fs.mkdirSync(UPDATE_PACKAGES_DIR, { recursive: true });
    zipEntryNames(req.body);
    fs.writeFileSync(zipPath, req.body, { flag: 'wx' });
    await extractZip(zipPath, extracted);
    updateStatus = { state: 'pending', package: path.basename(zipPath), extracted: path.basename(extracted), size: req.body.length, updatedAt: Date.now() };
    // 管理后台上传时可使用 ?apply=true 一步完成上传、替换和重启；默认仍只上传待审核。
    if (String(req.query.apply || '').toLowerCase() === 'true') {
      const backup = path.join(UPDATE_BACKUPS_DIR, String(Date.now()));
      backupAndApply(extracted, backup);
      updateStatus = { ...updateStatus, state: 'applied', backup, updatedAt: Date.now(), restartScheduled: true };
      res.json({ ok: true, state: 'applied', restartScheduled: true, backup });
      scheduleRestart();
    } else {
      res.json({ ok: true, state: 'pending', apply: '/api/admin/update-package/apply', size: req.body.length });
    }
  } catch (err) {
    try { fs.rmSync(extracted, { recursive: true, force: true }); fs.rmSync(zipPath, { force: true }); } catch {}
    updateStatus = { state: 'failed', error: err.message, updatedAt: Date.now() };
    console.error('[update] verify failed:', err.message);
    res.status(400).json({ error: '更新包校验或解压失败' });
  }
});

app.post('/api/admin/update-package/apply', async (req, res) => {
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  if (updateStatus.state !== 'pending') return res.status(409).json({ error: '没有待应用的更新包', update: updateStatus });
  const extracted = path.join(UPDATE_PACKAGES_DIR, updateStatus.extracted);
  const backup = path.join(UPDATE_BACKUPS_DIR, String(Date.now()));
  try {
    backupAndApply(extracted, backup);
    updateStatus = { ...updateStatus, state: 'applied', backup: path.relative(process.cwd(), backup), updatedAt: Date.now(), restartScheduled: true };
    res.json({ ok: true, state: 'applied', backup: updateStatus.backup, restartScheduled: true });
    scheduleRestart();
  } catch (err) {
    updateStatus = { ...updateStatus, state: 'failed', error: err.message, updatedAt: Date.now() };
    console.error('[update] apply failed:', err.message);
    res.status(500).json({ error: '应用更新失败', backup });
  }
});

function getVersionConfig() {
  try {
    // 去掉可能的 UTF-8 BOM：带 BOM 时 JSON.parse 会抛错，导致静默回退到 1.0.0 默认值
    const cfg = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!cfg || typeof cfg !== 'object') throw new Error('invalid version.json');
    return {
      current: String(cfg.current || DEFAULT_VERSION_CONFIG.current),
      latest: String(cfg.latest || cfg.current || DEFAULT_VERSION_CONFIG.latest),
      releaseNotes: cfg.releaseNotes || DEFAULT_VERSION_CONFIG.releaseNotes,
      updatedAt: Number(cfg.updatedAt) || DEFAULT_VERSION_CONFIG.updatedAt
    };
  } catch (e) {
    // 不再静默：读不到/解析失败会让 /api/version 退回 1.0.0，客户端永远收不到更新提示
    console.error('[version] 读取 ' + VERSION_FILE + ' 失败，回退默认版本:', e.message);
    return { ...DEFAULT_VERSION_CONFIG };
  }
}

function saveVersionConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 根据 version.json 的 latest 扫描 downloads 目录，动态构建下载链接（文件不存在则给 null）
function buildDownloads(cfg) {
  const downloads = {};
  const downloadVersions = {};
  for (const key of Object.keys(PLATFORM_FILES)) {
    const info = PLATFORM_FILES[key];
    const filename = 'SecureChat-' + cfg.latest + '-' + info.seg + '.' + info.ext;
    if (fs.existsSync(path.join(DOWNLOADS_DIR, filename))) {
      downloads[key] = '/downloads/' + filename;
      downloadVersions[key] = cfg.latest;
      continue;
    }
    const prefix = 'SecureChat-';
    const suffix = '-' + info.seg + '.' + info.ext;
    const fallback = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    downloads[key] = fallback ? '/downloads/' + fallback : null;
    if (fallback) downloadVersions[key] = fallback.slice(prefix.length, -suffix.length);
  }
  return { downloads, downloadVersions };
}

// GET /api/version（无需鉴权）返回版本配置与各平台下载链接
app.get('/api/version', (req, res) => {
  const cfg = getVersionConfig();
  const packageData = buildDownloads(cfg);
  res.json({
    current: cfg.current,
    latest: cfg.latest,
    releaseNotes: cfg.releaseNotes,
    updatedAt: cfg.updatedAt,
    downloads: packageData.downloads,
    downloadVersions: packageData.downloadVersions
  });
});

// 管理员更新版本信息：latest 必须是 x.y.z 格式；current 保持不变，updatedAt 更新为当前时间
app.post('/api/admin/version', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const latest = String((req.body || {}).latest || '').trim();
  // releaseNotes 允许数组（多版本日志），旧字符串格式仍兼容
  const rawNotes = (req.body || {}).releaseNotes;
  const releaseNotes = Array.isArray(rawNotes) ? rawNotes : String(rawNotes || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(latest)) {
    return res.status(400).json({ error: '版本号必须为 x.y.z 格式' });
  }
  const cfg = getVersionConfig();
  cfg.latest = latest;
  if (releaseNotes) cfg.releaseNotes = releaseNotes;
  cfg.updatedAt = Date.now();
  saveVersionConfig(cfg);
  res.json({ ok: true, version: cfg });
});

// 管理员生成充值兑换码：POST /api/admin/redeem/issue { value, count }
app.post('/api/admin/redeem/issue', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const value = parseFloat((req.body || {}).value);
  const count = Math.min(parseInt((req.body || {}).count || '1', 10) || 1, 500);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: '面额无效' });
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i++) {
    let c; do { c = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (prepare('SELECT 1 FROM redeem_codes WHERE code=?').get(c));
    prepare('INSERT INTO redeem_codes(code,value,created_at) VALUES(?,?,?)').run(c, value, Date.now());
    codes.push(c);
  }
  persist();
  res.json({ ok: true, count: codes.length, value, codes });
});

// 管理员查看兑换码列表：GET /api/admin/redeem?claimed=0|1
app.get('/api/admin/redeem', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const claimed = req.query.claimed;
  let rows;
  if (claimed === '0') rows = prepare('SELECT * FROM redeem_codes WHERE claimed_by IS NULL ORDER BY created_at DESC').all();
  else if (claimed === '1') rows = prepare('SELECT * FROM redeem_codes WHERE claimed_by IS NOT NULL ORDER BY claimed_at DESC').all();
  else rows = prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC').all();
  res.json({ codes: rows });
});

// 管理员直充余额：POST /api/admin/wallet/add { uid 或 userId, amount, remark }
app.post('/api/admin/wallet/add', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) return res.status(400).json({ error: '金额无效' });
  let user = null;
  if (b.userId) user = prepare('SELECT id FROM users WHERE id=?').get(parseInt(b.userId, 10));
  else if (b.uid) user = prepare('SELECT id FROM users WHERE uid=?').get(String(b.uid));
  else if (b.username) user = prepare('SELECT id FROM users WHERE username=?').get(String(b.username));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(user.id, Date.now());
  if (amount > 0) {
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(amount, amount, Date.now(), user.id);
  } else {
    const w = prepare('SELECT balance FROM wallets WHERE user_id=?').get(user.id);
    if ((w.balance || 0) + amount < 0) return res.status(400).json({ error: '扣减后余额为负' });
    prepare('UPDATE wallets SET balance=balance+?,updated_at=? WHERE user_id=?').run(amount, Date.now(), user.id);
  }
  prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)').run(user.id, amount > 0 ? 'recharge' : 'admin_deduct', Math.abs(amount), b.remark || '管理员调整', Date.now());
  persist();
  const w2 = prepare('SELECT balance FROM wallets WHERE user_id=?').get(user.id);
  res.json({ ok: true, userId: user.id, balance: w2.balance });
});

// 管理员查任意用户余额：GET /api/admin/wallet?uid=xxx
app.get('/api/admin/wallet', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '请提供用户 UID / 用户名 / ID' });
  let u = prepare('SELECT id,username,nickname,uid FROM users WHERE uid=?').get(q);
  if (!u) u = prepare('SELECT id,username,nickname,uid FROM users WHERE username=?').get(q);
  if (!u && /^\d+$/.test(q)) u = prepare('SELECT id,username,nickname,uid FROM users WHERE id=?').get(parseInt(q, 10));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  let w = prepare('SELECT balance FROM wallets WHERE user_id=?').get(u.id);
  if (!w) { prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(u.id, Date.now()); w = { balance: 0 }; }
  const txn = prepare('SELECT kind,amount,remark,created_at FROM wallet_txn WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(u.id);
  res.json({ user: u, balance: w.balance || 0, recentTxn: txn });
});

// 管理员上传安装包（无依赖二进制上传）：express.raw 直接解析 application/octet-stream 得到 Buffer，
// 按 version.json 的 latest 命名后写入 server/downloads。前端以 fetch(url, { body: file }) 发送。
app.post('/api/admin/upload/:platform', express.raw({ type: 'application/octet-stream', limit: '300mb' }), (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const info = PLATFORM_FILES[String(req.params.platform || '')];
  if (!info) return res.status(400).json({ error: '平台无效' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: '上传内容为空，请使用 application/octet-stream 发送文件字节流' });
  }
  const cfg = getVersionConfig();
  const filename = 'SecureChat-' + cfg.latest + '-' + info.seg + '.' + info.ext;
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOWNLOADS_DIR, filename), req.body);
  res.json({ ok: true, file: filename, size: req.body.length });
});

// 管理员删除安装包（方便重传）
app.delete('/api/admin/upload/:platform', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const info = PLATFORM_FILES[String(req.params.platform || '')];
  if (!info) return res.status(400).json({ error: '平台无效' });
  const cfg = getVersionConfig();
  const filename = 'SecureChat-' + cfg.latest + '-' + info.seg + '.' + info.ext;
  const filePath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  fs.unlinkSync(filePath);
  res.json({ ok: true, file: filename });
});

// ============ QQ 互联登录（OAuth2.0） ============
// 配置存 settings 表（key=qq_config），管理后台可修改。
// 流程：客户端生成 state → 打开授权页 → 用户授权 → QQ 回调本服务器
// /oauth/qq/callback → 换 token/openid → 已绑定直接生成登录会话；
// 未绑定则回调页引导绑定(邮箱验证码)或自动注册新账号。
// 客户端轮询 /api/oauth/qq/poll?state= 获取登录结果。
const QQ_SESSION_TTL = 3 * 60 * 1000;
const qqSessions = new Map(); // state -> { status, token?, user?, openid?, nickname?, avatar?, createdAt }

function getSetting(key) {
  try {
    const row = prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : null;
  } catch (e) { return null; }
}
function setSetting(key, value) {
  try {
    prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, value, Date.now());
    persist();
  } catch (e) { /* settings 表未建时忽略 */ }
}

function getQqConfig() {
  const raw = getSetting('qq_config');
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c || !c.appid) return null;
    return {
      appid: String(c.appid || '').trim(),
      secret: String(c.secret || '').trim(),
      redirect: String(c.redirect || '').trim(),
      enabled: !!c.enabled
    };
  } catch (e) { return null; }
}
function saveQqConfig(c) {
  setSetting('qq_config', JSON.stringify({
    appid: String(c.appid || '').trim(),
    secret: String(c.secret || '').trim(),
    redirect: String(c.redirect || '').trim(),
    enabled: !!c.enabled
  }));
}

// 无依赖 HTTPS GET（QQ 开放平台接口）
function httpsGetJson(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: 'bad url' }); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'SecureChat/1.0' }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function qqExchangeToken(code) {
  const cfg = getQqConfig();
  if (!cfg) return { error: 'QQ 互联未配置' };
  const url = 'https://graph.qq.com/oauth2.0/token?grant_type=authorization_code' +
    '&client_id=' + encodeURIComponent(cfg.appid) +
    '&client_secret=' + encodeURIComponent(cfg.secret) +
    '&code=' + encodeURIComponent(code) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect);
  const r = await httpsGetJson(url);
  if (r.status !== 200) return { error: 'QQ 授权失败（' + (r.status || r.body) + '）' };
  const params = new URLSearchParams(r.body);
  const err = params.get('error');
  if (err) return { error: 'QQ 授权失败：' + (params.get('error_description') || err) };
  const accessToken = params.get('access_token');
  if (!accessToken) return { error: 'QQ 未返回 access_token' };
  return { accessToken };
}

async function qqGetOpenid(accessToken) {
  const r = await httpsGetJson('https://graph.qq.com/oauth2.0/me?access_token=' + encodeURIComponent(accessToken));
  if (r.status !== 200) return { error: '获取 QQ openid 失败' };
  const m = r.body.match(/callback\(\s*(\{.*\})\s*\)/s) || r.body.match(/\{.*"openid".*\}/s);
  if (!m) return { error: 'QQ openid 响应异常' };
  try {
    const j = JSON.parse(m[1]);
    if (!j.openid) return { error: j.error_description || 'QQ openid 为空' };
    return { openid: j.openid };
  } catch (e) { return { error: 'QQ openid 解析失败' }; }
}

async function qqGetUserInfo(accessToken, openid) {
  const cfg = getQqConfig();
  const r = await httpsGetJson('https://graph.qq.com/user/get_user_info?access_token=' + encodeURIComponent(accessToken) +
    '&oauth_consumer_key=' + encodeURIComponent(cfg.appid) + '&openid=' + encodeURIComponent(openid));
  if (r.status !== 200) return { error: '获取 QQ 资料失败' };
  try {
    const j = JSON.parse(r.body);
    if (j.ret !== 0) return { error: j.msg || 'QQ 资料获取失败' };
    return {
      nickname: j.nickname || '',
      avatar: j.figureurl_qq_2 || j.figureurl_qq_1 || ''
    };
  } catch (e) { return { error: 'QQ 资料解析失败' }; }
}

function qqOrigin() {
  return '';
}

// 管理后台：读取 QQ 互联配置
app.get('/api/admin/qq/config', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const cfg = getQqConfig();
  res.json({ config: cfg || { appid: '', secret: '', redirect: '', enabled: false } });
});

// 管理后台：保存 QQ 互联配置
app.post('/api/admin/qq/config', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const b = req.body || {};
  if (!String(b.appid || '').trim() || !String(b.secret || '').trim()) {
    return res.status(400).json({ error: 'AppID 和 AppKey 不能为空' });
  }
  if (!String(b.redirect || '').trim().startsWith('https://')) {
    return res.status(400).json({ error: '回调地址必须以 https:// 开头，且需与 QQ 互联后台填写的完全一致' });
  }
  saveQqConfig({ appid: b.appid, secret: b.secret, redirect: b.redirect, enabled: !!b.enabled });
  logAudit(guard.u.id, 'qq_config', null, 'config', '更新 QQ 互联配置(appid=' + b.appid + ', enabled=' + (!!b.enabled) + ')', clientIp(req));
  res.json({ ok: true, config: getQqConfig() });
});

// 公开：查询 QQ 登录是否可用（不含 secret）
app.get('/api/oauth/qq/status', (req, res) => {
  const cfg = getQqConfig();
  res.json({ enabled: !!(cfg && cfg.enabled && cfg.appid), appid: cfg ? cfg.appid : '', redirect: cfg ? cfg.redirect : '' });
});

// 公开：生成 QQ 授权链接
app.get('/api/oauth/qq/url', (req, res) => {
  const cfg = getQqConfig();
  if (!cfg || !cfg.enabled || !cfg.appid || !cfg.redirect) {
    return res.status(503).json({ error: 'QQ 登录尚未启用' });
  }
  const state = String((req.query || {}).state || '').trim();
  if (!state) return res.status(400).json({ error: '缺少 state' });
  const url = 'https://graph.qq.com/oauth2.0/authorize?response_type=code' +
    '&client_id=' + encodeURIComponent(cfg.appid) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
    '&state=' + encodeURIComponent(state) +
    '&scope=get_user_info';
  res.json({ url });
});

// 轮询：客户端（桌面/网页）获取登录结果
app.get('/api/oauth/qq/poll', (req, res) => {
  const state = String((req.query || {}).state || '').trim();
  const s = qqSessions.get(state);
  if (!s) return res.status(404).json({ error: '登录会话不存在或已过期' });
  if (s.status === 'ok') {
    return res.json({ status: 'ok', token: s.token, user: s.user });
  }
  return res.json({ status: s.status || 'waiting' });
});

// 绑定：已有账号 + 邮箱验证码 → 绑定 QQ
app.post('/api/oauth/qq/bind', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { state, openid, email, code } = req.body || {};
  if (!state || !openid || !email || !code) return res.status(400).json({ error: '参数不完整' });
  const s = qqSessions.get(state);
  if (!s || s.openid !== openid) return res.status(400).json({ error: '登录会话无效，请重新发起 QQ 登录' });
  if (codeAttemptsExceeded(String(email))) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(String(email), String(code), 'login');
  if (codeErr) { recordCodeFail(String(email)); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(String(email));
  const user = prepare('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase());
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  if (user.banned) return res.status(403).json({ error: '该账号已被封禁' });
  const exists = prepare('SELECT id FROM users WHERE qq_openid=? AND id<>?').get(openid, user.id);
  if (exists) return res.status(400).json({ error: '该 QQ 已绑定其他账号' });
  prepare('UPDATE users SET qq_openid=? WHERE id=?').run(openid, user.id);
  persist();
  const token = signToken(user);
  s.status = 'ok'; s.token = token; s.user = publicUser(user);
  logAudit(user.id, 'qq_bind', user.id, 'user', 'QQ 绑定账号 ' + user.username, clientIp(req));
  res.json({ ok: true, token, user: s.user });
});

// 自动注册：用 QQ 昵称创建新账号
app.post('/api/oauth/qq/register', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { state, openid, nickname, avatar } = req.body || {};
  if (!state || !openid) return res.status(400).json({ error: '参数不完整' });
  const s = qqSessions.get(state);
  if (!s || s.openid !== openid) return res.status(400).json({ error: '登录会话无效，请重新发起 QQ 登录' });
  if (prepare('SELECT 1 FROM users WHERE qq_openid=?').get(openid)) {
    return res.status(400).json({ error: '该 QQ 已注册过账号，请使用绑定方式登录' });
  }
  let username;
  do { username = 'qq' + String(Math.floor(100000 + Math.random() * 900000)); }
  while (prepare('SELECT 1 FROM users WHERE username=?').get(username));
  let uid; do { uid = genUid(); } while (prepare('SELECT 1 FROM users WHERE uid=?').get(uid));
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  const nick = String(nickname || '').trim().slice(0, 20) || 'QQ用户';
  prepare('INSERT INTO users(username,nickname,password,uid,qq_openid,created_at) VALUES(?,?,?,?,?,?)')
    .run(username, nick, hash, uid, openid, Date.now());
  persist();
  const user = prepare('SELECT * FROM users WHERE username=?').get(username);
  const token = signToken(user);
  s.status = 'ok'; s.token = token; s.user = publicUser(user);
  res.json({ ok: true, token, user: s.user });
});

// QQ 授权回调页（HTML）：换 token/openid/资料，返回绑定或登录页
app.get('/oauth/qq/callback', async (req, res) => {
  const code = String((req.query || {}).code || '');
  const state = String((req.query || {}).state || '');
  const error = String((req.query || {}).error || '');
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const script = (v) => String(v || '').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/"/g, '\\u0022');

  if (error || !code || !state) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>QQ 登录失败</h3><p>' + esc(error || '缺少授权参数') + '</p></body>');
  }
  qqSessions.set(state, { status: 'waiting', openid: '', createdAt: Date.now() });
  const tok = await qqExchangeToken(code);
  if (tok.error) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>QQ 登录失败</h3><p>' + esc(tok.error) + '</p></body>');
  }
  const od = await qqGetOpenid(tok.accessToken);
  if (od.error) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>QQ 登录失败</h3><p>' + esc(od.error) + '</p></body>');
  }
  const s = qqSessions.get(state);
  if (s) { s.openid = od.openid; s.createdAt = Date.now(); }
  const ui = await qqGetUserInfo(tok.accessToken, od.openid);
  if (s) { s.nickname = ui.nickname || ''; s.avatar = ui.avatar || ''; }

  const bound = prepare('SELECT * FROM users WHERE qq_openid=?').get(od.openid);
  if (bound) {
    if (bound.banned) {
      return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#c0392b"><h3>该账号已被封禁</h3></body>');
    }
    const token = signToken(bound);
    s.status = 'ok'; s.token = token; s.user = publicUser(bound);
  }

  const html = '<!doctype html><html><meta charset="utf-8"><title>QQ 登录</title>' +
    '<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f7;margin:0;padding:0}'.replace('</style>','') +
    '.card{max-width:400px;margin:60px auto;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.08);padding:36px 28px;text-align:center}' +
    'h2{font-size:18px;margin:0 0 6px}.sub{color:#999;font-size:13px;margin-bottom:22px}' +
    '.qq-avatar{width:64px;height:64px;border-radius:50%;object-fit:cover;margin:0 auto 12px;display:block}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;margin:6px 0;border:1px solid #ddd;border-radius:8px;font-size:14px;outline:none}' +
    'input:focus{border-color:#12b7f5}' +
    'button{width:100%;padding:12px;margin-top:8px;border:none;border-radius:8px;font-size:15px;cursor:pointer}' +
    '.btn-blue{background:#12b7f5;color:#fff}.btn-green{background:#07c160;color:#fff}.btn-plain{background:#f2f3f5;color:#333}' +
    '.err{color:#c0392b;font-size:13px;margin:8px 0;min-height:18px}.ok{color:#07c160;font-size:14px;margin:10px 0}' +
    '.row{display:flex;gap:8px}.row input{flex:1}.row button{width:auto;padding:11px 14px;margin-top:6px;white-space:nowrap}' +
    '</style>' +
    '<div class="card">' +
    '<img class="qq-avatar" src="' + esc(ui.avatar || '') + '" onerror="this.style.display=\'none\'">' +
    '<h2>' + esc(ui.nickname || 'QQ 用户') + '</h2>' +
    '<div class="sub">使用 QQ 登录 SecureChat</div>' +
    '<div class="ok" id="okBox" style="display:none">登录成功，即将返回…</div>' +
    '<div id="errBox" class="err"></div>' +
    '<div id="bindBox" style="display:none">' +
      '<div class="sub" style="text-align:left">该 QQ 尚未绑定账号：</div>' +
      '<div class="row"><input id="email" placeholder="输入已注册邮箱" type="email"><button class="btn-plain" onclick="sendCode()">发验证码</button></div>' +
      '<input id="code" placeholder="邮箱验证码" style="margin-top:4px">' +
      '<button class="btn-blue" onclick="bind()">绑定已有账号并登录</button>' +
      '<div class="sub" style="margin:14px 0 0">或</div>' +
      '<button class="btn-green" onclick="reg()">用 QQ 账号直接注册新用户</button>' +
    '</div>' +
    '<div id="waitBox"><div class="sub">正在处理…</div></div>' +
    '</div>' +
    '<script>' +
    'var STATE=' + JSON.stringify(script(state)) + ';var OPENID=' + JSON.stringify(script(od.openid)) + ';var BOUND=' + (bound ? 'true' : 'false') + ';' +
    'var t=null;' +
    'function toast(m){document.getElementById("errBox").textContent=m;}' +
    'function showOk(){document.getElementById("okBox").style.display="block";document.getElementById("bindBox").style.display="none";document.getElementById("waitBox").style.display="none";}' +
    'function sendCode(){var em=document.getElementById("email").value.trim();if(!/^[^@]+@[^@]+\\.[^@]+$/.test(em)){toast("邮箱格式不正确");return;}toast("验证码已发送，请查收邮箱");fetch("/api/email/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:em,purpose:"login"})}).then(function(r){return r.json()}).then(function(d){if(!d.ok&&d.error)toast(d.error)}).catch(function(e){toast("发送失败")});}' +
    'function bind(){var em=document.getElementById("email").value.trim();var cd=document.getElementById("code").value.trim();if(!em||!cd){toast("请填写邮箱和验证码");return;}fetch("/api/oauth/qq/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,openid:OPENID,email:em,code:cd})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function reg(){fetch("/api/oauth/qq/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,openid:OPENID})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function poll(){fetch("/api/oauth/qq/poll?state="+encodeURIComponent(STATE)).then(function(r){return r.json()}).then(function(d){if(d.status==="ok"){showOk();finish();}else if(d.status==="waiting"){setTimeout(poll,1500);}else{toast(d.error||"登录失败");}}).catch(function(){setTimeout(poll,2000);});}' +
    'function finish(){try{if(window.opener){window.opener.postMessage({type:"securechat_qq_login",state:STATE,ok:true},location.origin);}setTimeout(function(){location.href="/?qq_done=1";},1200);}catch(e){}}' +
    'if(BOUND){showOk();poll();}else{document.getElementById("bindBox").style.display="block";document.getElementById("waitBox").style.display="none";}' +
    'setTimeout(function(){try{window.opener&&window.opener.postMessage({type:"securechat_qq_ready",state:STATE},location.origin)}catch(e){}},300);' +
    '</script></body></html>';
  res.type('html').send(html);
});

// 清理过期的 QQ 登录会话
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of qqSessions) {
    if (now - (v.createdAt || 0) > QQ_SESSION_TTL) qqSessions.delete(k);
  }
}, 60 * 1000);

// ============ GitHub OAuth 登录（无需备案） ============
// 配置存 settings['github_config']，流程同 QQ 互联但接口是 GitHub。
// GitHub API: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
const GITHUB_SESSION_TTL = 3 * 60 * 1000;
const githubSessions = new Map(); // state -> { status, token?, user?, githubId?, login?, avatar?, createdAt }

function getGithubConfig() {
  const raw = getSetting('github_config');
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c || !c.clientId) return null;
    return {
      clientId: String(c.clientId || '').trim(),
      clientSecret: String(c.clientSecret || '').trim(),
      redirect: String(c.redirect || '').trim(),
      enabled: !!c.enabled
    };
  } catch (e) { return null; }
}
function saveGithubConfig(c) {
  setSetting('github_config', JSON.stringify({
    clientId: String(c.clientId || '').trim(),
    clientSecret: String(c.clientSecret || '').trim(),
    redirect: String(c.redirect || '').trim(),
    enabled: !!c.enabled
  }));
}

async function githubExchangeToken(code) {
  const cfg = getGithubConfig();
  if (!cfg) return { error: 'GitHub OAuth 未配置' };
  const body = JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirect });
  const url = 'https://github.com/login/oauth/access_token';
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'SecureChat/1.0', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: 'GitHub 授权失败（' + res.statusCode + '）' });
        try {
          const j = JSON.parse(d);
          if (j.error) return resolve({ error: 'GitHub: ' + (j.error_description || j.error) });
          if (!j.access_token) return resolve({ error: 'GitHub 未返回 access_token' });
          resolve({ accessToken: j.access_token });
        } catch (e) { resolve({ error: 'GitHub 响应解析失败' }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function githubGetUser(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/user', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'SecureChat/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: 'GitHub 用户信息获取失败' });
        try {
          const j = JSON.parse(d);
          if (!j.id) return resolve({ error: 'GitHub 用户 ID 为空' });
          resolve({ githubId: String(j.id), login: j.login || '', name: j.name || j.login || '', avatar: j.avatar_url || '' });
        } catch (e) { resolve({ error: 'GitHub 用户信息解析失败' }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve({ error: 'timeout' }); });
    req.end();
  });
}

// 管理后台：读取 GitHub OAuth 配置
app.get('/api/admin/github/config', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const cfg = getGithubConfig();
  res.json({ config: cfg || { clientId: '', clientSecret: '', redirect: '', enabled: false } });
});

// 管理后台：保存 GitHub OAuth 配置
app.post('/api/admin/github/config', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const b = req.body || {};
  if (!String(b.clientId || '').trim() || !String(b.clientSecret || '').trim()) {
    return res.status(400).json({ error: 'Client ID 和 Client Secret 不能为空' });
  }
  if (!String(b.redirect || '').trim().startsWith('https://')) {
    return res.status(400).json({ error: '回调地址必须以 https:// 开头' });
  }
  saveGithubConfig({ clientId: b.clientId, clientSecret: b.clientSecret, redirect: b.redirect, enabled: !!b.enabled });
  logAudit(guard.u.id, 'github_config', null, 'config', '更新 GitHub OAuth 配置(clientId=' + b.clientId + ', enabled=' + (!!b.enabled) + ')', clientIp(req));
  res.json({ ok: true, config: getGithubConfig() });
});

// 公开：查询 GitHub 登录是否可用
app.get('/api/oauth/github/status', (req, res) => {
  const cfg = getGithubConfig();
  res.json({ enabled: !!(cfg && cfg.enabled && cfg.clientId), clientId: cfg ? cfg.clientId : '', redirect: cfg ? cfg.redirect : '' });
});

// 公开：生成 GitHub 授权链接
app.get('/api/oauth/github/url', (req, res) => {
  const cfg = getGithubConfig();
  if (!cfg || !cfg.enabled || !cfg.clientId || !cfg.redirect) {
    return res.status(503).json({ error: 'GitHub 登录尚未启用' });
  }
  const state = String((req.query || {}).state || '').trim();
  if (!state) return res.status(400).json({ error: '缺少 state' });
  const url = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(cfg.clientId) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) + '&state=' + encodeURIComponent(state) + '&scope=read:user';
  res.json({ url });
});

// 轮询：客户端获取登录结果
app.get('/api/oauth/github/poll', (req, res) => {
  const state = String((req.query || {}).state || '').trim();
  const s = githubSessions.get(state);
  if (!s) return res.status(404).json({ error: '登录会话不存在或已过期' });
  if (s.status === 'ok') {
    return res.json({ status: 'ok', token: s.token, user: s.user });
  }
  return res.json({ status: s.status || 'waiting' });
});

// 绑定：已有账号 + 邮箱验证码 → 绑定 GitHub
app.post('/api/oauth/github/bind', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { state, githubId, email, code } = req.body || {};
  if (!state || !githubId || !email || !code) return res.status(400).json({ error: '参数不完整' });
  const s = githubSessions.get(state);
  if (!s || s.githubId !== githubId) return res.status(400).json({ error: '登录会话无效，请重新发起 GitHub 登录' });
  if (codeAttemptsExceeded(String(email))) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(String(email), String(code), 'login');
  if (codeErr) { recordCodeFail(String(email)); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(String(email));
  const user = prepare('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase());
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  if (user.banned) return res.status(403).json({ error: '该账号已被封禁' });
  const exists = prepare('SELECT id FROM users WHERE github_id=? AND id<>?').get(githubId, user.id);
  if (exists) return res.status(400).json({ error: '该 GitHub 账号已绑定其他账号' });
  prepare('UPDATE users SET github_id=? WHERE id=?').run(githubId, user.id);
  persist();
  const token = signToken(user);
  s.status = 'ok'; s.token = token; s.user = publicUser(user);
  logAudit(user.id, 'github_bind', user.id, 'user', 'GitHub 绑定账号 ' + user.username, clientIp(req));
  res.json({ ok: true, token, user: s.user });
});

// 自动注册：用 GitHub 昵称创建新账号
app.post('/api/oauth/github/register', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { state, githubId, name, avatar } = req.body || {};
  if (!state || !githubId) return res.status(400).json({ error: '参数不完整' });
  const s = githubSessions.get(state);
  if (!s || s.githubId !== githubId) return res.status(400).json({ error: '登录会话无效，请重新发起 GitHub 登录' });
  if (prepare('SELECT 1 FROM users WHERE github_id=?').get(githubId)) {
    return res.status(400).json({ error: '该 GitHub 账号已注册过账号，请使用绑定方式登录' });
  }
  let username;
  do { username = 'gh' + String(Math.floor(100000 + Math.random() * 900000)); }
  while (prepare('SELECT 1 FROM users WHERE username=?').get(username));
  let uid; do { uid = genUid(); } while (prepare('SELECT 1 FROM users WHERE uid=?').get(uid));
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  const nick = String(name || '').trim().slice(0, 20) || 'GitHub用户';
  prepare('INSERT INTO users(username,nickname,password,uid,github_id,created_at) VALUES(?,?,?,?,?,?)')
    .run(username, nick, hash, uid, githubId, Date.now());
  persist();
  const user = prepare('SELECT * FROM users WHERE username=?').get(username);
  const token = signToken(user);
  s.status = 'ok'; s.token = token; s.user = publicUser(user);
  res.json({ ok: true, token, user: s.user });
});

// GitHub 授权回调页（HTML）
app.get('/oauth/github/callback', async (req, res) => {
  const code = String((req.query || {}).code || '');
  const state = String((req.query || {}).state || '');
  const error = String((req.query || {}).error || '');
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const script = (v) => String(v || '').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/"/g, '\\u0022');

  if (error || !code || !state) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>GitHub 登录失败</h3><p>' + esc(error || '缺少授权参数') + '</p></body>');
  }
  githubSessions.set(state, { status: 'waiting', githubId: '', createdAt: Date.now() });
  const tok = await githubExchangeToken(code);
  if (tok.error) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>GitHub 登录失败</h3><p>' + esc(tok.error) + '</p></body>');
  }
  const ui = await githubGetUser(tok.accessToken);
  if (ui.error) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>GitHub 登录失败</h3><p>' + esc(ui.error) + '</p></body>');
  }
  const s = githubSessions.get(state);
  if (s) { s.githubId = ui.githubId; s.login = ui.login; s.name = ui.name; s.avatar = ui.avatar; s.createdAt = Date.now(); }

  const bound = prepare('SELECT * FROM users WHERE github_id=?').get(ui.githubId);
  if (bound) {
    if (bound.banned) {
      return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#c0392b"><h3>该账号已被封禁</h3></body>');
    }
    const token = signToken(bound);
    s.status = 'ok'; s.token = token; s.user = publicUser(bound);
  }

  const html = '<!doctype html><html><meta charset="utf-8"><title>GitHub 登录</title>' +
    '<style>body{font-family:-apple-system,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:0}' +
    '.card{max-width:400px;margin:60px auto;background:#161b22;border-radius:14px;border:1px solid #30363d;padding:36px 28px;text-align:center}' +
    'h2{font-size:18px;margin:0 0 6px}.sub{color:#8b949e;font-size:13px;margin-bottom:22px}' +
    '.avatar{width:64px;height:64px;border-radius:50%;margin:0 auto 12px;display:block}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;margin:6px 0;border:1px solid #30363d;border-radius:8px;font-size:14px;outline:none;background:#0d1117;color:#c9d1d9}' +
    'input:focus{border-color:#58a6ff}' +
    'button{width:100%;padding:12px;margin-top:8px;border:none;border-radius:8px;font-size:15px;cursor:pointer}' +
    '.btn-blue{background:#238636;color:#fff}.btn-plain{background:#21262d;color:#c9d1d9;border:1px solid #30363d}' +
    '.err{color:#f85149;font-size:13px;margin:8px 0;min-height:18px}.ok{color:#3fb950;font-size:14px;margin:10px 0}' +
    '.row{display:flex;gap:8px}.row input{flex:1}.row button{width:auto;padding:11px 14px;margin-top:6px;white-space:nowrap}' +
    '</style>' +
    '<div class="card">' +
    '<img class="avatar" src="' + esc(ui.avatar || '') + '" onerror="this.style.display=\'none\'">' +
    '<h2>' + esc(ui.name || ui.login || 'GitHub 用户') + '</h2>' +
    '<div class="sub">使用 GitHub 登录 SecureChat</div>' +
    '<div class="ok" id="okBox" style="display:none">登录成功，即将返回…</div>' +
    '<div id="errBox" class="err"></div>' +
    '<div id="bindBox" style="display:none">' +
      '<div class="sub" style="text-align:left">该 GitHub 账号尚未绑定：</div>' +
      '<div class="row"><input id="email" placeholder="输入已注册邮箱" type="email"><button class="btn-plain" onclick="sendCode()">发验证码</button></div>' +
      '<input id="code" placeholder="邮箱验证码" style="margin-top:4px">' +
      '<button class="btn-blue" onclick="bind()">绑定已有账号并登录</button>' +
      '<div class="sub" style="margin:14px 0 0">或</div>' +
      '<button class="btn-blue" onclick="reg()">用 GitHub 账号直接注册新用户</button>' +
    '</div>' +
    '<div id="waitBox"><div class="sub">正在处理…</div></div>' +
    '</div>' +
    '<script>' +
    'var STATE=' + JSON.stringify(script(state)) + ';var GITHUB_ID=' + JSON.stringify(script(ui.githubId)) + ';var BOUND=' + (bound ? 'true' : 'false') + ';' +
    'function toast(m){document.getElementById("errBox").textContent=m;}' +
    'function showOk(){document.getElementById("okBox").style.display="block";document.getElementById("bindBox").style.display="none";document.getElementById("waitBox").style.display="none";}' +
    'function sendCode(){var em=document.getElementById("email").value.trim();if(!/^[^@]+@[^@]+\\.[^@]+$/.test(em)){toast("邮箱格式不正确");return;}toast("验证码已发送，请查收邮箱");fetch("/api/email/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:em,purpose:"login"})}).then(function(r){return r.json()}).then(function(d){if(!d.ok&&d.error)toast(d.error)}).catch(function(e){toast("发送失败")});}' +
    'function bind(){var em=document.getElementById("email").value.trim();var cd=document.getElementById("code").value.trim();if(!em||!cd){toast("请填写邮箱和验证码");return;}fetch("/api/oauth/github/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,githubId:GITHUB_ID,email:em,code:cd})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function reg(){fetch("/api/oauth/github/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,githubId:GITHUB_ID})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function poll(){fetch("/api/oauth/github/poll?state="+encodeURIComponent(STATE)).then(function(r){return r.json()}).then(function(d){if(d.status==="ok"){showOk();finish();}else if(d.status==="waiting"){setTimeout(poll,1500);}else{toast(d.error||"登录失败");}}).catch(function(){setTimeout(poll,2000);});}' +
    'function finish(){try{if(window.opener){window.opener.postMessage({type:"securechat_github_login",state:STATE,ok:true},location.origin);}setTimeout(function(){location.href="/?github_done=1";},1200);}catch(e){}}' +
    'if(BOUND){showOk();poll();}else{document.getElementById("bindBox").style.display="block";document.getElementById("waitBox").style.display="none";}' +
    '</script></body></html>';
  res.type('html').send(html);
});

// 清理过期的 GitHub 登录会话
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of githubSessions) {
    if (now - (v.createdAt || 0) > GITHUB_SESSION_TTL) githubSessions.delete(k);
  }
}, 60 * 1000);

// ============ Passkey 本地设备凭据（免密登录） ============
// 注册：登录态下生成 credential_id + secret，客户端本地存储。
// 登录：客户端出示 credential_id，服务器验证 HMAC(secret, challenge)。

const passkeyChallenges = new Map();

// 注册凭据（需登录态）
app.post('/api/passkey/register', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '请先登录' });
  const deviceName = String((req.body || {}).deviceName || '').trim().slice(0, 50) || '默认设备';
  const credentialId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    prepare('INSERT INTO passkey_credentials(user_id,credential_id,secret,device_name,created_at) VALUES(?,?,?,?,?)')
      .run(payload.id, credentialId, secret, deviceName, Date.now());
    persist();
    res.json({ ok: true, credentialId, secret, deviceName });
  } catch (e) {
    res.status(500).json({ error: '注册失败' });
  }
});

// 列出凭据（需登录态）
app.get('/api/passkey/list', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '请先登录' });
  let rows;
  try {
    rows = prepare('SELECT id,credential_id,device_name,created_at,last_used_at FROM passkey_credentials WHERE user_id=? ORDER BY created_at DESC').all(payload.id);
  } catch (e) { rows = []; }
  res.json({ credentials: rows });
});

// 删除凭据（需登录态）
app.delete('/api/passkey/delete', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '请先登录' });
  const credentialId = String((req.query || {}).credentialId || (req.body || {}).credentialId || '').trim();
  if (!credentialId) return res.status(400).json({ error: '缺少 credentialId' });
  try {
    prepare('DELETE FROM passkey_credentials WHERE user_id=? AND credential_id=?').run(payload.id, credentialId);
    persist();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// 登录第一步：发起挑战（无需登录）
app.post('/api/passkey/start', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const credentialId = String((req.body || {}).credentialId || '').trim();
  if (!credentialId) return res.status(400).json({ error: '缺少 credentialId' });
  const row = prepare('SELECT user_id,secret FROM passkey_credentials WHERE credential_id=?').get(credentialId);
  if (!row) return res.status(404).json({ error: '凭据不存在' });
  const challenge = crypto.randomBytes(32).toString('hex');
  passkeyChallenges.set(credentialId, { uid: row.user_id, secret: row.secret, challenge, createdAt: Date.now() });
  res.json({ challenge, credentialId });
});

// 登录第二步：验证签名（HMAC-SHA256）
app.post('/api/passkey/finish', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { credentialId, signature } = req.body || {};
  if (!credentialId || !signature) return res.status(400).json({ error: '参数不完整' });
  const session = passkeyChallenges.get(credentialId);
  if (!session) return res.status(400).json({ error: '挑战已过期，请重新发起登录' });
  passkeyChallenges.delete(credentialId);
  const expected = crypto.createHmac('sha256', session.secret).update(session.challenge).digest('hex');
  if (signature !== expected) return res.status(401).json({ error: '凭据验证失败' });
  const user = prepare('SELECT * FROM users WHERE id=?').get(session.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.banned) return res.status(403).json({ error: '该账号已被封禁' });
  prepare('UPDATE passkey_credentials SET last_used_at=? WHERE credential_id=?').run(Date.now(), credentialId);
  persist();
  const token = signToken(user);
  res.json({ ok: true, token, user: publicUser(user) });
});

// 管理员：查看所有凭据
app.get('/api/admin/passkey/list', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  let rows;
  try {
    rows = prepare(
      `SELECT p.id,p.user_id,p.credential_id,p.device_name,p.created_at,p.last_used_at,u.username,u.nickname,u.email
       FROM passkey_credentials p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC`
    ).all();
  } catch (e) { rows = []; }
  res.json({ credentials: rows });
});

// 管理员：删除凭据
app.delete('/api/admin/passkey/delete', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const credentialId = String((req.query || {}).credentialId || (req.body || {}).credentialId || '').trim();
  if (!credentialId) return res.status(400).json({ error: '缺少 credentialId' });
  try {
    prepare('DELETE FROM passkey_credentials WHERE credential_id=?').run(credentialId);
    persist();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// 清理过期挑战
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of passkeyChallenges) {
    if (now - (v.createdAt || 0) > 120000) passkeyChallenges.delete(k);
  }
}, 60 * 1000);

// AI 同源代理：避免浏览器直接请求供应商时被 CORS 拦截。
// API Key 只随本次请求转发，不写入服务器数据库。
app.post('/api/ai/chat', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '请先登录' });
  const body = req.body || {};
  let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  // Allow users to paste either the API base URL or the full completion URL.
  // The upstream request appends /chat/completions exactly once.
  baseUrl = baseUrl.replace(/\/chat\/completions$/i, '');
  // acu.ltzy.top is the AQUA control-panel host. Its OpenAI-compatible
  // inference endpoint is served by api.ltzy.top; accept the former input
  // for existing client settings and route it to the actual API host.
  baseUrl = baseUrl.replace(/^https:\/\/acu\.ltzy\.top\/v1$/i, 'https://api.ltzy.top/v1');
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || '').trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!/^https:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'AI Base URL 必须使用 HTTPS' });
  // SSRF防护：只允许已知的AI提供商域名
  try {
    const host = new URL(baseUrl).hostname;
    const allowed = /^(api\.openai\.com|api\.anthropic\.com|api\.ltzy\.top|acu\.ltzy\.top|generativelanguage\.googleapis\.com|open\.bigmodel\.cn|api\.deepseek\.com|api\.moonshot\.cn|api\.zhipu\.ai)$/i;
    if (!allowed.test(host)) return res.status(403).json({ error: '该AI服务商不在允许列表中' });
  } catch { return res.status(400).json({ error: 'AI Base URL 格式无效' }); }
  if (!apiKey || !model || !messages.length) return res.status(400).json({ error: 'AI 配置不完整' });
  if (baseUrl.length > 300 || apiKey.length > 500 || messages.length > 40) return res.status(400).json({ error: 'AI 请求参数过大' });
  try {
    const upstream = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(60000)
    });
    const text = await upstream.text();
    // Some providers/CDN error pages return HTML. Never label that HTML as
    // JSON, otherwise the browser reports the unhelpful "Unexpected token <".
    let upstreamBody;
    try {
      upstreamBody = text ? JSON.parse(text) : { error: 'AI 返回为空' };
    } catch {
      const preview = text.replace(/\s+/g, ' ').slice(0, 160);
      upstreamBody = {
        error: 'AI 服务返回了网页而非接口数据。请检查 Base URL 是否为 OpenAI 兼容 API 地址（不要填写官网首页）。',
        upstreamStatus: upstream.status,
        preview
      };
    }
    res.status(upstream.ok ? 200 : upstream.status).json(upstreamBody);
  } catch (e) {
    console.error('[ai] upstream error:', e && e.message);
    res.status(502).json({ error: 'AI 服务连接失败' });
  }
});

// ---------- 管理员后台 ----------
// GET /api/admin/overview —— 只读统计看板（仅 admin_emails 白名单账号可访问）
// 返回 100+ 字段：系统 / 用户 / 群组 / 消息 / 安全 / 存储 / AI / 反馈 等
app.get('/api/admin/overview', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const now = Date.now();
  const uptimeMs = now - START_AT;
  const usersAll = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,created_at FROM users').all();
  const onlineIds = new Set();
  for (const id of online.keys()) onlineIds.add(id);

  // 用户
  const userCount = usersAll.length;
  const usersWithEmail = usersAll.filter(u => !!u.email).length;
  const usersWithAvatar = usersAll.filter(u => !!u.avatar).length;
  const usersWithCountry = usersAll.filter(u => !!u.country).length;
  const usersWithCity = usersAll.filter(u => !!u.city).length;
  const usersWithExtra = usersAll.filter(u => !!u.extra && u.extra !== '{}').length;
  const onlineCount = online.size;
  const peakConcurrent = Math.max(peakConcurrentUsers, onlineCount);
  // 时间分布
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const todayMs = today0.getTime();
  const newUsersToday = usersAll.filter(u => u.created_at >= todayMs).length;
  const newUsers7d = usersAll.filter(u => u.created_at >= now - 7 * 86400000).length;
  const newUsers30d = usersAll.filter(u => u.created_at >= now - 30 * 86400000).length;
  // 在线用户列表
  const onlineUsers = usersAll.filter(u => onlineIds.has(u.id)).map(u => ({
    id: u.id, username: u.username, nickname: u.nickname, uid: u.uid, email: u.email
  }));

  // 好友
  const friendships = prepare('SELECT id, user_id, friend_id, status, created_at FROM friends').all();
  const friendshipAccepted = friendships.filter(f => f.status === 1).length;
  const friendshipPending = friendships.filter(f => f.status === 0).length;

  // 群组
  let groupsCount = 0;
  try { groupsCount = prepare('SELECT COUNT(*) AS c FROM groups').get().c; } catch { groupsCount = 0; }
  let groupMembers = [];
  let groupMessagesCount = 0;
  let groupMessagesTodayCount = 0;
  let biggestGroups = [];
  try {
    groupMembers = prepare('SELECT group_id, user_id, joined_at FROM group_members').all();
    groupMessagesCount = prepare('SELECT COUNT(*) AS c FROM group_messages').get().c;
    groupMessagesTodayCount = prepare('SELECT COUNT(*) AS c FROM group_messages WHERE created_at>=?').get(todayMs).c;
    biggestGroups = prepare(
      `SELECT g.id, g.name, g.owner_id AS ownerId, COUNT(m.user_id) AS memberCount
       FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
       GROUP BY g.id ORDER BY memberCount DESC LIMIT 5`
    ).all().map(r => ({ id: r.id, name: r.name, ownerId: r.ownerId, memberCount: r.memberCount }));
  } catch {}

  // 单聊消息
  let pmCount = 0, pmTodayCount = 0, pmReadCount = 0;
  try {
    pmCount = prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    pmTodayCount = prepare('SELECT COUNT(*) AS c FROM messages WHERE created_at>=?').get(todayMs).c;
    pmReadCount = prepare('SELECT COUNT(*) AS c FROM messages WHERE read=1').get().c;
  } catch {}

  // 反馈
  let feedbacks = [];
  let feedbackOpen = 0, feedbackProcessing = 0, feedbackClosed = 0;
  let feedbacksByKind = { bug: 0, suggestion: 0, complaint: 0, other: 0 };
  let feedbacksToday = 0;
  try {
    feedbacks = prepare('SELECT id, user_id AS userId, kind, content, status, created_at FROM feedbacks ORDER BY created_at DESC').all();
    feedbackOpen = feedbacks.filter(f => f.status === 'open').length;
    feedbackProcessing = feedbacks.filter(f => f.status === 'processing').length;
    feedbackClosed = feedbacks.filter(f => f.status === 'closed').length;
    for (const f of feedbacks) { if (feedbacksByKind[f.kind] !== undefined) feedbacksByKind[f.kind]++; }
    feedbacksToday = feedbacks.filter(f => f.created_at >= todayMs).length;
  } catch {}

  // 存储
  const adminDbPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'chat.sqlite');
  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(adminDbPath).size; } catch {}

  res.json({
    system: {
      hostname: process.env.COMPUTERNAME || require('os').hostname(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeMs,
      uptimeHuman: humanMs(uptimeMs),
      startedAt: START_AT,
      now,
      serverTime: new Date(now).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    realtime: {
      onlineCount,
      peakConcurrent,
      sentMsgsLastMin: sentMsgsLastMinCounter,
      recvMsgsLastMin: recvMsgsLastMinCounter,
      peakMsgsPerMin
    },
    users: {
      total: userCount,
      online: onlineCount,
      onlineUsers,
      newUsersToday,
      newUsers7d,
      newUsers30d,
      withEmail: usersWithEmail,
      withAvatar: usersWithAvatar,
      withCountry: usersWithCountry,
      withCity: usersWithCity,
      withExtra: usersWithExtra
    },
    friendships: {
      accepted: friendshipAccepted,
      pending: friendshipPending
    },
    groups: {
      total: groupsCount,
      messagesToday: groupMessagesTodayCount,
      messagesTotal: groupMessagesCount,
      biggest: biggestGroups,
      memberEdges: groupMembers.length
    },
    messages: {
      privateTotal: pmCount,
      privateToday: pmTodayCount,
      privateRead: pmReadCount,
      privateUnread: Math.max(0, pmCount - pmReadCount),
      groupTotal: groupMessagesCount,
      groupToday: groupMessagesTodayCount,
      allTotal: pmCount + groupMessagesCount,
      allToday: pmTodayCount + groupMessagesTodayCount
    },
    feedbacks: {
      all: feedbacks,
      total: feedbacks.length,
      open: feedbackOpen,
      processing: feedbackProcessing,
      closed: feedbackClosed,
      today: feedbacksToday,
      byKind: feedbacksByKind
    },
    storage: {
      dbPath: adminDbPath,
      dbSizeBytes,
      dbSizeHuman: humanBytes(dbSizeBytes)
    },
    admin: {
      youAre: { id: guard.u.id, username: guard.u.username, email: guard.u.email },
      adminEmails: ADMIN_EMAILS.slice()
    }
  });
});

// GET /api/admin/users —— 返回全部用户（含未在线），含在线/封禁状态
app.get('/api/admin/users', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const rows = prepare(
    'SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,banned,banned_at,banned_by,ban_reason,role,last_login_at,created_at FROM users ORDER BY created_at DESC'
  ).all();
  const onlineIds = new Set();
  for (const id of online.keys()) onlineIds.add(id);
  const list = rows.map(u => ({
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
    uid: u.uid, email: u.email || '', country: u.country || '', province: u.province || '', city: u.city || '',
    online: onlineIds.has(u.id),
    banned: !!u.banned,
    bannedAt: u.banned_at || null,
    bannedBy: u.banned_by || null,
    banReason: u.ban_reason || '',
    role: u.role || 'user',
    lastLoginAt: u.last_login_at || null,
    createdAt: u.created_at
  }));
  res.json({ users: list, total: list.length });
});

// POST /api/admin/ban —— 封禁/解封用户 { id, banned, reason? }
app.post('/api/admin/ban', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.body || {}).id);
  const banned = !!(req.body || {}).banned;
  if (!id) return res.status(400).json({ error: '缺少用户ID' });
  const target = prepare('SELECT id,username,email FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  // 不允许封禁管理员自己/其他管理员
  if (isAdmin(target)) return res.status(400).json({ error: '不能封禁管理员账号' });
  if (banned) {
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
    prepare('UPDATE users SET banned=1, banned_at=?, banned_by=?, ban_reason=?, token_version=COALESCE(token_version,0)+1 WHERE id=?')
      .run(Date.now(), guard.u.id, reason, id);
  } else {
    prepare('UPDATE users SET banned=0, banned_at=NULL, banned_by=NULL, ban_reason=NULL WHERE id=?').run(id);
  }
  // 若该用户在线，断开其 WebSocket 强制下线
  for (const ws of online.get(id) || []) {
    try { send(ws, 'KICKED', { reason: banned ? '账号已被封禁' : '账号已解封' }); } catch {}
  }
  try { online.delete(id); } catch {}
  res.json({ ok: true, id, banned });
});

// ---------- 通用：审计日志 + 客户端IP ----------
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (process.env.TRUST_PROXY === '1' && xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress || '').replace('::ffff:', '') || '';
}
function logAudit(adminId, action, targetId, targetType, detail, ip) {
  try {
    prepare('INSERT INTO audit_logs(admin_id,action,target_id,target_type,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(adminId || null, action, targetId || null, targetType || '', detail || '', ip || '', Date.now());
  } catch (e) { console.error('[audit] 写入失败', e.message); }
}

// GET /api/admin/audit —— 审计日志列表
app.get('/api/admin/audit', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const limit = Math.min(parseInt((req.query || {}).limit || '200', 10) || 200, 1000);
  const action = String((req.query || {}).action || '').trim();
  let rows;
  try {
    rows = action
      ? prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY created_at DESC LIMIT ?').all(action, limit)
      : prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  } catch (e) { return res.json({ logs: [] }); }
  res.json({ logs: rows.map(r => ({ id: r.id, adminId: r.admin_id, action: r.action, targetId: r.target_id, targetType: r.target_type, detail: r.detail, ip: r.ip, createdAt: r.created_at })) });
});

// ============ 聊天回放（管理员审计）============
// 明文存储后服务端可读消息原文，这里提供按会话回放的只读接口。
// 高敏感能力：一律走 adminGuard，且每次调用写审计日志。

// GET /api/admin/replay/conversations —— 会话清单（单聊 + 群聊），按最后消息时间倒序
app.get('/api/admin/replay/conversations', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const limit = Math.min(parseInt((req.query || {}).limit || '200', 10) || 200, 1000);
  const out = [];
  try {
    // 单聊：按 (min(from,to), max(from,to)) 归一化成一个会话
    const direct = prepare(`SELECT
        MIN(from_id, to_id) AS a, MAX(from_id, to_id) AS b,
        COUNT(*) AS cnt, MAX(created_at) AS lastAt
      FROM messages
      GROUP BY MIN(from_id, to_id), MAX(from_id, to_id)
      ORDER BY lastAt DESC LIMIT ?`).all(limit);
    for (const r of direct) {
      const ua = prepare('SELECT id,username,nickname FROM users WHERE id=?').get(r.a);
      const ub = prepare('SELECT id,username,nickname FROM users WHERE id=?').get(r.b);
      out.push({
        kind: 'direct',
        key: 'd:' + r.a + ':' + r.b,
        peerA: ua ? { id: ua.id, name: ua.nickname || ua.username } : { id: r.a, name: '#' + r.a },
        peerB: ub ? { id: ub.id, name: ub.nickname || ub.username } : { id: r.b, name: '#' + r.b },
        title: (ua ? (ua.nickname || ua.username) : '#' + r.a) + ' ↔ ' + (ub ? (ub.nickname || ub.username) : '#' + r.b),
        messageCount: r.cnt,
        lastAt: r.lastAt
      });
    }
    // 群聊
    const groups = prepare(`SELECT gm.group_id AS gid, COUNT(*) AS cnt, MAX(gm.created_at) AS lastAt
      FROM group_messages gm GROUP BY gm.group_id ORDER BY lastAt DESC LIMIT ?`).all(limit);
    for (const r of groups) {
      const g = prepare('SELECT id,name FROM groups WHERE id=?').get(r.gid);
      out.push({
        kind: 'group',
        key: 'g:' + r.gid,
        groupId: r.gid,
        title: (g ? g.name : '群#' + r.gid),
        messageCount: r.cnt,
        lastAt: r.lastAt
      });
    }
  } catch (e) {
    return res.status(500).json({ error: '读取会话失败' });
  }
  out.sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));
  logAudit(guard.u.id, 'replay_list', null, 'conversation', '查看会话清单', clientIp(req));
  res.json({ conversations: out.slice(0, limit) });
});

// GET /api/admin/replay/messages —— 某会话的完整消息流（按时间正序，供回放）
//   单聊: ?kind=direct&a=<uid>&b=<uid>
//   群聊: ?kind=group&groupId=<gid>
//   可选: &limit=&before=&after=
app.get('/api/admin/replay/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const q = req.query || {};
  const kind = String(q.kind || 'direct');
  const limit = Math.min(parseInt(q.limit || '500', 10) || 500, 5000);
  const after = Number(q.after) || 0;
  const before = Number(q.before) || Number.MAX_SAFE_INTEGER;
  const nameCache = new Map();
  const nameOf = (uid) => {
    if (nameCache.has(uid)) return nameCache.get(uid);
    const u = prepare('SELECT id,username,nickname FROM users WHERE id=?').get(uid);
    const n = u ? (u.nickname || u.username) : '#' + uid;
    nameCache.set(uid, n);
    return n;
  };
  try {
    if (kind === 'group') {
      const gid = Number(q.groupId);
      if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ error: '缺少 groupId' });
      const g = prepare('SELECT id,name FROM groups WHERE id=?').get(gid);
      const rows = prepare(`SELECT id,group_id,from_id,content,created_at,recalled
        FROM group_messages WHERE group_id=? AND created_at>? AND created_at<?
        ORDER BY created_at ASC, id ASC LIMIT ?`).all(gid, after, before, limit);
      logAudit(guard.u.id, 'replay_view', gid, 'group', '回放群聊 ' + (g ? g.name : gid) + '（' + rows.length + ' 条）', clientIp(req));
      return res.json({
        kind: 'group',
        title: g ? g.name : '群#' + gid,
        groupId: gid,
        messages: rows.map(r => ({
          id: r.id, from: r.from_id, fromName: nameOf(r.from_id),
          content: r.content, createdAt: r.created_at, recalled: !!r.recalled
        }))
      });
    }
    const a = Number(q.a), b = Number(q.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
      return res.status(400).json({ error: '缺少会话双方 id' });
    }
    const rows = prepare(`SELECT m.id,m.from_id,m.to_id,m.content,m.created_at,m.read,m.recalled
      FROM messages m
      WHERE ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?))
        AND m.created_at>? AND m.created_at<?
      ORDER BY m.created_at ASC, m.id ASC LIMIT ?`).all(a, b, b, a, after, before, limit);
    logAudit(guard.u.id, 'replay_view', a, 'user', '回放单聊 ' + nameOf(a) + ' ↔ ' + nameOf(b) + '（' + rows.length + ' 条）', clientIp(req));
    res.json({
      kind: 'direct',
      title: nameOf(a) + ' ↔ ' + nameOf(b),
      peerA: { id: a, name: nameOf(a) },
      peerB: { id: b, name: nameOf(b) },
      messages: rows.map(r => ({
        id: r.id, from: r.from_id, fromName: nameOf(r.from_id), to: r.to_id,
        content: r.content, createdAt: r.created_at, read: !!r.read, recalled: !!r.recalled
      }))
    });
  } catch (e) {
    res.status(500).json({ error: '读取消息失败' });
  }
});

// POST /api/admin/kick —— 强制下线（不封禁）
app.post('/api/admin/kick', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.body || {}).id);
  if (!id) return res.status(400).json({ error: '缺少用户ID' });
  const target = prepare('SELECT id,username FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  for (const ws of online.get(id) || []) { try { send(ws, P.S_KICKED, { reason: (req.body || {}).reason || '已被管理员强制下线' }); } catch {} }
  try { online.delete(id); } catch {}
  logAudit(guard.u.id, 'kick', id, 'user', '强制下线 ' + target.username, clientIp(req));
  broadcastUserList();
  res.json({ ok: true, id });
});

// POST /api/admin/ban-ip —— 封禁 IP { ip, reason }
app.post('/api/admin/ban-ip', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const ip = String((req.body || {}).ip || '').trim();
  if (!ip) return res.status(400).json({ error: '缺少IP' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
  try { prepare('INSERT OR IGNORE INTO banned_ips(ip,reason,created_by,created_at) VALUES(?,?,?,?)').run(ip, reason, guard.u.id, Date.now()); } catch (e) {}
  // 将该 IP 的所有在线用户踢下线
  const targetIp = ip;
  for (const [uid, list] of online.entries()) {
    for (const ws of list) {
      if (ws._ip === targetIp) { try { send(ws, P.S_KICKED, { reason: 'IP 已被封禁' }); } catch {} }
    }
  }
  logAudit(guard.u.id, 'ban_ip', null, 'ip', '封禁IP ' + ip + (reason ? ' (' + reason + ')' : ''), clientIp(req));
  res.json({ ok: true, ip });
});

// GET /api/admin/banned-ips / DELETE /api/admin/banned-ips
app.get('/api/admin/banned-ips', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  let rows;
  try { rows = prepare('SELECT * FROM banned_ips ORDER BY created_at DESC').all(); } catch (e) { rows = []; }
  res.json({ ips: rows });
});
app.delete('/api/admin/banned-ips', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const ip = String((req.query || {}).ip || (req.body || {}).ip || '').trim();
  if (!ip) return res.status(400).json({ error: '缺少IP' });
  try { prepare('DELETE FROM banned_ips WHERE ip=?').run(ip); } catch (e) {}
  logAudit(guard.u.id, 'unban_ip', null, 'ip', '解封IP ' + ip, clientIp(req));
  res.json({ ok: true, ip });
});

// POST /api/admin/user/update —— 修改昵称/角色/头像等 { id, nickname?, role?, avatar? }
app.post('/api/admin/user/update', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.body || {}).id);
  const b = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少用户ID' });
  const target = prepare('SELECT id,username,nickname,role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (b.nickname !== undefined) {
    const nickname = String(b.nickname).trim().slice(0, 30);
    if (nickname) prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname, id);
  }
  if (b.role !== undefined) {
    const role = String(b.role).trim();
    if (['user', 'vip', 'admin'].includes(role)) {
      if (role === 'admin' && isAdmin(target)) return res.status(400).json({ error: '不能修改管理员角色' });
      prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    }
  }
  logAudit(guard.u.id, 'user_update', id, 'user', '修改用户 ' + target.username, clientIp(req));
  res.json({ ok: true, id });
});

// POST /api/admin/user/reset-password —— 重置密码为随机
app.post('/api/admin/user/reset-password', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.body || {}).id);
  if (!id) return res.status(400).json({ error: '缺少用户ID' });
  const target = prepare('SELECT id,username FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (isAdmin(target)) return res.status(400).json({ error: '不能重置管理员密码' });
  const pwd = String((req.body || {}).password || '').trim();
  if (!pwd) return res.status(400).json({ error: '缺少新密码' });
  if (pwd.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync(pwd, 10);
  prepare('UPDATE users SET password=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').run(hash, id);
  // 重置后强制下线
  for (const ws of online.get(id) || []) { try { send(ws, P.S_KICKED, { reason: '密码已被管理员重置' }); } catch {} }
  try { online.delete(id); } catch {}
  logAudit(guard.u.id, 'reset_password', id, 'user', '重置密码 ' + target.username, clientIp(req));
  res.json({ ok: true, id });
});

// ---------- 系统公告 ----------
// POST /api/admin/announcements { title, content, level?, top? }
app.post('/api/admin/announcements', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const title = String((req.body || {}).title || '').trim().slice(0, 100);
  const content = String((req.body || {}).content || '').trim().slice(0, 2000);
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
  const level = ['info', 'warning', 'danger'].includes((req.body || {}).level) ? (req.body || {}).level : 'info';
  const top = !!(req.body || {}).top ? 1 : 0;
  const row = prepare('INSERT INTO announcements(title,content,level,top,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(title, content, level, top, guard.u.id, Date.now());
  const ann = { id: row.lastInsertRowid, title, content, level, top, createdBy: guard.u.id, createdAt: Date.now() };
  // 广播给所有在线用户
  for (const uid of online.keys()) sendToUser(uid, P.S_ANNOUNCEMENT, { announcement: ann });
  logAudit(guard.u.id, 'announce', null, 'announcement', '发布公告: ' + title, clientIp(req));
  res.json({ ok: true, announcement: ann });
});

// GET /api/admin/announcements —— 管理员查看全部
app.get('/api/admin/announcements', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  let rows;
  try { rows = prepare('SELECT * FROM announcements ORDER BY top DESC, id DESC').all(); } catch (e) { rows = []; }
  res.json({ announcements: rows.map(a => ({ id: a.id, title: a.title, content: a.content, level: a.level, top: a.top, createdBy: a.created_by, createdAt: a.created_at, expiresAt: a.expires_at })) });
});

// DELETE /api/admin/announcements?id=
app.delete('/api/admin/announcements', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.query || {}).id || (req.body || {}).id);
  if (!id) return res.status(400).json({ error: '缺少公告ID' });
  try { prepare('DELETE FROM announcements WHERE id=?').run(id); } catch (e) {}
  logAudit(guard.u.id, 'announce_delete', id, 'announcement', '删除公告 #' + id, clientIp(req));
  res.json({ ok: true, id });
});

// GET /api/announcements —— 用户拉取有效公告（未过期，最多5条）
app.get('/api/announcements', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const now = Date.now();
  let rows;
  try {
    rows = prepare('SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY top DESC, id DESC LIMIT 5').all(now);
  } catch (e) { rows = []; }
  res.json({ announcements: rows.map(a => ({ id: a.id, title: a.title, content: a.content, level: a.level, top: a.top, createdAt: a.created_at })) });
});

// ---------- 敏感词 ----------
// GET /api/admin/sensitive-words
app.get('/api/admin/sensitive-words', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  let rows;
  try { rows = prepare('SELECT * FROM sensitive_words ORDER BY id DESC').all(); } catch (e) { rows = []; }
  res.json({ words: rows });
});
// POST /api/admin/sensitive-words { word }
app.post('/api/admin/sensitive-words', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const word = String((req.body || {}).word || '').trim();
  if (!word) return res.status(400).json({ error: '缺少敏感词' });
  try { prepare('INSERT OR IGNORE INTO sensitive_words(word,created_by,created_at) VALUES(?,?,?)').run(word, guard.u.id, Date.now()); } catch (e) {}
  logAudit(guard.u.id, 'sensitive_add', null, 'sensitive', '添加敏感词: ' + word, clientIp(req));
  res.json({ ok: true, word });
});
// DELETE /api/admin/sensitive-words?word=
app.delete('/api/admin/sensitive-words', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const word = String((req.query || {}).word || (req.body || {}).word || '').trim();
  if (!word) return res.status(400).json({ error: '缺少敏感词' });
  try { prepare('DELETE FROM sensitive_words WHERE word=?').run(word); } catch (e) {}
  logAudit(guard.u.id, 'sensitive_del', null, 'sensitive', '删除敏感词: ' + word, clientIp(req));
  res.json({ ok: true, word });
});
// 消息敏感词检查（供发消息时调用）
function checkSensitive(content) {
  try {
    const words = prepare('SELECT word FROM sensitive_words').all();
    if (!words.length) return null;
    const c = String(content || '');
    for (const w of words) {
      if (w.word && c.includes(w.word)) return w.word;
    }
  } catch (e) {}
  return null;
}

// ---------- 群组管理 ----------
// GET /api/admin/groups —— 全部群组(含成员数/消息数)
app.get('/api/admin/groups', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const kw = String((req.query || {}).q || '').trim().toLowerCase();
  let rows;
  try {
    rows = prepare(
      `SELECT g.id,g.name,g.owner_id AS ownerId,g.created_at,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS memberCount,
        (SELECT COUNT(*) FROM group_messages gm WHERE gm.group_id=g.id) AS msgCount
       FROM groups g`
    ).all();
  } catch (e) { rows = []; }
  let list = rows;
  if (kw) list = rows.filter(g => String(g.name || '').toLowerCase().includes(kw));
  res.json({ groups: list });
});
// POST /api/admin/group/dissolve { id }
app.post('/api/admin/group/dissolve', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number((req.body || {}).id);
  if (!id) return res.status(400).json({ error: '缺少群ID' });
  const g = prepare('SELECT id,name FROM groups WHERE id=?').get(id);
  if (!g) return res.status(404).json({ error: '群不存在' });
  try { prepare('DELETE FROM group_messages WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_members WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM groups WHERE id=?').run(id); } catch (e) {}
  logAudit(guard.u.id, 'group_dissolve', id, 'group', '解散群: ' + g.name, clientIp(req));
  broadcastGroups();
  res.json({ ok: true, id });
});
// POST /api/admin/group/remove-member { groupId, userId }
app.post('/api/admin/group/remove-member', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const groupId = Number((req.body || {}).groupId);
  const userId = Number((req.body || {}).userId);
  if (!groupId || !userId) return res.status(400).json({ error: '缺少参数' });
  try { prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(groupId, userId); } catch (e) {}
  logAudit(guard.u.id, 'group_remove_member', userId, 'user', '从群 #' + groupId + ' 移除成员', clientIp(req));
  broadcastGroups();
  res.json({ ok: true });
});
// GET /api/admin/group/:id —— 群详情(成员列表)
app.get('/api/admin/group/:id', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '缺少群ID' });
  const g = prepare('SELECT * FROM groups WHERE id=?').get(id);
  if (!g) return res.status(404).json({ error: '群不存在' });
  let members;
  try {
    members = prepare(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.banned
       FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=?`
    ).all(id);
  } catch (e) { members = []; }
  res.json({ group: { id: g.id, name: g.name, ownerId: g.owner_id, createdAt: g.created_at }, members });
});


// 把毫秒转成 "1d 2h 3m"
function humanMs(ms) {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}
// 把字节数转成 "12 KB"
function humanBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ---------- 托管网页端静态资源 ----------
// /downloads/* 托管安装包目录（server/downloads），不存在则 404；前端 download.html 会处理"暂未提供"情况。
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
const webDir = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
// admin/chat 页禁止缓存，避免更新后浏览器/SW 卡旧版
app.get(['/admin.html', '/chat.html', '/merchant.html', '/wallet-pay.html', '/index.html', '/chat', '/'], (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(webDir, { setHeaders: (res, filePath) => {
  if (/\.html$/i.test(filePath)) { res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); }
  if (/\.js$/i.test(filePath)) { res.set('Content-Type', 'text/javascript; charset=utf-8'); res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); }
  if (/\.css$/i.test(filePath)) { res.set('Content-Type', 'text/css; charset=utf-8'); res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}}));
app.get('/', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(webDir, 'index.html')); });
app.get('/chat', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(webDir, 'chat.html')); });

const CERT_PATH = process.env.CERT_PATH || path.join(process.cwd(), 'portable', 'le.crt');
const KEY_PATH = process.env.KEY_PATH || path.join(process.cwd(), 'portable', 'le.key');
const PFX_PATH = process.env.PFX_PATH || path.join(process.cwd(), 'portable', 'le.pfx');
const PFX_PASS = process.env.PFX_PASS || '';
let server;
if (process.env.USE_HTTPS === '1' && fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  const https = require('https');
  server = https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, app);
} else if (process.env.USE_HTTPS === '1' && fs.existsSync(PFX_PATH)) {
  const https = require('https');
  server = https.createServer({ pfx: fs.readFileSync(PFX_PATH), passphrase: PFX_PASS }, app);
} else {
  server = http.createServer(app);
}

try {
  const epayHttpPort = Number(process.env.EPAY_HTTP_PORT || 8889);
  http.createServer(app).listen(epayHttpPort, '127.0.0.1', () => {
    console.log('[epaygw] http 监听 127.0.0.1:' + epayHttpPort);
  });
} catch (e) { console.error('[epaygw] http 监听失败: ' + (e && e.message || e)); }

// ---------- WebSocket ----------
// 跨源放行（前端 cloudflared 域名 与 API 域名不同源时需要）
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: (info, cb) => { cb(true); }
});
const online = new Map();

// 多端连接辅助：online Map: uid -> [ws,...]。以下为统一入口
function onlineWss(uid) {
  return online.get(uid) || [];
}
function onlineHas(uid) {
  const list = online.get(uid);
  return !!(list && list.length);
}
function onlineAny(uid) {
  return onlineHas(uid);
}
function sendToUser(uid, type, payload) {
  for (const ws of onlineWss(uid)) send(ws, type, payload);
}
function removeWs(uid, ws) {
  const list = online.get(uid);
  if (!list) return;
  const i = list.indexOf(ws);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) online.delete(uid);
}

wss.on('connection', (ws, req) => {
  ws.uid = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 未认证客户端10秒超时
  const authTimer = setTimeout(() => { if (!ws.uid) try { ws.close(4001, 'auth timeout'); } catch {} }, 10000);
  ws.on('close', () => { try { clearTimeout(authTimer); } catch {} });

  ws.on('message', (buf) => {
    let data;
    try {
      if (buf.length > MAX_MSG_CONTENT) { send(ws, P.S_ERROR || 'error', { error: '消息过大' }); return; }
      data = JSON.parse(buf.toString());
    } catch { return; }
    const { type, payload } = data;

    try {
    if (type === P.C_AUTH) {
      const user = verifyToken(payload.token);
      if (!user) return send(ws, P.S_AUTH_FAIL, { error: '令牌无效' });
       const dbUser = prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if (!dbUser) return send(ws, P.S_AUTH_FAIL, { error: '用户不存在' });
      if (dbUser.banned) return send(ws, P.S_AUTH_FAIL, { error: '该账号已被封禁' + (dbUser.ban_reason ? '：' + dbUser.ban_reason : '') });
      ws.uid = dbUser.id;
      try { clearTimeout(authTimer); } catch {} // 认证成功，清除超时
      ws.user = publicUser(dbUser);
      ws._ip = clientIp({ headers: {}, socket: ws._socket || ws._req || {} });
      // IP 封禁校验
      try {
        const bip = ws._ip ? prepare('SELECT ip FROM banned_ips WHERE ip=?').get(ws._ip) : null;
        if (bip) return send(ws, P.S_AUTH_FAIL, { error: '当前IP已被封禁' });
      } catch (e) {}
      // 多端登录：同一 uid 允许多个 WS 连接（Map 存数组）
      const list = online.get(dbUser.id) || [];
      list.push(ws);
      online.set(dbUser.id, list);
      if (online.size > peakConcurrentUsers) peakConcurrentUsers = online.size;
      send(ws, P.S_AUTH_OK, { user: ws.user });
      broadcastUserList();
      pushFriendList(dbUser.id);
      broadcastGroups();
      // 推送待处理好友请求数（供 UI 提示）
      const reqs = prepare(
         `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen
         FROM friends f JOIN users u ON u.id = f.user_id
         WHERE f.friend_id=? AND f.status=0 ORDER BY f.created_at DESC`
      ).all(dbUser.id);
      for (const r of reqs) send(ws, P.S_FRIEND_REQ, { from: r.id, fromUser: publicUser(r) });
      // 推送离线未读消息（断线期间积累的消息）
      try {
        const offlineMsgs = prepare('SELECT * FROM messages WHERE to_id=? AND read=0 ORDER BY created_at DESC LIMIT 200').all(dbUser.id);
        for (const m of offlineMsgs) {
          send(ws, P.S_MSG, { id: m.id, from: m.from_id, to: m.to_id, content: m.content, createdAt: m.created_at, read: false, replyTo: m.reply_to || null, clientMsgId: m.client_msg_id || null, forwardedFrom: m.forwarded_from || null, burnAfterReading: !!m.burn_after_reading });
        }
      } catch (e) {}
      // 记录最后登录时间与 IP
      try { prepare('UPDATE users SET last_login_at=?, last_ip=?, last_seen=? WHERE id=?').run(Date.now(), ws._ip || '', Date.now(), dbUser.id); } catch (e) {}
      return;
    }

    if (type === P.C_MSG) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { to, content, clientMsgId, replyTo, forwardedFrom, burnAfterReading } = payload || {};
      if ((typeof to !== 'number' && typeof to !== 'string') || !/^\d+$/.test(String(to))) return send(ws, P.S_ERROR, { error: '目标无效' });
      const toId = Number(to);
      if (toId === undefined || !Number.isInteger(toId) || !content) return send(ws, P.S_ERROR, { error: '消息内容无效' });
      if (toId === ws.uid) return send(ws, P.S_ERROR, { error: '不能给自己发送消息' });
      if (!prepare('SELECT 1 FROM users WHERE id=?').get(toId)) return send(ws, P.S_ERROR, { error: '目标用户不存在' });
      if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) {
        return send(ws, P.S_ERROR, { error: '消息标识无效' });
      }
      const metaFlag = Number(replyTo) || Number(forwardedFrom) || !!burnAfterReading;
      // Retries reuse clientMsgId. Return the original message instead of
      // inserting a duplicate row or delivering it twice.
      if (clientMsgId) {
        const existing = prepare('SELECT id,from_id AS senderId,to_id AS recipientId,content,created_at AS createdAt FROM messages WHERE client_msg_id=? AND from_id=?').get(clientMsgId, ws.uid);
        if (existing) {
          // content 已是客户端密文，不再 decrypt
          send(ws, P.S_MSG, { id: existing.id, from: existing.senderId, to: existing.recipientId, content: existing.content, createdAt: existing.createdAt, clientMsgId });
          return;
        }
      }
      const blocked1 = prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(toId, ws.uid);
      const blocked2 = prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(ws.uid, toId);
      if (blocked1 || blocked2) { send(ws, P.S_ERROR, { error: '无法发送（黑名单）' }); return; }
      // Cleartext path: from_id -> peer without E2EE. content 已被客户端加密为密文；服务端只存储/转发，不再加解密。
      const createdAt = Date.now();
      const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
        .run(ws.uid, toId, content, clientMsgId || null, createdAt);
      if (metaFlag) {
        prepare('INSERT INTO message_meta(message_id,reply_to,forwarded_from,burn_after_reading,updated_at) VALUES(?,?,?,?,?)')
          .run(info.lastInsertRowid, Number(replyTo) || null, Number(forwardedFrom) || null, burnAfterReading ? 1 : 0, createdAt);
      }
      const msgObj = { id: info.lastInsertRowid, from: ws.uid, to: toId, content, createdAt, clientMsgId: clientMsgId || null, replyTo: Number(replyTo) || null, forwardedFrom: Number(forwardedFrom) || null, burnAfterReading: !!burnAfterReading, read: 0 };
      let replyContent = null, replyFrom = null, replyRecalled = false;
      if (msgObj.replyTo) {
        try {
          const pm = prepare('SELECT content,from_id,recalled FROM messages WHERE id=? AND (from_id=? OR to_id=?)').get(msgObj.replyTo, ws.uid, ws.uid);
          if (pm) { replyContent = pm.content; replyFrom = pm.from_id; replyRecalled = !!pm.recalled; }
        } catch (e) {}
      }
      msgObj.replyContent = replyContent; msgObj.replyFrom = replyFrom; msgObj.replyRecalled = replyRecalled;
      send(ws, P.S_MSG, msgObj);
      const peer = onlineAny(toId);
      if (peer) sendToUser(toId, P.S_MSG, msgObj);
      // 实时计数：发1 收1（对方在线则记一次接收）
      sentMsgsThisMinCounter += 1;
      if (peer) recvMsgsThisMinCounter += 1;
      return;
    }

    if (type === P.C_READ) {
      if (!ws.uid) return;
      const { from } = payload || {};
      prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=?').run(Number(from), ws.uid);
      // 通知发送方：对方已读
      if (Number.isInteger(Number(from)) && onlineAny(Number(from))) sendToUser(Number(from), P.S_MSG_READ, { peerId: ws.uid });
      return;
    }

    // 群消息：C_GROUP_MSG { groupId, content }
    if (type === P.C_GROUP_MSG) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { groupId, content, clientMsgId, replyTo, forwardedFrom } = payload || {};
      const gid = Number(groupId);
      if (!Number.isInteger(gid) || !content) return send(ws, P.S_ERROR, { error: '消息内容无效' });
      if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) {
        return send(ws, P.S_ERROR, { error: '消息标识无效' });
      }
      const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(gid, ws.uid);
      if (!isMember) return send(ws, P.S_ERROR, { error: '你不在此群' });
      // 重试复用 clientMsgId：返回原消息，不再插入/广播第二条
      if (clientMsgId) {
        const existing = prepare('SELECT id,group_id AS groupId,from_id AS fromId,content,created_at AS createdAt FROM group_messages WHERE client_msg_id=? AND from_id=? AND group_id=?').get(clientMsgId, ws.uid, gid);
        if (existing) {
          send(ws, P.S_GROUP_MSG, { id: existing.id, groupId: existing.groupId, from: existing.fromId, content: existing.content, createdAt: existing.createdAt, clientMsgId, fromUser: ws.user });
          return;
        }
      }
      const enc = content;
      const now = Date.now();
      const info = prepare('INSERT INTO group_messages(group_id,from_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
        .run(gid, ws.uid, enc, clientMsgId || null, now);
      const replyToId = Number(replyTo) || null;
      const forwardedFromId = Number(forwardedFrom) || null;
      let replyContent = null, replyFrom = null;
      if (replyToId) {
        try {
          prepare('INSERT INTO group_message_meta(message_id,reply_to,forwarded_from,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,forwarded_from=excluded.forwarded_from,updated_at=excluded.updated_at')
            .run(info.lastInsertRowid, replyToId, forwardedFromId || null, now);
          const pm = prepare('SELECT content,from_id FROM group_messages WHERE id=? AND group_id=?').get(replyToId, gid);
          if (pm) { replyContent = pm.content; replyFrom = pm.from_id; }
        } catch (e) {}
      } else if (forwardedFromId) {
        try {
          prepare('INSERT INTO group_message_meta(message_id,reply_to,forwarded_from,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,forwarded_from=excluded.forwarded_from,updated_at=excluded.updated_at')
            .run(info.lastInsertRowid, null, forwardedFromId, now);
        } catch (e) {}
      }
      const msgObj = { id: info.lastInsertRowid, groupId: gid, from: ws.uid, fromUid: ws.user.uid, content, createdAt: now, clientMsgId: clientMsgId || null, replyTo: replyToId, replyContent, replyFrom, forwardedFrom: forwardedFromId || null, read: true, readCount: 1 };
      // 给群里所有在线成员（包括自己）都推送，附带 fromUser 便于客户端显示昵称
      const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gid);
      const fromUser = ws.user;
      for (const m of members) {
        if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { ...msgObj, fromUser });
      }
      // 实时计数：群消息按 发1 + 在线成员接收 计
      sentMsgsThisMinCounter += 1;
      recvMsgsThisMinCounter += members.filter(m => m.user_id === ws.uid || onlineHas(m.user_id)).length;
      return;
    }

    // 群已读：C_GROUP_READ { groupId } —— 落库 message_reads 并广播群已读
    if (type === P.C_GROUP_READ) {
      if (!ws.uid) return;
      const { groupId } = payload || {};
      const gid = Number(groupId);
      if (!Number.isInteger(gid)) return;
      // 成员校验：非群成员不得写入/触发广播
      const isMember = prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid, ws.uid);
      if (!isMember) return;
      try {
        // 单条批量 INSERT 把未读群消息一次性标记为已读（避免逐条遍历，性能优化）
        const now = Date.now();
        prepare(
          `INSERT OR IGNORE INTO message_reads(message_id,user_id,read_at)
           SELECT id,?,? FROM group_messages
           WHERE group_id=? AND from_id<>? AND id NOT IN (
             SELECT message_id FROM message_reads WHERE user_id=?
           )`
        ).run(ws.uid, now, gid, ws.uid, ws.uid);
        if (prepare('SELECT 1 FROM message_reads WHERE user_id=? LIMIT 1').get(ws.uid)) persist();
        // 广播给群内其他在线成员：userId 已读该群，客户端据此刷新已读人数
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gid);
        for (const mm of members) {
          if (mm.user_id !== ws.uid && onlineAny(mm.user_id)) {
            sendToUser(mm.user_id, P.S_GROUP_MSG_READ, { groupId: gid, userId: ws.uid });
          }
        }
      } catch (e) { /* 忽略 */ }
      return;
    }

    if (type === P.C_TYPING) {
      if (!ws.uid) return;
      const { to } = payload || {};
      const toId = Number(to);
      if (Number.isInteger(toId) && onlineAny(toId)) sendToUser(toId, P.S_TYPING, { from: ws.uid });
      return;
    }

    // 信令转发：用于 WebRTC（音视频/文件 DataChannel）的 offer/answer/ICE/挂断等
    if (type === P.C_SIGNAL) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { to, sub, data } = payload || {};
      const toId = Number(to);
      if (!Number.isInteger(toId) || !sub) return;
      if (!onlineAny(toId)) {
        send(ws, P.S_SIGNAL, { from: toId, sub: 'peer_offline', data: null });
        return;
      }
      sendToUser(toId, P.S_SIGNAL, { from: ws.uid, sub, data });
      return;
    }
    } catch (err) {
      console.error('[WS] message handler error:', err && err.stack || err);
      try { send(ws, P.S_ERROR, { error: '服务器内部错误' }); } catch {}
    }
  });

  ws.on('close', () => {
    if (ws.uid) {
      // 记录最后在线时间（先更新再广播，让 S_USER_LIST 带上最新 lastSeen）
      try { prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), ws.uid); } catch (e) {}
      removeWs(ws.uid, ws);
      broadcastUserList();
      broadcastGroups();
    }
  });
});

// WebSocket 心跳：30秒 ping，清理僵尸连接
const WS_PING_INTERVAL = 30000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_PING_INTERVAL);

let _lastUserListHash = '';
function broadcastUserList() {
  const users = prepare('SELECT id,username,nickname,avatar,uid,country,province,city,extra,pubkey,last_seen FROM users').all();
  const list = users.map(u => ({ ...publicUser(u), online: onlineHas(u.id) }));
  // 简单哈希去重：避免短时间内重复广播相同内容（如频繁改头像触发多次）
  const hash = JSON.stringify(list.map(u => u.id + ':' + u.online + ':' + u.nickname));
  if (hash === _lastUserListHash) return;
  _lastUserListHash = hash;
  for (const uid of online.keys()) sendToUser(uid, P.S_USER_LIST, { users: list });
  broadcastGroups();
}

// ---------- 挂载增强业务模块（独立 worker 产物，认证遵循各模块约定）----------
// 各 routes/*.js 与 chat-ext.js 均采用 registerXxx(app, db, auth) 签名。
//  - db   : 向各模块提供 { prepare, run, exec, persist, persistNow }。run 直通原始 sql.js db（用于 DDL），
//           prepare/persist 复用 db.js 的统一落盘实现。
//  - auth : 分组传参。groups/payment 期望 (req,res,next) 中间件并设置 req.user，故传 null 让其用内置 JWT 回退；
//           rtc/media/lifestyle/status-collar/lifestyle-msg 期望 auth(req) 返回 payload，传 apiUser；
//           chat-ext 期望 { sendToUser, onlineAny, P } 辅助对象。
// 单模块挂载失败记录日志但不阻断启动，避免一处影响全站。
function mountFeatureRoutes(app, db) {
  const rx = (m, args) => { try { require(m).apply(null, args); } catch (e) { console.error('[routes] 挂载失败 ' + m + ' : ' + (e && e.message || e)); } };

  // ---------- 表结构兼容（防止巨石 db.js 已建表但缺少数个列，导致新模块 INSERT/SELECT 报 no such column）----
  // status-collar 依赖的 user_status / favorites 由 db.js 先行建表，但缺 bg_url/created_at/expires_at（状态）、
  // name/icon/updated_at（收藏夹）。这里幂等补列，避免改动 db.js / routes/*.js。
  if (db.run) {
    const addCol = (table, col, ddl) => { try { db.run('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl); } catch (_) { /* 已存在则忽略 */ } };
    try { db.run('CREATE INDEX IF NOT EXISTS idx_user_status_expires ON user_status(expires_at)'); } catch (_) {}
    addCol('user_status', 'bg_url', 'bg_url TEXT DEFAULT \'\'');
    addCol('user_status', 'created_at', 'created_at INTEGER DEFAULT 0');
    addCol('user_status', 'expires_at', 'expires_at INTEGER DEFAULT 0');
    addCol('favorites', 'name', 'name TEXT');
    addCol('favorites', 'icon', 'icon TEXT');
    addCol('favorites', 'updated_at', 'updated_at INTEGER DEFAULT 0');
  }

  rx('./routes/groups', [app, db, null]);
  try {
    require('./routes/groups').attachGroupBroadcast((groupId, msg) => {
      try {
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
        const fromUser = prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(msg.from) || { nickname: '用户' + msg.from };
        for (const m of members) {
          if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { ...msg, fromUser });
        }
      } catch (e) {}
    });
  } catch (e) { console.error('[groups] attach broadcast failed: ' + (e && e.message || e)); }
  try {
    require('./routes/groups').attachGroupRecall(({ id, groupId, from }) => {
      try {
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
        for (const m of members) {
          if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { id, groupId, from, content: '', createdAt: Date.now(), recalled: true });
        }
      } catch (e) {}
    });
  } catch (e) { console.error('[groups] attach recall failed: ' + (e && e.message || e)); }
  try {
    require('./routes/groups').attachGroupEdit(({ groupId, id, from, content }) => {
      try {
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
        for (const m of members) {
          if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_MSG_EDIT, { messageId: id, groupId, from, content });
        }
      } catch (e) {}
    });
  } catch (e) { console.error('[groups] attach edit failed: ' + (e && e.message || e)); }
  try {
    require('./routes/groups').attachGroupMemberChange((groupId, userId, action) => {
      try {
        if (onlineAny(userId)) {
          sendToUser(userId, P.S_GROUP_MEMBER_CHANGE, { groupId, userId, action });
        }
        // 通知剩余在线成员群列表刷新
        try {
          const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
          for (const m of members) {
            if (m.user_id !== userId && onlineAny(m.user_id)) {
              sendToUser(m.user_id, P.S_GROUP_LIST, { groups: buildGroupsForUser(m.user_id) });
            }
          }
        } catch (e2) {}
      } catch (e) {}
    });
  } catch (e) { console.error('[groups] attach memberChange failed: ' + (e && e.message || e)); }
  rx('./chat-ext', [app, db, { sendToUser, onlineAny: onlineAny, P }]);
  rx('./routes/rtc', [app, db, apiUser]);
  rx('./routes/media', [app, db, apiUser]);
  rx('./routes/lifestyle', [app, db, apiUser]);
  rx('./routes/payment', [app, db, null]);
  rx('./epaygw', [app, db, null]);
  rx('./routes/status-collar', [app, db, apiUser]);
  rx('./routes/lifestyle-msg', [app, db, apiUser]);
  global.__scSendToUser = sendToUser;
  rx('./routes/redpacket', [app, db, apiUser]);
  rx('./routes/feeds', [app, db, apiUser]);
  rx('./routes/new-features', [app, db, apiUser]);
}

// 启动：先初始化数据库
(async () => {
  const rawDb = await getDb();
  ready = true;
  try { rawDb.run('CREATE TABLE IF NOT EXISTS blocklist(blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at INTEGER DEFAULT 0, PRIMARY KEY(blocker_id, blocked_id))'); } catch (e) { console.error('[db] blocklist 建表失败: ' + (e && e.message || e)); }
  try { rawDb.run('ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0'); } catch (e) { /* 已存在则忽略 */ }
  try { rawDb.run('ALTER TABLE group_message_meta ADD COLUMN forwarded_from INTEGER'); } catch (e) { /* 已存在则忽略 */ }
  const routeDb = {
    prepare, run: (...a) => rawDb.run(...a), exec: (...a) => rawDb.exec(...a),
    persist, persistNow, getDb, genUid
  };
  mountFeatureRoutes(app, routeDb);
  // 强制HTTPS终极方案：公网端口做协议探测路由。
  // 首字节0x16=TLS → 管道转发到内部TLS端口；否则 → 转发到内部HTTP重定向服务器（301到HTTPS）。
  if (process.env.USE_HTTPS === '1') {
    const httpRedirect = http.createServer((req, res) => {
      const hostHdr = String(req.headers.host || '').split(':')[0] || 'mc.32768.top';
      res.writeHead(301, { Location: 'https://' + hostHdr + ':' + PORT + (req.url || '/') });
      res.end();
    });
    const net = require('net');
    const TLS_INTERNAL = Number(process.env.TLS_INTERNAL_PORT || 18443);
    const HTTP_INTERNAL = Number(process.env.HTTP_REDIRECT_PORT || 18080);
    server.listen(TLS_INTERNAL, '127.0.0.1');
    httpRedirect.listen(HTTP_INTERNAL, '127.0.0.1');
    net.createServer((sock) => {
      // 防崩溃：error/close 监听必须先于任何异步路径注册（客户端RST不发数据时once('data')永不触发）
      sock.on('error', () => { try { sock.destroy(); } catch (_) {} });
      sock.setTimeout(15000, () => { try { sock.destroy(); } catch (_) {} }); // slowloris防护
      sock.once('data', (buf) => {
        // 立即暂停并把首块塞回流缓冲，connect期间的后续分段不会丢失
        sock.pause();
        try { sock.unshift(buf); } catch (_) {}
        const isTls = buf.length > 0 && buf[0] === 0x16;
        const target = isTls ? TLS_INTERNAL : HTTP_INTERNAL;
        const upstream = net.connect(target, '127.0.0.1', () => {
          upstream.on('error', () => { try { sock.destroy(); } catch (_) {} });
          sock.pipe(upstream);
          upstream.pipe(sock);
          sock.resume();
        });
      });
    }).listen(PORT, '0.0.0.0', () => {
      console.log(`[SecureChat] server running on https://0.0.0.0:${PORT} (plain http -> 301 https) (ws: /ws)`);
    });
  } else {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[SecureChat] server running on http://0.0.0.0:${PORT} (ws: /ws)`);
    });
  }
})();

// 退出时保存一次
process.on('SIGINT', () => { persistNow(); process.exit(0); });
process.on('exit', () => { try { persistNow(); } catch {} });
