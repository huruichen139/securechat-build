// module: oa (worker batch4) —— 公众号：关注/文章/留言/在看
// 依赖全局工具：state(serverHost/token/me)、toast、escapeHtml、t、openModal（web/app.js 已定义）
'use strict';
(function () {
  if (window.SecureChatOa) return;
  window.SecureChatOa = { name: '公众号', label: '公众号', icon: '官', open: openPanel, renderInto: renderInto };

  function _baseUrl() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    if (window.state && state.serverHost) return state.serverHost;
    return window.SERVER_HOST || location.origin;
  }
  function _bearer() {
    if (window.SecureChatExt && window.SecureChatExt._util) { const t = window.SecureChatExt._util.getToken(); return t ? 'Bearer ' + t : ''; }
    if (window.state && state.token) return 'Bearer ' + state.token;
    try { const t = localStorage.getItem('sc_token'); return t ? 'Bearer ' + t : ''; } catch (e) { return ''; }
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    const base = _baseUrl();
    const cfg = {
      method: opts.method || 'GET',
      headers: { 'Authorization': _bearer() },
    };
    let body = null;
    if (opts.json) { cfg.headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (opts.raw) { body = opts.raw; if (opts.mime) cfg.headers['Content-Type'] = opts.mime; }
    if (opts.form) { body = opts.form; }
    const headers = { method: cfg.method, headers: cfg.headers };
    if (body != null) headers.body = body;
    return fetch(base + path, headers)
      .then(function (r) { if (r.status === 401) throw new Error('未登录或登录已过期'); if (r.status === 204) return {}; return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.error) throw new Error(d.error); return d; });
  }
  function esc(s) { return escapeHtml ? escapeHtml(s) : String(s == null ? '' : s); }
  function fmt(ts) { if (!ts) return ''; const d = new Date(Number(ts)); const p = n => (n < 10 ? '0' + n : '' + n); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function toastMsg(msg, kind) { if (window.toast) window.toast(msg, kind || 'info'); }

  function _me() {
    if (window.state && state.me) return state.me;
    let v = null;
    try { const raw = localStorage.getItem('sc_me'); if (raw) { const parsed = JSON.parse(raw); if (parsed && parsed.id != null) v = parsed; } } catch (e) {}
    if (!v && window.SecureChatExt && window.SecureChatExt._util) { const id = window.SecureChatExt._util.getMyId(); if (id) v = { id: id, extra: {} }; }
    if (v) { v.extra = v.extra || {}; try { if (localStorage.getItem('sc_oa_owner') === '1') v.extra.oa = true; } catch (e) {} }
    return v;
  }

  function mount(host) {
    host.innerHTML = '';
    host.className = host.className + ' oa-panel';
    const me = _me();
    const isOaOwner = me && me.extra && me.extra.oa ? true : false;
    host.innerHTML =
      '<div class="oa-head">' +
        '<div class="oa-title">公众号</div>' +
        (isOaOwner ? '<button class="oa-btn" data-act="my">我的公众号</button>' : '<button class="oa-btn" data-act="register">注册公众号</button>') +
        '<button class="oa-btn" data-act="feed">订阅</button>' +
        '<button class="oa-btn" data-act="present">在看</button>' +
      '</div>' +
      '<div class="oa-body"><div class="oa-loading">加载中…</div></div>';
    const body = host.querySelector('.oa-body');
    host.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () { Act[b.dataset.act] ? Act[b.dataset.act](body) : loadAccounts(body); };
    });
    loadAccounts(body);
  }

  var Act = {
    my: function (body) { myAccount(body); },
    register: function (body) { registerForm(body); },
    feed: function (body) { feed(body); },
    present: function (body) { present(body); },
  };

  function registerForm(body) {
    if (!window.openModal) { toastMsg('当前页面不支持此操作', 'warn'); return; }
    window.openModal('注册公众号', [
      { key: 'name', label: '公众号名称', placeholder: '例如：SecureChat 官方' },
      { key: 'intro', label: '简介（可选）' },
    ], function (out, close) {
      if (!out.name) { toastMsg('请填写公众号名称'); return; }
      apiFetch('/api/oa/register', { method: 'POST', json: { name: out.name, intro: out.intro } })
        .then(function (d) { close(); toastMsg('公众号创建成功'); try { localStorage.setItem('sc_oa_owner', '1'); } catch (e) {} accountCards(body, d); })
        .catch(function (e) { toastMsg(e.message, 'error'); });
    });
  }

  function myAccount(body) {
    apiFetch('/api/oa').then(function (d) {
      const mine = (d.accounts || []).find(function (a) { const m = _me(); return a.ownerId && m && a.ownerId === m.id; });
      if (!mine) { toastMsg('你还没有公众号', 'warn'); loadAccounts(body); return; }
      articlesOf(mine, body);
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  function loadAccounts(body) {
    apiFetch('/api/oa').then(function (d) {
      accountCards(body, d);
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }
  function accountCards(body, d) {
    const list = d.accounts || (Array.isArray(d) ? d : []);
    if (!list.length) { body.innerHTML = '<div class="oa-empty">还没有公众号，去注册一个吧</div>'; return; }
    body.innerHTML = '<div class="oa-cards">' + list.map(function (a) {
      const follow = a.following ? '已关注' : '＋关注';
      return '<div class="oa-card" data-id="' + a.id + '">' +
        '<div class="oa-avatar">' + (a.avatar ? '<img src="' + esc(a.avatar) + '" />' : esc((a.name || '?'))[0]) + '</div>' +
        '<div class="oa-meta">' +
          '<div class="oa-name">' + esc(a.name) + '</div>' +
          '<div class="oa-intro">' + esc(a.intro || '') + '</div>' +
          '<div class="oa-sub">文章 ' + (a.articleCount || 0) + '</div>' +
        '</div>' +
        '<button class="oa-follow" data-on="' + (a.following ? '1' : '0') + '">' + follow + '</button>' +
      '</div>';
    }).join('') + '</div>';
    body.querySelectorAll('.oa-card').forEach(function (card) {
      card.onclick = function () { articlesOf({ id: Number(card.dataset.id) }, body); };
    });
    body.querySelectorAll('.oa-follow').forEach(function (btn) {
      btn.onclick = function (e) { e.stopPropagation(); toggleFollow(btn, body); };
    });
  }

  function toggleFollow(btn, body) {
    const id = Number(btn.closest('.oa-card').dataset.id);
    const on = btn.dataset.on !== '1';
    apiFetch('/api/oa/' + id + '/follow', { method: 'POST', json: { on: on } })
      .then(function () { btn.dataset.on = on ? '1' : '0'; btn.textContent = on ? '已关注' : '＋关注'; toastMsg(on ? '已关注' : '已取消关注'); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function articlesOf(account, body) {
    const id = account.id;
    apiFetch('/api/oa/' + id).then(function (ad) {
      apiFetch('/api/oa/' + id + '/articles').then(function (d) {
        const list = d.articles || [];
        body.innerHTML =
          '<div class="oa-back"><button data-act="back">← 返回</button><span class="oa-title2">' + esc(ad.account && ad.account.name || ('公众号#' + id)) + '</span>' +
          (ad.account && ad.account.ownedByMe ? '<button class="oa-btn" data-pub>发文</button>' : '<button class="oa-follow" data-on="' + ((ad.account && ad.account.following) ? '1' : '0') + '">' + ((ad.account && ad.account.following) ? '已关注' : '＋关注') + '</button>') +
          '</div>' +
          (list.length ? '<div class="oa-list">' + list.map(function (a) {
            return '<div class="oa-item" data-id="' + a.id + '">' +
              (a.cover ? '<div class="oa-cover"><img src="' + esc(a.cover) + '" /></div>' : '') +
              '<div class="oa-item-title">' + esc(a.title) + '</div>' +
              '<div class="oa-item-sub">阅读 ' + (a.readCount || 0) + ' · 在看 ' + (a.presentCount || 0) + ' · ' + fmt(a.createdAt) + '</div>' +
            '</div>';
          }).join('') + '</div>' : '<div class="oa-empty">暂无文章</div>');
        if (body.querySelector('[data-pub]')) body.querySelector('[data-pub]').onclick = function (e) { e.stopPropagation(); publishForm(id, body); };
        if (body.querySelector('.oa-follow')) body.querySelector('.oa-follow').onclick = function (e) { e.stopPropagation(); toggleFollow(body.querySelector('.oa-follow'), body); };
        if (body.querySelector('[data-act="back"]')) body.querySelector('[data-act="back"]').onclick = function () { loadAccounts(body); };
        body.querySelectorAll('.oa-item').forEach(function (it) { it.onclick = function () { articleDetail(Number(it.dataset.id), body); }; });
      });
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  function publishForm(accountId, body) {
    if (!window.openModal) { return; }
    window.openModal('发布图文文章', [
      { key: 'title', label: '标题' },
      { key: 'cover', label: '封面图地址（/api/media/...，可留空）' },
      { key: 'content', label: '正文' },
    ], function (out, close) {
      if (!out.title || !out.content) { toastMsg('标题和正文不能为空'); return; }
      apiFetch('/api/oa/' + accountId + '/article', { method: 'POST', json: { title: out.title, content: out.content, cover: out.cover } })
        .then(function () { close(); toastMsg('发布成功'); articlesOf({ id: accountId }, body); })
        .catch(function (e) { toastMsg(e.message, 'error'); });
    });
  }

  function articleDetail(aid, body) {
    apiFetch('/api/articles/' + aid).then(function (d) {
      const a = d.article || {};
      const comments = a.comments || [];
      body.innerHTML =
        '<div class="oa-back"><button data-act="back">← 返回</button></div>' +
        '<div class="oa-article">' +
          (a.cover ? '<div class="oa-cover"><img src="' + esc(a.cover) + '" /></div>' : '') +
          '<h2 class="oa-h2">' + esc(a.title) + '</h2>' +
          '<div class="oa-acc">来自 ' + esc(a.accountName) + ' · ' + fmt(a.createdAt) + '</div>' +
          '<div class="oa-content">' + esc(a.content) + '</div>' +
          '<div class="oa-actions">' +
            '<button class="oa-wow" data-on="' + (a.presented ? '1' : '0') + '">' + (a.presented ? '在看 ✓' : '在看') + ' <span>' + (a.presentCount || 0) + '</span></button>' +
            '<span class="oa-read">阅读 ' + (a.readCount || 0) + '</span>' +
            (a.ownedByMe ? '<span class="oa-host">我是作者</span>' : '') +
          '</div>' +
          '<div class="oa-comment-title">留言（' + (a.commentCount || 0) + '）</div>' +
          '<div class="oa-comments">' + (comments.length ? comments.map(commentHtml).join('') : '<div class="oa-empty">还没有留言</div>') + '</div>' +
          '<div class="oa-composer"><textarea data-cmt placeholder="写下你的留言…"></textarea><button data-send>发送</button></div>' +
        '</div>';
      body.querySelector('[data-act="back"]').onclick = function () { articlesOf({ id: a.accountId }, body); };
      body.querySelector('.oa-wow').onclick = function () { toggleWow(aid, body.querySelector('.oa-wow'), body); };
      body.querySelector('[data-send]').onclick = function () {
        const val = body.querySelector('[data-cmt]').value.trim();
        if (!val) { toastMsg('留言不能为空'); return; }
        apiFetch('/api/articles/' + aid + '/comment', { method: 'POST', json: { content: val } })
          .then(function (d2) { body.querySelector('[data-cmt]').value = ''; rerenderComments(aid, body, d2.comments); toastMsg('留言成功'); })
          .catch(function (e) { toastMsg(e.message, 'error'); });
      };
      body.querySelectorAll('.oa-feature').forEach(function (fb) {
        fb.onclick = function () { featureComment(aid, Number(fb.dataset.cid), body, fb); };
      });
      body.querySelectorAll('.oa-reply').forEach(function (rb) {
        rb.onclick = function () { replyTo(aid, Number(rb.dataset.cid), body); };
      });
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  function commentHtml(c) {
    const isAuthor = !!c.featured;
    return '<div class="oa-comment' + (isAuthor ? ' featured' : '') + '" data-id="' + c.id + '">' +
      '<div class="oa-c-head"><b>' + esc(c.nickname || c.username || ('用户' + c.userId)) + '</b>' + (isAuthor ? '<span class="oa-badge">作者精选</span>' : '') + ' <span class="oa-c-time">' + fmt(c.createdAt) + '</span></div>' +
      (c.replyTo ? '<div class="oa-c-reply">回复 ' + esc('评论#' + c.replyTo) + '</div>' : '') +
      '<div class="oa-c-body">' + esc(c.content) + '</div>' +
      '<div class="oa-c-ops">' +
        '<button class="oa-reply" data-cid="' + c.id + '">回复</button>' +
        '<button class="oa-feature" data-cid="' + c.id + '" data-on="' + (c.featured ? '1' : '0') + '">' + (c.featured ? '取消精选' : '精选') + '</button>' +
      '</div>' +
    '</div>';
  }
  function rerenderComments(aid, body, comments) {
    const host = body.querySelector('.oa-comments');
    if (!host) return;
    host.innerHTML = (comments && comments.length ? comments.map(commentHtml).join('') : '<div class="oa-empty">还没有留言</div>');
    host.querySelectorAll('.oa-feature').forEach(function (fb) { fb.onclick = function () { featureComment(aid, Number(fb.dataset.cid), body, fb); }; });
    host.querySelectorAll('.oa-reply').forEach(function (rb) { rb.onclick = function () { replyTo(aid, Number(rb.dataset.cid), body); }; });
  }
  function featureComment(aid, cid, body, btn) {
    const on = btn.dataset.on !== '1';
    apiFetch('/api/articles/' + aid + '/comment/' + cid + '/feature', { method: 'POST', json: { on: on } })
      .then(function (d) { rerenderComments(aid, body, d.comments); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }
  function replyTo(aid, cid, body) {
    const c = window.prompt('作者回复：');
    if (!c || !c.trim()) return;
    apiFetch('/api/articles/' + aid + '/reply', { method: 'POST', json: { commentId: cid, content: c.trim() } })
      .then(function (d) { rerenderComments(aid, body, d.comments); toastMsg('已回复'); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function toggleWow(aid, btn, body) {
    const on = btn.dataset.on !== '1';
    apiFetch('/api/articles/' + aid + '/wow', { method: 'POST', json: { on: on } })
      .then(function (d) { btn.dataset.on = on ? '1' : '0'; btn.innerHTML = (on ? '在看 ✓' : '在看') + ' <span>' + (d.presentCount || 0) + '</span>'; toastMsg(on ? '已在看' : '取消在看'); })
      .catch(function (e) { toastMsg(e.message, 'error'); });
  }

  function feed(body) {
    apiFetch('/api/oa/feed').then(function (d) {
      const list = d.articles || [];
      body.innerHTML = '<div class="oa-back"><button data-act="back">← 返回</button><span class="oa-title2">订阅信息流</span></div>';
      body.innerHTML += (list.length ? '<div class="oa-list">' + list.map(function (a) {
        return '<div class="oa-item" data-id="' + a.id + '">' +
          (a.cover ? '<div class="oa-cover"><img src="' + esc(a.cover) + '" /></div>' : '') +
          '<div class="oa-item-title">' + esc(a.title) + '</div>' +
          '<div class="oa-item-sub">' + esc(a.accountName) + ' · ' + fmt(a.createdAt) + '</div>' +
        '</div>';
      }).join('') + '</div>' : '<div class="oa-empty">你还没有关注任何公众号</div>');
      body.querySelector('[data-act="back"]').onclick = function () { loadAccounts(body); };
      body.querySelectorAll('.oa-item').forEach(function (it) { it.onclick = function () { articleDetail(Number(it.dataset.id), body); }; });
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  function present(body) {
    apiFetch('/api/oa/me/present').then(function (d) {
      const list = d.articles || [];
      body.innerHTML = '<div class="oa-back"><button data-act="back">← 返回</button><span class="oa-title2">我在看</span></div>';
      body.innerHTML += (list.length ? '<div class="oa-list">' + list.map(function (a) {
        return '<div class="oa-item" data-id="' + a.id + '">' +
          '<div class="oa-item-title">' + esc(a.title) + '</div>' +
          '<div class="oa-item-sub">' + esc(a.accountName) + ' · ' + fmt(a.createdAt) + '</div>' +
        '</div>';
      }).join('') + '</div>' : '<div class="oa-empty">你还没有点过在看</div>');
      body.querySelector('[data-act="back"]').onclick = function () { loadAccounts(body); };
      body.querySelectorAll('.oa-item').forEach(function (it) { it.onclick = function () { articleDetail(Number(it.dataset.id), body); }; });
    }).catch(function (e) { body.innerHTML = '<div class="oa-err">' + esc(e.message) + '</div>'; });
  }

  // 全屏浮层入口（未接入 SecureChatExt 时可用）
  function openPanel() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal oa-view';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    // 右上角关闭
    const closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e2) { if (e2.target === mask) mask.remove(); });
    const host = box.querySelector('.oa-container');
    host.style.maxHeight = '70vh'; host.style.overflow = 'auto';
    mount(host);
  }
  function renderInto(el) { if (el) mount(el); }

  // 若功能中心已加载其注册 API，则注册（健壮降级：不注册也能用）
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('oa', { name: '公众号', label: '公众号', icon: '官', open: openPanel, renderInto: renderInto });
  }
}());