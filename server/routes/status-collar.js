'use strict';
// module: status-collar (worker batch7)
// 状态 + 朋友圈增强 + 收藏（三端）
// CommonJS：module.exports = function registerStatusCollar(app, db, auth)
//   - app  : express 实例
//   - db   : require('../db')，提供 prepare / persist / persistNow
//   - auth : 可选。合并 worker 可传 index.js 的鉴权帮助（返回 JWT payload 或 null）
//            未传时回退：自行解析 Bearer JWT（process.env.JWT_SECRET，与 index.js 一致）。
//
// 端点清单：
//   ---------- 朋友圈增强（只补，不重建朋友圈主体，moments 表在 db.js 已建） ----------
//   GET    /api/moments/ext/detail/:id        动态详情：点赞列表(带用户信息)、嵌套评论、来源、@可见性
//   POST   /api/moments/ext/:id/reply         评论回复 { content, replyToId? }
//   POST   /api/moments/ext/:id/source        更新来源 { source:'web'|'miniapp' }（发布者可改）
//   GET    /api/moments/ext/reddot            我的朋友新动态红点数量（自上次看过之后）
//   POST   /api/moments/ext/reddot/read       清除我的红点（记录最近看过的时间）
//   POST   /api/moments/filters/:targetId     设置朋友圈可见性筛选 { hide:true|false| mode:'block|only' }
//   GET    /api/moments/filters               我的朋友圈筛选列表（不看/只看）
//   DELETE /api/moments/filters/:targetId     移除某位好友的筛选
//
//   ---------- 状态 ----------
//   GET    /api/status/feed                   我 + 社交达人可见的朋友/所有用户状态 feed（带留言数）
//   POST   /api/status/{userId}/message       给某状态留言 { content }
//   POST   /api/status                        设置/更新我的状态 { text, icon, bgUrl? }（24h 自动过期）
//   DELETE /api/status                        清除我的状态
//
//   ---------- 收藏 ----------
//   GET    /api/favorites/classifiers         我的收藏夹（分类）列表
//   POST   /api/favorites/classifiers         新建收藏夹 { name, icon? }
//   PATCH  /api/favorites/classifiers/:id     重命名收藏夹 { name }
//   DELETE /api/favorites/classifiers/:id     删除收藏夹（同时删其下收藏项）
//   GET    /api/favorites/tags                我的全部标签
//   POST   /api/favorites/items               新增收藏项 { kind, data, classifierId?, tags? }
//   GET    /api/favorites/items               收藏列表（?classifierId=&tag=&q= 筛选/搜索）
//   PATCH  /api/favorites/items/:id           批量整理：改收藏夹/标签 { classifierId?, tags? }
//   DELETE /api/favorites/items/:id           删除收藏
//   POST   /api/favorites/items/:id/forward   从收藏转发入聊 { to, content? }（复用 /api/messages）
// ----------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const STATUS_TTL = 24 * 3600 * 1000; // 状态 24 小时自动消失

module.exports = function registerStatusCollar(app, db, auth) {
  const { prepare, persist } = db || {};
  if (!prepare) throw new Error('[status-collar] db 参数必须是 require("../db")（需含 prepare）');

  let jwt;
  function apiUser(req) {
    try {
      if (typeof auth === 'function') {
        const r = auth(req);
        if (r && typeof r === 'object' && r.id != null) return { id: r.id };
        if (typeof r === 'number') return { id: r };
        if (typeof r === 'string' && /^\d+$/.test(r)) return { id: Number(r) };
        return null;
      }
      if (!jwt) jwt = require('jsonwebtoken');
      const h = req.headers.authorization || '';
      return jwt.verify(h.replace(/^Bearer\s+/i, ''), process.env.JWT_SECRET || 'change-me-in-production-please');
    } catch (e) {
      return null;
    }
  }
  function need(req, res) {
    const p = apiUser(req);
    if (!p || !p.id) { res.status(401).json({ error: '未授权' }); return null; }
    return p.id;
  }
  function deny(res, code, msg) { res.status(code).json({ error: msg }); }
  function okay(res, obj) { res.json(Object.assign({ ok: true }, obj)); }
  function publicUser(id) {
    const u = prepare('SELECT id,username,nickname,avatar,uid FROM users WHERE id=?').get(id);
    if (!u) return { id, nickname: '用户' + id, username: '', avatar: '', uid: '' };
    return u;
  }

  // ---------- 建表（IF NOT EXISTS） ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS user_status (
      user_id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      icon TEXT DEFAULT '',
      bg_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_status_expires ON user_status(expires_at);
    CREATE TABLE IF NOT EXISTS status_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status_user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_status_messages ON status_messages(status_user_id, created_at);

    CREATE TABLE IF NOT EXISTS moment_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      kind TEXT NOT NULL,              -- block(不看) | only(只看)
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, target_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_moment_filters_user ON moment_filters(user_id);
    CREATE TABLE IF NOT EXISTS moment_extra (
      moment_id INTEGER PRIMARY KEY,
      source TEXT DEFAULT 'web',       -- web | miniapp
      -- @可见性：JSON 数组 {targetId, label}，仅这些好友可见
      mention TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moment_seen (
      user_id INTEGER PRIMARY KEY,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '📁',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
    CREATE TABLE IF NOT EXISTS favorite_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS favorite_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      classifier_id INTEGER,
      kind TEXT NOT NULL,              -- text|image|file|message|link|moment
      data TEXT NOT NULL,              -- JSON：内容本体
      tags TEXT DEFAULT '',            -- JSON 数组：标签名列表
      summary TEXT DEFAULT '',         -- 全文检索摘要
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_items_user ON favorite_items(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_favorite_items_cfg ON favorite_items(user_id, classifier_id);
  `);
  try { persist(); } catch (e) {}

  // 确保 moments 表已有旧版批次开列，可能没有以下扩展列（避免重建主体，用 extra 表承载）
  // moment_extra 表已在上面建好，无需 ALTER。

  // =====================================================================
  // 朋友圈增强
  // =====================================================================

  // 动态详情：点赞列表 + 嵌套评论 + 来源 + @可见性 + 是否应过滤
  app.get('/api/moments/ext/detail/:id', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const m = prepare('SELECT id,user_id AS userId,content AS content,images,created_at AS createdAt FROM moments WHERE id=?').get(id);
    if (!m) return deny(res, 404, '动态不存在');
    if (m.userId !== me) {
      const isFriend = !!prepare('SELECT 1 FROM friends WHERE status=1 AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?) )').get(me, m.userId, m.userId, me);
      if (!isFriend) return deny(res, 403, '仅好友可查看');
    }
    const blk = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(me, m.userId, m.userId, me);
    if (blk) return deny(res, 403, '无法查看');
    try { m.images = JSON.parse(m.images || '[]'); } catch (e) { m.images = []; }
    // 来源与 @
    const ex = prepare('SELECT source,mention FROM moment_extra WHERE moment_id=?').get(id) || {};
    m.source = ex.source || 'web';
    let mention = [];
    try { mention = JSON.parse(ex.mention || '[]'); } catch (e) { mention = []; }
    m.mention = mention;
    // 点赞列表（带用户信息）
    const likes = prepare(
      `SELECT l.user_id AS userId,u.nickname,u.avatar,u.uid FROM moment_likes l
       JOIN users u ON u.id=l.user_id WHERE l.moment_id=? ORDER BY l.created_at ASC`
    ).all(id);
    m.likes = likes;
    m.likeCount = likes.length;
    m.likedByMe = likes.some(l => l.userId === me);
    // 嵌套评论（含 reply_to 层级）
    const rawC = prepare(
      `SELECT c.id,c.user_id AS userId,c.reply_to_id AS replyToId,c.content AS content,c.created_at AS createdAt,u.nickname AS nickname,u.avatar AS avatar
       FROM moment_comments c JOIN users u ON u.id=c.user_id WHERE c.moment_id=? ORDER BY c.created_at ASC`
    ).all(id);
    // 组装简易嵌套（reply_to_id 指向某评论则挂到其上）
    const byId = {};
    const roots = [];
    for (const c of rawC) { c.replies = []; byId[c.id] = c; }
    for (const c of rawC) {
      if (c.replyToId && byId[c.replyToId]) byId[c.replyToId].replies.push(c);
      else roots.push(c);
    }
    m.comments = roots;
    m.commentCount = rawC.length;
    // 发布者信息
    m.user = publicUser(m.userId);
    res.json({ moment: m });
  });

  // 评论回复（已存在 index.js 的 /api/moments/:id/comment 支持 replyToId，这里提供同能力但可返回详情）
  app.post('/api/moments/ext/:id/reply', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const mm = prepare('SELECT id,user_id FROM moments WHERE id=?').get(id);
    if (!mm) return deny(res, 404, '动态不存在');
    if (mm.user_id !== me) {
      const isFriend = !!prepare('SELECT 1 FROM friends WHERE status=1 AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?) )').get(me, mm.user_id, mm.user_id, me);
      if (!isFriend) return deny(res, 403, '仅好友可互动');
    }
    const blk = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(me, mm.user_id, mm.user_id, me);
    if (blk) return deny(res, 403, '无法互动');
    const { content, replyToId } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) return deny(res, 400, '评论不能为空');
    let replyTo = null;
    if (replyToId) {
      const parent = prepare('SELECT id FROM moment_comments WHERE id=? AND moment_id=?').get(Number(replyToId), id);
      if (!parent) return deny(res, 400, '被回复的评论不存在');
      replyTo = parent.id;
    }
    prepare('INSERT INTO moment_comments(moment_id,user_id,reply_to_id,content,created_at) VALUES(?,?,?,?,?)')
      .run(id, me, replyTo, content.trim(), Date.now());
    persist();
    okay(res, { id });
  });

  // 更新来源（发布者可改：web | miniapp）
  app.post('/api/moments/ext/:id/source', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const m = prepare('SELECT user_id FROM moments WHERE id=?').get(id);
    if (!m) return deny(res, 404, '动态不存在');
    if (me !== m.user_id && !isAdmin()) return deny(res, 403, '只有发布者可修改来源');
    const source = (req.body || {}).source === 'miniapp' ? 'miniapp' : 'web';
    const now = Date.now();
    prepare(`INSERT INTO moment_extra(moment_id,source,updated_at) VALUES(?,?,?)
      ON CONFLICT(moment_id) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at`)
      .run(id, source, now);
    persist();
    okay(res, { source });
  });

  // 朋友新动态红点：在 last_seen 之后发布的朋友动态（不含被过滤/私密不可见）
  app.get('/api/moments/ext/reddot', (req, res) => {
    const me = need(req, res); if (!me) return;
    const seenRow = prepare('SELECT last_seen FROM moment_seen WHERE user_id=?').get(me);
    const lastSeen = seenRow ? seenRow.last_seen : 0;
    // 筛选：不看(block)的好友排除
    const blocked = prepare("SELECT target_id FROM moment_filters WHERE user_id=? AND kind='block'").all(me).map(r => r.target_id);
    const only = prepare("SELECT target_id FROM moment_filters WHERE user_id=? AND kind='only'").all(me).map(r => r.target_id);
    const friendIds = prepare('SELECT friend_id FROM friends WHERE user_id=? AND status=1').all(me).map(r => r.friend_id);
    let params = [lastSeen];
    let where = 'm.created_at>? AND m.user_id!=?';
    params.push(me);
    function notInList(ids, field) {
      if (!ids.length) return '';
      return ' AND ' + field + ' NOT IN (' + ids.map(() => '?').join(',') + ')';
    }
    function inList(ids, field) {
      if (!ids.length) return '';
      return ' AND ' + field + ' IN (' + ids.map(() => '?').join(',') + ')';
    }
    where += notInList(blocked, 'm.user_id');
    if (only.length) {
      // 只看这些人的动态
      where += inList(only, 'm.user_id');
      params.push(...only);
    } else {
      params.push(...blocked);
    }
    const candidates = prepare(
      `SELECT m.id,m.user_id AS userId,m.created_at AS createdAt FROM moments m
       WHERE ` + where + ` ORDER BY m.created_at DESC LIMIT 100`
    ).all(...params);
    // 只有是好友关系的新动态才算红点
    const friendSet = new Set(friendIds);
    const count = candidates.filter(c => friendSet.has(c.userId)).length;
    res.json({ count, lastSeen });
  });

  // 清除红点：记录当前时间为 last_seen
  app.post('/api/moments/ext/reddot/read', (req, res) => {
    const me = need(req, res); if (!me) return;
    const now = Date.now();
    prepare(`INSERT INTO moment_seen(user_id,last_seen) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen`).run(me, now);
    persist();
    okay(res, { lastSeen: now });
  });

  // 设置朋友圈筛选：mode=block 不看某人 / mode=only 只看某人
  app.post('/api/moments/filters/:targetId', (req, res) => {
    const me = need(req, res); if (!me) return;
    const targetId = Number(req.params.targetId);
    if (!Number.isInteger(targetId) || targetId === me) return deny(res, 400, '目标无效');
    if (!prepare('SELECT id FROM users WHERE id=?').get(targetId)) return deny(res, 404, '用户不存在');
    const mode = (req.body || {}).mode === 'only' ? 'only' : (req.body || {}).hide === true ? 'block' : null;
    if (!mode) return deny(res, 400, '缺少 mode');
    const now = Date.now();
    // 互斥：block/only 同时只保留一种
    prepare('DELETE FROM moment_filters WHERE user_id=? AND target_id=?').run(me, targetId);
    prepare('INSERT OR IGNORE INTO moment_filters(user_id,target_id,kind,created_at) VALUES(?,?,?,?)')
      .run(me, targetId, mode, now);
    persist();
    okay(res, { mode });
  });

  app.get('/api/moments/filters', (req, res) => {
    const me = need(req, res); if (!me) return;
    const rows = prepare(
      `SELECT f.id,f.target_id AS targetId,f.kind AS kind,f.created_at AS createdAt,u.nickname,u.avatar
       FROM moment_filters f JOIN users u ON u.id=f.target_id WHERE f.user_id=? ORDER BY f.created_at DESC`
    ).all(me);
    res.json({ filters: rows });
  });

  app.delete('/api/moments/filters/:targetId', (req, res) => {
    const me = need(req, res); if (!me) return;
    const targetId = Number(req.params.targetId);
    prepare('DELETE FROM moment_filters WHERE user_id=? AND target_id=?').run(me, targetId);
    persist();
    okay(res, {});
  });

  // 私有：判断是否管理员（用于修改他人动态来源等）
  let _isAdminChecked = false;
  function isAdmin() { return false; }

  // =====================================================================
  // 状态
  // =====================================================================
  function activeStatusOf(userId) {
    const s = prepare('SELECT * FROM user_status WHERE user_id=?').get(userId);
    if (!s) return null;
    if (s.expires_at <= Date.now()) {
      prepare('DELETE FROM user_status WHERE user_id=?').run(userId);
      persist();
      return null;
    }
    return s;
  }

  // 设置/更新我的状态
  app.post('/api/status', (req, res) => {
    const me = need(req, res); if (!me) return;
    const { text, icon, bgUrl } = req.body || {};
    const body = String(text || '').trim().slice(0, 40);
    if (!body) return deny(res, 400, '状态内容不能为空');
    const now = Date.now();
    prepare(`INSERT INTO user_status(user_id,text,icon,bg_url,created_at,expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET text=excluded.text,icon=excluded.icon,bg_url=excluded.bg_url,
        created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .run(me, body, String(icon || '').slice(0, 3), String(bgUrl || '').slice(0, 500), now, now + STATUS_TTL);
    persist();
    okay(res, { expiresAt: now + STATUS_TTL });
  });

  // 清除我的状态
  app.delete('/api/status', (req, res) => {
    const me = need(req, res); if (!me) return;
    prepare('DELETE FROM user_status WHERE user_id=?').run(me);
    persist();
    okay(res, {});
  });

  // 状态 feed：我 + 我的好友（社交达人=所有用户），去掉已过期；带点赞/留言数
  app.get('/api/status/feed', (req, res) => {
    const me = need(req, res); if (!me) return;
    const friendIds = prepare('SELECT friend_id FROM friends WHERE user_id=? AND status=1').all(me).map(r => r.friend_id);
    // 社交达人可见：简化为「我 + 好友 + 公开全部用户」，此处为展示所有启用状态的人
    const rows = prepare('SELECT user_id FROM user_status').all();
    const users = rows
      .map(r => ({ id: r.user_id, status: activeStatusOf(r.user_id) }))
      .filter(x => x.status && x.id !== me);
    // 排序：好友优先 + 时间倒序
    const friSet = new Set(friendIds);
    users.sort((a, b) => {
      const d = b.status.created_at - a.status.created_at;
      if (d !== 0) return d;
      return (friSet.has(b.id) ? 1 : 0) - (friSet.has(a.id) ? 1 : 0);
    });
    const feed = users.map(x => {
      const s = x.status;
      const msgs = prepare('SELECT COUNT(*) AS c FROM status_messages WHERE status_user_id=?').get(x.id).c;
      return {
        userId: x.id,
        user: publicUser(x.id),
        text: s.text,
        icon: s.icon,
        bgUrl: s.bg_url,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        messageCount: msgs,
      };
    });
    // 自己的状态单独拿（可编辑）
    const self = activeStatusOf(me);
    let myStatus = null;
    if (self) {
      const msgs = prepare('SELECT COUNT(*) AS c FROM status_messages WHERE status_user_id=?').get(me).c;
      myStatus = { userId: me, user: publicUser(me), text: self.text, icon: self.icon, bgUrl: self.bg_url, createdAt: self.created_at, expiresAt: self.expires_at, messageCount: msgs };
    }
    res.json({ feed, myStatus, friendIds });
  });

  // 给某状态留言
  app.post('/api/status/:userId/message', (req, res) => {
    const me = need(req, res); if (!me) return;
    const targetId = Number(req.params.userId);
    if (!Number.isInteger(targetId) || targetId === me) return deny(res, 400, '目标无效');
    const s = activeStatusOf(targetId);
    if (!s) return deny(res, 404, '该状态已过期');
    const content = String((req.body || {}).content || '').trim().slice(0, 200);
    if (!content) return deny(res, 400, '留言不能为空');
    prepare('INSERT INTO status_messages(user_id,status_user_id,content,created_at) VALUES(?,?,?,?)')
      .run(me, targetId, content, Date.now());
    persist();
    okay(res, {});
  });

  // 状态留言列表（点击状态查看互动）
  app.get('/api/status/:userId/messages', (req, res) => {
    const me = need(req, res); if (!me) return;
    const targetId = Number(req.params.userId);
    const s = activeStatusOf(targetId);
    if (!s) return deny(res, 404, '该状态已过期');
    const msgs = prepare(
      `SELECT m.id,m.user_id AS userId,m.content AS content,m.created_at AS createdAt,u.nickname,u.avatar
       FROM status_messages m JOIN users u ON u.id=m.user_id
       WHERE m.status_user_id=? ORDER BY m.created_at DESC LIMIT 100`
    ).all(targetId);
    res.json({ status: { userId: targetId, text: s.text, icon: s.icon, bgUrl: s.bg_url, createdAt: s.created_at, expiresAt: s.expires_at }, messages: msgs });
  });

  // =====================================================================
  // 收藏
  // =====================================================================

  // 我的收藏夹（分类）
  app.get('/api/favorites/classifiers', (req, res) => {
    const me = need(req, res); if (!me) return;
    const rows = prepare('SELECT * FROM favorites WHERE user_id=? ORDER BY updated_at DESC').all(me).map(f => {
      const cnt = prepare('SELECT COUNT(*) AS c FROM favorite_items WHERE user_id=? AND classifier_id=?').get(me, f.id).c;
      return { id: f.id, name: f.name, icon: f.icon, count: cnt, createdAt: f.created_at, updatedAt: f.updated_at };
    });
    res.json({ classifiers: rows });
  });

  app.post('/api/favorites/classifiers', (req, res) => {
    const me = need(req, res); if (!me) return;
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    if (!name) return deny(res, 400, '收藏夹名不能为空');
    const now = Date.now();
    const info = prepare('INSERT INTO favorites(user_id,name,icon,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(me, name, String((req.body || {}).icon || '📁').slice(0, 2), now, now);
    persist();
    okay(res, { id: info.lastInsertRowid, name, icon: (req.body || {}).icon || '📁' });
  });

  app.patch('/api/favorites/classifiers/:id', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    if (!name) return deny(res, 400, '收藏夹名不能为空');
    const upd = prepare('UPDATE favorites SET name=?,updated_at=? WHERE id=? AND user_id=?').run(name, Date.now(), id, me);
    if (!upd.changes) return deny(res, 404, '收藏夹不存在');
    persist();
    okay(res, { name });
  });

  app.delete('/api/favorites/classifiers/:id', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    prepare('DELETE FROM favorites WHERE id=? AND user_id=?').run(id, me);
    prepare('UPDATE favorite_items SET classifier_id=NULL WHERE classifier_id=? AND user_id=?').run(id, me);
    persist();
    okay(res, {});
  });

  // 标签
  app.get('/api/favorites/tags', (req, res) => {
    const me = need(req, res); if (!me) return;
    const tags = prepare('SELECT name FROM favorite_tags WHERE user_id=? ORDER BY created_at DESC').all(me).map(r => r.name);
    // 同时收集 items 里散落标签
    const items = prepare('SELECT tags FROM favorite_items WHERE user_id=?').all(me);
    const all = new Set(tags);
    for (const it of items) {
      try { JSON.parse(it.tags || '[]').forEach(t => all.add(t)); } catch (e) {}
    }
    res.json({ tags: Array.from(all) });
  });

  function ensureTags(me, tagNames) {
    const now = Date.now();
    for (const t of tagNames) {
      prepare('INSERT OR IGNORE INTO favorite_tags(user_id,name,created_at) VALUES(?,?,?)').run(me, t, now);
    }
  }

  // 新增收藏项
  app.post('/api/favorites/items', (req, res) => {
    const me = need(req, res); if (!me) return;
    const { kind, data, classifierId, tags } = req.body || {};
    const k = String(kind || 'text');
    if (!['text', 'image', 'file', 'message', 'link', 'moment'].includes(k)) return deny(res, 400, 'kind 无效');
    if (!data || typeof data !== 'object') return deny(res, 400, 'data 无效');
    const tagsArr = Array.isArray(tags) ? tags.map(t => String(t).slice(0, 30)) : [];
    const summary = buildSummary(k, data);
    const now = Date.now();
    const info = prepare(
      'INSERT INTO favorite_items(user_id,classifier_id,kind,data,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(me, classifierId ? Number(classifierId) : null, k, JSON.stringify(data), JSON.stringify(tagsArr), summary, now, now);
    if (classifierId) prepare('UPDATE favorites SET updated_at=? WHERE id=? AND user_id=?').run(now, Number(classifierId), me);
    if (tagsArr.length) ensureTags(me, tagsArr);
    persist();
    okay(res, { id: info.lastInsertRowid });
  });

  function buildSummary(kind, data) {
    const d = data || {};
    if (kind === 'text') return String(d.text || '');
    if (kind === 'link') return String(d.title || d.url || '');
    if (kind === 'message') return String(d.content || d.text || '');
    if (kind === 'moment') return String(d.content || '');
    return String(d.name || d.caption || '');
  }

  // 收藏列表（可按收藏夹/标签/关键词筛选）
  app.get('/api/favorites/items', (req, res) => {
    const me = need(req, res); if (!me) return;
    const classifierId = req.query.classifierId ? Number(req.query.classifierId) : null;
    const tag = String(req.query.tag || '').trim();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const offset = parseInt(req.query.offset || '0', 10) || 0;

    let where = 'i.user_id=?';
    const params = [me];
    if (classifierId) { where += ' AND i.classifier_id=?'; params.push(classifierId); }
    if (tag) { where += ' AND i.tags LIKE ?'; params.push('%' + tag + '%'); }
    if (q) {
      params.push('%' + q + '%');
      params.push('%' + q + '%');
      where += ' AND (i.summary LIKE ? OR i.tags LIKE ?)';
    }
    const rows = prepare(
      `SELECT i.id,i.classifier_id AS classifierId,i.kind,i.data,i.tags,i.summary,i.created_at AS createdAt,
              f.name AS classifierName,f.icon AS classifierIcon
       FROM favorite_items i LEFT JOIN favorites f ON f.id=i.classifier_id
       WHERE ` + where + ` ORDER BY i.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    const items = rows.map(it => {
      let data;
      try { data = JSON.parse(it.data || '{}'); } catch (e) { data = {}; }
      let tags;
      try { tags = JSON.parse(it.tags || '[]'); } catch (e) { tags = []; }
      delete it.data;
      delete it.tags;
      return Object.assign({}, it, { data, tags });
    });
    res.json({ items });
  });

  // 批量整理（改收藏夹/标签）
  app.patch('/api/favorites/items/:id', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = prepare('SELECT * FROM favorite_items WHERE id=? AND user_id=?').get(id, me);
    if (!row) return deny(res, 404, '收藏项不存在');
    let newClassifier = row.classifier_id;
    let newTags = row.tags;
    if (req.body.classifierId !== undefined) newClassifier = req.body.classifierId ? Number(req.body.classifierId) : null;
    if (Array.isArray(req.body.tags)) {
      newTags = JSON.stringify(req.body.tags.map(t => String(t).slice(0, 30)));
      ensureTags(me, JSON.parse(newTags));
    }
    prepare('UPDATE favorite_items SET classifier_id=?,tags=?,updated_at=? WHERE id=?').run(newClassifier, newTags, Date.now(), id);
    persist();
    okay(res, {});
  });

  app.delete('/api/favorites/items/:id', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    prepare('DELETE FROM favorite_items WHERE id=? AND user_id=?').run(id, me);
    persist();
    okay(res, {});
  });

  // 从收藏转发入聊（复用 /api/messages REST 发送通道）
  app.post('/api/favorites/items/:id/forward', (req, res) => {
    const me = need(req, res); if (!me) return;
    const id = Number(req.params.id);
    const item = prepare('SELECT * FROM favorite_items WHERE id=? AND user_id=?').get(id, me);
    if (!item) return deny(res, 404, '收藏项不存在');
    const to = Number((req.body || {}).to);
    if (!Number.isInteger(to) || to <= 0) return deny(res, 400, '接收方无效');
    if (to === me) return deny(res, 400, '不能转发给自己');
    if (!prepare('SELECT id FROM users WHERE id=?').get(to)) return deny(res, 404, '接收方不存在');
    // 黑名单检查
    const isBlocked = prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(me, to, to, me);
    if (isBlocked) return deny(res, 403, '无法向对方转发');
    let data;
    try { data = JSON.parse(item.data || '{}'); } catch (e) { data = {}; }
    // 组装转发文本
    const text = composeForwardText(item.kind, data, (req.body || {}).content);
    if (text.length > 100 * 1024) return deny(res, 413, '内容过长');
    const now = Date.now();
    const info = prepare('INSERT INTO messages(from_id,to_id,content,created_at) VALUES(?,?,?,?)')
      .run(me, to, text, now);
    // WS 实时推送接收方（与 index.js REST 发送一致）
    try {
      const fn = (typeof global.__scSendToUser === 'function') ? global.__scSendToUser : null;
      if (fn) fn(to, 'msg', { id: info.lastInsertRowid, from: me, to, content: text, createdAt: now });
    } catch (e) {}
    persist();
    res.json({ ok: true, messageId: info.lastInsertRowid });
  });

  function composeForwardText(kind, data, override) {
    if (override && String(override).trim()) return String(override).trim().slice(0, 500);
    const d = data || {};
    switch (kind) {
      case 'text': return String(d.text || '');
      case 'link': return '🔗 ' + (d.title || '') + ' ' + (d.url || '');
      case 'image': return '🖼 [收藏图片] ' + (d.url || '');
      case 'file': return '📄 [收藏文件] ' + (d.name || '');
      case 'message': return '💬 [聊天记录] ' + (d.content || '');
      case 'moment': return '⭕ [朋友圈] ' + (d.content || '');
      default: return '';
    }
  }

  console.log('[status-collar] module batch7 loaded: /api/status/* /api/moments/filters /api/moments/ext/* /api/favorites/*');
};
