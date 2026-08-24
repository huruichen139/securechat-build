// module: wallet-cards (卡包) —— 会员卡/优惠券/票券管理
(function () {
  'use strict';
  if (window.SecureChatCards) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  var STORAGE_KEY = 'sc_cards_data';

  function loadCards() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCards(cards) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); } catch (e) {}
  }

  var defaultCards = [
    { id: 'card_1', type: 'member', name: 'SecureChat 会员卡', level: '黄金会员', no: 'SC' + Date.now().toString(36).toUpperCase().substring(0, 8), balance: 888, points: 12500, color: '#ffd700', validUntil: '2026-12-31' },
    { id: 'card_2', type: 'coupon', name: '咖啡优惠券', amount: 15, threshold: 30, expireAt: Date.now() + 7 * 86400000, used: false, color: '#8b4513' },
    { id: 'card_3', type: 'coupon', name: '外卖红包', amount: 8, threshold: 20, expireAt: Date.now() + 3 * 86400000, used: false, color: '#e74c3c' },
    { id: 'card_4', type: 'ticket', name: '电影票兑换券', code: 'FILM2025' + Math.floor(Math.random() * 9000 + 1000), expireAt: Date.now() + 30 * 86400000, used: false, color: '#2ecc71' },
  ];

  function ensureCards() {
    var cards = loadCards();
    if (!cards.length) { cards = defaultCards; saveCards(cards); }
    return cards;
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1).toString().padStart(2, '0') + '-' + d.getDate().toString().padStart(2, '0');
  }

  function fmtExpire(ts) {
    var diff = ts - Date.now();
    if (diff < 0) return '已过期';
    var days = Math.floor(diff / 86400000);
    if (days < 1) return Math.floor(diff / 3600000) + '小时后过期';
    if (days < 30) return days + '天后过期';
    return fmtDate(ts) + '到期';
  }

  function mount(host) {
    host.className = (host.className || '') + ' cards-panel';
    host.innerHTML =
      '<div class="cards-head">' +
        '<div class="cards-title">卡包</div>' +
        '<div class="cards-tabs">' +
          '<button class="cards-tab active" data-type="all">全部</button>' +
          '<button class="cards-tab" data-type="member">会员卡</button>' +
          '<button class="cards-tab" data-type="coupon">优惠券</button>' +
          '<button class="cards-tab" data-type="ticket">票券</button>' +
        '</div>' +
      '</div>' +
      '<div class="cards-list"></div>';

    var listEl = host.querySelector('.cards-list');
    var curType = 'all';

    function render() {
      var cards = ensureCards();
      var list = cards;
      if (curType !== 'all') list = cards.filter(function (c) { return c.type === curType; });

      if (!list.length) {
        listEl.innerHTML = '<div class="cards-empty">暂无卡券</div>';
        return;
      }

      listEl.innerHTML = list.map(function (c) {
        if (c.type === 'member') {
          return '<div class="card-item card-member" style="background:linear-gradient(135deg,' + esc(c.color) + ',#333)">' +
            '<div class="card-member-name">' + esc(c.name) + '</div>' +
            '<div class="card-member-level">' + esc(c.level) + '</div>' +
            '<div class="card-member-row">' +
              '<div class="card-member-balance">余额 ¥' + c.balance + '</div>' +
              '<div class="card-member-points">积分 ' + c.points + '</div>' +
            '</div>' +
            '<div class="card-member-no">NO. ' + esc(c.no) + '</div>' +
            '<div class="card-member-valid">有效期至 ' + esc(c.validUntil) + '</div>' +
          '</div>';
        }
        if (c.type === 'coupon') {
          var expired = c.expireAt < Date.now();
          return '<div class="card-item card-coupon' + (c.used || expired ? ' used' : '') + '" style="border-left:4px solid ' + esc(c.color) + '">' +
            '<div class="card-coupon-amount">¥<span>' + c.amount + '</span></div>' +
            '<div class="card-coupon-info">' +
              '<div class="card-coupon-name">' + esc(c.name) + '</div>' +
              '<div class="card-coupon-threshold">满' + c.threshold + '元可用</div>' +
              '<div class="card-coupon-expire">' + (c.used ? '已使用' : fmtExpire(c.expireAt)) + '</div>' +
            '</div>' +
            '<button class="card-coupon-use" data-id="' + esc(c.id) + '"' + (c.used || expired ? ' disabled' : '') + '>' + (c.used ? '已用' : expired ? '过期' : '使用') + '</button>' +
          '</div>';
        }
        if (c.type === 'ticket') {
          var tExp = c.expireAt < Date.now();
          return '<div class="card-item card-ticket' + (c.used || tExp ? ' used' : '') + '">' +
            '<div class="card-ticket-icon">票</div>' +
            '<div class="card-ticket-info">' +
              '<div class="card-ticket-name">' + esc(c.name) + '</div>' +
              '<div class="card-ticket-code">兑换码：' + esc(c.code) + '</div>' +
              '<div class="card-ticket-expire">' + (c.used ? '已使用' : fmtExpire(c.expireAt)) + '</div>' +
            '</div>' +
            '<button class="card-ticket-use" data-id="' + esc(c.id) + '"' + (c.used || tExp ? ' disabled' : '') + '>查看</button>' +
          '</div>';
        }
        return '';
      }).join('');

      listEl.querySelectorAll('.card-coupon-use').forEach(function (btn) {
        if (btn.disabled) return;
        btn.onclick = function (e) {
          e.stopPropagation();
          var id = btn.dataset.id;
          var cards = ensureCards();
          var card = cards.find(function (c) { return c.id === id; });
          if (card) { card.used = true; saveCards(cards); toastMsg('优惠券已使用'); render(); }
        };
      });
      listEl.querySelectorAll('.card-ticket-use').forEach(function (btn) {
        if (btn.disabled) return;
        btn.onclick = function (e) {
          e.stopPropagation();
          var id = btn.dataset.id;
          var cards = ensureCards();
          var card = cards.find(function (c) { return c.id === id; });
          if (card) {
            toastMsg('兑换码：' + card.code + '（已复制）');
            try { navigator.clipboard.writeText(card.code); } catch (err) {}
          }
        };
      });
    }

    host.querySelectorAll('.cards-tab').forEach(function (tab) {
      tab.onclick = function () {
        host.querySelectorAll('.cards-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        curType = tab.dataset.type;
        render();
      };
    });

    render();
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(520px,94vw);max-height:88vh;overflow:auto';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    mount(box.querySelector('.oa-container'));
  }

  window.SecureChatCards = { name: '卡包', label: '卡包', icon: '卡', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('cards', { name: '卡包', label: '卡包', icon: '卡', open: openPanel, mount: mount });
  }
}());
