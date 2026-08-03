'use strict';
// WebRTC 封装：语音/视频通话 + 文件传输（DataChannel），信令通过 chat WS 转发
// 依赖：页面提供 sendSignal(to, sub, data) 与 onSignal/from 处理；及对方 userId

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.qq.com:3478' }
];

// 单例：与某个 peer 的 PeerConnection + 多个 DataChannel（文件）+ media stream
function createRtc(ctx) {
  // ctx = { sendSignal(peerId, sub, data), selfId() }
  const peers = new Map(); // peerId -> { pc, dc, stream, kind, fileRecv }

  function ensurePc(peerId) {
    let entry = peers.get(peerId);
    if (entry && entry.pc) return entry;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const e = entry || { pc, dc: null, stream: null, kind: null, fileRecv: null };
    e.pc = pc;
    peers.set(peerId, e);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) ctx.sendSignal(peerId, 'ice', ev.candidate);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        // 通知 UI
        window.dispatchEvent(new CustomEvent('rtc-state', { detail: { peerId, state: s } }));
      } else {
        window.dispatchEvent(new CustomEvent('rtc-state', { detail: { peerId, state: s } }));
      }
    };
    pc.ontrack = (ev) => {
      e.stream = ev.streams[0];
      window.dispatchEvent(new CustomEvent('rtc-remote-stream', { detail: { peerId, stream: e.stream, kind: e.kind } }));
    };
    pc.ondatachannel = (ev) => {
      e.dc = ev.channel;
      bindDc(peerId, e.dc);
    };
    return e;
  }

  // ---------- 通话：audio/video ----------
  async function startCall(peerId, kind /* 'audio' | 'video' */, localStream) {
    const e = ensurePc(peerId);
    e.kind = kind;
    // 添加本地轨道
    if (localStream) {
      e.localStream = localStream;
      for (const tr of localStream.getTracks()) e.pc.addTrack(tr, localStream);
    }
    // 创建 DataChannel 备用（文件）
    try {
      const dc = e.pc.createDataChannel('file', { ordered: true });
      e.dc = dc;
      bindDc(peerId, dc);
    } catch (err) {}
    const offer = await e.pc.createOffer();
    await e.pc.setLocalDescription(offer);
    ctx.sendSignal(peerId, 'offer', { sdp: offer, kind });
  }

  async function onOffer(peerId, data) {
    const e = ensurePc(peerId);
    e.kind = data.kind || e.kind;
    await e.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await e.pc.createAnswer();
    await e.pc.setLocalDescription(answer);
    ctx.sendSignal(peerId, 'answer', { sdp: answer, kind: e.kind });
  }

  async function onAnswer(peerId, data) {
    const e = peers.get(peerId);
    if (!e || !e.pc) return;
    await e.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }

  async function onIce(peerId, candidate) {
    const e = peers.get(peerId);
    if (!e || !e.pc) return;
    try { await e.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
  }

  function hangup(peerId) {
    const e = peers.get(peerId);
    if (!e) return;
    try { if (e.localStream) e.localStream.getTracks().forEach((t) => t.stop()); } catch (err) {}
    try { if (e.pc) e.pc.close(); } catch (err) {}
    peers.delete(peerId);
    window.dispatchEvent(new CustomEvent('rtc-state', { detail: { peerId, state: 'closed' } }));
  }

  // 等 DC open；role='offer' 时先 createDataChannel + 协商 offer/answer
  function openDc(peerId, e, role) {
    return new Promise((resolve, reject) => {
      const dead = setTimeout(() => reject(new Error('datachannel 超时（25s）')), 25000);
      // 已有且 open 立即返回
      if (e.dc && e.dc.readyState === 'open') { clearTimeout(dead); resolve(e.dc); return; }

      const onOpen = () => { clearTimeout(dead); cleanup(); resolve(e.dc); };
      const onState = () => {
        const s = e.pc.connectionState;
        if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          clearTimeout(dead); cleanup(); reject(new Error('连接失败: ' + s));
        }
      };
      function cleanup() {
        if (e.dc) e.dc.removeEventListener('open', onOpen);
        if (e.pc) e.pc.removeEventListener('connectionstatechange', onState);
      }
      if (e.pc) e.pc.addEventListener('connectionstatechange', onState);

      if (role === 'offer') {
        // 发起方：建 DC + 发 offer 让双方协商
        if (!e.dc) {
          e.dc = e.pc.createDataChannel('file', { ordered: true });
          bindDc(peerId, e.dc);
        }
        e.dc.addEventListener('open', onOpen, { once: true });
        (async () => {
          try {
            const offer = await e.pc.createOffer();
            await e.pc.setLocalDescription(offer);
            ctx.sendSignal(peerId, 'offer', { sdp: offer, kind: 'file' });
          } catch (err) { clearTimeout(dead); cleanup(); reject(err); }
        })();
      } else {
        // 对端已发起 DC，PC.ondatachannel 会赋 e.dc；等其 open
        if (!e.dc) { clearTimeout(dead); cleanup(); reject(new Error('无可用 DataChannel')); return; }
        e.dc.addEventListener('open', onOpen, { once: true });
      }
    });
  }

  // ---------- 文件传输：DataChannel 分块 ----------
  async function sendFile(peerId, file, onProgress) {
    let e = peers.get(peerId);
    const ready = !!(e && e.pc && e.pc.connectionState === 'connected' && e.dc && e.dc.readyState === 'open');
    if (!ready) {
      if (e && e.pc) { try { e.pc.close(); } catch {} peers.delete(peerId); }
      e = ensurePc(peerId);
    }
    const dc = await openDc(peerId, e, ready ? null : 'offer');

    // 发 meta
    dc.send(JSON.stringify({ t: 'meta', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));

    // 分块发送（带背压）
    const chunk = 16 * 1024;
    let offset = 0;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      const pump = () => {
        if (offset >= file.size) { dc.send(JSON.stringify({ t: 'done' })); resolve(); return; }
        if (dc.bufferedAmount > 4 * 1024 * 1024) { setTimeout(pump, 20); return; }
        reader.readAsArrayBuffer(file.slice(offset, offset + chunk));
      };
      reader.onload = () => {
        try {
          dc.send(reader.result);
          offset += reader.result.byteLength || reader.result.size;
          if (onProgress) onProgress(offset, file.size);
          pump();
        } catch (err) { reject(err); }
      };
      pump();
    });
  }

  function bindDc(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      const e = peers.get(peerId);
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'meta') {
          e.fileRecv = { name: m.name, size: m.size, mime: m.mime, chunks: [], received: 0 };
          window.dispatchEvent(new CustomEvent('file-start', { detail: { peerId, name: m.name, size: m.size } }));
        } else if (m.t === 'done') {
          const f = e.fileRecv;
          if (!f) return;
          const blob = new Blob(f.chunks, { type: f.mime });
          const url = URL.createObjectURL(blob);
          window.dispatchEvent(new CustomEvent('file-done', { detail: { peerId, name: f.name, size: f.size, url } }));
          e.fileRecv = null;
        }
      } else {
        const e2 = peers.get(peerId);
        const f = e2.fileRecv;
        if (!f) return;
        f.chunks.push(ev.data);
        f.received += ev.data.byteLength;
        window.dispatchEvent(new CustomEvent('file-progress', { detail: { peerId, received: f.received, size: f.size } }));
      }
    };
    dc.onopen = () => window.dispatchEvent(new CustomEvent('dc-open', { detail: { peerId } }));
    dc.onclose = () => window.dispatchEvent(new CustomEvent('dc-close', { detail: { peerId } }));
  }

  // 对外：处理收到的信令
  async function handleSignal(msg) {
    const { from, sub, data } = msg || {};
    if (sub === 'offer') await onOffer(from, data);
    else if (sub === 'answer') await onAnswer(from, data);
    else if (sub === 'ice') await onIce(from, data);
    else if (sub === 'hangup') hangup(from);
    else if (sub === 'call') window.dispatchEvent(new CustomEvent('call-incoming', { detail: { from, kind: data && data.kind } }));
    else if (sub === 'call_reject') window.dispatchEvent(new CustomEvent('call-rejected', { detail: { from } }));
    else if (sub === 'peer_offline') window.dispatchEvent(new CustomEvent('peer-offline', { detail: { from } }));
  }

  return { startCall, hangup, sendFile, handleSignal, ensurePc };
}

// 工具：获取本地媒体
async function getLocalStream(kind) {
  const constraints = kind === 'video'
    ? { video: { width: 640, height: 480 }, audio: true }
    : { audio: true, video: false };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

if (typeof window !== 'undefined') window.createRtc = createRtc;
if (typeof window !== 'undefined') window.getLocalStream = getLocalStream;
