'use strict';

// 独立文字发送控制器：避免主应用其它模块异常时影响发送按钮。
(function () {
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
    const payload = { to: peerId, content: text, clientMsgId: id };

    input.value = '';
    if (typeof saveCurrentDraft === 'function') saveCurrentDraft();
    if (state.pendingLocal) state.pendingLocal[id] = true;
    if (typeof appendMessage === 'function') {
      appendMessage({ id: 'local-' + id, from: state.me.id, to: peerId, content: text, createdAt: Date.now(), clientMsgId: id }, false);
    }

    fetch(state.serverHost + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(payload)
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发送失败');
      if (state.pendingLocal) delete state.pendingLocal[id];
    }).catch((err) => {
      if (typeof toast === 'function') toast('消息发送失败：' + err.message, 'error');
    });
  }

  function bind() {
    const button = document.getElementById('sendBtn');
    const input = document.getElementById('input');
    if (!button || !input) return;
    // 覆盖主应用可能留下的 onclick，避免一次点击触发两套发送逻辑。
    button.onclick = (event) => { event.preventDefault(); sendPlainMessage(); };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendPlainMessage();
    }, true);
    window.sendPlainMessage = sendPlainMessage;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
