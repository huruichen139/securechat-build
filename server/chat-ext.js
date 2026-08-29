'use strict';
// module: chat-ext (worker batch2)
// 聊天增强（表情/拍一拍/引用/转发/合并转发/撤回）
// 用法：registerChatExt(app, db, auth)
//   app  - express 实例
//   db   - db.js 模块（提供 prepare/persist/persistNow），或直接传入 prepare 函数
//   auth - 可选辅助对象 { sendToUser, onlineAny, P }（挂载时由巨石文件传入）；
//          缺省时本模块自带兜底实现（embedded sendToUser/onlineAny），仅用于独立运行。
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

function resolvePrepare(input) {
  // 兼容 db 模块或直接传入 prepare 函数
  if (typeof input === 'function') return input;
  if (input && typeof input.prepare === 'function') return input.prepare.bind(input);
  if (input && typeof input.getDb === 'function') return null;
  throw new Error('[chat-ext] 无法解析 db，请传入 db.js 模块或 prepare()');
}

const RECALL_WINDOW_MS = 2 * 60 * 1000; // 撤回限 2 分钟

module.exports = function registerChatExt(app, db, auth) {
  const prepare = resolvePrepare(db);
  const helpers = auth || {};
  const P = helpers.P || {
    S_MSG: 'msg',
    S_POKE: 'poke',
    S_GROUP_MSG: 'group_msg'
  };
  // 兜底推送（挂载时传入真实现；缺省仅返回 false，不推送）
  const onlineAny = helpers.onlineAny || (() => false);
  const sendToUser = helpers.sendToUser || (() => {});

  // 确保增强元数据表存在（幂等）
  try {
    prepare(`
      CREATE TABLE IF NOT EXISTS chat_ext (
        message_id INTEGER NOT NULL,
        owner_id   INTEGER NOT NULL DEFAULT 0,   -- 0=对该消息双方均可见（合并转发卡片）；否则写入方
        kind       TEXT NOT NULL,                -- emoji | quote | forward | merged | system
        value      TEXT,                         -- JSON 字符串 / 文本
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(message_id, owner_id, kind)
      );
    `).run();
  } catch (e) { /* 已存在或锁，忽略 */ }

  function parseJson(s, fallback) {
    try { const v = JSON.parse(s); return (v === null || v === undefined) ? fallback : v; } catch { return fallback; }
  }

  function apiUser(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
  }

  function publicName(userId) {
    const u = prepare('SELECT nickname,username FROM users WHERE id=?').get(userId);
    return u ? (u.nickname || u.username || '用户') : '用户';
  }

  // 群消息实时分发：发给群内所有在线成员（含发送者）。群 ID 不是用户 ID，
  // 不能直接传给 sendToUser；必须遍历 group_members。
  function broadcastGroup(groupId, out) {
    try {
      const members = prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
      const fromUser = prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(out.from) || { nickname: publicName(out.from) };
      for (const m of members) {
        if (onlineAny(m.user_id)) sendToUser(m.user_id, P.S_GROUP_MSG, { ...out, fromUser });
      }
    } catch (e) { /* 群不存在或推送失败，落库不受影响 */ }
  }

  // 校验转发目标数组结构：[{ id, kind:'friend'|'group' }]，去重返回有效列表
  function normalizeTargets(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const id = Number(it.id);
      const kind = it.kind === 'group' ? 'group' : 'friend';
      if (!Number.isInteger(id) || id <= 0) continue;
      const sig = kind + ':' + id;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ id, kind });
    }
    return out;
  }

  // 校验 friend/group 目标合法且有效；群目标要求转发者是群成员，好友目标要求双方未拉黑
  function isBlockedEither(a, b) {
    try { return !!prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a); } catch (e) { return false; }
  }
  function isGroupMember(gid, uid) {
    try { return !!prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid, uid); } catch (e) { return false; }
  }
  function isValidTarget(t, userId) {
    if (t.kind === 'group') {
      const exists = prepare('SELECT id FROM groups WHERE id=?').get(t.id);
      return !!exists && isGroupMember(t.id, userId);
    }
    if (t.id === userId) return false; // 不能转发给自己
    const exists = prepare('SELECT id FROM users WHERE id=?').get(t.id);
    return !!exists && !isBlockedEither(t.id, userId);
  }

  // 取得某条私聊消息（必须与当前用户相关）
  function messageForUser(id, userId) {
    return prepare('SELECT * FROM messages WHERE id=? AND (from_id=? OR to_id=?)')
      .get(id, userId, userId) || null;
  }

  // 取得某条群消息（必须是群成员）
  function groupMessageForUser(gmId, userId) {
    const row = prepare(`
      SELECT gm.*, g.name AS groupName
      FROM group_messages gm
      JOIN group_members m ON m.group_id = gm.group_id AND m.user_id=?
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.id=?
    `).get(userId, gmId);
    return row || null;
  }

  // 写入一条私聊消息（含增强元数据）
  function insertMessage(fromId, toId, content, extra, opts) {
    const now = Date.now();
    const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
      .run(fromId, toId, content, (opts && opts.clientMsgId) || null, now);
    const mid = info.lastInsertRowid;
    // message_meta：转发来源
    if (extra.forwardedFrom) {
      try {
        prepare(`INSERT INTO message_meta(message_id,reply_to,forwarded_from,burn_after_reading,pinned,updated_at)
          VALUES(?,NULL,?,0,0,?)`).run(mid, Number(extra.forwardedFrom) || null, now);
      } catch (e) {}
    }
    return { id: mid, from_id: fromId, to_id: toId, content, created_at: now };
  }

  // 给某个私聊目标投递（写入 + 在线推送）
  function deliverToFriend(fromId, toId, content, extra, sourceMsg) {
    const msg = insertMessage(fromId, toId, content, extra);
    if (extra.kind) {
      const value = {
        kind: extra.kind,
        fromName: publicName(fromId),
        from: sourceMsg ? sourceMsg.from_id : fromId,
        sourceMessageId: sourceMsg ? sourceMsg.id : null,
        content: extra.quoteText || null,
        mergedAt: extra.mergedAt || null
      };
      try {
        prepare('INSERT OR REPLACE INTO chat_ext(message_id,owner_id,kind,value,updated_at) VALUES(?,?,?,?,?)')
          .run(msg.id, 0, extra.kind, JSON.stringify(value), Date.now());
      } catch (e) {}
    }
    const out = {
      id: msg.id, from: fromId, to: toId, content, createdAt: msg.created_at,
      replyTo: null, forwardedFrom: extra.forwardedFrom || null,
      kind: extra.kind || null, extra: extra
    };
    if (onlineAny(toId)) sendToUser(toId, P.S_MSG, out);
    return out;
  }

  // =====================================================================
  // 撤回：POST /api/messages/:id/recall   （限 2 分钟内、必须是本人所发）
  // =====================================================================
  app.post('/api/messages/:id/recall', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const id = Number(req.params.id);
    const msg = prepare('SELECT * FROM messages WHERE id=? AND from_id=?').get(id, payload.id);
    if (!msg) return res.status(404).json({ error: '消息不存在或无权撤回' });
    if (Date.now() - msg.created_at > RECALL_WINDOW_MS) {
      return res.status(403).json({ error: '超过 2 分钟，无法撤回' });
    }
    const recalled = '[系统]消息已撤回';
    prepare('UPDATE messages SET content=? WHERE id=?').run(recalled, id);
    const out = { id, from: msg.from_id, to: msg.to_id, content: recalled, createdAt: msg.created_at, recalled: true, replyTo: null, forwardedFrom: null };
    const peerId = msg.from_id === payload.id ? msg.to_id : msg.from_id;
    if (onlineAny(peerId)) sendToUser(peerId, P.S_MSG, out);
    res.json({ ok: true, message: out });
  });

  // =====================================================================
  // 单条转发：POST /api/messages/:id/forward  { targets:[{id,kind}], note }
  // =====================================================================
  app.post('/api/messages/:id/forward', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const id = Number(req.params.id);
    const targets = normalizeTargets(req.body && req.body.targets).slice(0, 50);
    if (!targets.length) return res.status(400).json({ error: '转发目标不能为空' });
    const srcMsg = messageForUser(id, payload.id);
    if (!srcMsg) return res.status(404).json({ error: '消息不存在' });
    // 保留原文（若原文是系统/语音等特殊消息则按原文转发）
    const content = srcMsg.content || '[转发消息]';
    const results = [];
    for (const t of targets) {
      if (!isValidTarget(t, payload.id)) continue;
      if (t.kind === 'group') {
        const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)')
          .run(t.id, payload.id, content, Date.now());
        try {
          prepare('INSERT OR REPLACE INTO chat_ext(message_id,owner_id,kind,value,updated_at) VALUES(?,?,?,?,?)')
            .run(info.lastInsertRowid, 0, 'forward', JSON.stringify({ kind: 'forward', fromName: publicName(payload.id), from: srcMsg.from_id, sourceMessageId: id, content: srcMsg.content }), Date.now());
        } catch (e) {}
        const out = { id: info.lastInsertRowid, groupId: t.id, from: payload.id, content, kind: 'forward', fromUser: { nickname: publicName(payload.id) } };
        broadcastGroup(t.id, out);
        results.push(out);
      } else {
        const out = deliverToFriend(payload.id, t.id, content, { kind: 'forward', forwardedFrom: id }, srcMsg);
        results.push(out);
      }
    }
    res.json({ ok: true, forwarded: results });
  });

  // =====================================================================
  // 批量/合并转发：POST /api/messages/forward { messageIds:[...], targets:[{id,kind}], merge:bool, note }
  // =====================================================================
  app.post('/api/messages/forward', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const body = req.body || {};
    const ids = Array.isArray(body.messageIds) ? body.messageIds.map(Number).filter(Number.isInteger).slice(0, 100) : [];
    const targets = normalizeTargets(body.targets).slice(0, 50);
    const merge = body.merge === true;
    if (!ids.length) return res.status(400).json({ error: '请选择要转发的消息' });
    if (!targets.length) return res.status(400).json({ error: '转发目标不能为空' });

    // 校验全部消息可用
    const src = [];
    for (const mid of ids) {
      const friendMsg = messageForUser(mid, payload.id);
      if (friendMsg) src.push({ kind: 'friend', msg: friendMsg });
      else {
        const gm = groupMessageForUser(mid, payload.id);
        if (gm) src.push({ kind: 'group', msg: gm });
      }
    }
    if (!src.length) return res.status(404).json({ error: '没有可转发的消息' });

    const results = [];
    if (merge) {
      // 合并转发：所有源打包成一个卡片，写入每个目标一条消息
      const cards = src.map(item => {
        const m = item.msg;
        return {
          kind: item.kind,
          id: m.id,
          fromId: m.from_id,
          fromName: item.kind === 'group'
            ? publicName(m.group_id && m.from_id || m.from_id)
            : publicName(m.from_id),
          content: m.content,
          createdAt: m.created_at
        };
      });
      const merged = {
        type: 'merged',
        count: cards.length,
        items: cards,
        note: typeof body.note === 'string' ? body.note.slice(0, 120) : ''
      };
      const content = '[合并转发]\n' + JSON.stringify(merged);
      for (const t of targets) {
        if (!isValidTarget(t, payload.id)) continue;
        if (t.kind === 'group') {
          const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)')
            .run(t.id, payload.id, content, Date.now());
          try {
            prepare('INSERT OR REPLACE INTO chat_ext(message_id,owner_id,kind,value,updated_at) VALUES(?,?,?,?,?)')
              .run(info.lastInsertRowid, 0, 'merged', JSON.stringify(merged), Date.now());
          } catch (e) {}
          const out = { id: info.lastInsertRowid, groupId: t.id, from: payload.id, content, kind: 'merged', fromUser: { nickname: publicName(payload.id) } };
          broadcastGroup(t.id, out);
          results.push(out);
        } else {
          const out = deliverToFriend(payload.id, t.id, content, { kind: 'merged', mergePayload: merged }, null);
          results.push(out);
        }
      }
    } else {
      // 逐条转发到每个目标
      for (const item of src) {
        const m = item.msg;
        const content = m.content || '[转发消息]';
        for (const t of targets) {
          if (!isValidTarget(t, payload.id)) continue;
          if (t.kind === 'group') {
            const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)')
              .run(t.id, payload.id, content, Date.now());
            try {
              prepare('INSERT OR REPLACE INTO chat_ext(message_id,owner_id,kind,value,updated_at) VALUES(?,?,?,?,?)')
                .run(info.lastInsertRowid, 0, 'forward', JSON.stringify({ kind: 'forward', fromName: publicName(payload.id), from: m.from_id, sourceMessageId: m.id }), Date.now());
            } catch (e) {}
            results.push({ id: info.lastInsertRowid, groupId: t.id, from: payload.id, content, kind: 'forward' });
            broadcastGroup(t.id, { id: info.lastInsertRowid, groupId: t.id, from: payload.id, content });
          } else {
            const out = deliverToFriend(payload.id, t.id, content, { kind: 'forward', forwardedFrom: m.id }, m);
            results.push(out);
          }
        }
      }
    }
    res.json({ ok: true, merge, forwarded: results, count: results.length });
  });

  // =====================================================================
  // 拍一拍 → 写成一条 type=poke 系统消息（对方端振动/提示）：POST /api/messages/:id/poke { to }
  // =====================================================================
  app.post('/api/messages/:id/poke', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const id = Number(req.params.id);
    const to = Number((req.body || {}).to);
    if (!Number.isInteger(to) || !prepare('SELECT id FROM users WHERE id=?').get(to)) {
      return res.status(404).json({ error: '拍一拍对象不存在' });
    }
    if (to === payload.id) return res.status(400).json({ error: '不能拍自己' });
    if (isBlockedEither(to, payload.id)) return res.status(403).json({ error: '无法拍一拍（黑名单）' });
    // 校验该消息属于当前会话（from 或 to 之一是当前用户，且另一端是目标）
    if (id) {
      const msg = messageForUser(id, payload.id);
      if (!msg) return res.status(404).json({ error: '消息不存在' });
      const otherId = msg.from_id === payload.id ? msg.to_id : msg.from_id;
      if (otherId !== to && !(msg.from_id === to || msg.to_id === to)) {
        return res.status(403).json({ error: '拍一拍目标与消息不对应' });
      }
    }
    const me = publicName(payload.id);
    const content = '[系统]' + me + '拍了拍你';
    const now = Date.now();
    const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
      .run(payload.id, to, content, null, now);
    const mid = info.lastInsertRowid;
    try {
      prepare('INSERT OR REPLACE INTO chat_ext(message_id,owner_id,kind,value,updated_at) VALUES(?,?,?,?,?)')
        .run(mid, 0, 'pok', JSON.stringify({ kind: 'poke', fromId: payload.id, fromNick: me, at: now }), now);
    } catch (e) {}
    const sysMsg = { id: mid, from: payload.id, to, content, createdAt: now, type: 'poke', fromNick: me, kind: 'poke' };
    // 推送系统消息 + poke 信号（客户端据此振动/提示）
    if (onlineAny(to)) {
      sendToUser(to, P.S_MSG, { id: mid, from: payload.id, to, content, createdAt: now, replyTo: null, forwardedFrom: null, kind: 'poke' });
      if (P.S_POKE) sendToUser(to, P.S_POKE, { fromId: payload.id, fromNick: me, messageId: mid, at: now });
    }
    res.json({ ok: true, message: sysMsg });
  });

  // =====================================================================
  // 取某条消息的增强数据：GET /api/messages/:id/ext
  // 返回该消息关联的 emoji/quote/forward/merged 元数据（双方可见，owner_id=0）
  // =====================================================================
  app.get('/api/messages/:id/ext', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const id = Number(req.params.id);
    const rows = prepare('SELECT kind,value,updated_at AS updatedAt FROM chat_ext WHERE message_id=? AND (owner_id=? OR owner_id=0)')
      .all(id, payload.id);
    res.json({ id, ext: rows.map(r => ({ kind: r.kind, value: parseJson(r.value, {}), updatedAt: r.updatedAt })) });
  });

  // =====================================================================
  // 聊天背景（可选服务端备份；主要按硬性要求在前端本地存储）：
  //   POST /api/chat-ext/bg { peerId, kind:'color'|'image', value, opacity? }
  // =====================================================================
  app.post('/api/chat-ext/bg', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const peerId = Number((req.body || {}).peerId);
    if (!Number.isInteger(peerId)) return res.status(400).json({ error: '联系人无效' });
    const kind = (req.body || {}).kind === 'image' ? 'image' : 'color';
    const value = String((req.body || {}).value || '').slice(0, 4096);
    const opacity = Math.min(Math.max(Number((req.body || {}).opacity) || 1, 0), 1);
    try {
      prepare('CREATE TABLE IF NOT EXISTS chat_bg(user_id INTEGER NOT NULL, peer_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT, opacity REAL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, peer_id))').run();
    } catch (e) {}
    prepare(`INSERT INTO chat_bg(user_id,peer_id,kind,value,opacity,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,peer_id) DO UPDATE SET kind=excluded.kind,value=excluded.value,opacity=excluded.opacity,updated_at=excluded.updated_at`)
      .run(payload.id, peerId, kind, value, opacity, Date.now());
    res.json({ ok: true, peerId, kind, opacity });
  });
  app.get('/api/chat-ext/bg', (req, res) => {
    const payload = apiUser(req); if (!payload) return res.status(401).json({ error: '未授权' });
    const peerId = req.query.peer ? Number(req.query.peer) : null;
    let rows;
    if (Number.isInteger(peerId)) {
      rows = prepare('SELECT peer_id AS peerId,kind,value,opacity,updated_at AS updatedAt FROM chat_bg WHERE user_id=? AND peer_id=?').all(payload.id, peerId);
    } else {
      rows = prepare('SELECT peer_id AS peerId,kind,value,opacity,updated_at AS updatedAt FROM chat_bg WHERE user_id=?').all(payload.id);
    }
    res.json({ bg: rows });
  });
};

// 预留：合并转发用即席写入逻辑，无独立辅助函数。