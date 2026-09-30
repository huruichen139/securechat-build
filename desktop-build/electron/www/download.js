(function () {
  'use strict';

  var PLATFORMS = [
    { key: 'windows', name: 'Windows', descriptionKey: 'dlWinDesc', description: 'Windows 7 / 10 / 11' },
    { key: 'macos', name: 'macOS', descriptionKey: 'dlMacDesc', description: 'macOS 10.15 及以上' },
    { key: 'android', name: 'Android', descriptionKey: 'dlAndroidDesc', description: 'Android 6.0 及以上' },
    { key: 'ios', name: 'iOS', descriptionKey: 'dlIosDesc', description: 'iOS 12 及以上' },
    { key: 'harmony', name: '鸿蒙 HarmonyOS', descriptionKey: 'dlHarmonyDesc', description: 'HarmonyOS 4 及以上（.hap）' }
  ];

  function _t(key, fallback) {
    if (window.SCI18N && typeof window.SCI18N.t === 'function') {
      var v = window.SCI18N.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function platformName(p) {
    var n = _t('dlName' + p.key, p.name);
    return n;
  }
  function platformDesc(p) {
    return _t(p.descriptionKey, p.description);
  }

  function apiHost() {
    var configured = window.DOWNLOAD_API_HOST || window.SERVER_HOST || '';
    try {
      var query = new URLSearchParams(window.location.search).get('api');
      configured = query || configured;
    } catch (ignore) {}
    if (!configured) {
      configured = window.location.origin || 'https://mc.32768.top:8888';
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
    if (!url) return addText(document.createDocumentFragment(), 'span', _t('downloadUnavailable', '暂未提供，敬请期待'), 'download disabled');
    var link = document.createElement('a');
     link.className = 'download'; link.href = url; link.textContent = _t('download', '下载');
    link.setAttribute('download', '');
    link.target = '_blank'; link.rel = 'noopener';
    return link;
  }

  function card(platform, version, url) {
    var article = document.createElement('article'); article.className = 'platform';
    addText(article, 'h3', platformName(platform));
    addText(article, 'p', platformDesc(platform), 'details');
    addText(article, 'div', _t('version', '版本') + ' v' + version, 'version');
    article.appendChild(downloadControl(url));
    if (platform.key === 'ios') {
      addText(article, 'p', _t('dlIosNote', '未签名 IPA：推荐用 LiveContainer 运行（下方下载），免费签名一次即可无限运行，无需重签。'), 'note');
      var base = apiHost().replace(/\/$/, '');
      var lc = document.createElement('a'); lc.className = 'download alt';
      lc.href = base + '/downloads/LiveContainer+SideStore.ipa'; lc.textContent = _t('dlLiveContainer', '下载 LiveContainer+SideStore');
      lc.setAttribute('download', ''); lc.target = '_blank'; lc.rel = 'noopener';
      article.appendChild(lc);
      var lc2 = document.createElement('a'); lc2.className = 'download alt';
      lc2.href = base + '/downloads/LiveContainer.ipa'; lc2.textContent = _t('dlLiveContainerLite', '下载 LiveContainer（单独）');
      lc2.setAttribute('download', ''); lc2.target = '_blank'; lc2.rel = 'noopener';
      article.appendChild(lc2);
    }
    return article;
  }

  function render(data, apiUrl, root) {
    root = root || document;
    var version = String(data.latest || data.current || '1.0.0');
    var downloads = data.downloads || {};
    var downloadVersions = data.downloadVersions || {};
    // 更新日志：每次打开都显示。releaseNotes 支持数组 [{version,date,notes}]，兼容旧字符串格式
    var notesEl = root.querySelector('#changelog');
    if (notesEl) {
      notesEl.innerHTML = '';
      var releaseNotes = data.releaseNotes;
      if (typeof releaseNotes === 'string') {
        var notesText = String(releaseNotes).trim();
        if (notesText.charAt(0) === '[') {
          try {
            var parsed = JSON.parse(notesText);
            if (Array.isArray(parsed)) releaseNotes = parsed;
          } catch (ignore) {}
        }
      }
      var entries = [];
      if (Array.isArray(releaseNotes)) {
        entries = releaseNotes.filter(function (e) { return e && (e.notes || e.changes); });
        entries = entries.map(function (e) { return Object.assign({}, e, { notes: e.notes || e.changes }); });
      } else if (releaseNotes) {
        entries = [{ version: version, date: '', notes: String(releaseNotes) }];
      }
      if (entries.length) {
        var head = document.createElement('h3');
        head.textContent = _t('changelog', '更新日志');
        notesEl.appendChild(head);
        entries.forEach(function (entry) {
          var block = document.createElement('div');
          block.className = 'log-version';
          var vhead = document.createElement('div');
          vhead.className = 'log-version-title';
          var vtext = 'v' + String(entry.version || '');
          if (entry.date) vtext += '（' + String(entry.date) + '）';
          vhead.textContent = vtext;
          block.appendChild(vhead);
          var lines = Array.isArray(entry.notes) ? entry.notes
            : String(entry.notes).split(/\r?\n|;|；/).map(function (s) { return s.trim(); }).filter(Boolean);
          lines.forEach(function (line) {
            var div = document.createElement('div');
            div.className = 'log-item';
            div.textContent = '• ' + line;
            block.appendChild(div);
          });
          notesEl.appendChild(block);
        });
      } else {
        notesEl.textContent = _t('noChangelog', '暂无更新日志');
      }
    }
    var recommendedKey = platformFromUserAgent(navigator.userAgent);
    var recommended = PLATFORMS.filter(function (p) { return p.key === recommendedKey; })[0] || PLATFORMS[0];
    var url = absoluteDownload(downloads[recommended.key], apiUrl);
    var target = root.querySelector('#recommended');
    if (!target) target = root.querySelector('#downloadRecommended');
    target.textContent = '';
    var copy = document.createElement('div');
    addText(copy, 'div', _t('recommended', '推荐下载'), 'recommend-label');
     addText(copy, 'h1', platformName(recommended), 'platform-name');
    addText(copy, 'p', platformDesc(recommended), 'details');
    addText(copy, 'div', _t('version', '版本') + ' v' + (downloadVersions[recommended.key] || version), 'version');
    target.appendChild(copy); target.appendChild(downloadControl(url));
    if (recommended.key === 'ios') {
      addText(copy, 'p', _t('dlIosNote', '未签名 IPA：推荐用 LiveContainer 运行（下方下载），免费签名一次即可无限运行，无需重签。'), 'note');
      var base = apiHost().replace(/\/$/, '');
      var lc = document.createElement('a'); lc.className = 'download alt';
      lc.href = base + '/downloads/LiveContainer+SideStore.ipa'; lc.textContent = _t('dlLiveContainer', '下载 LiveContainer+SideStore');
      lc.setAttribute('download', ''); lc.target = '_blank'; lc.rel = 'noopener';
      copy.appendChild(lc);
      var lc2 = document.createElement('a'); lc2.className = 'download alt';
      lc2.href = base + '/downloads/LiveContainer.ipa'; lc2.textContent = _t('dlLiveContainerLite', '下载 LiveContainer（单独）');
      lc2.setAttribute('download', ''); lc2.target = '_blank'; lc2.rel = 'noopener';
      copy.appendChild(lc2);
    }

    var list = root.querySelector('#platform-list');
    if (!list) list = root.querySelector('#download-platform-list');
    list.textContent = '';
    PLATFORMS.filter(function (p) { return p.key !== recommended.key; }).forEach(function (p) {
      list.appendChild(card(p, downloadVersions[p.key] || version, absoluteDownload(downloads[p.key], apiUrl)));
    });
    var status = root.querySelector('#status') || root.querySelector('#downloadStatus');
    if (status) status.textContent = _t('latestVersion', '最新版本') + ': v' + version;
  }

  var apiUrl = apiHost() + '/api/version';
  var loaded = null;
  function initDownloadView(root) {
    root = root || document;
    if (loaded) { render(loaded, apiUrl, root); return; }
    var status = root.querySelector('#status') || root.querySelector('#downloadStatus');
    if (status) status.textContent = _t('detectingSystem', '正在获取最新版本…');
    fetch(apiUrl).then(function (response) {
      if (!response.ok) throw new Error('API ' + response.status);
      return response.json();
    }).then(function (data) {
      loaded = data;
      render(data, apiUrl, root);
    }).catch(function () {
      if (status) status.textContent = _t('loadFailed', '暂时无法获取版本信息，请稍后刷新重试。');
      render({ current: '—', downloads: {} }, apiUrl, root);
    });
  }
  window.initDownloadView = initDownloadView;
  // download.html 仍使用同一套识别、推荐平台和列表逻辑。
  if (document.getElementById('status')) initDownloadView(document);
}());
