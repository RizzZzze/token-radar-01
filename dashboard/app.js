// Token Radar dashboard: refits the value curve in the browser from the
// same snapshot data, recomputes every row, and regenerates every farm
// plan. The numbers on screen are computed here, not copied from the file.
(function () {
  "use strict";
  var D = window.RADAR;
  if (!D) {
    document.getElementById("view").innerHTML =
      '<div class="card"><p>Dashboard data (data.js) did not load.</p></div>';
    return;
  }

  // ------------------------------------------------------------ numerics
  function medianOf(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var n = s.length, mid = Math.floor(n / 2);
    return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function quantileSorted(sortedAsc, q) {
    var n = sortedAsc.length;
    return sortedAsc[Math.min(n - 1, Math.floor(q * n))];
  }
  function meanOf(values) {
    var s = 0;
    for (var i = 0; i < values.length; i++) s += values[i];
    return s / values.length;
  }
  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function round2(v) { return Math.round(v * 100) / 100; }

  function solveLinear(A, b) {
    var n = b.length;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    var pivRow = [];
    for (var k = 0; k < n; k++) pivRow.push(-1);
    var r = 0;
    for (var col = 0; col < n && r < n; col++) {
      var piv = r, best = Math.abs(M[r][col]);
      for (var i = r + 1; i < n; i++) {
        var v = Math.abs(M[i][col]);
        if (v > best) { best = v; piv = i; }
      }
      if (best < 1e-12) continue;
      if (piv !== r) { var t = M[r]; M[r] = M[piv]; M[piv] = t; }
      pivRow[col] = r;
      for (var j = 0; j < n; j++) {
        if (j === r) continue;
        var f = M[j][col] / M[r][col];
        if (f !== 0) for (var c = col; c <= n; c++) M[j][c] -= f * M[r][c];
      }
      r++;
    }
    var x = [];
    for (var q = 0; q < n; q++) x.push(0);
    for (var col2 = 0; col2 < n; col2++) {
      var pr = pivRow[col2];
      if (pr < 0) { x[col2] = 0; continue; }
      x[col2] = M[pr][n] / M[pr][col2];
    }
    return x;
  }

  function olsFit(X, y, w) {
    var k = X[0].length;
    var A = [], b = [];
    for (var a = 0; a < k; a++) { A.push([]); b.push(0); for (var c = 0; c < k; c++) A[a].push(0); }
    for (var i = 0; i < X.length; i++) {
      var wi = w === null ? 1 : w[i];
      var row = X[i];
      for (var u = 0; u < k; u++) {
        b[u] += wi * row[u] * y[i];
        for (var v = 0; v < k; v++) A[u][v] += wi * row[u] * row[v];
      }
    }
    return solveLinear(A, b);
  }

  function huberFit(X, y) {
    var beta = olsFit(X, y, null);
    for (var iter = 0; iter < 12; iter++) {
      var resid = X.map(function (row, i) {
        var pred = 0;
        for (var j = 0; j < row.length; j++) pred += row[j] * beta[j];
        return y[i] - pred;
      });
      var med = medianOf(resid);
      var mad = Math.max(1e-6, medianOf(resid.map(function (r) { return Math.abs(r - med); })));
      var s = 1.4826 * mad;
      var w = resid.map(function (r) { return Math.min(1, (1.345 * s) / Math.max(Math.abs(r), 1e-9)); });
      var next = olsFit(X, y, w);
      var maxMove = 0;
      for (var j2 = 0; j2 < beta.length; j2++) maxMove = Math.max(maxMove, Math.abs(next[j2] - beta[j2]));
      beta = next;
      if (maxMove < 1e-10) break;
    }
    return beta;
  }

  // ------------------------------------------------------------ features
  function sizeX(tvl) { return Math.log10(tvl / 1e8); }
  function clampPct(pct) {
    var p = pct === null ? 0 : pct;
    return Math.min(120, Math.max(-60, p));
  }
  function growthMult(pct) { return 1 + (clampPct(pct) * 0.5) / 100; }
  function growthG(pct) { return clampPct(pct) / 100; }
  function ageFeature(age) { return age === null ? 0 : Math.log1p(age / 365); }
  function maturityFeature(age, tau) { return age === null ? 0 : 1 - Math.exp(-age / tau); }

  var TAU_GRID = [60, 90, 180, 365, 730, 1095, 1825, 3650];
  var LOG3 = Math.log10(3);

  function errorMetrics(errors) {
    var abs = errors.map(function (e) { return Math.abs(e); });
    var within = 0;
    for (var i = 0; i < abs.length; i++) if (abs[i] < LOG3) within++;
    return {
      miss: Math.pow(10, meanOf(abs)),
      within3: errors.length === 0 ? 0 : within / errors.length,
      medianMiss: Math.pow(10, medianOf(abs))
    };
  }
  function looSdOf(errors) {
    return Math.sqrt(meanOf(errors.map(function (e) { return e * e; })));
  }

  function dot(beta, x) {
    var s = 0;
    for (var j = 0; j < beta.length; j++) s += beta[j] * x[j];
    return s;
  }
  function regressionFitter(design, robust, useGrowth) {
    return function (train) {
      var X = train.map(design);
      var y = train.map(function (r) { return Math.log10(r.mcap); });
      var beta = robust ? huberFit(X, y) : olsFit(X, y, null);
      return {
        predict: function (row) {
          return dot(beta, design(row)) + (useGrowth ? Math.log10(growthMult(row.pct)) : 0);
        }
      };
    };
  }
  function designSize(r) { return [1, sizeX(r.tvl)]; }
  function designSizeAge(r) { return [1, sizeX(r.tvl), ageFeature(r.age)]; }
  function designSizeGrowthFit(r) { return [1, sizeX(r.tvl), growthG(r.pct)]; }
  function designSizeChains(r) { return [1, sizeX(r.tvl), Math.log10(Math.max(1, r.nChains))]; }
  function designSizeGrowthX(r) { return [1, sizeX(r.tvl), growthG(r.pct) * sizeX(r.tvl)]; }
  function designSizeQuad(r) { var x = sizeX(r.tvl); return [1, x, x * x]; }
  function designSizeMaturity(tau) {
    return function (r) { return [1, sizeX(r.tvl), maturityFeature(r.age, tau)]; };
  }
  function pooledMedianFitter(train) {
    function logRatio(r) { return Math.log10(r.mcap) - Math.log10(r.tvl); }
    var globalMed = medianOf(train.map(logRatio));
    var byCat = {};
    for (var i = 0; i < train.length; i++) {
      var r = train[i];
      if (r.category === null) continue;
      (byCat[r.category] = byCat[r.category] || []).push(logRatio(r));
    }
    var catMed = {};
    Object.keys(byCat).forEach(function (cat) {
      catMed[cat] = { med: medianOf(byCat[cat]), n: byCat[cat].length };
    });
    return {
      predict: function (row) {
        var cm = row.category === null ? undefined : catMed[row.category];
        var pooled = cm === undefined ? globalMed : (cm.n * cm.med + 5 * globalMed) / (cm.n + 5);
        var age = row.age === null ? 365 : row.age;
        var mat = 0.6 + 0.4 * (Math.min(Math.max(age, 0), 1095) / 1095);
        return Math.log10(row.tvl) + pooled + Math.log10(growthMult(row.pct)) + Math.log10(mat);
      }
    };
  }
  function globalMedianFitter(train) {
    var med = medianOf(train.map(function (r) { return Math.log10(r.mcap); }));
    return { predict: function () { return med; } };
  }
  function baseFit(train) {
    var X = train.map(designSize);
    var y = train.map(function (r) { return Math.log10(r.mcap); });
    return { beta: huberFit(X, y) };
  }
  function basePredict(beta, row) {
    return dot(beta, designSize(row)) + Math.log10(growthMult(row.pct));
  }
  function categoryOffsetFitter(train) {
    var beta = baseFit(train).beta;
    var sums = {};
    for (var i = 0; i < train.length; i++) {
      var r = train[i];
      if (r.category === null) continue;
      var resid = Math.log10(r.mcap) - basePredict(beta, r);
      var cur = sums[r.category] || { sum: 0, n: 0 };
      cur.sum += resid; cur.n += 1;
      sums[r.category] = cur;
    }
    var offsets = {};
    Object.keys(sums).forEach(function (cat) {
      offsets[cat] = (sums[cat].sum / sums[cat].n) * (sums[cat].n / (sums[cat].n + 5));
    });
    return {
      predict: function (row) {
        return basePredict(beta, row) + (row.category === null ? 0 : (offsets[row.category] || 0));
      }
    };
  }
  function categorySlopeFitter(train) {
    var beta = baseFit(train).beta;
    var groups = {};
    for (var i = 0; i < train.length; i++) {
      var r = train[i];
      if (r.category === null) continue;
      (groups[r.category] = groups[r.category] || []).push(r);
    }
    var adj = {};
    Object.keys(groups).forEach(function (cat) {
      var rows = groups[cat];
      if (rows.length < 3) return;
      var xs = rows.map(function (r) { return sizeX(r.tvl); });
      var xbar = meanOf(xs);
      var num = 0, den = 0;
      for (var k = 0; k < rows.length; k++) {
        var resid = Math.log10(rows[k].mcap) - basePredict(beta, rows[k]);
        num += (xs[k] - xbar) * resid;
        den += (xs[k] - xbar) * (xs[k] - xbar);
      }
      if (den > 1e-9) adj[cat] = { slope: (num / den) * (rows.length / (rows.length + 5)), xbar: xbar };
    });
    return {
      predict: function (row) {
        var a = row.category === null ? undefined : adj[row.category];
        return basePredict(beta, row) + (a === undefined ? 0 : a.slope * (sizeX(row.tvl) - a.xbar));
      }
    };
  }

  var SPECS = [
    { name: "v1 pooled median", fitter: pooledMedianFitter },
    { name: "flat global median", fitter: globalMedianFitter },
    { name: "OLS size curve", fitter: regressionFitter(designSize, false, false) },
    { name: "robust size curve", fitter: regressionFitter(designSize, true, false) },
    { name: "robust size x fixed growth", fitter: regressionFitter(designSize, true, true) },
    { name: "robust + fitted age", fitter: regressionFitter(designSizeAge, true, true) },
    { name: "robust + category offset", fitter: categoryOffsetFitter },
    { name: "robust + fitted growth", fitter: regressionFitter(designSizeGrowthFit, true, false) },
    { name: "robust + chain count", fitter: regressionFitter(designSizeChains, true, true) },
    { name: "robust + growth x size", fitter: regressionFitter(designSizeGrowthX, true, true) },
    { name: "robust + category slope", fitter: categorySlopeFitter },
    { name: "robust + quadratic size", fitter: regressionFitter(designSizeQuad, true, true) }
  ];

  function looErrors(fitter, rows) {
    var errors = [];
    for (var i = 0; i < rows.length; i++) {
      var train = rows.slice(0, i).concat(rows.slice(i + 1));
      var pred = fitter(train);
      errors.push(pred.predict(rows[i]) - Math.log10(rows[i].mcap));
    }
    return errors;
  }
  function splitErrors(fitter, train, test) {
    var pred = fitter(train);
    return test.map(function (r) { return pred.predict(r) - Math.log10(r.mcap); });
  }
  function timeSplit(rows, trainCount) {
    var dated = rows.filter(function (r) { return r.listedAt !== null; }).sort(function (a, b) {
      if (a.listedAt !== b.listedAt) return a.listedAt < b.listedAt ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return { train: dated.slice(0, trainCount), test: dated.slice(trainCount) };
  }
  function meanAbsError(errors) {
    return meanOf(errors.map(function (e) { return Math.abs(e); }));
  }
  function pickTauNestedCV(train) {
    var bestTau = TAU_GRID[0], bestScore = Infinity;
    for (var t = 0; t < TAU_GRID.length; t++) {
      var tau = TAU_GRID[t];
      var fitter = regressionFitter(designSizeMaturity(tau), true, true);
      var allErrors = [];
      for (var f = 0; f < 5; f++) {
        var subTrain = [], subTest = [];
        for (var i = 0; i < train.length; i++) {
          if (i % 5 === f) subTest.push(train[i]); else subTrain.push(train[i]);
        }
        if (subTest.length === 0) continue;
        var errs = splitErrors(fitter, subTrain, subTest);
        for (var e = 0; e < errs.length; e++) allErrors.push(errs[e]);
      }
      var score = meanAbsError(allErrors);
      if (score < bestScore) { bestScore = score; bestTau = tau; }
    }
    return bestTau;
  }
  function pickTauLoo(train) {
    var bestTau = TAU_GRID[0], bestScore = Infinity;
    for (var t = 0; t < TAU_GRID.length; t++) {
      var tau = TAU_GRID[t];
      var fitter = regressionFitter(designSizeMaturity(tau), true, true);
      var score = meanAbsError(looErrors(fitter, train));
      if (score < bestScore) { bestScore = score; bestTau = tau; }
    }
    return bestTau;
  }
  function looErrorsSaturating(rows) {
    var errors = [], taus = [];
    for (var i = 0; i < rows.length; i++) {
      var train = rows.slice(0, i).concat(rows.slice(i + 1));
      var tau = pickTauNestedCV(train);
      taus.push(tau);
      var fitter = regressionFitter(designSizeMaturity(tau), true, true);
      var pred = fitter(train);
      errors.push(pred.predict(rows[i]) - Math.log10(rows[i].mcap));
    }
    return { errors: errors, taus: taus };
  }
  function splitErrorsSaturating(train, test) {
    var tau = pickTauLoo(train);
    var fitter = regressionFitter(designSizeMaturity(tau), true, true);
    return { errors: splitErrors(fitter, train, test), tau: tau };
  }
  function pairedBootstrap(errA, errB) {
    var n = errA.length;
    var diffs = errA.map(function (a, i) { return Math.abs(a) - Math.abs(errB[i]); });
    var rng = mulberry32(20261115);
    var means = [];
    for (var r = 0; r < 2000; r++) {
      var s = 0;
      for (var j = 0; j < n; j++) s += diffs[Math.floor(rng() * n)];
      means.push(s / n);
    }
    var sorted = means.slice().sort(function (a, b) { return a - b; });
    return {
      diff: meanOf(diffs),
      ciLow: quantileSorted(sorted, 0.025),
      ciHigh: quantileSorted(sorted, 0.975)
    };
  }

  function runBacktest(comps, boardAges) {
    var X = comps.map(designSize);
    var y = comps.map(function (r) { return Math.log10(r.mcap); });
    var beta = huberFit(X, y);
    var curve = { a: beta[0], b: beta[1] };
    var split70 = timeSplit(comps, 62);
    var split50 = timeSplit(comps, 44);
    var specs = [];
    var looFinal = [], looSizeOnly = [], looAgeFit = [];
    var ts70SizeOnly = [], ts70Final = [], ts70AgeFit = [];
    var ts50SizeOnly = [], ts50Final = [], ts50AgeFit = [];
    for (var s = 0; s < SPECS.length; s++) {
      var loo = looErrors(SPECS[s].fitter, comps);
      var ts70 = splitErrors(SPECS[s].fitter, split70.train, split70.test);
      var lm = errorMetrics(loo), tm = errorMetrics(ts70);
      specs.push({ name: SPECS[s].name, looMiss: lm.miss, looWithin3: lm.within3, ts70Miss: tm.miss, ts70Within3: tm.within3 });
      if (s === 3) { looSizeOnly = loo; ts70SizeOnly = ts70; ts50SizeOnly = splitErrors(SPECS[s].fitter, split50.train, split50.test); }
      if (s === 4) { looFinal = loo; ts70Final = ts70; ts50Final = splitErrors(SPECS[s].fitter, split50.train, split50.test); }
      if (s === 5) { looAgeFit = loo; ts70AgeFit = ts70; ts50AgeFit = splitErrors(SPECS[s].fitter, split50.train, split50.test); }
    }
    var satLoo = looErrorsSaturating(comps);
    var sat70 = splitErrorsSaturating(split70.train, split70.test);
    var sat50 = splitErrorsSaturating(split50.train, split50.test);
    var ablation = [
      { name: "size only", looMiss: errorMetrics(looSizeOnly).miss, looMedian: errorMetrics(looSizeOnly).medianMiss, ts70Miss: errorMetrics(ts70SizeOnly).miss, ts50Miss: errorMetrics(ts50SizeOnly).miss },
      { name: "size + growth", looMiss: errorMetrics(looFinal).miss, looMedian: errorMetrics(looFinal).medianMiss, ts70Miss: errorMetrics(ts70Final).miss, ts50Miss: errorMetrics(ts50Final).miss },
      { name: "size + growth + fitted age", looMiss: errorMetrics(looAgeFit).miss, looMedian: errorMetrics(looAgeFit).medianMiss, ts70Miss: errorMetrics(ts70AgeFit).miss, ts50Miss: errorMetrics(ts50AgeFit).miss },
      { name: "size + growth + saturating age", looMiss: errorMetrics(satLoo.errors).miss, looMedian: errorMetrics(satLoo.errors).medianMiss, ts70Miss: errorMetrics(sat70.errors).miss, ts50Miss: errorMetrics(sat50.errors).miss }
    ];
    var absFinal = looFinal.map(function (e) { return Math.abs(e); }).sort(function (a, b) { return a - b; });
    var band80 = Math.pow(10, quantileSorted(absFinal, 0.8));
    var haircut = Math.pow(10, quantileSorted(absFinal, 0.5));
    var bootLog1p = pairedBootstrap(looAgeFit, looFinal);
    var bootSat = pairedBootstrap(satLoo.errors, looFinal);
    var ageBeta = huberFit(comps.map(designSizeAge), y);
    var factors = boardAges.map(function (age) { return Math.pow(10, ageBeta[2] * ageFeature(age)); });
    var fullTau = pickTauNestedCV(comps);
    var satBeta = huberFit(comps.map(designSizeMaturity(fullTau)), y);
    var looTauCounts = {};
    for (var i = 0; i < satLoo.taus.length; i++) {
      var k = String(satLoo.taus[i]);
      looTauCounts[k] = (looTauCounts[k] || 0) + 1;
    }
    var datedCount = comps.filter(function (r) { return r.listedAt !== null; }).length;
    return {
      curve: curve,
      specs: specs,
      ablation: ablation,
      band80: band80,
      haircut: haircut,
      looSd: looSdOf(looFinal),
      ageLog1p: {
        diff: bootLog1p.diff, ciLow: bootLog1p.ciLow, ciHigh: bootLog1p.ciHigh,
        coef: ageBeta[2], wouldBeMin: Math.min.apply(null, factors), wouldBeMax: Math.max.apply(null, factors)
      },
      ageSaturating: {
        diff: bootSat.diff, ciLow: bootSat.ciLow, ciHigh: bootSat.ciHigh,
        coef: satBeta[2], fullTau: fullTau, split70Tau: sat70.tau, split50Tau: sat50.tau,
        looTauCounts: looTauCounts
      },
      splitInfo: {
        dated: datedCount, undated: comps.length - datedCount,
        ts70: { train: split70.train.length, test: split70.test.length, cutoff: split70.test.length > 0 ? split70.test[0].listedAt : null },
        ts50: { train: split50.train.length, test: split50.test.length, cutoff: split50.test.length > 0 ? split50.test[0].listedAt : null }
      }
    };
  }

  // ------------------------------------------------------- verdict economics
  function gasSchedule(firstChain) {
    if (firstChain !== null) {
      var c = firstChain.toLowerCase();
      if (c.indexOf("ethereum") !== -1) return { setup: 12, weekly: 4 };
      if (c.indexOf("solana") !== -1) return { setup: 0.1, weekly: 0.1 };
      if (c.indexOf("bitcoin") !== -1) return { setup: 3, weekly: 3 };
    }
    return { setup: 1, weekly: 1 };
  }
  function holdDays(age) {
    if (age === null) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function tierCapital(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    return 50;
  }
  function economics(tvl, pct, age, firstChain, curve, band80, haircut) {
    var curveValue = Math.pow(10, curve.a + curve.b * sizeX(tvl));
    var mult = growthMult(pct);
    var implied = Math.max(1, Math.min(1e14, Math.round(curveValue * mult)));
    var bandLow = Math.max(1, Math.round(implied / band80));
    var bandHigh = Math.round(implied * band80);
    var hold = holdDays(age);
    var gas = gasSchedule(firstChain);
    var gasTotal = round2(gas.setup + gas.weekly * Math.ceil(hold / 7));
    var gross = 1000 * (implied / tvl) * 0.1;
    var cost = gasTotal + 1000 * 0.04 * (hold / 365);
    var net = gross - cost;
    var netLow = gross / haircut - cost;
    var verdict = netLow > 0 ? "FARM" : net > 0 ? "THIN" : "SKIP";
    return {
      curveValue: curveValue, growthPct: clampPct(pct), growthMultiplier: mult,
      implied: implied, bandLow: bandLow, bandHigh: bandHigh,
      gross: round2(gross), cost: round2(cost), net: round2(net), netLow: round2(netLow),
      gasTotal: gasTotal, hold: hold, verdict: verdict
    };
  }

  // ------------------------------------------------------------ farm plans
  var CATEGORY_GROUPS = [
    { keys: ["curator", "allocator"], main: "Deposit {pos} into the vault on {chain} through the protocol's official app", weekly: "Top up the vault or check the position and collect any points", risk: "vault withdrawal terms and any lock-up" },
    { keys: ["perpetual", "derivative", "interest-rate", "interest rate"], main: "Open a margined position of {pos} on {chain} with a small hedge on the other side", weekly: "Check the margined position, rebalance the hedge, and keep the position open", risk: "liquidation risk and the health of the hedge" },
    { keys: ["basis"], main: "Open a delta-neutral basis position of {pos} on {chain}", weekly: "Check the basis position and rebalance the hedge to stay delta-neutral", risk: "funding and liquidation risk on both legs" },
    { keys: ["lend", "cdp", "collateral"], main: "Supply {pos} to the lending market on {chain}", weekly: "Check the supplied position and top it up if the market moved", risk: "health factor and liquidation risk" },
    { keys: ["prediction"], main: "Take a {pos} position in an open market on {chain}", weekly: "Review the open markets and keep one live position", risk: "the market resolution rules" },
    { keys: ["bridge"], main: "Bridge {pos} to {chain} and put the funds to work in the protocol's main app", weekly: "Check the bridged funds and keep them working in the main app", risk: "bridge delays and destination-chain fees" },
    { keys: ["dex", "liquidity manager", "amm"], main: "Provide {pos} of liquidity on {chain} in the protocol's main pool", weekly: "Check the liquidity position and rebalance the range if needed", risk: "impermanent loss" },
    { keys: ["staking", "restaking"], main: "Stake {pos} on {chain} through the protocol's official staking flow", weekly: "Check the staked position and restake or collect any rewards", risk: "unbonding delays" },
    { keys: ["rwa"], main: "Mint {pos} of the yield-bearing asset on {chain}", weekly: "Check the minted asset and its yield accrual", risk: "the redemption window" },
    { keys: ["stablecoin", "dual-token", "dual token"], main: "Mint or deposit {pos} of the stable asset on {chain}", weekly: "Check the stable position and its peg", risk: "peg risk" },
    { keys: ["yield", "farm", "aggregator"], main: "Deposit {pos} into the yield vault on {chain}", weekly: "Check the vault position and harvest or compound", risk: "the withdrawal queue" },
    { keys: ["insurance"], main: "Buy {pos} of cover on {chain}", weekly: "Check the cover position and its expiry", risk: "cover terms and claim windows" },
    { keys: ["payment", "card"], main: "Deposit {pos} on {chain} and make one spend through the protocol", weekly: "Make one more spend and check the balance", risk: "spending and withdrawal terms" },
    { keys: ["governance"], main: "Stake {pos} and cast a vote on {chain}", weekly: "Vote on any new proposal and check the stake", risk: "unbonding delays and vote timing" },
    { keys: ["index"], main: "Buy {pos} of the index on {chain}", weekly: "Check the index position and rebalance if the weights moved", risk: "rebalance and withdrawal terms" },
    { keys: ["otc"], main: "Deposit {pos} and complete one OTC trade on {chain}", weekly: "Check for a new OTC listing and keep the deposit working", risk: "settlement and withdrawal terms" },
    { keys: ["btc", "bitcoin"], main: "Deposit {pos} of BTC on {chain}", weekly: "Check the BTC deposit and its rewards", risk: "withdrawal delays" },
    { keys: ["cedefi"], main: "Deposit {pos} into the vault on {chain}", weekly: "Check the vault position and top up if needed", risk: "vault withdrawal terms" },
    { keys: [], exactChain: true, main: "Bridge {pos} to {chain} and use the main app", weekly: "Use the main app once and check the position", risk: "bridge delays" }
  ];
  var GENERIC_GROUP = { keys: [], main: "Deposit {pos} through the protocol's official app on {chain}", weekly: "Check the position and keep it qualifying", risk: "withdrawal terms" };
  function categoryGroup(category) {
    if (category === null) return GENERIC_GROUP;
    var lower = category.toLowerCase();
    for (var g = 0; g < CATEGORY_GROUPS.length; g++) {
      var grp = CATEGORY_GROUPS[g];
      if (grp.exactChain) { if (lower === "chain") return grp; continue; }
      for (var k = 0; k < grp.keys.length; k++) {
        if (lower.indexOf(grp.keys[k]) !== -1) return grp;
      }
    }
    return GENERIC_GROUP;
  }
  function fmtMoney(v) {
    var abs = Math.abs(v).toFixed(2);
    return v < 0 ? "-$" + abs : "$" + abs;
  }
  function joinStep(text, cost, time) {
    var action = text.trim();
    var suffix = ". Cost: " + cost + ". Time: " + time;
    while ((action + suffix).length < 20) action += " Hold and check the position weekly.";
    var joined = action + suffix;
    if (joined.length > 600) {
      var maxAction = 600 - suffix.length - 3;
      action = action.slice(0, Math.max(0, maxAction)) + "...";
      joined = action + suffix;
    }
    return joined;
  }
  function buildFarmSteps(ctx) {
    var group = categoryGroup(ctx.category);
    var chain = ctx.firstChain === null ? "the protocol's chain" : ctx.firstChain;
    var weeks = Math.ceil(ctx.hold / 7);
    var pos = ctx.verdict === "SKIP" ? "$10.00" : fmtMoney(ctx.tier);
    function fill(t) { return t.replace("{pos}", pos).replace("{chain}", chain); }
    var step1 = "Verdict " + ctx.verdict + ": the $1,000 yardstick at a 10% share leaves net " +
      fmtMoney(ctx.net) + " after costs at a 4% hurdle (low-end net " + fmtMoney(ctx.netLow) + "). " +
      "Use a fresh wallet and only the links from the protocol's official docs";
    var step2 = fill(group.main) + ". Allow " + fmtMoney(ctx.setupGas) + " for setup gas";
    if (ctx.verdict === "SKIP") step2 += ". Keep this a small test position";
    var step3 = fill(group.weekly) + ". Repeat this check every week until the hold ends";
    var step4 = "Open the protocol's points or rewards page, confirm the position is counting, " +
      "and save a dated screenshot of the balance";
    var step5 = "Hold for at least " + ctx.hold + " days, completing one qualifying action each week " +
      "to keep the position active";
    var step6 = "Exit rule: if TVL falls 15% week over week, or the points page stops counting " +
      "the position for two weeks in a row, start exiting and do not add capital";
    var step7 = "Before exiting, check " + group.risk + " and withdraw a small test amount first";
    var step8 = "Keep a farm log of every deposit and screenshot, and claim only through " +
      "official links — never pay to claim";
    var steps = [];
    steps.push(joinStep(step1, "$0.00", "Week 1"));
    steps.push(joinStep(step2, pos, "Week 1"));
    if (ctx.verdict !== "SKIP") steps.push(joinStep(step3, fmtMoney(ctx.weeklyGas), "Week 2"));
    steps.push(joinStep(step4, "$0.00", "Week 2"));
    steps.push(joinStep(step5, "$0.00", "Weeks 1-" + weeks));
    if (ctx.verdict === "FARM") steps.push(joinStep(step6, "$0.00", "Weeks 1-" + weeks));
    steps.push(joinStep(step7, fmtMoney(ctx.weeklyGas), "Before exit"));
    steps.push(joinStep(step8, "$0.00", "Ongoing"));
    return steps;
  }

  // ------------------------------------------------- recompute everything
  var comps = D.comps.slice().sort(function (a, b) { return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; });
  var boardAges = D.rows.map(function (r) { return r.age; });
  var BT = runBacktest(comps, boardAges);

  var recomputed = D.rows.map(function (row) {
    var firstChain = row.chains.length > 0 ? row.chains[0] : null;
    var econ = economics(row.tvl, row.pct, row.age, firstChain, BT.curve, BT.band80, BT.haircut);
    var gas = gasSchedule(firstChain);
    var steps = buildFarmSteps({
      verdict: econ.verdict, category: row.category, firstChain: firstChain,
      tier: tierCapital(row.tvl), hold: econ.hold, net: econ.net, netLow: econ.netLow,
      setupGas: gas.setup, weeklyGas: gas.weekly
    });
    return {
      slug: row.slug, implied: econ.implied, bandLow: econ.bandLow, bandHigh: econ.bandHigh,
      verdict: econ.verdict, net: econ.net, gross: econ.gross, cost: econ.cost,
      hold: econ.hold, gas: econ.gasTotal, curveValue: econ.curveValue,
      growthPct: econ.growthPct, growthMult: econ.growthMultiplier, farmSteps: steps
    };
  });

  var check = { impliedMismatches: 0, bandMismatches: 0, verdictMismatches: 0, netMismatches: 0, rows: recomputed.length };
  for (var ci = 0; ci < D.rows.length; ci++) {
    var orig = D.rows[ci], rec = recomputed[ci];
    if (orig.implied !== rec.implied) check.impliedMismatches++;
    if (orig.bandLow !== rec.bandLow || orig.bandHigh !== rec.bandHigh) check.bandMismatches++;
    if (orig.verdict !== rec.verdict) check.verdictMismatches++;
    if (orig.net !== rec.net) check.netMismatches++;
  }
  window.__RADAR_RECOMPUTED__ = recomputed;
  window.__RADAR_CHECK__ = check;
  window.__RADAR_BACKTEST__ = BT;

  // -------------------------------------------------------------- rendering
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtInt(v) { return v.toLocaleString("en-US"); }
  function fmtCompact(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }
  function fmtPct(v) {
    if (v === null) return "n/a";
    return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function fmtAge(v) { return v === null ? "n/a" : v + "d"; }
  function pill(v) { return '<span class="pill ' + v + '">' + v + "</span>"; }
  function bySlug(slug) {
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) return D.rows[i];
    return null;
  }
  function recBySlug(slug) {
    for (var i = 0; i < recomputed.length; i++) if (recomputed[i].slug === slug) return recomputed[i];
    return null;
  }

  function statsBar() {
    return '<div class="stats">' +
      '<div class="stat"><div class="v">' + D.counts.board + '</div><div class="l">Ranked</div></div>' +
      '<div class="stat"><div class="v">' + D.verdicts.FARM + '</div><div class="l">Farm</div></div>' +
      '<div class="stat"><div class="v">' + D.verdicts.THIN + '</div><div class="l">Thin</div></div>' +
      '<div class="stat"><div class="v">' + D.verdicts.SKIP + '</div><div class="l">Skip</div></div>' +
      '<div class="stat"><div class="v">' + D.counts.watchlist + '</div><div class="l">Watchlist covered</div></div>' +
      '<div class="stat"><div class="v">' + D.counts.comps + '</div><div class="l">Fit comps</div></div>' +
      "</div>";
  }

  function boardTable(rows) {
    var h = '<table><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th>' +
      '<th class="num">TVL</th><th class="num">7d</th><th class="num">Implied value</th>' +
      '<th class="num">Band</th><th>Verdict</th><th class="num">Age</th><th>WL</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += "<tr><td class=\"num\">" + r.rank + "</td>" +
        '<td><a class="rowlink" href="#detail/' + esc(r.slug) + '">' + esc(r.name) + "</a> " +
        '<span class="muted small">' + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category === null ? "—" : r.category) + "</td>" +
        '<td class="num">' + fmtCompact(r.tvl) + "</td>" +
        '<td class="num">' + fmtPct(r.pct) + "</td>" +
        '<td class="num"><strong>' + fmtCompact(r.implied) + "</strong></td>" +
        '<td class="num">' + fmtCompact(r.bandLow) + " – " + fmtCompact(r.bandHigh) + "</td>" +
        "<td>" + pill(r.verdict) + "</td>" +
        '<td class="num">' + fmtAge(r.age) + "</td>" +
        '<td>' + (r.watchlist ? '<span class="watch" title="On the snapshot watchlist">★</span>' : "") + "</td></tr>";
    }
    return h + "</tbody></table>";
  }

  function renderBoard() {
    return statsBar() +
      '<div class="card"><h2>Board — ranked by implied value</h2>' +
      '<p class="muted small">Every protocol on the snapshot watchlist is covered, plus ' +
      "rankable protocols below the floor. Implied values are recomputed in this page from " +
      "the fitted curve. ★ marks watchlist rows.</p>" +
      boardTable(D.rows) + "</div>";
  }

  function renderFiltered(params) {
    var verdict = params.get("verdict") || "ALL";
    var category = params.get("category") || "ALL";
    var watchOnly = params.get("watchlist") === "1";
    var sort = params.get("sort") || "implied-desc";
    var cats = [];
    var seen = {};
    D.rows.forEach(function (r) {
      var c = r.category === null ? "(none)" : r.category;
      if (!seen[c]) { seen[c] = true; cats.push(c); }
    });
    cats.sort();
    var rows = D.rows.filter(function (r) {
      if (verdict !== "ALL" && r.verdict !== verdict) return false;
      if (category !== "ALL" && (r.category === null ? "(none)" : r.category) !== category) return false;
      if (watchOnly && !r.watchlist) return false;
      return true;
    });
    var sorted = rows.slice();
    if (sort === "implied-asc") sorted.sort(function (a, b) { return a.implied - b.implied; });
    else if (sort === "tvl-desc") sorted.sort(function (a, b) { return b.tvl - a.tvl; });
    else if (sort === "age-desc") sorted.sort(function (a, b) { return (b.age === null ? -1 : b.age) - (a.age === null ? -1 : a.age); });
    else if (sort === "name") sorted.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else sorted.sort(function (a, b) { return b.implied - a.implied; });

    function opt(value, label, current) {
      return '<option value="' + esc(value) + '"' + (value === current ? " selected" : "") + ">" + esc(label) + "</option>";
    }
    var h = '<div class="card"><h2>Filtered board</h2>' +
      '<div class="filters">' +
      '<div><label for="f-verdict">Verdict</label><select id="f-verdict">' +
      opt("ALL", "All verdicts", verdict) + opt("FARM", "FARM", verdict) + opt("THIN", "THIN", verdict) + opt("SKIP", "SKIP", verdict) +
      "</select></div>" +
      '<div><label for="f-category">Category</label><select id="f-category">' + opt("ALL", "All categories", category);
    cats.forEach(function (c) { h += opt(c, c, category); });
    h += "</select></div>" +
      '<div><label for="f-watch">Watchlist</label><select id="f-watch">' +
      opt("0", "All rows", watchOnly ? "1" : "0") + opt("1", "Watchlist only", watchOnly ? "1" : "0") +
      "</select></div>" +
      '<div><label for="f-sort">Sort</label><select id="f-sort">' +
      opt("implied-desc", "Implied value ↓", sort) + opt("implied-asc", "Implied value ↑", sort) +
      opt("tvl-desc", "TVL ↓", sort) + opt("age-desc", "Age ↓", sort) + opt("name", "Name A–Z", sort) +
      "</select></div></div>" +
      '<p class="muted small">' + sorted.length + " of " + D.rows.length + " rows shown.</p>" +
      boardTable(sorted) + "</div>";
    return h;
  }

  function renderDetail(slug) {
    var row = bySlug(slug) || D.rows[0];
    var rec = recBySlug(row.slug);
    var steps = rec ? rec.farmSteps : [];
    var chains = row.chains.length > 0 ? row.chains.join(", ") : "no chain recorded";
    var h = '<div class="card"><p><a href="#board">← Back to the board</a></p>' +
      "<h2>" + esc(row.name) + ' <span class="muted small">#' + row.rank + " · " + esc(row.slug) + "</span></h2>" +
      "<p>" + esc(row.category === null ? "No category recorded" : row.category) + " · " + esc(chains) +
      (row.watchlist ? ' · <span class="watch">★ Watchlist</span>' : "") + "</p>" +
      '<p class="muted small">Status: pre-token — not recorded as having a token in the snapshot. ' +
      "The figures below are recomputed in this page from the snapshot record.</p>" +
      '<div class="big">' + fmtInt(row.implied) + ' <span class="small muted">USD implied value</span></div>' +
      "<p>Band " + fmtInt(row.bandLow) + " – " + fmtInt(row.bandHigh) + " USD · " + pill(row.verdict) +
      " · Net " + fmtMoney(row.net) + " on the $1,000 yardstick</p>" +
      '<div class="grid">' +
      '<div class="kv"><div class="k">Curve value</div><div class="v">' + fmtCompact(row.curveValue) + "</div></div>" +
      '<div class="kv"><div class="k">Growth (7d)</div><div class="v">' + fmtPct(row.pct) + " → ×" + row.growthMult.toFixed(3) + "</div></div>" +
      '<div class="kv"><div class="k">Gross</div><div class="v">' + fmtMoney(row.gross) + "</div></div>" +
      '<div class="kv"><div class="k">Cost</div><div class="v">' + fmtMoney(row.cost) + "</div></div>" +
      '<div class="kv"><div class="k">TVL</div><div class="v">' + fmtCompact(row.tvl) + "</div></div>" +
      '<div class="kv"><div class="k">Age</div><div class="v">' + (row.age === null ? "n/a" : row.age + " days") + "</div></div>" +
      '<div class="kv"><div class="k">Hold window</div><div class="v">' + row.hold + " days</div></div>" +
      '<div class="kv"><div class="k">Est. gas</div><div class="v">' + fmtMoney(row.gas) + "</div></div>" +
      "</div>" +
      "<h3>Farm plan</h3><ol class=\"steps\">";
    for (var i = 0; i < steps.length; i++) h += "<li>" + esc(steps[i]) + "</li>";
    return h + "</ol></div>";
  }

  function f4(v) {
    if (v === null || v === undefined || !isFinite(v)) return "n/a";
    return v.toFixed(4);
  }
  function renderMethod() {
    var bt = BT;
    var h = '<div class="card"><h2>Method — how the radar ranks</h2>' +
      '<div class="callout"><strong>Age was tested, and rejected.</strong> ' +
      "Both age forms lose in leave-one-out testing against the size-and-growth curve, " +
      "with bootstrap intervals that exclude zero on the worse side, and both collapse in " +
      "time splits. Price therefore carries no age term. Age still sets each farm plan's " +
      "hold window, and every row shows its age.</div>" +
      "<h3>The data</h3>" +
      "<p>One frozen snapshot: " + D.counts.protocols + " protocols from DefiLlama, fetched " +
      esc(D.snapshot.as_of) + ". The watchlist holds " + D.counts.watchlist +
      " protocols. The board ranks " + D.counts.board + " protocols not recorded as having " +
      "a token that pass the watchlist exclusion rules; " + D.counts.excluded +
      " pre-token protocols are set aside by those rules (category " +
      D.counts.excludedReasons.category + ", version marker " +
      D.counts.excludedReasons.version + ", wrapped/staked name " +
      D.counts.excludedReasons.wrapped + ", exchange name " +
      D.counts.excludedReasons.exchange + "). The $50M floor is not used for the board: " +
      "rankable protocols below it are included. The price curve is fitted on " +
      D.counts.comps + " clean comparison protocols with a recorded token whose " +
      "market-cap/TVL ratio sits inside [0.001, 10].</p>" +
      "<h3>The value model, in words</h3>" +
      "<p>The curve predicts a protocol's market cap from its size alone: the log of market " +
      "cap is a straight line in the log of TVL measured against $100M. The line is fitted " +
      "robustly (Huber), so a few extreme comparisons cannot drag it. A fixed growth prior " +
      "then scales the curve value by the protocol's 7-day TVL change, and the result is " +
      "the implied value. Uncertainty bands come from the curve's own leave-one-out errors.</p>" +
      '<p class="eq">log10(market cap) = ' + bt.curve.a.toFixed(4) + " + " + bt.curve.b.toFixed(4) +
      " × log10(TVL / $100M) &nbsp;·&nbsp; implied = round(10<sup>curve</sup> × growth multiplier)</p>" +
      "<p>Growth multiplier = 1 + (7-day change, clamped to [−60%, +120%], × 0.5 / 100). " +
      "A missing 7-day change counts as 0. Band = implied ÷ " + f4(bt.band80) + " to implied × " +
      f4(bt.band80) + ", where " + f4(bt.band80) + " is 10 raised to the 80th percentile of " +
      "absolute leave-one-out errors.</p>" +
      "<h3>Verdict economics</h3>" +
      "<p>Gross = $1,000 yardstick × (implied / TVL) × 10% share. Cost = estimated gas + " +
      "$1,000 × 4% hurdle × (hold days / 365). Net = gross − cost; low-end net = gross ÷ " +
      f4(bt.haircut) + " − cost. FARM when low-end net is positive, THIN when only net is " +
      "positive, otherwise SKIP. Position tiers come from the protocol's own TVL: $250 at " +
      "$5B+, $150 at $1B+, $100 at $100M+, else $50. Hold windows come from age: unknown age " +
      "30 days, under 180 days 60 days, under 365 days 45 days, else 30 days.</p>" +
      "<h3>Constants</h3>" +
      "<p>Model label <code>" + esc(D.model.version) + "</code>. Growth weight 0.5; comparison " +
      "ratio [0.001, 10]; Huber c 1.345, 12 iterations; band quantile 0.8; haircut quantile 0.5; " +
      "yardstick $1,000; share 0.1; hurdle 4%. Bootstrap: 2,000 paired resamples, seed 20261115. " +
      "Saturating-age tau grid: 60, 90, 180, 365, 730, 1095, 1825, 3650 days.</p>";

    h += "<h3>Backtest — 12 specifications</h3>" +
      "<p>Miss = 10 raised to the mean absolute log10 error (lower is better); within3 = " +
      "share of errors inside a factor of 3. LOO = leave-one-out over " + D.counts.comps +
      " comparisons; TS70 = time split, " + bt.splitInfo.ts70.train + " oldest for training, " +
      bt.splitInfo.ts70.test + " newest for testing.</p>" +
      '<table><thead><tr><th>Specification</th><th class="num">LOO miss</th><th class="num">LOO within3</th>' +
      '<th class="num">TS70 miss</th><th class="num">TS70 within3</th></tr></thead><tbody>';
    for (var i = 0; i < bt.specs.length; i++) {
      var s = bt.specs[i];
      h += "<tr><td>" + esc(s.name) + (i === 4 ? " <strong>(this radar)</strong>" : "") + "</td>" +
        '<td class="num">' + f4(s.looMiss) + '</td><td class="num">' + f4(s.looWithin3) +
        '</td><td class="num">' + f4(s.ts70Miss) + '</td><td class="num">' + f4(s.ts70Within3) + "</td></tr>";
    }
    h += "</tbody></table>";

    h += "<h3>Ablation — what each ingredient adds</h3>" +
      '<table><thead><tr><th>Form</th><th class="num">LOO miss</th><th class="num">LOO median</th>' +
      '<th class="num">TS70 miss</th><th class="num">TS50 miss</th></tr></thead><tbody>';
    for (var j = 0; j < bt.ablation.length; j++) {
      var a = bt.ablation[j];
      h += "<tr><td>" + esc(a.name) + "</td>" +
        '<td class="num">' + f4(a.looMiss) + '</td><td class="num">' + f4(a.looMedian) +
        '</td><td class="num">' + f4(a.ts70Miss) + '</td><td class="num">' + f4(a.ts50Miss) + "</td></tr>";
    }
    h += "</tbody></table>" +
      "<p>TS50 = time split " + bt.splitInfo.ts50.train + "/" + bt.splitInfo.ts50.test +
      ". Only " + bt.splitInfo.dated + " comparisons carry a listing date (" +
      bt.splitInfo.undated + " without one are excluded from time splits). " +
      "The saturating-age TS70 figure is the honest result of a nearly unidentified " +
      "coefficient fitted on old listings only; it is reported, not repaired.</p>";

    h += "<h3>Age diagnostics</h3>" +
      "<p>Form 1 adds log1p(age in years) to the robust regression. Form 2 adds a " +
      "saturating maturity term, 1 − exp(−age / tau), with tau picked honestly: per-fold " +
      "5-fold cross-validation inside the training rows only for leave-one-out, and " +
      "leave-one-out inside the training rows only for time splits. Tau is never picked " +
      "from the rows being scored.</p>" +
      '<table><thead><tr><th>Age form</th><th class="num">LOO diff vs curve</th><th class="num">95% interval</th>' +
      '<th class="num">Fitted coef.</th></tr></thead><tbody>' +
      "<tr><td>log1p age</td><td class=\"num\">+" + f4(bt.ageLog1p.diff) + "</td>" +
      '<td class="num">[' + f4(bt.ageLog1p.ciLow) + ", " + f4(bt.ageLog1p.ciHigh) + "]</td>" +
      '<td class="num">' + f4(bt.ageLog1p.coef) + "</td></tr>" +
      "<tr><td>Saturating maturity</td><td class=\"num\">+" + f4(bt.ageSaturating.diff) + "</td>" +
      '<td class="num">[' + f4(bt.ageSaturating.ciLow) + ", " + f4(bt.ageSaturating.ciHigh) + "]</td>" +
      '<td class="num">' + f4(bt.ageSaturating.coef) + "</td></tr></tbody></table>" +
      "<p>Positive diffs mean the age form errs more than the curve. Both intervals exclude " +
      "zero on the worse side: a decisive rejection. Had age been kept, its would-be factor " +
      "over board rows would span [" + f4(bt.ageLog1p.wouldBeMin) + ", " + f4(bt.ageLog1p.wouldBeMax) +
      "]. Tau picked for the full-data saturating fit: " + bt.ageSaturating.fullTau +
      " days; for the TS70 split: " + bt.ageSaturating.split70Tau + " days; for TS50: " +
      bt.ageSaturating.split50Tau + " days. LOO error scale: band80 " + f4(bt.band80) +
      ", haircut " + f4(bt.haircut) + ", LOO RMS " + f4(bt.looSd) + ".</p>";

    h += "<h3>Missing data</h3>" +
      "<p>A missing listing date gives a neutral age feature and a 30-day hold. A missing " +
      "7-day change counts as 0% growth. A missing category gives the generic farm action. " +
      "No chain recorded gives neutral chain wording and default gas. The program never " +
      "crashes on a null field.</p>" +
      "<h3>Gas figures are estimates</h3>" +
      "<p>Gas is an estimate, labeled as such, not snapshot data. Schedules, setup + weekly: " +
      "Ethereum $12.00 + $4.00; Solana $0.10 + $0.10; Bitcoin $3.00 + $3.00; anything else " +
      "$1.00 + $1.00 — matched from the first chain the protocol names. Total gas = setup + " +
      "weekly × ceil(hold / 7).</p>" +
      "<h3>Recomputation check</h3>" +
      "<p>This page refitted the curve and the age diagnostics from the " + D.counts.comps +
      " fit comparisons, recomputed every implied value, band and verdict, and regenerated " +
      "every farm plan from the snapshot figures. Agreement with the program's board: " +
      check.impliedMismatches + " implied mismatches, " + check.bandMismatches +
      " band mismatches, " + check.verdictMismatches + " verdict mismatches, " +
      check.netMismatches + " net mismatches over " + check.rows + " rows.</p>" +
      "<h3>Source</h3>" +
      '<p class="muted">Snapshot: DefiLlama protocol data frozen ' + esc(D.snapshot.as_of) +
      ". All ages count from that frozen date; the page reads no clock and makes no network " +
      "requests. Model label <code>" + esc(D.model.version) + "</code>.</p></div>";
    return h;
  }

  function renderLive() {
    var h = '<div class="card"><h2>Live tokens — recorded market caps</h2>' +
      "<p class=\"muted small\">The 24 largest protocols with a recorded token, " +
      "excluding the CEX category, by market cap. Ratio = market cap / TVL.</p>" +
      '<table><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th>' +
      '<th class="num">TVL</th><th class="num">Market cap</th><th class="num">Ratio</th><th class="num">7d</th></tr></thead><tbody>';
    for (var i = 0; i < D.live.length; i++) {
      var l = D.live[i];
      h += "<tr><td class=\"num\">" + (i + 1) + "</td><td><strong>" + esc(l.name) + "</strong> " +
        '<span class="muted small">' + esc(l.slug) + "</span></td>" +
        "<td>" + esc(l.category === null ? "—" : l.category) + "</td>" +
        '<td class="num">' + fmtCompact(l.tvl) + "</td>" +
        '<td class="num">' + fmtCompact(l.mcap) + "</td>" +
        '<td class="num">' + l.ratio.toFixed(4) + "</td>" +
        '<td class="num">' + fmtPct(l.pct) + "</td></tr>";
    }
    return h + "</tbody></table></div>";
  }

  // ---------------------------------------------------------------- router
  var viewEl = document.getElementById("view");
  function parseHash() {
    var raw = window.location.hash.replace(/^#/, "");
    var parts = raw.split("?");
    var path = parts[0].split("/");
    var params = new URLSearchParams(parts[1] || "");
    return { view: path[0] || "board", arg: path[1] || "", params: params };
  }
  function render() {
    var parsed = parseHash();
    var html;
    var current = parsed.view;
    if (parsed.view === "detail") { html = renderDetail(decodeURIComponent(parsed.arg)); current = "board"; }
    else if (parsed.view === "filtered") html = renderFiltered(parsed.params);
    else if (parsed.view === "method") html = renderMethod();
    else if (parsed.view === "live") html = renderLive();
    else html = renderBoard();
    viewEl.innerHTML = html;
    var links = document.querySelectorAll("nav.tabs a");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("data-view") === current) links[i].setAttribute("aria-current", "page");
      else links[i].removeAttribute("aria-current");
    }
    if (parsed.view === "filtered") bindFilters(parsed.params);
    window.scrollTo(0, 0);
  }
  function bindFilters(params) {
    function go() {
      var v = document.getElementById("f-verdict").value;
      var c = document.getElementById("f-category").value;
      var w = document.getElementById("f-watch").value;
      var s = document.getElementById("f-sort").value;
      var q = new URLSearchParams();
      if (v !== "ALL") q.set("verdict", v);
      if (c !== "ALL") q.set("category", c);
      if (w === "1") q.set("watchlist", "1");
      if (s !== "implied-desc") q.set("sort", s);
      var qs = q.toString();
      window.location.hash = "#filtered" + (qs ? "?" + qs : "");
    }
    ["f-verdict", "f-category", "f-watch", "f-sort"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", go);
    });
  }
  window.addEventListener("hashchange", render);

  document.getElementById("foot").innerHTML =
    "Source: DefiLlama snapshot frozen " + esc(D.snapshot.as_of) +
    " · Model " + esc(D.model.version) +
    " · This page refits the curve in your browser and recomputes every figure from the same snapshot data.";

  render();
  window.__RADAR_READY__ = true;
})();
