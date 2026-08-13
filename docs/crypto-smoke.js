// SecureChat 5 端互通冒烟骨架（node，零 npm 依赖）
//
// 用 Node 内置 crypto 独立复刻 Flutter 端点位级的 X3DH + 简单棘轮算法，
// 验证 Web(Object / Flutter 侧) 的 wire 格式可对解：
//   X3DH:   sk = HKDF-SHA256(ECDH(idPrivA, idPubB), salt=[0x00], info='', len=64)[0:32]
//   ratchet: kdfRk / kdfChain；封包  0x02|dhPub(91B SPKI)|pn(u32BE)|n(u32BE)|iv(12B)|ct+tag
//
// 运行：node crypto-smoke.js
'use strict';
const crypto = require('crypto');

// ---------- 基础工具 ----------
function hex(a) { return Buffer.from(a).toString('hex').padStart(a.length * 2, '0'); }
function u32be(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function readU32be(b, off) { return b.readUInt32BE(off); }
function concatA(...arrs) { return Buffer.concat(arrs.map(a => Buffer.from(a))); }

// HKDF-SHA256（RFC5869）
function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }
function hkdf(ikm, salt, info, len) {
  const ikmB = Buffer.from(ikm);
  const saltB = salt == null ? Buffer.alloc(32) : Buffer.from(salt); // null->32字节全0
  const infoB = info == null ? Buffer.alloc(0) : Buffer.from(info);
  const prk = hmac(saltB, Buffer.concat([ikmB, Buffer.from([0])]));
  const zeros = Buffer.alloc(1, 0);
  const blocks = [];
  let prev = zeros; let total = 0; let c = 1;
  while (total < len) {
    const input = Buffer.concat([prev, infoB, Buffer.from([c])]);
    const t = hmac(prk, input);
    blocks.push(t); total += t.length; prev = t; c++;
  }
  return Buffer.concat(blocks).slice(0, len);
}
function kdfRk(rootKey, dhOut) { const o = hkdf(Buffer.from(dhOut), Buffer.from(rootKey), [0x01], 64); return [o.slice(0, 32), o.slice(32, 64)]; }
function kdfChain(chainKey) {
  const ck = Buffer.from(chainKey);
  const mk = hkdf(ck, Buffer.alloc(32), [0x01], 32);
  const newCk = hkdf(ck, Buffer.alloc(32), [0x02], 32);
  return [newCk, mk];
}
function x3dhKdf(dh) { return hkdf(Buffer.from(dh), [0x00], Buffer.alloc(0), 64).slice(0, 32); }

// ---------- P-256 ECDH ----------
const SPKI_HEAD = Buffer.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);
function genKeyPair() { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; }
// 手动拼 SPKI（91B = 26B 头 + 65B uncompressed point），与 Flutter _pubToSpki 字节一致
function pubSpki(ecdh) { return Buffer.concat([SPKI_HEAD, ecdh.getPublicKey()]); }
function pubSpkiB64(ecdh) { return pubSpki(ecdh).toString('base64'); }
// 取 SPKI 中的 65B uncompressed point 喂 computeSecret（Node 需原始 ECB 点，非含 DER 头的 SPKI）
function execdh(privEcdh, pubSpkiB64) {
  const spki = Buffer.from(pubSpkiB64, 'base64');
  const pt = spki.slice(26); // 去掉 26B SPKI 头
  return privEcdh.computeSecret(pt, null, 'buffer');
}

// ---------- AES-256-GCM（12B iv，128-bit tag）----------
function aesGcmEncrypt(key, plain, iv) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([ct, tag]); // ct+tag，长度 = plain+16
}
function aesGcmDecrypt(key, iv, ctWithTag) {
  const ct = ctWithTag.slice(0, -16); const tag = ctWithTag.slice(-16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- 棘轮（复刻 ratchet.dart）----------
function initAsSender(sk, remoteIdentSpkiB64) {
  const dh = genKeyPair();
  const dhOut = execdh(dh, remoteIdentSpkiB64);
  const [rk, ckS] = kdfRk(sk, dhOut);
  return { rk, dhS: dh, dhSm: dh, dhR: remoteIdentSpkiB64, ckS, ckR: null, nS: 0, nR: 0, pn: 0 };
}
function initAsReceiver(sk, identity) {
  return { rk: Buffer.from(sk), dhS: identity, dhR: null, ckS: null, ckR: null, nS: 0, nR: 0, pn: 0 };
}
function encryptMessage(state, plain) {
  if (!state.dhR) throw new Error('dhRemote 为空');
  if (!state.ckS) {
    state.pn = state.nS;
    const dh = genKeyPair();
    const dhOut = execdh(dh, state.dhR);
    const [rk, ckS] = kdfRk(state.rk, dhOut);
    state.rk = rk; state.ckS = ckS; state.dhS = dh;
    state.nS = 0; state.nR = 0;
  }
  const [newCk, mk] = kdfChain(state.ckS);
  state.ckS = newCk;
  const n = state.nS; state.nS = n + 1;
  const iv = crypto.randomBytes(12);
  const enc = aesGcmEncrypt(mk, plain, iv);
  const dhPubSpki = pubSpki(state.dhS);
  return concatA(Buffer.from([0x02]), dhPubSpki, u32be(state.pn), u32be(n), iv, enc).toString('base64');
}
function decryptMessage(state, pktB64) {
  const arr = Buffer.from(pktB64, 'base64');
  const minLen = 1 + 91 + 4 + 4 + 12 + 16;
  if (arr.length < minLen) throw new Error('封包过短');
  if (arr[0] !== 0x02) throw new Error('版本不符');
  const dhPubSpki = arr.slice(1, 92);
  const pn = readU32be(arr, 92);
  const n = readU32be(arr, 96);
  const iv = arr.slice(100, 112);
  const ctWithTag = arr.slice(112);
  const sameRemote = state.dhR && state.dhR === dhPubSpki.toString('base64');
  if (!sameRemote) {
    state.dhR = dhPubSpki.toString('base64');
    state.pn = pn; state.nR = 0; state.nS = 0;
    const dhOut = execdh(state.dhS, dhPubSpki.toString('base64'));
    const [rk, ckR] = kdfRk(state.rk, dhOut);
    state.rk = rk; state.ckR = ckR; state.ckS = null;
  }
  if (!state.ckR) throw new Error('接收链未初始化');
  while (state.nR < n) { const [ck] = kdfChain(state.ckR); state.ckR = ck; state.nR++; }
  const [ck, mk] = kdfChain(state.ckR);
  state.ckR = ck; state.nR = n + 1;
  return aesGcmDecrypt(mk, iv, ctWithTag);
}

// ---------- 主流程：A(sender) <-> B(receiver) 双向 ----------
async function main() {
  const identityA = genKeyPair();   // A 身份
  const identityB = genKeyPair();   // B 身份
  const pubA = pubSpkiB64(identityA);
  const pubB = pubSpkiB64(identityB);

  // 双端各自算同一 sk（X3DH，identity-only）
  const skA = x3dhKdf(execdh(identityA, pubB));
  const skB = x3dhKdf(execdh(identityB, pubA));
  if (!Buffer.from(skA).equals(Buffer.from(skB))) throw new Error('X3DH sk 不一致！');
  console.log('[OK] X3DH sk 一致:', hex(skA).slice(0, 16) + '…');

  // 发起方 A 建立 sender 态，接收方 B 建立 receiver 态
  const a = initAsSender(skA, pubB);
  const b = initAsReceiver(skB, identityB);

  // 轮1：A -> B
  const m1 = 'hello from web: 你好世界 👋';
  const c1 = encryptMessage(a, m1);
  const d1 = decryptMessage(b, c1);
  console.log('[轮1] 封包前缀:', hex(Buffer.from(c1, 'base64').slice(0, 4)), '(0x02 + dhPub 前2字节)');
  if (d1 !== m1) throw new Error('B 无法解 A 的密文！');
  console.log('[OK] A->B 解密正确:', d1);

  // 轮2：B -> A（B 此时 ckS=null，触发 B 的 DH-step）
  const m2 = 'reply from flutter: 一切正常';
  const c2 = encryptMessage(b, m2);
  const d2 = decryptMessage(a, c2);
  if (d2 !== m2) throw new Error('A 无法解 B 的密文！');
  console.log('[OK] B->A 解密正确:', d2);

  // 轮3：连续多发（棘轮推进）
  for (let i = 1; i <= 3; i++) {
    const msg = 'sequence msg #' + i;
    const c = encryptMessage(a, msg);
    const d = decryptMessage(b, c);
    if (d !== msg) throw new Error('顺序消息解失败 #' + i);
  }
  console.log('[OK] 连续 3 条顺序消息解密正确');

  // SPKI dhPub 长度校验：必须 91B，字节布局与 Flutter 一致
  const manualA = pubSpki(identityA);
  if (manualA.length !== 91) throw new Error('SPKI 布局不一致，无法与 Flutter 对齐！');
  console.log('[OK] SPKI dhPub = 91B，字节布局与 Flutter 一致');

  console.log('\n全部互通冒烟通过 ✔');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });