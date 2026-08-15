/* module: moment-ext (worker batch7) */
/* SecureChat 朋友圈增强 Web 模块（独立，不依赖 web/app.js 巨石）
   朋友圈现有主体（发布/feed/点赞/评论）在 app.js 巨石里已实现，
   本模块只增强：点赞列表、评论回复（多层）、来源（网页/小程序）、
   @好友可见性筛选、可仅看/不看某人、朋友新动态红点。
   复用 web/modules/registry.js 的 window.SecureChatExt._util（api/token）。
*/
(function () {
  'use strict';

  const Util = (window.SecureChatExt && window.SecureChatExt._util) ? window.SecureChatExt._util : null;
  const HOST = (window.SERVER_HOST || '').replace(/\/$/, '');

  function api(method, path, body) {
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

  // ---------- 红点 ----------
  // 返回 { count }，可设置到朋友圈入口上
  async function redDot() {
    try { return await api('GET', '/api/moments/ext/reddot'); }
    catch (e) { return { count: 0 }; }
  }
  async function markRedDotRead() {
    try { await api('POST', '/api/moments/ext/reddot/read', {}); } catch (e) { /* ignore */ }
  }

  // ---------- 筛选 ----------
  async function listFilters() { const d = await api('GET', '/api/moments/filters'); return d.filters || []; }
  async function setFilter(targetId, mode) { return api('POST', '/api/moments/filters/' + targetId, { mode }); }
  async function removeFilter(targetId) { return api('DELETE', '/api/moments/filters/' + targetId); }

  // 渲染筛选管理面板
  function openFilterPanel(containerEl) {
    const container = containerEl || document.createElement('div');
    container.innerHTML = '';
    container.classList.add('sc-mext-panel');
    container.innerHTML = '<div class="sc-mext-title">朋友圈可见性</div><div id="sc-mext-filters" class="sc-mext-filters"></div><div class="sc-mext-form"></div>';
    _loadFilters(container);
    return container;
  }

  async function _loadFilters(container) {
    const el = container.querySelector('#sc-mext-filters');
    try {
      const filters = await listFilters();
      const friends = await api('GET', '/api/friends');
      el.innerHTML = '';
      if (!filters.length) el.innerHTML = '<div class="sc-mext-empty">暂无筛选，可从下方添加「仅看/不看」某人</div>';
      filters.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'sc-mext-row';
        row.innerHTML = '<div class="sc-mext-row-avatar">' + esc((f.nickname || '?').charAt(0)) + '</div>' +
          '<div class="sc-mext-row-name">' + esc(f.nickname || '') + ' <span class="sc-mext-kind">' + (f.kind === 'block' ? '不看 TA' : '仅看 TA') + '</span></div>' +
          '<button class="sc-mext-del" data-id="' + f.targetId + '">移除</button>';
        row.querySelector('.sc-mext-del').addEventListener('click', async () => {
          try { await removeFilter(Number(row.querySelector('.sc-mext-del').getAttribute('data-id'))); _loadFilters(container); toast('已移除', 'success'); } catch (e) { toast(e.message, 'error'); }
        });
        el.appendChild(row);
      });
      // 添加控件
      const form = container.querySelector('.sc-mext-form');
      form.innerHTML = '<select id="sc-mext-mode"><option value="block">不看 TA 的朋友圈</option><option value="only">只看到 TA 的朋友圈</option></select>' +
        '<select id="sc-mext-target"><option value="">-- 选择好友 --</option>' + (friends.friends || []).map(u => '<option value="' + u.id + '">' + esc(u.nickname || u.username) + '</option>').join('') + '</select>' +
        '<button id="sc-mext-add" class="sc-mext-add">添加</button>';
      form.querySelector('#sc-mext-add').addEventListener('click', async () => {
        const target = form.querySelector('#sc-mext-target').value;
        const mode = form.querySelector('#sc-mext-mode').value;
        if (!target) return toast('请选择好友', 'error');
        try { await setFilter(Number(target), mode); _loadFilters(container); toast('已设置', 'success'); } catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { el.textContent = '加载失败：' + e.message; }
  }

  // ---------- 动态详情：点赞列表 + 嵌套评论 + 回复 + 来源 ----------
  async function openDetail(momentId, containerEl) {
    let d;
    try { d = await api('GET', '/api/moments/ext/detail/' + momentId); }
    catch (e) { toast(e.message, 'error'); return; }
    const m = d.moment;
    const overlay = document.createElement('div');
    overlay.className = 'sc-mext-overlay';
    const likesHtml = (m.likes && m.likes.length) ? '<div class="sc-mext-likes">赞：' + m.likes.map(l => '<span class="sc-mext-like-name">' + esc(l.nickname) + '</span>').join('、') + '</div>' : '';
    overlay.innerHTML = '<div class="sc-mext-modal">' +
      '<div class="sc-mext-modal-head">' +
      '<div class="sc-mext-author">' + esc(m.user.nickname || (m.user.username || '')) + ' <span class="sc-mext-src">来自' + (m.source === 'miniapp' ? '小程序' : '网页') + '</span></div>' +
      '<span class="sc-mext-close">✕</span></div>' +
      '<div class="sc-mext-body"><p class="sc-mext-content">' + esc(m.content || '') + '</p>' + likesHtml +
      '<div class="sc-mext-comments" id="sc-mext-comments"></div>' +
      '<div class="sc-mext-reply-row"><input id="sc-mext-reply-input" placeholder="回复..."><button id="sc-mext-reply-send">发送</button></div>' +
      '</div></div>';
    document.body.appendChild(overlay);
    const commentsEl = overlay.querySelector('#sc-mext-comments');
    let currentReplyTo = null;

    function renderComments() {
      function cLine(c, depth) {
        const pad = depth > 0 ? ' style="padding-left:' + (depth * 14) + 'px"' : '';
        let html = '<div class="sc-mext-cmt" data-id="' + c.id + '"' + pad + '>' +
          '<b>' + esc(c.nickname) + '</b>: ' + esc(c.content);
        if (c.replyToId) {
          const parent = m.comments.find(x => x.id === c.replyToId);
          if (parent && parent.nickname) html += ' <span class="sc-mext-reply-to">回复 ' + esc(parent.nickname) + '</span>';
        }
        html += ' <button class="sc-mext-cmt-reply" data-id="' + c.id + '">回复</button></div>';
        if (c.replies && c.replies.length) {
          html += c.replies.map((r) => cLine(r, depth + 1)).join('');
        }
        return html;
      }
      commentsEl.innerHTML = (m.comments || []).length ? m.comments.map(c => cLine(c, 0)).join('') : '<div class="sc-mext-empty">暂无评论</div>';
      commentsEl.querySelectorAll('.sc-mext-cmt-reply').forEach((b) => b.addEventListener('click', () => {
        currentReplyTo = Number(b.getAttribute('data-id'));
        const input = overlay.querySelector('#sc-mext-reply-input');
        input.placeholder = '回复评论...';
        input.focus();
      }));
    }
    renderComments();

    overlay.querySelector('.sc-mext-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#sc-mext-reply-send').addEventListener('click', async () => {
      const content = overlay.querySelector('#sc-mext-reply-input').value.trim();
      if (!content) return toast('请输入内容', 'error');
      try {
        await api('POST', '/api/moments/ext/' + m.id + '/reply', { content, replyToId: currentReplyTo || null });
        const nd = await api('GET', '/api/moments/ext/detail/' + m.id);
        m.comments = nd.moment.comments;
        renderComments();
        overlay.querySelector('#sc-mext-reply-input').value = '';
        currentReplyTo = null;
        toast('已回复', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
    return overlay;
  }

  // 点赞列表：只取详情（供挂载）
  const feature = {
    name: 'moment-ext',
    label: '朋友圈增强',
    icon: '圈',
    redDot,
    markRedDotRead,
    listFilters,
    setFilter,
    removeFilter,
    openFilterPanel,
    openDetail,
    api,
  };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('moment-ext', feature);
  }
  window.SecureChatMomentExt = feature;
  window.__scFindFeatureMomentExt = feature;
})();