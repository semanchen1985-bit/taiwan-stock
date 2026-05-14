// bt/worker.js — Web Worker
// 所有重計算在此執行，不阻塞 UI

"use strict";

importScripts('core.js');

self.onmessage = function(e) {
  var msg = e.data;
  try {
    switch (msg.type) {

      case 'backtest': {
        var result = runBacktestEngine(msg.data, msg.config);
        self.postMessage({ type: 'backtest_done', result: result, id: msg.id });
        break;
      }

      case 'optimize': {
        var data   = msg.data;
        var config = msg.config;
        var target = msg.target || 'cagr';
        var params = msg.params || generateParamGrid();
        var total  = params.length;
        var results = [];

        for (var i = 0; i < total; i++) {
          var c = Object.assign({}, config, params[i]);
          try {
            var r = runBacktestEngine(data, c);
            var score = getScore(r.metrics, target);
            results.push({ params: params[i], metrics: r.metrics, score: score });
          } catch(e2) {}

          // 每 10 筆回報進度
          if (i % 10 === 9 || i === total - 1) {
            self.postMessage({ type: 'optimize_progress', pct: ((i+1)/total*100)|0, id: msg.id });
          }
        }

        results.sort(function(a,b){ return b.score - a.score; });
        self.postMessage({ type: 'optimize_done', results: results.slice(0, 30), id: msg.id });
        break;
      }

      case 'batch': {
        var data    = msg.data;
        var config  = msg.config;
        var combos  = msg.combos;
        var target  = msg.target || 'cagr';
        var total   = combos.length;
        var results = [];

        for (var i = 0; i < total; i++) {
          var c = Object.assign({}, config, {
            longEntry: combos[i].entry,
            longExit:  combos[i].exit,
          });
          try {
            var r = runBacktestEngine(data, c);
            var score = getScore(r.metrics, target);
            results.push({
              entry:   combos[i].entry[0],
              exit:    combos[i].exit[0],
              metrics: r.metrics,
              score:   score,
            });
          } catch(e2) {}

          if (i % 5 === 4 || i === total - 1) {
            self.postMessage({ type: 'batch_progress', pct: ((i+1)/total*100)|0, id: msg.id });
          }
        }

        results.sort(function(a,b){ return b.score - a.score; });
        self.postMessage({ type: 'batch_done', results: results.slice(0, 50), id: msg.id });
        break;
      }

      default:
        self.postMessage({ type: 'error', message: 'Unknown message type: ' + msg.type, id: msg.id });
    }
  } catch(err) {
    self.postMessage({ type: 'error', message: err.message || String(err), id: msg.id });
  }
};

function getScore(metrics, target) {
  switch (target) {
    case 'cagr':    return metrics.cagr;
    case 'sharpe':  return metrics.sharpe;
    case 'sortino': return metrics.sortino;
    case 'calmar':  return metrics.calmar;
    case 'minDD':   return -metrics.maxDD;
    default:        return metrics.cagr;
  }
}

function generateParamGrid() {
  var params = [];
  [0, 3, 5, 7, 8, 10, 12, 15, 20].forEach(function(sl) {
    [0, 10, 15, 20, 25, 30, 40, 50, 75, 100].forEach(function(sp) {
      if (sp === 0 || sp > sl * 1.2) {
        params.push({ stopLoss: sl, stopProfit: sp });
      }
    });
  });
  return params;
}
