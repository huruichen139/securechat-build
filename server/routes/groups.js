'use strict';
// module: groups (worker batch1)
// 群聊体系独立模块：创建群/解散群/退出群/邀请/移除成员、群公告(置顶·非管理员只读)、
// 群文件、群聊设置(免打扰/群备注/我在本群的昵称)、群成员列表、群消息收发。
// 导出 CommonJS：module.exports = function registerGroups(app, db, auth)
//   - app  : express 实例
//   - db   : sql.js 数据库对象（id 参考 server/db.js）
//   - auth : 鉴权中间件 (req,res,next)。若未提供，则用内置 JWT 校验（与 server/index.js 相同 secret）。
//
// 仅供合并：本模块使用 require('../db') 的 prepare/persist 自足运行，
// 不影响 server/index.js / server/db.js 巨石文件。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');

const gdb = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

// ---------- 群文件存储目录（与 server/files 同级，避免依赖巨石文件常量）----------
const GROUP_FILES_DIR = process.env.GROUP_FILES_DIR || path.join(__dirname, '..', 'group-files');
try { fs.mkdirSync(GROUP_FILES_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }

// ---------- 共享 prepare：优先用 db.js 的（自带落盘）----------
// p 在 registerGroups 内被赋值；其余内部函数均通过闭包变量 p 访问。
let P = null;
let EDB = null;
function eof(sp) { return gdb && typeof gdb.prepare === 'function'; }
function prep() {
  // 退路：直接基于传入 EDB（不自动落盘，合并时可自行精简）
  return (sql) => {
    const stmt = EDB.prepare(sql);
    return {
      run(...args) { stmt.run(args); try { const row = EDB.exec('SELECT last_insert_rowid() as id'); return { lastInsertRowid: row && row.length ? row[0].values[0][0] : 0 }; } catch (e) { return { changes: 0 }; } },
      get(...args) { stmt.reset(); stmt.bind(args); const row = stmt.step() ? stmt.getAsObject() : null; return row; },
      all(...args) { stmt.reset(); stmt.bind(args); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; },
    };
  };
}
const p = { get: (sql, ...a) => P(sql).get(...a), all: (sql, ...a) => P(sql).all(...a), run: (sql, ...a) => P(sql).run(...a) };

// 内建 publicUser（与 index.js 一致），避免依赖巨石局部函数
function publicUser(u) {
  if (!u) return null;
  let extra = {};
  try { extra = JSON.parse((u.extra && u.extra) || '{}') || {}; } catch (e) { extra = {}; }
  return {
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
    uid: u.uid, email: u.email || '',
    country: u.country || '', province: u.province || '', city: u.city || '',
    extra: extra, pubkey: u.pubkey || '', lastSeen: u.last_seen || null
  };
}

function verifyUser(req) {
  const auth = req.headers.authorization || '';
  try {
    const payload = jwt.verify(auth.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    if (!payload || !payload.id) return null;
    const u = gdb.prepare('SELECT token_version, banned FROM users WHERE id=?').get(payload.id);
    if (!u) return null;
    if ((payload.tv || 0) !== (u.token_version || 0)) return null;
    if (u.banned) return null;
    return payload;
  } catch { return null; }
}
function apiUser(req) {
  try { return verifyUser(req); } catch (e) { return null; }
}
function fail(res, code, error) { res.status(code).json({ error }); }
// 内置鉴权中间件（当外部未注入 auth 时使用）
function defaultAuth(req, res, next) {
  const payload = apiUser(req);
  if (!payload) return fail(res, 401, '未授权');
  req.user = payload;
  next();
}

// 是否群成员；返回成员行或 null
function memberOf(groupId, userId) {
  return p.get('SELECT gm.id, gm.group_id AS groupId, gm.user_id AS userId FROM group_members gm WHERE gm.group_id=? AND gm.user_id=?', groupId, userId);
}
function groupExists(groupId) {
  return p.get('SELECT id FROM groups WHERE id=?', groupId);
}
function blockedEither(a, b) { return !!p.get('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a); }
function grantJoin(groupId, userId) { try { p.run('INSERT OR IGNORE INTO group_join_grants(group_id,user_id,created_at) VALUES(?,?,?)', groupId, userId, Date.now()); } catch (e) {} }

function myGroups(userId) {
  const groups = p.all(
    `SELECT g.id, g.name, g.owner_id AS ownerId, g.created_at AS createdAt
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id=? ORDER BY g.id`, userId);
  return groups.map(g => {
    const ann = p.get('SELECT content, publisher_id AS publisherId, pinned, updated_at AS updatedAt FROM group_announcements WHERE group_id=?', g.id) || null;
    const note = p.get('SELECT note FROM group_setting_notes WHERE group_id=? AND user_id=?', g.id, userId);
    const mine = p.get('SELECT my_nickname, muted FROM group_member_settings WHERE group_id=? AND user_id=?', g.id, userId);
    const last = p.get(
      `SELECT gm.id, gm.from_id AS fromId, gm.content, gm.created_at AS createdAt, u.id AS userId, u.nickname, u.avatar
       FROM group_messages gm LEFT JOIN users u ON u.id = gm.from_id
       WHERE gm.group_id=? ORDER BY gm.created_at DESC LIMIT 1`, g.id);
    const members = p.all(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.last_seen, gms.my_nickname FROM group_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN group_member_settings gms ON gms.group_id=m.group_id AND gms.user_id=m.user_id
       WHERE m.group_id=? ORDER BY m.joined_at ASC`, g.id);
    return {
      id: g.id, name: g.name, ownerId: g.ownerId, createdAt: g.createdAt,
      displayName: (note && note.note) || g.name,
      muted: (mine && mine.muted) ? true : false,
      myNickname: (mine && mine.my_nickname) || null,
      announcement: ann ? { content: ann.content, publisherId: ann.publisherId, pinned: !!ann.pinned, updatedAt: ann.updatedAt } : null,
      members: members.map(m => ({ ...publicUser(m), myNickname: m.my_nickname || null })),
      memberCount: members.length,
      lastMessage: last ? { id: last.id, from: last.fromId, content: last.content, createdAt: last.createdAt, fromUser: publicUser(last) } : null,
    };
  });
}

// 群消息返回体补全 sender 昵称（考虑「本群昵称」覆盖）+ 已读信息
function groupMsgDto(r, viewerId) {
  const sender = p.get(
    `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.last_seen,gms.my_nickname
     FROM users u LEFT JOIN group_member_settings gms ON gms.group_id=? AND gms.user_id=u.id
     WHERE u.id=?`, r.group_id, r.from_id);
  const name = (sender && (sender.my_nickname || sender.nickname)) || ('用户' + r.from_id);
  let read = false, readCount = 0;
  try {
    const rc = p.get('SELECT COUNT(*) AS c FROM message_reads mr JOIN group_members gm ON gm.user_id=mr.user_id AND gm.group_id=? WHERE mr.message_id=?', r.group_id, r.id);
    readCount = rc ? Number(rc.c) || 0 : 0;
    if (viewerId != null) {
      const mine = p.get('SELECT 1 FROM message_reads WHERE message_id=? AND user_id=?', r.id, viewerId);
      read = !!mine;
    }
  } catch (e) { /* message_reads 表缺失时忽略 */ }
  return {
    id: r.id, groupId: r.group_id, from: r.from_id,
    content: r.content, createdAt: r.created_at,
    clientMsgId: r.client_msg_id || null,
    fromUser: { id: r.from_id, username: sender && sender.username, nickname: name, avatar: sender && sender.avatar, uid: sender && sender.uid },
    replyTo: r.reply_to || null, replyContent: r.reply_content || null, replyFrom: r.reply_from || null, replyRecalled: !!r.reply_recalled,
    forwardedFrom: r.forwarded_from || null,
    recalled: !!r.recalled,
    read, readCount,
  };
}

// 追加群消息并尝试实时分发（若巨石 worker 通过 require.cache 注入分发器）
function insertGroupMessage(groupId, fromId, content, clientMsgId) {
  // 重试复用 clientMsgId 时返回原消息，避免重复插入与重复广播
  if (clientMsgId) {
    try {
      const existing = p.get(
        'SELECT id, group_id, from_id, content, created_at FROM group_messages WHERE client_msg_id=? AND from_id=? AND group_id=?',
        clientMsgId, fromId, groupId);
      if (existing) {
        return { id: existing.id, groupId: existing.group_id, from: existing.from_id, content: existing.content, createdAt: existing.created_at, clientMsgId };
      }
    } catch (e) { /* 老库无该列时忽略 */ }
  }
  const now = Date.now();
  const info = p.run(
    'INSERT INTO group_messages(group_id,from_id,content,client_msg_id,created_at) VALUES(?,?,?,?,?)',
    groupId, fromId, content, clientMsgId || null, now);
  const id = info.lastInsertRowid;
  const msg = { id, groupId, from: fromId, content, createdAt: now, clientMsgId: clientMsgId || null };
  // 事件分发钩子：registerGroups 会从 app.locals 读取合并方注入的可选广播
  broadcastHook && broadcastHook(groupId, msg);
  return msg;
}

let broadcastHook = null;
function setBroadcastHook(fn) { broadcastHook = fn || null; }
let recallHook = null;
function setRecallHook(fn) { recallHook = fn || null; }
let memberChangeHook = null;
function setMemberChangeHook(fn) { memberChangeHook = fn || null; }

module.exports = function registerGroups(app, db, auth) {
  // 构造 prepare：优先用 db.js 的（自带落盘）；否则退回纯 sql.js
  if (gdb && typeof gdb.prepare === 'function') {
    // gdb.prepare(sql) 返回 { run, get, all }
    P = (sql) => gdb.prepare(sql);
    EDB = db;
  } else {
    EDB = db;
    P = prep();
  }
  if (!EDB) { EDB = { run: () => {}, exec: () => [], prepare: () => ({}) }; }

  // ---------- 自建表（IF NOT EXISTS，安全幂等）----------
  try {
    const dbObj = EDB;
    dbObj.run(`
      CREATE TABLE IF NOT EXISTS group_announcements (
        group_id INTEGER PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        publisher_id INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_setting_notes (
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS group_member_settings (
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        my_nickname TEXT,
        muted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS group_files (
        id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        uploader_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_files_group ON group_files(group_id, created_at);
      CREATE TABLE IF NOT EXISTS group_message_meta (
        message_id INTEGER PRIMARY KEY,
        reply_to   INTEGER,
        forwarded_from INTEGER,
        pinned     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      `);
    } catch (e) { /* 表已存在或异地库不可用，忽略 */ }

  try { p.run('CREATE TABLE IF NOT EXISTS group_join_grants(group_id INTEGER, user_id INTEGER, created_at INTEGER, UNIQUE(group_id,user_id))'); } catch (e) {}
  const mw = (typeof auth === 'function') ? auth : defaultAuth;

  // ---------- 创建群：POST /api/groups { name, memberUids:[] } ----------
  app.post('/api/groups', mw, (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return fail(res, 400, '群名不能为空');
    const groupName = name.slice(0, 50);
    const memberUids = Array.isArray((req.body || {}).memberUids) ? (req.body.memberUids) : [];
    let uidList = [];
    if ((req.body || {}).uid && typeof (req.body.uid) === 'string') uidList.push(req.body.uid);
    if (typeof (req.body || {}).inviteUid === 'string') uidList.push(req.body.inviteUid);
    const allUids = (req.body && Array.isArray(req.body.uids)) ? req.body.uids.slice(0, 500) : uidList.length ? uidList : memberUids.slice(0, 500);
    const now = Date.now();
    const info = p.run('INSERT INTO groups(name,owner_id,created_at) VALUES(?,?,?)', groupName, req.user.id, now);
    const groupId = info.lastInsertRowid;
    p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, req.user.id, now);
    const added = [];
    if (Array.isArray(allUids)) {
      for (const uid of allUids) {
        if (!uid || typeof uid !== 'string') continue;
        const target = p.get('SELECT id FROM users WHERE uid=? AND id<>?', uid, req.user.id);
        if (!target) { continue; }
        if (blockedEither(target.id, req.user.id)) continue;
        if (memberOf(groupId, target.id)) { continue; }
        p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, target.id, now);
        grantJoin(groupId, target.id);
        added.push(target.id);
      }
    }
    res.json({ ok: true, group: { id: groupId, name: groupName, ownerId: req.user.id }, added });
  });

  // ---------- 我的群列表（增强）：GET /api/groups/enhanced ----------
  app.get('/api/groups/enhanced', mw, (req, res) => {
    res.json({ groups: myGroups(req.user.id) });
  });

  // ---------- 群详情：GET /api/groups/:id ----------
  app.get('/api/groups/:id', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const ann = p.get('SELECT content, publisher_id AS publisherId, pinned, created_at AS createdAt, updated_at AS updatedAt FROM group_announcements WHERE group_id=?', groupId) || null;
    const members = p.all(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.last_seen,gms.my_nickname,gms.muted
       FROM group_members m JOIN users u ON u.id=m.user_id
       LEFT JOIN group_member_settings gms ON gms.group_id=m.group_id AND gms.user_id=m.user_id
       WHERE m.group_id=? ORDER BY m.joined_at ASC`, groupId);
    const mine = p.get('SELECT my_nickname, muted FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    const note = p.get('SELECT note FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    res.json({
      group: {
        id: g.id, name: g.name, ownerId: g.owner_id, createdAt: g.created_at,
        displayName: note.note || g.name, muted: !!mine.muted, myNickname: mine.my_nickname || null,
        announcement: ann, isOwner: g.owner_id === req.user.id,
        members: members.map(m => ({ ...publicUser(m), myNickname: m.my_nickname || null })),
      }
    });
  });

  // ---------- 邀请入群：POST /api/groups/:id/invite { userIds:[] | uids:[] , intro } ----------
  app.post('/api/groups/:id/invite', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const body = req.body || {};
    let uids = [];
    const userIds = Array.isArray(body.userIds) ? body.userIds.map(v => parseInt(v, 10)).filter(Number.isInteger) : [];
    if (Array.isArray(body.uids)) uids = body.uids;
    if (body.uid && typeof body.uid === 'string') uids.push(body.uid);
    const added = [];
    const g = p.get('SELECT id, name, owner_id FROM groups WHERE id=?', groupId);
    for (const userId of userIds) {
      const target = p.get('SELECT id FROM users WHERE id=?', userId);
      if (!target || target.id === req.user.id || memberOf(groupId, target.id)) continue;
      if (blockedEither(target.id, req.user.id) || blockedEither(target.id, g.owner_id)) continue;
      p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, target.id, Date.now());
      grantJoin(groupId, target.id);
      added.push(target.id);
    }
    for (const uid of uids) {
      if (!uid || typeof uid !== 'string') continue;
      const target = p.get('SELECT id FROM users WHERE uid=?', uid);
      if (!target) continue;
      if (target.id === req.user.id) continue;
      if (blockedEither(target.id, req.user.id) || blockedEither(target.id, g.owner_id)) continue;
      if (memberOf(groupId, target.id)) continue;
      p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, target.id, Date.now());
      grantJoin(groupId, target.id);
      added.push(target.id);
    }
    const intro = String(body.intro || '').trim().slice(0, 200);
    if (added.length && intro) {
      insertGroupMessage(groupId, req.user.id, '邀请说明：' + intro);
    }
    res.json({ ok: true, added, count: added.length });
  });

  // ---------- 移除成员：POST /api/groups/:id/remove { userId } ----------
  app.post('/api/groups/:id/remove', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (g.owner_id !== req.user.id) return fail(res, 403, '仅群主可移除成员');
    const targetId = parseInt((req.body || {}).userId, 10);
    if (!targetId || targetId === req.user.id) return fail(res, 400, '目标无效');
    if (!memberOf(groupId, targetId)) return fail(res, 404, '该成员不在群中');
    p.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', groupId, targetId);
    p.run('DELETE FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, targetId);
    p.run('DELETE FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, targetId);
    try { p.run('DELETE FROM group_join_grants WHERE group_id=? AND user_id=?', groupId, targetId); } catch (e) {}
    try { memberChangeHook && memberChangeHook(groupId, targetId, 'removed'); } catch (e) {}
    res.json({ ok: true });
  });

  // ---------- 加入群（按群ID直接加入）：POST /api/groups/:id/join ----------
  app.post('/api/groups/:id/join', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (memberOf(groupId, req.user.id)) return fail(res, 400, '你已在此群');
    const grant = p.get('SELECT 1 FROM group_join_grants WHERE group_id=? AND user_id=?', groupId, req.user.id);
    if (!grant) return fail(res, 403, '需要群主邀请才能加入');
    p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, req.user.id, Date.now());
    p.run('DELETE FROM group_join_grants WHERE group_id=? AND user_id=?', groupId, req.user.id);
    res.json({ ok: true, groupId });
  });

  // ---------- 退出群：POST /api/groups/:id/leave ----------
  app.post('/api/groups/:id/leave', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    // 群主不可退出（应先解散），直接报错提示
    if (g.owner_id === req.user.id) return fail(res, 400, '群主不能退出群，请解散群或转让群主后退出');
    p.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', groupId, req.user.id);
    p.run('DELETE FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id);
    p.run('DELETE FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, req.user.id);
    try { memberChangeHook && memberChangeHook(groupId, req.user.id, 'left'); } catch (e) {}
    res.json({ ok: true });
  });

  // ---------- 解散群：POST /api/groups/:id/dissolve ----------
  app.post('/api/groups/:id/dissolve', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (g.owner_id !== req.user.id) return fail(res, 403, '仅群主可解散群');
    // 先通知所有在线成员群已解散（然后再删数据）
    try {
      const dissMembers = p.all('SELECT user_id FROM group_members WHERE group_id=?', groupId);
      for (const dm of dissMembers) {
        try { memberChangeHook && memberChangeHook(groupId, dm.user_id, 'dissolved'); } catch (e) {}
      }
    } catch (e) {}
    try { p.run('DELETE FROM group_message_meta WHERE message_id IN (SELECT id FROM group_messages WHERE group_id=?)', groupId); } catch (e) {}
    try { p.run('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM group_messages WHERE group_id=?)', groupId); } catch (e) {}
    p.run('DELETE FROM group_members WHERE group_id=?', groupId);
    p.run('DELETE FROM group_messages WHERE group_id=?', groupId);
    p.run('DELETE FROM group_announcements WHERE group_id=?', groupId);
    p.run('DELETE FROM group_member_settings WHERE group_id=?', groupId);
    p.run('DELETE FROM group_setting_notes WHERE group_id=?', groupId);
    try { p.run('DELETE FROM group_votes WHERE group_id=?', groupId); } catch (e) {}
    try { p.run('DELETE FROM group_todos WHERE group_id=?', groupId); } catch (e) {}
    try { p.run('DELETE FROM group_join_grants WHERE group_id=?', groupId); } catch (e) {}
    const files = p.all('SELECT id,name FROM group_files WHERE group_id=?', groupId);
    for (const f of files) { try { fs.unlinkSync(path.join(GROUP_FILES_DIR, f.id + '.bin')); } catch (e) { /* 忽略 */ } }
    p.run('DELETE FROM group_files WHERE group_id=?', groupId);
    p.run('DELETE FROM groups WHERE id=?', groupId);
    persist();
    res.json({ ok: true });
  });

  // ---------- 群消息历史：GET /api/groups/:id/messages ----------
  app.get('/api/groups/:id/messages', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const before = parseInt(req.query.before, 10) || null;
    let sql = `SELECT gm.*,gmm.reply_to,gmm.forwarded_from,pm.content AS reply_content,pm.from_id AS reply_from,pm.recalled AS reply_recalled
       FROM group_messages gm
       LEFT JOIN group_message_meta gmm ON gmm.message_id=gm.id
       LEFT JOIN group_messages pm ON pm.id=gmm.reply_to
       WHERE gm.group_id=?`;
    const params = [groupId];
    if (before) { sql += ' AND gm.id<?'; params.push(before); }
    sql += ' ORDER BY gm.created_at DESC LIMIT ?';
    params.push(limit);
    const rows = p.all(sql, ...params).reverse();
    res.json({ messages: rows.map(r => groupMsgDto(r, req.user.id)) });
  });

  // ---------- 发群消息：POST /api/groups/:id/messages { content } ----------
  app.post('/api/groups/:id/messages', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const content = String((req.body || {}).content || '');
    if (!content) return fail(res, 400, '消息内容不能为空');
    if (content.length > 100 * 1024) return fail(res, 413, '消息内容过长（最大100KB）');
    const msgId = insertGroupMessage(groupId, req.user.id, content, String((req.body || {}).clientMsgId || ''));
    const replyTo = Number((req.body || {}).replyTo) || null;
    const forwardedFrom = Number((req.body || {}).forwardedFrom) || null;
    if (replyTo || forwardedFrom) {
      try {
        p.run('INSERT INTO group_message_meta(message_id,reply_to,forwarded_from,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,forwarded_from=excluded.forwarded_from,updated_at=excluded.updated_at', msgId.id, replyTo, forwardedFrom, Date.now());
      } catch (e) {}
    }
    res.json({ ok: true, message: { id: msgId.id, groupId, from: req.user.id, content, createdAt: msgId.createdAt, read: true, readCount: 1 } });
  });

  // ---------- 群公告：POST /api/groups/:id/announcement { content } ----------
  // 仅管理员（群主）可编辑；其余成员只读
  app.post('/api/groups/:id/announcement', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    if (g.owner_id !== req.user.id) return fail(res, 403, '仅群主可编辑群公告');
    const content = String((req.body || {}).content || '').slice(0, 2000);
    const now = Date.now();
    p.run(`INSERT INTO group_announcements(group_id,content,publisher_id,pinned,created_at,updated_at)
       VALUES(?,?,?,0,?,?)
       ON CONFLICT(group_id) DO UPDATE SET content=excluded.content,publisher_id=excluded.publisher_id,updated_at=excluded.updated_at`,
       groupId, content, req.user.id, now, now);
    res.json({ ok: true, announcement: { content, publisherId: req.user.id, updatedAt: now } });
  });

  // 置顶/取消置顶公告：POST /api/groups/:id/announcement/pin { on }
  app.post('/api/groups/:id/announcement/pin', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    if (g.owner_id !== req.user.id) return fail(res, 403, '仅群主可置顶公告');
    const on = (req.body || {}).on !== false;
    p.run('UPDATE group_announcements SET pinned=? , updated_at=? WHERE group_id=?', on ? 1 : 0, Date.now(), groupId);
    res.json({ ok: true, pinned: on });
  });

  // ---------- 群聊设置：POST /api/groups/:id/settings { muted?, note? } ----------
  // 免打扰 + 群备注（对本人显示名/别名）
  app.post('/api/groups/:id/settings', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const body = req.body || {};
    const now = Date.now();
    if (body.muted !== undefined || body.nickname !== undefined) {
      const cur = p.get('SELECT my_nickname, muted FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id) || { my_nickname: null, muted: 0 };
      const muted = body.muted === undefined ? cur.muted : (body.muted ? 1 : 0);
      const nickname = body.nickname === undefined ? (cur.my_nickname || null) : (String(body.nickname || '').trim() || null);
      p.run(`INSERT INTO group_member_settings(group_id,user_id,my_nickname,muted,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(group_id,user_id) DO UPDATE SET my_nickname=excluded.my_nickname,muted=excluded.muted,updated_at=excluded.updated_at`,
        groupId, req.user.id, nickname, muted, now);
    }
    if (body.note !== undefined) {
      const note = String(body.note || '').trim().slice(0, 64);
      p.run(`INSERT INTO group_setting_notes(group_id,user_id,note,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(group_id,user_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at`,
        groupId, req.user.id, note, now);
    }
    const mine = p.get('SELECT my_nickname, muted FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    const note = p.get('SELECT note FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    res.json({ ok: true, muted: !!mine.muted, myNickname: mine.my_nickname || null, note: note.note || '' });
  });

  // 别名：POST /api/groups/:id/nickname { nickname }
  app.post('/api/groups/:id/nickname', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const nickname = String((req.body || {}).nickname || '').trim();
    p.run(`INSERT INTO group_member_settings(group_id,user_id,my_nickname,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(group_id,user_id) DO UPDATE SET my_nickname=excluded.my_nickname,updated_at=excluded.updated_at`,
      groupId, req.user.id, nickname || null, Date.now());
    res.json({ ok: true, myNickname: nickname || null });
  });

  // ---------- 群成员列表：GET /api/groups/:id/members ----------
  app.get('/api/groups/:id/members', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const members = p.all(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,u.last_seen,gms.my_nickname,gms.muted
       FROM group_members m JOIN users u ON u.id=m.user_id
       LEFT JOIN group_member_settings gms ON gms.group_id=m.group_id AND gms.user_id=m.user_id
       WHERE m.group_id=? ORDER BY m.joined_at ASC`, groupId);
    const mine = p.get('SELECT my_nickname FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    res.json({ members: members.map(m => ({ ...publicUser(m), myNickname: m.my_nickname || null })), ownerId: g.owner_id, myNickname: mine.my_nickname || null });
  });

  // ---------- 群文件：上传 POST /api/groups/:id/files (application/octet-stream) ----------
  app.post('/api/groups/:id/files', express.raw({ type: 'application/octet-stream', limit: '100mb' }), mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, '文件为空');
    // 群文件配额：单群总量 2GB，防止磁盘被刷满
    try {
      const q = p.get('SELECT COALESCE(SUM(size),0) AS s FROM group_files WHERE group_id=?', groupId) || { s: 0 };
      if (Number(q.s) + req.body.length > 2 * 1024 * 1024 * 1024) return fail(res, 400, '群文件空间已满（上限2GB）');
    } catch (e) { /* 表缺失时放行 */ }
    const name = String(req.query.name || 'file').trim().slice(0, 240) || 'file';
    const mime = String(req.query.mime || 'application/octet-stream').slice(0, 120);
    const id = crypto.randomUUID();
    const filePath = path.join(GROUP_FILES_DIR, id + '.bin');
    try {
      fs.writeFileSync(filePath, req.body);
      p.run('INSERT INTO group_files(id,group_id,uploader_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id, groupId, req.user.id, name, mime, req.body.length, filePath, Date.now());
      res.json({ ok: true, id, name, mime, size: req.body.length });
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch (e2) { /* 忽略 */ }
      fail(res, 500, '文件保存失败');
    }
  });

  // ---------- 群文件列表：GET /api/groups/:id/files ----------
  app.get('/api/groups/:id/files', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const rows = p.all('SELECT id,name,mime,size,uploader_id AS uploaderId,created_at AS createdAt FROM group_files WHERE group_id=? ORDER BY created_at DESC', groupId);
    const list = rows.filter(r => fs.existsSync(path.join(GROUP_FILES_DIR, r.id + '.bin')));
    for (const f of list) {
      const u = p.get('SELECT username,nickname FROM users WHERE id=?', f.uploaderId);
      f.uploader = u ? (u.nickname || u.username) : ('用户' + f.uploaderId);
    }
    res.json({ files: list });
  });

  // ---------- 群文件下载：GET /api/group-files/:fileId ----------
  // 独立路径避免与 /api/groups/:id 冲突（Express 按注册顺序匹配，:id 会先吞掉 'files'）
  app.get('/api/group-files/:fileId', mw, (req, res) => {
    const file = p.get('SELECT * FROM group_files WHERE id=?', req.params.fileId);
    if (!file) return fail(res, 404, '文件不存在');
    if (!memberOf(file.group_id, req.user.id)) return fail(res, 403, '你不在此群');
    const resolved = path.resolve(file.path);
    if (!resolved.startsWith(path.resolve(GROUP_FILES_DIR))) return fail(res, 403, '路径非法');
    if (!fs.existsSync(resolved)) return fail(res, 404, '文件不存在');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/["\\\r\n]/g, '_')}"`);
    fs.createReadStream(resolved).pipe(res);
  });

  // ---------- 群文件删除：DELETE /api/groups/:id/files/:fileId ----------
  app.delete('/api/groups/:id/files/:fileId', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '群ID错误');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const file = p.get('SELECT * FROM group_files WHERE id=? AND group_id=?', req.params.fileId, groupId);
    if (!file) return fail(res, 404, '文件不存在');
    const isOwner = g.owner_id === req.user.id;
    const isUploader = file.uploader_id === req.user.id;
    if (!isOwner && !isUploader) return fail(res, 403, '仅群主或上传者可删除');
    try { fs.unlinkSync(file.path); } catch (e) { /* 忽略 */ }
    p.run('DELETE FROM group_files WHERE id=?', req.params.fileId);
    res.json({ ok: true });
  });

  // 可选：供合并方注入实时分发器（更新群列表给在线成员）
  module.exports.attachGroupBroadcast = setBroadcastHook;

  // 群消息置顶/取消置顶：POST /api/groups/:id/messages/:msgId/pin { pinned }
  app.post('/api/groups/:id/messages/:msgId/pin', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId) || !Number.isInteger(msgId)) return fail(res, 400, '参数错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const msg = p.get('SELECT id, from_id FROM group_messages WHERE id=? AND group_id=?', msgId, groupId);
    if (!msg) return fail(res, 404, '消息不存在');
    const gpin = p.get('SELECT owner_id FROM groups WHERE id=?', groupId);
    if (!(req.user.id === (gpin && gpin.owner_id) || req.user.id === msg.from_id)) return fail(res, 403, '仅消息发送者或群主可操作');
    const pinned = !!(req.body && req.body.pinned);
    const now = Date.now();
    try {
      p.run('INSERT INTO group_message_meta(message_id,pinned,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET pinned=excluded.pinned,updated_at=excluded.updated_at', msgId, pinned ? 1 : 0, now);
    } catch (e) {}
    res.json({ ok: true, pinned });
  });

  // 群消息引用回复：POST /api/groups/:id/messages/:msgId/reply { replyTo }
  app.post('/api/groups/:id/messages/:msgId/reply', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId) || !Number.isInteger(msgId)) return fail(res, 400, '参数错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const msg = p.get('SELECT id, from_id FROM group_messages WHERE id=? AND group_id=?', msgId, groupId);
    if (!msg) return fail(res, 404, '消息不存在');
    const greply = p.get('SELECT owner_id FROM groups WHERE id=?', groupId);
    const replyTo = Number((req.body || {}).replyTo) || null;
    const now = Date.now();
    try {
      p.run('INSERT INTO group_message_meta(message_id,reply_to,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,updated_at=excluded.updated_at', msgId, replyTo, now);
    } catch (e) {}
    res.json({ ok: true, replyTo });
  });

  // 群消息撤回：POST /api/groups/:id/messages/:msgId/recall（发送者 5 分钟内）
  app.post('/api/groups/:id/messages/:msgId/recall', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId) || !Number.isInteger(msgId)) return fail(res, 400, '参数错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const msg = p.get('SELECT id,from_id,content,created_at FROM group_messages WHERE id=? AND group_id=?', msgId, groupId);
    if (!msg) return fail(res, 404, '消息不存在');
    if (msg.from_id !== req.user.id) return fail(res, 403, '只能撤回自己发送的消息');
    if (Date.now() - msg.created_at > 5 * 60 * 1000) return fail(res, 400, '超过 5 分钟不可撤回');
    try {
      p.run('UPDATE group_messages SET recalled=1 WHERE id=?', msgId);
      recallHook && recallHook({ id: msgId, groupId, from: msg.from_id });
    } catch (e) {
      return fail(res, 500, '撤回失败：' + ((e && e.message) || e));
    }
    res.json({ ok: true });
  });

  // 群消息编辑：POST /api/groups/:id/messages/:msgId/edit
  app.post('/api/groups/:id/messages/:msgId/edit', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId) || !Number.isInteger(msgId)) return fail(res, 400, '参数错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const msg = p.get('SELECT id,from_id,content,recalled FROM group_messages WHERE id=? AND group_id=?', msgId, groupId);
    if (!msg) return fail(res, 404, '消息不存在');
    if (msg.from_id !== req.user.id) return fail(res, 403, '只能编辑自己发送的消息');
    if (msg.recalled) return fail(res, 400, '已撤回的消息无法编辑');
    const content = (req.body || {}).content;
    if (!content || typeof content !== 'string' || !content.trim()) return fail(res, 400, '内容不能为空');
    try {
      p.run('UPDATE group_messages SET content=? WHERE id=?', content.trim(), msgId);
    } catch (e) {
      return fail(res, 500, '编辑失败：' + ((e && e.message) || e));
    }
    editHook && editHook({ groupId, id: msgId, from: msg.from_id, content: content.trim() });
    res.json({ ok: true, messageId: msgId, content: content.trim() });
  });

  let editHook = null;
  function setEditHook(fn) { editHook = fn || null; }
  module.exports.attachGroupEdit = setEditHook;

  module.exports.attachGroupBroadcast = setBroadcastHook;
  module.exports.attachGroupRecall = setRecallHook;
  module.exports.attachGroupMemberChange = setMemberChangeHook;
  return { ok: true, routes: ['/api/groups/*'] };
};
