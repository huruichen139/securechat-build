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
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

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
  }
  ensureTables();

  // ============ 工具 ============
  function mw(req, res, next) {
    if (auth && typeof auth === 'function') return auth(req, res, next);
    let payload = null;
    try { payload = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), JWT_SECRET); } catch (e) { payload = null; }
    if (!payload) return res.status(401).json({ error: '未授权' });
    req.user = payload;
    next();
  }

  function getUserRow(id) { return prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(id); }

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
  function doPay(fromId, toId, amount, remark, category, refId, cb) {
    if (!Number.isFinite(amount) || amount <= 0) return cb({ code: 400, message: '金额无效' });
    if (fromId === toId) return cb({ code: 400, message: '不能转给自己' });
    const my = ensureWallet(fromId);
    if ((my.balance || 0) < amount) return cb({ code: 400, message: '余额不足' });
    // 出账方
    writeCharge(fromId, 'out', amount, toId, remark);
    // 入账方
    ensureWallet(toId);
    writeCharge(toId, 'in', amount, fromId, remark);
    addBill(fromId, 'out', category, amount, toId, remark + '（转出）', category, refId || null);
    addBill(toId, 'in', category, amount, fromId, remark + '（收入）', category, refId || null);
    try { persist(); } catch (e) {}
    cb(null, { ok: true, balance: balanceOf(fromId) });
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
    const token = crypto.randomBytes(16).toString('base64url');
    const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    prepare('INSERT INTO pay_codes(owner_id,type,token,amount,remark,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(ownerId, 'receive', token, amount, remark, 'active', expiresAt, Date.now());
    const code = prepare('SELECT * FROM pay_codes WHERE token=?').get(token);
    try { persist(); } catch (e) {}
    res.json({ ok: true, code: codePublic(code), qrText: codePayload(code), expiresAt });
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
    if (code.amount) amount = code.amount;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额无效' });
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 100) || '扫码收款';
    doPay(payerId, code.owner_id, amount, remark, 'paycode', code.id, (err, result) => {
      if (err) return res.status(err.code || 400).json({ error: err.message });
      if (code.amount) prepare('UPDATE pay_codes SET status=? WHERE id=?').run('used', code.id);
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
    const remark = String((req.body && req.body.remark) || '').trim().slice(0, 100) || '付款码收款';
    doPay(code.owner_id, receiverId, amount, remark, 'paycode', code.id, (err, result) => {
      if (err) return res.status(err.code || 400).json({ error: err.message });
      prepare('UPDATE pay_codes SET status=? WHERE id=?').run('used', code.id);
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
    const remark = String((req.body && req.body.remark) || '').trim() || '群收款';
    doPay(userId, c.creator_id, c.amount, '群收款：' + c.title, 'group_collect', c.id, (err, result) => {
      if (err) return res.status(err.code || 400).json({ error: err.message });
      prepare('INSERT INTO collect_payments(collect_id,user_id,amount,remark,created_at) VALUES(?,?,?,?,?)')
        .run(collectId, userId, c.amount, remark, Date.now());
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
    doPay(userId, userId, amount, label + '（演示）', 'life', null, (err, result) => {
      if (err) return res.status(err.code || 400).json({ error: err.message });
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

  return { ok: true, routes: ['/api/pay/*'] };
};
