'use strict';
// module: redpacket —— 微信式红包：发/抢/查/退回
// 支持两种：单聊（专属/随机/普通）与群聊（拼手气/普通）。
// 复用巨石钱包（wallets/wallet_txn 已在 db.js 建表；发红包从钱包扣款，抢红包入账）。
// 消息以 [红包:<id>] 文本写入 messages / group_messages 表，前端渲染为红包气泡。
// 导出：module.exports = function registerRedpacket(app, db, auth)

module.exports = function registerRedpacket(app, db, auth) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('[redpacket] 需要 db.prepare（require("../db")）');
  }
  const prepare = db.prepare;
  const persist = (typeof db.persist === 'function') ? db.persist.bind(db) : (() => {});
  const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
  const jwt = require('jsonwebtoken');

  function apiUser(req) {
    const authH = req.headers.authorization || '';
    try {
      const token = authH.replace(/^Bearer\s+/i, '');
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload && payload.id) return payload;
    } catch (e) {}
    return null;
  }

  // ============ 建表 ============
  function ensureTables() {
    prepare("CREATE TABLE IF NOT EXISTS red_packets (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " sender_id INTEGER NOT NULL,\n" +
      " target_type TEXT NOT NULL DEFAULT 'dm',\n" + // dm | group
      " target_id INTEGER NOT NULL,\n" + // 对方 uid 或 group id
      " total_amount FLOAT NOT NULL,\n" +
      " count INTEGER NOT NULL DEFAULT 1,\n" +
      " remaining_amount FLOAT NOT NULL,\n" +
      " remaining_count INTEGER NOT NULL DEFAULT 0,\n" +
      " mode TEXT NOT NULL DEFAULT 'random',\n" + // random | average | single
      " greeting TEXT,\n" +
      " status TEXT NOT NULL DEFAULT 'active',\n" + // active | finished | expired | refunded
      " msg_id INTEGER,\n" +
      " created_at INTEGER NOT NULL\n)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_redpkt_sender ON red_packets(sender_id)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_redpkt_target ON red_packets(target_type, target_id)").run();

    prepare("CREATE TABLE IF NOT EXISTS red_packet_grabs (\n" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      " packet_id INTEGER NOT NULL,\n" +
      " user_id INTEGER NOT NULL,\n" +
      " amount FLOAT NOT NULL,\n" +
      " created_at INTEGER NOT NULL,\n" +
      " UNIQUE(packet_id, user_id)\n)").run();
    prepare("CREATE INDEX IF NOT EXISTS idx_redpkt_grab_user ON red_packet_grabs(user_id)").run();
  }
  ensureTables();

  function walletOf(uid) {
    let w = prepare('SELECT balance,total_received FROM wallets WHERE user_id=?').get(uid);
    if (!w) {
      prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,0,0,?)').run(uid, Date.now());
      w = prepare('SELECT balance,total_received FROM wallets WHERE user_id=?').get(uid);
    }
    return w;
  }

  // 发送 WS 通知（通过巨石注入，若提供了 sendToUser）
  function notify(toId, payload) {
    const fn = (typeof global.__scSendToUser === 'function') ? global.__scSendToUser : null;
    if (fn) fn(toId, 'msg', payload);
  }

  // ============ 发红包 ============
  // POST /api/redpacket { to, groupId, amount, count, mode, greeting }
  app.post('/api/redpacket', (req, res) => {
    if (!prepare('SELECT 1 FROM red_packets LIMIT 1')) ensureTables();
    const me = apiUser(req);
    if (!me) return res.status(401).json({ error: '未授权' });
    const { to, groupId, amount, count, mode, greeting } = req.body || {};
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: '金额无效' });
    const c = Math.max(1, parseInt(count, 10) || 1);
    if (c > 100) return res.status(400).json({ error: '单个红包最多 100 份' });
    const m = (mode === 'single' || mode === 'average') ? mode : 'random';
    if (m === 'single' && c > 1) return res.status(400).json({ error: '专属红包只能 1 份' });

    let targetType = 'dm', targetId = 0;
    if (groupId) {
      const g = prepare('SELECT id FROM groups WHERE id=?').get(parseInt(groupId, 10));
      if (!g) return res.status(404).json({ error: '群不存在' });
      targetType = 'group'; targetId = g.id;
      // 必须发红包者是群成员
      const member = prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(g.id, me.id);
      if (!member) return res.status(403).json({ error: '你不是该群成员' });
    } else {
      const target = prepare('SELECT id FROM users WHERE id=?').get(parseInt(to, 10));
      if (!target) return res.status(404).json({ error: '对方不存在' });
      if (target.id === me.id) return res.status(400).json({ error: '不能发给自己' });
      targetId = target.id;
    }

    const my = walletOf(me.id);
    if (my.balance < value) return res.status(400).json({ error: '余额不足' });

    // 扣款
    prepare('UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=?').run(value, Date.now(), me.id);

    // 先创建红包记录（msg_id 暂置 0），拿到自增 id 作为消息里的红包标识
    const rp = prepare('INSERT INTO red_packets(sender_id,target_type,target_id,total_amount,count,remaining_amount,remaining_count,mode,greeting,status,msg_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)')
      .run(me.id, targetType, targetId, value, c, value, c, m, (greeting || '恭喜发财，大吉大利！').slice(0, 60), 'active', Date.now());
    const packetId = rp.lastInsertRowid;
    // 消息内容用数字 id（[红包:<id>]），保证前端点击后能命中 red_packets.id 查询
    const msgContent = '[红包:' + packetId + ']';

    // 写消息（单聊进 messages，群聊进 group_messages），再把 msg_id 回写红包记录
    let msgId = null;
    if (targetType === 'dm') {
      const info = prepare('INSERT INTO messages(from_id,to_id,content,created_at) VALUES(?,?,?,?)').run(me.id, targetId, msgContent, Date.now());
      msgId = info.lastInsertRowid;
    } else {
      const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)').run(targetId, me.id, msgContent, Date.now());
      msgId = info.lastInsertRowid;
    }
    prepare('UPDATE red_packets SET msg_id=? WHERE id=?').run(msgId, packetId);

    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)')
      .run(me.id, 'out', value, targetType === 'dm' ? targetId : null, '发红包 ' + (greeting || ''), Date.now());
    persist();

    // WS 通知
    try {
      if (targetType === 'dm') {
        sendToUserNotify(targetId, me.id, msgContent, msgId, 'dm');
      } else {
        sendToGroupNotify(targetId, me.id, msgContent, msgId);
      }
    } catch (e) {}

    res.json({ ok: true, packetId, msgId, balance: walletOf(me.id).balance });
  });

  // ============ 抢红包 ============
  // POST /api/redpacket/:id/grab
  app.post('/api/redpacket/:id/grab', (req, res) => {
    const me = apiUser(req);
    if (!me) return res.status(401).json({ error: '未授权' });
    const id = parseInt(req.params.id, 10);
    const pkt = prepare('SELECT * FROM red_packets WHERE id=?').get(id);
    if (!pkt) return res.status(404).json({ error: '红包不存在' });

    // 自己不能领自己的红包
    if (pkt.sender_id === me.id) {
      return res.status(400).json({ error: '不能领取自己的红包' });
    }

    // 权限校验
    if (pkt.target_type === 'dm' && pkt.target_id !== me.id && pkt.sender_id !== me.id) {
      return res.status(403).json({ error: '这不是发给你的红包' });
    }
    if (pkt.target_type === 'group') {
      const member = prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(pkt.target_id, me.id);
      if (!member) return res.status(403).json({ error: '你不是该群成员' });
    }

    // 已经抢过
    const already = prepare('SELECT * FROM red_packet_grabs WHERE packet_id=? AND user_id=?').get(id, me.id);
    if (already) {
      return res.json({ ok: true, already: true, amount: already.amount, myAmount: already.amount, balance: walletOf(me.id).balance });
    }

    if (pkt.status !== 'active') {
      return res.status(400).json({ error: pkt.status === 'finished' ? '红包已被抢完' : '红包已过期' });
    }
    if (pkt.remaining_count <= 0) return res.status(400).json({ error: '红包已被抢完' });

    let amount;
    if (pkt.mode === 'average') {
      // 均分（最后一份取剩余）
      amount = (pkt.remaining_count === 1) ? pkt.remaining_amount : Math.floor(pkt.remaining_amount / pkt.remaining_count * 100) / 100;
    } else if (pkt.mode === 'single') {
      amount = pkt.total_amount;
    } else {
      // 随机拼手气：最后一份取剩余；否则 1 分到 剩余均值*2 之间
      if (pkt.remaining_count === 1) {
        amount = pkt.remaining_amount;
      } else {
        const avg = pkt.remaining_amount / pkt.remaining_count;
        const max = Math.min(pkt.remaining_amount - 0.01, avg * 2);
        const min = 0.01;
        amount = Math.floor((Math.random() * (max - min) + min) * 100) / 100;
        // 保证每人至少 1 分
        if (amount < 0.01) amount = 0.01;
        amount = Math.round(amount * 100) / 100;
      }
    }
    amount = Math.round(amount * 100) / 100;
    if (amount > pkt.remaining_amount) amount = pkt.remaining_amount;

    const dec = prepare('UPDATE red_packets SET remaining_count=remaining_count-1 WHERE id=? AND remaining_count>0 AND status=?').run(id, 'active');
    if (!dec.changes) return res.status(400).json({ error: '红包已被抢完' });
    try {
      prepare('INSERT INTO red_packet_grabs(packet_id,user_id,amount,created_at) VALUES(?,?,?,?)').run(id, me.id, amount, Date.now());
    } catch (e) {
      prepare('UPDATE red_packets SET remaining_count=remaining_count+1 WHERE id=?').run(id);
      if (String(e && e.message || e).includes('UNIQUE')) {
        const g = prepare('SELECT * FROM red_packet_grabs WHERE packet_id=? AND user_id=?').get(id, me.id);
        return res.json({ ok: true, already: true, amount: g ? g.amount : 0, myAmount: g ? g.amount : 0, balance: walletOf(me.id).balance });
      }
      throw e;
    }
    prepare('UPDATE red_packets SET remaining_amount=?,remaining_count=?,status=? WHERE id=?')
      .run(Math.round((pkt.remaining_amount - amount) * 100) / 100, pkt.remaining_count - 1, (pkt.remaining_count - 1 <= 0) ? 'finished' : 'active', id);

    // 入账
    prepare('INSERT OR IGNORE INTO wallets(user_id,balance,total_received,updated_at) VALUES(?,?,?,?)').run(me.id, 0, 0, Date.now());
    prepare('UPDATE wallets SET balance=balance+?,total_received=total_received+?,updated_at=? WHERE user_id=?').run(amount, amount, Date.now(), me.id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)')
      .run(me.id, 'in', amount, pkt.sender_id, '抢到红包', Date.now());
    persist();

    res.json({ ok: true, amount, myAmount: amount, balance: walletOf(me.id).balance });
  });

  // ============ 红包详情 ============
  // GET /api/redpacket/:id
  app.get('/api/redpacket/:id', (req, res) => {
    const me = apiUser(req);
    if (!me) return res.status(401).json({ error: '未授权' });
    const id = parseInt(req.params.id, 10);
    const pkt = prepare('SELECT * FROM red_packets WHERE id=?').get(id);
    if (!pkt) return res.status(404).json({ error: '红包不存在' });
    const sender = prepare('SELECT id,nickname,uid,avatar FROM users WHERE id=?').get(pkt.sender_id);
    const grabs = prepare('SELECT user_id,amount,created_at FROM red_packet_grabs WHERE packet_id=? ORDER BY created_at ASC').all(id);
    const grabUsers = {};
    for (const g of grabs) {
      const u = prepare('SELECT id,nickname,uid,avatar FROM users WHERE id=?').get(g.user_id);
      grabUsers[g.user_id] = u || { id: g.user_id };
    }
    // 是否可看具体金额：自己发的或已抢过的可看
    const mine = prepare('SELECT amount FROM red_packet_grabs WHERE packet_id=? AND user_id=?').get(id, me.id);
    res.json({
      id: pkt.id,
      sender: sender ? { id: sender.id, nickname: sender.nickname, uid: sender.uid, avatar: sender.avatar } : { id: pkt.sender_id },
      targetType: pkt.target_type,
      totalAmount: pkt.total_amount,
      count: pkt.count,
      remainingAmount: pkt.remaining_amount,
      remainingCount: pkt.remaining_count,
      mode: pkt.mode,
      greeting: pkt.greeting,
      status: pkt.status,
      createdAt: pkt.created_at,
      canViewAmount: (pkt.sender_id === me.id || !!mine),
      myAmount: mine ? mine.amount : null,
      grabbedByMe: !!mine,
      grabs: grabUsers,
    });
  });

  // ============ 退回过期红包 ============
  // POST /api/redpacket/:id/refund （发送者可手动退回未抢完的）
  app.post('/api/redpacket/:id/refund', (req, res) => {
    const me = apiUser(req);
    if (!me) return res.status(401).json({ error: '未授权' });
    const id = parseInt(req.params.id, 10);
    const pkt = prepare('SELECT * FROM red_packets WHERE id=?').get(id);
    if (!pkt) return res.status(404).json({ error: '红包不存在' });
    if (pkt.sender_id !== me.id) return res.status(403).json({ error: '只能退回自己发的红包' });
    if (pkt.status !== 'active' || pkt.remaining_count <= 0) return res.status(400).json({ error: '红包已抢完或已退回' });
    const refund = pkt.remaining_amount;
    prepare('UPDATE wallets SET balance=balance+?,updated_at=? WHERE user_id=?').run(refund, Date.now(), me.id);
    prepare('UPDATE red_packets SET status=?,remaining_amount=?,remaining_count=? WHERE id=?').run('refunded', 0, 0, id);
    prepare('INSERT INTO wallet_txn(user_id,kind,amount,peer_id,remark,created_at) VALUES(?,?,?,?,?,?)')
      .run(me.id, 'in', refund, null, '退回红包', Date.now());
    persist();
    res.json({ ok: true, refund, balance: walletOf(me.id).balance });
  });

  // WS 通知辅助
  function sendToUserNotify(toUid, fromId, content, msgId, type) {
    const fn = (typeof global.__scSendToUser === 'function') ? global.__scSendToUser : null;
    if (fn) fn(toUid, 'msg', { id: msgId, from: fromId, to: toUid, content, createdAt: Date.now() });
  }
  function sendToGroupNotify(groupId, fromId, content, msgId) {
    const fn = (typeof global.__scSendToUser === 'function') ? global.__scSendToUser : null;
    if (fn) {
      // 通知所有成员（通过 index.js 的在线用户表转发，简化：这里用全局在线兜底）
      try {
        const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
        for (const m of members) {
          if (m.user_id === fromId) continue;
          fn(m.user_id, 'group_msg', { id: msgId, groupId, from: fromId, content, createdAt: Date.now() });
        }
      } catch (e) {}
    }
  }
};