'use strict';
// module: todos (worker batch8)
// 群待办（今日待办）：发布待办清单、成员勾选完成、实时进度条。
// 依赖：web/modules/registry.js。
// 端点：/api/todos/*（由 server/routes/lifestyle-msg.js 提供）。
(function () {
  if (typeof window === 'undefined') return;

  const u = (window.SecureChatExt && window.SecureChatExt._util) || {};
  const apiFn = u.api;

  function toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind || 'info'); } catch (e) {}
    try { alert(msg); } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(ms) { const d = new Date(ms); const pad = (n) => String(n).padStart(2, '0'); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, detail) { (listeners[evt] || []).forEach((f) => { try { f(detail); } catch (e) {} }); }

  let todos = [];

  function loadByGroup(groupId) {
    return apiFn('GET', '/api/todos/group/' + groupId).then((d) => {
      todos = d.todos || [];
      return todos;
    }).catch((e) => { toast('加载待办失败：' + (e.message || e), 'error'); return []; });
  }

  async function createTodo(groupId, title, items) {
    const d = await apiFn('POST', '/api/todos', { body: { groupId, title, items } });
    toast('待办已发布', 'success');
    return d.todo;
  }

  async function checkItem(todoId, itemId, done) {
    const d = await apiFn('POST', '/api/todos/' + todoId + '/items/' + itemId + '/check', { body: { done } });
    return d.todo;
  }

  function getTodo(todoId) { return todos.find((t) => Number(t.id) === Number(todoId)) || null; }

  // 渲染：todo 卡片 + 进度条
  function renderTodoPanel(container, todo) {
    container.innerHTML =
      '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
      '<div style="font-size:13px;color:#999;margin-bottom:4px">' + esc((todo.creator && todo.creator.nickname) || '未知') + ' 发布 · ' + fmtDate(todo.createdAt) + '</div>' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:10px">' + esc(todo.title) + '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<div class="todo-bar" style="position:relative;flex:1;height:8px;background:#eee;border-radius:4px;overflow:hidden">' +
      '<div style="position:absolute;left:0;top:0;bottom:0;width:' + todo.progress + '%;background:#07c160;transition:width .3s"></div></div>' +
      '<span style="font-size:12px;color:#888">' + todo.progress + '%</span></div>' +
      '<div style="display:flex;flex-direction:column;gap:6px">' + todo.items.map((it) => {
        const checked = it.myDone ? 'checked' : '';
        return '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">' +
          '<input class="todo-ck" data-todo="' + todo.id + '" data-item="' + it.id + '" type="checkbox" ' + checked + ' style="width:18px;height:18px">' +
          '<span style="' + (it.done ? 'text-decoration:line-through;color:#aaa;' : '') + '">' + esc(it.content) + '</span>' +
          (it.done ? '<span style="font-size:11px;color:#07c160;margin-left:auto">已完成</span>' : '') +
          '</label>';
      }).join('') + '</div></div>';
    container.querySelectorAll('.todo-ck').forEach((cb) => {
      cb.onchange = async () => {
        try {
          const fresh = await checkItem(Number(cb.getAttribute('data-todo')), Number(cb.getAttribute('data-item')), cb.checked);
          renderTodoPanel(container, fresh);
          emit('changed', fresh);
        } catch (e) { toast('操作失败：' + (e.message || e), 'error'); cb.checked = !cb.checked; }
      };
    });
  }

  // 创建待办弹层
  function openCreate(groupId) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:20px;width:420px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.2)">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:12px">发布今日待办</div>' +
      '<input class="td-title" placeholder="待办标题（默认：今日待办）" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ddd;border-radius:8px;margin-bottom:10px">' +
      '<div id="td-items" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px"></div>' +
      '<button class="td-add" style="padding:6px 12px;background:#f2f2f2;border:none;border-radius:16px;cursor:pointer;margin-bottom:10px">+ 添加待办项</button>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="td-cancel" style="padding:8px 16px;background:#f2f2f2;border:none;border-radius:20px;cursor:pointer">取消</button>' +
      '<button class="td-confirm" style="padding:8px 16px;background:#07c160;color:#fff;border:none;border-radius:20px;cursor:pointer">发布</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#td-items');
    function addItem() {
      const row = document.createElement('div');
      row.style.display = 'flex'; row.style.gap = '6px';
      const inp = document.createElement('input');
      inp.placeholder = '待办内容';
      inp.style.cssText = 'flex:1;padding:7px 8px;border:1px solid #ddd;border-radius:6px';
      const del = document.createElement('button');
      del.textContent = '×';
      del.style.cssText = 'border:none;background:#fee;color:#c00;border-radius:50%;width:26px;cursor:pointer';
      del.onclick = () => row.remove();
      row.appendChild(inp); row.appendChild(del);
      box.appendChild(row);
    }
    addItem(); addItem();
    wrap.querySelector('.td-add').onclick = () => addItem();
    wrap.querySelector('.td-cancel').onclick = () => wrap.remove();
    wrap.querySelector('.td-confirm').onclick = async () => {
      const title = wrap.querySelector('.td-title').value.trim() || '今日待办';
      const items = Array.from(box.querySelectorAll('input')).map((i) => i.value.trim()).filter(Boolean);
      if (!items.length) { toast('请至少填写一项待办', 'warn'); return; }
      try {
        await createTodo(groupId, title, items);
        wrap.remove();
        emit('created', { title, items });
      } catch (e) { toast('发布失败：' + (e.message || e), 'error'); }
    };
  }

  const feature = {
    name: 'todos',
    loadByGroup, createTodo, checkItem, renderTodoPanel, openCreate, getTodo, on,
    getTodos: () => todos,
  };

  if (window.SecureChatExt && window.SecureChatExt.registerFeature) {
    window.SecureChatExt.registerFeature('todos', feature);
  } else {
    window.SecureChatExt = window.SecureChatExt || {};
    window.SecureChatExt.todos = feature;
  }
})();