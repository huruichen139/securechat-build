const initSqlJs = require('sql.js');
const fs = require('fs');
const path = 'D:/chat/data/chat.sqlite';
(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path);
  const db = new SQL.Database(buf);
  const row = db.exec("SELECT value FROM settings WHERE key='epay_config'");
  console.log('Current:', row.length > 0 ? row[0].values[0][0] : 'NOT SET');
  const cfg = JSON.stringify({enabled:true, baseUrl:'https://pay.qqxeg.cn', gatewayUrl:'https://pay.qqxeg.cn/xpay/epay/submit.php', gatewayId:'', merchantPid:'10060', key:'1Y2ckaVXiYuQLKteg0IM', notifyUrl:'https://mc.32768.top:8888/api/wallet/recharge/notify', returnUrl:'https://mc.32768.top:8888/wallet-pay.html'});
  db.run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", ['epay_config', cfg, Date.now()]);
  const data = db.export();
  fs.writeFileSync(path, Buffer.from(data));
  const row2 = db.exec("SELECT value FROM settings WHERE key='epay_config'");
  console.log('Updated:', row2[0].values[0][0]);
  db.close();
})();
