// module: album (相册) —— 浏览聊天中的图片/视频
(function () {
  'use strict';
  if (window.SecureChatAlbum) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  function _baseUrl() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    return window.SERVER_HOST || location.origin;
  }
  function _bearer() {
    if (window.SecureChatExt && window.SecureChatExt._util) { var t = window.SecureChatExt._util.getToken(); return t ? 'Bearer ' + t : ''; }
    if (window.state && window.state.token) return 'Bearer ' + window.state.token;
    try { var t = localStorage.getItem('sc_token'); return t ? 'Bearer ' + t : ''; } catch (e) { return ''; }
  }

  var items = [];
  var curIdx = 0;

  function loadMedia() {
    return fetch(_baseUrl() + '/api/files', { headers: { Authorization: _bearer() } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        return (d.files || []).filter(function (f) {
          var mime = (f.mime || '').toLowerCase();
          return mime.startsWith('image/') || mime.startsWith('video/');
        }).map(function (f) {
          var isVideo = (f.mime || '').toLowerCase().startsWith('video/');
          return {
            id: f.id,
            name: f.name,
            mime: f.mime,
            isVideo: isVideo,
            url: _baseUrl() + '/api/files/' + f.id,
            peer: f.peer,
            time: f.time,
            size: f.size,
          };
        });
      });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1).toString().padStart(2, '0') + '-' + d.getDate().toString().padStart(2, '0') + ' ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function mount(host) {
    host.className = (host.className || '') + ' album-panel';
    host.innerHTML =
      '<div class="album-head">' +
        '<div class="album-title">相册</div>' +
        '<div class="album-tabs">' +
          '<button class="album-tab active" data-type="all">全部</button>' +
          '<button class="album-tab" data-type="image">图片</button>' +
          '<button class="album-tab" data-type="video">视频</button>' +
        '</div>' +
      '</div>' +
      '<div class="album-grid"><div class="album-loading">加载中…</div></div>';

    var grid = host.querySelector('.album-grid');
    var curType = 'all';

    function render() {
      var list = items;
      if (curType === 'image') list = items.filter(function (i) { return !i.isVideo; });
      if (curType === 'video') list = items.filter(function (i) { return i.isVideo; });

      if (!list.length) {
        grid.innerHTML = '<div class="album-empty">暂无图片或视频<br>在聊天中发送图片/视频后，将自动出现在这里</div>';
        return;
      }

      grid.innerHTML = list.map(function (item, i) {
        var badge = item.isVideo ? '<span class="album-video-badge">▶</span>' : '';
        return '<div class="album-item" data-idx="' + i + '">' +
          '<img src="' + esc(item.url) + '" loading="lazy" onerror="this.style.background=\'#eee\';this.removeAttribute(\'src\')"/>' +
          badge +
        '</div>';
      }).join('');

      grid.querySelectorAll('.album-item').forEach(function (el) {
        el.onclick = function () {
          openViewer(list, Number(el.dataset.idx));
        };
      });
    }

    host.querySelectorAll('.album-tab').forEach(function (tab) {
      tab.onclick = function () {
        host.querySelectorAll('.album-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        curType = tab.dataset.type;
        render();
      };
    });

    loadMedia().then(function (media) {
      items = media;
      render();
    }).catch(function (e) {
      grid.innerHTML = '<div class="album-empty">加载失败：' + esc(e.message) + '</div>';
    });
  }

  function openViewer(list, idx) {
    curIdx = idx;
    var mask = document.createElement('div');
    mask.className = 'modal-mask album-viewer-mask';
    var box = document.createElement('div');
    box.className = 'album-viewer';
    box.innerHTML =
      '<div class="album-viewer-bar">' +
        '<span class="album-viewer-info"></span>' +
        '<button class="album-viewer-close" type="button">&times;</button>' +
      '</div>' +
      '<div class="album-viewer-content"></div>' +
      '<button class="album-viewer-prev" type="button">‹</button>' +
      '<button class="album-viewer-next" type="button">›</button>';
    mask.appendChild(box);
    document.body.appendChild(mask);

    var content = box.querySelector('.album-viewer-content');
    var info = box.querySelector('.album-viewer-info');

    function showItem() {
      var item = list[curIdx];
      if (!item) return;
      if (item.isVideo) {
        content.innerHTML = '<video src="' + esc(item.url) + '" controls autoplay style="max-width:100%;max-height:100%"></video>';
      } else {
        content.innerHTML = '<img src="' + esc(item.url) + '" style="max-width:100%;max-height:100%;object-fit:contain" />';
      }
      info.textContent = (curIdx + 1) + '/' + list.length + ' · ' + esc(item.peer || '') + ' · ' + fmtTime(item.time);
    }

    box.querySelector('.album-viewer-close').onclick = function () { mask.remove(); };
    box.querySelector('.album-viewer-prev').onclick = function (e) {
      e.stopPropagation();
      curIdx = (curIdx - 1 + list.length) % list.length;
      showItem();
    };
    box.querySelector('.album-viewer-next').onclick = function (e) {
      e.stopPropagation();
      curIdx = (curIdx + 1) % list.length;
      showItem();
    };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });

    showItem();
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(680px,94vw);max-height:88vh;overflow:auto';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    mount(box.querySelector('.oa-container'));
  }

  window.SecureChatAlbum = { name: '相册', label: '相册', icon: '相', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('album', { name: '相册', label: '相册', icon: '相', open: openPanel, mount: mount });
  }
}());
