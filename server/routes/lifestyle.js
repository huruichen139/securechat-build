// module: lifestyle (worker batch5) —— 小程序开放平台 + 附近的人 + 摇一摇
// 挂载方式（由合并 worker 调用）：在 server/index.js 中
//   const registerLifestyle = require('./routes/lifestyle');
//   registerLifestyle(app, db, auth);   // auth(req) 解析 Authorization 返回 JWT payload（或 null）
// 端点：/api/mini-program/*、/api/nearby/*、/api/shake/*
// 依赖：db.js 提供的 prepare/persist（prepare 内部已 persistNow）。
// 说明：小程序数据以 mini_programs 为规范存储，并在发布时镜像进既有 mini_apps 表，
//      以让巨石既有 /api/mini-apps（及 Flutter miniApps()）能读到同一批小程序。
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

// 摇一摇会话有效期（毫秒）
const SHAKE_TTL = 3 * 60 * 1000;

// 附近的人活跃窗口
const NEARBY_ACTIVE_MS = 24 * 60 * 60 * 1000;

// 简单但确定的 mock 城市池（IP 反查不可用时按用户 id 稳定散列）
const MOCK_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '苏州', '天津'];

module.exports = function registerLifestyle(app, db, auth) {
  const api = db && db.prepare ? db : { prepare: require('../db').prepare };
  const prepare = api.prepare;

  // ---------- 鉴权：优先用合并 worker 注入的 auth，退化自行解析 JWT ----------
  function apiUser(req) {
    try {
      if (typeof auth === 'function') {
        const r = auth(req);
        if (r && typeof r === 'object' && r.id != null) return { id: r.id };
        if (typeof r === 'number') return { id: r };
        if (typeof r === 'string' && /^\d+$/.test(r)) return { id: Number(r) };
        return null;
      }
      const h = req.headers.authorization || '';
      const payload = jwt.verify(h.replace(/^Bearer\s+/i, ''), JWT_SECRET);
      return payload ? { id: payload.id } : null;
    } catch (e) {
      return null;
    }
  }

  function deny(res, code, msg) { res.status(code).json({ error: msg }); }
  function okay(res, obj) { res.json(Object.assign({ ok: true }, obj)); }
  function me(res, req) {
    const p = apiUser(req);
    if (!p) { deny(res, 401, '未授权'); return null; }
    return p;
  }
  function userPublic(u) {
    if (!u) return null;
    return {
      id: u.id, username: u.username || '', nickname: u.nickname || '',
      avatar: u.avatar || '', uid: u.uid || '', city: u.city || '',
      country: u.country || '', province: u.province || '',
    };
  }
  function micrId(uid) { return Number(uid) || 0; }

  // 确保既有表补齐需要的列（幂等）
  function ensureColumn(table, col, ddl) {
    try { prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl).run(); } catch (_) { /* 已存在则忽略 */ }
  }

  // ---------- 建表（IF NOT EXISTS，必须 .run() 才真正执行） ----------
  prepare(`
    CREATE TABLE IF NOT EXISTS mini_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mini_owner ON mini_programs(owner_id);
  `).run();
  prepare(`
    CREATE TABLE IF NOT EXISTS mini_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, app_id)
    );
  `).run();
  prepare(`
    CREATE TABLE IF NOT EXISTS mini_favorites (
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, app_id)
    );
  `).run();
  prepare(`
    CREATE TABLE IF NOT EXISTS nearby_markers (
      user_id INTEGER PRIMARY KEY,
      city TEXT DEFAULT '',
      region TEXT DEFAULT '',
      lat REAL DEFAULT 0,
      lng REAL DEFAULT 0,
      last_seen INTEGER NOT NULL
    );
  `).run();
  prepare(`
    CREATE TABLE IF NOT EXISTS shake_sessions (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shake_expires ON shake_sessions(expires_at);
  `).run();
  // 用户表若缺城市列则补齐（profile 接口可能已建）
  ensureColumn('users', 'city TEXT', 'city TEXT');

  // ============================================================
  // 小程序开放平台
  // ============================================================
  function mpPublic(a, meId) {
    return {
      id: a.id, name: a.name, icon: a.icon, url: a.url, description: a.description,
      ownerId: a.owner_id, createdAt: a.created_at,
      ownedByMe: !!meId && a.owner_id === meId,
      favoritedByMe: !!meId && !!prepare('SELECT 1 FROM mini_favorites WHERE user_id=? AND app_id=?').get(meId, a.id),
    };
  }
  function syncToMiniApps(a) {
    // 既有 /api/mini-apps 读的是 mini_apps 表，这里镜像保持一致
    try {
      const ex = prepare('SELECT id FROM mini_apps WHERE owner_id=? AND name=?').get(a.owner_id, a.name);
      if (ex) {
        prepare('UPDATE mini_apps SET icon=?, desc=?, url=? WHERE id=?')
          .run(a.icon || '', a.description || '', a.url, ex.id);
      } else {
        prepare('INSERT INTO mini_apps(name,icon,desc,url,owner_id,created_at) VALUES(?,?,?,?,?,?)')
          .run(a.name, a.icon || '', a.description || '', a.url, a.owner_id, a.created_at);
      }
    } catch (_) { /* mini_apps 表未建则忽略，不影响本模块 */ }
  }

  // 发布小程序（任何登录用户均可，含 admin）
  app.post('/api/mini-program/publish', (req, res) => {
    const id = me(res, req); if (!id) return;
    const name = String((req.body || {}).name || '').trim();
    const url = String((req.body || {}).url || '').trim();
    if (!name || name.length > 30) return deny(res, 400, '小程序名称不能为空（30字内）');
    if (!url || !/^https?:\/\//i.test(url) || url.length > 2000) return deny(res, 400, '请填写 http(s) 开头的 web 入口地址');
    const icon = String((req.body || {}).icon || '').trim().slice(0, 2000);
    const description = String((req.body || {}).description || '').trim().slice(0, 500);
    const now = Date.now();
    const info = prepare('INSERT INTO mini_programs(name,icon,url,description,owner_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(name, icon, url, description, id.id, now);
    const row = prepare('SELECT * FROM mini_programs WHERE id=?').get(info.lastInsertRowid);
    syncToMiniApps(row);
    okay(res, { program: mpPublic(row, id.id) });
  });

  // 小程序列表
  app.get('/api/mini-program/list', (req, res) => {
    const id = me(res, req); if (!id) return;
    const rows = prepare('SELECT * FROM mini_programs ORDER BY id DESC').all();
    okay(res, { programs: rows.map(a => mpPublic(a, id.id)) });
  });

  // 搜索小程序
  app.get('/api/mini-program/search', (req, res) => {
    const id = me(res, req); if (!id) return;
    const q = String(req.query.q || '').trim();
    if (!q) return deny(res, 400, '请输入搜索关键词');
    const like = '%' + q.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
    const rows = prepare(`SELECT * FROM mini_programs
      WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
      ORDER BY id DESC LIMIT 50`).all(like, like);
    okay(res, { programs: rows.map(a => mpPublic(a, id.id)) });
  });

  // 小程序详情 + 使用记录（打开即记录）
  app.get('/api/mini-program/:id', (req, res) => {
    const id = me(res, req); if (!id) return;
    const aid = micrId(req.params.id);
    const a = prepare('SELECT * FROM mini_programs WHERE id=?').get(aid);
    if (!a) return deny(res, 404, '小程序不存在');
    prepare('INSERT INTO mini_usage(user_id,app_id,last_at,count) VALUES(?,?,?,1) '
      + 'ON CONFLICT(user_id,app_id) DO UPDATE SET last_at=excluded.last_at,count=count+1')
      .run(id.id, aid, Date.now());
    const owner = prepare('SELECT * FROM users WHERE id=?').get(a.owner_id);
    okay(res, { program: mpPublic(a, id.id), ownerName: owner ? owner.nickname : '' });
  });

  // 我的最近使用
  app.get('/api/mini-program/me/recent', (req, res) => {
    const id = me(res, req); if (!id) return;
    const rows = prepare(`
      SELECT mp.* FROM mini_programs mp JOIN mini_usage u ON u.app_id=mp.id
      WHERE u.user_id=? ORDER BY u.last_at DESC LIMIT 50`).all(id.id);
    okay(res, { programs: rows.map(a => mpPublic(a, id.id)) });
  });

  // 我的收藏
  app.get('/api/mini-program/me/favorites', (req, res) => {
    const id = me(res, req); if (!id) return;
    const rows = prepare(`
      SELECT mp.* FROM mini_programs mp JOIN mini_favorites f ON f.app_id=mp.id
      WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 100`).all(id.id);
    okay(res, { programs: rows.map(a => mpPublic(a, id.id)) });
  });

  // 收藏 / 取消收藏
  app.post('/api/mini-program/:id/favorite', (req, res) => {
    const id = me(res, req); if (!id) return;
    const aid = micrId(req.params.id);
    if (!prepare('SELECT id FROM mini_programs WHERE id=?').get(aid)) return deny(res, 404, '小程序不存在');
    const on = (req.body || {}).on !== false;
    if (on) prepare('INSERT OR IGNORE INTO mini_favorites(user_id,app_id,created_at) VALUES(?,?,?)').run(id.id, aid, Date.now());
    else prepare('DELETE FROM mini_favorites WHERE user_id=? AND app_id=?').run(id.id, aid);
    okay(res, { favorited: on });
  });

  // ============================================================
  // 附近的人
  // ============================================================
  // 从 IP 反查（尽力而为），失败则按用户 id 稳定 mock 城市
  function guessCity(req, userId) {
    let city = '';
    try {
      const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString();
      const raw = ip.split(',')[0].trim();
      if (raw && raw !== '::1' && raw !== '127.0.0.1' && /^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
        // 无外部 GeoIP 库时省略真实反查；保留扩展点，返回空让调用方走 mock
      }
    } catch (_) {}
    const salt = Math.abs(crypto.createHash('md5').update(String(userId)).digest().readInt32BE(0));
    city = MOCK_CITIES[salt % MOCK_CITIES.length];
    return city;
  }

  // 设置我的位置（城市可选，默认 IP/mock）
  app.post('/api/nearby/set', (req, res) => {
    const id = me(res, req); if (!id) return;
    const city = String((req.body || {}).city || '').trim().slice(0, 40) || guessCity(req, id.id);
    const region = String((req.body || {}).region || '').trim().slice(0, 40);
    const lat = Number((req.body || {}).lat) || 0;
    const lng = Number((req.body || {}).lng) || 0;
    prepare(`INSERT INTO nearby_markers(user_id,city,region,lat,lng,last_seen) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET city=excluded.city,region=excluded.region,lat=excluded.lat,lng=excluded.lng,last_seen=excluded.last_seen`)
      .run(id.id, city, region, lat, lng, Date.now());
    // 同步回 users.city（名片展示用）
    try { prepare('UPDATE users SET city=? WHERE id=?').run(city, id.id); } catch (_) {}
    okay(res, { city, region, lat, lng });
  });

  // 附近的人列表（同城 + 活跃）
  app.get('/api/nearby/list', (req, res) => {
    const id = me(res, req); if (!id) return;
    const m = prepare('SELECT * FROM nearby_markers WHERE user_id=?').get(id.id);
    const city = (m && m.city) || guessCity(req, id.id);
    // 保证自己也有标记，便于同城匹配
    if (!m) {
      prepare('INSERT INTO nearby_markers(user_id,city,region,lat,lng,last_seen) VALUES(?,?,?,?,?,?)')
        .run(id.id, city, '', 0, 0, Date.now());
    }
    const cutoff = Date.now() - NEARBY_ACTIVE_MS;
    const rows = prepare(`SELECT n.*, u.username,u.nickname,u.avatar,u.uid FROM nearby_markers n
      LEFT JOIN users u ON u.id=n.user_id
      WHERE n.user_id<>? AND n.city=? AND n.last_seen>=?
      ORDER BY n.last_seen DESC LIMIT 100`).all(id.id, city, cutoff);
    const list = rows.map(r => {
      const p = {
        userId: r.user_id, nickname: r.nickname, username: r.username, avatar: r.avatar, uid: r.uid,
        city: r.city, region: r.region || '', lastSeen: r.last_seen,
        online: Date.now() - r.last_seen < 2 * 60 * 1000,
      };
      p.isFriend = !!prepare(`SELECT 1 FROM friends
        WHERE (user_id=? AND friend_id=? AND status=1) AND EXISTS(SELECT 1 FROM friends f2 WHERE f2.user_id=? AND f2.friend_id=? AND f2.status=1)`)
        .get(id.id, r.user_id, r.user_id, id.id);
      p.friendRequested = !!prepare(`SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=0`)
        .get(id.id, r.user_id);
      return p;
    });
    okay(res, { city, people: list });
  });

  // 打招呼 / 加好友（插入待确认好友请求）
  app.post('/api/nearby/:userId/hello', (req, res) => {
    const id = me(res, req); if (!id) return;
    const target = micrId(req.params.userId);
    if (!target || target === id.id) return deny(res, 400, '无效对象');
    if (!prepare('SELECT id FROM users WHERE id=?').get(target)) return deny(res, 404, '用户不存在');
    // 已是双向好友则不需要重复
    const both = prepare(`SELECT 1 FROM friends a JOIN friends b ON b.user_id=a.friend_id AND b.friend_id=a.user_id
      WHERE a.user_id=? AND a.friend_id=? AND a.status=1`).get(id.id, target);
    if (both) return okay(res, { already: true, message: '你们已是好友' });
    prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,0,?)').run(id.id, target, Date.now());
    okay(res, { sent: true, message: '已打招呼' });
  });

  // ============================================================
  // 摇一摇
  // ============================================================
  // 开始摇（注册会话，保持 active 一段时间）
  app.post('/api/shake/start', (req, res) => {
    const id = me(res, req); if (!id) return;
    // 清理过期会话
    prepare('DELETE FROM shake_sessions WHERE expires_at<?').run(Date.now());
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    prepare('INSERT INTO shake_sessions(session_id,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(sessionId, id.id, now, now + SHAKE_TTL);
    okay(res, { shakeSessionId: sessionId, expiresAt: now + SHAKE_TTL });
  });

  // 拉取当前同样在摇的用户
  app.get('/api/shake/matches', (req, res) => {
    const id = me(res, req); if (!id) return;
    // 刷新自己的有效期（保持活跃）
    prepare('UPDATE shake_sessions SET expires_at=? WHERE user_id=?').run(Date.now() + SHAKE_TTL, id.id);
    // 清理过期
    prepare('DELETE FROM shake_sessions WHERE expires_at<?').run(Date.now());
    const rows = prepare(`
      SELECT s.user_id, u.username,u.nickname,u.avatar,u.uid,u.city
      FROM shake_sessions s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.user_id<>? AND s.expires_at>?
      GROUP BY s.user_id ORDER BY s.created_at DESC LIMIT 100`).all(id.id, Date.now());
    const list = rows.map(r => ({
      userId: r.user_id, nickname: r.nickname, username: r.username, avatar: r.avatar, uid: r.uid, city: r.city || '',
    }));
    okay(res, { matches: list });
  });

  // 停止摇（退出会话）
  app.post('/api/shake/stop', (req, res) => {
    const id = me(res, req); if (!id) return;
    prepare('DELETE FROM shake_sessions WHERE user_id=?').run(id.id);
    okay(res, {});
  });

  // 对摇到的用户打招呼 / 加好友
  app.post('/api/shake/:userId/hello', (req, res) => {
    const id = me(res, req); if (!id) return;
    const target = micrId(req.params.userId);
    if (!target || target === id.id) return deny(res, 400, '无效对象');
    if (!prepare('SELECT id FROM users WHERE id=?').get(target)) return deny(res, 404, '用户不存在');
    const both = prepare(`SELECT 1 FROM friends a JOIN friends b ON b.user_id=a.friend_id AND b.friend_id=a.user_id
      WHERE a.user_id=? AND a.friend_id=? AND a.status=1`).get(id.id, target);
    if (both) return okay(res, { already: true, message: '你们已是好友' });
    prepare('INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,0,?)').run(id.id, target, Date.now());
    okay(res, { sent: true, message: '已打招呼' });
  });

  console.log('[lifestyle] module batch5 loaded: /api/mini-program/* /api/nearby/* /api/shake/*');
};
