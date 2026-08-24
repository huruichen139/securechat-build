'use strict';
// module: rtc (worker batch3)
// 语音/视频通话增强：
//  1. 复用 web/webrtc.js 的 createRtc / getLocalStream（存在则用，缺失则友好降级提示）。
//  2. 信号转发：优先走巨石 app.js 的 WebSocket(P.C_SIGNAL)；
//     若没有 WS（如独立页面 / Web <-> Flutter 跨端），自动落到
//     服务端 REST 信令 /api/rtc/signal + /api/rtc/poll（由 batch3 的 server/routes/rtc.js 提供）。
//  3. 增强通话控制：接听/拒绝/忙线/挂断/扬声器/麦克风开关。
// 以特性形式注册：window.SecureChatExt.registerFeature('rtc', {...})
// 依赖：web/modules/registry.js（需先加载）。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;
  const serverHost = u.serverHost;

  const POLL_INTERVAL = 1800; // ms
  let rtc = null;      // webrtc.js 实例
  let pollTimer = null;
  let polling = false;
  let usingRTC = false; // 是否启用了 REST 轮询桥
  let localStream = null;
  let callPeerId = null;
  let callKind = 'audio';
  let incomingCall = null;

  // ---------- 降级提示 ----------
  function toast(msg, kind) {
    try {
      if (typeof window.toast === 'function') return window.toast(msg, kind || 'info');
    } catch (e) {}
    try { console.warn('[rtc] ' + msg); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }

  // ---------- 复用 webrtc.js ----------
  let wiredRtc = null;
  function ensureRtc() {
    if (rtc) return rtc;
    if (window.rtc) { rtc = window.rtc; wireRtcEvents(); return rtc; }
    if (window.createRtc && u.wsCycleSend) {
      const sendSignal = function (peerId, sub, data) {
        const ok = u.wsCycleSend(sub, peerId, data);
        if (!ok && usingRTC) rtcSignal(peerId, sub, data);
      };
      try {
        rtc = window.createRtc({ sendSignal, selfId: () => (u.getMyId && u.getMyId()) || 0 });
        wireRtcEvents();
      } catch (e) {
        console.warn('[rtc] createRtc failed', e);
      }
    }
    return rtc;
  }

  // ---------- REST 信令桥 ----------
  async function rtcSignal(to, sub, data) {
    if (!apiFn || to == null) return;
    try { await apiFn('POST', '/api/rtc/signal', { body: { to, sub, data } }); } catch (e) {}
  }
  async function pollInbox() {
    if (!apiFn || polling) return;
    polling = true;
    try {
      const res = await apiFn('POST', '/api/rtc/poll', { body: {} });
      const signals = res.signals || [];
      for (const s of signals) handleIncoming(s);
    } catch (e) {} finally {
      polling = false;
    }
  }
  function startPolling() {
    if (pollTimer || !apiFn) return;
    usingRTC = true;
    pollTimer = setInterval(pollInbox, POLL_INTERVAL);
    pollInbox();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    usingRTC = false;
  }

  // ---------- 事件接线（webrtc.js 派发 CustomEvent）----------
  function wireRtcEvents() {
    if (!rtc || wiredRtc === rtc) return;
    wiredRtc = rtc;
    window.addEventListener('rtc-remote-stream', (e) => emit('remote-stream', e.detail));
    window.addEventListener('rtc-state', (e) => emit('state', e.detail));
    window.addEventListener('call-incoming', (e) => {
      incomingCall = { from: e.detail.from, kind: e.detail.kind };
      emit('incoming', e.detail);
    });
    window.addEventListener('call-rejected', () => emit('rejected', {}));
    window.addEventListener('peer-offline', () => emit('offline', {}));
    window.addEventListener('remote-hangup', () => { emit('remote-hangup', {}); reset(); });
  }

  // 简易事件订阅（能力有限，供宿主/UI 接入）
  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) {
    (listeners[evt] || []).forEach((fn) => { try { fn(detail); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('sc-rtc-' + evt, { detail })); } catch (e) {}
  }

  // 收到信令：检查 un-paired 的 REST 信令并交给 webrtc.js / 交互
  async function handleIncoming(s) {
    const { from, sub, data } = s || {};
    if (sub === 'call') {
      incomingCall = { from, kind: data && data.kind };
      if (rtc) { try { await rtc.handleSignal({ from, sub, data }); } catch (e) {} }
      emit('incoming', { from, kind: incomingCall.kind });
      return;
    }
    if (sub === 'hangup') {
      if (rtc) { try { await rtc.handleSignal({ from, sub, data }); } catch (e) {} }
      emit('remote-hangup', { from });
      reset();
      return;
    }
    // offer/answer/ice/call_ack/call_reject/peer_offline 直接交给 webrtc.js
    if (rtc) {
      try { await rtc.handleSignal({ from, sub, data }); }
      catch (e) {
        try { toast('通话信令处理失败', 'warn'); } catch (_) {}
        try { rtc.hangup(from); } catch (_) {}
      }
    } else {
      emit(sub, { from, data });
    }
  }

  // ---------- 对外能力 ----------
  async function startCall(peerId, kind) {
    if (peerId == null) { toast('请先选择联系人', 'warn'); return false; }
    callPeerId = peerId;
    callKind = kind || 'audio';
    emit('calling', { peerId, kind: callKind });
    if (!ensureRtc()) {
      toast('当前端不支持 WebRTC，无法发起通话', 'error');
      return false;
    }
    // 有 WS 就走 WS 信令；否则确保轮询桥在跑
    if (!u.wsCycleSend('call', peerId, { kind: callKind })) startPolling();
    else startPolling(); // WS 为主，rest 兜底（若 WS 断则轮询接管）
    const ok = await getAndAddLocal();
    if (ok) {
      try { await rtc.startCall(peerId, callKind, localStream); } catch (e) {
        try { localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        localStream = null;
        try { rtc.hangup(peerId); } catch (_) {}
        toast('发起通话失败：' + (e.message || e), 'error');
        return false;
      }
    }
    return ok;
  }

  async function acceptCall() {
    if (!incomingCall) return false;
    if (!ensureRtc()) { toast('当前端不支持 WebRTC，无法接听', 'error'); return false; }
    const peerId = incomingCall.from;
    const ok = await getAndAddLocal(incomingCall.kind || 'audio');
    if (!ok) return false;
    try {
      await rtc.acceptCall(peerId, incomingCall.kind || 'audio', localStream);
      callPeerId = peerId; callKind = incomingCall.kind;
      incomingCall = null;
      return true;
    } catch (e) {
      try { localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      localStream = null;
      try { rtc.hangup(peerId); } catch (_) {}
      toast('接听失败：' + (e.message || e), 'error');
      return false;
    }
  }

  function rejectCall() {
    if (!incomingCall) return;
    const peerId = incomingCall.from;
    rtcSignal(peerId, 'hangup', null);
    if (rtc) { try { rtc.hangup(peerId); } catch (e) {} }
    incomingCall = null;
    reset();
  }

  function hangup() {
    if (callPeerId != null) {
      if (rtc) { try { rtc.hangup(callPeerId); } catch (e) {} }
      rtcSignal(callPeerId, 'hangup', null);
    }
    reset();
  }

  function setSpeaker(on) {
    // 浏览器无法强制切换扬声器输出设备（需用户选择输出设备），
    // 此处仅对远端 audio 元素做音量/clamp 与提示，语义为“外放开/关”。
    try {
      const v = document.querySelector('#remoteVideo');
      if (v) v.muted = !on;
    } catch (e) {}
    emit('speaker', !!on);
    return { ok: true, note: '浏览器输出设备由系统控制；已' + (on ? '开启' : '关闭') + '外放音量' };
  }

  function setMic(on) {
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => { try { t.enabled = !!on; } catch (e) {} });
    }
    emit('mic', !!on);
    return !!on;
  }

  function isCalling() { return callPeerId != null; }
  function getCallPeer() { return callPeerId; }

  function reset() {
    callPeerId = null;
    callKind = 'audio';
    incomingCall = null;
    if (localStream) { try { localStream.getTracks().forEach((t) => t.stop()); } catch (e) {} localStream = null; }
    if (rtc) { try { rtc.releaseAllMedia(); } catch (e) {} }
  }

  async function getAndAddLocal(kind) {
    if (!window.getLocalStream) {
      toast('当前端不支持媒体采集（需 HTTPS），无法通话', 'error');
      return false;
    }
    try {
      localStream = await window.getLocalStream(kind || callKind || 'audio');
      return true;
    } catch (e) {
      toast((e && e.message) || '无法访问麦克风/摄像头', 'error');
      return false;
    }
  }

  async function start() {
    // 仅当巨石没有接管 RTC（window.rtc 未初始化）时才需要主动开轮询桥；
    // 这里保守地总是开一个，保证独立页面可用；WS 断掉后作为兜底。
    startPolling();
  }
  function stop() {
    stopPolling();
    reset();
  }

  const feature = {
    name: 'rtc',
    startCall, acceptCall, rejectCall, hangup, setSpeaker, setMic,
    isCalling, getCallPeer, on, start, stop,
    releaseAllMedia: reset,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('rtc', feature);
  } else {
    // 极端情况：registry 未加载
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.rtc = feature;
  }
})();