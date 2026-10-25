'use strict';
// 共享 token 校验：JWT 签名 + token_version + 封禁 + 吊销表 + 设备存在性。
// 背景：routes/*.js 与 chat-ext.js 原先各自 jwt.verify，只查 token_version/banned，
// 不查 /api/logout 写入的 revoked_tokens 与 devices 表，导致退出登录/踢设备后
// 旧 token 仍能调群组、支付、红包、转发等接口（吊销机制被旁路）。
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @param {string} token   Bearer 后的 token 原文
 * @param {Function} [prepare] 可选的 db.prepare；不传时仅做 JWT 校验
 * @returns {object|null}
 */
function verify(token, prepare) {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const p = jwt.verify(String(token || ''), secret);
    if (!p || !p.id) return null;
    if (typeof prepare !== 'function') return p;
    const u = prepare('SELECT token_version, banned FROM users WHERE id=?').get(p.id);
    if (!u || u.banned) return null;
    if ((p.tv || 0) !== (u.token_version || 0)) return null;
    try {
      const rv = prepare('SELECT 1 AS x FROM revoked_tokens WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
      if (rv) return null;
    } catch (e) { /* 旧库尚未建表时忽略 */ }
    if (p.deviceId) {
      const dev = prepare('SELECT id FROM devices WHERE user_id=? AND device_id=?').get(p.id, String(p.deviceId));
      if (!dev) return null;
    }
    return p;
  } catch (e) {
    return null;
  }
}

module.exports = { verify, hash };
