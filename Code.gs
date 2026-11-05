/**
 * 股票追蹤 — 報價中繼（Google Apps Script）
 *
 * 網頁不能直接向證交所、Yahoo 要資料，所以由這支程式在 Google 的伺服器上代抓，再回傳給網頁。
 *
 * 部署方式（詳見 README）：
 *   1. 到 https://script.google.com 新增專案，把這整份貼上，存檔。
 *   2. 上方選 testSetup，按「執行」，依提示授權（只需要第一次）。
 *   3. 右上「部署」>「新增部署作業」> 類型選「網頁應用程式」
 *        執行身分：我　　誰可以存取：所有人
 *   4. 複製「網頁應用程式網址」（結尾是 /exec），貼到網頁的「設定 > 報價來源」。
 *
 * 之後如果修改了這份程式：部署 > 管理部署作業 > 編輯（鉛筆）> 版本選「新版本」> 部署。網址不會變。
 */

// 選填：設一段密語，別人就算拿到網址也不能用。設了之後，網頁設定裡的「存取密語」要填一樣的。
const ACCESS_KEY = '';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*'
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (ACCESS_KEY && p.key !== ACCESS_KEY) return json_({ error: 'unauthorized' });
  try {
    if (p.action === 'history') {
      return json_(history_(p.symbol, p.range || '2y', p.interval || '1d'));
    }
    return json_(quotes_(p));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

/* ---------------- 即時報價 ---------------- */

function quotes_(p) {
  const tw = splitList_(p.tw);
  const us = splitList_(p.us).map(function (s) { return s.toUpperCase(); });
  const wantFx = p.fx === '1';
  const cacheKey = 'q:' + tw.join(',') + '|' + us.join(',') + '|' + (wantFx ? 1 : 0);
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);

  const out = { time: Date.now(), tw: {}, us: {}, fx: null, errors: [] };

  // 台股：證交所基本市況報導（上市 tse、上櫃 otc 都送，哪個有資料就用哪個）
  if (tw.length) {
    try {
      const got = twse_(tw);
      Object.keys(got).forEach(function (c) { out.tw[c] = got[c]; });
    } catch (err) {
      out.errors.push('twse: ' + err);
    }
    // 證交所抓不到的，改用 Yahoo（可能延遲）
    const missing = tw.filter(function (c) { return !out.tw[c]; });
    if (missing.length) {
      const reqs = [];
      missing.forEach(function (c) { reqs.push(c + '.TW'); reqs.push(c + '.TWO'); });
      const ys = yahooQuotes_(reqs);
      missing.forEach(function (c) {
        const q = ys[c + '.TW'] || ys[c + '.TWO'];
        if (q) {
          q.code = c;
          q.ex = ys[c + '.TW'] ? 'tse' : 'otc';
          q.src = 'yahoo';
          q.delayed = true;
          out.tw[c] = q;
        } else {
          out.errors.push('tw not found: ' + c);
        }
      });
    }
  }

  // 美股與匯率：Yahoo Finance
  const ySyms = us.slice();
  if (wantFx) ySyms.push('TWD=X');
  if (ySyms.length) {
    const ys = yahooQuotes_(ySyms);
    us.forEach(function (s) {
      if (ys[s]) { ys[s].src = 'yahoo'; out.us[s] = ys[s]; }
      else out.errors.push('us not found: ' + s);
    });
    if (wantFx && ys['TWD=X']) out.fx = ys['TWD=X'].price;
  }

  try { cache.put(cacheKey, JSON.stringify(out), 5); } catch (err) { /* 太大就不快取 */ }
  return out;
}

function twse_(codes) {
  const chs = [];
  codes.forEach(function (c) { chs.push('tse_' + c + '.tw'); chs.push('otc_' + c + '.tw'); });
  const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&_=' + Date.now() +
    '&ex_ch=' + encodeURIComponent(chs.join('|'));
  let body = fetchText_(url, UA);
  let data = safeJson_(body);
  if (!data || !data.msgArray || !data.msgArray.length) {
    // 有時候要先拿到 cookie 才會回資料
    const home = UrlFetchApp.fetch('https://mis.twse.com.tw/stock/index.jsp', { headers: UA, muteHttpExceptions: true });
    const setCookie = home.getAllHeaders()['Set-Cookie'];
    const cookie = [].concat(setCookie || []).map(function (s) { return String(s).split(';')[0]; }).join('; ');
    const h = Object.assign({}, UA, cookie ? { Cookie: cookie } : {});
    body = fetchText_(url, h);
    data = safeJson_(body);
  }
  const out = {};
  ((data && data.msgArray) || []).forEach(function (m) {
    const bid = firstNum_(m.b), ask = firstNum_(m.a);
    const last = num_(m.z);
    const prev = num_(m.y);
    const price = last || bid || ask || prev;
    if (!price) return;
    out[m.c] = {
      code: m.c,
      name: m.n || '',
      ex: m.ex,
      price: price,
      lastTrade: !!last,
      prev: prev,
      open: num_(m.o),
      high: num_(m.h),
      low: num_(m.l),
      vol: num_(m.v),          // 張
      time: Number(m.tlong) || Date.now(),
      src: 'twse',
      delayed: false
    };
  });
  return out;
}

function yahooQuotes_(symbols) {
  const reqs = symbols.map(function (s) {
    return {
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?range=1d&interval=5m&includePrePost=false',
      headers: UA,
      muteHttpExceptions: true
    };
  });
  const res = UrlFetchApp.fetchAll(reqs);
  const out = {};
  res.forEach(function (r, i) {
    if (r.getResponseCode() !== 200) return;
    const d = safeJson_(r.getContentText());
    const result = d && d.chart && d.chart.result && d.chart.result[0];
    if (!result || !result.meta) return;
    const m = result.meta;
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const opens = (q.open || []).filter(function (v) { return v != null; });
    if (m.regularMarketPrice == null) return;
    out[symbols[i]] = {
      code: symbols[i],
      name: m.shortName || m.longName || '',
      price: m.regularMarketPrice,
      prev: m.previousClose != null ? m.previousClose : m.chartPreviousClose,
      open: opens.length ? opens[0] : null,
      high: m.regularMarketDayHigh != null ? m.regularMarketDayHigh : null,
      low: m.regularMarketDayLow != null ? m.regularMarketDayLow : null,
      vol: m.regularMarketVolume != null ? m.regularMarketVolume : null,
      time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
      currency: m.currency || ''
    };
  });
  return out;
}

/* ---------------- 歷史 K 線（第二階段會用到） ---------------- */
// 例：?action=history&symbol=2330.TW&range=2y&interval=1d
function history_(symbol, range, interval) {
  if (!symbol) return { error: 'symbol required' };
  const cache = CacheService.getScriptCache();
  const key = 'h:' + symbol + ':' + range + ':' + interval;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + encodeURIComponent(range) + '&interval=' + encodeURIComponent(interval) + '&events=div,split';
  const d = safeJson_(fetchText_(url, UA));
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r) return { error: 'no data', symbol: symbol };
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  (r.timestamp || []).forEach(function (t, i) {
    if (q.open[i] == null || q.close[i] == null) return;
    bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
  });
  const out = { symbol: symbol, currency: r.meta && r.meta.currency, bars: bars };
  try { cache.put(key, JSON.stringify(out), 600); } catch (err) { /* 資料太大就不快取 */ }
  return out;
}

/* ---------------- 工具 ---------------- */

function fetchText_(url, headers) {
  const r = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
  return r.getContentText();
}
function safeJson_(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function num_(v) { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; }
function firstNum_(s) { return s ? num_(String(s).split('_')[0]) : null; }
function splitList_(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// 第一次部署前先執行這個：會跳出授權視窗，並在「執行紀錄」印出測試結果。
function testSetup() {
  const r = quotes_({ tw: '2330,6488', us: 'AAPL', fx: '1' });
  Logger.log(JSON.stringify(r, null, 2));
}
