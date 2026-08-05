// STUN/TURN 服务：为 WebRTC 通话提供打洞与中继。
// 说明：本机位于 NAT 后，relay 不可用；主要用作 STUN（binding 响应无需认证）。
// 若将来部署到有公网 IP 的服务器，取消注释 credentials 与 relayIps 即可启用 TURN relay。
const Turn = require('node-turn');

const server = new Turn({
  listeningPort: Number(process.env.TURN_PORT || 3478),
  listeningIps: ['0.0.0.0'],
  relayIps: [],
  authMech: 'long-term',
  credentials: { securechat: process.env.TURN_SECRET || 'securechat-turn-2026' },
  debugLevel: process.env.TURN_DEBUG || 'WARN'
});

server.start();
console.log('[SecureChat] STUN server running on 0.0.0.0:' + (process.env.TURN_PORT || 3478) + ' (UDP/TCP)');
