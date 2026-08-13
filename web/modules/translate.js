'use strict';
// module: translate (worker batch8)
// 聊天界面长按消息 → 翻译成中文/英文。
// 提供：
//   - translateText(text, target='zh'|'en')：调 /api/translate
//   - attachContextMenu(messageEl, getText)：给消息元素挂长按 → 弹出「翻译/翻译成英文」菜单
// 依赖：web/modules/registry.js。
// 端点：/api/translate（由 server/routes/lifestyle-msg.js 提供，含 mymemory + 词典兜底）。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;

  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }

  // 判断文本是否像中文（用于默认目标语言）
  function looksChinese(text) {
    const zh = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
    return zh > String(text).length * 0.1;
  }

  async function translateText(text, target) {
    const lang = target === 'en' ? 'en' : 'zh';
    if (!apiFn) { toast('翻译服务不可用', 'error'); return null; }
    try {
      const d = await apiFn('POST', '/api/translate', { body: { text: String(text), target: lang } });
      return { translated: d.translated, source: d.source, detected: d.detected };
    } catch (e) {
      toast('翻译失败：' + (e.message || e), 'error');
      return null;
    }
  }

  // 复制
  function copyText(s) {
    try { navigator.clipboard.writeText(s); toast('已复制', 'success'); } catch (e) { try { window.prompt('复制结果：', s); } catch (e2) {} }
  }

  // 长按消息 → 菜单（浏览器兼容：mousedown 计时 600ms，避免与点击冲突）
  function attachContextMenu(messageEl, getText) {
    if (!messageEl) return;
    let timer = null;
    const start = (e) => {
      if (e.button === 2) { showMenu(messageEl, getText); return; }
      timer = setTimeout(() => { showMenu(messageEl, getText); }, 600);
    };
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    messageEl.addEventListener('mousedown', start);
    messageEl.addEventListener('mouseup', clear);
    messageEl.addEventListener('mouseleave', clear);
    messageEl.addEventListener('touchstart', () => { timer = setTimeout(() => showMenu(messageEl, getText), 600); }, { passive: true });
    messageEl.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  }

  function showMenu(messageEl, getText) {
    const text = typeof getText === 'function' ? getText() : (messageEl.textContent || '').trim();
    if (!text) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:transparent;z-index:9998';
    wrap.onmousedown = () => wrap.remove();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:14px;min-width:260px;max-width:88vw;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden;z-index:9999';
    const isZh = looksChinese(text);
    const items = [
      { label: isZh ? '翻译成英文' : '翻译成中文', act: 'en-zh', hideName: true },
    ];
    box.innerHTML =
      '<div style="padding:10px 14px;border-bottom:1px solid #f0f0f0;color:#333">消息内容</div>' +
      '<div style="padding:8px 14px;max-height:120px;overflow:auto;color:#666;font-size:13px;border-bottom:1px solid #f0f0f0">' + esc(text) + '</div>' +
      '<div id="t-acts" style="padding:6px 0"></div>';
    const acts = box.querySelector('#t-acts');
    const mkItem = (label, act) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;font-size:14px;cursor:pointer;color:#07c160';
      b.onmouseenter = () => { b.style.background = '#f6f6f6'; };
      b.onmouseleave = () => { b.style.background = 'none'; };
      b.onclick = async () => {
        wrap.remove();
        const target = act === 'en-zh' ? 'zh' : 'en';
        const res = await translateText(text, target);
        if (res) showResult(text, res, target);
      };
      acts.appendChild(b);
    };
    mkItem(isZh ? '翻译成英文' : '翻译成中文', 'en-zh');
    mkItem('翻译成中文', 'to-zh');
    mkItem('翻译成英文', 'to-en');
    mkItem('复制原文', 'copy');
    const bCopy = Array.from(acts.children).find((b) => b.textContent === '复制原文');
    bCopy.onclick = () => { wrap.remove(); copyText(text); };
    // 复制覆盖掉 on 命名冲突上的行为
    wrap.appendChild(box);
    document.body.appendChild(wrap);
  }

  function showResult(original, res, target) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#fff;border-radius:12px;padding:14px 18px;max-width:88vw;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:9999';
    d.innerHTML =
      '<div style="font-size:12px;color:#999;margin-bottom:4px">翻译结果（' + (target === 'zh' ? '中文' : '英文') + '）</div>' +
      '<div style="font-size:15px;color:#333;margin-bottom:8px">' + esc(res.translated) + '</div>' +
      '<div style="display:flex;gap:8px">' +
      '<button class="tr-copy" style="padding:5px 12px;background:#eee;border:none;border-radius:16px;cursor:pointer;font-size:12px">复制</button>' +
      '<button class="tr-close" style="padding:5px 12px;background:#07c160;color:#fff;border:none;border-radius:16px;cursor:pointer;font-size:12px">关闭</button>' +
      (res.source === 'mymemory' ? '<span style="font-size:11px;color:#aaa;align-self:center">· 在线翻译</span>' : '<span style="font-size:11px;color:#aaa;align-self:center">· 本地词典</span>') +
      '</div>';
    document.body.appendChild(d);
    d.querySelector('.tr-close').onclick = () => d.remove();
    d.querySelector('.tr-copy').onclick = () => { copyText(res.translated); };
    setTimeout(() => d.remove(), 15000);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const feature = {
    name: 'translate',
    translateText, attachContextMenu, looksChinese,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('translate', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.translate = feature;
  }
})();