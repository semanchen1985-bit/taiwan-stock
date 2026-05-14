// bt/storage.js — BacktestStorageManager v4.0
"use strict";

var BacktestStorage = (function() {

  var SCHEMA_VERSION = '4.0';
  var PREFIX = 'bt_v4_';
  var MAX_SNAPSHOTS = 10;

  // ── 壓縮（簡易 RLE for equity array）──────────────────────
  function compressEquity(equity, dates) {
    // 每 5 筆取 1，並只保留整數
    var eq = [];
    var dt = [];
    for (var i = 0; i < equity.length; i += 5) {
      eq.push(Math.round(equity[i]));
      if (dates) dt.push(dates[i]);
    }
    return { eq: eq, dt: dt };
  }

  // ── Schema 版本檢查 ────────────────────────────────────────
  function checkVersion(raw) {
    try {
      var obj = JSON.parse(raw);
      return obj && obj._schemaVersion === SCHEMA_VERSION ? obj : null;
    } catch(e) { return null; }
  }

  // ── save ──────────────────────────────────────────────────
  function saveLastResult(result, data, config) {
    try {
      var compressed = compressEquity(result.equity, data ? data.dates : null);
      var snapshot = {
        _schemaVersion: SCHEMA_VERSION,
        _ts: Date.now(),
        _code: config.code || (data && data.code) || 'unknown',
        config:  config,
        metrics: result.metrics,
        trades:  result.trades,
        annual:  result.annual,
        equity:  compressed.eq,
        dates:   compressed.dt,
      };
      var raw = JSON.stringify(snapshot);
      localStorage.setItem(PREFIX + 'last', raw);

      // 快照歷史
      var hist = loadHistory();
      hist.unshift({
        ts:     snapshot._ts,
        code:   snapshot._code,
        cagr:   result.metrics.cagr,
        sharpe: result.metrics.sharpe,
        maxDD:  result.metrics.maxDD,
      });
      if (hist.length > MAX_SNAPSHOTS) hist = hist.slice(0, MAX_SNAPSHOTS);
      localStorage.setItem(PREFIX + 'history', JSON.stringify(hist));

      return true;
    } catch(e) {
      console.warn('[Storage] saveLastResult failed:', e.message);
      return false;
    }
  }

  function loadLastResult() {
    try {
      var raw = localStorage.getItem(PREFIX + 'last');
      if (!raw) return null;
      return checkVersion(raw);
    } catch(e) { return null; }
  }

  // ── strategies ────────────────────────────────────────────
  function saveStrategy(entry) {
    try {
      var list = loadStrategies();
      entry._schemaVersion = SCHEMA_VERSION;
      entry._ts = Date.now();
      var idx = list.findIndex(function(s){ return s.name === entry.name; });
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      localStorage.setItem(PREFIX + 'strategies', JSON.stringify(list));
      return true;
    } catch(e) { return false; }
  }

  function loadStrategies() {
    try {
      var raw = localStorage.getItem(PREFIX + 'strategies');
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(function(s){ return s._schemaVersion === SCHEMA_VERSION; }) : [];
    } catch(e) { return []; }
  }

  function deleteStrategy(name) {
    var list = loadStrategies().filter(function(s){ return s.name !== name; });
    localStorage.setItem(PREFIX + 'strategies', JSON.stringify(list));
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(PREFIX + 'history');
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  }

  // ── optimize / batch results ──────────────────────────────
  function saveOptResult(results, config) {
    try {
      localStorage.setItem(PREFIX + 'opt', JSON.stringify({
        _schemaVersion: SCHEMA_VERSION, _ts: Date.now(),
        config: config, results: results.slice(0, 30)
      }));
    } catch(e) {}
  }

  function loadOptResult() {
    try {
      var raw = localStorage.getItem(PREFIX + 'opt');
      return raw ? checkVersion(raw) : null;
    } catch(e) { return null; }
  }

  function saveBatchResult(results) {
    try {
      localStorage.setItem(PREFIX + 'batch', JSON.stringify({
        _schemaVersion: SCHEMA_VERSION, _ts: Date.now(), results: results.slice(0, 50)
      }));
    } catch(e) {}
  }

  function loadBatchResult() {
    try {
      var raw = localStorage.getItem(PREFIX + 'batch');
      return raw ? checkVersion(raw) : null;
    } catch(e) { return null; }
  }

  // ── cleanup ───────────────────────────────────────────────
  function cleanup() {
    // 清除舊版 schema 的資料
    var oldPrefixes = ['bt_', 'bt_v2_', 'bt_v3_'];
    oldPrefixes.forEach(function(p) {
      Object.keys(localStorage).forEach(function(k) {
        if (k.startsWith(p) && !k.startsWith(PREFIX)) {
          try { localStorage.removeItem(k); } catch(e) {}
        }
      });
    });
  }

  // ── export ────────────────────────────────────────────────
  function exportFullJSON(result, data, config) {
    return JSON.stringify({
      _schemaVersion: SCHEMA_VERSION,
      _exportTime: new Date().toISOString(),
      config:  config,
      metrics: result.metrics,
      trades:  result.trades,
      annual:  result.annual,
      equity:  result.equity.filter(function(_,i){return i%5===0;}).map(Math.round),
      dates:   (data && data.dates ? data.dates : []).filter(function(_,i){return i%5===0;}),
    }, null, 2);
  }

  function exportTradesCSV(result) {
    var rows = ['\uFEFF日期,方向,備註,進場價,出場價,張數,淨損益(元),損益%,進場日期'];
    (result.trades || []).filter(function(t){return t.type==='exit';}).forEach(function(t) {
      rows.push([
        t.exitDate||t.date||'', t.side==='long'?'多單':'空單', t.reason||'',
        t.entryPrice.toFixed(2), t.exitPrice.toFixed(2),
        t.qty, Math.round(t.netPnl), t.pnlPct.toFixed(2)+'%', t.entryDate||''
      ].join(','));
    });
    return rows.join('\r\n');
  }

  function exportEquityCSV(result, dates) {
    var rows = ['\uFEFF日期,淨值,報酬率%'];
    var eq   = result.equity;
    var init = eq[0] || result.metrics.initCapital;
    eq.forEach(function(v, i) {
      rows.push([(dates&&dates[i])||i, Math.round(v), ((v-init)/init*100).toFixed(2)].join(','));
    });
    return rows.join('\r\n');
  }

  // 執行 cleanup 於初始化
  cleanup();

  return {
    saveLastResult, loadLastResult,
    saveStrategy, loadStrategies, deleteStrategy, loadHistory,
    saveOptResult, loadOptResult,
    saveBatchResult, loadBatchResult,
    exportFullJSON, exportTradesCSV, exportEquityCSV,
    SCHEMA_VERSION,
  };
})();
