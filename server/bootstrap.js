'use strict';

// The packaged server must be relocatable.  Do not use process.cwd() here: a
// shortcut, service manager, or cloudflared may start the executable from a
// different directory.
const fs = require('fs');
const path = require('path');

const isPackaged = Boolean(process.pkg);
const rootDir = isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const downloadsDir = process.env.DOWNLOADS_DIR || path.join(rootDir, 'downloads');
const logsDir = process.env.LOG_DIR || path.join(rootDir, 'logs');

for (const directory of [dataDir, downloadsDir, logsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

// Keep the release artifacts useful on first run while allowing administrators
// to replace/delete files in the external downloads directory.  pkg assets are
// read-only in the snapshot, so only copy files that do not already exist.
const bundledDownloads = path.join(__dirname, 'downloads');
if (fs.existsSync(bundledDownloads)) {
  for (const entry of fs.readdirSync(bundledDownloads, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destination = path.join(downloadsDir, entry.name);
    if (!fs.existsSync(destination)) fs.copyFileSync(path.join(bundledDownloads, entry.name), destination);
  }
}

process.env.DATA_DIR = dataDir;
process.env.DOWNLOADS_DIR = downloadsDir;
process.env.LOG_DIR = logsDir;

require('./index');
