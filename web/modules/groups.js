/* module: groups (worker batch1) */
/* SecureChat 群聊体系 Web 模块（独立，不依赖 web/app.js 巨石文件）
   提供：创建群、群列表、群详情、发消息、群公告、成员管理、@提及、群文件、群聊设置。
   约定：
   - 鉴权 token 从 localStorage.getItem('sc_token') 读取（与 app.js 一致）
   - API 基址沿用 window.SERVER_HOST（index.html 已定义）
   - 提供独立的管理面板 mount(containerEl)，可挂到任意容器；也暴露 API 函数供合并方调用
   - 若 window.SecureChatExt?.registerFeature 存在则登记，否则挂到 window.godoMods.groups
 */
(function () {
  'use strict';

  const HOST = (window.SERVER_HOST || '').replace(/\/$/, '');
  function token() {
    return (window.__secureChat && window.__secureChat.token) || localStorage.getItem('sc_token') || '';
  }
  function meId() {
    try {
      const me = localStorage.getItem('sc_me');
      if (me) { const u = JSON.parse(me); if (u && u.id) return u.id; }
    } catch (e) { /* ignore */ }
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showToast(msg, kind, ms) {
    if (window.toast && typeof window.toast === 'function') { window.toast(msg, kind, ms); return; }
    try { window.alert(msg); } catch (e) { /* ignore */ }
  }

  // 通用 JSON 请求
  async function _req(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const opt = { method, headers };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(HOST + url, opt);
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- API 封装 ----------
  const Groups = {
    createGroup: (name, memberUids) => _req('POST', '/api/groups', { name, uids: memberUids || [] }),
    listGroups: () => _req('GET', '/api/groups/enhanced'),
    groupDetail: (id) => _req('GET', '/api/groups/' + id),
    history: (id) => _req('GET', '/api/groups/' + id + '/messages'),
    sendMessage: (id, content, clientMsgId) => _req('POST', '/api/groups/' + id + '/messages', { content, clientMsgId }),
    invite: (id, uids) => _req('POST', '/api/groups/' + id + '/invite', { uids }),
    removeMember: (id, userId) => _req('POST', '/api/groups/' + id + '/remove', { userId }),
    leave: (id) => _req('POST', '/api/groups/' + id + '/leave', {}),
    dissolve: (id) => _req('POST', '/api/groups/' + id + '/dissolve', {}),
    setAnnouncement: (id, content) => _req('POST', '/api/groups/' + id + '/announcement', { content }),
    pinAnnouncement: (id, on) => _req('POST', '/api/groups/' + id + '/announcement/pin', { on }),
    settings: (id, opts) => _req('POST', '/api/groups/' + id + '/settings', opts),
    setNickname: (id, nickname) => _req('POST', '/api/groups/' + id + '/nickname', { nickname }),
    members: (id) => _req('GET', '/api/groups/' + id + '/members'),
    fileList: (id) => _req('GET', '/api/groups/' + id + '/files'),
    fileUrl: (fileId) => HOST + '/api/group-files/' + fileId,
    async uploadFile(id, file) {
      const headers = {};
      const t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
      const res = await fetch(HOST + '/api/groups/' + id + '/files?name=' + encodeURIComponent(file.name || 'file') + '&mime=' + encodeURIComponent(file.type || 'application/octet-stream'), {
        method: 'POST', headers, body: file
      });
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) throw new Error(data.error || ('上传失败 HTTP ' + res.status));
      return data;
    },
    deleteFile: (id, fileId) => _req('DELETE', '/api/groups/' + id + '/files/' + fileId),
  };

  // ---------- @提及 输入工具 ----------
  // 渲染一个带成员可选列表的 @ 输入框到 containerEl；onSubmit(text)
  function mentionInput(containerEl, members, onSubmit) {
    const wrap = document.createElement('div');
    wrap.className = 'group-at-wrap';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:12px;color:#888';
    tip.textContent = '输入 @ 呼出成员选择；点击 @全部 提及所有人';
    const ta = document.createElement('textarea');
    ta.placeholder = '输入消息…（@ 选择成员）';
    ta.style.cssText = 'width:100%;min-height:64px;box-sizing:border-box;padding:8px 10px;border:1px solid #d9d9d9;border-radius:8px;font-size:14px;outline:none';
    const list = document.createElement('div');
    list.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;max-height:120px;overflow:auto';
    (members || []).forEach((m) => {
      const nm = (m.myNickname || m.nickname || m.username || ('用户' + m.id));
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.n = nm;
      chip.textContent = '@' + nm;
      chip.style.cssText = 'padding:4px 10px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#07c160;font-size:12px;cursor:pointer';
      chip.onclick = () => {
        if (/@\w*$/.test(ta.value)) ta.value = ta.value.replace(/@\w*$/, '@' + nm + ' ');
        else ta.value += '@' + nm + ' ';
        ta.focus();
      };
      list.appendChild(chip);
    });
    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.textContent = '@全部';
    allChip.style.cssText = 'padding:4px 10px;border:1px solid #f0c36d;border-radius:14px;background:#fff8e1;color:#b26a00;font-size:12px;cursor:pointer';
    allChip.onclick = () => { ta.value += '@全部 '; ta.focus(); };
    list.prepend(allChip);
    ta.addEventListener('input', () => {
      const m = ta.value.match(/@(\w*)$/);
      list.style.display = m ? 'flex' : 'none';
      if (m && m[1]) {
        const kw = m[1].toLowerCase();
        Array.from(list.children).forEach((c) => {
          if (c === allChip) { c.style.display = 'flex'; return; }
          c.style.display = (c.dataset.n || '').toLowerCase().includes(kw) ? 'flex' : 'none';
        });
      } else if (m) {
        Array.from(list.children).forEach((c) => (c.style.display = 'flex'));
      }
    });
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = '发送到群';
    send.style.cssText = 'padding:8px 16px;background:#07c160;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px';
    send.onclick = () => {
      const text = ta.value.trim();
      if (!text) return;
      if (onSubmit) onSubmit(text);
      else showToast('未配置提交回调', 'warn');
    };
    wrap.appendChild(tip);
    wrap.appendChild(ta);
    wrap.appendChild(list);
    wrap.appendChild(send);
    containerEl.appendChild(wrap);
    return { getText: () => ta.value, setText: (v) => (ta.value = v) };
  }

  // ---------- 通用弹窗（自包含） ----------
  function modal(title, bodyFn, actionsFn) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'max-height:80vh;overflow:auto;width:min(420px,92vw)';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    const x = document.createElement('button');
    x.className = 'modal-x'; x.type = 'button'; x.innerHTML = '&times;';
    head.appendChild(h3); head.appendChild(x);
    box.appendChild(head);
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding:4px 0 8px';
    box.appendChild(body);
    const acts = document.createElement('div');
    acts.className = 'modal-actions';
    box.appendChild(acts);
    mask.appendChild(box);
    document.body.appendChild(mask);
    const close = () => mask.remove();
    x.onclick = close;
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    if (bodyFn) bodyFn(body);
    if (actionsFn) actionsFn(acts, close);
    if (!acts.children.length) {
      const b = document.createElement('button');
      b.className = 'btn-cn'; b.textContent = '关闭';
      b.onclick = close;
      acts.appendChild(b);
    }
    return { body, acts, close, mask };
  }
  function promoInput(label, value) {
    const w = document.createElement('div');
    w.className = 'field';
    const lb = document.createElement('label');
    lb.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value || '';
    w.appendChild(lb); w.appendChild(inp);
    return { w, inp };
  }

  // ---------- 群详情面板 ----------
  async function openGroupDetail(groupId) {
    let detail;
    try { detail = await Groups.groupDetail(groupId); }
    catch (e) { showToast('载入群失败：' + e.message, 'error'); return; }
    const g = detail.group;
    const m = modal('群设置', null, (acts, close) => {
      const b = document.createElement('button');
      b.className = 'btn-cn'; b.textContent = '关闭'; b.onclick = close;
      acts.appendChild(b);
    });
    const body = m.body;

    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:16px;font-weight:700;color:#07c160';
    nameEl.textContent = (g.displayName || g.name) + '  (ID:' + g.id + ')';
    body.appendChild(nameEl);
    body.appendChild(document.createElement('br'));

    // 公告（置顶）
    const annBox = document.createElement('div');
    annBox.style.cssText = 'background:#fffbe6;border:1px solid #ffe58f;border-radius:8px;padding:10px 12px;margin:8px 0';
    const annTitle = document.createElement('div');
    annTitle.textContent = (g.announcement && g.announcement.pinned ? '置顶公告' : '群公告');
    annTitle.style.cssText = 'font-weight:700;font-size:13px;color:#b26a00;margin-bottom:4px';
    const annBody = document.createElement('div');
    annBody.style.cssText = 'font-size:13px;color:#333;white-space:pre-wrap;word-break:break-all';
    annBody.textContent = (g.announcement && g.announcement.content) || '（暂无公告）';
    annBox.appendChild(annTitle); annBox.appendChild(annBody);
    body.appendChild(annBox);
    if (g.isOwner) {
      const editAnn = document.createElement('button');
      editAnn.className = 'btn-cn'; editAnn.style.cssText = 'margin:4px 4px 4px 0';
      editAnn.textContent = '编辑公告';
      editAnn.onclick = () => {
        const fd = promoInput('公告内容', (g.announcement && g.announcement.content) || '');
        const m2 = modal('编辑群公告', (bd) => bd.appendChild(fd.w), (acts, close) => {
          const ok = document.createElement('button'); ok.className = 'btn-cn'; ok.textContent = '保存';
          ok.onclick = async () => {
            try { await Groups.setAnnouncement(g.id, fd.inp.value); close(); showToast('公告已更新', 'success'); }
            catch (e) { showToast('更新失败：' + e.message, 'error'); }
          };
          acts.appendChild(ok);
        });
        m2 && m2;
      };
      body.appendChild(editAnn);
    }

    // 成员列表
    const memTitle = document.createElement('div');
    const memberCnt = (g.members || []).length;
    memTitle.textContent = '群成员（' + memberCnt + '）';
    memTitle.style.cssText = 'font-weight:700;font-size:14px;margin:12px 0 6px';
    body.appendChild(memTitle);
    const memList = document.createElement('div');
    memList.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto';
    (g.members || []).forEach((mm) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #eee;border-radius:8px';
      const av = document.createElement('div');
      av.style.cssText = 'width:30px;height:30px;border-radius:50%;background:#07c160;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0';
      av.textContent = (mm.myNickname || mm.nickname || mm.username || '?').charAt(0);
      const nm = document.createElement('div');
      nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px';
      nm.textContent = (mm.myNickname || mm.nickname || mm.username || ('用户' + mm.id)) + (mm.id === g.ownerId ? '（群主）' : '');
      row.appendChild(av); row.appendChild(nm);
      if (mm.id === meId()) { const meT = document.createElement('span'); meT.style.cssText = 'font-size:11px;color:#999'; meT.textContent = '(我)'; row.appendChild(meT); }
      if (g.isOwner && mm.id !== g.ownerId) {
        const rm = document.createElement('button');
        rm.className = 'btn-cn'; rm.textContent = '移除';
        rm.style.cssText = 'padding:2px 8px;font-size:12px;background:#fa5151;color:#fff;border:none;border-radius:6px;cursor:pointer';
        rm.onclick = async () => {
          if (!window.confirm('确认移除该成员？')) return;
          try { await Groups.removeMember(g.id, mm.id); showToast('已移除', 'success'); m.close(); openGroupDetail(g.id); }
          catch (e) { showToast('移除失败:' + e.message, 'error'); }
        };
        row.appendChild(rm);
      }
      memList.appendChild(row);
    });
    body.appendChild(memList);

    // 群文件
    const fileTitle = document.createElement('div');
    fileTitle.textContent = '群文件';
    fileTitle.style.cssText = 'font-weight:700;font-size:14px;margin:12px 0 6px';
    body.appendChild(fileTitle);
    const up = document.createElement('input');
    up.type = 'file'; up.style.cssText = 'margin:4px 0';
    up.onchange = async () => {
      const f = up.files && up.files[0];
      if (!f) return;
      try { await Groups.uploadFile(g.id, f); showToast('上传成功', 'success'); m.close(); openGroupDetail(g.id); }
      catch (e) { showToast('上传失败:' + e.message, 'error'); }
    };
    body.appendChild(up);
    const fileList = document.createElement('div');
    fileList.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:140px;overflow:auto';
    body.appendChild(fileList);
    Groups.fileList(g.id).then((d) => {
      (d.files || []).forEach((f) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #eee;border-radius:8px;font-size:12px';
        const a = document.createElement('a');
        a.href = Groups.fileUrl(f.id); a.target = '_blank';
        a.textContent = '下 ' + f.name + ' (' + Math.round((f.size || 0) / 1024) + 'KB)';
        a.style.cssText = 'flex:1;color:#07c160;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const by = document.createElement('span');
        by.textContent = f.uploader || '';
        by.style.cssText = 'color:#999';
        row.appendChild(a); row.appendChild(by);
        fileList.appendChild(row);
      });
    }).catch(() => {});

    // 邀请
    body.appendChild(document.createElement('br'));
    const inviteRow = document.createElement('div');
    inviteRow.style.cssText = 'display:flex;gap:8px;align-items:center';
    const uidInp = document.createElement('input');
    uidInp.type = 'text'; uidInp.placeholder = '对方 UID';
    uidInp.style.cssText = 'flex:1;padding:7px 10px;border:1px solid #d9d9d9;border-radius:8px';
    const invBtn = document.createElement('button');
    invBtn.className = 'btn-cn'; invBtn.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer';
    invBtn.textContent = '邀请';
    invBtn.onclick = async () => {
      const uid = uidInp.value.trim();
      if (!uid) return;
      try { await Groups.invite(g.id, [uid]); uidInp.value = ''; showToast('已邀请', 'success'); }
      catch (e) { showToast('邀请失败:' + e.message, 'error'); }
    };
    inviteRow.appendChild(uidInp); inviteRow.appendChild(invBtn);
    body.appendChild(inviteRow);

    // 群聊设置
    const setTitle = document.createElement('div');
    setTitle.textContent = '群聊设置';
    setTitle.style.cssText = 'font-weight:700;font-size:14px;margin:14px 0 6px';
    body.appendChild(setTitle);
    const muteWrap = document.createElement('div');
    muteWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0';
    const muteCb = document.createElement('input');
    muteCb.type = 'checkbox'; muteCb.checked = !!g.muted;
    const muteLb = document.createElement('span');
    muteLb.textContent = '消息免打扰';
    muteCb.onchange = async () => {
      try { await Groups.settings(g.id, { muted: muteCb.checked }); showToast('已更新', 'success'); }
      catch (e) { showToast('更新失败:' + e.message, 'error'); }
    };
    muteWrap.appendChild(muteCb); muteWrap.appendChild(muteLb);
    body.appendChild(muteWrap);
    const noteRow = promoInput('群备注（本群显示名）', g.displayName === g.name ? '' : g.displayName);
    body.appendChild(noteRow.w);
    const nickRow = promoInput('我在本群昵称', g.myNickname || '');
    body.appendChild(nickRow.w);
    body.appendChild(document.createElement('br'));
    const savBtn = document.createElement('button');
    savBtn.className = 'btn-cn'; savBtn.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer';
    savBtn.textContent = '保存备注/昵称';
    savBtn.onclick = async () => {
      try {
        await Groups.settings(g.id, { note: noteRow.inp.value.trim() });
        await Groups.setNickname(g.id, nickRow.inp.value.trim());
        showToast('已保存', 'success');
        m.close(); openGroupDetail(g.id);
      } catch (e) { showToast('保存失败:' + e.message, 'error'); }
    };
    body.appendChild(savBtn);

    // 危险操作
    body.appendChild(document.createElement('br'));
    body.appendChild(document.createElement('br'));
    const danger = document.createElement('button');
    danger.className = 'btn-cn'; danger.style.cssText = 'background:#f5f5f5;color:#333;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;margin-right:8px';
    danger.textContent = g.isOwner ? '解散群' : '退出群';
    danger.onclick = async () => {
      const tip = g.isOwner ? '解散后群消息与成员关系将全部删除，确认？' : '确认退出该群？';
      if (!window.confirm(tip)) return;
      try {
        if (g.isOwner) await Groups.dissolve(g.id);
        else await Groups.leave(g.id);
        showToast(g.isOwner ? '群已解散' : '已退出群', 'success');
        m.close();
      } catch (e) { showToast('操作失败:' + e.message, 'error'); }
    };
    body.appendChild(danger);
  }

  // ---------- 创建群对话框 ----------
  async function createGroupDialog() {
    let friends = [];
    try {
      const res = await fetch(HOST + '/api/friends', { headers: { 'Authorization': 'Bearer ' + token() } });
      const d = await res.json();
      friends = d.friends || [];
    } catch (e) { friends = []; }
    // 通过闭包收集输入，避免依赖 modal 返回值
    let nameEl = null;
    let selUids = [];
    modal('创建群聊', (body) => {
      const nameRow = promoInput('群名', '');
      nameEl = nameRow.inp;
      body.appendChild(nameRow.w);
      body.appendChild(document.createElement('br'));
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:13px;color:#666;margin:6px 0';
      lbl.textContent = '选择好友入群（可多选）';
      body.appendChild(lbl);
      const sel = document.createElement('div');
      sel.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto';
      (friends || []).forEach((u) => {
        const w2 = document.createElement('label');
        w2.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.onchange = () => {
          const i = selUids.indexOf(u.uid);
          if (cb.checked && i < 0) selUids.push(u.uid);
          if (!cb.checked && i >= 0) selUids.splice(i, 1);
        };
        const nm = document.createElement('span');
        nm.textContent = (u.nickname || u.username) + '（' + (u.uid || '') + '）';
        w2.appendChild(cb); w2.appendChild(nm);
        sel.appendChild(w2);
      });
      body.appendChild(sel);
    }, (acts, close) => {
      const ok = document.createElement('button'); ok.className = 'btn-cn'; ok.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer'; ok.textContent = '创建';
      ok.onclick = async () => {
        const name = nameEl && nameEl.value.trim();
        if (!name) { showToast('请填写群名', 'warn'); return; }
        try {
          await Groups.createGroup(name, selUids.slice());
          close();
          showToast('群「' + name + '」创建成功', 'success');
        } catch (e) { showToast('创建失败:' + e.message, 'error'); }
      };
      acts.appendChild(ok);
    });
  }

  // ---------- 群列表面板 ----------
  async function listGroupsPanel(containerEl) {
    containerEl.innerHTML = '';
    containerEl.style.cssText = 'padding:16px';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px';
    const title = document.createElement('h3');
    title.textContent = '我的群聊';
    title.style.cssText = 'margin:0;color:#07c160';
    const btn = document.createElement('button');
    btn.className = 'btn-cn'; btn.style.cssText = 'background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer';
    btn.textContent = '创建群聊';
    btn.onclick = createGroupDialog;
    head.appendChild(title); head.appendChild(btn);
    containerEl.appendChild(head);

    const ul = document.createElement('div');
    ul.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    containerEl.appendChild(ul);
    try {
      const d = await Groups.listGroups();
      (d.groups || []).forEach((g) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #eee;border-radius:10px;cursor:pointer;background:#fff';
        row.onclick = () => openGroupDetail(g.id);
        const av = document.createElement('div');
        av.style.cssText = 'width:38px;height:38px;border-radius:10px;background:#07c160;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700';
        av.textContent = (g.displayName || g.name || '?').charAt(0);
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;overflow:hidden';
        const n1 = document.createElement('div');
        n1.textContent = (g.displayName || g.name) + (g.ownerId === meId() ? '（群主）' : '');
        n1.style.cssText = 'font-size:14px;font-weight:600;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const n2 = document.createElement('div');
        n2.style.cssText = 'font-size:12px;color:#999';
        n2.textContent = (g.memberCount || 0) + ' 成员' + (g.muted ? ' · 免打扰' : '');
        info.appendChild(n1); info.appendChild(n2);
        row.appendChild(av); row.appendChild(info);
        if (g.announcement) {
          const pin = document.createElement('span');
          pin.textContent = ' 📌';
          row.appendChild(pin);
        }
        ul.appendChild(row);
      });
      if (!(d.groups || []).length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center;color:#999;padding:40px 0';
        empty.textContent = '还没有群聊，点击右上角创建';
        ul.appendChild(empty);
      }
    } catch (e) {
      const err = document.createElement('div');
      err.style.cssText = 'color:#c0392b;padding:16px';
      err.textContent = '载入失败：' + e.message;
      ul.appendChild(err);
    }
  }

  // ---------- 独立管理面板（可挂到任意容器） ----------
  function mount(containerEl) {
    if (!containerEl) containerEl = document.createElement('div');
    listGroupsPanel(containerEl);
    return containerEl;
  }
  // 若没有宿主容器，自动创建全屏浮层
  function openManager() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(560px,94vw);max-height:88vh;overflow:auto';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h3 = document.createElement('h3');
    h3.textContent = '群聊管理';
    const x = document.createElement('button');
    x.className = 'modal-x'; x.type = 'button'; x.innerHTML = '&times;';
    head.appendChild(h3); head.appendChild(x);
    box.appendChild(head);
    const body = document.createElement('div');
    box.appendChild(body);
    mask.appendChild(box);
    document.body.appendChild(mask);
    x.onclick = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    listGroupsPanel(body);
  }

  const api = {
    createGroup: Groups.createGroup,
    listGroups: Groups.listGroups,
    groupDetail: Groups.groupDetail,
    history: Groups.history,
    sendMessage: Groups.sendMessage,
    invite: Groups.invite,
    removeMember: Groups.removeMember,
    leave: Groups.leave,
    dissolve: Groups.dissolve,
    setAnnouncement: Groups.setAnnouncement,
    pinAnnouncement: Groups.pinAnnouncement,
    settings: Groups.settings,
    setNickname: Groups.setNickname,
    members: Groups.members,
    fileList: Groups.fileList,
    fileUrl: Groups.fileUrl,
    uploadFile: Groups.uploadFile,
    deleteFile: Groups.deleteFile,
    // UI
    mentionInput: mentionInput,
    openGroupDetail: openGroupDetail,
    createGroupDialog: createGroupDialog,
    listGroupsPanel: listGroupsPanel,
    mount: mount,
    openManager: openManager,
    api: Groups,
  };

  // 挂到 window.godoMods
  window.godoMods = window.godoMods || {};
  window.godoMods.groups = api;
  // 若宿主存在 registerFeature 则登记（可选）
  const Ext = window.SecureChatExt;
  if (Ext && typeof Ext.registerFeature === 'function') {
    try { Ext.registerFeature('groups', api); } catch (e) { /* ignore */ }
  }
})();