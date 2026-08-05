'use strict';

// 客户端打包版本号；与服务端 /api/version.current 比对，最新版后会弹更新浮层。
const PACKAGE_VERSION = '1.24.3';

const P = {
  C_AUTH: 'auth', C_MSG: 'msg', C_READ: 'read', C_TYPING: 'typing',
  C_SIGNAL: 'signal',
  C_GROUP_MSG: 'group_msg', C_GROUP_READ: 'group_read',
  S_AUTH_OK: 'auth_ok', S_AUTH_FAIL: 'auth_fail', S_MSG: 'msg',
  S_USER_LIST: 'user_list', S_TYPING: 'typing', S_ERROR: 'error',
  S_SIGNAL: 'signal',
  S_FRIEND_REQ: 'friend_req', S_FRIEND_LIST: 'friend_list',
  S_GROUP_MSG: 'group_msg', S_GROUP_LIST: 'group_list'
};

let state = {
  token: null,
  me: null,
  serverHost: window.SERVER_HOST,
  ws: null,
  wsAuthed: false,
  outboundQueue: [],
  users: [],
  friends: [],
  pendingReq: [],
  activePeer: null,
  unread: {},
  lastFrom: {},
  // E2EE：本账号私钥（JWK），登录成功后填充
  myPrivJwk: null,
  // 已发送消息明文缓存：clientMsgId -> 明文，用于服务端回包替换密文显示原文字
  sentPlain: {},
  // 本地已发送（乐观渲染）消息：clientMsgId -> true，用于去重服务端回显
  pendingLocal: {},
  // 群组
  tabContact: 'friends',   // 'friends' | 'groups'
  groups: [],
  activeGroup: null,
  groupUnread: {},
  groupMsgs: {},           // groupId -> 已加载消息数组（仅本地缓存当前/历史）
};

const $ = (id) => document.getElementById(id);

// i18n 短名：拿不到字典或字典里尚未收录该 key 时，回退到原中文，避免硬编码外文。
function t(key, fallback) {
  if (window.SCI18N && typeof SCI18N.t === 'function') {
    const v = SCI18N.t(key);
    // SCI18N.t 在缺失 key 时会返回 key 本身；此时落到 fallback。
    if (v && v !== key) return v;
  }
  return (fallback != null ? fallback : key);
}

function chatPrefs() {
  const key = 'sc_chat_prefs_' + ((state.me && state.me.id) || 'guest');
  try { return JSON.parse(localStorage.getItem(key) || '{"pinned":{},"muted":{}}'); } catch { return { pinned: {}, muted: {} }; }
}
function saveChatPrefs(prefs) {
  const key = 'sc_chat_prefs_' + ((state.me && state.me.id) || 'guest');
  localStorage.setItem(key, JSON.stringify(prefs));
}
function activeConversationKey() {
  if (state.activeGroup) return 'g:' + state.activeGroup;
  if (state.activePeer) return 'u:' + state.activePeer;
  return '';
}
function draftStorageKey() {
  return 'sc_drafts_' + ((state.me && state.me.id) || 'guest');
}
function readDrafts() {
  try { return JSON.parse(localStorage.getItem(draftStorageKey()) || '{}'); } catch { return {}; }
}
function saveCurrentDraft() {
  const key = activeConversationKey();
  if (!key) return;
  const drafts = readDrafts();
  const value = $('input').value;
  if (value) drafts[key] = value;
  else delete drafts[key];
  localStorage.setItem(draftStorageKey(), JSON.stringify(drafts));
  const hint = $('draftState'); if (hint) hint.textContent = value ? '草稿已保存' : '草稿自动保存';
}
function restoreCurrentDraft() {
  const key = activeConversationKey();
  const input = $('input');
  if (!input) return;
  input.value = key ? (readDrafts()[key] || '') : '';
  const hint = $('draftState'); if (hint) hint.textContent = input.value ? '已恢复草稿' : '草稿自动保存';
}

// ============ 个人资料字段定义（≥100 项） ============
// 独立列字段：nickname / country / province / city（不放进 extra）。
// 其它字段全部存入 extra（JSON 对象，扁平 key-value）。
const PROFILE_FIELDS = [
  { cat: '身份', items: [
    { key: 'realname', label: '真实姓名', placeholder: '可不填' },
    { key: 'englishName', label: '英文名' },
    { key: 'alias', label: '别名 / 昵称' },
    { key: 'gender', label: '性别' },
    { key: 'orientation', label: '性取向' },
    { key: 'marital', label: '婚姻状况' },
    { key: 'birthday', label: '生日', placeholder: 'YYYY-MM-DD' },
    { key: 'bloodType', label: '血型' },
    { key: 'zodiac', label: '星座' },
    { key: 'chineseZodiac', label: '生肖' },
    { key: 'height', label: '身高(cm)' },
    { key: 'weight', label: '体重(kg)' },
    { key: 'race', label: '民族 / 种族' },
    { key: 'idType', label: '证件类型' },
  ] },
  { cat: '地区', items: [
    { key: 'hometown', label: '籍贯 / 故乡' },
    { key: 'nationality', label: '国籍' },
    { key: 'timezone', label: '时区' },
    { key: 'language', label: '母语' },
    { key: 'languages2', label: '其它语言' },
    { key: 'district', label: '区 / 县' },
    { key: 'street', label: '街道 / 地址' },
    { key: 'village', label: '小区' },
    { key: 'zip', label: '邮编' },
    { key: 'currentAddress', label: '现住地址' },
    { key: 'workAddress', label: '工作地址' },
  ] },
  { cat: '职业', items: [
    { key: 'company', label: '公司' },
    { key: 'jobTitle', label: '职位' },
    { key: 'department', label: '部门' },
    { key: 'workPhone', label: '工作电话' },
    { key: 'workEmail', label: '工作邮箱' },
    { key: 'industry', label: '行业' },
    { key: 'jobLevel', label: '职级' },
    { key: 'experience', label: '工作年限' },
    { key: 'skills', label: '技能特长' },
    { key: 'jobStatus', label: '在职状态' },
    { key: 'salary', label: '薪资范围' },
    { key: 'gitHub', label: 'GitHub' },
  ] },
  { cat: '教育', items: [
    { key: 'eduLevel', label: '最高学历' },
    { key: 'school', label: '毕业院校' },
    { key: 'major', label: '专业' },
    { key: 'graduation', label: '毕业时间' },
    { key: 'degree', label: '学位' },
    { key: 'classRank', label: '班级' },
    { key: 'studentId', label: '学号' },
    { key: 'highSchool', label: '高中' },
    { key: 'middleSchool', label: '初中' },
    { key: 'primarySchool', label: '小学' },
    { key: 'gpa', label: 'GPA' },
    { key: 'advisor', label: '导师' },
  ] },
  { cat: '联系方式', items: [
    { key: 'phone', label: '手机号' },
    { key: 'tel', label: '座机' },
    { key: 'fax', label: '传真' },
    { key: 'qq', label: 'QQ' },
    { key: 'wechat', label: '微信' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'twitter', label: 'Twitter / X' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'discord', label: 'Discord' },
    { key: 'weibo', label: '微博' },
    { key: 'bilibili', label: 'B 站 ID' },
    { key: 'zhihu', label: '知乎' },
    { key: 'website', label: '个人网站' },
    { key: 'blog', label: '博客' },
  ] },
  { cat: '兴趣爱好', items: [
    { key: 'hobby1', label: '爱好 #1' },
    { key: 'hobby2', label: '爱好 #2' },
    { key: 'hobby3', label: '爱好 #3' },
    { key: 'reading', label: '常读书籍' },
    { key: 'readingType', label: '阅读类型' },
    { key: 'sports', label: '运动' },
    { key: 'sportTeam', label: '主队 / 球队' },
    { key: 'game', label: '游戏' },
    { key: 'gameId', label: '游戏 ID' },
    { key: 'travel', label: '常去旅行地' },
    { key: 'food', label: '喜欢的食物' },
    { key: 'drink', label: '喜欢的饮料' },
    { key: 'pet', label: '宠物' },
    { key: 'plant', label: '植物' },
    { key: 'photo', label: '摄影' },
    { key: 'collection', label: '收藏' },
    { key: 'diy', label: '手作 / DIY' },
    { key: 'car', label: '座驾' },
    { key: 'movie', label: '常看电影' },
    { key: 'anime', label: '动漫' },
  ] },
  { cat: '音乐/影视', items: [
    { key: 'singer', label: '喜欢的歌手' },
    { key: 'band', label: '喜欢的乐队' },
    { key: 'song', label: '喜欢的歌' },
    { key: 'album', label: '喜欢的专辑' },
    { key: 'musicType', label: '音乐类型' },
    { key: 'instrument', label: '乐器' },
    { key: 'movie1', label: '喜欢的电影' },
    { key: 'director', label: '喜欢的导演' },
    { key: 'actor', label: '喜欢的演员' },
    { key: 'actress', label: '喜欢的女演员' },
    { key: 'movieType', label: '电影类型' },
    { key: 'tvShow', label: '追的剧' },
    { key: 'show', label: '综艺节目' },
    { key: 'podcast', label: '听的播客' },
    { key: 'idol', label: '偶像' },
  ] },
  { cat: '生活方式', items: [
    { key: 'smoke', label: '是否吸烟' },
    { key: 'drinkAlcohol', label: '是否饮酒' },
    { key: 'sleepTime', label: '作息' },
    { key: 'diet', label: '饮食偏好' },
    { key: 'religion', label: '宗教信仰' },
    { key: 'political', label: '政治倾向' },
    { key: 'vehicle', label: '出行交通' },
    { key: 'house', label: '住房' },
    { key: 'salaryIdeal', label: '理想收入' },
    { key: 'fitness', label: '健身频率' },
    { key: 'cooking', label: '是否会做饭' },
  ] },
  { cat: '价值观', items: [
    { key: 'motto', label: '座右铭' },
    { key: 'dream', label: '理想 / 梦想' },
    { key: 'religionPref', label: '择偶信仰倾向' },
    { key: 'value1', label: '最看重的事 1' },
    { key: 'value2', label: '最看重的事 2' },
    { key: 'value3', label: '最看重的事 3' },
    { key: 'idealAge', label: '理想伴侣年龄' },
    { key: 'idealHeight', label: '理想伴侣身高' },
    { key: 'idealJob', label: '理想伴侣职业' },
    { key: 'idealCharacter', label: '理想伴侣性格' },
    { key: 'taboo', label: '不能接受的' },
  ] },
  { cat: '个性签名', items: [
    { key: 'signature', label: '个性签名' },
    { key: 'status', label: '状态' },
    { key: 'intro', label: '自我介绍' },
    { key: 'nickname2', label: '其它昵称' },
    { key: 'tagline', label: '一句话标签' },
    { key: 'mood', label: '心情' },
  ] },
];

// 自定义 Toast 提示（替代 alert）
function toast(msg, kind /* info|success|error|warn */, ms) {
  kind = kind || 'info';
  ms = ms || 2200;
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ico = { info: 'i', success: '✓', error: '!', warn: '!' }[kind] || 'i';
  el.innerHTML = '<div class="ico">' + ico + '</div><div>' + escapeHtml(msg) + '</div>';
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ============ 登录/注册 ============
let mode = 'login';
let loginMode = 'password'; // 'password' | 'code'（仅登录模式生效）

// 根据当前 mode 与 loginMode 统一刷新登录/注册表单字段的显隐
function applyLoginMode() {
  const showReg = mode === 'register';
  $('nickname').style.display = showReg ? 'block' : 'none';
  $('customUid').style.display = showReg ? 'block' : 'none';
  $('country').style.display = showReg ? 'block' : 'none';
  $('province').style.display = showReg ? 'block' : 'none';
  $('city').style.display = showReg ? 'block' : 'none';
  // 登录方式切换控件：仅登录模式显示
  $('loginModeRow').style.display = showReg ? 'none' : 'flex';
  const useCode = !showReg && loginMode === 'code';
  // 密码登录：用户名 + 密码；验证码登录：邮箱 + 验证码
  $('username').style.display = (showReg || !useCode) ? 'block' : 'none';
  $('password').style.display = (showReg || !useCode) ? 'block' : 'none';
  $('email').style.display = (showReg || useCode) ? 'block' : 'none';
  $('codeRow').style.display = (showReg || useCode) ? 'flex' : 'none';
  // 密码登录时用户名输入框 placeholder 为「用户名或邮箱」；注册/验证码登录时为「用户名」
  $('username').placeholder = (showReg || useCode) ? t('username', '用户名') : t('usernameOrEmail', '用户名或邮箱');
  // 邮箱 placeholder：注册时提示「注册时填写」，登录验证码时提示「邮箱」
  $('email').placeholder = showReg ? t('email', '邮箱（注册时填写）') : t('emailLogin', '邮箱');
  // 登录方式按钮高亮
  document.querySelectorAll('.login-mode-btn').forEach(b => b.classList.toggle('on', b.dataset.loginMode === loginMode));
  $('authErr').textContent = '';
}

document.querySelectorAll('.tab').forEach(tt => {
  tt.onclick = () => {
    mode = tt.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === tt));
    $('authBtn').textContent = mode === 'login' ? '登录' : '注册';
    applyLoginMode();
  };
});

// 登录方式切换按钮
document.querySelectorAll('.login-mode-btn').forEach(b => {
  b.onclick = () => {
    loginMode = b.dataset.loginMode;
    applyLoginMode();
  };
});

// 初始化登录页，首次打开时直接显示密码登录/验证码登录切换。
applyLoginMode();

$('authBtn').onclick = async () => {
  const username = $('username').value.trim();
  const password = $('password').value;
  const nickname = $('nickname').value.trim();
  const email = $('email').value.trim();
  const code = $('code').value.trim();
  const country = $('country') ? $('country').value.trim() : '';
  const province = $('province') ? $('province').value.trim() : '';
  const city = $('city') ? $('city').value.trim() : '';
  $('authErr').textContent = '';
  let endpoint, body;
  if (mode === 'register') {
    // 注册：用户名 + 密码 + 邮箱 + 验证码
    if (!username || !password) { $('authErr').textContent = '请输入用户名和密码'; return; }
    if (!email) { $('authErr').textContent = '请填写邮箱'; return; }
    if (!code) { $('authErr').textContent = '请输入邮箱验证码'; return; }
    endpoint = '/api/register';
    body = { username, password, nickname, email, code, customUid: $('customUid').value.trim(), country, province, city };
  } else if (loginMode === 'code') {
    // 登录-验证码：邮箱 + 验证码
    if (!email) { $('authErr').textContent = '请填写邮箱'; return; }
    if (!code) { $('authErr').textContent = '请输入邮箱验证码'; return; }
    endpoint = '/api/login/code';
    body = { email, code };
  } else {
    // 登录-密码：账号（用户名或邮箱）+ 密码
    if (!username || !password) { $('authErr').textContent = '请输入用户名或邮箱和密码'; return; }
    endpoint = '/api/login';
    body = { account: username, password };
  }
  try {
    const res = await fetch(state.serverHost + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { $('authErr').textContent = data.error || '请求失败'; return; }
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('sc_token', state.token);
    localStorage.setItem('sc_me', JSON.stringify(state.me));
    enterChat();
  } catch (e) {
    $('authErr').textContent = '无法连接服务器：' + e.message;
  }
};

// 发送邮箱验证码（注册用 purpose='register'；登录验证码登录用 purpose='login'）
let codeTimer = null;
$('sendCodeBtn').onclick = async () => {
  const email = $('email').value.trim();
  if (!email) { $('authErr').textContent = '请先填写邮箱'; return; }
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { $('authErr').textContent = '邮箱格式错误'; return; }
  // 根据当前状态决定验证码用途：注册 → register；登录+验证码登录 → login
  const purpose = mode === 'register' ? 'register' : 'login';
  $('sendCodeBtn').disabled = true;
  $('authErr').textContent = '正在发送验证码...';
  try {
    const res = await fetch(state.serverHost + '/api/email/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, purpose })
    });
    const data = await res.json();
    if (!res.ok) { $('authErr').textContent = data.error || '发送失败'; $('sendCodeBtn').disabled = false; return; }
    $('authErr').textContent = '';
    toast('验证码已发送，请查收邮箱', 'success');
    // 60s 倒计时
    let n = 60;
    $('sendCodeBtn').textContent = n + 's';
    if (codeTimer) clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(codeTimer); $('sendCodeBtn').textContent = t('sendCode', '发送验证码'); $('sendCodeBtn').disabled = false; }
      else $('sendCodeBtn').textContent = n + 's';
    }, 1000);
  } catch (e) {
    $('authErr').textContent = '发送失败：' + e.message;
    $('sendCodeBtn').disabled = false;
    $('sendCodeBtn').textContent = t('sendCode', '发送验证码');
  }
};

$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authBtn').click(); });

// ---------- 自动检查更新 ----------
// 语义化版本比较：返回 -1/0/1
function cmpVersion(a, b) {
  a = String(a || '0').split('.');
  b = String(b || '0').split('.');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = parseInt(a[i] || '0', 10) || 0;
    const bi = parseInt(b[i] || '0', 10) || 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}
// 每次（登录/进入聊天页）自动拉 /api/version，若 latest > 当前 PACKAGE_VERSION 则弹更新浮层。
async function checkUpdate() {
  if (/Electron\//i.test(navigator.userAgent || '')) return;
  try {
    const res = await fetch(state.serverHost + '/api/version');
    if (!res.ok) return;
    const data = await res.json();
    if (cmpVersion(PACKAGE_VERSION, data.latest) < 0) {
      $('updateTitle').textContent = '发现新版本 v' + data.latest;
      let notes = (data.releaseNotes || '').trim();
      // 把换行或分号切分为列表展示
      let html = '';
      String(notes || '').split(/\r?\n|;/).map(s => s.trim()).filter(Boolean)
        .forEach(line => { html += '<div>• ' + escapeHtml(line) + '</div>'; });
      if (!html) html = '<div>• ' + escapeHtml(data.latest || '') + '</div>';
      $('updateNotes').innerHTML = html;
      $('updateMask').style.display = 'flex';
      // 绑定按钮（每次都重绑，防止旧闭包）
      $('updateNowBtn').onclick = function () { window.open('download.html', '_blank'); };
      $('updateLaterBtn').onclick = function () { $('updateMask').style.display = 'none'; };
    }
  } catch (e) { /* 静默：检查更新失败不应打扰用户 */ }
}

// 自动恢复登录（先验证 token 再进聊天）
function tryRestore() {
  const savedToken = localStorage.getItem('sc_token');
  const savedMe = localStorage.getItem('sc_me');
  if (!savedToken || !savedMe) return;
  try {
    state.token = savedToken;
    state.me = JSON.parse(savedMe);
  } catch {
    localStorage.removeItem('sc_token');
    localStorage.removeItem('sc_me');
    return;
  }
  fetch(state.serverHost + '/api/users', { headers: { 'Authorization': 'Bearer ' + state.token } })
    .then((res) => {
      if (res.ok) enterChat();
      else { localStorage.removeItem('sc_token'); localStorage.removeItem('sc_me'); state.token = null; state.me = null; }
    })
    .catch(() => { localStorage.removeItem('sc_token'); localStorage.removeItem('sc_me'); state.token = null; state.me = null; });
}

function logout() {
  localStorage.removeItem('sc_token');
  localStorage.removeItem('sc_me');
  state.token = null; state.me = null;
  state.myPrivJwk = null;
  if (window.SCE2EE) window.SCE2EE._cache = {};
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  $('chatView').style.display = 'none';
  $('authView').style.display = 'flex';
}

// ============ 进入聊天 ============
function enterChat() {
  $('authView').style.display = 'none';
  $('chatView').style.display = 'flex';
  renderMyInfo();
  // 恢复该用户自定义聊天背景图（每个用户独立存储）
  applyChatBg(getChatBg());
  connectWS();
  loadFriends();
  // E2EE 已停用：消息以明文发送，不再生成/上传密钥。
}

function renderMyInfo() {
  const hasImg = state.me && state.me.avatar;
  const avHtml = hasImg ? '<img src="' + state.me.avatar + '">'
    : avatarChar(state.me.nickname);
  // 地区：country/province/city 是独立列；若三者皆空，再尝试从 extra 取现住地（currentAddress / hometown）
  const c = (state.me && state.me.country) || '';
  const p = (state.me && state.me.province) || '';
  const ct = (state.me && state.me.city) || '';
  const regionParts = [c, p, ct].filter(Boolean);
  const extra = (state.me && state.me.extra) || {};
  let regionText = regionParts.join(' ');
  if (!regionText) {
    const cur = extra.currentAddress || extra.hometown || '';
    if (cur) regionText = cur;
  }
  let regionHtml;
  if (regionText) {
    regionHtml = '<div class="my-id region-display" style="cursor:pointer" title="点击编辑资料">' + escapeHtml(regionText) + '</div>';
  } else {
    regionHtml = '<div class="my-id" style="cursor:pointer" id="emptyRegionTip">地区：未设置，点“资料”填写</div>';
  }
  const dark = document.body.classList.contains('dark-mode');
  $('myInfo').innerHTML = '<div class="account-card">'
    + '<div class="account-main">'
    + '<div class="avatar my-avatar" id="myAvatar" title="点击换头像">' + avHtml + '</div>'
    + '<div class="account-copy"><div class="my-name">' + escapeHtml(state.me.nickname) + '</div>'
    + '<div class="my-id" id="myIdText" style="cursor:pointer" title="点击复制ID">ID: ' + (state.me.uid || '') + '</div></div>'
    + '<button class="account-exit" id="logoutBtn" title="' + escapeHtml(t('logout', '退出登录')) + '">' + escapeHtml(t('logout', '退出')) + '</button>'
    + '</div>'
    + '<div class="account-region">' + regionHtml + '</div>'
    + '<div class="account-toolbar">'
    + '<button class="account-tool" id="editProfileBtn">' + escapeHtml(t('profile', '资料')) + '</button>'
    + '<button class="account-tool" id="editUidBtn">' + escapeHtml(t('editUid', '改 ID')) + '</button>'
    + '<button class="account-tool" id="bgBtn">' + escapeHtml(t('background', '背景')) + '</button>'
    + '<button class="account-tool" id="feedbackBtn">' + escapeHtml(t('feedback', '反馈')) + '</button>'
    + '<span class="theme-switch" role="group" aria-label="外观主题">'
    + '<button class="theme-choice' + (!dark ? ' active' : '') + '" id="themeDayBtn">' + escapeHtml(t('light', '日')) + '</button>'
    + '<button class="theme-choice' + (dark ? ' active' : '') + '" id="themeNightBtn">' + escapeHtml(t('dark', '夜')) + '</button>'
    + '</span></div>'
    + '</div>';
  // 账户卡里若子标签后续加了 data-i18n，apply() 会兜底；这里再扫一次。
  if (window.SCI18N && typeof SCI18N.apply === 'function') SCI18N.apply($('myInfo'));
  $('myAvatar').onclick = pickAvatar;
  $('bgBtn').onclick = pickChatBg;
  $('editUidBtn').onclick = editUid;
  $('editProfileBtn').onclick = editProfile;
  $('feedbackBtn').onclick = openFeedback;
  const setLocalTheme = (wantDark) => {
    document.body.classList.toggle('dark-mode', wantDark);
    localStorage.setItem('sc_theme', wantDark ? 'dark' : 'light');
    renderMyInfo();
  };
  $('themeDayBtn').onclick = () => setLocalTheme(false);
  $('themeNightBtn').onclick = () => setLocalTheme(true);
  const rEl = $('myInfo').querySelector('.region-display') || $('emptyRegionTip');
  if (rEl) rEl.onclick = editProfile;
  $('logoutBtn').onclick = logout;
  $('myIdText').onclick = () => {
    const uid = state.me && state.me.uid;
    if (!uid) { toast('暂无ID可复制', 'warn', 1000); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(uid))
        .then(() => toast('ID 已复制', 'success', 1000))
        .catch(() => toast('复制失败', 'error', 1000));
    } else {
      toast('当前浏览器不支持复制', 'warn', 1000);
    }
  };
}

// 通用模态弹窗（替代浏览器 prompt/confirm）
function openModal(title, fields, onOk) {
  // fields: [{key, label, value, placeholder}]
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  // 顶部栏：标题 + 叉叉（叉叉等同取消）
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x';
  xBtn.type = 'button';
  xBtn.setAttribute('aria-label', '关闭');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3);
  head.appendChild(xBtn);
  box.appendChild(head);
  fields.forEach(f => {
    const w = document.createElement('div');
    w.className = 'field';
    w.innerHTML = '<label>' + escapeHtml(f.label) + '</label>';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = f.value || ''; inp.placeholder = f.placeholder || '';
    f._el = inp;
    w.appendChild(inp);
    box.appendChild(w);
  });
  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'cancel'; cancel.textContent = '取消';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = '保存';
  acts.appendChild(cancel); acts.appendChild(ok);
  box.appendChild(acts);
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  cancel.onclick = close;
  xBtn.onclick = close;
  ok.onclick = () => {
    const out = {};
    fields.forEach(f => out[f.key] = f._el.value.trim());
    onOk(out, close);
  };
  // 点遮罩关闭
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  // ESC 关闭
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  // 自动聚焦第一个
  if (fields[0] && fields[0]._el) fields[0]._el.focus();
}

// 编辑个人资料：滚动 modal，按 PROFILE_FIELDS 分类列出所有字段。
// nickname/country/province/city 走独立列；其余所有字段全部塞进 extra。
function editProfile() {
  if (!state.me) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal modal-scroll';
  // 顶部带叉叉的标题栏
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = '编辑个人资料';
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x';
  xBtn.type = 'button';
  xBtn.setAttribute('aria-label', '关闭');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3);
  head.appendChild(xBtn);
  box.appendChild(head);
  // 顶部第一个分类：身份信息（昵称独立列）
  const headCat = document.createElement('div');
  headCat.className = 'field-cat';
  headCat.textContent = '基本信息';
  box.appendChild(headCat);
  const builtIn = [
    { key: 'nickname', label: '昵称', value: state.me.nickname || '', placeholder: '你的昵称' },
    { key: 'country',  label: '国家 / 地区', value: state.me.country || '', placeholder: '如：中国' },
    { key: 'province', label: '省 / 州', value: state.me.province || '', placeholder: '可留空' },
    { key: 'city',     label: '城市', value: state.me.city || '', placeholder: '可留空' }
  ];
  const builtInEls = {};
  builtIn.forEach(f => appendFieldRow(box, f.key, f.label, f.value, f.placeholder, builtInEls));
  const extraInputs = {};
  const extra = state.me.extra || {};
  PROFILE_FIELDS.forEach(group => {
    const h = document.createElement('div');
    h.className = 'field-cat';
    h.textContent = group.cat;
    box.appendChild(h);
    group.items.forEach(it => appendFieldRow(box, it.key, it.label, extra[it.key] || '', it.placeholder || '', extraInputs));
  });
  // 按钮
  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  acts.style.marginTop = '18px';
  const cancel = document.createElement('button');
  cancel.className = 'cancel'; cancel.textContent = '取消';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = '保存';
  acts.appendChild(cancel); acts.appendChild(ok);
  box.appendChild(acts);
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  cancel.onclick = close;
  xBtn.onclick = close;
  // ESC 关闭
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  ok.onclick = () => {
    const patch = {
      nickname: builtInEls.nickname.value.trim(),
      country: builtInEls.country.value.trim(),
      province: builtInEls.province.value.trim(),
      city: builtInEls.city.value.trim()
    };
    const extraOut = {};
    for (const k of Object.keys(extraInputs)) {
      const v = (extraInputs[k].value || '').trim();
      if (v) extraOut[k] = v; // 空值不写入（首存省一点）
    }
    patch.extra = extraOut;
    close();
    saveProfile(patch);
  };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  // 自动聚焦昵称
  if (builtInEls.nickname) builtInEls.nickname.focus();

  function appendFieldRow(parent, key, label, value, placeholder, bucket) {
    const w = document.createElement('div');
    w.className = 'field-row';
    w.innerHTML = '<label>' + escapeHtml(label) + '</label>';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value || '';
    inp.placeholder = placeholder || '';
    bucket[key] = inp;
    w.appendChild(inp);
    parent.appendChild(w);
  }
}

// 实际 POST 到服务端：patch = { nickname, country, province, city, extra }
async function saveProfile(patch) {
  try {
    const res = await fetch(state.serverHost + '/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(patch)
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '保存失败', 'error'); return; }
    if (data.user) state.me = data.user;
    localStorage.setItem('sc_me', JSON.stringify(state.me));
    renderMyInfo();
    toast('资料已更新', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

// 修改自定义ID（一个月只能改一次，后端控制）
function editUid() {
  if (!state.me) return;
  openModal('修改 ID', [{
    key: 'uid', label: '新ID（4-16位字母数字）', value: state.me.uid || '', placeholder: 'xY7mK3n4'
  }], async (out, close) => {
    const uid = out.uid;
    if (!uid) { toast('ID 不能为空', 'warn', 1000); return; }
    if (!/^[A-Za-z0-9]{4,16}$/.test(uid)) { toast('ID 需为 4-16 位字母数字', 'warn', 1500); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/uid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ uid })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '修改失败', 'error'); return; }
      if (data.user) state.me = data.user;
      else state.me.uid = data.uid || uid;
      localStorage.setItem('sc_me', JSON.stringify(state.me));
      renderMyInfo();
      toast('ID 已更新', 'success');
    } catch (e) {
      toast('请求失败：' + e.message, 'error');
    }
  });
}

// 反馈 / Bug 上报：弹出 modal，提交到 /api/feedback
function openFeedback() {
  if (!state.me) return;
  openModal('反馈 / Bug 上报', [
    { key: 'kind', label: '类型（bug/suggestion/complaint/other）', value: 'bug' },
    { key: 'content', label: '内容', placeholder: '详细描述（≥10字）' }
  ], async (out, close) => {
    if (!out.kind || !out.content || out.content.length < 10) {
      toast('内容至少 10 字', 'warn');
      return;
    }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ kind: out.kind, content: out.content })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '提交失败', 'error'); return; }
      toast('已提交，感谢反馈！', 'success');
    } catch (e) {
      toast(e.message || '提交失败', 'error');
    }
  });
}

// 背景图按用户ID隔离存储，每个用户各自的背景
function bgKey() { return 'sc_chatbg_' + (state.me && state.me.id || 'anon'); }
function getChatBg() { return localStorage.getItem(bgKey()); }
function setChatBg(uri) {
  if (uri) localStorage.setItem(bgKey(), uri);
  else localStorage.removeItem(bgKey());
}

// 选择并上传头像
function pickAvatar() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 500 * 1024) { toast('头像图片过大（限500KB）', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch(state.serverHost + '/api/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
          body: JSON.stringify({ avatar: reader.result })
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || '上传失败', 'error'); return; }
        state.me.avatar = data.user.avatar;
        localStorage.setItem('sc_me', JSON.stringify(state.me));
        renderMyInfo();
        toast('头像已更新', 'success');
      } catch (e) { toast('上传失败：' + e.message, 'error'); }
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

// 上传图片作为聊天界面背景（整个 chat-view）
function pickChatBg() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 4 * 1024 * 1024) { toast('背景图片过大（限4MB）', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setChatBg(reader.result);
      applyChatBg(reader.result);
      toast('背景已应用', 'success');
    };
    reader.onerror = () => toast('读取失败', 'error');
    reader.readAsDataURL(f);
  };
  inp.click();
}
function applyChatBg(uri) {
  const view = $('chatView');
  if (!view) return;
  if (uri) {
    view.style.backgroundImage = 'url("' + uri + '")';
    view.style.backgroundSize = 'cover';
    view.style.backgroundPosition = 'center';
    view.style.backgroundRepeat = 'no-repeat';
  } else {
    view.style.backgroundImage = 'none';
    view.style.backgroundColor = '';
  }
}
function clearChatBg() { setChatBg(null); applyChatBg(null); toast('已恢复默认背景', 'info', 1000); }

function avatarChar(name) { return (name || '?').charAt(0).toUpperCase(); }

// 登录后自检媒体权限，避免"点接听没反应"
async function checkMediaPermissionHint() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return;
    const checks = await Promise.allSettled([
      navigator.permissions.query({ name: 'camera' }).then((s) => s.state),
      navigator.permissions.query({ name: 'microphone' }).then((s) => s.state)
    ]);
    const states = checks.map((c) => c.status === 'fulfilled' ? c.value : 'prompt');
    if (states.indexOf('denied') >= 0) {
      toast('摄像头/麦克风权限已被拒绝：点击地址栏 🔒 → 网站设置 → 允许"摄像头/麦克风"后即可通话', 'error', 6000);
    }
  } catch (e) {}
}

function connectWS() {
  const wsUrl = state.serverHost.replace(/^http/, 'ws') + '/ws';
  state.wsAuthed = false;
  state.ws = new WebSocket(wsUrl);
  state.ws.onopen = () => state.ws.send(JSON.stringify({ type: P.C_AUTH, payload: { token: state.token } }));
  state.ws.onmessage = (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    handleServer(data);
  };
  state.ws.onclose = () => {
    state.wsAuthed = false;
    setTimeout(() => { if (state.me) connectWS(); }, 2000);
  };
}

function send(type, payload) {
  if (type !== P.C_AUTH && !state.wsAuthed) {
    state.outboundQueue.push({ type, payload });
    return true;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, payload }));
    return true;
  }
  return false;
}

function handleServer(data) {
  const { type, payload } = data;
  switch (type) {
    case P.S_AUTH_OK:
      state.wsAuthed = true;
      while (state.outboundQueue.length && state.ws && state.ws.readyState === WebSocket.OPEN) {
        const queued = state.outboundQueue.shift();
        state.ws.send(JSON.stringify(queued));
      }
      checkMediaPermissionHint();
      break;
    case P.S_AUTH_FAIL: toast(payload.error || '登录失效', 'error'); logout(); break;
    case P.S_USER_LIST:
      state.users = payload.users || [];
      renderContacts();
      break;
    case P.S_MSG:
      onIncomingMsg(payload);
      break;
    case P.S_TYPING:
      if (state.activePeer === payload.from) {
        const tip = document.querySelector('.typing-tip') || makeTypingTip();
        tip.textContent = '对方正在输入...';
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => tip.textContent = '', 2000);
      }
      break;
    case P.S_ERROR: console.warn('server error', payload); break;
    case P.S_SIGNAL: if (window.rtc) window.rtc.handleSignal(payload); break;
    case P.S_FRIEND_LIST:
      state.friends = payload.friends || [];
      renderContacts();
      break;
    case P.S_FRIEND_REQ:
      if (!state.pendingReq.find(r => r.from === payload.from)) state.pendingReq.push(payload);
      showFriendReqBar();
      break;
    case P.S_GROUP_LIST:
      state.groups = payload.groups || [];
      if (state.tabContact === 'groups') renderContacts();
      // 若当前选中的群还在列表里，刷新一下顶部 header 与在线状态
      if (state.activeGroup && state.groups.find(g => g.id === state.activeGroup)) {
        renderChatHeader();
      }
      break;
    case P.S_GROUP_MSG:
      onIncomingGroupMsg(payload);
      break;
  }
}

let typingTimer = null;
function makeTypingTip() {
  const d = document.createElement('div');
  d.className = 'typing-tip';
  $('messages').parentElement.insertBefore(d, $('messages').nextSibling);
  return d;
}

// ============ 联系人列表（只显示好友） ============
async function loadFriends() {
  try {
    const res = await fetch(state.serverHost + '/api/friends', {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    if (!res.ok) return;
    const data = await res.json();
    state.friends = data.friends || [];
    renderContacts();
  } catch (e) {}
}

function renderContacts() {
  const kw = $('search').value.trim().toLowerCase();
  const list = $('contactList');
  list.innerHTML = '';
  if (state.tabContact === 'groups') {
    renderGroupList();
    return;
  }
  // 默认：好友
  const friends = state.friends.filter(u => !kw
    || (u.nickname || '').toLowerCase().includes(kw)
    || (u.username || '').toLowerCase().includes(kw)
    || String(u.id).includes(kw)).sort((a, b) => Number(!!chatPrefs().pinned['u:' + b.id]) - Number(!!chatPrefs().pinned['u:' + a.id]) || (a.nickname || '').localeCompare(b.nickname || ''));
  const friendCount = $('friendCount'); if (friendCount) friendCount.textContent = state.friends.length;
  const groupCount = $('groupCount'); if (groupCount) groupCount.textContent = state.groups.length;
  const count = $('listCount');
  if (count) count.textContent = friends.length + ' 位好友';
  if (!friends.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:30px 16px;text-align:center;color:#aaa;font-size:13px';
    tip.textContent = kw ? '没有匹配的好友' : '还没有好友，输入对方ID加好友开始聊天';
    list.appendChild(tip);
    return;
  }
  friends.forEach(u => {
    const div = document.createElement('div');
    div.className = 'contact' + (state.activePeer === u.id ? ' active' : '');
    const unread = state.unread[u.id] || 0;
    const avHtml = u.avatar ? '<img src="' + u.avatar + '">' : avatarChar(u.nickname);
    const isPinned = !!chatPrefs().pinned['u:' + u.id];
    const isMuted = !!chatPrefs().muted['u:' + u.id];
    div.innerHTML = `<div class="avatar">${avHtml}</div>
      <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(u.nickname)}</div>
        <div class="last">${u.online ? '在线' : '离线'}</div>
      </div>
      ${isPinned ? '<span class="contact-mark">置顶</span>' : ''}${isMuted ? '<span class="contact-mark muted">静音</span>' : ''}<span class="dot ${u.online ? 'online' : ''}"></span>
      ${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}`;
    div.onclick = () => selectPeer(u.id);
    if (state.activePeer === u.id && unread) {
      state.unread[u.id] = 0;
      send(P.C_READ, { from: u.id });
    }
    list.appendChild(div);
  });
}

// 群组列表渲染
function renderGroupList() {
  const list = $('contactList');
  const kw = $('search').value.trim().toLowerCase();
  const groups = state.groups.filter(g => !kw
    || (g.name || '').toLowerCase().includes(kw)
    || String(g.id).includes(kw)).sort((a, b) => Number(!!chatPrefs().pinned['g:' + b.id]) - Number(!!chatPrefs().pinned['g:' + a.id]) || (a.name || '').localeCompare(b.name || ''));
  const friendCount = $('friendCount'); if (friendCount) friendCount.textContent = state.friends.length;
  const groupCount = $('groupCount'); if (groupCount) groupCount.textContent = state.groups.length;
  const count = $('listCount');
  if (count) count.textContent = groups.length + ' 个群';
  if (!groups.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:30px 16px;text-align:center;color:#aaa;font-size:13px';
    tip.textContent = kw ? '没有匹配的群' : '还没有加入任何群，点击"创建群"或"加入群"';
    list.appendChild(tip);
    return;
  }
  groups.forEach(g => {
    const div = document.createElement('div');
    div.className = 'contact' + (state.activeGroup === g.id ? ' active' : '');
    const unread = state.groupUnread[g.id] || 0;
    const isOwner = state.me && g.ownerId === state.me.id;
    const ownerMark = isOwner ? ' (群主)' : '';
    const memberCnt = (g.members || []).length;
    const lastMsg = g.lastMessage && g.lastMessage.content ? g.lastMessage.content : ('成员 ' + memberCnt + ' 人');
    const isPinned = !!chatPrefs().pinned['g:' + g.id];
    const isMuted = !!chatPrefs().muted['g:' + g.id];
    div.innerHTML = `<div class="avatar">${(g.name || '?').charAt(0).toUpperCase()}</div>
      <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(g.name)}<span class="last" style="margin-left:6px">ID:${g.id}${ownerMark}</span></div>
        <div class="last">${escapeHtml(String(lastMsg).slice(0, 30))}</div>
      </div>
      ${isPinned ? '<span class="contact-mark">置顶</span>' : ''}${isMuted ? '<span class="contact-mark muted">静音</span>' : ''}${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}`;
    div.onclick = () => selectGroup(g.id);
    if (state.activeGroup === g.id && unread) {
      state.groupUnread[g.id] = 0;
      send(P.C_GROUP_READ, { groupId: g.id });
    }
    list.appendChild(div);
  });
}

// 切换 side-tab
function syncMobileNav(active) {
  document.querySelectorAll('#mobileBottomNav .side-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.side === active);
  });
}
document.querySelectorAll('.side-tab').forEach(tt => {
  tt.onclick = () => {
    if (tt.dataset.side === 'friends' || tt.dataset.side === 'groups') state.tabContact = tt.dataset.side;
    document.querySelectorAll('.side-tab').forEach(x => x.classList.toggle('on', x === tt));
    syncMobileNav(tt.dataset.side);

    // AI tab：切到 AI 助手视图，隐藏主聊天区
    if (tt.dataset.side === 'ai') {
      const main = document.querySelector('.main');
      if (main) main.style.display = 'none';
      const downloadView = $('downloadView');
      if (downloadView) downloadView.style.display = 'none';
      const aiView = $('aiView');
      if (aiView) aiView.style.display = 'flex';
      // 侧边区域隐藏（AI 不需要加好友/群按钮）
      const fs = $('friendsSide'); if (fs) fs.style.display = 'none';
      const gs = $('groupsSide'); if (gs) gs.style.display = 'none';
      // 调用 ai.js 里的 switchToAi：它负责未配置 apiKey 时弹设置、聚焦输入
      if (window.switchToAi) window.switchToAi();
      // 移动端：切到 AI 视图也要进入"聊天态"（AI 视图与 .main 平级，靠 mobile-chat-active 移入屏内）
       if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
       return;
    }

    // 下载 tab：复用下载页逻辑，但保持在主站右侧视图内
    if (tt.dataset.side === 'downloads') {
      const main = document.querySelector('.main');
      if (main) main.style.display = 'none';
      const aiView = $('aiView');
      if (aiView) aiView.style.display = 'none';
      const downloadView = $('downloadView');
      if (downloadView) downloadView.style.display = 'flex';
      const fs = $('friendsSide'); if (fs) fs.style.display = 'none';
      const gs = $('groupsSide'); if (gs) gs.style.display = 'none';
      if (window.initDownloadView) window.initDownloadView(downloadView);
      if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
      return;
    }

    // 切回好友/群组：恢复 .main 显示，隐藏 AI 视图
    const aiView2 = $('aiView');
    if (aiView2) aiView2.style.display = 'none';
    const downloadView2 = $('downloadView');
    if (downloadView2) downloadView2.style.display = 'none';
    const main2 = document.querySelector('.main');
    if (main2) main2.style.display = 'flex';
    // 移动端：切回好友/群组 tab，回到列表态
    if (window.IS_MOBILE) document.getElementById('chatView').classList.remove('mobile-chat-active');

    const showFriends = state.tabContact === 'friends';
    const fs = $('friendsSide'); if (fs) fs.style.display = showFriends ? '' : 'none';
    const gs = $('groupsSide'); if (gs) gs.style.display = showFriends ? 'none' : '';
    renderContacts();
  };
});

// 移动端底部导航：克隆 rail tab 到底部栏，点击时转发到原 tab
(function initMobileBottomNav() {
  const nav = $('mobileBottomNav');
  if (!nav || !window.IS_MOBILE) return;
  document.querySelectorAll('.sidebar-rail .side-tab').forEach(src => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-tab' + (src.classList.contains('on') ? ' on' : '');
    b.dataset.side = src.dataset.side;
    b.innerHTML = src.innerHTML;
    b.onclick = () => {
      const real = document.querySelector('.sidebar-rail .side-tab[data-side="' + src.dataset.side + '"]');
      if (real) real.click();
      else {
        document.querySelectorAll('.side-tab').forEach(x => x.classList.toggle('on', x === b));
        syncMobileNav(src.dataset.side);
      }
    };
    nav.appendChild(b);
  });
  syncMobileNav(state.tabContact || 'friends');
})();

const downloadBackBtn = $('downloadBackBtn');
if (downloadBackBtn) downloadBackBtn.onclick = () => {
  const tab = document.querySelector('.side-tab[data-side="' + (state.tabContact || 'friends') + '"]');
  if (tab) tab.click();
};

// 创建群 / 加入群
$('createGroupBtn').onclick = () => {
  openModal('创建群', [{ key: 'name', label: '群名' }], async (out, close) => {
    if (!out.name) { toast('群名不能为空', 'warn', 1000); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/group/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ name: out.name })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '创建失败', 'error'); return; }
      toast('群「' + (data.group && data.group.name) + '」已创建（ID: ' + (data.group && data.group.id) + '）', 'success');
      // 强制切到群组 tab
      const gtab = document.querySelector('.side-tab[data-side="groups"]');
      if (gtab) gtab.click();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  });
};
$('joinGroupBtn').onclick = () => {
  openModal('加入群', [{ key: 'groupId', label: '群 ID（创建群成功后弹出的数字）', placeholder: '示例：1' }], async (out, close) => {
    if (!out.groupId) { toast('群ID不能为空', 'warn', 1000); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/group/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ groupId: parseInt(out.groupId, 10) })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '加群失败', 'error'); return; }
      toast('已加入群', 'success');
      const gtab = document.querySelector('.side-tab[data-side="groups"]');
      if (gtab) gtab.click();
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  });
};

// 邀请进群
$('inviteGroupBtn').onclick = () => {
  if (!state.activeGroup) { toast('请先选择一个群', 'warn', 1000); return; }
  openModal('邀请成员进群', [{ key: 'uid', label: '对方 UID（4-16 位字母或数字）', placeholder: '示例：xY7mK3n4' }], async (out, close) => {
    if (!out.uid) { toast('UID 不能为空', 'warn', 1000); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/group/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ groupId: state.activeGroup, uid: out.uid })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '邀请失败', 'error'); return; }
      toast('邀请成功', 'success');
    } catch (e) { toast('请求失败：' + e.message, 'error'); }
  });
};

// 统一渲染顶部 header（根据联系人/群而异）
function renderChatHeader() {
  if (state.activeGroup) {
    const g = state.groups.find(x => x.id === state.activeGroup);
    const name = g ? g.name : ('群 #' + state.activeGroup);
    $('chatHeader').textContent = '群聊：' + name;
    $('inviteBar').style.display = '';
    return;
  }
  if (state.activePeer) {
    const peer = state.friends.find(u => u.id === state.activePeer);
    $('chatHeader').textContent = peer ? peer.nickname : '聊天';
  } else {
    $('chatHeader').textContent = t('noConversation', '请选择联系人');
  }
  $('inviteBar').style.display = 'none';
}

// 选择群 + 加载群历史
async function selectGroup(groupId) {
  state.activeGroup = groupId;
  state.activePeer = null;
  const welcome = $('welcomePanel'); if (welcome) welcome.style.display = 'none';
  state.groupUnread[groupId] = 0;
  send(P.C_GROUP_READ, { groupId });
  renderContacts();
  renderChatHeader();
  refreshConversationButtons();
  restoreCurrentDraft();
  try {
    const res = await fetch(state.serverHost + '/api/group/' + groupId + '/messages', {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    const data = await res.json();
    if (!res.ok) { $('messages').innerHTML = '<div style="color:#999;text-align:center">' + (data.error || '加载历史失败') + '</div>'; return; }
    state.groupMsgs[groupId] = data.messages || [];
    renderGroupMessages(data.messages || []);
  } catch (e) {
    $('messages').innerHTML = '<div style="color:#999;text-align:center">加载历史失败</div>';
  }
  // 移动端：选中群组后切换到聊天区
  if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
}

function renderGroupMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  msgs.forEach(m => appendGroupMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

// 群聊消息气泡（带昵称）
function appendGroupMessage(m, prepend) {
  const box = $('messages');
  const mine = m.from === (state.me && state.me.id);
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'other');
  const fromName = (m.fromUser && m.fromUser.nickname) || ('用户' + m.from);
  const avHtml = (m.fromUser && m.fromUser.avatar)
    ? '<img src="' + m.fromUser.avatar + '">'
    : avatarChar(fromName);
  const nameLine = mine ? '' : '<div class="name">' + escapeHtml(fromName) + '</div>';
  row.innerHTML = `<div class="avatar">${avHtml}</div>
    <div class="bubble-wrap">
      ${nameLine}
      <div class="bubble">${escapeHtml(m.content)}</div>
      <span class="time">${fmtTime(m.createdAt)}</span>
    </div>`;
  box.appendChild(row);
  if (!prepend) box.scrollTop = box.scrollHeight;
}

// 收到群消息推送
function onIncomingGroupMsg(payload) {
  if (state.activeGroup === payload.groupId) {
    appendGroupMessage(payload, false);
  } else {
   	state.groupUnread[payload.groupId] = (state.groupUnread[payload.groupId] || 0) + 1;
    const fromName = (payload.fromUser && payload.fromUser.nickname) || ('用户' + payload.from);
    const g = state.groups.find(x => x.id === payload.groupId);
    const gname = g ? g.name : ('群#' + payload.groupId);
    showMessageNotice({ from: payload.from, content: payload.content }, gname + ' ' + fromName);
    renderContacts();
  }
}

// 群发送消息
function sendCurrentGroup() {
  if (!state.activeGroup) return false;
  const text = $('input').value.trim();
  if (!text) return true;
  send(P.C_GROUP_MSG, { groupId: state.activeGroup, content: text });
  $('input').value = '';
  saveCurrentDraft();
  return true;
}


$('search').oninput = renderContacts;

// ============ 加好友 ============
$('addFriendBtn').onclick = async () => {
  const fid = $('addFriendInput').value.trim();
  if (!fid) return;
  try {
    const res = await fetch(state.serverHost + '/api/friend/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ friendUid: fid })
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '加好友失败', 'error'); return; }
    $('addFriendInput').value = '';
    toast('已发送好友请求，等待对方接受', 'success');
  } catch (e) { toast('请求失败：' + e.message, 'error'); }
};

// 好友请求提示条
function showFriendReqBar() {
  const req = state.pendingReq[0];
  if (!req || !req.fromUser) { $('friendReqBar').style.display = 'none'; return; }
  $('friendReqText').textContent = req.fromUser.nickname + '（ID:' + req.fromUser.uid + '）请求加你为好友';
  $('friendReqBar').style.display = 'flex';
}
$('acceptFriendBtn').onclick = async () => {
  const req = state.pendingReq[0];
  if (!req) { $('friendReqBar').style.display = 'none'; return; }
  try {
    const res = await fetch(state.serverHost + '/api/friend/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ friendId: req.from })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    state.pendingReq.shift();
  } catch (e) {
    toast('接受好友请求失败：' + e.message, 'error');
    showFriendReqBar();
    return;
  }
  showFriendReqBar();
  loadFriends();
};
$('rejectFriendBtn').onclick = async () => {
  const req = state.pendingReq[0];
  if (!req) { $('friendReqBar').style.display = 'none'; return; }
  try {
    const res = await fetch(state.serverHost + '/api/friend/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ friendId: req.from })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    state.pendingReq.shift();
  } catch (e) {
    toast('拒绝好友请求失败：' + e.message, 'error');
    showFriendReqBar();
    return;
  }
  showFriendReqBar();
};

// ============ 选择联系人 + 历史 ============
async function selectPeer(peerId) {
  state.activePeer = peerId;
  state.activeGroup = null;
  const welcome = $('welcomePanel'); if (welcome) welcome.style.display = 'none';
  state.unread[peerId] = 0;
  loadCallReplays(peerId);
  const peer = state.friends.find(u => u.id === peerId);
  $('chatHeader').textContent = peer ? peer.nickname : '聊天';
  $('inviteBar').style.display = 'none';
  renderContacts();
  refreshConversationButtons();
  restoreCurrentDraft();
  try {
    const res = await fetch(state.serverHost + '/api/history/' + encodeURIComponent(String(peerId)), {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const msgs = data.messages || [];
    renderMessages(msgs);
  } catch (e) {
    $('messages').innerHTML = '<div style="color:#999;text-align:center">加载历史失败</div>';
  }
  // 移动端：选中联系人后切换到聊天区
  if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
}

function renderMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  msgs.forEach(m => appendMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

function refreshConversationButtons() {
  const key = activeConversationKey();
  const prefs = chatPrefs();
  const pin = $('pinChatBtn'); const mute = $('muteChatBtn');
  if (pin) { pin.classList.toggle('active', !!prefs.pinned[key]); pin.textContent = prefs.pinned[key] ? '已置顶' : '置顶'; }
  if (mute) { mute.classList.toggle('active', !!prefs.muted[key]); mute.textContent = prefs.muted[key] ? '已静音' : '免打扰'; }
}

function wireConversationTools() {
  const pin = $('pinChatBtn'); const mute = $('muteChatBtn'); const notify = $('notifyBtn');
  const clear = $('clearChatBtn');
  const searchBtn = $('messageSearchBtn'); const searchBar = $('messageSearchBar');
  const searchInput = $('messageSearchInput'); const searchClose = $('messageSearchClose');
  // 移动端返回按钮：回到会话列表，并清空当前会话选中态
  const backBtn = $('backToListBtn');
  if (backBtn) backBtn.onclick = () => {
    const cv = document.getElementById('chatView');
    if (cv) cv.classList.remove('mobile-chat-active');
    state.activePeer = null;
    state.activeGroup = null;
    renderChatHeader();
    $('inviteBar').style.display = 'none';
    const welcome = $('welcomePanel'); if (welcome) welcome.style.display = '';
    renderContacts();
  };
  if (pin) pin.onclick = () => {
    const key = activeConversationKey(); if (!key) return toast('请先选择会话', 'warn', 1200);
    const prefs = chatPrefs(); prefs.pinned[key] = !prefs.pinned[key]; saveChatPrefs(prefs); refreshConversationButtons(); renderContacts();
  };
  if (mute) mute.onclick = () => {
    const key = activeConversationKey(); if (!key) return toast('请先选择会话', 'warn', 1200);
    const prefs = chatPrefs(); prefs.muted[key] = !prefs.muted[key]; saveChatPrefs(prefs); refreshConversationButtons(); renderContacts();
  };
  if (notify) notify.onclick = async () => {
    if (!('Notification' in window)) return toast('当前浏览器不支持系统通知', 'warn', 1500);
    const permission = await Notification.requestPermission();
    notify.classList.toggle('active', permission === 'granted');
    notify.textContent = permission === 'granted' ? '通知已开' : '通知';
    toast(permission === 'granted' ? '浏览器通知已开启' : '未授予通知权限', permission === 'granted' ? 'success' : 'warn', 1500);
  };
  if (clear) clear.onclick = async () => {
    if (!state.activePeer) return toast('请先选择联系人', 'warn', 1200);
    if (!confirm('确定清空当前聊天记录吗？此操作不可恢复。')) return;
    clear.disabled = true;
    try {
      const res = await fetch(state.serverHost + '/api/history/' + encodeURIComponent(String(state.activePeer)), {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + state.token }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '清空失败');
      $('messages').innerHTML = '';
      toast('当前聊天记录已清空', 'success', 1500);
    } catch (e) { toast('清空失败：' + e.message, 'error'); }
    finally { clear.disabled = false; }
  };
  function applySearch() {
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    document.querySelectorAll('#messages .msg-row').forEach(row => {
      const hit = !!q && row.textContent.toLowerCase().includes(q);
      row.classList.toggle('search-hit', hit);
    });
  }
  if (searchBtn && searchBar) searchBtn.onclick = () => { searchBar.style.display = searchBar.style.display === 'none' ? 'flex' : 'none'; if (searchBar.style.display === 'flex') searchInput.focus(); };
  if (searchInput) searchInput.addEventListener('input', applySearch);
  if (searchClose && searchBar) searchClose.onclick = () => { searchBar.style.display = 'none'; if (searchInput) searchInput.value = ''; applySearch(); };
}

// 欢迎工作台快捷入口
const welcomeAddBtn = $('welcomeAddBtn');
const welcomeGroupBtn = $('welcomeGroupBtn');
const welcomeAiBtn = $('welcomeAiBtn');
if (welcomeAddBtn) welcomeAddBtn.onclick = () => { const input = $('addFriendInput'); if (input) input.focus(); };
if (welcomeGroupBtn) welcomeGroupBtn.onclick = () => { const tab = document.querySelector('.side-tab[data-side="groups"]'); if (tab) tab.click(); const btn = $('createGroupBtn'); if (btn) setTimeout(() => btn.click(), 80); };
if (welcomeAiBtn) welcomeAiBtn.onclick = () => { const tab = document.querySelector('.side-tab[data-side="ai"]'); if (tab) tab.click(); };

function appendMessage(m, prepend) {
  if (typeof m.content === 'string' && m.content.startsWith('__FILE__')) {
    try {
      const file = JSON.parse(m.content.slice(8));
      if (file.id && file.name) {
        appendFileMsg(m.from === state.me.id, file.name, file.size, file.id, m.createdAt);
        return;
      }
    } catch {}
  }
  const box = $('messages');
  const mine = m.from === state.me.id;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'other');
  const fullTime = new Date(m.createdAt).toLocaleString();
  row.innerHTML = `<div class="bubble">${escapeHtml(m.content)}</div><span class="time" title="${escapeHtml(fullTime)}">${fmtTime(m.createdAt)}</span><div class="message-actions"><button type="button" data-action="copy">复制</button><button type="button" data-action="quote">引用</button></div>`;
  row.querySelector('[data-action="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(String(m.content || '')); toast('已复制', 'success', 1200); }
    catch { toast('复制失败，请手动选择文本', 'warn', 1500); }
  };
  row.querySelector('[data-action="quote"]').onclick = () => {
    const input = $('input');
    const quote = '> ' + String(m.content || '').replace(/\n/g, '\n> ') + '\n';
    input.value = input.value ? quote + input.value : quote;
    input.focus();
  };
  box.appendChild(row);
  if (!prepend) box.scrollTop = box.scrollHeight;
}

function fmtTime(t) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

let noticeAudioContext = null;
document.addEventListener('pointerdown', () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !noticeAudioContext) noticeAudioContext = new AudioCtx();
    if (noticeAudioContext && noticeAudioContext.state === 'suspended') noticeAudioContext.resume().catch(() => {});
  } catch {}
}, { once: true, capture: true });
function playMessageNoticeSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    noticeAudioContext ||= new AudioCtx();
    if (noticeAudioContext.state === 'suspended') noticeAudioContext.resume().catch(() => {});
    const now = noticeAudioContext.currentTime;
    [0, 0.09].forEach((delay, index) => {
      const osc = noticeAudioContext.createOscillator();
      const gain = noticeAudioContext.createGain();
      osc.type = 'sine'; osc.frequency.value = index ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.16);
      osc.connect(gain).connect(noticeAudioContext.destination);
      osc.start(now + delay); osc.stop(now + delay + 0.18);
    });
  } catch {}
}
let callRingtoneTimer = null;
function startCallRingtone() {
  stopCallRingtone();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    noticeAudioContext ||= new AudioCtx();
    if (noticeAudioContext.state === 'suspended') noticeAudioContext.resume().catch(() => {});
    const ring = () => {
      if (!noticeAudioContext) return;
      const now = noticeAudioContext.currentTime;
      [0, 0.24].forEach((delay, index) => {
        const osc = noticeAudioContext.createOscillator();
        const gain = noticeAudioContext.createGain();
        osc.type = 'sine'; osc.frequency.value = index ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.16, now + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.18);
        osc.connect(gain).connect(noticeAudioContext.destination);
        osc.start(now + delay); osc.stop(now + delay + 0.2);
      });
    };
    ring();
    callRingtoneTimer = setInterval(ring, 1400);
  } catch {}
}
function stopCallRingtone() {
  if (callRingtoneTimer) { clearInterval(callRingtoneTimer); callRingtoneTimer = null; }
}
function showMessageNotice(m, name) {
  const text = String(m.content || '').startsWith('__FILE__') ? '收到一个文件' : String(m.content || '').slice(0, 240);
  playMessageNoticeSound();
  const stack = $('messageNoticeStack');
  if (stack) {
    const item = document.createElement('div'); item.className = 'message-notice';
    item.innerHTML = '<strong>' + escapeHtml(name || '新消息') + '</strong><span>' + escapeHtml(text || '收到新消息') + '</span>';
    item.onclick = () => { if (state.activePeer !== m.from) selectPeer(m.from); item.remove(); };
    stack.appendChild(item); setTimeout(() => item.remove(), 6500);
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(name || '新消息', { body: text || '收到新消息', tag: 'securechat-' + m.from }); } catch {}
  }
  if (window.chatAPI) window.chatAPI.notify(name + ' 发来消息', text);
}

// ============ 收消息 ============
async function onIncomingMsg(m) {
  // 明文模式：不再做 E2EE 解密，直接显示原文。
  if (m.from === state.me.id && m.clientMsgId && state.sentPlain[m.clientMsgId]) {
    m.content = state.sentPlain[m.clientMsgId];
    delete state.sentPlain[m.clientMsgId];
  }
  if (m.from === state.me.id && m.clientMsgId && state.pendingLocal[m.clientMsgId]) {
    delete state.pendingLocal[m.clientMsgId];
    state.lastFrom[m.from] = m.content;
    renderContacts();
    return;
  }
  // 服务端会回显发送者自己的消息；自己的消息也必须渲染到当前会话。
  if (m.from === state.me.id || state.activePeer === m.from) {
    appendMessage(m);
    if (m.from !== state.me.id) send(P.C_READ, { from: m.from });
  } else {
    state.unread[m.from] = (state.unread[m.from] || 0) + 1;
    const fromUser = state.friends.find(u => u.id === m.from);
    const name = fromUser ? fromUser.nickname : '新消息';
    showMessageNotice(m, name);
  }
  state.lastFrom[m.from] = m.content;
  renderContacts();
}

// ============ 发送 ============
function sendCurrent() {
  if (state.activeGroup) { sendCurrentGroup(); return; }
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.activePeer) return;
  const clientMsgId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const peerId = state.activePeer;
  const payload = { to: peerId, content: text, clientMsgId };
  state.pendingLocal[clientMsgId] = true;
  input.value = '';
  saveCurrentDraft();
  appendMessage({ id: 'local-' + clientMsgId, from: state.me.id, to: peerId, content: text, createdAt: Date.now(), clientMsgId }, false);
  // UI 先完成；文字通过 REST 持久化，不依赖浏览器 WebSocket 状态。
  fetch(state.serverHost + '/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
    body: JSON.stringify(payload)
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '发送失败');
    delete state.pendingLocal[clientMsgId];
  }).catch((e) => toast('消息保存失败：' + e.message, 'error'));
}

$('sendBtn').type = 'button';
$('sendBtn').onclick = (event) => { event.preventDefault(); sendCurrent(); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
let typingSent = 0;
$('input').addEventListener('input', () => {
  saveCurrentDraft();
  if (!state.activePeer) return;
  const now = Date.now();
  if (now - typingSent > 2000) {
    send(P.C_TYPING, { to: state.activePeer });
    typingSent = now;
  }
});

// 本地主题切换，不影响账号和聊天数据
const themeToggle = $('themeToggle');
const savedTheme = localStorage.getItem('sc_theme');
if (savedTheme === 'dark') document.body.classList.add('dark-mode');
if (themeToggle) themeToggle.onclick = () => {
  const dark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('sc_theme', dark ? 'dark' : 'light');
  themeToggle.textContent = dark ? t('light', '日') : t('dark', '夜');
};
if (themeToggle && savedTheme === 'dark') themeToggle.textContent = t('light', '日');

// ============ 语言切换浮层 ============
// 点击侧边栏底部 localeToggle 弹出语言选择菜单；选择后交给 SCI18N.setLocale。
const localeToggle = $('localeToggle');
let localeMenu = null;
function closeLocaleMenu() {
  if (localeMenu && localeMenu.parentNode) localeMenu.parentNode.removeChild(localeMenu);
  localeMenu = null;
  document.removeEventListener('keydown', onLocaleMenuEsc, true);
}
function onLocaleMenuEsc(e) { if (e.key === 'Escape') { closeLocaleMenu(); e.stopPropagation(); } }
function openLocaleMenu() {
  if (localeMenu) { closeLocaleMenu(); return; }
  if (!window.SCI18N || !SCI18N.names) return;
  const menu = document.createElement('div');
  menu.id = 'localeMenu';
  menu.className = 'locale-menu';
  Object.keys(SCI18N.names).forEach(code => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'locale-item' + (SCI18N.locale === code ? ' active' : '');
    item.dataset.locale = code;
    item.textContent = (SCI18N.locale === code ? '\u2713 ' : '') + SCI18N.names[code];
    item.onclick = () => {
      const next = item.dataset.locale;
      closeLocaleMenu();
      if (SCI18N.locale !== next) SCI18N.setLocale(next);
    };
    menu.appendChild(item);
  });
  // 定位交给 CSS（.locale-menu fixed 定位到屏幕左下、rail 底部上方）。
  // 关键：加 .open class 才会把 display:none 变为 flex，菜单才可见。
  menu.classList.add('open');
  document.body.appendChild(menu);
  localeMenu = menu;
  document.addEventListener('keydown', onLocaleMenuEsc, true);
}
if (localeToggle) localeToggle.onclick = (e) => { e.stopPropagation(); openLocaleMenu(); };
// 点击浮层外关闭
document.addEventListener('click', (e) => {
  if (!localeMenu) return;
  if (localeMenu.contains(e.target) || e.target === localeToggle) return;
  closeLocaleMenu();
});
// 切换语言后：重新渲染账户卡 / 重新翻译静态 DOM / 同步主题按钮文案
document.addEventListener('sc-locale-change', () => {
  if (state.me) renderMyInfo();
  // 刷新 chatHeader 静态文案（如“请选择联系人”）
  if (!state.activePeer && !state.activeGroup && $('chatHeader')) $('chatHeader').textContent = t('noConversation', '请选择联系人');
  if (window.SCI18N && typeof SCI18N.apply === 'function') SCI18N.apply();
  if (themeToggle) themeToggle.textContent = document.body.classList.contains('dark-mode') ? t('light', '日') : t('dark', '夜');
});

window.addEventListener('focus', () => { if (window.chatAPI) window.chatAPI.stopFlash(); });

// ============ 工具 ============
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
  }[c]));
}

// ============ WebRTC：文件 / 语音 / 视频 ============
let rtc, callPeer = null, callKind = null, incomingCall = null, localStream = null;
let pendingRemoteStream = null;
let callRecorder = null, callRecordChunks = [], callRecordStartedAt = 0;
let callRecordings = [];

function renderCallReplays() {
  const box = $('callReplayList');
  if (!box) return;
  if (!callRecordings.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = '<strong>通话回放</strong>' + callRecordings.map((r, i) => '<div class="call-replay"><span>' + escapeHtml(r.kind === 'video' ? '视频' : '语音') + ' ' + new Date(r.createdAt).toLocaleString() + '</span><a href="' + r.url + '" target="_blank">播放/下载</a></div>').join('');
}
async function loadCallReplays(peerId) {
  try {
    const res = await fetch(state.serverHost + '/api/call-recordings?peer=' + encodeURIComponent(peerId), { headers: { 'Authorization': 'Bearer ' + state.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载回放失败');
    callRecordings = (data.recordings || []).map(r => ({ ...r, url: state.serverHost + '/api/call-recordings/' + encodeURIComponent(r.id) }));
    renderCallReplays();
  } catch (e) { callRecordings = []; renderCallReplays(); }
}
function startCallRecording(remoteStream) {
  if (callRecorder || !localStream || !remoteStream || typeof MediaRecorder === 'undefined') return;
  const tracks = [...localStream.getTracks(), ...remoteStream.getTracks()];
  try {
    const mixed = new MediaStream(tracks);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    callRecorder = new MediaRecorder(mixed, { mimeType: mime });
    callRecordChunks = []; callRecordStartedAt = Date.now();
    callRecorder.ondataavailable = (e) => { if (e.data && e.data.size) callRecordChunks.push(e.data); };
    callRecorder.onstop = () => {
      if (!callRecordChunks.length) return;
      const blob = new Blob(callRecordChunks, { type: mime });
      const kind = callKind || 'audio';
      const peerId = callPeer;
      fetch(state.serverHost + '/api/call-recordings?to=' + encodeURIComponent(peerId) + '&kind=' + encodeURIComponent(kind), { method: 'POST', body: blob, headers: { 'Content-Type': 'video/webm', 'Authorization': 'Bearer ' + state.token } })
        .then(() => loadCallReplays(peerId))
        .catch((e) => toast('回放上传失败：' + e.message, 'error'));
      callRecorder = null; callRecordChunks = [];
    };
    callRecorder.start(1000);
  } catch (e) { callRecorder = null; }
}
function stopCallRecording() {
  if (callRecorder && callRecorder.state !== 'inactive') callRecorder.stop();
}

// 通话超时/恢复/远端画面显示（顶层函数，供 initRtc 事件与通话按钮共用）
let callTimer = null;
function clearCallTimer() { if (callTimer) { clearTimeout(callTimer); callTimer = null; } }
function startCallTimer() {
  // 若已有计时器或已接通则不重复
  if (callTimer) return;
  callTimer = setTimeout(() => {
    callTimer = null;
    // 8 秒后仍未恢复则关闭通话
    closeCallBar();
    toast('网络连接中断，通话已结束', 'warn');
  }, 8000);
}
function startCallTimeout() {
  clearCallTimer();
  callTimer = setTimeout(() => {
    callTimer = null;
    if (callPeer && !incomingCall) {
      toast('对方无响应，通话超时', 'warn');
      closeCallBar();
      if (rtc && callPeer) rtc.hangup(callPeer);
    }
  }, 30000);
}
function maybeShowRemote(peerId) {
  // 显示规则：必须已"接通"——incomingCall=null（已接听，从来电状态过渡）
  // 且当前 callPeer = 该 peer；或主动呼出方无需"接听"动作，对方一搭上就显示
  if (!pendingRemoteStream) return;
  if (!callPeer) return;
  // 主呼方：incomingCall 一直为 null 即可显示
  // 被呼方：必须 incomingCall=null（已 acceptIncomingCall 清空）
  if (incomingCall) return; // 还在待接听
  const v = $('remoteVideo');
  if (!v) return;
  v.srcObject = pendingRemoteStream;
  v.style.display = '';
  // WebView 默认禁止无手势自动播放，必须显式 play()，否则接通后无声/无画面
  try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  if (callKind === 'video') $('callBar').classList.add('with-video');
  $('callBar').style.display = 'flex';
  showCallDuration();
}

function initRtc() {
  if (window.createRtc) {
    rtc = window.createRtc({
      sendSignal: (peerId, sub, data) => send(P.C_SIGNAL, { to: peerId, sub, data }),
      selfId: () => state.me && state.me.id
    });
    window.rtc = rtc;
  }
  window.addEventListener('rtc-remote-stream', (e) => {
    // 未接听时暂存，不挂到 UI
    pendingRemoteStream = e.detail.stream;
    startCallRecording(e.detail.stream);
    maybeShowRemote(e.detail.peerId);
  });
  window.addEventListener('rtc-state', (e) => {
    if (e.detail.state === 'connected') { clearCallTimer(); stopCallDuration(); maybeShowRemote(e.detail.peerId); }
    if (e.detail.state === 'failed') {
      clearCallTimer(); stopCallDuration();
      toast('通话连接失败：请确认双方网络可互通（NAT/防火墙限制）', 'error', 3000);
      closeCallBar();
      if (rtc && callPeer) rtc.hangup(callPeer);
    }
    if (e.detail.state === 'closed') { clearCallTimer(); stopCallDuration(); closeCallBar(); }
    // disconnected：不立即关闭，等待恢复；超过 8s 仍 disconnected 则按失败处理
    if (e.detail.state === 'disconnected') startCallTimer();
  });
  window.addEventListener('call-incoming', (e) => {
    clearCallTimer();
    startCallRingtone();
    incomingCall = { from: e.detail.from, kind: e.detail.kind };
    $('callText').textContent = (e.detail.kind === 'video' ? '视频' : '语音') + '来电（来自用户 ' + e.detail.from + '）';
    $('acceptCallBtn').style.display = ''; $('rejectCallBtn').style.display = ''; $('hangupBtn').style.display = 'none';
    $('callBar').classList.remove('with-video'); $('callBar').style.display = 'flex';
    callTimer = setTimeout(() => {
      if (incomingCall) rejectIncomingCall();
    }, 30000);
  });
  window.addEventListener('call-rejected', () => { stopCallRingtone(); toast('对方已拒绝', 'warn'); closeCallBar(); });
  window.addEventListener('peer-offline', () => { stopCallRingtone(); toast('对方不在线', 'warn'); closeCallBar(); });
  window.addEventListener('remote-hangup', () => { stopCallRingtone(); toast('对方已挂断', 'info'); closeCallBar(); });
  window.addEventListener('file-start', (e) => { $('fileBar').style.display = ''; $('fileText').textContent = '接收：' + e.detail.name + ' (' + humanSize(e.detail.size) + ')'; setProgress(0); });
  window.addEventListener('file-progress', (e) => setProgress(e.detail.received / e.detail.size));
  window.addEventListener('file-done', (e) => {
    $('fileText').textContent = '已接收：' + e.detail.name; setProgress(1);
    appendFileMsg(true, e.detail.name, e.detail.size, e.detail.url);
    setTimeout(() => $('fileBar').style.display = 'none', 4000);
  });
}
function setProgress(r) { $('fileProgress').style.width = Math.round(r * 100) + '%'; }
function humanSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(1)+' KB'; if (b < 1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; }

// 通话时长计时（接通后显示 通话中 MM:SS）
let durationTimer = null;
let callStartAt = 0;
function showCallDuration() {
  if (durationTimer) return;
  callStartAt = Date.now();
  durationTimer = setInterval(() => {
    if (!callPeer) { clearInterval(durationTimer); durationTimer = null; return; }
    const s = Math.floor((Date.now() - callStartAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('callText').textContent = '通话中 ' + mm + ':' + ss;
  }, 1000);
}
function stopCallDuration() {
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
}

// 释放本地媒体设备（每次发起/接听/挂断前调用，防止"Device in use"）
function releaseLocalMedia() {
  if (localStream) {
    try { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
    localStream = null;
  }
  if (rtc) {
    try { rtc.releaseAllMedia(); } catch (e) {}
  }
  const lv = $('localVideo');
  if (lv) { try { lv.srcObject = null; } catch (e) {} }
  const rv = $('remoteVideo');
  if (rv) { try { rv.srcObject = null; } catch (e) {} }
}

function startOutgoingCall(kind) {
  stopCallRingtone();
  if (!state.activePeer) return toast('请先选择联系人', 'warn');
  // 若正在通话或设备被占用，先彻底释放
  releaseLocalMedia();
  if (rtc && callPeer) rtc.hangup(callPeer);
  callPeer = state.activePeer; callKind = kind;
  send(P.C_SIGNAL, { to: callPeer, sub: 'call', data: { kind } });
  $('callText').textContent = '正在呼叫(' + (kind==='video'?'视频':'语音') + ')...';
  $('acceptCallBtn').style.display='none'; $('rejectCallBtn').style.display='none'; $('hangupBtn').style.display='';
  $('callBar').style.display = 'flex';
  if (!window.getLocalStream) return toast('WebRTC 不可用', 'error');
  window.getLocalStream(kind).then((s) => {
    localStream = s;
    const v = $('localVideo'); if (v && kind==='video') v.srcObject = s;
    rtc.startCall(callPeer, kind, s);
    startCallTimeout();
  }).catch((e) => { toast('无法获取媒体：'+e.message, 'error'); closeCallBar(); });
}
async function acceptIncomingCall() {
  if (!incomingCall) {
    toast('没有正在响铃的来电，请让对方重新拨打', 'warn', 3000);
    return;
  }
  stopCallRingtone();
  clearCallTimer();
  const pendingCall = incomingCall;
  callPeer = pendingCall.from; callKind = pendingCall.kind;
  $('callText').textContent = '通话中...';
  $('acceptCallBtn').style.display='none'; $('rejectCallBtn').style.display='none'; $('hangupBtn').style.display='';
  try {
    if (!window.getLocalStream) throw new Error('WebRTC 不可用');
    $('callText').textContent = '正在请求麦克风/摄像头权限...';
    const mediaTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器权限请求超时，请允许摄像头和麦克风权限后重试')), 12000));
    localStream = await Promise.race([window.getLocalStream(callKind), mediaTimeout]);
    incomingCall = null;
    const v=$('localVideo'); if (v && callKind==='video') v.srcObject=localStream;
    await rtc.acceptCall(callPeer, callKind, localStream);
    startCallTimeout();
  } catch (e) {
    incomingCall = pendingCall;
    const code = e && e.code;
    const isPerm = code === 'PERMISSION' || code === 'NOT_SUPPORTED' || /NotAllowed|Permission|denied|拒绝|安全/i.test(String(e && e.message || e && e.name || ''));
    $('callText').textContent = isPerm ? '需要摄像头/麦克风权限才能接听' : '接听失败，请重试';
    $('acceptCallBtn').style.display=''; $('rejectCallBtn').style.display=''; $('hangupBtn').style.display='none';
    toast((isPerm ? '未授权媒体权限：请在浏览器地址栏点击 🔒 → 网站设置 → 允许"摄像头/麦克风"，然后重新接听' : '无法获取媒体：') + (e.message || e.name || ''), 'error', 5000);
    clearCallTimer();
    callTimer = setTimeout(() => { if (incomingCall === pendingCall) rejectIncomingCall(); }, 30000);
  }
}
function rejectIncomingCall() { stopCallRingtone(); if (incomingCall) { send(P.C_SIGNAL,{to:incomingCall.from,sub:'call_reject',data:null}); incomingCall = null; } closeCallBar(); }
function hangup() { if (callPeer) send(P.C_SIGNAL,{to:callPeer,sub:'hangup',data:null}); if (rtc&&callPeer) rtc.hangup(callPeer); closeCallBar(); }
function closeCallBar() {
  stopCallRingtone();
  clearCallTimer();
  stopCallDuration();
  stopCallRecording();
  releaseLocalMedia();
  pendingRemoteStream = null;
  const lv=$('localVideo'), rv=$('remoteVideo'); if (lv){lv.style.display='none';} if (rv){rv.style.display='none';}
  const bar=$('callBar'); if (bar){bar.style.display='none';bar.classList.remove('with-video');}
  callPeer=null; callKind=null; incomingCall=null;
}
$('fileBtn').onclick = () => {
  if (!state.activePeer) return toast('请先选择联系人', 'warn');
  const inp = document.createElement('input'); inp.type='file'; inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    $('fileBar').style.display=''; $('fileText').textContent='发送：'+f.name+' ('+humanSize(f.size)+')'; setProgress(0);
    fetch(state.serverHost + '/api/files?to=' + encodeURIComponent(state.activePeer) + '&name=' + encodeURIComponent(f.name) + '&mime=' + encodeURIComponent(f.type || 'application/octet-stream'), {
      method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + state.token }
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      send(P.C_MSG, { to: state.activePeer, content: '__FILE__' + JSON.stringify({ id: data.id, name: data.name, size: data.size, mime: data.mime }), clientMsgId: 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10) });
      $('fileText').textContent='已发送：'+f.name; setProgress(1);
      setTimeout(()=>$('fileBar').style.display='none',3000);
    }).catch((e)=>{ $('fileText').textContent='发送失败：'+e.message; toast('文件发送失败：' + e.message, 'error'); });
  }; inp.click();
};
function appendFileMsg(mine, name, size, fileId, createdAt) {
  const box=$('messages'); const row=document.createElement('div'); row.className='msg-row '+(mine?'me':'other');
  row.innerHTML='<div class="bubble"><div class="file-msg"><div class="ficon">文</div><div><div class="fname">'+escapeHtml(name)+'</div><div class="fsize">'+humanSize(size)+'</div></div>'+(fileId?'<button class="fsize file-download" type="button">下载</button>':'')+'</div></div><span class="time">'+fmtTime(createdAt || Date.now())+'</span>';
  const download = row.querySelector('.file-download');
  if (download) download.onclick = async () => {
    download.disabled = true;
    try {
      const res = await fetch(state.serverHost + '/api/files/' + encodeURIComponent(fileId), { headers: { 'Authorization': 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message, 'error'); } finally { download.disabled = false; }
  };
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}
$('audioBtn').onclick = () => startOutgoingCall('audio');
$('videoBtn').onclick = () => startOutgoingCall('video');
$('acceptCallBtn').onclick = acceptIncomingCall;
$('rejectCallBtn').onclick = rejectIncomingCall;
$('hangupBtn').onclick = hangup;
initRtc();

// ============ 语音消息（点一下开始录音，再点一下发送） ============
let recState = null; // { mediaRec, stream, chunks, startTime, timer, canceled, el }
const VOICE_PREFIX = '__VOICE__';

async function startVoiceRec() {
  if (recState) return;
  if (!state.activePeer) { toast('请先选择联系人', 'warn'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    const btn = $('voiceBtn');
    btn.classList.add('recording');
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const elapsed = (Date.now() - recState.startTime) / 1000;
      const canceled = recState.canceled;
      const st = recState; recState = null;
      st.stream.getTracks().forEach(t => t.stop());
      if (canceled) { return; }
      if (elapsed < 1) { toast('语音太短', 'warn', 1000); return; }
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 500 * 1024) { toast('语音过长（限60秒）', 'warn'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const b64 = dataUrl.split(',')[1];
        const body = VOICE_PREFIX + elapsed.toFixed(1) + '|' + b64;
        const clientMsgId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        send(P.C_MSG, { to: state.activePeer, content: body, clientMsgId });
        // 自己也存 b64，方便点播放能听
        appendVoiceMsg(true, elapsed, b64);
      };
      reader.readAsDataURL(blob);
    };
    recState = { mediaRec: mr, stream, chunks, startTime: Date.now(), timer: null, canceled: false, el: null };
    mr.start();
    $('recBar').style.display = '';
    $('recBar').classList.remove('cancel');
    $('recTime').textContent = '0.0s';
    recState.timer = setInterval(() => {
      if (!recState) return;
      const s = (Date.now() - recState.startTime) / 1000;
      $('recTime').textContent = s.toFixed(1) + 's';
      // 超过 60 秒自动发
      if (s >= 60) stopVoiceRec();
    }, 100);
  } catch (e) {
    toast('无法访问麦克风: ' + e.message, 'error');
  }
}

function stopVoiceRec(cancel) {
  if (!recState) return;
  if (cancel) recState.canceled = true;
  if (recState.timer) clearInterval(recState.timer);
  try { recState.mediaRec.stop(); } catch {}
  $('recBar').style.display = 'none';
  $('voiceTip').style.display = 'none';
  // 复位语音按钮文字
  const btn = $('voiceBtn');
  if (btn) { btn.classList.remove('recording'); btn.textContent = '语音'; }
  document.dispatchEvent(new Event('recrecstate'));
}

// 点击语音按钮 = 开始录音；再点击 = 发送
(function bindVoiceButton() {
  const btn = $('voiceBtn');
  btn.addEventListener('click', () => {
    if (recState) {
      stopVoiceRec(false); // 再点一次 = 发送
    } else {
      startVoiceRec();
    }
  });
})();

// 浏览器语音转文字：使用 Web Speech API，识别结果写入普通消息输入框。
// Chrome / Edge 支持较好；不支持时给出清晰提示，不影响语音消息功能。
(function bindSpeechToText() {
  const btn = $('speechBtn');
  if (!btn) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    btn.title = '当前浏览器不支持语音转文字';
    btn.onclick = () => toast('当前浏览器不支持语音转文字，请使用最新版 Chrome 或 Edge', 'warn', 2200);
    return;
  }
  let recognition = null;
  let active = false;
  let baseText = '';
  btn.onclick = () => {
    if (active && recognition) { recognition.stop(); return; }
    recognition = new Recognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    baseText = $('input').value;
    active = true;
    btn.classList.add('transcribing');
    btn.textContent = '停止转写';
    let finalText = '';
    recognition.onresult = ev => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const part = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += part;
        else interim += part;
      }
      $('input').value = baseText + finalText + interim;
      saveCurrentDraft();
    };
    recognition.onerror = ev => {
      if (ev.error !== 'aborted') {
        const msg = ev.error === 'not-allowed' ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风权限' : '语音转文字失败：' + ev.error;
        toast(msg, 'warn', 2400);
      }
    };
    recognition.onend = () => {
      active = false;
      btn.classList.remove('transcribing');
      btn.textContent = '转文字';
      saveCurrentDraft();
    };
    try { recognition.start(); toast('开始语音转文字，再次点击可停止', 'info', 1400); }
    catch { active = false; btn.classList.remove('transcribing'); btn.textContent = '转文字'; }
  };
})();

// 发送/收到语音气泡
function appendVoiceMsg(mine, durationSec, b64) {
  const box = $('messages');
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'other');
  const bars = '<span class="voice-bars">' + Array.from({length: 5}, (_, i) => '<span style="height:'+(6+i*2)+'px"></span>').join('') + '</span>';
  const dur = durationSec.toFixed(1) + '" ';
  row.innerHTML = '<div class="bubble"><div class="voice-bubble ' + (mine ? 'me' : '') + '">'
    + '<span class="play">\u25B6</span>'
    + bars
    + '<span class="vdur">' + dur + '</span>'
    + '</div></div><span class="time">' + fmtTime(Date.now()) + '</span>';
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  if (b64) {
    row.querySelector('.voice-bubble')._b64 = b64;
    row.querySelector('.voice-bubble').onclick = function () {
      const audio = new Audio('data:audio/webm;base64,' + this._b64);
      audio.play();
      const btn = this.querySelector('.play');
      const orig = btn.textContent;
      btn.textContent = '\u23F8';
      audio.onended = () => { btn.textContent = orig; };
      audio.onerror = () => { toast('播放失败', 'error'); btn.textContent = orig; };
    };
  }
}

// 在 onIncomingMsg / renderMessages 里识别并特殊处理 voice
const _orig_onIncomingMsg = onIncomingMsg;
onIncomingMsg = function (m) {
  if (typeof m.content === 'string' && m.content.startsWith(VOICE_PREFIX)) {
    const rest = m.content.slice(VOICE_PREFIX.length);
    const sep = rest.indexOf('|');
    const dur = parseFloat(rest.slice(0, sep));
    const b64 = rest.slice(sep + 1);
    if (state.activePeer === m.from) {
      appendVoiceMsg(false, dur, b64);
      send(P.C_READ, { from: m.from });
    } else {
      state.unread[m.from] = (state.unread[m.from] || 0) + 1;
      const fromUser = state.friends.find(u => u.id === m.from);
      if (window.chatAPI) window.chatAPI.notify((fromUser ? fromUser.nickname : '新消息') + ' 发来语音', '');
    }
    state.lastFrom[m.from] = '[语音]';
    renderContacts();
    return;
  }
  _orig_onIncomingMsg(m);
};

// 历史：识别语音消息格式，B做显示（无 b64 不能播但显示时长）
const _orig_appendMessage = appendMessage;
appendMessage = function (m, prepend) {
  if (typeof m.content === 'string' && m.content.startsWith(VOICE_PREFIX)) {
    const rest = m.content.slice(VOICE_PREFIX.length);
    const sep = rest.indexOf('|');
    const dur = parseFloat(rest.slice(0, sep)) || 0;
    const b64 = rest.slice(sep + 1);
    appendVoiceMsg(m.from === state.me.id, dur, b64);
    return;
  }
  _orig_appendMessage(m, prepend);
};
tryRestore();
checkUpdate();
wireConversationTools();

// i18n 兜底：i18n.js 在 DOMContentLoaded 时已自行 apply() 一次；
// 这里再补一次，覆盖 app.js 在 DOMContentLoaded 之前或之后执行的场景，确保静态 DOM 译好。
if (window.SCI18N && typeof SCI18N.apply === 'function') {
  const _applyI18n = () => SCI18N.apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _applyI18n, { once: true });
  else _applyI18n();
}
