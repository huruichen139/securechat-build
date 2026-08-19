// module: search (搜一搜) —— 全局搜索：好友/群/聊天记录/文件
(function () {
  'use strict';
  if (window.SecureChatSearch) return;

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

  function searchAll(kw) {
    var results = { friends: [], groups: [], messages: [], files: [] };
    var promises = [];

    if (window.state && window.state.friends) {
      results.friends = window.state.friends.filter(function (f) {
        var n = (f.nickname || f.username || '').toLowerCase();
        return n.indexOf(kw.toLowerCase()) >= 0;
      }).slice(0, 10);
    }

    if (window.state && window.state.groups) {
      results.groups = window.state.groups.filter(function (g) {
        var n = (g.name || '').toLowerCase();
        return n.indexOf(kw.toLowerCase()) >= 0;
      }).slice(0, 10);
    }

    if (kw.trim()) {
      promises.push(
        fetch(_baseUrl() + '/api/search/messages?q=' + encodeURIComponent(kw), { headers: { Authorization: _bearer() } })
          .then(function (r) { return r.json(); })
          .then(function (d) { results.messages = (d.messages || []).slice(0, 20); })
          .catch(function () {})
      );
      promises.push(
        fetch(_baseUrl() + '/api/files', { headers: { Authorization: _bearer() } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            results.files = (d.files || []).filter(function (f) {
              return (f.name || '').toLowerCase().indexOf(kw.toLowerCase()) >= 0;
            }).slice(0, 10);
          })
          .catch(function () {})
      );
    }

    return Promise.all(promises).then(function () { return results; });
  }

  function mount(host) {
    host.className = (host.className || '') + ' search-panel';
    host.innerHTML =
      '<div class="search-head">' +
        '<div class="search-title">搜一搜</div>' +
        '<div class="search-bar-wrap">' +
          '<input type="text" class="search-input" placeholder="搜索好友、群聊、聊天记录、文件…" />' +
          '<button class="search-btn">搜索</button>' +
        '</div>' +
      '</div>' +
      '<div class="search-results"></div>';

    var input = host.querySelector('.search-input');
    var btn = host.querySelector('.search-btn');
    var resultsEl = host.querySelector('.search-results');

    function doSearch() {
      var kw = input.value.trim();
      if (!kw) { resultsEl.innerHTML = '<div class="search-hint">输入关键词开始搜索</div>'; return; }
      resultsEl.innerHTML = '<div class="search-loading">搜索中…</div>';
      searchAll(kw).then(function (results) {
        renderResults(resultsEl, results, kw);
      });
    }

    btn.onclick = doSearch;
    input.onkeydown = function (e) { if (e.key === 'Enter') doSearch(); };

    resultsEl.innerHTML = '<div class="search-hint">输入关键词开始搜索<br>可搜索：好友昵称、群聊名称、聊天记录、文件名</div>';
  }

  function renderResults(el, results, kw) {
    var html = '';
    var hasResult = false;

    if (results.friends && results.friends.length) {
      hasResult = true;
      html += '<div class="search-group"><div class="search-group-title">好友</div>';
      results.friends.forEach(function (f) {
        html += '<div class="search-item" data-type="friend" data-id="' + f.id + '">' +
          '<div class="search-item-avatar">' + (f.avatar ? '<img src="' + esc(f.avatar) + '">' : esc((f.nickname || '?')[0])) + '</div>' +
          '<div class="search-item-info"><div class="search-item-name">' + esc(f.nickname || f.username) + '</div>' +
          '<div class="search-item-sub">微信号：' + esc(f.uid || f.username || '') + '</div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    if (results.groups && results.groups.length) {
      hasResult = true;
      html += '<div class="search-group"><div class="search-group-title">群聊</div>';
      results.groups.forEach(function (g) {
        html += '<div class="search-item" data-type="group" data-id="' + g.id + '">' +
          '<div class="search-item-avatar">群</div>' +
          '<div class="search-item-info"><div class="search-item-name">' + esc(g.name) + '</div>' +
          '<div class="search-item-sub">' + (g.memberCount || g.members || 0) + ' 人</div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    if (results.messages && results.messages.length) {
      hasResult = true;
      html += '<div class="search-group"><div class="search-group-title">聊天记录</div>';
      results.messages.forEach(function (m) {
        var content = m.content || '';
        var idx = content.toLowerCase().indexOf(kw.toLowerCase());
        if (idx >= 0) {
          var start = Math.max(0, idx - 20);
          var end = Math.min(content.length, idx + kw.length + 20);
          content = (start > 0 ? '…' : '') + content.substring(start, end) + (end < content.length ? '…' : '');
        }
        html += '<div class="search-item" data-type="message" data-peer="' + m.peerId + '">' +
          '<div class="search-item-info"><div class="search-item-text">' + esc(content) + '</div>' +
          '<div class="search-item-sub">' + esc(m.peerName || '') + ' · ' + esc(fmtTime(m.createdAt)) + '</div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    if (results.files && results.files.length) {
      hasResult = true;
      html += '<div class="search-group"><div class="search-group-title">文件</div>';
      results.files.forEach(function (f) {
        html += '<div class="search-item" data-type="file" data-id="' + f.id + '">' +
          '<div class="search-item-icon">文件</div>' +
          '<div class="search-item-info"><div class="search-item-name">' + esc(f.name) + '</div>' +
          '<div class="search-item-sub">' + esc(f.peer || '') + ' · ' + Math.round((f.size || 0) / 1024) + 'KB</div></div>' +
        '</div>';
      });
      html += '</div>';
    }

    if (!hasResult) {
      html = '<div class="search-empty">没有找到"' + esc(kw) + '"相关结果</div>';
    }

    html += '<div class="search-bing">' +
      '<div class="search-bing-title">百度搜索</div>' +
      '<a class="search-bing-link" href="https://www.baidu.com/s?wd=' + encodeURIComponent(kw) + '" target="_blank" rel="noopener">' +
      '在百度中搜索「' + esc(kw) + '」</a></div>' +
      '<div class="search-bing">' +
      '<div class="search-bing-title">Bing 搜索</div>' +
      '<a class="search-bing-link" href="https://www.bing.com/search?q=' + encodeURIComponent(kw) + '" target="_blank" rel="noopener">' +
      '在 Bing 中搜索「' + esc(kw) + '」</a></div>';

    el.innerHTML = html;

    el.querySelectorAll('.search-item').forEach(function (item) {
      item.onclick = function () {
        var type = item.dataset.type;
        var mask = el.closest('.modal-mask');
        var jump = function (fn) {
          if (mask) mask.remove();
          if (typeof fn === 'function') fn();
        };
        if (type === 'friend') {
          jump(function () { if (window.selectPeer) window.selectPeer(parseInt(item.dataset.id, 10)); });
        } else if (type === 'group') {
          jump(function () { if (window.selectGroup) window.selectGroup(parseInt(item.dataset.id, 10)); });
        } else if (type === 'message') {
          jump(function () { if (window.selectPeer) window.selectPeer(parseInt(item.dataset.peer, 10)); });
        } else if (type === 'file') {
          window.open(_baseUrl() + '/api/files/' + item.dataset.id, '_blank');
        }
      };
    });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(620px,94vw);max-height:88vh;overflow:auto';
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

  window.SecureChatSearch = { name: '搜一搜', label: '搜一搜', icon: '搜', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('search', { name: '搜一搜', label: '搜一搜', icon: '搜', open: openPanel, mount: mount });
  }
}());
