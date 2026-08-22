'use strict';
(function () {
  const API = location.origin;
  const $ = (id) => document.getElementById(id);

  let token = localStorage.getItem('sc_token') || '';
  let merchant = null;

  function tip(msg, ok) {
    const el = $('mainTip');
    el.textContent = msg || '';
    el.style.color = ok ? '#15803d' : '#b91c1c';
  }

  async function api(path, opts) {
    opts = opts || {};
    const resp = await fetch(API + path, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, opts.headers || {})
    }));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    return data;
  }

  function render() {
    if (!merchant) {
      $('loginView').classList.remove('hidden');
      $('mainView').classList.add('hidden');
      return;
    }
    $('loginView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    $('mName').value = merchant.name || '';
    $('mCallback').value = merchant.callbackUrl || '';
    $('mKey').value = merchant.apiKey || '';
    const b = $('statusBadge');
    if (merchant.status === 'approved') { b.className = 'badge ok'; b.textContent = '已通过审核'; }
    else if (merchant.status === 'pending') { b.className = 'badge wait'; b.textContent = '待审核'; }
    else { b.className = 'badge no'; b.textContent = '已拒绝' + (merchant.reason ? '：' + merchant.reason : ''); }
  }

  async function load() {
    try {
      const data = await api('/api/pay/gateway/merchant/me');
      merchant = data.merchant;
      render();
    } catch (e) {
      if (/401|token/i.test(e.message)) { merchant = null; render(); }
      $('loginTip').textContent = e.message;
    }
  }

  $('loginBtn').addEventListener('click', () => {
    token = $('tokenInput').value.trim();
    if (!token) { $('loginTip').textContent = '请输入令牌'; return; }
    load();
  });

  $('saveBtn').addEventListener('click', async () => {
    try {
      const data = await api('/api/pay/gateway/merchant/update', {
        method: 'POST',
        body: JSON.stringify({ name: $('mName').value.trim(), callbackUrl: $('mCallback').value.trim() })
      });
      merchant = data.merchant;
      render();
      tip('已保存', true);
    } catch (e) { tip(e.message); }
  });

  $('regenBtn').addEventListener('click', async () => {
    if (!confirm('确定重置 API 密钥？旧密钥将立即失效。')) return;
    try {
      const data = await api('/api/pay/gateway/merchant/update', {
        method: 'POST',
        body: JSON.stringify({ regenerateKey: true })
      });
      merchant = data.merchant;
      render();
      tip('密钥已重置', true);
    } catch (e) { tip(e.message); }
  });

  $('keyShowBtn').addEventListener('click', () => {
    const inp = $('mKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('keyShowBtn').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });

  $('keyCopyBtn').addEventListener('click', () => {
    const v = $('mKey').value;
    if (!v) return;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
      () => tip('已复制到剪贴板', true),
      () => { $('mKey').select(); document.execCommand('copy'); tip('已复制到剪贴板', true); }
    );
  });

  load();
})();
