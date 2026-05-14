// ═══════════════════════════════════════════════════════════════
// bt/core.js  —  台股回測核心引擎 v4.0
// ═══════════════════════════════════════════════════════════════
// 設計原則：
//   1. 純函數，無副作用，可在 Worker 中執行
//   2. Short accounting 遵循真實台股融券邏輯
//   3. 嚴格 signal/execution 分離，無 lookahead bias
//   4. Position object 完整，可擴充槓桿/分批
// ═══════════════════════════════════════════════════════════════

"use strict";

// ──────────────────────────────────────────────────────────────
// 1. INDICATORS ENGINE
// ──────────────────────────────────────────────────────────────

var Indicators = (function() {

  function sma(arr, p) {
    var n = arr.length;
    var r = new Float64Array(n);
    r.fill(NaN);
    if (p > n) return r;
    var s = 0;
    for (var i = 0; i < p; i++) s += arr[i];
    r[p - 1] = s / p;
    for (var i = p; i < n; i++) {
      s += arr[i] - arr[i - p];
      r[i] = s / p;
    }
    return r;
  }

  function ema(arr, p) {
    var n = arr.length;
    var r = new Float64Array(n);
    r.fill(NaN);
    var k = 2 / (p + 1);
    var cnt = 0, sum = 0;
    for (var i = 0; i < n; i++) {
      if (isNaN(arr[i])) continue;
      cnt++;
      sum += arr[i];
      if (cnt < p) continue;
      if (cnt === p) { r[i] = sum / p; continue; }
      // 找到上一個非 NaN 的 r 值
      var prev = NaN;
      for (var j = i - 1; j >= 0; j--) { if (!isNaN(r[j])) { prev = r[j]; break; } }
      r[i] = isNaN(prev) ? arr[i] : arr[i] * k + prev * (1 - k);
    }
    return r;
  }

  // Wilder RSI (correct implementation)
  function rsi(closes, p) {
    p = p || 14;
    var n = closes.length;
    var r = new Float64Array(n);
    r.fill(NaN);
    if (n < p + 2) return r;
    var ag = 0, al = 0;
    for (var i = 1; i <= p; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) ag += d / p;
      else       al -= d / p;
    }
    r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (var i = p + 1; i < n; i++) {
      var d = closes[i] - closes[i - 1];
      var g = d > 0 ? d : 0;
      var l = d < 0 ? -d : 0;
      ag = (ag * (p - 1) + g) / p;
      al = (al * (p - 1) + l) / p;
      r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return r;
  }

  // KD (Stochastic) — Wilder smoothing 1/3
  function kd(highs, lows, closes, p) {
    p = p || 9;
    var n = closes.length;
    var K = new Float64Array(n); K.fill(NaN);
    var D = new Float64Array(n); D.fill(NaN);
    var pk = 50, pd = 50;
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      var rsv = hi === lo ? 50 : (closes[i] - lo) / (hi - lo) * 100;
      pk = rsv / 3 + pk * 2 / 3;
      pd = pk  / 3 + pd * 2 / 3;
      K[i] = pk; D[i] = pd;
    }
    return { k: K, d: D };
  }

  // MACD — EMA-based signal line (no zero-fill hack)
  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var ef = ema(closes, fast);
    var es = ema(closes, slow);
    var n  = closes.length;
    var M  = new Float64Array(n); M.fill(NaN);
    for (var i = 0; i < n; i++) {
      if (!isNaN(ef[i]) && !isNaN(es[i])) M[i] = ef[i] - es[i];
    }
    // EMA of MACD (using only non-NaN values)
    var S = new Float64Array(n); S.fill(NaN);
    var k2 = 2 / (signal + 1), cnt = 0, sum = 0;
    for (var i = 0; i < n; i++) {
      if (isNaN(M[i])) continue;
      cnt++; sum += M[i];
      if (cnt < signal) continue;
      if (cnt === signal) { S[i] = sum / signal; continue; }
      var prev = NaN;
      for (var j = i - 1; j >= 0; j--) { if (!isNaN(S[j])) { prev = S[j]; break; } }
      S[i] = isNaN(prev) ? M[i] : M[i] * k2 + prev * (1 - k2);
    }
    var H = new Float64Array(n); H.fill(NaN);
    for (var i = 0; i < n; i++) {
      if (!isNaN(M[i]) && !isNaN(S[i])) H[i] = M[i] - S[i];
    }
    return { macd: M, signal: S, hist: H };
  }

  // Bollinger Bands
  function boll(closes, p, mult) {
    p = p || 20; mult = mult || 2;
    var n   = closes.length;
    var mid = sma(closes, p);
    var upper = new Float64Array(n); upper.fill(NaN);
    var lower = new Float64Array(n); lower.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var m = mid[i], s = 0;
      for (var j = i - p + 1; j <= i; j++) s += (closes[j] - m) * (closes[j] - m);
      var sd = Math.sqrt(s / p);
      upper[i] = m + mult * sd;
      lower[i] = m - mult * sd;
    }
    return { upper: upper, mid: mid, lower: lower };
  }

  // Williams %R
  function wr(highs, lows, closes, p) {
    p = p || 14;
    var n = closes.length;
    var r = new Float64Array(n); r.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      r[i] = hi === lo ? -50 : ((hi - closes[i]) / (hi - lo)) * -100;
    }
    return r;
  }

  // Donchian Channel
  function donchian(highs, lows, p) {
    p = p || 20;
    var n = highs.length;
    var upper = new Float64Array(n); upper.fill(NaN);
    var lower = new Float64Array(n); lower.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      upper[i] = hi; lower[i] = lo;
    }
    return { upper: upper, lower: lower };
  }

  // Precompute all indicators for a dataset
  function precompute(data) {
    var c = data.closes, h = data.highs, l = data.lows, v = data.volumes;
    return {
      ma5:   sma(c, 5),   ma10:  sma(c, 10),  ma20:  sma(c, 20),
      ma60:  sma(c, 60),  ma120: sma(c, 120),  ma200: sma(c, 200),
      ema20: ema(c, 20),  ema200:ema(c, 200),
      rsi14: rsi(c, 14),
      kd9:   kd(h, l, c, 9),
      macd:  macd(c, 12, 26, 9),
      boll20:boll(c, 20, 2),
      wr14:  wr(h, l, c, 14),
      dc20:  donchian(h, l, 20),
      dc10:  donchian(h, l, 10),
      vol20: sma(v, 20),
    };
  }

  return { sma, ema, rsi, kd, macd, boll, wr, donchian, precompute };
})();


// ──────────────────────────────────────────────────────────────
// 2. SIGNAL ENGINE
// ──────────────────────────────────────────────────────────────
// 規則：
//   - 所有訊號使用 sigDay（訊號產生日）的資料
//   - sigDay 和 execDay 由 ExecutionEngine 分離
//   - 此函數不接觸任何 execDay 的資料
// ──────────────────────────────────────────────────────────────

var SignalEngine = (function() {

  // 安全比較（NaN-safe）
  function v(x) { return !isNaN(x) && x != null; }

  function scoreLongEntry(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes, vols = data.volumes;
    var p = i, q = i - 1;          // p=今, q=昨（都是 sigDay 及之前）
    var e = strategies.entry || [];
    var score = 0;

    if (e.indexOf("ma_golden")     >= 0 && v(ind.ma5[q]) && v(ind.ma20[q]))
      if (ind.ma5[q] <= ind.ma20[q] && ind.ma5[p] > ind.ma20[p]) score += 2;

    if (e.indexOf("price_above_ma")>= 0 && v(ind.ma20[p]))
      if (c[q] <= ind.ma20[q] && c[p] > ind.ma20[p]) score += 1;

    if (e.indexOf("rsi_oversold")  >= 0 && v(ind.rsi14[q]) && v(ind.rsi14[p])) {
      if (ind.rsi14[q] < 30 && ind.rsi14[p] >= 30) score += 3;
      else if (ind.rsi14[p] < 25)                   score += 1;
    }

    if (e.indexOf("macd_golden")   >= 0 && v(ind.macd.hist[q]) && v(ind.macd.hist[p]))
      if (ind.macd.hist[q] < 0 && ind.macd.hist[p] >= 0) score += 2;

    if (e.indexOf("boll_break")    >= 0 && v(ind.boll20.lower[p]))
      if (c[q] <= ind.boll20.lower[q] && c[p] > ind.boll20.lower[p]) score += 2;

    if (e.indexOf("kd_golden")     >= 0 && v(ind.kd9.k[q]) && v(ind.kd9.d[q]))
      if (ind.kd9.k[q] <= ind.kd9.d[q] && ind.kd9.k[p] > ind.kd9.d[p] && ind.kd9.k[p] < 50) score += 2;

    if (e.indexOf("vol_surge")     >= 0 && v(ind.vol20[p]))
      if (vols[p] > ind.vol20[p] * 2.0 && c[p] > c[q]) score += 1;

    if (e.indexOf("price_high")    >= 0 && v(ind.dc20.upper[q]))
      if (c[p] > ind.dc20.upper[q]) score += 2;

    if (e.indexOf("wr_oversold")   >= 0 && v(ind.wr14[q]) && v(ind.wr14[p]))
      if (ind.wr14[q] < -80 && ind.wr14[p] >= -80) score += 2;

    if (e.indexOf("turtle_break")  >= 0 && v(ind.dc20.upper[q]))
      if (c[p] > ind.dc20.upper[q]) score += 2;

    return score;
  }

  function scoreLongExit(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var e = strategies.exit || [];
    var score = 0;

    if (e.indexOf("ma_death")      >= 0 && v(ind.ma5[q]) && v(ind.ma20[q]))
      if (ind.ma5[q] >= ind.ma20[q] && ind.ma5[p] < ind.ma20[p]) score += 2;

    if (e.indexOf("price_below_ma")>= 0 && v(ind.ma20[p]))
      if (c[q] >= ind.ma20[q] && c[p] < ind.ma20[p]) score += 1;

    if (e.indexOf("rsi_overbought")>= 0 && v(ind.rsi14[q]) && v(ind.rsi14[p])) {
      if (ind.rsi14[q] > 70 && ind.rsi14[p] <= 70) score += 3;
      else if (ind.rsi14[p] > 80)                    score += 1;
    }

    if (e.indexOf("macd_death")    >= 0 && v(ind.macd.hist[q]) && v(ind.macd.hist[p]))
      if (ind.macd.hist[q] > 0 && ind.macd.hist[p] <= 0) score += 2;

    if (e.indexOf("boll_upper")    >= 0 && v(ind.boll20.upper[p]))
      if (c[p] >= ind.boll20.upper[p]) score += 1;

    if (e.indexOf("kd_death")      >= 0 && v(ind.kd9.k[q]) && v(ind.kd9.d[q]))
      if (ind.kd9.k[q] >= ind.kd9.d[q] && ind.kd9.k[p] < ind.kd9.d[p] && ind.kd9.k[p] > 50) score += 2;

    if (e.indexOf("price_low")     >= 0 && v(ind.dc20.lower[q]))
      if (c[p] < ind.dc20.lower[q]) score += 2;

    if (e.indexOf("wr_overbought") >= 0 && v(ind.wr14[q]) && v(ind.wr14[p]))
      if (ind.wr14[q] > -20 && ind.wr14[p] <= -20) score += 2;

    if (e.indexOf("turtle_stop")   >= 0 && v(ind.dc10.lower[q]))
      if (c[p] < ind.dc10.lower[q]) score += 2;

    return score;
  }

  function scoreShortEntry(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var e = strategies.entry || [];
    var score = 0;

    if (e.indexOf("s_ma_death")      >= 0 && v(ind.ma5[q]) && v(ind.ma20[q]))
      if (ind.ma5[q] >= ind.ma20[q] && ind.ma5[p] < ind.ma20[p]) score += 2;

    if (e.indexOf("s_price_below_ma")>= 0 && v(ind.ma20[p]))
      if (c[q] >= ind.ma20[q] && c[p] < ind.ma20[p]) score += 1;

    if (e.indexOf("s_rsi_overbought")>= 0 && v(ind.rsi14[q]) && v(ind.rsi14[p])) {
      if (ind.rsi14[q] > 70 && ind.rsi14[p] <= 70) score += 3;
    }

    if (e.indexOf("s_macd_death")    >= 0 && v(ind.macd.hist[q]) && v(ind.macd.hist[p]))
      if (ind.macd.hist[q] > 0 && ind.macd.hist[p] <= 0) score += 2;

    if (e.indexOf("s_boll_upper")    >= 0 && v(ind.boll20.upper[p]))
      if (c[p] >= ind.boll20.upper[p]) score += 1;

    if (e.indexOf("s_kd_death")      >= 0 && v(ind.kd9.k[q]) && v(ind.kd9.d[q]))
      if (ind.kd9.k[q] >= ind.kd9.d[q] && ind.kd9.k[p] < ind.kd9.d[p] && ind.kd9.k[p] > 50) score += 2;

    if (e.indexOf("s_price_low")     >= 0 && v(ind.dc20.lower[q]))
      if (c[p] < ind.dc20.lower[q]) score += 2;

    if (e.indexOf("s_wr_overbought") >= 0 && v(ind.wr14[q]) && v(ind.wr14[p]))
      if (ind.wr14[q] > -20 && ind.wr14[p] <= -20) score += 2;

    if (e.indexOf("s_turtle_low")    >= 0 && v(ind.dc20.lower[q]))
      if (c[p] < ind.dc20.lower[q]) score += 2;

    return score;
  }

  function scoreShortExit(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var e = strategies.exit || [];
    var score = 0;

    if (e.indexOf("s_ma_golden")     >= 0 && v(ind.ma5[q]) && v(ind.ma20[q]))
      if (ind.ma5[q] <= ind.ma20[q] && ind.ma5[p] > ind.ma20[p]) score += 2;

    if (e.indexOf("s_price_above_ma")>= 0 && v(ind.ma20[p]))
      if (c[q] <= ind.ma20[q] && c[p] > ind.ma20[p]) score += 1;

    if (e.indexOf("s_rsi_oversold")  >= 0 && v(ind.rsi14[q]) && v(ind.rsi14[p]))
      if (ind.rsi14[q] < 30 && ind.rsi14[p] >= 30) score += 3;

    if (e.indexOf("s_macd_golden")   >= 0 && v(ind.macd.hist[q]) && v(ind.macd.hist[p]))
      if (ind.macd.hist[q] < 0 && ind.macd.hist[p] >= 0) score += 2;

    if (e.indexOf("s_boll_lower")    >= 0 && v(ind.boll20.lower[p]))
      if (c[p] <= ind.boll20.lower[p]) score += 1;

    if (e.indexOf("s_kd_golden")     >= 0 && v(ind.kd9.k[q]) && v(ind.kd9.d[q]))
      if (ind.kd9.k[q] <= ind.kd9.d[q] && ind.kd9.k[p] > ind.kd9.d[p] && ind.kd9.k[p] < 50) score += 2;

    if (e.indexOf("s_price_high")    >= 0 && v(ind.dc20.upper[q]))
      if (c[p] > ind.dc20.upper[q]) score += 2;

    if (e.indexOf("s_wr_oversold")   >= 0 && v(ind.wr14[q]) && v(ind.wr14[p]))
      if (ind.wr14[q] < -80 && ind.wr14[p] >= -80) score += 2;

    if (e.indexOf("s_turtle_high")   >= 0 && v(ind.dc20.upper[q]))
      if (c[p] > ind.dc20.upper[q]) score += 2;

    return score;
  }

  // Generate full signal arrays (one per bar)
  // Returns { longEntry[], longExit[], shortEntry[], shortExit[] }
  function generate(data, ind, longStrat, shortStrat, shortEnabled) {
    var n = data.closes.length;
    var le = new Int8Array(n), lx = new Int8Array(n);
    var se = new Int8Array(n), sx = new Int8Array(n);
    for (var i = 1; i < n; i++) {
      le[i] = scoreLongEntry(i, ind, data, longStrat);
      lx[i] = scoreLongExit(i, ind, data, longStrat);
      if (shortEnabled) {
        se[i] = scoreShortEntry(i, ind, data, shortStrat);
        sx[i] = scoreShortExit(i, ind, data, shortStrat);
      }
    }
    return { longEntry: le, longExit: lx, shortEntry: se, shortExit: sx };
  }

  return { generate, scoreLongEntry, scoreLongExit, scoreShortEntry, scoreShortExit };
})();


// ──────────────────────────────────────────────────────────────
// 3. POSITION OBJECT
// ──────────────────────────────────────────────────────────────

function createPosition(side, qty, entryPrice, entryDate, feeRate) {
  var cost = qty * 1000 * entryPrice;
  var fees = cost * feeRate;
  return {
    side:             side,           // 'long' | 'short'
    qty:              qty,            // 張數
    entryPrice:       entryPrice,
    entryDate:        entryDate,
    markPrice:        entryPrice,
    margin:           cost,           // 凍結資金（多=成本, 空=保證金）
    entryFees:        fees,           // 進場手續費
    unrealizedPnl:    0,
    realizedPnl:      0,
    trailHigh:        entryPrice,     // 多單移動停損追蹤
    trailLow:         entryPrice,     // 空單移動停損追蹤
  };
}

function updatePositionMark(pos, currentPrice) {
  pos.markPrice = currentPrice;
  if (pos.side === 'long') {
    pos.unrealizedPnl = pos.qty * 1000 * (currentPrice - pos.entryPrice) - pos.entryFees;
    if (currentPrice > pos.trailHigh) pos.trailHigh = currentPrice;
  } else {
    pos.unrealizedPnl = pos.qty * 1000 * (pos.entryPrice - currentPrice) - pos.entryFees;
    if (currentPrice < pos.trailLow) pos.trailLow = currentPrice;
  }
}

function closePosition(pos, exitPrice, exitDate, sellFeeRate) {
  var exitFees = pos.qty * 1000 * exitPrice * sellFeeRate;
  var grossPnl = pos.side === 'long'
    ? pos.qty * 1000 * (exitPrice - pos.entryPrice) - pos.entryFees
    : pos.qty * 1000 * (pos.entryPrice - exitPrice) - pos.entryFees;
  var netPnl = grossPnl - exitFees;
  return {
    exitPrice:  exitPrice,
    exitDate:   exitDate,
    exitFees:   exitFees,
    grossPnl:   grossPnl,
    netPnl:     netPnl,
    pnlPct:     (netPnl / pos.margin) * 100,
    returnMargin: pos.margin + netPnl,  // 退還給 portfolio 的金額
  };
}


// ──────────────────────────────────────────────────────────────
// 4. PORTFOLIO ENGINE
// ──────────────────────────────────────────────────────────────
// 帳戶模型：
//   balance         = 未凍結現金
//   usedMargin      = 凍結中的保證金（進場成本 or 放空保證金）
//   unrealizedPnl   = 未平倉浮動損益
//   equity          = balance + usedMargin + unrealizedPnl
//   availableMargin = balance（可用）
// ──────────────────────────────────────────────────────────────

function createPortfolio(initCapital) {
  return {
    initCapital:   initCapital,
    balance:       initCapital,  // 可用現金
    usedMargin:    0,            // 凍結保證金
    unrealizedPnl: 0,
    realizedPnl:   0,
    position:      null,         // 當前持倉（單一部位）
  };
}

function portfolioEquity(pf) {
  return pf.balance + pf.usedMargin + pf.unrealizedPnl;
}

function portfolioEnterLong(pf, qty, price, date, buyFeeRate) {
  var cost = qty * 1000 * price;
  var fees = cost * buyFeeRate;
  var totalCost = cost + fees;
  if (totalCost > pf.balance || qty <= 0) return false;

  pf.balance    -= totalCost;
  pf.usedMargin += cost;                // 凍結持股市值（不含手續費）
  pf.position    = createPosition('long', qty, price, date, buyFeeRate);
  pf.position.entryFees = fees;
  return true;
}

// ── 正確的做空會計 ──────────────────────────────────────────────
// 台股融券：
//   進場：凍結保證金 = 放空市值（此處簡化為 100% 保證金率）
//         balance -= margin
//         usedMargin += margin
//   出場：
//         grossPnl = qty * 1000 * (entryPrice - exitPrice)
//         fees = exitValue * sellFeeRate
//         netPnl = grossPnl - entryFees - exitFees
//         退還 = margin + netPnl
//         balance += margin + netPnl  （只退保證金+損益，不憑空加本金）
//         usedMargin -= margin
// ──────────────────────────────────────────────────────────────
function portfolioEnterShort(pf, qty, price, date, buyFeeRate) {
  var margin = qty * 1000 * price;     // 凍結保證金
  var fees   = margin * buyFeeRate;    // 融券手續費
  if (margin + fees > pf.balance || qty <= 0) return false;

  pf.balance    -= (margin + fees);   // 扣除保證金 + 手續費
  pf.usedMargin += margin;            // 凍結保證金
  pf.position    = createPosition('short', qty, price, date, buyFeeRate);
  pf.position.entryFees = fees;
  return true;
}

function portfolioExitPosition(pf, exitPrice, date, sellFeeRate, reason) {
  if (!pf.position) return null;
  var pos    = pf.position;
  var result = closePosition(pos, exitPrice, date, sellFeeRate);

  // 退還保證金 + 損益（正確做法）
  pf.balance    += result.returnMargin;
  pf.usedMargin -= pos.margin;
  pf.realizedPnl += result.netPnl;
  pf.unrealizedPnl = 0;

  var trade = {
    entryDate:  pos.entryDate,
    exitDate:   date,
    side:       pos.side,
    qty:        pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice:  exitPrice,
    entryFees:  pos.entryFees,
    exitFees:   result.exitFees,
    grossPnl:   result.grossPnl,
    netPnl:     result.netPnl,
    pnlPct:     result.pnlPct,
    reason:     reason || 'strategy',
  };

  pf.position = null;
  return trade;
}

function portfolioUpdateMark(pf, currentPrice) {
  if (!pf.position) { pf.unrealizedPnl = 0; return; }
  updatePositionMark(pf.position, currentPrice);
  pf.unrealizedPnl = pf.position.unrealizedPnl;
}


// ──────────────────────────────────────────────────────────────
// 5. EXECUTION ENGINE
// ──────────────────────────────────────────────────────────────
// 核心設計：
//   close mode: sigDay=i, execDay=i,   execPrice=closes[i]
//   open  mode: sigDay=i, execDay=i+1, execPrice=opens[i+1]
//   → 所有訊號預先計算好（SignalEngine.generate），
//     再按 execDay 執行，保證零 lookahead bias
// ──────────────────────────────────────────────────────────────

var ExecutionEngine = (function() {

  var WARMUP = 250; // MA200 需要 200 根，再留 50 根穩定

  function run(data, config) {
    var n       = data.closes.length;
    var closes  = data.closes;
    var opens   = data.opens;
    var dates   = data.dates;

    var capital       = +config.capital      || 1000000;
    var execType      = config.execType      || 'close';
    var posBase       = config.positionBase  || 'initial';
    var posSizePct    = Math.min(Math.max(+config.posSize || 100, 1), 100) / 100;
    var stopLossPct   = +config.stopLoss   > 0 ? +config.stopLoss   / 100 : null;
    var stopProfitPct = +config.stopProfit > 0 ? +config.stopProfit / 100 : null;
    var threshold     = Math.max(parseInt(config.scoreThreshold, 10) || 1, 1);
    var isETF         = /^00/.test((config.code || ''));
    var buyFeeRate    = +config.buyFee  > 0 ? +config.buyFee  / 100 : (isETF ? 0.001 : 0.001425);
    var sellFeeRate   = +config.sellFee > 0 ? +config.sellFee / 100 : (isETF ? 0.002 : 0.004425);
    var shortEnabled  = !!config.shortEnabled;

    var longStrat  = { entry: config.longEntry  || [], exit: config.longExit  || [] };
    var shortStrat = { entry: config.shortEntry || [], exit: config.shortExit || [] };

    // Step 1: 預計算所有指標
    var ind = Indicators.precompute(data);

    // Step 2: 預計算所有訊號（sigDay 為基準）
    var sigs = SignalEngine.generate(data, ind, longStrat, shortStrat, shortEnabled);

    // Step 3: 初始化 portfolio
    var pf      = createPortfolio(capital);
    var equity  = new Float64Array(n);
    var trades  = [];

    // execType=open：第 i 天的訊號在第 i+1 天開盤執行
    // execType=close：第 i 天的訊號在第 i 天收盤執行
    // 為了統一迴圈，建立 pending 訊號
    var pendingLongEntry  = false;
    var pendingLongExit   = false;
    var pendingShortEntry = false;
    var pendingShortExit  = false;
    var pendingReason     = '';

    for (var i = 0; i < n; i++) {
      var closePrice = closes[i];
      var openPrice  = opens[i] || closes[i];
      var date       = dates[i];

      // ── 確定今日執行價 ────────────────────────────────────
      var execPrice;
      if (execType === 'open') {
        execPrice = openPrice;   // 今日開盤（前日訊號）
      } else {
        execPrice = closePrice;  // 今日收盤（今日訊號）
      }

      if (!execPrice || execPrice <= 0) {
        portfolioUpdateMark(pf, closePrice || 0);
        equity[i] = portfolioEquity(pf);
        continue;
      }

      // ── 執行前日 pending 訊號（open 模式）──────────────────
      if (execType === 'open' && i > 0) {
        if (pendingLongEntry && !pf.position) {
          var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
          var lots = Math.floor(base * posSizePct / (execPrice * 1000));
          portfolioEnterLong(pf, lots, execPrice, date, buyFeeRate);
          if (pf.position) {
            trades.push({ type: 'entry', side: 'long', date, price: execPrice, qty: lots, reason: 'strategy' });
          }
        }
        if (pendingLongExit && pf.position && pf.position.side === 'long') {
          var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, pendingReason || 'strategy');
          if (t) trades.push({ type: 'exit', side: 'long', date, price: execPrice, qty: t.qty, ...t });
        }
        if (pendingShortEntry && !pf.position) {
          var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
          var lots = Math.floor(base * posSizePct / (execPrice * 1000));
          portfolioEnterShort(pf, lots, execPrice, date, buyFeeRate);
          if (pf.position) {
            trades.push({ type: 'entry', side: 'short', date, price: execPrice, qty: lots, reason: 'strategy' });
          }
        }
        if (pendingShortExit && pf.position && pf.position.side === 'short') {
          var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, pendingReason || 'strategy');
          if (t) trades.push({ type: 'exit', side: 'short', date, price: execPrice, qty: t.qty, ...t });
        }
        pendingLongEntry = pendingLongExit = pendingShortEntry = pendingShortExit = false;
        pendingReason = '';
      }

      // ── 停損停利（當日收盤檢查，open 模式也一樣）──────────
      if (pf.position) {
        portfolioUpdateMark(pf, closePrice);
        var pos = pf.position;

        // 跳空開盤停損（更真實：先用開盤價確認）
        var checkPrice = (execType === 'open') ? openPrice : closePrice;

        if (pos.side === 'long') {
          var unrealPct = (checkPrice - pos.entryPrice) / pos.entryPrice;
          if (stopLossPct   && unrealPct <= -stopLossPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopLoss');
            if (t) trades.push({ type: 'exit', side: 'long', date, price: checkPrice, qty: t.qty, ...t });
          } else if (stopProfitPct && unrealPct >= stopProfitPct) {
            var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'stopProfit');
            if (t) trades.push({ type: 'exit', side: 'long', date, price: closePrice, qty: t.qty, ...t });
          } else if (longStrat.exit.indexOf('trailing_stop') >= 0 && pf.position) {
            if (closePrice < pf.position.trailHigh * 0.95) {
              var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'trailingStop');
              if (t) trades.push({ type: 'exit', side: 'long', date, price: closePrice, qty: t.qty, ...t });
            }
          }
        } else if (pos.side === 'short') {
          var unrealPct = (pos.entryPrice - checkPrice) / pos.entryPrice;
          if (stopLossPct   && unrealPct <= -stopLossPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopLoss');
            if (t) trades.push({ type: 'exit', side: 'short', date, price: checkPrice, qty: t.qty, ...t });
          } else if (stopProfitPct && unrealPct >= stopProfitPct) {
            var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'stopProfit');
            if (t) trades.push({ type: 'exit', side: 'short', date, price: closePrice, qty: t.qty, ...t });
          } else if (shortStrat.exit.indexOf('s_trailing') >= 0 && pf.position) {
            if (closePrice > pf.position.trailLow * 1.05) {
              var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'trailingStop');
              if (t) trades.push({ type: 'exit', side: 'short', date, price: closePrice, qty: t.qty, ...t });
            }
          }
        }
      }

      // ── 策略訊號執行（warm-up 後）──────────────────────────
      var sigIdx = i; // 訊號永遠用 today（不管 execType，訊號都是今天）

      if (sigIdx >= WARMUP) {
        var leScore = sigs.longEntry[sigIdx];
        var lxScore = sigs.longExit[sigIdx];
        var seScore = sigs.shortEntry[sigIdx];
        var sxScore = sigs.shortExit[sigIdx];

        if (execType === 'close') {
          // 今日收盤執行
          if (!pf.position) {
            if (leScore >= threshold) {
              var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
              var lots = Math.floor(base * posSizePct / (execPrice * 1000));
              portfolioEnterLong(pf, lots, execPrice, date, buyFeeRate);
              if (pf.position) trades.push({ type: 'entry', side: 'long', date, price: execPrice, qty: lots, reason: 'strategy', score: leScore });
            } else if (shortEnabled && seScore >= threshold) {
              var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
              var lots = Math.floor(base * posSizePct / (execPrice * 1000));
              portfolioEnterShort(pf, lots, execPrice, date, buyFeeRate);
              if (pf.position) trades.push({ type: 'entry', side: 'short', date, price: execPrice, qty: lots, reason: 'strategy', score: seScore });
            }
          } else if (pf.position.side === 'long' && lxScore >= threshold) {
            var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, 'strategy');
            if (t) trades.push({ type: 'exit', side: 'long', date, price: execPrice, qty: t.qty, ...t });
          } else if (pf.position.side === 'short' && sxScore >= threshold) {
            var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, 'strategy');
            if (t) trades.push({ type: 'exit', side: 'short', date, price: execPrice, qty: t.qty, ...t });
          }
        } else {
          // open 模式：設定 pending，明日開盤執行
          if (!pf.position) {
            if (leScore >= threshold) { pendingLongEntry = true; }
            else if (shortEnabled && seScore >= threshold) { pendingShortEntry = true; }
          } else if (pf.position.side === 'long' && lxScore >= threshold) {
            pendingLongExit = true; pendingReason = 'strategy';
          } else if (pf.position.side === 'short' && sxScore >= threshold) {
            pendingShortExit = true; pendingReason = 'strategy';
          }
        }
      }

      // ── Mark-to-market ─────────────────────────────────────
      portfolioUpdateMark(pf, closePrice);
      equity[i] = portfolioEquity(pf);

      // 防止 NaN 擴散
      if (isNaN(equity[i])) equity[i] = i > 0 ? equity[i-1] : capital;
    }

    return { equity, trades, finalPortfolio: pf };
  }

  return { run };
})();


// ──────────────────────────────────────────────────────────────
// 6. METRICS ENGINE
// ──────────────────────────────────────────────────────────────

var MetricsEngine = (function() {

  function compute(equity, trades, initCapital, dates) {
    var n = equity.length;
    var finalEquity = equity[n - 1] || initCapital;

    // ── 基本報酬 ──────────────────────────────────────────────
    var totalReturn = (finalEquity - initCapital) / initCapital;
    var years = Math.max(n / 252, 1 / 252);

    // CAGR（正確公式）
    var cagr = Math.pow(Math.max(finalEquity / initCapital, 1e-6), 1 / years) - 1;

    // ── 回撤計算 ──────────────────────────────────────────────
    var maxDD = 0, peak = equity[0];
    var ddStart = 0, ddEnd = 0, ddLen = 0, maxDDLen = 0;
    var curDDStart = 0;
    for (var i = 1; i < n; i++) {
      if (equity[i] > peak) { peak = equity[i]; curDDStart = i; }
      var dd = peak > 0 ? (peak - equity[i]) / peak : 0;
      if (dd > maxDD) { maxDD = dd; ddStart = curDDStart; ddEnd = i; maxDDLen = i - curDDStart; }
    }

    // ── 日報酬率（log return 更準確）──────────────────────────
    var logRets = [];
    for (var i = 1; i < n; i++) {
      if (equity[i - 1] > 0 && equity[i] > 0) logRets.push(Math.log(equity[i] / equity[i-1]));
    }
    var nd = logRets.length || 1;
    var meanRet = logRets.reduce(function(a,b){return a+b;},0) / nd;
    var variance = logRets.reduce(function(a,b){return a+Math.pow(b-meanRet,2);},0) / Math.max(nd-1,1);
    var stdRet = Math.sqrt(variance);

    var sharpe  = stdRet  > 1e-8 ? (meanRet * Math.sqrt(252)) / stdRet : 0;

    // Sortino（只用負報酬的下行標準差）
    var downRets = logRets.filter(function(r){return r < 0;});
    var downVar  = downRets.length > 1
      ? downRets.reduce(function(a,b){return a+b*b;},0) / (downRets.length - 1)
      : 1e-8;
    var downStd  = Math.sqrt(downVar) * Math.sqrt(252);
    var sortino  = downStd > 1e-8 ? cagr / downStd : 0;

    // Calmar Ratio
    var calmar = maxDD > 1e-8 ? cagr / maxDD : 0;

    // ── 交易統計 ──────────────────────────────────────────────
    var closed = trades.filter(function(t){return t.type === 'exit';});
    var wins   = closed.filter(function(t){return t.netPnl > 0;});
    var losses = closed.filter(function(t){return t.netPnl <= 0;});

    var winRate      = closed.length > 0 ? wins.length / closed.length : 0;
    var avgWin       = wins.length   > 0 ? wins.reduce(function(a,t){return a+t.netPnl;},0)  / wins.length   : 0;
    var avgLoss      = losses.length > 0 ? losses.reduce(function(a,t){return a+t.netPnl;},0) / losses.length : 0;
    var grossProfit  = wins.reduce(function(a,t){return a+t.netPnl;},0);
    var grossLoss    = Math.abs(losses.reduce(function(a,t){return a+t.netPnl;},0));
    var profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    var expectancy   = (winRate * avgWin) + ((1 - winRate) * avgLoss); // 期望值

    // 連勝/連敗
    var maxWS=0, maxLS=0, cW=0, cL=0;
    closed.forEach(function(t){
      if (t.netPnl > 0) { cW++; cL=0; if(cW>maxWS) maxWS=cW; }
      else               { cL++; cW=0; if(cL>maxLS) maxLS=cL; }
    });

    // Recovery Factor
    var recoveryFactor = maxDD > 1e-8 ? totalReturn / maxDD : 0;

    // Exposure（持倉時間比例）
    var entryDates = {}, inPos = false;
    trades.forEach(function(t){
      if (t.type === 'entry') { entryDates[t.entryDate||t.date] = true; inPos = true; }
      if (t.type === 'exit')  { inPos = false; }
    });
    // 粗略估計：以交易筆數佔總天數比率
    var exposure = closed.length > 0
      ? closed.reduce(function(a,t){
          var ed = new Date(t.entryDate||dates[0]);
          var xd = new Date(t.exitDate||t.date||dates[0]);
          return a + Math.max((xd-ed)/86400000, 1);
        }, 0) / Math.max(n, 1)
      : 0;

    // ── 年度績效 ──────────────────────────────────────────────
    var annual = {};
    if (dates) {
      dates.forEach(function(d, i) {
        if (!d) return;
        var y = d.slice(0,4);
        if (!annual[y]) annual[y] = { start:i, startV:equity[i] };
        annual[y].end = i; annual[y].endV = equity[i];
      });
      Object.keys(annual).forEach(function(y) {
        var a = annual[y];
        a.ret = (a.endV - a.startV) / a.startV;
        a.tradeCnt = closed.filter(function(t){return (t.exitDate||t.date||'').slice(0,4)===y;}).length;
      });
    }

    return {
      // 報酬
      totalReturn, cagr, annReturn: cagr,
      // 風險
      sharpe, sortino, calmar, maxDD, maxDDLen,
      recoveryFactor, exposure,
      // 交易
      tradeCount: closed.length,
      winRate, avgWin, avgLoss, grossProfit, grossLoss,
      profitFactor, expectancy,
      maxWinStreak: maxWS, maxLoseStreak: maxLS,
      // 帳戶
      finalEquity, initCapital,
      // 年度
      annual,
    };
  }

  return { compute };
})();


// ──────────────────────────────────────────────────────────────
// 7. TOP-LEVEL BACKTEST FUNCTION（供 Worker 呼叫）
// ──────────────────────────────────────────────────────────────

function runBacktestEngine(data, config) {
  if (!data || !data.closes || data.closes.length < 60) {
    throw new Error('資料不足，需至少 60 筆');
  }
  var result = ExecutionEngine.run(data, config);
  var metrics = MetricsEngine.compute(
    result.equity, result.trades, config.capital || 1000000, data.dates
  );
  return {
    equity:   Array.from(result.equity),
    trades:   result.trades,
    metrics:  metrics,
    annual:   metrics.annual,
  };
}

// Export for Worker use
if (typeof module !== 'undefined') module.exports = { runBacktestEngine, Indicators, SignalEngine, MetricsEngine };
