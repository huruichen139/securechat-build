// SecureChat Web E2EE：复刻 Flutter 端 x3dh.dart + ratchet.dart 的 wire 协议，
// 使 Web 端与 Flutter 端（以及多端）可互解/互发 0x02 封包的双棘轮密文。
//
// Wire 格式（base64，严格与 Flutter encryptMessage 一致）：
//   version(1B = 0x02) | dhPub(91B SPKI, P-256) | pn(uint32 BE) | n(uint32 BE) | iv(12B) | ct+tag(16B)
//
// 密钥派生（与 Flutter 完全一致）：
//   X3DH:   sk = HKDF-SHA256(ECDH(myIdentPriv, peerIdentPub), salt=[0x00], info=kosong)[0:32]
//   _kdfRk: (newRK, CK) = HKDF-SHA256(ikm=dhOut, salt=rootKey, info=[0x01], len=64)
//   _kdfChain: (newCK, MK) 由 chainKey 派生（salt=空, info=[0x01]/[0x02]）
//   AES-256-GCM：12B iv，128-bit tag（GCM 默认 tag 长度）
(function () {
  'use strict';
  const STORE_PRIV = 'sc_e2ee_priv';   // 身份私钥 JWK
  const STORE_PUB = 'sc_e2ee_pub';     // 身份公钥 SPKI base64
  const SESSION_PREFIX = 'sc_ratchet_'; // 每 peer 会话状态
  const SK_PREFIX = 'sc_ratchet_sk_';   // 每 peer E2E sk (hex)

  // ---------- base64 / buffer 工具 ----------
  function bufToB64(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToBuf(b) {
    const bin = atob(b);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  function b64ToArr(b) { return new Uint8Array(b64ToBuf(b)); }
  function arrB64(arr) { return bufToB64(arr.buffer); }
  function hex(a) { return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join(''); }
  function strToBytes(s) { return new TextEncoder().encode(s); }
  function bytesToStr(b) { return new TextDecoder().decode(b); }
  function concatA(...arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  function u32be(v) { return Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function readU32be(b, off) { return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0; }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------- HKDF-SHA256 (WebCrypto deriveBits) ----------
  // pointycastle 的 HKDF：salt == null 时内部用 32 字节全 0；传入短盐（如 x3dh 的 [0x00]）按原样使用。
  async function hkdf(ikm, salt, info, len) {
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
    return new Uint8Array(bits);
  }
  // _kdfRk: (newRK 32B, CK 32B)
  async function kdfRk(rootKey, dhOut) {
    const out = await hkdf(dhOut, rootKey, Uint8Array.from([0x01]), 64);
    return [out.slice(0, 32), out.slice(32, 64)];
  }
  // _kdfChain: (newCK 32B, MK 32B)
  async function kdfChain(chainKey) {
    const salt = new Uint8Array(32); // 空盐 == 32B 全 0（对齐 Flutter null salt）
    const mk = await hkdf(chainKey, salt, Uint8Array.from([0x01]), 32);
    const newCk = await hkdf(chainKey, salt, Uint8Array.from([0x02]), 32);
    return [newCk, mk];
  }
  // x3dhKdf: sk = HKDF(dh, salt=[0x00], info=kosong, len=64)[0:32]
  async function x3dhKdf(dhBytes) {
    const out = await hkdf(dhBytes, Uint8Array.from([0x00]), new Uint8Array(0), 64);
    return out.slice(0, 32);
  }

  // ---------- ECDH (P-256) ----------
  async function ecdhShare(myPrivJwk, peerPubSpkiB64) {
    const priv = await crypto.subtle.importKey(
      'jwk', myPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const peerPub = await crypto.subtle.importKey(
      'spki', b64ToBuf(peerPubSpkiB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPub }, priv, 256);
    return new Uint8Array(bits); // 32B x 坐标，对齐 Flutter ecdhShare
  }

  async function genEcKeyPair() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pubSpki = await crypto.subtle.exportKey('spki', kp.publicKey);
    return { privJwk, pubSpki: arrB64(new Uint8Array(pubSpki)) };
  }

  // ---------- AES-256-GCM ----------
  async function aesGcmEncrypt(key, plain, iv) {
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, plain);
    return new Uint8Array(enc); // ct + 16B tag
  }
  async function aesGcmDecrypt(key, iv, ctWithTag) {
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, ck, ctWithTag);
    return new Uint8Array(pt);
  }

  // ============================================================
  // 身份密钥对（与旧版一致，存 localStorage）
  // ============================================================
  async function getOrCreateIdentity() {
    let privJwk = null, pubB64 = '';
    try { privJwk = JSON.parse(localStorage.getItem(STORE_PRIV) || 'null'); } catch { privJwk = null; }
    pubB64 = localStorage.getItem(STORE_PUB) || '';
    if (!privJwk || !pubB64) {
      const kp = await genEcKeyPair();
      privJwk = kp.privJwk; pubB64 = kp.pubSpki;
      localStorage.setItem(STORE_PRIV, JSON.stringify(privJwk));
      localStorage.setItem(STORE_PUB, pubB64);
    }
    return { privJwk, pubB64 };
  }

  // ============================================================
  // 会话状态（对齐 RatchetState.toJson/fromJson）
  // ============================================================
  // 状态字段：rk, dhS_priv(jwk), dhS_pub(spki b64), dhR(spki b64 | null), ckS, ckR(b64|null), nS, nR, pn
  function sessionKey(peerId) { return SESSION_PREFIX + peerId; }
  function skKey(peerId) { return SK_PREFIX + peerId; }
  function loadSession(peerId) {
    try {
      const j = JSON.parse(localStorage.getItem(sessionKey(peerId)) || 'null');
      if (!j || !j.rk) return null;
      return {
        rk: b64ToArr(j.rk),
        dhS_priv: j.dhS_priv || null,
        dhS_pub: j.dhS_pub || null,
        dhR: j.dhR ? b64ToArr(j.dhR) : null,
        ckS: j.ckS ? b64ToArr(j.ckS) : null,
        ckR: j.ckR ? b64ToArr(j.ckR) : null,
        nS: j.nS | 0, nR: j.nR | 0, pn: j.pn | 0
      };
    } catch { return null; }
  }
  function saveSession(peerId, s) {
    localStorage.setItem(sessionKey(peerId), JSON.stringify({
      rk: arrB64(s.rk),
      dhS_priv: s.dhS_priv || null,
      dhS_pub: s.dhS_pub || null,
      dhR: s.dhR ? arrB64(s.dhR) : null,
      ckS: s.ckS ? arrB64(s.ckS) : null,
      ckR: s.ckR ? arrB64(s.ckR) : null,
      nS: s.nS, nR: s.nR, pn: s.pn
    }));
  }
  function loadSk(peerId) {
    const h = localStorage.getItem(skKey(peerId));
    if (!h || h.length !== 64) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function saveSk(peerId, sk) { localStorage.setItem(skKey(peerId), hex(sk)); }

  // 服务器身份公钥缓存：peerId -> SPKI base64
  let pubCache = new Map();
  function cachePub(peerId, b64) { if (peerId != null && b64) pubCache.set(String(peerId), b64); }
  async function getPeerIdentityPub(peerId) {
    const k = String(peerId);
    if (pubCache.get(k)) return pubCache.get(k);
    try {
      const res = await fetch(state.serverHost + '/api/keys/bundle/' + encodeURIComponent(k),
        { headers: { 'Authorization': 'Bearer ' + state.token } });
      if (!res.ok) return null;
      const b = await res.json();
      const idKey = b.identityKey;
      if (typeof idKey === 'string' && idKey.length > 0) return idKey;
      const spk = b.signedPreKey;
      if (spk && typeof spk.pubKey === 'string' && spk.pubKey.length > 0) return spk.pubKey;
      return null;
    } catch { return null; }
  }

  // ============================================================
  // 会话初始化（对齐 x3dhInitSender / x3dhInitReceiver）
  // ============================================================
  async function initAsSender(sk, peerIdentitySpkiB64) {
    const identity = await getOrCreateIdentity();
    // 使用身份密钥对作为 DH 密钥对，与 Flutter 端的 identity-only 模式对齐：
    // Flutter x3dhInitReceiver 用 web 的身份私钥作为 dhSelf，web 也必须用身份私钥才能解密。
    const dhOut = await ecdhShare(identity.privJwk, peerIdentitySpkiB64);
    const parts = await kdfRk(sk, dhOut);
    return {
      rk: parts[0],
      dhS_priv: identity.privJwk, dhS_pub: identity.pubB64,
      dhR: b64ToArr(peerIdentitySpkiB64),
      ckS: parts[1],
      ckR: null,
      nS: 0, nR: 0, pn: 0
    };
  }
  async function initAsReceiver(sk, identity) {
    return {
      rk: sk, dhS_priv: identity.privJwk, dhS_pub: identity.pubB64, dhR: null,
      ckS: null, ckR: null, nS: 0, nR: 0, pn: 0
    };
  }

  async function x3dhInitSender(peerId) {
    const peerPub = await getPeerIdentityPub(peerId);
    if (!peerPub) return null;
    const identity = await getOrCreateIdentity();
    const dhOut = await ecdhShare(identity.privJwk, peerPub);
    const sk = await x3dhKdf(dhOut);
    saveSk(peerId, sk);
    const s = await initAsSender(sk, peerPub);
    saveSession(peerId, s);
    return s;
  }
  async function x3dhInitReceiver(peerId) {
    const peerPub = await getPeerIdentityPub(peerId);
    if (!peerPub) return null;
    const identity = await getOrCreateIdentity();
    const dhOut = await ecdhShare(identity.privJwk, peerPub);
    const sk = await x3dhKdf(dhOut);
    saveSk(peerId, sk);
    const s = await initAsReceiver(sk, identity);
    saveSession(peerId, s);
    return s;
  }

  // ============================================================
  // 加密 / 解密（对齐 encryptMessage / decryptMessage）
  // ============================================================
  async function encryptMessage(state, plain) {
    if (!state.dhR) throw new Error('RatchetState.dhRemote 为空');
    // DH-step：用身份私钥与远端身份公钥做 ECDH（与 initAsSender 保持一致）
    if (!state.ckS) {
      state.pn = state.nS;
      const dhOut = await ecdhShare(state.dhS_priv, arrB64(state.dhR));
      const parts = await kdfRk(state.rk, dhOut);
      state.rk = parts[0];
      state.ckS = parts[1];
      state.nS = 0; state.nR = 0;
    }
    const ck = await kdfChain(state.ckS);
    state.ckS = ck[0];
    const mk = ck[1];
    const n = state.nS;
    state.nS = n + 1;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = strToBytes(plain);
    const enc = await aesGcmEncrypt(mk, pt, iv);
    const dhPubSpki = b64ToArr(state.dhS_pub);
    const pkt = concatA(Uint8Array.from([0x02]), dhPubSpki, u32be(state.pn), u32be(n), iv, enc);
    return arrB64(pkt);
  }

  async function decryptMessage(state, arr) {
    const minLen = 1 + 91 + 4 + 4 + 12 + 16;
    if (arr.length < minLen) throw new Error('封包过短');
    if (arr[0] !== 0x02) throw new Error('版本不符');
    const dhPubSpki = arr.slice(1, 92);
    const pn = readU32be(arr, 92);
    const n = readU32be(arr, 96);
    const iv = arr.slice(100, 112);
    const ctWithTag = arr.slice(112);
    // DH-step 判断
    const sameRemote = state.dhR && bytesEqual(dhPubSpki, state.dhR);
    if (!sameRemote) {
      if (!state.dhS_priv) throw new Error('无身份私钥，无法完成 DH-step');
      state.dhR = dhPubSpki;
      state.pn = pn;
      state.nR = 0; state.nS = 0;
      const dhOut = await ecdhShare(state.dhS_priv, arrB64(dhPubSpki));
      const parts = await kdfRk(state.rk, dhOut);
      state.rk = parts[0];
      state.ckR = parts[1];
      state.ckS = null; // 下次我方发送会触发新的 DH-step
    }
    if (!state.ckR) throw new Error('接收链未初始化');
    while (state.nR < n) {
      const k = await kdfChain(state.ckR);
      state.ckR = k[0];
      state.nR++;
    }
    const k = await kdfChain(state.ckR);
    state.ckR = k[0];
    const mk = k[1];
    state.nR = n + 1;
    const pt = await aesGcmDecrypt(mk, iv, ctWithTag);
    return bytesToStr(pt);
  }

  // ---------- 对外 API ----------
  window.SCE2EE = {
    // 保证当前账号有身份密钥对，并上传到服务器（幂等）。
    ensureKeyPair: async function () {
      const id = await getOrCreateIdentity();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(state.serverHost + '/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
            body: JSON.stringify({ pubkey: id.pubB64 })
          });
          if (res.ok) return id;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
      return id;
    },
    getPub: function () { return localStorage.getItem(STORE_PUB) || ''; },
    cachePeerPub: cachePub,
    _cache: {},
    // 先建立/复用会话，再加密。会话建立失败返回 null（调用方回退明文，与 Flutter e2eeEncrypt 一致）。
    async encryptFor(peerId, plain) {
      const k = String(peerId);
      let s = loadSession(k);
      if (!s) {
        s = await x3dhInitSender(k);
        if (!s) return null;
      }
      const ct = await encryptMessage(s, plain);
      saveSession(k, s);
      return ct;
    },
    // 若是 0x02 密文则解密；否则（明文/媒体占位）原样返回。
    async decryptFrom(peerId, b64) {
      if (!isRatchetCipher(b64)) return b64;
      const k = String(peerId);
      // 优先复用已有会话
      let s = loadSession(k);
      if (s) {
        try {
          const plain = await decryptMessage(s, b64ToArr(b64));
          saveSession(k, s);
          return plain;
        } catch (e) {
          // 已有会话解密失败：很可能是旧/坏会话或密钥被更换，丢弃后重建一次
        }
      }
      try {
        s = await x3dhInitReceiver(k);
        if (!s) return b64;
      } catch (e) {
        return b64;
      }
      try {
        const plain = await decryptMessage(s, b64ToArr(b64));
        saveSession(k, s);
        return plain;
      } catch (e) {
        return b64;
      }
    },
    // 显式初始化接收会话（在渲染前先建会话，避免乱序）。
    async primeReceiver(peerId) {
      const k = String(peerId);
      if (!loadSession(k)) { await x3dhInitReceiver(k); }
    },
    clearSession: function (peerId) {
      localStorage.removeItem(sessionKey(String(peerId)));
      localStorage.removeItem(skKey(String(peerId)));
    },
    isRatchetCipher
  };

  function isRatchetCipher(s) {
    if (typeof s !== 'string' || s.length < 16) return false;
    try {
      const b = b64ToArr(s);
      return b.length > 0 && b[0] === 0x02 && b.length >= 1 + 91 + 4 + 4 + 12 + 16;
    } catch { return false; }
  }
})();
