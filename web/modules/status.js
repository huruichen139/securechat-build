/* module: status (worker batch7) */
/* SecureChat 状态（聊天式）Web 模块（独立，不依赖 web/app.js 巨石）
   提供：设置文字+图标状态、自定义背景图、好友头像旁状态徽标、点看留言互动、
   24h 自动消失、状态 feed。
   复用 web/modules/registry.js 的 window.SecureChatExt._util（api/token）。
*/
(function () {
  'use strict';

  const Util = (window.SecureChatExt && window.SecureChatExt._util) ? window.SecureChatExt._util : null;
  const HOST = (window.SERVER_HOST || '').replace(/\/$/, '');

  function api(method, path, body) {
    // 复用 registry 工具（带鉴权），否则回退本地 fetch
    if (Util && typeof Util.api === 'function') return Util.api(method, path, { body });
    return _req(method, path, body);
  }
  async function _req(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = (window.__secureChat && window.__secureChat.token) || localStorage.getItem('sc_token') || '';
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const opt = { method, headers };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(HOST + url, opt);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function toast(msg, kind, ms) {
    if (window.toast && typeof window.toast === 'function') { window.toast(msg, kind, ms); return; }
    try { window.alert(msg); } catch (e) {}
  }

  const ICONS = ['😄', '😴', '🌙', '💼', '🏃', '📚', '🎵', '🍜', '✈️', '❤️', '💪', '🎮', '🧘', '☕', '📱', '🚴'];

  // 状态徽标 DOM：好友头像旁小图标
  function statusBadge(status, size) {
    const span = document.createElement('span');
    span.className = 'sc-status-badge';
    span.setAttribute('data-status', status.text);
    span.textContent = status.icon || '😄';
    if (size) { span.style.width = size + 'px'; span.style.height = size + 'px'; }
    span.style.cssText += ';position:absolute;right:-2px;bottom:-2px;background:' + (status.bgColor || '#07c160') +
      ';border:2px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:' + (size ? (size / 2) : 10) + 'px;width:' + (size || 16) + 'px;height:' + (size || 16) + 'px;';
    return span;
  }

  // 异步：给定一组好友 userId，拉取其状态并绑定徽标到头像元素上
  async function attachBadges(userIds, avatarElsById) {
    try {
      const data = await api('GET', '/api/status/feed');
      const byId = {};
      for (const s of (data.feed || [])) byId[s.userId] = s;
      for (const id of Object.keys(avatarElsById)) {
        const el = avatarElsById[id];
        const s = byId[id];
        if (s && el) {
          const holder = el.parentNode && el.parentNode.style ? el.parentNode : el;
          holder.style.position = 'relative';
          holder.appendChild(statusBadge(s, 16));
        }
      }
      return data;
    } catch (e) { return null; }
  }

  // 面板：设置/查看我的状态 + 好友状态 feed
  function openPanel(containerEl) {
    const container = containerEl || document.createElement('div');
    container.innerHTML = ''; // 清空
    container.classList.add('sc-status-panel');
    let html = '';
    html += '<div class="sc-status-title">我的一天</div>';
    html += '<div id="sc-status-mine" class="sc-status-mine"></div>';
    html += '<div class="sc-status-title">好友状态</div>';
    html += '<div id="sc-status-feed" class="sc-status-feed"></div>';
    container.innerHTML = html;
    _renderMine(container.querySelector('#sc-status-mine'));
    _renderFeed(container.querySelector('#sc-status-feed'));
    return container;
  }

  function _renderMine(el) {
    api('GET', '/api/status/feed').then((data) => {
      const my = data.myStatus;
      if (!my) {
        el.innerHTML = '<div class="sc-status-empty">点击头像设置我的状态，24 小时后自动消失</div>' +
          '<div class="sc-status-icons">' + ICONS.map(i => '<button class="sc-status-icon" data-icon="' + i + '">' + i + '</button>').join('') + '</div>' +
          '<input id="sc-status-text" class="sc-status-input" maxlength="40" placeholder="此刻的想法...">' +
          '<input id="sc-status-bg" type="file" accept="image/*" class="sc-status-file">' +
          '<button id="sc-status-save" class="sc-status-btn">设为状态</button>';
        _bindSetStatus(el);
      } else {
        el.innerHTML = _statusCard(my, true) +
          '<button id="sc-status-clear" class="sc-status-btn sc-status-btn-link">清除状态</button>';
        el.querySelector('#sc-status-clear').addEventListener('click', async () => {
          try { await api('DELETE', '/api/status'); toast('已清除', 'success'); _renderMine(el); } catch (e) { toast(e.message, 'error'); }
        });
      }
    }).catch((e) => { el.textContent = '加载失败：' + e.message; });
  }

  function _bindSetStatus(el) {
    let icon = '😄';
    const icons = el.querySelectorAll('.sc-status-icon');
    icons.forEach((b) => b.addEventListener('click', () => {
      icons.forEach((x) => x.classList.remove('sc-status-icon-active'));
      b.classList.add('sc-status-icon-active');
      icon = b.getAttribute('data-icon');
    }));
    const bgInput = el.querySelector('#sc-status-bg');
    let bgUrl = '';
    bgInput.addEventListener('change', async () => {
      const f = bgInput.files && bgInput.files[0];
      if (!f) return;
      // 复用 /api/media 上传 image（media.js 已提供），得到相对 url
      try {
        const fd = new FormData();
        fd.append('file', f);
        const url = await UploadMedia(f);
        bgUrl = url;
        toast('背景上传成功', 'success');
      } catch (e) { toast('背景上传失败：' + e.message, 'error'); }
    });
    el.querySelector('#sc-status-save').addEventListener('click', async () => {
      const text = (el.querySelector('#sc-status-text').value || '').trim();
      if (!text) return toast('请输入状态内容', 'error');
      try { await api('POST', '/api/status', { text, icon, bgUrl }); toast('已设置', 'success'); _renderMine(el); } catch (e) { toast(e.message, 'error'); }
    });
  }

  // 上传到 /api/media（image），返回相对 url /api/media/:id
  async function UploadMedia(file) {
    const t = (window.__secureChat && window.__secureChat.token) || localStorage.getItem('sc_token') || '';
    const headers = { 'Authorization': 'Bearer ' + t, 'Content-Type': file.type || 'application/octet-stream' };
    const res = await fetch(HOST + '/api/media?name=' + encodeURIComponent(file.name || 'bg') + '&mime=' + encodeURIComponent(file.type || 'image/*'), { method: 'POST', headers, body: file });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || ('上传失败 ' + res.status));
    return data.url || ('/api/media/' + data.id);
  }

  function _statusCard(s, isSelf) {
    const bgSafe = s.bgUrl && /^\/api\/media\//.test(String(s.bgUrl)) ? String(s.bgUrl).replace(/[^\w\-./]/g, '') : '';
    const bg = bgSafe ? 'style="background-image:linear-gradient(rgba(0,0,0,0.35),rgba(0,0,0,0.35)),url(' + HOST + bgSafe + ');background-size:cover"' : 'style="background:#2a9d8f;color:#fff"';
    let html = '<div class="sc-status-card" ' + bg + '>';
    html += '<div class="sc-status-avatar">' + esc((s.user && (s.user.nickname || s.user.username) || '?').charAt(0)) + '</div>';
    html += '<div class="sc-status-icon-big">' + (s.icon || '😄') + '</div>';
    html += '<div class="sc-status-text">' + esc(s.text) + '</div>';
    if (s.messageCount) html += '<div class="sc-status-msgs">' + s.messageCount + ' 条留言</div>';
    if (isSelf) html += '<div class="sc-status-badge-self"><span>状态</span></div>';
    html += '</div>';
    return html;
  }

  function _renderFeed(el) {
    api('GET', '/api/status/feed').then((data) => {
      const feed = data.feed || [];
      if (!feed.length) { el.innerHTML = '<div class="sc-status-empty">还没有好友设置状态</div>'; return; }
      const box = document.createElement('div');
      box.className = 'sc-status-grid';
      feed.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'sc-status-card-wrap';
        card.innerHTML = _statusCard(s, false);
        card.addEventListener('click', () => _openDetail(s.userId));
        box.appendChild(card);
      });
      el.innerHTML = '';
      el.appendChild(box);
    }).catch((e) => { el.textContent = '加载失败：' + e.message; });
  }

  // 点看状态：留言互动
  function _openDetail(userId) {
    api('GET', '/api/status/' + userId + '/messages').then((data) => {
      if (!data || !data.status) { toast('状态已过期', 'warn'); return; }
      const overlay = document.createElement('div');
      overlay.className = 'sc-status-overlay';
      overlay.innerHTML = '<div class="sc-status-modal">' +
        '<div class="sc-status-modal-title">' + esc(data.status.text) + ' <span class="sc-status-close">✕</span></div>' +
        '<div class="sc-status-msgs" id="sc-status-msgs"></div>' +
        '<div class="sc-status-input-row"><input id="sc-status-msg-input" placeholder="留言鼓励一下..."><button id="sc-status-msg-send">发送</button></div>' +
        '</div>';
      document.body.appendChild(overlay);
      const msgsEl = overlay.querySelector('#sc-status-msgs');
      const renderMsgs = () => {
        msgsEl.innerHTML = (data.messages || []).map(m =>
          '<div class="sc-status-msg"><b>' + esc(m.nickname) + ':</b> ' + esc(m.content) + '</div>').join('') || '<div class="sc-status-empty">暂无留言</div>';
      };
      renderMsgs();
      overlay.querySelector('.sc-status-close').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('#sc-status-msg-send').addEventListener('click', async () => {
        const content = overlay.querySelector('#sc-status-msg-input').value.trim();
        if (!content) return toast('请输入留言', 'error');
        try {
          await api('POST', '/api/status/' + userId + '/message', { content });
          overlay.querySelector('#sc-status-msg-input').value = '';
          const d = await api('GET', '/api/status/' + userId + '/messages');
          data.messages = d.messages;
          renderMsgs();
          toast('已留言', 'success');
        } catch (e) { toast(e.message, 'error'); }
      });
    }).catch((e) => toast(e.message, 'error'));
  }

  // 注册特性
  const feature = {
    name: 'status',
    label: '状态',
    icon: '态',
    open: openPanel,
    renderInto: openPanel,
    api,
    attachBadges,
  };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('status', feature);
  }
  window.__scFindFeatureStatus = feature;
})();