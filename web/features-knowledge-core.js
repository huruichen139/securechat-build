// 知识库中心核心框架：注册 / 搜索 / 随机 / 复制 / 收藏
// 各 features-knowledge-*.js 数据模块调用 window.SecureChatKB.register(cat, entries) 注册
(function () {
  'use strict';
  var cats = {};
  var order = ['idioms', 'xiehouyu', 'riddles', 'braintwisters', 'quotes', 'jokes', 'poems', 'tongue'];
  var names = {
    idioms: '成语词典',
    xiehouyu: '歇后语',
    riddles: '谜语',
    braintwisters: '脑筋急转弯',
    quotes: '名人名言',
    jokes: '笑话大全',
    poems: '唐诗三百首',
    tongue: '绕口令'
  };
  var KEY = 'sc_kb_favs';
  var currentCat = 'all';
  var query = '';
  var viewMode = 'list';
  var panel = null;

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveFavs(f) { try { localStorage.setItem(KEY, JSON.stringify(f)); } catch (e) {} }
  function isFav(cat, idx) {
    var f = loadFavs();
    return !!(f[cat] && f[cat].indexOf(idx) >= 0);
  }
  function toggleFav(cat, idx) {
    var f = loadFavs();
    if (!f[cat]) f[cat] = [];
    var i = f[cat].indexOf(idx);
    if (i >= 0) { f[cat].splice(i, 1); } else { f[cat].push(idx); }
    saveFavs(f);
    renderList();
  }
  function favCount() {
    var f = loadFavs();
    var n = 0;
    Object.keys(f).forEach(function (k) { n += (f[k] || []).length; });
    return n;
  }
  function count(cat) {
    if (cat === 'all') {
      var n = 0;
      order.forEach(function (k) { if (cats[k]) n += cats[k].length; });
      return n;
    }
    return cats[cat] ? cats[cat].length : 0;
  }
  function hasCat(cat) { return !!cats[cat]; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function titleOf(cat, e) {
    if (e.w) return e.w;
    if (e.t) return e.t;
    if (e.q) return e.q;
    return '';
  }
  function subOf(cat, e) {
    if (e.py) return esc(e.py);
    if (e.a && (cat === 'poems' || cat === 'quotes')) return esc(e.a);
    if (e.a && (cat === 'xiehouyu' || cat === 'riddles')) return esc(e.a);
    return '';
  }
  function bodyOf(cat, e) {
    if (e.m && e.c) return esc(e.m) + '<div class="kb-ex">例：' + esc(e.c) + '</div>';
    if (e.m) return esc(e.m);
    if (e.s) return '<div class="kb-poem">' + esc(e.s) + '</div>';
    if (e.t && (cat === 'jokes' || cat === 'tongue')) return esc(e.t);
    if (e.a && (cat === 'xiehouyu' || cat === 'riddles')) return '谜底/后半句：<b>' + esc(e.a) + '</b>';
    if (e.q) return esc(e.q);
    return '';
  }

  function buildEntries() {
    var out = [];
    if (currentCat === 'all') {
      order.forEach(function (k) {
        if (cats[k]) cats[k].forEach(function (e, i) { out.push({ cat: k, idx: i, e: e }); });
      });
    } else if (currentCat === 'favs') {
      var f = loadFavs();
      Object.keys(f).forEach(function (k) {
        if (!cats[k]) return;
        (f[k] || []).forEach(function (i) {
          if (cats[k][i]) out.push({ cat: k, idx: i, e: cats[k][i] });
        });
      });
    } else if (cats[currentCat]) {
      cats[currentCat].forEach(function (e, i) { out.push({ cat: currentCat, idx: i, e: e }); });
    }
    if (query) {
      var q = query.toLowerCase();
      out = out.filter(function (it) {
        return titleOf(it.cat, it.e).toLowerCase().indexOf(q) >= 0 ||
          String(it.e.m || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.e.c || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.e.a || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.e.s || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.e.t || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    return out;
  }

  function randInt(n) { return Math.floor(Math.random() * n); }

  function renderList() {
    if (!panel) return;
    var listEl = panel.querySelector('.kb-list');
    var items = buildEntries();
    if (!items.length) {
      listEl.innerHTML = '<div class="kb-empty">没有找到相关内容</div>';
      return;
    }
    var html = '';
    items.forEach(function (it) {
      var t = titleOf(it.cat, it.e);
      var s = subOf(it.cat, it.e);
      var b = bodyOf(it.cat, it.e);
      var fav = isFav(it.cat, it.idx);
      html += '<div class="kb-item">' +
        '<div class="kb-t"><span class="kb-badge">' + esc(names[it.cat] || it.cat) + '</span>' + esc(t) + (s && s !== esc(t) ? '<div class="kb-s">' + s + '</div>' : '') + '</div>' +
        (b ? '<div class="kb-b">' + b + '</div>' : '') +
        '<div class="kb-ops">' +
        '<button class="kb-btn" data-act="copy" data-cat="' + it.cat + '" data-idx="' + it.idx + '">复制</button>' +
        '<button class="kb-btn' + (fav ? ' kb-faved' : '') + '" data-act="fav" data-cat="' + it.cat + '" data-idx="' + it.idx + '">' + (fav ? '已收藏' : '收藏') + '</button>' +
        '</div></div>';
    });
    listEl.innerHTML = html;
  }

  function render() {
    if (!panel) return;
    var tabsHtml = '<div class="kb-tab' + (currentCat === 'all' ? ' kb-tab-on' : '') + '" data-cat="all">全部（' + count('all') + '）</div>';
    order.forEach(function (k) {
      if (hasCat(k)) {
        tabsHtml += '<div class="kb-tab' + (currentCat === k ? ' kb-tab-on' : '') + '" data-cat="' + k + '">' + esc(names[k]) + '（' + count(k) + '）</div>';
      }
    });
    tabsHtml += '<div class="kb-tab' + (currentCat === 'favs' ? ' kb-tab-on' : '') + '" data-cat="favs">我的收藏（' + favCount() + '）</div>';
    panel.querySelector('.kb-tabs').innerHTML = tabsHtml;
    renderList();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制到剪贴板');
      }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }
  var toastTimer = null;
  function toast(msg) {
    if (!panel) return;
    var el = panel.querySelector('.kb-toast');
    el.textContent = msg;
    el.classList.add('kb-toast-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('kb-toast-on'); }, 1500);
  }

  function onPanelClick(ev) {
    var t = ev.target;
    if (t.classList.contains('kb-tab')) {
      currentCat = t.getAttribute('data-cat');
      render();
      return;
    }
    var btn = t.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var cat = btn.getAttribute('data-cat');
    var idx = parseInt(btn.getAttribute('data-idx'), 10);
    if (act === 'copy') {
      var e = cats[cat] && cats[cat][idx];
      if (!e) return;
      var parts = [];
      if (e.w) parts.push(e.w + (e.py ? '（' + e.py + '）' : ''));
      if (e.m) parts.push(e.m);
      if (e.c) parts.push('例句：' + e.c);
      if (e.q) parts.push(e.q);
      if (e.t && (cat === 'jokes' || cat === 'tongue')) parts.push(e.t);
      if (e.a && (cat === 'xiehouyu' || cat === 'riddles')) parts.push(e.a);
      if (e.t && (cat === 'poems' || cat === 'quotes')) parts.push(e.t);
      if (e.a && (cat === 'poems' || cat === 'quotes')) parts.push('——' + e.a);
      if (e.s) parts.push(e.s);
      copyText(parts.join('\n'));
    } else if (act === 'fav') {
      toggleFav(cat, idx);
    }
  }

  function randomOne() {
    var items = buildEntries();
    if (!items.length) { toast('暂无内容'); return; }
    var it = items[randInt(items.length)];
    var t = titleOf(it.cat, it.e);
    var s = subOf(it.cat, it.e);
    var b = bodyOf(it.cat, it.e);
    var box = panel.querySelector('.kb-random-box');
    box.innerHTML = '<div class="kb-item">' +
      '<div class="kb-t"><span class="kb-badge">' + esc(names[it.cat]) + '</span>' + esc(t) + (s ? '<div class="kb-s">' + s + '</div>' : '') + '</div>' +
      (b ? '<div class="kb-b">' + b + '</div>' : '') +
      '<div class="kb-ops"><button class="kb-btn" data-act="copy" data-cat="' + it.cat + '" data-idx="' + it.idx + '">复制</button></div></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closePanel() {
    if (panel) {
      panel.parentNode.removeChild(panel);
      panel = null;
    }
    if (window.hideMobilePages) { try { window.hideMobilePages(); } catch (e) {} }
  }

  function openPanel(cat) {
    if (cat && cats[cat]) { currentCat = cat; } else if (cat === 'favs') { currentCat = 'favs'; } else { currentCat = 'all'; }
    query = '';
    if (panel) { panel.parentNode.removeChild(panel); }
    panel = document.createElement('div');
    panel.className = 'kb-panel';
    panel.innerHTML =
      '<div class="kb-head">' +
      '<div class="kb-title">知识库中心</div>' +
      '<div class="kb-sub">成语 · 歇后语 · 谜语 · 名言 · 笑话 · 唐诗 · 绕口令</div>' +
      '<div class="kb-search"><input type="text" class="kb-input" placeholder="搜索关键词…"><button class="kb-rand">随机一条</button><button class="kb-close">关闭</button></div>' +
      '</div>' +
      '<div class="kb-tabs"></div>' +
      '<div class="kb-random-box" style="display:none"></div>' +
      '<div class="kb-list"></div>' +
      '<div class="kb-toast"></div>';
    document.body.appendChild(panel);
    var input = panel.querySelector('.kb-input');
    var debounce = null;
    input.addEventListener('input', function () {
      clearTimeout(debounce);
      var v = this.value;
      debounce = setTimeout(function () { query = v; renderList(); }, 200);
    });
    panel.querySelector('.kb-rand').addEventListener('click', randomOne);
    panel.querySelector('.kb-close').addEventListener('click', closePanel);
    panel.addEventListener('click', onPanelClick);
    render();
  }

  window.SecureChatKB = {
    register: function (cat, entries) {
      cats[cat] = entries;
      if (order.indexOf(cat) < 0) order.push(cat);
      if (panel && panel.parentNode) render();
    },
    open: function (cat) { openPanel(cat); },
    close: closePanel,
    getNames: function () { return names; }
  };

  var style = document.createElement('style');
  style.textContent =
    '.kb-panel{position:fixed;top:0;right:0;bottom:0;left:390px;z-index:950;background:#ededed;display:flex;flex-direction:column;font-family:"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:-2px 0 8px rgba(0,0,0,.06)}' +
    '.kb-head{background:#f7f7f7;padding:14px 16px 10px;border-bottom:1px solid #e0e0e0;flex-shrink:0}' +
    '.kb-title{font-size:16px;font-weight:600;color:#111}' +
    '.kb-sub{font-size:12px;color:#999;margin:2px 0 10px}' +
    '.kb-search{display:flex;gap:8px;align-items:center}' +
    '.kb-input{flex:1;height:32px;border:1px solid #d8d8d8;border-radius:6px;padding:0 10px;font-size:13px;background:#fff;outline:none}' +
    '.kb-input:focus{border-color:#07c160}' +
    '.kb-rand,.kb-close{height:32px;border:none;border-radius:6px;padding:0 12px;font-size:13px;cursor:pointer;white-space:nowrap}' +
    '.kb-rand{background:#07c160;color:#fff}' +
    '.kb-close{background:#fff;color:#555;border:1px solid #d8d8d8}' +
    '.kb-tabs{display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:1px solid #e0e0e0;background:#f7f7f7;flex-shrink:0}' +
    '.kb-tab{font-size:12px;color:#555;background:#fff;border:1px solid #d8d8d8;border-radius:14px;padding:4px 12px;cursor:pointer}' +
    '.kb-tab-on{background:#07c160;border-color:#07c160;color:#fff}' +
    '.kb-list{flex:1;overflow-y:auto;padding:10px 16px}' +
    '.kb-item{background:#fff;border-radius:8px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.04)}' +
    '.kb-t{font-size:14px;color:#111;font-weight:600;line-height:1.5}' +
    '.kb-badge{display:inline-block;font-size:10px;color:#07c160;background:#e6f7ec;border-radius:4px;padding:1px 6px;margin-right:6px;vertical-align:1px;font-weight:400}' +
    '.kb-s{font-size:12px;color:#888;font-weight:400;margin-top:2px}' +
    '.kb-b{font-size:13px;color:#333;line-height:1.7;margin-top:6px}' +
    '.kb-ex{margin-top:4px;color:#999;font-size:12px}' +
    '.kb-poem{font-size:13px;line-height:2;color:#333}' +
    '.kb-ops{margin-top:8px;display:flex;gap:8px}' +
    '.kb-btn{font-size:12px;border:1px solid #d8d8d8;background:#fff;color:#555;border-radius:4px;padding:3px 12px;cursor:pointer}' +
    '.kb-btn:hover{border-color:#07c160;color:#07c160}' +
    '.kb-faved{background:#07c160;border-color:#07c160;color:#fff}' +
    '.kb-empty{padding:40px 0;text-align:center;color:#999;font-size:13px}' +
    '.kb-toast{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.75);color:#fff;font-size:13px;padding:10px 20px;border-radius:8px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:10}' +
    '.kb-toast-on{opacity:1}' +
    '@media (max-width:760px){.kb-panel{left:0}}';
  document.head.appendChild(style);

  (function drain() {
    var q = window.__kbQueue || [];
    q.forEach(function (pair) { cats[pair[0]] = pair[1]; });
  })();

  window.openKnowledgeCenter = function (cat) { openPanel(cat); };
})();