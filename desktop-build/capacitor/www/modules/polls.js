'use strict';
// module: polls (worker batch8)
// 群投票：发起投票（单选/多选、匿名、截止时间）、投票、实时结果（饼图），仅群成员可投。
// 依赖：web/modules/registry.js（window.SecureChatExt）。
// 端点：/api/polls/*（由 server/routes/lifestyle-msg.js 提供）。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;

  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(ms) {
    if (!ms) return '长期有效';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function colors() { return ['#07c160', '#10aeff', '#fa9d3b', '#ff5b5b', '#9a6bff', '#00bcd4', '#ff9800', '#8bc34a', '#e91e63', '#3f51b5']; }

  // 简易饼图：div 用 conic-gradient
  function pieHTML(options) {
    const total = options.reduce((s, o) => s + (o.votes || 0), 0) || 1;
    const stops = [];
    let acc = 0;
    options.forEach((o, i) => {
      const pct = (o.votes || 0) / total;
      const start = acc * 360;
      const end = (acc + pct) * 360;
      if (o.votes > 0) stops.push(colorAt(i, options.length) + ' ' + start + 'deg ' + end + 'deg');
      acc += pct;
    });
    let bg = '#eee';
    if (stops.length) bg = 'conic-gradient(' + stops.join(', ') + ')';
    return '<div class="polls-pie" style="width:120px;height:120px;border-radius:50%;background:' + bg + ';margin:6px auto;"></div>';
  }
  function colorAt(i, n) { const c = colors(); return c[i % c.length]; }

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) { (listeners[evt] || []).forEach((f) => { try { f(detail); } catch (e) {} }); }

  let polls = [];

  function loadByGroup(groupId) {
    return apiFn('GET', '/api/polls/group/' + groupId).then((d) => {
      polls = d.polls || [];
      return polls;
    }).catch((e) => { toast('加载投票失败：' + (e.message || e), 'error'); return []; });
  }

  async function createPoll(groupId, data) {
    const body = Object.assign({ groupId }, data);
    const d = await apiFn('POST', '/api/polls', { body });
    toast('投票已发布', 'success');
    return d.poll;
  }

  async function vote(pollId, optionIds) {
    const d = await apiFn('POST', '/api/polls/' + pollId + '/vote', { body: { optionIds } });
    return d.poll;
  }

  async function closePoll(pollId) {
    const d = await apiFn('POST', '/api/polls/' + pollId + '/close', { body: {} });
    return d.poll;
  }

  // ---------- 渲染 ----------
  function renderPollPanel(container, poll) {
    const myId = u.getMyId && u.getMyId();
    const isCreator = Number(poll.creatorId) === Number(myId);
    const over = poll.status === 'closed' || (poll.deadline && Date.now() > poll.deadline);
    const who = poll.anonymous ? '匿名投票' : '实名投票'; // 匿名不展示投票分布
    container.innerHTML =
      '<div class="polls-card" style="background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
      '<div style="font-size:13px;color:#999;margin-bottom:4px">' + esc((poll.creator && poll.creator.nickname) || '匿名') + ' 发起的投票 · ' + (poll.multi ? '多选' : '单选') + ' · ' + who + ' · 截止 ' + esc(fmtDate(poll.deadline)) + '</div>' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:10px">' + esc(poll.title) + '</div>' +
      (poll.voted || over || poll.anonymous ? pieHTML(poll.options) : '') +
      renderOptions(poll, over) +
      (isCreator && poll.status === 'open' ? '<button class="polls-close" data-id="' + poll.id + '" style="margin-top:10px;padding:6px 14px;background:#eee;border:none;border-radius:16px;color:#666;cursor:pointer">结束投票</button>' : '') +
      '<div style="font-size:12px;color:#aaa;margin-top:8px">共 ' + poll.totalVotes + ' 人参与</div>' +
      '</div>';
    // 选项点击
    container.querySelectorAll('.polls-opt').forEach((el) => {
      el.onclick = async () => {
        if (poll.voted) { toast('你已投过票，可再做一次以改票', 'info'); return; }
        if (over) { toast('投票已结束', 'warn'); return; }
        let fresh = poll;
        const id = Number(el.getAttribute('data-id'));
        if (poll.multi) {
          el.classList.toggle('polls-opt-on');
          const sel = Array.from(container.querySelectorAll('.polls-opt-on')).map((e) => Number(e.getAttribute('data-id')));
          if (!sel.length) return;
          fresh = await vote(poll.id, sel);
          if (fresh) renderPollPanel(container, fresh);
        } else {
          fresh = await vote(poll.id, [id]);
          if (fresh) renderPollPanel(container, fresh);
        }
        emit('changed', fresh || poll);
      };
    });
    const closeBtn = container.querySelector('.polls-close');
    if (closeBtn) closeBtn.onclick = async () => {
      const fresh = await closePoll(Number(closeBtn.getAttribute('data-id')));
      if (fresh) renderPollPanel(container, fresh);
    };
  }

  function renderOptions(poll, over) {
    const show = poll.voted || over || poll.anonymous;
    return '<div style="display:flex;flex-direction:column;gap:8px">' + poll.options.map((o, i) => {
      const pct = poll.totalVotes ? Math.round((o.votes || 0) / poll.totalVotes * 100) : 0;
      let extra = '';
      if (show) extra = '<div style="margin-top:4px;height:6px;background:' + colorAt(i, poll.options.length) + ';border-radius:3px;width:' + pct + '%"></div>' +
        '<div style="font-size:12px;color:#888">' + o.votes + ' 票 · ' + pct + '%</div>';
      const on = (poll.myVotes || []).indexOf(o.id) >= 0 ? ' polls-opt-on' : '';
      return '<div class="polls-opt' + on + '" data-id="' + o.id + '" style="padding:8px 10px;border:1px solid #e5e5e5;border-radius:8px;font-size:14px;cursor:pointer">' + esc(o.content) + extra + '</div>';
    }).join('') + '</div>';
  }

  // 创建投票弹层
  function openCreate(groupId) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999';
    wrap.innerHTML =
      '<div class="polls-creator" style="background:#fff;border-radius:16px;padding:20px;width:420px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.2)">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:12px">发起群投票</div>' +
      '<input class="pc-title" placeholder="投票标题" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ddd;border-radius:8px;margin-bottom:10px">' +
      '<div id="pc-opts" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px"></div>' +
      '<button class="pc-add" style="padding:6px 12px;background:#f2f2f2;border:none;border-radius:16px;cursor:pointer;margin-bottom:10px">+ 添加选项</button>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:13px">' +
      '<label><input type="checkbox" class="pc-multi"> 多选</label>' +
      '<label><input type="checkbox" class="pc-anon"> 匿名</label>' +
      '<label><input type="checkbox" class="pc-only" checked> 仅群成员</label>' +
      '</div>' +
      '<div style="font-size:13px;color:#666;margin-bottom:10px">截止时间（分）：<input type="number" class="pc-min" min="0" placeholder="0=长期" style="width:90px;padding:6px;border:1px solid #ddd;border-radius:6px"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="pc-cancel" style="padding:8px 16px;background:#f2f2f2;border:none;border-radius:20px;cursor:pointer">取消</button>' +
      '<button class="pc-confirm" style="padding:8px 16px;background:#07c160;color:#fff;border:none;border-radius:20px;cursor:pointer">发布</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    const optsBox = wrap.querySelector('#pc-opts');
    function addOption(v) {
      const row = document.createElement('div');
      row.style.display = 'flex'; row.style.gap = '6px';
      const inp = document.createElement('input');
      inp.value = v || '';
      inp.placeholder = '选项';
      inp.style.cssText = 'flex:1;padding:7px 8px;border:1px solid #ddd;border-radius:6px';
      const del = document.createElement('button');
      del.textContent = '×';
      del.style.cssText = 'border:none;background:#fee;color:#c00;border-radius:50%;width:26px;cursor:pointer';
      del.onclick = () => row.remove();
      row.appendChild(inp); row.appendChild(del);
      optsBox.appendChild(row);
    }
    addOption(''); addOption('');
    wrap.querySelector('.pc-add').onclick = () => addOption('');
    wrap.querySelector('.pc-cancel').onclick = () => wrap.remove();
    wrap.querySelector('.pc-confirm').onclick = async () => {
      const title = wrap.querySelector('.pc-title').value.trim();
      const opts = Array.from(optsBox.querySelectorAll('input')).map((i) => i.value.trim()).filter(Boolean);
      if (!title) { toast('请输入标题', 'warn'); return; }
      if (opts.length < 2) { toast('至少两个选项', 'warn'); return; }
      const min = parseInt(wrap.querySelector('.pc-min').value, 10);
      const deadline = min > 0 ? Date.now() + min * 60000 : null;
      const multi = wrap.querySelector('.pc-multi').checked;
      const anonymous = wrap.querySelector('.pc-anon').checked;
      const onlyMembers = wrap.querySelector('.pc-only').checked;
      const body = { title, options: opts, multi, anonymous, onlyMembers, deadline };
      try {
        await createPoll(groupId, body);
        wrap.remove();
        emit('created', body);
      } catch (e) { toast('发布失败：' + (e.message || e), 'error'); }
    };
  }

  // ============================================================
  // 群接龙（报名类） /api/solang/* —— 与投票同属群互动工具，放进本模块
  // ============================================================
  let solangs = [];

  function solangDtoRender(s) {
    return {
      id: s.id, groupId: s.groupId, creatorId: s.creatorId,
      creator: s.creator, title: s.title, status: s.status,
      createdAt: s.createdAt, count: s.count, entries: s.entries,
    };
  }

  function loadSolangs(groupId) {
    return apiFn('GET', '/api/solang/group/' + groupId).then((d) => {
      solangs = (d.solangs || []).map(solangDtoRender);
      return solangs;
    }).catch((e) => { toast('加载接龙失败：' + (e.message || e), 'error'); return []; });
  }

  async function createSolang(groupId, title) {
    const d = await apiFn('POST', '/api/solang', { body: { groupId, title } });
    return solangDtoRender(d.solang);
  }

  async function joinSolang(solangId, note) {
    const d = await apiFn('POST', '/api/solang/' + solangId + '/join', { body: { note } });
    return solangDtoRender(d.solang);
  }

  async function closeSolang(solangId) {
    const d = await apiFn('POST', '/api/solang/' + solangId + '/close', { body: {} });
    return solangDtoRender(d.solang);
  }

  function renderSolangPanel(container, s) {
    const myId = u.getMyId && u.getMyId();
    const isCreator = Number(s.creatorId) === Number(myId);
    container.innerHTML =
      '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
      '<div style="font-size:13px;color:#999;margin-bottom:4px">' + esc((s.creator && s.creator.nickname) || '匿名') + ' 发起接龙 · ' + (s.status === 'open' ? '进行中' : '已结束') + '</div>' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:10px">' + esc(s.title) + '</div>' +
      '<div style="font-size:12px;color:#888;margin-bottom:8px">已有 ' + s.count + ' 人报名</div>' +
      '<div style="display:flex;flex-direction:column;gap:4px">' + (s.entries || []).map((e) =>
        '<div style="display:flex;gap:8px;font-size:14px;align-items:center">' +
        '<span style="display:inline-flex;min-width:24px;height:24px;align-items:center;justify-content:center;background:#07c160;color:#fff;border-radius:50%;font-size:12px">' + e.seq + '</span>' +
        '<span>' + esc(e.nickname || ('用户' + e.userId)) + '</span>' +
        (e.note ? '<span style="color:#999;font-size:12px">（' + esc(e.note) + '）</span>' : '') +
        '</div>').join('') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      (s.status === 'open' ? '<input class="sol-join" placeholder="备注（可选）" style="flex:1;padding:8px 10px;border:1px solid #ddd;border-radius:8px">' +
        '<button class="sol-go" data-id="' + s.id + '" style="padding:8px 16px;background:#07c160;color:#fff;border:none;border-radius:20px;cursor:pointer">我接 ' + ((s.count || 0) + 1) + ' 号</button>' : '') +
      (isCreator && s.status === 'open' ? '<button class="sol-close" data-id="' + s.id + '" style="padding:8px 14px;background:#eee;border:none;border-radius:20px;cursor:pointer;color:#666">结束</button>' : '') +
      '</div></div>';
    const go = container.querySelector('.sol-go');
    if (go) go.onclick = async () => {
      const note = (container.querySelector('.sol-join') || {}).value || '';
      try { const fresh = await joinSolang(Number(go.getAttribute('data-id')), note); renderSolangPanel(container, fresh); emit('solang-changed', fresh); } catch (e) { toast('接龙失败：' + (e.message || e), 'error'); }
    };
    const close = container.querySelector('.sol-close');
    if (close) close.onclick = async () => { try { const fresh = await closeSolang(Number(close.getAttribute('data-id'))); renderSolangPanel(container, fresh); } catch (e) {} };
  }

  // 创建接龙弹层
  function openCreateSolang(groupId) {
    const title = window.prompt('接龙主题：', '');
    if (title == null) return;
    if (!title.trim()) { toast('主题不能为空', 'warn'); return; }
    createSolang(groupId, title.trim()).then(() => emit('solang-created', {})).catch((e) => toast('发起失败：' + (e.message || e), 'error'));
  }

  // ============================================================
  // 群语音消息 /api/solang/voice —— 复用 voicemsg 上传 + 本端点写群
  // ============================================================
  // voicemsg.uploadBytes(to, blob, name) 返回 { id }；这里拿到 fileId 后发给群。
  async function sendGroupVoice(groupId, fileId) {
    const d = await apiFn('POST', '/api/solang/voice?groupId=' + groupId + '&fileId=' + encodeURIComponent(fileId), { body: {} });
    return d.message;
  }

  async function recordAndSendGroup(groupId) {
    const vis = window.SecureChatExt && window.SecureChatExt.getFeature && window.SecureChatExt.getFeature('voicemsg');
    if (!vis) { toast('语音模块不可用', 'error'); return null; }
    // 复用 voicemsg 的录音：先录音拿到 blob，只上传不发送（uploadBytes 需 to，用 -1 兜底亦可）
    const blob = vis.stop && vis.stop(); // 需先按启动录：简化——由调用方先按住开始
    toast('请通过语音按钮按住录音，松开后选择发送到群', 'info');
    return null;
  }

  const feature = {
    name: 'polls',
    loadByGroup, createPoll, vote, closePoll, renderPollPanel, openCreate, on,
    getPolls: () => polls,
    loadSolangs, createSolang, joinSolang, closeSolang, renderSolangPanel, openCreateSolang, getSolangs: () => solangs,
    sendGroupVoice, recordAndSendGroup,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('polls', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.polls = feature;
  }
})();