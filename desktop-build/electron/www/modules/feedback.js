(function () {
  'use strict';
  if (window.SecureChatFeedback) return;

  const KINDS = [
    { id: 'bug', label: 'Bug' },
    { id: 'suggestion', label: '建议' },
    { id: 'complaint', label: '投诉' },
    { id: 'other', label: '其他' }
  ];

  function sh() {
    if (window.SecureChatExt && window.SecureChatExt._util) return window.SecureChatExt._util.serverHost();
    return (window.state && window.state.serverHost) || (window.SERVER_HOST || location.origin);
  }
  function tok() {
    if (window.state && window.state.token) return 'Bearer ' + window.state.token;
    return '';
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtTime(ts) { if (!ts) return ''; const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  const STATUS_LABEL = { open: '处理中', resolved: '已处理', closed: '已关闭' };

  function open() {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'feedbackModalMask';
    mask.addEventListener('mousedown', e => { if (e.target === mask) closeModal(); });
    const box = document.createElement('div');
    box.className = 'modal-box feedback-box';
    box.style.cssText = 'max-width:520px;width:92vw;max-height:86vh;display:flex;flex-direction:column;background:var(--card,#fff);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border,#eee);">' +
        '<h3 style="margin:0;font-size:17px;">意见反馈</h3>' +
        '<button id="fbCloseBtn" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text2,#888);line-height:1;">&times;</button>' +
      '</div>' +
      '<div style="display:flex;gap:18px;border-bottom:1px solid var(--border,#eee);padding:0 18px;">' +
        '<button class="fb-tab" data-tab="write" style="padding:10px 2px;border:none;background:none;cursor:pointer;font-size:14px;border-bottom:2px solid var(--accent,#07c160);">提交反馈</button>' +
        '<button class="fb-tab" data-tab="list" style="padding:10px 2px;border:none;background:none;cursor:pointer;font-size:14px;color:var(--text2,#888);border-bottom:2px solid transparent;">我的反馈</button>' +
      '</div>' +
      '<div id="fbBody" style="flex:1;overflow-y:auto;padding:18px;"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    document.getElementById('fbCloseBtn').addEventListener('click', closeModal);
    mask.querySelectorAll('.fb-tab').forEach(b => b.addEventListener('click', () => {
      mask.querySelectorAll('.fb-tab').forEach(x => { x.style.borderBottomColor = 'transparent'; x.style.color = 'var(--text2,#888)'; });
      b.style.borderBottomColor = 'var(--accent,#07c160)'; b.style.color = '';
      renderTab(b.dataset.tab);
    }));
    renderTab('write');
  }
  function closeModal() { const m = document.getElementById('feedbackModalMask'); if (m) m.remove(); }

  let curKind = 'bug';
  function renderTab(tab) {
    const body = document.getElementById('fbBody'); if (!body) return;
    if (tab === 'write') {
      curKind = 'bug';
      body.innerHTML =
        '<div style="margin-bottom:12px;">' +
          KINDS.map(k => '<button class="fb-kind" data-k="' + k.id + '" style="padding:6px 14px;margin-right:8px;border:1px solid var(--border,#ddd);border-radius:18px;background:' + (k.id === curKind ? 'var(--accent,#07c160)' : 'transparent') + ';color:' + (k.id === curKind ? '#fff' : 'inherit') + ';cursor:pointer;font-size:13px;">' + k.label + '</button>').join('') +
        '</div>' +
        '<textarea id="fbContent" placeholder="请描述您的问题或建议（至少 10 字）" style="width:100%;min-height:120px;resize:vertical;border:1px solid var(--border,#ddd);border-radius:8px;padding:10px;font-size:14px;box-sizing:border-box;background:var(--bg,#fafafa);color:var(--text,#222);"></textarea>' +
        '<input id="fbContact" placeholder="联系方式（选填，手机/邮箱）" style="width:100%;margin-top:10px;border:1px solid var(--border,#ddd);border-radius:8px;padding:10px;font-size:14px;box-sizing:border-box;background:var(--bg,#fafafa);color:var(--text,#222);" />' +
        '<div style="display:flex;justify-content:flex-end;margin-top:14px;">' +
          '<button id="fbSubmit" style="padding:9px 22px;border:none;border-radius:8px;background:var(--accent,#07c160);color:#fff;cursor:pointer;font-size:14px;">提交</button>' +
        '</div>';
      body.querySelectorAll('.fb-kind').forEach(b => b.addEventListener('click', () => {
        curKind = b.dataset.k;
        body.querySelectorAll('.fb-kind').forEach(x => { x.style.background = 'transparent'; x.style.color = 'inherit'; });
        b.style.background = 'var(--accent,#07c160)'; b.style.color = '#fff';
      }));
      document.getElementById('fbSubmit').addEventListener('click', submit);
    } else {
      loadList();
    }
  }

  async function submit() {
    const content = (document.getElementById('fbContent').value || '').trim();
    const contact = (document.getElementById('fbContact').value || '').trim();
    const btn = document.getElementById('fbSubmit');
    if (content.length < 10) { if (window.toast) window.toast('内容至少 10 字', 'warn', 1500); return; }
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const res = await fetch(sh() + '/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': tok() },
        body: JSON.stringify({ kind: curKind, content: content + (contact ? '（联系：' + contact + '）' : '') })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');
      if (window.toast) window.toast('反馈已提交，感谢！', 'success', 1800);
      const ta = document.getElementById('fbContent'); if (ta) ta.value = '';
      renderTab('list');
      const tabs = document.querySelectorAll('.fb-tab');
      tabs.forEach(x => { x.style.borderBottomColor = 'transparent'; x.style.color = 'var(--text2,#888)'; });
      const listTab = Array.from(tabs).find(x => x.dataset.tab === 'list');
      if (listTab) { listTab.style.borderBottomColor = 'var(--accent,#07c160)'; listTab.style.color = ''; }
    } catch (e) {
      if (window.toast) window.toast('提交失败：' + e.message, 'error', 2000);
    } finally {
      btn.disabled = false; btn.textContent = '提交';
    }
  }

  async function loadList() {
    const body = document.getElementById('fbBody'); if (!body) return;
    body.innerHTML = '<div style="text-align:center;color:var(--text2,#888);padding:24px;">加载中…</div>';
    try {
      const res = await fetch(sh() + '/api/feedback', { headers: { 'Authorization': tok() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载失败');
      const list = data.feedbacks || [];
      if (!list.length) { body.innerHTML = '<div style="text-align:center;color:var(--text2,#888);padding:32px;">暂无反馈记录</div>'; return; }
      body.innerHTML = list.map(f =>
        '<div style="border:1px solid var(--border,#eee);border-radius:10px;padding:12px;margin-bottom:10px;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
            '<span style="font-size:12px;color:var(--text2,#888);">' + esc((KINDS.find(k => k.id === f.kind) || {}).label || f.kind) + ' · ' + fmtTime(f.created_at) + '</span>' +
            '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:var(--bg,#f0f0f0);color:var(--text2,#666);">' + esc(STATUS_LABEL[f.status] || f.status) + '</span>' +
          '</div>' +
          '<div style="font-size:14px;white-space:pre-wrap;word-break:break-word;color:var(--text,#222);">' + esc(f.content) + '</div>' +
        '</div>'
      ).join('');
    } catch (e) {
      body.innerHTML = '<div style="text-align:center;color:#e15a5a;padding:24px;">' + esc(e.message) + '</div>';
    }
  }

  window.SecureChatFeedback = { open };
})();