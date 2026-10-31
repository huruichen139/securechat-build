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
const { getDb, prepare, persist, persistNow, genUid, nextSeq, getSyncState, updateSyncState } = require('./db');
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

// 生产密钥必须显式配置：回退到公开常量意味着任何人都能签发 {id:<管理员id>} 的 token。
// 缺失时直接退出（由守护脚本拉起并记录日志），避免静默以弱密钥对外服务。
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('[fatal] JWT_SECRET 未配置或过短（至少 16 字符），拒绝启动。请在 server/.env 中设置 JWT_SECRET。');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
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

// ---------- Cap Core：自托管人机验证（替代 Turnstile） ----------
const CAP_SECRET = process.env.CAP_SECRET || null;
let _capCore = null;
async function getCapCore() {
  if (_capCore) return _capCore;
  if (!CAP_SECRET) return null;
  try {
    _capCore = await import('capjs-core');
    console.log('[cap] capjs-core loaded');
    return _capCore;
  } catch (e) { console.error('[cap] capjs-core load failed:', e.message); return null; }
}

// Token 存储：redeem 后存 tokenKey，verify 时消费（单次使用）
const capTokenStore = new Map();
function capTokenCleanup() {
  const now = Date.now();
  for (const [k, v] of capTokenStore) {
    if (v.expiresAt <= now) capTokenStore.delete(k);
  }
}
setInterval(capTokenCleanup, 60 * 1000);

// Nonce 防重放：consumeNonce 回调
const capNonceStore = new Set();
function capNonceCleanup() {
  // nonce TTL 由 capjs-core 控制，这里只做辅助清理（防内存泄漏）
  // 实际 nonce 条目有过期时间，但 Set 无法高效过期
  // 简单策略：超 5000 条时清空（极端情况）
  if (capNonceStore.size > 5000) capNonceStore.clear();
}
setInterval(capNonceCleanup, 5 * 60 * 1000);

// ---------- 管理员后台白名单 ----------
// 仅 3529403074@qq.com 拥有管理员后台权限
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '3529403074@qq.com').split(',').map(s => s.trim().toLowerCase());
function isAdmin(user) { return !!(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())); }
// authed：通用认证，校验 Authorization Bearer token，返回 payload 或 null
function authed(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const u = prepare('SELECT id,banned FROM users WHERE id=?').get(payload.id);
  if (!u || u.banned) return null;
  return payload;
}
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

// ========== 请求追踪 ID ==========
// 每个请求分配唯一 requestId，随 X-Request-ID 响应返回；日志可据此串起一条链路
let _reqSeq = 0;
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || ('r-' + process.pid + '-' + (++_reqSeq));
  res.set('X-Request-ID', req.requestId);
  next();
});

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
  // 必须精确匹配来源主机（可带端口）。原先用 startsWith 会被
  // https://mc.32768.top.evil.com、http://localhost.evil.com 这类前缀绕过。
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (e) { host = null; }
    const ok = host && (host === 'mc.32768.top'
      || host === '127.0.0.1' || host === '127.0.0.1:8888'
      || /^localhost(:\d+)?$/.test(host));
    if (ok) res.header('Access-Control-Allow-Origin', origin);
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

// ---------- Cap Core：自托管人机验证路由 + token 验证 ----------
// POST /api/cap/challenge：生成 PoW + instrumentation 挑战
app.post('/api/cap/challenge', async (req, res) => {
  if (rateLimit('cap:' + getIp(req), 60, 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const cap = await getCapCore();
  if (!cap) return res.status(503).json({ error: 'CAPTCHA 未配置' });
  try {
    const ch = await cap.generateChallenge(CAP_SECRET, {
      instrumentation: { blockAutomatedBrowsers: true, obfuscationLevel: 3 },
    });
    res.json(ch);
  } catch (e) {
    console.error('[cap] challenge error:', e.message);
    res.status(500).json({ error: '验证挑战生成失败' });
  }
});

// POST /api/cap/redeem：验证 PoW + instrumentation 解答，返回 token
app.post('/api/cap/redeem', async (req, res) => {
  const cap = await getCapCore();
  if (!cap) return res.status(503).json({ error: 'CAPTCHA 未配置' });
  try {
    const { token, solutions, instr } = req.body || {};
    if (!token || !solutions) return res.status(400).json({ error: '缺少验证参数' });
    const result = await cap.validateChallenge(CAP_SECRET, { token, solutions, instr }, {
      consumeNonce: async (sigHex, ttlMs) => {
        if (capNonceStore.has(sigHex)) return false;
        capNonceStore.add(sigHex);
        setTimeout(() => capNonceStore.delete(sigHex), ttlMs);
        return true;
      },
    });
    if (!result.success) {
      console.warn('[cap] redeem failed:', result.reason);
      return res.status(403).json({ error: '验证失败', reason: result.reason });
    }
    const { createHash } = await import('crypto');
    const [id, verToken] = result.token.split(':');
    const tokenKey = id + ':' + createHash('sha256').update(verToken).digest('hex');
    capTokenStore.set('cap-token:' + tokenKey, { expiresAt: result.expires });
    res.json({ success: true, token: result.token, expires: result.expires });
  } catch (e) {
    console.error('[cap] redeem error:', e.message);
    res.status(500).json({ error: '验证失败' });
  }
});

// 验证 Cap token（表单提交时调用）
async function verifyCapToken(token) {
  if (!token) return false;
  try {
    const { createHash } = await import('crypto');
    const [id, verToken] = String(token).split(':');
    const tokenKey = id + ':' + createHash('sha256').update(verToken).digest('hex');
    const storeKey = 'cap-token:' + tokenKey;
    const entry = capTokenStore.get(storeKey);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) { capTokenStore.delete(storeKey); return false; }
    capTokenStore.delete(storeKey);
    return true;
  } catch (e) { return false; }
}

// ---------- 第三方聚合登录（mapay.cn / OAuth2.0） ----------
// 流程：/api/oauth/connect 取跳转地址 → 浏览器跳第三方 → 平台回调
//       /api/oauth/callback?type=&code= → 用 code 换用户资料 → 找到/创建本地账号 → 签发本站 JWT
// 安全：APPKEY 只存在于服务端 .env，任何接口都不回传给前端；state 用 HMAC 签名防 CSRF。
const OAUTH_GATEWAY = process.env.MAPAY_GATEWAY || 'https://login.mapay.cn/connect.php';
const OAUTH_APPID = process.env.MAPAY_APPID || '';
const OAUTH_APPKEY = process.env.MAPAY_APPKEY || '';
const OAUTH_CALLBACK = process.env.MAPAY_CALLBACK_URL
  || ((process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '') + '/api/oauth/callback');
const OAUTH_TYPES = ['qq', 'wx', 'alipay', 'github'];
// 第三方登录 state/票据签名密钥必须独立于支付网关 APPKEY：
// 原实现直接用 MAPAY_APPKEY，未配置时退化为 sha256(body)（无密钥），任何人都能伪造 state
// 与绑定票据，从而把攻击者自己的第三方账号绑到受害者账户或直接接管登录。
const OAUTH_STATE_KEY = process.env.OAUTH_STATE_SECRET
  || crypto.createHash('sha256').update('oauth-state-v1:' + JWT_SECRET).digest('hex');
function oauthSig(data) {
  return crypto.createHmac('sha256', OAUTH_STATE_KEY).update(String(data)).digest('hex').slice(0, 32);
}
// 定长、恒时字符串比较，用于比较签名类凭证
function constantEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// 第三方登录绑定/登录的公共收尾逻辑：
// 找到绑定则直接登录；否则返回一次性票据，交由前端配合账密绑定（不自动建号）
function oauthCompleteBind(req, res, provider, socialUid, nickname, avatar, toFront, wantsHtml, ip) {
  const link = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get(provider, socialUid);
  if (link) {
    const owner = prepare('SELECT * FROM users WHERE id=?').get(link.user_id);
    if (owner && owner.banned) return oauthFail(req, res, '该账户已被封禁，无法登录', 403);
    if (owner) {
      prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
        .run(Date.now(), nickname || link.nickname, avatar || link.avatar, link.id);
      prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), owner.id);
      logAudit(owner.id, 'oauth_login', owner.id, 'user', '第三方登录(' + provider + ') 已绑定账户直接登录', ip);
      const tk = signToken(owner);
      if (wantsHtml) return toFront({ key: 'oauth', data: { token: tk, type: provider, bound: 1 } });
      return res.json({ ok: true, bound: true, token: tk, user: publicUser(owner) });
    }
    prepare('DELETE FROM oauth_accounts WHERE id=?').run(link.id);
  }
  // 未绑定：签发一次性票据
  const body = Buffer.from(JSON.stringify({
    p: provider, s: socialUid, n: nickname || '', a: avatar || '',
    nn: crypto.createHash('sha256').update(socialUid + provider + Date.now() + Math.random()).digest('hex').slice(0, 20),
    exp: Date.now() + 10 * 60 * 1000
  })).toString('base64url');
  const sig = oauthSig(body);
  const ticket = body + '.' + sig;
  if (wantsHtml) return toFront({ key: 'oauthbind', data: { ticket, type: provider, nickname } });
  res.json({ ok: true, needBind: true, ticket, type: provider, nickname });
}

function oauthEnabled() { return !!(OAUTH_APPID && OAUTH_APPKEY); }

// 回调出错时的响应：浏览器访问给友好页面（并带回前端显示），API 调用才返回 JSON
function oauthFail(req, res, msg, code) {
  const status = code || 400;
  if (String(req.headers.accept || '').includes('text/html')) {
    const base = (process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '');
    const page = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>登录失败</title><style>` +
      `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
      `font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f5f5;color:#191919}` +
      `.box{background:#fff;padding:32px 28px;border-radius:12px;max-width:460px;margin:20px;` +
      `box-shadow:0 8px 30px rgba(15,23,42,.08);text-align:left}` +
      `h1{font-size:19px;margin:0 0 14px;text-align:center}` +
      `p{font-size:14px;color:#555;line-height:1.85;margin:0 0 22px;white-space:pre-line}` +
      `a{display:inline-block;background:#07c160;color:#fff;text-decoration:none;padding:10px 28px;` +
      `border-radius:6px;font-size:14px}</style></head><body><div class="box">` +
      `<h1>登录失败</h1><p>${String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` +
      `<a href="${base}/chat">返回登录页</a></div></body></html>`;
    res.status(status);
    return res.type('html').send(page);
  }
  return res.status(status).json({ error: msg });
}

// state = base64url(payload).HMAC，10 分钟有效，payload 内含 type 与防重放 nonce
function oauthSignState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = oauthSig(body);
  return body + '.' + sig;
}
function oauthVerifyState(state) {
  try {
    const s = String(state || '');
    const dot = s.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = s.slice(0, dot), sig = s.slice(dot + 1);
    const expect = oauthSig(body);
    // 定长比较，避免时序侧信道
    if (sig.length !== expect.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
    if (diff !== 0) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.nonce || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    if (_oauthSeen.has(payload.nonce)) return null;
    _oauthSeen.set(payload.nonce, Date.now());
    if (_oauthSeen.size > 5000) for (const [k, v] of _oauthSeen) if (Date.now() - v > 600000) _oauthSeen.delete(k);
    return payload;
  } catch (e) { return null; }
}
const _oauthSeen = new Map(); // state nonce 防重放

// 调平台接口（服务端 -> 平台）
function oauthCall(params) {
  return new Promise((resolve) => {
    try {
      const u = new URL(OAUTH_GATEWAY);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
      const mod = u.protocol === 'https:' ? require('https') : require('http');
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET', timeout: 12000
      }, (r) => {
        let b = '';
        r.on('data', (c) => { if (b.length < 200000) b += c; });
        r.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { resolve({ code: -1, msg: '平台返回非JSON' }); }
        });
      });
      req.on('error', (e) => resolve({ code: -1, msg: '无法连接聚合登录平台: ' + (e.code || e.message) }));
      req.on('timeout', () => { req.destroy(); resolve({ code: -1, msg: '聚合登录平台超时' }); });
      req.end();
    } catch (e) { resolve({ code: -1, msg: '请求构造失败' }); }
  });
}

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

// 他人视角的用户信息：不暴露邮箱（原实现让任意人加好友即可拿到对方邮箱，
// 好友列表/群成员/好友请求也会把邮箱扩散给所有人，便于撞库与钓鱼）。
function publicUserBrief(u) {
  const p = publicUser(u);
  delete p.email;
  return p;
}

function signToken(user, deviceId) {
  const claims = { id: user.id, username: user.username, tv: user.token_version || 0 };
  if (deviceId) claims.deviceId = String(deviceId).slice(0, 128);
  // 每次签发唯一 jti：JWT 的 iat/exp 只到秒，同一用户在同一秒内两次登录会得到
  // 完全相同的 token 字符串，退出登录吊销后再登录会立刻拿到已被吊销的 token。
  claims.jti = crypto.randomBytes(9).toString('hex');
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '7d' });
}

// 已吊销 token 的内存缓存：退出登录后原 token 立即失效。
// DB 只用于重启后恢复；命中缓存即可拒绝，避免每个请求都查库。
const revokedTokenCache = new Map();
let revokedLoaded = false;
function tokenHashOf(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function loadRevokedTokens() {
  if (revokedLoaded) return;
  try {
    const rows = prepare('SELECT token_hash, expires_at FROM revoked_tokens WHERE expires_at > ?').all(Date.now());
    for (const r of rows) revokedTokenCache.set(r.token_hash, r.expires_at);
    revokedLoaded = true;
  } catch (e) { /* 表尚未建好时下次再试 */ }
}
function isTokenRevoked(token) {
  loadRevokedTokens();
  const h = tokenHashOf(token);
  const exp = revokedTokenCache.get(h);
  if (exp == null) return false;
  if (exp < Date.now()) { revokedTokenCache.delete(h); return false; }
  return true;
}

function verifyToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p || !p.id) return null;
    if (isTokenRevoked(token)) return null;
    // 检查 token_version 是否匹配（密码重置/封禁后废除旧 token）
    const u = prepare('SELECT token_version, banned FROM users WHERE id=?').get(p.id);
    if (!u) return null;
    if ((p.tv || 0) !== (u.token_version || 0)) return null;
    // 封禁账号拒绝所有已签发 token（防止封禁后仍能通过 REST 操作）
    if (u.banned) return null;
    // 设备维度吊销：若 token 绑定了具体设备，则校验该设备仍存在（被踢出/移除后失效）
    if (p.deviceId) {
      const dev = prepare('SELECT id FROM devices WHERE user_id=? AND device_id=?').get(p.id, String(p.deviceId));
      if (!dev) return null;
    }
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
// 清除某限流桶（登录成功时清掉账号级失败计数）
function clearRateLimit(key) {
  try { _rateBuckets.delete(key); } catch (e) {}
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

// ============ 人机验证码系统（图形数字验证码 + Cloudflare Turnstile） ============
// Cloudflare Turnstile 配置（可被 .env 覆盖）
const CF_TURNSTILE_SITE = process.env.CF_TURNSTILE_SITE || '0x4AAAAAAEknUV0niF2E259J';
const CF_TURNSTILE_SECRET = process.env.CF_TURNSTILE_SECRET || '0x4AAAAAAEknUYAOZj5B8ZAinA71X3zSfc8';

// 图形数字验证码存储：id -> { text, expireAt }
const captchaStore = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
const CAPTCHA_MAX = 20000;

function cleanCaptcha() {
  const now = Date.now();
  if (captchaStore.size > CAPTCHA_MAX) {
    for (const [k, v] of captchaStore) if (v.expireAt < now) captchaStore.delete(k);
  }
  for (const [k, v] of captchaStore) if (v.expireAt < now) captchaStore.delete(k);
}

// 生成 5 位数字验证码文本（不含易混淆的 0/O/1/I）
function genCaptchaText() {
  const chars = '23456789';
  let t = '';
  for (let i = 0; i < 5; i++) t += chars[crypto.randomInt(0, chars.length)];
  return t;
}

// 生成干扰线条 SVG 图形数字验证码（纯 JS，无原生依赖，线条/噪点丰富）
function genCaptchaSvg(text) {
  const w = 140, h = 46;
  // 每个字符颜色随机
  const colors = ['#e45959', '#3b82f6', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
  const c = (a) => colors[crypto.randomInt(0, colors.length)];
  const m = (max) => crypto.randomInt(0, max);
  // 给每个字符一个随机 x/rotate/size
  let chars = [];
  const cw = (w - 20) / text.length;
  for (let i = 0; i < text.length; i++) {
    chars.push({
      ch: text[i],
      x: 12 + i * cw + m(6),
      y: 18 + m(14),
      fs: 24 + m(10),
      rot: -18 + m(36),
      color: c(),
    });
  }
  // 干扰线
  let lines = '';
  for (let i = 0; i < 8; i++) {
    const x1 = m(w), y1 = m(h), x2 = m(w), y2 = m(h);
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c()}" stroke-width="${1 + m(2)}" opacity="${0.3 + m(40) / 100}"/>`;
  }
  // 噪点
  let dots = '';
  for (let i = 0; i < 40; i++) {
    dots += `<circle cx="${m(w)}" cy="${m(h)}" r="${1 + m(2)}" fill="${c()}" opacity="${0.3 + m(50) / 100}"/>`;
  }
  // 干扰圆弧
  let arcs = '';
  for (let i = 0; i < 3; i++) {
    arcs += `<path d="M${m(w)} ${m(h)} q ${m(40) - 20} ${m(30) - 15} ${m(40)} ${m(20)}" fill="none" stroke="${c()}" stroke-width="${1 + m(2)}" opacity="${0.3 + m(30) / 100}"/>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#f7f9fc"/>` +
    lines + dots + arcs +
    chars.map((k) => `<text x="${k.x}" y="${k.y}" font-size="${k.fs}" font-weight="700" font-family="Arial,Helvetica,sans-serif" fill="${k.color}" transform="rotate(${k.rot} ${k.x} ${k.y})">${k.ch}</text>`).join('') +
    `</svg>`;
  return svg;
}

// 生成图形验证码，返回 { id, svg }
function createCaptcha() {
  cleanCaptcha();
  const text = genCaptchaText();
  // 带过期 + 一次性（校验后即删）
  let id;
  do { id = crypto.randomUUID(); } while (captchaStore.has(id));
  captchaStore.set(id, { text, expireAt: Date.now() + CAPTCHA_TTL });
  return { id, svg: genCaptchaSvg(text) };
}

// 校验图形验证码：成功则删除（一次性）并返回 true
function checkCaptcha(id, answer) {
  if (!id || !answer) return false;
  const v = captchaStore.get(id);
  if (!v) return false;
  captchaStore.delete(id);
  if (v.expireAt < Date.now()) return false;
  // 忽略大小写与首尾空格；数字验证码宽松比较
  return String(answer).trim() === v.text;
}

// 校验 Cloudflare Turnstile token：调官方 siteverify
async function checkTurnstile(token, ip) {
  if (!token) return false;
  return new Promise((resolve) => {
    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const data = `secret=${encodeURIComponent(CF_TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}` + (ip ? `&remoteip=${encodeURIComponent(ip)}` : '');
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (d) => b += d);
      res.on('end', () => {
        try { const j = JSON.parse(b); resolve(!!j.success); } catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// 统一人机校验：允许「图形验证码」或「Cloudflare Turnstile」二选一
// req.body: { captchaId, captchaText } 或 { turnstileToken }
// strict=true：必须通过（失败写 403）；strict=false：带了才验，不带则放行（兼容老客户端）
// 通过返回 true；strict 且失败时已向 res 写 403 并返回 false
async function verifyHuman(req, res, strict) {
  const b = req.body || {};
  // 优先检查 Cap token
  const capToken = b['cap-token'] || b.capToken;
  if (capToken) {
    const capOk = await verifyCapToken(capToken);
    if (capOk) return true;
    if (strict) res.status(403).json({ error: '人机验证失败（Cap）' });
    return false;
  }
  const token = b.turnstileToken || b.cfTurnstile || b.cfToken || b.cloudflareToken;
  if (token) {
    const ok = await checkTurnstile(token, getIp(req));
    if (ok) return true;
    if (strict) res.status(403).json({ error: '人机验证失败（Cloudflare）' });
    return ok;
  }
  const id = b.captchaId, answer = b.captchaText;
  if (id || answer) {
    if (checkCaptcha(id, answer)) return true;
    if (strict) res.status(403).json({ error: '图形验证码错误或已过期，请刷新重试' });
    return false;
  }
  // 未带任何验证数据：strict 时拒绝，兼容模式放行
  if (strict) { res.status(403).json({ error: '请完成人机验证' }); return false; }
  return true;
}
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

// 获取图形数字验证码：GET /api/captcha —— 返回 SVG + captchaId（一次性）
app.get('/api/captcha', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  // SVG 生成有 CPU 成本，不设限可被打码机批量拉取或用于耗 CPU
  if (rateLimit('captcha:' + getIp(req), 30, 10 * 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const { id, svg } = createCaptcha();
  res.json({ ok: true, id, svg, style: 'numeric' });
});

// 人机验证配置：GET /api/captcha/config —— 返回 Cloudflare Turnstile sitekey 等
app.get('/api/captcha/config', (req, res) => {
  res.json({ ok: true, turnstile: { site: CF_TURNSTILE_SITE }, methods: ['img', 'turnstile'] });
});

// 请求验证码：POST /api/email/code { email, purpose: "register"|"bind" }
app.post('/api/email/code', async (req, res) => {
 try {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  cleanCode();
  const ip = getIp(req);
  if (rateLimit('email:' + ip, 5, 10 * 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请10分钟后再试' });
  // 人机验证（图形验证码 或 Cloudflare Turnstile 二选一，均可切换）
  if (!(await verifyHuman(req, res, true))) return;
  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
  const purpose = typeof body.purpose === 'string' ? body.purpose : '';
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式错误' });
  }
  // 邮箱已被占用？（register/bind 时已占用则拒绝；login 时需已注册）
  const taken = prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (purpose === 'login' || purpose === 'reset') {
    if (!taken) return res.status(400).json({ error: '该邮箱未注册，请先注册再使用验证码登录' });
  } else if (taken) {
    return res.status(409).json({ error: '该邮箱已被绑定' });
  }

  // 发码限流：除按 IP 外，再按邮箱限 3 次/10 分钟，防止对同一邮箱轰炸替换旧码
  if (rateLimit('emailcode:' + email.toLowerCase(), 3, 10 * 60 * 1000)) return res.status(429).json({ error: '该邮箱请求过于频繁，请10分钟后再试' });

  const code = genCode();
  emailCodes.set(email, { code, expireAt: Date.now() + 10 * 60 * 1000, purpose: purpose || 'register', used: false });

  const subject = 'SecureChat 验证码';
  const html = `<div style="font-family:'Microsoft YaHei',Arial;background:#f7f8fa;padding:24px;color:#222">
    <h2 style="color:#2563eb;margin:0 0 12px">SecureChat</h2>
    <p>你的验证码是：</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:4px;color:#2563eb;margin:10px 0">${code}</div>
    <p style="color:#888;font-size:12px">10 分钟内有效。如果不是你本人请求的，请忽略此邮件。</p>
  </div>`;
  const r = await sendMail(email, subject, html);
  if (!r.ok) return res.status(500).json({ error: '邮件发送失败：' + (r.err || '未知错误') });
  res.json({ ok: true });
 } catch (e) {
  console.error('[email/code] 处理失败:', e && e.message || e);
  if (!res.headersSent) { try { res.status(500).json({ error: '验证码发送失败，请稍后再试' }); } catch (_) {} }
 }
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
  verifyHuman(req, res, true).then((ok) => {
    if (!ok) return;
    (function doRegister() {
      try {
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const nickname = typeof body.nickname === 'string' ? body.nickname.trim().slice(0, 40) : '';
      const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
      const code = typeof body.code === 'string' ? body.code.trim().slice(0, 16) : '';
      const customUid = typeof body.customUid === 'string' ? body.customUid.trim().slice(0, 32) : '';
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度需2-20' });
  // 用户名禁止 @ 等分隔符：登录把含 @ 的账号按邮箱解析，用户名带 @ 会造成歧义与撞库混淆
  if (/[@:\s]/.test(username)) return res.status(400).json({ error: '用户名不能包含 @ : 或空白字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'register');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const exists = prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  const emailTaken = prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
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
      } catch (e) {
        console.error('[register] 处理失败:', e && e.message || e);
        if (!res.headersSent) { try { res.status(500).json({ error: '注册失败，请稍后再试' }); } catch (_) {} }
      }
    })();
  });
});

// ---------- 聚合登录接口 ----------
// Step1 取跳转地址：GET /api/oauth/connect?type=qq|wx|alipay
app.get('/api/oauth/connect', async (req, res) => {
 try {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  if (!oauthEnabled()) return res.status(503).json({ error: '聚合登录未配置' });
  const type = String((req.query || {}).type || '').trim();
  if (!OAUTH_TYPES.includes(type)) return res.status(400).json({ error: '不支持的登录方式' });
  const ip = getIp(req);
  if (rateLimit('oauth:' + ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  // bind=1 表示"已登录用户主动绑定"：校验 token，把用户身份签进 state，
  // 这样浏览器跳第三方再回来（不带 Authorization 头）仍能确定绑到谁
  let bindUserId = 0;
  if (String((req.query || {}).bind || '') === '1') {
    const u = verifyToken(String(req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!u) return res.status(401).json({ error: '请先登录后再绑定' });
    bindUserId = u.id;
  }

  const state = oauthSignState({
    t: type,
    u: bindUserId || undefined, // 登录态发起绑定时把用户身份签进来
    nonce: crypto.createHash('sha256').update(String(Date.now()) + Math.random() + ip).digest('hex').slice(0, 24),
    exp: Date.now() + 10 * 60 * 1000
  });
  // 平台回调只会附带 type 与 code，不会回传我们自定义的 state，
  // 因此把 state 拼进 redirect_uri 查询串，平台跳转时便会原样带回。
  const redirectUri = OAUTH_CALLBACK + '?state=' + encodeURIComponent(state);
  const r = await oauthCall({ act: 'login', appid: OAUTH_APPID, appkey: OAUTH_APPKEY, type, redirect_uri: redirectUri });
  if (!r || r.code !== 0 || !r.url) {
    return res.status(502).json({ error: '获取聚合登录地址失败：' + ((r && r.msg) || '未知错误') });
  }
  // 只回传跳转地址与扫码地址，绝不回传 appkey
  res.json({ ok: true, type, url: r.url, qrcode: r.qrcode || '', state });
 } catch (e) {
  console.error('[oauth] connect 异常:', e && e.message || e);
  if (!res.headersSent) res.status(500).json({ error: '服务内部错误' });
 }
});

// Step3/4 回调换用户信息：GET /api/oauth/callback?type=&code=&state=
app.get('/api/oauth/callback', async (req, res) => {
 try {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  if (!oauthEnabled()) return res.status(503).json({ error: '聚合登录未配置' });
  const q = req.query || {};
  const type = String(q.type || '').trim();
  const code = String(q.code || '').trim();
  const st = oauthVerifyState(q.state);
  if (!OAUTH_TYPES.includes(type)) return oauthFail(req, res, '不支持的登录方式');
  if (!code) return oauthFail(req, res, '缺少授权码');
  if (!st) return oauthFail(req, res, '登录状态已失效，请重新发起登录');
  if (st.t !== type) return oauthFail(req, res, '登录类型不匹配');

  const r = await oauthCall({ act: 'callback', appid: OAUTH_APPID, appkey: OAUTH_APPKEY, type, code });
  if (!r || r.code !== 0 || !r.social_uid) {
    return oauthFail(req, res, '第三方登录失败：' + ((r && r.msg) || '未知错误'), 401);
  }
  const socialUid = String(r.social_uid);
  const nickname = String(r.nickname || '').trim().slice(0, 40);
  const avatar = String(r.faceimg || '').trim().slice(0, 500);

  // 绑定票据：一次性、10 分钟有效，内容含第三方标识，供前端配合账密完成绑定
  function makeTicket() {
    const body = Buffer.from(JSON.stringify({
      p: type, s: socialUid, n: nickname, a: avatar,
      nn: crypto.createHash('sha256').update(socialUid + type + Date.now() + Math.random()).digest('hex').slice(0, 20),
      exp: Date.now() + 10 * 60 * 1000
    })).toString('base64url');
    const sig = oauthSig(body);
    return body + '.' + sig;
  }
  const frontBase = (process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '');
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  function toFront(fragObj) {
    return res.redirect(frontBase + '/chat#' + fragObj.key + '=' + encodeURIComponent(JSON.stringify(fragObj.data)));
  }

  // 情况一：已登录发起绑定 → 直接绑定到该账号
  // 两种身份来源：① 请求带 Authorization 头 ② state.u（登录态发起绑定时由服务端签入，
  // 因为浏览器跳第三方再回来不会携带 Authorization 头）
  const authHeader = String(req.headers.authorization || '').replace('Bearer ', '').trim();
  let cur = authHeader ? verifyToken(authHeader) : null;
  if (!cur && st && st.u) {
    const u0 = prepare('SELECT token_version, banned FROM users WHERE id=?').get(st.u);
    if (u0 && !u0.banned) cur = { id: st.u };
  }
  if (cur) {
    const owner = prepare('SELECT * FROM users WHERE id=?').get(cur.id);
    if (!owner) return oauthFail(req, res, '登录状态已失效，请重新登录', 401);
    if (owner.banned) return oauthFail(req, res, '该账号已被封禁' + (owner.ban_reason ? '：' + owner.ban_reason : ''), 403);
    const dup = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get(type, socialUid);
if (dup && dup.user_id !== owner.id) {
      // 该第三方账号已挂在别的账户下。与登录页保持一致的 SSO 语义：
      // 直接登录它所归属的账户（而不是报错让用户自己去猜/去解绑）。
      const boundOwner = prepare('SELECT * FROM users WHERE id=?').get(dup.user_id);
      if (boundOwner && boundOwner.banned) return oauthFail(req, res, '该账户已被封禁，无法登录', 403);
      if (boundOwner) {
        prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
          .run(Date.now(), nickname || dup.nickname, avatar || dup.avatar, dup.id);
        prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), boundOwner.id);
        logAudit(boundOwner.id, 'oauth_login', boundOwner.id, 'user',
          '第三方登录(' + type + ') 已绑定账户直接登录(登录态冲突自动切换)', getIp(req));
        const tkB = signToken(boundOwner);
        if (wantsHtml) {
          // 切到该账户后回设置页，让用户看到自己现在在哪个账户
          const back = (process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '') + '/chat#oauth='
            + encodeURIComponent(JSON.stringify({ token: tkB, type, bound: 1, switched: 1 }));
          return res.redirect(back);
        }
        return res.json({ ok: true, bound: true, switched: true, token: tkB, user: publicUser(boundOwner) });
      }
      // 绑定记录指向已不存在的用户：清理后正常绑定
      prepare('DELETE FROM oauth_accounts WHERE id=?').run(dup.id);
    }
    if (dup) {
      prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
        .run(Date.now(), nickname || dup.nickname, avatar || dup.avatar, dup.id);
    } else {
      prepare('INSERT INTO oauth_accounts(provider,social_uid,user_id,nickname,avatar,created_at,last_login_at) VALUES(?,?,?,?,?,?,?)')
        .run(type, socialUid, owner.id, nickname || '', avatar || '', Date.now(), Date.now());
    }
    logAudit(cur.id, 'oauth_bind', owner.id, 'user', '绑定聚合登录(' + type + ')', getIp(req));
const token = signToken(owner);
      if (wantsHtml) {
        // 登录态发起的绑定：回设置页并刷新绑定列表；未登录的登录流程则直接进聊天
        if (st && st.u) return toFront({ key: 'oauthbound', data: { type, nickname, ok: 1 } });
        return toFront({ key: 'oauth', data: { token, type, bound: 1 } });
      }
      return res.json({ ok: true, bound: true, token, user: publicUser(owner) });
  }

  // 情况二：未登录 → 不自动建号，返回票据，前端引导用户填写账密完成绑定
const dup2 = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get(type, socialUid);
  if (dup2) {
    const owner = prepare('SELECT * FROM users WHERE id=?').get(dup2.user_id);
    if (owner && owner.banned) return oauthFail(req, res, '该账户已被封禁，无法登录', 403);
    if (owner) {
      // 该第三方账号已绑定本站账户 —— 直接登录该账户（标准 SSO 语义），不再报错
      prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
        .run(Date.now(), nickname || dup2.nickname, avatar || dup2.avatar, dup2.id);
      prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), owner.id);
      logAudit(owner.id, 'oauth_login', owner.id, 'user', '聚合登录(' + type + ') 已绑定账户直接登录', getIp(req));
      const tk2 = signToken(owner);
      if (wantsHtml) return toFront({ key: 'oauth', data: { token: tk2, type, bound: 1 } });
      return res.json({ ok: true, bound: true, token: tk2, user: publicUser(owner) });
    }
// 绑定记录存在但用户已不存在：清理孤儿记录后走正常流程
    prepare('DELETE FROM oauth_accounts WHERE id=?').run(dup2.id);
  }
  const ticket = makeTicket();
  if (wantsHtml) return toFront({ key: 'oauthbind', data: { ticket, type, nickname } });
  res.json({ ok: true, needBind: true, ticket, type, nickname });
 } catch (e) {
  console.error('[oauth] callback 异常:', e && e.message || e);
  if (!res.headersSent) res.status(500).json({ error: '服务内部错误' });
 }
});

// 可用第三方登录方式：未配置的服务端不暴露，前端据此隐藏对应按钮（避免点了报错）
app.get('/api/oauth/providers', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  res.json({
    ok: true,
    providers: {
      qq: oauthEnabled(), wx: oauthEnabled(), alipay: oauthEnabled(),
      github: ghEnabled()
    }
  });
});

// 查询当前账号已绑定的第三方账号：GET /api/oauth/bindings
app.get('/api/oauth/bindings', (req, res) => {
 if (!ready) return res.status(503).json({ error: '服务初始化中' });
 const u = verifyToken(String(req.headers.authorization || '').replace('Bearer ', '').trim());
 if (!u) return res.status(401).json({ error: '未授权' });
 const rows = prepare('SELECT provider, social_uid, nickname, avatar, created_at FROM oauth_accounts WHERE user_id=?').all(u.id);
 const mask = (s) => { const t = String(s || ''); return t.length > 10 ? t.slice(0, 4) + '****' + t.slice(-4) : '****'; };
 res.json({
  ok: true,
  items: rows.map(r => ({
   provider: r.provider, socialUid: mask(r.social_uid),
   nickname: r.nickname || '', avatar: r.avatar || '',
   createdAt: r.created_at
  }))
 });
});

// 解绑：POST /api/oauth/unbind { provider }
app.post('/api/oauth/unbind', (req, res) => {
 if (!ready) return res.status(503).json({ error: '服务初始化中' });
 const u = verifyToken(String(req.headers.authorization || '').replace('Bearer ', '').trim());
 if (!u) return res.status(401).json({ error: '未授权' });
 const provider = String((req.body || {}).provider || '').trim();
 if (!OAUTH_TYPES.includes(provider)) return res.status(400).json({ error: '不支持的登录方式' });
 prepare('DELETE FROM oauth_accounts WHERE user_id=? AND provider=?').run(u.id, provider);
 logAudit(u.id, 'oauth_unbind', u.id, 'user', '解绑聚合登录(' + provider + ')', getIp(req));
 res.json({ ok: true });
});

// 账密完成绑定：POST /api/oauth/bind { ticket, account, password }
// 前端拿到票据后，用现有账号密码把第三方账号绑定到自己名下并登录。
app.post('/api/oauth/bind', (req, res) => {
 if (!ready) return res.status(503).json({ error: '服务初始化中' });
 if (!oauthEnabled()) return res.status(503).json({ error: '聚合登录未配置' });
 const body = req.body || {};
 const ip = getIp(req);
 if (rateLimit('oauthbind:' + ip, 15, 15 * 60 * 1000)) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });

 const ticket = String(body.ticket || '').trim();
 const account = String(body.account || body.username || '').trim();
 const password = String(body.password || '');
 if (!ticket || !account || !password) return res.status(400).json({ error: '请填写账号和密码' });

 // 校验并消费票据（一次性）
 let tk;
 try {
  const dot = ticket.lastIndexOf('.');
  if (dot <= 0) return res.status(400).json({ error: '绑定票据无效，请重新发起登录' });
  const b = ticket.slice(0, dot), sig = ticket.slice(dot + 1);
  const expect = oauthSig(b);
  if (sig.length !== expect.length) return res.status(400).json({ error: '绑定票据无效，请重新发起登录' });
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return res.status(400).json({ error: '绑定票据无效，请重新发起登录' });
  tk = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
 } catch (e) { return res.status(400).json({ error: '绑定票据无效，请重新发起登录' }); }
 if (!tk || !tk.p || !tk.s || !tk.nn || !tk.exp || Date.now() > tk.exp) {
  return res.status(400).json({ error: '绑定已超时，请重新发起登录' });
 }
 if (_oauthSeen.has(tk.nn)) return res.status(400).json({ error: '该绑定票据已使用过，请重新发起登录' });
 _oauthSeen.set(tk.nn, Date.now());

 let user = prepare('SELECT * FROM users WHERE username=?').get(account);
 if (!user && account.indexOf('@') > -1) user = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(account);
 if (!user || !bcrypt.compareSync(password, user.password)) {
  return res.status(401).json({ error: '账号或密码错误' });
 }
 if (user.banned) return res.status(403).json({ error: '该账号已被封禁' + (user.ban_reason ? '：' + user.ban_reason : '') });

 const dup = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get(tk.p, tk.s);
 if (dup && dup.user_id !== user.id) return res.status(409).json({ error: '该第三方账号已绑定其他账户' });
 if (dup) {
  prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
   .run(Date.now(), tk.n || dup.nickname, tk.a || dup.avatar, dup.id);
 } else {
  prepare('INSERT INTO oauth_accounts(provider,social_uid,user_id,nickname,avatar,created_at,last_login_at) VALUES(?,?,?,?,?,?,?)')
   .run(tk.p, tk.s, user.id, tk.n || '', tk.a || '', Date.now(), Date.now());
  // 首次绑定时把第三方头像同步到账号（用户已有头像则不覆盖）
  if (!user.avatar && tk.a) {
   try { prepare('UPDATE users SET avatar=? WHERE id=?').run(String(tk.a).slice(0, 500), user.id); } catch (e) {}
  }
 }
 const fresh = prepare('SELECT * FROM users WHERE id=?').get(user.id);
 logAudit(user.id, 'oauth_bind', user.id, 'user', '绑定聚合登录(' + tk.p + ')', ip);
 res.json({ ok: true, token: signToken(fresh), user: publicUser(fresh) });
});

// ---------- GitHub App 用户登录 ----------
// 纯"登录 + 读资料"只需 user access token，不需要 private key / installation token。
// 注意：GitHub App 的用户授权流程与 OAuth App 基本一致。
const GH_CLIENT_ID = process.env.GH_CLIENT_ID || '';
const GH_CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const GH_REDIRECT = process.env.GH_OAUTH_REDIRECT ||
  ((process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '') + '/api/github/callback');
function ghEnabled() { return !!(GH_CLIENT_ID && GH_CLIENT_SECRET); }
// 申请 read:user + user:email（拿邮箱所需）
const GH_SCOPE = process.env.GH_SCOPE || 'read:user user:email';

// Step1 取 GitHub 授权地址：GET /api/github/connect
app.get('/api/github/connect', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  if (!ghEnabled()) return res.status(503).json({ error: 'GitHub 登录未配置（缺少 GH_CLIENT_SECRET）' });
  const ip = getIp(req);
  if (rateLimit('gh:' + ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const state = oauthSignState({
    t: 'github',
    nonce: crypto.createHash('sha256').update(String(Date.now()) + Math.random() + ip).digest('hex').slice(0, 24),
    exp: Date.now() + 10 * 60 * 1000
  });
  // 申请 user:email 权限，否则 /user 返回的 email 常为 null（用户未公开邮箱）
  const url = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(GH_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(GH_REDIRECT) + '&scope=' + encodeURIComponent(GH_SCOPE) +
    '&state=' + encodeURIComponent(state);
  res.json({ ok: true, type: 'github', url, state });
});

// Step2 回调：GET /api/github/callback?code=&state=
async function githubCallbackHandler(req, res) {
  try {
    if (!ready) return res.status(503).json({ error: '服务初始化中' });
    if (!ghEnabled()) return oauthFail(req, res, 'GitHub 登录未配置', 503);
    const q = req.query || {};
    const code = String(q.code || '').trim();
    const st = oauthVerifyState(q.state);
    if (!code) return oauthFail(req, res, '缺少授权码');
    if (!st || st.t !== 'github') return oauthFail(req, res, '登录状态已失效，请重新发起登录');

    // code 换 user access token
    const tokenResp = await new Promise((resolve) => {
      const u = new URL('https://github.com/login/oauth/access_token');
      const body = 'client_id=' + encodeURIComponent(GH_CLIENT_ID) +
        '&client_secret=' + encodeURIComponent(GH_CLIENT_SECRET) +
        '&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(GH_REDIRECT);
      const req2 = require('https').request({
        hostname: u.hostname, port: 443, path: u.pathname, method: 'POST', timeout: 15000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
                   'Content-Length': Buffer.byteLength(body), 'User-Agent': 'SecureChat' }
      }, (r) => {
        let b = ''; r.on('data', (c) => { if (b.length < 100000) b += c; });
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({}); } });
      });
      req2.on('error', () => resolve({}));
      req2.on('timeout', () => { req2.destroy(); resolve({}); });
      req2.write(body); req2.end();
    });
    if (!tokenResp || tokenResp.error || !tokenResp.access_token) {
      return oauthFail(req, res, 'GitHub 授权失败：' + ((tokenResp && tokenResp.error_description) || '无法获取访问令牌'), 401);
    }

    // 取用户资料
    const profile = await new Promise((resolve) => {
      const req3 = require('https').request({
        hostname: 'api.github.com', port: 443, path: '/user', method: 'GET', timeout: 15000,
        headers: { Authorization: 'Bearer ' + tokenResp.access_token, Accept: 'application/vnd.github+json',
                   'User-Agent': 'SecureChat' }
      }, (r) => {
        let b = ''; r.on('data', (c) => { if (b.length < 100000) b += c; });
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
      });
      req3.on('error', () => resolve(null));
      req3.on('timeout', () => { req3.destroy(); resolve(null); });
      req3.end();
    });
    if (!profile || !profile.id) return oauthFail(req, res, '无法获取 GitHub 用户资料', 401);

    const socialUid = 'gh_' + profile.id;
    const nickname = String(profile.name || profile.login || '').slice(0, 40);
    const avatar = String(profile.avatar_url || '').slice(0, 500);
    const ip = getIp(req);

    // 取已验证邮箱：/user 的 email 字段常为 null(用户未公开)，需再查 /user/emails
    const ghGet = (pathname) => new Promise((resolve) => {
      const r = require('https').request({
        hostname: 'api.github.com', port: 443, path: pathname, method: 'GET', timeout: 12000,
        headers: { Authorization: 'Bearer ' + tokenResp.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'SecureChat' }
      }, (rs) => {
        let b = ''; rs.on('data', (c) => { if (b.length < 200000) b += c; });
        rs.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    });
        // 邮箱必须来自 /user/emails 且 verified=true。
    // 安全要点：/user 返回的 profile.email 是用户可任意填写的「公开邮箱」，GitHub 不做验证，
    // 绝不能用于自动匹配账号（否则攻击者把公开邮箱填成受害者邮箱即可零成本抢绑账号）。
    let ghEmail = '';
    const emails = await ghGet('/user/emails');
    if (Array.isArray(emails)) {
      const prim = emails.find((x) => x && x.primary && x.verified) ||
                   emails.find((x) => x && x.verified);
      if (prim && prim.email) ghEmail = String(prim.email).trim().toLowerCase().slice(0, 120);
    }
    if (!ghEmail && profile.email) {
      console.warn('[github] 未取到已验证邮箱，忽略未验证的公开邮箱: ' + String(profile.email).slice(0, 80));
    }
    logAudit(null, 'oauth', null, 'user', 'GitHub 授权成功 ' + (profile.login || '') + ' 邮箱=' + (ghEmail || '未获取'), ip);
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const frontBase = (process.env.PUBLIC_BASE_URL || 'https://mc.32768.top:8888').replace(/\/+$/, '');
    const toFront = (o) => res.redirect(frontBase + '/chat#' + o.key + '=' + encodeURIComponent(JSON.stringify(o.data)));
    // 登录态发起的绑定：未绑定时直接绑到当前用户（state.u 由服务端签名，防篡改），
    // 避免又弹账密框让用户重复登录
    if (st && st.u) {
      const me = prepare('SELECT * FROM users WHERE id=?').get(st.u);
      if (me && !me.banned) {
        const exist = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get('github', socialUid);
        if (exist && exist.user_id === me.id) {
          prepare('UPDATE oauth_accounts SET last_login_at=?, nickname=?, avatar=? WHERE id=?')
            .run(Date.now(), nickname || exist.nickname, avatar || exist.avatar, exist.id);
        } else if (!exist) {
          prepare('INSERT INTO oauth_accounts(provider,social_uid,user_id,nickname,avatar,created_at,last_login_at) VALUES(?,?,?,?,?,?,?)')
            .run('github', socialUid, me.id, nickname || '', avatar || '', Date.now(), Date.now());
        }
        logAudit(me.id, 'oauth_bind', me.id, 'user', '绑定GitHub', ip);
        const fresh = prepare('SELECT * FROM users WHERE id=?').get(me.id);
        const tk = signToken(fresh);
        if (wantsHtml) return toFront({ key: 'oauthbound', data: { type: 'github', nickname, ok: 1 } });
        return res.json({ ok: true, token: tk, user: publicUser(fresh) });
      }
    }

    // 未绑定：若本站存在"邮箱与 GitHub 已验证邮箱相同"的账号，则直接绑定并登录，
    // 省去用户再输一次账密。邮箱取自 GitHub /user/emails 的 verified 项。
    if (ghEmail) {
      const matched = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(ghEmail);
      if (matched && !matched.banned) {
        const dupMail = prepare('SELECT * FROM oauth_accounts WHERE provider=? AND social_uid=?').get('github', socialUid);
        if (dupMail && dupMail.user_id !== matched.id) {
          // 该 GitHub 号已绑到别的账户，走正常 SSO 直接登录那个账户
          const other = prepare('SELECT * FROM users WHERE id=?').get(dupMail.user_id);
          if (other && !other.banned) {
            const tkM = signToken(other);
            if (wantsHtml) return toFront({ key: 'oauth', data: { token: tkM, type: 'github', bound: 1 } });
            return res.json({ ok: true, bound: true, token: tkM, user: publicUser(other) });
          }
          prepare('DELETE FROM oauth_accounts WHERE id=?').run(dupMail.id);
        } else if (!dupMail) {
          prepare('INSERT INTO oauth_accounts(provider,social_uid,user_id,nickname,avatar,created_at,last_login_at) VALUES(?,?,?,?,?,?,?)')
            .run('github', socialUid, matched.id, nickname || '', avatar || '', Date.now(), Date.now());
        }
        prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), matched.id);
        logAudit(matched.id, 'oauth_bind', matched.id, 'user', '按GitHub已验证邮箱自动绑定', ip);
        const freshM = prepare('SELECT * FROM users WHERE id=?').get(matched.id);
        const tk = signToken(freshM);
        if (wantsHtml) return toFront({ key: 'oauth', data: { token: tk, type: 'github', bound: 1, matchedEmail: 1 } });
        return res.json({ ok: true, bound: true, matchedEmail: true, token: tk, user: publicUser(freshM) });
      }
    }
    return oauthCompleteBind(req, res, 'github', socialUid, nickname, avatar, toFront, wantsHtml, ip);
  } catch (e) {
    console.error('[github] callback 异常:', e && e.message || e);
    if (!res.headersSent) res.status(500).json({ error: '服务内部错误' });
  }
}

app.get('/api/github/callback', githubCallbackHandler);
app.get('/auth/callback', githubCallbackHandler);


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
  const { email, code, password } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: '请填写邮箱和验证码' });
  // 改绑/换绑邮箱必须验证原密码：否则一旦会话 token 被窃取，
  // 攻击者可直接换成自己的邮箱再走 /api/password/reset 完成账号接管。
  const cur = prepare('SELECT id,password,email FROM users WHERE id=?').get(payload.id);
  if (cur && cur.email && cur.password) {
    if (!password) return res.status(400).json({ error: '修改已绑定邮箱需要输入当前密码' });
    if (!bcrypt.compareSync(String(password), cur.password)) return res.status(403).json({ error: '当前密码错误' });
  }
  if (rateLimit('emailbind:' + payload.id, 5, 60 * 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请1小时后再试' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'bind');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
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
  // 密码登录：前端不携带人机验证数据（注册/验证码登录才带），故此处保持兼容模式，
  // 改由下方账号级失败计数（login_fail）兜底撞库与密码喷洒。
  // 注意：若改为 strict=true 会直接打断全部密码登录，客户端需同步改造。
  verifyHuman(req, res, false).then((ok) => {
    if (!ok) return;
    (function doLogin() {
  try {
  // account 可为用户名或邮箱（兼容旧字段 username）
  const account = String((req.body || {}).account || (req.body || {}).username || '').trim().slice(0, 320);
  const rawPassword = (req.body || {}).password;
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!account || !password) return res.status(400).json({ error: '用户名/邮箱和密码不能为空' });
  let user = prepare('SELECT * FROM users WHERE username=?').get(account);
  if (!user && account.indexOf('@') > -1) {
    user = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(account);
  }
  // 账号级失败锁定：原实现只有按 IP 的固定窗口限流，攻击者用代理池/IPv6 空间
  // 可对同一账号无限尝试（撞库、密码喷洒）而永不触发锁定。
  if (rateLimit('login_fail:' + String(account).toLowerCase(), 10, 30 * 60 * 1000)) {
    return res.status(429).json({ error: '该账号登录失败次数过多，请30分钟后再试' });
  }
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名/邮箱或密码错误' });
  }
  if (user.banned) {
    return res.status(403).json({ error: '该账号已被封禁' + (user.ban_reason ? '：' + user.ban_reason : '') });
  }
  const loginDeviceId = String((req.body || {}).deviceId || '').slice(0, 128);
  // 关键：若带 deviceId，必须先确保该设备已登记（token 会绑定设备，若设备缺失 verifyToken 会立即失效）
  if (loginDeviceId) {
    try {
      prepare(`INSERT INTO devices(user_id, device_id, device_name, device_type, platform, ip, last_active_at, created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET ip=excluded.ip, last_active_at=excluded.last_active_at`)
        .run(user.id, loginDeviceId, String((req.body || {}).deviceName || '').slice(0, 64) || '未知设备', String((req.body || {}).deviceType || 'desktop').slice(0, 32), String((req.body || {}).platform || '').slice(0, 32), getIp(req), Date.now(), Date.now());
    } catch (e) {}
  }
  const token = signToken(user, loginDeviceId || undefined);
  clearRateLimit('login_fail:' + String(account).toLowerCase());
  res.json({ token, user: publicUser(user) });
  } catch (e) {
    // 类型异常的 body（如 password 传对象）会让 bcrypt 抛错；若不兜底响应会一直挂起并占用连接
    console.error('[login] 处理失败:', e && e.message || e);
    if (!res.headersSent) { try { res.status(500).json({ error: '登录失败，请稍后再试' }); } catch (_) {} }
  }
    })();
  });
});

// 邮箱验证码登录：POST /api/login/code { email, code }
app.post('/api/login/code', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  verifyHuman(req, res, true).then((ok) => {
    if (!ok) return;
    (function doCodeLogin() {
  try {
  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
  const code = typeof body.code === 'string' ? body.code.trim().slice(0, 16) : '';
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式错误' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'login');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const user = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  if (user.banned) {
    return res.status(403).json({ error: '该账号已被封禁' + (user.ban_reason ? '：' + user.ban_reason : '') });
  }
  const codeDeviceId = String((req.body || {}).deviceId || '').slice(0, 128);
  if (codeDeviceId) {
    try {
      prepare(`INSERT INTO devices(user_id, device_id, device_name, device_type, platform, ip, last_active_at, created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET ip=excluded.ip, last_active_at=excluded.last_active_at`)
        .run(user.id, codeDeviceId, String((req.body || {}).deviceName || '').slice(0, 64) || '未知设备', String((req.body || {}).deviceType || 'desktop').slice(0, 32), String((req.body || {}).platform || '').slice(0, 32), getIp(req), Date.now(), Date.now());
    } catch (e) {}
  }
  const token = signToken(user, codeDeviceId || undefined);
  res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('[login/code] 处理失败:', e && e.message || e);
    if (!res.headersSent) { try { res.status(500).json({ error: '登录失败，请稍后再试' }); } catch (_) {} }
  }
    })();
  });
});

// 退出登录：POST /api/logout
// 客户端清本地存储并不等于服务端失效：token 仍可用满 7 天（被窃取即可继续访问）。
// 这里把当前 token 的 sha256 记入吊销表，并删除其绑定的设备记录（设备维度踢下线）。
app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '');
  const p = verifyToken(token);
  if (!p) return res.status(401).json({ error: '未授权' });
  const exp = p.exp ? p.exp * 1000 : Date.now() + 7 * 24 * 3600 * 1000;
  const h = tokenHashOf(token);
  revokedTokenCache.set(h, exp);
  try {
    prepare('INSERT OR REPLACE INTO revoked_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(h, p.id, exp);
    if (p.deviceId) prepare('DELETE FROM devices WHERE user_id=? AND device_id=?').run(p.id, String(p.deviceId));
    persist();
  } catch (e) {
    console.error('[logout] 吊销写入失败: ' + (e && e.message || e));
  }
  res.json({ ok: true });
});

// 忘记密码：POST /api/password/reset { email, code, newPassword }
// 先向邮箱发送 purpose=reset 的验证码，再凭邮箱+验证码重置密码。
app.post('/api/password/reset', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const ip = getIp(req);
  if (rateLimit('reset:' + ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请15分钟后再试' });
  const { email, code, newPassword } = req.body || {};
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式错误' });
  if (!code) return res.status(400).json({ error: '请输入邮箱验证码' });
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少6位' });
  if (codeAttemptsExceeded(email)) return res.status(429).json({ error: '尝试次数过多，请10分钟后再试' });
  const codeErr = checkCode(email, code, 'reset');
  if (codeErr) { recordCodeFail(email); return res.status(400).json({ error: codeErr }); }
  clearCodeFails(email);
  const user = prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (!user) return res.status(400).json({ error: '该邮箱未注册' });
  const hash = bcrypt.hashSync(String(newPassword), 10);
  prepare('UPDATE users SET password=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').run(hash, user.id);
  // token_version 已让旧 token 失效，但已建立的 WS 连接不会重新校验，必须主动踢下线。
  try { forceLogoutUser(user.id, '密码已重置，请重新登录'); } catch (e) {}
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
  try { forceLogoutUser(user.id, '密码已修改，请重新登录'); } catch (e) {}
  res.json({ ok: true });
});

// 扫码登录（聊天式）：未登录端（电脑）生成二维码 → 已登录端（手机）扫码确认 → 电脑端轮询后登录。
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
  if (rateLimit('qrimg:' + getIp(req), 60, 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
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
  // QR 生成是 CPU 密集操作，未登录接口必须限流，否则可被刷满 CPU
  if (rateLimit('qrcode:' + getIp(req), 60, 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
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
  // 全站用户目录会被用来批量加好友/拉群，加频率限制防止枚举刷取
  if (rateLimit('users:' + payload.id, 30, 60 * 1000)) return res.status(429).json({ error: '请求过于频繁' });
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
  // 限流：10 分钟内最多发 20 个好友请求（防批量骚扰/爬用户）
  if (rateLimit('friendreq:' + payload.id, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '好友请求过于频繁，请稍后再试' });
  const existing = prepare('SELECT id,status FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)')
    .get(payload.id, friendId, friendId, payload.id);
  if (existing && existing.status === 1) return res.status(409).json({ error: '已经是好友' });
  if (existing && existing.status === 0) return res.status(409).json({ error: '已发送请求，待对方接受' });
  prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,0,?)')
    .run(payload.id, friendId, Date.now());
  res.json({ ok: true, friend: publicUserBrief(target) });
  if (onlineAny(friendId)) {
    const me = prepare('SELECT id,username,nickname,avatar,uid,email,country,province,city,extra,pubkey FROM users WHERE id=?').get(payload.id);
    sendToUser(friendId, P.S_FRIEND_REQ, { from: payload.id, fromUser: publicUserBrief(me) });
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
  res.json({ friends: rows.map(r => ({ ...publicUserBrief(r), online: onlineHas(r.id), remark: r.remark || '' })) });
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
  res.json({ requests: rows.map(r => publicUserBrief(r)) });
});

function pushFriendList(uid) {
  if (!onlineAny(uid)) return;
  const rows = prepare(
     `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id=? AND f.status=1 ORDER BY u.nickname`
  ).all(uid);
  const list = rows.map(r => ({ ...publicUserBrief(r), online: onlineHas(r.id) }));
  sendToUser(uid, P.S_FRIEND_LIST, { friends: list });
}

// 设置头像：POST /api/avatar { avatar: "<data-uri base64>" }
app.post('/api/avatar', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const avatar = (req.body || {}).avatar;
  if (rateLimit('avatar:' + payload.id, 20, 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
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
    prepare('BEGIN IMMEDIATE TRANSACTION').run();
    const opk = prepare('SELECT id, key_id AS keyId, pub_key AS pubKey FROM prekeys WHERE user_id=? AND used=0 ORDER BY created_at ASC LIMIT 1').get(targetId) || null;
    if (opk) {
      prepare('UPDATE prekeys SET used=1 WHERE id=?').run(opk.id);
      oneTimePreKey = { keyId: opk.keyId, pubKey: opk.pubKey };
    }
    prepare('COMMIT').run();
  } catch (e) { try { prepare('ROLLBACK').run(); } catch {} }
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
  // 资料修改会触发 broadcastUserList 全量广播，必须限流防止高频改昵称刷全站
  if (rateLimit('profile:' + payload.id, 20, 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
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
  const row = prepare(`
    SELECT m.id,m.from_id AS fromId,m.to_id AS toId,m.content,m.recalled,m.created_at AS createdAt,m.read,
      mm.reply_to AS replyTo,mm.forwarded_from AS forwardedFrom,
      mm.burn_after_reading AS burnAfterReading,mm.pinned
    FROM messages m LEFT JOIN message_meta mm ON mm.message_id=m.id
    WHERE m.id=? AND (m.from_id=? OR m.to_id=?)
  `).get(messageId, userId, userId);
  // 撤回后正文不得再经 pin/reply/favorite 等接口回读
  if (row && row.recalled) row.content = '';
  return row;
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
  // message_meta 是全局共享行：只允许消息发送者修改，否则收件人可篡改对方消息的引用/置顶
  if (Number(message.fromId) !== Number(payload.id)) return res.status(403).json({ error: '只能操作自己发送的消息' });
  const replyToRaw = Number(req.body && req.body.replyTo) || 0;
  if (replyToRaw) {
    // 引用必须属于同一会话，否则可跨私聊把他人消息正文带进来
    const peer = Number(message.fromId) === Number(payload.id) ? Number(message.toId) : Number(message.fromId);
    const own = prepare('SELECT 1 FROM messages WHERE id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
      .get(replyToRaw, payload.id, peer, peer, payload.id);
    if (!own) return res.status(400).json({ error: '被引用消息不属于当前会话' });
  }
  const meta = messageMetaUpdate(id, payload.id, 'reply_to', replyToRaw);
  res.json({ ok: true, message: meta });
});

app.post('/api/messages/:id/pin', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const id = Number(req.params.id);
  const message = messageForUser(id, payload.id);
  if (!message) return res.status(404).json({ error: '消息不存在' });
  if (Number(message.fromId) !== Number(payload.id)) return res.status(403).json({ error: '只能操作自己发送的消息' });
  const meta = messageMetaUpdate(id, payload.id, 'pinned', !!(req.body && req.body.pinned));
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
  const rows = prepare(`SELECT m.id,m.from_id AS fromId,m.to_id AS toId,
      CASE WHEN m.recalled=1 THEN '' ELSE m.content END AS content,
      m.created_at AS createdAt,f.created_at AS favoritedAt
    FROM message_favorites f JOIN messages m ON m.id=f.message_id WHERE f.user_id=? ORDER BY f.created_at DESC`).all(payload.id);
  res.json({ messages: rows.map(r => ({ id: r.id, from: r.fromId, to: r.toId, content: r.content, createdAt: r.createdAt, favoritedAt: r.favoritedAt })) });
});

app.post('/api/chats/:peerId/settings', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
  const peerId = Number(req.params.peerId); if (!Number.isInteger(peerId)) return res.status(400).json({ error: '联系人无效' });
  // 目标必须真实存在，并限制写入频率（否则可对任意整数无限写行撑大 DB）
  if (!prepare('SELECT 1 FROM users WHERE id=?').get(peerId)) return res.status(404).json({ error: '联系人不存在' });
  if (rateLimit('chatset:' + payload.id, 120, 60 * 1000)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
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
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = prepare(`SELECT m.*,mm.reply_to,mm.forwarded_from,mm.burn_after_reading,mm.pinned,
    pm.content AS reply_content,pm.from_id AS reply_from,pm.recalled AS reply_recalled
    FROM messages m LEFT JOIN message_meta mm ON mm.message_id=m.id
    LEFT JOIN messages pm ON pm.id=mm.reply_to AND ((pm.from_id=? AND pm.to_id=?) OR (pm.from_id=? AND pm.to_id=?))
    WHERE ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?))
      AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
    ORDER BY m.created_at DESC LIMIT ? OFFSET ?`)
    .all(payload.id, peerId, peerId, payload.id, payload.id, peerId, peerId, payload.id, payload.id, limit, offset);
  const msgs = rows.reverse().map(r => ({ id: r.id, from: r.from_id, to: r.to_id, content: r.recalled ? '' : r.content, createdAt: r.created_at, read: r.read, replyTo: r.reply_to, forwardedFrom: r.forwarded_from, burnAfterReading: !!r.burn_after_reading, pinned: !!r.pinned, recalled: !!r.recalled, replyContent: r.reply_recalled ? null : (r.reply_content || null), replyFrom: r.reply_from || null, replyRecalled: !!r.reply_recalled }));
  res.json({ messages: msgs });
});

app.get('/api/search/messages', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ messages: [] });
  const qs = q.replace(/[\\%_]/g, '\\$&');
  // 撤回的消息不出现在搜索结果中(撤回后正文仍留在库里,这里过滤掉)
  const rows = prepare(`SELECT m.id,m.from_id,m.to_id,m.content,m.created_at FROM messages m
    WHERE (m.from_id=? OR m.to_id=?) AND m.recalled=0
      AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
      AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 50`)
    .all(payload.id, payload.id, payload.id, '%' + qs + '%');
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
  // 导出原先无任何上限且不过滤已撤回/已隐藏消息：可一次性拉走全量历史，
  // 也能导出自己已清空（hidden_messages）的对话。这里限制最近 20000 条并做过滤。
  if (rateLimit('export:' + payload.id, 10, 10 * 60 * 1000)) return res.status(429).json({ error: '导出过于频繁，请稍后再试' });
  const rows = prepare(
    `SELECT m.*,u1.nickname AS fromName,u2.nickname AS toName FROM messages m
     LEFT JOIN users u1 ON u1.id=m.from_id LEFT JOIN users u2 ON u2.id=m.to_id
     WHERE ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?))
       AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
     ORDER BY m.created_at ASC LIMIT 20000`
  ).all(payload.id, peerId, peerId, payload.id, payload.id);
  const safeContent = (r) => (r.recalled ? '[消息已撤回]' : r.content);
  if (format === 'txt') {
    const lines = rows.map(r => {
      const time = new Date(r.created_at).toLocaleString('zh-CN');
      const name = r.from_id === payload.id ? (r.fromName || '我') : (r.toName || '对方');
      return `[${time}] ${name}: ${safeContent(r)}`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${peerId}.txt"`);
    res.send(lines.join('\n'));
  } else {
    const msgs = rows.map(r => ({ id: r.id, from: r.from_id, to: r.to_id, fromName: r.fromName, toName: r.toName, content: safeContent(r), createdAt: r.created_at, read: r.read }));
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
  // 清空聊天记录只影响自己：原实现物理删除双方消息并清掉对方的收藏，
  // 单方即可销毁对方历史记录（跨用户数据破坏）。改为写入 hidden_messages，
  // 只对当前用户隐藏，不再动对方数据。
  let hidden = 0;
  try {
    const r = prepare(`INSERT OR IGNORE INTO hidden_messages(user_id,message_id,created_at)
      SELECT ?, id, ? FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)`)
      .run(payload.id, Date.now(), payload.id, peerId, peerId, payload.id);
    hidden = (r && r.changes) || 0;
  } catch (e) {
    return res.status(500).json({ error: '清空失败：' + (e && e.message || e) });
  }
  try { prepare('DELETE FROM message_favorites WHERE user_id=? AND message_id IN (SELECT message_id FROM hidden_messages WHERE user_id=?)').run(payload.id, payload.id); } catch {}
  persist();
  res.json({ ok: true, deleted: hidden });
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
  // 编辑同样受限：发送时过滤了敏感词，但编辑此前可直接改成违规内容
  const _badEdit = checkSensitive(content.trim());
  if (_badEdit) return res.status(400).json({ error: '内容包含违规词：' + _badEdit });
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
  // REST 发送限流：WS 通道有 60 条/10s 限制，REST 此前无限流，可绕过刷库/骚扰
  if (rateLimit('msg:' + payload.id, 120, 60 * 1000)) return res.status(429).json({ error: '发送过于频繁，请稍后再试' });
  const toId = parseInt(to, 10);
  if (!Number.isInteger(toId) || !content || typeof content !== 'string') return res.status(400).json({ error: '消息内容无效' });
  if (toId === payload.id) return res.status(400).json({ error: '不能给自己发送消息' });
  if (!prepare('SELECT 1 FROM users WHERE id=?').get(toId)) return res.status(404).json({ error: '目标用户不存在' });
  if (content.length > MAX_MSG_CONTENT) return res.status(413).json({ error: '消息内容过长（最大100KB）' });
  // 敏感词过滤：单聊主链路此前完全缺失（WS 通道同样缺失）
  const _swMsg = checkSensitive(String(content));
  if (_swMsg) return res.status(400).json({ error: '消息包含违规词：' + _swMsg });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(payload.id, toId)) return res.status(403).json({ error: '你已拉黑对方，无法发送消息' });
  if (prepare('SELECT 1 FROM blocklist WHERE blocker_id=? AND blocked_id=?').get(toId, payload.id)) return res.status(403).json({ error: '对方已把你拉黑，无法发送消息' });
  if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) return res.status(400).json({ error: '消息标识无效' });
  if (clientMsgId) {
    const existing = prepare('SELECT id,from_id AS senderId,to_id AS recipientId,content,created_at AS createdAt FROM messages WHERE client_msg_id=? AND from_id=?').get(clientMsgId, payload.id);
    if (existing) return res.json({ ok: true, message: { id: existing.id, from: existing.senderId, to: existing.recipientId, content: existing.content, createdAt: existing.createdAt, clientMsgId } });
  }
  const createdAt = Date.now();
  // 越权防护:replyTo/forwardedFrom 必须属于当前用户的会话,防 id 枚举读取任意私聊正文
  const dmReplyTo = Number(replyTo) || null;
  const dmFwdFrom = Number(forwardedFrom) || null;
  // 必须是「发件人↔本收件人」这一会话内的消息，避免引用到与其他人的私聊
  const dmOwnsMsg = (mid) => !!prepare('SELECT 1 FROM messages WHERE id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
    .get(mid, payload.id, toId, toId, payload.id);
  const okReply = dmReplyTo ? dmOwnsMsg(dmReplyTo) : true;
  const okFwd = dmFwdFrom ? dmOwnsMsg(dmFwdFrom) : true;
  if (!okReply || !okFwd) return res.status(403).json({ error: '引用的消息不存在或无权访问' });
  const msgSeq = nextSeq();
  const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at,seq) VALUES(?,?,?,?,?,?)').run(payload.id, toId, content, clientMsgId || null, createdAt, msgSeq);
  if (dmReplyTo || dmFwdFrom || burnAfterReading) {
    prepare('INSERT INTO message_meta(message_id,reply_to,forwarded_from,burn_after_reading,updated_at) VALUES(?,?,?,?,?)')
      .run(info.lastInsertRowid, dmReplyTo, dmFwdFrom, burnAfterReading ? 1 : 0, createdAt);
  }
  const message = { id: info.lastInsertRowid, from: payload.id, to: toId, content, createdAt, clientMsgId: clientMsgId || null, replyTo: dmReplyTo, forwardedFrom: dmFwdFrom, burnAfterReading: !!burnAfterReading, read: 0, seq: msgSeq };
  const peer = onlineAny(toId);
  if (peer) sendToUser(toId, P.S_MSG, message);
  // 离线队列：对方不在线时入队，重连后推送（即使 WS 断开也能收到）
  if (!peer) {
    try { prepare('INSERT INTO offline_queue(user_id, from_id, msg_type, ref_id, content, seq, created_at) VALUES(?,?,?,?,?,?,?)').run(toId, payload.id, 'direct', info.lastInsertRowid, content, msgSeq, createdAt); } catch (e) {}
  }
  // 推送给自己其他在线端（多端同步：REST 发送时其他端也需要看到自己发的消息）
  sendToUser(payload.id, P.S_MSG, message);
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

// 二进制上传前置鉴权：express.raw 必须在鉴权之后挂载，否则未登录请求会先把
// 100/200/500MB 请求体读进内存再返回 401（并发几十个即 OOM）。
function rawAuthGate(req, res, next) {
  const p = apiUser(req);
  if (!p) {
    try { req.resume(); } catch (e) {}
    return res.status(401).json({ error: '未授权' });
  }
  req._scUser = p;
  next();
}

app.post('/api/files', rawAuthGate, express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = req._scUser || apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '文件为空' });
  // 单文件与用户总量配额：原先本接口无任何配额（/api/media、群文件都有），
  // 任意用户循环上传可把磁盘写满，导致整个服务不可用。
  if (req.body.length > 100 * 1024 * 1024) return res.status(413).json({ error: '文件超过 100MB 限制' });
  try {
    const used = prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM file_transfers WHERE from_id=?')
      .get(payload.id) || { c: 0, s: 0 };
    if (Number(used.c) + 1 > 500) return res.status(400).json({ error: '文件数量已达上限（500 个）' });
    if (Number(used.s) + req.body.length > 2 * 1024 * 1024 * 1024) return res.status(400).json({ error: '文件空间已满（2GB）' });
  } catch (e) { return res.status(500).json({ error: '配额校验失败' }); }
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
  // 路径遍历防护：验证文件路径在允许目录内（带分隔符，避免 C:\chat\files-evil 命中前缀）
  const resolved = path.resolve(file.path);
  const inFiles = resolved.startsWith(path.resolve(FILES_DIR) + path.sep);
  const inCalls = resolved.startsWith(path.resolve(CALLS_DIR) + path.sep);
  if (!inFiles && !inCalls) {
    return res.status(403).json({ error: '路径非法' });
  }
  // Content-Type 白名单：mime 来自用户上传参数，含 CRLF 会让 setHeader 抛 ERR_INVALID_CHAR
  // 导致该文件永久 500；非白名单一律 octet-stream（配合 nosniff 避免存储型 XSS）。
  const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'video/mp4', 'video/webm', 'application/pdf', 'text/plain']);
  const mime = String(file.mime || '').split(';')[0].trim().toLowerCase();
  res.setHeader('Content-Type', SAFE_INLINE.has(mime) ? mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/["\\\r\n]/g, '_')}"`);
  const stream = fs.createReadStream(file.path);
  // 文件可能被 TTL 清理并发删除：无 error 监听会冒泡成 uncaughtException 并挂起响应
  stream.on('error', (e) => {
    console.error('[files] 读取失败: ' + (e && e.message || e));
    if (!res.headersSent) { try { res.status(404).json({ error: '文件不存在' }); } catch (_) {} }
    else { try { res.destroy(); } catch (_) {} }
  });
  stream.pipe(res);
});

// ---------- 离线文件中转清理（TTL）----------
// 原实现 file_transfers 只有插入与读取，全库没有任何删除路径或 TTL 清扫，
// 过期后磁盘文件与数据库行永久保留，磁盘单调增长直至写满。
(function __fileTransferJanitor() {
  const TTL = 30 * 24 * 3600 * 1000; // 中转文件保留 30 天
  const SWEEP = 6 * 3600 * 1000;     // 每 6 小时清扫一次
  const run = () => {
    try {
      if (!ready) return;
      const cutoff = Date.now() - TTL;
      const rows = prepare('SELECT id, path FROM file_transfers WHERE created_at < ?').all(cutoff);
      if (!rows || !rows.length) return;
      let removed = 0;
      for (const r of rows) {
        try { if (r.path && fs.existsSync(r.path)) fs.unlinkSync(r.path); } catch (e) {}
        try { prepare('DELETE FROM file_transfers WHERE id=?').run(r.id); removed++; } catch (e) {}
      }
      if (removed) {
        try { persist(); } catch (e) {}
        console.log('[file-transfers] 已清理过期中转文件 ' + removed + ' 个');
      }
    } catch (e) {
      console.error('[file-transfers] 清理失败: ' + (e && e.message || e));
    }
  };
  const kick = setTimeout(run, 30000);
  if (kick && typeof kick.unref === 'function') kick.unref();
  const t = setInterval(run, SWEEP);
  if (t && typeof t.unref === 'function') t.unref();
})();

// ---------- 离线消息队列清理（TTL）----------
// offline_queue 只在对方离线时写入，客户端从不调用 /api/offline/pull 或 /ack（实测无人调用），
// 因此行会永久堆积。登录推送已按 seq 清理，这里再兜底清扫 30 天前的陈旧行。
(function __offlineQueueJanitor() {
  const TTL = 30 * 24 * 3600 * 1000;
  const SWEEP = 12 * 3600 * 1000;
  const run = () => {
    try {
      if (!ready) return;
      const r = prepare('DELETE FROM offline_queue WHERE created_at < ?').run(Date.now() - TTL);
      if (r && r.changes) {
        try { persist(); } catch (e) {}
        console.log('[offline-queue] 已清理过期离线消息 ' + r.changes + ' 条');
      }
    } catch (e) {
      console.error('[offline-queue] 清理失败: ' + (e && e.message || e));
    }
  };
  const kick = setTimeout(run, 45000);
  if (kick && typeof kick.unref === 'function') kick.unref();
  const t = setInterval(run, SWEEP);
  if (t && typeof t.unref === 'function') t.unref();
})();

// ---------- 已吊销 token 清理（自然过期后无需再记录）----------
(function __revokedTokenJanitor() {
  const SWEEP = 6 * 3600 * 1000;
  const run = () => {
    try {
      if (!ready) return;
      const now = Date.now();
      const r = prepare('DELETE FROM revoked_tokens WHERE expires_at <= ?').run(now);
      for (const [h, exp] of revokedTokenCache) if (exp <= now) revokedTokenCache.delete(h);
      if (r && r.changes) {
        try { persist(); } catch (e) {}
        console.log('[revoked-token] 已清理过期吊销记录 ' + r.changes + ' 条');
      }
    } catch (e) {
      console.error('[revoked-token] 清理失败: ' + (e && e.message || e));
    }
  };
  const kick = setTimeout(run, 60000);
  if (kick && typeof kick.unref === 'function') kick.unref();
  const t = setInterval(run, SWEEP);
  if (t && typeof t.unref === 'function') t.unref();
})();

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
    // 系统默认 python 可能是 32 位(装不了 PyTorch)，故用 STT_PYTHON 指定的 64 位解释器
    const py = process.env.STT_PYTHON || 'python';
    try {
      const { stdout } = await execFile(py, [script, filePath], {
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // 必须显式 UTF-8：Windows 上子进程 stdout 默认按 GBK/latin1 解码，中文会乱码
        encoding: 'utf8',
        env: {
          ...process.env,
          STT_WHISPER_MODEL: process.env.STT_WHISPER_MODEL || 'base',
          STT_WHISPER_LANG: process.env.STT_WHISPER_LANG || 'zh',
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com'
        }
      });
      const out = String(stdout).trim();
      if (!out) throw new Error('未识别到语音内容');
      return out;
    } catch (e) {
      const detail = String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 300);
      throw new Error(detail || '转写失败');
    }
  }
  throw new Error('未配置 STT_WHISPER_CLI，或缺少 server/stt_whisper.py');
}

// 语音转写任务表：转写耗时长(可能几十秒)，而公网 8888 是 TLS 探测口，
// 空闲 15 秒会断开连接(slowloris 防护)，长任务必须走"提交 + 轮询"而非同步等待。
const STT_TTL = 5 * 60 * 1000;
function sttSweep() {
  const now = Date.now();
  for (const [k, v] of sttJobs) if (now - v.at > STT_TTL) sttJobs.delete(k);
}
const sttJobs = new Map();

app.post('/api/stt', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  // STT 限流：30MB 音频识别吃 CPU（外部 python 进程），不设限可并发刷爆
  if (rateLimit('stt:' + payload.id, 10, 60 * 1000)) return res.status(429).json({ error: '识别请求过于频繁，请稍后再试' });
  const id = String((req.body && req.body.id) || '');
  const audioB64 = req.body && req.body.audioB64;
  let filePath = null;
  let tmpFile = null;
  if (audioB64 && typeof audioB64 === 'string') {
    try {
      const buf = Buffer.from(audioB64, 'base64');
      if (!buf.length) return res.status(400).json({ error: '音频数据为空' });
      if (buf.length > 30 * 1024 * 1024) return res.status(413).json({ error: '音频过大(限30MB)' });
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
  sttSweep();
  const jobId = crypto.randomUUID();
  sttJobs.set(jobId, { status: 'running', at: Date.now(), uid: payload.id });
  res.json({ ok: true, jobId, status: 'running' });

  // 后台执行，完成后写回结果；前端用 /api/stt/status 轮询
  runStt(filePath)
    .then(text => sttJobs.set(jobId, { status: 'done', text, at: Date.now(), uid: payload.id }))
    .catch(e => {
      console.error('[stt]', e.message);
      sttJobs.set(jobId, { status: 'error', error: String(e && e.message || e).slice(0, 300), at: Date.now(), uid: payload.id });
    })
    .finally(() => { if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} } });
});

// 轮询转写结果：GET /api/stt/status?jobId=
app.get('/api/stt/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const jobId = String((req.query || {}).jobId || '');
  const job = sttJobs.get(jobId);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  if (job.uid !== payload.id) return res.status(403).json({ error: '无权查看该任务' });
  sttSweep();
  res.json({ ok: true, status: job.status, text: job.text || '', error: job.error || '' });
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

app.post('/api/call-recordings', rawAuthGate, express.raw({
    // type-is 对带 codecs 参数（如 video/webm;codecs=vp8,opus）的匹配有 bug，改用自定义类型判定
    type: (req) => { const ct = String(req.headers['content-type'] || '').split(';')[0].trim(); return ct === 'video/webm' || ct === 'audio/webm'; },
    limit: '500mb'
  }), (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = req._scUser || apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '回放为空' });
  const toId = parseInt(req.query.to, 10);
  const kind = req.query.kind === 'video' ? 'video' : 'audio';
  if (!Number.isInteger(toId) || !prepare('SELECT id FROM users WHERE id=?').get(toId)) return res.status(400).json({ error: '接收方无效' });
  const areFriends = prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=1').get(payload.id, toId);
  if (!areFriends) return res.status(403).json({ error: '只能录制好友通话' });
  // 通话录像原先无任何配额与 TTL，单账号可无限上传 500MB 文件写满磁盘。
  const used = prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS cnt FROM call_recordings WHERE from_id=?').get(payload.id) || { bytes: 0, cnt: 0 };
  if (used.cnt >= 500 || used.bytes + req.body.length > 2 * 1024 * 1024 * 1024) {
    return res.status(413).json({ error: '回放存储配额已满，请先删除旧回放' });
  }
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
  // 通话录像仅通话双方可见。直播回放豁免仅在该直播间的**主播本人**引用时生效：
  // 原实现只判断「是否有直播间引用该录像」，而 replay_url 由用户自由填写且不校验录像归属，
  // 导致通话任一方可单方面把私密通话录像公开给全站登录用户（另一方从未同意）。
  let liveRef = null;
  try {
    liveRef = prepare('SELECT 1 FROM live_rooms WHERE host_id=? AND (replay_url=? OR replay_url LIKE ?)').get(payload.id, '/api/call-recordings/' + req.params.id, '/api/call-recordings/' + req.params.id + '%');
  } catch (e) { /* live_rooms 未建表（直播模块未挂载）时视为无引用 */ }
  // 直播回放豁免必须同时满足「引用者是该直播间主播」和「录像属于该主播本人」，
  // 否则任意用户可自建直播间把 replay_url 指向他人录像 id 来下载私密通话录像。
  const ownsRecording = row.from_id === payload.id || row.to_id === payload.id;
  if (!ownsRecording && !(liveRef && row.from_id === payload.id)) {
    // 管理员可查看所有回放
    const meA = prepare('SELECT * FROM users WHERE id=?').get(payload.id);
    const adminOk = !!meA && !!meA.email && String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').includes(meA.email.toLowerCase());
    if (!adminOk) return res.status(404).json({ error: '回放不存在' });
  }
  if (!fs.existsSync(row.path)) return res.status(404).json({ error: '回放不存在' });
  const resolved = path.resolve(row.path);
  if (!resolved.startsWith(path.resolve(CALLS_DIR) + path.sep)) return res.status(403).json({ error: '路径非法' });
  res.setHeader('Content-Type', row.kind === 'audio' ? 'audio/webm' : 'video/webm');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stream = fs.createReadStream(resolved);
  stream.on('error', (e) => {
    console.error('[call-recordings] 读取失败: ' + (e && e.message || e));
    if (!res.headersSent) { try { res.status(404).json({ error: '回放不存在' }); } catch (_) {} }
    else { try { res.destroy(); } catch (_) {} }
  });
  stream.pipe(res);
});

// 删除通话回放：通话任一方可删除（删除后双方都不可再访问）
app.delete('/api/call-recordings/:id', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const payload = apiUser(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const row = prepare('SELECT * FROM call_recordings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '回放不存在' });
  // 只有上传者（发起方）可删除，避免收件人单方面销毁对方的唯一录像
  if (Number(row.from_id) !== Number(payload.id)) return res.status(404).json({ error: '回放不存在' });
  try {
    const resolved = path.resolve(String(row.path || ''));
    if (row.path && resolved.startsWith(path.resolve(CALLS_DIR) + path.sep) && fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (e) { console.error('[call-recordings] 删除文件失败: ' + (e && e.message || e)); }
  try { prepare('DELETE FROM call_recordings WHERE id=?').run(row.id); persist(); } catch (e) { return res.status(500).json({ error: '删除失败' }); }
  res.json({ ok: true });
});

// ---------- 通话回放 TTL 清理 ----------
// 录像文件与数据库行此前只增不减，配合配额上限兜底，定期清理 90 天前的回放。
(function __callRecordingJanitor() {
  const TTL = 90 * 24 * 3600 * 1000;
  const SWEEP = 12 * 3600 * 1000;
  const run = () => {
    try {
      if (!ready) return;
      const rows = prepare('SELECT id, path FROM call_recordings WHERE created_at < ?').all(Date.now() - TTL);
      if (!rows || !rows.length) return;
      // 仍被直播回放引用的录像不删，否则直播回放 404
      let liveRefs = new Set();
      try {
        for (const lr of prepare('SELECT replay_url FROM live_rooms').all()) {
          const m = /\/api\/call-recordings\/(\d+)/.exec(String((lr && lr.replay_url) || ''));
          if (m) liveRefs.add(Number(m[1]));
        }
      } catch (e) {}
      let removed = 0;
      const baseDir = path.resolve(CALLS_DIR) + path.sep;
      for (const r of rows) {
        if (liveRefs.has(Number(r.id))) continue;
        try {
          if (r.path) {
            const resolved = path.resolve(String(r.path));
            if (!resolved.startsWith(baseDir)) continue;
            if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
          }
        } catch (e) { continue; }
        try { prepare('DELETE FROM call_recordings WHERE id=?').run(r.id); removed++; } catch (e) {}
      }
      if (removed) {
        try { persist(); } catch (e) {}
        console.log('[call-recordings] 已清理过期回放 ' + removed + ' 个');
      }
    } catch (e) {
      console.error('[call-recordings] 清理失败: ' + (e && e.message || e));
    }
  };
  const kick = setTimeout(run, 45000);
  if (kick && typeof kick.unref === 'function') kick.unref();
  const t = setInterval(run, SWEEP);
  if (t && typeof t.unref === 'function') t.unref();
})();

// ---------- 群组 ----------
// 建群：POST /api/group/create { name }
app.post('/api/group/create', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const name = (req.body || {}).name;
  // 类型校验：传对象时 String() 会得到 "[object Object]" 并真的建出一个怪群名
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: '群名不能为空' });
  const groupName = name.trim().slice(0, 50);
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
  // uid 必须是字符串/数字：传对象会让 sql.js 绑定抛错（500）而不是返回 400
  const uid = typeof body.uid === 'string' || typeof body.uid === 'number' ? String(body.uid).trim() : '';
  if (!groupId) return res.status(400).json({ error: '群ID不能为空' });
  if (!uid) return res.status(400).json({ error: '对方UID不能为空' });
  const g = prepare('SELECT id FROM groups WHERE id=?').get(groupId);
  if (!g) return res.status(404).json({ error: '群不存在' });
  // 与 groups.js 新版邀请接口对齐：人数上限 + 频率限制（原接口两者都没有，
  // 配合 /api/users 可把全站用户逐个塞进群）
  if (rateLimit('groupinvite:' + payload.id, 50, 60 * 60 * 1000)) return res.status(429).json({ error: '邀请过于频繁，请稍后再试' });
  const cnt = prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id=?').get(groupId);
  if (cnt && Number(cnt.c) >= 500) return res.status(400).json({ error: '群成员已达上限（500 人）' });
  const inviter = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, payload.id);
  if (!inviter) return res.status(403).json({ error: '你不是该群成员，无法邀请' });
  const target = prepare('SELECT id FROM users WHERE uid=?').get(uid);
  if (!target) return res.status(404).json({ error: '该UID不存在' });
  const exists = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(groupId, target.id);
  if (exists) return res.status(409).json({ error: '该用户已是群成员' });
  // 拉黑校验(与 groups.js 的新版邀请接口一致):任一方拉黑则不能邀请入群
  const blk = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(payload.id, target.id, target.id, payload.id);
  if (blk) return res.status(403).json({ error: '对方已把你拉黑，无法邀请' });
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
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = prepare(
    `SELECT gm.id, gm.group_id AS groupId, gm.from_id AS fromId,
            CASE WHEN gm.recalled=1 THEN '' ELSE gm.content END AS content,
            gm.recalled, gm.created_at AS createdAt,
            gmm.pinned, gmm.reply_to AS replyTo,
            u.id AS userId, u.username, u.nickname, u.avatar, u.uid AS userUid
      FROM group_messages gm LEFT JOIN users u ON u.id = gm.from_id
      LEFT JOIN group_message_meta gmm ON gmm.message_id = gm.id
      WHERE gm.group_id=?
        AND gm.created_at >= COALESCE((SELECT joined_at FROM group_members WHERE group_id=? AND user_id=?),0)
      ORDER BY gm.created_at DESC LIMIT ? OFFSET ?`
  ).all(groupId, groupId, payload.id, limit, offset);
  const msgs = rows.reverse().map(r => ({
    id: r.id, groupId: r.groupId, from: r.fromId, content: r.content, createdAt: r.createdAt,
    fromUser: { id: r.userId, username: r.username, nickname: r.nickname, avatar: r.avatar, uid: r.userUid },
    pinned: !!r.pinned, replyTo: r.replyTo || null, recalled: !!r.recalled
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
  // 限流：同一用户 10 分钟内最多 20 条动态，防刷
  if (rateLimit('moment:' + payload.id, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '发布过于频繁，请稍后再试' });
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
  // 拉黑双向过滤：只按 friends 取动态时，被拉黑的人仍会出现在 feed 里（拉黑不自动删好友）。
  const blockedRows = prepare('SELECT blocker_id, blocked_id FROM blocklist WHERE blocker_id=? OR blocked_id=?').all(payload.id, payload.id);
  const blockedIds = new Set(blockedRows.map(r => (r.blocker_id === payload.id ? r.blocked_id : r.blocker_id)));
  const rows = prepare(
    `SELECT m.id,m.user_id AS userId,m.content AS content,m.images,m.created_at AS createdAt,
            u.nickname,u.avatar,u.uid
     FROM moments m JOIN users u ON u.id=m.user_id
     WHERE m.user_id IN (${friendIds.map(()=>'?').join(',')})
     ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
  ).all(...friendIds, limit, offset).filter(m => !blockedIds.has(m.userId));
  // 补点赞与评论
  // 批量查点赞/评论，避免 N+1
  const momentIds = rows.map(m => m.id);
  const allLikes = momentIds.length ? prepare('SELECT moment_id,user_id FROM moment_likes WHERE moment_id IN (' + momentIds.map(()=>'?').join(',') + ') ORDER BY created_at').all(...momentIds) : [];
  const allComments = momentIds.length ? prepare(
    `SELECT c.id,c.moment_id AS momentId,c.user_id AS userId,c.content AS content,c.created_at AS createdAt,u.nickname
     FROM moment_comments c JOIN users u ON u.id=c.user_id WHERE c.moment_id IN (` + momentIds.map(()=>'?').join(',') + `) ORDER BY c.created_at ASC`
  ).all(...momentIds) : [];
  // 点赞/评论同样过滤黑名单用户，否则拉黑后仍能在动态下看到对方的互动
  const likesVisible = allLikes.filter(l => !blockedIds.has(l.user_id));
  const commentsVisible = allComments.filter(c => !blockedIds.has(c.userId));
  // 点赞昵称：一次 JOIN users 取所有点赞者的昵称
  const likerIds = [...new Set(likesVisible.map(l => l.user_id))];
  const nickMap = new Map();
  if (likerIds.length) {
    const nickRows = prepare('SELECT id,nickname FROM users WHERE id IN (' + likerIds.map(()=>'?').join(',') + ')').all(...likerIds);
    for (const nr of nickRows) nickMap.set(nr.id, nr.nickname);
  }
  const likesByMoment = new Map(); const commentsByMoment = new Map();
  for (const l of likesVisible) {
    if (!likesByMoment.has(l.moment_id)) likesByMoment.set(l.moment_id, []);
    likesByMoment.get(l.moment_id).push(l.user_id);
  }
  for (const c of commentsVisible) { if (!commentsByMoment.has(c.momentId)) commentsByMoment.set(c.momentId, []); commentsByMoment.get(c.momentId).push(c); }
  const data = rows.map(m => {
    const likes = likesByMoment.get(m.id) || [];
    const comments = commentsByMoment.get(m.id) || [];
    try { m.images = JSON.parse(m.images || '[]'); } catch { m.images = []; }
    m.likeCount = likes.length;
    m.likedByMe = likes.includes(payload.id);
    // 点赞者昵称列表（聊天式"XXX，YYY 觉得很赞"）
    m.likers = likes.map(uid => nickMap.get(uid) || '').filter(Boolean);
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
  if (content.length > 2000) return res.status(400).json({ error: '评论过长（限2000字）' });
  const _sw = checkSensitive(content.trim());
  if (_sw) return res.status(400).json({ error: '评论包含违规词：' + _sw });
  // 限流：同一用户 5 分钟内最多 30 条评论，防刷
  if (rateLimit('mcomment:' + payload.id, 30, 5 * 60 * 1000)) return res.status(429).json({ error: '评论过于频繁，请稍后再试' });
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
    prepare('BEGIN IMMEDIATE TRANSACTION').run();
    const c = prepare('SELECT code,value,claimed_by FROM redeem_codes WHERE code=?').get(code);
    if (!c) { prepare('ROLLBACK').run(); return res.status(404).json({ error: '兑换码不存在' }); }
    if (c.claimed_by) { prepare('ROLLBACK').run(); return res.status(409).json({ error: '兑换码已被使用' }); }
    prepare('UPDATE redeem_codes SET claimed_by=?,claimed_at=? WHERE code=?').run(payload.id, Date.now(), code);
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(payload.id, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(c.value, c.value, Date.now(), payload.id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)').run(payload.id, 'recharge', c.value, '兑换码充值', Date.now());
    prepare('COMMIT').run();
    persist();
    const w = prepare('SELECT balance FROM wallets WHERE user_id=?').get(payload.id);
    res.json({ ok: true, balance: w.balance, value: c.value });
  } catch (e) { try { prepare('ROLLBACK').run(); } catch {} res.status(500).json({ error: '兑换失败' }); }
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
  let value = parseFloat(amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: '金额无效' });
  value = Math.round(value * 100) / 100;
  if (value <= 0) return res.status(400).json({ error: '金额无效' });
  if (value > 1000000) return res.status(400).json({ error: '单笔转账最多 100 万元' });
  try {
    prepare('BEGIN IMMEDIATE TRANSACTION').run();
    // CAS 余额扣款:与 doPay/红包一致,避免 check-then-act 模式脆弱
    const deb = prepare('UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=? AND balance>=?').run(value, Date.now(), payload.id, value);
    if (!deb.changes) { prepare('ROLLBACK').run(); return res.status(400).json({ error: '余额不足' }); }
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,?,?,?)').run(target.id, 0, 0, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(value, value, Date.now(), target.id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)').run(payload.id, 'out', value, target.id, remark || '转账', Date.now());
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)').run(target.id, 'in', value, payload.id, remark || '收到转账', Date.now());
    prepare('COMMIT').run();
    persist();
    // 到账语音通知：SecureChat到账 xx元（推送给收款方在线连接）
    try {
      const meRow = prepare('SELECT nickname,username FROM users WHERE id=?').get(payload.id);
      const senderName = meRow ? (meRow.nickname || meRow.username || ('用户' + payload.id)) : ('用户' + payload.id);
      sendToUser(target.id, 'payment_arrival', { amount: value, fromId: payload.id, fromName: senderName, remark: remark || '转账', category: 'transfer', ts: Date.now() });
    } catch (e) {}
    res.json({ ok: true, balance: (prepare('SELECT balance FROM wallets WHERE user_id=?').get(payload.id)).balance });
  } catch (e) { try { prepare('ROLLBACK').run(); } catch {} res.status(500).json({ error: '转账失败' }); }
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
  // 只认商户密钥（epay_config.key）。曾有用 .epaygw_key.json 后备验签的逻辑,
  // 但该文件存的是源码里的公开默认常量 securechat-mock-key,等于验签形同虚设,
  // 任何人都能伪造回调无限充值,已删除。
  const signOk = epaySignOf(p, c.key) === String(p.sign || '').toLowerCase();
  if (!signOk) {
    console.log('[wallet] recharge notify sign mismatch: ' + JSON.stringify(p).slice(0, 300));
    return res.send('sign error');
  }
  if (String(p.trade_status || '') !== 'TRADE_SUCCESS') return res.send('success');
  ensureRechargeTable();
  try {
    prepare('BEGIN IMMEDIATE TRANSACTION').run();
    const r = prepare('SELECT * FROM wallet_recharges WHERE order_no=?').get(String(p.out_trade_no || ''));
    if (!r) { prepare('ROLLBACK').run(); return res.send('order not found'); }
    if (r.status === 'paid') { prepare('ROLLBACK').run(); return res.send('success'); }
    // 金额必须按分精确比对：原实现 Math.abs(a-b)>0.001 在 p.money 缺失/NaN 时
    // 两边都是 NaN，比较为 false → 直接放行，金额校验形同虚设。
    const notifyCents = Math.round(Number(p.money) * 100);
    const orderCents = Math.round(Number(r.amount) * 100);
    if (!Number.isFinite(notifyCents) || notifyCents <= 0 || notifyCents !== orderCents) {
      console.log('[wallet] recharge money mismatch: order=' + r.amount + ' notify=' + p.money);
      prepare('ROLLBACK').run(); return res.send('money mismatch');
    }
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(r.user_id, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(r.amount, r.amount, Date.now(), r.user_id);
    prepare('UPDATE wallet_recharges SET status=?,trade_no=?,paid_at=? WHERE order_no=?').run('paid', String(p.trade_no || ''), Date.now(), r.order_no);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)')
      .run(r.user_id, 'recharge', r.amount, '在线充值(' + (p.trade_no || '') + ')', Date.now());
    prepare('COMMIT').run();
    persist();
    console.log('[wallet] recharged: user=' + r.user_id + ' +' + r.amount);
    // 到账语音通知：充值到账
    try {
      sendToUser(r.user_id, 'payment_arrival', { amount: r.amount, fromId: null, fromName: '在线充值', remark: '充值到账', category: 'recharge', ts: Date.now() });
    } catch (e) {}
    res.send('success');
  } catch (e) { try { prepare('ROLLBACK').run(); } catch {} res.send('error'); }
});

// 状态：GET my status / SET 状态（聊天『我的状态』）
app.get('/api/status', (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const auth = req.headers.authorization || '';
  const payload = verifyToken(auth.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: '未授权' });
  const s = prepare('SELECT text,icon,emoji,bg_url AS bgUrl,created_at AS createdAt,expires_at AS expiresAt,updated_at AS updatedAt FROM user_status WHERE user_id=?').get(payload.id);
  // 过期状态不再下发（历史行 expires_at 可能为空，视为有效但由 status-collar 的 24h 逻辑兜底）
  if (s && s.expiresAt && s.expiresAt <= Date.now()) return res.json({ status: null });
  res.json({ status: s || null });
});
// 设置状态：POST /api/status 由 routes/status-collar.js 统一提供（含 24h 过期、背景图、校验），
// 此处不再重复注册，否则会先注册覆盖掉带过期的实现。

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
// 点赞/评论路由已统一由 routes/media.js 提供（含频控、敏感词、回复与拉黑过滤），
// 此处保留占位说明，勿再重复注册，否则会因先注册而覆盖 media.js 的实现。

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
  // 限流：对同一人 1 分钟内最多拍 5 次（防骚扰刷屏）
  if (rateLimit('poke:' + payload.id + ':' + to, 5, 60 * 1000)) return res.status(429).json({ error: '拍一拍过于频繁，请稍后再试' });
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
  const rawNote = (req.body || {}).content;
  if (typeof rawNote !== 'string') return res.status(400).json({ error: '内容格式错误' });
  const content = rawNote.trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 50000) return res.status(400).json({ error: '内容过长（限5万字）' });
  // 限流：防单请求连环插入撑爆笔记配额
  if (rateLimit('note:' + payload.id, 30, 60 * 1000)) return res.status(429).json({ error: '保存过于频繁，请稍后再试' });
  // 配额：单用户最多 2000 条笔记，防刷库
  const noteCount = prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id=? AND type=?').get(payload.id, 'note');
  if (noteCount && noteCount.c >= 2000) return res.status(400).json({ error: '笔记数量已达上限（2000条）' });
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
  if (content.length > 5000) return res.status(400).json({ error: '内容过长（限5000字）' });
  // 限流：同一用户 10 分钟内最多 5 条，防刷库
  if (rateLimit('feedback:' + payload.id, 5, 10 * 60 * 1000)) return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
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
    ).all(g.id).map(m => ({ ...publicUserBrief(m), online: onlineHas(m.id) }));
    const last = prepare(
      `SELECT gm.id, gm.from_id AS fromId, CASE WHEN gm.recalled=1 THEN '' ELSE gm.content END AS content, gm.created_at AS createdAt,
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
    // 群未读:非自己发的、未登记已读的消息数(message_reads 表可能缺失,子查询报错时降级 0)
    let unread = 0;
    try {
      const ur = prepare(
        `SELECT COUNT(*) AS c FROM group_messages gm
         WHERE gm.group_id=? AND gm.from_id<>? AND gm.recalled=0
         AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id=gm.id AND mr.user_id=?)`
      ).get(g.id, userId, userId);
      unread = ur ? (Number(ur.c) || 0) : 0;
    } catch (e) { /* message_reads 表缺失时为 0 */ }
    return { id: g.id, name: g.name, ownerId: g.ownerId, members, lastMessage, unread };
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
    // 禁止更新包携带任何运行时数据：旧快照会覆盖线上库/文件，等于数据回滚
    for (const keep of ['server/data/', 'server/files/', 'server/call-recordings/', 'server/media/', 'server/group-files/', 'server/downloads/', 'server/node_modules/', 'server/backups/']) {
      if (name.startsWith(keep)) throw new Error('更新包不允许包含运行时数据: ' + name);
    }
    if (name === 'server/.env' || name.endsWith('/.env')) throw new Error('更新包不允许包含 .env');
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
    if (preserveUpdatePackages && RUNTIME_KEEP.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, false);
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}

// 运行时目录/文件：更新包替换代码时必须原样保留。
// 原实现只保留 update-packages，apply 一次就会删掉 data（含线上 sqlite）、files、
// call-recordings、media、group-files、downloads、node_modules、.env —— 直接丢数据且可能起不来。
const RUNTIME_KEEP = new Set([
  'update-packages', 'data', 'files', 'call-recordings', 'media', 'group-files',
  'downloads', 'node_modules', 'backups', '.env', 'guard_miss.count'
]);

function clearTree(source, preserveUpdatePackages) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source)) {
    if (preserveUpdatePackages && RUNTIME_KEEP.has(entry)) continue;
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

app.post('/api/admin/update-package', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  // 必须先鉴权再读请求体：express.raw 作为路由中间件会在鉴权前把整个 body 读进内存，
  // 未登录攻击者用 application/octet-stream 发超大请求即可在 401 前耗尽堆内存（OOM DoS）。
  // 注意：guard.sent 为真说明 401/403 已发出，此时绝不能再读体（原实现顺序写反，等于没修）。
  if (guard.sent) return;
  await readRawBody(req, res, '1gb');
  if (res._scRawError) return;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '上传内容为空' });
  if (req.body.length > UPDATE_MAX_BYTES) return res.status(413).json({ error: '更新包超过 1GB 限制' });
  const id = Date.now() + '-' + process.pid;
  const zipPath = path.join(UPDATE_PACKAGES_DIR, id + '.zip');
  const extracted = path.join(UPDATE_PACKAGES_DIR, id + '-extracted');
  const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
  try {
    fs.mkdirSync(UPDATE_PACKAGES_DIR, { recursive: true });
    zipEntryNames(req.body);
    fs.writeFileSync(zipPath, req.body, { flag: 'wx' });
    await extractZip(zipPath, extracted);
    updateStatus = { state: 'pending', package: path.basename(zipPath), extracted: path.basename(extracted), size: req.body.length, sha256, updatedAt: Date.now() };
    // 管理员可替换服务端代码/分发包，属最高危操作，必须留痕（原实现完全无审计）
    logAudit(guard.payload.id, 'update_package_upload', null, 'system',
      JSON.stringify({ file: path.basename(zipPath), size: req.body.length, sha256, apply: String(req.query.apply || '') === 'true' }), clientIp(req));
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
    logAudit(guard.payload.id, 'update_package_apply', null, 'system',
      JSON.stringify({ package: updateStatus.package, sha256: updateStatus.sha256, backup }), clientIp(req));
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
    // latest 参与拼接下载文件名：若被写成 "../../evil" 会让后续上传/删除写出 downloads 目录。
    const ver = String(cfg.latest || cfg.current || '');
    if (!/^\d+\.\d+\.\d+$/.test(ver)) throw new Error('invalid latest version: ' + ver);
    return {
      current: String(cfg.current || DEFAULT_VERSION_CONFIG.current),
      latest: ver,
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
    // fallback 版本段必须是 x.y.z，避免管理员误放的外部文件引导客户端"升级"到假版本
    if (fallback) {
      const verSeg = fallback.slice(prefix.length, -suffix.length);
      downloadVersions[key] = /^\d+\.\d+\.\d+$/.test(verSeg) ? verSeg : cfg.latest;
    }
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
  // 版本号决定全量客户端是否自动更新，属高危操作
  logAudit(guard.u.id, 'version_set', null, 'system', '设置最新版本为 ' + latest, clientIp(req));
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
    // 兑换码等同现金：必须用密码学随机数，Math.random 状态可预测（拿到几张码即可推算后续）
    let c; do { c = Array.from({ length: 12 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
    while (prepare('SELECT 1 FROM redeem_codes WHERE code=?').get(c));
    prepare('INSERT INTO redeem_codes(code,value,created_at) VALUES(?,?,?)').run(c, value, Date.now());
    codes.push(c);
  }
  persist();
  res.json({ ok: true, count: codes.length, value, codes });
  // 兑换码等价于发放余额，必须留痕
  logAudit(guard.u.id, 'redeem_issue', null, 'system',
    '生成兑换码 ' + codes.length + ' 张，面额 ' + value, clientIp(req));
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
  // 金额先归一到分，避免 0.005 产生亚分余额
  const rawAmount = parseFloat(b.amount);
  const amount = Math.round(rawAmount * 100) / 100;
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
    // 原子扣减：原实现先 SELECT 再 UPDATE，并发两个扣款请求都能通过非负检查（余额可为负）
    const r = prepare('UPDATE wallets SET balance=balance+?,updated_at=? WHERE user_id=? AND balance+?>=0').run(amount, Date.now(), user.id, amount);
    if (!r || !r.changes) return res.status(400).json({ error: '扣减后余额为负' });
  }
  prepare('INSERT INTO wallet_txn(user_id,kind,amount,remark,created_at) VALUES(?,?,?,?,?)').run(user.id, amount > 0 ? 'recharge' : 'admin_deduct', Math.abs(amount), b.remark || '管理员调整', Date.now());
  persist();
  const w2 = prepare('SELECT balance FROM wallets WHERE user_id=?').get(user.id);
  res.json({ ok: true, userId: user.id, balance: w2.balance });
  // 直接改用户余额属最高危的资金操作，必须留痕（原实现可无痕清零任何账户）
  logAudit(guard.u.id, amount > 0 ? 'wallet_add' : 'wallet_sub', user.id, 'user',
    (amount > 0 ? '增加余额 ' : '扣减余额 ') + amount + '，余额变为 ' + w2.balance, clientIp(req));
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
app.post('/api/admin/upload/:platform', async (req, res) => {
  if (!ready) return res.status(503).json({ error: '服务初始化中' });
  const guard = adminGuard(req, res);
  // 必须先鉴权再读请求体（同 update-package：guard.sent 后仍读体等于未授权 OOM 通道）
  if (guard.sent) return;
  await readRawBody(req, res, '300mb');
  if (res._scRawError) return;
  const info = PLATFORM_FILES[String(req.params.platform || '')];
  if (!info) return res.status(400).json({ error: '平台无效' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: '上传内容为空，请使用 application/octet-stream 发送文件字节流' });
  }
  const cfg = getVersionConfig();
  const filename = 'SecureChat-' + cfg.latest + '-' + info.seg + '.' + info.ext;
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const outPath = path.join(DOWNLOADS_DIR, filename);
  // 路径约束：文件名由 version.json 拼接，getVersionConfig 已校验版本格式，这里再兜底一次
  if (!path.resolve(outPath).startsWith(path.resolve(DOWNLOADS_DIR) + path.sep)) {
    return res.status(400).json({ error: '非法目标路径' });
  }
  try { fs.writeFileSync(outPath, req.body); } catch (e) {
    return res.status(500).json({ error: '写入安装包失败：' + (e && e.message || e) });
  }
  const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
  logAudit(guard.payload.id, 'package_upload', null, info.seg,
    JSON.stringify({ file: filename, size: req.body.length, sha256 }), clientIp(req));
  res.json({ ok: true, file: filename, size: req.body.length, sha256 });
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
  if (!path.resolve(filePath).startsWith(path.resolve(DOWNLOADS_DIR) + path.sep)) {
    return res.status(400).json({ error: '非法目标路径' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  fs.unlinkSync(filePath);
  logAudit(guard.payload.id, 'package_delete', null, info.seg, JSON.stringify({ file: filename }), clientIp(req));
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
  // state 由服务端生成并用 APPKEY 签名，且一次性消费。
  // 原实现直接采用客户端传入的 state，导致登录 CSRF：
  // 攻击者可用自己的 QQ 授权码 + 受害者客户端的 state 抢先写入会话，
  // 使受害者轮询到攻击者账号的 token。
  const state = oauthSignState({
    t: 'qq',
    nonce: crypto.createHash('sha256').update(String(Date.now()) + Math.random() + getIp(req)).digest('hex').slice(0, 24),
    exp: Date.now() + 10 * 60 * 1000
  });
  const url = 'https://graph.qq.com/oauth2.0/authorize?response_type=code' +
    '&client_id=' + encodeURIComponent(cfg.appid) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) +
    '&state=' + encodeURIComponent(state) +
    '&scope=get_user_info';
  // pollKey：与 state 绑定的轮询凭证，只有真正发起登录的客户端才知道，
  // 防止拿到 state（日志/历史记录泄露）的第三方直接轮询窃取登录 token。
  const pollKey = oauthSig('poll:' + state);
  res.json({ url, state, pollKey });
});

// 轮询：客户端（桌面/网页）获取登录结果
app.get('/api/oauth/qq/poll', (req, res) => {
  const state = String((req.query || {}).state || '').trim();
  const key = String((req.query || {}).key || '').trim();
  if (!state || !constantEq(key, oauthSig('poll:' + state))) return res.status(403).json({ error: '缺少轮询凭证' });
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
  const user = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(String(email).trim().toLowerCase());
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
  // 校验 state 必须由本服务签发且未被使用过（防登录 CSRF 与会话覆盖）
  const st = oauthVerifyState(state);
  if (!st || st.t !== 'qq') {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;padding:40px;text-align:center"><h3>登录状态已失效</h3><p>请返回应用重新发起登录。</p></body>');
  }
  // 同一 state 不允许覆盖已有会话（否则攻击者可在受害者授权后重置其会话）
  if (qqSessions.has(state)) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>QQ 登录</title><body style="font-family:sans-serif;padding:40px;text-align:center"><h3>登录请求已处理</h3><p>请返回应用查看结果。</p></body>');
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
    'var STATE=' + JSON.stringify(script(state)) + ';var POLLKEY=' + JSON.stringify(script(oauthSig('poll:' + state))) + ';var OPENID=' + JSON.stringify(script(od.openid)) + ';var BOUND=' + (bound ? 'true' : 'false') + ';' +
    'var t=null;' +
    'function toast(m){document.getElementById("errBox").textContent=m;}' +
    'function showOk(){document.getElementById("okBox").style.display="block";document.getElementById("bindBox").style.display="none";document.getElementById("waitBox").style.display="none";}' +
    'function sendCode(){var em=document.getElementById("email").value.trim();if(!/^[^@]+@[^@]+\\.[^@]+$/.test(em)){toast("邮箱格式不正确");return;}toast("验证码已发送，请查收邮箱");fetch("/api/email/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:em,purpose:"login"})}).then(function(r){return r.json()}).then(function(d){if(!d.ok&&d.error)toast(d.error)}).catch(function(e){toast("发送失败")});}' +
    'function bind(){var em=document.getElementById("email").value.trim();var cd=document.getElementById("code").value.trim();if(!em||!cd){toast("请填写邮箱和验证码");return;}fetch("/api/oauth/qq/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,openid:OPENID,email:em,code:cd})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function reg(){fetch("/api/oauth/qq/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,openid:OPENID})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function poll(){fetch("/api/oauth/qq/poll?state="+encodeURIComponent(STATE)+"&key="+encodeURIComponent(POLLKEY)).then(function(r){return r.json()}).then(function(d){if(d.status==="ok"){showOk();finish();}else if(d.status==="waiting"){setTimeout(poll,1500);}else{toast(d.error||"登录失败");}}).catch(function(){setTimeout(poll,2000);});}' +
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
  // state 由服务端签名生成（防登录 CSRF：原先信任客户端传入的 state，
  // 攻击者可用自己的授权码 + 受害者 state 劫持受害者会话）
  const state = oauthSignState({
    t: 'gh_legacy',
    nonce: crypto.createHash('sha256').update(String(Date.now()) + Math.random() + getIp(req)).digest('hex').slice(0, 24),
    exp: Date.now() + 10 * 60 * 1000
  });
  const url = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(cfg.clientId) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) + '&state=' + encodeURIComponent(state) + '&scope=read:user';
  const pollKey = oauthSig('poll:' + state);
  res.json({ url, state, pollKey });
});

// 轮询：客户端获取登录结果
app.get('/api/oauth/github/poll', (req, res) => {
  const state = String((req.query || {}).state || '').trim();
  const key = String((req.query || {}).key || '').trim();
  if (!state || !constantEq(key, oauthSig('poll:' + state))) return res.status(403).json({ error: '缺少轮询凭证' });
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
  const user = prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(String(email).trim().toLowerCase());
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
  const stG = oauthVerifyState(state);
  if (!stG || stG.t !== 'gh_legacy') {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;padding:40px;text-align:center"><h3>登录状态已失效</h3><p>请返回应用重新发起登录。</p></body>');
  }
  if (githubSessions.has(state)) {
    return res.type('html').send('<!doctype html><meta charset="utf-8"><title>GitHub 登录</title><body style="font-family:sans-serif;padding:40px;text-align:center"><h3>登录请求已处理</h3><p>请返回应用查看结果。</p></body>');
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
    'var STATE=' + JSON.stringify(script(state)) + ';var POLLKEY=' + JSON.stringify(script(oauthSig('poll:' + state))) + ';var GITHUB_ID=' + JSON.stringify(script(ui.githubId)) + ';var BOUND=' + (bound ? 'true' : 'false') + ';' +
    'function toast(m){document.getElementById("errBox").textContent=m;}' +
    'function showOk(){document.getElementById("okBox").style.display="block";document.getElementById("bindBox").style.display="none";document.getElementById("waitBox").style.display="none";}' +
    'function sendCode(){var em=document.getElementById("email").value.trim();if(!/^[^@]+@[^@]+\\.[^@]+$/.test(em)){toast("邮箱格式不正确");return;}toast("验证码已发送，请查收邮箱");fetch("/api/email/code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:em,purpose:"login"})}).then(function(r){return r.json()}).then(function(d){if(!d.ok&&d.error)toast(d.error)}).catch(function(e){toast("发送失败")});}' +
    'function bind(){var em=document.getElementById("email").value.trim();var cd=document.getElementById("code").value.trim();if(!em||!cd){toast("请填写邮箱和验证码");return;}fetch("/api/oauth/github/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,githubId:GITHUB_ID,email:em,code:cd})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function reg(){fetch("/api/oauth/github/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:STATE,githubId:GITHUB_ID})}).then(function(r){return r.json()}).then(function(d){if(d.error){toast(d.error);return;}showOk();finish();}).catch(function(e){toast("网络错误");});}' +
    'function poll(){fetch("/api/oauth/github/poll?state="+encodeURIComponent(STATE)+"&key="+encodeURIComponent(POLLKEY)).then(function(r){return r.json()}).then(function(d){if(d.status==="ok"){showOk();finish();}else if(d.status==="waiting"){setTimeout(poll,1500);}else{toast(d.error||"登录失败");}}).catch(function(){setTimeout(poll,2000);});}' +
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
  // 注册新凭据必须验证当前密码：仅凭会话 token 就能新增"永久登录凭证"，
  // token 被窃取（XSS/设备失窃）即可无痕加凭据，让受害者的密码防线彻底失效。
  const { password } = req.body || {};
  const me = prepare('SELECT id,password FROM users WHERE id=?').get(payload.id);
  if (me && me.password) {
    if (!password) return res.status(400).json({ error: '请输入当前密码以确认操作' });
    if (!bcrypt.compareSync(String(password), me.password)) return res.status(403).json({ error: '当前密码错误' });
  }
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
  // secret/challenge 均以 hex 存储，HMAC 需按字节参与计算（与客户端 WebCrypto 一致）
  const keyBytes = Buffer.from(session.secret, 'hex');
  const expected = crypto.createHmac('sha256', keyBytes).update(session.challenge, 'utf8').digest('hex');
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
  // AI 代理限流：Key 是用户自带的，但 60s 长连接可被打满带宽/并发
  if (rateLimit('aichat:' + payload.id, 60, 60 * 1000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
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

// 受限体积的原始二进制体读取：必须由调用方在完成鉴权之后调用。
// 直接把 express.raw 挂在路由上会让请求体在鉴权前被完整读入内存，
// 未登录攻击者只需 Content-Type: application/octet-stream + 超大 body 即可打爆进程内存。
function readRawBody(req, res, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const max = require('bytes')(limit);
    let done = false;
    // 已读完（如全局 express.json 已消费）或客户端已断开时不再等事件：
    // 原实现只监听 data/end/error，JSON 请求走到这里 Promise 永不 resolve，handler 永久挂起。
    if (req.readableEnded || req.complete) {
      req.body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return resolve();
    }
    const finish = (err) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onErr);
      req.removeListener('aborted', onAbort);
      req.removeListener('close', onAbort);
      clearTimeout(timer);
      if (err) {
        res._scRawError = true;
        // 401/403 可能已发出：不能再写头，否则抛 ERR_HTTP_HEADERS_SENT 使 handler 卡死
        if (!res.headersSent) {
          try { res.status(err.status || 400).json({ error: err.message || '请求体无效' }); } catch (e) {}
        } else {
          try { res.end(); } catch (e) {}
        }
      }
      resolve();
    };
    const onData = (c) => {
      size += c.length;
      if (size > max) { try { req.destroy(); } catch (e) {} return finish({ status: 413, message: '请求体超过大小限制' }); }
      chunks.push(c);
    };
    const onEnd = () => { req.body = Buffer.concat(chunks); finish(null); };
    const onErr = () => finish({ status: 400, message: '请求体读取失败' });
    const onAbort = () => finish({ status: 400, message: '连接已中断' });
    // 总超时兜底：慢速上传不能无限占用连接
    const timer = setTimeout(() => { try { req.destroy(); } catch (e) {} finish({ status: 408, message: '请求体读取超时' }); }, 120000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
    req.on('aborted', onAbort);
    req.on('close', onAbort);
  });
}

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
  const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
  if (banned) {
    prepare('UPDATE users SET banned=1, banned_at=?, banned_by=?, ban_reason=?, token_version=COALESCE(token_version,0)+1 WHERE id=?')
      .run(Date.now(), guard.u.id, reason, id);
  } else {
    prepare('UPDATE users SET banned=0, banned_at=NULL, banned_by=NULL, ban_reason=NULL WHERE id=?').run(id);
  }
  // 若该用户在线，断开其 WebSocket 强制下线（封禁时；解封不踢）
  if (banned) {
    forceLogoutUser(id, '账号已被封禁' + (reason ? '：' + reason : ''));
  }
  res.json({ ok: true, id, banned });
  // 封禁是高危操作，必须留痕（原实现完全无审计，令牌被盗后可无痕封禁任何人）
  logAudit(guard.u.id, banned ? 'user_ban' : 'user_unban', id, 'user',
    (banned ? '封禁用户 ' : '解封用户 ') + (target.username || ('#' + id)) +
    (banned ? ('，原因：' + (String((req.body || {}).reason || '').trim().slice(0, 100) || '未填写')) : ''), clientIp(req));
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
  // 已撤回消息默认脱敏；仅当显式传 withRecalled=1 时返回原文（并单独记审计）
  const withRecalled = String(q.withRecalled || '') === '1';
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
      // 群回放同样要留痕：管理员可读任意群（含私密群）的全部消息，
      // 原实现只有 withRecalled=1 才写审计，普通回放可无痕翻看群聊内容。
      logAudit(guard.u.id, 'replay_view', gid, 'group',
        '查看群聊回放 ' + (g ? g.name : gid) + '（' + rows.length + ' 条' + (withRecalled ? '，含撤回原文' : '') + '）', clientIp(req));
      return res.json({
        kind: 'group',
        title: g ? g.name : '群#' + gid,
        groupId: gid,
        messages: rows.map(r => ({
          id: r.id, from: r.from_id, fromName: nameOf(r.from_id),
          content: (!withRecalled && r.recalled) ? '[已撤回]' : r.content, createdAt: r.created_at, recalled: !!r.recalled
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
    logAudit(guard.u.id, withRecalled ? 'replay_view_recalled' : 'replay_view', a, 'user', (withRecalled ? '查看含撤回原文的单聊回放 ' : '回放单聊 ') + nameOf(a) + ' ↔ ' + nameOf(b) + '（' + rows.length + ' 条）', clientIp(req));
    res.json({
      kind: 'direct',
      title: nameOf(a) + ' ↔ ' + nameOf(b),
      peerA: { id: a, name: nameOf(a) },
      peerB: { id: b, name: nameOf(b) },
      messages: rows.map(r => ({
        id: r.id, from: r.from_id, fromName: nameOf(r.from_id), to: r.to_id,
        content: (!withRecalled && r.recalled) ? '[已撤回]' : r.content, createdAt: r.created_at, read: !!r.read, recalled: !!r.recalled
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
  forceLogoutUser(id, (req.body || {}).reason || '已被管理员强制下线');
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
    for (const ws of list.slice()) {
      if (ws._ip === targetIp) {
        try { send(ws, P.S_KICKED, { reason: 'IP 已被封禁' }); } catch {}
        try { ws.close(4001, 'ip banned'); } catch {}
        try { removeWs(uid, ws); } catch {}
      }
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
  forceLogoutUser(id, '密码已被管理员重置');
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
  // 管理员解散群必须做完整清理：原实现只删消息/成员/群，group_files（含磁盘文件）、
  // 公告、投票、待办、入群凭证等全部残留（每群最多 2GB 磁盘永不回收）。
  try { prepare('DELETE FROM group_message_meta WHERE message_id IN (SELECT id FROM group_messages WHERE group_id=?)').run(id); } catch (e) {}
  try { prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM group_messages WHERE group_id=?)').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_messages WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_members WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_announcements WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_member_settings WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_setting_notes WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_votes WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_todos WHERE group_id=?').run(id); } catch (e) {}
  try { prepare('DELETE FROM group_join_grants WHERE group_id=?').run(id); } catch (e) {}
  try {
    const files = prepare('SELECT id FROM group_files WHERE group_id=?').all(id);
    const dir = path.join(__dirname, 'group-files');
    for (const f of files) { try { fs.unlinkSync(path.join(dir, f.id + '.bin')); } catch (_) {} }
    prepare('DELETE FROM group_files WHERE group_id=?').run(id);
  } catch (e) {}
  try { prepare('DELETE FROM groups WHERE id=?').run(id); } catch (e) {}
  logAudit(guard.u.id, 'group_dissolve', id, 'group', '解散群: ' + g.name, clientIp(req));
  broadcastGroups();
  persist();
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
  // 必须一并清掉入群凭证：否则被管理员移出的人可用残留 grant 自助 join 重新进群
  try { prepare('DELETE FROM group_join_grants WHERE group_id=? AND user_id=?').run(groupId, userId); } catch (e) {}
  try { prepare('DELETE FROM group_member_settings WHERE group_id=? AND user_id=?').run(groupId, userId); } catch (e) {}
  try { prepare('DELETE FROM group_setting_notes WHERE group_id=? AND user_id=?').run(groupId, userId); } catch (e) {}
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

// ========== 消息增量同步 API ==========
// GET /api/sync?since=0&limit=200  — 返回 seq > since 的私聊+群聊消息
app.get('/api/sync', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const since = parseInt(req.query.since, 10) || 0;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  // 私聊消息：自己发的 + 收到的
  const directMsgs = prepare(
    `SELECT m.id, m.from_id AS "from", m.to_id AS "to",
            CASE WHEN m.recalled=1 THEN '' ELSE m.content END AS content,
            m.recalled, m.created_at AS createdAt, m.seq, m.client_msg_id AS clientMsgId, m.read
     FROM messages m
     WHERE m.seq > ? AND (m.from_id = ? OR m.to_id = ?)
       AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
     ORDER BY m.seq ASC LIMIT ?`
  ).all(since, payload.id, payload.id, payload.id, limit);
  // 群聊消息：所在群的消息
  const groupMsgs = prepare(
    `SELECT gm.id, gm.group_id AS groupId, gm.from_id AS "from",
            CASE WHEN gm.recalled=1 THEN '' ELSE gm.content END AS content,
            gm.created_at AS createdAt, gm.seq, gm.client_msg_id AS clientMsgId
     FROM group_messages gm
     JOIN group_members gmemb ON gmemb.group_id = gm.group_id AND gmemb.user_id = ?
     WHERE gm.seq > ? AND gm.created_at >= gmemb.joined_at
     ORDER BY gm.seq ASC LIMIT ?`
  ).all(payload.id, since, limit);
  // 合并排序，按 seq 升序
  const all = [...directMsgs.map(m => ({ ...m, msgType: 'direct' })), ...groupMsgs.map(m => ({ ...m, msgType: 'group' }))];
  all.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const sliced = all.slice(0, limit);
  const maxSeq = sliced.length ? Math.max(...sliced.map(m => m.seq || 0)) : since;
  // 任一路查询取满 limit 即说明可能还有更多消息。
  // 原写法 all.length > limit 会误判为 false，导致剩余消息永久丢失。
  const hasMore = all.length > limit || directMsgs.length >= limit || groupMsgs.length >= limit;
  // 更新同步状态
  const directSeqs = sliced.filter(m => m.msgType === 'direct').map(m => m.seq || 0);
  const groupSeqs = sliced.filter(m => m.msgType === 'group').map(m => m.seq || 0);
  const maxDirect = directSeqs.length ? Math.max(...directSeqs) : since;
  const maxGroup = groupSeqs.length ? Math.max(...groupSeqs) : since;
  updateSyncState(payload.id, maxDirect, maxGroup);
  res.json({ ok: true, messages: sliced, lastSeq: maxSeq, hasMore });
});

// GET /api/conversations/preview — 一次返回所有会话（好友+群）的最新一条消息
// 用于会话列表显示"最后一条消息预览"，避免 N 次请求。聊天式体验。
app.get('/api/conversations/preview', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const previews = {};
  try {
    const me = payload.id;
    // 私聊：按 (对端 peer) 分组取每组最新一条。peer = 与我不一样的那方。
    const dp = prepare(
      `SELECT id, from_id AS "from", to_id AS "to", content, created_at AS createdAt, seq, mine
       FROM (
         SELECT m.id, m.from_id, m.to_id, CASE WHEN m.recalled=1 THEN '' ELSE m.content END AS content, m.created_at, m.seq,
                CASE WHEN m.from_id=? THEN 1 ELSE 0 END AS mine,
                CASE WHEN m.from_id=? THEN m.to_id ELSE m.from_id END AS peer,
                ROW_NUMBER() OVER (PARTITION BY CASE WHEN m.from_id=? THEN m.to_id ELSE m.from_id END ORDER BY m.id DESC) AS rn
         FROM messages m
         WHERE (m.from_id=? OR m.to_id=?)
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
       ) WHERE rn=1 ORDER BY seq DESC`
    );
    const rows = dp.all(me, me, me, me, me, me);
    for (const r of rows) {
      previews['f' + (r.mine ? r.to : r.from)] = { id: r.id, text: r.content, mine: !!r.mine, ts: r.created_at, seq: r.seq };
    }
    // 群聊：每个所在群最新一条
    const gp = prepare(
      `SELECT id, group_id AS groupId, from_id AS "from", content, created_at AS createdAt, seq, mine
       FROM (
         SELECT gm.id, gm.group_id, gm.from_id, CASE WHEN gm.recalled=1 THEN '' ELSE gm.content END AS content, gm.created_at, gm.seq,
                CASE WHEN gm.from_id=? THEN 1 ELSE 0 END AS mine,
                ROW_NUMBER() OVER (PARTITION BY gm.group_id ORDER BY gm.id DESC) AS rn
         FROM group_messages gm
         JOIN group_members gmemb ON gmemb.group_id=gm.group_id AND gmemb.user_id=?
       ) WHERE rn=1 ORDER BY seq DESC`
    );
    const grows = gp.all(me, me);
    for (const r of grows) {
      previews['g' + r.groupId] = { id: r.id, text: r.content, mine: !!r.mine, ts: r.created_at, seq: r.seq };
    }
    // 私聊未读：每个好友发给我的未读消息数（重启后恢复角标）
    try {
      const dpUnread = prepare('SELECT from_id AS peer, COUNT(*) AS c FROM messages WHERE to_id=? AND read=0 AND recalled=0 GROUP BY from_id');
      for (const u of dpUnread.all(me)) {
        const key = 'f' + u.peer;
        if (previews[key]) previews[key].unread = Number(u.c) || 0; else previews[key] = { text: '', mine: false, unread: Number(u.c) || 0 };
      }
    } catch (e) { /* 忽略 */ }
  } catch (e) {
    // 窗口函数不支持时降级为空，不影响主流程
  }
  res.json({ ok: true, previews });
});
app.get('/api/offline/pending', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const cnt = prepare('SELECT COUNT(*) AS c FROM offline_queue WHERE user_id=?').get(payload.id);
  res.json({ ok: true, count: cnt ? cnt.c : 0 });
});

// GET /api/offline/pull — 拉取并清除离线消息队列
app.get('/api/offline/pull', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const rows = prepare(`SELECT q.id, q.from_id AS fromId, q.msg_type AS msgType, q.ref_id AS refId,
      CASE WHEN m.recalled=1 THEN '' ELSE q.content END AS content,
      q.seq, q.created_at AS createdAt, COALESCE(m.recalled,0) AS recalled
    FROM offline_queue q LEFT JOIN messages m ON m.id=q.ref_id
    WHERE q.user_id=? ORDER BY q.seq ASC LIMIT 500`).all(payload.id);
  const maxSeq = rows.length ? Math.max(...rows.map(r => r.seq || 0)) : 0;
  // 清除已拉取的队列（避免重复推送）
  for (const r of rows) {
    try { prepare('DELETE FROM offline_queue WHERE id=?').run(r.id); } catch (e) {}
  }
  res.json({ ok: true, messages: rows, lastSeq: maxSeq });
});

// POST /api/offline/ack — 确认收到离线消息
app.post('/api/offline/ack', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const ids = Array.isArray((req.body || {}).ids) ? (req.body.ids).map(Number).filter(Number.isInteger) : [];
  for (const id of ids) {
    try { prepare('DELETE FROM offline_queue WHERE id=? AND user_id=?').run(id, payload.id); } catch (e) {}
  }
  res.json({ ok: true });
});

// ========== 登录设备管理 API ==========
// POST /api/devices/register — 登录时注册设备
app.post('/api/devices/register', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { deviceId, deviceName, deviceType, platform } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128) return res.status(400).json({ error: '设备ID无效' });
  const name = String(deviceName || '').slice(0, 64) || '未知设备';
  const type = String(deviceType || 'desktop').slice(0, 32);
  const plat = String(platform || '').slice(0, 32);
  const ip = clientIp(req);
  const now = Date.now();
  prepare(`INSERT INTO devices(user_id, device_id, device_name, device_type, platform, ip, last_active_at, created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET device_name=excluded.device_name, device_type=excluded.device_type, platform=excluded.platform, ip=excluded.ip, last_active_at=excluded.last_active_at`)
    .run(payload.id, deviceId, name, type, plat, ip, now, now);
  res.json({ ok: true });
});

// GET /api/devices — 列出所有登录设备
app.get('/api/devices', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const devices = prepare('SELECT id, device_id AS deviceId, device_name AS deviceName, device_type AS deviceType, platform, ip, last_active_at AS lastActiveAt, created_at AS createdAt FROM devices WHERE user_id=? ORDER BY last_active_at DESC').all(payload.id);
  // 标记当前在线的设备
  const now = Date.now();
  for (const d of devices) {
    d.isOnline = (now - d.lastActiveAt) < 5 * 60 * 1000; // 5 分钟内活跃视为在线
  }
  res.json({ ok: true, devices });
});

// POST /api/devices/heartbeat — 设备心跳（更新 last_active_at）
app.post('/api/devices/heartbeat', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const { deviceId } = req.body || {};
  if (deviceId) {
    try { prepare('UPDATE devices SET last_active_at=? WHERE user_id=? AND device_id=?').run(Date.now(), payload.id, deviceId); } catch (e) {}
  }
  res.json({ ok: true });
});

// DELETE /api/devices/:deviceId — 移除设备（吊销该设备的 token，不影响其他设备）
app.delete('/api/devices/:deviceId', (req, res) => {
  const payload = authed(req);
  if (!payload) return res.status(401).json({ error: '未授权' });
  const deviceId = req.params.deviceId;
  if (!deviceId) return res.status(400).json({ error: '设备ID无效' });
  const device = prepare('SELECT * FROM devices WHERE user_id=? AND device_id=?').get(payload.id, deviceId);
  if (!device) return res.status(404).json({ error: '设备不存在' });
  // 删除设备记录 → 触发 verifyToken 中 deviceId 校验，使该设备的 token 失效
  prepare('DELETE FROM devices WHERE user_id=? AND device_id=?').run(payload.id, deviceId);
  // 推送踢下线通知并关闭仅该 deviceId 的在线 WS 连接（不影响其他设备）
  try {
    const P = require('../shared/protocol');
    const targets = online.get(payload.id);
    if (targets) {
      for (const ws of targets) {
        if (String(ws.deviceId || '') === String(deviceId)) {
          try { send(ws, P.S_DEVICE_KICKED || 'device_kicked', { deviceId }); } catch (e) {}
          try { ws.close(4003, 'device removed'); } catch (e) {}
        }
      }
    }
  } catch (e) {}
  persist();
  res.json({ ok: true });
});

// ========== 托管网页端静态资源 ==========
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

// 统一错误处理：JSON 解析失败等异常不再输出带服务器路径的 HTML 堆栈（信息泄露 + 体验差）
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }
  if (status >= 500) {
    try { console.error('[http] ' + req.method + ' ' + req.originalUrl + ': ' + (err && err.message || err)); } catch (_) {}
  }
  const code = status >= 400 && status < 600 ? status : 500;
  if (req.path && req.path.indexOf('/api/') === 0) {
    return res.status(code).json({ error: code === 400 ? '请求格式错误' : '服务器错误' });
  }
  res.status(code).type('text/plain').send(code === 400 ? 'Bad Request' : 'Server Error');
});

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
// @提及 解析：返回 { atAll, atUids(Set) }，供 WebSocket 与 REST 两条群消息发送路径共用
// 匹配字段：nickname / username / uid / 群内昵称 my_nickname（与 Flutter 端 @ 检测字段一致）
function computeGroupMentions(groupId, content) {
  let atAll = false;
  const atUids = new Set();
  try {
    if (typeof content !== 'string' || !content.includes('@')) return { atAll, atUids };
    if (/@所有人|@all\b/i.test(content)) atAll = true;
    const memberRows = prepare(
      `SELECT gm.user_id, u.nickname, u.username, u.uid, gms.my_nickname
       FROM group_members gm
       JOIN users u ON u.id=gm.user_id
       LEFT JOIN group_member_settings gms ON gms.group_id=gm.group_id AND gms.user_id=gm.user_id
       WHERE gm.group_id=?`).all(groupId);
    for (const r of memberRows) {
      const names = [r.nickname, r.username, r.uid, r.my_nickname]
        .filter(n => typeof n === 'string' && n.trim().length > 0)
        .map(n => n.trim());
      for (const n of names) {
        if (content.includes('@' + n)) { atUids.add(r.user_id); break; }
      }
    }
  } catch (e) {}
  return { atAll, atUids };
}
function removeWs(uid, ws) {
  const list = online.get(uid);
  if (!list) return;
  const i = list.indexOf(ws);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) online.delete(uid);
}

// 强制下线：先推 KICKED 再关闭连接。
// 原实现只 send 一个 'KICKED'（客户端只识别小写 kicked/device_kicked）且不关 socket，
// 被封禁/被踢用户在原连接上仍能继续发消息，封禁要等重连才生效。
function forceLogoutUser(uid, reason) {
  const list = online.get(uid) || [];
  for (const ws of list.slice()) {
    try { send(ws, P.S_KICKED, { reason: reason || '已被强制下线' }); } catch (e) {}
    try { ws.close(4001, 'kicked'); } catch (e) {}
    try { removeWs(uid, ws); } catch (e) {}
  }
  try { online.delete(uid); } catch (e) {}
}

wss.on('connection', (ws, req) => {
  ws.uid = null;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    // 自适应心跳：计算 RTT
    if (ws.uid && ws._pingSentAt) {
      const rtt = Date.now() - ws._pingSentAt;
      let bucket = rttBuckets.get(ws.uid);
      if (!bucket) { bucket = { samples: [], avgRtt: rtt }; rttBuckets.set(ws.uid, bucket); }
      bucket.samples.push(rtt);
      if (bucket.samples.length > 10) bucket.samples.shift();
      bucket.avgRtt = bucket.samples.reduce((a, b) => a + b, 0) / bucket.samples.length;
      updateHeartbeatInterval();
    }
  });
  // 记录 ping 发送时间（用于 RTT 计算）
  const origPing = ws.ping.bind(ws);
  ws.ping = function(...args) {
    ws._pingSentAt = Date.now();
    return origPing(...args);
  };
  // 未认证客户端10秒超时
  const authTimer = setTimeout(() => { if (!ws.uid) try { ws.close(4001, 'auth timeout'); } catch {} }, 10000);
  ws.on('close', () => { try { clearTimeout(authTimer); } catch {} });

  ws.on('message', (buf) => {
    let data;
    try {
      if (buf.length > MAX_MSG_CONTENT) { send(ws, P.S_ERROR || 'error', { error: '消息过大' }); return; }
      data = JSON.parse(buf.toString());
    } catch { return; }
    // JSON 合法但不是对象（如 "null"、数字、字符串）时，解构会抛 TypeError 逃出
    // ws.on('message')，只能靠全局 uncaughtException 兜底（刷日志/占 CPU）。
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const { type, payload } = data;

    try {
    if (type === P.C_AUTH) {
      const user = verifyToken(payload.token);
      if (!user) return send(ws, P.S_AUTH_FAIL, { error: '令牌无效' });
       const dbUser = prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if (!dbUser) return send(ws, P.S_AUTH_FAIL, { error: '用户不存在' });
      if (dbUser.banned) return send(ws, P.S_AUTH_FAIL, { error: '该账号已被封禁' + (dbUser.ban_reason ? '：' + dbUser.ban_reason : '') });
      // 重复认证必须先摘除旧身份：否则旧 uid 的 online 列表会残留本连接，
      // 导致 A 的消息被投递给已登录成 B 的连接（跨账号泄露），
      // 且 onlineAny(A) 恒为 true 使 A 的消息永不进入离线队列（永久丢失）。
      // IP 封禁校验必须在写入 ws.uid 之前：原实现先赋值 ws.uid 再校验，
      // 被封 IP 的客户端收到 auth_fail 后仍能以该 uid 继续发消息（封禁完全无效）。
      ws._ip = clientIp({ headers: {}, socket: ws._socket || ws._req || {} });
      try {
        const bip = ws._ip ? prepare('SELECT ip FROM banned_ips WHERE ip=?').get(ws._ip) : null;
        if (bip) {
          if (ws.uid) { try { removeWs(ws.uid, ws); } catch (e) {} }
          ws.uid = null; ws.user = null;
          send(ws, P.S_AUTH_FAIL, { error: '当前IP已被封禁' });
          try { ws.close(4003, 'ip banned'); } catch (e) {}
          return;
        }
      } catch (e) {}
      if (ws.uid && ws.uid !== dbUser.id) { try { removeWs(ws.uid, ws); } catch (e) {} }
      // 同一连接重复认证同一 uid：先把本连接从列表摘掉，否则下面 push 会让同一 ws 在
      // online 列表里出现多次，sendToUser 重复下发同一条消息（多端同步时表现为消息重复）。
      if (ws.uid === dbUser.id) { try { removeWs(ws.uid, ws); } catch (e) {} }
      ws.uid = dbUser.id;
      try { clearTimeout(authTimer); } catch {} // 认证成功，清除超时
      ws.user = publicUser(dbUser);
      // 设备注册（客户端传 deviceId 时自动注册）
      if (payload.deviceId) {
        const devName = String(payload.deviceName || '').slice(0, 64) || '桌面端';
        const devType = String(payload.deviceType || 'desktop').slice(0, 32);
        const plat = String(payload.platform || '').slice(0, 32);
        try {
          prepare(`INSERT INTO devices(user_id, device_id, device_name, device_type, platform, ip, last_active_at, created_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET device_name=excluded.device_name, device_type=excluded.device_type, platform=excluded.platform, ip=excluded.ip, last_active_at=excluded.last_active_at`)
            .run(dbUser.id, payload.deviceId, devName, devType, plat, ws._ip || '', Date.now(), Date.now());
        } catch (e) {}
        ws.deviceId = payload.deviceId;
      }
      // 多端登录：同一 uid 允许多个 WS 连接（Map 存数组）
      const list = online.get(dbUser.id) || [];
      list.push(ws);
      online.set(dbUser.id, list);
      if (online.size > peakConcurrentUsers) peakConcurrentUsers = online.size;
      const syncState = getSyncState(dbUser.id);
      // 若客户端带了 deviceId，签发绑定设备的 token（被移除的设备 token 立即失效，不影响其他设备）
      const deviceToken = ws.deviceId ? signToken(dbUser, ws.deviceId) : null;
      send(ws, P.S_AUTH_OK, { user: ws.user, syncState: { lastMsgSeq: syncState.last_msg_seq, lastGroupSeq: syncState.last_group_seq }, deviceToken });
      broadcastUserList();
      pushFriendList(dbUser.id);
      broadcastGroups();
      // 推送待处理好友请求数（供 UI 提示）
      const reqs = prepare(
         `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.email,u.country,u.province,u.city,u.extra,u.pubkey,u.last_seen
         FROM friends f JOIN users u ON u.id = f.user_id
         WHERE f.friend_id=? AND f.status=0 ORDER BY f.created_at DESC`
      ).all(dbUser.id);
      for (const r of reqs) send(ws, P.S_FRIEND_REQ, { from: r.id, fromUser: publicUserBrief(r) });
      // 推送离线未读消息（断线期间积累的消息，带 seq 供增量去重）
      // 原实现每次重连都把「全部未读」重推一遍（最多 500 条），且与 offline_queue 双通道重复投递；
      // 现按客户端上报的 lastMsgSeq 只补新消息，并在投递后清掉对应离线队列行，避免重复与队列无限膨胀。
      try {
        const reported = Number((payload || {}).lastMsgSeq);
        const sinceSeq = Number.isInteger(reported) && reported > 0 ? reported : 0;
        const offlineMsgs = sinceSeq > 0
          ? prepare('SELECT * FROM messages WHERE to_id=? AND read=0 AND seq>? AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) ORDER BY seq ASC LIMIT 500').all(dbUser.id, sinceSeq, dbUser.id)
          : prepare('SELECT * FROM messages WHERE to_id=? AND read=0 AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?) ORDER BY seq ASC LIMIT 500').all(dbUser.id, dbUser.id);
        let maxPushed = 0;
        for (const m of offlineMsgs) {
          send(ws, P.S_MSG, { id: m.id, from: m.from_id, to: m.to_id, content: m.recalled ? '' : m.content, createdAt: m.created_at, read: false, replyTo: m.reply_to || null, clientMsgId: m.client_msg_id || null, forwardedFrom: m.forwarded_from || null, burnAfterReading: !!m.burn_after_reading, recalled: !!m.recalled, seq: m.seq || null });
          if (Number(m.seq) > maxPushed) maxPushed = Number(m.seq);
        }
        if (maxPushed > 0) {
          try { prepare('DELETE FROM offline_queue WHERE user_id=? AND seq<=?').run(dbUser.id, maxPushed); } catch (e) {}
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
      // content 必须是字符串：数组/对象会被 sql.js 当 BLOB 入库（历史接口回给客户端变成
      // {"0":1,...}），数字/布尔则破坏协议类型，且非字符串绕过了长度语义。
      if (typeof content !== 'string') return send(ws, P.S_ERROR, { error: '消息内容无效' });
      if (content.length > MAX_MSG_CONTENT) return send(ws, P.S_ERROR, { error: '消息内容过大（最大100KB）' });
      // 敏感词过滤：E2EE 已停用，WS 与 REST 均为明文，主链路此前完全缺失
      const _swWs = checkSensitive(content);
      if (_swWs) return send(ws, P.S_ERROR, { error: '消息包含违规词：' + _swWs });
      // 发送限流：登录/注册/加好友都有限流，唯独核心消息路径没有，
      // 单连接可每秒数百帧刷屏并把 sql.js 全库落盘打满。
      if (rateLimit('wsmsg:' + ws.uid, 60, 10 * 1000)) return send(ws, P.S_ERROR, { error: '发送过于频繁，请稍后再试' });
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
      // 越权防护:replyTo/forwardedFrom 必须属于当前会话
      const dmR = Number(replyTo) || null;
      const dmF = Number(forwardedFrom) || null;
      // 必须是与「本收件人」的同一会话，否则可跨私聊把他人消息正文带进来
      const dmOwns = (mid) => !!prepare('SELECT 1 FROM messages WHERE id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
        .get(mid, ws.uid, toId, toId, ws.uid);
      if (dmR && !dmOwns(dmR)) return send(ws, P.S_ERROR, { error: '引用的消息无权访问' });
      if (dmF && !dmOwns(dmF)) return send(ws, P.S_ERROR, { error: '转发的消息无权访问' });
      const wsMsgSeq = nextSeq();
      const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at,seq) VALUES(?,?,?,?,?,?)')
        .run(ws.uid, toId, content, clientMsgId || null, createdAt, wsMsgSeq);
      if (metaFlag) {
        prepare('INSERT INTO message_meta(message_id,reply_to,forwarded_from,burn_after_reading,updated_at) VALUES(?,?,?,?,?)')
          .run(info.lastInsertRowid, dmR, dmF, burnAfterReading ? 1 : 0, createdAt);
      }
      const msgObj = { id: info.lastInsertRowid, from: ws.uid, to: toId, content, createdAt, clientMsgId: clientMsgId || null, replyTo: dmR, forwardedFrom: dmF, burnAfterReading: !!burnAfterReading, read: 0, seq: wsMsgSeq };
      console.log('[msg] ws.uid=' + ws.uid + ' -> to=' + toId + ' len=' + String(content).length + ' id=' + info.lastInsertRowid);
      let replyContent = null, replyFrom = null, replyRecalled = false;
      if (msgObj.replyTo) {
        try {
          const pm = prepare('SELECT content,from_id,recalled FROM messages WHERE id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
            .get(msgObj.replyTo, ws.uid, toId, toId, ws.uid);
          // 撤回消息不得通过引用块回显原文
          if (pm) { replyContent = pm.recalled ? null : pm.content; replyFrom = pm.from_id; replyRecalled = !!pm.recalled; }
        } catch (e) {}
      }
      msgObj.replyContent = replyContent; msgObj.replyFrom = replyFrom; msgObj.replyRecalled = replyRecalled;
      send(ws, P.S_MSG, msgObj);
      // 同一账号的其他在线端也要实时看到自己发出的消息（原先只回显当前连接，
      // 多端登录时另一台设备只能靠 /api/sync 补拉）
      for (const other of (online.get(ws.uid) || [])) {
        if (other !== ws) { try { send(other, P.S_MSG, msgObj); } catch (e) {} }
      }
      const peer = onlineAny(toId);
      if (peer) sendToUser(toId, P.S_MSG, msgObj);
      // 离线队列：对方不在线时入队
      if (!peer) {
        try { prepare('INSERT INTO offline_queue(user_id, from_id, msg_type, ref_id, content, seq, created_at) VALUES(?,?,?,?,?,?,?)').run(toId, ws.uid, 'direct', info.lastInsertRowid, content, wsMsgSeq, createdAt); } catch (e) {}
      }
      // 实时计数：发1 收1（对方在线则记一次接收）
      sentMsgsThisMinCounter += 1;
      if (peer) recvMsgsThisMinCounter += 1;
      return;
    }

    if (type === P.C_READ) {
      if (!ws.uid) return;
      const from = Number((payload || {}).from);
      const readRes = prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=?').run(from, ws.uid);
      // 只有确实更新到消息时才广播。原实现不检查影响行数，
      // 任意用户可对从未会话的在线用户伪造「对方已读」回执（并向 uid 0 发包）。
      if (Number.isInteger(from) && from > 0 && onlineAny(from) && readRes && readRes.changes > 0) {
        sendToUser(from, P.S_MSG_READ, { peerId: ws.uid });
      }
      return;
    }

    // 群消息：C_GROUP_MSG { groupId, content }
    if (type === P.C_GROUP_MSG) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { groupId, content, clientMsgId, replyTo, forwardedFrom } = payload || {};
      const gid = Number(groupId);
      if (!Number.isInteger(gid) || !content) return send(ws, P.S_ERROR, { error: '消息内容无效' });
      if (typeof content !== 'string') return send(ws, P.S_ERROR, { error: '消息内容无效' });
      if (content.length > MAX_MSG_CONTENT) return send(ws, P.S_ERROR, { error: '消息内容过大（最大100KB）' });
      // 敏感词过滤：与 REST 群消息通道保持一致
      const _swG = checkSensitive(content);
      if (_swG) return send(ws, P.S_ERROR, { error: '消息包含违规词：' + _swG });
      if (clientMsgId !== undefined && (typeof clientMsgId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(clientMsgId))) {
        return send(ws, P.S_ERROR, { error: '消息标识无效' });
      }
      const isMember = prepare('SELECT id FROM group_members WHERE group_id=? AND user_id=?').get(gid, ws.uid);
      if (!isMember) return send(ws, P.S_ERROR, { error: '你不在此群' });
      // 群消息限流：REST 群消息入口有限流，WS 通道此前缺失，单连接可刷屏并拖垮全群扇出
      if (rateLimit('wsmsg:' + ws.uid, 60, 10 * 1000)) return send(ws, P.S_ERROR, { error: '发送过于频繁，请稍后再试' });
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
      const grpMsgSeq = nextSeq();
      const info = prepare('INSERT INTO group_messages(group_id,from_id,content,client_msg_id,created_at,seq) VALUES(?,?,?,?,?,?)')
        .run(gid, ws.uid, enc, clientMsgId || null, now, grpMsgSeq);
      // 越权防护:replyTo/forwardedFrom 必须是本群消息,防 id 枚举跨群泄露正文
      // （必须用 let：下面要把无效 id 置 null，const 会在运行时抛 TypeError 导致整条消息丢失）
      let replyToId = Number(replyTo) || null;
      let forwardedFromId = Number(forwardedFrom) || null;
      if (replyToId && !prepare('SELECT 1 FROM group_messages WHERE id=? AND group_id=?').get(replyToId, gid)) replyToId = null;
      if (forwardedFromId && !prepare('SELECT 1 FROM group_messages WHERE id=? AND group_id=?').get(forwardedFromId, gid)) forwardedFromId = null;
      let replyContent = null, replyFrom = null;
      if (replyToId) {
        try {
          prepare('INSERT INTO group_message_meta(message_id,reply_to,forwarded_from,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=COALESCE(excluded.reply_to,group_message_meta.reply_to),forwarded_from=COALESCE(excluded.forwarded_from,group_message_meta.forwarded_from),updated_at=excluded.updated_at')
            .run(info.lastInsertRowid, replyToId, forwardedFromId || null, now);
          const pm = prepare('SELECT CASE WHEN recalled=1 THEN NULL ELSE content END AS content, from_id, recalled FROM group_messages WHERE id=? AND group_id=?').get(replyToId, gid);
          if (pm) { replyContent = pm.recalled ? null : pm.content; replyFrom = pm.from_id; }
        } catch (e) {}
      } else if (forwardedFromId) {
        try {
          prepare('INSERT INTO group_message_meta(message_id,reply_to,forwarded_from,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=COALESCE(excluded.reply_to,group_message_meta.reply_to),forwarded_from=COALESCE(excluded.forwarded_from,group_message_meta.forwarded_from),updated_at=excluded.updated_at')
            .run(info.lastInsertRowid, null, forwardedFromId, now);
        } catch (e) {}
      }
      const msgObj = { id: info.lastInsertRowid, groupId: gid, from: ws.uid, fromUid: ws.user.uid, content, createdAt: now, clientMsgId: clientMsgId || null, replyTo: replyToId, replyContent, replyFrom, forwardedFrom: forwardedFromId || null, read: true, readCount: 1, seq: grpMsgSeq };
      // @提及 解析：找出被 @ 的成员（@昵称 或 @所有人），这些成员收到消息时标记 mentionMe
      const { atAll, atUids } = computeGroupMentions(gid, content);
      // 给群里所有在线成员（包括自己）都推送，附带 fromUser 便于客户端显示昵称
      const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gid);
      const fromUser = ws.user;
      for (const m of members) {
        if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { ...msgObj, fromUser, mentionMe: (atAll || atUids.has(m.user_id)) ? true : false });
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
      const { to, groupId } = payload || {};
      if (groupId) {
        // 群聊输入：广播给所有群成员（排除自己）
        const gid = Number(groupId);
        if (Number.isInteger(gid)) {
          try {
            // 必须校验发送者是群成员：否则任意用户可枚举群 id 向任意群注入"正在输入"
            if (!prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid, ws.uid)) return;
            const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gid);
            for (const m of members) {
              if (m.user_id !== ws.uid && onlineAny(m.user_id)) sendToUser(m.user_id, P.S_TYPING, { from: ws.uid, groupId: gid });
            }
          } catch (e) {}
        }
        return;
      }
      const toId = Number(to);
      // 拉黑关系下不再推送"正在输入"
      if (Number.isInteger(toId) && toId > 0 && !prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(ws.uid, toId, toId, ws.uid) && onlineAny(toId)) {
        sendToUser(toId, P.S_TYPING, { from: ws.uid });
      }
      return;
    }

    // ========== 客户端 pong 回复（自适应心跳 RTT 测量） ==========
    if (type === 'pong' && payload && payload.clientTs) {
      if (!ws.uid) return;
      const rtt = Date.now() - Number(payload.clientTs);
      let bucket = rttBuckets.get(ws.uid);
      if (!bucket) { bucket = { samples: [], avgRtt: rtt }; rttBuckets.set(ws.uid, bucket); }
      bucket.samples.push(rtt);
      if (bucket.samples.length > 10) bucket.samples.shift();
      bucket.avgRtt = bucket.samples.reduce((a, b) => a + b, 0) / bucket.samples.length;
      updateHeartbeatInterval();
      // 回复服务端建议的心跳间隔
      send(ws, 'pong', { serverTs: Date.now(), suggestedInterval: wsPingInterval, rtt: Math.round(bucket.avgRtt) });
      return;
    }

    // ========== 增量同步（WS通道） ==========
    if (type === P.C_SYNC) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const since = Number((payload || {}).since) || 0;
      const limit = Math.min(Math.max(Number((payload || {}).limit) || 200, 1), 500);
      // 私聊消息
      const directMsgs = prepare(
        `SELECT m.id, m.from_id AS "from", m.to_id AS "to",
                CASE WHEN m.recalled=1 THEN '' ELSE m.content END AS content,
                m.recalled, m.created_at AS createdAt, m.seq, m.client_msg_id AS clientMsgId, m.read
         FROM messages m WHERE m.seq > ? AND (m.from_id = ? OR m.to_id = ?)
           AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=m.id)
         ORDER BY m.seq ASC LIMIT ?`
      ).all(since, ws.uid, ws.uid, ws.uid, limit);
      // 群聊消息
      const groupMsgs = prepare(
        `SELECT gm.id, gm.group_id AS groupId, gm.from_id AS "from",
                CASE WHEN gm.recalled=1 THEN '' ELSE gm.content END AS content,
                gm.recalled, gm.created_at AS createdAt, gm.seq, gm.client_msg_id AS clientMsgId
         FROM group_messages gm JOIN group_members gmemb ON gmemb.group_id = gm.group_id AND gmemb.user_id = ?
         WHERE gm.seq > ? AND gm.created_at >= gmemb.joined_at ORDER BY gm.seq ASC LIMIT ?`
      ).all(ws.uid, since, limit);
      const all = [...directMsgs.map(m => ({ ...m, msgType: 'direct' })), ...groupMsgs.map(m => ({ ...m, msgType: 'group' }))];
      all.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const sliced = all.slice(0, limit);
      const maxSeq = sliced.length ? Math.max(...sliced.map(m => m.seq || 0)) : since;
      const maxDirect = sliced.filter(m => m.msgType === 'direct').reduce((mx, m) => Math.max(mx, m.seq || 0), since);
      const maxGroup = sliced.filter(m => m.msgType === 'group').reduce((mx, m) => Math.max(mx, m.seq || 0), since);
      updateSyncState(ws.uid, maxDirect, maxGroup);
      send(ws, P.S_SYNC, { messages: sliced, lastSeq: maxSeq, hasMore: all.length > limit || directMsgs.length >= limit || groupMsgs.length >= limit });
      return;
    }

    // 信令转发：用于 WebRTC（音视频/文件 DataChannel）的 offer/answer/ICE/挂断等
    if (type === P.C_SIGNAL) {
      if (!ws.uid) return send(ws, P.S_ERROR, { error: '未登录' });
      const { to, sub, data } = payload || {};
      const toId = Number(to);
      if (!Number.isInteger(toId) || toId <= 0 || !sub) return;
      if (toId === ws.uid) return;
      // 信令必须限定在好友之间且 sub 在白名单内，否则任意用户可对任意在线用户伪造
      // offer/answer/hangup（强制弹呼叫、挂断他人通话、向攻击者推流音视频）
      if (!ALLOWED_SIGNAL_SUBS.has(String(sub))) return;
      // 信令独立限流：避免共同好友高频刷 call/ring 造成持续响铃骚扰
      if (rateLimit('wsig:' + ws.uid, 120, 60 * 1000)) return;
      // 必须是已通过的好友（status=1）且双向未拉黑：原实现不判 status，
      // 发一条好友请求就能对陌生人弹呼叫框/伪造 hangup，与 REST 通道不一致。
      if (!prepare('SELECT 1 FROM friends WHERE status=1 AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))').get(ws.uid, toId, toId, ws.uid)) return;
      if (prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(ws.uid, toId, toId, ws.uid)) return;
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
      // 清理自适应心跳 RTT 数据
      if (!onlineHas(ws.uid)) rttBuckets.delete(ws.uid);
      broadcastUserList();
      broadcastGroups();
    }
  });
});

// WebSocket 心跳：自适应间隔，基础 30 秒
const WS_PING_BASE_INTERVAL = 30000;
let wsPingInterval = WS_PING_BASE_INTERVAL;
const wsPingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, wsPingInterval);
// 自适应心跳：客户端上报 RTT，服务端动态调整 ping 间隔
// 网络好时缩短到 15s，网络差时延长到 60s
const rttBuckets = new Map(); // uid -> { samples: [], avgRtt: number }
// WebRTC 信令子类型白名单：sub 由客户端自由传入，必须限制取值，
// 否则可构造畸形 data 或伪造 hangup 强制断开他人通话。
// 必须与客户端 rtc_service.dart 实际发送的 sub 对齐：漏掉 call/call_ack 会让
// 主叫的呼叫请求被服务端静默丢弃，被叫永远不响铃（通话功能整条链路失效）。
const ALLOWED_SIGNAL_SUBS = new Set(['call', 'call_ack', 'call_reject', 'ring', 'offer', 'answer', 'candidate', 'ice', 'hangup', 'offer_file', 'answer_file', 'datachannel']);

function updateHeartbeatInterval() {
  if (rttBuckets.size === 0) { wsPingInterval = WS_PING_BASE_INTERVAL; return; }
  let totalRtt = 0, count = 0;
  for (const [, v] of rttBuckets) { totalRtt += v.avgRtt; count++; }
  const avgRtt = count ? totalRtt / count : 0;
  if (avgRtt < 200) wsPingInterval = 15000;       // 网络很好
  else if (avgRtt < 1000) wsPingInterval = 30000;  // 正常
  else wsPingInterval = 60000;                      // 弱网，减少心跳频率
  clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, wsPingInterval);
}

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
  try { require('./routes/groups').setSensitiveCheck((t) => checkSensitive(t)); } catch (e) {}
  try {
    require('./routes/groups').attachGroupBroadcast((groupId, msg) => {
      try {
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
        const fromUser = prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(msg.from) || { nickname: '用户' + msg.from };
        const { atAll, atUids } = computeGroupMentions(groupId, msg.content);
        for (const m of members) {
          if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { ...msg, fromUser, mentionMe: (atAll || atUids.has(m.user_id)) ? true : false });
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
  rx('./routes/media', [app, db, apiUser, { checkSensitive: (t) => checkSensitive(t) }]);
  rx('./routes/lifestyle', [app, db, apiUser]);
  // 到账语音通知注入：payment.js 的 doPay 到账后回调 → 推送到账事件给收款方所有在线连接
  try {
    app.set('arrivalNotifier', (toId, info) => {
      try {
        if (toId == null) return;
        sendToUser(toId, 'payment_arrival', {
          amount: info && info.amount,
          fromId: info && info.fromId,
          fromName: info && info.fromName,
          remark: info && info.remark,
          category: info && info.category,
          ts: Date.now()
        });
      } catch (e) {}
    });
  } catch (e) {}
  rx('./routes/payment', [app, db, null]);
  rx('./epaygw', [app, db, null]);
  rx('./routes/status-collar', [app, db, apiUser, { checkSensitive: (t) => checkSensitive(t) }]);
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
  try { rawDb.run('CREATE TABLE IF NOT EXISTS message_reactions(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(message_id, user_id, emoji))'); } catch (e) { console.error('[db] message_reactions 建表失败: ' + (e && e.message || e)); }
  try { rawDb.run('ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0'); } catch (e) { /* 已存在则忽略 */ }
  try { rawDb.run('ALTER TABLE group_message_meta ADD COLUMN forwarded_from INTEGER'); } catch (e) { /* 已存在则忽略 */ }
  const routeDb = {
    prepare, run: (...a) => rawDb.run(...a), exec: (...a) => rawDb.exec(...a),
    persist, persistNow, getDb, genUid, nextSeq
  };
  mountFeatureRoutes(app, routeDb);

  // ========== 表情回应 API ==========
  // 归属校验：只能对与自己相关的消息（私聊收发双方，或所在群成员）添加/查询回应
  function reactionMsgAuth(msgId, userId) {
    const dm = prepare('SELECT 1 FROM messages WHERE id=? AND (from_id=? OR to_id=?)').get(msgId, userId, userId);
    if (dm) return true;
    const gm = prepare('SELECT 1 FROM group_messages gm JOIN group_members m ON m.group_id=gm.group_id AND m.user_id=? WHERE gm.id=?').get(userId, msgId);
    return !!gm;
  }

  app.post('/api/messages/:id/reactions', (req, res) => {
    if (!ready) return res.status(503).json({ error: '服务初始化中' });
    const user = apiUser(req);
    if (!user) return res.status(401).json({ error: '未登录' });
    const msgId = Number(req.params.id);
    const emoji = String((req.body || {}).emoji || '').slice(0, 10);
    if (!msgId || !emoji) return res.status(400).json({ error: '参数无效' });
    try {
      const msg = prepare('SELECT id FROM messages WHERE id=?').get(msgId);
      if (!msg) return res.status(404).json({ error: '消息不存在' });
      if (!reactionMsgAuth(msgId, user.id)) return res.status(403).json({ error: '无权操作该消息' });
      // toggle: 已存在则删除，不存在则添加
      const existing = prepare('SELECT id FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?').get(msgId, user.id, emoji);
      if (existing) {
        prepare('DELETE FROM message_reactions WHERE id=?').run(existing.id);
      } else {
        prepare('INSERT INTO message_reactions(message_id, user_id, emoji, created_at) VALUES(?,?,?,?)').run(msgId, user.id, emoji, Date.now());
      }
      // 返回当前消息所有回应
      const reactions = prepare('SELECT user_id, emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id=? GROUP BY emoji').all(msgId);
      res.json({ ok: true, reactions });
    } catch (e) { res.status(500).json({ error: '回应失败' }); }
  });

  app.get('/api/messages/:id/reactions', (req, res) => {
    if (!ready) return res.status(503).json({ error: '服务初始化中' });
    const user = apiUser(req);
    if (!user) return res.status(401).json({ error: '未登录' });
    const msgId = Number(req.params.id);
    if (!msgId) return res.status(400).json({ error: '参数无效' });
    try {
      if (!reactionMsgAuth(msgId, user.id)) return res.status(403).json({ error: '无权查看该消息' });
      const reactions = prepare('SELECT user_id, emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id=? GROUP BY emoji').all(msgId);
      res.json({ ok: true, reactions });
    } catch (e) { res.status(500).json({ error: '查询失败' }); }
  });

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
// 全局异常兜底：防止未捕获异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && err.message || err);
  // 端口占用等致命错误必须让进程退出：否则会残留"占着端口却不服务"的僵尸进程，
  // 导致 watchdog 持续判定 offline 并反复杀/拉，形成重启死循环。
  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL')) {
    try { persistNow(); } catch (_) {}
    console.error('[fatal] 致命端口错误，进程退出，交由 watchdog 重新拉起');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => { console.error('[fatal] unhandledRejection:', reason && reason.message || reason); });
