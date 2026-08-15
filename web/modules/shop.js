// module: shop (购物) —— 精选商品浏览
(function () {
  'use strict';
  if (window.SecureChatShop) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  var STORAGE_KEY = 'sc_cart';
  function loadCart() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; } }
  function saveCart(c) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch (e) {} }

  var PRODUCTS = [
    { id: 1, name: 'SecureChat 定制马克杯', price: 39.9, oldPrice: 59.9, cat: '生活', img: '☕', sold: 1234, desc: '陶瓷材质，3D 立体 Logo，可微波加热，容量 350ml' },
    { id: 2, name: '无线蓝牙耳机 Pro', price: 199, oldPrice: 399, cat: '数码', img: '🎧', sold: 5678, desc: '主动降噪，30 小时续航，IPX5 防水，低延迟游戏模式' },
    { id: 3, name: '智能手表 S9', price: 899, oldPrice: 1299, cat: '数码', img: '⌚', sold: 2345, desc: 'AMOLED 屏幕，心率血氧监测，100+ 运动模式，14 天续航' },
    { id: 4, name: '纯棉短袖 T 恤', price: 59, oldPrice: 99, cat: '服饰', img: '👕', sold: 8901, desc: '100% 新疆长绒棉，亲肤透气，多色可选，宽松版型' },
    { id: 5, name: '保温杯 500ml', price: 49.9, oldPrice: 89, cat: '生活', img: '🥤', sold: 4567, desc: '316 不锈钢内胆，24 小时保温保冷，防漏设计，送杯刷' },
    { id: 6, name: '机械键盘 87 键', price: 159, oldPrice: 259, cat: '数码', img: '⌨️', sold: 3456, desc: '红轴/青轴可选，RGB 背光，Type-C 可换线，PBT 键帽' },
    { id: 7, name: '速干运动短裤', price: 39, oldPrice: 69, cat: '服饰', img: '🩳', sold: 6789, desc: '四面弹力面料，速干透气，内衬安全裤，多色可选' },
    { id: 8, name: '香薰蜡烛礼盒', price: 79, oldPrice: 128, cat: '生活', img: '🕯️', sold: 1234, desc: '天然大豆蜡，4 种香型，助眠安神，燃烧 30 小时' },
    { id: 9, name: '便携充电宝 20000mAh', price: 99, oldPrice: 169, cat: '数码', img: '🔋', sold: 7890, desc: '22.5W 快充，双向 PD，可上飞机，LED 数显电量' },
    { id: 10, name: '帆布单肩包', price: 45, oldPrice: 88, cat: '服饰', img: '👜', sold: 3456, desc: '16oz 加厚帆布，大容量，可装 14 寸笔记本，多口袋设计' },
    { id: 11, name: '不锈钢餐具套装', price: 29.9, oldPrice: 49, cat: '生活', img: '🍴', sold: 2345, desc: '筷勺刀叉五件套，304 不锈钢，便携收纳盒，环保出行' },
    { id: 12, name: '运动蓝牙音箱', price: 129, oldPrice: 229, cat: '数码', img: '🔊', sold: 4567, desc: 'IPX7 防水，20W 大功率，12 小时续航，TWS 串联' },
  ];

  function mount(host) {
    host.className = (host.className || '') + ' shop-panel';
    var cats = ['全部', '数码', '生活', '服饰'];
    host.innerHTML =
      '<div class="shop-head">' +
        '<div class="shop-title">购物</div>' +
        '<div class="shop-bar-wrap">' +
          '<input type="text" class="shop-search" placeholder="搜索商品…" />' +
          '<button class="shop-cart-btn">购物车(<span class="shop-cart-count">0</span>)</button>' +
        '</div>' +
        '<div class="shop-cats">' +
          cats.map(function (c) { return '<button class="shop-cat' + (c === '全部' ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') +
        '</div>' +
      '</div>' +
      '<div class="shop-grid"></div>';

    var grid = host.querySelector('.shop-grid');
    var searchInput = host.querySelector('.shop-search');
    var curCat = '全部';
    var kw = '';

    function render() {
      var list = PRODUCTS.filter(function (p) {
        var catOk = curCat === '全部' || p.cat === curCat;
        var kwOk = !kw || p.name.toLowerCase().indexOf(kw.toLowerCase()) >= 0 || p.desc.toLowerCase().indexOf(kw.toLowerCase()) >= 0;
        return catOk && kwOk;
      });

      if (!list.length) { grid.innerHTML = '<div class="shop-empty">没有找到相关商品</div>'; return; }

      grid.innerHTML = list.map(function (p) {
        var discount = Math.round(p.price / p.oldPrice * 10);
        return '<div class="shop-item" data-id="' + p.id + '">' +
          '<div class="shop-item-img">' + p.img + '</div>' +
          '<div class="shop-item-info">' +
            '<div class="shop-item-name">' + esc(p.name) + '</div>' +
            '<div class="shop-item-desc">' + esc(p.desc) + '</div>' +
            '<div class="shop-item-price-row">' +
              '<span class="shop-item-price">¥' + p.price + '</span>' +
              '<span class="shop-item-old">¥' + p.oldPrice + '</span>' +
              '<span class="shop-item-discount">' + discount + '折</span>' +
            '</div>' +
            '<div class="shop-item-foot">' +
              '<span class="shop-item-sold">已售 ' + p.sold + '</span>' +
              '<button class="shop-add-cart" data-id="' + p.id + '">加入购物车</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      grid.querySelectorAll('.shop-add-cart').forEach(function (btn) {
        btn.onclick = function (e) {
          e.stopPropagation();
          var id = Number(btn.dataset.id);
          var product = PRODUCTS.find(function (p) { return p.id === id; });
          if (!product) return;
          var cart = loadCart();
          var existing = cart.find(function (c) { return c.id === id; });
          if (existing) { existing.qty++; } else { cart.push({ id: id, name: product.name, price: product.price, img: product.img, qty: 1 }); }
          saveCart(cart);
          updateCartCount(host);
          toastMsg('已加入购物车');
        };
      });
      grid.querySelectorAll('.shop-item').forEach(function (item) {
        item.onclick = function () {
          var id = Number(item.dataset.id);
          var p = PRODUCTS.find(function (x) { return x.id === id; });
          if (p) openProduct(p);
        };
      });
    }

    function updateCartCount(h) {
      var cart = loadCart();
      var count = cart.reduce(function (s, c) { return s + c.qty; }, 0);
      var el = h.querySelector('.shop-cart-count');
      if (el) el.textContent = count;
    }

    host.querySelectorAll('.shop-cat').forEach(function (btn) {
      btn.onclick = function () {
        host.querySelectorAll('.shop-cat').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        curCat = btn.dataset.cat;
        render();
      };
    });
    searchInput.oninput = function () { kw = searchInput.value; render(); };

    host.querySelector('.shop-cart-btn').onclick = function () { openCart(host, render); };

    updateCartCount(host);
    render();
  }

  function openProduct(p) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(520px,94vw);max-height:88vh;overflow:auto';
    var discount = Math.round(p.price / p.oldPrice * 10);
    box.innerHTML =
      '<div class="product-detail">' +
        '<button class="modal-x" type="button">&times;</button>' +
        '<div class="product-img">' + p.img + '</div>' +
        '<div class="product-price-row"><span class="product-price">¥' + p.price + '</span><span class="product-old">¥' + p.oldPrice + '</span><span class="product-discount">' + discount + '折</span></div>' +
        '<h2 class="product-name">' + esc(p.name) + '</h2>' +
        '<div class="product-desc">' + esc(p.desc) + '</div>' +
        '<div class="product-sold">已售 ' + p.sold + ' 件</div>' +
        '<button class="product-buy">立即购买</button>' +
      '</div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.modal-x').onclick = function () { mask.remove(); };
    box.querySelector('.product-buy').onclick = function () {
      var cart = loadCart();
      cart.push({ id: p.id, name: p.name, price: p.price, img: p.img, qty: 1 });
      saveCart(cart);
      mask.remove();
      toastMsg('已添加，购买功能演示中');
    };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
  }

  function openCart(host, refreshFn) {
    var cart = loadCart();
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(480px,94vw);max-height:80vh;overflow:auto';
    var total = cart.reduce(function (s, c) { return s + c.price * c.qty; }, 0);
    box.innerHTML =
      '<div class="cart-head"><span>购物车</span><button class="modal-x" type="button">&times;</button></div>' +
      '<div class="cart-list">' + (cart.length ? cart.map(function (c, i) {
        return '<div class="cart-item">' +
          '<div class="cart-item-img">' + c.img + '</div>' +
          '<div class="cart-item-info"><div class="cart-item-name">' + esc(c.name) + '</div>' +
          '<div class="cart-item-price">¥' + c.price + ' × ' + c.qty + '</div></div>' +
          '<button class="cart-item-del" data-idx="' + i + '">删除</button>' +
        '</div>';
      }).join('') : '<div class="cart-empty">购物车是空的</div>') + '</div>' +
      (cart.length ? '<div class="cart-foot"><span>合计：¥' + total.toFixed(2) + '</span><button class="cart-checkout">结算</button></div>' : '');
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.modal-x').onclick = function () { mask.remove(); };
    box.querySelectorAll('.cart-item-del').forEach(function (btn) {
      btn.onclick = function () {
        var idx = Number(btn.dataset.idx);
        cart.splice(idx, 1);
        saveCart(cart);
        mask.remove();
        openCart(host, refreshFn);
        if (host) {
          var count = cart.reduce(function (s, c) { return s + c.qty; }, 0);
          var el = host.querySelector('.shop-cart-count');
          if (el) el.textContent = count;
        }
      };
    });
    var checkout = box.querySelector('.cart-checkout');
    if (checkout) checkout.onclick = function () {
      toastMsg('结算功能演示中，共 ¥' + total.toFixed(2));
      cart = [];
      saveCart(cart);
      mask.remove();
      if (host) {
        var el = host.querySelector('.shop-cart-count');
        if (el) el.textContent = '0';
      }
    };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(680px,94vw);max-height:88vh;overflow:auto';
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

  window.SecureChatShop = { name: '购物', label: '购物', icon: '购', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('shop', { name: '购物', label: '购物', icon: '购', open: openPanel, mount: mount });
  }
}());
