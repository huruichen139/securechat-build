(function () {
  'use strict';

  var PLATFORMS = [
    { key: 'windows', name: 'Windows', description: 'Windows 7 / 10 / 11' },
    { key: 'macos', name: 'macOS', description: 'macOS 10.15 及以上' },
    { key: 'android', name: 'Android', description: 'Android 6.0 及以上' },
    { key: 'ios', name: 'iOS', description: 'iOS 12 及以上' },
    { key: 'harmony', name: '鸿蒙 HarmonyOS', description: 'HarmonyOS 4 及以上（.hap）' }
  ];

  function apiHost() {
    var configured = window.DOWNLOAD_API_HOST || window.SERVER_HOST || '';
    try {
      var query = new URLSearchParams(window.location.search).get('api');
      configured = query || configured;
    } catch (ignore) {}
    if (!configured) {
      var host = window.location.hostname || '';
      configured = 'https://mc.32768.top:8888';
    }
    return String(configured).replace(/\/$/, '');
  }

  function platformFromUserAgent(ua) {
    ua = ua || '';
    if (/HarmonyOS|OpenHarmony|ArkWeb/i.test(ua)) return 'harmony';
    // iPadOS 13+ may identify itself as Macintosh, but retains touch points.
    if (/iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
    return 'windows';
  }

  function absoluteDownload(link, apiUrl) {
    if (!link) return '';
    try {
      // Relative API links must resolve against the API origin when the page
      // is hosted separately; same-origin deployments use the page as base.
      var base = /^https?:\/\//i.test(apiUrl) ? apiUrl : document.baseURI;
      return new URL(String(link), base).href;
    } catch (e) { return ''; }
  }

  function addText(parent, tag, text, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function downloadControl(url) {
    if (!url) return addText(document.createDocumentFragment(), 'span', '暂未提供，敬请期待', 'download disabled');
    var link = document.createElement('a');
     link.className = 'download'; link.href = url; link.textContent = '下载';
    link.setAttribute('download', '');
    link.target = '_blank'; link.rel = 'noopener';
    return link;
  }

  function card(platform, version, url) {
    var article = document.createElement('article'); article.className = 'platform';
    addText(article, 'h3', platform.name);
    addText(article, 'p', platform.description, 'details');
    addText(article, 'div', '版本 v' + version, 'version');
    article.appendChild(downloadControl(url));
    return article;
  }

  function render(data, apiUrl, root) {
    root = root || document;
    var version = String(data.latest || data.current || '1.0.0');
    var downloads = data.downloads || {};
    var recommendedKey = platformFromUserAgent(navigator.userAgent);
    var recommended = PLATFORMS.filter(function (p) { return p.key === recommendedKey; })[0] || PLATFORMS[0];
    var url = absoluteDownload(downloads[recommended.key], apiUrl);
    var target = root.querySelector('#recommended');
    if (!target) target = root.querySelector('#downloadRecommended');
    target.textContent = '';
    var copy = document.createElement('div');
    addText(copy, 'div', '推荐下载', 'recommend-label');
     addText(copy, 'h1', recommended.name, 'platform-name');
    addText(copy, 'p', recommended.description, 'details');
    addText(copy, 'div', '最新版本 v' + version, 'version');
    target.appendChild(copy); target.appendChild(downloadControl(url));

    var list = root.querySelector('#platform-list');
    if (!list) list = root.querySelector('#download-platform-list');
    list.textContent = '';
    PLATFORMS.filter(function (p) { return p.key !== recommended.key; }).forEach(function (p) {
      list.appendChild(card(p, version, absoluteDownload(downloads[p.key], apiUrl)));
    });
    var status = root.querySelector('#status') || root.querySelector('#downloadStatus');
    if (status) status.textContent = data.releaseNotes ? '最新版本：v' + version + ' · ' + data.releaseNotes : '最新版本：v' + version;
  }

  var apiUrl = apiHost() + '/api/version';
  var loaded = null;
  function initDownloadView(root) {
    root = root || document;
    if (loaded) { render(loaded, apiUrl, root); return; }
    var status = root.querySelector('#status') || root.querySelector('#downloadStatus');
    if (status) status.textContent = '正在获取最新版本…';
    fetch(apiUrl).then(function (response) {
      if (!response.ok) throw new Error('API ' + response.status);
      return response.json();
    }).then(function (data) {
      loaded = data;
      render(data, apiUrl, root);
    }).catch(function () {
      if (status) status.textContent = '暂时无法获取版本信息，请稍后刷新重试。';
      render({ current: '—', downloads: {} }, apiUrl, root);
    });
  }
  window.initDownloadView = initDownloadView;
  // download.html 仍使用同一套识别、推荐平台和列表逻辑。
  if (document.getElementById('status')) initDownloadView(document);
}());
