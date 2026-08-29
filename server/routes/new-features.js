'use strict';
// routes/new-features.js —— 消息翻译/快捷回复/定时发送/群投票/群待办/阅后即焚
const P = require('../../shared/protocol');

module.exports = function register(app, db, auth) {
  // 认证中间件
  const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
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

  // ========== 消息翻译 ==========
  app.post('/api/message/translate', requireAuth, (req, res) => {
    const { messageId, sourceLang, targetLang, text } = req.body || {};
    if (!text) return res.status(400).json({ error: '参数缺失' });
    const target = targetLang || 'zh';
    try {
      // 调用翻译 API（这里用 mock，实际可接入 DeepL/Google/百度翻译）
      const translated = mockTranslate(text, sourceLang, target);
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
    db.run(
      'INSERT INTO scheduled_messages(user_id, peer_id, is_group, content, kind, scheduled_at, created_at) VALUES(?,?,?,?,?,?,?)',
      [req.user.id, peerId, isGroup ? 1 : 0, content, kind || 'text', scheduledAt, Date.now()]
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
    const result = db.run('INSERT INTO group_votes(group_id, title, content, created_by, is_anonymous, allow_change, created_at) VALUES(?,?,?,?,?,?,?)',
      [groupId, title, content || '', req.user.id, isAnonymous ? 1 : 0, allowChange ? 1 : 0, now]);
    const voteId = result.lastInsertRowid;
    if (Array.isArray(options)) {
      options.forEach((opt, idx) => {
        const text = String(opt?.text || opt || '').trim();
        if (text) db.run('INSERT INTO vote_options(vote_id, text, order_index) VALUES(?,?,?)', [voteId, text, idx]);
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
        opt.votes = db.prepare('SELECT COUNT(*) as cnt FROM vote_votes WHERE option_id=?').get(opt.id);
      }
      options.push(voteData);
    }
    res.json({ votes: options });
  });

  app.post('/api/groups/votes/:voteId/vote', requireAuth, (req, res) => {
    const { optionIds } = req.body || [];
    if (!optionIds || optionIds.length === 0) return res.status(400).json({ error: '请选择投票选项' });
    const vote = db.prepare('SELECT * FROM group_votes WHERE id=?').get(req.params.voteId);
    if (!vote) return res.status(404).json({ error: '投票不存在' });
    if (!memberOf(vote.group_id, req.user.id)) return res.status(403).json({ error: '非群成员' });
    if (vote.ended) return res.status(400).json({ error: '投票已结束' });
    const optRows = db.prepare('SELECT id FROM vote_options WHERE vote_id=?').all(vote.id);
    const validOptIds = new Set(optRows.map(o => o.id));
    for (const oid of optionIds) { if (!validOptIds.has(Number(oid))) return res.status(400).json({ error: '包含无效选项' }); }
    if (!vote.allow_change) {
      const existing = db.prepare('SELECT * FROM vote_votes WHERE vote_id=? AND user_id=?').get(vote.id, req.user.id);
      if (existing) return res.status(400).json({ error: '已投票，不可重复' });
    }
    // 删除旧投票
    db.run('DELETE FROM vote_votes WHERE vote_id=? AND user_id=?', [vote.id, req.user.id]);
    // 插入新投票
    for (const optId of optionIds) {
      db.run('INSERT INTO vote_votes(vote_id, user_id, option_id, created_at) VALUES(?,?,?,?)',
        [vote.id, req.user.id, optId, Date.now()]);
    }
    res.json({ success: true });
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
    let allowed = false;
    if (msg) allowed = (row.from_id === uid || row.to_id === uid);
    else {
      allowed = (row.from_id === uid) || !!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(row.group_id, uid);
    }
    if (!allowed) return res.status(403).json({ error: '无权操作该消息' });
    const now = Date.now();
    db.run(
      'INSERT OR REPLACE INTO message_timers(message_id, duration, started_at) VALUES(?,?,?)',
      [messageId, dur, now]
    );
    setTimeout(() => {
      destroyBurnMessage(messageId);
    }, dur * 1000);
    res.json({ success: true });
  });

  function destroyBurnMessage(messageId) {
    try {
      // 先查出消息信息（含发送者/接收者），再删除并广播
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      const gmsg = msg ? null : db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId);
      // 从单聊表删除
      db.run('DELETE FROM messages WHERE id=?', [messageId]);
      // 从群聊表删除
      db.run('DELETE FROM group_messages WHERE id=?', [messageId]);
      // 从 message_meta 删除
      db.run('DELETE FROM message_meta WHERE message_id=?', [messageId]);
      db.run('DELETE FROM group_message_meta WHERE message_id=?', [messageId]);
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
      db.run('DELETE FROM message_timers WHERE message_id=?', [messageId]);
      db.persist && db.persist();
    } catch (e) {
      console.error('[burn] destroy failed:', e.message);
    }
  }

  app.get('/api/message/burn-status/:messageId', requireAuth, (req, res) => {
    const timer = db.prepare('SELECT * FROM message_timers WHERE message_id=?').get(req.params.messageId);
    if (!timer) return res.json({ exists: false });
    const elapsed = (Date.now() - timer.started_at) / 1000;
    const remaining = Math.max(0, timer.duration - elapsed);
    res.json({ exists: true, remaining: Math.round(remaining), duration: timer.duration });
  });

  // ========== 消息置顶 ==========
  app.post('/api/message/pin', requireAuth, (req, res) => {
    const { messageId, groupId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    if (groupId) {
      db.run('UPDATE group_message_meta SET pinned=1 WHERE message_id=?', [messageId]);
    } else {
      db.run('UPDATE message_meta SET pinned=1 WHERE message_id=?', [messageId]);
    }
    res.json({ success: true });
  });

  app.post('/api/message/unpin', requireAuth, (req, res) => {
    const { messageId, groupId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    if (groupId) {
      db.run('UPDATE group_message_meta SET pinned=0 WHERE message_id=?', [messageId]);
    } else {
      db.run('UPDATE message_meta SET pinned=0 WHERE message_id=?', [messageId]);
    }
    res.json({ success: true });
  });

  app.get('/api/messages/pinned/:groupId', requireAuth, (req, res) => {
    if (!memberOf(req.params.groupId, req.user.id)) return res.status(403).json({ error: '非群成员' });
    const rows = db.prepare('SELECT mm.*, gm.content, gm.created_at, u.nickname, u.avatar FROM group_message_meta mm JOIN group_messages gm ON mm.message_id=gm.id JOIN users u ON gm.from_id=u.id WHERE mm.pinned=1 AND gm.group_id=? ORDER BY mm.created_at ASC').all(req.params.groupId);
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
    broadcastGroupRecall(messageId, groupId || msg.group_id, msg.from_id, reason);
    res.json({ success: true });
  });

  // ========== 语音转文字 ==========
  app.post('/api/message/transcribe', requireAuth, (req, res) => {
    const { audioPath } = req.body || {};
    if (!audioPath || typeof audioPath !== 'string' || audioPath.length > 500) return res.status(400).json({ error: '音频路径不能为空' });
    try {
      const { execFileSync } = require('child_process');
      const result = execFileSync('python', [require('path').join(__dirname, '../stt_whisper.py'), String(audioPath)], { encoding: 'utf8', timeout: 30000 });
      res.json({ success: true, text: result.trim() });
    } catch (e) {
      res.status(500).json({ error: '转写失败: ' + e.message });
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
          const info = db.prepare('INSERT INTO group_messages(group_id,from_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
            .run(m.peer_id, m.user_id, m.content, null, now);
          const messageId = info.lastInsertRowid;
          const members = db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(m.peer_id);
          for (const mb of members) {
            sendToUser(mb.user_id, P.S_GROUP_MSG, { id: messageId, groupId: m.peer_id, from: m.user_id, content: m.content, createdAt: now, scheduled: true });
          }
        } else {
          const info = db.prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)')
            .run(m.user_id, m.peer_id, m.content, null, now);
          sendToUser(m.peer_id, P.S_MSG, { id: info.lastInsertRowid, from: m.user_id, to: m.peer_id, content: m.content, createdAt: now, scheduled: true });
        }
        db.run('UPDATE scheduled_messages SET sent_at=? WHERE id=?', [now, m.id]);
      }
      if (due.length) db.persist && db.persist();
    } catch (e) { console.error('[scheduled] tick failed:', e && e.message || e); }
  }, 5000);
};