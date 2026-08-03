// SecureChat E2EE: ECDH(P-256) + AES-GCM，私钥存 localStorage（JWK）
// 服务端只存/转发密文，无法解密。
(function () {
  'use strict';
  const STORE_PRIV = 'sc_e2ee_priv';
  const STORE_PUB = 'sc_e2ee_pub';

  function strToB64Url(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }
  function b64UrlToStr(b) {
    return decodeURIComponent(escape(atob(b)));
  }
  function bufToB64(buf) {
    let s = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToBuf(b) {
    const bin = atob(b); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  async function genKeyPair() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey', 'deriveBits']);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pubSpki = await crypto.subtle.exportKey('spki', kp.publicKey);
    return { privJwk, pubB64: bufToB64(pubSpki) };
  }

  async function loadPriv(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
  }
  async function importPeerPub(pubB64) {
    return crypto.subtle.importKey('spki', b64ToBuf(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }
  async function deriveAesKey(priv, peerPub) {
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, priv,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // 加密 -> 返回 base64( iv(12) + ciphertext )
  async function encryptStr(aesKey, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plain));
    const out = new Uint8Array(iv.length + enc.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(enc), iv.length);
    return bufToB64(out.buffer);
  }
  // 解密 base64 -> 明文；失败抛异常
  async function decryptStr(aesKey, b64) {
    const buf = new Uint8Array(b64ToBuf(b64));
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return new TextDecoder().decode(pt);
  }

  window.SCE2EE = {
    // 保证当前账号有密钥对；若无则生成并上传到服务器
    async ensureKeyPair(token, serverHost) {
      let privJwk = null, pubB64 = '';
      try { privJwk = JSON.parse(localStorage.getItem(STORE_PRIV) || 'null'); } catch {}
      pubB64 = localStorage.getItem(STORE_PUB) || '';
      if (!privJwk || !pubB64) {
        const kp = await genKeyPair();
        privJwk = kp.privJwk; pubB64 = kp.pubB64;
        localStorage.setItem(STORE_PRIV, JSON.stringify(privJwk));
        localStorage.setItem(STORE_PUB, pubB64);
      }
      // 上传（幂等；服务器没存或对不上都覆盖一次）
      try {
        await fetch(serverHost + '/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ pubkey: pubB64 })
        });
      } catch {}
      return { privJwk, pubB64 };
    },
    getPub() { return localStorage.getItem(STORE_PUB) || ''; },
    // 发给某用户的密钥缓存
    _cache: {},
    async _getSendKey(myPrivJwk, peerPubB64, cacheKey) {
      if (this._cache[cacheKey]) return this._cache[cacheKey];
      const priv = await loadPriv(myPrivJwk);
      const peerPub = await importPeerPub(peerPubB64);
      const k = await deriveAesKey(priv, peerPub);
      this._cache[cacheKey] = k;
      return k;
    },
    // 加密发出去的明文 -> 密文 base64
    async encryptOut(myPrivJwk, peerPubB64, plain) {
      if (!peerPubB64) throw new Error('对方尚未上传公钥，无法端到端加密');
      const k = await this._getSendKey(myPrivJwk, peerPubB64, 's:' + peerPubB64);
      return encryptStr(k, plain);
    },
    // 解密收到的密文 -> 明文
    async decryptIn(myPrivJwk, fromPubB64, cipherB64) {
      if (!fromPubB64) throw new Error('对方公钥缺失');
      const k = await this._getSendKey(myPrivJwk, fromPubB64, 'r:' + fromPubB64);
      return decryptStr(k, cipherB64);
    },
    isCipher(b64) {
      if (typeof b64 !== 'string') return false;
      return /^[A-Za-z0-9+/=]{16,}$/.test(b64) && b64.indexOf('|') === -1;
    }
  };
})();
