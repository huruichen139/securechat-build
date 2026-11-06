'use strict';
// module: remind (worker batch8)
// 定时提醒（群聊/单聊）：设置 @某成员 或自己的提醒，到点 server 定时任务推一条提醒消息。
//   - 单聊：直接写入 messages 表 from=0 to=目标用户
//   - 群聊：写入 group_messages（由 server/routes/lifestyle-msg.js 的 setTimeout 队列触发）
// 依赖：web/modules/registry.js。
// 端点：/api/reminders/*。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;

  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDateTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) { (listeners[evt] || []).forEach((f) => { try { f(detail); } catch (e) {} }); }
  try { window.dispatchEvent(new CustomEvent('sc-remind-ready', { detail: {} })); } catch (e) {}

  let reminders = [];

  async function loadMine() {
    if (!apiFn) return [];
    return apiFn('GET', '/api/reminders').then((d) => {
      reminders = d.reminders || [];
      return reminders;
    }).catch((e) => { toast('加载提醒失败：' + (e.message || e), 'error'); return []; });
  }

  // targetType: 'direct'|'group'；targetId: 用户id 或 群id
  async function createReminder({ targetType, targetId, at, content }) {
    const d = await apiFn('POST', '/api/reminders', { body: { targetType, targetId, at, content } });
    toast('提醒已设置，到点将自动推送', 'success');
    return d.reminder;
  }

  async function removeReminder(id) {
    const d = await apiFn('DELETE', '/api/reminders/' + id, { body: {} });
    toast('提醒已删除', 'info');
    return d;
  }

  // ---------- 渲染（我的提醒列表） ----------
  function renderList(container) {
    container.innerHTML =
      '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
      '<div style="font-size:15px;font-weight:600;margin-bottom:10px">我的定时提醒</div>' +
      (reminders.length ? reminders.map((r) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px">' +
        '<div style="flex:1"><div>' + esc(r.content) + '</div>' +
        '<div style="color:#999;font-size:12px">' + (r.targetType === 'group' ? '群#' + r.targetId : '单聊#' + r.targetId) + ' · ' + fmtDateTime(r.at) + (r.fired ? ' · 已触发' : '') + '</div></div>' +
        (r.fired ? '' : '<button class="rm-del" data-id="' + r.id + '" style="border:none;background:#fee;color:#c00;border-radius:16px;padding:4px 10px;cursor:pointer">删除</button>') +
        '</div>').join('') : '<div style="color:#aaa;font-size:13px">暂无提醒</div>') +
      '</div>';
    container.querySelectorAll('.rm-del').forEach((b) => {
      b.onclick = async () => { try { await removeReminder(Number(b.getAttribute('data-id'))); await loadMine(); renderList(container); emit('changed', {}); } catch (e) { toast('删除失败：' + (e.message || e), 'error'); } };
    });
  }

  // 创建提醒弹层：type = 'direct'|'group'，targetId 已定
  // 说明：@某成员时机由群界面选中成员后在单聊/群聊会话弹此面板，targetId 即该成员/群。
  function openCreate({ targetType, targetId, defaultContent }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:20px;width:400px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.2)">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:12px">设置定时提醒</div>' +
      '<div style="font-size:13px;color:#666;margin-bottom:8px">目标：' + (targetType === 'group' ? '群 #' + targetId : '单聊成员 #' + targetId) + '</div>' +
      '<input class="rm-dt" placeholder="提醒时间" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px">' +
      '<div style="font-size:11px;color:#aaa;margin-bottom:8px">时间格式：YYYY-MM-DD HH:mm（如 2026-08-15 18:00）</div>' +
      '<textarea class="rm-ct" placeholder="提醒内容" rows="2" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ddd;border-radius:8px;margin-bottom:12px">' + esc(defaultContent || '') + '</textarea>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="rm-cancel" style="padding:8px 16px;background:#f2f2f2;border:none;border-radius:20px;cursor:pointer">取消</button>' +
      '<button class="rm-confirm" style="padding:8px 16px;background:#07c160;color:#fff;border:none;border-radius:20px;cursor:pointer">确认</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('.rm-cancel').onclick = () => wrap.remove();
    wrap.querySelector('.rm-confirm').onclick = async () => {
      const raw = wrap.querySelector('.rm-dt').value.trim();
      const content = wrap.querySelector('.rm-ct').value.trim();
      const at = parseFmt(raw);
      if (!at) { toast('时间格式无效，请用 YYYY-MM-DD HH:mm', 'warn'); return; }
      if (!content) { toast('请填写提醒内容', 'warn'); return; }
      try {
        await createReminder({ targetType, targetId, at, content });
        wrap.remove();
        await loadMine();
        emit('changed', {});
      } catch (e) { toast('设置失败：' + (e.message || e), 'error'); }
    };
  }

  // 解析 "YYYY-MM-DD HH:mm" -> 时间戳
  function parseFmt(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/.exec(s.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    if (isNaN(d.getTime())) return null;
    return d.getTime();
  }

  const feature = {
    name: 'remind',
    loadMine, createReminder, removeReminder, renderList, openCreate, on,
    getReminders: () => reminders,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('remind', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.remind = feature;
  }
})();