/* SecureChat v5 - core */
(function () {
  'use strict';

  var HOST = location.origin;
  var TOKEN_KEY = 'sc_token';
  var ME_KEY = 'sc_me';

  var P = {
    C_AUTH: 'auth', C_MSG: 'msg', C_READ: 'read', C_TYPING: 'typing', C_SIGNAL: 'signal',
    C_GROUP_MSG: 'group_msg', C_GROUP_READ: 'group_read',
    S_AUTH_OK: 'auth_ok', S_AUTH_FAIL: 'auth_fail', S_MSG: 'msg', S_USER_LIST: 'user_list',
    S_TYPING: 'typing', S_ERROR: 'error', S_MSG_RECALL: 'msg_recall', S_MSG_READ: 'msg_read',
    S_MSG_EDIT: 'msg_edit', S_GROUP_MSG_READ: 'group_msg_read', S_SIGNAL: 'signal',
    S_FRIEND_REQ: 'friend_req', S_FRIEND_LIST: 'friend_list', S_GROUP_MSG: 'group_msg',
    S_GROUP_LIST: 'group_list', S_ANNOUNCEMENT: 'announcement', S_KICKED: 'kicked'
  };

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    me: null,
    users: [],
    friends: [],
    groups: [],
    previews: {},
    unread: {},
    activePeer: null,
    activeGroup: null,
    ws: null,
    wsReady: false,
    typingTimers: {},
    msgMap: {},
    reply: null
  };
  try { state.me = JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch (e) { state.me = null; }

  /* ---------- utils ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function dayLabel(ts) {
    var d = new Date(Number(ts));
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function initial(name) { return String(name || '?').trim().charAt(0).toUpperCase() || '?'; }
  function uid8() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- toast / modal ---------- */
  function toast(msg, kind, ms) {
    var wrap = $('toastWrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, (ms || 2200) - 200);
    setTimeout(function () { el.remove(); }, ms || 2200);
  }

  var modalStack = [];
  function openModal(title, bodyHtml, opts) {
    opts = opts || {};
    var wrap = $('modalWrap');
    wrap.hidden = false;
    wrap.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'modal' + (opts.className ? ' ' + opts.className : '');
    box.innerHTML =
      '<div class="modal-head"><h3>' + esc(title || '') + '</h3>' +
      '<button class="icon-btn" data-close>×</button></div>' +
      '<div class="modal-body">' + (bodyHtml || '') + '</div>' +
      (opts.footer ? '<div class="modal-foot">' + opts.footer + '</div>' : '');
    wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) closeModal(); };
    box.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeModal; });
    modalStack.push(box);
    if (opts.onMount) opts.onMount(box);
    return box;
  }
  function closeModal() {
    modalStack.pop();
    var wrap = $('modalWrap');
    if (modalStack.length) {
      var prev = modalStack[modalStack.length - 1];
      wrap.innerHTML = '';
      wrap.appendChild(prev);
      return;
    }
    wrap.hidden = true;
    wrap.innerHTML = '';
  }
  function confirmDialog(title, text, okText) {
    return new Promise(function (resolve) {
      openModal(title, '<p style="margin:0;color:var(--text-2)">' + esc(text || '') + '</p>', {
        footer: '<button class="btn ghost" data-no>取消</button><button class="btn primary" data-yes>' + esc(okText || '确定') + '</button>',
        onMount: function (box) {
          box.querySelector('[data-no]').onclick = function () { closeModal(); resolve(false); };
          box.querySelector('[data-yes]').onclick = function () { closeModal(); resolve(true); };
        }
      });
    });
  }

  /* ---------- api ---------- */
  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (!opts.raw && body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    var init = { method: method, headers: headers };
    if (body !== undefined && body !== null) init.body = opts.raw ? body : JSON.stringify(body);
    return fetch(HOST + path, init).then(function (res) {
      if (res.status === 401 && !opts.noAuthRedirect) {
        var e = new Error('登录已失效');
        e.code = 401;
        throw e;
      }
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') >= 0 ? res.json().catch(function () { return {}; }) : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ('请求失败 ' + res.status));
          err.code = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function get(path) { return api('GET', path); }
  function post(path, body) { return api('POST', path, body); }

  /* ---------- 会话持久化 ---------- */
  function saveSession(token, me) {
    state.token = token || '';
    state.me = me || null;
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    if (me) localStorage.setItem(ME_KEY, JSON.stringify(me)); else localStorage.removeItem(ME_KEY);
  }
  function logout() {
    api('POST', '/api/logout', {}).catch(function () {});
    try { if (state.ws) state.ws.close(); } catch (e) {}
    saveSession('', null);
    location.reload();
  }

  /* ---------- websocket ---------- */
  var wsHandlers = {};
  var wsRetry = 0;
  function on(type, fn) { (wsHandlers[type] = wsHandlers[type] || []).push(fn); }
  function emit(type, payload) { (wsHandlers[type] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error(e); } }); }

  function wsConnect() {
    if (!state.token) return;
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    state.ws = ws;
    ws.onopen = function () {
      wsRetry = 0;
      ws.send(JSON.stringify({ type: P.C_AUTH, payload: { token: state.token } }));
    };
    ws.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (!data || typeof data !== 'object') return;
      if (data.type === P.S_AUTH_OK) { state.wsReady = true; }
      if (data.type === P.S_AUTH_FAIL) { state.wsReady = false; return; }
      if (data.type === P.S_KICKED) { toast('账号已在其他设备登录', 'warn'); }
      emit(data.type, data.payload);
    };
    ws.onclose = function () {
      state.wsReady = false;
      if (!state.token) return;
      wsRetry = Math.min(wsRetry + 1, 6);
      setTimeout(wsConnect, 800 * wsRetry);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function wsSend(type, payload) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: type, payload: payload }));
      return true;
    }
    return false;
  }

  /* ---------- 功能注册表（供 modules/*.js 复用） ---------- */
  var features = {};
  var SecureChatExt = {
    features: features,
    registerFeature: function (name, def) { features[name] = def; return def; },
    getFeature: function (name) { return features[name] || null; },
    listFeatures: function () { return Object.keys(features).map(function (k) { return features[k]; }); },
    open: function (name) {
      var f = features[name];
      if (!f) { toast('该功能组件未加载', 'warn'); return false; }
      return openContainerFeature(f, f.name || name);
    }
  };

  function openContainerFeature(feature, title) {
    if (!feature) { toast('该功能组件未加载', 'warn'); return false; }
    var hasContainer = typeof feature.renderInto === 'function' || typeof feature.mount === 'function' || typeof feature.openFilterPanel === 'function';
    if (hasContainer) {
      var box = openModal(title || feature.name || '功能', '<div class="feature-host"></div>', { className: 'wide' });
      var host = box.querySelector('.feature-host');
      try {
        if (typeof feature.renderInto === 'function') feature.renderInto(host);
        else if (typeof feature.mount === 'function') feature.mount(host);
        else feature.openFilterPanel(host);
      } catch (e) {
        console.error(e);
        toast('该功能打开失败', 'error');
        return false;
      }
      return true;
    }
    if (typeof feature.open === 'function') {
      try { feature.open(); return true; } catch (e) { console.error(e); toast('该功能打开失败', 'error'); return false; }
    }
    toast('该功能组件未实现', 'warn');
    return false;
  }

  /* ---------- 主题 ---------- */
  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', !!dark);
    localStorage.setItem('sc5_dark', dark ? '1' : '0');
  }
  applyTheme(localStorage.getItem('sc5_dark') === '1');

  /* ---------- 兼容层：旧模块依赖的全局 ---------- */
  window.SERVER_HOST = HOST;
  window.P = P;
  window.state = state;
  window.appState = state;
  window.scState = state;
  window.IS_MOBILE = window.matchMedia('(max-width: 760px)').matches;
  window.$ = $;
  window.toast = toast;
  window.escapeHtml = esc;
  window.fmtTime = fmtTime;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.SecureChatExt = SecureChatExt;
  window.openContainerFeature = openContainerFeature;
  window.api = api;
  window.scApi = api;
  window.scHost = HOST;

  window.SC5 = {
    HOST: HOST, P: P, state: state, $: $, esc: esc, fmtTime: fmtTime, dayLabel: dayLabel,
    humanSize: humanSize, initial: initial, uid8: uid8, toast: toast, api: api, get: get, post: post,
    openModal: openModal, closeModal: closeModal, confirm: confirmDialog, on: on, wsSend: wsSend,
    wsConnect: wsConnect, saveSession: saveSession, logout: logout, applyTheme: applyTheme,
    SecureChatExt: SecureChatExt, openContainerFeature: openContainerFeature
  };
})();
