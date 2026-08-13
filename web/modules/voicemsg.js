'use strict';
// module: voicemsg (worker batch3)
// 按住录音（MediaRecorder, webm）→ 上传 server /api/files → 以 [语音消息:uuid] 消息发送。
// 端能力：
//  - start()/stop()/cancel()：按住说话（component 会把指针按下/松开映射到这里）
//  - sendRecorded(to)：把刚录好的音频上传 + 发送
//  - processFile(to, file/blob, name)：任意来源音频/blob 直接上传发送（降级：没有 MediaRecorder 的端）
//  - playback(url)：用 audio 元素播放一条语音
// 依赖：web/modules/registry.js；上传复用服务端现有 /api/files（不在本 worker 重写）。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;
  const serverHost = u.serverHost;

  let recorder = null;
  let chunks = [];
  let blob = null;
  let startTs = 0;
  let timer = null;
  let duration = 0;
  let recording = false;

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) {
    (listeners[evt] || []).forEach((fn) => { try { fn(detail); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('sc-voicemsg-' + evt, { detail })); } catch (e) {}
  }
  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function fmt(s) { return (s / 1000).toFixed(1) + 's'; }

  // 开始录音（按住）
  async function start() {
    if (recording) return;
    if (!supported()) { toast('当前端不支持录音（需 HTTPS + WebM 编码）', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recorder = new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { stop(false); toast('录音出错', 'error'); };
      recorder.start();
      recording = true;
      startTs = Date.now();
      duration = 0;
      timer = setInterval(() => {
        duration = Date.now() - startTs;
        emit('progress', { duration });
      }, 100);
      emit('start', {});
      // 兼容：1 分钟上限，避免误触导致过久后台录音
      setTimeout(() => { if (recording) stop(); }, 60000);
    } catch (e) {
      toast((e && e.message) || '无法获取麦克风', 'error');
    }
  }

  // 停止录音：canvas=success 则保留，否则丢弃（配合“上滑取消”）
  function stop(cancel) {
    if (!recording) return null;
    if (timer) { clearInterval(timer); timer = null; }
    recording = false;
    const ms = Date.now() - startTs;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
    emit('stop', { duration: ms });
    if (cancel) { reset(); return null; }
    if (!chunks.length) { reset(); toast('没有录到声音', 'warn'); return null; }
    const type = (chunks[0] && chunks[0].type) || 'audio/webm';
    blob = new Blob(chunks, { type });
    chunks = [];
    duration = ms;
    emit('ready', { duration: ms, size: blob.size });
    try { if (recorder && recorder.stream) recorder.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    return blob;
  }

  function cancel() {
    if (recording) stop(true);
    reset();
  }

  function reset() {
    if (timer) { clearInterval(timer); timer = null; }
    recording = false;
    recorder = null; chunks = []; blob = null; duration = 0;
    try { if (recorder && recorder.stream) recorder.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  }

  // 上传 + 发送：把音频字节 POST 到 /api/files（发送给 to），然后以客户端消息方式发送文本 marker
  async function sendRecorded(to, { name, clientMsgId } = {}) {
    const r = (blob || chunks.length ? new Blob(chunks, { type: 'audio/webm' }) : null);
    if (!r) { toast('请先录音', 'warn'); return null; }
    const id = await uploadBytes(to, r, name || ('voice-' + Date.now() + '.webm'));
    blob = null; chunks = [];
    return id;
  }

  // 任意来源（文件选择 / 其它端）：直接上传，返回 {id, data}
  async function uploadBytes(to, byteSource, name) {
    if (to == null) { toast('请先选择接收人', 'warn'); return null; }
    if (!apiFn) { toast('API 不可用', 'error'); return null; }
    try {
      const data = await apiFn('POST', '/api/files' + (name ? '?name=' + encodeURIComponent(name) + '&mime=audio/webm' : ''), { raw: byteSource });
      emit('sent', { id: data.id, to });
      return data;
    } catch (e) {
      toast('语音上传失败：' + (e.message || e), 'error');
      return null;
    }
  }

  // 通过巨石发送通道发消息（如果存在 app.js 的 send）
  function sendAsText(to, marker, clientMsgId) {
    try {
      if (window.socket && typeof window.send === 'function') {
        window.send('msg', { to, content: marker, clientMsgId });
        return true;
      }
    } catch (e) {}
    // REST 兜底：/api/messages
    if (apiFn) { apiFn('POST', '/api/messages', { body: { to, content: marker, clientMsgId } }); return true; }
    return false;
  }

  // 便捷：录音 → 上传 → 发送一气呵成（按住结束回调调用）
  async function recordAndSend(to, { cancelPrev, ignoreDuration } = {}) {
    const r = stop(cancelPrev);
    if (!r) return null;
    if (!ignoreDuration && duration < 500) { toast('说话时间过短', 'warn'); return null; }
    const id = await uploadBytes(to, r, 'voice-' + Date.now() + '.webm');
    if (!id) return null;
    const marker = '[语音消息:' + id.id + ']';
    sendAsText(to, marker, 'v' + Date.now() + Math.floor(Math.random() * 999));
    return id;
  }

  // 播放
  function playback(url) {
    if (!url) return;
    const el = document.createElement('audio');
    el.src = url; el.controls = true; el.style.display = 'none';
    document.body.appendChild(el);
    el.play().catch(() => {});
    el.onended = () => el.remove();
  }

  const feature = {
    name: 'voicemsg',
    supported, start, stop, cancel, reset, recordAndSend, uploadBytes, sendRecorded, playback, on, isRecording: () => recording,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('voicemsg', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.voicemsg = feature;
  }
})();