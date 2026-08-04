'use strict';

/* ===========================================================
   AI 助手模块（纯前端，关键 API key 仅存 localStorage，不上服务器）
   - 支持 OpenAI 兼容协议 /chat/completions
   - 通过预设快速填好 baseUrl / model
   =========================================================== */

// ============ 预设供应商 ============
const AI_PRESETS = {
  acu: {
    name: 'ACU 聚合 API',
    baseUrl: 'https://api.ltzy.top/v1',
    defaultModel: 'deepseek-ai/deepseek-v4-flash',
    desc: 'AQUA 公益 AI OpenAI 兼容接口'
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    desc: 'OpenAI 官方'
  },
  anthropic: {
    name: 'Anthropic Claude',
    // Anthropic 自身不是 OpenAI 兼容协议，这里默认通过 OpenRouter 转接
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    desc: '通过 OpenRouter 接入 Claude（需 OpenRouter API key）'
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    desc: '深度求索'
  },
  glm: {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    desc: '智谱 AI，OpenAI 兼容'
  },
  kimi: {
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    desc: '月之暗面 Kimi'
  },
  qwen: {
    name: '通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    desc: '阿里 DashScope OpenAI 兼容模式'
  },
  baichuan: {
    // 百川暂未提供稳定的 OpenAI 兼容端点，先用 OpenRouter 转接
    name: '百川',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'baichuan/baichuan-7b',
    desc: '通过 OpenRouter 接入百川（或自定义填入官方 baseUrl）'
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    desc: 'Groq 高速推理'
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    desc: '聚合多家提供商'
  },
  custom: {
    name: '自定义',
    baseUrl: '',
    defaultModel: '',
    desc: '任意 OpenAI 兼容端点'
  }
};

const AI_STORAGE_KEY = 'sc_ai_config';
const AI_HISTORY_KEY = 'sc_ai_history';

// 内存中的会话历史（随刷新清掉也无所谓；历史仅用于拼装上下文）
let aiHistory = [];

function aiHistoryKey() {
  try {
    const me = JSON.parse(localStorage.getItem('sc_me') || 'null');
    return AI_HISTORY_KEY + '_' + (me && me.id ? me.id : 'guest');
  } catch { return AI_HISTORY_KEY + '_guest'; }
}
function saveAiHistory() {
  // 保留最近 100 条展示消息，同时限制请求上下文仍为最近 20 条。
  try { localStorage.setItem(aiHistoryKey(), JSON.stringify(aiHistory.slice(-100))); } catch {}
}
function restoreAiHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(aiHistoryKey()) || '[]');
    aiHistory = Array.isArray(saved) ? saved.filter(x => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string').slice(-100) : [];
  } catch { aiHistory = []; }
  const box = document.getElementById('aiMessages');
  if (!box) return;
  box.innerHTML = '';
  aiHistory.forEach(item => appendAiMsg(item.role, item.content));
}

// ============ 持久化 ============
function getAiConfig() {
  try {
    const raw = localStorage.getItem(AI_STORAGE_KEY);
    if (!raw) return defaultAiConfig();
    const c = JSON.parse(raw);
    // 兼容老数据：缺失字段补默认
    const def = defaultAiConfig();
    const baseUrl = c.baseUrl || def.baseUrl;
    // 兼容曾填写过的控制台域名：实际推理接口在 api.ltzy.top。
    const normalizedBaseUrl = baseUrl.replace(/^https:\/\/acu\.ltzy\.top\/v1\/?$/i, 'https://api.ltzy.top/v1');
    return {
      preset: c.preset || def.preset,
      baseUrl: normalizedBaseUrl,
      apiKey: c.apiKey || '',
      model: c.model || def.model,
      systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : def.systemPrompt
    };
  } catch {
    return defaultAiConfig();
  }
}
function setAiConfig(c) {
  localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({
    preset: c.preset || 'custom',
    baseUrl: c.baseUrl || '',
    apiKey: c.apiKey || '',
    model: c.model || '',
    systemPrompt: c.systemPrompt || ''
  }));
}
function defaultAiConfig() {
  return {
    preset: 'openai',
    baseUrl: AI_PRESETS.openai.baseUrl,
    apiKey: '',
    model: AI_PRESETS.openai.defaultModel,
    systemPrompt: '你是一位友善的中文助手，回答简洁有用。'
  };
}

// ============ 渲染消息气泡 ============
// 复用主聊天 .msg-row .bubble 的 me/other 样式
function appendAiMsg(role, content) {
  const box = document.getElementById('aiMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (role === 'user' ? 'me' : 'other');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content; // textContent 自动转义
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtAiTime(Date.now());
  row.appendChild(bubble);
  row.appendChild(time);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function fmtAiTime(t) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

// ============ 发送 ============
async function sendAi(text) {
  const cfg = getAiConfig();
  if (!text) return;
  if (!cfg.apiKey) {
    appendAiMsg('assistant', '尚未配置 API Key，请点击右上角 ⚙️ 设置。');
    openAiSettings();
    return;
  }
  if (!cfg.baseUrl) {
    appendAiMsg('assistant', '尚未配置 baseUrl，请点击 ⚙️ 设置。');
    openAiSettings();
    return;
  }
  if (!cfg.model) {
    appendAiMsg('assistant', '尚未配置 model，请点击 ⚙️ 设置。');
    openAiSettings();
    return;
  }

  appendAiMsg('user', text);

  // 拼装消息列表：system + 历史 + 当前 user
  const messages = [];
  if (cfg.systemPrompt && cfg.systemPrompt.trim()) {
    messages.push({ role: 'system', content: cfg.systemPrompt });
  }
  aiHistory.slice(-20).forEach(h => messages.push(h));
  messages.push({ role: 'user', content: text });
  // 本地保存进历史
  aiHistory.push({ role: 'user', content: text });
  // 展示记录保留最近 100 条；请求上下文在上方限制为最近 20 条。
  if (aiHistory.length > 100) aiHistory = aiHistory.slice(-100);
  saveAiHistory();

  // 显示"对方正在思考..."占位气泡，等服务端回来后再替换内容
  const box = document.getElementById('aiMessages');
  const pendingRow = document.createElement('div');
  pendingRow.className = 'msg-row other';
  const pendingBubble = document.createElement('div');
  pendingBubble.className = 'bubble';
  pendingBubble.textContent = '正在思考...';
  pendingRow.appendChild(pendingBubble);
  box.appendChild(pendingRow);
  box.scrollTop = box.scrollHeight;

    // 优先使用同源后端代理，避免 OpenAI/DeepSeek 等接口的浏览器 CORS 问题。
    const url = (window.SERVER_HOST || '') + '/api/ai/chat';
    try {
      const res = await fetch(url, {
      method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('sc_token') || '')
        },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
        messages: messages,
        stream: false
      })
    });
    if (!res.ok) {
      let errTxt = 'HTTP ' + res.status;
      try {
        const ej = await res.json();
        if (ej && ej.error) {
          errTxt += ' ' + (typeof ej.error === 'string' ? ej.error : (ej.error.message || JSON.stringify(ej.error)));
        }
      } catch {}
      pendingBubble.textContent = '调用失败：' + errTxt;
      return;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      pendingRow.remove();
      appendAiMsg('assistant', '调用失败：服务器返回格式异常。请检查 AI Base URL。');
      return;
    }
    // OpenAI-compatible providers normally use choices[0].message.content,
    // but expose useful errors or alternative text fields in other shapes.
    const choice = data && data.choices && data.choices[0];
    const reply = choice && choice.message ? choice.message.content
      : (choice && choice.text ? choice.text : (data && (data.output_text || data.content)));
    pendingRow.remove();
    if (reply) {
      appendAiMsg('assistant', reply);
      aiHistory.push({ role: 'assistant', content: reply });
      if (aiHistory.length > 100) aiHistory = aiHistory.slice(-100);
      saveAiHistory();
    } else {
      const detail = data && data.error
        ? (typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error)))
        : (data && data.message ? data.message : '响应中没有 choices[0].message.content');
      appendAiMsg('assistant', '调用失败：' + detail);
    }
  } catch (e) {
    pendingRow.remove();
    appendAiMsg('assistant', '调用失败：' + (e && e.message ? e.message : String(e)));
  }
}

// ============ 设置弹窗（专用 DOM，不复用 openModal，因为需要 select） ============
function openAiSettings() {
  const cfg = getAiConfig();

  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  const box = document.createElement('div');
  box.className = 'modal';
  box.style.width = '360px';

  const title = document.createElement('h3');
  title.textContent = 'AI 助手设置';
  box.appendChild(title);

  // 预设下拉
  const fldPreset = document.createElement('div');
  fldPreset.className = 'field';
  fldPreset.innerHTML = '<label>提供商预设</label>';
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;background:#fff;';
  Object.keys(AI_PRESETS).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = AI_PRESETS[k].name + (AI_PRESETS[k].desc ? ' — ' + AI_PRESETS[k].desc : '');
    if (k === cfg.preset) opt.selected = true;
    sel.appendChild(opt);
  });
  fldPreset.appendChild(sel);
  box.appendChild(fldPreset);

  // baseUrl
  const fldBase = makeField('baseUrl', 'Base URL（OpenAI 兼容）', cfg.baseUrl, 'https://api.openai.com/v1');
  box.appendChild(fldBase.wrap);
  // apiKey（用 password 类型）
  const fldKey = makeField('apiKey', 'API Key（仅保存在本机浏览器）', cfg.apiKey, 'sk-...', 'password');
  box.appendChild(fldKey.wrap);
  // model
  const fldModel = makeField('model', '模型名', cfg.model, 'gpt-4o-mini');
  box.appendChild(fldModel.wrap);
  // systemPrompt
  const fldSys = makeField('systemPrompt', '系统提示词（System Prompt）', cfg.systemPrompt, '你是一位友善的中文助手。');
  box.appendChild(fldSys.wrap);

  // 预设切换自动填 baseUrl/model
  sel.addEventListener('change', () => {
    const k = sel.value;
    const p = AI_PRESETS[k];
    if (!p) return;
    if (p.baseUrl) fldBase.input.value = p.baseUrl;
    if (p.defaultModel) fldModel.input.value = p.defaultModel;
  });

  // 按钮
  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'cancel'; cancel.textContent = '取消';
  const ok = document.createElement('button');
  ok.className = 'ok'; ok.textContent = '保存';
  acts.appendChild(cancel);
  acts.appendChild(ok);
  box.appendChild(acts);

  mask.appendChild(box);
  document.body.appendChild(mask);

  const close = () => mask.remove();
  cancel.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  ok.onclick = () => {
    const newCfg = {
      preset: sel.value,
      baseUrl: fldBase.input.value.trim(),
      apiKey: fldKey.input.value.trim(),
      model: fldModel.input.value.trim(),
      systemPrompt: fldSys.input.value
    };
    setAiConfig(newCfg);
    close();
    if (window.toast) window.toast('AI 设置已保存（仅本机）', 'success', 1500);
    else if (typeof toast === 'function') toast('AI 设置已保存（仅本机）', 'success', 1500);
  };

  // 工具：生成字段 DOM
  function makeField(key, label, value, placeholder, type) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML = '<label>' + label + '</label>';
    const input = document.createElement('input');
    input.type = type || 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.style.cssText = 'width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;background:#fff;';
    wrap.appendChild(input);
    return { wrap, input };
  }
}

// ============ 入口绑定 ============
function bindAiEntry() {
  const sendBtn = document.getElementById('aiSendBtn');
  const aiInput = document.getElementById('aiInput');
  const settingsBtn = document.getElementById('aiSettingsBtn');
  if (sendBtn) sendBtn.onclick = () => {
    const text = aiInput ? aiInput.value.trim() : '';
    if (!text) return;
    aiInput.value = '';
    sendAi(text);
  };
  if (aiInput) aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = aiInput.value.trim();
      if (!text) return;
      aiInput.value = '';
      sendAi(text);
    }
  });
  if (settingsBtn) settingsBtn.onclick = openAiSettings;
}

// ============ 切换到 AI 视图 ============
// 由 app.js 的 side-tab onclick 通过 window.switchToAi() 调用
window.switchToAi = function () {
  const main = document.querySelector('.main');
  const aiView = document.getElementById('aiView');
  if (main) main.style.display = 'none';
  if (aiView) aiView.style.display = 'flex';
  // 侧边栏上下区域：AI 模式下隐藏好友/群组操作条
  const fs = document.getElementById('friendsSide');
  const gs = document.getElementById('groupsSide');
  if (fs) fs.style.display = 'none';
  if (gs) gs.style.display = 'none';
  // 未配置则自动弹设置
  const cfg = getAiConfig();
  if (!cfg.apiKey) openAiSettings();
  // 聚焦输入框
  const aiInput = document.getElementById('aiInput');
  if (aiInput) aiInput.focus();
};

// 切回好友/群组时由 app.js 调用此 helper（也可以不调，ai.js 自身监听）
window.hideAiView = function () {
  const aiView = document.getElementById('aiView');
  if (aiView) aiView.style.display = 'none';
};

// ============ 监听 side-tab 的"AI"点击（独立监听，与 app.js 联动） ============
// 注意：app.js 中 side-tab 切换逻辑已直接调用 window.switchToAi()，
// 这里**只**做 DOMContentLoaded 时的初始化（bindAiEntry）；
// 不再重复绑定 click 监听，避免点击 AI tab 时弹两次设置窗。
document.addEventListener('DOMContentLoaded', function () {
  bindAiEntry();
  restoreAiHistory();
});
