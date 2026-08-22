'use strict';
const path = require('path');
const fs = require('fs');

const KEY_FILE = path.join(__dirname, '.epaygw_key.json');

function loadKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    }
  } catch (e) {}
  return { key: 'securechat-mock-key', merchantId: null };
}

function saveKey(data) {
  try {
    fs.writeFileSync(KEY_FILE, JSON.stringify(data), 'utf8');
  } catch (e) { console.error('[epaygw] save key failed: ' + e.message); }
}

// Export for use in epaygw.js
module.exports = { loadKey, saveKey };
