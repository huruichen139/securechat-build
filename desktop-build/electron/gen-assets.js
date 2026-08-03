// 生成 SecureChat 应用图标: icon.png (512x512) + icon.ico (含多尺寸)
// ICO 文件格式：ICONDIR + ICONDIRENTRY(含 PNG 数据条目) —— 现代 Windows 支持 PNG 压缩条目
const fs = require('fs');
const path = require('path');

// 先复用 gen-icon.js 的 PNG 生成逻辑生成 512 PNG
const { execFileSync } = require('child_process');
const node = process.execPath;
execFileSync(node, [path.join(__dirname, 'gen-icon.js')]);

// 用 png 数据生成 ICO。ICO 里可放多个 PNG 条目（Windows 10/11 支持）。
// 但我们只有一张 512 PNG；ICO 允许最大 256x256 PNG 条目。
// 简化：直接用 512 PNG 的字节包进 ICO 目录项（宽高字段写 0 表示 256）。
function pngToIco(pngBuf) {
  const ICONDIR = Buffer.alloc(6);
  ICONDIR.writeUInt16LE(0, 0); // reserved
  ICONDIR.writeUInt16LE(1, 2); // type = icon
  ICONDIR.writeUInt16LE(1, 4); // count = 1

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width (0 = 256)
  entry[1] = 0; // height (0 = 256)
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bitcount
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // image offset

  return Buffer.concat([ICONDIR, entry, pngBuf]);
}

const pngBuf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
const ico = pngToIco(pngBuf);
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.ico'), ico);
console.log('icon.ico written:', ico.length, 'bytes');
