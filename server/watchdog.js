// SecureChat server watchdog (node) - restarts the server if it goes down.
// Reliable on Windows: node itself persists when spawned detached with stdio ignore.
const { spawn, execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname);
const LOG_DIR = 'D:\\chat\\data';
const PORT = 8888;
const INTERVAL = 10 * 1000;

// 单实例锁：防止多个 watchdog 同时拉起服务器造成 EADDRINUSE 风暴
const LOCK_FILE = path.join(LOG_DIR, 'watchdog.lock');
try {
  if (fs.existsSync(LOCK_FILE)) {
    const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (Number.isInteger(prev)) {
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch (e) { alive = false; }
      if (alive && prev !== process.pid) {
        console.log('[watchdog] another instance running (pid ' + prev + '), exit.');
        process.exit(0);
      }
    }
  }
} catch (e) {}
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch (e) {} });

function log(msg) {
  const line = '[watchdog ' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, 'watchdog.log'), line + '\n', 'utf8'); } catch (e) {}
}

function testOnline() {
  return new Promise((resolve) => {
    const req = https.get({ hostname: '127.0.0.1', port: PORT, path: '/api/version', timeout: 5000, rejectUnauthorized: false }, (res) => {
      res.resume();
      // 200=就绪；503=服务初始化中（进程活着，但不能当 offline 误杀重启）
      resolve(res.statusCode === 200 || res.statusCode === 503);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 杀掉所有 index.js 残留进程（防 EADDRINUSE：旧服务器未退出时新进程绑端口失败）
// 仅当 watchdog 已确认 server offline 时才调用。
// Windows 新版已移除 wmic，改用 PowerShell CIM（实测验证可取回命令行匹配的 PID）
function killStaleServer() {
  let pids = [];
  try {
    const out = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'kill_stale.ps1') + '"', { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    pids = String(out).split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
  } catch (e) { /* 查询失败则按无残留处理 */ }
  const selfPid = String(process.pid);
  let killed = 0;
  for (const pid of pids) {
    if (pid === selfPid) continue;
    try { process.kill(parseInt(pid, 10), 'SIGTERM'); killed++; log('killed stale server pid ' + pid); } catch (e) {}
  }
  if (killed > 0) {
    // 给旧进程时间释放端口再接续（用真实定时器避免忙等）
    const deadline = Date.now() + 3000;
    (function wait(){ if (Date.now() < deadline) { execSync('ping -n 1 127.0.0.1 >nul', { windowsHide: true }); wait(); } })();
  }
}

function bootServer() {
  killStaleServer();
  try {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const out = fs.openSync(path.join(LOG_DIR, 'server_' + ts + '.out.log'), 'a');
    const err = fs.openSync(path.join(LOG_DIR, 'server_' + ts + '.err.log'), 'a');
    const child = spawn(process.execPath, ['index.js'], {
      cwd: SERVER_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    });
    child.unref();
    log('server started (pid ' + child.pid + ', logs: ' + ts + ')');
  } catch (e) {
    log('restart failed: ' + (e && e.message || e));
  }
}

let lastBoot = 0;
let startPass = 0;

async function main() {
  log('watchdog started, checks every ' + (INTERVAL / 1000) + 's');
  // 启动探活：服务器可能刚 bind 完还在初始化，给足耐心，不要一探失败就强杀重启
  let online = await testOnline();
  for (let i = 0; i < 5 && !online; i++) {
    log('startup probe ' + (i + 1) + '/5 offline, wait ' + (INTERVAL / 1000) + 's');
    await new Promise(r => setTimeout(r, INTERVAL));
    online = await testOnline();
  }
  if (!online) { startPass = Date.now(); bootServer(); }
  startPass = Date.now();
  setInterval(async () => {
    const onlineNow = await testOnline();
    if (onlineNow) { lastBoot = 0; return; }
    const now = Date.now();
    if (now - startPass < 60000) { log('within startup grace, skip'); return; }
    if (now - lastBoot < 30000) { log('boot throttled, skip'); return; }
    log('server offline, restarting...');
    lastBoot = now;
    bootServer();
  }, INTERVAL);
}

main();
