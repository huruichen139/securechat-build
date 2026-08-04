'use strict';
// SecureChat 桌面客户端 —— WebView 壳，加载桌面端站点。支持托盘隐藏与系统通知。
const { app, BrowserWindow, shell, Menu, Tray, Notification, dialog, protocol } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');

const APP_URL = 'https://mc.32768.top:8888';

protocol.registerSchemesAsPrivileged([
  { scheme: 'securechat', privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true } }
]);

// 单一实例：再次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

function localMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' })[ext] || 'application/octet-stream';
}

function registerLocalAssets() {
  protocol.handle('securechat', async (request) => {
    const url = new URL(request.url);
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const root = path.join(__dirname, 'www');
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    try {
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': localMime(file) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  tray = new Tray(iconPath);

  const menu = Menu.buildFromTemplate([
    {
      label: '打开 SecureChat',
      click: () => showMain()
    },
    {
      label: '显示/隐藏窗口',
      click: () => {
        const win = getMainWindow();
        if (win) {
          if (win.isVisible() && !win.isMinimized()) win.hide();
          else showMain();
        }
      }
    },
    { type: 'separator' },
    {
      label: '检查更新',
      click: () => checkForUpdates(true)
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('SecureChat');
  tray.setContextMenu(menu);

  // Windows：单击托盘图标切换窗口
  tray.on('click', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isVisible() && !win.isMinimized() && win.isFocused()) win.hide();
      else showMain();
    }
  });
  tray.on('double-click', () => showMain());

  return tray;
}

function showMain() {
  const win = getMainWindow();
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- 自动更新检查 ----------
const VERSION_URL = APP_URL + '/api/version';

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchVersionInfo() {
  return new Promise((resolve, reject) => {
    const req = https.get(VERSION_URL, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
  });
}

function downloadInstaller(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadInstaller(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('服务器返回 ' + res.statusCode));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => { received += c.length; });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (total > 0 && received < total) reject(new Error('下载不完整'));
          else resolve(dest);
        });
      });
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
  });
}

async function checkForUpdates(manual) {
  let info;
  try {
    info = await fetchVersionInfo();
  } catch (e) {
    if (manual) dialog.showMessageBox(getMainWindow(), { type: 'error', title: '检查更新失败', message: '无法连接服务器：' + e.message });
    return;
  }
  const latest = info.latest || '';
  const current = app.getVersion();
  if (!latest) {
    if (manual) dialog.showMessageBox(getMainWindow(), { type: 'info', title: '检查更新', message: '无法获取服务器版本信息。' });
    return;
  }
  if (compareVersions(latest, current) <= 0) {
    if (manual) dialog.showMessageBox(getMainWindow(), { type: 'info', title: '检查更新', message: '当前已是最新版本（' + current + '）。' });
    return;
  }

  const notes = (info.releaseNotes || '修复若干问题，建议更新。');
  const win = getMainWindow();
  const dlUrl = `${APP_URL}/downloads/SecureChat-${latest}-windows.exe`;
  const dest = path.join(app.getPath('downloads'), `SecureChat-${latest}-windows.exe`);

  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 ${latest}（当前 ${current}），是否下载更新？`,
    detail: notes,
    buttons: ['下载并安装', '暂不更新'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return;

  const notify = new Notification({ title: 'SecureChat 更新', body: '正在下载新版本，请稍候…' });
  if (Notification.isSupported()) notify.show();

  try {
    await downloadInstaller(dlUrl, dest);
    const { response: r2 } = await dialog.showMessageBox(win, {
      type: 'info',
      title: '下载完成',
      message: `新版本安装包已下载到：\n${dest}\n点击"立即安装"将关闭当前客户端并启动安装程序。`,
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1
    });
    if (r2 === 0) {
      isQuitting = true;
      shell.openPath(dest);
      setTimeout(() => app.quit(), 500);
    }
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', title: '下载失败', message: '自动下载失败：' + e.message + '\n可前往 ' + APP_URL + '/downloads 手动下载。' });
  }
}


function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    title: 'SecureChat',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadURL('securechat://index.html');
  win.once('ready-to-show', () => win.show());

  // 关闭按钮 -> 隐藏到托盘而不是退出（托盘里有真正的"退出"）
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // 只允许站点内导航；外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 标题跟随页面
  win.webContents.on('page-title-updated', (e, title) => {
    if (title && title.trim()) win.setTitle(title.trim() + ' - SecureChat');
  });

  // 若页面加载失败（如断网），显示重试
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return; // ERR_ABORTED 忽略
    win.loadURL(APP_URL + '?offline_retry=' + Date.now());
  });

  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });

  return win;
}

// 生产走 https；开发可传 --url 指定本地调试地址
const urlArg = process.argv.find(a => a.startsWith('--url='));
if (urlArg) {
  const u = urlArg.replace('--url=', '');
  if (/^https?:\/\//.test(u)) {
    process.env.SC_APP_URL = u;
  }
}

app.whenReady().then(() => {
  // Windows 托盘/通知需要 AppUserModelID
  if (process.platform === 'win32') {
    app.setAppUserModelId('top.32768.chat');
  }

  // 允许摄像头/麦克风等媒体权限（否则 getUserMedia 直接失败："无法获取媒体"）
  const { session } = require('electron');
  const mediaPerms = ['media', 'mediaKeySystem', 'display-capture'];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(mediaPerms.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return mediaPerms.includes(permission) ||
      permission === 'clipboard-sanitized-write' ||
      permission === 'notifications';
  });

  registerLocalAssets();

  Menu.setApplicationMenu(null);
  createWindow();
  createTray();

  // 启动后静默检查更新（仅在发现新版本时提示）
  setTimeout(() => checkForUpdates(false), 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMain();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

// 托盘模式：关闭窗口后不退出，仅当从托盘"退出"才真正结束
app.on('window-all-closed', (e) => {
  // 由托盘"退出"触发 app.quit()，这里无需处理；避免默认退出用单实例锁兜底
});
