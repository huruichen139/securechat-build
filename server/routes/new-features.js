'use strict';
// routes/new-features.js —— 消息翻译/快捷回复/定时发送/群投票/群待办/阅后即焚
const P = require('../../shared/protocol');

module.exports = function register(app, db, auth) {
  // 认证中间件
  const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (!payload || !payload.id) return res.status(401).json({ error: '未授权' });
      req.user = payload;
      try {
        const u = require('../db').prepare('SELECT token_version, banned FROM users WHERE id=?').get(payload.id);
        if (!u || u.banned) return res.status(403).json({ error: '账号不可用' });
        if ((payload.tv || 0) !== (u.token_version || 0)) return res.status(401).json({ error: '登录已失效' });
      } catch (e) {}
      next();
    } catch (e) {
      res.status(401).json({ error: '未授权' });
    }
  };

  // 转写限流（内存级，5 次/分钟）
  const _sttHits = new Map();
  function _sttLimited(uid) {
    const now = Date.now();
    const arr = (_sttHits.get(uid) || []).filter(t => now - t < 60000);
    if (arr.length >= 5) { _sttHits.set(uid, arr); return true; }
    arr.push(now); _sttHits.set(uid, arr);
    return false;
  }

  // ========== 消息翻译 ==========
  // 归属校验：翻译记录挂在 message_id 上，若不校验，任何人都能读别人消息的译文，
  // 也能把自己编造的文本写成某条消息的"官方翻译"（误导对方）。
  function canAccessMessage(userId, messageId) {
    const mid = Number(messageId);
    if (!Number.isInteger(mid) || mid <= 0) return false;
    const dm = db.prepare('SELECT 1 FROM messages WHERE id=? AND (from_id=? OR to_id=?)').get(mid, userId, userId);
    if (dm) return true;
    const gm = db.prepare('SELECT 1 FROM group_messages WHERE id=?').get(mid);
    if (!gm) return false;
    return !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gm.group_id, userId);
  }

  app.post('/api/message/translate', requireAuth, (req, res) => {
    const { messageId, sourceLang, targetLang, text } = req.body || {};
    const target = targetLang || 'zh';
    if (messageId) {
      if (!canAccessMessage(req.user.id, messageId)) return res.status(403).json({ error: '无权访问该消息' });
    } else if (!text) {
      return res.status(400).json({ error: '参数缺失' });
    }
    try {
      // 有 messageId 时以库内原文为准，忽略客户端传入的 text（防止伪造译文）
      let source = text;
      if (messageId) {
        const mid = Number(messageId);
        const row = db.prepare('SELECT content FROM messages WHERE id=?').get(mid)
          || db.prepare('SELECT content FROM group_messages WHERE id=?').get(mid);
        source = (row && row.content) || '';
      }
      if (!source) return res.status(400).json({ error: '消息内容为空' });
      const translated = mockTranslate(source, sourceLang, target);
      if (messageId) {
        db.run(
          'INSERT OR REPLACE INTO message_translations(message_id, source_lang, target_lang, translated, translated_by, created_at) VALUES(?,?,?,?,?,?)',
          [messageId, sourceLang || 'auto', target, translated, req.user.id, Date.now()]
        );
      }
      res.json({ success: true, translated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/message/translations/:messageId', requireAuth, (req, res) => {
    if (!canAccessMessage(req.user.id, req.params.messageId)) return res.status(403).json({ error: '无权访问该消息' });
    const rows = db.prepare('SELECT * FROM message_translations WHERE message_id=?').all(req.params.messageId);
    res.json({ translations: rows });
  });

  // ========== 快捷回复 ==========
  app.get('/api/quick-replies', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM quick_replies WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id);
    res.json({ replies: rows });
  });

  app.post('/api/quick-replies', requireAuth, (req, res) => {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
    if (typeof title !== 'string' || title.trim().length > 50) return res.status(400).json({ error: '标题需1-50字符' });
    if (typeof content !== 'string' || content.trim().length > 500) return res.status(400).json({ error: '内容需1-500字符' });
    if (db.prepare('SELECT COUNT(*) AS c FROM quick_replies WHERE user_id=?').get(req.user.id).c >= 50) return res.status(429).json({ error: '快捷回复已满（50条）' });
    const now = Date.now();
    db.run('INSERT INTO quick_replies(user_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?)',
      [req.user.id, title, content, now, now]);
    res.json({ success: true });
  });

  app.put('/api/quick-replies/:id', requireAuth, (req, res) => {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
    db.run('UPDATE quick_replies SET title=?, content=?, updated_at=? WHERE id=? AND user_id=?',
      [title, content, Date.now(), req.params.id, req.user.id]);
    res.json({ success: true });
  });

  app.delete('/api/quick-replies/:id', requireAuth, (req, res) => {
    db.run('DELETE FROM quick_replies WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success: true });
  });

  // ========== 定时发送 ==========
  app.get('/api/scheduled-messages', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM scheduled_messages WHERE user_id=? AND cancelled=0 ORDER BY scheduled_at ASC').all(req.user.id);
    res.json({ messages: rows });
  });

  app.post('/api/scheduled-messages', requireAuth, (req, res) => {
    const { peerId, isGroup, content, kind, scheduledAt } = req.body || {};
    if (!peerId || !scheduledAt || !content) return res.status(400).json({ error: '参数缺失' });
    if (typeof content !== 'string' || !content.trim() || content.length > 4000) return res.status(400).json({ error: '内容长度需1-4000字符' });
    const at = Number(scheduledAt);
    const now = Date.now();
    if (!Number.isFinite(at) || at < now - 60 * 1000 || at > now + 30 * 24 * 3600 * 1000) return res.status(400).json({ error: '定时时间无效（需在未来30天内）' });
    if (db.prepare('SELECT COUNT(*) AS c FROM scheduled_messages WHERE user_id=? AND cancelled=0 AND sent_at IS NULL').get(req.user.id).c >= 20) return res.status(429).json({ error: '待发送定时消息已满（20条）' });
    const targetId = Number(peerId);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: '对象无效' });
    if (isGroup) {
      if (!memberOf(targetId, req.user.id)) return res.status(403).json({ error: '你不在此群' });
    } else if (!db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=1').get(req.user.id, targetId)) {
      return res.status(403).json({ error: '只能定时发送给好友' });
    }
    db.run(
      'INSERT INTO scheduled_messages(user_id, peer_id, is_group, content, kind, scheduled_at, created_at) VALUES(?,?,?,?,?,?,?)',
      [req.user.id, targetId, isGroup ? 1 : 0, content, kind || 'text', at, Date.now()]
    );
    res.json({ success: true });
  });

  app.delete('/api/scheduled-messages/:id', requireAuth, (req, res) => {
    db.run('UPDATE scheduled_messages SET cancelled=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success: true });
  });

  // ========== 群投票 ==========
  function memberOf(groupId, userId) {
    return !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId);
  }

  app.post('/api/groups/votes', requireAuth, (req, res) => {
    const { groupId, title, content, options, isAnonymous, allowChange } = req.body || {};
    if (!groupId || !title) return res.status(400).json({ error: '群ID和标题不能为空' });
    if (!memberOf(groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    const now = Date.now();
    // db.run 是 sql.js 原生 run（返回 Database 对象，不带 lastInsertRowid），
    // 原来直接取 result.lastInsertRowid 得到 undefined，导致后续插入选项时绑定 undefined 报 500。
    db.run('INSERT INTO group_votes(group_id, title, content, created_by, is_anonymous, allow_change, created_at) VALUES(?,?,?,?,?,?,?)',
      [groupId, title, content || '', req.user.id, isAnonymous ? 1 : 0, allowChange ? 1 : 0, now]);
    let voteId = 0;
    try {
      const r = db.exec('SELECT last_insert_rowid() AS id');
      voteId = (r && r.length && r[0].values.length) ? r[0].values[0][0] : 0;
    } catch (e) {}
    if (!voteId) return res.status(500).json({ error: '创建投票失败' });
    if (Array.isArray(options)) {
      // created_at 是 NOT NULL 且无默认值：原插入语句漏了该列，建投票直接 500。
      options.slice(0, 50).forEach((opt, idx) => {
        const text = String(opt?.text || opt || '').trim().slice(0, 200);
        if (text) db.run('INSERT INTO vote_options(vote_id, text, order_index, created_at) VALUES(?,?,?,?)', [voteId, text, idx, now]);
      });
    }
    res.json({ success: true, voteId });
  });

  app.get('/api/groups/votes/:groupId', requireAuth, (req, res) => {
    if (!memberOf(req.params.groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    const votes = db.prepare('SELECT * FROM group_votes WHERE group_id=? ORDER BY created_at DESC').all(req.params.groupId);
    const options = [];
    for (const v of votes) {
      const opts = db.prepare('SELECT * FROM vote_options WHERE vote_id=? ORDER BY order_index').all(v.id);
      const voteData = { ...v, options: opts };
      // 统计票数
      for (const opt of opts) {
        // 原先返回的是 {cnt:n} 对象，客户端按数字渲染会显示 [object Object]
        const c = db.prepare('SELECT COUNT(*) as cnt FROM vote_votes WHERE option_id=?').get(opt.id);
        opt.votes = (c && c.cnt) || 0;
      }
      options.push(voteData);
    }
    res.json({ votes: options });
  });

  app.post('/api/groups/votes/:voteId/vote', requireAuth, (req, res) => {
    // 原写法 `const { optionIds } = req.body || []`：body 为数组/为空时解构出 undefined，
    // 且未去重、未限数量 —— 重复 id 会重复插行把票数刷高（旧表主键还会直接 500）。
    const body = req.body || {};
    const raw = Array.isArray(body.optionIds) ? body.optionIds : [];
    const optionIds = Array.from(new Set(raw.map(v => Number(v)).filter(Number.isInteger)));
    if (!optionIds.length) return res.status(400).json({ error: '请选择投票选项' });
    if (optionIds.length > 50) return res.status(400).json({ error: '最多选择 50 个选项' });
    const vote = db.prepare('SELECT * FROM group_votes WHERE id=?').get(req.params.voteId);
    if (!vote) return res.status(404).json({ error: '投票不存在' });
    if (!memberOf(vote.group_id, req.user.id)) return res.status(403).json({ error: '非群成员' });
    if (vote.ended) return res.status(400).json({ error: '投票已结束' });
    const optRows = db.prepare('SELECT id FROM vote_options WHERE vote_id=?').all(vote.id);
    const validOptIds = new Set(optRows.map(o => o.id));
    for (const oid of optionIds) { if (!validOptIds.has(oid)) return res.status(400).json({ error: '包含无效选项' }); }
    if (!vote.allow_change) {
      const existing = db.prepare('SELECT * FROM vote_votes WHERE vote_id=? AND user_id=?').get(vote.id, req.user.id);
      if (existing) return res.status(400).json({ error: '已投票，不可重复' });
    }
    // 删除旧投票
    db.run('DELETE FROM vote_votes WHERE vote_id=? AND user_id=?', [vote.id, req.user.id]);
    // 插入新投票
    for (const optId of optionIds) {
      db.run('INSERT OR IGNORE INTO vote_votes(vote_id, user_id, option_id, created_at) VALUES(?,?,?,?)',
        [vote.id, req.user.id, optId, Date.now()]);
    }
    res.json({ success: true, selected: optionIds.length });
  });

  app.post('/api/groups/votes/:voteId/end', requireAuth, (req, res) => {
    const vote = db.prepare('SELECT * FROM group_votes WHERE id=? AND created_by=?').get(req.params.voteId, req.user.id);
    if (!vote) return res.status(403).json({ error: '无权操作' });
    db.run('UPDATE group_votes SET ended=1, ended_at=? WHERE id=?', [Date.now(), req.params.voteId]);
    res.json({ success: true });
  });

  // ========== 群待办 ==========
  app.post('/api/groups/todos', requireAuth, (req, res) => {
    const { groupId, title, description, assignedTo, dueAt } = req.body || {};
    if (!groupId || !title) return res.status(400).json({ error: '群ID和标题不能为空' });
    if (!memberOf(groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    db.run(
      'INSERT INTO group_todos(group_id, title, description, created_by, assigned_to, due_at, created_at) VALUES(?,?,?,?,?,?,?)',
      [groupId, title, description || '', req.user.id, assignedTo || null, dueAt || null, Date.now()]
    );
    res.json({ success: true });
  });

  app.get('/api/groups/todos/:groupId', requireAuth, (req, res) => {
    if (!memberOf(req.params.groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    const rows = db.prepare('SELECT * FROM group_todos WHERE group_id=? ORDER BY status ASC, created_at DESC').all(req.params.groupId);
    res.json({ todos: rows });
  });

  app.put('/api/groups/todos/:id', requireAuth, (req, res) => {
    const { status, completedAt } = req.body || {};
    if (status === 'completed') {
      db.run('UPDATE group_todos SET status=?, completed_at=? WHERE id=? AND created_by=?',
        [status, completedAt || Date.now(), req.params.id, req.user.id]);
    } else {
      db.run('UPDATE group_todos SET status=? WHERE id=? AND created_by=?',
        [status, req.params.id, req.user.id]);
    }
    res.json({ success: true });
  });

  // ========== 阅后即焚 ==========
  app.post('/api/message/burn', requireAuth, (req, res) => {
    const { messageId, duration } = req.body || {};
    if (!messageId || !duration) return res.status(400).json({ error: '参数缺失' });
    const dur = parseInt(duration, 10);
    if (!Number.isFinite(dur) || dur < 1 || dur > 86400) return res.status(400).json({ error: 'duration 无效' });
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    const gmsg = msg ? null : db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId);
    const row = msg || gmsg;
    if (!row) return res.status(404).json({ error: '消息不存在' });
    const uid = req.user.id;
    // 只有发送者可以设置阅后即焚（群主可对群内消息兜底）；普通成员不能焚毁别人的消息。
    const g = gmsg ? db.prepare('SELECT owner_id FROM groups WHERE id=?').get(gmsg.group_id) : null;
    const allowed = (row.from_id === uid) || (g && g.owner_id === uid);
    if (!allowed) return res.status(403).json({ error: '无权操作该消息' });
    const kind = msg ? 'direct' : 'group';
    const now = Date.now();
    db.run(
      'INSERT OR REPLACE INTO message_timers(message_id, kind, duration, started_at) VALUES(?,?,?,?)',
      [messageId, kind, dur, now]
    );
    scheduleBurn(kind, Number(messageId), dur * 1000);
    res.json({ success: true, kind });
  });

  // 计时器按 (kind, messageId) 记账，避免单聊/群聊自增 id 相同的消息互相误删。
  const _burnTimers = new Map();
  function scheduleBurn(kind, messageId, delayMs) {
    const key = kind + ':' + messageId;
    const old = _burnTimers.get(key);
    if (old) { try { clearTimeout(old); } catch (e) {} }
    const t = setTimeout(() => { _burnTimers.delete(key); destroyBurnMessage(kind, messageId); }, Math.max(0, delayMs));
    if (t && typeof t.unref === 'function') t.unref();
    _burnTimers.set(key, t);
  }

  function destroyBurnMessage(kind, messageId) {
    try {
      const isGroup = kind === 'group';
      // 先查出消息信息（含发送者/接收者），再删除并广播
      const msg = isGroup ? null : db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      const gmsg = isGroup ? db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId) : null;
      if (isGroup) {
        db.run('DELETE FROM group_messages WHERE id=?', [messageId]);
        db.run('DELETE FROM group_message_meta WHERE message_id=?', [messageId]);
      } else {
        db.run('DELETE FROM messages WHERE id=?', [messageId]);
        db.run('DELETE FROM message_meta WHERE message_id=?', [messageId]);
      }
      // 广播销毁消息
      const sendToUser = global.__scSendToUser;
      if (sendToUser) {
        if (msg) {
          sendToUser(msg.from_id, P.S_MSG, { id: messageId, destroyed: true });
          sendToUser(msg.to_id, P.S_MSG, { id: messageId, destroyed: true });
        } else if (gmsg) {
          const members = db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(gmsg.group_id);
          for (const mb of members) {
            sendToUser(mb.user_id, P.S_MSG, { id: messageId, groupId: gmsg.group_id, destroyed: true });
          }
        }
      }
      db.run('DELETE FROM message_timers WHERE message_id=? AND kind=?', [messageId, kind]);
      db.persist && db.persist();
    } catch (e) {
      console.error('[burn] destroy failed:', e.message);
    }
  }

  // 重启恢复：setTimeout 不会跨进程存活，原实现重启后所有焚毁任务永久丢失。
  // 启动时按剩余时间重新排程，已超时的立即销毁。
  try {
    const pending = db.prepare('SELECT * FROM message_timers').all();
    for (const t of pending) {
      const elapsed = Date.now() - t.started_at;
      const remain = t.duration * 1000 - elapsed;
      const kind = t.kind || 'direct';
      if (remain <= 0) destroyBurnMessage(kind, t.message_id);
      else scheduleBurn(kind, t.message_id, remain);
    }
    if (pending.length) console.log('[burn] 已恢复 ' + pending.length + ' 个阅后即焚计时器');
  } catch (e) {
    console.error('[burn] 恢复计时器失败:', e && e.message);
  }

  app.get('/api/message/burn-status/:messageId', requireAuth, (req, res) => {
    const mid = Number(req.params.messageId);
    // 归属校验：原接口不校验，任何人都能探测任意消息是否存在焚毁计时器
    const msg = db.prepare('SELECT from_id, to_id FROM messages WHERE id=?').get(mid);
    const gmsg = msg ? null : db.prepare('SELECT from_id, group_id FROM group_messages WHERE id=?').get(mid);
    // 消息已不存在（可能已焚毁）：直接告知不存在，避免把"已销毁"误报成"无权访问"
    if (!msg && !gmsg) return res.json({ exists: false, destroyed: true });
    let allowed = false;
    if (msg) allowed = (msg.from_id === req.user.id || msg.to_id === req.user.id);
    else if (gmsg) allowed = !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gmsg.group_id, req.user.id);
    if (!allowed) return res.status(403).json({ error: '无权访问该消息' });
    const timer = db.prepare('SELECT * FROM message_timers WHERE message_id=? AND kind=?')
      .get(mid, msg ? 'direct' : 'group');
    if (!timer) return res.json({ exists: false });
    const elapsed = (Date.now() - timer.started_at) / 1000;
    const remaining = Math.max(0, timer.duration - elapsed);
    res.json({ exists: true, remaining: Math.round(remaining), duration: timer.duration });
  });

  // ========== 消息置顶（越权修复：必须群成员 + 消息属于该群 + 发送者或群主）==========
  function pinPermission(req, res, groupId, messageId) {
    if (!groupId) {
      // 私聊:消息必须属于当前用户的会话
      const m = db.prepare('SELECT 1 FROM messages WHERE id=? AND (from_id=? OR to_id=?)').get(messageId, req.user.id, req.user.id);
      if (!m) return { err: [404, '消息不存在或无权操作'] };
      return { dm: true };
    }
    const g = db.prepare('SELECT owner_id FROM groups WHERE id=?').get(groupId);
    if (!g) return { err: [404, '群不存在'] };
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, req.user.id)) return { err: [403, '你不在此群'] };
    const msg = db.prepare('SELECT from_id FROM group_messages WHERE id=? AND group_id=?').get(messageId, groupId);
    if (!msg) return { err: [404, '消息不存在或不在该群'] };
    if (!(req.user.id === g.owner_id || req.user.id === msg.from_id)) return { err: [403, '仅消息发送者或群主可操作'] };
    return { dm: false };
  }

  app.post('/api/message/pin', requireAuth, (req, res) => {
    const { messageId, groupId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    const perm = pinPermission(req, res, groupId, messageId);
    if (perm.err) return res.status(perm.err[0]).json({ error: perm.err[1] });
    if (groupId) {
      // 用 upsert:多数消息没有 meta 行(仅引用/转发过才有),裸 UPDATE 会空操作导致置顶不生效
      db.run('INSERT INTO group_message_meta(message_id,pinned,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned=excluded.pinned,updated_at=excluded.updated_at', [messageId, 1, Date.now()]);
    } else {
      db.run('INSERT INTO message_meta(message_id,pinned,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned=excluded.pinned,updated_at=excluded.updated_at', [messageId, 1, Date.now()]);
    }
    res.json({ success: true });
  });

  app.post('/api/message/unpin', requireAuth, (req, res) => {
    const { messageId, groupId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    const perm = pinPermission(req, res, groupId, messageId);
    if (perm.err) return res.status(perm.err[0]).json({ error: perm.err[1] });
    if (groupId) {
      db.run('INSERT INTO group_message_meta(message_id,pinned,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned=excluded.pinned,updated_at=excluded.updated_at', [messageId, 0, Date.now()]);
    } else {
      db.run('INSERT INTO message_meta(message_id,pinned,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned=excluded.pinned,updated_at=excluded.updated_at', [messageId, 0, Date.now()]);
    }
    res.json({ success: true });
  });

  app.get('/api/messages/pinned/:groupId', requireAuth, (req, res) => {
    if (!memberOf(req.params.groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    const rows = db.prepare('SELECT mm.*, gm.content, gm.created_at, u.nickname, u.avatar FROM group_message_meta mm JOIN group_messages gm ON mm.message_id=gm.id JOIN users u ON gm.from_id=u.id WHERE mm.pinned=1 AND gm.group_id=? ORDER BY mm.updated_at ASC').all(req.params.groupId);
    res.json({ messages: rows });
  });

  // ========== 消息撤回增强 ==========
  app.post('/api/message/recall', requireAuth, (req, res) => {
    const { messageId, reason } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    // 检查是否在撤回时间范围内（5分钟内）
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (msg.from_id !== req.user.id) return res.status(403).json({ error: '只能撤回自己的消息' });
    if (Date.now() - msg.created_at > 5 * 60 * 1000) {
      return res.status(400).json({ error: '超过5分钟无法撤回' });
    }
    db.run('UPDATE messages SET recalled=1 WHERE id=?', [messageId]);
    // 广播撤回
    broadcastRecall(messageId, msg.from_id, msg.to_id, reason);
    res.json({ success: true });
  });

  app.post('/api/group-message/recall', requireAuth, (req, res) => {
    const { messageId, groupId, reason } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    const msg = db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (msg.from_id !== req.user.id) return res.status(403).json({ error: '只能撤回自己的消息' });
    if (Date.now() - msg.created_at > 5 * 60 * 1000) {
      return res.status(400).json({ error: '超过5分钟无法撤回' });
    }
    db.run('UPDATE group_messages SET recalled=1 WHERE id=?', [messageId]);
    // 固定用消息所属群广播：参数 groupId 可能伪造，改用它会让其他群收到无关撤回
    broadcastGroupRecall(messageId, msg.group_id, msg.from_id, reason);
    res.json({ success: true });
  });

  // ========== 语音转文字 ==========
  app.post('/api/message/transcribe', requireAuth, (req, res) => {
    const { audioPath } = req.body || {};
    if (!audioPath || typeof audioPath !== 'string' || audioPath.length > 500) return res.status(400).json({ error: '音频路径不能为空' });
    // 路径白名单：只允许转写服务器媒体目录内的文件，且必须存在（防把任意本地文件送进模型、防路径穿越）
    const pathMod = require('path');
    const fsMod = require('fs');
    const roots = ['server/media', 'media', 'call-recordings', 'files', 'server/group-files', 'group-files']
      .map(r => pathMod.resolve(__dirname, '../../', r) + pathMod.sep);
    const resolved = pathMod.resolve(String(audioPath));
    if (!roots.some(r => resolved.startsWith(r))) return res.status(400).json({ error: '音频路径不在允许目录内' });
    if (!fsMod.existsSync(resolved)) return res.status(404).json({ error: '音频文件不存在' });
    if (_sttLimited(req.user.id)) return res.status(429).json({ error: '转写请求过于频繁，请稍后再试' });
    try {
      const { execFile } = require('child_process');
      execFile('python', [pathMod.join(__dirname, '../stt_whisper.py'), resolved], { encoding: 'utf8', timeout: 30000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: '转写失败' });
        res.json({ success: true, text: String(stdout || '').trim() });
      });
    } catch (e) {
      res.status(500).json({ error: '转写失败' });
    }
  });

  // ========== 图片 OCR ==========
  app.post('/api/image/ocr', requireAuth, (req, res) => {
    const { imagePath } = req.body || {};
    if (!imagePath) return res.status(400).json({ error: '图片路径不能为空' });
    // 调用 OCR 服务（这里用 mock）
    const text = mockOCR(imagePath);
    res.json({ success: true, text });
  });

  // ========== Mock 函数 ==========
  function mockTranslate(text, source, target) {
    // 实际应调用翻译 API
    return `[${target}] ${text}`;
  }

  function mockOCR(imagePath) {
    // 实际应调用 OCR 服务
    return '[OCR识别结果]';
  }

  function broadcastRecall(messageId, fromId, toId, reason) {
    const sendToUser = global.__scSendToUser;
    if (!sendToUser) return;
    sendToUser(toId, P.S_MSG_RECALL, { messageId, from: fromId, to: toId, reason: reason || '已撤回' });
  }

  function broadcastGroupRecall(messageId, groupId, fromId, reason) {
    const sendToUser = global.__scSendToUser;
    if (!sendToUser) return;
    const members = db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
    for (const m of members) {
      sendToUser(m.user_id, P.S_GROUP_MSG, { id: messageId, groupId, from: fromId, content: '', createdAt: Date.now(), recalled: true, reason: reason || '已撤回' });
    }
  }

  // 3. 定时发送调度器：每 5 秒扫描到期任务并投递（通过 WS 发送消息，同时落库）
  setInterval(() => {
    try {
      const due = db.prepare("SELECT * FROM scheduled_messages WHERE cancelled=0 AND sent_at IS NULL AND scheduled_at <= ?").all(Date.now());
      for (const m of due) {
        const sendToUser = global.__scSendToUser;
        if (!sendToUser) continue;
        const now = Date.now();
        if (m.is_group) {
          // 投递前重校验:退群/被移除后不再以成员身份发言
          const stillIn = db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(m.peer_id, m.user_id);
          if (!stillIn) {
            db.run('UPDATE scheduled_messages SET sent_at=? WHERE id=?', [now, m.id]);
            continue;
          }
          const grpSeq = db.nextSeq();
          const info = db.prepare('INSERT INTO group_messages(group_id,from_id,content,client_msg_id,created_at,seq) VALUES(?,?,?,?,?,?)')
            .run(m.peer_id, m.user_id, m.content, null, now, grpSeq);
          const messageId = info.lastInsertRowid;
          const members = db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(m.peer_id);
          for (const mb of members) {
            sendToUser(mb.user_id, P.S_GROUP_MSG, { id: messageId, groupId: m.peer_id, from: m.user_id, content: m.content, createdAt: now, scheduled: true, seq: grpSeq });
          }
        } else {
          // 私聊:任一方拉黑则不投递
          const blocked = db.prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(m.user_id, m.peer_id, m.peer_id, m.user_id);
          if (blocked) {
            db.run('UPDATE scheduled_messages SET sent_at=? WHERE id=?', [now, m.id]);
            continue;
          }
          const dmSeq = db.nextSeq();
          const info = db.prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at,seq) VALUES(?,?,?,?,?,?)')
            .run(m.user_id, m.peer_id, m.content, null, now, dmSeq);
          sendToUser(m.peer_id, P.S_MSG, { id: info.lastInsertRowid, from: m.user_id, to: m.peer_id, content: m.content, createdAt: now, scheduled: true, seq: dmSeq });
        }
        db.run('UPDATE scheduled_messages SET sent_at=? WHERE id=?', [now, m.id]);
      }
      if (due.length) db.persist && db.persist();
    } catch (e) { console.error('[scheduled] tick failed:', e && e.message || e); }
  }, 5000);
};