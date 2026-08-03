'use strict';
// SecureChat 桌面客户端 —— WebView 壳，加载桌面端站点。
const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');

const APP_URL = 'https://mc.32768.top:8888';

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadURL(APP_URL);

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
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
