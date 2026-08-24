'use strict';
// module: rtc (worker batch3)
// 语音/视频通话增强信令（REST 轮询直传，兼容 Web & Flutter，不依赖 WebSocket）+ 文件传输助手。
// CommonJS：module.exports = function registerRtc(app, db, auth)
//   - app  : express 实例
//   - db   : require('../db')，提供 prepare / persist  / getDb / persistNow
//   - auth : 可选。合并 worker 可传 index.js 的鉴权帮助：
//                auth(req) -> userId(number) 或 null
//           未传时回退：自行解析 Bearer JWT（process.env.JWT_SECRET，与 index.js 一致）。
// 端点：
//   POST /api/rtc/signal   { to, sub, data }  向对端投递一条信令
//   POST /api/rtc/poll                        取走调用方自己收件箱里的信令（一次性）
//   POST /api/rtc/hangup   { to }             通知对端挂断
//   GET  /api/rtc/inbox/length                取调用方收件箱未读数
//   ----- 文件传输助手（虚拟好友，peer_id=-1，复用 messages 表）-----
//   POST   /api/rtc/filehelper/upload?name=&mime=   原始字节(body)，落盘 + 写消息
//   GET    /api/rtc/filehelper/files                列出当前用户文件传输助手里命中的文件
//   GET    /api/rtc/filehelper/file/:id             下载文件
//   DELETE /api/rtc/filehelper/file/:id             删除文件（同时标记消息）
//
// 说明：
//   1) 通话本身（offer/answer/ice 的 WebRTC 协商）已由 P.C_SIGNAL/S_SIGNAL WebSocket 转发；
//      本路由的 /signal 是给「没有 WS 的端」或跨端（Web <-> Flutter）做 REST 兜底的中转。
//   2) 文件传输助手把文件以纯字节存到 server/files/filehelper/，
//      并在 messages 表写一条 from=self,to=FILEHELPER 的记录(content=[文件:id:name])，
//      这样既有会话历史、又能从任意端 /api/rtc/filehelper/files 取用。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 保留的「文件传输助手」虚拟 peer id。messages.to_id 为 INTEGER，负值可正常存取。
// /api/history/-1 也能用（index.js 用 parseInt，不校验用户存在）。
module.exports = function registerRtc(app, db, auth) {
  const { prepare, persist } = db || {};
  if (!prepare) throw new Error('[rtc] db 参数必须是 require("../db")（需含 prepare）');

  const FILEHELPER_ID = -1;
  const FILEHELPER_NAME = '文件传输助手';
  const INBOX_TTL = 2 * 60 * 1000; // 信令 2 分钟过期

  // ---------- 鉴权：优先用合并 worker 注入的 auth，退化自行解析 JWT ----------
  let jwt;
  function apiUser(req) {
    try {
      if (typeof auth === 'function') {
        const r = auth(req);
        if (r && typeof r === 'object' && r.id != null) return { id: r.id };
        if (typeof r === 'number') return { id: r };
        if (typeof r === 'string' && /^\d+$/.test(r)) return { id: Number(r) };
        // auth 返回 null/undefined 且已发过响应时视为失败；这里只返回 null 让路由判 401
        return null;
      }
      // 回退：自行解析 Bearer
      if (!jwt) jwt = require('jsonwebtoken');
      const h = req.headers.authorization || '';
      const payload = jwt.verify(h.replace(/^Bearer\s+/i, ''), process.env.JWT_SECRET || 'change-me-in-production-please');
      return payload ? { id: payload.id } : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- 内存信令信箱：userId -> [{ seq, sub, data, ts, from }] ----------
  const inbox = new Map(); // userId -> []
  let seq = 0;
  function cleanInbox(userId) {
    const list = inbox.get(userId);
    if (!list) return;
    const now = Date.now();
    const alive = list.filter((s) => now - s.ts < INBOX_TTL);
    if (alive.length !== list.length) {
      if (alive.length) inbox.set(userId, alive);
      else inbox.delete(userId);
    }
  }
  function pushSignal(toUserId, from, sub, data) {
    if (!inbox.has(toUserId)) inbox.set(toUserId, []);
    inbox.get(toUserId).push({ seq: ++seq, sub, data: data || null, ts: Date.now(), from });
  }
  setInterval(() => {
    for (const uid of inbox.keys()) cleanInbox(uid);
  }, 30 * 1000);

  // ---------- 文件传输助手存储 ----------
  const FH_DIR = process.env.FILEHELPER_DIR || path.join(__dirname, '..', 'files', 'filehelper');
  try { fs.mkdirSync(FH_DIR, { recursive: true }); } catch (e) {}

  function requireAuth(req, res) {
    // 下载类请求允许 ?t=<jwt> 携带令牌（浏览器直接下载无 Authorization 头）
    if (!req.headers.authorization && req.query && typeof req.query.t === 'string' && req.query.t) {
      try { req.headers.authorization = 'Bearer ' + String(req.query.t); } catch (e) {}
    }
    const u = apiUser(req);
    if (!u || !u.id) {
      res.status(401).json({ error: '未授权' });
      return null;
    }
    // auth 注入的是 userId，也确认真实用户存在（filehelper 写消息需要）
    try {
      const row = prepare('SELECT id FROM users WHERE id=?').get(u.id);
      if (!row) { res.status(401).json({ error: '用户不存在' }); return null; }
    } catch (e) { /* 允许非用户场景 */ }
    return u.id;
  }

  // ---------- 信令 REST ----------
  app.post('/api/rtc/signal', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    const { to, sub, data } = (req.body && typeof req.body === 'object') ? req.body : {};
    // data 可能含 SDP/ICE，序列化成通用对象存内存即可
    const toId = Number(to);
    if (!Number.isInteger(toId) || !toId || !sub) {
      return res.status(400).json({ error: 'to 或 sub 无效' });
    }
    if (toId === me) return res.status(400).json({ error: '不能发给自己' });
    let blocked = false;
    try {
      blocked = !!prepare('SELECT 1 FROM blocklist WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(toId, me, me, toId);
    } catch (e) { blocked = false; }
    if (blocked) return res.status(403).json({ error: '无法向该用户发送信令' });
    if ((inbox.get(toId) || []).length >= 200) return res.status(429).json({ error: '信令队列已满' });
    if (JSON.stringify(data || null).length > 16384) return res.status(400).json({ error: '信令数据过大' });
    pushSignal(toId, me, String(sub).slice(0, 40), data);
    res.json({ ok: true });
  });

  // 轮询：取走调用方收件箱排队的信令（一次性）。long-poll 也可上行去 /signal。
  app.post('/api/rtc/poll', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    cleanInbox(me);
    const list = inbox.get(me) || [];
    inbox.delete(me);
    res.json({ ok: true, signals: list });
  });

  app.get('/api/rtc/inbox/length', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    cleanInbox(me);
    res.json({ ok: true, length: (inbox.get(me) || []).length });
  });

  app.post('/api/rtc/hangup', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    const { to } = (req.body && typeof req.body === 'object') ? req.body : {};
    const toId = Number(to);
    if (Number.isInteger(toId) && toId && toId !== me) pushSignal(toId, me, 'hangup', null);
    res.json({ ok: true });
  });

  // ---------- 文件传输助手 ----------
  // 上传：原始字节体 + ?name&mime，落盘并写一条 messages 记录(到 FILEHELPER_ID)。
  // 复用 messages 表 => 端上可用 /api/history/-1 拿会话；文件本体经 /file/:id 取用。
  app.post('/api/rtc/filehelper/upload',
    (req, res, next) => {
      const raw = require('express').raw({ type: 'application/octet-stream', limit: '100mb' });
      return raw(req, res, next);
    },
    async (req, res) => {
      const me = requireAuth(req, res);
      if (!me) return;
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '文件为空' });
      let quota = { c: 0, s: 0 };
      try {
        const rows = prepare(
          `SELECT content FROM messages WHERE to_id=? AND from_id=? AND content LIKE '文件:%'`
        ).all(FILEHELPER_ID, me);
        quota.c = rows.length;
        for (const r of rows) {
          const m = /^文件:([0-9a-f-]{8,}):(\{.*\})$/.exec(String(r.content || ''));
          if (!m) continue;
          try { quota.s += JSON.parse(m[2]).size || 0; } catch (e) {}
        }
      } catch (e) {}
      if (quota.c >= 500 || quota.s + req.body.length > 1024 * 1024 * 1024) {
        return res.status(400).json({ error: '文件助手空间已满（上限500个或1GB）' });
      }
      const name = String(req.query.name || 'file').trim().slice(0, 240) || 'file';
      const mime = String(req.query.mime || 'application/octet-stream').slice(0, 120);
      const id = crypto.randomUUID();
      const filePath = path.join(FH_DIR, id + '.bin');
      const now = Date.now();
      try {
        await fs.promises.writeFile(filePath, req.body);
        // messages 表：from=self , to=FILEHELPER_ID；content 携带文件元信息供端上解析。
        const marker = '文件:' + id + ':' + JSON.stringify({ name, mime, size: req.body.length, at: now });
        prepare('INSERT INTO messages(from_id,to_id,content,created_at) VALUES(?,?,?,?)')
          .run(me, FILEHELPER_ID, marker, now);
        persist();
        res.json({ ok: true, id, name, mime, size: req.body.length });
      } catch (e) {
        try { fs.unlinkSync(filePath); } catch (err) {}
        res.status(500).json({ error: '文件保存失败' });
      }
    }
  );

  // 列表：从 messages 里抽出「文件传输助手」里命中的文件（只属于当前 user 的 from 侧）
  app.get('/api/rtc/filehelper/files', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    const rows = prepare(
      `SELECT id, from_id AS fromId, content, created_at AS createdAt FROM messages
       WHERE to_id=? AND from_id=? ORDER BY created_at DESC LIMIT 500`
    ).all(FILEHELPER_ID, me);
    const files = [];
    for (const r of rows) {
      const m = /^文件:([0-9a-f-]{8,}):(\{.*\})$/.exec(String(r.content || ''));
      if (!m) continue;
      let meta;
      try { meta = JSON.parse(m[2]); } catch (e) { continue; }
      const filePath = path.join(FH_DIR, m[1] + '.bin');
      if (!fs.existsSync(filePath)) continue;
      files.push({
        id: m[1],
        name: meta.name || 'file',
        mime: meta.mime || 'application/octet-stream',
        size: meta.size || 0,
        time: r.createdAt || meta.at || 0,
      });
    }
    res.json({ files });
  });

  app.get('/api/rtc/filehelper/file/:id', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{8,}$/.test(id)) return res.status(400).json({ error: '文件 id 无效' });
    // 只允许拥有该消息的用户下载
    const msg = prepare('SELECT content FROM messages WHERE to_id=? AND from_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 1')
      .get(FILEHELPER_ID, me, '文件:' + id + ':%');
    if (!msg) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(FH_DIR, id + '.bin');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    let name = 'file';
    try {
      const m = /^文件:([0-9a-f-]{8,}):(\{.*\})$/.exec(msg.content);
      if (m) name = (JSON.parse(m[2]).name || 'file').toString();
    } catch (e) {}
    res.setHeader('Content-Type', (() => {
      try {
        const m = /^文件:([0-9a-f-]{8,}):(\{.*\})$/.exec(msg.content);
        return m ? (JSON.parse(m[2]).mime || 'application/octet-stream') : 'application/octet-stream';
      } catch (e) { return 'application/octet-stream'; }
    })());
    res.setHeader('Content-Disposition', `attachment; filename="${String(name).replace(/["\\\r\n]/g, '_')}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  app.delete('/api/rtc/filehelper/file/:id', (req, res) => {
    const me = requireAuth(req, res);
    if (!me) return;
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{8,}$/.test(id)) return res.status(400).json({ error: '文件 id 无效' });
    const msg = prepare('SELECT id, content FROM messages WHERE to_id=? AND from_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 1')
      .get(FILEHELPER_ID, me, '文件:' + id + ':%');
    if (!msg) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(FH_DIR, id + '.bin');
    let removed = false;
    try { fs.unlinkSync(filePath); removed = true; } catch (e) {}
    // 标记该消息（把 content 换成已删除占位，避免重复列出）
    prepare('UPDATE messages SET content=? WHERE id=?').run('文件:DELETED', msg.id);
    persist();
    res.json({ ok: true, removed });
  });

  // 预热：确保 FILEHELPER_ID 虚拟好友的会话能在 UI 里出现（无需真实 users 行）
  return {
    FILEHELPER_ID,
    FILEHELPER_NAME,
    pushSignal,
    inboxLength: (userId) => (inbox.get(userId) || []).length,
  };
};