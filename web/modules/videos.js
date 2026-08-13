// module: videos (worker batch4) —— 视频号：上传/信息流/评论/点赞/收藏/转发
// 依赖全局：state(serverHost/token)、toast、escapeHtml、openModal（web/app.js）
'use strict';
(function () {
  if (window.SecureChatVideos) return;
  window.SecureChatVideos = { name: '视频号', label: '视频号', icon: '视', open: openPanel, renderInto: renderInto };

  function base() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    if (window.state && state.serverHost) return state.serverHost;
    return window.SERVER_HOST || location.origin;
  }
  function authHeaders() {
    let t = '';
    if (window.SecureChatExt && window.SecureChatExt._util) t = window.SecureChatExt._util.getToken();
    else if (window.state && state.token) t = state.token;
    else { try { t = localStorage.getItem('sc_token'); } catch (e) {} }
    return { 'Authorization': t ? 'Bearer ' + t : '' };
  }
  function fetchJson(path, opts) {
    opts = opts || {};
    const h = authHeaders();
    const cfg = { method: opts.method || 'GET', headers: h };
    let body = null;
    if (opts.json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    else if (opts.raw) { body = opts.raw; if (opts.mime) h['Content-Type'] = opts.mime; }
    if (body != null) cfg.body = body;
    return fetch(base() + path, cfg)
      .then(function (r) { if (r.status === 401) throw new Error('未登录或登录已过期'); return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) throw new Error(d.error); return d; });
  }
  function esc(s) { return escapeHtml ? escapeHtml(s) : String(s == null ? '' : s); }
  function fmt(ts) { if (!ts) return ''; const d = new Date(Number(ts)); const p = n => (n < 10 ? '0' + n : '' + n); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  function mount(host) {
    host.innerHTML = '';
    host.className = host.className + ' vid-panel';
    host.innerHTML =
      '<div class="vid-head">' +
        '<div class="vid-title">视频号</div>' +
        '<button class="vid-tab on" data-feed="pub">推荐</button>' +
        '<button class="vid-tab" data-feed="follow">关注</button>' +
        '<button class="vid-tab" data-feed="fav">收藏</button>' +
        '<button class="vid-btn" data-pub>发布视频</button>' +
      '</div>' +
      '<div class="vid-grid"><div class="vid-loading">加载中…</div></div>';
    const grid = host.querySelector('.vid-grid');
    let cur = 'pub';
    host.querySelectorAll('[data-feed]').forEach(function (b) {
      b.onclick = function () { cur = b.dataset.feed; host.querySelectorAll('[data-feed]').forEach(x => x.classList.toggle('on', x === b)); loadFeed(cur, grid, host); };
    });
    host.querySelector('[data-pub]').onclick = function () { publishForm(host, grid); };
    loadFeed('pub', grid, host);
  }

  function loadFeed(kind, grid, host) {
    const path = kind === 'follow' ? '/api/videos/following' : (kind === 'fav' ? '/api/videos/me/favorites' : '/api/videos/feed');
    fetchJson(path).then(function (d) {
      const list = d.videos || [];
      if (!list.length) { grid.innerHTML = '<div class="vid-empty">' + (kind === 'follow' ? '关注流还没有视频' : (kind === 'fav' ? '还没有收藏的视频' : '还没有视频')) + '</div>'; return; }
      grid.innerHTML = list.map(videoCard).join('');
      grid.querySelectorAll('.vid-card').forEach(function (c) {
        c.onclick = function () { detail(Number(c.dataset.id), grid, host); };
      });
      grid.querySelectorAll('[data-like]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); toggleLike(b); }; });
      grid.querySelectorAll('[data-fav]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); toggleFav(b); }; });
      grid.querySelectorAll('[data-share]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); share(b); }; });
      grid.querySelectorAll('[data-cmt]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); comment(Number(b.dataset.cmt), grid, host); }; });
    }).catch(function (e) { grid.innerHTML = '<div class="vid-err">' + esc(e.message) + '</div>'; });
  }

  function mediaUrl(u) { return u ? (u.indexOf('/') === 0 ? base() + u : u) : ''; }

  function videoCard(v) {
    const src = mediaUrl(v.url);
    return '<div class="vid-card" data-id="' + v.id + '">' +
      '<div class="vid-player">' +
        (src ? '<video preload="metadata" muted controls playsinline src="' + esc(src) + '" type="video/' + esc(v.fileType || 'mp4') + '"></video>' : '<div class="vid-novideo">[未加载视频]</div>') +
      '</div>' +
      '<div class="vid-info">' +
        '<div class="vid-author"><span class="vid-ava">' + esc((v.nickname || '?')[0] || '?') + '</span>' + esc(v.nickname || v.username || '') + '</div>' +
        '<div class="vid-desc">' + esc(v.title) + '</div>' +
        (v.content ? '<div class="vid-content">' + esc(v.content) + '</div>' : '') +
        '<div class="vid-ops">' +
          '<button data-like data-on="' + (v.likedByMe ? '1' : '0') + '">' + (v.likedByMe ? '♥' : '♡') + ' ' + (v.likeCount || 0) + '</button>' +
          '<button data-cmt="' + v.id + '">💬 ' + (v.commentCount || 0) + '</button>' +
          '<button data-fav data-on="' + (v.favoritedByMe ? '1' : '0') + '">' + (v.favoritedByMe ? '★' : '☆') + ' ' + (v.favoriteCount || 0) + '</button>' +
          '<button data-share="' + v.id + '">↗ ' + (v.shareCount || 0) + '</button>' +
          '<span class="vid-time">' + fmt(v.createdAt) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function publishForm(host, grid) {
    // 先选视频文件，再填标题/描述
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/webm,video/*';
    input.onchange = function () {
      const f = input.files && input.files[0];
      if (!f) return;
      if (!window.openModal) { toastMsg('当前页面不支持发布', 'warn'); return; }
      const name = f.name || ('video-' + Date.now() + '.mp4');
      toastMsg('上传中，请稍候…', 'info');
      fetchJson('/api/media?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(f.type || 'video/mp4'), { method: 'POST', raw: f, mime: f.type || 'video/mp4' })
        .then(function (up) {
          const url = up.url;
          window.openModal('发布视频', [
            { key: 'title', label: '标题' },
            { key: 'cover', label: '封面图地址（可选）' },
            { key: 'content', label: '描述（可选）' },
          ], function (out, close) {
            if (!out.title) { toastMsg('标题不能为空'); return; }
            fetchJson('/api/videos/publish', { method: 'POST', json: { title: out.title, content: out.content, cover: out.cover, url: url } })
              .then(function () { close(); toastMsg('发布成功'); loadFeed('pub', grid, host); })
              .catch(function (e) { toastMsg(e.message, 'error'); });
          });
        })
        .catch(function (e) { toastMsg('上传失败：' + e.message, 'error'); });
    };
    input.click();
  }

  function toggleLike(btn) {
    const id = Number(btn.closest('.vid-card').dataset.id);
    const on = btn.dataset.on !== '1';
    fetchJson('/api/videos/' + id + '/like', { method: 'POST', json: { on: on } })
      .then(function (d) { btn.dataset.on = on ? '1' : '0'; btn.textContent = (on ? '♥ ' : '♡ ') + (d.likeCount || 0); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function toggleFav(btn) {
    const id = Number(btn.closest('.vid-card').dataset.id);
    const on = btn.dataset.on !== '1';
    fetchJson('/api/videos/' + id + '/favorite', { method: 'POST', json: { on: on } })
      .then(function (d) { btn.dataset.on = on ? '1' : '0'; btn.textContent = (on ? '★ ' : '☆ ') + (d.favoriteCount || 0); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function share(btn) {
    const id = Number(btn.dataset.share);
    if (navigator.share) {
      navigator.share({ title: '分享视频', url: location.href }).catch(function () {});
    }
    fetchJson('/api/videos/' + id + '/share', { method: 'POST' })
      .then(function (d) { btn.textContent = '↗ ' + (d.shareCount || 0); toastMsg('已转发'); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function comment(id, grid, host) {
    const c = window.prompt('评论：');
    if (!c || !c.trim()) return;
    fetchJson('/api/videos/' + id + '/comment', { method: 'POST', json: { content: c.trim() } })
      .then(function () { toastMsg('评论成功'); reloadCard(grid, host); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function reloadCard(grid, host) {
    const card = grid.querySelector('.vid-card');
    if (!card) { loadFeed('pub', grid, host); return; }
    detail(Number(card.dataset.id), grid, host, true);
  }

  function detail(id, grid, host, backToList) {
    fetchJson('/api/videos/' + id).then(function (d) {
      const v = d.video || {};
      const cmts = v.comments || [];
      grid.innerHTML =
        '<div class="vid-back"><button data-back>← 返回</button><span class="vid-title2">' + esc(v.title) + '</span></div>' +
        '<div class="vid-detail">' +
          '<div class="vid-player">' + (mediaUrl(v.url) ? '<video controls autoplay muted playsinline src="' + esc(mediaUrl(v.url)) + '" type="video/' + esc(v.fileType || 'mp4') + '"></video>' : '<div class="vid-novideo">[未加载视频]</div>') + '</div>' +
          '<div class="vid-author">' + esc(v.nickname || v.username || '') + ' · ' + fmt(v.createdAt) + '</div>' +
          '<div class="vid-desc">' + esc(v.title) + '</div>' +
          (v.content ? '<div class="vid-content">' + esc(v.content) + '</div>' : '') +
          '<div class="vid-ops">' +
            '<button data-like data-on="' + (v.likedByMe ? '1' : '0') + '">' + (v.likedByMe ? '♥' : '♡') + ' ' + (v.likeCount || 0) + '</button>' +
            '<button data-fav data-on="' + (v.favoritedByMe ? '1' : '0') + '">' + (v.favoritedByMe ? '★' : '☆') + ' ' + (v.favoriteCount || 0) + '</button>' +
            '<button data-share="' + v.id + '">↗ ' + (v.shareCount || 0) + '</button>' +
            '<span class="vid-time">播放 ' + (v.playCount || 0) + '</span>' +
          '</div>' +
          '<div class="vid-cmt-title">评论（' + (cmts.length) + '）</div>' +
          '<div class="vid-cmts">' + (cmts.length ? cmts.map(function (c) {
            return '<div class="vid-cmt"><b>' + esc(c.nickname || c.username || ('用户' + c.userId)) + '</b> ' + esc(c.content) + '</div>';
          }).join('') : '<div class="vid-empty">还没有评论</div>') + '</div>' +
          '<div class="vid-composer"><textarea data-cmt placeholder="说点什么…"></textarea><button data-send>发送</button></div>' +
        '</div>';
      grid.querySelector('[data-back]').onclick = function () { loadFeed('pub', grid, host); };
      grid.querySelector('[data-like]').onclick = function () { toggleLike(grid.querySelector('[data-like]')); };
      grid.querySelector('[data-fav]').onclick = function () { toggleFav(grid.querySelector('[data-fav]')); };
      grid.querySelector('[data-share]').onclick = function () { share(grid.querySelector('[data-share]')); };
      grid.querySelector('[data-send]').onclick = function () {
        const val = grid.querySelector('[data-cmt]').value.trim();
        if (!val) { toastMsg('评论不能为空'); return; }
        fetchJson('/api/videos/' + id + '/comment', { method: 'POST', json: { content: val } })
          .then(function () { toastMsg('评论成功'); detail(id, grid, host); })
          .catch(function (e) { toastMsg(e.message, 'error'); });
      };
    }).catch(function (e) { grid.innerHTML = '<div class="vid-err">' + esc(e.message) + '</div>'; });
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal vid-view';
    const host = document.createElement('div');
    host.className = 'vid-container';
    box.appendChild(host);
    mask.appendChild(box);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
  }
  function renderInto(el) { if (el) mount(el); }

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('videos', { name: '视频号', label: '视频号', icon: '视', open: openPanel, renderInto: renderInto });
  }
}());