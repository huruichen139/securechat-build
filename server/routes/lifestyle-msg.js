'use strict';
// module: polls|remind|todos|translate|solang (worker batch8)
// 聊天民生工具服务端：群投票 / 群接龙 / 群待办 / 定时提醒 / 翻译 / 群语音。
// 挂载方式（由合并 worker 调用）：
//   const registerLifestyleMsg = require('./routes/lifestyle-msg');
//   registerLifestyleMsg(app, db, apiUser);   // apiUser(req) 解析 Authorization 返回 JWT payload（或 null）
// 依赖：require('../db') 的 prepare（media.js 同款）；提醒定时任务用 setTimeout 队列 + 关闭时清空。
const jwt = require('jsonwebtoken');
const { prepare } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

module.exports = function registerLifestyleMsg(app, db, auth) {
  function authed(req) {
    if (typeof auth === 'function') return auth(req);
    const h = req.headers.authorization || '';
    try { return jwt.verify(String(h).replace(/^Bearer\s+/i, ''), JWT_SECRET); } catch (_) { return null; }
  }
  function deny(res, code, msg) { res.status(code).json({ error: msg }); }
  function okay(res, obj) { res.json(Object.assign({ ok: true }, obj)); }
  function userInfo(id) {
    const u = prepare('SELECT id,username,nickname,avatar FROM users WHERE id=?').get(id);
    if (!u) return { id, nickname: '用户' + id, username: '', avatar: '' };
    return u;
  }

  // 群成员校验：目标用户是否在群内
  function inGroup(groupId, userId) {
    return !!prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId);
  }
  function groupExists(groupId) {
    return !!prepare('SELECT id FROM groups WHERE id=?').get(groupId);
  }

  // ---------- 建表（IF NOT EXISTS，安全幂等） ----------
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        creator_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        multi INTEGER NOT NULL DEFAULT 0,
        anonymous INTEGER NOT NULL DEFAULT 0,
        deadline INTEGER,
        only_members INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_polls_group ON polls(group_id, created_at);
      CREATE TABLE IF NOT EXISTS poll_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);
      CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        option_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(poll_id, option_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS solang (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        creator_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_solang_group ON solang(group_id, created_at);
      CREATE TABLE IF NOT EXISTS solang_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        solang_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        note TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_solang_entries_solang_seq ON solang_entries(solang_id, seq);
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        at INTEGER NOT NULL,
        content TEXT NOT NULL,
        fired INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, fired, at);
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        creator_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_todos_group ON todos(group_id, created_at);
      CREATE TABLE IF NOT EXISTS todo_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        todo_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_todo_items_todo ON todo_items(todo_id);
      CREATE TABLE IF NOT EXISTS todo_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        todo_item_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(todo_item_id, user_id)
      );
    `);
  } catch (e) { /* 异地库不可用则忽略，端点仍注册 */ }

  // ============================================================
  // 群投票 /api/polls/*
  // ============================================================
  function pollDto(p, meId) {
    const options = prepare('SELECT * FROM poll_options WHERE poll_id=? ORDER BY id ASC').all(p.id);
    const voters = prepare('SELECT user_id FROM poll_votes WHERE poll_id=?').all(p.id).map(r => r.user_id);
    const myVotes = prepare('SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?').all(p.id, meId).map(r => r.option_id);
    const total = voters.length;
    return {
      id: p.id, groupId: p.group_id, creatorId: p.creator_id,
      creator: userInfo(p.creator_id),
      title: p.title, multi: !!p.multi, anonymous: !!p.anonymous,
      deadline: p.deadline || null, onlyMembers: !!p.only_members,
      status: p.status, createdAt: p.created_at,
      options: options.map(o => ({ id: o.id, content: o.content, votes: o.votes })),
      totalVotes: total, myVotes,
      voted: myVotes.length > 0,
      createdByMe: !!meId && p.creator_id === meId,
    };
  }

  // 创建投票
  app.post('/api/polls', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt((req.body || {}).groupId, 10);
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return deny(res, 400, '群不存在');
    if (!inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const title = String((req.body || {}).title || '').trim();
    const opts = Array.isArray((req.body || {}).options) ? (req.body.options) : [];
    const cleanOpts = opts.map(o => String(o == null ? '' : o).trim()).filter(o => o && o.length <= 100);
    if (!title || title.length > 120) return deny(res, 400, '投票标题不能为空（120字内）');
    if (cleanOpts.length < 2) return deny(res, 400, '至少需要两个选项');
    if (cleanOpts.length > 20) return deny(res, 400, '选项最多 20 个');
    const multi = !!((req.body || {}).multi);
    const anonymous = !!((req.body || {}).anonymous);
    const onlyMembers = (req.body || {}).onlyMembers !== false;
    let deadline = parseInt((req.body || {}).deadline, 10);
    if (!Number.isInteger(deadline) || deadline <= Date.now()) deadline = null;
    const now = Date.now();
    const info = prepare('INSERT INTO polls(group_id,creator_id,title,multi,anonymous,deadline,only_members,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(groupId, payload.id, title, multi ? 1 : 0, anonymous ? 1 : 0, deadline, onlyMembers ? 1 : 0, 'open', now);
    const pollId = info.lastInsertRowid;
    for (const o of cleanOpts) {
      prepare('INSERT INTO poll_options(poll_id,content) VALUES(?,?)').run(pollId, o);
    }
    const p = prepare('SELECT * FROM polls WHERE id=?').get(pollId);
    okay(res, { poll: pollDto(p, payload.id) });
  });

  // 群内投票列表
  app.get('/api/polls/group/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt(req.params.id, 10);
    if (!groupExists(groupId) || !inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const rows = prepare('SELECT * FROM polls WHERE group_id=? ORDER BY id DESC').all(groupId);
    okay(res, { polls: rows.map(r => pollDto(r, payload.id)) });
  });

  // 投票详情
  app.get('/api/polls/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const p = prepare('SELECT * FROM polls WHERE id=?').get(parseInt(req.params.id, 10));
    if (!p) return deny(res, 404, '投票不存在');
    if (!inGroup(p.group_id, payload.id)) return deny(res, 403, '你不在此群');
    okay(res, { poll: pollDto(p, payload.id) });
  });

  // 投票：POST /api/polls/:id/vote { optionIds: [] }
  app.post('/api/polls/:id/vote', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const poll = prepare('SELECT * FROM polls WHERE id=?').get(parseInt(req.params.id, 10));
    if (!poll) return deny(res, 404, '投票不存在');
    if (!inGroup(poll.group_id, payload.id)) return deny(res, 403, '你不在此群');
    if (poll.status !== 'open') return deny(res, 400, '投票已结束');
    if (poll.deadline && Date.now() > poll.deadline) {
      prepare('UPDATE polls SET status=\'closed\' WHERE id=?').run(poll.id);
      return deny(res, 400, '投票已截止');
    }
    let optionIds = Array.isArray((req.body || {}).optionIds) ? (req.body.optionIds) : [];
    optionIds = optionIds.map(o => parseInt(o, 10)).filter(o => Number.isInteger(o));
    if (!optionIds.length) return deny(res, 400, '请选择选项');
    if (poll.multi && optionIds.length > 1) { /* 多选允许多个 */ }
    else optionIds = optionIds.slice(0, 1);
    // 校验选项属于该投票
    for (const oid of optionIds) {
      if (!prepare('SELECT id FROM poll_options WHERE id=? AND poll_id=?').get(oid, poll.id)) {
        return deny(res, 400, '含无效选项');
      }
    }
    const existing = prepare('SELECT id FROM poll_votes WHERE poll_id=? AND user_id=?').get(poll.id, payload.id);
    const wasVoted = !!existing;
    // 撤销旧投
    prepare('DELETE FROM poll_votes WHERE poll_id=? AND user_id=?').run(poll.id, payload.id);
    prepare('UPDATE poll_options SET votes=0 WHERE poll_id=?').run(poll.id);
    const now = Date.now();
    const votedIds = [];
    for (const oid of optionIds) {
      prepare('INSERT OR IGNORE INTO poll_votes(poll_id,option_id,user_id,created_at) VALUES(?,?,?,?)').run(poll.id, oid, payload.id, now);
      votedIds.push(oid);
    }
    // 重算每个选项票数
    const optRows = prepare('SELECT id FROM poll_options WHERE poll_id=?').all(poll.id);
    for (const o of optRows) {
      const c = (prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id=? AND option_id=?').get(poll.id, o.id) || { c: 0 }).c;
      prepare('UPDATE poll_options SET votes=? WHERE id=?').run(c, o.id);
    }
    const fresh = prepare('SELECT * FROM polls WHERE id=?').get(poll.id);
    res.json({ ok: true, changed: wasVoted, poll: pollDto(fresh, payload.id) });
  });

  // 结束投票（仅创建者）
  app.post('/api/polls/:id/close', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const poll = prepare('SELECT * FROM polls WHERE id=?').get(parseInt(req.params.id, 10));
    if (!poll) return deny(res, 404, '投票不存在');
    if (poll.creator_id !== payload.id) return deny(res, 403, '仅创建者可结束投票');
    prepare('UPDATE polls SET status=\'closed\' WHERE id=?').run(poll.id);
    const fresh = prepare('SELECT * FROM polls WHERE id=?').get(poll.id);
    okay(res, { poll: pollDto(fresh, payload.id) });
  });

  // ============================================================
  // 群接龙（报名类） /api/solang/*
  // ============================================================
  function solangDto(s) {
    const entries = prepare(
      'SELECT e.id,e.seq AS seq,e.note AS note,e.created_at AS createdAt, u.id AS userId,u.nickname,u.avatar FROM solang_entries e LEFT JOIN users u ON u.id=e.user_id WHERE e.solang_id=? ORDER BY e.seq ASC').all(s.id);
    return {
      id: s.id, groupId: s.group_id, creatorId: s.creator_id,
      creator: userInfo(s.creator_id), title: s.title, status: s.status,
      createdAt: s.created_at, count: entries.length, entries,
    };
  }

  app.post('/api/solang', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt((req.body || {}).groupId, 10);
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return deny(res, 400, '群不存在');
    if (!inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const title = String((req.body || {}).title || '').trim();
    if (!title || title.length > 200) return deny(res, 400, '接龙主题不能为空（200字内）');
    const info = prepare('INSERT INTO solang(group_id,creator_id,title,status,created_at) VALUES(?,?,?,?,?)')
      .run(groupId, payload.id, title, 'open', Date.now());
    const s = prepare('SELECT * FROM solang WHERE id=?').get(info.lastInsertRowid);
    okay(res, { solang: solangDto(s) });
  });

  app.get('/api/solang/group/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt(req.params.id, 10);
    if (!groupExists(groupId) || !inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const rows = prepare('SELECT * FROM solang WHERE group_id=? ORDER BY id DESC').all(groupId);
    okay(res, { solangs: rows.map(r => solangDto(r)) });
  });

  app.get('/api/solang/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const s = prepare('SELECT * FROM solang WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return deny(res, 404, '接龙不存在');
    if (!inGroup(s.group_id, payload.id)) return deny(res, 403, '你不在此群');
    okay(res, { solang: solangDto(s) });
  });

  // 报名（追加一条，seq 自动递增）
  app.post('/api/solang/:id/join', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const s = prepare('SELECT * FROM solang WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return deny(res, 404, '接龙不存在');
    if (s.status !== 'open') return deny(res, 400, '接龙已结束');
    if (!inGroup(s.group_id, payload.id)) return deny(res, 403, '你不在此群');
    const note = String((req.body || {}).note || '').trim().slice(0, 200);
    // 去重：同一用户不能重复报名（solang_entries 只有 UNIQUE(solang_id,seq)，没有 user 唯一约束）
    const dup = prepare('SELECT id FROM solang_entries WHERE solang_id=? AND user_id=?').get(s.id, payload.id);
    if (dup) return deny(res, 409, '你已报名');
    // seq 递增有并发竞态（两人同时报名会拿到同一 seq 触发 UNIQUE 冲突），失败时重试几次
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const maxSeq = prepare('SELECT COALESCE(MAX(seq),0) AS m FROM solang_entries WHERE solang_id=?').get(s.id) || { m: 0 };
      const seq = (maxSeq.m || 0) + 1;
      try {
        prepare('INSERT INTO solang_entries(solang_id,seq,user_id,note,created_at) VALUES(?,?,?,?,?)')
          .run(s.id, seq, payload.id, note, Date.now());
        inserted = true;
      } catch (e) {
        if (!String(e && e.message || e).includes('UNIQUE')) throw e;
        // seq 冲突：重新取 MAX(seq) 再试
      }
    }
    if (!inserted) return deny(res, 500, '报名失败，请重试');
    const fresh = prepare('SELECT * FROM solang WHERE id=?').get(s.id);
    okay(res, { solang: solangDto(fresh) });
  });

  // 结束接龙（仅创建者）
  app.post('/api/solang/:id/close', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const s = prepare('SELECT * FROM solang WHERE id=?').get(parseInt(req.params.id, 10));
    if (!s) return deny(res, 404, '接龙不存在');
    if (s.creator_id !== payload.id) return deny(res, 403, '仅创建者可结束接龙');
    prepare('UPDATE solang SET status=\'closed\' WHERE id=?').run(s.id);
    const fresh = prepare('SELECT * FROM solang WHERE id=?').get(s.id);
    okay(res, { solang: solangDto(fresh) });
  });

  // ============================================================
  // 群待办（今日待办） /api/todos/*
  // ============================================================
  function todoDto(t, meId) {
    const items = prepare('SELECT * FROM todo_items WHERE todo_id=? ORDER BY id ASC').all(t.id);
    const rows = items.map(it => {
      const myCheck = prepare('SELECT done FROM todo_checks WHERE todo_item_id=? AND user_id=?').get(it.id, meId);
      return { id: it.id, content: it.content, done: !!it.done, myDone: !!(myCheck && myCheck.done) };
    });
    const total = items.length;
    const doneCount = items.filter(it => !!it.done).length;
    return {
      id: t.id, groupId: t.group_id, creatorId: t.creator_id,
      creator: userInfo(t.creator_id), title: t.title, createdAt: t.created_at,
      progress: total ? Math.round(doneCount / total * 100) : 0,
      items: rows,
    };
  }

  app.post('/api/todos', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt((req.body || {}).groupId, 10);
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return deny(res, 400, '群不存在');
    if (!inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const title = String((req.body || {}).title || '').trim().slice(0, 120) || '今日待办';
    const items = Array.isArray((req.body || {}).items) ? (req.body.items) : [];
    const cleanItems = items.map(i => String(i == null ? '' : i).trim()).filter(i => i && i.length <= 200);
    if (!cleanItems.length) cleanItems.push('（空清单）');
    const now = Date.now();
    const info = prepare('INSERT INTO todos(group_id,creator_id,title,created_at) VALUES(?,?,?,?)')
      .run(groupId, payload.id, title, now);
    const todoId = info.lastInsertRowid;
    for (const c of cleanItems) {
      prepare('INSERT INTO todo_items(todo_id,content) VALUES(?,?)').run(todoId, c);
    }
    const t = prepare('SELECT * FROM todos WHERE id=?').get(todoId);
    okay(res, { todo: todoDto(t, payload.id) });
  });

  app.get('/api/todos/group/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt(req.params.id, 10);
    if (!groupExists(groupId) || !inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    const rows = prepare('SELECT * FROM todos WHERE group_id=? ORDER BY id DESC').all(groupId);
    okay(res, { todos: rows.map(r => todoDto(r, payload.id)) });
  });

  app.get('/api/todos/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const t = prepare('SELECT * FROM todos WHERE id=?').get(parseInt(req.params.id, 10));
    if (!t) return deny(res, 404, '待办不存在');
    if (!inGroup(t.group_id, payload.id)) return deny(res, 403, '你不在此群');
    okay(res, { todo: todoDto(t, payload.id) });
  });

  // 勾选/取消：POST /api/todos/:todoId/items/:itemId/check { done }
  app.post('/api/todos/:todoId/items/:itemId/check', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const todoId = parseInt(req.params.todoId, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const t = prepare('SELECT * FROM todos WHERE id=?').get(todoId);
    if (!t) return deny(res, 404, '待办不存在');
    if (!inGroup(t.group_id, payload.id)) return deny(res, 403, '你不在此群');
    const it = prepare('SELECT * FROM todo_items WHERE id=? AND todo_id=?').get(itemId, todoId);
    if (!it) return deny(res, 404, '待办项不存在');
    const done = (req.body || {}).done ? 1 : 0;
    prepare('INSERT OR IGNORE INTO todo_checks(todo_item_id,user_id,done,created_at) VALUES(?,?,?,?)')
      .run(itemId, payload.id, done, Date.now());
    prepare('UPDATE todo_checks SET done=? WHERE todo_item_id=? AND user_id=?').run(done, itemId, payload.id);
    // 累计完成：项在所有确认都 done 时才算整体完成（简化为有任一成员勾选即算完成）
    const anyDone = prepare('SELECT done FROM todo_checks WHERE todo_item_id=? ORDER BY done DESC LIMIT 1').get(itemId);
    prepare('UPDATE todo_items SET done=? WHERE id=?').run(anyDone && anyDone.done ? 1 : 0, itemId);
    const fresh = prepare('SELECT * FROM todos WHERE id=?').get(todoId);
    okay(res, { todo: todoDto(fresh, payload.id) });
  });

  // ============================================================
  // 定时提醒 /api/reminders/*
  // 到点时往 messages 表写一条提醒消息（from_id=0 系统, to_id=目标 或 group_messages 群内）。
  // ============================================================
  const timers = new Map();

  function pushReminderContent(at, content) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    const title = content || '定时提醒';
    return '[提醒] ' + title + ' (于 ' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ')';
  }

  // 定时器：到点写消息 + 标记 fired。返回是否已安排。
  function schedule(id) {
    const r = prepare('SELECT * FROM reminders WHERE id=?').get(id);
    if (!r) return;
    if (r.fired) return;
    const delay = r.at - Date.now();
    const exec = () => {
      const cur = prepare('SELECT * FROM reminders WHERE id=?').get(id);
      if (!cur || cur.fired) return;
      const content = pushReminderContent(cur.at, cur.content);
      const now = Date.now();
      let inserted = null;
      if (cur.target_type === 'group') {
        if (groupExists(cur.target_id)) {
          const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)').run(cur.target_id, 0, content, now);
          inserted = { kind: 'group', id: info.lastInsertRowid, groupId: cur.target_id };
        }
      } else {
        const info = prepare('INSERT INTO messages(from_id,to_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)').run(0, cur.target_id, content, null, now);
        inserted = { kind: 'direct', id: info.lastInsertRowid, toId: cur.target_id };
      }
      prepare('UPDATE reminders SET fired=1 WHERE id=?').run(id);
      timers.delete(id);
      console.log('[remind] fired reminder #' + id + (inserted ? (' -> ' + inserted.kind + ':' + inserted.id) : ''));
    };
    if (delay <= 0) { setTimeout(exec, 0); return; }
    // setTimeout 上限约 24.8 天；超长提醒必须递归重新调度，否则会提前触发导致提醒错时间。
    if (delay > 2147483647) {
      // 分阶段逼近：睡 7 天后重新评估剩余时间，直到剩余 <= 上限再真正 exec。
      const step = Math.min(delay - 2147483647, 7 * 24 * 3600 * 1000);
      const t = setTimeout(() => { if (!timers.has(id)) return; timers.delete(id); schedule(id); }, step);
      timers.set(id, t);
      return;
    }
    const t = setTimeout(exec, Math.min(delay, 2147483647));
    timers.set(id, t);
  }

  // 扫描未触发提醒（服务启动时恢复）
  try {
    const pending = prepare('SELECT id FROM reminders WHERE fired=0').all();
    for (const p of pending) schedule(p.id);
  } catch (e) { /* 忽略 */ }

  app.post('/api/reminders', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rawTargetType = String((req.body || {}).targetType || 'direct');
    const targetId = parseInt((req.body || {}).targetId, 10);
    const at = parseInt((req.body || {}).at, 10);
    const content = String((req.body || {}).content || '').trim().slice(0, 300) || '定时提醒';
    if (!Number.isInteger(targetId)) return deny(res, 400, '目标无效');
    if (!Number.isInteger(at) || at <= 0) return deny(res, 400, '提醒时间无效');
    // 拒绝过去时间（否则 schedule 会立即触发，等于"立刻发消息"）与超过 1 年的远期
    if (at <= Date.now()) return deny(res, 400, '提醒时间必须晚于当前时间');
    if (at > Date.now() + 365 * 24 * 3600 * 1000) return deny(res, 400, '提醒时间不能超过一年');
    // 配额：单用户最多 200 条未触发提醒，防定时器/内存耗尽
    const pendingCnt = prepare('SELECT COUNT(*) AS c FROM reminders WHERE user_id=? AND fired=0').get(payload.id);
    if (pendingCnt && pendingCnt.c >= 200) return deny(res, 400, '未完成提醒过多（上限200条）');
    let targetType = rawTargetType;
    if (targetType === 'group') {
      if (!groupExists(targetId)) return deny(res, 400, '群不存在');
      if (!inGroup(targetId, payload.id)) return deny(res, 403, '你不在此群');
    } else {
      targetType = 'direct';
      if (targetId !== payload.id) {
        const isFriend = prepare('SELECT 1 FROM friends WHERE status=1 AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))').get(payload.id, targetId, targetId, payload.id);
        if (!isFriend) return deny(res, 403, '只能提醒自己或好友');
      }
    }
    const now = Date.now();
    const info = prepare('INSERT INTO reminders(user_id,target_type,target_id,at,content,fired,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(payload.id, targetType, targetId, at, content, 0, now);
    const id = info.lastInsertRowid;
    schedule(id);
    const r = prepare('SELECT id,user_id AS userId,target_type AS targetType,target_id AS targetId,at,content,created_at AS createdAt FROM reminders WHERE id=?').get(id);
    okay(res, { reminder: r });
  });

  app.get('/api/reminders', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rows = prepare(
      'SELECT id,user_id AS userId,target_type AS targetType,target_id AS targetId,at,content,fired,created_at AS createdAt FROM reminders WHERE user_id=? ORDER BY id DESC').all(payload.id);
    okay(res, { reminders: rows });
  });

  app.delete('/api/reminders/:id', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const id = parseInt(req.params.id, 10);
    const r = prepare('SELECT * FROM reminders WHERE id=?').get(id);
    if (!r) return deny(res, 404, '提醒不存在');
    if (r.user_id !== payload.id) return deny(res, 403, '仅创建者可删除');
    prepare('DELETE FROM reminders WHERE id=?').run(id);
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    okay(res, { reminderId: id });
  });

  // ============================================================
  // 翻译 /api/translate  —— 优先在线(myMemory 免费API)，失败回退内置词典
  // ============================================================
  const LITE_DICT = {
    'hello': '你好', 'world': '世界', 'good': '好', 'morning': '早晨', 'night': '晚上',
    'thank': '谢谢', 'friend': '朋友', 'chat': '聊天', 'message': '消息', 'group': '群',
    '你好': 'Hello', '世界': 'World', '朋友': 'Friend', '聊天': 'Chat', '消息': 'Message',
    '吃饭': 'Eat', '喝水': 'Drink', '工作': 'Work', '学习': 'Study', '谢谢': 'Thanks',
  };

  // 翻译限流（内存桶）：单用户 1 分钟内最多 20 次，防把上游免费 API 刷爆/被封
  const _trBuckets = new Map();
  function _trLimited(userId) {
    const now = Date.now();
    let b = _trBuckets.get(userId);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60 * 1000 }; _trBuckets.set(userId, b); }
    b.count++;
    return b.count > 20;
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of _trBuckets) { if (now > b.resetAt) _trBuckets.delete(k); } }, 5 * 60 * 1000);

  app.post('/api/translate', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    if (_trLimited(payload.id)) return deny(res, 429, '翻译过于频繁，请稍后再试');
    const { text, target = 'zh' } = req.body || {};
    const src = String(text || '').slice(0, 2000);
    if (!src) return deny(res, 400, '没有待翻译文本');
    const lang = String(target) === 'en' ? 'en' : 'zh';
    handleTranslate(src, lang)
      .then((out) => res.json({ ok: true, text, translated: out.translated, source: out.source, detected: out.detected }))
      .catch((e) => res.status(502).json({ error: e.message || '翻译失败' }));
  });

  function handleTranslate(src, lang) {
    return new Promise((resolve, reject) => {
      const lower = src.toLowerCase();
      const dictHit = LITE_DICT[lower];
      if (lang === 'zh' && dictHit) {
        return resolve({ translated: dictHit, source: 'dict', detected: 'en' });
      }
      if (lang === 'en' && LITE_DICT[src]) {
        return resolve({ translated: LITE_DICT[src], source: 'dict', detected: 'zh' });
      }
      const from = lang === 'zh' ? 'auto' : 'auto';
      const to = lang === 'zh' ? 'zh-CN' : 'en';
      const req = https_get('https://api.mymemory.translated.net/get', { q: src, langpair: from + '|' + to }, 12000);
      req.then((body) => {
        let data;
        try { data = JSON.parse(body); } catch (_) { data = {}; }
        const tr = (data && data.responseData && data.responseData.translatedText) || '';
        if (tr && String(tr).toLowerCase() !== String(src).toLowerCase()) {
          resolve({ translated: tr, source: 'mymemory', detected: data.responseData.detectedLanguage || '' });
        } else {
          // 在线失败 → 词典兜底（单向简单映射）
          const hit = lang === 'zh' ? LITE_DICT[src] : LITE_DICT[lower];
          resolve({ translated: hit || src, source: 'dict-fallback', detected: '' });
        }
      }).catch(() => {
        const hit = lang === 'zh' ? LITE_DICT[src] : LITE_DICT[lower];
        resolve({ translated: hit || src, source: 'dict-fallback', detected: '' });
      });
    });
  }

  function https_get(url, params, timeout) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const u = new URL(url);
      u.search = new URLSearchParams(params).toString();
      const req = https.get(u, (resp) => {
        let d = '';
        resp.on('data', (c) => { d += c; });
        resp.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(timeout || 12000, () => { req.destroy(new Error('翻译服务超时')); });
    });
  }

  // ============================================================
  // 群语音消息 /api/solang/voice —— 复用 /api/files 上传，把 [语音消息:uuid] 写入群消息
  // 说明：群语音的字节上传仍走 server/index.js 的 POST /api/files（media.js 风格的原始 body）。
  //       本端点仅提供「面向群内的语音 marker 快捷发送」，供 Web/Flutter 三端调用。
  // ============================================================
  app.post('/api/solang/voice', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const groupId = parseInt((req.query || {}).groupId, 10);
    const fileId = String((req.query || {}).fileId || '').trim();
    if (!Number.isInteger(groupId) || !groupExists(groupId)) return deny(res, 400, '群不存在');
    if (!inGroup(groupId, payload.id)) return deny(res, 403, '你不在此群');
    if (!fileId) return deny(res, 400, '缺少语音文件id');
    const marker = '[语音消息:' + fileId + ']';
    const now = Date.now();
    const info = prepare('INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)')
      .run(groupId, payload.id, marker, now);
    okay(res, { message: { id: info.lastInsertRowid, groupId, from: payload.id, content: marker, createdAt: now } });
  });

  // ============================================================
  // 进程退出时清理定时器
  // ============================================================
  const shutdown = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); });

  console.log('[lifestyle-msg] module batch8 loaded: /api/polls/* /api/solang/* /api/todos/* /api/reminders/* /api/translate');
};
