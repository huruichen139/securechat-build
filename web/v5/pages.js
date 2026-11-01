/* SecureChat v5 - 通讯录 / 发现 / 我 / 功能中心 */
(function () {
  'use strict';
  var S = window.SC5;
  var state = S.state;
  var el = S.el;

  var currentTab = 'chats';

  function setTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.rail-btn[data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    document.querySelectorAll('.tab[data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    if (tab !== 'chats') {
      document.querySelector('.main-pane').classList.remove('open');
      state.activePeer = null;
      state.activeGroup = null;
    }
    renderPane();
  }

  function paneTitle(t) {
    return { chats: '聊天', contacts: '通讯录', discover: '发现', me: '我' }[t] || '聊天';
  }

  function renderPane() {
    var body = S.$('listBody');
    S.$('paneTitle').textContent = paneTitle(currentTab);
    S.$('listSearch').style.display = currentTab === 'chats' ? '' : 'none';
    body.innerHTML = '';
    if (currentTab === 'chats') { S.renderList(); return; }
    if (currentTab === 'contacts') return renderContacts(body);
    if (currentTab === 'discover') return renderDiscover(body);
    if (currentTab === 'me') return renderMe(body);
  }

  /* ---------------- 通讯录 ---------------- */
  function renderContacts(body) {
    var tools = el('div', 'card');
    [['新的朋友', function () { S.toast('好友申请列表开发中', 'info'); }],
     ['添加朋友', openAddFriend],
     ['发起群聊', openCreateGroup]].forEach(function (a) {
      var cell = el('div', 'cell');
      cell.appendChild(el('div', 'cell-ico', a[0].charAt(0)));
      cell.appendChild(el('div', 'cell-main', a[0]));
      cell.appendChild(el('div', 'cell-arrow', '›'));
      cell.onclick = a[1];
      tools.appendChild(cell);
    });
    body.appendChild(tools);

    var groups = state.groups;
    if (groups.length) {
      body.appendChild(el('div', 'section-title', '群聊'));
      var gc = el('div', 'card');
      groups.forEach(function (g) {
        var cell = el('div', 'cell');
        cell.appendChild(S.avatarNode(g.name, g.avatar, 'cell-ico'));
        var main = el('div', 'cell-main');
        main.appendChild(el('div', 'cell-title', g.name));
        main.appendChild(el('div', 'cell-sub', (g.memberCount || 0) + ' 位成员'));
        cell.appendChild(main);
        cell.onclick = function () { S.openChat('group', g.id); };
        gc.appendChild(cell);
      });
      body.appendChild(gc);
    }

    body.appendChild(el('div', 'section-title', '联系人'));
    var fc = el('div', 'card');
    if (!state.friends.length) {
      fc.appendChild(el('div', 'empty', '还没有联系人'));
    }
    state.friends.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); }).forEach(function (f) {
      var cell = el('div', 'cell');
      cell.appendChild(S.avatarNode(f.name, f.avatar, 'cell-ico'));
      var main = el('div', 'cell-main');
      main.appendChild(el('div', 'cell-title', f.name));
      main.appendChild(el('div', 'cell-sub', f.online ? '在线' : (f.uid ? 'ID: ' + f.uid : '')));
      cell.appendChild(main);
      cell.onclick = function () { S.openChat('friend', f.id); };
      fc.appendChild(cell);
    });
    body.appendChild(fc);
  }

  function openAddFriend() {
    var box = S.openModal('添加朋友', '<label class="field"><span>用户名 / UID / 邮箱</span><input id="addFriendInput" placeholder="输入对方账号" /></label>', {
      footer: '<button class="btn ghost" data-close>取消</button><button class="btn primary" id="addFriendGo">添加</button>'
    });
    box.querySelector('#addFriendGo').onclick = function () {
      var q = (box.querySelector('#addFriendInput').value || '').trim();
      if (!q) return;
      S.post('/api/friend/add', { friendUid: q }).then(function () {
        S.toast('好友申请已发送', 'success');
        S.closeModal();
      }).catch(function (e) { S.toast(e.message || '发送失败', 'error'); });
    };
  }

  function openCreateGroup() {
    var box = S.openModal('发起群聊', '<label class="field"><span>群名称</span><input id="newGroupName" placeholder="例如：周末出游" /></label><div id="newGroupFriends" class="card" style="margin-top:10px"></div>', {
      footer: '<button class="btn ghost" data-close>取消</button><button class="btn primary" id="newGroupGo">创建</button>'
    });
    var picked = {};
    var list = box.querySelector('#newGroupFriends');
    state.friends.forEach(function (f) {
      var cell = el('div', 'cell');
      cell.appendChild(S.avatarNode(f.name, f.avatar, 'cell-ico'));
      cell.appendChild(el('div', 'cell-main', f.name));
      var mark = el('div', 'cell-arrow', '');
      cell.appendChild(mark);
      cell.onclick = function () {
        picked[f.id] = !picked[f.id];
        mark.textContent = picked[f.id] ? '✓' : '';
      };
      list.appendChild(cell);
    });
    box.querySelector('#newGroupGo').onclick = function () {
      var name = (box.querySelector('#newGroupName').value || '').trim();
      if (!name) { S.toast('请填写群名称', 'warn'); return; }
      var memberIds = Object.keys(picked).filter(function (k) { return picked[k]; });
      S.post('/api/group/create', { name: name }).then(function (d) {
        var gid = (d.group && d.group.id) || d.groupId;
        var after = memberIds.length && gid
          ? S.post('/api/groups/' + gid + '/invite', { userIds: memberIds }).catch(function () {})
          : Promise.resolve();
        return after.then(function () {
          S.toast('群聊已创建', 'success');
          S.closeModal();
          S.loadGroups().then(function () { renderPane(); if (gid) S.openChat('group', gid); });
        });
      }).catch(function (e) { S.toast(e.message || '创建失败', 'error'); });
    };
  }

  /* ---------------- 发现 ---------------- */
  function renderDiscover(body) {
    var entries = [
      ['朋友圈', function () { openFeature('moments', '朋友圈', function () { S.toast('朋友圈组件未加载', 'warn'); }); }],
      ['扫一扫', function () { openFeature('scan', '扫一扫', function () { S.toast('扫一扫组件未加载', 'warn'); }); }],
      ['小程序', function () { openFeature('miniapp', '小程序', function () { S.toast('小程序组件未加载', 'warn'); }); }],
      ['视频号', function () { openFeature('videos', '视频号', function () { S.toast('视频号组件未加载', 'warn'); }); }],
      ['直播', function () { openFeature('live', '直播', function () { S.toast('直播组件未加载', 'warn'); }); }],
      ['搜一搜', function () { openFeature('search', '搜一搜', function () { S.toast('搜索组件未加载', 'warn'); }); }],
      ['附近的人', function () { openFeature('nearby', '附近的人', function () { S.toast('附近组件未加载', 'warn'); }); }],
      ['摇一摇', function () { openFeature('shake', '摇一摇', function () { S.toast('摇一摇组件未加载', 'warn'); }); }],
      ['游戏', function () { openFeature('games', '游戏', function () { S.toast('游戏组件未加载', 'warn'); }); }],
      ['购物', function () { openFeature('shop', '购物', function () { S.toast('购物组件未加载', 'warn'); }); }],
      ['公众号', function () { openFeature('oa', '公众号', function () { S.toast('公众号组件未加载', 'warn'); }); }],
      ['更多功能', openFeatureCenter]
    ];
    var card = el('div', 'card');
    entries.forEach(function (e) {
      var cell = el('div', 'cell');
      cell.appendChild(el('div', 'cell-ico', e[0].charAt(0)));
      cell.appendChild(el('div', 'cell-main', e[0]));
      cell.appendChild(el('div', 'cell-arrow', '›'));
      cell.onclick = e[1];
      card.appendChild(cell);
    });
    body.appendChild(card);
  }

  function findFeature(name) {
    var ext = window.SecureChatExt;
    if (!ext) return null;
    if (typeof ext.getFeature === 'function') {
      var f = ext.getFeature(name);
      if (f) return f;
    }
    return ext[name] || null;
  }

  function openFeature(name, title, fallback) {
    var f = findFeature(name);
    if (f) { S.openContainerFeature(f, title); return; }
    var globals = { moments: 'SecureChatMoments', scan: 'SecureChatScan', miniapp: 'SecureChatMiniApp', videos: 'SecureChatVideos', live: 'SecureChatLive', search: 'SecureChatSearch', nearby: 'SecureChatNearby', shake: 'SecureChatShake', games: 'SecureChatGames', shop: 'SecureChatShop', oa: 'SecureChatOa' };
    var g = window[globals[name]];
    if (g && typeof g.open === 'function') { g.open(); return; }
    fallback();
  }

  var FEATURES = [
    ['群聊管理', 'groups'], ['投票接龙', 'polls'], ['群待办', 'todos'], ['定时提醒', 'remind'],
    ['翻译', 'translate'], ['朋友圈管理', 'moment-ext'], ['公众号', 'oa'], ['小程序', 'miniapp'],
    ['相册', 'album'], ['卡包', 'cards'], ['表情', 'stickers'], ['红包', 'redpacket'],
    ['摇一摇', 'shake'], ['扫一扫', 'scan'], ['支付生活', 'pay'], ['我的状态', 'status'],
    ['我的收藏', 'favorites'], ['收付款码', 'pay'], ['兑换码充值', 'redeem'], ['知识库中心', 'kb'],
    ['成语词典', 'idioms'], ['唐诗三百首', 'poems'], ['歇后语', 'xiehouyu'], ['笑话大全', 'jokes'], ['名人名言', 'quotes']
  ];

  function openFeatureCenter() {
    var grid = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:10px">' +
      FEATURES.map(function (f, i) {
        return '<button class="feat" data-i="' + i + '" style="padding:14px 6px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);font-size:12.5px">' +
          S.esc(f[0]) + '</button>';
      }).join('') + '</div>';
    var box = S.openModal('更多功能', grid, { className: 'wide' });
    box.querySelectorAll('.feat').forEach(function (b) {
      b.onclick = function () {
        var f = FEATURES[Number(b.dataset.i)];
        var feat = findFeature(f[1]);
        if (feat) { S.openContainerFeature(feat, f[0]); return; }
        if (f[1] === 'redeem') { openRedeem(); return; }
        if (f[1] === 'pay') { openWallet(); return; }
        if (/^(kb|idioms|poems|xiehouyu|jokes|quotes)$/.test(f[1])) {
          if (typeof window.openKnowledgeCenter === 'function') {
            window.openKnowledgeCenter(f[1] === 'kb' ? undefined : f[1]);
            return;
          }
        }
        S.toast(f[0] + ' 组件未加载', 'warn');
      };
    });
  }

  function openRedeem() {
    var box = S.openModal('兑换码充值', '<label class="field"><span>兑换码</span><input id="redeemCode" placeholder="输入兑换码" /></label>', {
      footer: '<button class="btn ghost" data-close>取消</button><button class="btn primary" id="redeemGo">兑换</button>'
    });
    box.querySelector('#redeemGo').onclick = function () {
      var code = (box.querySelector('#redeemCode').value || '').trim();
      if (!code) return;
      S.post('/api/wallet/redeem', { code: code }).then(function (d) {
        S.toast('兑换成功' + (d.amount ? '，到账 ¥' + d.amount : ''), 'success');
        S.closeModal();
      }).catch(function (e) { S.toast(e.message || '兑换失败', 'error'); });
    };
  }

  function openWallet() {
    S.get('/api/wallet').then(function (d) {
      var w = d.wallet || d;
      S.openModal('钱包', '<div style="font-size:13px;color:var(--text-2)">可用余额</div>' +
        '<div style="font-size:28px;font-weight:700;margin:6px 0 2px">¥ ' + Number(w.balance || 0).toFixed(2) + '</div>' +
        '<div style="font-size:12px;color:var(--text-3)">累计收款 ¥' + Number(w.totalReceived || w.total_received || 0).toFixed(2) + '</div>');
    }).catch(function (e) { S.toast(e.message || '加载失败', 'error'); });
  }

  /* ---------------- 我 ---------------- */
  function renderMe(body) {
    var me = state.me || {};
    var head = el('div', 'me-head');
    head.appendChild(S.avatarNode(me.nickname || me.username || '我', me.avatar, 'me-avatar'));
    var info = el('div');
    info.appendChild(el('div', 'me-name', me.nickname || me.username || '我'));
    info.appendChild(el('div', 'me-id', 'ID: ' + (me.uid || me.id || '-')));
    head.appendChild(info);
    body.appendChild(head);

    var cells = [
      ['支付', openWallet],
      ['我的收藏', function () { openFeature('favorites', '我的收藏', function () { S.toast('收藏组件未加载', 'warn'); }); }],
      ['我的状态', function () { openFeature('status', '我的状态', function () { S.toast('状态组件未加载', 'warn'); }); }],
      ['相册', function () { openFeature('album', '相册', function () { S.toast('相册组件未加载', 'warn'); }); }],
      ['设置', openSettings],
      ['退出登录', function () {
        S.confirm('退出登录', '确认退出当前账号？').then(function (ok) { if (ok) S.logout(); });
      }]
    ];
    var card = el('div', 'card');
    cells.forEach(function (c) {
      var cell = el('div', 'cell');
      cell.appendChild(el('div', 'cell-ico', c[0].charAt(0)));
      cell.appendChild(el('div', 'cell-main', c[0]));
      cell.appendChild(el('div', 'cell-arrow', '›'));
      cell.onclick = c[1];
      card.appendChild(cell);
    });
    body.appendChild(card);
  }

  function openSettings() {
    var box = S.openModal('设置', '<div class="card" id="settingsCard"></div>');
    var card = box.querySelector('#settingsCard');
    var dark = document.documentElement.classList.contains('dark');
    var items = [
      ['深色模式', function () {
        dark = !dark;
        S.applyTheme(dark);
        S.toast(dark ? '已切换深色模式' : '已切换浅色模式');
      }],
      ['修改密码', function () { S.toast('修改密码开发中', 'info'); }],
      ['关于 SecureChat', function () { S.toast('SecureChat v5'); }]
    ];
    items.forEach(function (it) {
      var cell = el('div', 'cell');
      cell.appendChild(el('div', 'cell-main', it[0]));
      cell.appendChild(el('div', 'cell-arrow', '›'));
      cell.onclick = it[1];
      card.appendChild(cell);
    });
  }

  function pagesInit() {
    document.querySelectorAll('.rail-btn[data-tab]').forEach(function (b) {
      b.onclick = function () { setTab(b.dataset.tab); };
    });
    document.querySelectorAll('.tab[data-tab]').forEach(function (b) {
      b.onclick = function () { setTab(b.dataset.tab); };
    });
    S.$('themeBtn').onclick = function () {
      S.applyTheme(!document.documentElement.classList.contains('dark'));
    };
    window.addEventListener('resize', function () { window.IS_MOBILE = window.innerWidth <= 760; });
  }

  S.pagesInit = pagesInit;
  S.setTab = setTab;
  S.renderPane = renderPane;
  window.showMobilePage = function () { /* v5 使用列表页切换，无需单独移动页 */ };
  window.selectPeer = function (id) { S.openChat('friend', Number(id)); };
  window.selectGroup = function (id) { S.openChat('group', Number(id)); };
})();
