'use strict';
/* SecureChat 管理员后台 —— 只读看板，调用 /api/admin/overview */
(function () {
  const API = window.SERVER_HOST || ''; // 同源部署时为 ''，跨源时形如 'https://mc.32768.top:5432'
  const TOKEN_KEY = 'sc_token';        // 与主站保持一致
  const ME_KEY = 'sc_me';
  let refreshTimer = null;

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); }

  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.style.display = ''; }
  function hide(node) { if (node) node.style.display = 'none'; }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
    }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '-';
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // 卡片渲染：把 {label, value, hint} 渲染成网格
  function renderGrid(grid, items) {
    if (!grid) return;
    grid.innerHTML = items.map(it => `
      <div class="stat-card">
        <div class="stat-label">${escapeHtml(it.label)}</div>
        <div class="stat-value">${escapeHtml(it.value)}</div>
        ${it.hint ? `<div class="stat-hint">${escapeHtml(it.hint)}</div>` : ''}
      </div>`).join('');
  }

  // 用户表：显示全部用户（含未在线），含封禁状态与操作
  function renderOnline(list) {
    const tb = el('onlineTbody');
    const q = (el('adminUserSearch') && el('adminUserSearch').value || '').trim().toLowerCase();
    const filtered = q ? list.filter(u => [u.username, u.nickname, u.uid, u.email].some(v => String(v || '').toLowerCase().includes(q))) : list;
    el('onlineCountTag').textContent = '(' + filtered.length + (q ? '/' + list.length : '') + ')';
    if (!filtered.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">没有匹配的用户</td></tr>'; return; }
    tb.innerHTML = filtered.map(u => {
      const onlineBadge = u.online ? '<span class="admin-badge online">在线</span>' : '<span class="admin-badge offline">离线</span>';
      const banBadge = u.banned ? '<span class="admin-badge banned" title="' + escapeHtml(u.banReason || '') + '">已封禁</span>' : '';
      const roleText = (u.role || 'user') === 'admin' ? '管理员' : ((u.role || 'user') === 'vip' ? 'VIP' : '普通');
      const actions = [];
      if (u.banned) actions.push('<button class="admin-action-btn" data-unban="' + u.id + '">解封</button>');
      else actions.push('<button class="admin-action-btn danger" data-ban="' + u.id + '">封禁</button>');
      if (u.online) actions.push('<button class="admin-action-btn" data-kick="' + u.id + '">踢下线</button>');
      actions.push('<button class="admin-action-btn" data-role="' + u.id + '" data-role-cur="' + escapeHtml(u.role || 'user') + '">改角色</button>');
      actions.push('<button class="admin-action-btn" data-nick="' + u.id + '">改昵称</button>');
      actions.push('<button class="admin-action-btn" data-resetpw="' + u.id + '">重置密码</button>');
      return `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.nickname)}</td>
        <td><code>${escapeHtml(u.uid)}</code></td>
        <td>${escapeHtml(u.email || '-')}</td>
        <td>${roleText}</td>
        <td>${onlineBadge} ${banBadge}</td>
        <td>${fmtTime(u.createdAt)}</td>
        <td class="admin-actions-col">${actions.join(' ')}</td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('[data-ban]').forEach(btn => btn.addEventListener('click', () => toggleBan(Number(btn.dataset.ban), true)));
    tb.querySelectorAll('[data-unban]').forEach(btn => btn.addEventListener('click', () => toggleBan(Number(btn.dataset.unban), false)));
    tb.querySelectorAll('[data-kick]').forEach(btn => btn.addEventListener('click', () => kickUser(Number(btn.dataset.kick))));
    tb.querySelectorAll('[data-role]').forEach(btn => btn.addEventListener('click', () => changeRole(Number(btn.dataset.role), btn.dataset.roleCur)));
    tb.querySelectorAll('[data-nick]').forEach(btn => btn.addEventListener('click', () => changeNick(Number(btn.dataset.nick))));
    tb.querySelectorAll('[data-resetpw]').forEach(btn => btn.addEventListener('click', () => resetPassword(Number(btn.dataset.resetpw))));
  }

  // 踢下线
  async function kickUser(id) {
    const token = getToken();
    if (!token) return;
    if (!window.confirm('确认强制下线该用户？')) return;
    try {
      const resp = await fetch(API + '/api/admin/kick', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '操作失败', 'error'); return; }
      toast('已强制下线', 'success');
      await loadAllUsers();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 修改角色
  async function changeRole(id, cur) {
    const next = window.prompt('输入新角色（user / vip / admin），当前：' + cur, cur || 'user');
    if (next === null) return;
    const role = next.trim().toLowerCase();
    if (!['user', 'vip', 'admin'].includes(role)) { toast('角色无效', 'warn'); return; }
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/user/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id, role })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '修改失败', 'error'); return; }
      toast('角色已修改', 'success');
      await loadAllUsers();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 修改昵称
  async function changeNick(id) {
    const nick = window.prompt('输入新昵称：', '');
    if (nick === null || !nick.trim()) return;
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/user/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id, nickname: nick.trim() })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '修改失败', 'error'); return; }
      toast('昵称已修改', 'success');
      await loadAllUsers();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 重置密码
  async function resetPassword(id) {
    const pwd = window.prompt('输入新密码（至少6位），该用户将被强制下线：', '');
    if (pwd === null || !pwd.trim()) return;
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/user/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id, password: pwd.trim() })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '重置失败', 'error'); return; }
      toast('密码已重置并强制下线', 'success');
      await loadAllUsers();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 封禁 / 解封
  async function toggleBan(id, banned) {
    const token = getToken();
    if (!token) return;
    let reason = '';
    if (banned) {
      reason = window.prompt('请输入封禁原因（可留空）：', '');
      if (reason === null) return; // 用户取消
    }
    try {
      const resp = await fetch(API + '/api/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id, banned, reason })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || (banned ? '封禁失败' : '解封失败'), 'error'); return; }
      toast(banned ? '已封禁该用户' : '已解封该用户', 'success');
      await loadAllUsers();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 拉取全部用户列表（含未在线、封禁状态）
  async function loadAllUsers() {
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } });
      if (resp.status !== 200) return;
      const data = await resp.json();
      renderOnline(data.users || []);
    } catch {}
  }

  function renderGroups(rows) {
    const tb = el('groupsTbody');
    if (!rows || !rows.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">暂无群组</td></tr>'; return; }
    tb.innerHTML = rows.map(g => `
      <tr>
        <td>${g.id}</td>
        <td>${escapeHtml(g.name)}</td>
        <td>${g.ownerId}</td>
        <td>${g.memberCount}</td>
        <td>${g.msgCount || 0}</td>
        <td class="admin-actions-col">
          <button class="admin-action-btn" data-gdetail="${g.id}">成员</button>
          <button class="admin-action-btn danger" data-gdissolve="${g.id}" data-gname="${escapeHtml(g.name)}">解散</button>
        </td>
      </tr>`).join('');
    tb.querySelectorAll('[data-gdetail]').forEach(btn => btn.addEventListener('click', () => loadGroupDetail(Number(btn.dataset.gdetail))));
    tb.querySelectorAll('[data-gdissolve]').forEach(btn => btn.addEventListener('click', () => dissolveGroup(Number(btn.dataset.gdissolve), btn.dataset.gname)));
  }

  // 加载全部群组（可搜索）
  async function loadAllGroups(kw) {
    const token = getToken();
    if (!token) return;
    try {
      const q = kw ? ('?q=' + encodeURIComponent(kw)) : '';
      const resp = await fetch(API + '/api/admin/groups' + q, { headers: { 'Authorization': 'Bearer ' + token } });
      if (resp.status !== 200) return;
      const data = await resp.json();
      renderGroups(data.groups || []);
    } catch {}
  }

  // 解散群
  async function dissolveGroup(id, name) {
    const token = getToken();
    if (!token) return;
    if (!window.confirm('确认解散群「' + name + '」？将删除该群所有成员和消息，不可恢复！')) return;
    try {
      const resp = await fetch(API + '/api/admin/group/dissolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '解散失败', 'error'); return; }
      toast('群已解散', 'success');
      hide(el('groupDetail'));
      await loadAllGroups();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 群详情
  async function loadGroupDetail(id) {
    const token = getToken();
    if (!token) return;
    const detail = el('groupDetail');
    if (!detail) return;
    try {
      const resp = await fetch(API + '/api/admin/group/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '加载失败', 'error'); return; }
      show(detail);
      el('groupDetailInfo').innerHTML = '群名：<b>' + escapeHtml(data.group.name) + '</b>　群主ID：' + data.group.ownerId + '　创建：' + fmtTime(data.group.createdAt);
      const tb = el('groupDetailTbody');
      const members = data.members || [];
      if (!members.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">暂无成员</td></tr>'; return; }
      tb.innerHTML = members.map(m => `
        <tr>
          <td>${m.id}</td>
          <td>${escapeHtml(m.username)}</td>
          <td>${escapeHtml(m.nickname)}</td>
          <td><code>${escapeHtml(m.uid || '')}</code></td>
          <td>${m.banned ? '<span class="admin-badge banned">已封禁</span>' : '<button class="admin-action-btn danger" data-grm="${id}" data-grmu="${m.id}">移除</button>'}</td>
        </tr>`).join('');
      tb.querySelectorAll('[data-grm]').forEach(btn => btn.addEventListener('click', () => removeGroupMember(Number(btn.dataset.grm), Number(btn.dataset.grmu))));
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // 移除群成员
  async function removeGroupMember(groupId, userId) {
    const token = getToken();
    if (!token) return;
    if (!window.confirm('确认从群中移除该成员？')) return;
    try {
      const resp = await fetch(API + '/api/admin/group/remove-member', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ groupId, userId })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '移除失败', 'error'); return; }
      toast('成员已移除', 'success');
      loadGroupDetail(groupId);
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  function renderFeedbacks(list, byKind) {
    const wrap = el('fbList');
    if (!wrap) return;
    if (!list || !list.length) { wrap.innerHTML = '<div class="admin-empty">暂无反馈</div>'; return; }
    const me = meOrNull();
    wrap.innerHTML = list.map(f => {
      const cls = 'fb-status ' + (f.status || 'open');
      return `
        <div class="fb-item">
          <div class="fb-head">
            <span class="fb-id">#${f.id}</span>
            <span class="fb-kind kind-${escapeHtml(f.kind)}">${escapeHtml(f.kind)}</span>
            <span class="${cls}">${escapeHtml(f.status)}</span>
            <span class="fb-time">${fmtTime(f.created_at)}</span>
            <span class="fb-user">用户ID ${escapeHtml(f.userId)}</span>
          </div>
          <div class="fb-body">${escapeHtml(f.content)}</div>
          <div class="fb-actions">
            <button class="admin-action-btn" data-fb-id="${f.id}" data-fb-status="processing">处理中</button>
            <button class="admin-action-btn" data-fb-id="${f.id}" data-fb-status="closed">关闭</button>
            <button class="admin-action-btn" data-fb-id="${f.id}" data-fb-status="open">重新打开</button>
          </div>
        </div>`;
    }).join('');
    wrap.querySelectorAll('[data-fb-id]').forEach(btn => btn.addEventListener('click', () => updateFeedbackStatus(btn.dataset.fbId, btn.dataset.fbStatus)));
  }

  async function updateFeedbackStatus(id, status) {
    const token = getToken();
    try {
      const resp = await fetch(API + '/api/admin/feedback/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id: Number(id), status })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '更新反馈失败', 'error'); return; }
      toast('反馈状态已更新', 'success');
      refresh();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  function meOrNull() {
    try { return JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch { return null; }
  }

  // ===== 毫秒级服务器时钟 =====
  // 思路：每次从 /api/admin/overview 拿到 system.serverTime（ISO 字符串）和 startedAt 后，
  // 用本地 Date.now() 作为基准，每 1ms 自己往前推进"服务器时间"。
  // 这样既不每毫秒打接口（性能爆炸），又能精确到毫秒一跳。
  let serverTimeBase = null;     // 最近一次同步到的服务器 absolute epoch ms
  let serverTimeLocalAt = null;   // 同步那一刻的本地 Date.now() ms
  let serverStartedAt = null;
  let clockTimer = null;

  function syncServerClock(serverTimeMs, startedAtMs) {
    if (typeof serverTimeMs === 'number' && !isNaN(serverTimeMs)) {
      serverTimeBase = serverTimeMs;
      serverTimeLocalAt = Date.now();
    }
    if (typeof startedAtMs === 'number' && !isNaN(startedAtMs)) {
      serverStartedAt = startedAtMs;
    }
  }
  function formatMsClock(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '--';
    const d = new Date(ms);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    const pad3 = n => (n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      + '.' + pad3(d.getMilliseconds());
  }
  function startMsClock() {
    if (clockTimer) return; // 已启动
    clockTimer = setInterval(() => {
      if (serverTimeBase === null || serverTimeLocalAt === null) return;
      const cur = serverTimeBase + (Date.now() - serverTimeLocalAt);
      el('rtTime').textContent = formatMsClock(cur);
      // 顺便把运行时长（毫秒）也跟着跳动
      // 找到 sysGrid 中的 "运行时长" 卡片直接改 stat-value（避免整页重渲）
      const card = document.querySelector('#sysGrid .stat-card .stat-value');
      // 第一个卡片就是运行时长
      if (card) card.textContent = humanMsLocal(cur - (serverStartedAt || cur));
    }, 1); // 每 1ms 跳
  }
  function humanMsLocal(ms) {
    if (ms < 0) ms = 0;
    const days = Math.floor(ms / 86400000); ms -= days * 86400000;
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const ms3 = Math.floor(ms);
    const pad3 = n => (n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n));
    if (days > 0) return days + 'd ' + h + 'h ' + m + 'm ' + s + '.' + pad3(ms3) + 's';
    if (h > 0)  return h + 'h ' + m + 'm ' + s + '.' + pad3(ms3) + 's';
    if (m > 0)  return m + 'm ' + s + '.' + pad3(ms3) + 's';
    return s + '.' + pad3(ms3) + 's';
  }

  // 主刷新函数
  async function refresh() {
    const token = getToken();
    if (!token) { showLogin(); return; }
    let resp;
    try {
      resp = await fetch(API + '/api/admin/overview', { headers: { 'Authorization': 'Bearer ' + token } });
    } catch (e) {
      toast('网络错误：' + e.message, 'error');
      return;
    }
    if (resp.status === 401) { clearToken(); showLogin(); return; }
    if (resp.status === 403) {
      toast('当前账号没有管理员权限', 'error');
      const me = meOrNull();
      if (me) el('adminMe').textContent = (me.nickname || me.username) + '（无权限）';
      hide(el('loginMask'));
      return;
    }
    if (!resp.ok) {
      const txt = await resp.text();
      toast('加载失败 (' + resp.status + '): ' + txt, 'error');
      return;
    }
    let data;
    try { data = await resp.json(); } catch (e) { toast('响应解析失败: ' + e.message, 'error'); return; }

    hide(el('loginMask'));
    show(el('adminMain'));
    show(el('realtimeBar'));

    const me = meOrNull();
    el('adminMe').textContent = me ? (me.nickname || me.username) + (data.admin && data.admin.youAre ? ' · ' + (data.admin.youAre.email || '') : '') : '已登录';

    // 实时条
    el('rtOnline').textContent = data.realtime.onlineCount;
    el('rtPeak').textContent = data.realtime.peakConcurrent;
    el('rtSent').textContent = data.realtime.sentMsgsLastMin;
    el('rtRecv').textContent = data.realtime.recvMsgsLastMin;
    el('rtPeakMsg').textContent = data.realtime.peakMsgsPerMin;
    // 服务器时间用本地毫秒时钟推进，每次同步服务器基准
    syncServerClock(new Date(data.system.serverTime).getTime(), data.system.startedAt);
    startMsClock();

    renderGrid(el('sysGrid'), [
      { label: '运行时长', value: data.system.uptimeHuman, hint: '启动时间 ' + fmtTime(data.system.startedAt) },
      { label: '主机名', value: data.system.hostname },
      { label: 'Node 版本', value: data.system.nodeVersion },
      { label: '平台', value: data.system.platform + '/' + data.system.arch },
      { label: 'PID', value: data.system.pid },
      { label: '时区', value: data.system.timezone }
    ]);

    renderGrid(el('userGrid'), [
      { label: '用户总数', value: data.users.total, hint: '今日新增 ' + data.users.newUsersToday },
      { label: '在线用户', value: data.users.online, hint: '峰值 ' + data.realtime.peakConcurrent },
      { label: '今日新增', value: data.users.newUsersToday },
      { label: '近 7 天新增', value: data.users.newUsers7d },
      { label: '近 30 天新增', value: data.users.newUsers30d },
      { label: '已绑邮箱', value: data.users.withEmail },
      { label: '已设头像', value: data.users.withAvatar },
      { label: '已设国家', value: data.users.withCountry },
      { label: '已设城市', value: data.users.withCity },
      { label: '已扩展资料', value: data.users.withExtra }
    ]);
    renderOnline(data.users.onlineUsers);
    await loadAllUsers();

    renderGrid(el('socialGrid'), [
      { label: '好友关系（已成立）', value: data.friendships.accepted },
      { label: '待处理好友请求', value: data.friendships.pending },
      { label: '群组总数', value: data.groups.total },
      { label: '群成员边数', value: data.groups.memberEdges },
      { label: '群消息总数', value: data.groups.messagesTotal, hint: '今日 ' + data.groups.messagesToday },
      { label: '今日群消息', value: data.groups.messagesToday }
    ]);
    renderGroups(data.groups.biggest);

    renderGrid(el('msgGrid'), [
      { label: '私聊总消息数', value: data.messages.privateTotal },
      { label: '今日私聊', value: data.messages.privateToday },
      { label: '私聊已读', value: data.messages.privateRead },
      { label: '私聊未读', value: data.messages.privateUnread },
      { label: '群聊消息总数', value: data.messages.groupTotal },
      { label: '今日群聊', value: data.messages.groupToday },
      { label: '总消息数', value: data.messages.allTotal },
      { label: '今日总消息', value: data.messages.allToday }
    ]);

    el('feedbackTag').textContent = '(' + data.feedbacks.total + ' / 待处理 ' + data.feedbacks.open + ')';
    renderGrid(el('fbGrid'), [
      { label: '反馈总数', value: data.feedbacks.total },
      { label: '待处理', value: data.feedbacks.open },
      { label: '处理中', value: data.feedbacks.processing },
      { label: '已关闭', value: data.feedbacks.closed },
      { label: '今日新反馈', value: data.feedbacks.today },
      { label: 'bug', value: data.feedbacks.byKind.bug },
      { label: 'suggestion', value: data.feedbacks.byKind.suggestion },
      { label: 'complaint', value: data.feedbacks.byKind.complaint },
      { label: 'other', value: data.feedbacks.byKind.other }
    ]);
    renderFeedbacks(data.feedbacks.all);

    renderGrid(el('storeGrid'), [
      { label: 'DB 路径', value: data.storage.dbPath },
      { label: 'DB 大小', value: data.storage.dbSizeHuman, hint: '字节 ' + data.storage.dbSizeBytes }
    ]);

    renderGrid(el('secGrid'), [
      { label: '当前管理员', value: data.admin.youAre ? (data.admin.youAre.username + ' · ' + (data.admin.youAre.email || '-')) : '-' },
      { label: 'JWT secret 是否默认', value: '只读看板，不展示', hint: '建议生产环境用环境变量 JWT_SECRET 覆盖' },
      { label: '管理员邮箱白名单', value: data.admin.adminEmails ? data.admin.adminEmails.join(', ') : '-' }
    ]);

    await loadVersionPanel();
  }

  // ===== 版本 / 发布面板 =====
  // 平台 -> { label, file 主名，扩展名 }
  const PKG_PLATFORMS = {
    windows:        { label: 'Windows 安装包' },
    windowsPortable:{ label: 'Windows 便携版' },
    macos:          { label: 'macOS' },
    android:        { label: 'Android' },
    harmony:        { label: '鸿蒙' },
    ios:            { label: 'iOS' }
  };

  let pkgLatestVersion = '1.0.0';

  async function loadVersionPanel() {
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/version', { headers: { 'Authorization': 'Bearer ' + token } });
      if (resp.status !== 200) return;
      const v = await resp.json();
      pkgLatestVersion = v.latest || '1.0.0';

      renderGrid(el('verGrid'), [
        { label: '当前版本', value: v.current || '-' },
        { label: '最新版本', value: v.latest || '-' },
        { label: '发布时间', value: v.updatedAt ? fmtTime(v.updatedAt) : '-' },
        { label: '更新提示', value: (v.current !== v.latest) ? '有新版本可下载' : '已是最新' }
      ]);

      el('verLatest').value = v.latest || '1.0.0';
      el('verNotes').value = v.releaseNotes || '';
      el('verSavedAt').textContent = v.updatedAt ? '上次更新 ' + fmtTime(v.updatedAt) : '尚未发布更新';

      // 安装包状态
      const dl = v.downloads || {};
      ['windows', 'windowsPortable', 'macos', 'android', 'harmony', 'ios'].forEach(p => {
        const st = el('pkg' + p[0].toUpperCase() + p.slice(1));
        if (!st) return;
        const url = dl[p];
        if (url) {
          const fn = url.split('/').pop();
          st.textContent = '已上传 ' + fn;
          st.classList.add('pkg-ok');
          const del = document.querySelector('.del-btn[data-platform="' + p + '"]');
          if (del) del.style.display = '';
        } else {
          st.textContent = '未上传';
          st.classList.remove('pkg-ok');
          const del = document.querySelector('.del-btn[data-platform="' + p + '"]');
          if (del) del.style.display = 'none';
        }
      });
    } catch (e) { /* 面板加载失败不打断主看板 */ }
  }

  async function saveVersion() {
    const latest = el('verLatest').value.trim();
    const notes = el('verNotes').value.trim();
    if (!/^\d+\.\d+\.\d+$/.test(latest)) { toast('版本号格式错误：应为 x.y.z', 'error'); return; }
    const token = getToken();
    try {
      const resp = await fetch(API + '/api/admin/version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ latest, releaseNotes: notes })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '保存失败', 'error'); return; }
      toast('版本信息已保存', 'success');
      await loadVersionPanel();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  let pkgUploading = false;
  function bindPkgUploads() {
    const input = el('pkgFileInput');
    if (!input) return;
    let currentPlatform = null;

    document.querySelectorAll('.upload-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (pkgUploading) { toast('正在上传中，请稍候', 'error'); return; }
        currentPlatform = btn.dataset.platform;
        input.accept = currentPlatform === 'windows' ? '.exe,.msi' :
          currentPlatform === 'windowsPortable' ? '.zip' :
          currentPlatform === 'macos' ? '.dmg' :
          currentPlatform === 'android' ? '.apk,.aab' :
          currentPlatform === 'harmony' ? '.hap' : '.ipa';
        input.value = '';
        input.click();
      });
    });

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file || !currentPlatform) return;
      pkgUploading = true;
      el('pkgProgress').style.display = '';
      el('pkgProgress').textContent = '上传 ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)…';
      const token = getToken();
      try {
        const resp = await fetch(API + '/api/admin/upload/' + currentPlatform, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token },
          body: file
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) { toast(data.error || '上传失败', 'error'); }
        else {
          toast('上传成功：' + data.file, 'success');
          await loadVersionPanel();
        }
      } catch (e) { toast('上传失败：' + e.message, 'error'); }
      finally {
        pkgUploading = false;
        el('pkgProgress').style.display = 'none';
      }
    });

    document.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const platform = btn.dataset.platform;
        if (!confirm('确定删除 ' + platform + ' 的安装包？')) return;
        const token = getToken();
        try {
          const resp = await fetch(API + '/api/admin/upload/' + platform, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) { toast(data.error || '删除失败', 'error'); return; }
          toast('已删除', 'success');
          await loadVersionPanel();
        } catch (e) { toast('请求失败：' + e.message, 'error'); }
      });
    });
  }

  // 显示登录
  function showLogin() {
    show(el('loginMask'));
    hide(el('adminMain'));
    hide(el('realtimeBar'));
    el('adminMe').textContent = '未登录';
  }

  // 登录模式切换
  window.adminSwitchLoginMode = function (mode) {
    const isCode = mode === 'code';
    const pwdBox = el('loginPwdBox'), codeBox = el('loginCodeBox');
    if (!pwdBox || !codeBox) return;
    pwdBox.style.display = isCode ? 'none' : 'block';
    codeBox.style.display = isCode ? 'block' : 'none';
    el('loginTabPwd').classList.toggle('active', !isCode);
    el('loginTabCode').classList.toggle('active', isCode);
    el('loginErr').textContent = '';
  };

  // 发送验证码
  let adminCodeCooldown = 0, adminCodeTimer = null;
  async function adminSendCode() {
    const email = (el('loginEmail').value || '').trim();
    const errEl = el('loginErr');
    errEl.textContent = '';
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { errEl.textContent = '请输入正确的邮箱'; return; }
    const btn = el('sendCodeBtn');
    btn.disabled = true;
    try {
      const resp = await fetch(API + '/api/email/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, purpose: 'login' })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { errEl.textContent = data.error || '发送失败'; btn.disabled = false; return; }
      adminCodeCooldown = 60;
      btn.textContent = adminCodeCooldown + 's';
      adminCodeTimer = setInterval(() => {
        adminCodeCooldown--;
        if (adminCodeCooldown <= 0) { clearInterval(adminCodeTimer); btn.disabled = false; btn.textContent = '发送验证码'; }
        else { btn.textContent = adminCodeCooldown + 's'; }
      }, 1000);
    } catch (e) { errEl.textContent = '网络错误：' + e.message; btn.disabled = false; }
  }

  // 验证码登录
  async function adminCodeLogin() {
    const email = (el('loginEmail').value || '').trim();
    const code = (el('loginCode').value || '').trim();
    const errEl = el('loginErr');
    errEl.textContent = '';
    if (!email) { errEl.textContent = '请输入邮箱'; return; }
    if (!code) { errEl.textContent = '请输入验证码'; return; }
    let resp;
    try {
      resp = await fetch(API + '/api/login/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
    } catch (e) { errEl.textContent = '网络错误：' + e.message; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { errEl.textContent = data.error || '验证码错误'; return; }
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ME_KEY, JSON.stringify(data.user));
    el('loginCode').value = '';
    await refresh();
  }

  // 登录逻辑
  async function doLogin() {
    const u = el('loginUser').value.trim();
    const p = el('loginPass').value;
    el('loginErr').textContent = '';
    if (!u || !p) { el('loginErr').textContent = '请填写用户名和密码'; return; }
    let resp;
    try {
      resp = await fetch(API + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
    } catch (e) { el('loginErr').textContent = '网络错误：' + e.message; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { el('loginErr').textContent = data.error || '登录失败'; return; }
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ME_KEY, JSON.stringify(data.user));
    el('loginPass').value = '';
    await refresh();
  }

  function logout() {
    clearToken();
    showLogin();
  }

  // 简易 toast（这里不依赖主站 app.js）
  function toast(msg, type) {
    let wrap = document.getElementById('toastWrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2600);
  }

  // ===== 自动刷新控制 =====
  // 默认每 30 秒后自动刷新；如果鼠标在页面任意位置按下/正在滚 fbList，则暂停 5 秒
  let autoRefreshEnabled = true;
  let lastInteraction = 0;
  function pauseAutoRefresh() { lastInteraction = Date.now(); }
  document.addEventListener('mousedown', pauseAutoRefresh);
  document.addEventListener('wheel', pauseAutoRefresh, { passive: true });
  document.addEventListener('touchstart', pauseAutoRefresh, { passive: true });

  function tickAutoRefresh() {
    if (!autoRefreshEnabled) return;
    // 5 秒内有交互则跳过这次刷新
    if (Date.now() - lastInteraction < 5000) {
      updateRealtimeBar();
      return;
    }
    refresh();
  }

  // 实时计数条轻量更新（不重渲整个看板）：只刷新 realtime 字段
  async function updateRealtimeBar() {
    const token = getToken();
    if (!token) return;
    try {
      // 复用 overview，毕竟后端这个 endpoint 不重，开发期没关系
      const resp = await fetch(API + '/api/admin/overview', { headers: { 'Authorization': 'Bearer ' + token } });
      if (resp.status !== 200) return;
      const data = await resp.json();
      el('rtOnline').textContent = data.realtime.onlineCount;
      el('rtPeak').textContent = data.realtime.peakConcurrent;
      el('rtSent').textContent = data.realtime.sentMsgsLastMin;
      el('rtRecv').textContent = data.realtime.recvMsgsLastMin;
      el('rtPeakMsg').textContent = data.realtime.peakMsgsPerMin;
      // 同步服务器时钟基准（毫秒本地推进由 startMsClock 心跳维持）
      syncServerClock(new Date(data.system.serverTime).getTime(), data.system.startedAt);
      startMsClock();
    } catch {}
  }

  // ============ 公告管理 ============
  async function publishAnnouncement() {
    const title = (el('annTitle').value || '').trim();
    const content = (el('annContent').value || '').trim();
    const level = el('annLevel').value;
    const top = el('annTop').checked;
    if (!title || !content) { toast('标题和内容不能为空', 'warn'); return; }
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/announcements', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ title, content, level, top })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '发布失败', 'error'); return; }
      toast('公告已发布并广播', 'success');
      el('annTitle').value = ''; el('annContent').value = '';
      el('annResult').textContent = '已发布 #' + data.announcement.id;
      loadAnnouncements();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }
  async function loadAnnouncements() {
    const token = getToken();
    if (!token) return;
    const list = el('annList');
    if (!list) return;
    try {
      const resp = await fetch(API + '/api/admin/announcements', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      const anns = data.announcements || [];
      if (!anns.length) { list.innerHTML = '<div class="admin-empty">暂无公告</div>'; return; }
      list.innerHTML = anns.map(a => `
        <div class="fb-item">
          <div class="fb-head">
            <span class="fb-id">#${a.id}</span>
            <span class="fb-kind kind-${escapeHtml(a.level)}">${escapeHtml(a.level)}</span>
            ${a.top ? '<span class="admin-badge banned">置顶</span>' : ''}
            <span class="fb-time">${fmtTime(a.createdAt)}</span>
          </div>
          <div class="fb-body"><b>${escapeHtml(a.title)}</b><br>${escapeHtml(a.content)}</div>
          <div class="fb-actions"><button class="admin-action-btn danger" data-ann-del="${a.id}">删除</button></div>
        </div>`).join('');
      list.querySelectorAll('[data-ann-del]').forEach(btn => btn.addEventListener('click', () => deleteAnnouncement(Number(btn.dataset.annDel))));
    } catch {}
  }
  async function deleteAnnouncement(id) {
    const token = getToken();
    if (!token) return;
    if (!window.confirm('确认删除该公告？')) return;
    try {
      const resp = await fetch(API + '/api/admin/announcements?id=' + id, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '删除失败', 'error'); return; }
      toast('公告已删除', 'success');
      loadAnnouncements();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // ============ 封禁 IP ============
  async function banIp() {
    const ip = (el('ipInput').value || '').trim();
    const reason = (el('ipReason').value || '').trim();
    if (!ip) { toast('请输入IP', 'warn'); return; }
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/ban-ip', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ ip, reason })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '封禁失败', 'error'); return; }
      toast('IP 已封禁', 'success');
      el('ipInput').value = ''; el('ipReason').value = '';
      loadBannedIps();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }
  async function loadBannedIps() {
    const token = getToken();
    if (!token) return;
    const tb = el('ipTbody');
    if (!tb) return;
    try {
      const resp = await fetch(API + '/api/admin/banned-ips', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      const ips = data.ips || [];
      if (!ips.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">暂无封禁IP</td></tr>'; return; }
      tb.innerHTML = ips.map(r => `
        <tr>
          <td><code>${escapeHtml(r.ip)}</code></td>
          <td>${escapeHtml(r.reason || '-')}</td>
          <td>${fmtTime(r.created_at)}</td>
          <td><button class="admin-action-btn" data-unbanip="${escapeHtml(r.ip)}">解封</button></td>
        </tr>`).join('');
      tb.querySelectorAll('[data-unbanip]').forEach(btn => btn.addEventListener('click', () => unbanIp(btn.dataset.unbanip)));
    } catch {}
  }
  async function unbanIp(ip) {
    const token = getToken();
    if (!token) return;
    if (!window.confirm('确认解封IP ' + ip + '？')) return;
    try {
      const resp = await fetch(API + '/api/admin/banned-ips?ip=' + encodeURIComponent(ip), {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '解封失败', 'error'); return; }
      toast('IP 已解封', 'success');
      loadBannedIps();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // ============ 敏感词 ============
  async function addSensitiveWord() {
    const word = (el('sensitiveInput').value || '').trim();
    if (!word) { toast('请输入敏感词', 'warn'); return; }
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/sensitive-words', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ word })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '添加失败', 'error'); return; }
      toast('敏感词已添加', 'success');
      el('sensitiveInput').value = '';
      loadSensitiveWords();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }
  async function loadSensitiveWords() {
    const token = getToken();
    if (!token) return;
    const list = el('sensitiveList');
    if (!list) return;
    try {
      const resp = await fetch(API + '/api/admin/sensitive-words', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      const words = data.words || [];
      if (!words.length) { list.innerHTML = '<div class="admin-empty">暂无敏感词</div>'; return; }
      list.innerHTML = words.map(w => '<span class="admin-code-item" title="点击删除" data-sens="' + escapeHtml(w.word) + '">' + escapeHtml(w.word) + ' ×</span>').join('');
      list.querySelectorAll('[data-sens]').forEach(span => span.addEventListener('click', () => removeSensitiveWord(span.dataset.sens)));
    } catch {}
  }
  async function removeSensitiveWord(word) {
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/sensitive-words?word=' + encodeURIComponent(word), {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '删除失败', 'error'); return; }
      toast('已删除', 'success');
      loadSensitiveWords();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // ============ 审计日志 ============
  async function loadAuditLogs() {
    const token = getToken();
    if (!token) return;
    const tb = el('auditTbody');
    if (!tb) return;
    const action = el('auditActionFilter').value;
    try {
      const q = action ? ('?action=' + encodeURIComponent(action)) : '';
      const resp = await fetch(API + '/api/admin/audit' + q, { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      const logs = data.logs || [];
      if (!logs.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">暂无日志</td></tr>'; return; }
      tb.innerHTML = logs.map(l => `
        <tr>
          <td>${fmtTime(l.createdAt)}</td>
          <td>${l.adminId || '-'}</td>
          <td>${escapeHtml(l.action)}</td>
          <td>${l.targetType ? escapeHtml(l.targetType) + ':' + (l.targetId || '-') : '-'}</td>
          <td>${escapeHtml(l.detail || '-')}</td>
          <td><code>${escapeHtml(l.ip || '-')}</code></td>
        </tr>`).join('');
    } catch {}
  }

  // ============ EPay 商户审核 ============
  async function loadMerchants() {
    const token = getToken();
    if (!token) return;
    const tb = el('merchantTbody');
    if (!tb) return;
    try {
      const resp = await fetch(API + '/api/admin/pay/merchants', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      const list = data.merchants || [];
      if (!list.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">暂无商户申请</td></tr>'; return; }
      tb.innerHTML = list.map(m => `
        <tr>
          <td>${m.id}</td>
          <td>${escapeHtml(m.name || '-')}</td>
          <td>${m.userId || '-'}</td>
          <td>${escapeHtml(m.callbackUrl || '-')}</td>
          <td>${escapeHtml(m.authMode || 'local')}</td>
          <td>${m.status === 'approved' ? '<span class="admin-badge online">已通过</span>' : (m.status === 'pending' ? '<span class="admin-badge">审核中</span>' : '<span class="admin-badge banned">已拒绝</span>')}</td>
          <td>${fmtTime(m.createdAt)}</td>
          <td>
            ${m.status !== 'approved' ? `<button class="admin-action-btn" data-merchant-review="${m.id}" data-status="approved">通过</button>` : ''}
            ${m.status !== 'rejected' ? `<button class="admin-action-btn danger" data-merchant-review="${m.id}" data-status="rejected">拒绝</button>` : ''}
          </td>
        </tr>`).join('');
      document.querySelectorAll('[data-merchant-review]').forEach(btn => {
        btn.addEventListener('click', () => reviewMerchant(Number(btn.dataset.merchantReview), btn.dataset.status));
      });
    } catch { tb.innerHTML = '<tr><td colspan="8" class="empty">加载失败</td></tr>'; }
  }

  async function reviewMerchant(id, status) {
    const token = getToken();
    if (!token) return;
    let reason = '';
    if (status === 'rejected') {
      reason = prompt('拒绝原因：') || '';
    }
    try {
      const resp = await fetch(API + '/api/admin/pay/merchants/' + id + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ status, reason })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '操作失败', 'error'); return; }
      toast(status === 'approved' ? '已通过审核' : '已拒绝', 'success');
      loadMerchants();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }

  // ============ EPay 通道配置 ============
  async function loadEpayConfig() {
    const token = getToken();
    if (!token) return;
    try {
      const resp = await fetch(API + '/api/admin/pay/epay/config', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { el('epaySaveTip').textContent = '加载失败：' + (data.error || resp.status); return; }
      const c = data.config || {};
      el('epayEnabled').checked = !!c.enabled;
      el('epaySandbox').checked = !!c.sandbox;
      el('epayBase').value = c.baseUrl || '';
      el('epayGateway').value = c.gatewayUrl || '';
      el('epayGatewayId').value = c.gatewayId || '';
      el('epayPid').value = c.merchantPid || '';
      el('epayKey').value = (c.key && c.key !== '********') ? c.key : '';
      el('epayNotify').value = c.notifyUrl || '';
      el('epayReturn').value = c.returnUrl || '';
      el('epaySaveTip').textContent = '已加载（Key 已隐藏，留空保存则不改动）';
    } catch (e) { el('epaySaveTip').textContent = '加载失败：' + e.message; }
  }

  async function saveEpayConfig() {
    const token = getToken();
    if (!token) return;
    const body = {
      enabled: el('epayEnabled').checked,
      sandbox: el('epaySandbox').checked,
      baseUrl: el('epayBase').value.trim(),
      gatewayUrl: el('epayGateway').value.trim(),
      gatewayId: el('epayGatewayId').value.trim(),
      merchantPid: el('epayPid').value.trim(),
      key: el('epayKey').value.trim(),
      notifyUrl: el('epayNotify').value.trim(),
      returnUrl: el('epayReturn').value.trim()
    };
    try {
      const resp = await fetch(API + '/api/admin/pay/epay/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { toast(data.error || '保存失败', 'error'); return; }
      toast('EPay 配置已保存', 'success');
      loadEpayConfig();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    // 左侧后台分区导航：只切换内容面板，不刷新页面、不丢失滚动位置
    document.querySelectorAll('.admin-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.adminSection;
        document.querySelectorAll('.admin-nav-item').forEach(x => x.classList.toggle('active', x === btn));
        document.querySelectorAll('[data-admin-panel]').forEach(panel => {
          panel.classList.toggle('admin-section-active', panel.dataset.adminPanel === target);
        });
        const main = el('adminMain');
        if (main) main.scrollTop = 0;
        // 按需加载分区数据
        if (target === 'social') loadAllGroups();
        if (target === 'announce') loadAnnouncements();
        if (target === 'ips') loadBannedIps();
        if (target === 'sensitive') loadSensitiveWords();
        if (target === 'audit') loadAuditLogs();
        if (target === 'merchants') loadMerchants();
        if (target === 'epay') loadEpayConfig();
      });
    });
    el('refreshBtn').addEventListener('click', refresh);
    if (el('adminUserSearch')) el('adminUserSearch').addEventListener('input', () => {
      const q = el('adminUserSearch').value.trim().toLowerCase();
      document.querySelectorAll('#onlineTbody tr').forEach(row => { row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    if (el('clearUserSearch')) el('clearUserSearch').addEventListener('click', () => { el('adminUserSearch').value = ''; refresh(); });
    el('logoutBtn').addEventListener('click', logout);
    el('loginGo').addEventListener('click', doLogin);
    el('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    if (el('sendCodeBtn')) el('sendCodeBtn').addEventListener('click', adminSendCode);
    if (el('codeLoginGo')) el('codeLoginGo').addEventListener('click', adminCodeLogin);
    if (el('loginEmail')) el('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') adminSendCode(); });
    el('verSaveBtn').addEventListener('click', saveVersion);
    bindPkgUploads();
    // 公告
    if (el('annPublishBtn')) el('annPublishBtn').addEventListener('click', publishAnnouncement);
    // 封禁IP
    if (el('ipBanBtn')) el('ipBanBtn').addEventListener('click', banIp);
    // 敏感词
    if (el('sensitiveAddBtn')) el('sensitiveAddBtn').addEventListener('click', addSensitiveWord);
    // 审计日志
    if (el('auditRefreshBtn')) el('auditRefreshBtn').addEventListener('click', loadAuditLogs);
    if (el('merchantRefreshBtn')) el('merchantRefreshBtn').addEventListener('click', loadMerchants);
    if (el('epaySaveBtn')) el('epaySaveBtn').addEventListener('click', saveEpayConfig);
    // 群组
    if (el('groupSearchBtn')) el('groupSearchBtn').addEventListener('click', () => loadAllGroups(el('groupSearch').value.trim()));
    if (el('groupLoadBtn')) el('groupLoadBtn').addEventListener('click', () => loadAllGroups());
    if (el('groupDetailClose')) el('groupDetailClose').addEventListener('click', () => hide(el('groupDetail')));
    // 自动刷新开关
    el('autoBtn').addEventListener('click', () => {
      autoRefreshEnabled = !autoRefreshEnabled;
      el('autoBtn').textContent = '自动刷新: ' + (autoRefreshEnabled ? '开' : '关');
    });
    refresh();
    // 实时条 5 秒一刷（轻量），看板整页 30 秒一刷但用户暂停
    setInterval(updateRealtimeBar, 5 * 1000);
    refreshTimer = setInterval(tickAutoRefresh, 30 * 1000);
  });

  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); });

  // ============ 兑换码管理 ============
  let redeemClaimedFilter = '';
  function loadRedeemCodes(claimed) {
    redeemClaimedFilter = claimed || '';
    const tb = el('redeemTbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999">加载中...</td></tr>';
    const token = getToken();
    if (!token) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#c0392b">请先登录</td></tr>'; return; }
    fetch(API + '/api/admin/redeem' + (claimed !== undefined && claimed !== '' ? '?claimed=' + claimed : ''), {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => r.json()).then(data => {
      const codes = data.codes || [];
      if (!codes.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999">暂无兑换码</td></tr>'; return; }
      tb.innerHTML = codes.map(c => {
        const used = !!c.claimed_by;
        const statusHtml = used
          ? '<span class="admin-badge banned">已使用</span>'
          : '<span class="admin-badge online">未使用</span>';
        const claimedAt = c.claimed_at ? fmtTime(c.claimed_at) : '-';
        const claimer = c.claimed_by ? String(c.claimed_by).slice(0, 8) : '-';
        return `<tr>
          <td><code>${escapeHtml(c.code)}</code></td>
          <td>${c.value}元</td>
          <td>${statusHtml}</td>
          <td>${claimedAt}</td>
          <td>${escapeHtml(claimer)}</td>
        </tr>`;
      }).join('');
    }).catch(e => { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#c0392b">加载失败: ' + escapeHtml(e.message) + '</td></tr>'; });
  }
  function renderRedeemResult(codes, value) {
    const list = el('redeemCodeList');
    const countEl = el('redeemResultCount');
    const resultDiv = el('redeemResult');
    if (!list || !countEl || !resultDiv) return;
    countEl.textContent = codes.length;
    list.innerHTML = codes.map(c => `<code class="admin-redeem-code" title="点击复制">${escapeHtml(c)}</code>`).join('');
    resultDiv.style.display = '';
    list.querySelectorAll('.admin-redeem-code').forEach(el => {
      el.addEventListener('click', () => {
        navigator.clipboard.writeText(el.textContent).then(() => {
          const orig = el.textContent;
          el.textContent = '✓ 已复制';
          setTimeout(() => { el.textContent = orig; }, 1200);
        });
      });
    });
  }
  el('redeemIssueBtn').addEventListener('click', () => {
    const value = parseFloat(el('redeemValue').value);
    const count = Math.min(parseInt(el('redeemCount').value) || 1, 500);
    if (!value || value <= 0) { alert('请输入有效面值'); return; }
    const btn = el('redeemIssueBtn');
    btn.disabled = true; btn.textContent = '生成中...';
    const token = getToken();
    fetch(API + '/api/admin/redeem/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ value, count })
    }).then(r => r.json()).then(data => {
      if (!data.ok) throw new Error(data.error || '生成失败');
      renderRedeemResult(data.codes, value);
      loadRedeemCodes(redeemClaimedFilter);
    }).catch(e => { alert('生成失败: ' + e.message); }).finally(() => { btn.disabled = false; btn.textContent = '生成兑换码'; });
  });
  el('redeemCopyAllBtn').addEventListener('click', () => {
    const codes = Array.from(el('redeemCodeList').querySelectorAll('.admin-redeem-code')).map(e => e.textContent);
    navigator.clipboard.writeText(codes.join('\n')).then(() => alert('已复制 ' + codes.length + ' 个兑换码'));
  });
  document.querySelectorAll('.admin-redeem-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-redeem-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      loadRedeemCodes(tab.dataset.claimed);
    });
  });
  // 切换到兑换码面板时自动加载
  document.querySelectorAll('.admin-nav-item').forEach(btn => {
    if (btn.dataset.adminSection === 'redeem') {
      btn.addEventListener('click', () => loadRedeemCodes(redeemClaimedFilter));
    }
  });
})();
