// module: redpacket —— 微信式红包：发/抢/查/退回
// 独立模块，不依赖 app.js 巨石。复用 SecureChatExt._util（registry.js）做鉴权与请求。
// 功能：
//   - 聊天输入框 "+ 红包" 按钮 → 发红包弹窗（专属/拼手气/普通红包）
//   - 消息中 [红包:<id>] 渲染为微信式红包气泡，点击抢红包/查明细
(function () {
  'use strict';
  if (window.SecureChatRedpacket) return;

  var HOST = String((window.SERVER_HOST || '').replace(/\/$/, ''));

  function _baseUrl() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    return HOST || location.origin;
  }
  function _bearer() {
    if (window.SecureChatExt && window.SecureChatExt._util) { var t = window.SecureChatExt._util.getToken(); return t ? 'Bearer ' + t : ''; }
    if (window.state && window.state.token) return 'Bearer ' + window.state.token;
    try { var t = localStorage.getItem('sc_token'); return t ? 'Bearer ' + t : ''; } catch (e) { return ''; }
  }
  function api(method, path, body) {
    if (window.SecureChatExt && window.SecureChatExt._util && typeof window.SecureChatExt._util.api === 'function') {
      return window.SecureChatExt._util.api(method, path, { body: body });
    }
    var headers = { 'Content-Type': 'application/json', 'Authorization': _bearer() };
    var opt = { method: method.toUpperCase(), headers: headers };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(_baseUrl() + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m, k) { if (window.toast) window.toast(m, k || 'info'); }
  function myId() {
    if (window.SecureChatExt && window.SecureChatExt._util) { var id = window.SecureChatExt._util.getMyId(); if (id) return Number(id); }
    if (window.state && window.state.me) return Number(window.state.me.id);
    try { var u = JSON.parse(localStorage.getItem('sc_me') || 'null'); if (u && u.id) return Number(u.id); } catch (e) {}
    return 0;
  }
  function activePeerId() {
    if (window.state && window.state.activePeer) return Number(window.state.activePeer);
    return 0;
  }
  function activeGroupId() {
    if (window.state && window.state.activeGroup) return Number(window.state.activeGroup);
    return 0;
  }
  function peerName() {
    try {
      var st = window.state || {};
      if (st.activePeerName) return st.activePeerName;
      if (st.activePeer && Array.isArray(st.friends)) {
        for (var i = 0; i < st.friends.length; i++) {
          if (Number(st.friends[i].id) === Number(st.activePeer)) return st.friends[i].nickname || st.friends[i].username || '好友';
        }
      }
    } catch (e) {}
    return '好友';
  }

  var RED_RE = /^\[红包:([0-9a-f]+)\]$/;

  // ============ 发送红包弹窗 ============
  function openSendDialog() {
    var peer = activePeerId();
    var group = activeGroupId();
    if (!peer && !group) { toast('请先选择聊天对象', 'warn'); return; }

    var mask = document.createElement('div');
    mask.className = 'modal-mask rp-mask';
    var box = document.createElement('div');
    box.className = 'rp-send-box';
    box.innerHTML =
      '<div class="rp-send-head">发红包</div>' +
      '<button class="modal-x rp-close" type="button">&times;</button>' +
      '<div class="rp-send-greeting">' + (group ? '发到当前群聊' : '发给' + esc(peerName())) + '</div>' +
      '<div class="rp-send-mode">' +
        (group
          ? '<button class="rp-mode active" data-mode="random">拼手气红包</button><button class="rp-mode" data-mode="average">普通红包</button>'
          : '<button class="rp-mode active" data-mode="single">专属红包</button><button class="rp-mode" data-mode="random">拼手气</button>') +
      '</div>' +
      '<div class="rp-send-field"><label>总金额（元）</label><input type="number" id="rpAmount" min="0.01" step="0.01" placeholder="0.01" /></div>' +
      '<div class="rp-send-field" id="rpCountField" style="display:' + (group ? 'block' : 'none') + '"><label>红包个数</label><input type="number" id="rpCount" min="1" max="100" value="1" /></div>' +
      '<div class="rp-send-field"><label>祝福语</label><input type="text" id="rpGreeting" maxlength="60" value="恭喜发财，大吉大利！" /></div>' +
      '<button class="rp-send-btn" type="button">塞钱进红包</button>';

    mask.appendChild(box);
    document.body.appendChild(mask);

    var mode = group ? 'random' : 'single';

    box.querySelector('.rp-close').onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });

    box.querySelectorAll('.rp-mode').forEach(function (btn) {
      btn.onclick = function () {
        box.querySelectorAll('.rp-mode').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        mode = btn.getAttribute('data-mode');
        var countField = box.querySelector('#rpCountField');
        if (countField) countField.style.display = (mode === 'average' || mode === 'random') ? 'block' : 'none';
      };
    });

    box.querySelector('.rp-send-btn').onclick = function () {
      var amount = parseFloat(box.querySelector('#rpAmount').value);
      if (!Number.isFinite(amount) || amount <= 0) { toast('请输入有效金额', 'warn'); return; }
      var count = parseInt(box.querySelector('#rpCount') && box.querySelector('#rpCount').value, 10) || 1;
      var greeting = (box.querySelector('#rpGreeting').value || '').trim();
      var body = {};
      if (group) { body.groupId = group; } else { body.to = peer; }
      body.amount = amount;
      body.count = count;
      body.mode = mode;
      body.greeting = greeting || '恭喜发财，大吉大利！';
      var btn = this;
      btn.disabled = true; btn.textContent = '发送中…';
      api('POST', '/api/redpacket', body).then(function (d) {
        toast('红包已发出', 'success', 1500);
        mask.remove();
        if (d && d.msgId) {
          // 本地追加一条红包消息
          var content = '[红包:' + 'local' + ']';
          // 通过包装后的 appendMessage 渲染（若已包装会识别，否则回退）
          try {
            if (window.appendMessage) {
              window.appendMessage({ id: d.msgId || ('local-' + Date.now()), from: myId(), to: body.to || body.groupId, content: content, createdAt: Date.now() }, false);
            }
          } catch (e) {}
        }
      }).catch(function (err) {
        toast(err.message || '发送失败', 'error');
        btn.disabled = false; btn.textContent = '塞钱进红包';
      });
    };
  }

  // ============ 抢红包 / 查看 ============
  function grab(packetId) {
    return api('POST', '/api/redpacket/' + packetId + '/grab', {}).then(function (d) {
      if (d && d.already) return { already: true, amount: d.myAmount };
      return { already: false, amount: d.amount };
    });
  }
  function fetchDetail(packetId) {
    return api('GET', '/api/redpacket/' + packetId, undefined);
  }

  function openGrabDialog(packetId) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask rp-mask';
    var box = document.createElement('div');
    box.className = 'rp-grab-box';
    box.innerHTML =
      '<button class="modal-x rp-close" type="button">&times;</button>' +
      '<div class="rp-grab-inner"><div class="rp-grab-loading">加载中…</div></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.rp-close').onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    var inner = box.querySelector('.rp-grab-inner');

    // 先抢，再拉详情
    grab(packetId).then(function (g) {
      return fetchDetail(packetId).then(function (d) {
        renderGrab(inner, d, g, mask);
      });
    }).catch(function (err) {
      // 抢失败（可能已过期等）仍展示详情
      fetchDetail(packetId).then(function (d) {
        renderGrab(inner, d, null, mask);
      }).catch(function () {
        inner.innerHTML = '<div class="rp-grab-err">' + esc(err.message || '红包不可用') + '</div>';
      });
    });
  }

  function renderGrab(inner, d, g, mask) {
    var senderName = d.sender ? d.sender.nickname : '好友';
    var grabbedByMe = d.grabbedByMe;
    var myAmt = (g && !g.already) ? g.amount : (d.myAmount != null ? d.myAmount : null);
    var finished = d.status === 'finished';
    var canView = d.canViewAmount;

    var detailHtml = '';
    if (canView && d.grabs) {
      var grabList = Object.keys(d.grabs).map(function (k) { return d.grabs[k]; });
      detailHtml = '<div class="rp-grab-list">' + (grabList.length ? grabList.map(function (u) {
        return '<div class="rp-grab-row"><div class="rp-grab-avatar">' + (u.avatar ? '<img src="' + esc(u.avatar) + '">' : esc((u.nickname || '?')[0])) + '</div>' +
          '<div class="rp-grab-name">' + esc(u.nickname || '用户') + '</div>' +
          (grabbedByMe && u.id === myId() && myAmt != null ? '<div class="rp-grab-amount">' + myAmt + ' 元</div>' : '<div class="rp-grab-amount">抢到了</div>') +
        '</div>';
      }).join('') : '') + '</div>';
    }

    inner.innerHTML =
      '<div class="rp-grab-top">' +
        (grabbedByMe || (g && !g.already) ? '<div class="rp-grab-result">' + (myAmt != null ? '成功领取 <b>' + myAmt + '</b> 元' : '已领取') + '</div>' : '<div class="rp-grab-result">手慢了，红包已被抢完</div>') +
      '</div>' +
      '<div class="rp-grab-msg">' + esc(senderName) + ' 的红包' + '</div>' +
      '<div class="rp-grab-greeting">' + esc(d.greeting || '恭喜发财，大吉大利！') + '</div>' +
      '<div class="rp-grab-progress">' + '已抢 ' + Object.keys(d.grabs || {}).length + '/' + d.count + ' 个 · 已领 ' + (d.totalAmount - (d.remainingAmount || 0)).toFixed(2) + '/' + d.totalAmount + ' 元</div>' +
      detailHtml +
      '<button class="rp-grab-close" type="button">开心收下</button>';

    var closeBtn = inner.querySelector('.rp-grab-close');
    if (closeBtn) closeBtn.onclick = function () { if (mask) mask.remove(); };
  }

  // ============ 渲染红包气泡 ============
  function parseRedId(content) {
    var m = RED_RE.exec(String(content || '').trim());
    return m ? m[1] : null;
  }

  function renderRedBubble(m, mine) {
    var id = parseRedId(m.content);
    var row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'me' : 'other');
    row.setAttribute('data-id', m.id != null ? m.id : '');
    if (m.createdAt) row.setAttribute('data-ts', String(m.createdAt));
    var fullTime = new Date(m.createdAt).toLocaleString();
    var fmt = window.fmtTime || function (t) { var d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    row.innerHTML =
      '<div class="bubble rp-bubble" data-rp="' + esc(id) + '">' +
        '<div class="rp-bubble-icon">' + (mine ? '🧧' : '🧧') + '</div>' +
        '<div class="rp-bubble-body">' +
          '<div class="rp-bubble-title">微信红包</div>' +
          '<div class="rp-bubble-sub">' + (mine ? '查看领取详情' : '点击领取红包') + '</div>' +
        '</div>' +
      '</div>' +
      '<span class="time" title="' + esc(fullTime) + '">' + fmt(m.createdAt) + '</span>' +
      '<div class="message-actions"><button type="button" data-action="copy">复制</button></div>';
    row.querySelector('[data-action="copy"]').onclick = function () {
      try { navigator.clipboard.writeText(String(m.content || '')); toast('已复制', 'success', 1200); } catch (e) { toast('复制失败', 'warn'); }
    };
    row.querySelector('.rp-bubble').onclick = function () { openGrabDialog(id); };
    return row;
  }

  // ============ 包装 appendMessage ============
  function wrapAppendMessage() {
    if (window.__rpWrapped || typeof window.appendMessage !== 'function') return;
    window.__rpWrapped = true;
    var original = window.appendMessage;
    window.appendMessage = function (m, prepend) {
      if (m && typeof m.content === 'string' && parseRedId(m.content) && !m.__rpHandled) {
        m.__rpHandled = true;
        try {
          var box = document.getElementById('messages');
          if (box) {
            var mine = Number(m.from) === Number(myId());
            var row = renderRedBubble(m, mine);
            box.appendChild(row);
            if (!prepend) box.scrollTop = box.scrollHeight;
            return;
          }
        } catch (e) {}
      }
      return original.apply(this, arguments);
    };
  }

  // ============ 输入框挂载"红包"按钮 ============
  function mountRedBtn() {
    var tools = document.querySelector('.composer-tools');
    if (!tools) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool rp-tool-btn';
    btn.textContent = '红包';
    btn.title = '发送红包';
    btn.onclick = function () { openSendDialog(); };
    tools.appendChild(btn);
  }

  function openPanel() { openSendDialog(); }

  // ============ 初始化 ============
  function init() {
    wrapAppendMessage();
    mountRedBtn();
    // 定期检查：输入框存在则挂按钮（SPA 切换）
    if (document.querySelector('.composer-tools') && !document.querySelector('.rp-tool-btn')) mountRedBtn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SecureChatRedpacket = { name: '红包', label: '红包', icon: '🧧', open: openPanel, sendDialog: openSendDialog, grab: grab, fetchDetail: fetchDetail };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('redpacket', { name: '红包', label: '红包', icon: '🧧', open: openPanel, sendDialog: openSendDialog, grab: grab, fetchDetail: fetchDetail });
  }
})();