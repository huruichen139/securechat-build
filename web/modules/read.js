// module: read (看一看) —— 精选资讯信息流
(function () {
  'use strict';
  if (window.SecureChatRead) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  var FEED = [
    { cat: '科技', title: 'AI 大模型最新进展：多模态能力再突破', src: '科技日报', time: '2小时前', summary: '新一代多模态大模型在图像理解、代码生成和长文本推理方面取得显著进展，准确率提升 23%。', read: '12.5万' },
    { cat: '财经', title: '央行发布最新货币政策报告', src: '新华财经', time: '3小时前', summary: '报告指出将继续实施稳健的货币政策，保持流动性合理充裕，促进综合融资成本稳中有降。', read: '8.3万' },
    { cat: '社会', title: '全国高铁里程突破 4.5 万公里', src: '人民日报', time: '5小时前', summary: '随着多条新线路开通运营，全国高铁营业里程再创新高，覆盖 95% 以上百万人口城市。', read: '23.1万' },
    { cat: '体育', title: '国足世预赛最新战报', src: '体坛周报', time: '6小时前', summary: '在昨晚的世预赛亚洲区比赛中，国家队凭借下半场两粒进球取得关键胜利，小组出线形势明朗。', read: '45.2万' },
    { cat: '生活', title: '秋季养生指南：这些食物最养肺', src: '健康时报', time: '8小时前', summary: '入秋后气候干燥，专家推荐梨、百合、银耳、蜂蜜等润肺食材，搭配适量运动增强免疫力。', read: '6.7万' },
    { cat: '国际', title: '全球气候大会达成新共识', src: '环球时报', time: '12小时前', summary: '各方就减排目标、资金支持和技术转移等核心议题达成一致，将加速可再生能源部署。', read: '15.9万' },
    { cat: '娱乐', title: '国庆档电影票房破 30 亿', src: '猫眼电影', time: '1天前', summary: '多部大片同台竞技，主旋律影片领跑票房榜，观影人次超 8000 万，创下近年新高。', read: '31.4万' },
    { cat: '科技', title: '国产芯片制造工艺取得新进展', src: '半导体行业观察', time: '1天前', summary: '国内半导体企业在先进制程量产方面取得突破，良率稳步提升，国产替代进程加速推进。', read: '9.8万' },
    { cat: '教育', title: '2025 考研报名时间公布', src: '中国教育报', time: '1天前', summary: '教育部发布考研日程安排，网上预报名将于本月启动，全国预计报考人数超 500 万。', read: '7.2万' },
    { cat: '汽车', title: '新能源汽车销量连续多月增长', src: '汽车之家', time: '2天前', summary: '最新数据显示新能源汽车渗透率突破 45%，多款新车型上市带动市场需求持续旺盛。', read: '5.6万' },
  ];
  // 远程真实新闻（新浪聚合，经服务端 /api/feeds/news 代理）；加载失败时回退上面的演示数据
  var REMOTE = null;
  var cats = ['全部', '科技', '财经', '社会', '体育', '生活', '娱乐'];

  var liked = {};

  function feedList() { return REMOTE || FEED; }

  function apiHost() {
    if (window.SERVER_HOST) return String(window.SERVER_HOST).replace(/\/$/, '');
    return '';
  }

  function loadRemote(tabsEl, render) {
    fetch(apiHost() + '/api/feeds/news').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.list) || d.list.length === 0) throw new Error('empty');
      REMOTE = d.list;
      if (d.cats && Array.isArray(d.cats) && d.cats.length) {
        var merged = ['全部'];
        d.cats.forEach(function (c) { if (merged.indexOf(c) < 0) merged.push(c); });
        cats = merged;
        rebuildTabs(tabsEl, render);
      }
      render();
    }).catch(function () {
      // 上游不可用时回退演示数据
      render();
    });
  }

  function rebuildTabs(tabsEl, render) {
    tabsEl.innerHTML = cats.map(function (c, i) {
      return '<button class="read-tab' + (i === 0 ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    bindTabs(tabsEl, render);
  }

  function bindTabs(tabsEl, render) {
    tabsEl.querySelectorAll('.read-tab').forEach(function (tab) {
      tab.onclick = function () {
        tabsEl.querySelectorAll('.read-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        curCat = tab.dataset.cat;
        render();
      };
    });
  }

  var curCat = '全部';

  function mount(host) {
    host.className = (host.className || '') + ' read-panel';
    host.innerHTML =
      '<div class="read-head">' +
        '<div class="read-title">看一看</div>' +
        '<div class="read-tabs" id="readTabs"></div>' +
      '</div>' +
      '<div class="read-feed"></div>';

    var feed = host.querySelector('.read-feed');
    var tabsEl = host.querySelector('.read-tabs');
    var render = function () {
      var list = curCat === '全部' ? feedList() : feedList().filter(function (f) { return f.cat === curCat; });
      if (!list.length) {
        feed.innerHTML = '<div style="padding:40px;text-align:center;color:#999">该分类暂无资讯</div>';
        return;
      }
      feed.innerHTML = list.map(function (f, i) {
        var isLiked = liked[i] ? ' liked' : '';
        return '<div class="read-card" data-idx="' + i + '">' +
          '<div class="read-card-cat">' + esc(f.cat) + '</div>' +
          '<div class="read-card-title">' + esc(f.title) + '</div>' +
          '<div class="read-card-summary">' + esc(f.summary) + '</div>' +
          '<div class="read-card-foot">' +
            '<span class="read-card-src">' + esc(f.src || '') + '</span>' +
            '<span class="read-card-time">' + esc(f.time || '') + '</span>' +
            (f.read ? '<span class="read-card-read">' + esc(f.read) + '阅读</span>' : '') +
            '<button class="read-like' + isLiked + '" data-idx="' + i + '">' + (liked[i] ? '已赞' : '赞') + '</button>' +
          '</div>' +
        '</div>';
      }).join('');

      feed.querySelectorAll('.read-card').forEach(function (card) {
        card.onclick = function (e) {
          if (e.target.classList.contains('read-like')) return;
          var idx = Number(card.dataset.idx);
          openArticle(list[idx]);
        };
      });
      feed.querySelectorAll('.read-like').forEach(function (btn) {
        btn.onclick = function (e) {
          e.stopPropagation();
          var idx = Number(btn.dataset.idx);
          liked[idx] = !liked[idx];
          btn.classList.toggle('liked');
          btn.textContent = liked[idx] ? '已赞' : '赞';
        };
      });
    };
    loadRemote(tabsEl, render);
  }

  function openArticle(a) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal read-article';
    box.style.cssText = 'width:min(680px,94vw);max-height:88vh;overflow:auto';
    box.innerHTML =
      '<div class="read-article-head">' +
        '<span class="read-article-cat">' + esc(a.cat) + '</span>' +
        '<button class="modal-x" type="button">&times;</button>' +
      '</div>' +
      '<h2 class="read-article-title">' + esc(a.title) + '</h2>' +
      '<div class="read-article-meta">' + esc(a.src || '') + ' · ' + esc(a.time || '') + (a.read ? ' · ' + esc(a.read) + '阅读' : '') + '</div>' +
      '<div class="read-article-body">' + esc(a.summary) + '</div>' +
      (a.url ? '<div class="read-article-body" style="margin-top:14px"><a href="' + esc(a.url) + '" target="_blank" rel="noopener" style="color:#1989fa;text-decoration:none">打开原文 ↗</a></div>' : '') +
      (!a.url ? '<div class="read-article-body" style="color:#888;margin-top:12px">这是 SecureChat 看一看频道精选资讯演示内容。更多精彩内容正在路上。</div>' : '');
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.modal-x').onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(620px,94vw);max-height:88vh;overflow:auto';
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

  window.SecureChatRead = { name: '看一看', label: '看一看', icon: '看', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('read', { name: '看一看', label: '看一看', icon: '看', open: openPanel, mount: mount });
  }
}());
