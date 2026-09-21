'use strict';
const path = require('path');
const fs = require('fs');

const KEY_FILE = path.join(__dirname, '.epaygw_key.json');

const PUB_DEFAULT = 'securechat-mock-key'; // 仓库公开常量,仅用于本地开发兜底,绝不能用于线上

function loadKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
      // 线上禁止使用公开默认密钥:该字符串在仓库里可见,用它等于网关签名形同虚设
      if (process.env.NODE_ENV === 'production' && cfg && cfg.key === PUB_DEFAULT) {
        throw new Error('[epaygw] 线上环境不能使用公开默认密钥,请生成随机密钥写入 .epaygw_key.json');
      }
      return cfg;
    }
  } catch (e) {
    if (e && /公开默认密钥/.test(e.message)) throw e;
  }
  return { key: PUB_DEFAULT, merchantId: null };
}

function saveKey(data) {
  try {
    fs.writeFileSync(KEY_FILE, JSON.stringify(data), 'utf8');
  } catch (e) { console.error('[epaygw] save key failed: ' + e.message); }
}

// Export for use in epaygw.js
module.exports = { loadKey, saveKey };
