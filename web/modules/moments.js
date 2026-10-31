'use strict';
// module: moments —— Web 端「朋友圈」feed（发布 / 点赞 / 评论 / 图片九宫格）
// 发现页此前把「朋友圈」指向 window.SecureChatMomentExt.open()，但该对象只有
// openFilterPanel/openDetail，没有 open()，点击后抛 TypeError 且页面毫无反应。
(function () {
  if (typeof window === 'undefined') return;

  const PAGE_ID = 'momentsPage';
  const util = (window.SecureChatExt && window.SecureChatExt._util) || null;
  let pageEl = null;
  let listEl = null;
  let state = { offset: 0, limit: 20, loading: false, hasMore: true, items: [] };
  let composerEl = null;

  function host() {
    if (util && typeof util.serverHost === 'function') return util.serverHost();
    return window.SERVER_HOST || location.origin;
  }
  function token() {
    if (window.state && window.state.token) return window.state.token;
    try { return localStorage.getItem('sc_token') || ''; } catch (e) { return ''; }
  }
  function myId() {
    if (window.state && window.state.me && window.state.me.id != null) return Number(window.state.me.id);
    try { return Number(localStorage.getItem('sc_myid') || 0) || null; } catch (e) { return null; }
  }
  function toast(msg, kind) {
    if (typeof window.toast === 'function') return window.toast(msg, kind);
    console.log('[moments] ' + msg);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(method, path, body) {
    const opts = { method, headers: { Authorization: 'Bearer ' + token() } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(host() + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
    return data || {};
  }
  function mediaUrl(u) {
    const s = String(u || '');
    if (!s) return '';
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    return host() + (s.charAt(0) === '/' ? s : '/' + s);
  }
  function avatarChar(name) {
    const n = String(name || '?').trim();
    return n ? n.charAt(0).toUpperCase() : '?';
  }
  function timeAgo(ts) {
    const t = Number(ts) || 0;
    if (!t) return '';
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + '天前';
    const d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function ensurePage() {
    if (pageEl && document.body.contains(pageEl)) return pageEl;
    pageEl = document.createElement('div');
    pageEl.id = PAGE_ID;
    pageEl.className = 'wechat-page moments-page';
    pageEl.innerHTML =
      '<div class="page-header moments-header">' +
        '<button class="back-btn" type="button" data-role="back">返回</button>' +
        '<h2>朋友圈</h2>' +
        '<button class="moments-publish-btn" type="button" data-role="publish">发布</button>' +
      '</div>' +
      '<div class="page-body moments-body"><div class="moments-feed" data-role="feed"></div>' +
        '<div class="moments-more" data-role="more" hidden><button type="button" data-role="loadmore">加载更多</button></div>' +
        '<div class="moments-empty" data-role="empty" hidden>还没有动态，点右上角「发布」记录第一条吧</div>' +
      '</div>';
    document.body.appendChild(pageEl);
    listEl = pageEl.querySelector('[data-role="feed"]');
    pageEl.querySelector('[data-role="back"]').onclick = close;
    pageEl.querySelector('[data-role="publish"]').onclick = openComposer;
    pageEl.querySelector('[data-role="loadmore"]').onclick = () => load(false);
    listEl.addEventListener('click', onFeedClick);
    listEl.addEventListener('submit', onFeedSubmit);
    return pageEl;
  }

  function showPage() {
    ensurePage();
    if (typeof window.showMobilePage === 'function') {
      window.showMobilePage(PAGE_ID);
    } else {
      pageEl.classList.add('active');
    }
    const main = document.querySelector('.main');
    if (main) main.style.display = 'none';
    const sb = document.querySelector('.sidebar');
    if (sb && !window.IS_MOBILE) pageEl.style.left = sb.offsetWidth + 'px';
  }

  function close() {
    if (pageEl) pageEl.classList.remove('active');
    const main = document.querySelector('.main');
    if (main) main.style.display = '';
    if (composerEl) { composerEl.remove(); composerEl = null; }
    const tab = document.querySelector('.sidebar-rail .side-tab[data-side="ai"]');
    if (tab) tab.click();
  }

  async function load(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.offset = 0; state.items = []; state.hasMore = true; }
    const emptyEl = pageEl.querySelector('[data-role="empty"]');
    const moreEl = pageEl.querySelector('[data-role="more"]');
    try {
      if (!state.items.length) listEl.innerHTML = '<div class="moments-loading">加载中…</div>';
      const data = await api('GET', '/api/moments?offset=' + state.offset + '&limit=' + state.limit);
      const items = Array.isArray(data.moments) ? data.moments : [];
      state.items = state.items.concat(items);
      state.offset += items.length;
      state.hasMore = !!data.hasMore;
      render();
      emptyEl.hidden = state.items.length > 0;
      moreEl.hidden = !state.hasMore;
    } catch (e) {
      if (!state.items.length) listEl.innerHTML = '<div class="moments-error">' + esc(e.message) + '</div>';
      else toast(e.message, 'error');
    } finally {
      state.loading = false;
    }
  }

  function imageGrid(images) {
    const arr = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [];
    if (!arr.length) return '';
    return '<div class="moments-images n' + arr.length + '">' + arr.map((u) =>
      '<button type="button" class="moments-img" data-role="viewimg" data-src="' + esc(mediaUrl(u)) + '">' +
      '<img src="' + esc(mediaUrl(u)) + '" alt="" loading="lazy"></button>').join('') + '</div>';
  }

  function render() {
    if (!listEl) return;
    const me = myId();
    listEl.innerHTML = state.items.map((m) => {
      const name = m.nickname || m.username || ('用户' + m.userId);
      const liked = !!m.likedByMe;
      const likers = Array.isArray(m.likers) ? m.likers.filter(Boolean) : [];
      const comments = Array.isArray(m.comments) ? m.comments : [];
      return '<article class="moment-card" data-id="' + m.id + '">' +
        '<div class="moment-avatar">' + (m.avatar ? '<img src="' + esc(mediaUrl(m.avatar)) + '" alt="">' : esc(avatarChar(name))) + '</div>' +
        '<div class="moment-main">' +
          '<div class="moment-name">' + esc(name) + '</div>' +
          '<div class="moment-content">' + esc(m.content) + '</div>' +
          imageGrid(m.images) +
          '<div class="moment-foot"><span class="moment-time">' + esc(timeAgo(m.createdAt)) + '</span>' +
            '<button type="button" class="moment-like' + (liked ? ' on' : '') + '" data-role="like">' + (liked ? '取消赞' : '赞') + '</button>' +
            '<button type="button" class="moment-comment-btn" data-role="toggle-comment">评论</button>' +
          '</div>' +
          (likers.length || comments.length ?
            '<div class="moment-social">' +
              (likers.length ? '<div class="moment-likes">' + esc(likers.join('、')) + ' 觉得很赞</div>' : '') +
              (comments.length ? '<div class="moment-comments">' + comments.map((c) =>
                '<div class="moment-comment"><b>' + esc(c.nickname || '用户') + '</b>：' + esc(c.content) + '</div>').join('') + '</div>' : '') +
            '</div>' : '') +
          '<form class="moment-comment-form" data-role="comment-form" hidden>' +
            '<input type="text" maxlength="2000" placeholder="评论…" data-role="comment-input">' +
            '<button type="submit">发送</button>' +
          '</form>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  function findCard(el) {
    const card = el && el.closest ? el.closest('.moment-card') : null;
    return card;
  }

  async function onFeedClick(e) {
    const card = findCard(e.target);
    if (!card) return;
    const id = Number(card.dataset.id);
    const role = e.target.closest('[data-role]');
    if (!role) return;
    const action = role.getAttribute('data-role');
    if (action === 'viewimg') {
      openImageViewer(role.getAttribute('data-src'));
      return;
    }
    if (action === 'like') {
      const item = state.items.find((m) => Number(m.id) === id);
      if (!item) return;
      role.disabled = true;
      try {
        await api('POST', '/api/moments/' + id + '/like', { on: !item.likedByMe });
        item.likedByMe = !item.likedByMe;
        item.likeCount = Math.max(0, (Number(item.likeCount) || 0) + (item.likedByMe ? 1 : -1));
        if (!item.likers) item.likers = [];
        const myName = (window.state && window.state.me && (window.state.me.nickname || window.state.me.username)) || '';
        if (item.likedByMe) { if (myName && item.likers.indexOf(myName) < 0) item.likers.push(myName); }
        else if (myName) { item.likers = item.likers.filter((n) => n !== myName); }
        render();
      } catch (err) { toast(err.message, 'error'); role.disabled = false; }
      return;
    }
    if (action === 'toggle-comment') {
      const form = card.querySelector('[data-role="comment-form"]');
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) { const inp = form.querySelector('[data-role="comment-input"]'); if (inp) inp.focus(); }
    }
  }

  async function onFeedSubmit(e) {
    const form = e.target.closest('[data-role="comment-form"]');
    if (!form) return;
    e.preventDefault();
    const card = findCard(form);
    if (!card) return;
    const id = Number(card.dataset.id);
    const inp = form.querySelector('[data-role="comment-input"]');
    const content = (inp && inp.value || '').trim();
    if (!content) return;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await api('POST', '/api/moments/' + id + '/comment', { content });
      inp.value = '';
      form.hidden = true;
      await load(true);
      toast('评论成功', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openImageViewer(src) {
    if (!src) return;
    const mask = document.createElement('div');
    mask.className = 'moments-viewer';
    mask.innerHTML = '<img src="' + esc(src) + '" alt="">';
    mask.onclick = () => mask.remove();
    document.body.appendChild(mask);
  }

  function openComposer() {
    if (composerEl) return;
    composerEl = document.createElement('div');
    composerEl.className = 'modal-mask';
    composerEl.innerHTML =
      '<div class="modal moments-composer">' +
        '<div class="modal-head"><h3>发表动态</h3><button class="modal-x" type="button" aria-label="关闭">&times;</button></div>' +
        '<textarea class="moments-textarea" maxlength="10000" placeholder="这一刻的想法…"></textarea>' +
        '<div class="moments-picked" data-role="picked"></div>' +
        '<div class="moments-compose-bar">' +
          '<label class="moments-addimg">添加图片<input type="file" accept="image/*" multiple hidden data-role="files"></label>' +
          '<span class="moments-hint">最多 9 张</span>' +
          '<button class="ok" type="button" data-role="send">发表</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(composerEl);
    const ta = composerEl.querySelector('.moments-textarea');
    const picked = composerEl.querySelector('[data-role="picked"]');
    const fileInput = composerEl.querySelector('[data-role="files"]');
    const sendBtn = composerEl.querySelector('[data-role="send"]');
    const pickedUrls = [];
    const closeComposer = () => { composerEl.remove(); composerEl = null; };
    composerEl.querySelector('.modal-x').onclick = closeComposer;
    composerEl.addEventListener('click', (e) => { if (e.target === composerEl) closeComposer(); });
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const f of files) {
        if (pickedUrls.length >= 9) { toast('最多 9 张图片', 'warn'); break; }
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 10 * 1024 * 1024) { toast('单张图片不能超过 10MB', 'warn'); continue; }
        try {
          const res = await fetch(host() + '/api/media?name=' + encodeURIComponent(f.name || 'image') + '&mime=' + encodeURIComponent(f.type), {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/octet-stream' },
            body: f
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '上传失败');
          const u = data.url || data.absolute;
          pickedUrls.push(u);
          const thumb = document.createElement('button');
          thumb.type = 'button';
          thumb.className = 'moments-picked-item';
          thumb.innerHTML = '<img src="' + esc(mediaUrl(u)) + '" alt="">';
          thumb.onclick = () => {
            const i = pickedUrls.indexOf(u);
            if (i >= 0) pickedUrls.splice(i, 1);
            thumb.remove();
          };
          picked.appendChild(thumb);
        } catch (err) { toast('图片上传失败：' + err.message, 'error'); }
      }
    };
    sendBtn.onclick = async () => {
      const content = (ta.value || '').trim();
      if (!content) { toast('说点什么再发布吧', 'warn'); return; }
      sendBtn.disabled = true; sendBtn.textContent = '发布中…';
      try {
        await api('POST', '/api/moments', { content, images: pickedUrls.slice(0, 9) });
        closeComposer();
        await load(true);
        toast('已发布', 'success');
      } catch (err) {
        toast(err.message, 'error');
        sendBtn.disabled = false; sendBtn.textContent = '发表';
      }
    };
    setTimeout(() => ta.focus(), 50);
  }

  function open() {
    showPage();
    load(true);
  }

  const feature = { name: 'moments', label: '朋友圈', icon: '圈', open };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('moments', feature);
  }
  window.SecureChatMoments = feature;
})();
