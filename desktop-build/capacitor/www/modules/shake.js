// module: shake (worker batch5) —— 摇一摇：devicemotion 模拟，禁权限时用手动按钮触发；匹配同时"摇"的人
// 依赖：web/modules/registry.js（window.SecureChatExt.registerFeature 与 _util）。
// 复用既有全局：window.state、window.toast、window.escapeHtml。
'use strict';
(function () {
  if (window.SecureChatShake) return;

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

  function mount(host) {
    host.innerHTML = '';
    host.className = (host.className || '') + ' shake-panel';
    host.innerHTML =
      '<div class="shake-stage">' +
        '<div class="shake-phone">📱</div>' +
        '<div class="shake-hint">摇动手机，或点击下方按钮模拟摇一摇</div>' +
        '<button class="shake-btn" data-now>现在摇</button>' +
      '</div>' +
      '<div class="oa-body"><div class="oa-loading" hidden></div></div>';
    const body = host.querySelector('.oa-body');
    const btn = host.querySelector('[data-now]');
    let shaking = false;
    let pollTimer = null;
    let sessionId = null;

    // 摇一摇触发：注册会话 + 拉匹配
    function trigger() {
      if (shaking) return;
      shaking = true;
      body.classList.add('shake-running');
      btn.disabled = true;
      btn.textContent = '正在摇…';
      apiFetch('/api/shake/start', { method: 'POST', json: {} })
        .then(function (d) {
          sessionId = d.shakeSessionId;
          toastMsg('摇一摇中，寻找同样在摇的人…', 'info');
          pull();
          // 会话内定时刷新（直到手动停止）
          pollTimer = setInterval(pull, 4000);
        })
        .catch(function (e) {
          shaking = false; btn.disabled = false; btn.textContent = '现在摇';
          toastMsg(e.message, 'error');
        });
    }

    function pull() {
      if (!host.isConnected) { clearInterval(pollTimer); pollTimer = null; return; }
      apiFetch('/api/shake/matches').then(function (d) {
        const list = d.matches || [];
        body.innerHTML = '<div class="shake-results">' +
          '<div class="shake-res-title">摇到的 「' + (list.length ? list[0].city || '附近' : '人') + '」朋友们</div>' +
          (list.length ? '<div class="nearby-list">' + list.map(function (p) {
            return '<div class="nearby-item">' +
              '<div class="nearby-avatar">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" />' : esc((p.nickname || '?')[0])) + '</div>' +
              '<div class="nearby-meta">' +
                '<div class="nearby-name">' + esc(p.nickname || p.username) + '</div>' +
                '<div class="nearby-sub">' + esc(p.city || '') + '</div>' +
              '</div>' +
              '<button class="nearby-hello" data-uid="' + p.userId + '">打招呼</button>' +
            '</div>';
          }).join('') + '</div>' : '<div class="oa-empty">还没有人同时摇，再等等…</div>') +
        '</div>';
        if (btn) btn.textContent = '停止摇 ';
        bindHello();
      }).catch(function () { /* 轮询失败忽略 */ });
    }

    function bindHello() {
      body.querySelectorAll('.nearby-hello').forEach(function (b) {
        if (!b.dataset.uid) return;
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          apiFetch('/api/shake/' + b.dataset.uid + '/hello', { method: 'POST', json: {} })
            .then(function (d) {
              if (d.already) toastMsg(d.message || '你们已是好友', 'info');
              else toastMsg('已打招呼');
              b.disabled = true; b.textContent = d.already ? '已是好友' : '已打招呼';
            })
            .catch(function (e2) { toastMsg(e2.message, 'error'); });
        });
      });
    }

    function stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      apiFetch('/api/shake/stop', { method: 'POST', json: {} }).catch(function () {});
      shaking = false;
      body.classList.remove('shake-running');
      btn.disabled = false; btn.textContent = '现在摇';
      if (!body.querySelector('.shake-results')) {
        body.innerHTML = '<div class="oa-empty">停止摇动</div>';
      }
    }

    // 触发源：手动按钮优先；devicemotion 可用时监听
    btn.addEventListener('click', function () { if (shaking) stop(); else trigger(); });

    // devicemotion 权限（iOS Safari 需用户授权）
    let lastAcc = { x: 0, y: 0, z: 0 };
    let lastT = 0;
    function onMotion(e) {
      const a = (e && e.accelerationIncludingGravity) || {};
      const now = Date.now();
      const dx = (a.x || 0) - lastAcc.x;
      const dy = (a.y || 0) - lastAcc.y;
      const dz = (a.z || 0) - lastAcc.z;
      lastAcc = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
      const d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
      if (now - lastT > 600 && d > 18) { lastT = now; trigger(); }
    }
    if (!host._shakeMotionBound) {
      host._shakeMotionBound = true;
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
        try {
          DeviceMotionEvent.requestPermission().then(function (r) {
            if (r === 'granted') window.addEventListener('devicemotion', onMotion);
          }).catch(function () {});
        } catch (_) {}
      } else {
        window.addEventListener('devicemotion', onMotion);
      }
    }

    // 卸载清理
    host._shakeOff = function () {
      window.removeEventListener('devicemotion', onMotion);
      if (pollTimer) clearInterval(pollTimer);
      apiFetch('/api/shake/stop', { method: 'POST', json: {} }).catch(function () {});
    };

    body.innerHTML = '<div class="oa-empty">点击「现在摇」开始，或晃动设备</div>';
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal shake-view';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { cleanup(mask); };
    mask.addEventListener('click', function (e) { if (e.target === mask) cleanup(mask); });
    const host = box.querySelector('.oa-container');
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
    function cleanup(m) {
      const h = box.querySelector('.oa-container');
      if (h && h._shakeOff) { try { h._shakeOff(); } catch (e) {} }
      m.remove();
    }
  }
  function renderInto(el) { if (el) mount(el); }

  window.SecureChatShake = { name: '摇一摇', label: '摇一摇', icon: '摇', open: openPanel, renderInto: renderInto };

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('shake', { name: '摇一摇', label: '摇一摇', icon: '摇', open: openPanel, renderInto: renderInto });
  }
}());