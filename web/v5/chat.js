/* SecureChat v5 - 登录 / 会话列表 / 聊天 */
(function () {
  'use strict';
  var S = window.SC5;
  var state = S.state;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function avatarNode(name, url, cls) {
    var a = el('div', cls || 'row-avatar');
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      a.appendChild(img);
    } else {
      a.textContent = S.initial(name);
    }
    return a;
  }

  /* ---------------- 登录 ---------------- */
  var authMode = 'login';
  function initAuth() {
    var tabs = document.querySelectorAll('.auth-tab');
    tabs.forEach(function (t) {
      t.onclick = function () {
        authMode = t.dataset.mode;
        tabs.forEach(function (x) { x.classList.toggle('on', x === t); });
        document.querySelectorAll('.reg-only').forEach(function (f) { f.hidden = authMode !== 'register'; });
        S.$('authBtn').textContent = authMode === 'register' ? '注册并登录' : '登录';
      };
    });
    S.$('authBtn').onclick = doAuth;
    S.$('authPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });
  }

  function doAuth() {
    var account = (S.$('authAccount').value || '').trim();
    var password = S.$('authPassword').value || '';
    var err = S.$('authErr');
    err.hidden = true;
    if (!account || !password) { err.textContent = '请输入账号和密码'; err.hidden = false; return; }
    var btn = S.$('authBtn');
    btn.disabled = true;
    var req = authMode === 'register'
      ? S.post('/api/register', { username: account, password: password, nickname: (S.$('authNickname').value || '').trim() || account })
      : S.post('/api/login', { account: account, password: password });
    req.then(function (data) {
      S.saveSession(data.token, data.user || null);
      if (!data.user) return S.get('/api/profile').then(function (p) { return p.user || p; }).catch(function () { return null; });
      return data.user;
    }).then(function (me) {
      if (me) S.saveSession(state.token, me);
      boot();
    }).catch(function (e) {
      err.textContent = e.message || '操作失败';
      err.hidden = false;
    }).finally(function () { btn.disabled = false; });
  }

  /* ---------------- 数据 ---------------- */
  function loadFriends() {
    return S.get('/api/friends').then(function (d) {
      state.friends = (d.friends || []).map(function (f) {
        return {
          id: f.id, name: f.remark || f.nickname || f.username || ('用户' + f.id),
          avatar: f.avatar || '', uid: f.uid || '', online: !!f.online, raw: f
        };
      });
    }).catch(function () { state.friends = []; });
  }
  function loadGroups() {
    return S.get('/api/groups').then(function (d) {
      state.groups = (d.groups || []).map(function (g) {
        return { id: g.id, name: g.name || ('群聊 ' + g.id), avatar: g.avatar || '', memberCount: g.memberCount || 0, ownerId: g.ownerId };
      });
    }).catch(function () { state.groups = []; });
  }
  function loadPreviews() {
    return S.get('/api/conversations/preview').then(function (d) {
      state.previews = d.previews || {};
      var unread = 0;
      Object.keys(state.previews).forEach(function (k) { unread += Number(state.previews[k].unread || 0); });
      state.unread = { total: unread };
      renderList();
    }).catch(function () {});
  }

  function previewText(text) {
    var t = String(text || '');
    if (t.indexOf('__FILE__') === 0) return '[文件]';
    if (/^\[语音消息:[^\]]+\]$/.test(t)) return '[语音]';
    return t.replace(/\s+/g, ' ').slice(0, 60);
  }

  function listItems() {
    var items = [];
    var seen = {};
    state.friends.forEach(function (f) {
      var key = 'f' + f.id;
      seen[key] = 1;
      var pv = state.previews[key] || {};
      items.push({
        key: key, type: 'friend', id: f.id, name: f.name, avatar: f.avatar,
        ts: pv.ts || 0, preview: pv.text ? ((pv.mine ? '我: ' : '') + previewText(pv.text)) : (f.uid ? 'ID: ' + f.uid : ''),
        unread: Number(pv.unread || 0)
      });
    });
    state.groups.forEach(function (g) {
      var key = 'g' + g.id;
      seen[key] = 1;
      var pv = state.previews[key] || {};
      items.push({
        key: key, type: 'group', id: g.id, name: g.name, avatar: g.avatar,
        ts: pv.ts || 0, preview: pv.text ? ((pv.mine ? '我: ' : '') + previewText(pv.text)) : (g.memberCount ? g.memberCount + ' 位成员' : ''),
        unread: Number(pv.unread || 0)
      });
    });
    Object.keys(state.previews).forEach(function (key) {
      if (seen[key]) return;
      var pv = state.previews[key] || {};
      if (!pv.ts) return;
      var isGroup = key.charAt(0) === 'g';
      var id = Number(key.slice(1));
      items.push({
        key: key, type: isGroup ? 'group' : 'friend', id: id,
        name: (isGroup ? '群聊 ' : '用户 ') + id, avatar: '', ts: pv.ts,
        preview: previewText(pv.text), unread: Number(pv.unread || 0)
      });
    });
    items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return items;
  }

  var listFilter = '';
  function renderList() {
    var body = S.$('listBody');
    if (!body) return;
    body.innerHTML = '';
    var items = listItems().filter(function (it) {
      if (!listFilter) return true;
      return (it.name + ' ' + it.preview).toLowerCase().indexOf(listFilter) >= 0;
    });
    if (!items.length) {
      body.appendChild(el('div', 'empty', state.friends.length || state.groups.length ? '没有匹配的会话' : '还没有会话，点击右上角 + 发起聊天'));
      return;
    }
    items.forEach(function (it) {
      var row = el('div', 'row' + (isActive(it) ? ' on' : ''));
      row.dataset.key = it.key;
      row.appendChild(avatarNode(it.name, it.avatar));
      var main = el('div', 'row-main');
      var top = el('div', 'row-top');
      top.appendChild(el('div', 'row-name', it.name));
      if (it.ts) top.appendChild(el('div', 'row-time', S.fmtTime(it.ts)));
      main.appendChild(top);
      main.appendChild(el('div', 'row-preview', it.preview || ''));
      row.appendChild(main);
      if (it.unread) row.appendChild(el('div', 'row-badge', it.unread > 99 ? '99+' : String(it.unread)));
      row.onclick = function () { openChat(it.type, it.id); };
      body.appendChild(row);
    });
  }
  function isActive(it) {
    return it.type === 'group' ? state.activeGroup === it.id : (state.activePeer === it.id && !state.activeGroup);
  }

  /* ---------------- 会话 ---------------- */
  function openChat(type, id) {
    if (type === 'group') { state.activeGroup = id; state.activePeer = null; }
    else { state.activePeer = id; state.activeGroup = null; }
    document.querySelector('.main-pane').classList.add('open');
    S.$('welcome').hidden = true;
    S.$('conversation').hidden = false;
    var item = listItems().filter(function (x) { return x.type === type && x.id === id; })[0] || {};
    S.$('convTitle').textContent = item.name || (type === 'group' ? '群聊 ' + id : '用户 ' + id);
    S.$('convSub').textContent = type === 'group' ? (item.preview && /位成员/.test(item.preview) ? item.preview : '群聊') : '';
    S.$('noticeBar').hidden = true;
    renderList();
    var box = S.$('messages');
    box.innerHTML = '<div class="empty">加载中…</div>';
    var req = type === 'group'
      ? S.get('/api/groups/' + id + '/messages?limit=60')
      : S.get('/api/history/' + id + '?limit=60');
    req.then(function (d) {
      var msgs = (d.messages || []).slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      box.innerHTML = '';
      renderMessages(msgs, true);
      scrollBottom(true);
      markRead(type, id);
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'empty', '加载失败：' + (e.message || '未知错误')));
    });
    if (type === 'group') loadGroupInfo(id);
    S.$('input').focus();
  }

  function loadGroupInfo(id) {
    S.get('/api/groups/' + id).then(function (d) {
      var g = (d && d.group) || {};
      if (g.displayName) S.$('convTitle').textContent = g.displayName;
      if (g.members) S.$('convSub').textContent = g.members.length + ' 位成员';
      var ann = g.announcement && g.announcement.content;
      if (ann) { S.$('noticeBar').textContent = ann; S.$('noticeBar').hidden = false; }
    }).catch(function () {});
  }

  function markRead(type, id) {
    if (type === 'group') S.wsSend(window.P.C_GROUP_READ, { groupId: id });
    else S.wsSend(window.P.C_READ, { peerId: id });
    var key = (type === 'group' ? 'g' : 'f') + id;
    if (state.previews[key]) state.previews[key].unread = 0;
    renderList();
  }

  function msgSenderName(m, type) {
    if (m.mine || m.from === (state.me && state.me.id)) return '我';
    if (type === 'friend') return S.$('convTitle').textContent;
    var u = state.users.filter(function (x) { return x.id === m.from; })[0];
    return (u && (u.nickname || u.username)) || ('用户 ' + m.from);
  }

  function linkify(text) {
    return S.esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function bubbleContent(m) {
    var content = String(m.content || '');
    if (m.recalled) return '<span style="opacity:.6">消息已撤回</span>';
    if (content.indexOf('__FILE__') === 0) {
      var meta = {};
      try { meta = JSON.parse(content.slice(8)); } catch (e) { meta = {}; }
      var url = (state.activeGroup ? '/api/group-files/' : '/api/files/') + encodeURIComponent(meta.id || '');
      var mime = String(meta.mime || '');
      if (/^image\//.test(mime)) {
        return '<img src="' + S.esc(url) + '" alt="' + S.esc(meta.name || '图片') + '" loading="lazy">';
      }
      if (/^video\//.test(mime)) {
        return '<video src="' + S.esc(url) + '" controls preload="metadata"></video>';
      }
      if (/^audio\//.test(mime)) {
        return '<audio src="' + S.esc(url) + '" controls style="max-width:240px"></audio>';
      }
      return '<div class="file-card"><div class="file-ico">文</div><div><div class="file-name">' + S.esc(meta.name || '文件') +
        '</div><div class="file-size">' + S.humanSize(meta.size) + '</div></div></div>';
    }
    var voice = /^\[语音消息:([^\]]+)\]$/.exec(content);
    if (voice) return '<audio src="' + S.esc('/api/files/' + voice[1]) + '" controls style="max-width:220px"></audio>';
    return linkify(content);
  }

  function renderMessages(msgs, reset) {
    var box = S.$('messages');
    if (reset) box.innerHTML = '';
    var lastDay = '';
    var meId = state.me && state.me.id;
    msgs.forEach(function (m) {
      var day = S.dayLabel(m.createdAt);
      if (day !== lastDay) {
        lastDay = day;
        box.appendChild(el('div', 'day-sep', day));
      }
      var mine = m.mine != null ? !!m.mine : (m.from === meId);
      var row = el('div', 'msg' + (mine ? ' mine' : ''));
      row.dataset.id = m.id || '';
      row.appendChild(avatarNode(msgSenderName(m, state.activeGroup ? 'group' : 'friend'), '', 'msg-avatar'));
      var body = el('div', 'msg-body');
      var meta = el('div', 'msg-meta');
      meta.appendChild(el('span', '', mine ? '我' : msgSenderName(m, state.activeGroup ? 'group' : 'friend')));
      meta.appendChild(el('span', '', S.fmtTime(m.createdAt)));
      body.appendChild(meta);
      var bubble = el('div', 'bubble');
      bubble.innerHTML = bubbleContent(m);
      body.appendChild(bubble);
      row.appendChild(body);
      box.appendChild(row);
    });
  }

  function appendMessage(m) {
    var box = S.$('messages');
    if (!box || S.$('conversation').hidden) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    renderMessages([m], false);
    if (nearBottom) scrollBottom();
  }
  function scrollBottom(instant) {
    var box = S.$('messages');
    if (!box) return;
    if (instant) box.scrollTop = box.scrollHeight;
    else box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }

  /* ---------------- 发送 ---------------- */
  function currentTarget() {
    if (state.activeGroup) return { type: 'group', id: state.activeGroup };
    if (state.activePeer) return { type: 'friend', id: state.activePeer };
    return null;
  }

  function sendText(text) {
    var target = currentTarget();
    if (!target) { S.toast('请先选择聊天对象', 'warn'); return; }
    var content = String(text || '').trim();
    if (!content) return;
    var cmid = 'c_' + S.uid8();
    var optimistic = { id: 'local_' + cmid, from: state.me && state.me.id, content: content, createdAt: Date.now(), clientMsgId: cmid, mine: true };
    appendMessage(optimistic);
    scrollBottom();
    var req = target.type === 'group'
      ? S.post('/api/groups/' + target.id + '/messages', { content: content, clientMsgId: cmid })
      : S.post('/api/messages', { to: target.id, content: content, clientMsgId: cmid });
    req.then(function (d) {
      var row = document.querySelector('.msg[data-id="local_' + cmid + '"]');
      if (row && d.message) row.dataset.id = d.message.id;
    }).catch(function (e) {
      var row = document.querySelector('.msg[data-id="local_' + cmid + '"]');
      if (row) row.style.opacity = '.5';
      S.toast('发送失败：' + (e.message || '网络错误'), 'error');
    });
    var key = (target.type === 'group' ? 'g' : 'f') + target.id;
    state.previews[key] = { text: content, mine: true, ts: Date.now() };
    renderList();
  }

  function sendFile(file) {
    var target = currentTarget();
    if (!target) { S.toast('请先选择聊天对象', 'warn'); return; }
    var qs = '?name=' + encodeURIComponent(file.name || 'file') + '&mime=' + encodeURIComponent(file.type || 'application/octet-stream');
    var url = target.type === 'group'
      ? '/api/groups/' + target.id + '/files' + qs
      : '/api/files?to=' + encodeURIComponent(target.id) + '&name=' + encodeURIComponent(file.name || 'file') + '&mime=' + encodeURIComponent(file.type || 'application/octet-stream');
    S.toast('正在上传 ' + (file.name || '文件') + '…');
    S.api('POST', url, file, { raw: true, headers: { 'Content-Type': 'application/octet-stream' } }).then(function (d) {
      var meta = '__FILE__' + JSON.stringify({ id: d.id, name: d.name || file.name, size: d.size || file.size, mime: d.mime || file.type });
      sendText(meta);
    }).catch(function (e) { S.toast('上传失败：' + (e.message || '网络错误'), 'error'); });
  }

  /* ---------------- 接收 ---------------- */
  function handleIncoming(m) {
    var fromId = m.from;
    var mine = state.me && fromId === state.me.id;
    var peerId = mine ? m.to : fromId;
    var key = 'f' + peerId;
    var active = !state.activeGroup && state.activePeer === peerId;
    if (active) {
      appendMessage(Object.assign({ mine: mine }, m));
      if (!mine) markRead('friend', peerId);
      return;
    }
    var pv = state.previews[key] || {};
    pv.text = m.content;
    pv.ts = m.createdAt || Date.now();
    pv.mine = mine;
    if (!mine) pv.unread = Number(pv.unread || 0) + 1;
    state.previews[key] = pv;
    renderList();
  }

  function handleGroupIncoming(m) {
    var gid = m.groupId || (m.group && m.group.id);
    if (!gid) return;
    var mine = state.me && m.from === state.me.id;
    var key = 'g' + gid;
    if (state.activeGroup === gid) {
      appendMessage(Object.assign({ mine: mine }, m));
      if (!mine) markRead('group', gid);
      return;
    }
    var pv = state.previews[key] || {};
    pv.text = m.content;
    pv.ts = m.createdAt || Date.now();
    pv.mine = mine;
    if (!mine) pv.unread = Number(pv.unread || 0) + 1;
    state.previews[key] = pv;
    renderList();
  }

  /* ---------------- 交互绑定 ---------------- */
  function bindConversation() {
    var input = S.$('input');
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      var target = currentTarget();
      if (target && target.type === 'friend') S.wsSend(window.P.C_TYPING, { to: target.id });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        var text = input.value;
        input.value = '';
        input.style.height = 'auto';
        sendText(text);
      }
    });
    S.$('sendBtn').onclick = function () {
      var text = input.value;
      input.value = '';
      input.style.height = 'auto';
      sendText(text);
    };
    S.$('fileBtn').onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.onchange = function () { if (inp.files && inp.files[0]) sendFile(inp.files[0]); };
      inp.click();
    };
    S.$('emojiBtn').onclick = function () { S.toast('表情面板开发中', 'info'); };
    S.$('convBack').onclick = function () {
      document.querySelector('.main-pane').classList.remove('open');
      state.activePeer = null; state.activeGroup = null;
      renderList();
    };
    S.$('convMoreBtn').onclick = openChatMenu;
    S.$('listSearch').addEventListener('input', function (e) {
      listFilter = (e.target.value || '').trim().toLowerCase();
      renderList();
    });
    S.$('newChatBtn').onclick = openNewChat;
    S.$('convSearchBtn').onclick = function () { S.toast('会话内搜索开发中', 'info'); };
  }

  function openChatMenu() {
    var target = currentTarget();
    if (!target) return;
    var box = S.openModal('会话设置', '<div class="card" id="chatMenuCard"></div>', { className: 'narrow' });
    var card = box.querySelector('#chatMenuCard');
    var actions = [
      ['查看资料', function () { S.closeModal(); S.toast('资料页开发中', 'info'); }],
      ['清空聊天记录', function () {
        S.confirm('清空聊天记录', '删除后不可恢复，仅影响你自己').then(function (ok) {
          if (!ok) return;
          S.api('DELETE', '/api/history/' + target.id).then(function () {
            S.$('messages').innerHTML = '';
            S.toast('已清空', 'success');
          }).catch(function (e) { S.toast(e.message, 'error'); });
        });
      }],
      ['退出', function () { S.closeModal(); S.logout(); }]
    ];
    actions.forEach(function (a) {
      var cell = el('div', 'cell');
      cell.appendChild(el('div', 'cell-main', a[0]));
      cell.appendChild(el('div', 'cell-arrow', '›'));
      cell.onclick = a[1];
      card.appendChild(cell);
    });
  }

  function openNewChat() {
    var box = S.openModal('发起聊天', '<div id="newChatBody"></div>');
    var body = box.querySelector('#newChatBody');
    var search = el('input', 'search');
    search.placeholder = '搜索联系人';
    search.style.width = '100%';
    search.style.marginBottom = '10px';
    body.appendChild(search);
    var list = el('div');
    body.appendChild(list);
    function render() {
      var q = (search.value || '').trim().toLowerCase();
      list.innerHTML = '';
      var people = state.friends.filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) >= 0; });
      if (!people.length) { list.appendChild(el('div', 'empty', '没有联系人，先去通讯录添加')); return; }
      people.forEach(function (f) {
        var cell = el('div', 'cell');
        cell.appendChild(avatarNode(f.name, f.avatar, 'cell-ico'));
        var main = el('div', 'cell-main');
        main.appendChild(el('div', 'cell-title', f.name));
        cell.appendChild(main);
        cell.onclick = function () { S.closeModal(); openChat('friend', f.id); };
        list.appendChild(cell);
      });
    }
    search.oninput = render;
    render();
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    S.$('authView').hidden = true;
    S.$('chatView').hidden = false;
    window.SC5.pagesInit();
    Promise.all([loadFriends(), loadGroups()]).then(function () {
      renderList();
      loadPreviews();
      S.get('/api/users').then(function (d) { state.users = d.users || []; }).catch(function () {});
    });
    S.wsConnect();
  }

  S.on(window.P.S_MSG, handleIncoming);
  S.on(window.P.S_GROUP_MSG, handleGroupIncoming);
  S.on(window.P.S_MSG_RECALL, function (p) {
    var row = document.querySelector('.msg[data-id="' + (p && (p.id || p.messageId)) + '"]');
    if (row) { var b = row.querySelector('.bubble'); if (b) b.innerHTML = '<span style="opacity:.6">消息已撤回</span>'; }
  });
  S.on(window.P.S_MSG_EDIT, function (p) {
    var row = document.querySelector('.msg[data-id="' + (p && p.id) + '"] .bubble');
    if (row && p && p.content != null) row.textContent = p.content;
  });
  S.on(window.P.S_TYPING, function (p) {
    var t = S.$('typing');
    if (!t || !p) return;
    t.textContent = '对方正在输入…';
    t.hidden = false;
    clearTimeout(state.typingTimers.t);
    state.typingTimers.t = setTimeout(function () { t.hidden = true; }, 2500);
  });
  S.on(window.P.S_KICKED, function () { S.toast('账号已在其他设备登录', 'warn'); });

  window.SC5.boot = boot;
  window.SC5.openChat = openChat;
  window.SC5.renderList = renderList;
  window.SC5.appendMessage = appendMessage;
  window.SC5.sendText = sendText;
  window.SC5.loadFriends = loadFriends;
  window.SC5.loadGroups = loadGroups;
  window.SC5.loadPreviews = loadPreviews;
  window.SC5.listItems = listItems;
  window.SC5.avatarNode = avatarNode;
  window.SC5.el = el;

  document.addEventListener('DOMContentLoaded', function () {
    initAuth();
    bindConversation();
    if (state.token) {
      S.get('/api/friends').then(function () { boot(); }).catch(function () { S.saveSession('', null); });
    }
  });
})();
