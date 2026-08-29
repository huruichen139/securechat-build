// module: media (worker batch4) —— 公众号 / 视频号 / 直播（三端）
// 挂载方式（由合并 worker 调用）：在 server/index.js 中
//   const registerMedia = require('./routes/media');
//   registerMedia(app, db, apiUser);   // apiUser(req) 解析 Authorization 返回 JWT payload（或 null）
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { prepare } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (_) {}

function baseUrlOf(req) {
  return (req.protocol || 'http') + '://' + (req.get('host') || '');
}

module.exports = function registerMedia(app, db, auth) {
  // 本地验证：若调用方未传 auth 函数，则用同一 JWT_SECRET 自行解析
  function authed(req) {
    if (typeof auth === 'function') return auth(req);
    const h = req.headers.authorization || '';
    try { return jwt.verify(String(h).replace(/^Bearer\s+/i, ''), JWT_SECRET); } catch (_) { return null; }
  }
  function deny(res, code, msg) { res.status(code).json({ error: msg }); }
  function userInfo(id) {
    const u = prepare('SELECT id,username,nickname,avatar FROM users WHERE id=?').get(id);
    if (!u) return { id, nickname: '用户' + id, username: '', avatar: '' };
    return u;
  }
  function okay(res, obj) { res.json(Object.assign({ ok: true }, obj)); }

  // 确保新增列存在（batch2 可能已建过同名表但没有下列列）
  function ensureColumn(table, col, ddl) {
    try { prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl).run(); } catch (_) { /* 已存在则忽略 */ }
  }

  // ---------- 建表（IF NOT EXISTS） ----------
  db.run(`
    CREATE TABLE IF NOT EXISTS official_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      owner_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      cover TEXT DEFAULT '',
      read_count INTEGER NOT NULL DEFAULT 0,
      present_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_articles_account ON articles(account_id, created_at);
    CREATE TABLE IF NOT EXISTS present_likes (
      article_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(article_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS article_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reply_to INTEGER,
      content TEXT NOT NULL,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_article_comments ON article_comments(article_id, created_at);
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      cover TEXT DEFAULT '',
      content TEXT DEFAULT '',
      url TEXT DEFAULT '',
      file_type TEXT DEFAULT 'mp4',
      play_count INTEGER NOT NULL DEFAULT 0,
      share_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      favorite_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id, created_at);
    CREATE TABLE IF NOT EXISTS video_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reply_to INTEGER,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_video_comments ON video_comments(video_id, created_at);
    CREATE TABLE IF NOT EXISTS video_likes (
      video_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(video_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS video_favorites (
      video_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(video_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS live_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      cover TEXT DEFAULT '',
      stream_url TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'live',  -- live|ended
      replay_url TEXT DEFAULT '',
      viewer_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      favorite_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_live_rooms_status ON live_rooms(status, created_at);
    CREATE TABLE IF NOT EXISTS live_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_chat ON live_chat(room_id, created_at);
    CREATE TABLE IF NOT EXISTS live_likes (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS live_favorites (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS media_files (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // batch2 的 videos 表可能没有新增列，尽量补齐
  ensureColumn('videos', 'url TEXT', 'url TEXT');
  ensureColumn('videos', 'file_type TEXT', 'file_type TEXT DEFAULT \'mp4\'');
  ensureColumn('videos', 'play_count INTEGER', 'play_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('videos', 'share_count INTEGER', 'share_count INTEGER NOT NULL DEFAULT 0');
  try { prepare('ALTER TABLE videos ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
  try { prepare('ALTER TABLE videos ADD COLUMN favorite_count INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
  try { prepare('ALTER TABLE videos ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
  ensureColumn('video_comments', 'reply_to INTEGER', 'reply_to INTEGER');
  try { prepare('ALTER TABLE official_accounts ADD COLUMN type TEXT').run(); } catch (_) {}

  // ============================================================
  // 媒体文件上传 / 下载（图片封面 + 视频源文件；解耦于 /api/files 的好友双向模型）
  // ============================================================
  app.post('/api/media', express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return deny(res, 400, '文件为空');
    // 用户配额：最多 500 个文件或总量 2GB，防止磁盘被刷满
    try {
      const q = prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM media_files WHERE user_id=?').get(payload.id) || { c: 0, s: 0 };
      if (Number(q.c) >= 500 || Number(q.s) + req.body.length > 2 * 1024 * 1024 * 1024) {
        return deny(res, 400, '媒体空间已满（上限500个或2GB）');
      }
    } catch (e) { /* 配额表缺失时放行 */ }
    const mime = String(req.query.mime || 'application/octet-stream').slice(0, 120);
    const id = crypto.randomUUID();
    const filePath = path.join(MEDIA_DIR, id + '.bin');
    try {
      fs.writeFileSync(filePath, req.body);
      prepare('INSERT INTO media_files(id,user_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, payload.id, String(req.query.name || 'file').slice(0, 240) || 'file', mime, req.body.length, filePath, Date.now());
      const url = '/api/media/' + id;
      const absolute = baseUrlOf(req) + url;
      res.json({ ok: true, id, url, name: req.query.name || 'file', mime, size: req.body.length, absolute });
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      res.status(500).json({ error: '文件保存失败' });
    }
  });

  app.get('/api/media/:id', (req, res) => {
    // 媒体为公开读：封面/视频在信息流中被任何人可见
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{8,}$/.test(id)) return deny(res, 400, '无效文件');
    const f = prepare('SELECT name,mime,path FROM media_files WHERE id=?').get(id);
    if (!f || !fs.existsSync(f.path)) return deny(res, 404, '文件不存在');
    // 防 XSS：仅白名单类型允许内联渲染，其余强制下载；svg/html 可携带脚本一律不内联
    const rawMime = String(f.mime || '').toLowerCase().split(';')[0].trim();
    const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac))$/;
    const safe = SAFE_INLINE.test(rawMime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', safe ? rawMime : 'application/octet-stream');
    res.setHeader('Content-Disposition', (safe ? 'inline' : 'attachment') + '; filename="' + String(f.name || 'file').replace(/["\\\r\n]/g, '_') + '"');
    fs.createReadStream(f.path).pipe(res);
  });

  // ============================================================
  // 公众号
  // ============================================================
  function oaPublic(a, meId) {
    return {
      id: a.id, name: a.name, avatar: a.avatar, intro: a.intro,
      ownerId: a.owner_id,
      following: !!meId && !!prepare('SELECT 1 FROM account_follows WHERE account_id=? AND user_id=?').get(a.id, meId),
      articleCount: 0,
    };
  }

  // 注册/把我当前的普通账号升级为公众号（一个用户最多一个）
  app.post('/api/oa/register', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const name = String((req.body || {}).name || '').trim();
    if (!name || name.length > 40) return deny(res, 400, '公众号名称不能为空（40字内）');
    const existing = prepare('SELECT id FROM official_accounts WHERE owner_id=?').get(payload.id);
    if (existing) return deny(res, 409, '你已拥有公众号');
    const avatar = String((req.body || {}).avatar || '').slice(0, 2000);
    const intro = String((req.body || {}).intro || '').slice(0, 500);
    const now = Date.now();
    const info = prepare('INSERT INTO official_accounts(name,avatar,intro,owner_id,created_at) VALUES(?,?,?,?,?)')
      .run(name, avatar, intro, payload.id, now);
    oaRaw = prepare('SELECT * FROM official_accounts WHERE id=?').get(info.lastInsertRowid);
    okay(res, { account: oaPublic(oaRaw, payload.id) });
  });
  let oaRaw = null;

  // 公众号列表（含当前用户关注状态）
  app.get('/api/oa', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const rows = prepare('SELECT * FROM official_accounts ORDER BY id DESC').all();
    const list = rows.map(r => {
      const p = oaPublic(r, meId);
      p.articleCount = (prepare('SELECT COUNT(*) AS c FROM articles WHERE account_id=?').get(r.id) || { c: 0 }).c;
      return p;
    });
    okay(res, { accounts: list });
  });

  // 我的信息流：我关注的公众号的最新文章
  app.get('/api/oa/feed', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rows = prepare(`
      SELECT ar.* FROM articles ar
      JOIN account_follows af ON af.account_id=ar.account_id
      WHERE af.user_id=? ORDER BY ar.created_at DESC LIMIT 200`).all(payload.id);
    okay(res, { articles: rows.map(r => articlePublic(r, payload.id)) });
  });

  // 我在看的文章
  app.get('/api/oa/me/present', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rows = prepare(`
      SELECT ar.* FROM articles ar JOIN present_likes pl ON pl.article_id=ar.id
      WHERE pl.user_id=? ORDER BY pl.created_at DESC LIMIT 200`).all(payload.id);
    okay(res, { articles: rows.map(r => articlePublic(r, payload.id)) });
  });

  app.get('/api/oa/:id', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const a = prepare('SELECT * FROM official_accounts WHERE id=?').get(Number(req.params.id));
    if (!a) return deny(res, 404, '公众号不存在');
    const p = oaPublic(a, meId);
    p.articleCount = (prepare('SELECT COUNT(*) AS c FROM articles WHERE account_id=?').get(a.id) || { c: 0 }).c;
    p.followerCount = (prepare('SELECT COUNT(*) AS c FROM account_follows WHERE account_id=?').get(a.id) || { c: 0 }).c;
    if (a.owner_id === meId) p.ownedByMe = true;
    okay(res, { account: p });
  });

  // 关注 / 取关公众号
  app.post('/api/oa/:id/follow', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    const a = prepare('SELECT id FROM official_accounts WHERE id=?').get(aid);
    if (!a) return deny(res, 404, '公众号不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO account_follows(account_id,user_id,created_at) VALUES(?,?,?)').run(aid, payload.id, Date.now());
    else prepare('DELETE FROM account_follows WHERE account_id=? AND user_id=?').run(aid, payload.id);
    okay(res, { following: on, followCount: (prepare('SELECT COUNT(*) AS c FROM account_follows WHERE account_id=?').get(aid) || { c: 0 }).c });
  });

  // 公众号文章列表
  app.get('/api/oa/:id/articles', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const rows = prepare('SELECT * FROM articles WHERE account_id=? ORDER BY created_at DESC').all(Number(req.params.id));
    const list = rows.map(r => articlePublic(r, meId));
    okay(res, { articles: list });
  });

  // 公众号发文（仅账号 owner）
  app.post('/api/oa/:id/article', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    const a = prepare('SELECT * FROM official_accounts WHERE id=?').get(aid);
    if (!a) return deny(res, 404, '公众号不存在');
    if (a.owner_id !== payload.id) return deny(res, 403, '仅公众号作者可以发文');
    const title = String((req.body || {}).title || '').trim();
    const content = String((req.body || {}).content || '').trim();
    if (!title || !content) return deny(res, 400, '标题和正文不能为空');
    const cover = String((req.body || {}).cover || '').slice(0, 2000);
    const now = Date.now();
    const info = prepare('INSERT INTO articles(account_id,title,content,cover,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(aid, title, content, cover, now, now);
    okArticle = prepare('SELECT * FROM articles WHERE id=?').get(info.lastInsertRowid);
    okay(res, { article: articlePublic(okArticle, payload.id) });
  });
  let okArticle = null;

  function articlePublic(r, meId) {
    const acc = prepare('SELECT * FROM official_accounts WHERE id=?').get(r.account_id) || {};
    return {
      id: r.id, accountId: r.account_id, accountName: acc.name, accountAvatar: acc.avatar,
      title: r.title, content: r.content, cover: r.cover,
      readCount: r.read_count, presentCount: r.present_count, commentCount: r.comment_count,
      createdAt: r.created_at, updatedAt: r.updated_at,
      presented: !!meId && !!prepare('SELECT 1 FROM present_likes WHERE article_id=? AND user_id=?').get(r.id, meId),
    };
  }

  function articleComments(articleId) {
    const rows = prepare(`
      SELECT c.id,c.article_id AS articleId,c.reply_to AS replyTo,c.content,c.featured,c.created_at AS createdAt,
             u.id AS userId,u.nickname,u.username,u.avatar
      FROM article_comments c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.article_id=? ORDER BY c.featured DESC,c.created_at ASC`).all(articleId);
    return rows;
  }

  // 文章详情（阅读量 +1；含评论）
  app.get('/api/articles/:id', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const r = prepare('SELECT * FROM articles WHERE id=?').get(Number(req.params.id));
    if (!r) return deny(res, 404, '文章不存在');
    prepare('UPDATE articles SET read_count=read_count+1 WHERE id=?').run(r.id);
    const fresh = prepare('SELECT * FROM articles WHERE id=?').get(r.id);
    const pub = articlePublic(fresh, meId);
    pub.comments = articleComments(r.id);
    const acc = prepare('SELECT * FROM official_accounts WHERE id=?').get(fresh.account_id) || {};
    pub.ownedByMe = !!meId && acc.owner_id === meId;
    okay(res, { article: pub });
  });

  // 读者留言
  app.post('/api/articles/:id/comment', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    if (!prepare('SELECT id FROM articles WHERE id=?').get(aid)) return deny(res, 404, '文章不存在');
    const content = String((req.body || {}).content || '').trim();
    if (!content || content.length > 2000) return deny(res, 400, '留言内容不能为空');
    let replyTo = null;
    const rawReplyTo = Number((req.body || {}).replyTo) || null;
    if (rawReplyTo) {
      const parent = prepare('SELECT id FROM article_comments WHERE id=? AND article_id=?').get(rawReplyTo, aid);
      if (!parent) return deny(res, 400, '被回复的评论不存在');
      replyTo = parent.id;
    }
    prepare('INSERT INTO article_comments(article_id,user_id,reply_to,content,created_at) VALUES(?,?,?,?,?)')
      .run(aid, payload.id, replyTo, content, Date.now());
    prepare('UPDATE articles SET comment_count=(SELECT COUNT(*) FROM article_comments WHERE article_id=?) WHERE id=?').run(aid, aid);
    okay(res, { comments: articleComments(aid) });
  });

  // 作者精选 / 取消精选某条留言（仅 owner）
  app.post('/api/articles/:id/comment/:commentId/feature', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    const a = prepare('SELECT * FROM articles WHERE id=? ').get(aid);
    const acc = a ? prepare('SELECT * FROM official_accounts WHERE id=?').get(a.account_id) : null;
    if (!acc || acc.owner_id !== payload.id) return deny(res, 403, '仅公众号作者可精选留言');
    const cid = Number(req.params.commentId);
    const on = (req.body || {}).on !== false;
    prepare('UPDATE article_comments SET featured=? WHERE id=? AND article_id=?').run(on ? 1 : 0, cid, aid);
    okay(res, { comments: articleComments(aid) });
  });

  // 作者回复留言（以作者身份发表一条带 reply_to 的评论）
  app.post('/api/articles/:id/reply', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    const a = prepare('SELECT * FROM articles WHERE id=? ').get(aid);
    const acc = a ? prepare('SELECT * FROM official_accounts WHERE id=?').get(a.account_id) : null;
    if (!acc || acc.owner_id !== payload.id) return deny(res, 403, '仅公众号作者可回复');
    const content = String((req.body || {}).content || '').trim();
    const replyTo = Number((req.body || {}).commentId) || null;
    if (!content) return deny(res, 400, '回复内容不能为空');
    prepare('INSERT INTO article_comments(article_id,user_id,reply_to,content,created_at) VALUES(?,?,?,?,?)')
      .run(aid, payload.id, replyTo, content, Date.now());
    prepare('UPDATE articles SET comment_count=(SELECT COUNT(*) FROM article_comments WHERE article_id=?) WHERE id=?').run(aid, aid);
    okay(res, { comments: articleComments(aid) });
  });

  // "在看" 点赞 / 取消
  app.post('/api/articles/:id/wow', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const aid = Number(req.params.id);
    if (!prepare('SELECT id FROM articles WHERE id=?').get(aid)) return deny(res, 404, '文章不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO present_likes(article_id,user_id,created_at) VALUES(?,?,?)').run(aid, payload.id, Date.now());
    else prepare('DELETE FROM present_likes WHERE article_id=? AND user_id=?').run(aid, payload.id);
    const cnt = (prepare('SELECT COUNT(*) AS c FROM present_likes WHERE article_id=?').get(aid) || { c: 0 }).c;
    prepare('UPDATE articles SET present_count=? WHERE id=?').run(cnt, aid);
    okay(res, { presented: on, presentCount: cnt });
  });

  // ============================================================
  // 视频号
  // ============================================================
  function videoPublic(v, meId) {
    const u = userInfo(v.user_id);
    return {
      id: v.id, userId: v.user_id, nickname: u.nickname, username: u.username, avatar: u.avatar,
      title: v.title, content: v.content, cover: v.cover, url: v.url, fileType: v.file_type,
      playCount: v.play_count, shareCount: v.share_count, likeCount: v.like_count,
      favoriteCount: v.favorite_count, commentCount: v.comment_count,
      createdAt: v.created_at,
      likedByMe: !!meId && !!prepare('SELECT 1 FROM video_likes WHERE video_id=? AND user_id=?').get(v.id, meId),
      favoritedByMe: !!meId && !!prepare('SELECT 1 FROM video_favorites WHERE video_id=? AND user_id=?').get(v.id, meId),
    };
  }

  // 发布短视频：先 POST /api/media 上传 mp4/webm 得到 { url }，再在这里记录
  app.post('/api/videos/publish', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const title = String((req.body || {}).title || '').trim();
    if (!title) return deny(res, 400, '视频标题不能为空');
    const url = String((req.body || {}).url || '').trim();
    if (!url) return deny(res, 400, '请先上传视频文件');
    const content = String((req.body || {}).content || '').trim();
    const cover = String((req.body || {}).cover || '').slice(0, 2000);
    const fileType = /\.(webm)(\?|$)/i.test(url) ? 'webm' : 'mp4';
    const now = Date.now();
    const info = prepare(`INSERT INTO videos(user_id,title,cover,content,url,file_type,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(payload.id, title, cover, content, url, fileType, now);
    const v = prepare('SELECT * FROM videos WHERE id=?').get(info.lastInsertRowid);
    okay(res, { video: videoPublic(v, payload.id) });
  });

  // 推荐流（最新，按时间倒序）
  app.get('/api/videos/feed', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const rows = prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT ?').all(limit);
    okay(res, { videos: rows.map(r => videoPublic(r, meId)) });
  });

  // 视频搜索（标题/描述 LIKE）
  app.get('/api/videos/search', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const q = String(req.query.q || '').trim();
    if (!q) return okay(res, { videos: [] });
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    const rows = prepare("SELECT * FROM videos WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 50").all(like, like);
    okay(res, { videos: rows.map(r => videoPublic(r, meId)) });
  });

  // 关注流：好友 + 自己的视频
  app.get('/api/videos/following', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    // 好友集合（双向 status=1）
    const friendRows = prepare('SELECT friend_id AS fid FROM friends WHERE user_id=? AND status=1 UNION SELECT user_id AS fid FROM friends WHERE friend_id=? AND status=1').all(payload.id, payload.id);
    const ids = friendRows.map(r => r.fid).concat(payload.id);
    if (!ids.length) return okay(res, { videos: [] });
    const marks = ids.map(() => '?').join(',');
    const rows = prepare('SELECT * FROM videos WHERE user_id IN (' + marks + ') ORDER BY created_at DESC LIMIT 200').all(...ids);
    okay(res, { videos: rows.map(r => videoPublic(r, payload.id)) });
  });

  // 我收藏的视频（必须在 :id 之前注册，否则 "me" 被 :id 吞掉）
  app.get('/api/videos/me/favorites', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rows = prepare(`
      SELECT v.* FROM videos v JOIN video_favorites vf ON vf.video_id=v.id
      WHERE vf.user_id=? ORDER BY vf.created_at DESC LIMIT 200`).all(payload.id);
    okay(res, { videos: rows.map(r => videoPublic(r, payload.id)) });
  });

  // 视频详情（播放量 +1）
  app.get('/api/videos/:id', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const v = prepare('SELECT * FROM videos WHERE id=?').get(Number(req.params.id));
    if (!v) return deny(res, 404, '视频不存在');
    prepare('UPDATE videos SET play_count=play_count+1 WHERE id=?').run(v.id);
    const fresh = prepare('SELECT * FROM videos WHERE id=?').get(v.id);
    const pub = videoPublic(fresh, meId);
    pub.comments = prepare(`
      SELECT c.id,c.video_id AS videoId,c.reply_to AS replyTo,c.content,c.created_at AS createdAt,
             u.id AS userId,u.nickname,u.username,u.avatar
      FROM video_comments c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.video_id=? ORDER BY c.created_at ASC`).all(Number(req.params.id));
    okay(res, { video: pub });
  });

  app.get('/api/videos/:id/comments', (req, res) => {
    const payload = authed(req); const meId = payload ? payload.id : null;
    const vid = Number(req.params.id);
    if (!prepare('SELECT id FROM videos WHERE id=?').get(vid)) return deny(res, 404, '视频不存在');
    const comments = prepare(`
      SELECT c.id,c.video_id AS videoId,c.reply_to AS replyTo,c.content,c.created_at AS createdAt,
             u.id AS userId,u.nickname,u.username,u.avatar
      FROM video_comments c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.video_id=? ORDER BY c.created_at ASC`).all(vid);
    okay(res, { comments });
  });

  // 点赞 / 取消
  app.post('/api/videos/:id/like', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const vid = Number(req.params.id);
    if (!prepare('SELECT id FROM videos WHERE id=?').get(vid)) return deny(res, 404, '视频不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO video_likes(video_id,user_id,created_at) VALUES(?,?,?)').run(vid, payload.id, Date.now());
    else prepare('DELETE FROM video_likes WHERE video_id=? AND user_id=?').run(vid, payload.id);
    const cnt = (prepare('SELECT COUNT(*) AS c FROM video_likes WHERE video_id=?').get(vid) || { c: 0 }).c;
    prepare('UPDATE videos SET like_count=? WHERE id=?').run(cnt, vid);
    okay(res, { liked: on, likeCount: cnt });
  });

  // 收藏 / 取消
  app.post('/api/videos/:id/favorite', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const vid = Number(req.params.id);
    if (!prepare('SELECT id FROM videos WHERE id=?').get(vid)) return deny(res, 404, '视频不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO video_favorites(video_id,user_id,created_at) VALUES(?,?,?)').run(vid, payload.id, Date.now());
    else prepare('DELETE FROM video_favorites WHERE video_id=? AND user_id=?').run(vid, payload.id);
    const cnt = (prepare('SELECT COUNT(*) AS c FROM video_favorites WHERE video_id=?').get(vid) || { c: 0 }).c;
    prepare('UPDATE videos SET favorite_count=? WHERE id=?').run(cnt, vid);
    okay(res, { favorited: on, favoriteCount: cnt });
  });

  // 评论
  app.post('/api/videos/:id/comment', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const vid = Number(req.params.id);
    if (!prepare('SELECT id FROM videos WHERE id=?').get(vid)) return deny(res, 404, '视频不存在');
    const content = String((req.body || {}).content || '').trim();
    if (!content || content.length > 2000) return deny(res, 400, '评论不能为空');
    let replyTo = null;
    const rawReplyTo = Number((req.body || {}).replyTo) || null;
    if (rawReplyTo) {
      const parent = prepare('SELECT id FROM video_comments WHERE id=? AND video_id=?').get(rawReplyTo, vid);
      if (!parent) return deny(res, 400, '被回复的评论不存在');
      replyTo = parent.id;
    }
    prepare('INSERT INTO video_comments(video_id,user_id,reply_to,content,created_at) VALUES(?,?,?,?,?)')
      .run(vid, payload.id, replyTo, content, Date.now());
    const cnt = (prepare('SELECT COUNT(*) AS c FROM video_comments WHERE video_id=?').get(vid) || { c: 0 }).c;
    prepare('UPDATE videos SET comment_count=? WHERE id=?').run(cnt, vid);
    okay(res, { commentCount: cnt });
  });

  // 转发
  app.post('/api/videos/:id/share', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const vid = Number(req.params.id);
    if (!prepare('SELECT id FROM videos WHERE id=?').get(vid)) return deny(res, 404, '视频不存在');
    prepare('UPDATE videos SET share_count=share_count+1 WHERE id=?').run(vid);
    const v = prepare('SELECT * FROM videos WHERE id=?').get(vid);
    okay(res, { shareCount: v.share_count });
  });

  // ============================================================
  // 直播
  // ============================================================
  function livePublic(r, meId, withHost) {
    const u = withHost ? userInfo(r.host_id) : null;
    const p = {
      id: r.id, hostId: r.host_id, hostNickname: u ? u.nickname : '', hostAvatar: u ? u.avatar : '',
      title: r.title, cover: r.cover, streamUrl: r.stream_url, status: r.status,
      replayUrl: r.replay_url, viewerCount: r.viewer_count, likeCount: r.like_count,
      favoriteCount: r.favorite_count, createdAt: r.created_at, startedAt: r.started_at,
      endedAt: r.ended_at,
      likedByMe: !!meId && !!prepare('SELECT 1 FROM live_likes WHERE room_id=? AND user_id=?').get(r.id, meId),
      favoritedByMe: !!meId && !!prepare('SELECT 1 FROM live_favorites WHERE room_id=? AND user_id=?').get(r.id, meId),
    };
    return p;
  }

  // 开播：创建直播会话（降级方案 —— 主播提供 HLS/RTMP 拉流地址，或留空纯聊天室）
  app.post('/api/live/start', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    // 一个用户同时只能开一个直播间
    const live = prepare('SELECT id FROM live_rooms WHERE host_id=? AND status=\'live\'').get(payload.id);
    if (live) return deny(res, 409, '你已有正在直播的直播间');
    const title = String((req.body || {}).title || '').trim();
    if (!title) return deny(res, 400, '直播间标题不能为空');
    const cover = String((req.body || {}).cover || '').slice(0, 2000);
    const streamUrl = String((req.body || {}).streamUrl || '').trim().slice(0, 2000);
    const now = Date.now();
    const info = prepare(`INSERT INTO live_rooms(host_id,title,cover,stream_url,status,started_at,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(payload.id, title, cover, streamUrl, 'live', now, now);
    const room = prepare('SELECT * FROM live_rooms WHERE id=?').get(info.lastInsertRowid);
    okay(res, { room: livePublic(room, payload.id, true) });
  });

  // 下播（回放地址可传入：如 /api/media/:id 或外部 HLS）
  app.post('/api/live/end', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rid = Number((req.body || {}).roomId);
    const room = prepare('SELECT * FROM live_rooms WHERE id=?').get(rid);
    if (!room) return deny(res, 404, '直播间不存在');
    if (room.host_id !== payload.id) return deny(res, 403, '仅主播可结束直播');
    const replayUrl = String((req.body || {}).replayUrl || '').trim().slice(0, 2000);
    prepare('UPDATE live_rooms SET status=\'ended\', replay_url=?, ended_at=? WHERE id=?')
      .run(replayUrl || room.replay_url || '', Date.now(), rid);
    const fresh = prepare('SELECT * FROM live_rooms WHERE id=?').get(rid);
    okay(res, { room: livePublic(fresh, payload.id, true) });
  });

  // 直播列表：进行中在前，最近结束的按时间倒序
  app.get('/api/live', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const rows = prepare('SELECT * FROM live_rooms ORDER BY (status=\'live\') DESC, started_at DESC LIMIT 100').all();
    okay(res, { rooms: rows.map(r => livePublic(r, meId, true)) });
  });

  // 直播详情（收看量 +1）
  app.get('/api/live/room/:id', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const r = prepare('SELECT * FROM live_rooms WHERE id=?').get(Number(req.params.id));
    if (!r) return deny(res, 404, '直播间不存在');
    if (r.status === 'live') prepare('UPDATE live_rooms SET viewer_count=viewer_count+1 WHERE id=?').run(r.id);
    const fresh = prepare('SELECT * FROM live_rooms WHERE id=?').get(r.id);
    okay(res, { room: livePublic(fresh, meId, true) });
  });

  // 拉取弹幕 / 聊天记录（轮询：传 since 时间戳取增量）
  app.get('/api/live/room/:id/chat', (req, res) => {
    const payload = authed(req);
    const meId = payload ? payload.id : null;
    const rid = Number(req.params.id);
    if (!prepare('SELECT id FROM live_rooms WHERE id=?').get(rid)) return deny(res, 404, '直播间不存在');
    const since = parseInt(req.query.since, 10) || 0;
    const rows = prepare(`
      SELECT c.id,c.room_id AS roomId,c.content,c.created_at AS createdAt,
             u.id AS userId,u.nickname,u.username,u.avatar
      FROM live_chat c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.room_id=? AND c.created_at>? ORDER BY c.created_at ASC LIMIT 200`).all(rid, since);
    okay(res, { chats: rows, serverTime: Date.now() });
  });

  // 发送弹幕 / 聊天
  app.post('/api/live/room/:id/chat', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rid = Number(req.params.id);
    if (!prepare('SELECT id FROM live_rooms WHERE id=?').get(rid)) return deny(res, 404, '直播间不存在');
    const content = String((req.body || {}).content || '').trim();
    if (!content || content.length > 300) return deny(res, 400, '弹幕内容不能为空（300字内）');
    const now = Date.now();
    const info = prepare('INSERT INTO live_chat(room_id,user_id,content,created_at) VALUES(?,?,?,?)')
      .run(rid, payload.id, content, now);
    const chat = { id: info.lastInsertRowid, roomId: rid, content, createdAt: now, userId: payload.id, nickname: userInfo(payload.id).nickname, ...userInfo(payload.id) };
    // 简单去抖落盘：prepare 已内部 persistNow
    okay(res, { chat });
  });

  // 直播点赞 / 取消
  app.post('/api/live/room/:id/like', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rid = Number(req.params.id);
    if (!prepare('SELECT id FROM live_rooms WHERE id=?').get(rid)) return deny(res, 404, '直播间不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO live_likes(room_id,user_id,created_at) VALUES(?,?,?)').run(rid, payload.id, Date.now());
    else prepare('DELETE FROM live_likes WHERE room_id=? AND user_id=?').run(rid, payload.id);
    const cnt = (prepare('SELECT COUNT(*) AS c FROM live_likes WHERE room_id=?').get(rid) || { c: 0 }).c;
    prepare('UPDATE live_rooms SET like_count=? WHERE id=?').run(cnt, rid);
    okay(res, { liked: on, likeCount: cnt });
  });

  // 直播收藏（历史回放入口）
  app.post('/api/live/room/:id/favorite', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rid = Number(req.params.id);
    if (!prepare('SELECT id FROM live_rooms WHERE id=?').get(rid)) return deny(res, 404, '直播间不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO live_favorites(room_id,user_id,created_at) VALUES(?,?,?)').run(rid, payload.id, Date.now());
    else prepare('DELETE FROM live_favorites WHERE room_id=? AND user_id=?').run(rid, payload.id);
    const cnt = (prepare('SELECT COUNT(*) AS c FROM live_favorites WHERE room_id=?').get(rid) || { c: 0 }).c;
    prepare('UPDATE live_rooms SET favorite_count=? WHERE id=?').run(cnt, rid);
    okay(res, { favorited: on, favoriteCount: cnt });
  });

  // 我收藏的直播回放
  app.get('/api/live/me/favorites', (req, res) => {
    const payload = authed(req);
    if (!payload) return deny(res, 401, '未授权');
    const rows = prepare(`
      SELECT r.* FROM live_rooms r JOIN live_favorites lf ON lf.room_id=r.id
      WHERE lf.user_id=? ORDER BY lf.created_at DESC LIMIT 100`).all(payload.id);
    okay(res, { rooms: rows.map(r => livePublic(r, payload.id, true)) });
  });

  // ============================================================
  // 直播弹幕实时推送（尽力而为：不挂 WebSocket，靠轮询；此处可挂 SIG 但保持轻量）
  // ============================================================
  console.log('[media] module batch4 loaded: /api/oa/* /api/videos/* /api/live/* /api/media');
};