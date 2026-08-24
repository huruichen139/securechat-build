'use strict';

// 独立文字发送控制器：避免主应用其它模块异常时影响发送按钮。
// 支持 E2E 加密:先尝试加密,失败自动降级明文(保持向后兼容)
(function () {
  function encryptIfReady(peerId, text) {
    if (!peerId || !text) return text;
    if (window.SCE2EE) {
      try { const e = window.SCE2EE.encryptFor(peerId, text); if (e && typeof e.then === 'function') { return e.then(ct => { if (ct) return ct; if (!window.__e2eeWarned) { window.__e2eeWarned = true; try { toast('对方密钥不可用，本条消息未加密发送', 'warn'); } catch (_) {} } return text; }); } return e || text; } catch {}
    }
    return text;
  }
  function sendPlainMessage() {
    const input = document.getElementById('input');
    if (!input || typeof state === 'undefined') return;
    if (state.activeGroup) {
      if (typeof sendCurrentGroup === 'function') sendCurrentGroup();
      return;
    }
    const text = input.value.trim();
    const peerId = state.activePeer;
    if (!text || !peerId) return;
    const id = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    // E2E 加密:异步等待后发送,失败降级明文
    const enc = encryptIfReady(peerId, text);
    if (enc && typeof enc.then === 'function') {
      enc.then(async (ct) => {
        const payload = { to: peerId, content: ct || text, clientMsgId: id };
        if (typeof pendingReply !== 'undefined' && pendingReply) payload.replyTo = pendingReply;
        input.value = '';
        if (typeof saveCurrentDraft === 'function') saveCurrentDraft();
        if (state.pendingLocal) state.pendingLocal[id] = true;
        if (typeof appendMessage === 'function') {
          appendMessage({ id: 'local-' + id, from: state.me.id, to: peerId, content: ct || text, createdAt: Date.now(), clientMsgId: id, replyTo: pendingReply || null }, false);
        }
        fetch(state.serverHost + '/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
          body: JSON.stringify(payload)
        }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Send failed');
          if (state.pendingLocal) delete state.pendingLocal[id];
          if (typeof clearPendingReply === 'function') clearPendingReply();
        }).catch((err) => {
          if (typeof toast === 'function') toast('Send failed: ' + err.message, 'error');
        });
      });
      return;
    }
    // 同步降级或 SCE2EE 未就绪
    const payload = { to: peerId, content: enc || text, clientMsgId: id };
    if (typeof pendingReply !== 'undefined' && pendingReply) payload.replyTo = pendingReply;
    input.value = '';
    if (typeof saveCurrentDraft === 'function') saveCurrentDraft();
    if (state.pendingLocal) state.pendingLocal[id] = true;
    if (typeof appendMessage === 'function') {
      appendMessage({ id: 'local-' + id, from: state.me.id, to: peerId, content: enc || text, createdAt: Date.now(), clientMsgId: id, replyTo: pendingReply || null }, false);
    }
    fetch(state.serverHost + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      if (state.pendingLocal) delete state.pendingLocal[id];
      if (typeof clearPendingReply === 'function') clearPendingReply();
    }).catch((err) => {
      if (typeof toast === 'function') toast('Send failed: ' + err.message, 'error');
    });
  }

  function bind() {
    const button = document.getElementById('sendBtn');
    const input = document.getElementById('input');
    if (!button || !input) return;
    button.onclick = (event) => { event.preventDefault(); sendPlainMessage(); };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault(); event.stopImmediatePropagation();
      sendPlainMessage();
    }, true);
    window.sendPlainMessage = sendPlainMessage;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
