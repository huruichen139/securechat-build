// 微型 STUN 服务器（RFC 5389 binding）：为 WebRTC 通话提供 NAT 打洞。
// 支持 UDP 3478；NAT 映射场景下客户端通过它发现公网地址。
const dgram = require('dgram');
const net = require('net');

const PORT = Number(process.env.TURN_PORT || 3478);
const COOKIE = 0x2112a442;

function xorMappedAttr(ip, port) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(0x0020, 0);       // type XOR-MAPPED-ADDRESS
  buf.writeUInt16BE(8, 2);            // length
  buf[4] = 0;                          // reserved
  buf[5] = 0x01;                       // family IPv4
  buf.writeUInt16BE(port ^ (COOKIE >>> 16), 6);
  const p = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) buf[8 + i] = p[i] ^ ((COOKIE >>> (8 * (3 - i))) & 0xff);
  return buf;
}

function handle(msg, rinfo, send) {
  if (msg.length < 20) return;
  const type = msg.readUInt16BE(0);
  if (type !== 0x0001) return; // 仅响应 binding request
  const txid = msg.slice(8, 20);
  const resp = Buffer.alloc(20);
  resp.writeUInt16BE(0x0101, 0);      // binding success response
  resp.writeUInt16BE(12, 2);          // length（仅 attr，不含 20B 头）
  resp.writeUInt32BE(COOKIE, 4);
  txid.copy(resp, 8);
  const attr = xorMappedAttr(rinfo.address, rinfo.port);
  send(Buffer.concat([resp, attr]));
}

const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => handle(msg, rinfo, (b) => udp.send(b, rinfo.port, rinfo.address)));
udp.on('error', (e) => console.error('[STUN] udp error:', e.message));
udp.bind(PORT, '0.0.0.0', () => console.log('[SecureChat] STUN UDP listening on 0.0.0.0:' + PORT));

// TCP 支持（WebRTC 的 stun: 走 UDP，这里仅供诊断）
const tcp = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 20) return;
    if (buf.readUInt16BE(0) === 0x0001) {
      const txid = buf.slice(8, 20);
      const resp = Buffer.alloc(20);
      resp.writeUInt16BE(0x0101, 0);
      resp.writeUInt16BE(12, 2);
      resp.writeUInt32BE(COOKIE, 4);
      txid.copy(resp, 8);
      const attr = xorMappedAttr(sock.remoteAddress.replace(/^::ffff:/, ''), sock.remotePort);
      sock.write(Buffer.concat([resp, attr]));
    }
    buf = Buffer.alloc(0);
  });
});
tcp.on('error', (e) => console.error('[STUN] tcp error:', e.message));
tcp.listen(PORT, '0.0.0.0', () => console.log('[SecureChat] STUN TCP listening on 0.0.0.0:' + PORT));
