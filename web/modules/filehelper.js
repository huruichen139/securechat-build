'use strict';
// module: filehelper (worker batch3)
// 文件传输助手：一个固定「文件传输助手」会话（保留虚拟 peer_id = -1，复用 messages 表）。
// 可发文件 / 文字到它，再从任意端取用（跨 Web/Flutter）。
// 端点：直接复用 /api/messages 与 /api/history/-1；
//       文件上传/下载走 batch3 自己的 /api/rtc/filehelper/*（由 server/routes/rtc.js 提供）。
// 依赖：web/modules/registry.js。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;
  const serverHost = u.serverHost;

  const FILEHELPER_ID = -1;
  const NAME = '文件传输助手';
  let mountEl = null;
  let messages = [];
  const listeners = {};

  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) {
    (listeners[evt] || []).forEach((fn) => { try { fn(detail); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('sc-filehelper-' + evt, { detail })); } catch (e) {}
  }
  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function humanSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }

  // ---------- 数据 ----------
  function parseMarker(content) {
    // 文本/文件/语音三种形态
    const file = /^文件:([0-9a-f-]{8,}):(\{.*\})$/.exec(String(content || ''));
    if (file) {
      let meta = {};
      try { meta = JSON.parse(file[2]); } catch (e) {}
      return { kind: 'file', id: file[1], name: meta.name || '文件', mime: meta.mime || '', size: meta.size || 0 };
    }
    const voice = /^\[语音消息:([0-9a-f-]{8,})\]$/.exec(String(content || ''));
    if (voice) return { kind: 'voice', id: voice[1], name: '语音消息', mime: 'audio/webm' };
    if (content === '文件:DELETED') return { kind: 'deleted', name: '(已删除)' };
    return { kind: 'text', text: String(content || '') };
  }

  async function loadHistory() {
    if (!apiFn) return [];
    const data = await apiFn('GET', '/api/history/' + FILEHELPER_ID);
    const rows = data.messages || [];
    messages = rows.map((r) => ({
      id: r.id,
      mine: Number(r.from) === Number(u.getMyId && u.getMyId()),
      time: fmtTime(r.createdAt),
      raw: r.content,
      ...parseMarker(r.content),
    }));
    emit('history', messages);
    return messages;
  }

  async function sendText(text) {
    if (!text || !text.trim()) return false;
    await apiFn('POST', '/api/messages', { body: { to: FILEHELPER_ID, content: text.trim() } });
    await loadHistory();
    return true;
  }

  async function sendFile(fileBlob, name) {
    if (!apiFn) return false;
    try {
      const data = await apiFn('POST', '/api/rtc/filehelper/upload?name=' + encodeURIComponent(name || 'file'), { raw: fileBlob });
      await loadHistory();
      return data;
    } catch (e) { toast('文件上传失败：' + (e.message || e), 'error'); return null; }
  }

  function pickAndSendFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      sendFile(f, f.name);
    };
    input.click();
  }

  function fileUrl(id) {
    return serverHost() + '/api/rtc/filehelper/file/' + encodeURIComponent(id) + (u.getToken ? '?t=' + encodeURIComponent(u.getToken()) : '');
  }
  async function downloadFile(id, name) {
    const a = document.createElement('a');
    a.href = fileUrl(id); a.download = name || 'file';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function removeFile(id) {
    await apiFn('DELETE', '/api/rtc/filehelper/file/' + encodeURIComponent(id));
    await loadHistory();
  }

  // ---------- 渲染 ----------
  function render() {
    if (!mountEl) return;
    const mine = (r) => (r.mine ? 'fh-msg mine' : 'fh-msg');
    mountEl.innerHTML =
      '<div class="fh-head">' + esc(NAME) +
      '<button class="fh-close" title="关闭">×</button></div>' +
      '<div class="fh-body">' +
      messages.map((r) => {
        if (r.kind === 'file') {
          return `<div class="${mine(r)}"><span class="fh-file">[文件] ${esc(r.name)} (${humanSize(r.size)})</span>` +
            `<span class="fh-ops"><button data-act="open" data-id="${r.id}" data-name="${esc(r.name)}">打开</button>` +
            `<button data-act="del" data-id="${r.id}">删除</button></span></div>`;
        }
        if (r.kind === 'voice') {
          return `<div class="${mine(r)}"><span class="fh-voice">[语音] ${esc(r.name)}</span>` +
            `<span class="fh-ops"><button data-act="voice" data-id="${r.id}">播放</button></span></div>`;
        }
        if (r.kind === 'deleted') return `<div class="${mine(r)}"><span class="fh-deleted">(${esc(r.name)})</span></div>`;
        return `<div class="${mine(r)}"><span class="fh-text">${esc(r.text)}</span></div>`;
      }).join('') +
      '<div class="fh-empty">（暂无内容，发送文件或文字到文件传输助手）</div>' +
      '</div>' +
      '<div class="fh-foot"><input class="fh-input" placeholder="输入，Enter 发送" /><button class="fh-send">发送</button><button class="fh-file">文件</button></div>';
    bindEvents();
  }

  function bindEvents() {
    const q = (sel) => mountEl.querySelector(sel);
    mountEl.querySelector('.fh-close').onclick = () => close();
    const input = q('.fh-input');
    q('.fh-send').onclick = () => { if (input.value) { sendText(input.value); input.value = ''; } };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (input.value) { sendText(input.value); input.value = ''; } } };
    q('.fh-file').onclick = () => pickAndSendFile();
    mountEl.querySelectorAll('.fh-msg [data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name') || 'file';
        if (act === 'open') downloadFile(id, name);
        else if (act === 'del') removeFile(id);
        else if (act === 'voice') {
          const vis = window.SecureChatExt && window.SecureChatExt.getFeature && window.SecureChatExt.getFeature('voicemsg');
          if (vis && vis.playback) vis.playback(fileUrl(id));
          else downloadFile(id, name);
        }
      };
    });
  }

  // ---------- 挂载 UI ----------
  function mount(target) {
    close();
    mountEl = document.createElement('div');
    mountEl.className = 'filehelper-panel';
    (target || document.body).appendChild(mountEl);
    loadHistory().then(render).catch(() => render());
    emit('mount', {});
  }
  function close() {
    if (mountEl && mountEl.parentNode) mountEl.parentNode.removeChild(mountEl);
    mountEl = null;
  }
  function isOpen() { return !!mountEl; }

  const feature = {
    name: 'filehelper',
    id: FILEHELPER_ID, name: NAME,
    mount, close, isOpen, loadHistory, sendText, sendFile, pickAndSendFile, downloadFile, removeFile, on,
    getMessages: () => messages,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('filehelper', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.filehelper = feature;
  }
})();