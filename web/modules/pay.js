/* module: pay (worker batch6) */
/* SecureChat 支付与生活 Web 模块（独立，不依赖 web/app.js 巨石文件）
   提供：收付款码、付款码收款/付款码付款、转账、群收款+接龙、生活缴费/手机充值演示、钱包账单。
   复用全局工具：window.SecureChatExt._util.api / getToken / getMyId（registry.js），
   兼容旧版：直接读 localStorage('sc_token') / window.SERVER_HOST。
   通过 window.SecureChatExt.registerFeature('pay', api) 注册；同时挂到 window.godoMods.pay。
 */
(function () {
  'use strict';

  const HOST = String((window.SERVER_HOST || '').replace(/\/$/, ''));
  function token() {
    if (window.SecureChatExt && window.SecureChatExt._util && typeof window.SecureChatExt._util.getToken === 'function') {
      return window.SecureChatExt._util.getToken() || '';
    }
    return localStorage.getItem('sc_token') || '';
  }
  function myId() {
    if (window.SecureChatExt && window.SecureChatExt._util && typeof window.SecureChatExt._util.getMyId === 'function') {
      const id = window.SecureChatExt._util.getMyId();
      if (id) return id;
    }
    try { const u = JSON.parse(localStorage.getItem('sc_me') || 'null'); if (u && u.id) return u.id; } catch (e) {}
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showToast(msg, kind, ms) {
    if (window.toast && typeof window.toast === 'function') { window.toast(msg, kind, ms); return; }
    try { window.alert(msg); } catch (e) {}
    if (kind === 'error') console.error(msg);
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function qrUrl(text, w) {
    return HOST + '/api/qrcode/render?text=' + encodeURIComponent(text) + '&w=' + (w || 320);
  }

  // 通用 JSON
  async function _req(method, url, body) {
    // 优先用 registry 的 api（自带 host + auth）
    if (window.SecureChatExt && window.SecureChatExt._util && typeof window.SecureChatExt._util.api === 'function') {
      return window.SecureChatExt._util.api(method, url, { body });
    }
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const opt = { method, headers };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(HOST + url, opt);
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  const Pay = {
    wallet: () => _req('GET', '/api/wallet'),
    txn: () => _req('GET', '/api/wallet/txn'),
    redeem: (code) => _req('POST', '/api/wallet/redeem', { code }),
    transfer: (toUid, amount, remark) => _req('POST', '/api/wallet/transfer', { toUid, amount, remark }),
    friends: () => _req('GET', '/api/friends'),
    groups: () => _req('GET', '/api/groups'),

    // 收付款码
    createReceiveCode: (amount, remark) => _req('POST', '/api/pay/code/receive', { amount, remark }),
    createPayCode: () => _req('POST', '/api/pay/code/pay', {}),
    myCodes: (type) => _req('GET', '/api/pay/code' + (type ? '?type=' + type : '')),
    codeInfo: (t) => _req('GET', '/api/pay/code/' + encodeURIComponent(t) + '/info'),
    payByReceiveCode: (t, amount, remark) => _req('POST', '/api/pay/code/receive/' + encodeURIComponent(t) + '/confirm', { amount, remark }),
    chargeByPayCode: (t, amount, remark) => _req('POST', '/api/pay/code/pay/' + encodeURIComponent(t) + '/confirm', { amount, remark }),

    // 群收款
    createCollect: (groupId, title, amount) => _req('POST', '/api/pay/group/collect', { groupId, title, amount }),
    groupCollects: (groupId) => _req('GET', '/api/pay/group/' + groupId + '/collects'),
    collectDetail: (id) => _req('GET', '/api/pay/group/collect/' + id),
    payCollect: (id, remark) => _req('POST', '/api/pay/group/collect/' + id + '/pay', { remark }),

    // 群接龙
    createSolection: (groupId, subject) => _req('POST', '/api/pay/group/solection', { groupId, subject }),
    groupSolections: (groupId) => _req('GET', '/api/pay/group/' + groupId + '/solections'),
    solectionDetail: (id) => _req('GET', '/api/pay/group/solection/' + id),
    joinSolection: (id, remark) => _req('POST', '/api/pay/group/solection/' + id + '/join', { remark }),
    leaveSolection: (id) => _req('DELETE', '/api/pay/group/solection/' + id + '/join', {}),

    // 生活缴费 / 手机充值
    catalog: () => _req('GET', '/api/pay/life/catalog'),
    lifePay: (category, provider, account, amount) => _req('POST', '/api/pay/life/pay', { category, provider, account, amount }),
    lifeHistory: () => _req('GET', '/api/pay/life/history'),

    // 账单
    bills: (opts) => { const q = new URLSearchParams(); if (opts && opts.category) q.set('category', opts.category); if (opts && opts.limit) q.set('limit', opts.limit); const s = q.toString(); return _req('GET', '/api/pay/bills' + (s ? '?' + s : '')); },
    summary: () => _req('GET', '/api/pay/summary'),
  };

  // ---------- 弹窗（自包含） ----------
  function modal(title, bodyFn, actionsFn) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'max-height:85vh;overflow:auto;width:min(440px,92vw)';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    const x = document.createElement('button');
    x.className = 'modal-x'; x.type = 'button'; x.innerHTML = '&times;';
    head.appendChild(h3); head.appendChild(x);
    box.appendChild(head);
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding:4px 0 8px';
    box.appendChild(body);
    const acts = document.createElement('div');
    acts.className = 'modal-actions';
    box.appendChild(acts);
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = () => mask.remove();
    x.onclick = close;
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    if (bodyFn) bodyFn(body);
    if (actionsFn) actionsFn(acts, close);
    if (!acts.children.length) {
      const b = document.createElement('button');
      b.className = 'btn-cn'; b.textContent = '关闭';
      b.onclick = close;
      acts.appendChild(b);
    }
    return { body, acts, close, mask };
  }
  function field(label, value, opts) {
    const w = document.createElement('div');
    w.style.cssText = 'margin-bottom:10px' + ((opts && opts.inline) ? '' : '');
    const lb = document.createElement('label');
    lb.textContent = label;
    lb.style.cssText = 'display:block;font-size:12px;color:#888;margin-bottom:4px';
    const inp = document.createElement('input');
    inp.type = (opts && opts.type) || 'text';
    inp.value = value || '';
    inp.placeholder = (opts && opts.placeholder) || '';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d9d9d9;border-radius:8px;font-size:14px;outline:none';
    w.appendChild(lb); w.appendChild(inp);
    return { w, inp };
  }
  function selField(label, optsList, selected) {
    const w = document.createElement('div');
    w.style.cssText = 'margin-bottom:10px';
    const lb = document.createElement('label');
    lb.textContent = label;
    lb.style.cssText = 'display:block;font-size:12px;color:#888;margin-bottom:4px';
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d9d9d9;border-radius:8px;font-size:14px;outline:none;background:#fff';
    (optsList || []).forEach((o) => {
      const op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      if (o.value === selected) op.selected = true;
      sel.appendChild(op);
    });
    w.appendChild(lb); w.appendChild(sel);
    return { w, sel };
  }

  // ---------- 收款码生成与展示 ----------
  async function showReceiveCodeFlow() {
    const amt = field('金额（可选，固定金额则一次性）', '', { type: 'number', placeholder: '留空为任意金额' });
    const rm = field('备注（可选）', '');
    modal('生成收款码', (body) => {
      body.appendChild(amt.w);
      body.appendChild(rm.w);
    }, (acts, close) => {
      const ok = document.createElement('button');
      ok.className = 'btn-primary'; ok.textContent = '生成';
      ok.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
      ok.onclick = async () => {
        const a = amt.inp.value.trim();
        try {
          const r = await Pay.createReceiveCode(a || undefined, rm.inp.value.trim());
          close();
          showCodePanel({ qrText: r.qrText }, "receive");
        } catch (e) { showToast('生成失败：' + e.message, 'error'); }
      };
      acts.appendChild(ok);
    });
  }

  // 展示二维码 + 复制/扫码说明；pay 类型可传入 regen 回调在临近过期时自动刷新
  function showCodePanel(code, type, regen) {
    const isPay = type === 'pay';
    const img = document.createElement('img');
    const info = document.createElement('div');
    info.style.cssText = 'text-align:center;font-size:14px;color:#333';
    const tip = document.createElement('div');
    tip.style.cssText = 'text-align:center;font-size:12px;color:#999;margin-top:8px';

    let timer = null;
    function render(c) {
      img.src = qrUrl(c.qrText || c.text || '', 340);
      const secs = c.expiresAt ? Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000)) : 0;
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      info.textContent = isPay ? ('付款码（' + mm + ':' + ss + ' 后失效，请勿截图外传）') : ((c.amount ? '收款 ¥' + c.amount : '收款码') + (c.remark ? ' · ' + c.remark : ''));
    }
    function start() {
      if (timer) clearInterval(timer);
      render(code);
      if (isPay && regen) {
        timer = setInterval(() => {
          const remain = code.expiresAt ? (code.expiresAt - Date.now()) : 0;
          render(code);
          if (remain <= 30000) {
            clearInterval(timer);
            regen().then((r) => {
              if (r && r.qrText) { code = r; start(); }
            }).catch((e) => showToast('刷新失败：' + e.message, 'error'));
          }
        }, 1000);
      }
    }
    img.style.cssText = 'width:260px;height:260px;display:block;margin:12px auto;border:1px solid #eee;border-radius:10px;background:#fff';
    tip.textContent = '扫码后跳转 securechat://pay 解码确认';
    const acts = [info, img, tip];
    modal(isPay ? '我的付款码' : '收款码', (body) => {
      acts.forEach((a) => body.appendChild(a));
    }, (actsBox, close) => {
      const b = document.createElement('button');
      b.className = 'btn-cn'; b.textContent = '关闭';
      b.onclick = () => { if (timer) clearInterval(timer); close(); };
      actsBox.appendChild(b);
    });
    start();
  }

  // 扫码输入 token → 解码跳转 → 执行付款/收款
  async function scanFlow(expectType) {
    const inp = field('二维码内容或 token', '', { placeholder: 'securechat://pay?... 或输入 token' });
    modal(expectType === 'pay' ? '扫付款码收款' : '扫收款码付款', (body) => body.appendChild(inp.w),
      (acts, close) => {
        const ok = document.createElement('button');
        ok.className = 'btn-primary'; ok.textContent = '解析并继续';
        ok.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
        ok.onclick = async () => {
          let raw = inp.inp.value.trim();
          if (!raw) { showToast('请输入内容', 'warn'); return; }
          let tk = raw;
          const m = raw.match(/token=([^&]+)/);
          if (m) tk = decodeURIComponent(m[1]);
          try {
            const info = await Pay.codeInfo(tk);
            if (expectType === 'pay' && info.type !== 'pay') { showToast('这不是付款码', 'error'); return; }
            if (expectType === 'receive' && info.type !== 'receive') { showToast('这不是收款码', 'error'); return; }
            const who = info.receiver || info.payer;
            const amtF = expectType === 'pay'
              ? field('收款金额', '', { type: 'number', placeholder: '输入要收的金额' })
              : field('付款金额', info.amount ? String(info.amount) : '', { type: 'number', placeholder: '收款码金额' });
            const rm = field('备注（可选）', '');
            modal(expectType === 'pay' ? '向 ' + (who ? who.nickname || who.username || '用户' : '对方') + ' 收款' : '向 ' + (who ? who.nickname || who.username || '用户' : '对方') + ' 付款', (b2) => {
              b2.appendChild(amtF.w); b2.appendChild(rm.w);
            }, (acts2, close2) => {
              const go = document.createElement('button');
              go.className = 'btn-primary'; go.textContent = '确认' + (expectType === 'pay' ? '收款' : '付款');
              go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
              go.onclick = async () => {
                const amt = parseFloat(amtF.inp.value);
                if (isNaN(amt) || amt <= 0) { showToast('金额无效', 'warn'); return; }
                try {
                  if (expectType === 'pay') await Pay.chargeByPayCode(tk, amt, rm.inp.value.trim());
                  else await Pay.payByReceiveCode(tk, amt, rm.inp.value.trim());
                  showToast('交易成功', 'success');
                  close2(); close();
                } catch (e) { showToast('失败：' + e.message, 'error'); }
              };
              acts2.appendChild(go);
            });
          } catch (e) { showToast('解析失败：' + e.message, 'error'); }
        };
        acts.appendChild(ok);
      });
  }

  // 转账
  function openTransfer() {
    const toUid = field('收款人 ID (UID)', '');
    const amt = field('金额', '', { type: 'number' });
    const rm = field('备注（可选）', '');
    modal('转账好友', (body) => { body.appendChild(toUid.w); body.appendChild(amt.w); body.appendChild(rm.w); },
      (acts, close) => {
        const go = document.createElement('button');
        go.className = 'btn-primary'; go.textContent = '转账';
        go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
        go.onclick = async () => {
          const uid = toUid.inp.value.trim(); const a = parseFloat(amt.inp.value);
          if (!uid || isNaN(a) || a <= 0) { showToast('请填写 UID 和金额', 'warn'); return; }
          try {
            const r = await Pay.transfer(uid, a, rm.inp.value.trim());
            showToast('转账成功，余额 ¥' + r.balance, 'success');
            close();
          } catch (e) { showToast('转账失败：' + e.message, 'error'); }
        };
        acts.appendChild(go);
      });
  }

  // 群收款
  async function openGroupCollect() {
    let groups = [];
    try { groups = (await Pay.groups()).groups || []; } catch (e) {}
    const gsel = selField('选择群', groups.map(g => ({ value: g.id, label: (g.name || '群' + g.id) })), groups.length ? String(groups[0].id) : '');
    const title = field('收款说明', '聚餐AA');
    const amt = field('每人金额', '', { type: 'number' });
    modal('群收款', (body) => { body.appendChild(gsel.w); body.appendChild(title.w); body.appendChild(amt.w); },
      (acts, close) => {
        const go = document.createElement('button');
        go.className = 'btn-primary'; go.textContent = '发起';
        go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
        go.onclick = async () => {
          const gid = parseInt(gsel.sel.value, 10); const a = parseFloat(amt.inp.value);
          if (!gid || !title.inp.value || isNaN(a) || a <= 0) { showToast('请填写完整', 'warn'); return; }
          try {
            const r = await Pay.createCollect(gid, title.inp.value, a);
            showToast('已发起群收款', 'success');
            close();
            renderCollectDetail(r.collect.id, null);
          } catch (e) { showToast('失败：' + e.message, 'error'); }
        };
        acts.appendChild(go);
      });
  }

  function renderCollectDetail(id, container) {
    (async () => {
      const c = await Pay.collectDetail(id);
      const box = container || modal('群收款', (body) => {
        const out = document.createElement('div'); body.appendChild(out);
        drawCollect(c, out);
      }, (acts, close) => {
        const b = document.createElement('button'); b.className = 'btn-cn'; b.textContent = '关闭'; b.onclick = close; acts.appendChild(b);
      }).body;
      if (box) { box.innerHTML = ''; drawCollect(c, box); }
    })().catch((e) => showToast('载入收款失败：' + e.message, 'error'));
  }

  function drawCollect(c, out) {
    const head = document.createElement('div');
    head.style.cssText = 'text-align:center;padding:8px 0 14px;border-bottom:1px solid #eee;margin-bottom:12px';
    head.innerHTML = `<div style="font-size:28px;font-weight:800;color:#07c160">¥${Number(c.amount).toFixed(2)}</div>
      <div style="font-size:14px;color:#333;margin-top:4px">${esc(c.title)}</div>
      <div style="font-size:12px;color:#999;margin-top:4px">${esc(c.groupName)} · ${c.paidCount}/${c.memberCount} 已缴</div>`;
    out.appendChild(head);
    if (c.status === 'open') {
      const payBtn = document.createElement('button');
      payBtn.className = 'btn-primary';
      payBtn.textContent = c.viewerPaid ? '你已缴款' : '立即缴款（¥' + Number(c.amount).toFixed(2) + '）';
      payBtn.disabled = c.viewerPaid;
      payBtn.style.cssText = 'width:100%;box-sizing:border-box;padding:11px;border:none;border-radius:10px;font-size:15px;cursor:pointer;margin-bottom:12px;' + (c.viewerPaid ? 'background:#ccc;color:#666' : 'background:#07c160;color:#fff');
      if (!c.viewerPaid) {
        payBtn.onclick = async () => {
          try { await Pay.payCollect(c.id, c.title); showToast('缴款成功', 'success'); renderCollectDetail(c.id, out.parentElement); }
          catch (e) { showToast('缴款失败：' + e.message, 'error'); }
        };
      }
      out.appendChild(payBtn);
    }
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    (c.members || []).forEach((m) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #f0f0f0;border-radius:8px';
      const av = document.createElement('div');
      av.style.cssText = 'width:30px;height:30px;border-radius:50%;background:#e6f7ee;color:#07c160;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;overflow:hidden';
      if (m.avatar) av.innerHTML = `<img src="${esc(m.avatar)}" style="width:100%;height:100%;object-fit:cover">`;
      else av.textContent = (m.name || '?').charAt(0);
      const nm = document.createElement('div');
      nm.style.cssText = 'flex:1;font-size:14px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nm.textContent = (m.name || '') + (m.remark ? '（' + m.remark + '）' : '');
      const st = document.createElement('div');
      st.style.cssText = 'font-size:12px;color:' + (m.paid ? '#07c160' : '#999');
      st.textContent = m.paid ? '已缴' : '未缴';
      row.appendChild(av); row.appendChild(nm); row.appendChild(st);
      list.appendChild(row);
    });
    out.appendChild(list);
  }

  // 群接龙
  async function openGroupSolection() {
    let groups = [];
    try { groups = (await Pay.groups()).groups || []; } catch (e) {}
    const gsel = selField('选择群', groups.map(g => ({ value: g.id, label: (g.name || '群' + g.id) })), groups.length ? String(groups[0].id) : '');
    const subject = field('接龙主题', '周末聚会报名');
    modal('发起群接龙', (body) => { body.appendChild(gsel.w); body.appendChild(subject.w); },
      (acts, close) => {
        const go = document.createElement('button');
        go.className = 'btn-primary'; go.textContent = '发起';
        go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
        go.onclick = async () => {
          const gid = parseInt(gsel.sel.value, 10);
          if (!gid || !subject.inp.value) { showToast('请填写完整', 'warn'); return; }
          try { const r = await Pay.createSolection(gid, subject.inp.value); showToast('已发起接龙', 'success'); close(); renderSolectionDetail(r.solection.id, null); }
          catch (e) { showToast('失败：' + e.message, 'error'); }
        };
        acts.appendChild(go);
      });
  }

  function renderSolectionDetail(id, container) {
    (async () => {
      const s = await Pay.solectionDetail(id);
      const box = container || modal('群接龙', (body) => { const out = document.createElement('div'); body.appendChild(out); drawSolection(s, out); },
        (acts, close) => { const b = document.createElement('button'); b.className = 'btn-cn'; b.textContent = '关闭'; b.onclick = close; acts.appendChild(b); }).body;
      if (box) { box.innerHTML = ''; drawSolection(s, box); }
    })().catch((e) => showToast('载入接龙失败：' + e.message, 'error'));
  }

  function drawSolection(s, out) {
    const head = document.createElement('div');
    head.style.cssText = 'padding:8px 0 14px;border-bottom:1px solid #eee;margin-bottom:12px';
    head.innerHTML = `<div style="font-size:17px;font-weight:700;color:#333">${esc(s.subject)}</div>
      <div style="font-size:12px;color:#999;margin-top:4px">${esc(s.groupName)} · ${s.entryCount} 人已报名</div>`;
    out.appendChild(head);
    const joined = (s.entries || []).some(e => e.userId === myId());
    if (s.status === 'open') {
      if (joined) {
        const leaveBtn = document.createElement('button');
        leaveBtn.className = 'btn-cn';
        leaveBtn.textContent = '取消报名';
        leaveBtn.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #eee;border-radius:10px;cursor:pointer;background:#fff;margin-bottom:12px';
        leaveBtn.onclick = async () => { try { await Pay.leaveSolection(s.id); showToast('已取消', 'success'); renderSolectionDetail(s.id, out.parentElement); } catch (e) { showToast('失败：' + e.message, 'error'); } };
        out.appendChild(leaveBtn);
      } else {
        const rm = field('留言（可选，如 +1）', '+1');
        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn-primary'; joinBtn.textContent = '报名接龙 +1';
        joinBtn.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border:none;border-radius:10px;cursor:pointer;background:#07c160;color:#fff;margin-bottom:8px';
        joinBtn.onclick = async () => { try { await Pay.joinSolection(s.id, rm.inp.value.trim()); showToast('报名成功', 'success'); renderSolectionDetail(s.id, out.parentElement); } catch (e) { showToast('失败：' + e.message, 'error'); } };
        out.appendChild(rm.w);
        out.appendChild(joinBtn);
      }
    }
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    (s.entries || []).forEach((e, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #f0f0f0;border-radius:8px';
      const av = document.createElement('div');
      av.style.cssText = 'width:30px;height:30px;border-radius:50%;background:#e6f7ee;color:#07c160;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;overflow:hidden';
      if (e.avatar) av.innerHTML = `<img src="${esc(e.avatar)}" style="width:100%;height:100%;object-fit:cover">`;
      else av.textContent = (e.name || '?').charAt(0);
      const nm = document.createElement('div');
      nm.style.cssText = 'flex:1;font-size:14px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nm.textContent = (idx + 1) + '. ' + (e.name || '') + (e.remark ? '（' + e.remark + '）' : '');
      row.appendChild(av); row.appendChild(nm);
      list.appendChild(row);
    });
    out.appendChild(list);
  }

  // 生活缴费 / 手机充值
  async function openLifePay() {
    const cat = await Pay.catalog();
    const cats = cat.categories || [];
    const csel = selField('缴费项目', cats.map(c => ({ value: c.key, label: c.label })), cats.length ? cats[0].key : '');
    const psel = selField('机构', (cats[0] ? cats[0].providers : []).map(p => ({ value: p, label: p })), null);
    const accountF = field('户号 / 手机号', '');
    const amtF = field('金额', '', { type: 'number' });
    const lb = document.createElement('div');
    lb.style.cssText = 'font-size:12px;color:#b26a00;background:#fff8e1;padding:8px;border-radius:6px;margin-bottom:10px';
    lb.textContent = '演示环境：仅扣减余额生成凭证，不产生真实缴费到账。';
    csel.sel.addEventListener('change', () => {
      const c = cats.find(x => x.key === csel.sel.value);
      psel.sel.innerHTML = '';
      (c ? c.providers : []).forEach((p) => { const op = document.createElement('option'); op.value = p; op.textContent = p; psel.sel.appendChild(op); });
    });
    modal('生活缴费 / 手机充值', (body) => {
      body.appendChild(lb); body.appendChild(csel.w); body.appendChild(psel.w); body.appendChild(accountF.w); body.appendChild(amtF.w);
    }, (acts, close) => {
      const go = document.createElement('button');
      go.className = 'btn-primary'; go.textContent = '确认缴费';
      go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
      go.onclick = async () => {
        const catKey = csel.sel.value; const prov = psel.sel.value; const acc = accountF.inp.value.trim(); const a = parseFloat(amtF.inp.value);
        if (!catKey || !prov || !acc || isNaN(a) || a <= 0) { showToast('请填写完整信息', 'warn'); return; }
        try {
          const r = await Pay.lifePay(catKey, prov, acc, a);
          showToast('缴费成功，凭证号 #' + r.payment.id + '，余额 ¥' + r.balance, 'success');
          close();
        } catch (e) { showToast('缴费失败：' + e.message, 'error'); }
      };
      acts.appendChild(go);
    });
  }

  // 账单
  async function renderBills(container) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
    const title = document.createElement('h3');
    title.textContent = '钱包账单'; title.style.cssText = 'margin:0;color:#07c160';
    head.appendChild(title);
    wrap.appendChild(head);
    container.appendChild(wrap);
    const inner = document.createElement('div');
    inner.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    wrap.appendChild(inner);
    try {
      let bills = (await Pay.bills()).bills || [];
      if (!bills.length) {
        const empty = document.createElement('div'); empty.style.cssText = 'text-align:center;color:#999;padding:40px 0'; empty.textContent = '暂无账单'; inner.appendChild(empty);
      }
      bills.forEach((b) => {
        const ined = b.kind === 'in';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fff';
        const icon = document.createElement('div');
        icon.style.cssText = 'width:34px;height:34px;border-radius:50%;background:' + (ined ? '#e6f7ee' : '#fdecea') + ';color:' + (ined ? '#07c160' : '#e74c3c') + ';display:flex;align-items:center;justify-content:center;font-size:14px';
        icon.textContent = ined ? '收' : '支';
        const mid = document.createElement('div');
        mid.style.cssText = 'flex:1;min-width:0';
        const t1 = document.createElement('div'); t1.textContent = b.title || b.category; t1.style.cssText = 'font-size:14px;color:#333;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const t2 = document.createElement('div'); t2.textContent = fmtTime(b.createdAt) + (b.peerName ? ' · ' + b.peerName : ''); t2.style.cssText = 'font-size:12px;color:#999';
        mid.appendChild(t1); mid.appendChild(t2);
        const amt = document.createElement('div');
        amt.textContent = (ined ? '+' : '-') + Number(b.amount).toFixed(2);
        amt.style.cssText = 'font-size:16px;font-weight:700;color:' + (ined ? '#07c160' : '#333');
        row.appendChild(icon); row.appendChild(mid); row.appendChild(amt);
        inner.appendChild(row);
      });
    } catch (e) {
      const err = document.createElement('div'); err.style.cssText = 'color:#c0392b;padding:16px'; err.textContent = '载入失败：' + e.message; inner.appendChild(err);
    }
  }

  // ---------- 主导航面板 ----------
  function homePanel(container) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px';
    const title = document.createElement('h3');
    title.textContent = '钱包与生活服务'; title.style.cssText = 'margin:0;color:#07c160';
    head.appendChild(title);
    wrap.appendChild(head);

    // 余额卡
    const balCard = document.createElement('div');
    balCard.style.cssText = 'background:linear-gradient(135deg,#07c160,#05a14f);border-radius:16px;padding:20px;color:#fff;margin-bottom:16px';
    balCard.innerHTML = `<div style="font-size:13px;opacity:.85">我的余额（元）</div>
      <div id="pay-bal" style="font-size:34px;font-weight:800;margin:6px 0">0.00</div>
      <div id="pay-recv" style="font-size:13px;opacity:.85">累计收款 ¥0.00</div>`;
    wrap.appendChild(balCard);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px';
    const items = [
      { label: '转账', icon: '→', fn: openTransfer },
      { label: '收款码', icon: '￥', fn: () => showReceiveCodeFlow() },
      { label: '付款码', icon: '◈', fn: () => Pay.createPayCode().then(r => showCodePanel(r, "pay", () => Pay.createPayCode())).catch(e => showToast('生成失败：' + e.message, 'error')) },
      { label: '扫一扫', icon: '▦', fn: () => scanFlow('receive') },
      { label: '群收款', icon: '群', fn: () => openGroupCollect() },
      { label: '群接龙', icon: '接', fn: () => openGroupSolection() },
      { label: '充值', icon: '充', fn: () => redeemFlow() },
      { label: '缴费', icon: '缴', fn: () => openLifePay() },
    ];
    items.forEach((it) => {
      const cell = document.createElement('button');
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 4px;border:1px solid #f0f0f0;border-radius:12px;background:#fff;cursor:pointer';
      const ic = document.createElement('div');
      ic.style.cssText = 'width:38px;height:38px;border-radius:50%;background:#e6f7ee;color:#07c160;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700';
      ic.textContent = it.icon;
      const lb = document.createElement('div'); lb.textContent = it.label; lb.style.cssText = 'font-size:12px;color:#333';
      cell.appendChild(ic); cell.appendChild(lb);
      cell.onclick = it.fn;
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);

    const sec = document.createElement('div');
    sec.style.cssText = 'font-size:14px;font-weight:600;color:#333;margin:14px 0 8px';
    sec.textContent = '最近账单';
    wrap.appendChild(sec);
    const billsBox = document.createElement('div');
    wrap.appendChild(billsBox);

    container.appendChild(wrap);

    // 加载余额 + 摘要 + 账单
    Pay.wallet().then(w => {
      if (document.getElementById('pay-bal')) document.getElementById('pay-bal').textContent = Number(w.balance).toFixed(2);
      if (document.getElementById('pay-recv')) document.getElementById('pay-recv').textContent = '累计收款 ¥' + Number(w.totalReceived || 0).toFixed(2);
    }).catch(e => {});
    renderBills(billsBox);
  }

  // 兑换码充值（复用巨石 /api/wallet/redeem）
  function redeemFlow() {
    const code = field('兑换码', '', { placeholder: '输入 16 位兑换码' });
    modal('兑换码充值', (body) => body.appendChild(code.w),
      (acts, close) => {
        const go = document.createElement('button');
        go.className = 'btn-primary'; go.textContent = '兑换';
        go.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
        go.onclick = async () => {
          const c = code.inp.value.trim();
          if (!c) { showToast('请输入兑换码', 'warn'); return; }
          try { const r = await Pay.redeem(c); showToast('充值成功 +¥' + r.value + '，余额 ¥' + r.balance, 'success'); close(); }
          catch (e) { showToast('兑换失败：' + e.message, 'error'); }
        };
        acts.appendChild(go);
      });
  }

  // ---------- 导出 & 注册 ----------
  const api = {
    // data
    wallet: Pay.wallet, txn: Pay.txn, redeem: Pay.redeem, transfer: Pay.transfer, friends: Pay.friends, groups: Pay.groups,
    // 收付款码
    createReceiveCode: Pay.createReceiveCode, createPayCode: Pay.createPayCode, myCodes: Pay.myCodes,
    codeInfo: Pay.codeInfo, payByReceiveCode: Pay.payByReceiveCode, chargeByPayCode: Pay.chargeByPayCode,
    // 群收款 / 接龙
    createCollect: Pay.createCollect, groupCollects: Pay.groupCollects, collectDetail: Pay.collectDetail, payCollect: Pay.payCollect,
    createSolection: Pay.createSolection, groupSolections: Pay.groupSolections, solectionDetail: Pay.solectionDetail,
    joinSolection: Pay.joinSolection, leaveSolection: Pay.leaveSolection,
    // 生活
    catalog: Pay.catalog, lifePay: Pay.lifePay, lifeHistory: Pay.lifeHistory,
    // 账单
    bills: Pay.bills, summary: Pay.summary,
    // UI
    homePanel: homePanel, renderBills: renderBills,
    openTransfer: openTransfer, showReceiveCodeFlow: showReceiveCodeFlow, scanFlow: scanFlow,
    openGroupCollect: openGroupCollect, openGroupSolection: openGroupSolection,
    openLifePay: openLifePay, redeemFlow: redeemFlow,
    mount: homePanel,
    api: Pay,
  };

  window.godoMods = window.godoMods || {};
  window.godoMods.pay = api;
  const Ext = window.SecureChatExt;
  if (Ext && typeof Ext.registerFeature === 'function') {
    try {
      if (!Ext.getFeature || !Ext.getFeature('pay')) Ext.registerFeature('pay', api);
    } catch (e) {}
  } else if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    try { window.SecureChatExt.registerFeature('pay', api); } catch (e) {}
  }
})();
