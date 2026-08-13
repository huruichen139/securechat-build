// module: live (worker batch4) —— 直播：开播/进房看播/弹幕聊天室/回放
// 降级方案：主播提供 HLS/RTMP 拉流地址（streamUrl），否则为“纯文字+聊天室”；弹幕走轮询。
// 依赖全局：state(serverHost/token)、toast、escapeHtml、openModal
'use strict';
(function () {
  if (window.SecureChatLive) return;
  window.SecureChatLive = { name: '直播', label: '直播', icon: '直', open: openPanel, renderInto: renderInto };

  function base() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    if (window.state && state.serverHost) return state.serverHost;
    return window.SERVER_HOST || location.origin;
  }
  function fetchJson(path, opts) {
    opts = opts || {};
    let t = '';
    if (window.SecureChatExt && window.SecureChatExt._util) t = window.SecureChatExt._util.getToken();
    else if (window.state && state.token) t = state.token;
    else { try { t = localStorage.getItem('sc_token'); } catch (e) {} }
    const h = { 'Authorization': t ? 'Bearer ' + t : '' };
    const cfg = { method: opts.method || 'GET', headers: h };
    let body = null;
    if (opts.json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (body != null) cfg.body = body;
    return fetch(base() + path, cfg)
      .then(function (r) { if (r.status === 401) throw new Error('未登录或登录已过期'); return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) throw new Error(d.error); return d; });
  }
  function esc(s) { return escapeHtml ? escapeHtml(s) : String(s == null ? '' : s); }
  function fmt(ts) { if (!ts) return ''; const d = new Date(Number(ts)); const p = n => (n < 10 ? '0' + n : '' + n); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }
  function mediaUrl(u) { return u ? (u.indexOf('/') === 0 ? base() + u : u) : ''; }

  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function mount(host) {
    host.innerHTML = '';
    host.className = host.className + ' live-panel';
    host.innerHTML =
      '<div class="live-head">' +
        '<div class="live-title">直播</div>' +
        '<button class="live-btn" data-start>开播</button>' +
        '<button class="live-btn" data-refresh>刷新</button>' +
        '<button class="live-btn" data-fav>我的收藏</button>' +
      '</div>' +
      '<div class="live-list"><div class="live-loading">加载中…</div></div>';
    const list = host.querySelector('.live-list');
    host.querySelector('[data-refresh]').onclick = function () { loadRooms(list); };
    host.querySelector('[data-start]').onclick = function () { startForm(); };
    host.querySelector('[data-fav]').onclick = function () { myFav(list); };
    loadRooms(list);
  }

  function loadRooms(list) {
    fetchJson('/api/live').then(function (d) {
      const rooms = d.rooms || [];
      if (!rooms.length) { list.innerHTML = '<div class="live-empty">当前没有直播</div>'; return; }
      list.innerHTML = rooms.map(function (r) {
        const on = r.status === 'live';
        return '<div class="live-card" data-id="' + r.id + '">' +
          '<div class="live-badge ' + (on ? 'live' : 'end') + '">' + (on ? '● 直播中' : '已结束') + '</div>' +
          '<div class="live-title2">' + esc(r.title) + '</div>' +
          '<div class="live-sub">主播：' + esc(r.hostNickname || '') + ' · 观看 ' + (r.viewerCount || 0) + ' · ' + fmt(r.startedAt) + '</div>' +
          (r.status === 'ended' && r.replayUrl ? '<a class="live-replay" data-replay="' + esc(r.replayUrl) + '" href="javascript:void(0)">▶ 回放</a>' : '') +
        '</div>';
      }).join('');
      list.querySelectorAll('.live-card').forEach(function (c) {
        c.onclick = function () { enterRoom(Number(c.dataset.id), list); };
      });
      list.querySelectorAll('[data-replay]').forEach(function (a) {
        a.onclick = function (e) { e.stopPropagation(); window.open(mediaUrl(a.dataset.replay), '_blank'); };
      });
    }).catch(function (e) { list.innerHTML = '<div class="live-err">' + esc(e.message) + '</div>'; });
  }

  function myFav(list) {
    fetchJson('/api/live/me/favorites').then(function (d) {
      const rooms = d.rooms || [];
      list.innerHTML = '<div class="live-back"><button data-back>← 返回</button><span>我的收藏</span></div>';
      list.innerHTML += (rooms.length ? rooms.map(function (r) {
        return '<div class="live-card" data-id="' + r.id + '"><div class="live-badge end">' + (r.status === 'live' ? '● 直播中' : '已结束') + '</div><div class="live-title2">' + esc(r.title) + '</div></div>';
      }).join('') : '<div class="live-empty">还没有收藏</div>');
      if (list.querySelector('[data-back]')) list.querySelector('[data-back]').onclick = function () { loadRooms(list); };
      list.querySelectorAll('.live-card').forEach(function (c) { c.onclick = function () { enterRoom(Number(c.dataset.id), list); }; });
    }).catch(function (e) { list.innerHTML = '<div class="live-err">' + esc(e.message) + '</div>'; });
  }

  function startForm() {
    if (!window.openModal) { toastMsg('当前页面不支持开播', 'warn'); return; }
    window.openModal('开播', [
      { key: 'title', label: '直播间标题' },
      { key: 'streamUrl', label: '拉流地址（HLS .m3u8 / RTMP，可留空=纯聊天室）' },
      { key: 'cover', label: '封面图地址（可选）' },
    ], function (out, close) {
      if (!out.title) { toastMsg('请填写标题'); return; }
      fetchJson('/api/live/start', { method: 'POST', json: { title: out.title, streamUrl: out.streamUrl, cover: out.cover } })
        .then(function (d) { close(); toastMsg('开播成功'); openRoom(d.room, null, true); })
        .catch(function (e) { toastMsg(e.message, 'error'); });
    });
  }

  function enterRoom(id, list) {
    fetchJson('/api/live/room/' + id).then(function (d) { openRoom(d.room, list, false); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function openRoom(room, backFn, isHost) {
    stopPoll();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal live-view';
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { stopPoll(); mask.remove(); };
    mask.appendChild(box);
    mask.addEventListener('click', function (e) { if (e.target === mask) { stopPoll(); mask.remove(); } });
    document.body.appendChild(mask);

    const src = mediaUrl(room.streamUrl);
    const onAir = room.status === 'live';
    box.innerHTML =
      '<div class="live-room-head">' + esc(room.title) + ' <span class="live-badge ' + (onAir ? 'live' : 'end') + '">' + (onAir ? '直播中' : '已结束') + '</span></div>' +
      '<div class="live-video">' +
        (src ? '<video controls autoplay muted playsinline src="' + esc(src) + '"></video>' : '<div class="vid-novideo">' + (onAir ? '主播未配置视频流，本直播为文字 + 聊天室模式' : '回放地址未配置') + '</div>') +
      '</div>' +
      '<div class="live-ops">' +
        '<button data-like data-on="' + (room.likedByMe ? '1' : '0') + '">' + (room.likedByMe ? '♥' : '♡') + ' ' + (room.likeCount || 0) + '</button>' +
        '<button data-fav data-on="' + (room.favoritedByMe ? '1' : '0') + '">' + (room.favoritedByMe ? '★' : '☆') + ' ' + (room.favoriteCount || 0) + '</button>' +
        (isHost || (backFn && backFn.dataHost) ? '<button data-end>结束直播</button>' : '') +
        '<span class="live-viewers">观看 ' + (room.viewerCount || 0) + '</span>' +
      '</div>' +
      '<div class="live-chat-box">' +
        '<div class="live-chats"></div>' +
        '<div class="live-composer">' +
          (onAir ? '<input data-chat placeholder="发一条弹幕…" maxlength="300" /><button data-send>发送</button>' : '<span class="live-notice">直播已结束，可查看回放</span>') +
        '</div>' +
      '</div>';

    const chatsEl = box.querySelector('.live-chats');
    let since = 0;
    function renderChats(rows) {
      const div = document.createElement('div');
      div.innerHTML = rows.map(function (c) {
        return '<div class="live-chat"><b>' + esc(c.nickname || c.username || ('用户' + c.userId)) + '：</b>' + esc(c.content) + '</div>';
      }).join('');
      chatsEl.appendChild(div);
      chatsEl.scrollTop = chatsEl.scrollHeight;
    }
    function poll() {
      fetchJson('/api/live/room/' + room.id + '/chat?since=' + since)
        .then(function (d) {
          const rows = d.chats || [];
          if (rows.length) { since = (d.serverTime || 0); renderChats(rows); }
        })
        .catch(function (err) { /* 轮询失败静默，网络恢复后自动续上 */ if (err.message && err.message.indexOf('未登录') === 0) stopPoll(); });
    }
    if (onAir) { poll(); pollTimer = setInterval(poll, 2500); }

    box.querySelector('[data-send]').onclick = function () {
      const v = box.querySelector('[data-chat]').value.trim();
      if (!v) { toastMsg('弹幕不能为空'); return; }
      fetchJson('/api/live/room/' + room.id + '/chat', { method: 'POST', json: { content: v } })
        .then(function () { box.querySelector('[data-chat]').value = ''; if (pollTimer && since) poll(); })
        .catch(function (e) { toastMsg(e.message, 'error'); });
    };
    box.querySelector('[data-like]').onclick = function () { toggleLike(box.querySelector('[data-like]'), room.id); };
    box.querySelector('[data-fav]').onclick = function () { toggleFav(box.querySelector('[data-fav]'), room.id); };
    const endBtn = box.querySelector('[data-end]');
    if (endBtn) endBtn.onclick = function () { endLive(room.id, box); };

    if (onAir && box.querySelector('[data-chat]')) box.querySelector('[data-chat]').addEventListener('keydown', function (e) { if (e.key === 'Enter') box.querySelector('[data-send]').click(); });
  }

  function toggleLike(btn, id) {
    const on = btn.dataset.on !== '1';
    fetchJson('/api/live/room/' + id + '/like', { method: 'POST', json: { on: on } })
      .then(function (d) { btn.dataset.on = on ? '1' : '0'; btn.textContent = (on ? '♥ ' : '♡ ') + (d.likeCount || 0); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function toggleFav(btn, id) {
    const on = btn.dataset.on !== '1';
    fetchJson('/api/live/room/' + id + '/favorite', { method: 'POST', json: { on: on } })
      .then(function (d) { btn.dataset.on = on ? '1' : '0'; btn.textContent = (on ? '★ ' : '☆ ') + (d.favoriteCount || 0); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function endLive(id, box) {
    const replay = window.prompt('回放地址（HLS 或 /api/media/...，可留空）：');
    fetchJson('/api/live/end', { method: 'POST', json: { roomId: id, replayUrl: replay || '' } })
      .then(function () { toastMsg('已结束直播'); stopPoll(); const head = box.querySelector('.live-room-head'); if (head) head.innerHTML = head.innerHTML.replace('live-badge live', 'live-badge end'); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal live-view';
    const host = document.createElement('div');
    host.className = 'live-container';
    box.appendChild(host);
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { stopPoll(); mask.remove(); };
    mask.appendChild(box);
    mask.addEventListener('click', function (e) { if (e.target === mask) { stopPoll(); mask.remove(); } });
    document.body.appendChild(mask);
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
  }
  function renderInto(el) { if (el) mount(el); }

  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('live', { name: '直播', label: '直播', icon: '直', open: openPanel, renderInto: renderInto });
  }
}());