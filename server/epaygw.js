'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const QRCode = require('qrcode');

const GATEWAY_KEY = 'securechat-mock-key';
const ORDERS_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'epaygw_orders.json');

let orders = new Map();

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      for (const k of Object.keys(obj)) orders.set(k, obj[k]);
    }
  } catch (e) { console.error('[epaygw] load orders failed: ' + (e && e.message || e)); }
}

function saveOrders() {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(Object.fromEntries(orders), null, 0), 'utf8');
  } catch (e) { console.error('[epaygw] save orders failed: ' + (e && e.message || e)); }
}

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex').toUpperCase(); }

function signOf(params, key) {
  const arr = {};
  for (const k of Object.keys(params).sort()) {
    if (k === 'sign' || k === 'sign_type') continue;
    arr[k] = params[k];
  }
  const keys = Object.keys(arr);
  const qs = keys.map(k => k + '=' + arr[k]).join('&');
  const qsEnc = keys.map(k => k + '=' + encodeURIComponent(arr[k])).join('&');
  const concat = keys.map(k => arr[k]).join('');
  const concatEnc = keys.map(k => encodeURIComponent(arr[k])).join('');
  return [qs, qsEnc, concat, concatEnc].map(s => md5(s + key));
}

function verifySign(params, sign) {
  if (!sign) return true;
  const want = String(sign).toUpperCase();
  return signOf(params, GATEWAY_KEY).indexOf(want) >= 0;
}

function moneyFmt(v) {
  const n = Number(v);
  if (isNaN(n) || n < 0) return '0.00';
  return n.toFixed(2);
}

function createOrder(p) {
  const outTradeNo = String(p.out_trade_no || '').slice(0, 64);
  const now = Date.now();
  const order = {
    pid: String(p.pid || ''),
    out_trade_no: outTradeNo,
    trade_no: 'EP' + now + Math.floor(Math.random() * 1000),
    type: String(p.type || 'alipay'),
    name: String(p.name || '').slice(0, 64),
    money: moneyFmt(p.money),
    notify_url: String(p.notify_url || '').slice(0, 512),
    return_url: String(p.return_url || '').slice(0, 512),
    status: 'WAIT_BUYER_PAY',
    created_at: now,
    paid_at: 0
  };
  orders.set(outTradeNo, order);
  saveOrders();
  return order;
}

function orderResult(o) {
  return {
    code: 1,
    msg: '查询订单号成功',
    trade_no: o.trade_no,
    out_trade_no: o.out_trade_no,
    type: o.type,
    name: o.name,
    money: o.money,
    trade_status: o.status
  };
}

function notifyMerchant(o) {
  if (!o || !o.notify_url) return;
  const params = {
    pid: o.pid,
    trade_no: o.trade_no,
    out_trade_no: o.out_trade_no,
    type: o.type,
    name: o.name,
    money: o.money,
    trade_status: 'TRADE_SUCCESS'
  };
  const body = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&') + '&sign=' + signOf(params, GATEWAY_KEY)[0] + '&sign_type=MD5';
  const lib = /^https:/i.test(o.notify_url) ? https : http;
  const req = lib.request(o.notify_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => { console.log('[epaygw] notify ' + o.out_trade_no + ' -> ' + (res.statusCode || 0) + ' ' + String(data).slice(0, 120)); });
  });
  req.on('error', e => { console.error('[epaygw] notify failed: ' + (e && e.message || e)); });
  req.setTimeout(10000, () => { try { req.destroy(); } catch (e) {} });
  req.write(body);
  req.end();
}

function cashierHtml(o, baseUrl) {
  const qrSrc = baseUrl + '/epaygw/qrcode/' + encodeURIComponent(o.out_trade_no);
  const webCashier = baseUrl + '/api/pay/gateway/epay/cashier?order=' + encodeURIComponent(o.out_trade_no);
  const deepLink = 'securechat://gateway/pay?order=' + encodeURIComponent(o.out_trade_no);
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SecureChat 收银台</title></head>' +
    '<body style="font-family:system-ui,sans-serif;background:#f2f3f5;margin:0;padding:0;display:flex;justify-content:center;align-items:center;min-height:100vh">' +
    '<div style="background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:32px;max-width:400px;width:100%;box-sizing:border-box;text-align:center">' +
    '<div style="font-size:18px;font-weight:600;color:#222">SecureChat 收银台</div>' +
    '<div style="font-size:13px;color:#999;margin:6px 0 18px">订单金额将从 SecureChat 钱包扣除</div>' +
    '<div style="border:1px dashed #e0e0e0;border-radius:12px;padding:16px;margin:0 0 18px">' +
    '<div style="display:flex;justify-content:space-between;font-size:13px;color:#666;padding:3px 0"><span>商户订单号</span><b style="color:#222">' + o.out_trade_no + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:13px;color:#666;padding:3px 0"><span>商品</span><b style="color:#222">' + o.name + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:13px;color:#666;padding:3px 0"><span>支付方式</span><b style="color:#222">' + o.type + '</b></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:13px;color:#666;padding:3px 0"><span>金额</span><b style="color:#e4393c;font-size:18px">¥' + o.money + '</b></div>' +
    '</div>' +
    '<div style="font-size:14px;font-weight:600;color:#222;margin:0 0 10px">选择支付方式（均需确认）</div>' +
    '<div style="border:1px solid #eee;border-radius:12px;padding:14px;margin:0 0 12px;text-align:center">' +
    '<img src="' + qrSrc + '" alt="qrcode" style="width:160px;height:160px;border:1px solid #eee;border-radius:8px">' +
    '<div style="font-size:12px;color:#666;margin:8px 0 2px"><b>扫码扣款</b></div>' +
    '<div style="font-size:12px;color:#999">用 SecureChat 客户端扫码，确认后扣款</div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    '<a href="' + webCashier + '" style="background:#1989fa;color:#fff;border:0;border-radius:10px;padding:12px 0;font-size:14px;text-decoration:none;cursor:pointer">网页端授权扣款</a>' +
    '<a href="' + deepLink + '" style="background:#07c160;color:#fff;border:0;border-radius:10px;padding:12px 0;font-size:14px;text-decoration:none;cursor:pointer">本地客户端直接扣款</a>' +
    '</div></div></body></html>';
}

function qrSvg(o) {
  const seed = md5(o.out_trade_no);
  let cells = '';
  const n = 25;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = seed.charCodeAt((x * 3 + y * 5) % seed.length);
      const on = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7) ? true : (c + x + y) % 3 !== 0;
      if (on && !(x >= 8 && y >= 8 && x < 10 && y < 10)) cells += '<rect x="' + (x * 8) + '" y="' + (y * 8) + '" width="7" height="7" fill="#000"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">' + cells +
    '<rect x="64" y="64" width="72" height="72" fill="#fff"/>' +
    '<path d="M84 100 l12 12 l24 -24" stroke="#07c160" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
}

function walletPay(db, payerUsername, amount, orderNo) {
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(payerUsername);
  if (!user) return { error: '扣款账号不存在（SecureChat 用户 ' + payerUsername + '）' };
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(user.id);
  const balance = w ? Number(w.balance) : 0;
  if (balance < amount) return { error: 'SecureChat 钱包余额不足（当前 ¥' + balance.toFixed(2) + '）' };
  db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=?').run(amount, user.id);
  db.prepare('INSERT INTO pay_bills(user_id,kind,category,amount,peer_id,title,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(user.id, 'out', 'epaygw', amount, 0, 'NewAPI 充值 ' + orderNo, 'epaygw', 0, Date.now());
  return { ok: true, payerId: user.id, balance: balance - amount };
}

function payerConfig(db) {
  const cfg = { payerUsername: 'andy' };
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('epaygw_config');
    if (row) Object.assign(cfg, JSON.parse(row.value || '{}'));
  } catch (e) {}
  return cfg;
}

module.exports = function (app, db, authMw) {
  loadOrders();

  function ensureGatewayMerchant() {
    try {
      const owner = db.prepare("SELECT id FROM users WHERE username='andy'").get();
      if (!owner) return null;
      const m = db.prepare("SELECT id FROM pay_merchants WHERE name='SecureChat 模拟网关' OR name='SecureChat 支付网关'").get();
      if (m) return m.id;
      const r = db.prepare('INSERT INTO pay_merchants(user_id,name,callback_url,auth_mode,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(owner.id, 'SecureChat 支付网关', '', 'local', 'approved', Date.now());
      return r.lastInsertRowid;
    } catch (e) { console.error('[epaygw] ensure merchant failed: ' + (e && e.message || e)); return null; }
  }
  const GATEWAY_MERCHANT_ID = ensureGatewayMerchant();

  function syncSecurechatOrder(outTradeNo) {
    try {
      const sc = db.prepare('SELECT status FROM pay_orders WHERE order_no=?').get(outTradeNo);
      const o = orders.get(outTradeNo);
      if (sc && o && o.status !== 'TRADE_SUCCESS' && sc.status === 'paid') {
        o.status = 'TRADE_SUCCESS';
        o.paid_at = Date.now();
        saveOrders();
        notifyMerchant(o);
        console.log('[epaygw] confirmed via SecureChat: ' + outTradeNo);
      }
    } catch (e) { console.error('[epaygw] sync failed: ' + (e && e.message || e)); }
  }

  app.all('/epaygw/mockpay', (req, res) => {
    const outTradeNo = String((req.query && req.query.out_trade_no) || (req.body && req.body.out_trade_no) || '');
    const o = orders.get(outTradeNo);
    if (!o) return res.status(404).send('订单不存在');
    syncSecurechatOrder(outTradeNo);
    const page = (inner) => '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
      '<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f2f3f5">' +
      '<div style="background:#fff;border-radius:16px;padding:32px;text-align:center;max-width:340px;width:100%;box-sizing:border-box">' + inner + '</div></body></html>';
    if (o.status !== 'TRADE_SUCCESS') {
      return res.type('text/html; charset=utf-8').send(page(
        '<div style="font-size:40px">⏳</div><div style="font-size:16px;font-weight:600;margin:10px 0 4px">尚未确认支付</div>' +
        '<div style="font-size:13px;color:#999;margin-bottom:16px">请使用扫码扣款 / 网页端授权扣款 / 本地客户端直接扣款完成确认后再查看结果</div>' +
        '<a href="javascript:history.back()" style="display:block;background:#07c160;color:#fff;border-radius:8px;padding:12px 0;font-size:14px;text-decoration:none">返回收银台</a>'));
    }
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=' + o.return_url + '"></head>' +
      '<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f2f3f5"><div style="background:#fff;border-radius:16px;padding:32px;text-align:center">' +
      '<div style="font-size:40px">✅</div><div style="font-size:16px;font-weight:600;margin:10px 0 4px">支付成功</div>' +
      '<div style="font-size:13px;color:#999">SecureChat 钱包已确认扣款 ¥' + o.money + '，正在跳转回商户…</div></div></body></html>';
    res.type('text/html; charset=utf-8').send(html);
  });

  app.get('/epaygw/qrcode/:out', async (req, res) => {
    const o = orders.get(String(req.params.out || ''));
    const text = 'securechat://gateway/pay?order=' + encodeURIComponent((o && o.out_trade_no) || req.params.out);
    try {
      const buf = await QRCode.toBuffer(text, { type: 'png', width: 200, margin: 1 });
      res.type('image/png').send(buf);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  app.all('/epaygw/api.php', (req, res) => {
    const p = Object.assign({}, req.query || {}, req.body || {});
    const act = String(p.act || '');
    if (act === 'order') {
      const o = orders.get(String(p.out_trade_no || ''));
      if (o) {
        syncSecurechatOrder(o.out_trade_no);
        return res.json(orderResult(o));
      }
      return res.json({ code: 0, msg: '查询订单号不存在' });
    }
    res.json({ code: 0, msg: '未知接口 act=' + act });
  });

  async function renderCashier(req, res, p) {
    const o = createOrder(p);
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const base = proto + '://' + req.get('host');
    try {
      const sc = db.prepare('SELECT id FROM pay_orders WHERE order_no=?').get(o.out_trade_no);
      if (!sc && GATEWAY_MERCHANT_ID) {
        db.prepare('INSERT INTO pay_orders(order_no,merchant_id,amount,subject,status,callback_url,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(o.out_trade_no, GATEWAY_MERCHANT_ID, Number(o.money), o.name, 'pending', o.notify_url, Date.now(), Date.now() + 30 * 60 * 1000);
        if (typeof db.persist === 'function') db.persist();
      }
    } catch (e) { console.error('[epaygw] insert sc order failed: ' + (e && e.message || e)); }
    res.type('text/html; charset=utf-8').send(cashierHtml(o, base));
  }

  app.all('/epaygw/submit.php', (req, res) => {
    const p = Object.assign({}, req.query || {}, req.body || {});
    if (!verifySign(p, p.sign)) {
      return res.status(400).type('text/html; charset=utf-8').send('<html><body>签名校验失败</body></html>');
    }
    return renderCashier(req, res, p);
  });

  app.all('/epaygw/pay.php', (req, res) => {
    const p = Object.assign({}, req.query || {}, req.body || {});
    if (!verifySign(p, p.sign)) return res.status(400).send('签名校验失败');
    return renderCashier(req, res, p);
  });
};
