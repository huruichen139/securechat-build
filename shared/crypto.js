'use strict';
const crypto = require('crypto');

// AES-256-GCM 对称加密，密钥由客户端与服务端共享
// 实际部署应通过环境变量或配置注入，这里用固定密钥示例
const KEY_HEX = process.env.CHAT_KEY || 'a3f5c1e09b7d4f2e8a1c3b5d7e9f0a2c4b6d8e0f2a4c6d8e0b2d4f6a8c0e2b4d6';

function getKey() {
  return Buffer.from(KEY_HEX, 'hex');
}

// 加密明文 -> 返回 base64 字符串（含 iv + 密文 + tag）
function encrypt(plain) {
  if (plain === undefined || plain === null) return '';
  const str = typeof plain === 'string' ? plain : JSON.stringify(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  let enc = cipher.update(str, 'utf8', 'base64');
  enc += cipher.final('base64');
  const tag = cipher.getAuthTag();
  // 拼接 iv(12) + tag(16) + 密文
  const blob = Buffer.concat([iv, tag, Buffer.from(enc, 'base64')]);
  return blob.toString('base64');
}

// 解密 base64 字符串 -> 明文
function decrypt(b64) {
  if (!b64) return '';
  try {
    const blob = Buffer.from(b64, 'base64');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(enc, undefined, 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    return '';
  }
}

module.exports = { encrypt, decrypt, getKey };
