/* module: favorites (worker batch7) */
/* SecureChat 收藏（我的收藏）Web 模块（独立，不依赖 web/app.js 巨石）
   提供：收藏文字/图片/文件/聊天记录/链接到分类收藏夹，标签、批量整理、搜索，
   发送时从收藏选图文转发入聊。
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
  function _patch(method, path, body) {
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

  const KindLabel = { text: '文字', image: '图片', file: '文件', message: '聊天记录', link: '链接', moment: '朋友圈' };

  // 收藏入口：提供「新增收藏」快捷（从当前选中/输入组装）
  const quickSaveApi = {
    text(text, classifierId, tags) { return api('POST', '/api/favorites/items', { kind: 'text', data: { text }, classifierId, tags }); },
    link(url, title, classifierId, tags) { return api('POST', '/api/favorites/items', { kind: 'link', data: { url, title }, classifierId, tags }); },
    image(url, classifierId, tags) { return api('POST', '/api/favorites/items', { kind: 'image', data: { url }, classifierId, tags }); },
    message(content, classifierId, tags) { return api('POST', '/api/favorites/items', { kind: 'message', data: { content }, classifierId, tags }); },
    moment(content, classifierId, tags) { return api('POST', '/api/favorites/items', { kind: 'moment', data: { content }, classifierId, tags }); },
  };

  function openPanel(containerEl) {
    const container = containerEl || document.createElement('div');
    container.innerHTML = '';
    container.classList.add('sc-fav-panel');
    let html = '';
    html += '<div class="sc-fav-toolbar">';
    html += '<div class="sc-fav-classifiers"><button class="sc-fav-cfg sc-fav-cfg-active" data-id="">全部</button><span id="sc-fav-cfg-list"></span></div>';
    html += '<div class="sc-fav-actions">';
    html += '<button id="sc-fav-newcfg" class="sc-fav-btn">+ 收藏夹</button>';
    html += '<input id="sc-fav-search" class="sc-fav-search" placeholder="搜索收藏...">';
    html += '<button id="sc-fav-add" class="sc-fav-btn sc-fav-btn-primary">+ 收藏</button>';
    html += '</div></div>';
    html += '<div id="sc-fav-tags" class="sc-fav-tags"></div>';
    html += '<div id="sc-fav-items" class="sc-fav-items"></div>';
    container.innerHTML = html;
    const state = { classifierId: null, tag: '', keyword: '' };

    container.querySelector('#sc-fav-cfg-list').innerHTML = '';
    _loadClassifiers(container, state);
    _loadTags(container);
    _loadItems(container, state);

    container.querySelector('#sc-fav-newcfg').addEventListener('click', () => _newClassifier(container, state));
    container.querySelector('#sc-fav-add').addEventListener('click', () => _newItem(container, state));
    container.querySelector('#sc-fav-search').addEventListener('input', (e) => {
      state.keyword = e.target.value.trim();
      _loadItems(container, state);
    });
    return container;
  }

  async function _loadClassifiers(container, state) {
    try {
      const d = await api('GET', '/api/favorites/classifiers');
      const wrap = container.querySelector('#sc-fav-cfg-list');
      wrap.innerHTML = (d.classifiers || []).map(f =>
        '<button class="sc-fav-cfg ' + (state.classifierId === f.id ? 'sc-fav-cfg-active' : '') + '" data-id="' + f.id + '">' + esc(f.icon) + ' ' + esc(f.name) + (f.count ? '(' + f.count + ')' : '') + '</button>').join('');
      wrap.querySelectorAll('.sc-fav-cfg').forEach((b) => b.addEventListener('click', () => {
        wrap.querySelectorAll('.sc-fav-cfg').forEach((x) => x.classList.remove('sc-fav-cfg-active'));
        b.classList.add('sc-fav-cfg-active');
        state.classifierId = b.getAttribute('data-id') ? Number(b.getAttribute('data-id')) : null;
        _loadItems(container, state);
      }));
    } catch (e) { toast(e.message, 'error'); }
  }

  async function _loadTags(container) {
    try {
      const d = await api('GET', '/api/favorites/tags');
      const el = container.querySelector('#sc-fav-tags');
      if (!(d.tags || []).length) { el.innerHTML = ''; return; }
      el.innerHTML = '<span class="sc-fav-tag-label">标签:</span> ' +
        d.tags.map(t => '<button class="sc-fav-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>').join('');
      el.querySelectorAll('.sc-fav-tag').forEach((b) => b.addEventListener('click', () => {
        state.tag = state.tag === b.getAttribute('data-tag') ? '' : b.getAttribute('data-tag');
        _loadItems(container, state);
        container.querySelectorAll('.sc-fav-tag').forEach((x) => x.classList.toggle('sc-fav-tag-active', x.getAttribute('data-tag') === state.tag));
      }));
    } catch (e) { /* ignore */ }
  }

  async function _loadItems(container, state) {
    const el = container.querySelector('#sc-fav-items');
    const q = { limit: '100' };
    if (state.classifierId) q.classifierId = String(state.classifierId);
    if (state.tag) q.tag = state.tag;
    if (state.keyword) q.q = state.keyword;
    try {
      const query = Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
      const d = await api('GET', '/api/favorites/items' + (query ? '?' + query : ''));
      const items = d.items || [];
      if (!items.length) { el.innerHTML = '<div class="sc-fav-empty">暂无收藏</div>'; return; }
      el.innerHTML = items.map(it => _itemCard(it, container, state)).join('');
      el.querySelectorAll('.sc-fav-item').forEach((card) => {
        card.querySelector('.sc-fav-item-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = Number(card.getAttribute('data-id'));
          try { await api('DELETE', '/api/favorites/items/' + id); _loadItems(container, state); toast('已删除', 'success'); } catch (err) { toast(err.message, 'error'); }
        });
        card.querySelector('.sc-fav-item-fwd').addEventListener('click', (e) => { e.stopPropagation(); _forwardItem(card.getAttribute('data-id')); });
        card.querySelector('.sc-fav-item-tag').addEventListener('click', (e) => { e.stopPropagation(); _editItem(container, state, card); });
      });
    } catch (e) { el.innerHTML = '<div class="sc-fav-error">加载失败：' + esc(e.message) + '</div>'; }
  }

  function _itemContent(it) {
    const d = it.data || {};
    switch (it.kind) {
      case 'image': return '<div class="sc-fav-image-wrap">' + (d.url ? '<img loading="lazy" src="' + HOST + d.url + '">' : '<span>图片</span>') + '</div>';
      case 'link': return '<div class="sc-fav-link">[链接] ' + esc(d.title || d.url || '') + '</div>';
      case 'file': return '<div class="sc-fav-file">[文件] ' + esc(d.name || 'file') + '</div>';
      case 'moment': return '<div class="sc-fav-moment">' + esc(d.content || '') + '</div>';
      case 'message': return '<div class="sc-fav-message">[评论] ' + esc(d.content || '') + '</div>';
      default: return '<div class="sc-fav-text">' + esc(d.text || '') + '</div>';
    }
  }

  function _itemCard(it, container, state) {
    let html = '<div class="sc-fav-item" data-id="' + it.id + '" data-kind="' + it.kind + '">';
    html += '<div class="sc-fav-item-body">' + _itemContent(it) + '</div>';
    html += '<div class="sc-fav-item-meta">';
    html += '<span class="sc-fav-kind">' + (KindLabel[it.kind] || it.kind) + '</span>';
    if (it.classifierName) html += '<span class="sc-fav-cls">' + esc(it.classifierIcon || '') + ' ' + esc(it.classifierName) + '</span>';
    const tags = it.tags || [];
    html += tags.map(t => '<span class="sc-fav-tag-mini">#' + esc(t) + '</span>').join('');
    html += '</div>';
    html += '<div class="sc-fav-item-ops">';
    html += '<button class="sc-fav-item-btn sc-fav-item-fwd">转发</button>';
    html += '<button class="sc-fav-item-btn sc-fav-item-tag">整理</button>';
    html += '<button class="sc-fav-item-btn sc-fav-item-del">删除</button>';
    html += '</div></div>';
    return html;
  }

  // 转发入聊：选择好友会话
  async function _forwardItem(itemId) {
    try {
      const friends = await api('GET', '/api/friends');
      const list = friends.friends || [];
      if (!list.length) return toast('暂无可转发的好友', 'error');
      const names = list.map(u => u.nickname || u.username);
      const choice = window.prompt('选择转发给（请输入好友昵称，从：' + names.join('，') + '）', list[0] && (list[0].nickname || list[0].username));
      if (!choice) return;
      const target = list.find(u => (u.nickname || u.username) === choice) || list.find(u => String(u.id) === String(choice));
      if (!target) return toast('未找到该好友', 'error');
      await api('POST', '/api/favorites/items/' + itemId + '/forward', { to: target.id });
      toast('已转发给 ' + (target.nickname || target.username), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function _editItem(container, state, card) {
    const id = Number(card.getAttribute('data-id'));
    api('GET', '/api/favorites/classifiers').then((cd) => {
      const tagNames = card.querySelectorAll('.sc-fav-tag-mini');
      const curTags = Array.from(tagNames).map(t => t.textContent.replace(/^#/, ''));
      const clist = cd.classifiers || [];
      const name = String(curTags.join(',')).trim();
      const tagsInput = window.prompt('编辑标签（逗号分隔）', name);
      if (tagsInput === null) return;
      const tags = tagsInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      let clsId = null;
      if (clist.length) {
        const options = clist.map(c => c.name).join('，');
        const varCls = window.prompt('选择收藏夹（逗号隔开多个人间序号不适用，直接键入收藏夹名称或留空）', '');
        if (varCls === null) return;
        if (varCls.trim()) {
          const found = clist.find(c => c.name === varCls.trim());
          if (found) clsId = found.id;
        }
      }
      _patch('/api/favorites/items/' + id, { tags, classifierId: clsId }).then(() => {
        _loadItems(container, state); _loadTags(container);
      }).catch((e) => toast(e.message, 'error'));
    }).catch(() => {
      // 无收藏夹也可改标签
      const name = Array.from(card.querySelectorAll('.sc-fav-tag-mini')).map(t => t.textContent.replace(/^#/, '')).join(',');
      const tagsInput = window.prompt('编辑标签（逗号分隔）', name);
      if (tagsInput === null) return;
      const tags = tagsInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      api('PATCH', '/api/favorites/items/' + id, { tags }).then(() => { _loadItems(container, state); _loadTags(container); }).catch((e) => toast(e.message, 'error'));
    });
  }

  function _newClassifier(container, state) {
    const name = window.prompt('新收藏夹名称');
    if (!name || !name.trim()) return;
    api('POST', '/api/favorites/classifiers', { name: name.trim() }).then(() => {
      _loadClassifiers(container, state); toast('已创建', 'success');
    }).catch((e) => toast(e.message, 'error'));
  }

  function _newItem(container, state) {
    api('GET', '/api/favorites/classifiers').then((cd) => {
      const kindChoice = window.prompt('收藏内容类型？(text=文字 image=图片 file=文件 link=链接 message=聊天记录 moment=朋友圈)', 'text');
      if (!kindChoice) return;
      const kindMap = { '文字': 'text', '图片': 'image', '文件': 'file', '链接': 'link', '聊天记录': 'message', '朋友圈': 'moment' };
      const kind = kindMap[kindChoice.trim()] || kindChoice.trim();
      if (!['text', 'image', 'file', 'link', 'message', 'moment'].includes(kind)) return toast('类型无效', 'error');
      let data = {};
      const cls = (cd.classifiers || [])[0];
      const classifierId = cls ? cls.id : null;
      if (kind === 'text' || kind === 'message' || kind === 'moment') {
        const c = window.prompt('内容'); if (c == null) return; data = { text: c, content: c };
      } else if (kind === 'link') {
        const u = window.prompt('链接 URL'); if (u == null) return;
        const t = window.prompt('标题', u); data = { url: u, title: t || u };
      } else if (kind === 'image') {
        const u = window.prompt('图片地址'); if (u == null) return; data = { url: u };
      } else if (kind === 'file') {
        const n = window.prompt('文件名称'); if (n == null) return; data = { name: n, url: '' };
      }
      const tagsStr = window.prompt('标签(逗号分隔)', '');
      const tags = (tagsStr || '').split(/[,，]/).map(t => t.trim()).filter(Boolean);
      api('POST', '/api/favorites/items', { kind, data, classifierId, tags }).then(() => {
        _loadItems(container, state); _loadTags(container); toast('已收藏', 'success');
      }).catch((e) => toast(e.message, 'error'));
    }).catch((e) => toast(e.message, 'error'));
  }

  // 注册特性
  const feature = {
    name: 'favorites',
    label: '收藏',
    icon: '藏',
    open: openPanel,
    renderInto: openPanel,
    api,
    save: quickSaveApi,
    _req,
  };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('favorites', feature);
  }
  window.SecureChatFavorites = feature;
  window.__scFindFeatureFavorites = feature;
})();