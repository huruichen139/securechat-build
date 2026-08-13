// module: miniapp (worker batch5) —— 小程序开放平台：发布/列表/搜索/收藏/最近使用/内嵌打开
// 依赖：web/modules/registry.js（window.SecureChatExt.registerFeature 与 _util）。
// 兼容既有 app.js 的全局：window.state/serverHost/token、window.toast、window.escapeHtml、window.openModal。
'use strict';
(function () {
  if (window.SecureChatMiniApp) return;

  function _baseUrl() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    if (window.state && state.serverHost) return state.serverHost;
    return window.SERVER_HOST || location.origin;
  }
  function _bearer() {
    if (window.SecureChatExt && window.SecureChatExt._util) { const tt = window.SecureChatExt._util.getToken(); return tt ? 'Bearer ' + tt : ''; }
    if (window.state && state.token) return 'Bearer ' + state.token;
    try { const tt = localStorage.getItem('sc_token'); return tt ? 'Bearer ' + tt : ''; } catch (e) { return ''; }
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    const cfg = { method: opts.method || 'GET', headers: { 'Authorization': _bearer() } };
    let body = null;
    if (opts.json) { cfg.headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const req = { method: cfg.method, headers: cfg.headers };
    if (body != null) req.body = body;
    return fetch(_baseUrl() + path, req)
      .then(function (r) { if (r.status === 401) throw new Error('未登录或登录已过期'); return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) throw new Error(d.error); return d; });
  }
  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }
  function fmt(ts) { if (!ts) return ''; const d = new Date(Number(ts)); const p = n => (n < 10 ? '0' + n : '' + n); return d.getMonth() + 1 + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }

  function _me() {
    if (window.state && state.me) return state.me;
    let v = null;
    try { const raw = localStorage.getItem('sc_me'); if (raw) { const parsed = JSON.parse(raw); if (parsed && parsed.id != null) v = parsed; } } catch (e) {}
    if (!v && window.SecureChatExt && window.SecureChatExt._util) { const idz = window.SecureChatExt._util.getMyId(); if (idz) v = { id: idz }; }
    return v;
  }

  function mount(host) {
    host.innerHTML = '';
    host.className = (host.className || '') + ' miniapp-panel';
    const me = _me();
    const isAdmin = me && me.extra && me.extra.admin;
    host.innerHTML =
      '<div class="miniapp-head">' +
        '<div class="miniapp-title">小程序</div>' +
        '<button class="miniapp-btn" data-act="publish">发布小程序</button>' +
        '<button class="miniapp-btn" data-act="recent">最近使用</button>' +
        '<button class="miniapp-btn" data-act="favs">我的收藏</button>' +
      '</div>' +
      '<div class="miniapp-search"><input data-search placeholder="搜索小程序…"><button data-searchbtn>搜索</button></div>' +
      '<div class="oa-body"><div class="oa-loading">加载中…</div></div>';
    const body = host.querySelector('.oa-body');
    function bindAct(name, fn) {
      const b = host.querySelector('[data-act="' + name + '"]');
      if (b) b.addEventListener('click', function (e) { e.stopPropagation(); fn(body); });
    }
    bindAct('publish', publishForm);
    bindAct('recent', listRecent);
    bindAct('favs', listFavs);
    const inp = host.querySelector('[data-search]');
    host.querySelector('[data-searchbtn]').addEventListener('click', function () { search(inp.value.trim(), body); });
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(inp.value.trim(), body); });
    listAll(body);
  }

  function renderCards(body, programs) {
    const list = programs || [];
    if (!list.length) { body.innerHTML = '<div class="oa-empty">还没有小程序</div>'; return; }
    body.innerHTML = '<div class="miniapp-grid">' + list.map(function (a) {
      return '<div class="miniapp-card" data-id="' + a.id + '">' +
        '<div class="miniapp-icon">' + (a.icon ? '<img src="' + esc(a.icon) + '" />' : esc((a.name || '?'))[0]) + '</div>' +
        '<div class="miniapp-meta">' +
          '<div class="miniapp-name">' + esc(a.name) + '</div>' +
          '<div class="miniapp-desc">' + esc(a.description || '') + '</div>' +
        '</div>' +
        '<button class="miniapp-fav" data-on="' + (a.favoritedByMe ? '1' : '0') + '" data-id="' + a.id + '">' + (a.favoritedByMe ? '★' : '☆') + '</button>' +
      '</div>';
    }).join('') + '</div>';
    body.querySelectorAll('.miniapp-card').forEach(function (card) {
      card.addEventListener('click', function () { openApp(Number(card.dataset.id), body); });
    });
    body.querySelectorAll('.miniapp-fav').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const on = btn.dataset.on !== '1';
        apiFetch('/api/mini-program/' + btn.dataset.id + '/favorite', { method: 'POST', json: { on: on } })
          .then(function () { btn.dataset.on = on ? '1' : '0'; btn.textContent = on ? '★' : '☆'; toastMsg(on ? '已收藏' : '取消收藏'); })
          .catch(function (e2) { toastMsg(e2.message, 'error'); });
      });
    });
  }

  function listAll(body) {
    apiFetch('/api/mini-program/list').then(function (d) { renderCards(body, d.programs); })
      .catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }
  function listRecent(body) {
    apiFetch('/api/mini-program/me/recent').then(function (d) { renderCards(body, d.programs); })
      .catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }
  function listFavs(body) {
    apiFetch('/api/mini-program/me/favorites').then(function (d) { renderCards(body, d.programs); })
      .catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }
  function search(q, body) {
    if (!q) { listAll(body); return; }
    apiFetch('/api/mini-program/search?q=' + encodeURIComponent(q)).then(function (d) { renderCards(body, d.programs); })
      .catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  function publishForm(body) {
    if (!window.openModal) { toastMsg('当前页面不支持发布', 'warn'); return; }
    window.openModal('发布小程序', [
      { key: 'name', label: '名称' },
      { key: 'url', label: 'Web 入口（http(s)://）' },
      { key: 'icon', label: '图标地址（可留空）' },
      { key: 'description', label: '描述（可留空）' },
    ], function (out, close) {
      if (!out.name || !out.url) { toastMsg('名称和入口地址不能为空'); return; }
      apiFetch('/api/mini-program/publish', { method: 'POST', json: { name: out.name, url: out.url, icon: out.icon, description: out.description } })
        .then(function () { close(); toastMsg('发布成功'); listAll(body); })
        .catch(function (e) { toastMsg(e.message, 'error'); });
    });
  }

  function openApp(id, body) {
    apiFetch('/api/mini-program/' + id).then(function (d) {
      const a = d.program;
      if (!a || !a.url) { toastMsg('小程序入口缺失', 'warn'); return; }
      // 内嵌 iframe 打开（web 端）
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      const box = document.createElement('div');
      box.className = 'modal miniapp-view';
      box.innerHTML =
        '<div class="miniapp-view-head">' +
          '<span class="miniapp-view-title">' + esc(a.name) + '</span>' +
          '<span class="miniapp-view-sub">' + esc(a.url) + '</span>' +
          '<button class="miniapp-close">✕</button>' +
        '</div>' +
        '<iframe class="miniapp-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="' + esc(a.url) + '"></iframe>';
      mask.appendChild(box);
      document.body.appendChild(mask);
      box.querySelector('.miniapp-close').addEventListener('click', function () { mask.remove(); });
      mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
      if (window.toast) window.toast('已打开「' + a.name + '」（桌面网页端内嵌，手机建议用 App）', 'info', 2000);
    }).catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal miniapp-view-host';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e2) { if (e2.target === mask) mask.remove(); });
    const host = box.querySelector('.oa-container');
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
  }
  function renderInto(el) { if (el) mount(el); }

  window.SecureChatMiniApp = { name: '小程序', label: '小程序', icon: '小', open: openPanel, renderInto: renderInto };

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('miniapp', { name: '小程序', label: '小程序', icon: '小', open: openPanel, renderInto: renderInto });
  }
}());