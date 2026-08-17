'use strict';

// �ͻ��˴���汾�ţ������� /api/version.latest �ȶԣ����°��ᵯ���¸��㡣
const PACKAGE_VERSION = '1.62.3';

const P = {
  C_AUTH: 'auth', C_MSG: 'msg', C_READ: 'read', C_TYPING: 'typing',
  C_SIGNAL: 'signal',
  C_GROUP_MSG: 'group_msg', C_GROUP_READ: 'group_read',
  S_AUTH_OK: 'auth_ok', S_AUTH_FAIL: 'auth_fail', S_MSG: 'msg',
  S_USER_LIST: 'user_list', S_TYPING: 'typing', S_ERROR: 'error',
  S_MSG_RECALL: 'msg_recall', S_MSG_READ: 'msg_read',
  S_SIGNAL: 'signal',
  S_FRIEND_REQ: 'friend_req', S_FRIEND_LIST: 'friend_list',
  S_GROUP_MSG: 'group_msg', S_GROUP_LIST: 'group_list',
  S_ANNOUNCEMENT: 'announcement', S_KICKED: 'kicked'
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
  lastMsgTime: {},
  groupLastMsg: {},
  groupLastMsgTime: {},
  // E2EE�����˺�˽Կ��JWK������¼�ɹ������
  myPrivJwk: null,
  // �ѷ�����Ϣ���Ļ��棺clientMsgId -> ���ģ����ڷ���˻ذ��滻������ʾԭ����
  sentPlain: {},
  // �����ѷ��ͣ��ֹ���Ⱦ����Ϣ��clientMsgId -> true������ȥ�ط���˻���
  pendingLocal: {},
  // Ⱥ��
  tabContact: 'friends',   // 'friends' | 'groups'
  groups: [],
  activeGroup: null,
  groupUnread: {},
  groupMsgs: {},           // groupId -> �Ѽ�����Ϣ���飨�����ػ��浱ǰ/��ʷ��
};

// ���ص� window����������ģ�飨modules/*.js����ȡȫ�ֵ�¼̬/��ǰ�Ự��
// ��Щģ���ǰ���� window.state ����δ����ֵ������ token/activePeer/activeGroup ȫΪ�� �� ����ʧЧ��
window.P = P; window.state = state;

const $ = (id) => document.getElementById(id);

// i18n �������ò����ֵ���ֵ�����δ��¼�� key ʱ�����˵�ԭ���ģ�����Ӳ�������ġ�
function t(key, fallback) {
  if (window.SCI18N && typeof SCI18N.t === 'function') {
    const v = SCI18N.t(key);
    // SCI18N.t ��ȱʧ key ʱ�᷵�� key ��������ʱ�䵽 fallback��
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
  const cv = document.getElementById('chatView');
  const isMobileChat = cv && cv.classList.contains('mobile-chat-active');
  const input = isMobileChat ? $('input') : (document.getElementById('desktopInput') || $('input'));
  const value = input ? input.value : '';
  if (value) drafts[key] = value;
  else delete drafts[key];
  localStorage.setItem(draftStorageKey(), JSON.stringify(drafts));
  const hintId = isMobileChat ? 'draftState' : 'draftStateDesktop';
  const hint = document.getElementById(hintId);
  if (hint) hint.textContent = value ? t('draftSaved','�ݸ��ѱ���') : t('draftAuto','�ݸ��Զ�����');
}
function restoreCurrentDraft() {
  const key = activeConversationKey();
  const cv = document.getElementById('chatView');
  const isMobileChat = cv && cv.classList.contains('mobile-chat-active');
  const input = isMobileChat ? $('input') : (document.getElementById('desktopInput') || $('input'));
  if (!input) return;
  input.value = key ? (readDrafts()[key] || '') : '';
  const hintId = isMobileChat ? 'draftState' : 'draftStateDesktop';
  const hint = document.getElementById(hintId);
  if (hint) hint.textContent = input.value ? t('draftRestored','�ѻָ��ݸ�') : t('draftAuto','�ݸ��Զ�����');
}

// ============ ���������ֶζ��壨��100 � ============
// �������ֶΣ�nickname / country / province / city�����Ž� extra����
// �����ֶ�ȫ������ extra��JSON ���󣬱�ƽ key-value����
const PROFILE_FIELDS = [
  { cat: '����', items: [
    { key: 'realname', label: '��ʵ����', placeholder: '�ɲ���' },
    { key: 'englishName', label: 'Ӣ����' },
    { key: 'alias', label: '���� / �ǳ�' },
    { key: 'gender', label: '�Ա�' },
    { key: 'orientation', label: '��ȡ��' },
    { key: 'marital', label: '����״��' },
    { key: 'birthday', label: '����', placeholder: 'YYYY-MM-DD' },
    { key: 'bloodType', label: 'Ѫ��' },
    { key: 'zodiac', label: '����' },
    { key: 'chineseZodiac', label: '��Ф' },
    { key: 'height', label: '����(cm)' },
    { key: 'weight', label: '����(kg)' },
    { key: 'race', label: '���� / ����' },
    { key: 'idType', label: '֤������' },
  ] },
  { cat: '����', items: [
    { key: 'hometown', label: '���� / ����' },
    { key: 'nationality', label: '����' },
    { key: 'timezone', label: 'ʱ��' },
    { key: 'language', label: 'ĸ��' },
    { key: 'languages2', label: '��������' },
    { key: 'district', label: '�� / ��' },
    { key: 'street', label: '�ֵ� / ��ַ' },
    { key: 'village', label: 'С��' },
    { key: 'zip', label: '�ʱ�' },
    { key: 'currentAddress', label: '��ס��ַ' },
    { key: 'workAddress', label: '������ַ' },
  ] },
  { cat: 'ְҵ', items: [
    { key: 'company', label: '��˾' },
    { key: 'jobTitle', label: 'ְλ' },
    { key: 'department', label: '����' },
    { key: 'workPhone', label: '�����绰' },
    { key: 'workEmail', label: '��������' },
    { key: 'industry', label: '��ҵ' },
    { key: 'jobLevel', label: 'ְ��' },
    { key: 'experience', label: '��������' },
    { key: 'skills', label: '�����س�' },
    { key: 'jobStatus', label: '��ְ״̬' },
    { key: 'salary', label: 'н�ʷ�Χ' },
    { key: 'gitHub', label: 'GitHub' },
  ] },
  { cat: '����', items: [
    { key: 'eduLevel', label: '���ѧ��' },
    { key: 'school', label: '��ҵԺУ' },
    { key: 'major', label: 'רҵ' },
    { key: 'graduation', label: '��ҵʱ��' },
    { key: 'degree', label: 'ѧλ' },
    { key: 'classRank', label: '�༶' },
    { key: 'studentId', label: 'ѧ��' },
    { key: 'highSchool', label: '����' },
    { key: 'middleSchool', label: '����' },
    { key: 'primarySchool', label: 'Сѧ' },
    { key: 'gpa', label: 'GPA' },
    { key: 'advisor', label: '��ʦ' },
  ] },
  { cat: '��ϵ��ʽ', items: [
    { key: 'phone', label: '�ֻ���' },
    { key: 'tel', label: '����' },
    { key: 'fax', label: '����' },
    { key: 'qq', label: 'QQ' },
    { key: 'wechat', label: '΢��' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'twitter', label: 'Twitter / X' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'discord', label: 'Discord' },
    { key: 'weibo', label: '΢��' },
    { key: 'bilibili', label: 'B վ ID' },
    { key: 'zhihu', label: '֪��' },
    { key: 'website', label: '������վ' },
    { key: 'blog', label: '����' },
  ] },
  { cat: '��Ȥ����', items: [
    { key: 'hobby1', label: '���� #1' },
    { key: 'hobby2', label: '���� #2' },
    { key: 'hobby3', label: '���� #3' },
    { key: 'reading', label: '�����鼮' },
    { key: 'readingType', label: '�Ķ�����' },
    { key: 'sports', label: '�˶�' },
    { key: 'sportTeam', label: '���� / ���' },
    { key: 'game', label: '��Ϸ' },
    { key: 'gameId', label: '��Ϸ ID' },
    { key: 'travel', label: '��ȥ���е�' },
    { key: 'food', label: 'ϲ����ʳ��' },
    { key: 'drink', label: 'ϲ��������' },
    { key: 'pet', label: '����' },
    { key: 'plant', label: 'ֲ��' },
    { key: 'photo', label: '��Ӱ' },
    { key: 'collection', label: '�ղ�' },
    { key: 'diy', label: '���� / DIY' },
    { key: 'car', label: '����' },
    { key: 'movie', label: '������Ӱ' },
    { key: 'anime', label: '����' },
  ] },
  { cat: '����/Ӱ��', items: [
    { key: 'singer', label: 'ϲ���ĸ���' },
    { key: 'band', label: 'ϲ�����ֶ�' },
    { key: 'song', label: 'ϲ���ĸ�' },
    { key: 'album', label: 'ϲ����ר��' },
    { key: 'musicType', label: '��������' },
    { key: 'instrument', label: '����' },
    { key: 'movie1', label: 'ϲ���ĵ�Ӱ' },
    { key: 'director', label: 'ϲ���ĵ���' },
    { key: 'actor', label: 'ϲ������Ա' },
    { key: 'actress', label: 'ϲ����Ů��Ա' },
    { key: 'movieType', label: '��Ӱ����' },
    { key: 'tvShow', label: '׷�ľ�' },
    { key: 'show', label: '���ս�Ŀ' },
    { key: 'podcast', label: '���Ĳ���' },
    { key: 'idol', label: 'ż��' },
  ] },
  { cat: '���ʽ', items: [
    { key: 'smoke', label: '�Ƿ�����' },
    { key: 'drinkAlcohol', label: '�Ƿ�����' },
    { key: 'sleepTime', label: '��Ϣ' },
    { key: 'diet', label: '��ʳƫ��' },
    { key: 'religion', label: '�ڽ�����' },
    { key: 'political', label: '��������' },
    { key: 'vehicle', label: '���н�ͨ' },
    { key: 'house', label: 'ס��' },
    { key: 'salaryIdeal', label: '��������' },
    { key: 'fitness', label: '����Ƶ��' },
    { key: 'cooking', label: '�Ƿ������' },
  ] },
  { cat: '��ֵ��', items: [
    { key: 'motto', label: '������' },
    { key: 'dream', label: '���� / ����' },
    { key: 'religionPref', label: '��ż��������' },
    { key: 'value1', label: '��ص��� 1' },
    { key: 'value2', label: '��ص��� 2' },
    { key: 'value3', label: '��ص��� 3' },
    { key: 'idealAge', label: '�����������' },
    { key: 'idealHeight', label: '�����������' },
    { key: 'idealJob', label: '�������ְҵ' },
    { key: 'idealCharacter', label: '��������Ը�' },
    { key: 'taboo', label: '���ܽ��ܵ�' },
  ] },
  { cat: '����ǩ��', items: [
    { key: 'signature', label: '����ǩ��' },
    { key: 'status', label: '״̬' },
    { key: 'intro', label: '���ҽ���' },
    { key: 'nickname2', label: '�����ǳ�' },
    { key: 'tagline', label: 'һ�仰��ǩ' },
    { key: 'mood', label: '����' },
  ] },
];

// �Զ��� Toast ��ʾ����� alert��
function toast(msg, kind /* info|success|error|warn */, ms) {
  kind = kind || 'info';
  ms = ms || 2200;
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ico = { info: 'i', success: '?', error: '!', warn: '!' }[kind] || 'i';
  el.innerHTML = '<div class="ico">' + ico + '</div><div>' + escapeHtml(msg) + '</div>';
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ============ ��¼/ע�� ============
let mode = 'login';
let loginMode = 'password'; // 'password' | 'code'������¼ģʽ��Ч��
let qrLoginTimer = null;

// ���ݵ�ǰ mode �� loginMode ͳһˢ�µ�¼/ע������ֶε�����
function applyLoginMode() {
  const showReg = mode === 'register';
  $('nickname').style.display = showReg ? 'block' : 'none';
  $('customUid').style.display = showReg ? 'block' : 'none';
  $('country').style.display = showReg ? 'block' : 'none';
  $('province').style.display = showReg ? 'block' : 'none';
  $('city').style.display = showReg ? 'block' : 'none';
  // ��¼��ʽ�л��ؼ�������¼ģʽ��ʾ
  $('loginModeRow').style.display = showReg ? 'none' : 'flex';
  const useCode = !showReg && loginMode === 'code';
  const useQr = !showReg && loginMode === 'qr';
  // �����¼���û��� + ���룻��֤���¼������ + ��֤�룻ɨ���¼�������ڶ�ά��
  const showPw = showReg || (!useCode && !useQr);
  $('username').style.display = showPw ? 'block' : 'none';
  $('password').style.display = showPw ? 'block' : 'none';
  $('email').style.display = (showReg || useCode) ? 'block' : 'none';
  $('codeRow').style.display = (showReg || useCode) ? 'flex' : 'none';
  $('authBtn').style.display = (showReg || !useQr) ? 'block' : 'none';
  const qa = $('qrLoginArea');
  if (qa) qa.style.display = useQr ? 'block' : 'none';
  if (useQr) {
    setQrLogin();
  } else if (qrLoginTimer) {
    clearInterval(qrLoginTimer);
    qrLoginTimer = null;
  }
  // �����¼ʱ�û�������� placeholder Ϊ���û��������䡹��ע��/��֤���¼ʱΪ���û�����
  $('username').placeholder = (showReg || useCode || useQr) ? t('username', '�û���') : t('usernameOrEmail', '�û���������');
  // ���� placeholder��ע��ʱ��ʾ��ע��ʱ��д������¼��֤��ʱ��ʾ�����䡹
  $('email').placeholder = showReg ? t('email', '���䣨ע��ʱ��д��') : t('emailLogin', '����');
  // ��¼��ʽ��ť����
  document.querySelectorAll('.login-mode-btn').forEach(b => b.classList.toggle('on', b.dataset.loginMode === loginMode));
  $('authErr').textContent = '';
}

document.querySelectorAll('.tab').forEach(tt => {
  tt.onclick = () => {
    mode = tt.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === tt));
    $('authBtn').textContent = mode === 'login' ? t('login', '��¼') : t('register', 'ע��');
    applyLoginMode();
  };
});

// ��¼��ʽ�л���ť
document.querySelectorAll('.login-mode-btn').forEach(b => {
  b.onclick = () => {
    loginMode = b.dataset.loginMode;
    applyLoginMode();
  };
});

// ��ʼ����¼ҳ���״δ�ʱֱ����ʾ�����¼/��֤���¼�л���
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
    // ע�᣺�û��� + ���� + ���� + ��֤��
    if (!username || !password) { $('authErr').textContent = '�������û���������'; return; }
    if (!email) { $('authErr').textContent = '����д����'; return; }
    if (!code) { $('authErr').textContent = '������������֤��'; return; }
    endpoint = '/api/register';
    body = { username, password, nickname, email, code, customUid: $('customUid').value.trim(), country, province, city };
  } else if (loginMode === 'code') {
    // ��¼-��֤�룺���� + ��֤��
    if (!email) { $('authErr').textContent = '����д����'; return; }
    if (!code) { $('authErr').textContent = '������������֤��'; return; }
    endpoint = '/api/login/code';
    body = { email, code };
  } else if (loginMode === 'qr') {
    // ɨ���¼����ά���ڱ�������Ⱦ��authBtn ���أ��˷�֧��Ӧ����
    return;
  } else {
    // ��¼-���룺�˺ţ��û��������䣩+ ����
    if (!username || !password) { $('authErr').textContent = '�������û��������������'; return; }
    endpoint = '/api/login';
    body = { account: username, password };
  }
  const btn = $('authBtn');
  btn.disabled = true;
  btn.textContent = t('loggingIn', '��¼�С�');
  try {
    const res = await fetch(state.serverHost + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { $('authErr').textContent = data.error || '����ʧ��'; return; }
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('sc_token', state.token);
    localStorage.setItem('sc_me', JSON.stringify(state.me));
    enterChat();
    fetchAnnouncements();
  } catch (e) {
    $('authErr').textContent = '�޷����ӷ�������' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = mode === 'register' ? t('register', 'ע��') : (loginMode === 'code' ? t('codeLogin', '��֤���¼') : t('login', '��¼'));
  }
};

async function setQrLogin() {
  if (qrLoginTimer) { clearInterval(qrLoginTimer); qrLoginTimer = null; }
  const img = $('qrImage');
  const tip = $('qrTip');
  const qa = $('qrLoginArea');
  try {
    const res = await fetch(state.serverHost + '/api/login/qr/create', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '��ά������ʧ��');
    if (img) { img.src = state.serverHost + '/api/login/qr/image?token=' + encodeURIComponent(data.token); img.style.display = 'block'; }
    if (tip) tip.textContent = '��ʹ���ѵ�¼�� SecureChat �ֻ��ˡ�ɨһɨ��ɨ���ά���¼����ά�� 2 ��������Ч��';
    if ($('authErr')) $('authErr').textContent = '';
    let done = false;
    qrLoginTimer = setInterval(async () => {
      if (done) return;
      try {
        const r = await fetch(state.serverHost + '/api/login/qr/consume', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: data.token })
        });
        const rdata = await r.json();
        if (r.status === 410) { done = true; clearInterval(qrLoginTimer); if (tip) tip.textContent = '��ά����ʧЧ����ˢ������'; return; }
        if (rdata.status === 'ok' && rdata.token && rdata.user) {
          done = true; clearInterval(qrLoginTimer); qrLoginTimer = null;
          state.token = rdata.token;
          state.me = rdata.user;
          localStorage.setItem('sc_token', state.token);
          localStorage.setItem('sc_me', JSON.stringify(state.me));
          enterChat();
        }
      } catch (e) {}
    }, 2000);
  } catch (e) { if (tip) tip.textContent = e.message || '��ά������ʧ��'; }
}

const qrRegenBtnEl = $('qrRegenBtn');
if (qrRegenBtnEl) qrRegenBtnEl.onclick = () => setQrLogin();

// ����������֤�루ע���� purpose='register'����¼��֤���¼�� purpose='login'��
let codeTimer = null;
$('sendCodeBtn').onclick = async () => {
  const email = $('email').value.trim();
  if (!email) { $('authErr').textContent = '������д����'; return; }
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { $('authErr').textContent = '�����ʽ����'; return; }
  // ���ݵ�ǰ״̬������֤����;��ע�� �� register����¼+��֤���¼ �� login
  const purpose = mode === 'register' ? 'register' : 'login';
  $('sendCodeBtn').disabled = true;
  $('authErr').textContent = '���ڷ�����֤��...';
  try {
    const res = await fetch(state.serverHost + '/api/email/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, purpose })
    });
    const data = await res.json();
    if (!res.ok) { $('authErr').textContent = data.error || '����ʧ��'; $('sendCodeBtn').disabled = false; return; }
    $('authErr').textContent = '';
    toast('��֤���ѷ��ͣ����������', 'success');
    // 60s ����ʱ
    let n = 60;
    $('sendCodeBtn').textContent = n + 's';
    if (codeTimer) clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(codeTimer); $('sendCodeBtn').textContent = t('sendCode', '������֤��'); $('sendCodeBtn').disabled = false; }
      else $('sendCodeBtn').textContent = n + 's';
    }, 1000);
  } catch (e) {
    $('authErr').textContent = '����ʧ�ܣ�' + e.message;
    $('sendCodeBtn').disabled = false;
    $('sendCodeBtn').textContent = t('sendCode', '������֤��');
  }
};

$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authBtn').click(); });

// ---------- �Զ������� ----------
// ���廯�汾�Ƚϣ����� -1/0/1
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
// ������ʾ��չʾ������ҳ��download.html �·�������־����web �˲��ٵ����¸��㡣
async function checkUpdate() {
  return;
}

// �Զ��ָ���¼������֤ token �ٽ����죩
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
      if (res.ok) { enterChat(); fetchAnnouncements(); }
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
  if (qrLoginTimer) { clearInterval(qrLoginTimer); qrLoginTimer = null; }
  // �����ǰ�Ự/��ϵ��״̬
  state.current = null;
  if (state.messages) state.messages = {};
  // �л��ص�¼ҳ�����õ�¼ģʽ
  $('chatView').style.display = 'none';
  $('authView').style.display = 'flex';
  mode = 'login';
  loginMode = 'password';
  try { applyLoginMode(); } catch {}
  toast(t('logout', '���˳���¼'), 'info');
}

// ============ �������� ============
function enterChat() {
  $('authView').style.display = 'none';
  $('chatView').style.display = 'flex';
  renderMyInfo();
  // ��¼�ɹ��������ϴ����ݹ�Կ������Է�ֻ�ܸ��þɻỰ�����޷����ܡ�
  if (window.SCE2EE && typeof window.SCE2EE.ensureKeyPair === 'function') {
    window.SCE2EE.ensureKeyPair().catch(() => {});
  }
// �ָ����û��Զ������챳��ͼ��ÿ���û������洢��
  applyChatBg(getChatBg());
  applyMsgFont();
  connectWS();
  loadFriends();
  loadGroups();
  // E2EE ��ͣ�ã���Ϣ�����ķ��ͣ���������/�ϴ���Կ��
  // �ƶ��ˣ���¼��Ĭ����ʾ��ϵ���б������Զ���������̬��
  if (window.IS_MOBILE) {
    const cv = document.getElementById('chatView');
    if (cv) cv.classList.remove('mobile-chat-active');
  }
}

function renderMyInfo() {
  const hasImg = state.me && state.me.avatar;
  const avHtml = hasImg ? '<img src="' + state.me.avatar + '">'
    : avatarChar(state.me.nickname);
  // ������country/province/city �Ƕ����У������߽Կգ��ٳ��Դ� extra ȡ��ס�أ�currentAddress / hometown��
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
    regionHtml = '<div class="my-id region-display" style="cursor:pointer" title="����༭����">' + escapeHtml(regionText) + '</div>';
  } else {
    regionHtml = '<div class="my-id" style="cursor:pointer" id="emptyRegionTip">������δ���ã��㡰���ϡ���д</div>';
  }
  const dark = document.body.classList.contains('dark-mode');
  $('myInfo').innerHTML = '<div class="account-card">'
    + '<div class="account-main">'
    + '<div class="avatar my-avatar" id="myAvatar" title="�����ͷ��">' + avHtml + '</div>'
    + '<div class="account-copy"><div class="my-name">' + escapeHtml(state.me.nickname) + '</div>'
    + '<div class="my-id" id="myIdText" style="cursor:pointer" title="�������ID">ID: ' + (state.me.uid || '') + '</div></div>'
    + '<button class="account-exit" id="logoutBtn" title="' + escapeHtml(t('logout', '�˳���¼')) + '">' + escapeHtml(t('logout', '�˳�')) + '</button>'
    + '</div>'
    + '<div class="account-region">' + regionHtml + '</div>'
    + '<div class="account-toolbar">'
    + '<button class="account-tool" id="editProfileBtn">' + escapeHtml(t('profile', '����')) + '</button>'
    + '<button class="account-tool" id="editUidBtn">' + escapeHtml(t('editUid', '�� ID')) + '</button>'
    + '<button class="account-tool" id="myCardBtn">' + escapeHtml(t('myCard', '��Ƭ')) + '</button>'
    + '<button class="account-tool" id="scanQrBtn">' + escapeHtml(t('scan', 'ɨһɨ')) + '</button>'
    + '<button class="account-tool" id="bgBtn">' + escapeHtml(t('background', '����')) + '</button>'
    + '<button class="account-tool" id="feedbackBtn">' + escapeHtml(t('feedback', '����')) + '</button>'
    + '<span class="theme-switch" role="group" aria-label="�������">'
    + '<button class="theme-choice' + (!dark ? ' active' : '') + '" id="themeDayBtn">' + escapeHtml(t('light', '��')) + '</button>'
    + '<button class="theme-choice' + (dark ? ' active' : '') + '" id="themeNightBtn">' + escapeHtml(t('dark', 'ҹ')) + '</button>'
    + '</span></div>'
    + '</div>';
  // �˻��������ӱ�ǩ�������� data-i18n��apply() �ᶵ�ף�������ɨһ�Ρ�
  if (window.SCI18N && typeof SCI18N.apply === 'function') SCI18N.apply($('myInfo'));
  $('myAvatar').onclick = pickAvatar;
  $('bgBtn').onclick = pickChatBg;
  $('editUidBtn').onclick = editUid;
  $('editProfileBtn').onclick = editProfile;
  $('feedbackBtn').onclick = openFeedback;
  $('myCardBtn').onclick = showMyCard;
  $('scanQrBtn').onclick = openQrScanner;
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
    if (!uid) { toast('����ID�ɸ���', 'warn', 1000); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(uid))
        .then(() => toast('ID �Ѹ���', 'success', 1000))
        .catch(() => toast('����ʧ��', 'error', 1000));
    } else {
      toast('��ǰ�������֧�ָ���', 'warn', 1000);
    }
  };
}

// չʾ�ҵ���Ƭ���Ӻ��Ѷ�ά�룩
function showMyCard() {
  if (!state.me || !state.me.uid) { toast('����ID���޷�������Ƭ', 'warn', 1500); return; }
  const uid = String(state.me.uid);
  const qrText = 'securechat://friend?uid=' + encodeURIComponent(uid);
  const imgUrl = state.serverHost + '/api/qrcode/render?text=' + encodeURIComponent(qrText) + '&w=300';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = t('myCard', '��Ƭ');
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.setAttribute('aria-label', '�ر�'); xBtn.innerHTML = '&times;';
  head.appendChild(h3); head.appendChild(xBtn); box.appendChild(head);
  const body = document.createElement('div');
  body.style.cssText = 'text-align:center;padding:6px 0 4px';
  body.innerHTML = '<img src="' + imgUrl + '" alt="��Ƭ��ά��" style="width:220px;height:220px;max-width:100%;border:1px solid var(--border);border-radius:12px;padding:10px;background:#fff">'
    + '<div style="margin-top:12px;font-size:14px;font-weight:600">' + escapeHtml(state.me.nickname) + '</div>'
    + '<div style="font-size:12px;color:#64748b;margin-top:3px">ID: ' + escapeHtml(uid) + '</div>'
    + '<div style="margin-top:8px;font-size:12px;color:#64748b">���������ֻ���ɨһɨ��������Ϊ����</div>';
  box.appendChild(body);
  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = t('close', '�ر�');
  acts.appendChild(ok); box.appendChild(acts);
  mask.appendChild(box); document.body.appendChild(mask);
  const close = () => mask.remove();
  ok.onclick = close; xBtn.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ��ͼ��� ImageData �����ά�루jsQR Ϊͬ����ǰ�˽��룬ͼƬ���ϴ���
function decodeQRFromImageData(imageData) {
  if (typeof jsQR !== 'function') throw new Error('��ά������δ����');
  const res = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert'
  });
  return res ? res.data : null;
}

// ��ȾͼƬ�� canvas������ ImageData ��ԭʼλͼ
function renderToImageData(img) {
  const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// ����ɨ������������ �� �Ӻ��ѣ���¼�� �� ȷ�ϵ�¼
async function handleScanText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('δʶ�𵽶�ά������');
  // ������
  let uid = null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'securechat:' && (u.hostname === 'friend' || u.pathname.indexOf('/friend') === 0)) uid = u.searchParams.get('uid');
  } catch (_) { /* �� URL �������ʽ */ }
  if (!uid && raw.startsWith('securechat://friend')) {
    const m = raw.match(/uid=(.+?)(&|$)/i);
    if (m) uid = m[1];
  }
  if (uid) {
    const ok = await confirmOpen('ɨһɨ', 'ʶ�𵽺��Ѷ�ά�룬ID��' + uid + '��ȷ�Ϸ��ͺ�������');
    if (!ok) return '��ȡ��';
    const res = await fetch(state.serverHost + '/api/friend/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ friendUid: String(uid).trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '�Ӻ���ʧ��');
    return '���������ѷ��ͣ�' + ((data.friend && (data.friend.nickname || data.friend.username)) || uid);
  }
  // ��¼�룺�ѵ�¼�豸ɨ��ȷ�ϣ�Ŀ���豸���ɵ�¼Ϊ��ǰ�˺�
  if (raw.startsWith('securechat://login')) {
    const m = raw.match(/token=(.+?)(&|$)/i);
    const token = m ? m[1] : null;
    if (!token) throw new Error('��¼��ά����Ч');
    const ok = await confirmOpen('ɨһɨ', 'ȷ��������һ̨�豸��¼ SecureChat ��');
    if (!ok) return '��ȡ��';
    const res = await fetch(state.serverHost + '/api/login/qr/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ token })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ȷ��ʧ��');
    return '��ȷ�ϣ�Ŀ���豸�ɵ�¼';
  }
  throw new Error('���� SecureChat ��ά��');
}

// ȷ�ϵ��������� openModal ���
function confirmOpen(title, message) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal modal-sm';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h3 = document.createElement('h3'); h3.textContent = title;
    const xBtn = document.createElement('button'); xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.innerHTML = '&times;';
    head.appendChild(h3); head.appendChild(xBtn); box.appendChild(head);
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = '<div style="font-size:14px;line-height:1.6">' + escapeHtml(message) + '</div>';
    box.appendChild(body);
    const acts = document.createElement('div');
    acts.className = 'modal-actions';
    const no = document.createElement('button'); no.className = 'cancel'; no.textContent = t('cancel', 'ȡ��');
    const yes = document.createElement('button'); yes.className = 'ok'; yes.textContent = t('confirm', 'ȷ��');
    acts.appendChild(no); acts.appendChild(yes); box.appendChild(acts);
    mask.appendChild(box); document.body.appendChild(mask);
    const settle = (v) => { mask.remove(); resolve(v); };
    yes.onclick = () => settle(true); no.onclick = () => settle(false); xBtn.onclick = () => settle(false);
    mask.addEventListener('click', (e) => { if (e.target === mask) settle(false); });
  });
}

// ��ɨһɨ������֧��ѡ��ͼƬ / ��ק / ճ��������ͼƬ��ǰ���� jsQR ����
function openQrScanner() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3'); h3.textContent = t('scan', 'ɨһɨ');
  const xBtn = document.createElement('button'); xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.innerHTML = '&times;';
  head.appendChild(h3); head.appendChild(xBtn); box.appendChild(head);
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.textAlign = 'center';
  const drop = document.createElement('div');
  const dropId = 'scanDrop_' + Date.now();
  drop.className = 'scan-drop'; drop.id = dropId;
  drop.innerHTML = '<div style="font-size:40px;opacity:.6">&#128269;</div>'
    + '<div style="margin-top:8px;font-size:14px">ѡ�����ק��ά��ͼƬ���˴�</div>'
    + '<div style="margin-top:4px;font-size:12px;color:#64748b">Ҳ֧�� Ctrl+V ճ��ͼƬ��ͼƬ���ڱ�������</div>';
  const preview = document.createElement('img');
  preview.style.cssText = 'max-width:240px;max-height:240px;margin-top:12px;border-radius:10px;border:1px solid var(--border);display:none';
  const btnRow = document.createElement('div');
  btnRow.className = 'modal-actions';
  const pick = document.createElement('button'); pick.className = 'ok'; pick.textContent = t('chooseImage', 'ѡ��ͼƬ');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  btnRow.appendChild(pick);
  body.appendChild(drop); body.appendChild(preview); body.appendChild(fileInput); body.appendChild(btnRow);
  box.appendChild(body);
  const status = document.createElement('div');
  status.className = 'modal-status'; status.style.cssText = 'font-size:12px;color:#64748b;padding:0 20px 12px;min-height:18px';
  box.appendChild(status);
  mask.appendChild(box); document.body.appendChild(mask);
  let pasteFn = null;
  const close = () => {
    if (pasteFn) { document.removeEventListener('paste', pasteFn); pasteFn = null; }
    mask.remove();
  };
  xBtn.onclick = close; mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

  let busy = false;

  async function renderFileToImageData(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im); im.onerror = () => reject(new Error('�޷���ȡͼƬ'));
        im.src = url;
      });
      const data = renderToImageData(img);
      return { data, url };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function decode(file) {
    if (busy) return;
    busy = true;
    try {
      const { data, url } = await renderFileToImageData(file);
      preview.src = url; preview.style.display = 'block';
      status.textContent = '����ʶ��';
      const text = decodeQRFromImageData(data);
      if (text === null) { status.textContent = 'δʶ�𵽶�ά�룬�뻻һ�Ÿ�������ͼƬ'; return; }
      status.textContent = 'ʶ��ɹ��������С�';
      const result = await handleScanText(text);
      status.textContent = result || '�������';
    } catch (e) {
      status.textContent = e.message || 'ʶ��ʧ��';
    } finally {
      busy = false;
    }
  }

  pick.onclick = () => fileInput.click();
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => { const f = fileInput.files[0]; if (f) decode(f); };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
    const f = (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) || null;
    if (f) decode(f);
  });
  document.addEventListener('paste', pasteFn = function onPaste(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image') === 0) {
        const f = it.getAsFile();
        if (f) { decode(f); return; }
      }
    }
  });
}

// ͨ��ģ̬�������������� prompt/confirm��
function openModal(title, fields, onOk) {
  // fields: [{key, label, value, placeholder}]
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  // ������������ + ��棨����ͬȡ����
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x';
  xBtn.type = 'button';
  xBtn.setAttribute('aria-label', '�ر�');
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
  cancel.className = 'cancel'; cancel.textContent = 'ȡ��';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = '����';
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
  // �����ֹر�
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  // ESC �ر�
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  // �Զ��۽���һ��
  if (fields[0] && fields[0]._el) fields[0]._el.focus();
}

// ---------- ���Է������ģ����๦����ڣ�----------
// �ۺϸ�ҵ��ģ�飨groups/chat-ext/rtc/media/lifestyle/payment/status-collar �ȣ���
// ��ڵ�һ��������塣����ģ�鶼ͨ�� window.SecureChatExt.registerFeature �Ǽǣ�
// ����ͳһ�� SecureChatExt.getFeature(name) ȡ�ã�������Ͼ���ģ���ʵ��ϸ�ڡ�
// ˵����feature.open ��������̬����
//   �� �Դ����㣨oa/videos/live/nearby/shake/scan/miniapp/groups/pay �ȣ���ֱ�� feature.open()��
//   �� ��Ҫ������status/favorites/moment-ext����feature.open(containerEl)��
// openFeatureCenter ��ǰ�ߵ��� open()���Ժ����½� modal ���������������� feature.open(container)��
// ÿ����ڵĽ�����ɫ��135deg����΢�š����֡�ҳ����ɫԲ�Ƿ��顣
const FEATURE_GRADS = [
  'linear-gradient(135deg,#07c160,#06ad56)',
  'linear-gradient(135deg,#10aeff,#0a7fe0)',
  'linear-gradient(135deg,#fa9d3b,#f97316)',
  'linear-gradient(135deg,#ff5b5b,#ef4444)',
  'linear-gradient(135deg,#9a6bff,#7c3aed)',
  'linear-gradient(135deg,#00bcd4,#0097a7)',
  'linear-gradient(135deg,#ff9800,#f57c00)',
  'linear-gradient(135deg,#8bc34a,#689f38)',
  'linear-gradient(135deg,#e91e63,#d81b60)',
  'linear-gradient(135deg,#3f51b5,#303f9f)',
  'linear-gradient(135deg,#00c853,#009624)',
  'linear-gradient(135deg,#ff4081,#f50057)',
];
function featureGrad(i) {
  const list = FEATURE_GRADS;
  return list[i % list.length];
}
function featureKey(label) {
  const keys = {
    'Ⱥ�Ĺ���':'groups','ͶƱ����':'polls','Ⱥ����':'todos','��ʱ����':'remind','����':'translate','����Ȧ��ǿ':'moments',
    '��һ��':'read','��һ��':'search','��Ƶ��':'videos','���ں�':'oa','ֱ��':'live','С����':'miniapp',
    '���':'album','����':'cards','����':'stickers','����':'shop','��Ϸ':'games','���':'redpacket','��������':'nearby','ҡһҡ':'shake','ɨһɨ':'scan','֧������':'pay',
    '�ҵ�״̬':'status','�ҵ��ղ�':'favorites','�ո�����':'payment','�һ����ֵ':'redeem'
  };
  return keys[label] || 'feature';
}

// ��ѡ��Ⱥ���Ի����г���ǰ�û�Ⱥ�б���ѡ����ص� group����Ⱥ����ʾ�Ƚ���Ŀ��Ⱥ�ġ�
function pickGroupDialog(title, onPick) {
  const get = (name) => window.SecureChatExt && window.SecureChatExt.getFeature && window.SecureChatExt.getFeature(name);
  const groups = get('groups');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.cssText = 'width:min(520px,92vw);max-height:82vh;overflow:auto';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = title || 'ѡ��Ⱥ';
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.setAttribute('aria-label', '�ر�');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3); head.appendChild(xBtn);
  box.appendChild(head);
  const body = document.createElement('div');
  body.style.cssText = 'padding:4px 2px 8px';
  const tip = document.createElement('div');
  tip.style.cssText = 'font-size:12px;color:#999;padding:4px 6px 10px';
  tip.textContent = '�ù�����Ҫѡ��һ��Ŀ��Ⱥ�ģ�';
  body.appendChild(tip);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  body.appendChild(list);
  box.appendChild(body);
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  xBtn.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });

  const loading = document.createElement('div');
  loading.style.cssText = 'text-align:center;color:#999;padding:30px 0';
  loading.textContent = '���ڼ���Ⱥ�б���';
  list.appendChild(loading);

  const load = () => {
    if (!groups || typeof groups.listGroups !== 'function') {
      list.innerHTML = '<div style="text-align:center;color:#999;padding:30px 0">��δ��ȡ��Ⱥ�б������Ƚ���Ŀ��Ⱥ�ģ���Ⱥ����������</div>';
      return;
    }
    groups.listGroups().then((d) => {
      const arr = (d && d.groups) || [];
      list.innerHTML = '';
      if (!arr.length) {
        list.innerHTML = '<div style="text-align:center;color:#999;padding:30px 0">��û��Ⱥ�ģ����ȴ���һ��Ⱥ</div>';
        return;
      }
      arr.forEach((g) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:1px solid #eee;border-radius:10px;cursor:pointer;background:#fff;text-align:left;box-sizing:border-box';
        row.onmouseenter = () => { row.style.background = '#f5f5f5'; };
        row.onmouseleave = () => { row.style.background = '#fff'; };
        const av = document.createElement('div');
        av.style.cssText = 'width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#07c160,#06ad56);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0';
        av.textContent = (g.displayName || g.name || '?').charAt(0);
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;overflow:hidden';
        const n1 = document.createElement('div');
        n1.textContent = g.displayName || g.name || ('Ⱥ #' + g.id);
        n1.style.cssText = 'font-size:14px;font-weight:600;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const n2 = document.createElement('div');
        n2.style.cssText = 'font-size:12px;color:#999';
        n2.textContent = (g.memberCount != null ? g.memberCount + ' ��Ա' : (g.members ? g.members.length + ' ��Ա' : ''));
        info.appendChild(n1); info.appendChild(n2);
        row.appendChild(av); row.appendChild(info);
        row.onclick = () => {
          close();
          if (typeof onPick === 'function') { try { onPick(g); } catch (e) { console.error('[feature] ִ��ʧ��', e); toast('����ʧ�ܣ�' + (e && e.message || e), 'error'); } }
        };
        list.appendChild(row);
      });
    }).catch((e) => {
      list.innerHTML = '<div style="text-align:center;color:#c0392b;padding:30px 0">����Ⱥ�б�ʧ�ܣ�' + escapeHtml((e && e.message) || e) + '</div>';
    });
  };
  load();
}

// �� polls/todos ��Ⱥ�ڹ���ѡȺ����ã��� loadByGroup �� openCreate��
function openGroupTool(name, openMethod) {
  const get = (nm) => window.SecureChatExt && window.SecureChatExt.getFeature && window.SecureChatExt.getFeature(nm);
  const feature = get(name);
  if (!feature) { toast('�ù������δ����', 'warn'); return; }
  pickGroupDialog('ѡ��Ŀ��Ⱥ', async (g) => {
    if (feature.loadByGroup) { try { await feature.loadByGroup(g.id); } catch (e) { /* loadByGroup �ڲ��� toast */ } }
    const fn = feature[openMethod] || feature.openCreate;
    if (typeof fn !== 'function') { toast('�ù�����δ�ṩ���', 'warn'); return; }
    fn(g.id);
  });
}

function openFeatureCenter() {
  if (!window.SecureChatExt || typeof window.SecureChatExt.getFeature !== 'function') {
    toast('����ģ����δ���أ���ˢ��ҳ������', 'warn');
    return;
  }
  const get = (name) => window.SecureChatExt.getFeature(name);

  // ÿ����Ŀ��{label, short, grad, open}��short Ϊͼ�귽������ʾ������������2-4 �֣���grad Ϊ������ɫ������
  // ���ࣺ���� / ���� / ���� / ����
  const groups = [
    { id: 'community', label: '����', items: [
      { label: 'Ⱥ�Ĺ���', short: 'Ⱥ��', grad: 0, open: () => openFeatureModalFrom(get('groups'), 'openManager') },
      { label: 'ͶƱ����', short: 'ͶƱ', grad: 1, open: () => openGroupTool('polls', 'openCreate') },
      { label: 'Ⱥ����', short: '����', grad: 2, open: () => openGroupTool('todos', 'openCreate') },
      { label: '��ʱ����', short: '����', grad: 3, open: () => pickGroupDialog('ѡ��Ŀ��Ⱥ', (g) => {
          const feature = get('remind');
          if (!feature || typeof feature.openCreate !== 'function') { toast('�ù������δ����', 'warn'); return; }
          feature.openCreate({ targetType: 'group', targetId: g.id, defaultContent: '' });
        }) },
      { label: '����', short: '����', grad: 4, open: () => toast('����������Ϣ���Ҽ����򳤰���ʹ�÷���', 'info') },
      { label: '����Ȧ��ǿ', short: '����Ȧ', grad: 5, open: () => openContainerFeature(get('moment-ext'), '����Ȧ����') },
    ]},
    { id: 'content', label: '����', items: [
      { label: '��һ��', short: '��һ��', grad: 6, open: () => window.SecureChatRead && window.SecureChatRead.open() },
      { label: '��һ��', short: '��һ��', grad: 7, open: () => window.SecureChatSearch && window.SecureChatSearch.open() },
      { label: '��Ƶ��', short: '��Ƶ��', grad: 8, open: () => window.SecureChatVideos && window.SecureChatVideos.open() },
      { label: '���ں�', short: '���ں�', grad: 9, open: () => window.SecureChatOa && window.SecureChatOa.open() },
      { label: 'ֱ��', short: 'ֱ��', grad: 10, open: () => window.SecureChatLive && window.SecureChatLive.open() },
      { label: 'С����', short: 'С����', grad: 11, open: () => window.SecureChatMiniApp && window.SecureChatMiniApp.open() },
    ]},
    { id: 'life', label: '����', items: [
      { label: '���', short: '���', grad: 0, open: () => window.SecureChatAlbum && window.SecureChatAlbum.open() },
      { label: '����', short: '����', grad: 1, open: () => window.SecureChatCards && window.SecureChatCards.open() },
      { label: '����', short: '����', grad: 2, open: () => window.SecureChatStickers && window.SecureChatStickers.open() },
      { label: '����', short: '����', grad: 3, open: () => window.SecureChatShop && window.SecureChatShop.open() },
      { label: '��Ϸ', short: '��Ϸ', grad: 4, open: () => window.SecureChatGames && window.SecureChatGames.open() },
      { label: '���', short: '���', grad: 4, open: () => window.SecureChatRedpacket && window.SecureChatRedpacket.open() },
      { label: '��������', short: '����', grad: 10, open: () => window.SecureChatNearby && window.SecureChatNearby.open() },
      { label: 'ҡһҡ', short: 'ҡһҡ', grad: 11, open: () => window.SecureChatShake && window.SecureChatShake.open() },
      { label: 'ɨһɨ', short: 'ɨһɨ', grad: 5, open: () => window.SecureChatScan && window.SecureChatScan.open() },
      { label: '֧������', short: '֧��', grad: 6, open: () => openFeatureModalFrom(get('pay'), 'homePanel') },
    ]},
{ id: 'tools', label: '����', items: [
      { label: '�ҵ�״̬', short: '״̬', grad: 2, open: () => openContainerFeature(get('status'), '�ҵ�״̬') },
      { label: '�ҵ��ղ�', short: '�ղ�', grad: 3, open: () => openContainerFeature(get('favorites'), '�ҵ��ղ�') },
      { label: '�ո�����', short: '�ո���', grad: 4, open: () => openFeatureModalFrom(get('pay'), 'homePanel') },
      { label: '�һ����ֵ', short: '�һ�', grad: 5, open: () => { const p = get('pay'); if (p && typeof p.redeemFlow === 'function') p.redeemFlow(); else toast('�һ�����δ����', 'warn'); } },
      { label: '֪ʶ������', short: '֪ʶ��', grad: 0, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter(); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
      { label: '����ʵ�', short: '����', grad: 1, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter('idioms'); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
      { label: '��ʫ������', short: '��ʫ', grad: 2, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter('poems'); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
      { label: 'Ъ����', short: 'Ъ����', grad: 3, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter('xiehouyu'); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
      { label: 'Ц����ȫ', short: 'Ц��', grad: 4, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter('jokes'); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
      { label: '��������', short: '����', grad: 5, open: () => { if (window.openKnowledgeCenter) window.openKnowledgeCenter('quotes'); else toast('֪ʶ��ģ��δ���أ���ˢ������', 'warn'); } },
    ]},
  ];

  // ��Ⱦ����
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.cssText = 'width:min(680px,94vw);max-height:88vh;overflow:auto';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = '���๦��';
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.setAttribute('aria-label', '�ر�');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3); head.appendChild(xBtn);
  box.appendChild(head);

  const body = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'feature-tabs';
  const allTab = document.createElement('button');
  allTab.type = 'button';
  allTab.className = 'feature-tab active';
  allTab.textContent = 'ȫ��';
  tabs.appendChild(allTab);
  groups.forEach(cat => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'feature-tab';
    tab.dataset.featureCategory = cat.id;
    tab.textContent = cat.label;
    tabs.appendChild(tab);
  });
  box.appendChild(tabs);

  const renderCategories = (selected) => {
    body.innerHTML = '';
    groups.filter(cat => !selected || cat.id === selected).forEach(cat => {
    const sec = document.createElement('div');
    sec.className = 'feature-cat feature-cat-' + cat.id;
    const t = document.createElement('div');
    t.className = 'feature-cat-title';
    t.textContent = cat.label;
    sec.appendChild(t);
    const grid = document.createElement('div');
    grid.className = 'feature-grid';
    cat.items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'feature-item feature-item-' + cat.id + ' feature-item-' + featureKey(it.label);
      b.innerHTML =
        '<span class="feature-icon feature-icon-tone-' + (it.grad % 6) + '" style="background:' + featureGrad(it.grad) + '">' + escapeHtml(it.short || it.label || '+') + '</span>' +
        '<span class="feature-label">' + escapeHtml(it.label) + '</span>';
      b.onclick = () => {
        mask.remove();
        try { it.open(); } catch (e) { console.error('[feature] ��ʧ�� ' + it.label, e); toast('�򿪡�' + it.label + '��ʧ��', 'error'); }
      };
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    body.appendChild(sec);
  });
  };
  allTab.onclick = () => {
    tabs.querySelectorAll('.feature-tab').forEach(t => t.classList.remove('active'));
    allTab.classList.add('active');
    renderCategories('');
  };
  tabs.querySelectorAll('[data-feature-category]').forEach(tab => {
    tab.onclick = () => {
      tabs.querySelectorAll('.feature-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderCategories(tab.dataset.featureCategory);
    };
  });
  renderCategories('');
  box.appendChild(body);

  mask.appendChild(box);
  document.body.appendChild(mask);
  xBtn.onclick = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  const onKey = (ev) => { if (ev.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// �򿪡������͡����ԣ�Ϊ���½�һ�� modal ���������� feature.open(container)
function openContainerFeature(feature, title) {
  if (!feature || typeof feature.open !== 'function') { toast('�ù������δ����', 'warn'); return; }
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.cssText = 'width:min(620px,94vw);max-height:88vh;overflow:auto';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = title || '����';
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.setAttribute('aria-label', '�ر�');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3); head.appendChild(xBtn);
  box.appendChild(head);
  const host = document.createElement('div');
  box.appendChild(host);
  mask.appendChild(box);
  document.body.appendChild(mask);
  xBtn.onclick = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  const onKey = (ev) => { if (ev.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  try { feature.open(host); } catch (e) { console.error('[feature] ��ʧ��', e); toast('��ʧ�ܣ�' + (e && e.message || e), 'error'); }
}

// �򿪡��Դ����㡹���ԣ�feature[method] Ϊ��������ȱʡ�� open�����Ҹ÷������ܽ�������������
function openFeatureModalFrom(feature, method, hint) {
  if (!feature) { toast('�ù������δ����' + (hint ? '��' + hint + '��' : ''), 'warn'); return; }
  const call = feature[method] || feature.open || feature.homePanel;
  if (typeof call !== 'function') { toast('�ù�����δ�ṩ���', 'warn'); return; }
  try {
    // Ϊ��Ҫ container �����ķ������� homePanel���Զ���������
    if (method === 'homePanel' || method === 'mount' || method === 'open') {
      const mask = document.createElement('div'); mask.className = 'modal-mask';
      const box = document.createElement('div'); box.className = 'modal';
      box.style.cssText = 'width:min(620px,94vw);max-height:88vh;overflow:auto';
      const head = document.createElement('div'); head.className = 'modal-head';
      const h3 = document.createElement('h3'); h3.textContent = (feature._title || method) + '';
      const xBtn = document.createElement('button'); xBtn.className = 'modal-x'; xBtn.type = 'button'; xBtn.innerHTML = '&times;';
      head.appendChild(h3); head.appendChild(xBtn); box.appendChild(head);
      const host = document.createElement('div'); box.appendChild(host);
      mask.appendChild(box); document.body.appendChild(mask);
      xBtn.onclick = () => mask.remove();
      mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
      document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); } });
      call(host);
    } else {
      call();
    }
  } catch (e) { console.error('[feature] ��ʧ��', e); toast('��ʧ�ܣ�' + (e && e.message || e), 'error'); }
}

// �༭�������ϣ����� modal���� PROFILE_FIELDS �����г������ֶΡ�
// nickname/country/province/city �߶����У����������ֶ�ȫ������ extra��
function editProfile() {
  if (!state.me) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal modal-scroll';
  // ���������ı�����
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = '�༭��������';
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-x';
  xBtn.type = 'button';
  xBtn.setAttribute('aria-label', '�ر�');
  xBtn.innerHTML = '&times;';
  head.appendChild(h3);
  head.appendChild(xBtn);
  box.appendChild(head);
  // ������һ�����ࣺ������Ϣ���ǳƶ����У�
  const headCat = document.createElement('div');
  headCat.className = 'field-cat';
  headCat.textContent = '������Ϣ';
  box.appendChild(headCat);
  const builtIn = [
    { key: 'nickname', label: '�ǳ�', value: state.me.nickname || '', placeholder: '����ǳ�' },
    { key: 'country',  label: '���� / ����', value: state.me.country || '', placeholder: '�磺�й�' },
    { key: 'province', label: 'ʡ / ��', value: state.me.province || '', placeholder: '������' },
    { key: 'city',     label: '����', value: state.me.city || '', placeholder: '������' }
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
  // ��ť
  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  acts.style.marginTop = '18px';
  const cancel = document.createElement('button');
  cancel.className = 'cancel'; cancel.textContent = 'ȡ��';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = '����';
  acts.appendChild(cancel); acts.appendChild(ok);
  box.appendChild(acts);
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  cancel.onclick = close;
  xBtn.onclick = close;
  // ESC �ر�
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
      if (v) extraOut[k] = v; // ��ֵ��д�루�״�ʡһ�㣩
    }
    patch.extra = extraOut;
    close();
    saveProfile(patch);
  };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  // �Զ��۽��ǳ�
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

// ʵ�� POST ������ˣ�patch = { nickname, country, province, city, extra }
async function saveProfile(patch) {
  try {
    const res = await fetch(state.serverHost + '/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(patch)
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '����ʧ��', 'error'); return; }
    if (data.user) state.me = data.user;
    localStorage.setItem('sc_me', JSON.stringify(state.me));
    renderMyInfo();
    toast('�����Ѹ���', 'success');
  } catch (e) {
    toast('����ʧ�ܣ�' + e.message, 'error');
  }
}

// �޸��Զ���ID��һ����ֻ�ܸ�һ�Σ���˿��ƣ�
function editUid() {
  if (!state.me) return;
  openModal('�޸� ID', [{
    key: 'uid', label: '��ID��4-16λ��ĸ���֣�', value: state.me.uid || '', placeholder: 'xY7mK3n4'
  }], async (out, close) => {
    const uid = out.uid;
    if (!uid) { toast('ID ����Ϊ��', 'warn', 1000); return; }
    if (!/^[A-Za-z0-9]{4,16}$/.test(uid)) { toast('ID ��Ϊ 4-16 λ��ĸ����', 'warn', 1500); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/uid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ uid })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '�޸�ʧ��', 'error'); return; }
      if (data.user) state.me = data.user;
      else state.me.uid = data.uid || uid;
      localStorage.setItem('sc_me', JSON.stringify(state.me));
      renderMyInfo();
      toast('ID �Ѹ���', 'success');
    } catch (e) {
      toast('����ʧ�ܣ�' + e.message, 'error');
    }
  });
}

// ���� / Bug �ϱ������� modal���ύ�� /api/feedback
function openFeedback() {
  if (!state.me) return;
  openModal('���� / Bug �ϱ�', [
    { key: 'kind', label: '���ͣ�bug/suggestion/complaint/other��', value: 'bug' },
    { key: 'content', label: '����', placeholder: '��ϸ��������10�֣�' }
  ], async (out, close) => {
    if (!out.kind || !out.content || out.content.length < 10) {
      toast('�������� 10 ��', 'warn');
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
      if (!res.ok) { toast(data.error || '�ύʧ��', 'error'); return; }
      toast('���ύ����л������', 'success');
    } catch (e) {
      toast(e.message || '�ύʧ��', 'error');
    }
  });
}

// ����ͼ���û�ID����洢��ÿ���û����Եı���
function bgKey() { return 'sc_chatbg_' + (state.me && state.me.id || 'anon'); }
function getChatBg() { return localStorage.getItem(bgKey()); }
function setChatBg(uri) {
  if (uri) localStorage.setItem(bgKey(), uri);
  else localStorage.removeItem(bgKey());
}

// ѡ���ϴ�ͷ��
function pickAvatar() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 500 * 1024) { toast('ͷ��ͼƬ������500KB��', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch(state.serverHost + '/api/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
          body: JSON.stringify({ avatar: reader.result })
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || '�ϴ�ʧ��', 'error'); return; }
        state.me.avatar = data.user.avatar;
        localStorage.setItem('sc_me', JSON.stringify(state.me));
        renderMyInfo();
        toast('ͷ���Ѹ���', 'success');
      } catch (e) { toast('�ϴ�ʧ�ܣ�' + e.message, 'error'); }
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

// �ϴ�ͼƬ��Ϊ������汳�������� chat-view��
function pickChatBg() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 4 * 1024 * 1024) { toast('����ͼƬ������4MB��', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setChatBg(reader.result);
      applyChatBg(reader.result);
      toast('������Ӧ��', 'success');
    };
    reader.onerror = () => toast('��ȡʧ��', 'error');
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
function clearChatBg() { setChatBg(null); applyChatBg(null); toast('�ѻָ�Ĭ�ϱ���', 'info', 1000); }

function avatarChar(name) { return (name || '?').charAt(0).toUpperCase(); }

// ��¼���Լ�ý��Ȩ�ޣ�����"�����û��Ӧ"
async function checkMediaPermissionHint() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return;
    const checks = await Promise.allSettled([
      navigator.permissions.query({ name: 'camera' }).then((s) => s.state),
      navigator.permissions.query({ name: 'microphone' }).then((s) => s.state)
    ]);
    const states = checks.map((c) => c.status === 'fulfilled' ? c.value : 'prompt');
    if (states.indexOf('denied') >= 0) {
      toast('����ͷ/��˷�Ȩ���ѱ��ܾ��������ַ�� ?? �� ��վ���� �� ����"����ͷ/��˷�"�󼴿�ͨ��', 'error', 6000);
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
  // ����֤�� socket ��δ��������������/���� CONNECTING������ӣ�������ͳһ��ˢ�����⾲Ĭ������
  if (type !== P.C_AUTH) {
    state.outboundQueue.push({ type, payload });
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
    case P.S_AUTH_FAIL: toast(payload.error || '��¼ʧЧ', 'error'); logout(); break;
    case P.S_USER_LIST:
      state.users = payload.users || [];
      renderContacts();
      break;
case P.S_MSG:
      // ������ɺ�����Ⱦ������ʵʱ��Ϣ������ʾ�����Ҳ����Զ�ˢ�¡�
      // ���ܼ� 3s ��ʱ���������ʱ���ܿ�����Ϣ��Ⱦ�����������ױ��� Unhandled Rejection��
      Promise.race([
        maybeDecryptLive(payload),
        new Promise((_, rej) => setTimeout(() => rej(new Error('decrypt timeout')), 3000))
      ]).catch(() => {})
        .then(() => onIncomingMsg(payload))
        .catch((e) => console.warn('msg render failed', e));
      break;
    case P.S_TYPING:
      if (state.activePeer === payload.from) {
        const tip = document.querySelector('.typing-tip') || makeTypingTip();
        tip.textContent = '�Է���������...';
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => tip.textContent = '', 2000);
      }
      break;
    case P.S_ERROR: toast((payload && payload.error) || '���������ش���', 'error'); console.warn('server error', payload); break;
    case P.S_MSG_RECALL:
      if (payload && payload.messageId) markRecalled(payload.messageId, false);
      break;
    case P.S_MSG_READ:
      if (payload && (state.activePeer === payload.peerId)) markConversationRead();
      break;
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
      renderContacts();
      // ����ǰѡ�е�Ⱥ�����б��ˢ��һ�¶��� header ������״̬
      if (state.activeGroup && state.groups.find(g => g.id === state.activeGroup)) {
        renderChatHeader();
      }
      break;
    case P.S_GROUP_MSG:
      onIncomingGroupMsg(payload);
      break;
    case P.S_ANNOUNCEMENT:
      if (payload && payload.announcement) showAnnouncement(payload.announcement, true);
      break;
    case P.S_KICKED:
      toast(payload.reason || '�ѱ�ǿ������', 'error');
      logout();
      break;
  }
}

// ============ ϵͳ����չʾ ============
let shownAnnouncements = new Set();
function announcementLevelClass(l) { return l === 'danger' ? 'danger' : (l === 'warning' ? 'warning' : 'info'); }
function showAnnouncement(ann, force) {
  if (!ann || !ann.id) return;
  if (shownAnnouncements.has(ann.id) && !force) return;
  shownAnnouncements.add(ann.id);
  const title = ann.title || 'ϵͳ����';
  const cls = announcementLevelClass(ann.level);
  // ���� toast ϵͳ�����ø���Ŀ�ĺ��
  try {
    const mask = document.createElement('div');
    mask.className = 'announcement-mask';
    mask.innerHTML =
      '<div class="announcement-box ' + cls + '">' +
      '<div class="announcement-badge">' + (ann.level === 'danger' ? '��Ҫ֪ͨ' : (ann.level === 'warning' ? 'ϵͳ����' : 'ϵͳ����')) + '</div>' +
      '<div class="announcement-title">' + escapeHtml(title) + '</div>' +
      '<div class="announcement-content">' + escapeHtml(ann.content || '').replace(/\n/g, '<br>') + '</div>' +
      '<div class="announcement-actions"><button class="announcement-ok">֪����</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    const ok = mask.querySelector('.announcement-ok');
    ok.onclick = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  } catch (e) {
    toast(title + '��' + ann.content, 'info');
  }
}

// ��¼����ȡδ������
async function fetchAnnouncements() {
  if (!state.token) return;
  try {
    const res = await fetch(state.serverHost + '/api/announcements', {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    if (!res.ok) return;
    const data = await res.json();
    const anns = data.announcements || [];
    // ���򵯣���������ǰ�����ȵ��ɵ��ٵ��µ�������ã�
    for (let i = anns.length - 1; i >= 0; i--) showAnnouncement(anns[i], false);
  } catch (e) {}
}

let typingTimer = null;
function makeTypingTip() {
  const d = document.createElement('div');
  d.className = 'typing-tip';
  $('messages').parentElement.insertBefore(d, $('messages').nextSibling);
  return d;
}

// ============ ��ϵ���б���ֻ��ʾ���ѣ� ============
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
  updateUnreadBadge();
  const kw = $('search').value.trim().toLowerCase();
  const list = $('contactList');
  list.innerHTML = '';
  const friends = state.friends.filter(u => !kw
    || (u.nickname || '').toLowerCase().includes(kw)
    || (u.username || '').toLowerCase().includes(kw)
    || String(u.id).includes(kw)).sort((a, b) => Number(!!chatPrefs().pinned['u:' + b.id]) - Number(!!chatPrefs().pinned['u:' + a.id]) || (a.nickname || '').localeCompare(b.nickname || ''));
  const friendCount = $('friendCount'); if (friendCount) friendCount.textContent = state.friends.length;
  const groupCount = $('groupCount'); if (groupCount) groupCount.textContent = state.groups.length;
  const count = $('listCount');
  const groups = state.groups.filter(g => !kw
    || (g.name || '').toLowerCase().includes(kw)
    || String(g.id).includes(kw));
  const conversations = [];
  friends.forEach(u => conversations.push({ kind: 'user', item: u, key: 'u:' + u.id, time: state.lastMsgTime[u.id] || 0 }));
  groups.forEach(g => conversations.push({ kind: 'group', item: g, key: 'g:' + g.id, time: state.groupLastMsgTime[g.id] || 0 }));
  conversations.sort((a, b) => Number(!!chatPrefs().pinned[b.key]) - Number(!!chatPrefs().pinned[a.key]) || b.time - a.time);
  if (count) count.textContent = conversations.length + ' ���Ự';
  if (!conversations.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:30px 16px;text-align:center;color:#aaa;font-size:13px';
    tip.textContent = kw ? 'û��ƥ��ĺ��ѻ�Ⱥ��' : '��û�лỰ�����Ӻ��ѻ򴴽�Ⱥ�Ŀ�ʼ����';
    list.appendChild(tip);
    return;
  }
  conversations.forEach(c => {
    if (c.kind === 'group') {
      const g = c.item;
      const div = document.createElement('div');
      div.className = 'contact conversation-group' + (state.activeGroup === g.id ? ' active' : '');
      const unread = state.groupUnread[g.id] || 0;
      const lastMsg = state.groupLastMsg[g.id] || (g.lastMessage && g.lastMessage.content) || 'Ⱥ��';
      const lastTime = state.groupLastMsgTime[g.id] || 0;
      const isPinned = !!chatPrefs().pinned[c.key];
      const isMuted = !!chatPrefs().muted[c.key];
      div.innerHTML = `<div class="avatar group-avatar">${escapeHtml((g.name || '?').charAt(0).toUpperCase())}</div><div style="flex:1;overflow:hidden"><div class="name">${escapeHtml(g.name || ('Ⱥ #' + g.id))}</div><div class="last">${escapeHtml(String(lastMsg).replace(/\n/g, ' ').slice(0, 30))}</div></div>${lastTime ? `<span class="chat-time">${fmtChatListTime(lastTime)}</span>` : ''}${isPinned ? '<span class="contact-mark">�ö�</span>' : ''}${isMuted ? '<span class="contact-mark muted">����</span>' : ''}${unread ? (isMuted ? '<span class="badge dot"></span>' : `<span class="badge">${unread > 99 ? '99+' : unread}</span>`) : ''}`;
      div.onclick = () => selectGroup(g.id);
      list.appendChild(div);
      return;
    }
    const u = c.item;
    const div = document.createElement('div');
    div.className = 'contact' + (state.activePeer === u.id ? ' active' : '');
    const unread = state.unread[u.id] || 0;
    const avHtml = u.avatar ? '<img src="' + u.avatar + '">' : avatarChar(u.nickname);
    const isPinned = !!chatPrefs().pinned['u:' + u.id];
    const isMuted = !!chatPrefs().muted['u:' + u.id];
    const lastMsg = state.lastFrom[u.id];
    const lastTime = state.lastMsgTime ? state.lastMsgTime[u.id] : 0;
    const preview = lastMsg ? escapeHtml(String(lastMsg).replace(/\n/g, ' ').slice(0, 30)) : (u.online ? '����' : '����');
    const timeStr = lastTime ? fmtChatListTime(lastTime) : '';
    div.innerHTML = `<div class="avatar">${avHtml}</div>
      <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(u.nickname)}</div>
        <div class="last">${preview}</div>
      </div>
      ${timeStr ? `<span class="chat-time">${timeStr}</span>` : ''}${isPinned ? '<span class="contact-mark">�ö�</span>' : ''}${isMuted ? '<span class="contact-mark muted">����</span>' : ''}
      ${unread ? (isMuted ? '<span class="badge dot"></span>' : `<span class="badge">${unread > 99 ? '99+' : unread}</span>`) : ''}`;
    div.onclick = () => selectPeer(u.id);
    if (state.activePeer === u.id && unread) {
      state.unread[u.id] = 0;
      send(P.C_READ, { from: u.id });
    }
    list.appendChild(div);
  });
}

// ͨѶ¼Ŀ¼��Ⱦ��΢��ʽ��Ⱥ�� + A-Z ���ѣ���ʱ��/δ����
function renderContactsDirectory() {
  const kw = ($('search') && $('search').value.trim().toLowerCase()) || '';
  const list = $('contactList');
  if (!list) return;
  list.innerHTML = '';
  const friendCount = $('friendCount'); if (friendCount) friendCount.textContent = state.friends.length;
  const groupCount = $('groupCount'); if (groupCount) groupCount.textContent = state.groups.length;
  const count = $('listCount'); if (count) count.textContent = state.friends.length + ' λ����';

  const sections = [];
  // Ⱥ�ķ���
  const groups = state.groups.filter(g => !kw
    || (g.name || '').toLowerCase().includes(kw)
    || String(g.id).includes(kw)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (groups.length) sections.push({ title: 'Ⱥ��', items: groups.map(g => ({ kind: 'group', g })) });

  // ���ѣ����ǳ�����ĸ����
  const friends = state.friends.filter(u => !kw
    || (u.nickname || '').toLowerCase().includes(kw)
    || (u.username || '').toLowerCase().includes(kw)
    || String(u.id).includes(kw)).sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'zh'));

  const alphaMap = {};
  friends.forEach(u => {
    const ch = (u.nickname || '?').trim().charAt(0).toUpperCase();
    const key = /[A-Z]/.test(ch) ? ch : '#';
    (alphaMap[key] = alphaMap[key] || []).push(u);
  });
  Object.keys(alphaMap).sort().forEach(k => sections.push({ title: k, items: alphaMap[k].map(u => ({ kind: 'user', u })) }));

  if (!sections.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:30px 16px;text-align:center;color:#aaa;font-size:13px';
    tip.textContent = kw ? 'û��ƥ�����ϵ��' : '��û����ϵ�ˣ����Ӻ��ѿ�ʼ����';
    list.appendChild(tip);
    return;
  }

  sections.forEach(sec => {
    const head = document.createElement('div');
    head.className = 'section-label';
    head.textContent = sec.title;
    list.appendChild(head);
    sec.items.forEach(item => {
      const div = document.createElement('div');
      if (item.kind === 'group') {
        const g = item.g;
        div.className = 'contact conversation-group';
        div.innerHTML = `<div class="avatar group-avatar">${escapeHtml((g.name || '?').charAt(0).toUpperCase())}</div><div style="flex:1;overflow:hidden"><div class="name">${escapeHtml(g.name || ('Ⱥ #' + g.id))}</div><div class="last">${(g.members || []).length} ��</div></div>`;
        div.onclick = () => selectGroup(g.id);
      } else {
        const u = item.u;
        const avHtml = u.avatar ? '<img src="' + u.avatar + '">' : avatarChar(u.nickname);
        div.className = 'contact' + (state.activePeer === u.id ? ' active' : '');
        div.innerHTML = `<div class="avatar">${avHtml}</div><div style="flex:1;overflow:hidden"><div class="name">${escapeHtml(u.nickname)}</div><div class="last">${u.online ? '����' : '����'}</div></div>`;
        div.onclick = () => selectPeer(u.id);
      }
      list.appendChild(div);
    });
  });
}

// Ⱥ���б���Ⱦ
function renderGroupList() {
  const list = $('contactList');
  const kw = $('search').value.trim().toLowerCase();
  const groups = state.groups.filter(g => !kw
    || (g.name || '').toLowerCase().includes(kw)
    || String(g.id).includes(kw)).sort((a, b) => Number(!!chatPrefs().pinned['g:' + b.id]) - Number(!!chatPrefs().pinned['g:' + a.id]) || (a.name || '').localeCompare(b.name || ''));
  const friendCount = $('friendCount'); if (friendCount) friendCount.textContent = state.friends.length;
  const groupCount = $('groupCount'); if (groupCount) groupCount.textContent = state.groups.length;
  const count = $('listCount');
  if (count) count.textContent = groups.length + ' ��Ⱥ';
  if (!groups.length) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:30px 16px;text-align:center;color:#aaa;font-size:13px';
    tip.textContent = kw ? 'û��ƥ���Ⱥ' : '��û�м����κ�Ⱥ�����"����Ⱥ"��"����Ⱥ"';
    list.appendChild(tip);
    return;
  }
  groups.forEach(g => {
    const div = document.createElement('div');
    div.className = 'contact' + (state.activeGroup === g.id ? ' active' : '');
    const unread = state.groupUnread[g.id] || 0;
    const isOwner = state.me && g.ownerId === state.me.id;
    const ownerMark = isOwner ? ' (Ⱥ��)' : '';
    const memberCnt = (g.members || []).length;
    const lastMsg = state.groupLastMsg[g.id] || (g.lastMessage && g.lastMessage.content) || ('��Ա ' + memberCnt + ' ��');
    const groupTime = state.groupLastMsgTime[g.id] ? fmtChatListTime(state.groupLastMsgTime[g.id]) : '';
    const isPinned = !!chatPrefs().pinned['g:' + g.id];
    const isMuted = !!chatPrefs().muted['g:' + g.id];
    div.innerHTML = `<div class="avatar">${(g.name || '?').charAt(0).toUpperCase()}</div>
       <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(g.name)}<span class="last" style="margin-left:6px">ID:${g.id}${ownerMark}</span></div>
        <div class="last">${escapeHtml(String(lastMsg).slice(0, 30))}</div>
       </div>
       ${groupTime ? `<span class="chat-time">${groupTime}</span>` : ''}
      ${isPinned ? '<span class="contact-mark">�ö�</span>' : ''}${isMuted ? '<span class="contact-mark muted">����</span>' : ''}${unread ? (isMuted ? '<span class="badge dot"></span>' : `<span class="badge">${unread > 99 ? '99+' : unread}</span>`) : ''}`;
    div.onclick = () => selectGroup(g.id);
    if (state.activeGroup === g.id && unread) {
      state.groupUnread[g.id] = 0;
      send(P.C_GROUP_READ, { groupId: g.id });
    }
    list.appendChild(div);
  });
}

// �л� side-tab
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

    // ���� tab��΢��ʽ����ҳ������Ȧ/��Ƶ��/ֱ��/ɨһɨ/��һ��/��һ��/����/����/��Ϸ/С����/AI��
    if (tt.dataset.side === 'ai') {
      showMobilePage('discoverPage');
      renderDiscoverPage();
      if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
      return;
    }

    // ���๦�� tab�������Է������ģ�����ҵ��ģ��ͳһ��ڣ�
    if (tt.dataset.side === 'more') {
      tt.classList.remove('on'); // ��ռ�ݳ�פ����������������󸴹�
      openFeatureCenter();
      return;
    }

    // �� tab��΢��ʽ"��"ҳ������ + ֧��/�ղ�/���/���� + ���� + ���������
    if (tt.dataset.side === 'downloads' || tt.dataset.side === 'dl') {
      showMobilePage('mePage');
      renderMePage();
      if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
      return;
    }

    // ת�� tab����ת�˵���
    if (tt.dataset.side === 'pay') {
      if (window.IS_MOBILE) document.getElementById('chatView').classList.remove('mobile-chat-active');
      const main2 = document.querySelector('.main');
      if (main2) main2.style.display = 'flex';
      const aiView2 = $('aiView'); if (aiView2) aiView2.style.display = 'none';
      const downloadView2 = $('downloadView'); if (downloadView2) downloadView2.style.display = 'none';
      const fs = $('friendsSide'); if (fs) fs.style.display = '';
      const gs = $('groupsSide'); if (gs) gs.style.display = 'none';
      // ֱ�Ӵ�ת�˵���
      if (window.godoMods && window.godoMods.pay && typeof window.godoMods.pay.openTransfer === 'function') {
        window.godoMods.pay.openTransfer();
      } else if (window.SecureChatExt && typeof window.SecureChatExt.getFeature === 'function') {
        const payFeat = window.SecureChatExt.getFeature('pay');
        if (payFeat && typeof payFeat.openTransfer === 'function') payFeat.openTransfer();
      } else {
        toast('ת�˹�����δ���أ����ڡ����ࡹ�н���', 'warn');
      }
      return;
    }

    // ͨѶ¼ tab��΢��ʽ��ϵ��Ŀ¼��Ⱥ�� + �º��� + A-Z ���ѣ�
    if (tt.dataset.side === 'contacts') {
      showMobilePage('contactsPage');
      renderContactsPage();
      if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
      return;
    }

    // �лغ���/Ⱥ�飺�ָ� .main ��ʾ������ AI/����/��/ͨѶ¼ ȫ��ҳ
    hideMobilePages();
    const aiView2 = $('aiView');
    if (aiView2) aiView2.style.display = 'none';
    const downloadView2 = $('downloadView');
    if (downloadView2) downloadView2.style.display = 'none';
    const main2 = document.querySelector('.main');
    if (main2) main2.style.display = 'flex';
    // �ƶ��ˣ��лغ���/Ⱥ�� tab���ص��б�̬
    if (window.IS_MOBILE) document.getElementById('chatView').classList.remove('mobile-chat-active');

    const fs = $('friendsSide'); if (fs) fs.style.display = '';
    renderContacts();
  };
});

// �ƶ��˵ײ���������¡ rail tab ���ײ��������ʱת����ԭ tab
(function initMobileBottomNav() {
  const nav = $('mobileBottomNav');
  if (!nav || !window.IS_MOBILE) return;
  // ΢��ʽ�ײ������������� 4 ������ Tab��΢�� / ͨѶ¼ / ���� / �ң�
  const CORE_TABS = ['friends', 'contacts', 'ai', 'downloads'];
  document.querySelectorAll('.sidebar-rail .side-tab').forEach(src => {
    if (!CORE_TABS.includes(src.dataset.side)) return;
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

// ����Ⱥ / ����Ⱥ
$('createGroupBtn').onclick = () => {
  openModal('����Ⱥ', [{ key: 'name', label: 'Ⱥ��' }], async (out, close) => {
    if (!out.name) { toast('Ⱥ������Ϊ��', 'warn', 1000); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ name: out.name, uids: [] })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '����ʧ��', 'error'); return; }
      if (data.group) {
        const g = data.group;
        if (!state.groups.some(x => Number(x.id) === Number(g.id))) state.groups.push(g);
      }
      renderContacts();
      toast('Ⱥ��' + (data.group && data.group.name) + '���Ѵ�����ID: ' + (data.group && data.group.id) + '��', 'success');
      // ǿ���е�Ⱥ�� tab
      const gtab = document.querySelector('.side-tab[data-side="groups"]');
      if (gtab) gtab.click();
    } catch (e) { toast('����ʧ�ܣ�' + e.message, 'error'); }
  });
};
$('joinGroupBtn').onclick = () => {
  openModal('����Ⱥ', [{ key: 'groupId', label: 'Ⱥ ID������Ⱥ�ɹ��󵯳������֣�', placeholder: 'ʾ����1' }], async (out, close) => {
    if (!out.groupId) { toast('ȺID����Ϊ��', 'warn', 1000); return; }
    close();
    try {
      const res = await fetch(state.serverHost + '/api/groups/' + parseInt(out.groupId, 10) + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ groupId: parseInt(out.groupId, 10) })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || '��Ⱥʧ��', 'error'); return; }
      loadFriends();
      toast('�Ѽ���Ⱥ', 'success');
      const gtab = document.querySelector('.side-tab[data-side="groups"]');
      if (gtab) gtab.click();
    } catch (e) { toast('����ʧ�ܣ�' + e.message, 'error'); }
  });
};

// ΢��ʽ�����Ⱥ��������������ѡ��ֱ����Ⱥ����������˵����
function openGroupInvitePicker() {
  if (!state.activeGroup) { toast('����ѡ��һ��Ⱥ', 'warn', 1000); return; }
  const mask = document.createElement('div'); mask.className = 'modal-mask';
  const box = document.createElement('div'); box.className = 'modal group-invite-modal';
  box.innerHTML = '<div class="modal-head"><h3>������ѽ�Ⱥ</h3><button class="modal-x" type="button">&times;</button></div>' +
    '<div class="group-invite-tip">ѡ����Ѻ�ֱ�Ӽ���Ⱥ�ģ�����Ҫ�Է����롣</div>' +
    '<input class="search group-invite-search" placeholder="���������ǳơ��û����� ID" />' +
    '<div class="group-invite-list"></div>' +
    '<label class="group-intro-label">����˵������ѡ��</label>' +
    '<textarea class="group-intro" maxlength="200" placeholder="����һ�����Ⱥ�����������Ϊʲô��������"></textarea>' +
    '<div class="modal-actions"><button type="button" class="cancel">ȡ��</button><button type="button" class="ok group-invite-submit">ֱ������</button></div>';
  mask.appendChild(box); document.body.appendChild(mask);
  const close = () => mask.remove();
  box.querySelector('.modal-x').onclick = close;
  box.querySelector('.cancel').onclick = close;
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  const list = box.querySelector('.group-invite-list');
  const search = box.querySelector('.group-invite-search');
  const selected = new Set();
  const render = () => {
    const kw = search.value.trim().toLowerCase();
    const rows = state.friends.filter(u => !kw || [u.nickname, u.username, u.uid, u.id].some(v => String(v || '').toLowerCase().includes(kw)));
    list.innerHTML = rows.length ? rows.map(u => '<label class="group-invite-user"><input type="checkbox" data-id="' + u.id + '"' + (selected.has(u.id) ? ' checked' : '') + '><span class="avatar">' + (u.avatar ? '<img src="' + escapeHtml(u.avatar) + '">' : escapeHtml(avatarChar(u.nickname))) + '</span><span class="group-invite-user-info"><b>' + escapeHtml(u.nickname || u.username) + '</b><small>ID: ' + escapeHtml(u.uid || u.id) + '</small></span></label>').join('') : '<div class="group-invite-empty">û��ƥ��ĺ���</div>';
    list.querySelectorAll('input').forEach(input => { input.onchange = () => input.checked ? selected.add(Number(input.dataset.id)) : selected.delete(Number(input.dataset.id)); });
  };
  search.oninput = render;
  render();
  box.querySelector('.group-invite-submit').onclick = async () => {
    if (!selected.size) { toast('����ѡ��һλ����', 'warn'); return; }
    const btn = box.querySelector('.group-invite-submit'); btn.disabled = true;
    try {
      const res = await fetch(state.serverHost + '/api/groups/' + state.activeGroup + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token }, body: JSON.stringify({ userIds: Array.from(selected), intro: box.querySelector('.group-intro').value.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      close(); await loadGroups(); toast('��ֱ������ ' + (data.count || 0) + ' λ���ѽ�Ⱥ', 'success');
    } catch (e) { btn.disabled = false; toast(e.message || '����ʧ��', 'error'); }
  };
}
$('inviteGroupBtn').onclick = openGroupInvitePicker;

// ͳһ��Ⱦ���� header��������ϵ��/Ⱥ���죩
function renderChatHeader() {
  if (state.activeGroup) {
    const g = state.groups.find(x => x.id === state.activeGroup);
    const name = g ? g.name : ('Ⱥ #' + state.activeGroup);
    $('chatHeader').textContent = 'Ⱥ�ģ�' + name;
    $('chatHeader').onclick = () => openGroupProfile(state.activeGroup);
    const mt = document.getElementById('chatMobileTitle');
    if (mt) { mt.textContent = 'Ⱥ�ģ�' + name; mt.onclick = () => openGroupProfile(state.activeGroup); }
    $('inviteBar').style.display = '';
    return;
  }
  if (state.activePeer) {
    const peer = state.friends.find(u => u.id === state.activePeer);
    const name = peer ? peer.nickname : '����';
    $('chatHeader').textContent = name;
    $('chatHeader').onclick = () => openPeerProfile(state.activePeer);
    const mt = document.getElementById('chatMobileTitle');
    if (mt) { mt.textContent = name; mt.onclick = () => openPeerProfile(state.activePeer); }
  } else {
    $('chatHeader').textContent = t('noConversation', '��ѡ����ϵ��');
    $('chatHeader').onclick = null;
  }
  $('inviteBar').style.display = 'none';
}

// �������Ͽ����������ͷ���򿪣�
function openPeerProfile(peerId) {
  const peer = state.friends.find(u => u.id === peerId);
  if (!peer) return;
  const blocked = blockedMap ? blockedMap.has(peer.id) : false;
  const mask = document.createElement('div');
  mask.className = 'profile-mask';
  const region = [peer.country, peer.province, peer.city].filter(Boolean).join(' ');
  mask.innerHTML = `
    <div class="profile-card">
      <div class="profile-head">
        <div class="profile-avatar">${peer.avatar ? '<img src="' + peer.avatar + '">' : avatarChar(peer.nickname)}</div>
        <div class="profile-name">${escapeHtml(peer.nickname || peer.username)}</div>
        <div class="profile-id">΢�źţ�${escapeHtml(peer.uid || '')} �� ID: ${peer.id}</div>
        <div class="profile-online">${peer.online ? '<span class="dot online"></span> ����' : '����'}</div>
        ${region ? '<div class="profile-region">������' + escapeHtml(region) + '</div>' : ''}
      </div>
      <div class="profile-actions">
        <button class="btn-cn" id="profileMsgBtn">����Ϣ</button>
        <button class="btn-cn gray" id="profileBlockBtn">${blocked ? '�������' : '����'}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelector('#profileMsgBtn').onclick = () => { mask.remove(); selectPeer(peer.id); };
  mask.querySelector('#profileBlockBtn').onclick = () => {
    toggleBlock(peer.id, () => {
      const bl = mask.querySelector('#profileBlockBtn');
      const nowBlocked = blockedMap ? blockedMap.has(peer.id) : false;
      if (bl) bl.textContent = nowBlocked ? '�������' : '����';
    });
  };
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
}

// Ⱥ���Ͽ������Ⱥ���򿪣�����/��Ա/�˳���
async function openGroupProfile(groupId) {
  const g = state.groups.find(x => x.id === groupId);
  if (!g) return;
  let members = [];
  let announcement = null;
  let isOwner = false;
  try {
    const res = await fetch(state.serverHost + '/api/groups/' + groupId, { headers: { 'Authorization': 'Bearer ' + state.token } });
    const data = await res.json();
    if (res.ok && data.group) {
      members = data.group.members || [];
      announcement = data.group.announcement || null;
      isOwner = !!data.group.isOwner;
    }
  } catch (e) {}
  const mask = document.createElement('div');
  mask.className = 'profile-mask';
  mask.innerHTML = `
    <div class="profile-card">
      <div class="profile-head">
        <div class="profile-avatar">${escapeHtml((g.name || 'Ⱥ').charAt(0))}</div>
        <div class="profile-name">${escapeHtml(g.name)}</div>
        <div class="profile-id">${members.length} ����Ա</div>
        ${announcement && announcement.content ? `<div class="profile-region" style="margin-top:6px;word-break:break-all">公告：${escapeHtml(String(announcement.content).slice(0, 200))}${String(announcement.content).length > 200 ? '…' : ''}${isOwner ? '<button class="ann-edit-btn" type="button">编辑</button>' : ''}</div>` : (isOwner ? '<div class="profile-region" style="margin-top:6px">暂无公告<button class="ann-edit-btn" type="button">发布公告</button></div>' : '')}
      </div>
      <div class="profile-members">
        ${members.length ? members.map(m => `<div class="profile-member" data-mid="${m.id}">
          <div class="avatar" style="width:34px;height:34px;border-radius:6px">${m.avatar ? '<img src="' + m.avatar + '">' : avatarChar(m.myNickname || m.nickname)}</div>
          <span>${escapeHtml(m.myNickname || m.nickname)}</span>${m.id === (g.ownerId) ? '<em style="color:#fa5151;font-style:normal;font-size:11px">Ⱥ��</em>' : ''}
        </div>`).join('') : '<div style="padding:12px;color:#aaa;font-size:13px">���޳�Ա</div>'}
      </div>
      <div class="profile-actions">
        <button class="btn-cn" id="groupInviteBtn">�����Ա</button>
        ${isOwner ? '<button class="btn-cn gray" id="groupDissolveBtn">��ɢȺ��</button>' : '<button class="btn-cn gray" id="groupLeaveBtn">�˳�Ⱥ��</button>'}
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelectorAll('.profile-member').forEach(el => {
    el.onclick = () => { mask.remove(); const mid = parseInt(el.dataset.mid); if (mid && state.friends.some(f => f.id === mid)) selectPeer(mid); };
  });
  const annEditBtn = mask.querySelector('.ann-edit-btn');
  if (annEditBtn) annEditBtn.onclick = async () => {
    const cur = announcement && announcement.content ? announcement.content : '';
    const content = prompt('编辑群公告（2000 字以内）：', cur);
    if (content == null) return;
    if (String(content).length > 2000) { toast('公告不能超过 2000 字', 'error'); return; }
    try {
      const res = await fetch(state.serverHost + '/api/groups/' + groupId + '/announcement', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ content: String(content).trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发布失败');
      toast('群公告已更新', 'success', 1200);
      mask.remove();
      openGroupProfile(groupId);
    } catch (e) { toast('发布失败：' + e.message, 'error'); }
  };
  mask.querySelector('#groupInviteBtn').onclick = () => { mask.remove(); const btn = $('inviteBtn'); if (btn) btn.click(); };
  const leaveBtn = mask.querySelector('#groupLeaveBtn');
  if (leaveBtn) leaveBtn.onclick = async () => {
    if (!confirm('ȷ���˳���Ⱥ�ģ�')) return;
    try {
      const res = await fetch(state.serverHost + '/api/groups/' + groupId + '/leave', { method: 'POST', headers: { 'Authorization': 'Bearer ' + state.token } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      mask.remove();
      toast('���˳�Ⱥ��', 'success', 1200);
      state.groups = state.groups.filter(x => x.id !== groupId);
      const cv = document.getElementById('chatView'); if (cv) cv.classList.remove('mobile-chat-active');
      state.activeGroup = null;
      renderChatHeader();
      renderContacts();
    } catch (e) { toast('�˳�ʧ�ܣ�' + e.message, 'error'); }
  };
  const dissolveBtn = mask.querySelector('#groupDissolveBtn');
  if (dissolveBtn) dissolveBtn.onclick = async () => {
    if (!confirm('ȷ����ɢ��Ⱥ�����г�Ա�����Ƴ������ɻָ���')) return;
    try {
      const res = await fetch(state.serverHost + '/api/groups/' + groupId + '/dissolve', { method: 'POST', headers: { 'Authorization': 'Bearer ' + state.token } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      mask.remove();
      toast('Ⱥ���ѽ�ɢ', 'success', 1200);
      state.groups = state.groups.filter(x => x.id !== groupId);
      const cv = document.getElementById('chatView'); if (cv) cv.classList.remove('mobile-chat-active');
      state.activeGroup = null;
      renderChatHeader();
      renderContacts();
    } catch (e) { toast('��ɢʧ�ܣ�' + e.message, 'error'); }
  };
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
}

// ѡ��Ⱥ + ����Ⱥ��ʷ
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
  showGroupAnnounceBanner();
  try {
    const res = await fetch(state.serverHost + '/api/groups/' + groupId + '/messages', {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    const data = await res.json();
    if (!res.ok) { $('messages').innerHTML = '<div style="color:#999;text-align:center">' + (data.error || '������ʷʧ��') + '</div>'; return; }
    state.groupMsgs[groupId] = data.messages || [];
    renderGroupMessages(data.messages || []);
  } catch (e) {
    $('messages').innerHTML = '<div style="color:#999;text-align:center">������ʷʧ��</div>';
  }
  // �ƶ��ˣ�ѡ��Ⱥ����л�������������������������ȫ��ҳ�����⵲ס�����
  if (window.IS_MOBILE) showMobileChatView();
  else { hideMobilePages(); setRailActive('friends'); setChatListVisible(true); }
}

// 群公告横幅（进入群聊时显示，可关闭，本地记录已读）
function showGroupAnnounceBanner() {
  const banner = $('groupAnnounceBanner');
  if (!banner) return;
  const g = state.groups.find(x => x.id === state.activeGroup);
  const ann = g && g.announcement;
  if (!state.activeGroup || !ann || !ann.content) { banner.style.display = 'none'; return; }
  const key = 'sc_ann_read_' + state.activeGroup + '_' + (ann.updatedAt || ann.createdAt || '');
  if (localStorage.getItem(key)) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  banner.textContent = '📢 ' + ann.content;
  banner.onclick = () => { banner.style.display = 'none'; try { localStorage.setItem(key, '1'); } catch (e) {} };
}

function renderGroupMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  msgs.forEach(m => appendGroupMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

// Ⱥ����Ϣ���ݣ����ǳƣ�
function appendGroupMessage(m, prepend) {
  // ͳһȥ�أ�ͬһ��Ⱥ��Ϣ������� id �� clientMsgId��ֻ��Ⱦһ��
  const box0 = $('messages');
  if (box0) {
    if (m.id != null && box0.querySelector('.msg-row[data-id="' + String(m.id).replace(/"/g, '\\"') + '"]')) return;
    if (m.clientMsgId) {
      const local = box0.querySelector('.msg-row[data-cmid="' + String(m.clientMsgId).replace(/"/g, '\\"') + '"]');
      if (local) { if (m.id != null) local.setAttribute('data-id', String(m.id)); return; }
    }
  }
  if (isMsgDeleted(m.id)) return;
  // Ⱥ���������������ݽṹ�������Ϸ������ǳ�/ͷ��
  if (typeof m.content === 'string' && m.content.startsWith(VOICE_PREFIX)) {
    const rest = m.content.slice(VOICE_PREFIX.length);
    const sep = rest.indexOf('|');
    const dur = parseFloat(rest.slice(0, sep)) || 0;
    const b64 = rest.slice(sep + 1);
    const box = $('messages');
    const mine = m.from === (state.me && state.me.id);
    const row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'me' : 'other');
    const fromName = (m.fromUser && m.fromUser.nickname) || ('�û�' + m.from);
    const avHtml = (m.fromUser && m.fromUser.avatar)
      ? '<img src="' + m.fromUser.avatar + '">'
      : avatarChar(fromName);
    const nameLine = mine ? '' : '<div class="name">' + escapeHtml(fromName) + '</div>';
    const bars = '<span class="voice-bars">' + Array.from({ length: 5 }, (_, i) => '<span style="height:' + (6 + i * 2) + 'px"></span>').join('') + '</span>';
    if (m.id != null) row.setAttribute('data-id', String(m.id));
    if (m.clientMsgId) row.setAttribute('data-cmid', String(m.clientMsgId));
    row.innerHTML = `<div class="avatar">${avHtml}</div>
      <div class="bubble-wrap">
        ${nameLine}
        <div class="bubble"><div class="voice-bubble">\u25B6${bars}<span class="vdur">${dur.toFixed(1)}"</span></div></div>
        <span class="time">${fmtTime(m.createdAt)}</span>
      </div>`;
    if (b64) {
      const vb = row.querySelector('.voice-bubble');
      vb._b64 = b64;
      vb.onclick = function () {
        const audio = new Audio('data:audio/webm;base64,' + this._b64);
        audio.play();
        const btn = this.querySelector('.play') || this;
        btn.textContent = '\u23F8';
        audio.onended = () => { btn.textContent = '\u25B6'; };
        audio.onerror = () => { toast('����ʧ��', 'error'); btn.textContent = '\u25B6'; };
      };
    }
    box.appendChild(row);
    if (!prepend) box.scrollTop = box.scrollHeight;
    return;
  }
  const box = $('messages');
  const mine = m.from === (state.me && state.me.id);
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'other');
  const fromName = (m.fromUser && m.fromUser.nickname) || ('�û�' + m.from);
  const avHtml = (m.fromUser && m.fromUser.avatar)
    ? '<img src="' + m.fromUser.avatar + '">'
    : avatarChar(fromName);
  const nameLine = mine ? '' : '<div class="name">' + escapeHtml(fromName) + '</div>';
  if (m.id != null) row.setAttribute('data-id', String(m.id));
  if (m.clientMsgId) row.setAttribute('data-cmid', String(m.clientMsgId));
  if (m.recalled) {
    row.innerHTML = `<div class="avatar">${avHtml}</div>
      <div class="bubble-wrap">
        ${nameLine}
        <div class="bubble recalled">${escapeHtml(fromName)}������һ����Ϣ</div>
      </div>`;
    box.appendChild(row);
    if (!prepend) box.scrollTop = box.scrollHeight;
    return;
  }
  const canGroupRecall = mine && m.createdAt && (Date.now() - m.createdAt) < 5 * 60 * 1000;
  if (typeof m.content === 'string' && m.content.startsWith('__FILE__')) {
    try {
      const file = JSON.parse(m.content.slice(8));
      if (file.id && file.name) {
        row.classList.add('has-file');
        appendFileMsg(mine, file.name, file.size, file.id, m.createdAt, file.mime, true);
        return;
      }
    } catch {}
  }
  row.innerHTML = `<div class="avatar">${avHtml}</div>
    <div class="bubble-wrap">
      ${nameLine}
      ${quoteBlockHtml(m)}
      ${m.forwardedFrom ? '<div class="fwd-tag">ת������Ϣ</div>' : ''}
      <div class="bubble">${escapeHtml(m.content)}</div>
      <span class="time">${fmtTime(m.createdAt)}</span>
      <div class="message-actions">${canGroupRecall ? '<button type="button" data-action="recall">����</button>' : ''}<button type="button" data-action="copy">����</button><button type="button" data-action="quote">����</button><button type="button" data-action="forward">ת��</button><button type="button" data-action="del">ɾ��</button></div>
    </div>`;
  if (canGroupRecall) {
    row.querySelector('[data-action="recall"]').onclick = () => recallGroupMessage(m.id);
  }
  row.querySelector('[data-action="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(String(m.content || '')); toast('�Ѹ���', 'success', 1200); }
    catch { toast('����ʧ�ܣ����ֶ�ѡ���ı�', 'warn', 1500); }
  };
  row.querySelector('[data-action="quote"]').onclick = () => {
    if (m.id == null) { toast('�޷����ø���Ϣ', 'warn', 1200); return; }
    setPendingReply(m.id);
    toast('��ѡ�����ã��������ݺ���', 'success', 1500);
  };
  const fwdBtnG = row.querySelector('[data-action="forward"]');
  if (fwdBtnG) fwdBtnG.onclick = () => { if (m.id == null) { toast('�޷�ת������Ϣ', 'warn', 1200); return; } openForwardPicker(m); };
  const delBtnG = row.querySelector('[data-action="del"]');
  if (delBtnG) delBtnG.onclick = () => { if (m.id == null) { toast('�޷�ɾ������Ϣ', 'warn', 1200); return; } if (confirm('ɾ��������Լ��ֻ�����ʧ��ȷ��ɾ����')) deleteMsgLocal(m.id); };
  bindQuoteClicks(row);
  bindMobileLongPress(row);
  box.appendChild(row);
  if (!prepend) box.scrollTop = box.scrollHeight;
}

async function recallGroupMessage(id) {
  if (!state.activeGroup || !confirm('ȷ������������Ϣ��')) return;
  try {
    const res = await fetch(state.serverHost + '/api/groups/' + state.activeGroup + '/messages/' + id + '/recall', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + state.token }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '����ʧ��');
    markGroupRecalled(id);
  } catch (e) {
    toast('����ʧ�ܣ�' + e.message, 'error');
  }
}
function markGroupRecalled(id) {
  const row = document.querySelector('#messages .msg-row[data-id="' + String(id).replace(/"/g, '\\"') + '"]');
  if (!row) return;
  const mine = row.classList.contains('me');
  const name = row.querySelector('.name');
  const fromName = name ? name.textContent : (mine ? '��' : '�Է�');
  row.innerHTML = '<div class="bubble recalled">' + escapeHtml(fromName) + '������һ����Ϣ</div>';
  const box = $('messages'); if (box) box.scrollTop = box.scrollHeight;
}
function onIncomingGroupMsg(payload) {
  state.groupLastMsg[payload.groupId] = payload.content || '[��Ϣ]';
  state.groupLastMsgTime[payload.groupId] = payload.createdAt || Date.now();
  if (state.activeGroup === payload.groupId) {
    appendGroupMessage(payload, false);
  } else {
   	state.groupUnread[payload.groupId] = (state.groupUnread[payload.groupId] || 0) + 1;
    const fromName = (payload.fromUser && payload.fromUser.nickname) || ('�û�' + payload.from);
    const g = state.groups.find(x => x.id === payload.groupId);
    const gname = g ? g.name : ('Ⱥ#' + payload.groupId);
    showMessageNotice({ from: payload.from, content: payload.content }, gname + ' ' + fromName);
    renderContacts();
  }
}

// Ⱥ������Ϣ��E2E ���ܣ����Ự�ѽ������ȼ����ٷ���ʧ���Զ��������ģ�
async function sendCurrentGroup() {
  if (!state.activeGroup) return false;
  const cv = document.getElementById('chatView');
  const isMobileChat = cv && cv.classList.contains('mobile-chat-active');
  const input = isMobileChat ? $('input') : (document.getElementById('desktopInput') || $('input'));
  const text = input.value.trim();
  if (!text) return true;
  const gid = state.activeGroup;
  // Ⱥ�Ĳ��ܸ��õ��ĵ� peer E2EE �Ự��groupId �����û���Կ ID��
  // ��ʹ��Ⱥ��ϢЭ�鷢�����ģ������Ⱥ ID �����û� ID ���·���ʧ�ܡ�
  const reply = pendingReply || null;
  const ok = send(P.C_GROUP_MSG, { groupId: gid, content: text, replyTo: reply });
  if (ok) {
    input.value = '';
    saveCurrentDraft();
    clearPendingReply();
    return true;
  }
  // WS �����ã��� REST ���ף��������֧�� POST /api/groups/:id/messages����
  try {
    const res = await fetch(state.serverHost + '/api/groups/' + gid + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ content: text, replyTo: reply })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '����ʧ��');
    input.value = '';
    saveCurrentDraft();
    clearPendingReply();
    return true;
  } catch (e) {
    toast('Ⱥ��Ϣ����ʧ�ܣ�' + ((e && e.message) || e), 'error');
    return false;
  }
}

async function loadGroups() {
  try {
    const res = await fetch(state.serverHost + '/api/groups/enhanced', {
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    if (!res.ok) return;
    const data = await res.json();
    // �Գ�Ա��ϵΪ׼����Ⱥû����ϢҲ���뱣���ڻỰ�б���
    state.groups = Array.isArray(data.groups) ? data.groups : [];
    renderContacts();
  } catch (e) {}
}


$('search').oninput = () => {
  const active = document.querySelector('.sidebar-rail .side-tab.on');
  if (active && active.dataset.side === 'contacts') renderContactsDirectory();
  else renderContacts();
};

// ============ �Ӻ��� ============
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
    if (!res.ok) { toast(data.error || '�Ӻ���ʧ��', 'error'); return; }
    $('addFriendInput').value = '';
    toast('�ѷ��ͺ������󣬵ȴ��Է�����', 'success');
  } catch (e) { toast('����ʧ�ܣ�' + e.message, 'error'); }
};

// ����������ʾ��
function showFriendReqBar() {
  const req = state.pendingReq[0];
  if (!req || !req.fromUser) { $('friendReqBar').style.display = 'none'; return; }
  $('friendReqText').textContent = req.fromUser.nickname + '��ID:' + req.fromUser.uid + '���������Ϊ����';
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
    toast('���ܺ�������ʧ�ܣ�' + e.message, 'error');
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
    toast('�ܾ���������ʧ�ܣ�' + e.message, 'error');
    showFriendReqBar();
    return;
  }
  showFriendReqBar();
};

// ============ ѡ����ϵ�� + ��ʷ ============
async function selectPeer(peerId) {
  state.activePeer = peerId;
  state.activeGroup = null;
  const annB = $('groupAnnounceBanner'); if (annB) annB.style.display = 'none';
  const welcome = $('welcomePanel'); if (welcome) welcome.style.display = 'none';
  state.unread[peerId] = 0;
  loadCallReplays(peerId);
  const peer = state.friends.find(u => u.id === peerId);
  $('chatHeader').textContent = peer ? peer.nickname : '����';
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
    // ��ʷ��Ϣ�������� E2EE ���ܣ���Ϊ 0x02 �����һỰ�ɽ�����
    for (const m of msgs) { try { await maybeDecryptLive(m); } catch (e) {} }
    renderMessages(msgs);
  } catch (e) {
    $('messages').innerHTML = '<div style="color:#999;text-align:center">������ʷʧ��</div>';
  }
  // �ƶ��ˣ�ѡ����ϵ�˺��л�������������������������ȫ��ҳ�����⵲ס�����
  if (window.IS_MOBILE) showMobileChatView();
  else { hideMobilePages(); setRailActive('friends'); setChatListVisible(true); }
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
  if (pin) { pin.classList.toggle('active', !!prefs.pinned[key]); pin.textContent = prefs.pinned[key] ? t('pinned','���ö�') : t('pin','�ö�'); }
  if (mute) { mute.classList.toggle('active', !!prefs.muted[key]); mute.textContent = prefs.muted[key] ? t('muted','�Ѿ���') : t('mute','�����'); }
}

function wireConversationTools() {
  const pin = $('pinChatBtn'); const mute = $('muteChatBtn'); const notify = $('notifyBtn');
  const clear = $('clearChatBtn');
  const searchBtn = $('messageSearchBtn'); const searchBar = $('messageSearchBar');
  const searchInput = $('messageSearchInput'); const searchClose = $('messageSearchClose');
  // �ƶ��˷��ذ�ť���ص��Ự�б�������յ�ǰ�Ựѡ��̬
  const backBtn = $('backToListBtn');
  if (backBtn) backBtn.onclick = () => {
    const cv = document.getElementById('chatView');
    if (cv) cv.classList.remove('mobile-chat-active');
    state.activePeer = null;
    state.activeGroup = null;
    setRailActive('friends');
    setChatListVisible(true);
    renderChatHeader();
    $('inviteBar').style.display = 'none';
    const welcome = $('welcomePanel'); if (welcome) welcome.style.display = '';
    renderContacts();
  };
  if (pin) pin.onclick = () => {
    const key = activeConversationKey(); if (!key) return toast('����ѡ��Ự', 'warn', 1200);
    const prefs = chatPrefs(); prefs.pinned[key] = !prefs.pinned[key]; saveChatPrefs(prefs); refreshConversationButtons(); renderContacts();
  };
  if (mute) mute.onclick = () => {
    const key = activeConversationKey(); if (!key) return toast('����ѡ��Ự', 'warn', 1200);
    const prefs = chatPrefs(); prefs.muted[key] = !prefs.muted[key]; saveChatPrefs(prefs); refreshConversationButtons(); renderContacts();
  };
  if (notify) notify.onclick = async () => {
    if (!('Notification' in window)) return toast('��ǰ�������֧��ϵͳ֪ͨ', 'warn', 1500);
    const permission = await Notification.requestPermission();
    notify.classList.toggle('active', permission === 'granted');
    notify.textContent = permission === 'granted' ? t('notifyOn','֪ͨ�ѿ�') : t('notify','֪ͨ');
    toast(permission === 'granted' ? '�����֪ͨ�ѿ���' : 'δ����֪ͨȨ��', permission === 'granted' ? 'success' : 'warn', 1500);
  };
  if (clear) clear.onclick = async () => {
    if (!state.activePeer) return toast('����ѡ����ϵ��', 'warn', 1200);
    if (!confirm('ȷ����յ�ǰ�����¼�𣿴˲������ɻָ���')) return;
    clear.disabled = true;
    try {
      const res = await fetch(state.serverHost + '/api/history/' + encodeURIComponent(String(state.activePeer)), {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + state.token }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '���ʧ��');
      $('messages').innerHTML = '';
      toast('��ǰ�����¼�����', 'success', 1500);
    } catch (e) { toast('���ʧ�ܣ�' + e.message, 'error'); }
    finally { clear.disabled = false; }
  };
  let searchHits = []; let searchIdx = -1;
  function applySearch() {
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    searchHits = [];
    searchIdx = -1;
    document.querySelectorAll('#messages .msg-row').forEach(row => {
      const hit = !!q && row.textContent.toLowerCase().includes(q);
      row.classList.toggle('search-hit', hit);
      row.classList.remove('search-current');
      if (hit) searchHits.push(row);
    });
    const cnt = $('messageSearchCount');
    if (cnt) cnt.textContent = q ? (searchHits.length ? '1/' + searchHits.length : '0/0') : '';
    if (searchHits.length) { searchIdx = 0; gotoSearchHit(); }
  }
  function gotoSearchHit() {
    if (!searchHits.length) return;
    if (searchIdx < 0) searchIdx = 0;
    if (searchIdx >= searchHits.length) searchIdx = searchHits.length - 1;
    searchHits.forEach(r => r.classList.remove('search-current'));
    const cur = searchHits[searchIdx];
    cur.classList.add('search-current');
    cur.scrollIntoView({ block: 'center' });
    const cnt = $('messageSearchCount');
    if (cnt) cnt.textContent = (searchIdx + 1) + '/' + searchHits.length;
  }
  const prevBtn = $('messageSearchPrev'); const nextBtn = $('messageSearchNext');
  if (prevBtn) prevBtn.onclick = () => { if (!searchHits.length) return; searchIdx = (searchIdx - 1 + searchHits.length) % searchHits.length; gotoSearchHit(); };
  if (nextBtn) nextBtn.onclick = () => { if (!searchHits.length) return; searchIdx = (searchIdx + 1) % searchHits.length; gotoSearchHit(); };
  if (searchBtn && searchBar) searchBtn.onclick = () => { searchBar.style.display = searchBar.style.display === 'none' ? 'flex' : 'none'; if (searchBar.style.display === 'flex') searchInput.focus(); };
  if (searchInput) searchInput.addEventListener('input', applySearch);
  if (searchClose && searchBar) searchClose.onclick = () => { searchBar.style.display = 'none'; if (searchInput) searchInput.value = ''; applySearch(); };
}

// ��ӭ����̨������
const welcomeAddBtn = $('welcomeAddBtn');
const welcomeGroupBtn = $('welcomeGroupBtn');
const welcomeAiBtn = $('welcomeAiBtn');
if (welcomeAddBtn) welcomeAddBtn.onclick = () => { const input = $('addFriendInput'); if (input) input.focus(); };
if (welcomeGroupBtn) welcomeGroupBtn.onclick = () => { const btn = $('createGroupBtn'); if (btn) btn.click(); };
if (welcomeAiBtn) welcomeAiBtn.onclick = () => {
  hideMobilePages();
  const main = document.querySelector('.main'); if (main) main.style.display = 'none';
  const dv = $('downloadView'); if (dv) dv.style.display = 'none';
  const av = $('aiView'); if (av) av.style.display = 'flex';
  const fs = $('friendsSide'); if (fs) fs.style.display = 'none';
  if (window.switchToAi) window.switchToAi();
};

function appendMessage(m, prepend) {
  // ͳһȥ�أ�ͬһ����Ϣ������� id �� clientMsgId��ֻ��Ⱦһ�Ρ�
  // �ֹ���Ⱦ���� id Ϊ 'local-<clientMsgId>'������˻��Ե���ʱ�� clientMsgId ����ͬһ�С�
  const box0 = $('messages');
  if (box0) {
    if (m.id != null && box0.querySelector('.msg-row[data-id="' + String(m.id).replace(/"/g, '\\"') + '"]')) return;
    if (m.clientMsgId) {
      const local = box0.querySelector('.msg-row[data-cmid="' + String(m.clientMsgId).replace(/"/g, '\\"') + '"]');
      if (local) {
        // ���б����ֹ��У����Ϸ���� id����������һ��
        if (m.id != null) local.setAttribute('data-id', String(m.id));
        return;
      }
    }
  }
  if (isMsgDeleted(m.id)) return;
  if (typeof m.content === 'string' && m.content.startsWith('__FILE__')) {
    try {
      const file = JSON.parse(m.content.slice(8));
      if (file.id && file.name) {
        appendFileMsg(m.from === state.me.id, file.name, file.size, file.id, m.createdAt, file.mime);
        return;
      }
    } catch {}
  }
  // ΢��ʽ���ڷָ���������ʱ����
  const mb = $('messages');
  if (mb && m.createdAt) {
    const mk = (d) => new Date(d).toDateString();
    const last = mb.lastElementChild;
    if (!last || !last.classList.contains('msg-row')) {
      // �׸���Ϣ���ϴ��Ƿָ������ж��Ƿ���Ҫ
      const prevDivider = mb.querySelector('.day-divider:last-of-type');
      const prevDay = prevDivider ? prevDivider.getAttribute('data-day') : null;
      if (!prevDay || prevDay !== mk(m.createdAt)) addDayDivider(m.createdAt);
    } else {
      const prevRow = last;
      const prevTime = prevRow.getAttribute('data-ts');
      if (prevTime && mk(Number(prevTime)) !== mk(m.createdAt)) addDayDivider(m.createdAt);
    }
  }
  const box = $('messages');
  const mine = m.from === state.me.id;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'me' : 'other');
  if (m.id != null) row.setAttribute('data-id', String(m.id));
  if (m.clientMsgId) row.setAttribute('data-cmid', String(m.clientMsgId));
  if (m.createdAt) row.setAttribute('data-ts', String(m.createdAt));
  const fullTime = new Date(m.createdAt).toLocaleString();
  if (m.recalled) {
    row.innerHTML = `<div class="bubble recalled">${mine ? '�㳷����һ����Ϣ' : '�Է�������һ����Ϣ'}</div>`;
    box.appendChild(row);
    if (!prepend) box.scrollTop = box.scrollHeight;
    return;
  }
  const canRecall = mine && m.createdAt && (Date.now() - m.createdAt) < 5 * 60 * 1000 && !m.recalled;
  row.innerHTML = `${quoteBlockHtml(m)}${m.forwardedFrom ? '<div class="fwd-tag">ת������Ϣ</div>' : ''}<div class="bubble">${escapeHtml(m.content)}</div><span class="time" title="${escapeHtml(fullTime)}">${fmtTime(m.createdAt)}</span>${mine ? '<span class="read-state' + (m.read ? ' read' : '') + '">' + (m.read ? '�Ѷ�' : 'δ��') + '</span>' : ''}<div class="message-actions">${canRecall ? '<button type="button" data-action="recall">����</button>' : ''}<button type="button" data-action="copy">����</button><button type="button" data-action="quote">����</button><button type="button" data-action="forward">ת��</button><button type="button" data-action="del">ɾ��</button></div>`;
  bindQuoteClicks(row);
  if (canRecall) {
    row.querySelector('[data-action="recall"]').onclick = () => recallMessage(m.id);
  }
  row.querySelector('[data-action="del"]').onclick = () => { if (m.id == null) { toast('�޷�ɾ������Ϣ', 'warn', 1200); return; } if (confirm('ɾ������ڱ�����ʧ��ȷ��ɾ����')) deleteMsgLocal(m.id); };
  row.querySelector('[data-action="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(String(m.content || '')); toast('�Ѹ���', 'success', 1200); }
    catch { toast('����ʧ�ܣ����ֶ�ѡ���ı�', 'warn', 1500); }
  };
  row.querySelector('[data-action="quote"]').onclick = () => {
    if (m.id == null) { toast('�޷����ø���Ϣ', 'warn', 1200); return; }
    setPendingReply(m.id);
    toast('��ѡ�����ã��������ݺ���', 'success', 1500);
  };
  const fwdBtn = row.querySelector('[data-action="forward"]');
  if (fwdBtn) fwdBtn.onclick = () => { if (m.id == null) { toast('�޷�ת������Ϣ', 'warn', 1200); return; } openForwardPicker(m); };
  bindQuoteClicks(row);
  bindMobileLongPress(row);
  box.appendChild(row);
  if (!prepend) box.scrollTop = box.scrollHeight;
}

// ============ ��Ϣ����ɾ���������ˣ� ============
function isMsgDeleted(id) {
  if (id == null) return false;
  try { const s = localStorage.getItem('deletedMsgIds'); if (!s) return false; return JSON.parse(s).indexOf(String(id)) !== -1; } catch (e) { return false; }
}
function deleteMsgLocal(id) {
  try {
    const s = localStorage.getItem('deletedMsgIds');
    const arr = s ? JSON.parse(s) : [];
    arr.push(String(id));
    localStorage.setItem('deletedMsgIds', JSON.stringify(arr));
  } catch (e) {}
  document.querySelectorAll('#messages .msg-row[data-id="' + String(id).replace(/"/g, '\\"') + '"]').forEach(el => el.remove());
  const box = $('messages'); if (box) box.scrollTop = box.scrollHeight;
}

// ============ ��Ϣת����΢��ʽ�� ============
function openForwardPicker(msg) {
  const mask = document.createElement('div');
  mask.className = 'profile-mask';
  const targets = [];
  state.friends.forEach(u => targets.push({ kind: 'user', id: u.id, name: u.nickname || u.username, avatar: u.avatar }));
  state.groups.forEach(g => targets.push({ kind: 'group', id: g.id, name: g.name, avatar: null }));
  if (!targets.length) { toast('���޺��ѻ�Ⱥ�Ŀ�ת��', 'warn', 1500); return; }
  mask.innerHTML = `
    <div class="profile-card">
      <div class="profile-head">
        <div class="profile-name" style="font-size:15px">ѡ��ת��Ŀ��</div>
        <div class="profile-id">${escapeHtml(String(msg.content || '').slice(0, 24))}</div>
      </div>
      <div class="profile-members">
        ${targets.map(t => `<div class="profile-member" data-k="${t.kind}" data-id="${t.id}">
          <div class="avatar" style="width:34px;height:34px;border-radius:6px">${t.avatar ? '<img src="' + t.avatar + '">' : avatarChar(t.name)}</div>
          <span>${escapeHtml(t.name)}</span>${t.kind === 'group' ? '<em style="color:#888;font-style:normal;font-size:11px">Ⱥ��</em>' : ''}
        </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelectorAll('.profile-member').forEach(el => {
    el.onclick = async () => {
      const kind = el.dataset.k;
      const id = parseInt(el.dataset.id);
      const content = String(msg.content || '');
      mask.remove();
      try {
        if (kind === 'group') {
          const res = await fetch(state.serverHost + '/api/groups/' + id + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
            body: JSON.stringify({ content, forwardedFrom: msg.id })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ת��ʧ��');
        } else {
          const res = await fetch(state.serverHost + '/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
            body: JSON.stringify({ to: id, content, forwardedFrom: msg.id })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ת��ʧ��');
        }
        toast('��ת��', 'success', 1200);
        if (state.activePeer === id || state.activeGroup === id) {
          if (state.activePeer === id) selectPeer(id);
          else selectGroup(id);
        }
      } catch (e) { toast('ת��ʧ�ܣ�' + e.message, 'error'); }
    };
  });
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
}
let pendingReply = null;
function setPendingReply(id) {
  pendingReply = id;
  renderReplyHint();
}
function clearPendingReply() {
  pendingReply = null;
  renderReplyHint();
}
function renderReplyHint() {
  const shown = !!pendingReply;
  ['chatMobileComposer', 'chatDesktopComposer'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    let hint = c.querySelector('.reply-hint');
    if (!shown) { if (hint) hint.remove(); return; }
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'reply-hint';
      hint.innerHTML = '<span class="reply-hint-text">��������һ����Ϣ</span><button type="button" class="reply-hint-cancel">ȡ��</button>';
      hint.querySelector('.reply-hint-cancel').onclick = () => clearPendingReply();
      const wrap = c.querySelector('.composer-input-wrap') || c;
      wrap.insertBefore(hint, wrap.firstChild);
    }
  });
}

function fmtTime(t) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

// ============ ����ѡ���� ============
const EMOJI_SET = ['??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','??','?','??','??','??','??','??','??','?','??','??','??','??','??','??','?','??','??','??','?','??','??','??','??','??','?','?','?','?'];
function toggleEmojiPanel() {
  const existing = document.getElementById('emojiPanel');
  if (existing) { existing.remove(); return; }
  const host = document.getElementById('chatMobileComposer') || document.getElementById('chatDesktopComposer');
  if (!host) return;
  const panel = document.createElement('div');
  panel.id = 'emojiPanel';
  panel.className = 'emoji-panel';
  panel.innerHTML = EMOJI_SET.map(e => '<span class="emoji-item">' + e + '</span>').join('');
  host.appendChild(panel);
  panel.querySelectorAll('.emoji-item').forEach(el => {
    el.onclick = () => {
      const cv = document.getElementById('chatView');
      const isMobileChat = cv && cv.classList.contains('mobile-chat-active');
      const input = isMobileChat ? document.getElementById('input') : (document.getElementById('desktopInput') || document.getElementById('input'));
      if (input) { input.value += el.textContent; input.focus(); }
      panel.remove();
    };
  });
  const close = (e) => { if (!panel.contains(e.target) && !e.target.closest('#emojiIconBtn')) panel.remove(); };
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}
(function () {
  const emojiBtn = document.getElementById('emojiIconBtn');
  if (emojiBtn) emojiBtn.onclick = toggleEmojiPanel;
})();

// ============ ����ѡ���� END ============

// ���ÿ飺��Ⱦ��������Ϣ��ԭ�ģ����������λ
function quoteBlockHtml(m) {
  if (!m.replyTo) return '';
  let text = m.replyContent;
  if (m.replyRecalled) text = '[��Ϣ�ѳ���]';
  if (text == null) {
    const el = document.querySelector('#messages .msg-row[data-id="' + String(m.replyTo).replace(/"/g, '\\"') + '"] .bubble');
    if (el) text = el.textContent;
  }
  if (text == null) return '';
  return '<div class="quote-block" data-reply="' + String(m.replyTo).replace(/"/g, '&quot;') + '" title="����鿴ԭ��">' + escapeHtml(String(text).replace(/\s+/g, ' ').slice(0, 80)) + '</div>';
}
function bindQuoteClicks(row) {
  row.querySelectorAll('.quote-block').forEach(qb => {
    qb.onclick = () => {
      const t = document.querySelector('.msg-row[data-id="' + qb.dataset.reply + '"]');
      if (t) t.scrollIntoView({ block: 'center' });
      else toast('ԭ�Ĳ��ڵ�ǰ���ط�Χ��', 'warn', 1200);
    };
  });
}
// �ƶ��˳�����Ϣ��ʾ���������� hover �����������
function bindMobileLongPress(row) {
  if (!window.IS_MOBILE) return;
  let timer = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  row.addEventListener('touchstart', () => { clear(); timer = setTimeout(() => { row.classList.add('show-actions'); }, 450); }, { passive: true });
  row.addEventListener('touchend', clear, { passive: true });
  row.addEventListener('touchmove', clear, { passive: true });
  row.addEventListener('touchcancel', clear, { passive: true });
}
if (window.IS_MOBILE) {
  document.addEventListener('touchstart', (e) => {
    if (e.target && e.target.closest && !e.target.closest('.msg-row')) {
      document.querySelectorAll('.msg-row.show-actions').forEach(r => r.classList.remove('show-actions'));
    }
  }, { passive: true });
}

// ============ Ⱥ�� @ ��Ա ============
let atPanel = null;
function showAtPanel(anchorInput) {
  if (!state.activeGroup) return;
  const g = state.groups.find(x => x.id === state.activeGroup);
  const members = (g && g.members) || [];
  if (!members.length) return;
  hideAtPanel();
  const list = members.map(id => {
    const u = state.friends.find(f => f.id === id);
    return { id, name: u ? (u.nickname || u.username) : ('�û�' + id) };
  });
  atPanel = document.createElement('div');
  atPanel.className = 'at-panel';
  atPanel.innerHTML = list.map(m => '<div class="at-item" data-id="' + m.id + '">' + escapeHtml(m.name) + '</div>').join('');
  const rect = anchorInput.getBoundingClientRect();
  atPanel.style.position = 'fixed';
  atPanel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  atPanel.style.left = Math.max(8, rect.left) + 'px';
  atPanel.style.maxHeight = '220px';
  atPanel.style.overflowY = 'auto';
  document.body.appendChild(atPanel);
  atPanel.querySelectorAll('.at-item').forEach(el => {
    el.onclick = () => {
      const name = el.textContent;
      const v = anchorInput.value;
      const idx = v.lastIndexOf('@');
      anchorInput.value = idx >= 0 ? v.slice(0, idx) + '@' + name + ' ' + v.slice(idx + 1) : v + '@' + name + ' ';
      anchorInput.focus();
      hideAtPanel();
    };
  });
}
function hideAtPanel() { if (atPanel) { atPanel.remove(); atPanel = null; } }
function onAtKey(input) {
  const v = input.value;
  if (!state.activeGroup || atPanel && !v.includes('@')) hideAtPanel();
  if (v.slice(-1) === '@' && state.activeGroup) showAtPanel(input);
}

// ============ ��Ϣ���� ============
async function recallMessage(msgId) {
  if (!msgId) return;
  try {
    const res = await fetch(state.serverHost + '/api/messages/' + msgId + '/recall', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + state.token }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '����ʧ��');
    markRecalled(msgId, true);
  } catch (e) {
    toast(((e && e.message) || '����ʧ��'), 'error');
  }
}
function markRecalled(msgId, mine) {
  const row = document.querySelector('.msg-row[data-id="' + String(msgId).replace(/"/g, '\\"') + '"]');
  if (!row) return;
  const bubbles = row.querySelectorAll('.bubble');
  bubbles.forEach(b => { b.textContent = mine ? '�㳷����һ����Ϣ' : '�Է�������һ����Ϣ'; b.classList.add('recalled'); });
  const actions = row.querySelector('.message-actions');
  if (actions) actions.style.display = 'none';
}
function markConversationRead() {
  document.querySelectorAll('#messages .msg-row.me .read-state').forEach(el => {
    el.textContent = '�Ѷ�';
    el.classList.add('read');
  });
}

// ΢��ʽ���ڷָ����İ�
function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.floor((today - day) / 86400000);
  if (diff === 0) return '����';
  if (diff === 1) return '����';
  if (diff === 2) return 'ǰ��';
  const w = ['����', '��һ', '�ܶ�', '����', '����', '����', '����'];
  if (diff < 7) return w[d.getDay()];
  return (d.getMonth() + 1) + '��' + d.getDate() + '��';
}
function addDayDivider(ts) {
  const box = $('messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.setAttribute('data-day', new Date(ts).toDateString());
  div.textContent = dayLabel(ts);
  box.appendChild(div);
}

function fmtChatListTime(t) {
  const d = new Date(Number(t));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.floor((today - day) / 86400000);
  if (diff === 0) return fmtTime(t);
  if (diff === 1) return '����';
  if (diff < 7) return ['����', '��һ', '�ܶ�', '����', '����', '����', '����'][d.getDay()];
  return (d.getMonth() + 1) + '/' + d.getDate();
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
  const text = String(m.content || '').startsWith('__FILE__') ? '�յ�һ���ļ�' : String(m.content || '').slice(0, 240);
  playMessageNoticeSound();
  const stack = $('messageNoticeStack');
  if (stack) {
    const item = document.createElement('div'); item.className = 'message-notice';
    item.innerHTML = '<strong>' + escapeHtml(name || '����Ϣ') + '</strong><span>' + escapeHtml(text || '�յ�����Ϣ') + '</span>';
    item.onclick = () => { if (state.activePeer !== m.from) selectPeer(m.from); item.remove(); };
    stack.appendChild(item); setTimeout(() => item.remove(), 6500);
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(name || '����Ϣ', { body: text || '�յ�����Ϣ', tag: 'securechat-' + m.from }); } catch {}
  }
  if (window.chatAPI) window.chatAPI.notify(name + ' ������Ϣ', text);
}

// ============ ����Ϣ ============
// ʵʱ�ذ������������˷��� 0x02 ˫�������ģ����� E2E �����ٽ���չʾ�߼���
async function maybeDecryptLive(m) {
  if (!m || typeof m.content !== 'string') return;
  if (m.from === state.me.id) return; // �Լ����ģ��������� sentPlain �滻�����ظ�����
  if (!window.SCE2EE || !SCE2EE.isRatchetCipher(m.content)) return;
  try {
    const plain = await SCE2EE.decryptFrom(m.from, m.content);
    if (typeof plain === 'string' && plain !== m.content) {
      m.content = plain;
    }
  } catch {}
}
async function onIncomingMsg(m) {
  // ����ģʽ�������� E2EE ���ܣ�ֱ����ʾԭ�ġ�
  if (m.from === state.me.id && m.clientMsgId && state.sentPlain[m.clientMsgId]) {
    m.content = state.sentPlain[m.clientMsgId];
    delete state.sentPlain[m.clientMsgId];
  }
  if (m.from === state.me.id && m.clientMsgId && state.pendingLocal[m.clientMsgId]) {
    delete state.pendingLocal[m.clientMsgId];
    // ���ֹ���Ⱦ������������� id��appendMessage �ڲ��� data-cmid ���в��������������
    appendMessage(m);
    state.lastFrom[m.from] = m.content;
    state.lastMsgTime[m.from] = m.createdAt || Date.now();
    renderContacts();
    return;
  }
  // ����˻���Է������Լ�����Ϣ���Լ�����ϢҲ������Ⱦ����ǰ�Ự��
  if (m.from === state.me.id || state.activePeer === m.from) {
    appendMessage(m);
    if (m.from !== state.me.id) send(P.C_READ, { from: m.from });
  } else {
    state.unread[m.from] = (state.unread[m.from] || 0) + 1;
    const fromUser = state.friends.find(u => u.id === m.from);
    const name = fromUser ? fromUser.nickname : '����Ϣ';
    showMessageNotice(m, name);
  }
  state.lastFrom[m.from] = m.content;
  state.lastMsgTime[m.from] = m.createdAt || Date.now();
  renderContacts();
}

// ============ ���� ============
// E2E ���ܸ������� SCE2EE ��������ܣ�ʧ�ܽ�������
async function _e2eeSendContent(peerId, text) {
  if (!peerId || !text) return text;
  if (window.SCE2EE) {
    try { const e = window.SCE2EE.encryptFor(peerId, text); if (e && typeof e.then === 'function') return await e; return e || text; } catch {}
  }
  return text;
}
function sendCurrent() {
  if (state.activeGroup) { sendCurrentGroup(); return; }
  const cv = document.getElementById('chatView');
  const isMobileChat = cv && cv.classList.contains('mobile-chat-active');
  const input = isMobileChat ? $('input') : (document.getElementById('desktopInput') || $('input'));
  const text = input.value.trim();
  if (!text || !state.activePeer) return;
  const clientMsgId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const peerId = state.activePeer;
  state.pendingLocal[clientMsgId] = true;
  input.value = '';
  saveCurrentDraft();
  // UI ��չʾ���ģ�ʵ�ʴ洢�߼�������
  const localCreatedAt = Date.now();
  state.lastFrom[peerId] = text;
  state.lastMsgTime[peerId] = localCreatedAt;
  appendMessage({ id: 'local-' + clientMsgId, from: state.me.id, to: peerId, content: text, createdAt: localCreatedAt, clientMsgId }, false);
  _e2eeSendContent(peerId, text).then(async (ct) => {
    const payload = { to: peerId, content: ct || text, clientMsgId };
    fetch(state.serverHost + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      delete state.pendingLocal[clientMsgId];
    }).catch((e) => toast('��Ϣ����ʧ�ܣ�' + e.message, 'error'));
  }).catch(() => {
    // ����ʧ�ܽ�������
    const payload = { to: peerId, content: text, clientMsgId };
    fetch(state.serverHost + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      delete state.pendingLocal[clientMsgId];
    }).catch((e) => toast('��Ϣ����ʧ�ܣ�' + e.message, 'error'));
  });
}

$('sendBtn').type = 'button';
$('sendBtn').onclick = (event) => { event.preventDefault(); sendCurrent(); };
// ����˷��Ͱ�ť
const desktopSendBtnEl = document.getElementById('desktopSendBtn');
if (desktopSendBtnEl) { desktopSendBtnEl.type = 'button'; desktopSendBtnEl.onclick = (event) => { event.preventDefault(); sendCurrent(); }; }
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
const desktopInput = document.getElementById('desktopInput');
if (desktopInput) desktopInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
let typingSent = 0;
$('input').addEventListener('input', () => {
  saveCurrentDraft();
  onAtKey($('input'));
  if (!state.activePeer) return;
  const now = Date.now();
  if (now - typingSent > 2000) { send(P.C_TYPING, { to: state.activePeer }); typingSent = now; }
});
if (desktopInput) desktopInput.addEventListener('input', () => {
  saveCurrentDraft();
  onAtKey(desktopInput);
  if (!state.activePeer) return;
  const now = Date.now();
  if (now - typingSent > 2000) { send(P.C_TYPING, { to: state.activePeer }); typingSent = now; }
});

// ���������л�����Ӱ���˺ź���������
const themeToggle = $('themeToggle');
const savedTheme = localStorage.getItem('sc_theme');
if (savedTheme === 'dark') document.body.classList.add('dark-mode');
if (themeToggle) themeToggle.onclick = () => {
  const dark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('sc_theme', dark ? 'dark' : 'light');
  themeToggle.textContent = dark ? t('light', '��') : t('dark', 'ҹ');
};
if (themeToggle && savedTheme === 'dark') themeToggle.textContent = t('light', '��');

// ============ �����л����� ============
// ���������ײ� localeToggle ��������ѡ��˵���ѡ��󽻸� SCI18N.setLocale��
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
  // ��λ���� CSS��.locale-menu fixed ��λ����Ļ���¡�rail �ײ��Ϸ�����
  // �ؼ����� .open class �Ż�� display:none ��Ϊ flex���˵��ſɼ���
  menu.classList.add('open');
  document.body.appendChild(menu);
  localeMenu = menu;
  document.addEventListener('keydown', onLocaleMenuEsc, true);
}
if (localeToggle) localeToggle.onclick = (e) => { e.stopPropagation(); openLocaleMenu(); };
// ���������ر�
document.addEventListener('click', (e) => {
  if (!localeMenu) return;
  if (localeMenu.contains(e.target) || e.target === localeToggle) return;
  closeLocaleMenu();
});
// �л����Ժ�������Ⱦ�˻��� / ���·��뾲̬ DOM / ͬ�����ⰴť�İ�
document.addEventListener('sc-locale-change', () => {
  if (state.me) renderMyInfo();
  // ˢ�� chatHeader ��̬�İ����硰��ѡ����ϵ�ˡ���
  if (!state.activePeer && !state.activeGroup && $('chatHeader')) $('chatHeader').textContent = t('noConversation', '��ѡ����ϵ��');
  if (window.SCI18N && typeof SCI18N.apply === 'function') SCI18N.apply();
  if (themeToggle) themeToggle.textContent = document.body.classList.contains('dark-mode') ? t('light', '��') : t('dark', 'ҹ');
});

window.addEventListener('focus', () => { if (window.chatAPI) window.chatAPI.stopFlash(); });

// ============ ���� ============
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
  }[c]));
}

// ============ WebRTC���ļ� / ���� / ��Ƶ ============
let rtc, callPeer = null, callKind = null, incomingCall = null, localStream = null;
let pendingRemoteStream = null;
let callRecorder = null, callRecordChunks = [], callRecordStartedAt = 0;
let callRecordings = [];

function renderCallReplays() {
  const box = $('callReplayList');
  if (!box) return;
  if (!callRecordings.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = '<strong>ͨ���ط�</strong>' + callRecordings.map((r, i) => '<div class="call-replay"><span>' + escapeHtml(r.kind === 'video' ? '��Ƶ' : '����') + ' ' + new Date(r.createdAt).toLocaleString() + '</span><a href="' + r.url + '" target="_blank">����/����</a></div>').join('');
}
async function loadCallReplays(peerId) {
  try {
    const res = await fetch(state.serverHost + '/api/call-recordings?peer=' + encodeURIComponent(peerId), { headers: { 'Authorization': 'Bearer ' + state.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '���ػط�ʧ��');
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
        .catch((e) => toast('�ط��ϴ�ʧ�ܣ�' + e.message, 'error'));
      callRecorder = null; callRecordChunks = [];
    };
    callRecorder.start(1000);
  } catch (e) { callRecorder = null; }
}
function stopCallRecording() {
  if (callRecorder && callRecorder.state !== 'inactive') callRecorder.stop();
}

// ͨ����ʱ/�ָ�/Զ�˻�����ʾ�����㺯������ initRtc �¼���ͨ����ť���ã�
let callTimer = null;
function clearCallTimer() { if (callTimer) { clearTimeout(callTimer); callTimer = null; } }
function startCallTimer() {
  // �����м�ʱ�����ѽ�ͨ���ظ�
  if (callTimer) return;
  callTimer = setTimeout(() => {
    callTimer = null;
    // 8 �����δ�ָ���ر�ͨ��
    closeCallBar();
    toast('���������жϣ�ͨ���ѽ���', 'warn');
  }, 8000);
}
function startCallTimeout() {
  clearCallTimer();
  callTimer = setTimeout(() => {
    callTimer = null;
    if (callPeer && !incomingCall) {
      toast('�Է�����Ӧ��ͨ����ʱ', 'warn');
      closeCallBar();
      if (rtc && callPeer) rtc.hangup(callPeer);
    }
  }, 30000);
}
function maybeShowRemote(peerId) {
  // ��ʾ���򣺱�����"��ͨ"����incomingCall=null���ѽ�����������״̬���ɣ�
  // �ҵ�ǰ callPeer = �� peer������������������"����"�������Է�һ���Ͼ���ʾ
  if (!pendingRemoteStream) return;
  if (!callPeer) return;
  // ��������incomingCall һֱΪ null ������ʾ
  // ������������ incomingCall=null���� acceptIncomingCall ��գ�
  if (incomingCall) return; // ���ڴ�����
  const v = $('remoteVideo');
  if (!v) return;
  v.srcObject = pendingRemoteStream;
  v.style.display = '';
  // WebView Ĭ�Ͻ�ֹ�������Զ����ţ�������ʽ play()�������ͨ������/�޻���
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
    // δ����ʱ�ݴ棬���ҵ� UI
    pendingRemoteStream = e.detail.stream;
    startCallRecording(e.detail.stream);
    maybeShowRemote(e.detail.peerId);
  });
  window.addEventListener('rtc-state', (e) => {
    if (e.detail.state === 'connected') { clearCallTimer(); stopCallDuration(); maybeShowRemote(e.detail.peerId); }
    if (e.detail.state === 'failed') {
      clearCallTimer(); stopCallDuration();
      toast('ͨ������ʧ�ܣ���ȷ��˫������ɻ�ͨ��NAT/����ǽ���ƣ�', 'error', 3000);
      closeCallBar();
      if (rtc && callPeer) rtc.hangup(callPeer);
    }
    if (e.detail.state === 'closed') { clearCallTimer(); stopCallDuration(); closeCallBar(); }
    // disconnected���������رգ��ȴ��ָ������� 8s �� disconnected ��ʧ�ܴ���
    if (e.detail.state === 'disconnected') startCallTimer();
  });
  window.addEventListener('call-incoming', (e) => {
    clearCallTimer();
    startCallRingtone();
    incomingCall = { from: e.detail.from, kind: e.detail.kind };
    $('callText').textContent = (e.detail.kind === 'video' ? '��Ƶ' : '����') + '���磨�����û� ' + e.detail.from + '��';
    $('acceptCallBtn').style.display = ''; $('rejectCallBtn').style.display = ''; $('hangupBtn').style.display = 'none';
    $('callBar').classList.remove('with-video'); $('callBar').style.display = 'flex';
    callTimer = setTimeout(() => {
      if (incomingCall) rejectIncomingCall();
    }, 30000);
  });
  window.addEventListener('call-rejected', () => { stopCallRingtone(); toast('�Է��Ѿܾ�', 'warn'); closeCallBar(); });
  window.addEventListener('peer-offline', () => { stopCallRingtone(); toast('�Է�������', 'warn'); closeCallBar(); });
  window.addEventListener('remote-hangup', () => { stopCallRingtone(); toast('�Է��ѹҶ�', 'info'); closeCallBar(); });
  window.addEventListener('file-start', (e) => { $('fileBar').style.display = ''; $('fileText').textContent = '���գ�' + e.detail.name + ' (' + humanSize(e.detail.size) + ')'; setProgress(0); });
  window.addEventListener('file-progress', (e) => setProgress(e.detail.received / e.detail.size));
  window.addEventListener('file-done', (e) => {
    $('fileText').textContent = '�ѽ��գ�' + e.detail.name; setProgress(1);
    appendFileMsg(true, e.detail.name, e.detail.size, e.detail.url);
    setTimeout(() => $('fileBar').style.display = 'none', 4000);
  });
}

async function loadMiniPrograms() {
  const list = $('miniProgramList');
  if (!list || !state.token) return;
  try {
    const res = await fetch(state.serverHost + '/api/mini-programs', { headers: { Authorization: 'Bearer ' + state.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '����ʧ��');
    list.innerHTML = '';
    (data.programs || []).forEach((program) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'mini-program-item';
      item.innerHTML = '<strong>' + escapeHtml(program.name) + '</strong><span>v' + escapeHtml(program.version) + '</span>';
      item.onclick = () => {
        if (!String(program.entry).startsWith('/mini-programs/')) return toast('С������ڲ�������', 'error');
        window.open(state.serverHost + program.entry, '_blank', 'noopener');
      };
      list.appendChild(item);
    });
  } catch (e) { list.textContent = 'С�����ݲ�����'; }
}
function setProgress(r) { $('fileProgress').style.width = Math.round(r * 100) + '%'; }
function humanSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(1)+' KB'; if (b < 1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; }

// ͨ��ʱ����ʱ����ͨ����ʾ ͨ���� MM:SS��
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
    $('callText').textContent = 'ͨ���� ' + mm + ':' + ss;
  }, 1000);
}
function stopCallDuration() {
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
}

// �ͷű���ý���豸��ÿ�η���/����/�Ҷ�ǰ���ã���ֹ"Device in use"��
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
  if (!state.activePeer) return toast('����ѡ����ϵ��', 'warn');
  // ������ͨ�����豸��ռ�ã��ȳ����ͷ�
  releaseLocalMedia();
  if (rtc && callPeer) rtc.hangup(callPeer);
  callPeer = state.activePeer; callKind = kind;
  send(P.C_SIGNAL, { to: callPeer, sub: 'call', data: { kind } });
  $('callText').textContent = '���ں���(' + (kind==='video'?'��Ƶ':'����') + ')...';
  $('acceptCallBtn').style.display='none'; $('rejectCallBtn').style.display='none'; $('hangupBtn').style.display='';
  $('callBar').style.display = 'flex';
  if (!window.getLocalStream) return toast('WebRTC ������', 'error');
  window.getLocalStream(kind).then((s) => {
    localStream = s;
    const v = $('localVideo'); if (v && kind==='video') v.srcObject = s;
    rtc.startCall(callPeer, kind, s);
    startCallTimeout();
  }).catch((e) => { toast('�޷���ȡý�壺'+e.message, 'error'); closeCallBar(); });
}
async function acceptIncomingCall() {
  if (!incomingCall) {
    toast('û��������������磬���öԷ����²���', 'warn', 3000);
    return;
  }
  stopCallRingtone();
  clearCallTimer();
  const pendingCall = incomingCall;
  callPeer = pendingCall.from; callKind = pendingCall.kind;
  $('callText').textContent = 'ͨ����...';
  $('acceptCallBtn').style.display='none'; $('rejectCallBtn').style.display='none'; $('hangupBtn').style.display='';
  try {
    if (!window.getLocalStream) throw new Error('WebRTC ������');
    $('callText').textContent = '����������˷�/����ͷȨ��...';
    const mediaTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('�����Ȩ������ʱ������������ͷ����˷�Ȩ�޺�����')), 12000));
    localStream = await Promise.race([window.getLocalStream(callKind), mediaTimeout]);
    incomingCall = null;
    const v=$('localVideo'); if (v && callKind==='video') v.srcObject=localStream;
    await rtc.acceptCall(callPeer, callKind, localStream);
    startCallTimeout();
  } catch (e) {
    incomingCall = pendingCall;
    const code = e && e.code;
    const isPerm = code === 'PERMISSION' || code === 'NOT_SUPPORTED' || /NotAllowed|Permission|denied|�ܾ�|��ȫ/i.test(String(e && e.message || e && e.name || ''));
    $('callText').textContent = isPerm ? '��Ҫ����ͷ/��˷�Ȩ�޲��ܽ���' : '����ʧ�ܣ�������';
    $('acceptCallBtn').style.display=''; $('rejectCallBtn').style.display=''; $('hangupBtn').style.display='none';
    toast((isPerm ? 'δ��Ȩý��Ȩ�ޣ������������ַ����� ?? �� ��վ���� �� ����"����ͷ/��˷�"��Ȼ�����½���' : '�޷���ȡý�壺') + (e.message || e.name || ''), 'error', 5000);
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
  if (!state.activePeer && !state.activeGroup) return toast('����ѡ����ϵ��', 'warn');
  const inp = document.createElement('input'); inp.type='file'; inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    $('fileBar').style.display=''; $('fileText').textContent='���ͣ�'+f.name+' ('+humanSize(f.size)+')'; setProgress(0);
    const upload = state.activeGroup
      ? fetch(state.serverHost + '/api/groups/' + state.activeGroup + '/files?name=' + encodeURIComponent(f.name) + '&mime=' + encodeURIComponent(f.type || 'application/octet-stream'), {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + state.token }
        })
      : fetch(state.serverHost + '/api/files?to=' + encodeURIComponent(state.activePeer) + '&name=' + encodeURIComponent(f.name) + '&mime=' + encodeURIComponent(f.type || 'application/octet-stream'), {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + state.token }
        });
    upload.then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '�ϴ�ʧ��');
      const meta = '__FILE__' + JSON.stringify({ id: data.id, name: data.name, size: data.size, mime: data.mime });
      const cmid = 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      if (state.activeGroup) send(P.C_GROUP_MSG, { groupId: state.activeGroup, content: meta, clientMsgId: cmid });
      else send(P.C_MSG, { to: state.activePeer, content: meta, clientMsgId: cmid });
      $('fileText').textContent='�ѷ��ͣ�'+f.name; setProgress(1);
      setTimeout(()=>$('fileBar').style.display='none',3000);
    }).catch((e)=>{ $('fileText').textContent='����ʧ�ܣ�'+e.message; toast('�ļ�����ʧ�ܣ�' + e.message, 'error'); });
  }; inp.click();
};
function appendFileMsg(mine, name, size, fileId, createdAt, mime, isGroup) {
  const fUrl = (id) => state.serverHost + (isGroup ? '/api/group-files/' : '/api/files/') + encodeURIComponent(id);
  const box=$('messages'); const row=document.createElement('div'); row.className='msg-row '+(mine?'me':'other');
  const isImage = mime && String(mime).startsWith('image/');
  if (isImage) {
    row.innerHTML='<div class="bubble"><div class="file-msg"><div class="ficon">ͼ</div><div><div class="fname">'+escapeHtml(name)+'</div><div class="fsize">'+humanSize(size)+'</div></div></div><div class="file-image-wrap"><img class="file-image" data-fid="'+String(fileId)+'" alt="���Ԥ��" loading="lazy"></div></div><span class="time">'+fmtTime(createdAt || Date.now())+'</span>';
    const img = row.querySelector('.file-image');
    fetch(fUrl(fileId), { headers: { 'Authorization': 'Bearer ' + state.token } })
      .then(r => { if (!r.ok) throw new Error('����ʧ��'); return r.blob(); })
      .then(b => { img.src = URL.createObjectURL(b); })
      .catch(() => { img.alt = '����ʧ��'; });
    img.onclick = () => openImagePreview(img.src, name, fileId, isGroup);
  } else {
    row.innerHTML='<div class="bubble"><div class="file-msg"><div class="ficon">��</div><div><div class="fname">'+escapeHtml(name)+'</div><div class="fsize">'+humanSize(size)+'</div></div>'+(fileId?'<button class="fsize file-download" type="button">����</button>':'')+'</div></div><span class="time">'+fmtTime(createdAt || Date.now())+'</span>';
    const download = row.querySelector('.file-download');
    if (download) download.onclick = async () => {
      download.disabled = true;
      try {
        const res = await fetch(fUrl(fileId), { headers: { 'Authorization': 'Bearer ' + state.token } });
        if (!res.ok) throw new Error('����ʧ��');
        const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) { toast(e.message, 'error'); } finally { download.disabled = false; }
    };
  }
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}
// ͼƬȫ��Ԥ����΢��ʽ����������ֹرգ��ײ��ṩ����
function openImagePreview(src, name, fileId, isGroup) {
  if (!src) { toast('ͼƬ��δ�������', 'warn', 1200); return; }
  const mask = document.createElement('div');
  mask.className = 'img-preview-mask';
  mask.innerHTML = '<img class="img-preview-img" src="' + src + '" alt="' + escapeHtml(name) + '"><div class="img-preview-bar"><span>' + escapeHtml(name) + '</span><button type="button" class="img-preview-dl">����</button></div>';
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
  const dl = mask.querySelector('.img-preview-dl');
  if (dl) dl.onclick = async (e) => {
    e.stopPropagation();
    dl.disabled = true;
    try {
      const res = await fetch(state.serverHost + (isGroup ? '/api/group-files/' : '/api/files/') + encodeURIComponent(fileId), { headers: { 'Authorization': 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('����ʧ��');
      const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('�ѿ�ʼ����', 'success', 1200);
    } catch (e) { toast(e.message, 'error'); } finally { dl.disabled = false; }
  };
  document.body.appendChild(mask);
}
$('audioBtn').onclick = () => startOutgoingCall('audio');
$('videoBtn').onclick = () => startOutgoingCall('video');
$('acceptCallBtn').addEventListener('click', (event) => {
  event.preventDefault();
  acceptIncomingCall();
});
$('rejectCallBtn').addEventListener('click', (event) => {
  event.preventDefault();
  rejectIncomingCall();
});
$('hangupBtn').addEventListener('click', (event) => {
  event.preventDefault();
  hangup();
});
initRtc();

// ============ ������Ϣ����һ�¿�ʼ¼�����ٵ�һ�·��ͣ� ============
let recState = null; // { mediaRec, stream, chunks, startTime, timer, canceled, el }
const VOICE_PREFIX = '__VOICE__';

async function startVoiceRec() {
  if (recState) return;
  if (!state.activePeer) { toast('����ѡ����ϵ��', 'warn'); return; }
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
      if (elapsed < 1) { toast('����̫��', 'warn', 1000); return; }
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 500 * 1024) { toast('������������60�룩', 'warn'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const b64 = dataUrl.split(',')[1];
        const body = VOICE_PREFIX + elapsed.toFixed(1) + '|' + b64;
        const clientMsgId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        send(P.C_MSG, { to: state.activePeer, content: body, clientMsgId });
        // �Լ�Ҳ�� b64������㲥������
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
      // ���� 60 ���Զ���
      if (s >= 60) stopVoiceRec();
    }, 100);
  } catch (e) {
    toast('�޷�������˷�: ' + e.message, 'error');
  }
}

function stopVoiceRec(cancel) {
  if (!recState) return;
  if (cancel) recState.canceled = true;
  if (recState.timer) clearInterval(recState.timer);
  try { recState.mediaRec.stop(); } catch {}
  $('recBar').style.display = 'none';
  $('voiceTip').style.display = 'none';
  // ��λ������ť����
  const btn = $('voiceBtn');
  if (btn) { btn.classList.remove('recording'); btn.textContent = t('voice','����'); }
  document.dispatchEvent(new Event('recrecstate'));
}

// ���������ť = ��ʼ¼�����ٵ�� = ����
(function bindVoiceButton() {
  const btn = $('voiceBtn');
  btn.addEventListener('click', () => {
    if (recState) {
      stopVoiceRec(false); // �ٵ�һ�� = ����
    } else {
      startVoiceRec();
    }
  });
})();

// ���������ת���֣�ʹ�� Web Speech API��ʶ����д����ͨ��Ϣ�����
// Chrome / Edge ֧�ֽϺã���֧��ʱ����������ʾ����Ӱ��������Ϣ���ܡ�
(function bindSpeechToText() {
  const btn = $('speechBtn');
  if (!btn) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    btn.title = '��ǰ�������֧������ת����';
    btn.onclick = () => toast('��ǰ�������֧������ת���֣���ʹ�����°� Chrome �� Edge', 'warn', 2200);
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
    btn.textContent = 'ֹͣתд';
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
        const msg = ev.error === 'not-allowed' ? '��˷�Ȩ�ޱ��ܾ��������������ַ��������˷�Ȩ��' : '����ת����ʧ�ܣ�' + ev.error;
        toast(msg, 'warn', 2400);
      }
    };
    recognition.onend = () => {
      active = false;
      btn.classList.remove('transcribing');
      btn.textContent = t('transcribe','ת����');
      saveCurrentDraft();
    };
    try { recognition.start(); toast('��ʼ����ת���֣��ٴε����ֹͣ', 'info', 1400); }
    catch { active = false; btn.classList.remove('transcribing'); btn.textContent = t('transcribe','ת����'); }
  };
})();

// ����/�յ���������
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
      audio.onerror = () => { toast('����ʧ��', 'error'); btn.textContent = orig; };
    };
  }
}

// �� onIncomingMsg / renderMessages ��ʶ�����⴦�� voice
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
      if (window.chatAPI) window.chatAPI.notify((fromUser ? fromUser.nickname : '����Ϣ') + ' ��������', '');
    }
    state.lastFrom[m.from] = '[����]';
    renderContacts();
    return;
  }
  _orig_onIncomingMsg(m);
};

// ��ʷ��ʶ��������Ϣ��ʽ��B����ʾ���� b64 ���ܲ�����ʾʱ����
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

// ============ ΢��ʽ�ƶ���ҳ�浼�� ============
function showMobileChatView() {
  const chatView = document.getElementById('chatView');
  if (!chatView) return;
  chatView.classList.add('mobile-chat-active');
  hideMobilePages();
  const chatHeader = document.getElementById('chatMobileHeader');
  if (chatHeader) chatHeader.style.display = 'flex';
  const chatComposer = document.getElementById('chatMobileComposer');
  if (chatComposer) chatComposer.style.display = 'flex';
  const desktopComposer = document.getElementById('chatDesktopComposer');
  if (desktopComposer) desktopComposer.style.display = 'none';
}
function hideMobileChatView() {
  const chatView = document.getElementById('chatView');
  if (chatView) chatView.classList.remove('mobile-chat-active');
  const chatHeader = document.getElementById('chatMobileHeader');
  if (chatHeader) chatHeader.style.display = 'none';
  const chatComposer = document.getElementById('chatMobileComposer');
  if (chatComposer) chatComposer.style.display = 'none';
  const desktopComposer = document.getElementById('chatDesktopComposer');
  if (desktopComposer) desktopComposer.style.display = '';
}
window.addEventListener('resize', () => {
  if (window.IS_MOBILE) return;
  const active = document.querySelector('.wechat-page.active');
  if (!active) return;
  const sb = document.querySelector('.sidebar');
  if (sb) active.style.left = sb.offsetWidth + 'px';
});
function hideMobilePages() {
  ['discoverPage', 'mePage', 'contactsPage', 'blocklistPage'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
}
function showMobilePage(pageId) {
  hideMobilePages();
  const el = document.getElementById(pageId);
  if (el) el.classList.add('active');
  if (!window.IS_MOBILE) {
    const sb = document.querySelector('.sidebar');
    if (sb) el.style.left = sb.offsetWidth + 'px';
  }
  const chatView = document.getElementById('chatView');
  if (chatView) chatView.classList.remove('mobile-chat-active');
  const chatHeader = document.getElementById('chatMobileHeader');
  if (chatHeader) chatHeader.style.display = 'none';
  const chatComposer = document.getElementById('chatMobileComposer');
  if (chatComposer) chatComposer.style.display = 'none';
}

// ����ҳ��Ⱦ��΢��ʽ�б���
function renderDiscoverPage() {
  const list = document.getElementById('discoverList');
  if (!list) return;
  const items = [
    { name: '����Ȧ', icon: '����Ȧ', action: () => { if (window.SecureChatMomentExt) window.SecureChatMomentExt.open(); else toast('����Ȧ���ܿ�����', 'info'); } },
    { name: '��Ƶ��', icon: '��Ƶ', action: () => { if (window.SecureChatVideos) window.SecureChatVideos.open(); else toast('��Ƶ�Ź��ܿ�����', 'info'); } },
    { name: '��һ��', icon: '��', action: () => { if (window.SecureChatRead) window.SecureChatRead.open(); else toast('��һ�����ܿ�����', 'info'); } },
    { name: '��һ��', icon: '��', action: () => { if (window.SecureChatSearch) window.SecureChatSearch.open(); else toast('��һ�ѹ��ܿ�����', 'info'); } },
    { name: 'ֱ��', icon: 'ֱ��', action: () => { if (window.SecureChatLive) window.SecureChatLive.open(); else toast('ֱ�����ܿ�����', 'info'); } },
    { name: '����', icon: '��', action: () => { if (window.SecureChatNearby) window.SecureChatNearby.open(); else toast('�������ܿ�����', 'info'); } },
    { name: '����', icon: '��', action: () => { if (window.SecureChatShop) window.SecureChatShop.open(); else toast('���﹦�ܿ�����', 'info'); } },
    { name: '��Ϸ', icon: '��', action: () => { if (window.SecureChatGames) window.SecureChatGames.open(); else toast('��Ϸ���ܿ�����', 'info'); } },
    { name: 'С����', icon: 'С', action: () => { if (window.loadMiniPrograms) loadMiniPrograms(); if (window.openMiniAppCenter) window.openMiniAppCenter(); else toast('С�����ܿ�����', 'info'); } },
    { name: 'AI ����', icon: 'AI', action: () => { const main = document.querySelector('.main'); if (main) main.style.display = 'none'; hideMobilePages(); const aiView = $('aiView'); if (aiView) aiView.style.display = 'flex'; if (window.switchToAi) window.switchToAi(); loadMiniPrograms(); } },
  ];
  // ���飺�������ã��м�С������
  const group1 = items.slice(0, 3);
  const group2 = items.slice(3);
  const itemHtml = (it, i) => `
    <div class="wx-discover-item" data-idx="${i}">
      <div class="wx-discover-icon">${it.icon}</div>
      <div class="wx-discover-name">${it.name}</div>
      <span class="wx-discover-arrow">?</span>
    </div>`;
  list.innerHTML = `
    <div class="wx-group">${group1.map((it, i) => itemHtml(it, i)).join('')}</div>
    <div class="wx-group">${group2.map((it, i) => itemHtml(it, i + group1.length)).join('')}</div>`;
  list.querySelectorAll('.wx-discover-item').forEach((el, i) => {
    el.onclick = () => items[i].action();
  });
}

// �ҵ�ҳ��Ⱦ��΢��ʽ��
function renderMePage() {
  if (!state.me) return;
  const header = document.getElementById('meHeaderContent');
  if (!header) return;
  const hasImg = state.me.avatar;
  const avHtml = hasImg ? `<img src="${state.me.avatar}">` : avatarChar(state.me.nickname);
  header.innerHTML = `
    <div class="me-avatar">${avHtml}</div>
    <div class="me-info">
      <div class="me-name">${escapeHtml(state.me.nickname)}</div>
      <div class="me-id">΢�źţ�${escapeHtml(state.me.uid || '')}</div>
    </div>
    <span class="me-qr" id="meQrBtn"><span class="wx-ico-sm">ɨ</span></span>`;
  const qrBtn = document.getElementById('meQrBtn');
  if (qrBtn) qrBtn.onclick = () => openQrScanner();

  const svc = document.getElementById('meServicesCard');
  if (!svc) return;
const services = [
    { name: '֧��', icon: '֧��', action: () => {
      const pay = window.SecureChatExt && window.SecureChatExt.getFeature && window.SecureChatExt.getFeature('pay');
      if (pay && typeof pay.homePanel === 'function') openFeatureModalFrom(pay, 'homePanel');
      else toast('֧�����ܿ�����', 'info');
    } },
    { name: '�ղ�', icon: '��', action: () => { if (window.SecureChatFavorites) window.SecureChatFavorites.open(); else toast('�ղع��ܿ�����', 'info'); } },
    { name: '���', icon: '��', action: () => { if (window.SecureChatAlbum) window.SecureChatAlbum.open(); else toast('��Ṧ�ܿ�����', 'info'); } },
    { name: '����', icon: '��', action: () => { if (window.SecureChatCards) window.SecureChatCards.open(); else toast('�������ܿ�����', 'info'); } },
    { name: '����', icon: '?', action: () => { if (window.SecureChatStickers) window.SecureChatStickers.open(); else toast('���鹦�ܿ�����', 'info'); } },
    { name: '������', icon: '��', action: () => { renderBlocklistPage(); showMobilePage('blocklistPage'); } },
    { name: '���๦��', icon: '��', action: () => openFeatureCenter() },
    { name: '����', icon: '��', action: () => { const main = document.querySelector('.main'); if (main) main.style.display = 'none'; hideMobilePages(); const dv = $('downloadView'); if (dv) dv.style.display = 'flex'; if (window.initDownloadView) window.initDownloadView(dv); } },
    { name: '�������', icon: '��', action: () => { if (window.SecureChatFeedback) window.SecureChatFeedback.open(); else toast('����������ܿ�����', 'info'); } },
    { name: '����', icon: '��', action: () => { if (window.openAiSettings) { const main = document.querySelector('.main'); if (main) main.style.display = 'none'; hideMobilePages(); const aiView = $('aiView'); if (aiView) aiView.style.display = 'flex'; window.openAiSettings(); } else toast('���ù��ܿ�����', 'info'); } },
  ];
  // ΢��ʽ���飺��һ�� ֧��/�ղأ��ڶ��� ���/����/���飬������ ���๦��/����/�������/����
  svc.innerHTML = `
    <div class="wx-me-group">${services.slice(0, 2).map((s, i) => meItemHtml(s, i)).join('')}</div>
    <div class="wx-me-group">${services.slice(2, 5).map((s, i) => meItemHtml(s, i + 2)).join('')}</div>
    <div class="wx-me-group">${services.slice(5).map((s, i) => meItemHtml(s, i + 5)).join('')}</div>`;
  svc.querySelectorAll('.wx-me-item').forEach((el, i) => { el.onclick = services[Number(el.dataset.si)].action; });
}
function meItemHtml(s, i) {
  return `<div class="wx-me-item" data-si="${i}"><div class="wx-me-icon">${s.icon}</div><span class="wx-me-name">${s.name}</span><span class="wx-discover-arrow">?</span></div>`;
}

// ͨѶ¼ҳ��Ⱦ
function renderContactsPage() {
  const kw = (document.getElementById('contactsSearch') || {}).value || '';
  const newFEl = document.getElementById('contactsNewFriends');
  const grpEl = document.getElementById('contactsGroups');
  const alpEl = document.getElementById('contactsAlphabetSection');
  if (!newFEl || !grpEl || !alpEl) return;

  // �º��ѣ�pending requests��
  newFEl.innerHTML = state.pendingReq.length ? state.pendingReq.map(r => {
    const u = r.fromUser || {};
    return `<div class="contact" data-uid="${r.from}">
      <div class="avatar">${u.avatar ? '<img src="'+u.avatar+'">' : avatarChar(u.nickname)}</div>
      <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(u.nickname || 'δ֪')}</div>
        <div class="last">ID: ${escapeHtml(String(r.from))}</div>
      </div>
      <button class="btn-cn" style="padding:4px 10px;font-size:12px;margin-right:4px" data-accept="${r.from}">����</button>
      <button class="btn-cn gray" style="padding:4px 10px;font-size:12px" data-reject="${r.from}">�ܾ�</button>
    </div>`;
  }).join('') : '<div class="contact" style="padding:12px 14px;color:#aaa;font-size:14px">�����º�������</div>';
  newFEl.querySelectorAll('[data-accept]').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.accept;
      state.pendingReq = state.pendingReq.filter(r => String(r.from) !== uid);
      renderContactsPage();
      loadFriends();
    };
  });
  newFEl.querySelectorAll('[data-reject]').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.reject;
      state.pendingReq = state.pendingReq.filter(r => String(r.from) !== uid);
      renderContactsPage();
    };
  });

  // ����Ⱥ
  const friendGroups = state.groups.filter(g => {
    const m = (g.members || []);
    return m.some(mid => state.friends.some(f => f.id === mid));
  });
  grpEl.innerHTML = friendGroups.length ? friendGroups.map(g => `
    <div class="contact" data-gid="${g.id}">
      <div class="avatar">${(g.name || '?').charAt(0).toUpperCase()}</div>
      <div style="flex:1;overflow:hidden">
        <div class="name">${escapeHtml(g.name)}</div>
        <div class="last">${(g.members || []).length} ��Ա</div>
      </div>
    </div>`).join('') : '<div class="contact" style="padding:12px 14px;color:#aaa;font-size:14px">��������Ⱥ</div>';
  grpEl.querySelectorAll('[data-gid]').forEach(btn => {
    btn.onclick = () => { const gid = parseInt(btn.dataset.gid); if (gid) selectGroup(gid); };
  });

  // ��ĸ��������
  const allFriends = state.friends.filter(u =>
    !kw || (u.nickname || '').toLowerCase().includes(kw) ||
    (u.username || '').toLowerCase().includes(kw) ||
    String(u.id).includes(kw)
  ).sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'zh'));

  const groups = {};
  allFriends.forEach(u => {
    const ch = (u.nickname || '?').charAt(0).toUpperCase();
    const key = /^[A-Za-z]$/.test(ch) ? ch : '#';
    (groups[key] || (groups[key] = [])).push(u);
  });
  const sortedKeys = Object.keys(groups).sort();
  alpEl.innerHTML = sortedKeys.map(k => `
    <div class="contact-group-label" id="contact-letter-${k === '#' ? 'hash' : k}">${k}</div>
    <div class="contact-section">
      ${groups[k].map(u => `
        <div class="contact" data-uid="${u.id}">
          <div class="avatar">${u.avatar ? '<img src="'+u.avatar+'">' : avatarChar(u.nickname)}</div>
          <div style="flex:1;overflow:hidden">
            <div class="name">${escapeHtml(u.nickname)}</div>
            <div class="last">${u.online ? '<span class="dot online"></span> ����' : '����'}</div>
          </div>
        </div>`).join('')}
    </div>`).join('');
  alpEl.querySelectorAll('[data-uid]').forEach(el => {
    el.onclick = () => selectPeer(parseInt(el.dataset.uid));
  });

  const page = document.getElementById('contactsPage');
  if (page) {
    let index = page.querySelector('.contact-alphabet-index');
    if (!index) { index = document.createElement('div'); index.className = 'contact-alphabet-index'; page.appendChild(index); }
    index.innerHTML = sortedKeys.map(k => `<span data-letter="${k}">${k}</span>`).join('');
    index.querySelectorAll('[data-letter]').forEach(el => {
      el.onclick = () => {
        const key = el.dataset.letter;
        const target = document.getElementById('contact-letter-' + (key === '#' ? 'hash' : key));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
  }
}

// ����� Tab ������rail ��ť + �ƶ��˵ײ�����ͬ��
function setRailActive(side) {
  document.querySelectorAll('.sidebar-rail .side-tab').forEach(x => x.classList.toggle('on', x.dataset.side === side));
  if (typeof syncMobileNav === 'function') syncMobileNav(side);
}
// �����"΢��"tab δ�������Ǳ꣨����ŻỰ�����룩
function updateUnreadBadge() {
  const prefs = chatPrefs();
  const total = Object.keys(state.unread || {}).reduce((a, k) => a + (prefs.muted['u:' + k] ? 0 : (state.unread[k] || 0)), 0)
    + Object.keys(state.groupUnread || {}).reduce((a, k) => a + (prefs.muted['g:' + k] ? 0 : (state.groupUnread[k] || 0)), 0);
  const tab = document.querySelector('.sidebar-rail .side-tab[data-side="friends"]');
  if (!tab) return;
  let badge = tab.querySelector('.rail-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'rail-badge';
    tab.appendChild(badge);
  }
  badge.style.display = total > 0 ? 'flex' : 'none';
  badge.textContent = total > 99 ? '99+' : String(total);
}
// ����ˣ��������б�ֻ�ڵ��"΢��"ʱ��ʾ
function setChatListVisible(show) {
  document.documentElement.classList.toggle('chat-list-hidden', !show);
}
// ����� Tab �� ΢��ʽҳ��·�ɣ�ȫ��ͨ�ã�
(function initWechatMobileNav() {
  // ���� tab �� ΢��ʽ����ҳ
  const discoverTab = document.querySelector('.sidebar-rail .side-tab[data-side="ai"]');
  if (discoverTab) {
    discoverTab.onclick = (e) => {
      e.stopPropagation();
      setRailActive('ai');
      setChatListVisible(false);
      renderDiscoverPage();
      showMobilePage('discoverPage');
    };
  }
  // �� tab �� �ҵ�ҳ
  const meTab = document.querySelector('.sidebar-rail .side-tab[data-side="downloads"]');
  if (meTab) {
    meTab.onclick = (e) => {
      e.stopPropagation();
      setRailActive('downloads');
      setChatListVisible(false);
      renderMePage();
      showMobilePage('mePage');
    };
  }
  // ͨѶ¼ tab �� ͨѶ¼ҳ
  const contactsTab = document.querySelector('.sidebar-rail .side-tab[data-side="contacts"]');
  if (contactsTab) {
    contactsTab.onclick = (e) => {
      e.stopPropagation();
      setRailActive('contacts');
      setChatListVisible(false);
      renderContactsPage();
      showMobilePage('contactsPage');
    };
  }
  // ΢�� tab �� �л����������棨�����ͬʱ��ʾ�������б���
  const friendsTab = document.querySelector('.sidebar-rail .side-tab[data-side="friends"]');
  if (friendsTab) {
    friendsTab.onclick = (e) => {
      e.stopPropagation();
      setRailActive('friends');
      setChatListVisible(true);
      hideMobilePages();
      const main = document.querySelector('.main');
      if (main) main.style.display = 'flex';
      const aiView = $('aiView'); if (aiView) aiView.style.display = 'none';
      const downloadView = $('downloadView'); if (downloadView) downloadView.style.display = 'none';
      const fs = $('friendsSide'); if (fs) fs.style.display = '';
      renderContacts();
      if (window.IS_MOBILE) document.getElementById('chatView').classList.remove('mobile-chat-active');
    };
  }
  // ���ذ�ť������ҳ / �ҵ�ҳ / ͨѶ¼ҳ��
  const pages = [
    { id: 'discoverPage', tab: 'ai' },
    { id: 'mePage', tab: 'downloads' },
    { id: 'contactsPage', tab: 'friends' },
  ];
  pages.forEach(p => {
    const backBtn = document.getElementById(p.id.replace('Page', '') + 'BackBtn');
    if (backBtn) {
      backBtn.onclick = () => {
        const tab = document.querySelector('.sidebar-rail .side-tab[data-side="' + p.tab + '"]');
        if (tab) tab.click();
        else {
          document.querySelectorAll('.side-tab').forEach(x => x.classList.toggle('on', x.dataset.side === p.tab));
          syncMobileNav(p.tab);
        }
        hideMobilePages();
        const chatView = document.getElementById('chatView');
        if (chatView) chatView.classList.add('mobile-chat-active');
      };
    }
  });
  // ͨѶ¼����
  const contactsBackBtn = document.getElementById('contactsBackBtn');
  if (contactsBackBtn) {
    contactsBackBtn.onclick = () => {
      const tab = document.querySelector('.sidebar-rail .side-tab[data-side="friends"]');
      if (tab) tab.click();
      hideMobilePages();
      const chatView = document.getElementById('chatView');
      if (chatView) chatView.classList.add('mobile-chat-active');
    };
  }
  // ���췵�ذ�ť
  const chatMobileBackBtn = document.getElementById('chatMobileBackBtn');
  if (chatMobileBackBtn) {
    chatMobileBackBtn.onclick = () => {
      hideMobileChatView();
      state.activePeer = null;
      state.activeGroup = null;
      renderChatHeader();
      $('inviteBar').style.display = 'none';
      const welcome = $('welcomePanel'); if (welcome) welcome.style.display = '';
      renderContacts();
    };
  }
  // ���ఴť������ͷ������ �����˵������� / ������ / ���๦��
  const chatMobileMoreBtn = document.getElementById('chatMobileMoreBtn');
  if (chatMobileMoreBtn) {
    chatMobileMoreBtn.onclick = (e) => {
      e.stopPropagation();
      openChatMoreMenu(chatMobileMoreBtn);
    };
  }
  // ���������ͷ��"?"��ť
  const chatHeaderMoreBtn = document.getElementById('chatHeaderMoreBtn');
  if (chatHeaderMoreBtn) {
    chatHeaderMoreBtn.onclick = (e) => {
      e.stopPropagation();
      openChatMoreMenu(chatHeaderMoreBtn);
    };
  }
  // ����ͼ�� �� ����¼��
  const voiceIconBtn = document.getElementById('voiceIconBtn');
  if (voiceIconBtn) {
    voiceIconBtn.onclick = () => {
      const realBtn = $('voiceBtn');
      if (realBtn) realBtn.click();
    };
  }
  // ������ҳ���� �� ��"��"ҳ
  const blocklistBackBtn = document.getElementById('blocklistBackBtn');
  if (blocklistBackBtn) {
    blocklistBackBtn.onclick = () => {
      const tab = document.querySelector('.sidebar-rail .side-tab[data-side="downloads"]');
      if (tab) tab.click();
    };
  }
  // Ĭ�ϴ�������棨�����б��ɼ������е�����/��/ͨѶ¼ʱ���أ���"΢��"����ʾ
  setChatListVisible(true);
})();

tryRestore();
checkUpdate();
wireConversationTools();

// ============ ���ڣ���������============
let blockedMap = null; // Map: id -> user
async function loadBlocklist(force) {
  if (!force && blockedMap !== null) return blockedMap;
  if (!state || !state.token) return blockedMap || new Map();
  try {
    const res = await fetch(state.serverHost + '/api/blocklist', { headers: { 'Authorization': 'Bearer ' + state.token } });
    if (!res.ok) return blockedMap || new Map();
    const data = await res.json();
    blockedMap = new Map((data.blocked || []).map(x => [x.id, x]));
    return blockedMap;
  } catch (e) { return blockedMap || new Map(); }
}
async function toggleBlock(peerId, onDone) {
  if (!peerId) return;
  const bl = await loadBlocklist();
  const blocked = bl.has(peerId);
  const action = blocked ? 'unblock' : 'block';
  try {
    const res = await fetch(state.serverHost + '/api/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ targetId: peerId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '����ʧ��');
    if (action === 'block') bl.set(peerId, { id: peerId }); else bl.delete(peerId);
    toast(action === 'block' ? '�����ڸ���ϵ��' : '�ѽ������', 'success');
    if (typeof onDone === 'function') onDone();
  } catch (e) {
    toast(((e && e.message) || '����ʧ��'), 'error');
  }
}
let chatMoreMenu = null;
function openChatMoreMenu(anchor) {
  hideChatMoreMenu();
  const peer = state.activePeer ? (state.friends.find(u => u.id === state.activePeer) || null) : null;
  const items = [];
  if (peer) {
    const blocked = blockedMap ? blockedMap.has(peer.id) : false;
    items.push({ label: blocked ? '�������' : '���ڸ���ϵ��', danger: !blocked, onClick: () => toggleBlock(peer.id) });
  }
  if (state.activePeer || state.activeGroup) {
    const key = state.activePeer ? 'u:' + state.activePeer : 'g:' + state.activeGroup;
    const prefs = chatPrefs();
    const pinned = !!prefs.pinned[key];
    const muted = !!prefs.muted[key];
    items.push({ label: '���������¼', onClick: () => { hideChatMoreMenu(); exportChatLog(); } });
    items.push({ label: pinned ? 'ȡ���ö�' : '�ö��Ự', onClick: () => { hideChatMoreMenu(); const p = chatPrefs(); p.pinned[key] = !p.pinned[key]; saveChatPrefs(p); refreshConversationButtons(); renderContacts(); } });
    items.push({ label: muted ? '�ָ�����' : '�����', onClick: () => { hideChatMoreMenu(); const p = chatPrefs(); p.muted[key] = !p.muted[key]; saveChatPrefs(p); refreshConversationButtons(); renderContacts(); } });
  }
  items.push({ label: '����������', onClick: () => { hideChatMoreMenu(); renderBlocklistPage(); showMobilePage('blocklistPage'); } });
  items.push({ label: '���๦��', onClick: () => { hideChatMoreMenu(); openFeatureCenter(); } });
  items.push({ label: '��Ϣ���壺' + msgFontLabel(), onClick: () => { hideChatMoreMenu(); cycleMsgFont(); } });
  items.push({ label: '���챳��', onClick: () => { hideChatMoreMenu(); openChatBgPicker(); } });
  if (!items.length) return;
  chatMoreMenu = document.createElement('div');
  chatMoreMenu.className = 'chat-more-menu';
  chatMoreMenu.innerHTML = items.map(it => '<div class="chat-more-item' + (it.danger ? ' danger' : '') + '">' + it.label + '</div>').join('');
  document.body.appendChild(chatMoreMenu);
  const r = anchor.getBoundingClientRect();
  chatMoreMenu.style.top = Math.max(8, r.bottom + 6) + 'px';
  chatMoreMenu.style.left = Math.min(Math.max(8, r.left), window.innerWidth - 166) + 'px';
  chatMoreMenu.querySelectorAll('.chat-more-item').forEach((el, i) => { el.onclick = items[i].onClick; });
  setTimeout(() => { document.addEventListener('click', hideChatMoreMenu, { once: true }); }, 0);
}
function hideChatMoreMenu() {
  if (chatMoreMenu) { chatMoreMenu.remove(); chatMoreMenu = null; }
}
// ============ ���챳�� ============
const CHAT_BGS = [
  { name: 'Ĭ��', color: '' },
  { name: '�װ�', color: '#f8fafc' },
  { name: 'ǳ��', color: '#e8eaed' },
  { name: 'ī��', color: '#2f4f43' },
  { name: '����', color: '#2b3a55' },
  { name: 'ů��', color: '#f5e6d3' },
  { name: '����', color: '#dbe9f7' },
  { name: '����', color: '#e6e0f0' },
];
function applyChatBg(color) {
  const key = 'chatBgColor';
  if (color) { localStorage.setItem(key, color); document.documentElement.style.setProperty('--chat-bg', color); }
  else { localStorage.removeItem(key); document.documentElement.style.removeProperty('--chat-bg'); }
}
function initChatBg() {
  try { const c = localStorage.getItem('chatBgColor'); if (c) document.documentElement.style.setProperty('--chat-bg', c); } catch (e) {}
}
function openChatBgPicker() {
  const mask = document.createElement('div');
  mask.className = 'profile-mask';
  mask.innerHTML = `<div class="profile-card" style="max-width:340px">
    <div class="profile-head"><div class="profile-name" style="font-size:15px">���챳��</div></div>
    <div class="chat-bg-grid">${CHAT_BGS.map(b => `<div class="chat-bg-item" data-c="${escapeHtml(b.color)}" style="${b.color ? 'background:' + b.color : 'background:#f8fafc;border:1px dashed #cbd5e1'}"><span style="${b.color ? '' : 'color:#94a3b8'}">${escapeHtml(b.name)}</span></div>`).join('')}</div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelectorAll('.chat-bg-item').forEach(el => {
    el.onclick = () => { applyChatBg(el.dataset.c); mask.remove(); toast('���챳���Ѹ���', 'success', 1200); };
  });
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
}
initChatBg();
// ============ ���������¼ + ��Ϣ���� ============
async function exportChatLog() {
  const peerId = state.activePeer;
  const groupId = state.activeGroup;
  if (!peerId && !groupId) { toast('����ѡ��Ự', 'warn'); return; }
  try {
    let msgs, title;
    if (groupId) {
      const res = await fetch(state.serverHost + '/api/groups/' + groupId + '/messages', { headers: { 'Authorization': 'Bearer ' + state.token } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      msgs = data.messages || [];
      const g = state.groups.find(x => x.id === groupId);
      title = g ? g.name : ('Ⱥ�� #' + groupId);
    } else {
      const res = await fetch(state.serverHost + '/api/history/' + encodeURIComponent(String(peerId)), { headers: { 'Authorization': 'Bearer ' + state.token } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      msgs = data.messages || [];
      const peer = state.friends.find(u => u.id === peerId);
      title = peer ? peer.nickname : ('�û� #' + peerId);
    }
    if (!msgs.length) { toast('���������¼', 'info'); return; }
    const nameOf = (id) => {
      if (id === state.me.id) return state.me.nickname || '��';
      const f = state.friends.find(u => u.id === id);
      return f ? (f.nickname || f.username) : ('�û� ' + id);
    };
    const lines = ['SecureChat �����¼����', '�Ự��' + title, 'ʱ�䣺' + new Date().toLocaleString(), '�� ' + msgs.length + ' ����Ϣ', '----------------------------------------', ''];
    msgs.forEach(m => {
      const who = nameOf(m.from);
      const ts = new Date(m.createdAt).toLocaleString();
      let body = m.recalled ? (m.from === state.me.id ? '�㳷����һ����Ϣ' : '�Է�������һ����Ϣ') : String(m.content || '').replace(/\r?\n/g, '\n    ');
      lines.push('[' + ts + '] ' + who + ': ' + body);
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'SecureChat-' + title.replace(/[\\/:*?"<>|]/g, '_') + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('�����¼�ѵ���', 'success');
  } catch (e) {
    toast('����ʧ�ܣ�' + ((e && e.message) || e), 'error');
  }
}
function msgFontLabel() {
  const s = localStorage.getItem('sc_msg_font') || 'm';
  return s === 's' ? 'С' : (s === 'l' ? '��' : '��');
}
function applyMsgFont() {
  const s = localStorage.getItem('sc_msg_font') || 'm';
  const size = s === 's' ? '13px' : (s === 'l' ? '17px' : '15px');
  const box = $('messages');
  if (box) box.style.fontSize = size;
}
function cycleMsgFont() {
  const cur = localStorage.getItem('sc_msg_font') || 'm';
  const next = cur === 's' ? 'm' : (cur === 'm' ? 'l' : 's');
  localStorage.setItem('sc_msg_font', next);
  applyMsgFont();
  toast('��Ϣ���壺' + msgFontLabel(), 'info', 1200);
}
async function renderBlocklistPage() {
  const list = document.getElementById('blocklistList');
  if (!list) return;
  list.innerHTML = '<div style="padding:24px;text-align:center;color:#999">�����С�</div>';
  const bl = await loadBlocklist(true);
  if (!bl.size) { list.innerHTML = '<div style="padding:24px;text-align:center;color:#999">���޺�����</div>'; return; }
  list.innerHTML = [...bl.values()].map(u => '<div class="contact" style="display:flex;align-items:center;padding:10px 14px;background:#fff">' +
    '<div class="avatar">' + (u.avatar ? '<img src="' + u.avatar + '">' : avatarChar(u.nickname || u.username)) + '</div>' +
    '<div style="flex:1;overflow:hidden"><div class="name">' + escapeHtml(u.nickname || u.username) + '</div>' +
    '<div class="last">ID: ' + escapeHtml(String(u.uid || u.id)) + '</div></div>' +
    '<button class="btn-cn" style="padding:4px 10px;font-size:12px" data-unblock="' + u.id + '">�������</button></div>').join('');
  list.querySelectorAll('[data-unblock]').forEach(btn => {
    btn.onclick = () => toggleBlock(parseInt(btn.dataset.unblock, 10), () => renderBlocklistPage());
  });
}

// i18n ���ף�i18n.js �� DOMContentLoaded ʱ������ apply() һ�Σ�
// �����ٲ�һ�Σ����� app.js �� DOMContentLoaded ֮ǰ��֮��ִ�еĳ�����ȷ����̬ DOM ��á�
if (window.SCI18N && typeof SCI18N.apply === 'function') {
  const _applyI18n = () => SCI18N.apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _applyI18n, { once: true });
  else _applyI18n();
}
// E2EE ����Ԥ�ȣ���¼��������ʼ�� identity key ���ϴ� prekey bundle��
// ȷ���յ���һ�� Flutter ����ʱ�ܹ��������ܡ�
(function initE2EEOnLogin() {
  function warmup() {
    if (window.SCE2EE && state && state.me) {
      window.SCE2EE.ensureKeyPair().catch(() => {});
    }
  }
  document.addEventListener('securechat.login', warmup, { once: false });
  if (state && state.me) warmup();
})();


// ============ ������̨�����һ������������ ============
(function initAdminPanel() {
  const adminEntry = $('adminEntry');
  if (!adminEntry) return;
  // ������Ա�ɼ�
  function isAdminUser() {
    if (!state.me || !state.me.email) return false;
    try {
      const admins = (localStorage.getItem('sc_admin_emails') || '3529403074@qq.com').split(',').map(s => s.trim().toLowerCase());
      return admins.includes(state.me.email.toLowerCase());
    } catch { return false; }
  }
  function showAdminView() {
    document.querySelector('.main').style.display = 'none';
    const av = $('adminView'); if (av) av.style.display = 'flex';
    if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
    loadAdminCodes('');
  }
  function hideAdminView() {
    const main = document.querySelector('.main'); if (main) main.style.display = 'flex';
    const av = $('adminView'); if (av) av.style.display = 'none';
    if (window.IS_MOBILE) document.getElementById('chatView').classList.remove('mobile-chat-active');
  }
  adminEntry.onclick = () => {
    if (!isAdminUser()) { toast('�޹���Ȩ��', 'warn'); return; }
    // �л� admin tab ����
    document.querySelectorAll('.side-tab').forEach(x => x.classList.toggle('on', x === adminEntry));
    syncMobileNav('admin');
    if (document.querySelector('.main')) document.querySelector('.main').style.display = 'none';
    const av = $('adminView'); if (av) av.style.display = 'flex';
    if (window.IS_MOBILE) document.getElementById('chatView').classList.add('mobile-chat-active');
    loadAdminCodes('');
  };
  // ���ذ�ť
  const adminBackBtn = $('adminBackBtn');
  if (adminBackBtn) adminBackBtn.onclick = () => {
    const friendsTab = document.querySelector('.side-tab[data-side="friends"]');
    if (friendsTab) friendsTab.click();
    else { document.querySelectorAll('.side-tab').forEach(x => x.classList.toggle('on', x.dataset.side === 'friends')); syncMobileNav('friends'); }
    hideAdminView();
  };
  // ���ɶһ���
  const adminIssueBtn = $('adminIssueBtn');
  if (adminIssueBtn) {
    adminIssueBtn.onclick = async () => {
      const value = parseFloat($('adminRedeemValue').value);
      const count = Math.min(parseInt($('adminRedeemCount').value) || 1, 500);
      if (!value || value <= 0) { toast('��������Ч��ֵ', 'warn'); return; }
      adminIssueBtn.disabled = true; adminIssueBtn.textContent = '������...';
      try {
        const res = await fetch(state.serverHost + '/api/admin/redeem/issue', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
          body: JSON.stringify({ value, count })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '����ʧ��');
        $('adminIssueCount').textContent = data.count;
        const list = $('adminCodeList');
        list.innerHTML = (data.codes || []).map(c => '<span class="admin-code-item" title="�������">' + escapeHtml(c) + '</span>').join('');
        list.querySelectorAll('.admin-code-item').forEach(el => {
          el.onclick = () => { navigator.clipboard.writeText(el.textContent).then(() => toast('�Ѹ���: ' + el.textContent, 'success', 1200)); };
        });
        $('adminIssueResult').style.display = '';
        toast('�ɹ����� ' + data.count + ' ���һ���', 'success');
        loadAdminCodes('');
      } catch (e) { toast('����ʧ�ܣ�' + e.message, 'error'); }
      finally { adminIssueBtn.disabled = false; adminIssueBtn.textContent = '���ɶһ���'; }
    };
  }
  // ����ȫ��
  const adminCopyAllBtn = $('adminCopyAllBtn');
  if (adminCopyAllBtn) {
    adminCopyAllBtn.onclick = () => {
      const codes = Array.from($('adminCodeList').querySelectorAll('.admin-code-item')).map(el => el.textContent).join('\n');
      navigator.clipboard.writeText(codes).then(() => toast('�Ѹ���ȫ���һ���', 'success'));
    };
  }
  // �һ����б� tab �л�
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      loadAdminCodes(tab.dataset.claimed);
    };
  });
  // ���ضһ����б�
  window.loadAdminCodes = async function(claimed) {
    const tbl = $('adminCodeTable');
    if (!tbl) return;
    tbl.innerHTML = '<div style="padding:20px;color:#999;text-align:center">������...</div>';
    try {
      const res = await fetch(state.serverHost + '/api/admin/redeem' + (claimed !== undefined && claimed !== '' ? '?claimed=' + claimed : ''), {
        headers: { 'Authorization': 'Bearer ' + state.token }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '����ʧ��');
      const codes = data.codes || [];
      if (!codes.length) { tbl.innerHTML = '<div style="padding:20px;color:#999;text-align:center">���޶һ���</div>'; return; }
      tbl.innerHTML = codes.map(c => {
        const claimedAt = c.claimed_at ? new Date(c.claimed_at).toLocaleString() : '-';
        const statusCls = c.claimed_by ? 'used' : 'unused';
        const statusText = c.claimed_by ? '��ʹ��' : 'δʹ��';
        return '<div class="admin-code-row"><span class="code">' + escapeHtml(c.code) + '</span><span class="value">' + c.value + 'Ԫ</span><span class="status ' + statusCls + '">' + statusText + '</span><span style="color:#999;font-size:11px">' + escapeHtml(claimedAt) + '</span></div>';
      }).join('');
    } catch (e) { tbl.innerHTML = '<div style="padding:20px;color:#c0392b;text-align:center">����ʧ�ܣ�' + escapeHtml(e.message) + '</div>'; }
  };
})();
