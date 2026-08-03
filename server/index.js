'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const util = require('util');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');
const { getDb, prepare, persist, persistNow, genUid } = require('./db');
const { encrypt, decrypt } = require('../shared/crypto');
const P = require('../shared/protocol');
const execFile = util.promisify(childProcess.execFile);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
const PORT = parseInt(process.env.PORT || '8080', 10);

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

// ---------- CORS：允许网页端独立部署（不同域名）访问 API ----------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

function publicUser(u) {
  return {
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
    uid: u.uid, email: u.email || '',
    country: u.country || '', province: u.province || '', city: u.city || '',
    extra: parseExtra(u.extra),
    pubkey: u.pubkey || ''
  };
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload, v: P.VERSION }));
  }
}

let ready = false;

// ---------- REST ----------
// ---------- 验证码池（内存，按 email -> {code, expireAt, used}） ----------
const emailCodes = new Map();
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function cleanCode() { const now = Date.now(); for (const [k, v] of emailCodes) if (v.expireAt < now) emailCodes.delete(k); }

// ---------- SMTP 邮件发送（163 邮箱） ----------
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.163.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'andy130305@163.com',
    pass: process.env.SMTP_PASS || 'JZmmd32V9UusCa3z'
  }
});

async function sendMail(to, subject, html) {
  return new Promise((resolve) => {
    mailer.sendMail({
      from: '"SecureChat" <' + (process.env.SMTP_USER || 'andy130305@163.com') + '>',
      to, subject, html
    }, (err, info) => resolve({ ok: !err, err: err && err.message, info }));
  });
}

// 请求验证码：POST /api/email/code { email, purpose: "register"|"bind" }
app.post('/api/email/code', async (req, res) => {
  cleanCode();
  const { email, purpose } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式错误' });
  }
  // 邮箱已被占用？（register/bind 时已占用则拒绝；login 时需已注册）
  const taken = prepare('SELECT id FROM users WHERE email=?').get(email);
  if (purpose === 'login') {
    if (!taken) return res.status(400).json({ error: '该邮箱未注册' });
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
  const { username, password, nickname, email, code, customUid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度需2-20' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const codeErr = checkCode(email, code, 'register');
  if (codeErr) return res.status(400).json({ error: codeErr });
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
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// 邮箱验证码登录：POST /api/login/code { email, code }
app.post('/api/login/code', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const { email, code } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式错误' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  const codeErr = checkCode(email, code, 'login');
  if (codeErr) return res.status(400).json({ error: codeErr });
  const user = prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/users', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const users = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id<>? ORDER BY nickname').all(payload.id);
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
  const existing = prepare('SELECT id,status FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)')
    .get(payload.id, friendId, friendId, payload.id);
  if (existing && existing.status === 1) return res.status(409).json({ error: '已经是好友' });
  if (existing && existing.status === 0) return res.status(409).json({ error: '已发送请求，待对方接受' });
  prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,0,?)')
    .run(payload.id, friendId, Date.now());
  res.json({ ok: true, friend: publicUser(target) });
  const peer = online.get(friendId);
  if (peer) {
    const me = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
    send(peer, P.S_FRIEND_REQ, { from: payload.id, fromUser: publicUser(me) });
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

// 我的好友列表：GET /api/friends
app.get('/api/friends', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id=? AND f.status=1 ORDER BY u.nickname`
  ).all(payload.id);
  res.json({ friends: rows });
});

// 待处理好友请求列表：GET /api/friend/requests
app.get('/api/friend/requests', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey
     FROM friends f JOIN users u ON u.id = f.user_id
     WHERE f.friend_id=? AND f.status=0 ORDER BY f.created_at DESC`
  ).all(payload.id);
  res.json({ requests: rows });
});

function pushFriendList(uid) {
  const ws = online.get(uid);
  if (!ws) return;
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id=? AND f.status=1 ORDER BY u.nickname`
  ).all(uid);
  const list = rows.map(r => ({ ...publicUser(r), online: online.has(r.id) }));
  send(ws, P.S_FRIEND_LIST, { friends: list });
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
    fields.push('nickname=?'); args.push(nick);
  }
  if (typeof body.country === 'string') { fields.push('country=?'); args.push(body.country); }
  if (typeof body.province === 'string') { fields.push('province=?'); args.push(body.province); }
  if (typeof body.city === 'string') { fields.push('city=?'); args.push(body.city); }
  // extra：任意键值对象，整体写入（覆盖）
  if (body.extra !== undefined) {
    if (body.extra === null || typeof body.extra !== 'object' || Array.isArray(body.extra)) {
      return res.status(400).json({ error: 'extra 必须是对象' });
    }
    const cleaned = {};
    for (const k of Object.keys(body.extra)) {
      if (Object.prototype.hasOwnProperty.call(body.extra, k)) {
        const v = body.extra[k];
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') continue; // 不存嵌套对象/数组，保持扁平
        cleaned[k] = String(v);
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

app.get('/api/history/:peerId', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = parseInt(req.params.peerId, 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const rows = prepare('SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY created_at ASC LIMIT ?')
    .all(payload.id, peerId, peerId, payload.id, limit);
  const msgs = rows.map(r => ({ id: r.id, from: r.from_id, to: r.to_id, content: r.content, createdAt: r.created_at, read: r.read }));
  res.json({ messages: msgs });
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
app.post('/api/group/join', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const groupId = parseInt((req.body || {}).groupId, 10);
  if (!groupId) return res.status(400).json({ error: '群ID不能为空' });
  const g = prepare('SELECT id FROM groups WHERE id=?').get(groupId);
  if (!g) return res.status(404).json({ error: '群不存在' });
  prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)')
    .run(groupId, payload.id, Date.now());
  res.json({ ok: true });
  broadcastGroups();
});

// 邀请入群：POST /api/group/invite { groupId, uid }
// 注意：body 里的 uid 是用户的 UID 字符串（如 xY7mK3n4），不是数据库 id
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
  const target = prepare('SELECT id FROM users WHERE uid=?').get(uid);
  if (!target) return res.status(404).json({ error: '该UID不存在' });
  const exists = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, target.id);
  if (exists) return res.status(409).json({ error: '该用户已是群成员' });
  prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)')
    .run(groupId, target.id, Date.now());
  res.json({ ok: true, userId: target.id });
  broadcastGroups();
});

// 群消息历史：GET /api/group/:id/messages?limit=100
app.get('/api/group/:id/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const groupId = parseInt(req.params.id, 10);
  if (!groupId) return res.status(400).json({ error: '群ID错误' });
  const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!isMember) return res.status(403).json({ error: '你不在此群' });
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = prepare(
    `SELECT gm.id, gm.group_id AS groupId, gm.from_id AS fromId, gm.content, gm.created_at AS createdAt,
            u.id AS userId, u.username, u.nickname, u.avatar, u.uid AS userUid
     FROM group_messages gm LEFT JOIN users u ON u.id = gm.from_id
     WHERE gm.group_id=? ORDER BY gm.created_at ASC LIMIT ?`
  ).all(groupId, limit);
  const msgs = rows.map(r => ({
    id: r.id, groupId: r.groupId, from: r.fromId, content: r.content, createdAt: r.createdAt,
    fromUser: { id: r.userId, username: r.username, nickname: r.nickname, avatar: r.avatar, uid: r.userUid }
  }));
  res.json({ messages: msgs });
});

// 我所在的所有群（初始加载用）：GET /api/groups
app.get('/api/groups', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  res.json({ groups: buildGroupsForUser(payload.id) });
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
    ).all(g.id).map(m => ({ ...publicUser(m), online: online.has(m.id) }));
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
  for (const ws of online.values()) {
    if (ws.uid == null) continue;
    send(ws, P.S_GROUP_LIST, { groups: buildGroupsForUser(ws.uid) });
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
    res.status(400).json({ error: '更新包校验或解压失败: ' + err.message });
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
    res.status(500).json({ error: '应用更新失败: ' + err.message, backup });
  }
});

function getVersionConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    if (!cfg || typeof cfg !== 'object') throw new Error('invalid version.json');
    return {
      current: String(cfg.current || DEFAULT_VERSION_CONFIG.current),
      latest: String(cfg.latest || cfg.current || DEFAULT_VERSION_CONFIG.latest),
      releaseNotes: cfg.releaseNotes || DEFAULT_VERSION_CONFIG.releaseNotes,
      updatedAt: Number(cfg.updatedAt) || DEFAULT_VERSION_CONFIG.updatedAt
    };
  } catch {
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
  for (const key of Object.keys(PLATFORM_FILES)) {
    const info = PLATFORM_FILES[key];
    const filename = 'SecureChat-' + cfg.latest + '-' + info.seg + '.' + info.ext;
    downloads[key] = fs.existsSync(path.join(DOWNLOADS_DIR, filename)) ? '/downloads/' + filename : null;
  }
  return downloads;
}

// GET /api/version（无需鉴权）返回版本配置与各平台下载链接
app.get('/api/version', (req, res) => {
  const cfg = getVersionConfig();
  res.json({
    current: cfg.current,
    latest: cfg.latest,
    releaseNotes: cfg.releaseNotes,
    updatedAt: cfg.updatedAt,
    downloads: buildDownloads(cfg)
  });
});

// 管理员更新版本信息：latest 必须是 x.y.z 格式；current 保持不变，updatedAt 更新为当前时间
app.post('/api/admin/version', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  if (guard.sent) return;
  const latest = String((req.body || {}).latest || '').trim();
  const releaseNotes = String((req.body || {}).releaseNotes || '').trim();
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
    res.status(502).json({ error: 'AI 服务连接失败：' + (e && e.message ? e.message : '网络错误') });
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
// /downloads/* 托管安装包目录（server/downloads），不存在则 404；前端 download.html 会处理“暂未提供”情况。
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
const webDir = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
// admin/download 页禁止缓存，避免更新后浏览器/SW 卡旧版
app.get(['/admin.html', '/download.html'], (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(webDir, { setHeaders: (res, filePath) => {
  if (/\.html$/i.test(filePath)) res.set('Content-Type', 'text/html; charset=utf-8');
  if (/\.js$/i.test(filePath)) res.set('Content-Type', 'text/javascript; charset=utf-8');
  if (/\.css$/i.test(filePath)) res.set('Content-Type', 'text/css; charset=utf-8');
}}));
app.get('/', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.sendFile(path.join(webDir, 'index.html')); });

const CERT_PATH = process.env.CERT_PATH || path.join(process.cwd(), 'portable', 'le.crt');
const KEY_PATH = process.env.KEY_PATH || path.join(process.cwd(), 'portable', 'le.key');
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

// ---------- WebSocket ----------
// 跨源放行（前端 cloudflared 域名 与 API 域名不同源时需要）
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: (info, cb) => { cb(true); }
});
const online = new Map();

wss.on('connection', (ws) => {
  ws.uid = null;

  ws.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }
    const { type, payload } = data;

    if (type === P.C_AUTH) {
      const user = verifyToken(payload.token);
      if (!user) return send(ws, P.S_AUTH_FAIL, { error: '令牌无效' });
       const dbUser = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(user.id);
      if (!dbUser) return send(ws, P.S_AUTH_FAIL, { error: '用户不存在' });
      ws.uid = dbUser.id;
      ws.user = publicUser(dbUser);
      online.set(dbUser.id, ws);
      if (online.size > peakConcurrentUsers) peakConcurrentUsers = online.size;
      send(ws, P.S_AUTH_OK, { user: ws.user });
      broadcastUserList();
      pushFriendList(dbUser.id);
      broadcastGroups();
      // 推送待处理好友请求数（供 UI 提示）
      const reqs = prepare(
         `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey
         FROM friends f JOIN users u ON u.id = f.user_id
         WHERE f.friend_id=? AND f.status=0 ORDER BY f.created_at DESC`
      ).all(dbUser.id);
      for (const r of reqs) send(ws, P.S_FRIEND_REQ, { from: r.id, fromUser: publicUser(r) });
      return;
    }

    if (type === P.C_MSG) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { to, content, clientMsgId } = payload || {};
      if (to === undefined || !content) return;
      if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) {
        return send(ws, P.S_ERROR, { error: '消息标识无效' });
      }
      // Retries reuse clientMsgId. Return the original message instead of
      // inserting a duplicate row or delivering it twice.
      if (clientMsgId) {
        const existing = prepare('SELECT id,from_id AS from,to_id AS to,content,created_at AS createdAt FROM messages WHERE client_msg_id=?').get(clientMsgId);
        if (existing) {
          // content 已是客户端密文，不再 decrypt
          send(ws, P.S_MSG, { ...existing, clientMsgId });
          return;
        }
      }
      // Cleartext path: from_id -> peer without E2EE. content 已被客户端加密为密文；服务端只存储/转发，不再加解密。
      const createdAt = Date.now();
      const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
        .run(ws.uid, to, content, clientMsgId || null, createdAt);
      const msgObj = { id: info.lastInsertRowid, from: ws.uid, to, content, createdAt, clientMsgId: clientMsgId || null };
      send(ws, P.S_MSG, msgObj);
      const peer = online.get(to);
      if (peer) send(peer, P.S_MSG, msgObj);
      // 实时计数：发1 收1（对方在线则记一次接收）
      sentMsgsThisMinCounter += 1;
      if (peer) recvMsgsThisMinCounter += 1;
      return;
    }

    if (type === P.C_READ) {
      if (!ws.uid) return;
      const { from } = payload || {};
      prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=?').run(from, ws.uid);
      return;
    }

    // 群消息：C_GROUP_MSG { groupId, content }
    if (type === P.C_GROUP_MSG) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { groupId, content } = payload || {};
      if (!groupId || !content) return;
      const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, ws.uid);
      if (!isMember) return send(ws, P.S_ERROR, { error: '你不在此群' });
      const enc = content;
      const now = Date.now();
      const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)')
        .run(groupId, ws.uid, enc, now);
      const msgObj = { id: info.lastInsertRowid, groupId, from: ws.uid, fromUid: ws.user.uid, content, createdAt: now };
      // 给群里所有在线成员（包括自己）都推送，附带 fromUser 便于客户端显示昵称
      const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
      const fromUser = ws.user;
      for (const m of members) {
        const peer = online.get(m.user_id);
        if (peer) send(peer, P.S_GROUP_MSG, { ...msgObj, fromUser });
      }
      // 实时计数：群消息按 发1 + 在线成员接收 计
      sentMsgsThisMinCounter += 1;
      recvMsgsThisMinCounter += members.filter(m => m.user_id === ws.uid || online.has(m.user_id)).length;
      return;
    }

    // 群已读：C_GROUP_READ { groupId } —— 暂时 noop，直接响应 ok
    if (type === P.C_GROUP_READ) {
      if (!ws.uid) return;
      // 未持久化已读状态；每次推送时客户端可清本地 unread
      return;
    }

    if (type === P.C_TYPING) {
      if (!ws.uid) return;
      const { to } = payload || {};
      const peer = online.get(to);
      if (peer) send(peer, P.S_TYPING, { from: ws.uid });
      return;
    }

    // 信令转发：用于 WebRTC（音视频/文件 DataChannel）的 offer/answer/ICE/挂断等
    if (type === P.C_SIGNAL) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { to, sub, data } = payload || {};
      if (to === undefined || !sub) return;
      const peer = online.get(to);
      if (!peer) {
        send(ws, P.S_SIGNAL, { from: to, sub: 'peer_offline', data: null });
        return;
      }
      send(peer, P.S_SIGNAL, { from: ws.uid, sub, data });
      return;
    }
  });

  ws.on('close', () => {
    if (ws.uid) {
      online.delete(ws.uid);
      broadcastUserList();
      broadcastGroups();
    }
  });
});

function broadcastUserList() {
  const users = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users').all();
  const list = users.map(u => ({ ...publicUser(u), online: online.has(u.id) }));
  for (const ws of online.values()) send(ws, P.S_USER_LIST, { users: list });
  // 用户在线状态变化也会影响群成员在线展示，同步推送群列表
  broadcastGroups();
}

// 启动：先初始化数据库
(async () => {
  await getDb();
  ready = true;
  server.listen(PORT, '0.0.0.0', () => {
    const proto = process.env.USE_HTTPS === '1' ? 'https' : 'http';
    console.log(`[SecureChat] server running on ${proto}://0.0.0.0:${PORT} (ws: /ws)`);
  });
})();

// 退出时保存一次
process.on('SIGINT', () => { persist(); process.exit(0); });
process.on('exit', () => { try { persist(); } catch {} });
