// module: scan (worker batch5) —— 扫一扫：getUserMedia 摄像头 + jsqr.js 二维码解码，
// 摄像头不可用时降级为"上传二维码图片解码"。识别结果 → 加好友 / 打开小程序 / 跳转网页。
// 依赖：web/jsqr.js（全局 window.jsQR）、web/modules/registry.js。
// 复用既有全局：window.state、window.toast、window.escapeHtml。
'use strict';
(function () {
  if (window.SecureChatScan) return;

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
  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  // jsQR 全局可用性探测
  function hasJsQR() { return typeof window.jsQR === 'function'; }

  // 从 ImageData 解码
  function decodeFromCanvas(canvas) {
    if (!hasJsQR()) throw new Error('当前环境未提供二维码解码库（jsqr.js 未加载）');
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data) return code.data;
    return null;
  }

  // ============================================================
  // 扫描结果处理：好友码 / 小程序 URL / 任意网页 URL / 登录码
  // ============================================================
  function handlePayload(raw, statusEl, onDone) {
    const text = String(raw || '').trim();
    if (!text) { status('未识别到二维码内容', statusEl); return; }

    // securechat://friend?uid=xxx → 加好友
    let uid = null;
    try {
      const u = new URL(text);
      if (u.protocol === 'securechat:' && (u.hostname === 'friend' || u.pathname.indexOf('/friend') === 0)) uid = u.searchParams.get('uid');
    } catch (_) {}
    if (!uid && /^securechat:\/\/friend/i.test(text)) { const m = text.match(/uid=([^&]+)/i); if (m) uid = decodeURIComponent(m[1]); }
    if (uid) {
      go(function () {
        return fetch(_baseUrl() + '/api/friend/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': _bearer() },
          body: JSON.stringify({ friendUid: String(uid).trim() })
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || '加好友失败'); return d; }); });
      }, function (d) {
        const name = (d.friend && (d.friend.nickname || d.friend.username)) || uid;
        status('好友请求已发送：' + name, statusEl);
        if (onDone) onDone();
      });
      return;
    }

    // securechat://login?token=xxx → 确认登录
    if (/^securechat:\/\/login/i.test(text)) {
      const m = text.match(/token=([^&]+)/i);
      const token = m ? decodeURIComponent(m[1]) : null;
      if (!token) { status('登录二维码无效', statusEl); return; }
      go(function () {
        return fetch(_baseUrl() + '/api/login/qr/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': _bearer() },
          body: JSON.stringify({ token: token })
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || '确认失败'); return d; }); });
      }, function () { status('已确认登录', statusEl); if (onDone) onDone(); });
      return;
    }

    // securechat://mini?app=<name 或 id> → 打开小程序（按名称搜索）
    if (/^securechat:\/\/mini/i.test(text)) {
      const m = text.match(/(?:app|id)=([^&]+)/i);
      const key = m ? decodeURIComponent(m[1]) : '';
      if (!key) { status('小程序码无效', statusEl); return; }
      fetch(_baseUrl() + '/api/mini-program/search?q=' + encodeURIComponent(key), { headers: { 'Authorization': _bearer() } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          const list = d.programs || [];
          if (!list.length) { status('未找到小程序：' + key, statusEl); return; }
          const target = list.find(function (a) { return String(a.id) === String(key); }) || list[0];
          status('正在打开小程序：' + target.name, statusEl);
          openUrlInIframe(target);
          if (onDone) onDone();
        })
        .catch(function (e) { status('打开小程序失败：' + e.message, statusEl); });
      return;
    }

    // 其它 http(s) URL → 跳转网页
    if (/^https?:\/\//i.test(text)) {
      status('识别到网页链接，正在跳转…', statusEl);
      openUrl(text);
      if (onDone) onDone();
      return;
    }

    // WiFi 二维码：WIFI:T:WPA;S:<ssid>;P:<pass>;; → 展示连接信息
    if (/^WIFI:/i.test(text)) {
      showGenericResult(text, 'WiFi 二维码', statusEl);
      if (onDone) onDone();
      return;
    }

    // mailto / tel / sms → 系统级打开
    if (/^mailto:/i.test(text)) { status('打开邮件…', statusEl); openUrl(text); if (onDone) onDone(); return; }
    if (/^tel:/i.test(text)) { status('拨打电话…', statusEl); openUrl(text); if (onDone) onDone(); return; }
    if (/^sms:/i.test(text)) { status('发送短信…', statusEl); openUrl(text); if (onDone) onDone(); return; }

    // 名片：BEGIN:VCARD… → 展示名片文本
    if (/^BEGIN:VCARD/i.test(text)) {
      showGenericResult(text, '电子名片', statusEl);
      if (onDone) onDone();
      return;
    }

    // 其它任意内容 → 以文本形式展示并允许复制，尽量"扫得动"
    showGenericResult(text, '二维码内容', statusEl);
    if (onDone) onDone();
  }

  // 兜底：把任意识别内容展示为可复制文本（保证"扫任何二维码都有结果"）
  function showGenericResult(text, title, statusEl) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal scan-text-view';
    box.style.cssText = 'width:min(420px,88vw);max-height:80vh;overflow:auto;padding:18px 20px;box-sizing:border-box';
    const escText = esc(text);
    box.innerHTML =
      '<div style="font-size:16px;font-weight:700;margin-bottom:10px">' + esc(title) + '</div>' +
      '<div style="font-size:13px;color:#888;margin-bottom:12px">识别到以下内容，可复制使用：</div>' +
      '<textarea readonly style="width:100%;box-sizing:border-box;min-height:90px;padding:10px;font-size:13px;border:1px solid #ddd;border-radius:8px;background:#f8fafc;color:#333;resize:vertical">' + escText + '</textarea>' +
      '<div style="display:flex;gap:10px;margin-top:12px;justify-content:flex-end">' +
        '<button class="scan-text-copy" type="button" style="padding:8px 16px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:13px">复制</button>' +
        '<button class="scan-text-close" type="button" style="padding:8px 16px;border:none;border-radius:8px;background:#07c160;color:#fff;cursor:pointer;font-size:13px">完成</button>' +
      '</div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.scan-text-close').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    box.querySelector('.scan-text-copy').addEventListener('click', function () {
      var ta = box.querySelector('textarea');
      ta.removeAttribute('readonly');
      ta.select();
      try { document.execCommand('copy'); toastMsg('已复制', 'success'); }
      catch (e) { toastMsg('复制失败，请手动复制', 'warn'); }
      ta.setAttribute('readonly', 'readonly');
    });
    status(title + '：' + (text.length > 30 ? text.slice(0, 30) + '…' : text), statusEl);
  }

  // 网页跳转：优先新标签页（外部），内嵌留给 code 明确 mini 时用
  function openUrl(url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function openUrlInIframe(miniApp) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal miniapp-view';
    box.innerHTML =
      '<div class="miniapp-view-head">' +
        '<span class="miniapp-view-title">' + esc(miniApp.name) + '</span>' +
        '<button class="miniapp-close">✕</button>' +
      '</div>' +
      '<iframe class="miniapp-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="' + esc(miniApp.url) + '"></iframe>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.miniapp-close').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
  }

  function go(promiseFn, thenFn) {
    promiseFn().then(thenFn).catch(function (e) {
      if (window.console) console.error('[scan]', e);
      if (window.toast) window.toast(e.message || '处理失败', 'error');
    });
  }
  function status(msg, el) {
    if (el) el.textContent = msg;
    if (window.toast) window.toast(msg, 'info', 1800);
  }

  // ============================================================
  // UI：摄像头扫码 + 上传解码
  // ============================================================
  function mount(host) {
    host.innerHTML = '';
    host.className = (host.className || '') + ' scan-panel';
    host.innerHTML =
      '<div class="scan-head">扫一扫</div>' +
      '<div class="scan-stage">' +
        '<video class="scan-video" autoplay playsinline muted></video>' +
        '<canvas class="scan-canvas" hidden></canvas>' +
        '<div class="scan-overlay"><div class="scan-corner"></div></div>' +
      '</div>' +
      '<div class="scan-status">启动摄像头…</div>' +
      '<div class="scan-actions">' +
        '<button class="scan-btn" data-cam>重置摄像头</button>' +
        '<label class="scan-btn scan-upload">上传二维码图片<input type="file" accept="image/*" data-file hidden></label>' +
      '</div>';
    const video = host.querySelector('.scan-video');
    const canvas = host.querySelector('.scan-canvas');
    const statusEl = host.querySelector('.scan-status');
    let stream = null;
    let raf = null;
    let closed = false;

    function tearDown() {
      closed = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }

    function loop() {
      if (closed) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const text = decodeFromCanvas(canvas);
          if (text) {
            tearDown();
            video.classList.add('scan-done');
            statusEl.textContent = '已识别';
            handlePayload(text, statusEl, null);
            return;
          }
        } catch (_) {}
      }
      raf = requestAnimationFrame(loop);
    }

    function startCam() {
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      closed = false;
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
          .then(function (s) {
            stream = s;
            video.srcObject = s;
            video.play().then(function () {
              statusEl.textContent = hasJsQR() ? '将二维码对准取景框' : '解码库未加载，将尝试上传识别';
            }).catch(function () {});
            raf = requestAnimationFrame(loop);
          })
          .catch(function (e) {
            statusEl.textContent = '摄像头不可用：' + (e && e.name || e) + '。可上传二维码图片识别';
            toastMsg('摄像头不可用，可改用上传图片', 'warn');
          });
      } else {
        statusEl.textContent = '当前环境不支持摄像头，请上传二维码图片';
      }
    }

    host.querySelector('[data-cam]').addEventListener('click', function () { startCam(); });

    host.querySelector('[data-file]').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      tearDown();
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          statusEl.textContent = hasJsQR() ? '正在解码…' : '解码库未加载';
          canvas.width = img.width; canvas.height = img.height;
          canvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);
          try {
            const text = decodeFromCanvas(canvas);
            if (text) { statusEl.textContent = '已识别'; handlePayload(text, statusEl, null); }
            else { statusEl.textContent = '未能识别二维码，请换一张清晰的图片'; toastMsg('未能识别二维码', 'warn'); }
          } catch (err) {
            statusEl.textContent = '解码失败：' + err.message;
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    host._scanOff = tearDown;
    startCam();
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal scan-view';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { cleanup(mask); };
    mask.addEventListener('click', function (e) { if (e.target === mask) cleanup(mask); });
    const host = box.querySelector('.oa-container');
    host.style.maxHeight = '80vh'; host.style.overflow = 'auto';
    mount(host);
    function cleanup(m) {
      const h = box.querySelector('.oa-container');
      if (h && h._scanOff) { try { h._scanOff(); } catch (e) {} }
      m.remove();
    }
  }
  function renderInto(el) { if (el) mount(el); }

  window.SecureChatScan = {
    name: '扫一扫', label: '扫一扫', icon: '扫', open: openPanel, renderInto: renderInto,
    decodeImageData: decodeFromCanvas, handleText: handlePayload, present: hasJsQR,
  };

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('scan', { name: '扫一扫', label: '扫一扫', icon: '扫', open: openPanel, renderInto: renderInto });
  }
}());