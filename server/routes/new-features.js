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
      req.user = jwt.verify(token, JWT_SECRET);
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
  app.post('/api/groups/votes', requireAuth, (req, res) => {
    const { groupId, title, content, isAnonymous, allowChange } = req.body || {};
    if (!groupId || !title) return res.status(400).json({ error: '群ID和标题不能为空' });
    const now = Date.now();
    const result = db.run('INSERT INTO group_votes(group_id, title, content, created_by, is_anonymous, allow_change, created_at) VALUES(?,?,?,?,?,?,?)',
      [groupId, title, content || '', req.user.id, isAnonymous ? 1 : 0, allowChange ? 1 : 0, now]);
    const voteId = result.lastInsertRowid;
    res.json({ success: true, voteId });
  });

  app.get('/api/groups/votes/:groupId', requireAuth, (req, res) => {
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
    if (vote.ended) return res.status(400).json({ error: '投票已结束' });
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
    db.run(
      'INSERT INTO group_todos(group_id, title, description, created_by, assigned_to, due_at, created_at) VALUES(?,?,?,?,?,?,?)',
      [groupId, title, description || '', req.user.id, assignedTo || null, dueAt || null, Date.now()]
    );
    res.json({ success: true });
  });

  app.get('/api/groups/todos/:groupId', requireAuth, (req, res) => {
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
    const now = Date.now();
    db.run(
      'INSERT OR REPLACE INTO message_timers(message_id, duration, started_at) VALUES(?,?,?)',
      [messageId, duration, now]
    );
    // 调度销毁
    setTimeout(() => {
      destroyBurnMessage(messageId);
    }, duration * 1000);
    res.json({ success: true });
  });

  function destroyBurnMessage(messageId) {
    try {
      // 从单聊表删除
      db.run('DELETE FROM messages WHERE id=?', [messageId]);
      // 从群聊表删除
      db.run('DELETE FROM group_messages WHERE id=?', [messageId]);
      // 从 message_meta 删除
      db.run('DELETE FROM message_meta WHERE message_id=?', [messageId]);
      // 广播销毁消息
      broadcastDestroyMessage(messageId);
    } catch (e) {
      console.error('[burn] destroy failed:', e.message);
    }
  }

  function broadcastDestroyMessage(messageId) {
    // 这里可以广播销毁消息给所有用户
    // 简化处理，实际需要根据 messageId 找到对应会话
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (msg) {
      // 广播给相关用户
      const toBroadcast = [msg.from_id, msg.to_id];
      // 清理 timer
      db.run('DELETE FROM message_timers WHERE message_id=?', [messageId]);
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
    if (Date.now() - msg.created_at > 5 * 60 * 1000) {
      return res.status(400).json({ error: '超过5分钟无法撤回' });
    }
    db.run('UPDATE messages SET recalled=1, recalled_reason=? WHERE id=?', [reason || '', messageId]);
    // 广播撤回
    broadcastRecall(messageId, msg.from_id, msg.to_id, reason);
    res.json({ success: true });
  });

  app.post('/api/group-message/recall', requireAuth, (req, res) => {
    const { messageId, groupId, reason } = req.body || {};
    if (!messageId) return res.status(400).json({ error: '消息ID不能为空' });
    const msg = db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (Date.now() - msg.created_at > 5 * 60 * 1000) {
      return res.status(400).json({ error: '超过5分钟无法撤回' });
    }
    db.run('UPDATE group_messages SET recalled=1, recalled_reason=? WHERE id=?', [reason || '', messageId]);
    broadcastGroupRecall(messageId, groupId, msg.from_id, reason);
    res.json({ success: true });
  });

  // ========== 语音转文字 ==========
  app.post('/api/message/transcribe', requireAuth, (req, res) => {
    const { audioPath } = req.body || {};
    if (!audioPath) return res.status(400).json({ error: '音频路径不能为空' });
    // 调用本地 whisper 服务
    try {
      const { execSync } = require('child_process');
      const result = execSync(`python ${require('path').join(__dirname, '../stt_whisper.py')} "${audioPath}"`, { encoding: 'utf8' });
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

  // 3. 定时发送调度器：每 5 秒扫描到期任务并投递（通过 WS 发送消息）
  setInterval(() => {
    try {
      const due = db.prepare("SELECT * FROM scheduled_messages WHERE cancelled=0 AND sent_at IS NULL AND scheduled_at <= ?").all(Date.now());
      for (const m of due) {
        const sendToUser = global.__scSendToUser;
        if (!sendToUser) continue;
        if (m.is_group) {
          sendToUser(m.user_id, P.S_GROUP_MSG, { groupId: m.peer_id, from: m.user_id, content: m.content, createdAt: Date.now(), scheduled: true });
        } else {
          sendToUser(m.user_id, P.S_MSG, { from: m.user_id, to: m.peer_id, content: m.content, createdAt: Date.now(), scheduled: true });
        }
        db.run('UPDATE scheduled_messages SET sent_at=? WHERE id=?', [Date.now(), m.id]);
      }
      if (due.length) db.persist && db.persist();
    } catch (e) { console.error('[scheduled] tick failed:', e && e.message || e); }
  }, 5000);
};