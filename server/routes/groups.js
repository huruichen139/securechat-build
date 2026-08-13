'use strict';
// module: groups (worker batch1)
// 缇よ亰浣撶郴鐙珛妯″潡锛氬垱寤虹兢/瑙ｆ暎缇?閫€鍑虹兢/閭€璇?绉婚櫎鎴愬憳銆佺兢鍏憡(缃《路闈炵鐞嗗憳鍙)銆?// 缇ゆ枃浠躲€佺兢鑱婅缃?鍏嶆墦鎵?缇ゅ娉?缇ゆ垚鍛樺垪琛?鏈兢鏄电О)銆佺兢娑堟伅鏀跺彂銆?// 瀵煎嚭 CommonJS锛歮odule.exports = function registerGroups(app, db, auth)
//   - app  : express 瀹炰緥
//   - db   : sql.js 鏁版嵁搴撳璞★紙id 鍙傝€?server/db.js锛?//   - auth : 閴存潈涓棿浠?(req,res,next)銆傝嫢鏈彁渚涳紝鍒欑敤鍐呯疆 JWT 鏍￠獙锛堜笌 server/index.js 鐩稿悓 secret锛夈€?//
// 浠呬緵鍚堝苟锛氭湰妯″潡浣跨敤 require('../db') 鐨?prepare/persist 鑷冻杩愯锛?// 涓嶅奖鍝?server/index.js / server/db.js 宸ㄧ煶鏂囦欢銆?const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');

const gdb = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

// ---------- 缇ゆ枃浠跺瓨鍌ㄧ洰褰曪紙涓?server/files 鍚岀骇锛岄伩鍏嶄緷璧栧法鐭虫枃浠跺父閲忥級----------
const GROUP_FILES_DIR = process.env.GROUP_FILES_DIR || path.join(__dirname, '..', 'group-files');
try { fs.mkdirSync(GROUP_FILES_DIR, { recursive: true }); } catch (e) { /* 蹇界暐 */ }

// ---------- 鍏变韩 prepare锛氫紭鍏堢敤 db.js 鐨勶紙鑷甫钀界洏锛?---------
// p 鍦?registerGroups 鍐呰璧嬪€硷紱鍏朵綑鍐呴儴鍑芥暟鍧囬€氳繃闂寘鍙橀噺 p 璁块棶銆?let P = null;
let EDB = null;
function eof(sp) { return gdb && typeof gdb.prepare === 'function'; }
function prep() {
  // 閫€璺細鐩存帴鍩轰簬浼犲叆 EDB锛堜笉鑷姩钀界洏锛屽悎骞舵椂鍙嚜琛岀簿绠€锛?  return (sql) => {
    const stmt = EDB.prepare(sql);
    return {
      run(...args) { stmt.run(args); try { const row = EDB.exec('SELECT last_insert_rowid() as id'); return { lastInsertRowid: row && row.length ? row[0].values[0][0] : 0 }; } catch (e) { return { changes: 0 }; } },
      get(...args) { stmt.reset(); stmt.bind(args); const row = stmt.step() ? stmt.getAsObject() : null; return row; },
      all(...args) { stmt.reset(); stmt.bind(args); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; },
    };
  };
}
const p = { get: (...a) => P.get(...a), all: (...a) => P.all(...a), run: (...a) => P.run(...a) };

// 鍐呭缓 publicUser锛堜笌 index.js 涓€鑷达級锛岄伩鍏嶄緷璧栧法鐭冲眬閮ㄥ嚱鏁?function publicUser(u) {
  if (!u) return null;
  let extra = {};
  try { extra = JSON.parse((u.extra && u.extra) || '{}') || {}; } catch (e) { extra = {}; }
  return {
    id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
    uid: u.uid, email: u.email || '',
    country: u.country || '', province: u.province || '', city: u.city || '',
    extra: extra, pubkey: u.pubkey || ''
  };
}

function verifyUser(req) {
  const auth = req.headers.authorization || '';
  return jwt.verify(auth.replace(/^Bearer\s+/i, ''), JWT_SECRET) || null;
}
function apiUser(req) {
  try { return verifyUser(req); } catch (e) { return null; }
}
function fail(res, code, error) { res.status(code).json({ error }); }
// 鍐呯疆閴存潈涓棿浠讹紙褰撳閮ㄦ湭娉ㄥ叆 auth 鏃朵娇鐢級
function defaultAuth(req, res, next) {
  const payload = apiUser(req);
  if (!payload) return fail(res, 401, '鏈巿鏉?);
  req.user = payload;
  next();
}

// 鏄惁缇ゆ垚鍛橈紱杩斿洖鎴愬憳琛屾垨 null
function memberOf(groupId, userId) {
  return p.get('SELECT gm.id, gm.group_id AS groupId, gm.user_id AS userId FROM group_members gm WHERE gm.group_id=? AND gm.user_id=?', groupId, userId);
}
function groupExists(groupId) {
  return p.get('SELECT id FROM groups WHERE id=?', groupId);
}

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
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid, gms.my_nickname FROM group_members m
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

// 缇ゆ秷鎭繑鍥炰綋琛ュ叏 sender 鏄电О锛堣€冭檻銆屾湰缇ゆ樀绉般€嶈鐩栵級
function groupMsgDto(r) {
  const sender = p.get(
    `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,gms.my_nickname
     FROM users u LEFT JOIN group_member_settings gms ON gms.group_id=? AND gms.user_id=u.id
     WHERE u.id=?`, r.from_id, r.from_id);
  const name = (sender && (sender.my_nickname || sender.nickname)) || ('鐢ㄦ埛' + r.from_id);
  return {
    id: r.id, groupId: r.group_id, from: r.from_id,
    content: r.content, createdAt: r.created_at,
    fromUser: { id: r.from_id, username: sender && sender.username, nickname: name, avatar: sender && sender.avatar, uid: sender && sender.uid },
  };
}

// 杩藉姞缇ゆ秷鎭苟灏濊瘯瀹炴椂鍒嗗彂锛堣嫢宸ㄧ煶 worker 閫氳繃 require.cache 娉ㄥ叆鍒嗗彂鍣級
function insertGroupMessage(groupId, fromId, content, clientMsgId) {
  const now = Date.now();
  const info = p.run(
    'INSERT INTO group_messages(group_id,from_id,content,created_at) VALUES(?,?,?,?)',
    groupId, fromId, content, now);
  const id = info.lastInsertRowid;
  const msg = { id, groupId, from: fromId, content, createdAt: now };
  // 浜嬩欢鍒嗗彂閽╁瓙锛歳egisterGroups 浼氫粠 app.locals 璇诲彇鍚堝苟鏂规敞鍏ョ殑鍙€夊箍鎾?  broadcastHook && broadcastHook(groupId, msg);
  return msg;
}

let broadcastHook = null;
function setBroadcastHook(fn) { broadcastHook = fn || null; }

module.exports = function registerGroups(app, db, auth) {
  // 鏋勯€?prepare锛氫紭鍏?db.js 鐨勶紙鑷甫钀界洏锛夛紱鍚﹀垯閫€鍥炵函 sql.js
  if (gdb && typeof gdb.prepare === 'function') {
    // gdb.prepare(sql) 杩斿洖 { run, get, all }
    P = (sql) => gdb.prepare(sql);
    EDB = db;
  } else {
    EDB = db;
    P = prep();
  }
  if (!EDB) { EDB = { run: () => {}, exec: () => [], prepare: () => ({}) }; }

  // ---------- 鑷缓琛紙IF NOT EXISTS锛屽畨鍏ㄥ箓绛夛級----------
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
        pinned     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      `);
    } catch (e) { /* 琛ㄥ凡瀛樺湪鎴栧紓鍦板簱涓嶅彲鐢紝蹇界暐 */ }

  const mw = (typeof auth === 'function') ? auth : defaultAuth;

  // ---------- 鍒涘缓缇わ細POST /api/groups { name, memberUids:[] } ----------
  app.post('/api/groups', mw, (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return fail(res, 400, '缇ゅ悕涓嶈兘涓虹┖');
    const groupName = name.slice(0, 50);
    const memberUids = Array.isArray((req.body || {}).memberUids) ? (req.body.memberUids) : [];
    let uidList = [];
    if ((req.body || {}).uid && typeof (req.body.uid) === 'string') uidList.push(req.body.uid);
    if (typeof (req.body || {}).inviteUid === 'string') uidList.push(req.body.inviteUid);
    const allUids = (req.body && Array.isArray(req.body.uids)) ? req.body.uids : uidList.length ? uidList : memberUids;
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
        if (memberOf(groupId, target.id)) { continue; }
        p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, target.id, now);
        added.push(target.id);
      }
    }
    res.json({ ok: true, group: { id: groupId, name: groupName, ownerId: req.user.id }, added });
  });

  // ---------- 鎴戠殑缇ゅ垪琛紙澧炲己锛夛細GET /api/groups/enhanced ----------
  app.get('/api/groups/enhanced', mw, (req, res) => {
    res.json({ groups: myGroups(req.user.id) });
  });

  // ---------- 缇よ鎯咃細GET /api/groups/:id ----------
  app.get('/api/groups/:id', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const ann = p.get('SELECT content, publisher_id AS publisherId, pinned, created_at AS createdAt, updated_at AS updatedAt FROM group_announcements WHERE group_id=?', groupId) || null;
    const members = p.all(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,gms.my_nickname,gms.muted
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

  // ---------- 閭€璇峰叆缇わ細POST /api/groups/:id/invite { uids:[] , uid } ----------
  app.post('/api/groups/:id/invite', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const body = req.body || {};
    let uids = [];
    if (Array.isArray(body.uids)) uids = body.uids;
    if (body.uid && typeof body.uid === 'string') uids.push(body.uid);
    const added = [];
    for (const uid of uids) {
      if (!uid || typeof uid !== 'string') continue;
      const target = p.get('SELECT id FROM users WHERE uid=?', uid);
      if (!target) continue;
      if (target.id === req.user.id) continue;
      if (memberOf(groupId, target.id)) continue;
      p.run('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)', groupId, target.id, Date.now());
      added.push(target.id);
    }
    res.json({ ok: true, added, count: added.length });
  });

  // ---------- 绉婚櫎鎴愬憳锛歅OST /api/groups/:id/remove { userId } ----------
  app.post('/api/groups/:id/remove', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (g.owner_id !== req.user.id) return fail(res, 403, '浠呯兢涓诲彲绉婚櫎鎴愬憳');
    const targetId = parseInt((req.body || {}).userId, 10);
    if (!targetId || targetId === req.user.id) return fail(res, 400, '鐩爣鏃犳晥');
    if (!memberOf(groupId, targetId)) return fail(res, 404, '璇ユ垚鍛樹笉鍦ㄧ兢涓?);
    p.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', groupId, targetId);
    p.run('DELETE FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, targetId);
    p.run('DELETE FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, targetId);
    res.json({ ok: true });
  });

  // ---------- 閫€鍑虹兢锛歅OST /api/groups/:id/leave ----------
  app.post('/api/groups/:id/leave', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    // 缇や富涓嶅彲閫€鍑猴紙搴斿厛瑙ｆ暎锛夛紝鐩存帴鎶ラ敊鎻愮ず
    if (g.owner_id === req.user.id) return fail(res, 400, '缇や富涓嶈兘閫€鍑虹兢锛岃瑙ｆ暎缇ゆ垨杞缇や富鍚庨€€鍑?);
    p.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', groupId, req.user.id);
    p.run('DELETE FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id);
    p.run('DELETE FROM group_setting_notes WHERE group_id=? AND user_id=?', groupId, req.user.id);
    res.json({ ok: true });
  });

  // ---------- 瑙ｆ暎缇わ細POST /api/groups/:id/dissolve ----------
  app.post('/api/groups/:id/dissolve', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (g.owner_id !== req.user.id) return fail(res, 403, '浠呯兢涓诲彲瑙ｆ暎缇?);
    p.run('DELETE FROM groups WHERE id=?', groupId);
    p.run('DELETE FROM group_members WHERE group_id=?', groupId);
    p.run('DELETE FROM group_messages WHERE group_id=?', groupId);
    p.run('DELETE FROM group_announcements WHERE group_id=?', groupId);
    p.run('DELETE FROM group_member_settings WHERE group_id=?', groupId);
    p.run('DELETE FROM group_setting_notes WHERE group_id=?', groupId);
    const files = p.all('SELECT id,name FROM group_files WHERE group_id=?', groupId);
    for (const f of files) { try { fs.unlinkSync(path.join(GROUP_FILES_DIR, f.id)); } catch (e) { /* 蹇界暐 */ } }
    p.run('DELETE FROM group_files WHERE group_id=?', groupId);
    res.json({ ok: true });
  });

  // ---------- 缇ゆ秷鎭巻鍙诧細GET /api/groups/:id/messages ----------
  app.get('/api/groups/:id/messages', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const rows = p.all(
      'SELECT * FROM group_messages WHERE group_id=? ORDER BY created_at ASC', groupId);
    res.json({ messages: rows.map(groupMsgDto) });
  });

  // ---------- 鍙戠兢娑堟伅锛歅OST /api/groups/:id/messages { content } ----------
  app.post('/api/groups/:id/messages', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const content = String((req.body || {}).content || '');
    if (!content) return fail(res, 400, '娑堟伅鍐呭涓嶈兘涓虹┖');
    const msgId = insertGroupMessage(groupId, req.user.id, content, String((req.body || {}).clientMsgId || ''));
    res.json({ ok: true, message: { id: msgId.id, groupId, from: req.user.id, content, createdAt: msgId.createdAt } });
  });

  // ---------- 缇ゅ叕鍛婏細POST /api/groups/:id/announcement { content } ----------
  // 浠呯鐞嗗憳锛堢兢涓伙級鍙紪杈戯紱鍏朵綑鎴愬憳鍙
  app.post('/api/groups/:id/announcement', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    if (g.owner_id !== req.user.id) return fail(res, 403, '浠呯兢涓诲彲缂栬緫缇ゅ叕鍛?);
    const content = String((req.body || {}).content || '').slice(0, 2000);
    const now = Date.now();
    p.run(`INSERT INTO group_announcements(group_id,content,publisher_id,pinned,created_at,updated_at)
       VALUES(?,?,?,0,?,?)
       ON CONFLICT(group_id) DO UPDATE SET content=excluded.content,publisher_id=excluded.publisher_id,updated_at=excluded.updated_at`,
       groupId, content, req.user.id, now, now);
    res.json({ ok: true, announcement: { content, publisherId: req.user.id, updatedAt: now } });
  });

  // 缃《/鍙栨秷缃《鍏憡锛歅OST /api/groups/:id/announcement/pin { on }
  app.post('/api/groups/:id/announcement/pin', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    if (g.owner_id !== req.user.id) return fail(res, 403, '浠呯兢涓诲彲缃《鍏憡');
    const on = (req.body || {}).on !== false;
    p.run('UPDATE group_announcements SET pinned=? , updated_at=? WHERE group_id=?', on ? 1 : 0, Date.now(), groupId);
    res.json({ ok: true, pinned: on });
  });

  // ---------- 缇よ亰璁剧疆锛歅OST /api/groups/:id/settings { muted?, note? } ----------
  // 鍏嶆墦鎵?+ 缇ゅ娉紙瀵规湰浜虹殑鏄剧ず鍚?鍒悕锛?  app.post('/api/groups/:id/settings', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
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

  // 鍒悕锛歅OST /api/groups/:id/nickname { nickname }
  app.post('/api/groups/:id/nickname', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const nickname = String((req.body || {}).nickname || '').trim();
    p.run(`INSERT INTO group_member_settings(group_id,user_id,my_nickname,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(group_id,user_id) DO UPDATE SET my_nickname=excluded.my_nickname,updated_at=excluded.updated_at`,
      groupId, req.user.id, nickname || null, Date.now());
    res.json({ ok: true, myNickname: nickname || null });
  });

  // ---------- 缇ゆ垚鍛樺垪琛細GET /api/groups/:id/members ----------
  app.get('/api/groups/:id/members', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const members = p.all(
      `SELECT u.id,u.username,u.nickname,u.avatar,u.uid,gms.my_nickname,gms.muted
       FROM group_members m JOIN users u ON u.id=m.user_id
       LEFT JOIN group_member_settings gms ON gms.group_id=m.group_id AND gms.user_id=m.user_id
       WHERE m.group_id=? ORDER BY m.joined_at ASC`, groupId);
    const mine = p.get('SELECT my_nickname FROM group_member_settings WHERE group_id=? AND user_id=?', groupId, req.user.id) || {};
    res.json({ members: members.map(m => ({ ...publicUser(m), myNickname: m.my_nickname || null })), ownerId: g.owner_id, myNickname: mine.my_nickname || null });
  });

  // ---------- 缇ゆ枃浠讹細涓婁紶 POST /api/groups/:id/files (application/octet-stream) ----------
  app.post('/api/groups/:id/files', express.raw({ type: 'application/octet-stream', limit: '100mb' }), mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, '鏂囦欢涓虹┖');
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
      try { fs.unlinkSync(filePath); } catch (e2) { /* 蹇界暐 */ }
      fail(res, 500, '鏂囦欢淇濆瓨澶辫触');
    }
  });

  // ---------- 缇ゆ枃浠跺垪琛細GET /api/groups/:id/files ----------
  app.get('/api/groups/:id/files', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    if (!groupExists(groupId)) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const rows = p.all('SELECT id,name,mime,size,uploader_id AS uploaderId,created_at AS createdAt FROM group_files WHERE group_id=? ORDER BY created_at DESC', groupId);
    const list = rows.filter(r => fs.existsSync(path.join(GROUP_FILES_DIR, r.id + '.bin')));
    for (const f of list) {
      const u = p.get('SELECT username,nickname FROM users WHERE id=?', f.uploaderId);
      f.uploader = u ? (u.nickname || u.username) : ('鐢ㄦ埛' + f.uploaderId);
    }
    res.json({ files: list });
  });

  // ---------- 缇ゆ枃浠朵笅杞斤細GET /api/groups/files/:fileId ----------
  // 娉ㄦ剰锛氬繀椤诲湪 /api/groups/:id 涔嬪墠娉ㄥ唽锛岄伩鍏?:id 璇尮閰?'files'
  app.get('/api/groups/files/:fileId', mw, (req, res) => {
    const file = p.get('SELECT * FROM group_files WHERE id=?', req.params.fileId);
    if (!file) return fail(res, 404, '鏂囦欢涓嶅瓨鍦?);
    if (!memberOf(file.group_id, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    if (!fs.existsSync(file.path)) return fail(res, 404, '鏂囦欢涓嶅瓨鍦?);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/["\\\r\n]/g, '_')}"`);
    fs.createReadStream(file.path).pipe(res);
  });

  // ---------- 缇ゆ枃浠跺垹闄わ細DELETE /api/groups/:id/files/:fileId ----------
  app.delete('/api/groups/:id/files/:fileId', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) return fail(res, 400, '缇D閿欒');
    const g = p.get('SELECT * FROM groups WHERE id=?', groupId);
    if (!g) return fail(res, 404, '缇や笉瀛樺湪');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '浣犱笉鍦ㄦ缇?);
    const file = p.get('SELECT * FROM group_files WHERE id=? AND group_id=?', req.params.fileId, groupId);
    if (!file) return fail(res, 404, '鏂囦欢涓嶅瓨鍦?);
    const isOwner = g.owner_id === req.user.id;
    const isUploader = file.uploader_id === req.user.id;
    if (!isOwner && !isUploader) return fail(res, 403, '浠呯兢涓绘垨涓婁紶鑰呭彲鍒犻櫎');
    try { fs.unlinkSync(file.path); } catch (e) { /* 蹇界暐 */ }
    p.run('DELETE FROM group_files WHERE id=?', req.params.fileId);
    res.json({ ok: true });
  });

  // 鍙€夛細渚涘悎骞舵柟娉ㄥ叆瀹炴椂鍒嗗彂鍣紙鏇存柊缇ゅ垪琛ㄧ粰鍦ㄧ嚎鎴愬憳锛?  module.exports.attachGroupBroadcast = setBroadcastHook;
  
  // 群消息置顶/取消置顶：POST /api/groups/:id/messages/:msgId/pin { pinned }
  app.post('/api/groups/:id/messages/:msgId/pin', mw, (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isInteger(groupId) || !Number.isInteger(msgId)) return fail(res, 400, '参数错误');
    if (!groupExists(groupId)) return fail(res, 404, '群不存在');
    if (!memberOf(groupId, req.user.id)) return fail(res, 403, '你不在此群');
    const msg = p.get('SELECT id, from_id FROM group_messages WHERE id=? AND group_id=?', msgId, groupId);
    if (!msg) return fail(res, 404, '消息不存在');
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
    const replyTo = Number((req.body || {}).replyTo) || null;
    const now = Date.now();
    try {
      p.run('INSERT INTO group_message_meta(message_id,reply_to,updated_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET reply_to=excluded.reply_to,updated_at=excluded.updated_at', msgId, replyTo, now);
    } catch (e) {}
    res.json({ ok: true, replyTo });
  });return { ok: true, routes: ['/api/groups/*'] };
};