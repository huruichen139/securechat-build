'use strict';
// module: rtc|voicemsg|filehelper (worker batch3)
// 极简特性注册中心：window.SecureChatExt.registerFeature(name, { ... })
// 让 batch3 的多个独立模块在没有任何既有依赖的情况下自取 token/baseUrl，
// 即便 app.js 巨石里没有该全局对象也不会崩（幂等降级创建）。
(function () {
  if (typeof window === 'undefined') return;

  // 幂等：若巨石已提供 SecureChatExt 则复用，否则自建最小实现。
  if (!window.SecureChatExt) {
    window.SecureChatExt = {
      _features: {},
      registerFeature(name, feature) {
        if (this._features[name]) {
          console.warn('[SecureChatExt] 特性已注册，覆盖: ' + name);
        }
        this._features[name] = feature;
        return feature;
      },
      getFeature(name) {
        return this._features[name] || null;
      },
      listFeatures() {
        return Object.keys(this._features);
      },
    };
  }

  // 统一基址与鉴权头：优先取巨石 app.js 的 state / state.token；
  // 否则回退 readCookie/localStorage，方便独立加载调试。
  function serverHost() {
    if (window.SERVER_HOST) return window.SERVER_HOST;
    return location.origin;
  }

  function getState() {
    // app.js 巨石把登录态挂在 window 某个全局 state 上（保护式探测）
    const cand = [window.state, window.appState, window.scState];
    for (const s of cand) {
      if (s && typeof s.token === 'string' && s.token) return s;
    }
    return null;
  }

  function getToken() {
    const s = getState();
    if (s && s.token) return s.token;
    try { return localStorage.getItem('sc_token') || ''; } catch (e) { return ''; }
  }

  function getMyId() {
    const s = getState();
    if (s && s.me && typeof s.me.id === 'number') return s.me.id;
    if (s && s.me && s.me.id != null) return Number(s.me.id);
    try { return Number(localStorage.getItem('sc_myid') || 0) || null; } catch (e) { return null; }
  }

  function authHeader() {
    const t = getToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  async function api(method, path, { body, query, raw } = {}) {
    const url = serverHost() + path + (query ? '?' + new URLSearchParams(query).toString() : '');
    const headers = Object.assign({}, authHeader());
    let opts = { method: method.toUpperCase(), headers };
    if (raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      opts.body = raw;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const isJson = (resp.headers.get('content-type') || '').indexOf('json') >= 0;
    const data = isJson ? await resp.json() : await resp.blob();
    if (!resp.ok) {
      const msg = (data && data.error) || ('请求失败 (' + resp.status + ')');
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  // WS：复用巨石 socket（若存在），否则返回 null（Web<->Flutter 用 REST 信令兜底）
  function wsCycleSend(sub, to, data) {
    try {
      if (window.socket && typeof window.send === 'function') {
        window.send('signal', { to, sub, data });
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 暴露给各特性模块的公共工具（不污染全局名）
  window.SecureChatExt._util = {
    serverHost,
    api,
    getToken,
    getMyId,
    getState,
    authHeader,
    wsCycleSend,
  };
})();