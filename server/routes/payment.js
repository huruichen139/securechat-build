'use strict';
// module: pay (worker batch6)
// 支付与生活：收付款码、群收款+接龙、生活缴费/手机充值(演示)、钱包账单。
// 复用巨石钱包基础（wallets/wallet_txn/redeem_codes 已在 server/db.js 建表；
// /api/wallet /api/wallet/redeem /api/wallet/transfer /api/wallet/txn 已在 server/index.js 提供，本模块不重写）。
// 本模块仅新增 /api/pay/* 端点，自建 pay_bills/pay_codes/group_collects/collect_payments/
// group_solections/solection_entries/life_payments 表（IF NOT EXISTS，幂等）。
// 导出：module.exports = function registerPayment(app, db, auth)
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

function epaySign(params, key) {
  const body = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('md5').update(body + key).digest('hex');
}

function epayConfig(prepare) {
  try {
    const row = prepare('SELECT value FROM settings WHERE key=?').get('epay_config');
    const c = row ? JSON.parse(row.value) : {};
    return {
      enabled: !!c.enabled,
      sandbox: !!c.sandbox,
      baseUrl: String(c.baseUrl || '').replace(/\/$/, ''),
      gatewayUrl: String(c.gatewayUrl || '').trim(),
      gatewayId: String(c.gatewayId || '').trim(),
      merchantPid: String(c.merchantPid || '').trim(),
      key: String(c.key || '').trim(),
      notifyUrl: String(c.notifyUrl || '').trim(),
      returnUrl: String(c.returnUrl || '').trim()
    };
  } catch (e) { return { enabled: false, sandbox: false, baseUrl: '', gatewayUrl: '', gatewayId: '', merchantPid: '', key: '', notifyUrl: '', returnUrl: '' }; }
}

module.exports = function registerPayment(app, db, auth) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('[payment] 需要 db.prepare（require("../db")）');
  }
  const prepare = db.prepare;
  const persist = (typeof db.persist === 'function') ? db.persist.bind(db) : (() => {});

  // ============ 建表（IF NOT EXISTS）============
  function ensureTables() {
    prepare("CREATE TABLE IF NOT EXISTS pay_bills (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " user_id INTEGER NOT NULL,\n" +
      " kind TEXT NOT NULL,\n" +
      " category TEXT NOT NULL,\n" +
      " amount FLOAT NOT NULL,\n" +
      " peer_id INTEGER,\n" +
      " title TEXT,\n" +
      " ref_type TEXT,\n" +
      " ref_id INTEGER,\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_pay_bills_user ON pay_bills(user_id, created_at)").run();

    prepare("CREATE TABLE IF NOT EXISTS pay_codes (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " owner_id INTEGER NOT NULL,\n" +
      " type TEXT NOT NULL,\n" +
      " token TEXT NOT NULL UNIQUE,\n" +
      " amount FLOAT,\n" +
      " remark TEXT,\n" +
      " status TEXT NOT NULL DEFAULT 'active',\n" +
      " expires_at INTEGER,\n" +
      " created_at INTEGER NOT NULL\n)").run();

    prepare("CREATE TABLE IF NOT EXISTS group_collects (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " group_id INTEGER NOT NULL,\n" +
      " creator_id INTEGER NOT NULL,\n" +
      " title TEXT NOT NULL,\n" +
      " amount FLOAT NOT NULL,\n" +
      " status TEXT NOT NULL DEFAULT 'open',\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE TABLE IF NOT EXISTS collect_payments (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " collect_id INTEGER NOT NULL,\n" +
      " user_id INTEGER NOT NULL,\n" +
      " amount FLOAT NOT NULL,\n" +
      " remark TEXT,\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_collect_pay_collect ON collect_payments(collect_id)").run();
    try { prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_collect_pay_once ON collect_payments(collect_id,user_id)").run(); } catch (e) {}

    prepare("CREATE TABLE IF NOT EXISTS group_solections (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " group_id INTEGER NOT NULL,\n" +
      " creator_id INTEGER NOT NULL,\n" +
      " subject TEXT NOT NULL,\n" +
      " status TEXT NOT NULL DEFAULT 'open',\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE TABLE IF NOT EXISTS solection_entries (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " solection_id INTEGER NOT NULL,\n" +
      " user_id INTEGER NOT NULL,\n" +
      " remark TEXT,\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_solection_entry_sol ON solection_entries(solection_id)").run();

    prepare("CREATE TABLE IF NOT EXISTS life_payments (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " user_id INTEGER NOT NULL,\n" +
      " category TEXT NOT NULL,\n" +
      " provider TEXT NOT NULL,\n" +
      " account TEXT NOT NULL,\n" +
      " amount FLOAT NOT NULL,\n" +
      " status TEXT NOT NULL DEFAULT 'paid',\n" +
      " created_at INTEGER NOT NULL\n)").run();

    // 网关商户、支付订单和用户明确授权记录。
    prepare("CREATE TABLE IF NOT EXISTS pay_merchants (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " user_id INTEGER NOT NULL, name TEXT NOT NULL, callback_url TEXT, auth_mode TEXT NOT NULL DEFAULT 'local',\n" +
      " status TEXT NOT NULL DEFAULT 'pending', reason TEXT, created_at INTEGER NOT NULL, reviewed_at INTEGER\n" +
      ")").run();
    prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_merchant_user ON pay_merchants(user_id)").run();
    prepare("CREATE TABLE IF NOT EXISTS pay_orders (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, merchant_id INTEGER NOT NULL, payer_id INTEGER,\n" +
      " amount FLOAT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', callback_url TEXT,\n" +
      " created_at INTEGER NOT NULL, paid_at INTEGER, expires_at INTEGER\n" +
      ")").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_pay_orders_merchant ON pay_orders(merchant_id, created_at)").run();
    prepare("CREATE TABLE IF NOT EXISTS pay_authorizations (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, merchant_id INTEGER NOT NULL,\n" +
      " mode TEXT NOT NULL, max_amount FLOAT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, expires_at INTEGER\n" +
      ")").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_pay_auth_user_merchant ON pay_authorizations(user_id, merchant_id, status)").run();
  }
  ensureTables();
  // 迁移：收款码次数限制列
  try { prepare("ALTER TABLE pay_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT -1").run(); } catch (e) {}
  try { prepare("ALTER TABLE pay_codes ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0").run(); } catch (e) {}
  // 迁移：pay_merchants 增加每商户独立 API 密钥列
  try { prepare("ALTER TABLE pay_merchants ADD COLUMN api_key TEXT").run(); } catch (e) {}
  try {
    const rows = prepare('SELECT id FROM pay_merchants WHERE api_key IS NULL OR api_key=""').all();
    for (const r of rows) {
      prepare('UPDATE pay_merchants SET api_key=? WHERE id=?').run('sk_' + crypto.randomBytes(16).toString('hex'), r.id);
    }
    if (rows.length) persist();
  } catch (e) {}

  function saveEpayConfig(c) {
    const value = JSON.stringify({
      enabled: !!c.enabled,
      sandbox: !!c.sandbox,
      baseUrl: String(c.baseUrl || '').trim(),
      gatewayUrl: String(c.gatewayUrl || '').trim(),
      gatewayId: String(c.gatewayId || '').trim(),
      merchantPid: String(c.merchantPid || '').trim(),
      key: String(c.key || '').trim(),
      notifyUrl: String(c.notifyUrl || '').trim(),
      returnUrl: String(c.returnUrl || '').trim()
    });
    prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run('epay_config', value, Date.now());
    persist();
  }

  // ============ 工具 ============
  function mw(req, res, next) {
    if (auth && typeof auth === 'function') return auth(req, res, next);
    let payload = null;
    try { payload = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), JWT_SECRET); } catch (e) { payload = null; }
    if (!payload) return res.status(401).json({ error: '未授权' });
    req.user = payload;
    next();
  }

  // 管理端点鉴权：优先外部 auth 中间件，否则回退内置 JWT 校验 + 管理员检查
  function adminMw(req, res, next) {
    if (auth && typeof auth === 'function') return auth(req, res, next);
    let payload = null;
    try { payload = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), JWT_SECRET); } catch (e) { payload = null; }
    if (!payload) return res.status(401).json({ error: '未授权' });
    req.user = payload;
    const u = prepare('SELECT id,email FROM users WHERE id=?').get(payload.id);
    const admins = String(process.env.ADMIN_EMAILS || '3529403074@qq.com').toLowerCase().split(',');
    if (!u || !admins.includes(String(u.email || '').toLowerCase())) return res.status(403).json({ error: '需要管理员权限' });
    next();
  }

  function getUserRow(id) { return prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(id); }

  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function ensureWallet(userId) {
    const w = prepare('SELECT balance,updated_at FROM wallets WHERE user_id=?').get(userId);
    if (!w) { prepare('INSERT INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(userId, Date.now()); return { balance: 0 }; }
    return w;
  }

  function balanceOf(userId) { return ensureWallet(userId).balance || 0; }

  // 记账到巨石钱包：冲正钱包余额并写 wallet_txn（与 index.js 转账同风格）
  function writeCharge(userId, kind, amount, peerId, remark) {
    if (kind === 'in') {
      prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(userId, Date.now());
      prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(amount, amount, Date.now(), userId);
    } else {
      prepare('UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=?').run(amount, Date.now(), userId);
    }
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, kind, amount, peerId || null, remark || '转账', Date.now());
  }

  function addBill(userId, kind, category, amount, peerId, title, refType, refId) {
    prepare('INSERT INTO pay_bills(user_id,kind,category,amount,peer_id,title,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(userId, kind, category, amount, peerId || null, title || null, refType || null, refId || Date.now(), Date.now());
  }

  function groupExists(gid) { return !!prepare('SELECT id FROM groups WHERE id=?').get(gid); }
  function memberOf(gid, uid) { return !!prepare('SELECT 1 AS one FROM group_members WHERE group_id=? AND user_id=?').get(gid, uid); }
  function groupMembers(gid) {
    return prepare('SELECT user_id AS userId FROM group_members WHERE group_id=?').all(gid);
  }
  function groupName(gid) { const g = prepare('SELECT name FROM groups WHERE id=?').get(gid); return g ? g.name : ('群' + gid); }

  function codePayload(c) { return 'securechat://pay?type=' + c.type + '&token=' + encodeURIComponent(c.token); }
  function codePublic(c) {
    return {
      id: c.id, type: c.type, token: c.token, amount: c.amount, remark: c.remark,
      status: c.status, expiresAt: c.expires_at, createdAt: c.created_at,
      maxUses: c.max_uses === undefined ? -1 : c.max_uses,
      usedCount: c.used_count || 0,
      owner: publicUser(getUserRow(c.owner_id))
    };
  }
  function publicUser(u) {
    if (!u) return null;
    let extra = {};
    try { extra = JSON.parse(u.extra || '{}') || {}; } catch (e) { extra = {}; }
    return { id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar, uid: u.uid, email: u.email || '', extra: extra };
  }

  // 统一扣款+入账（冲钱包，写流水与账单），err 通过 cb({code,message}) callback 返回
  function doPay(fromId, toId, amount, remark, category, refId, cb, allowSelf) {
    if (!Number.isFinite(amount) || amount <= 0) return cb({ code: 400, message: '金额无效' });
    amount = Math.round(amount * 100) / 100;
    if (amount > 1000000) return cb({ code: 400, message: '金额超限' });
    if (fromId === toId && !allowSelf) return cb({ code: 400, message: '不能转给自己' });
    ensureWallet(fromId);
    ensureWallet(toId);
    const deb = prepare('UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=? AND balance>=?').run(amount, Date.now(), fromId, amount);
    if (!deb.changes) return cb({ code: 400, message: '余额不足' });
    try {
      prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)')
        .run(fromId, 'out', amount, toId || null, remark || '转账', Date.now());
      writeCharge(toId, 'in', amount, fromId, remark);
      addBill(fromId, 'out', category, amount, toId, remark + '（转出）', category, refId || null);
      addBill(toId, 'in', category, amount, fromId, remark + '（收入）', category, refId || null);
      try { persist(); } catch (e) {}
      cb(null, { ok: true, balance: balanceOf(fromId) });
    } catch (e) {
      prepare('UPDATE wallets SET balance=balance+?,updated_at=? WHERE user_id=?').run(amount, Date.now(), fromId);
      try { persist(); } catch (_) {}
      cb({ code: 500, message: '支付失败已回滚' });
    }
  }

  // ============ 收付款码 ============
  // 生成收款码：POST /api/pay/code/receive { amount?, remark? }
  app.post('/api/pay/code/receive', mw, (req, res) => {
    const ownerId = req.user.id;
    const amountStr = (req.body && req.body.amount);
    let amount = null;
    if (amountStr !== undefined && amountStr !== null && amountStr !== '') {
      amount = parseFloat(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额无效' });
    }
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 100) || '';
    // 次数限制：-1 无上限（默认）；正整数 N = 可被扫N次；其余值非法
    let maxUses = -1;
    const muRaw = (req.body && req.body.maxUses);
    if (muRaw !== undefined && muRaw !== null && muRaw !== '') {
      const muNum = Number(muRaw);
      if (!(muNum === -1 || (Number.isInteger(muNum) && muNum >= 1))) return res.status(400).json({ error: '次数参数无效（-1为无上限，正整数为限定次数）' });
      maxUses = muNum;
    }
    const token = crypto.randomBytes(16).toString('base64url');
    // 长期收款码：10年有效期，靠 status/used_count 控制失效
    const expiresAt = Date.now() + 3650 * 24 * 3600 * 1000;
    prepare('INSERT INTO pay_codes(owner_id,type,token,amount,remark,status,expires_at,created_at,max_uses,used_count) VALUES(?,?,?,?,?,?,?,?,?,0)')
      .run(ownerId, 'receive', token, amount, remark, 'active', expiresAt, Date.now(), maxUses);
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(token);
    try { persist(); } catch (e) {}
    res.json({ ok: true, code: codePublic(code), qrText: codePayload(code), expiresAt });
  });

  // 我的长期收款码列表（含使用计数）
  app.get('/api/pay/code/mine', mw, (req, res) => {
    const rows = prepare("SELECT * FROM pay_codes WHERE owner_id=? AND type='receive' AND status IN ('active','used') ORDER BY created_at DESC LIMIT 20").all(req.user.id);
    res.json({ codes: rows.map(codePublic) });
  });

  // 删除我的收款码
  app.delete('/api/pay/code/mine/:id', mw, (req, res) => {
    const info = prepare("UPDATE pay_codes SET status='cancelled' WHERE id=? AND owner_id=? AND type='receive'").run(parseInt(req.params.id, 10), req.user.id);
    if (!info.changes) return res.status(404).json({ error: '收款码不存在' });
    try { persist(); } catch (e) {}
    res.json({ ok: true });
  });

  // 生成付款码（短时效 2 分钟）：POST /api/pay/code/pay
  app.post('/api/pay/code/pay', mw, (req, res) => {
    const ownerId = req.user.id;
    const token = crypto.randomBytes(16).toString('base64url');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    prepare('INSERT INTO pay_codes(owner_id,type,token,amount,remark,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(ownerId, 'pay', token, null, '', 'active', expiresAt, Date.now());
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(token);
    try { persist(); } catch (e) {}
    res.json({ ok: true, code: codePublic(code), qrText: codePayload(code), expiresAt });
  });

  // 查询码状态：GET /api/pay/code/:token
  app.get('/api/pay/code/:token', (req, res) => {
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(String(req.params.token || ''));
    if (!code) return res.status(404).json({ error: '码不存在' });
    const expired = code.status === 'active' && code.expires_at && code.expires_at < Date.now();
    if (expired) prepare('UPDATE pay_codes SET status=? WHERE id=?').run('expired', code.id);
    if (code.status !== 'active' || expired) return res.status(410).json({ error: '码已失效' });
    res.json({ code: codePublic(code) });
  });

  // 扫码获取对象信息（不校验登录，供解码跳转）：GET /api/pay/code/:token/info
  app.get('/api/pay/code/:token/info', (req, res) => {
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(String(req.params.token || ''));
    if (!code) return res.status(404).json({ error: '码不存在' });
    if (code.status !== 'active' || (code.expires_at && code.expires_at < Date.now())) return res.status(410).json({ error: '码已失效' });
    const owner = getUserRow(code.owner_id);
    res.json({
      type: code.type, amount: code.amount, remark: code.remark, expiresAt: code.expires_at,
      receiver: code.type === 'pay' ? null : publicUser(owner),
      payer: code.type === 'pay' ? publicUser(owner) : null,
      action: code.type === 'pay' ? 'request' : 'pay'
    });
  });

  // 扫收款码付款：POST /api/pay/code/receive/:token/confirm { amount?, remark? }
  app.post('/api/pay/code/receive/:token/confirm', mw, (req, res) => {
    const payerId = req.user.id;
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(String(req.params.token || ''));
    if (!code) return res.status(404).json({ error: '码不存在' });
    if (code.type !== 'receive') return res.status(400).json({ error: '不是收款码' });
    if (code.status !== 'active' || (code.expires_at && code.expires_at < Date.now())) return res.status(410).json({ error: '码已失效' });
    if (code.owner_id === payerId) return res.status(400).json({ error: '不能扫自己的收款码' });
    let amount = parseFloat((req.body && req.body.amount));
    // 次数限制原子扣减：无上限(-1)或未达上限才能继续，码保持 active
    const claim = prepare("UPDATE pay_codes SET used_count=used_count+1 WHERE id=? AND status='active' AND (max_uses<0 OR used_count<max_uses)").run(code.id);
    if (!claim.changes) {
      const cur = prepare('SELECT used_count,max_uses FROM pay_codes WHERE id=?').get(code.id);
      if (cur && cur.max_uses >= 0 && cur.used_count >= cur.max_uses) return res.status(410).json({ error: '该收款码已达使用次数上限' });
      return res.status(410).json({ error: '码已失效' });
    }
    if (code.amount) amount = code.amount;
    if (!Number.isFinite(amount) || amount <= 0) {
      prepare('UPDATE pay_codes SET used_count=MAX(0,used_count-1) WHERE id=?').run(code.id);
      return res.status(400).json({ error: '金额无效' });
    }
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 100) || '扫码收款';
    doPay(payerId, code.owner_id, amount, remark, 'paycode', code.id, (err, result) => {
      if (err) {
        prepare('UPDATE pay_codes SET used_count=MAX(0,used_count-1) WHERE id=?').run(code.id);
        return res.status(err.code || 400).json({ error: err.message });
      }
      try { persist(); } catch (e) {}
      res.json(result);
    });
  });

  // 扫付款码收款（商家扫顾客）：POST /api/pay/code/pay/:token/confirm { amount, remark? }
  app.post('/api/pay/code/pay/:token/confirm', mw, (req, res) => {
    const receiverId = req.user.id;
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(String(req.params.token || ''));
    if (!code) return res.status(404).json({ error: '码不存在' });
    if (code.type !== 'pay') return res.status(400).json({ error: '不是付款码' });
    if (code.status !== 'active' || (code.expires_at && code.expires_at < Date.now())) return res.status(410).json({ error: '码已失效或过期' });
    if (code.owner_id === receiverId) return res.status(400).json({ error: '不能向自己收款' });
    const amount = parseFloat((req.body && req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额无效' });
    const claim2 = prepare("UPDATE pay_codes SET status='used' WHERE id=? AND status='active'").run(code.id);
    if (!claim2.changes) return res.status(410).json({ error: '码已失效或过期' });
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 100) || '付款码收款';
    doPay(code.owner_id, receiverId, amount, remark, 'paycode', code.id, (err, result) => {
      if (err) {
        prepare('UPDATE pay_codes SET status=? WHERE id=?').run('active', code.id);
        return res.status(err.code || 400).json({ error: err.message });
      }
      try { persist(); } catch (e) {}
      res.json(result);
    });
  });

  // 我的收付款码历史：GET /api/pay/code?type=receive|pay
  app.get('/api/pay/code', mw, (req, res) => {
    const type = (req.query.type === 'pay') ? 'pay' : 'receive';
    const rows = prepare('SELECT * FROM pay_codes WHERE owner_id=? AND type=? ORDER BY created_at DESC LIMIT 20').all(req.user.id, type);
    res.json({ codes: rows.map(codePublic) });
  });

  // ============ 群收款 ============
  // 发起群收款：POST /api/pay/group/collect { groupId, title, amount }
  app.post('/api/pay/group/collect', mw, (req, res) => {
    const creatorId = req.user.id;
    const groupId = parseInt((req.body && req.body.groupId), 10);
    const title = String((req.body && req.body.title) || '').trim().slice(0, 100);
    const perAmount = parseFloat((req.body && req.body.amount));
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!memberOf(groupId, creatorId)) return res.status(403).json({ error: '你不在此群' });
    if (!title) return res.status(400).json({ error: '请输入收款说明' });
    if (!Number.isFinite(perAmount) || perAmount <= 0) return res.status(400).json({ error: '每人金额无效' });
    const info = prepare('INSERT INTO group_collects(group_id,creator_id,title,amount,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(groupId, creatorId, title, perAmount, 'open', Date.now());
    const id = info.lastInsertRowid;
    // 记录发起人的付款（处理掉）
    prepare('INSERT INTO collect_payments(collect_id,user_id,amount,remark,created_at) VALUES(?,?,?,?,?)')
      .run(id, creatorId, perAmount, '发起人(已预缴)', Date.now());
    try { persist(); } catch (e) {}
    res.json({ ok: true, collect: collectDetail(id, creatorId) });
  });

  function collectDetail(id, viewerId) {
    const c = prepare('SELECT * FROM group_collects WHERE id=?').get(id);
    if (!c) return null;
    const members = groupMembers(c.group_id);
    const paidRows = prepare('SELECT * FROM collect_payments WHERE collect_id=?').all(id);
    const paid = {};
    paidRows.forEach(p => { if (!paid[p.user_id]) paid[p.user_id] = { amount: p.amount, remark: p.remark, createdAt: p.created_at }; });
    const statusList = members.map(m => {
      const me = getUserRow(m.userId);
      const p = paid[m.userId];
      return {
        userId: m.userId,
        name: me ? (me.nickname || me.username) : ('用户' + m.userId),
        avatar: me ? me.avatar : null,
        amount: c.amount,
        paid: !!p,
        paidAmount: p ? p.amount : 0,
        remark: p ? p.remark : '',
        paidAt: p ? p.createdAt : null
      };
    });
    return {
      id: c.id, groupId: c.group_id, groupName: groupName(c.group_id),
      creatorId: c.creator_id, title: c.title, amount: c.amount,
      status: c.status, createdAt: c.created_at,
      memberCount: members.length, paidCount: Object.keys(paid).length,
      viewerPaid: !!paid[viewerId],
      members: statusList
    };
  }

  // 群内成员缴款：POST /api/pay/group/collect/:id/pay
  app.post('/api/pay/group/collect/:id/pay', mw, (req, res) => {
    const userId = req.user.id;
    const collectId = parseInt(req.params.id, 10);
    const c = prepare('SELECT * FROM group_collects WHERE id=?').get(collectId);
    if (!c) return res.status(404).json({ error: '收款不存在' });
    if (!memberOf(c.group_id, userId)) return res.status(403).json({ error: '你不在此群' });
    if (c.status !== 'open') return res.status(400).json({ error: '收款已结束' });
    const existing = prepare('SELECT id FROM collect_payments WHERE collect_id=? AND user_id=?').get(collectId, userId);
    if (existing) return res.status(409).json({ error: '你已缴款' });
    try {
      prepare('INSERT INTO collect_payments(collect_id,user_id,amount,remark,created_at) VALUES(?,?,?,?,?)')
        .run(collectId, userId, c.amount, '(处理中)', Date.now());
    } catch (e) {
      if (String(e && e.message || e).includes('UNIQUE')) return res.status(409).json({ error: '你已缴款' });
      throw e;
    }
    const remark = String((req.body && req.body.remark) || '').trim() || '群收款';
    doPay(userId, c.creator_id, c.amount, '群收款：' + c.title, 'group_collect', c.id, (err, result) => {
      if (err) {
        prepare('DELETE FROM collect_payments WHERE collect_id=? AND user_id=?').run(collectId, userId);
        return res.status(err.code || 400).json({ error: err.message });
      }
      prepare('UPDATE collect_payments SET remark=? WHERE collect_id=? AND user_id=?').run(remark, collectId, userId);
      try { persist(); } catch (e) {}
      res.json({ ok: true, collect: collectDetail(collectId, userId), balance: result.balance });
    });
  });

  // 查看单个收款：GET /api/pay/group/collect/:id
  app.get('/api/pay/group/collect/:id', mw, (req, res) => {
    const c = prepare('SELECT * FROM group_collects WHERE id=?').get(parseInt(req.params.id, 10));
    if (!c) return res.status(404).json({ error: '收款不存在' });
    if (!memberOf(c.group_id, req.user.id)) return res.status(403).json({ error: '你不在此群' });
    res.json({ collect: collectDetail(c.id, req.user.id) });
  });

  // 收款列表（按群）：GET /api/pay/group/:id/collects
  app.get('/api/pay/group/:id/collects', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupExists(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!memberOf(groupId, req.user.id)) return res.status(403).json({ error: '你不在此群' });
    const rows = prepare('SELECT * FROM group_collects WHERE group_id=? ORDER BY created_at DESC').all(groupId);
    res.json({ collects: rows.map(c => collectDetail(c.id, req.user.id)) });
  });

  // ============ 群接龙 ============
  // 发起接龙：POST /api/pay/group/solection { groupId, subject }
  app.post('/api/pay/group/solection', mw, (req, res) => {
    const creatorId = req.user.id;
    const groupId = parseInt((req.body && req.body.groupId), 10);
    const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!memberOf(groupId, creatorId)) return res.status(403).json({ error: '你不在此群' });
    if (!subject) return res.status(400).json({ error: '请输入接龙主题' });
    const info = prepare('INSERT INTO group_solections(group_id,creator_id,subject,status,created_at) VALUES(?,?,?,?,?)')
      .run(groupId, creatorId, subject, 'open', Date.now());
    try { persist(); } catch (e) {}
    res.json({ ok: true, solection: solectionDetail(info.lastInsertRowid) });
  });

  function solectionDetail(id) {
    const s = prepare('SELECT * FROM group_solections WHERE id=?').get(id);
    if (!s) return null;
    const entries = prepare('SELECT * FROM solection_entries WHERE solection_id=? ORDER BY created_at ASC').all(id);
    const list = entries.map(e => {
      const u = getUserRow(e.user_id);
      return {
        userId: e.user_id, name: u ? (u.nickname || u.username) : ('用户' + e.user_id),
        avatar: u ? u.avatar : null, remark: e.remark, createdAt: e.created_at, id: e.id
      };
    });
    return {
      id: s.id, groupId: s.group_id, groupName: groupName(s.group_id),
      creatorId: s.creator_id, subject: s.subject, status: s.status,
      createdAt: s.created_at, entryCount: entries.length, entries: list
    };
  }

  // 接龙报名：POST /api/pay/group/solection/:id/join { remark? }
  app.post('/api/pay/group/solection/:id/join', mw, (req, res) => {
    const userId = req.user.id;
    const s = prepare('SELECT * FROM group_solections WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return res.status(404).json({ error: '接龙不存在' });
    if (!memberOf(s.group_id, userId)) return res.status(403).json({ error: '你不在此群' });
    if (s.status !== 'open') return res.status(400).json({ error: '接龙已结束' });
    const existing = prepare('SELECT id FROM solection_entries WHERE solection_id=? AND user_id=?').get(s.id, userId);
    if (existing) return res.status(409).json({ error: '你已报名' });
    const remark = String((req.body && req.body.remark) || '').trim() || '';
    prepare('INSERT INTO solection_entries(solection_id,user_id,remark,created_at) VALUES(?,?,?,?)')
      .run(s.id, userId, remark, Date.now());
    try { persist(); } catch (e) {}
    res.json({ ok: true, solection: solectionDetail(s.id) });
  });

  // 取消报名：DELETE /api/pay/group/solection/:id/join
  app.delete('/api/pay/group/solection/:id/join', mw, (req, res) => {
    const userId = req.user.id;
    const s = prepare('SELECT * FROM group_solections WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return res.status(404).json({ error: '接龙不存在' });
    prepare('DELETE FROM solection_entries WHERE solection_id=? AND user_id=?').run(s.id, userId);
    try { persist(); } catch (e) {}
    res.json({ ok: true, solection: solectionDetail(s.id) });
  });

  // 查看接龙：GET /api/pay/group/solection/:id
  app.get('/api/pay/group/solection/:id', mw, (req, res) => {
    const s = prepare('SELECT * FROM group_solections WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return res.status(404).json({ error: '接龙不存在' });
    if (!memberOf(s.group_id, req.user.id)) return res.status(403).json({ error: '你不在此群' });
    res.json({ solection: solectionDetail(s.id) });
  });

  // 接龙列表（按群）：GET /api/pay/group/:id/solections
  app.get('/api/pay/group/:id/solections', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!groupExists(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!memberOf(groupId, req.user.id)) return res.status(403).json({ error: '你不在此群' });
    const rows = prepare('SELECT * FROM group_solections WHERE group_id=? ORDER BY created_at DESC').all(groupId);
    res.json({ solections: rows.map(s => solectionDetail(s.id)) });
  });

  // ============ 生活缴费 / 手机充值（演示流程）============
  // 可选项目与供应商（前端也内置一份，此处作为权威列表）
  app.get('/api/pay/life/catalog', mw, (req, res) => {
    res.json({ categories: [
      { key: 'water', label: '水费', providers: ['市自来水公司'] },
      { key: 'electric', label: '电费', providers: ['国家电网'] },
      { key: 'gas', label: '燃气费', providers: ['市燃气公司'] },
      { key: 'phone', label: '话费充值', providers: ['中国移动', '中国联通', '中国电信'] },
      { key: 'broadband', label: '宽带', providers: ['中国电信', '中国移动'] },
      { key: 'traffic', label: '交通违章', providers: ['交管12123'] },
      { key: 'tuition', label: '学杂费', providers: ['示例大学'] }
    ] });
  });

  // 缴费/充值：POST /api/pay/life/pay { category, provider, account, amount }
  app.post('/api/pay/life/pay', mw, (req, res) => {
    const userId = req.user.id;
    const category = String((req.body && req.body.category) || '').trim();
    const provider = String((req.body && req.body.provider) || '').trim().slice(0, 60);
    const account = String((req.body && (req.body.account || req.body.phone)) || '').trim().slice(0, 60);
    const amount = parseFloat((req.body && req.body.amount));
    if (!category) return res.status(400).json({ error: '请选择缴费项目' });
    if (!provider) return res.status(400).json({ error: '请选择缴费机构' });
    if (!account) return res.status(400).json({ error: '请填写户号/手机号' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额无效' });
    const cat = { water: '水费', electric: '电费', gas: '燃气费', phone: '手机充值', broadband: '宽带', traffic: '交通违章', tuition: '学杂费' };
    const label = cat[category] || category;
    doPay(userId, userId, amount, label + '（演示）', 'life', null, true, (err, result) => {      if (err) return res.status(err.code || 400).json({ error: err.message });
      const info = prepare('INSERT INTO life_payments(user_id,category,provider,account,amount,status,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(userId, category, provider, account, amount, 'paid', Date.now());
      try { persist(); } catch (e) {}
      res.json({ ok: true, payment: { id: info.lastInsertRowid, category, provider, account, amount, status: 'paid', balance: result.balance }, note: '演示环境，未发生真实扣款到账' });
    });
  });

  // 缴费历史：GET /api/pay/life/history
  app.get('/api/pay/life/history', mw, (req, res) => {
    const rows = prepare('SELECT id,category,provider,account,amount,status,created_at FROM life_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
    const cat = { water: '水费', electric: '电费', gas: '燃气费', phone: '手机充值', broadband: '宽带', traffic: '交通违章', tuition: '学杂费' };
    res.json({ history: rows.map(r => ({ ...r, categoryLabel: cat[r.category] || r.category })) });
  });

  // ============ 钱包账单流水 ============
  // GET /api/pay/bills?category=&limit=&offset=
  app.get('/api/pay/bills', mw, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const cat = String(req.query.category || '');
    let sql = 'SELECT * FROM pay_bills WHERE user_id=?';
    const args = [req.user.id];
    if (cat) { sql += ' AND category=?'; args.push(cat); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    const rows = prepare(sql).all(...args);
    const list = rows.map(r => {
      let peerName = null;
      if (r.peer_id && r.peer_id !== r.user_id) { const u = getUserRow(r.peer_id); peerName = u ? (u.nickname || u.username) : null; }
      return {
        id: r.id, kind: r.kind, category: r.category, amount: r.amount,
        peerId: r.peer_id, peerName, title: r.title, refType: r.ref_type, refId: r.ref_id, createdAt: r.created_at
      };
    });
    res.json({ bills: list });
  });

  // 汇总：GET /api/pay/summary
  app.get('/api/pay/summary', mw, (req, res) => {
    const uid = req.user.id;
    ensureWallet(uid);
    const w = prepare('SELECT balance,total_received FROM wallets WHERE user_id=?').get(uid);
    const row = prepare('SELECT COUNT(*) AS cnt, COALESCE(SUM(CASE WHEN kind=\'in\' THEN amount ELSE 0 END),0) AS totalIn, COALESCE(SUM(CASE WHEN kind=\'out\' THEN amount ELSE 0 END),0) AS totalOut FROM pay_bills WHERE user_id=?').get(uid);
    const collectPaid = prepare('SELECT COUNT(*) AS cnt FROM collect_payments WHERE user_id=?').get(uid);
    const solJoined = prepare('SELECT COUNT(*) AS cnt FROM solection_entries WHERE user_id=?').get(uid);
    const life = prepare('SELECT COUNT(*) AS cnt FROM life_payments WHERE user_id=?').get(uid);
    res.json({
      balance: w ? w.balance : 0,
      totalReceived: w ? w.total_received : 0,
      totalBills: row ? row.cnt : 0, totalIn: row ? row.totalIn : 0, totalOut: row ? row.totalOut : 0,
      collectPaid: collectPaid ? collectPaid.cnt : 0,
      solJoined: solJoined ? solJoined.cnt : 0,
      lifePaid: life ? life.cnt : 0
    });
  });

  // ============ 支付网关（内置钱包沙箱） ============
  function merchantPublic(m) {
    return { id: m.id, userId: m.user_id, name: m.name, callbackUrl: m.callback_url || '', authMode: m.auth_mode, status: m.status, reason: m.reason || '', apiKey: m.api_key || '', createdAt: m.created_at, reviewedAt: m.reviewed_at || null };
  }
  function orderPublic(o) {
    return { id: o.id, orderNo: o.order_no, merchantId: o.merchant_id, amount: o.amount, subject: o.subject, status: o.status, createdAt: o.created_at, paidAt: o.paid_at || null, expiresAt: o.expires_at, qrText: 'securechat://gateway/pay?order=' + encodeURIComponent(o.order_no) };
  }

  // 商户申请：回调地址可选；网页授权和本地客户端授权二选一。
  app.post('/api/pay/gateway/merchant/apply', mw, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const callbackUrl = String(req.body?.callbackUrl || '').trim().slice(0, 500);
    const authMode = ['web', 'local'].includes(req.body?.authMode) ? req.body.authMode : 'local';
    if (!name) return res.status(400).json({ error: '商户名称不能为空' });
    if (callbackUrl && !/^https:\/\//i.test(callbackUrl)) return res.status(400).json({ error: '回调地址必须使用 HTTPS' });
    const old = prepare('SELECT * FROM pay_merchants WHERE user_id=?').get(req.user.id);
    if (old) return res.status(409).json({ error: '你已经申请过商户，请等待审核', merchant: merchantPublic(old) });
    const r = prepare('INSERT INTO pay_merchants(user_id,name,callback_url,auth_mode,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(req.user.id, name, callbackUrl, authMode, 'pending', Date.now());
    persist();
    res.json({ ok: true, merchant: merchantPublic(prepare('SELECT * FROM pay_merchants WHERE id=?').get(r.lastInsertRowid)) });
  });

  app.get('/api/pay/gateway/merchant/me', mw, (req, res) => {
    const m = prepare('SELECT * FROM pay_merchants WHERE user_id=?').get(req.user.id);
    res.json({ merchant: m ? merchantPublic(m) : null });
  });

  // 商户自助修改：名称 / 回调地址 / 重新生成自己的 API 密钥
  app.post('/api/pay/gateway/merchant/update', mw, (req, res) => {
    const m = prepare('SELECT * FROM pay_merchants WHERE user_id=?').get(req.user.id);
    if (!m) return res.status(404).json({ error: '你还没有商户，请先申请' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : m.name;
    if (!name) return res.status(400).json({ error: '商户名称不能为空' });
    let callbackUrl = m.callback_url || '';
    if (req.body?.callbackUrl !== undefined) {
      callbackUrl = String(req.body.callbackUrl).trim().slice(0, 500);
      if (callbackUrl && !/^https:\/\//i.test(callbackUrl)) return res.status(400).json({ error: '回调地址必须使用 HTTPS' });
    }
    let apiKey = m.api_key || '';
    if (req.body?.regenerateKey) apiKey = 'sk_' + crypto.randomBytes(16).toString('hex');
    prepare('UPDATE pay_merchants SET name=?, callback_url=?, api_key=? WHERE id=?').run(name, callbackUrl, apiKey, m.id);
    persist();
    res.json({ ok: true, merchant: merchantPublic(prepare('SELECT * FROM pay_merchants WHERE id=?').get(m.id)) });
  });

  // 创建订单：只有审核通过的商户能创建。
  app.post('/api/pay/gateway/order', mw, (req, res) => {
    const merchant = prepare('SELECT * FROM pay_merchants WHERE user_id=? AND status=?').get(req.user.id, 'approved');
    if (!merchant) return res.status(403).json({ error: '商户未审核通过' });
    const amount = Number(req.body?.amount);
    const subject = String(req.body?.subject || '').trim().slice(0, 120);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: '金额无效' });
    if (!subject) return res.status(400).json({ error: '商品说明不能为空' });
    const orderNo = 'SC' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = Date.now() + 30 * 60 * 1000;
    prepare('INSERT INTO pay_orders(order_no,merchant_id,amount,subject,status,callback_url,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(orderNo, merchant.id, amount, subject, 'pending', merchant.callback_url || '', Date.now(), expiresAt);
    persist();
    res.json({ ok: true, order: orderPublic(prepare('SELECT * FROM pay_orders WHERE order_no=?').get(orderNo)) });
  });

  // 订单详情：扫码前可公开查询基本信息，不返回敏感数据。
  app.get('/api/pay/gateway/order/:orderNo', (req, res) => {
    const o = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(req.params.orderNo);
    if (!o) return res.status(404).json({ error: '订单不存在' });
    if (o.status === 'pending' && o.expires_at < Date.now()) {
      prepare('UPDATE pay_orders SET status=? WHERE id=?').run('expired', o.id);
      o.status = 'expired';
    }
    res.json({ order: orderPublic(o) });
  });

  // 确认支付：直接扣款，无需预授权；允许转给自己（网关商户与付款人可为同一账号）。
  app.post('/api/pay/gateway/order/:orderNo/confirm', mw, (req, res) => {
    let o = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(req.params.orderNo);
    if (!o) return res.status(404).json({ error: '订单不存在' });
    // 未支付过的过期单（含pending但已过期）：复活并刷新有效期（商户重发同单号时不再被永久卡死）
    if ((o.status !== 'pending' || !o.expires_at || o.expires_at < Date.now()) && !o.paid_at) {
      prepare("UPDATE pay_orders SET status='pending',expires_at=? WHERE id=? AND status<>'paid'").run(Date.now() + 30 * 60 * 1000, o.id);
      o = prepare('SELECT * FROM pay_orders WHERE id=?').get(o.id);
    }
    if (o.status === 'paid') return res.status(409).json({ error: '该订单此前已支付成功，请勿重复支付；如需再次赞助请在游戏内重新下单' });
    if (o.status !== 'pending' || (o.expires_at && o.expires_at < Date.now())) return res.status(409).json({ error: '订单已失效或已处理' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: '必须明确确认扣款' });
    const amount = Number(req.body?.amount);
    if (amount !== o.amount) return res.status(400).json({ error: '确认金额与订单金额不一致' });
    const claim = prepare("UPDATE pay_orders SET payer_id=?,status='paid',paid_at=? WHERE id=? AND status='pending'").run(req.user.id, Date.now(), o.id);
    if (!claim.changes) return res.status(409).json({ error: '订单已失效或已处理' });
    const merchant = prepare('SELECT user_id FROM pay_merchants WHERE id=?').get(o.merchant_id);
    doPay(req.user.id, merchant.user_id, amount, o.subject, 'gateway', o.id, (err, result) => {
      if (err) {
        prepare("UPDATE pay_orders SET status='pending',payer_id=NULL,paid_at=NULL WHERE id=? AND status='paid'").run(o.id);
        persist();
        return res.status(err.code || 400).json({ error: err.message });
      }
      persist();
      // 触发 epaygw 懒同步：置网关订单 TRADE_SUCCESS 并通知商户（NewAPI 等）
      try {
        const c = epayConfig(prepare);
        const q = { act: 'order', pid: c.merchantPid || '1000', out_trade_no: o.order_no };
        const qs = Object.keys(q).sort().map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
        const sg = crypto.createHash('md5').update(qs + c.key).digest('hex').toUpperCase();
        http.get('http://127.0.0.1:' + (process.env.EPAY_HTTP_PORT || 8889) + '/epaygw/api.php?' + qs + '&sign=' + sg, (r) => { r.resume(); }).on('error', () => {});
      } catch (e) { console.error('[pay] trigger epaygw sync failed: ' + (e && e.message || e)); }
      res.json({ ok: true, order: orderPublic(prepare('SELECT * FROM pay_orders WHERE id=?').get(o.id)), balance: result.balance, callback: !!o.callback_url });
    }, true);
  });

  // 用户创建授权：需明确确认，网页/本地客户端均可使用。
  app.post('/api/pay/gateway/authorization', mw, (req, res) => {
    const merchantId = parseInt(req.body?.merchantId, 10);
    const maxAmount = Number(req.body?.maxAmount);
    const mode = ['web', 'local'].includes(req.body?.mode) ? req.body.mode : 'local';
    const confirm = req.body?.confirm === true;
    if (!merchantId || !Number.isFinite(maxAmount) || maxAmount <= 0 || !confirm) return res.status(400).json({ error: '授权金额和明确确认必填' });
    const m = prepare('SELECT id,status FROM pay_merchants WHERE id=?').get(merchantId);
    if (!m || m.status !== 'approved') return res.status(404).json({ error: '商户不存在或未审核' });
    const expiresAt = Date.now() + 90 * 24 * 3600 * 1000;
    prepare('INSERT INTO pay_authorizations(user_id,merchant_id,mode,max_amount,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(req.user.id, merchantId, mode, maxAmount, 'active', Date.now(), expiresAt);
    persist();
    res.json({ ok: true, mode, maxAmount, expiresAt });
  });

  app.get('/api/pay/gateway/authorization', mw, (req, res) => {
    const rows = prepare('SELECT * FROM pay_authorizations WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
    res.json({ authorizations: rows.map(a => ({ id: a.id, merchantId: a.merchant_id, mode: a.mode, maxAmount: a.max_amount, status: a.status, createdAt: a.created_at, expiresAt: a.expires_at })) });
  });

  app.delete('/api/pay/gateway/authorization/:id', mw, (req, res) => {
    prepare('UPDATE pay_authorizations SET status=? WHERE id=? AND user_id=?').run('revoked', parseInt(req.params.id, 10), req.user.id);
    persist();
    res.json({ ok: true });
  });

  // ============ EPay 通道 ============
  // 配置只允许管理员设置；key 不返回给客户端。
  app.get('/api/admin/pay/epay/config', (req, res) => {
    return adminMw(req, res, () => {
      const u = prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      const admins = String(process.env.ADMIN_EMAILS || '3529403074@qq.com').toLowerCase().split(',');
      if (!u || !admins.includes(String(u.email || '').toLowerCase())) return res.status(403).json({ error: '无权限' });
      const c = epayConfig(prepare);
      res.json({ config: { ...c, key: c.key ? '********' : '' } });
    });
  });

  app.post('/api/admin/pay/epay/config', (req, res) => {
    return adminMw(req, res, () => {
      const u = prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      const admins = String(process.env.ADMIN_EMAILS || '3529403074@qq.com').toLowerCase().split(',');
      if (!u || !admins.includes(String(u.email || '').toLowerCase())) return res.status(403).json({ error: '无权限' });
      const old = epayConfig(prepare);
      const b = req.body || {};
      const c = {
        enabled: b.enabled === true,
        sandbox: b.sandbox === true,
        baseUrl: b.baseUrl,
        gatewayUrl: b.gatewayUrl,
        gatewayId: b.gatewayId,
        merchantPid: b.merchantPid,
        key: b.key && b.key !== '********' ? b.key : old.key,
        notifyUrl: b.notifyUrl,
        returnUrl: b.returnUrl
      };
      if (c.enabled && !c.sandbox && (!c.baseUrl || !c.gatewayUrl || !c.merchantPid || !c.key || !c.notifyUrl)) return res.status(400).json({ error: '启用 EPay 前必须填写基础地址、网关地址、商户 PID、Key、异步回调地址（或开启模拟模式）' });
      saveEpayConfig(c);
      res.json({ ok: true, config: { ...c, key: c.key ? '********' : '' } });
    });
  });

  app.get('/api/pay/gateway/epay/status', (req, res) => {
    const c = epayConfig(prepare);
    res.json({ enabled: c.enabled, sandbox: c.sandbox, gatewayId: c.gatewayId, merchantPid: c.merchantPid });
  });

  // 商户创建 EPay 订单，返回第三方支付跳转地址；模拟模式下返回本服务模拟收银台。
  app.post('/api/pay/gateway/epay/order', mw, (req, res) => {
    const c = epayConfig(prepare);
    if (!c.enabled) return res.status(503).json({ error: 'EPay 通道未启用' });
    const merchant = prepare('SELECT * FROM pay_merchants WHERE user_id=? AND status=?').get(req.user.id, 'approved');
    if (!merchant) return res.status(403).json({ error: '商户未审核通过' });
    const amount = Number(req.body?.amount);
    const subject = String(req.body?.subject || '').trim().slice(0, 120);
    const type = ['alipay', 'wxpay', 'qqpay'].includes(req.body?.type) ? req.body.type : 'wxpay';
    if (!Number.isFinite(amount) || amount <= 0 || !subject) return res.status(400).json({ error: '金额或商品说明无效' });
    const orderNo = 'EP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = Date.now() + 30 * 60 * 1000;
    prepare('INSERT INTO pay_orders(order_no,merchant_id,amount,subject,status,callback_url,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(orderNo, merchant.id, amount, subject, 'pending', merchant.callback_url || '', Date.now(), expiresAt);
    if (c.sandbox) {
      // 模拟模式：不跳真实网关，返回模拟收银台地址，由 /mock/pay 完成钱包扣款流程。
      const payUrl = '/api/pay/gateway/epay/mock/cashier?orderNo=' + encodeURIComponent(orderNo);
      persist();
      return res.json({ ok: true, sandbox: true, orderNo, amount, subject, payUrl, mock: true, note: '请在客户端展示订单信息并要求用户明确确认后调用支付接口' });
    }
    const params = {
      pid: c.merchantPid,
      type,
      out_trade_no: orderNo,
      notify_url: c.notifyUrl,
      return_url: c.returnUrl,
      name: subject,
      money: amount.toFixed(2),
      sitename: merchant.name
    };
    params.sign = epaySign(params, c.key);
    params.sign_type = 'MD5';
    const query = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const gateway = c.gatewayUrl || `${c.baseUrl}/submit.php`;
    persist();
    res.json({ ok: true, orderNo, amount, subject, gatewayUrl: gateway + (gateway.includes('?') ? '&' : '?') + query, params: { ...params, sign: undefined }, note: '请在客户端展示订单信息并要求用户明确确认后跳转付款' });
  });

  // 网页端授权扣款：确认页（登录态 JS 校验授权并确认扣款）。
  app.get('/api/pay/gateway/epay/cashier', (req, res) => {
    const orderNo = String(req.query.order || req.query.orderNo || '');
    const order = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(orderNo);
    if (!order) return res.status(404).send('订单不存在');
    const merchant = prepare('SELECT id,name,user_id FROM pay_merchants WHERE id=?').get(order.merchant_id);
    res.set('Cache-Control', 'no-store');
    res.type('text/html; charset=utf-8').send('<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SecureChat 网页授权扣款</title></head>' +
      '<body style="font-family:system-ui,sans-serif;background:#f2f3f5;margin:0;padding:0;display:flex;justify-content:center;align-items:center;min-height:100vh">' +
      '<div style="background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:28px;max-width:400px;width:100%;box-sizing:border-box">' +
      '<div style="font-size:18px;font-weight:600;color:#222;margin-bottom:14px">网页端授权扣款</div>' +
      '<div style="border:1px dashed #e0e0e0;border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px;color:#666">' +
      '<div style="padding:3px 0"><span>订单号</span><b style="color:#222;float:right">' + order.order_no + '</b></div>' +
      '<div style="padding:3px 0;clear:both"><span>商户</span><b style="color:#222;float:right">' + escHtml(merchant ? merchant.name : '') + '</b></div>' +
      '<div style="padding:3px 0;clear:both"><span>说明</span><b style="color:#222;float:right">' + escHtml(order.subject) + '</b></div>' +
      '<div style="padding:3px 0;clear:both"><span>金额</span><b style="color:#e4393c;float:right">¥' + Number(order.amount).toFixed(2) + '</b></div>' +
      '</div>' +
      '<div id="authBox" style="border:1px solid #eee;border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px;color:#666"></div>' +
      '<button id="payBtn" style="width:100%;background:#07c160;color:#fff;border:0;border-radius:10px;padding:13px 0;font-size:15px;cursor:pointer">确认支付 ¥' + Number(order.amount).toFixed(2) + '</button>' +
      '<div id="msgBox" style="font-size:13px;margin-top:12px;text-align:center"></div>' +
      '<a href="securechat://gateway/pay?order=' + encodeURIComponent(order.order_no) + '" style="display:block;text-align:center;margin-top:12px;font-size:13px;color:#07c160;text-decoration:none;font-weight:600">在客户端中打开并扣款</a>' +
      '<div style="text-align:center;margin-top:4px;font-size:12px;color:#999">已安装 SecureChat 桌面客户端时，点击后会唤起客户端确认扣款</div>' +
      '<a href="javascript:history.back()" style="display:block;text-align:center;margin-top:10px;font-size:13px;color:#1989fa;text-decoration:none">← 返回</a>' +
      '<script>var ORD=' + JSON.stringify({ orderNo: order.order_no, amount: Number(order.amount), merchantId: order.merchant_id }) + ';' +
      'function token(){try{var u=JSON.parse(localStorage.getItem("sc_me")||"null");if(u&&u.token)return u.token;}catch(e){}return localStorage.getItem("sc_token")||"";}' +
      'function api(m,u,b){return fetch((window.SERVER_HOST||"")+u,{method:m,headers:{"Content-Type":"application/json","Authorization":"Bearer "+token()},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d;});});}' +
      'var authBox=document.getElementById("authBox");var payBtn=document.getElementById("payBtn");var msg=document.getElementById("msgBox");' +
      'function show(t){msg.innerHTML=t;}' +
      'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","\u0027":"&#39;"}[c];});}' +
      'function renderLogin(){' +
      'authBox.innerHTML="登录 SecureChat 后确认支付。<br>账号：<input id=\\"lgAcc\\" type=\\"text\\" value=\\"\\" style=\\"width:160px;padding:4px;margin:4px 0\\"><br>密码：<input id=\\"lgPwd\\" type=\\"password\\" style=\\"width:160px;padding:4px;margin:4px 0\\"><br><button id=\\"lgBtn\\" style=\\"padding:4px 20px;border-radius:6px;border:1px solid #1989fa;background:#1989fa;color:#fff;cursor:pointer;margin-top:4px\\">登录</button>";' +
      'document.getElementById("lgBtn").onclick=function(){var a=document.getElementById("lgAcc").value.trim();var pw=document.getElementById("lgPwd").value;if(!a||!pw){show("请输入账号和密码");return;}api("POST","/api/login",{account:a,password:pw}).then(function(d){try{localStorage.setItem("sc_token",d.token);var m=JSON.parse(localStorage.getItem("sc_me")||"null")||{};m.token=d.token;m.user=d.user;localStorage.setItem("sc_me",JSON.stringify(m));}catch(e){}show("✅ 登录成功：@"+d.user.username);init();}).catch(function(e){show("登录失败："+esc(e.message));});};' +
      '}' +
      'function renderReady(u){authBox.innerHTML="已登录：@"+esc(u)+"。点击下方按钮直接确认支付，无需预授权。";}' +
      'function init(){if(!token()){renderLogin();payBtn.disabled=true;return;}try{var u=JSON.parse(localStorage.getItem("sc_me")||"null");renderReady(u&&u.user?u.user.username:"");}catch(e){renderReady("");}}' +
      'payBtn.onclick=function(){if(!token()){show("未登录");return;}if(!confirm("确认从 SecureChat 钱包扣款 ¥"+ORD.amount.toFixed(2)+" 支付本订单？"))return;api("POST","/api/pay/gateway/order/"+encodeURIComponent(ORD.orderNo)+"/confirm",{confirm:true,amount:ORD.amount}).then(function(d){show("✅ 支付成功！钱包余额 ¥"+Number(d.balance).toFixed(2));payBtn.disabled=true;setTimeout(function(){window.close();},1500);}).catch(function(e){show("❌ 支付失败："+esc(e.message));});};' +
      'init();</script></div></body></html>');
  });

  // 模拟收银台：返回模拟支付确认页（HTML，可直接在浏览器打开）。
  app.get('/api/pay/gateway/epay/mock/cashier', (req, res) => {
    const c = epayConfig(prepare);
    if (!c.enabled || !c.sandbox) return res.status(503).json({ error: '模拟模式未启用' });
    const order = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(String(req.query.orderNo || ''));
    if (!order) return res.status(404).send('订单不存在');
    if (order.status !== 'pending' && order.paid_at) return res.send('订单已处理');
    if (!order.paid_at && (order.status !== 'pending' || !order.expires_at || order.expires_at < Date.now())) {
      prepare("UPDATE pay_orders SET status='pending',expires_at=? WHERE id=?").run(Date.now() + 30 * 60 * 1000, order.id);
      try { persist(); } catch (e) {}
      order = prepare('SELECT * FROM pay_orders WHERE id=?').get(order.id);
    }
    res.type('html').send(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>收银台</title></head>
<body style="font-family:sans-serif;max-width:420px;margin:40px auto;text-align:center">
<h2>收银台</h2><p>订单：${escHtml(order.order_no)}</p><p>金额：<b>¥${Number(order.amount).toFixed(2)}</b></p><p>说明：${escHtml(order.subject)}</p>
<form method="post" action="/api/pay/gateway/epay/mock/pay"><input type="hidden" name="orderNo" value="${escHtml(order.order_no)}"><button style="font-size:18px;padding:12px 40px">确认支付</button></form>
<p style="color:#999;font-size:12px">支付将从 SecureChat 钱包扣款</p></body></html>`);
  });

  // 模拟支付：钱包扣款 -> 商户入账 -> 标记订单已支付（幂等）。
  app.post('/api/pay/gateway/epay/mock/pay', mw, (req, res) => {
    const c = epayConfig(prepare);
    if (!c.enabled || !c.sandbox) return res.status(503).json({ error: '模拟模式未启用' });
    const order = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(String((req.body && req.body.orderNo) || ''));
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (!order.paid_at && (order.status !== 'pending' || !order.expires_at || order.expires_at < Date.now())) {
      prepare("UPDATE pay_orders SET status='pending',expires_at=? WHERE id=?").run(Date.now() + 30 * 60 * 1000, order.id);
      order = prepare('SELECT * FROM pay_orders WHERE id=?').get(order.id);
    }
    if (order.status !== 'pending' || (order.expires_at && order.expires_at < Date.now())) return res.status(409).json({ error: '订单已失效或已处理' });
    const merchant = prepare('SELECT user_id FROM pay_merchants WHERE id=?').get(order.merchant_id);
    if (!merchant) return res.status(404).json({ error: '商户不存在' });
    doPay(req.user.id, merchant.user_id, Number(order.amount), '支付 ' + order.subject, 'epay', order.id, (err, result) => {
      if (err) return res.status(err.code || 400).json({ error: err.message });
      prepare('UPDATE pay_orders SET payer_id=?,status=?,paid_at=? WHERE id=?').run(req.user.id, 'paid', Date.now(), order.id);
      persist();
      res.json({ ok: true, sandbox: true, order: orderPublic(prepare('SELECT * FROM pay_orders WHERE id=?').get(order.id)), balance: result.balance, note: '支付成功（钱包扣款）' });
    });
  });

  // EPay 异步通知：验签后幂等更新订单。成功返回 success。
  app.all('/api/pay/gateway/epay/notify', (req, res) => {
    const c = epayConfig(prepare);
    const p = { ...(req.query || {}), ...(req.body || {}) };
    if (!c.enabled || !c.key || !p.sign || epaySign(p, c.key) !== String(p.sign).toLowerCase()) return res.status(403).send('fail');
    if (String(p.trade_status || '').toUpperCase() !== 'TRADE_SUCCESS' && String(p.trade_status || '') !== '1') return res.send('success');
    const order = prepare('SELECT * FROM pay_orders WHERE order_no=?').get(String(p.out_trade_no || ''));
    if (!order) return res.status(404).send('fail');
    if (Number(p.money) !== Number(order.amount)) return res.status(400).send('fail');
    if (order.status !== 'paid') {
      prepare('UPDATE pay_orders SET status=?,paid_at=? WHERE id=?').run('paid', Date.now(), order.id);
      persist();
    }
    res.send('success');
  });

  // NewAPI 回调兜底：当商户把"回调地址"误配为本机时，把通知原样转发到真实 NewAPI 站点。
  app.all('/api/user/epay/*', (req, res) => {
    const targetHost = 'ai.32768.top';
    const path = req.originalUrl;
    const body = Object.keys(req.body || {}).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(req.body[k])).join('&');
    const u = new URL('https://' + targetHost + path);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: req.method, rejectUnauthorized: false, headers: { 'Content-Type': req.get('content-type') || 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (rr) => {
      let b = ''; rr.on('data', (c) => b += c); rr.on('end', () => res.status(rr.statusCode).send(b));
    });
    r.on('error', (e) => res.status(502).send('forward failed: ' + (e && e.message || e)));
    r.write(body); r.end();
  });

  // 管理员审核商户（调用方可接入现有 admin 页面）。
  app.get('/api/admin/pay/merchants', (req, res) => {
    return adminMw(req, res, () => {
      const u = prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if (!u || !u.email || !String(process.env.ADMIN_EMAILS || '3529403074@qq.com').toLowerCase().split(',').includes(u.email.toLowerCase())) return res.status(403).json({ error: '无权限' });
      res.json({ merchants: prepare('SELECT * FROM pay_merchants ORDER BY created_at DESC').all().map(merchantPublic) });
    });
  });

  app.post('/api/admin/pay/merchants/:id/review', (req, res) => {
    return adminMw(req, res, () => {
      const u = prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if (!u || !u.email || !String(process.env.ADMIN_EMAILS || '3529403074@qq.com').toLowerCase().split(',').includes(u.email.toLowerCase())) return res.status(403).json({ error: '无权限' });
      const status = ['approved', 'rejected', 'pending'].includes(req.body?.status) ? req.body.status : 'pending';
      const target = prepare('SELECT * FROM pay_merchants WHERE id=?').get(parseInt(req.params.id, 10));
      if (!target) return res.status(404).json({ error: '商户不存在' });
      let apiKey = target.api_key || '';
      if (status === 'approved' && !apiKey) apiKey = 'sk_' + crypto.randomBytes(16).toString('hex');
      prepare('UPDATE pay_merchants SET status=?,reason=?,reviewed_at=?,api_key=? WHERE id=?').run(status, String(req.body?.reason || '').slice(0, 200), Date.now(), apiKey, target.id);
      persist();
      res.json({ ok: true, status });
    });
  });

  // ============ 个人真实收款码（支付宝/微信）============
  // 用户上传自己的真实收款二维码图片，可设使用次数（-1=无上限），展示/保存/删除。
  try { prepare("CREATE TABLE IF NOT EXISTS personal_qr (\n" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    " user_id INTEGER NOT NULL,\n" +
    " type TEXT NOT NULL DEFAULT 'alipay',\n" +
    " image TEXT NOT NULL,\n" +
    " note TEXT DEFAULT '',\n" +
    " max_uses INTEGER NOT NULL DEFAULT -1,\n" +
    " used_count INTEGER NOT NULL DEFAULT 0,\n" +
    " created_at INTEGER NOT NULL\n)") .run(); } catch (e) {}

  function personalQrPublic(r) {
    return { id: r.id, type: r.type, image: r.image, note: r.note || '', maxUses: r.max_uses, usedCount: r.used_count, exhausted: r.max_uses >= 0 && r.used_count >= r.max_uses, createdAt: r.created_at };
  }

  app.get('/api/pay/personal-qr', mw, (req, res) => {
    const rows = prepare('SELECT * FROM personal_qr WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(req.user.id);
    res.json({ codes: rows.map(personalQrPublic) });
  });

  // 保存/更新：同一类型覆盖旧码
  app.post('/api/pay/personal-qr', mw, (req, res) => {
    const b = req.body || {};
    const type = ['alipay', 'wxpay'].includes(b.type) ? b.type : 'alipay';
    const image = typeof b.image === 'string' ? b.image.trim() : '';
    if (!image.startsWith('data:image/') || image.length > 600 * 1024) return res.status(400).json({ error: '图片无效或过大（限600KB，请用截图data-uri）' });
    const maxUses = Number(b.maxUses);
    const mu = Number.isFinite(maxUses) ? Math.trunc(maxUses) : -1;
    const note = String(b.note || '').slice(0, 60);
    const old = prepare('SELECT id FROM personal_qr WHERE user_id=? AND type=?').get(req.user.id, type);
    if (old) {
      prepare('UPDATE personal_qr SET image=?,note=?,max_uses=?,used_count=0 WHERE id=?').run(image, note, mu, old.id);
    } else {
      prepare('INSERT INTO personal_qr(user_id,type,image,note,max_uses,used_count,created_at) VALUES(?,?,?,?,?,0,?)')
        .run(req.user.id, type, image, note, mu, Date.now());
    }
    persist();
    const row = prepare('SELECT * FROM personal_qr WHERE user_id=? AND type=?').get(req.user.id, type);
    res.json({ ok: true, code: personalQrPublic(row) });
  });

  // 被扫一次：次数+1（原子条件更新，达到上限后拒绝再计）
  app.post('/api/pay/personal-qr/:id/use', mw, (req, res) => {
    const row = prepare('SELECT * FROM personal_qr WHERE id=? AND user_id=?').get(parseInt(req.params.id, 10), req.user.id);
    if (!row) return res.status(404).json({ error: '收款码不存在' });
    const upd = prepare('UPDATE personal_qr SET used_count=used_count+1 WHERE id=? AND user_id=? AND (max_uses<0 OR used_count<max_uses)').run(row.id, req.user.id);
    if (!upd.changes) return res.status(409).json({ error: '已达使用次数上限' });
    persist();
    res.json({ ok: true, code: personalQrPublic(prepare('SELECT * FROM personal_qr WHERE id=?').get(row.id)) });
  });

  // 重置次数
  app.post('/api/pay/personal-qr/:id/reset', mw, (req, res) => {
    const row = prepare('SELECT id FROM personal_qr WHERE id=? AND user_id=?').get(parseInt(req.params.id, 10), req.user.id);
    if (!row) return res.status(404).json({ error: '收款码不存在' });
    prepare('UPDATE personal_qr SET used_count=0 WHERE id=?').run(row.id);
    persist();
    res.json({ ok: true });
  });

  app.delete('/api/pay/personal-qr/:id', mw, (req, res) => {
    const info = prepare('DELETE FROM personal_qr WHERE id=? AND user_id=?').run(parseInt(req.params.id, 10), req.user.id);
    if (!info.changes) return res.status(404).json({ error: '收款码不存在' });
    persist();
    res.json({ ok: true });
  });

  return { ok: true, routes: ['/api/pay/*'] };
};
