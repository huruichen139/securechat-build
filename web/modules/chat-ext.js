'use strict';
// module: chat-ext (worker batch2)
// 聊天增强 Web 端：表情面板 / 拍一拍 / 引用回复 / 多选·合并转发 / 聊天背景 / 快捷复制·撤回·删除
// 依赖 app.js 的全局：state / $ / toast / escapeHtml / fmtTime / P / send / appendMessage
// 且需在 index.html 中于 app.js 之后加载本模块（由巨石/合并 worker 加挂载行）。

(function () {
  if (window.SecureChatExt) {
    // 幂等：避免重复注册
    if (window.SecureChatExt.registerFeature) return;
  }

  // ============ 内置表情库 ============
  var EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🤩', '😘', '😗', '😋', '😜', '😝', '🤪', '😎', '🤓', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '😢', '😭', '😤', '😠', '😡', '🤬', '🥺', '😳', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '😶', '😐', '😑', '🥱', '😴', '🤤', '🤑', '🤐', '😬', '😷', '🤒', '🤕', '🥵', '🥶', '😈', '👿', '👻', '💀', '🎃', '😺', '😸', '😻', '🙀', '👋', '🤚', '✋', '🖐️', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👉', '👈', '👆', '👇', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🤲', '🤝', '💪', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💋', '💯', '💢', '💥', '💫', '🌟', '⭐', '✨', '🔥', '🎉', '🎊', '🎈', '🎁', '🎂', '🍰', '🍕', '🍺', '🍻', '🥂', '☕', '🍵', '🌸', '🌹', '🌻', '🍀', '🌈', '⚡', '🌙', '☀️', '❄️', '🎵', '🎶', '🏆', '🚀', '🛸', '🌍', '💎', '🧧', '💌', '📌'];

  var HOST_FALLBACK = window.SERVER_HOST || (location.origin || '');
  function apiBase() {
    try { return window.state && window.state.serverHost ? window.state.serverHost : HOST_FALLBACK; }
    catch (e) { return HOST_FALLBACK; }
  }
  function tok() {
    try { return window.state && window.state.token ? window.state.token : (localStorage.getItem('sc_token') || ''); }
    catch (e) { return localStorage.getItem('sc_token') || ''; }
  }
  function getState() { return window.state || {}; }
  function $(id) { return document.getElementById(id); }
  function toast(msg, kind, ms) {
    if (window.toast) { window.toast(msg, kind, ms); return; }
    // 兜底
    try { alert(msg); } catch (e) {}
  }
  function esc(s) {
    if (window.escapeHtml) return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fTime(ts) {
    if (window.fmtTime) { try { return window.fmtTime(ts); } catch (e) {} }
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function activeTarget() {
    const s = getState();
    if (s.activeGroup) return { kind: 'group', id: s.activeGroup };
    if (s.activePeer) return { kind: 'friend', id: s.activePeer };
    return null;
  }
  function myId() { const s = getState(); return s.me && s.me.id; }

  // 会话可转发目标清单：好友 + 群
  function targetList() {
    const s = getState();
    const out = [];
    (s.friends || []).forEach(function (f) {
      if (f && f.id) out.push({ kind: 'friend', id: f.id, name: f.nickname || f.username || ('#' + f.id) });
    });
    (s.groups || []).forEach(function (g) {
      if (g && g.id) out.push({ kind: 'group', id: g.id, name: (g.name || '群聊') + '（群）' });
    });
    return out;
  }

  // ============ REST 辅助 ============
  function post(path, body) {
    return fetch(apiBase() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() },
      body: JSON.stringify(body || {})
    }).then(async function (res) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    });
  }
  function get(path) {
    return fetch(apiBase() + path, { headers: { 'Authorization': 'Bearer ' + tok() } })
      .then(async function (res) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      });
  }

  // 从本地会话已渲染/已加载消息里找 id -> msg（用于多选转发）
  function lookupMessage(id) {
    // app.js 以 state 保存群消息；私聊历史经 appendMessage 直接渲染，无集中缓存，退化为按 DOM 查找
    const s = getState();
    if (s.groupMsgs && s.groupMsgs[s.activeGroup]) {
      for (const m of s.groupMsgs[s.activeGroup]) if (Number(m.id) === Number(id)) return m;
    }
    return null;
  }

  // 收集当前会话已渲染消息 id（从 .msg-row 上 data-id）
  function renderedMessageIds() {
    const box = $('messages');
    if (!box) return [];
    const ids = [];
    box.querySelectorAll('.msg-row[data-id]').forEach(function (el) {
      ids.push(Number(el.getAttribute('data-id')));
    });
    return ids;
  }

  // ============ 发送增强消息（明文）============
  function sendContent(content, opts) {
    const target = activeTarget();
    if (!target) { toast('请先选择会话', 'warn'); return Promise.reject(new Error('no target')); }
    // 明文模式：不再加密，原文直发，以支持历史检索与聊天回放。
    function encryptIfReady(peerId, text) {
      return Promise.resolve(text);
    }
    if (target.kind === 'group') {
      const gid = target.id;
      return encryptIfReady(gid, content).then((ct) => {
        const finalContent = ct || content;
        if (window.send) {
          const ok = window.send(window.P.C_GROUP_MSG, { groupId: gid, content: finalContent, clientMsgId: opts && opts.clientMsgId, replyTo: opts && opts.replyTo });
          if (ok) {
            if (opts && opts.optimistic) appendLocal(finalContent, true, opts);
            return Promise.resolve({ ok: true });
          }
        }
        return post('/api/groups/' + gid + '/messages', { content: finalContent, replyTo: opts && opts.replyTo })
          .catch(function () { return { ok: false }; })
          .then(function () {
            if (window.send) window.send(window.P && window.P.C_GROUP_MSG, { groupId: gid, content: finalContent, clientMsgId: (opts && opts.clientMsgId) || ('g' + Date.now()) });
            if (opts && opts.optimistic) appendLocal(finalContent, true, opts);
            return { ok: true };
          });
      });
    }
    // 好友：走 REST
    const peerId = target.id;
    return encryptIfReady(peerId, content).then((ct) => {
      const finalContent = ct || content;
      const clientMsgId = (opts && opts.clientMsgId) || ('ce_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
      const payload = { to: peerId, content: finalContent, clientMsgId: clientMsgId };
      if (opts && opts.replyTo) payload.replyTo = opts.replyTo;
      if (opts && opts.forwardedFrom) payload.forwardedFrom = opts.forwardedFrom;
      if (opts && opts.optimistic) appendLocal(finalContent, true, opts);
      return fetch(apiBase() + '/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() },
        body: JSON.stringify(payload)
      }).then(async function (res) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '发送失败');
        return data;
      });
    });
  }

  function appendLocal(content, mine, opts) {
    if (!window.appendMessage) return;
    try {
      window.appendMessage({ id: 'local-' + Date.now(), from: mine && myId(), to: activeTarget() && activeTarget().id, content: content, createdAt: Date.now(), clientMsgId: (opts && opts.clientMsgId) || '' }, false);
    } catch (e) {}
  }

  // ============ 表情 ============
  function showEmojiPanel() {
    let panel = $('ceEmojiPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ceEmojiPanel';
      panel.className = 'ce-emoji-panel';
      panel.innerHTML = '<div class="ce-emoji-head">表情</div><div class="ce-emoji-grid"></div>';
      const grid = panel.querySelector('.ce-emoji-grid');
      EMOJIS.forEach(function (e) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ce-emoji';
        b.textContent = e;
        b.onclick = function () {
          sendContent('[emoji:' + e + ']', { optimistic: true }).then(function () {
            toast('已发送表情', 'success', 1200);
          }).catch(function (err) { toast('发送失败：' + err.message, 'error'); });
          panel.classList.remove('open');
        };
        grid.appendChild(b);
      });
      const composer = document.querySelector('.composer');
      if (composer) composer.parentNode.appendChild(panel);
      else document.body.appendChild(panel);
      const panelRef = panel;
      document.addEventListener('click', function (ev) {
        if (!panelRef.classList.contains('open')) return;
        if (panelRef.contains(ev.target) || (ev.target && ev.target.closest && ev.target.closest('#ceEmojiBtn'))) return;
        panelRef.classList.remove('open');
      });
    }
    panel.classList.toggle('open');
  }
  function mountEmojiButton() {
    if ($('ceEmojiBtn')) return;
    const tools = document.querySelector('.composer-tools');
    if (!tools) return;
    const btn = document.createElement('button');
    btn.id = 'ceEmojiBtn';
    btn.className = 'tool';
    btn.title = '表情';
    btn.textContent = '表情';
    btn.type = 'button';
    btn.onclick = function (ev) { ev.stopPropagation(); showEmojiPanel(); };
    tools.appendChild(btn);
  }

  // ============ 拍一拍（双击对方头像/姓名）============
  function poke(toId, msgId) {
    if (toId == null) { toast('请选择要拍的好友', 'warn'); return Promise.resolve(); }
    const id = msgId || (renderedMessageIds()[0] || 0);
    return post('/api/messages/' + id + '/poke', { to: toId }).then(function () {
      toast('已拍一拍' + (getState().activePeer ? '' : ''), 'success', 1200);
    }).catch(function (e) { toast('拍一拍失败：' + e.message, 'error'); });
  }
  function mountPokeDblClick() {
    const box = $('messages');
    if (!box || box.__cePokeBound) return;
    box.__cePokeBound = true;
    box.addEventListener('dblclick', function (ev) {
      const s = getState();
      if (s.activeGroup) return; // 群不支持拍一拍
      const avatar = ev.target && ev.target.closest ? ev.target.closest('.avatar, .bubble .ico, .msg-row .bubble') : null;
      if (!avatar) return;
      const peer = s.activePeer;
      if (peer == null || peer === myId()) return;
      poke(peer);
    });
  }

  // ============ 引用回复 / 复制 / 撤回 / 删除 ============
  function quoteReply(msg) {
    const input = $('input');
    if (!input) return;
    const quote = '> ' + String(msg.content || '').replace(/\n/g, '\n> ') + '\n';
    input.value = input.value ? quote + input.value : quote;
    input.focus();
  }
  function copyMsg(msg) {
    try {
      navigator.clipboard.writeText(String(msg.content || '')).then(function () { toast('已复制', 'success', 1200); });
    } catch (e) { toast('复制失败，请手动选择文本', 'warn', 1500); }
  }
  function recallMsg(msg) {
    const id = Number(msg.id);
    if (!id) { toast('仅支持撤回已同步的消息', 'warn'); return Promise.resolve(); }
    const s = getState();
    if (s.me && msg.from !== s.me.id) { toast('只能撤回自己发送的消息', 'warn'); return Promise.resolve(); }
    if (Date.now() - Number(msg.createdAt || 0) > 2 * 60 * 1000) { toast('超过 2 分钟，无法撤回', 'warn'); return Promise.resolve(); }
    return post('/api/messages/' + id + '/recall', {}).then(function () {
      toast('已撤回', 'success', 1200);
      const row = document.querySelector('.msg-row[data-id="' + id + '"] .bubble');
      if (row) row.textContent = '[系统]消息已撤回';
    }).catch(function (e) { toast('撤回失败：' + e.message, 'error'); });
  }
  function deleteLocalMsg(msg) {
    const id = Number(msg.id);
    const row = document.querySelector('.msg-row[data-id="' + id + '"]');
    if (row) { row.parentNode && row.parentNode.removeChild(row); toast('已删除（仅本端）', 'success', 1200); }
    else toast('未找到该消息', 'warn');
  }

  // ============ 多选 / 合并转发 ============
  var selState = { active: false, ids: new Set() };
  function toggleSelectMode(on) {
    selState.active = on;
    selState.ids.clear();
    document.querySelectorAll('.msg-row').forEach(function (el) {
      el.classList.toggle('ce-selected', on && selState.ids.has(Number(el.getAttribute('data-id'))));
      if (on && !el.getAttribute('data-ce-bound')) {
        el.setAttribute('data-ce-bound', '1');
        el.addEventListener('click', function (ev) {
          if (!selState.active) return;
          const id = Number(el.getAttribute('data-id'));
          if (!id) return;
          if (selState.ids.has(id)) selState.ids.delete(id);
          else selState.ids.add(id);
          el.classList.toggle('ce-selected', selState.ids.has(id));
        });
      }
    });
    let bar = $('ceSelectBar');
    if (on) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ceSelectBar';
        bar.className = 'ce-select-bar';
        bar.innerHTML = '<span>已选 <b>0</b> 条</span><button type="button" data-act="forward">转发</button><button type="button" data-act="merge">合并转发</button><button type="button" data-act="cancel">取消</button>';
        document.body.appendChild(bar);
      }
      const refresh = function () {
        const n = selState.ids.size;
        const b = bar.querySelector('b'); if (b) b.textContent = n;
      };
      bar.querySelector('[data-act="forward"]').onclick = function () { startForward(false); };
      bar.querySelector('[data-act="merge"]').onclick = function () { startForward(true); };
      bar.querySelector('[data-act="cancel"]').onclick = function () { toggleSelectMode(false); };
      bar.style.display = 'flex';
      refresh();
    } else if (bar) {
      bar.style.display = 'none';
    }
    if ($('messages')) $('messages').classList.toggle('ce-selecting', on);
  }
  function beginMultiSelect() {
    if (renderedMessageIds().length === 0) { toast('当前会话没有可转发的消息', 'warn'); return; }
    toggleSelectMode(true);
    toast('勾选消息后，点击下方转发', 'info', 2000);
  }
  function liveCount() {
    const bar = $('ceSelectBar'); if (!bar) return 0;
    const b = bar.querySelector('b'); return b ? parseInt(b.textContent, 10) : 0;
  }
  function pickTargets() {
    const list = targetList();
    if (!list.length) { toast('没有可转发的好友或群', 'warn'); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      const mask = document.createElement('div');
      mask.className = 'ce-modal-mask';
      const rows = list.map(function (t) {
        return '<div class="ce-target" data-k="' + t.kind + '" data-id="' + t.id + '"><span class="ce-target-ico">' + (t.kind === 'group' ? '群' : '友') + '</span><span>' + esc(t.name) + '</span></div>';
      }).join('');
      mask.innerHTML = '<div class="ce-modal"><div class="ce-modal-title">转发到…</div><div class="ce-target-list">' + rows + '</div><div class="ce-modal-actions"><button type="button" class="ce-cancel">取消</button></div></div>';
      document.body.appendChild(mask);
      const chosen = [];
      mask.querySelectorAll('.ce-target').forEach(function (el) {
        el.addEventListener('click', function () {
          el.classList.toggle('on');
        });
      });
      mask.querySelector('.ce-cancel').onclick = function () { mask.remove(); resolve(null); };
      // 点空白关闭
      mask.addEventListener('click', function (ev) { if (ev.target === mask) { mask.remove(); resolve(null); } });
      // 提供确认
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'ce-ok';
      okBtn.textContent = '确认转发';
      mask.querySelector('.ce-modal-actions').appendChild(okBtn);
      okBtn.onclick = function () {
        mask.querySelectorAll('.ce-target.on').forEach(function (el) {
          chosen.push({ kind: el.getAttribute('data-k'), id: Number(el.getAttribute('data-id')) });
        });
        mask.remove();
        resolve(chosen.length ? chosen : null);
      };
    });
  }

  function startForward(merge) {
    if (!selState.active) { toast('请先进入多选模式', 'warn'); return; }
    const ids = Array.from(selState.ids);
    if (!ids.length) { toast('请先勾选消息', 'warn'); return; }
    pickTargets().then(function (targets) {
      if (!targets) return;
      const body = { messageIds: ids, targets: targets, merge: merge };
      post('/api/messages/forward', body).then(function (data) {
        toast(merge ? ('已合并转发' + (data.count || 0) + '条') : ('已转发' + (data.count || 0) + '条'), 'success', 1600);
        toggleSelectMode(false);
      }).catch(function (e) { toast('转发失败：' + e.message, 'error'); });
    });
  }

  // ============ 聊天背景（本地存储）============
  function bgKey() {
    const s = getState();
    const userId = myId() || 'guest';
    const conv = activeTarget();
    const id = conv ? conv.id : 0;
    return 'sc_bg_' + userId + '_' + id;
  }
  function getBackground() {
    try { return JSON.parse(localStorage.getItem(bgKey()) || 'null'); } catch (e) { return null; }
  }
  function applyBackground(bg) {
    const msgs = $('messages');
    if (!msgs) return;
    if (bg && bg.kind === 'image' && bg.value) {
      msgs.style.backgroundImage = "url('" + bg.value.replace(/'/g, "%27") + "')";
      msgs.style.backgroundSize = 'cover';
      msgs.style.backgroundPosition = 'center';
      msgs.style.backgroundColor = 'transparent';
    } else if (bg && bg.kind === 'color' && bg.value) {
      msgs.style.backgroundImage = 'none';
      msgs.style.backgroundColor = bg.value;
    } else {
      msgs.style.backgroundImage = '';
      msgs.style.backgroundColor = '';
      msgs.style.backgroundSize = '';
      msgs.style.backgroundPosition = '';
    }
  }
  function setBackground(bg) {
    if (bg && typeof bg === 'object' && bg.kind) {
      localStorage.setItem(bgKey(), JSON.stringify(bg));
    } else {
      localStorage.removeItem(bgKey());
      bg = null;
    }
    applyBackground(bg);
  }
  function showBackgroundDialog() {
    const real = getBackground();
    const preset = ['#e6f4ea', '#fdf6e3', '#fde9e4', '#e7ecf7', '#fff4d6', '#e9f5e5', '#f0f0f5', '#ffffff'];
    const mask = document.createElement('div');
    mask.className = 'ce-modal-mask';
    mask.innerHTML = '<div class="ce-modal"><div class="ce-modal-title">聊天背景</div>' +
      '<div class="ce-bg-presets">' + preset.map(function (c) {
        return '<button type="button" class="ce-bg-swatch" style="background:' + c + '" data-color="' + c + '"></button>';
      }).join('') + '<button type="button" class="ce-bg-swatch ce-bg-reset">默认</button></div>' +
      '<div class="ce-bg-row"><label>背景图片 URL/粘贴图片(或选文件)</label></div>' +
      '<div class="ce-bg-row"><input type="file" id="ceBgFile" accept="image/*"><button type="button" id="ceBgUrlBtn">使用链接</button></div>' +
      '<input type="text" id="ceBgUrl" placeholder="https://… 图片链接" style="margin-top:8px;width:100%">' +
      '<div class="ce-modal-actions"><button type="button" class="ce-cancel">关闭</button><button type="button" class="ce-ok">保存</button></div></div>';
    document.body.appendChild(mask);
    let pending = null;
    mask.querySelectorAll('.ce-bg-swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        pending = sw.getAttribute('data-color') ? { kind: 'color', value: sw.getAttribute('data-color') } : null;
        mask.querySelectorAll('.ce-bg-swatch').forEach(function (x) { x.classList.remove('on'); });
        sw.classList.add('on');
      });
    });
    const file = mask.querySelector('#ceBgFile');
    file.addEventListener('change', function () {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        pending = { kind: 'image', value: reader.result };
        toast('已载入图片，点击保存', 'info', 2000);
      };
      reader.readAsDataURL(f);
    });
    mask.querySelector('#ceBgUrlBtn').addEventListener('click', function () {
      const url = mask.querySelector('#ceBgUrl').value.trim();
      if (!url) { toast('请输入链接', 'warn'); return; }
      pending = { kind: 'image', value: url };
      toast('将使用该图片，点击保存', 'info', 2000);
    });
    mask.querySelector('.ce-cancel').addEventListener('click', function () { mask.remove(); });
    mask.querySelector('.ce-ok').addEventListener('click', function () {
      setBackground(pending);
      mask.remove();
      toast('背景已更新', 'success', 1200);
    });
    mask.addEventListener('click', function (ev) { if (ev.target === mask) mask.remove(); });
  }

  // ============ 消息增强渲染（补合并转发卡片 / 表情大字号）============
  function enhanceRenderedText(el, content) {
    if (!el || typeof content !== 'string') return;
    // 合并转发卡片
    if (content.indexOf('[合并转发]') === 0) {
      let data = null;
      const json = content.slice('[合并转发]'.length);
      try { data = JSON.parse(json); } catch (e) {}
      if (data && data.type === 'merged') {
        el.textContent = '[合并转发] 共' + (data.count || 0) + '条消息';
        el.className = (el.className || '') + ' ce-merged-card';
        el.setAttribute('data-merged', '1');
      }
    } else if (content.indexOf('[系统]') === 0) {
      el.className = (el.className || '') + ' ce-system';
    } else if (content.indexOf('[emoji:') === 0) {
      const m = /^\[emoji:(.+)\]$/.exec(content);
      if (m) { el.textContent = m[1]; el.className = (el.className || '') + ' ce-emoji-big'; }
    }
  }
  function openMergedCard(el) {
    const bubble = el.closest('.bubble');
    if (!bubble || !el.getAttribute('data-merged')) return;
    // 从来源消息文本取卡（若未内嵌 JSON 则尝试 /ext）
    const content = (el.textContent || '');
    let data = null;
    const jsonCandidate = el.getAttribute('data-json');
    try { data = JSON.parse(jsonCandidate); } catch (e) {}
    if (!data || !data.items) data = parseMergedFromDom();
    if (!data) { toast('无法解析合并转发', 'warn'); return; }
    const mask = document.createElement('div');
    mask.className = 'ce-modal-mask';
    mask.innerHTML = '<div class="ce-modal ce-merged-detail"><div class="ce-modal-title">合并转发记录' + (data.count ? '（' + data.count + '条）' : '') + '</div><div class="ce-merged-list">' +
      (data.items || []).map(function (it) {
        const name = esc(it.fromName || '未知');
        const txt = esc(String(it.content || ''));
        const isEmoji = /^\[emoji:(.+)\]$/.exec(it.content || '');
        const disp = isEmoji ? '（表情）' + isEmoji[1] : txt;
        return '<div class="ce-merged-item"><div class="ce-merged-who">' + name + '</div><div class="ce-merged-msg">' + (disp ? disp : '（文件/语音）') + '</div></div>';
      }).join('') + '</div><div class="ce-modal-actions"><button type="button" class="ce-cancel">关闭</button></div></div>';
    document.body.appendChild(mask);
    mask.querySelector('.ce-cancel').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (ev) { if (ev.target === mask) mask.remove(); });
  }
  function parseMergedFromDom() {
    const s = getState();
    if (!s.groupMsgs) return null;
    // 尝试从该会话来源构建；此函数仅在卡片无内嵌时兜底
    return null;
  }
  function mountMergedOpen() {
    const box = $('messages');
    if (!box || box.__ceMergedBound) return;
    box.__ceMergedBound = true;
    box.addEventListener('click', function (ev) {
      const card = ev.target && ev.target.closest ? ev.target.closest('.ce-merged-card') : null;
      if (card) openMergedCard(card);
    });
  }

  // 给已存在的 / 未来渲染的消息补增强（由 registerFeature 供主 app 调用）
  function refreshEnhance() {
    const box = $('messages');
    if (!box) return;
    box.querySelectorAll('.msg-row .bubble').forEach(function (b) {
      const row = b.closest('.msg-row');
      const id = row && row.getAttribute('data-id');
      enhanceRenderedText(b, b.textContent);
    });
  }

  // 主 app 在渲染完一条消息后可调用（合并 worker 挂载时机）
  function onMessageRendered(el, msg) {
    if (el) enhanceRenderedText(el, msg && msg.content);
    applyBackground(getBackground());
  }

  // ============ 程序化转发单条（供消息操作菜单）============
  function forwardMessages(messageIds, merge) {
    if (!Array.isArray(messageIds) || !messageIds.length) return Promise.reject(new Error('no messages'));
    return pickTargets().then(function (targets) {
      if (!targets) return null;
      return post('/api/messages/forward', { messageIds: messageIds, targets: targets, merge: !!merge }).then(function (data) {
        toast(merge ? ('已合并转发' + (data.count || 0) + '条') : ('已转发' + (data.count || 0) + '条'), 'success', 1600);
        return data;
      });
    });
  }

  // ============ 初始化 & 对外 API ============
  function init() {
    mountEmojiButton();
    mountPokeDblClick();
    mountMergedOpen();
    applyBackground(getBackground());
    // 让 app.js 在每次渲染消息后可调用我们的增强
    VueLikeHooks();
  }
  function VueLikeHooks() {
    // 无 Vue 依赖；暴露网关让大文件挂载
  }

  window.SecureChatExt = {
    registerFeature: function (name, api) {
      if (name === 'chat-ext') {
        // 简单合并扩展点
        if (api && typeof api === 'object') {
          Object.keys(api).forEach(function (k) { window.SecureChatExt[k] = api[k]; });
        }
      }
      return window.SecureChatExt;
    },
    chatExt: true,
    EMOJIS: EMOJIS,
    showEmojiPanel: showEmojiPanel,
    sendEmoji: function (e) { sendContent('[emoji:' + e + ']', { optimistic: true }); },
    sendContent: sendContent,
    poke: poke,
    quoteReply: quoteReply,
    copyMsg: copyMsg,
    recallMsg: recallMsg,
    deleteLocalMsg: deleteLocalMsg,
    beginMultiSelect: beginMultiSelect,
    forwardMessages: forwardMessages,
    setBackground: setBackground,
    getBackground: getBackground,
    showBackgroundDialog: showBackgroundDialog,
    refreshEnhance: refreshEnhance,
    onMessageRendered: onMessageRendered,
    init: init,
    // 便捷：让 app.js 无需改动即可接入聊天背景到头部
    activeTarget: activeTarget,
    applyBackgroundNow: function () { applyBackground(getBackground()); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();