'use strict';
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

let db;
let saveTimer = null;
let dbPath;

// 随机生成字母+数字组合的 UID（8 位）
function genUid() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// sql.js 是内存数据库，需手动持久化到 .sqlite 文件
async function getDb() {
  if (db) return db;
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'chat.sqlite');
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  init();
  return db;
}

function init() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT,
      uid TEXT UNIQUE,
      email TEXT,
      uid_changed_at INTEGER,
      country TEXT,
      province TEXT,
      city TEXT,
      extra TEXT,
      pubkey TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      client_msg_id TEXT,
      created_at INTEGER NOT NULL,
      read INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS file_transfers (
      id TEXT PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_recordings (
      id TEXT PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_recordings_pair ON call_recordings(from_id, to_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_transfers_pair ON file_transfers(from_id, to_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, created_at);
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at INTEGER NOT NULL,
      UNIQUE(group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      from_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gm_group ON group_messages(group_id, created_at);
    CREATE TABLE IF NOT EXISTS feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT NOT NULL,             -- 'bug'|'suggestion'|'complaint'|'other'
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',   -- open|processing|closed
      created_at INTEGER NOT NULL
    );
  `);
  // 迁移：给旧表加 uid 列（如果不存在）；给历史用户补 uid
  try {
    db.run('ALTER TABLE users ADD COLUMN uid TEXT');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN email TEXT');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN uid_changed_at INTEGER');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN country TEXT');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN province TEXT');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN city TEXT');
  } catch (e) { /* 列已存在，忽略 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN extra TEXT');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN pubkey TEXT');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE messages ADD COLUMN client_msg_id TEXT');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN banned_at INTEGER');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN banned_by INTEGER');
  } catch (e) { /* 列已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN ban_reason TEXT');
  } catch (e) { /* 列已存在 */ }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_msg_id) WHERE client_msg_id IS NOT NULL');
  // 给缺 uid 的老数据补一个
  const missing = db.exec('SELECT id FROM users WHERE uid IS NULL');
  if (missing && missing.length) {
    for (const row of missing[0].values) {
      const id = row[0];
      let code; do { code = genUid(); } while (db.exec('SELECT 1 FROM users WHERE uid=\'' + code + '\'').length);
      db.run('UPDATE users SET uid=? WHERE id=?', [code, id]);
    }
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL');
  // 注：feedbacks 表由 worker D 负责正式建表，此处不重复创建。
  // /api/admin/overview 查询 feedbacks 时会做 try/catch 兜底，未建表则返回 []。
  persistNow();
}

function doPersist() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.error('persist failed', e);
  }
}

// 防抖落盘（高频写用）
function persist() {
  if (!db) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doPersist, 500);
}

// 立即同步落盘（关键写入：注册/好友 等低频但重要的操作）
function persistNow() {
  if (!db) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  doPersist();
}

// 简单包装：同步风格 API
function prepare(sql) {
  return {
    run(...args) {
      db.run(sql, args);
      // 先取 last_insert_rowid 再持久化：sql.js 的 export() 会把 last_insert_rowid 重置为 0
      const row = db.exec('SELECT last_insert_rowid() AS id');
      const lastInsertRowid = (row && row.length && row[0].values.length) ? row[0].values[0][0] : 0;
      persistNow();
      return { lastInsertRowid };
    },
    get(...args) {
      const stmt = db.prepare(sql);
      stmt.bind(args);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row;
    },
    all(...args) {
      const stmt = db.prepare(sql);
      stmt.bind(args);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
  };
}

module.exports = { getDb, prepare, persist, persistNow, genUid };
