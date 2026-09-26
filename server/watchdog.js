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

// 杀掉占用 8888 的残留 node 进程（防 EADDRINUSE：旧服务器未退出时新进程绑端口失败）
function killStaleServer() {
  try {
    const out = childProcess.execSync(
      'netstat -ano | findstr ":8888" | findstr "LISTENING"',
      { windowsHide: true, timeout: 5000 }
    ).toString();
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    pids.delete(String(process.pid));
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); log('killed stale server pid ' + pid); } catch (e) {}
    }
    if (pids.size > 0) {
      // 给旧进程一点时间释放端口
      const start = Date.now();
      while (Date.now() - start < 1500) {}
    }
  } catch (e) { /* 无监听则跳过 */ }
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

async function main() {
  log('watchdog started, checks every ' + (INTERVAL / 1000) + 's');
  if (!(await testOnline())) bootServer();
  setInterval(async () => {
    const online = await testOnline();
    if (!online) {
      const now = Date.now();
      if (now - lastBoot < 20000) { log('boot throttled, skip'); return; }
      log('server offline, restarting...');
      lastBoot = now;
      bootServer();
    }
  }, INTERVAL);
}

main();
