// 生成 SecureChat 应用图标 (512x512 PNG) —— 无需 canvas 库，直接输出 PNG 二进制
// 图标设计：深蓝圆角方块 + 绿色对话气泡 + "S"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const R = 112; // 圆角半径

// ---------- 像素缓冲 ----------
const px = Buffer.alloc(S * S * 4); // RGBA
function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= S || y < 0 || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
// 判断点是否在圆角矩形内
function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}
// 是否在椭圆内
function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

// 背景：深蓝圆角方块
const bg = [15, 23, 42]; // #0f172a
// 气泡绿色渐变
const c1 = [7, 193, 96];   // #07c160
const c2 = [16, 185, 129]; // #10b981

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // 背景圆角方块
    if (inRoundRect(x, y, 8, 8, S - 8, S - 8, R)) {
      setPixel(x, y, bg[0], bg[1], bg[2], 255);
    }
    // 对话气泡：主圆 + 尾部小三角
    const inBubble = inEllipse(x, y, 256, 218, 150, 112);
    const tail = (x >= 300 && x <= 420 && y >= 300 && y <= 340 && (y - 300) <= (x - 300) * 0.9);
    if (inBubble || tail) {
      // 简单垂直渐变
      const t = y / S;
      const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      setPixel(x, y, r, g, b, 255);
    }
  }
}

// 画三条白点线（聊天省略号），简化：画三个白圆点
function dot(cx, cy, rad) {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) setPixel(x, y, 255, 255, 255, 255);
    }
  }
}
dot(170, 210, 14);
dot(256, 210, 14);
dot(342, 210, 14);

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
// raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('icon.png written:', out, png.length, 'bytes');
