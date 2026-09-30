// module: nearby (worker batch5) —— 附近的人：LBS（城市/坐标），列出附近活跃用户，可打招呼/加好友
// 依赖：web/modules/registry.js（window.SecureChatExt.registerFeature 与 _util）。
// 复用既有全局：window.state、window.toast、window.escapeHtml。
'use strict';
(function () {
  if (window.SecureChatNearby) return;

  function _baseUrl() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    if (window.state && window.state.serverHost) return window.state.serverHost;
    return window.SERVER_HOST || location.origin;
  }
  function _bearer() {
    if (window.SecureChatExt && window.SecureChatExt._util) { const t = window.SecureChatExt._util.getToken(); return t ? 'Bearer ' + t : ''; }
    if (window.state && window.state.token) return 'Bearer ' + window.state.token;
    try { const t = localStorage.getItem('sc_token'); return t ? 'Bearer ' + t : ''; } catch (e) { return ''; }
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    const req = { method: opts.method || 'GET', headers: { 'Authorization': _bearer() } };
    if (opts.json) { req.headers['Content-Type'] = 'application/json'; req.body = JSON.stringify(opts.json); }
    return fetch(_baseUrl() + path, req)
      .then(function (r) { if (r.status === 401) throw new Error('未登录或登录已过期'); return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) throw new Error(d.error); return d; });
  }
  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }
  function fmtRel(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚在线';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  function mount(host) {
    host.innerHTML = '';
    host.className = (host.className || '') + ' nearby-panel';
    host.innerHTML =
      '<div class="nearby-head">' +
        '<div class="nearby-title">附近的人</div>' +
        '<button class="nearby-btn" data-act="set">我的位置</button>' +
        '<button class="nearby-btn" data-act="refresh">刷新</button>' +
      '</div>' +
      '<div class="nearby-city"><span class="nearby-city-label">附近 · </span><span class="nearby-city-val">…</span></div>' +
      '<div class="oa-body"><div class="oa-loading">加载中…</div></div>';
    const body = host.querySelector('.oa-body');
    host.querySelector('[data-act="refresh"]').addEventListener('click', function () { load(body); });
    host.querySelector('[data-act="set"]').addEventListener('click', function () { setCity(host, body); });

    function load(b) {
      apiFetch('/api/nearby/list').then(function (d) {
        host.querySelector('.nearby-city-val').textContent = d.city || '';
        const list = d.people || [];
        if (!list.length) { b.innerHTML = '<div class="oa-empty">附近还没有活跃的人</div>'; return; }
        b.innerHTML = '<div class="nearby-list">' + list.map(function (p) {
          const tag = p.online ? '<span class="nearby-badge">在线</span>' : '';
          let action = '<button class="nearby-hello" data-uid="' + p.userId + '">打招呼</button>';
          if (p.isFriend) action = '<button class="nearby-hello" disabled>已是好友</button>';
          else if (p.friendRequested) action = '<button class="nearby-hello" disabled>已打招呼</button>';
          return '<div class="nearby-item">' +
            '<div class="nearby-avatar">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" />' : esc((p.nickname || '?')[0])) + '</div>' +
            '<div class="nearby-meta">' +
              '<div class="nearby-name">' + esc(p.nickname || p.username) + tag + '</div>' +
              '<div class="nearby-sub">' + esc(p.city || '') + (p.region ? ' · ' + esc(p.region) : '') + ' · ' + fmtRel(p.lastSeen) + '</div>' +
            '</div>' +
            action +
          '</div>';
        }).join('') + '</div>';
        b.querySelectorAll('.nearby-hello').forEach(function (btn) {
          if (!btn.dataset.uid) return;
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const uid = Number(btn.dataset.uid);
            apiFetch('/api/nearby/' + uid + '/hello', { method: 'POST', json: {} })
              .then(function (d) {
                if (d.already) { toastMsg(d.message || '你们已是好友', 'info'); btn.disabled = true; btn.textContent = '已是好友'; btn.dataset.uid = ''; }
                else { btn.disabled = true; btn.textContent = '已打招呼'; btn.dataset.uid = ''; toastMsg('已打招呼'); }
              })
              .catch(function (e2) { toastMsg(e2.message, 'error'); });
          });
        });
      }).catch(function (e) { b.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
    }

    function setCity(h, b) {
      if (!window.openModal) { toastMsg('当前页面不支持设置', 'warn'); return; }
      const cur = (h.querySelector('.nearby-city-val') || {}).textContent || '';
      window.openModal('设置我的位置', [
        { key: 'city', label: '城市（留空自动按 IP/mock 估算）', value: cur !== '…' ? cur : '' },
        { key: 'region', label: '区 / 详细（可留空）' },
      ], function (out, close) {
        apiFetch('/api/nearby/set', { method: 'POST', json: { city: out.city, region: out.region } })
          .then(function (d) { close(); toastMsg('位置已更新：' + (d.city || '—')); load(b); })
          .catch(function (e2) { toastMsg(e2.message, 'error'); });
      });
    }

    load(body);
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal nearby-view';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    const host = box.querySelector('.oa-container');
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
  }
  function renderInto(el) { if (el) mount(el); }

  window.SecureChatNearby = { name: '附近的人', label: '附近的人', icon: '附', open: openPanel, renderInto: renderInto };

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('nearby', { name: '附近的人', label: '附近的人', icon: '附', open: openPanel, renderInto: renderInto });
  }
}());