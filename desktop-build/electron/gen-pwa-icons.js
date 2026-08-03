// 生成 PWA 图标 icon-192.png 和 icon-512.png（复用 gen-icon.js 的绘制逻辑，参数化尺寸）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makeIcon(S, outPath) {
  const R = Math.round(S * 0.22);
  const px = Buffer.alloc(S * S * 4);
  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= S || y < 0 || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  function inRoundRect(x, y, x0, y0, x1, y1, rad) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= rad * rad;
  }
  function inEllipse(x, y, cx, cy, rx, ry) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  const bg = [15, 23, 42];
  const c1 = [7, 193, 96], c2 = [16, 185, 129];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inRoundRect(x, y, 8, 8, S - 8, S - 8, R)) setPixel(x, y, bg[0], bg[1], bg[2], 255);
      const inBubble = inEllipse(x, y, S * 0.5, S * 0.42, S * 0.29, S * 0.22);
      const tail = (x >= S * 0.58 && x <= S * 0.82 && y >= S * 0.58 && y <= S * 0.66 && (y - S * 0.58) <= (x - S * 0.58) * 0.9);
      if (inBubble || tail) {
        const t = y / S;
        setPixel(x, y, Math.round(c1[0] + (c2[0] - c1[0]) * t), Math.round(c1[1] + (c2[1] - c1[1]) * t), Math.round(c1[2] + (c2[2] - c1[2]) * t), 255);
      }
    }
  }
  function dot(cx, cy, rad) {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) setPixel(x, y, 255, 255, 255, 255);
  }
  dot(S * 0.33, S * 0.41, S * 0.027);
  dot(S * 0.5, S * 0.41, S * 0.027);
  dot(S * 0.67, S * 0.41, S * 0.027);

  function crc32(buf) {
    let c, table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(outPath, png);
  console.log('written:', outPath, png.length, 'bytes');
}

const iconsDir = path.join(__dirname, '..', '..', 'web', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
makeIcon(512, path.join(iconsDir, 'icon-512.png'));
makeIcon(192, path.join(iconsDir, 'icon-192.png'));