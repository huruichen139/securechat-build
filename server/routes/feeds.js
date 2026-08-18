'use strict';
// module: feeds —— 真实资讯聚合（新浪新闻滚动）与热门视频（B站排行榜）
// 服务端代理 + 5 分钟内存缓存；上游不可用时回退旧缓存或返回空列表，不阻断主服务。
module.exports = function registerFeeds(app, db, auth) {
  const http = require('http');
  const https = require('https');
  const cache = new Map();
  const TTL = 5 * 60 * 1000;

  const NEWS_CATS = [
    { lid: '2517', cat: '国内' },
    { lid: '2518', cat: '国际' },
    { lid: '2519', cat: '社会' },
    { lid: '2520', cat: '体育' },
    { lid: '2522', cat: '娱乐' },
    { lid: '2524', cat: '财经' },
    { lid: '2526', cat: '科技' },
    { lid: '2538', cat: '军事' },
  ];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SecureChat/1.0';

  function getJson(url) {
    return new Promise((resolve, reject) => {
      const mod = url.indexOf('https:') === 0 ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('upstream ' + res.statusCode)); return; }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      });
      req.setTimeout(8000, () => req.destroy(new Error('upstream timeout')));
      req.on('error', reject);
    });
  }

  function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - TTL) return Promise.resolve(hit.value);
    return Promise.resolve().then(loader).then((v) => {
      cache.set(key, { at: Date.now(), value: v });
      return v;
    }).catch((e) => {
      if (hit) return hit.value;
      throw e;
    });
  }

  function relTime(unixSec) {
    const s = Math.max(0, Date.now() / 1000 - unixSec);
    if (s < 60) return Math.floor(s) + '秒前';
    if (s < 3600) return Math.floor(s / 60) + '分钟前';
    if (s < 86400) return Math.floor(s / 3600) + '小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + '天前';
    return new Date(unixSec * 1000).toLocaleDateString('zh-CN');
  }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  function fmtDuration(sec) {
    sec = Number(sec) || 0;
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return m + ':' + s;
  }

  async function loadNews() {
    const tasks = NEWS_CATS.map((c) => getJson(
      'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=' + c.lid + '&k=&num=12&page=1'
    ).then((j) => {
      const list = (j && j.result && j.result.data) || [];
      return list.map((d) => ({
        id: String(d.docid || (d.oid || '') + '-' + c.lid),
        cat: c.cat,
        title: String(d.title || '').trim(),
        src: String(d.media_name || '新浪新闻').trim(),
        time: relTime(parseInt(d.intime, 10) || 0),
        summary: String(d.intro || d.summary || '').trim(),
        url: String(d.wapurl || d.url || ''),
        img: (d.img && d.img.u) ? String(d.img.u).replace(/^http:/, 'https:') : '',
      })).filter((x) => x.title);
    }).catch(() => []));
    const groups = await Promise.all(tasks);
    const all = [];
    for (const g of groups) all.push.apply(all, g);
    return { ok: true, source: 'sina', list: all, cats: NEWS_CATS.map((c) => c.cat) };
  }

  async function loadVideos() {
    const j = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all&ps=30');
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.list)) throw new Error('bilibili bad response');
    const list = j.data.list.map((v) => ({
      id: String(v.bvid || v.aid || ''),
      title: String(v.title || '').trim(),
      pic: String(v.pic || '').replace(/^http:/, 'https:'),
      owner: (v.owner && v.owner.name) || '',
      view: fmtCount(v.stat && v.stat.view),
      like: fmtCount(v.stat && v.stat.like),
      duration: fmtDuration(v.duration),
      created: relTime(v.pubdate),
      url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
      desc: String(v.desc || '').trim(),
    }));
    return { ok: true, source: 'bilibili', list };
  }

  // GET /api/feeds/news —— 真实新闻聚合（新浪）
  app.get('/api/feeds/news', (req, res) => {
    cached('news', loadNews).then((v) => res.json(v)).catch(() => res.status(502).json({ ok: false, error: '上游新闻源暂不可用', list: [] }));
  });

  // GET /api/feeds/videos —— 热门视频（B站排行榜）
  app.get('/api/feeds/videos', (req, res) => {
    cached('videos', loadVideos).then((v) => res.json(v)).catch(() => res.status(502).json({ ok: false, error: '上游视频源暂不可用', list: [] }));
  });
};
