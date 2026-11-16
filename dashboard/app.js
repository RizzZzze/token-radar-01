// Token Radar: 198 protocols not recorded as having a token (40 watchlist + 158
// beyond), ranked by an implied value from a Huber-robust size curve fitted over
// 119 live-token comps: log10(mcap) = a + b*log10(TVL/$100M), fitted at run time.
// Age was fitted, tested under three protocols, and rejected; the Method view
// carries the ablation and the bootstrap intervals. 144 wrapped/staked/bridged/
// exchange protocols are set aside by the watchlist rule, never ranked. No
// network: every byte shown is in data.js. The model lives here too, in the same
// arithmetic main.ts runs: fitCurve refits the curve, maturityFit refits the
// diagnostic age fit, impliedOf is size curve x growth, looBand rebuilds the
// band, verdictOf nets dollars at the yardstick, farmSteps derives each plan.
// No protocol name is special-cased.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watch: false, tab: 'board', sort: 'implied', dir: -1, selected: null,
    capital: DATA.model.verdict_capital, share: DATA.model.verdict_share * 100, hurdle: DATA.model.hurdle_rate * 100 };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(2) + 'x';
  }
  function fmtMiss(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    if (v >= 1000) return 'x' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 100) return 'x' + Math.round(v);
    return 'x' + v.toFixed(2);
  }
  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  /** Days from listed_at to as_of, clamped at zero; null when either date is absent or bad. */
  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / 86400000));
  }

  // Least squares by Gaussian elimination, then Huber reweighting: the same fit main.ts runs.
  function solveLinear(A, b) {
    var n = b.length;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var col = 0, row = 0; col < n && row < n; col++, row++) {
      var piv = row;
      for (var r = row + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      var tmp = M[row]; M[row] = M[piv]; M[piv] = tmp;
      if (Math.abs(M[row][col]) < 1e-12) continue;
      for (r = 0; r < n; r++) {
        if (r === row) continue;
        var f = M[r][col] / M[row][col];
        for (var c = col; c <= n; c++) M[r][c] -= f * M[row][c];
      }
    }
    return M.map(function (row, i) { return Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]; });
  }
  function ols(X, y, weights) {
    var k = X[0].length;
    var A = [], b = [];
    for (var i = 0; i < k; i++) { A.push([]); for (var j = 0; j < k; j++) A[i].push(0); b.push(0); }
    for (i = 0; i < X.length; i++) {
      var w = weights ? weights[i] : 1;
      for (var r = 0; r < k; r++) {
        b[r] += w * X[i][r] * y[i];
        for (var c = 0; c < k; c++) A[r][c] += w * X[i][r] * X[i][c];
      }
    }
    return solveLinear(A, b);
  }
  function dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function huberFit(rows, cols) {
    var m = DATA.model;
    var X = rows.map(cols);
    var y = rows.map(function (r) { return r.y; });
    var beta = ols(X, y);
    for (var it = 0; it < m.huber_iters; it++) {
      var res = rows.map(function (r, i) { return y[i] - dot(X[i], beta); });
      var med = median(res);
      var mad = median(res.map(function (v) { return Math.abs(v - med); })) || 1e-6;
      var s = 1.4826 * mad;
      var w = res.map(function (v) { return Math.min(1, (m.huber_c * s) / Math.max(Math.abs(v), 1e-9)); });
      var next = ols(X, y, w);
      var done = next.every(function (v, i) { return Math.abs(v - beta[i]) < 1e-10; });
      beta = next;
      if (done) break;
    }
    return beta;
  }
  // sizeFit: the pricing fit, refit in the page; maturityFit is the diagnostic
  // age fit, refit only to verify the diagnostic numbers the build reports.
  function sizeFit(rows) {
    var beta = huberFit(rows, function (r) { return [1, r.x]; });
    return { intercept: beta[0], slope: beta[1] };
  }
  function maturityFit(rows) {
    var beta = huberFit(rows, function (r) { return [1, r.x, r.a]; });
    return { intercept: beta[0], slope: beta[1], ageCoef: beta[2] };
  }
  function fitCurve() { return sizeFit(DATA.fit_comps); }

  // impliedOf: curve value from TVL, times the fixed growth factor. No age term.
  function curveValueOf(row, fit) {
    return Math.pow(10, fit.intercept + fit.slope * Math.log10(row.tvl_usd / 1e8));
  }
  function growthMultOf(row) {
    var m = DATA.model;
    var raw = row.change_7d === null || row.change_7d === undefined || !isFinite(row.change_7d) ? 0 : row.change_7d;
    var growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, raw));
    return 1 + (growthPct / 100) * m.growth_weight;
  }
  function impliedOf(row) {
    return Math.max(1, Math.min(1e14, Math.round(curveValueOf(row, DATA.curve) * growthMultOf(row))));
  }

  // looBand: hold each comp out, refit without it, record the miss; the band is the
  // 80th percentile of the misses, the verdict haircut their median.
  function looBand() {
    var comps = DATA.fit_comps;
    var errs = [];
    for (var i = 0; i < comps.length; i++) {
      var train = comps.filter(function (c, j) { return j !== i; });
      var fit = sizeFit(train);
      var pred = fit.intercept + fit.slope * comps[i].x + Math.log10(1 + comps[i].g * DATA.model.growth_weight);
      errs.push(Math.abs(pred - comps[i].y));
    }
    errs.sort(function (a, b) { return a - b; });
    function quant(q) { return Math.pow(10, errs[Math.min(errs.length - 1, Math.floor(q * errs.length))]); }
    return { band80: quant(DATA.model.band_quantile), band50: quant(DATA.model.haircut_quantile), n: comps.length };
  }

  // verdictOf: expected gross at the yardstick minus gas and the hurdle. FARM clears
  // the hurdle after the haircut, THIN at the point estimate, SKIP neither.
  function verdictOf(row, opts) {
    var o = opts || { capital: state.capital, share: state.share / 100, hurdle: state.hurdle / 100 };
    var ratio = impliedOf(row) / row.tvl_usd;
    var gross = o.capital * ratio * o.share;
    var costs = row.gas_usd + o.capital * o.hurdle * (row.hold_days / 365);
    var net = gross - costs;
    var netLow = gross / DATA.backtest.band50 - costs;
    return { gross: round2(gross), costs: round2(costs), net: round2(net), netLow: round2(netLow), verdict: netLow > 0 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP' };
  }
  function defaultOpts() {
    return { capital: DATA.model.verdict_capital, share: DATA.model.verdict_share, hurdle: DATA.model.hurdle_rate };
  }
  function leversChanged() {
    return state.capital !== DATA.model.verdict_capital || state.share !== DATA.model.verdict_share * 100 || state.hurdle !== DATA.model.hurdle_rate * 100;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // farmSteps: the same derivation main.ts writes to board.json, step for step.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasFor(chain) {
    var c = chain.toLowerCase();
    if (c.indexOf('ethereum') >= 0) return { first: 'est. $12 of gas for the first transaction', setup: 'est. $12 of gas', weekly: 'est. $4 of gas a week' };
    if (c.indexOf('solana') >= 0) return { first: '~$0.10 of fees for the first transaction', setup: '~$0.10 of fees', weekly: '~$0.10 of fees a week' };
    if (c.indexOf('bitcoin') >= 0) return { first: 'est. $3 of network fees for the first transaction', setup: 'est. $3 of network fees', weekly: 'est. $3 of network fees a week' };
    return { first: 'est. $1 of gas for the first transaction', setup: 'est. $1 of gas', weekly: 'est. under $1 of gas a week' };
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the vault shares.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('interest rate') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('basis') >= 0) return 'Open a $' + capital + ' delta-neutral basis position on ' + name + ' on ' + chain + ' and keep both legs open.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('amm') >= 0) return 'Provide $' + capital + " of liquidity to " + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('stablecoin') >= 0 || c.indexOf('dual-token') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('aggregator') >= 0) return 'Deposit $' + capital + ' of USDC into a ' + name + ' yield vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('payment') >= 0 || c.indexOf('card') >= 0) return 'Deposit $' + capital + ' with ' + name + ' on ' + chain + ' and complete one payment or card spend.';
    if (c.indexOf('governance') >= 0) return 'Stake $' + capital + ' with ' + name + ' on ' + chain + ' and cast one governance vote.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of the ' + name + ' index on ' + chain + ' and hold it.';
    if (c.indexOf('otc') >= 0) return 'Deposit $' + capital + ' with ' + name + ' on ' + chain + ' and complete one OTC trade.';
    if (c.indexOf('btc') >= 0 || c.indexOf('bitcoin') >= 0) return 'Deposit $' + capital + ' of BTC into ' + name + ' on ' + chain + ' and keep the receipt token.';
    if (c.indexOf('cedefi') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the position open.';
    if (c === 'chain') return 'Bridge $' + capital + ' of USDC onto ' + name + " and use its main app once.";
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function weeklyFor(p, chain) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return "Check the vault's allocation on " + chain + ' and add a small top-up when the strategy changes.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('interest rate') >= 0) return 'Open or close one small hedge and check the margin and funding on ' + chain + '.';
    if (c.indexOf('basis') >= 0) return 'Check both legs of the basis position and rebalance a small amount when the spread moves.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Add a small supply top-up and check the borrow health factor on ' + chain + '.';
    if (c.indexOf('prediction') >= 0) return 'Place one more small market position and check the open markets.';
    if (c.indexOf('bridge') >= 0) return 'Bridge a small amount back or use the bridged funds once more in the app.';
    if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('amm') >= 0) return 'Add a small amount of liquidity, or claim and re-stake the pool rewards.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Restake the staking rewards or add a small stake.';
    if (c.indexOf('rwa') >= 0 || c.indexOf('stablecoin') >= 0 || c.indexOf('dual-token') >= 0) return 'Mint a small top-up and confirm the yield or redemption terms still hold.';
    if (c.indexOf('governance') >= 0) return 'Vote on one live proposal, or delegate the stake when no proposal is open.';
    return 'Make one qualifying action, such as a deposit, a swap, a borrow or a vote.';
  }
  function riskFor(p, chain) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('amm') >= 0) return "Check impermanent loss and the pool's ratio before withdrawing, then withdraw a small test amount first.";
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Check the borrow health factor and the borrow rate, then repay or withdraw a small test amount first.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('interest rate') >= 0) return 'Check the liquidation price and funding rate, then close a small part of the hedge first.';
    if (c.indexOf('bridge') >= 0) return 'Check the bridge delay and that the destination wallet holds gas on ' + chain + ', then bridge a small test amount first.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Check the unbonding period and any slashing terms, then unstake a small test amount first.';
    if (c.indexOf('rwa') >= 0) return "Check the issuer's redemption window and any lockup, then redeem a small test amount first.";
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return "Check the vault's withdrawal queue and strategy drift, then redeem a small test amount first.";
    if (c.indexOf('stablecoin') >= 0 || c.indexOf('dual-token') >= 0) return 'Check the peg and the redemption terms, then redeem a small test amount first.';
    if (c.indexOf('prediction') >= 0) return "Check the market's resolution rules, then close a small part of the position first.";
    return 'Check the withdrawal terms and any lockup, then withdraw a small test amount first.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = p.verdict === 'SKIP' ? 10 : capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var weeks = Math.ceil(hold / 7);
    var gas = gasFor(chain);
    var m = DATA.model;
    var netPhrase = p.net_usd < 0 ? 'about -$' + Math.abs(p.net_usd).toFixed(2) : 'about $' + p.net_usd.toFixed(2);
    var steps = [
      { text: 'Week 1: verdict ' + p.verdict + ' - at the $' + m.verdict_capital.toLocaleString('en-US') + ' yardstick this farm nets ' + netPhrase + ' after gas and the ' + Math.round(m.hurdle_rate * 100) + '% hurdle. Use a fresh wallet that holds only the funds you plan to farm, and open ' + p.name + ' only from the link its own docs publish.', cost: gas.first, time: '10 minutes' },
      { text: 'Week 1: ' + actionFor(p, capital, chain), cost: '$' + capital + ' of capital and ' + gas.setup, time: '15 minutes to set up' }
    ];
    if (p.verdict !== 'SKIP') {
      steps.push({ text: 'Week 2: ' + weeklyFor(p, chain) + ' Repeat weekly until the exit rule or the hold below says otherwise.', cost: gas.weekly, time: '10 minutes a week' });
    }
    steps.push(
      { text: "Week 2: open the protocol's points or rewards page, confirm the position is counted, and save a dated screenshot of the balance.", cost: 'no fee to check', time: '10 minutes' },
      { text: 'Weeks 1-' + weeks + ': hold the position for at least ' + hold + ' days with one qualifying action a week, so the activity spans more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before exit: ' + riskFor(p, chain), cost: gas.setup, time: '15 minutes' },
      { text: "Throughout: write the wallet, the dates and every transaction in a farm log, and claim only from the protocol's own link: never pay to claim.", cost: 'nothing but the log', time: '5 minutes' }
    );
    if (p.verdict === 'FARM') {
      steps.splice(4, 0, { text: 'Exit rule: if ' + p.name + "'s TVL falls 15% week over week, or the points page stops counting the position for two weeks in a row, start the exit below instead of adding more capital.", cost: gas.setup, time: '5 minutes a week to check' });
    }
    return steps.map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watch = true;
    if (params.get('tab')) state.tab = params.get('tab') === 'comps' ? 'method' : params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watch) params.set('watch', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.watch && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'net') { av = verdictOf(a).net; bv = verdictOf(b).net; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function verdictCounts() {
    var counts = { FARM: 0, THIN: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { counts[verdictOf(r).verdict]++; });
    return counts;
  }

  function header() {
    return el('div', { class: 'topbar' },
      el('div', { class: 'topbar-inner' },
        el('div', { class: 'brand' },
          el('span', { class: 'mark' }),
          el('span', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('span', { class: 'brand-tag', text: 'pre-token protocols, priced off the market that trades' })
        ),
        el('div', { class: 'top-meta' },
          el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
          el('span', null, 'Model ', el('b', { text: DATA.model_version })),
          el('span', null, el('b', { text: String(DATA.clean_comps) }), ' clean comps')
        )
      )
    );
  }

  function lede() {
    var counts = verdictCounts();
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and not recorded as having a token. The radar lifts the floor and ranks ' + DATA.beyond_size + ' more by the same rule. Each value comes from a size curve, fitted to the tokens that already trade, with an uncertainty band; each verdict nets the farm in dollars after gas and a hurdle. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Beyond the watchlist' }), el('b', { text: String(DATA.beyond_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Set aside as wrapped / staked' }), el('b', { text: String(DATA.excluded_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token comps fitted from' }), el('b', { text: String(DATA.clean_comps) })),
        el('div', { class: 'fact' }, el('span', { text: 'Verdicts at $' + state.capital.toLocaleString('en-US') }), el('b', { text: counts.FARM + ' FARM · ' + counts.THIN + ' THIN · ' + counts.SKIP + ' SKIP' }))
      )
    );
  }

  function leverField(id, label, value, min, max, step, onChange) {
    var input = el('input', { type: 'number', id: id, value: String(value), min: String(min), max: String(max), step: String(step), 'aria-label': label });
    input.addEventListener('input', function () { var v = parseFloat(input.value); if (isFinite(v)) { onChange(v); writeHash(); render(); } });
    return el('div', { class: 'field lever' }, el('label', { for: id, text: label }), input);
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')', selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var watchBtn = el('button', { type: 'button', class: 'toggle', 'aria-pressed': state.watch ? 'true' : 'false', text: 'Watchlist only', onclick: function () { state.watch = !state.watch; writeHash(); render(); } });
    function tabBtn(tab, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; writeHash(); render(); } });
    }
    var countText = state.tab === 'board' ? rows().length + ' of ' + DATA.board_size + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : 'Method and backtest';
    var resetBtn = leversChanged() ? el('button', { type: 'button', class: 'toggle', text: 'Reset yardstick', onclick: function () { state.capital = DATA.model.verdict_capital; state.share = DATA.model.verdict_share * 100; state.hurdle = DATA.model.hurdle_rate * 100; render(); } }) : null;
    return el('div', null,
      el('div', { class: 'controls' },
        el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
        el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
        el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
        el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Scope' }), watchBtn),
        el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'View' }), el('div', { class: 'tabs' }, tabBtn('board', 'Pre-token board'), tabBtn('live', 'Live token'), tabBtn('method', 'Method'))),
        el('span', { class: 'count', text: countText })
      ),
      el('div', { class: 'controls yardstick' },
        el('span', { class: 'lbl', text: 'Verdict yardstick' }),
        leverField('cap', 'Capital ($)', state.capital, 100, 5000, 50, function (v) { state.capital = Math.min(5000, Math.max(100, v)); }),
        leverField('share', 'Farmer share (%)', state.share, 1, 20, 1, function (v) { state.share = Math.min(20, Math.max(1, v)); }),
        leverField('hurdle', 'Hurdle (%/yr)', state.hurdle, 0, 8, 0.5, function (v) { state.hurdle = Math.min(8, Math.max(0, v)); }),
        resetBtn,
        el('span', { class: 'sub', text: 'Verdicts recompute live. The board keeps the default yardstick.' })
      )
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var v = verdictOf(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('div', { class: 'rowline' }, el('b', { text: r.name }), r.watchlist ? el('span', { class: 'badge', text: 'WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'sub', text: 'band ' + fmtUsd(r.band_low_usd) + ' – ' + fmtUsd(r.band_high_usd) })
        )),
        el('td', null, el('div', { class: 'verdict' },
          el('span', { class: 'vbadge v-' + v.verdict.toLowerCase(), text: v.verdict }),
          el('span', { class: 'sub num', text: fmtMoney(v.net) })
        )),
        el('td', null, el('span', { class: 'status', text: 'not recorded' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown, verdict arithmetic and farm plan. "Not recorded" means the snapshot does not record the protocol as having a token. The band is the 80% interval from the model\'s own misses; the verdict nets dollars at the yardstick above.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            sortHeader('net', 'Verdict'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'status live', text: 'already trades' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio === null ? 'n/a' : fmtMult(r.ratio) })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Live token: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking; the curve is fitted from the wider set of clean live-token comps in the Method view.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }))),
          tbody
        )
      )
    );
  }

  function backtestRow(namePart) {
    var found = null;
    DATA.backtest.rows.forEach(function (r) { if (r.name.indexOf(namePart) >= 0) found = r; });
    return found;
  }

  function methodPanel() {
    var m = DATA.model;
    var b = DATA.backtest;
    var refit = fitCurve();
    var diag = maturityFit(DATA.fit_comps);
    var dg = b.diagnostic;
    var band = looBand();
    var coefOk = Math.abs(refit.intercept - DATA.curve.intercept) < 1e-9 && Math.abs(refit.slope - DATA.curve.slope) < 1e-9;
    var diagOk = Math.abs(diag.intercept - dg.log1p.intercept) < 1e-9 && Math.abs(diag.slope - dg.log1p.slope) < 1e-9 && Math.abs(diag.ageCoef - dg.log1p.ageCoef) < 1e-9;
    var bandOk = Math.abs(band.band80 - b.band80) < 1e-4 && Math.abs(band.band50 - b.band50) < 1e-4;
    var tbody = el('tbody');
    b.rows.forEach(function (r) {
      var isFinal = r.name.indexOf('this radar') >= 0;
      tbody.appendChild(el('tr', { class: isFinal ? 'final-row' : null },
        el('td', null, el('b', { text: r.name })),
        el('td', { class: 'num', text: 'x' + r.loo_miss.toFixed(2) }),
        el('td', { class: 'num', text: (r.loo_within3 * 100).toFixed(0) + '%' }),
        el('td', { class: 'num', text: fmtMiss(r.ts_miss) }),
        el('td', { class: 'num', text: r.ts_within3 === null ? 'n/a' : (r.ts_within3 * 100).toFixed(0) + '%' })
      ));
    });
    var v1 = backtestRow('(v1)');
    var fin = backtestRow('this radar');
    var gro = backtestRow('fitted growth');
    var fam = backtestRow('category offsets');
    var ab = b.ablation;
    var counts = verdictCounts();
    var atbody = el('tbody');
    ab.forEach(function (r) {
      atbody.appendChild(el('tr', null,
        el('td', null, el('b', { text: r.name })),
        el('td', { class: 'num', text: fmtMiss(r.loo_miss) }),
        el('td', { class: 'num', text: fmtMiss(r.loo_median) }),
        el('td', { class: 'num', text: fmtMiss(r.ts70_miss) }),
        el('td', { class: 'num', text: fmtMiss(r.ts50_miss) })
      ));
    });
    return el('div', null,
      el('section', { class: 'panel model' },
        el('h2', { text: 'The size curve' }),
        el('p', { class: 'sub', text: 'Market caps grow slower than TVL: a protocol ten times larger is not worth ten times more. The radar fits that law from the ' + DATA.clean_comps + ' clean comps — live-token protocols whose market-cap/TVL ratio lies between ' + m.ratio_min + ' and ' + m.ratio_max + ' — by Huber-robust regression, so one runaway token cannot drag the line. No name is special-cased and no coefficient is carried over: the fit runs again on whatever snapshot it is given.' }),
        el('div', { class: 'formula', text: 'log10(mcap) = ' + DATA.curve.intercept.toFixed(4) + ' + ' + DATA.curve.slope.toFixed(4) + ' x log10(TVL / $100M)' }),
        el('div', { class: 'formula', text: 'implied = round( size-curve value x growth )' }),
        el('p', { class: 'sub', text: 'The growth factor is a fixed prior at weight ' + m.growth_weight + ', stated here, not a fitted coefficient: the fitted growth weight is near zero and the factor is out-of-sample neutral, so it is kept only so seven-day momentum moves values.' }),
        el('p', { class: 'sub', text: 'Age was fitted, tested and rejected: adding log1p(age in years) to the regression fits a weight of d = ' + dg.log1p.ageCoef.toFixed(4) + ' (had it been applied, age factors would run ' + dg.factor_min.toFixed(3) + 'x to ' + dg.factor_max.toFixed(3) + 'x) but misses worse on every protocol. A paired bootstrap of ' + dg.bootstrap_log1p.resamples + ' resamples puts its mean |error| change at ' + (dg.bootstrap_log1p.diff_mean >= 0 ? '+' : '') + dg.bootstrap_log1p.diff_mean.toFixed(4) + ', 95% CI [' + dg.bootstrap_log1p.ci_lo.toFixed(4) + ', ' + dg.bootstrap_log1p.ci_hi.toFixed(4) + '] — worse, significantly. A saturating maturity form, horizon ' + dg.saturating.tau + ' days chosen on training rows only, is likewise worse: ' + (dg.bootstrap_saturating.diff_mean >= 0 ? '+' : '') + dg.bootstrap_saturating.diff_mean.toFixed(4) + ' [' + dg.bootstrap_saturating.ci_lo.toFixed(4) + ', ' + dg.bootstrap_saturating.ci_hi.toFixed(4) + ']. So no age term is in the price. The splits train on the oldest listings only, where age barely varies, so an age coefficient is barely identified there; the bootstrap on leave-one-out settles the question.' }),
        el('p', { class: 'check', text: 'Refit check: this page refits the curve from the comps it carries and gets intercept ' + refit.intercept.toFixed(4) + ', slope ' + refit.slope.toFixed(4) + ' — ' + (coefOk ? 'the same coefficients the board was built with.' : 'DIFFERENT from the board: the data would be stale.') + ' It also refits the diagnostic age fit and gets age weight ' + diag.ageCoef.toFixed(4) + ' — ' + (diagOk ? 'the same as the build reports.' : 'DIFFERENT from the build.') + ' The page rebuilds the band the same way and gets x' + band.band80.toFixed(2) + ' / x' + band.band50.toFixed(2) + ' — ' + (bandOk ? 'the same band.' : 'DIFFERENT from the board.') })
      ),
      el('div', { class: 'panel', style: 'margin-top:16px' },
        el('div', { class: 'table-wrap' },
          el('table', null,
            el('caption', { text: 'Ablation: each row adds one term, measured out of sample on the ' + b.loo_n + ' clean comps under three protocols: leave-one-out, a 70/30 time-split (fit ' + b.ts_train_n + ' oldest, test ' + b.ts_test_n + ' newest) and a 50/50 time-split (fit ' + b.ts50_train_n + ', test ' + b.ts50_test_n + '). The saturating row\'s horizon is chosen on training rows only. Miss is the geometric mean fold-error; lower is better.' }),
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Specification' }), el('th', { scope: 'col', text: 'LOO miss' }), el('th', { scope: 'col', text: 'LOO median' }), el('th', { scope: 'col', text: 'TS70 miss' }), el('th', { scope: 'col', text: 'TS50 miss' }))),
            atbody
          )
        )
      ),
      el('div', { class: 'panel', style: 'margin-top:16px' },
        el('div', { class: 'table-wrap' },
          el('table', null,
            el('caption', { text: 'Out-of-sample misses on the clean comps. Leave-one-out holds each comp out in turn and refits without it; the 70/30 time-split fits the ' + b.ts_train_n + ' oldest listings and tests the ' + b.ts_test_n + ' newest (cutoff ' + (b.ts_cutoff || 'no dated comps') + '; ' + b.null_date_excluded + ' comps without a listing date are excluded from the split only). Miss is the geometric mean fold-error; lower is better.' }),
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Specification' }), el('th', { scope: 'col', text: 'LOO miss' }), el('th', { scope: 'col', text: 'LOO within 3x' }), el('th', { scope: 'col', text: 'Time-split miss' }), el('th', { scope: 'col', text: 'Time-split within 3x' }))),
            tbody
          )
        )
      ),
      el('section', { class: 'panel model', style: 'margin-top:16px' },
        el('h2', { text: 'What was tested and left out' }),
        el('p', { class: 'sub', text: 'The curve beats the pooled-median method out of sample: leave-one-out x' + v1.loo_miss.toFixed(2) + ' to x' + fin.loo_miss.toFixed(2) + ', and on the time-split too (' + fmtMiss(v1.ts_miss) + ' to ' + fmtMiss(fin.ts_miss) + '). Every addition below was tested one at a time against the curve and adopted only on a clear out-of-sample gain. Later passes tested blends with the median method, sibling counts, shrunken category offsets, a piecewise curve, a restricted comp universe, other loss functions, recency weights, chain indicators and name signals the same way. None cleared the bar, so none is in the price:' }),
        el('div', { class: 'method' },
          el('div', null, el('b', { text: 'Category offsets' }), el('span', { text: 'LOO x' + fam.loo_miss.toFixed(2) + ' but time-split ' + fmtMiss(fam.ts_miss) + ' — the leave-one-out edge does not survive a paired comparison, the time-split is worse, and the offsets reshuffle the board without evidence.' })),
          el('div', null, el('b', { text: 'Fitted growth' }), el('span', { text: 'The fitted growth weight is near zero and the fitted-growth row misses worse out of sample (LOO x' + gro.loo_miss.toFixed(2) + '). Growth stays a fixed prior, stated above.' })),
          el('div', null, el('b', { text: 'Age forms' }), el('span', { text: 'The ablation above carries both fitted age forms; both lose on every protocol, significantly on leave-one-out. Age sets each farm plan\'s hold window, never the price.' })),
          el('div', null, el('b', { text: 'Chains, slopes, curvature' }), el('span', { text: 'Chain counts, per-category slopes, a growth-by-size interaction and a quadratic size term all miss worse out of sample. The table above carries their numbers.' }))
        ),
        el('h2', { text: 'The band and the verdict', style: 'margin-top:20px' }),
        el('p', { class: 'sub', text: 'The 80% band is x' + b.band80.toFixed(2) + ': the 80th percentile of the final model\'s own leave-one-out misses, so four out of five traded comps land inside it. The verdict haircut is x' + b.band50.toFixed(2) + ', the median miss. Bands this wide are the honest state of launch pricing.' }),
        el('p', { class: 'sub', text: 'The verdict nets dollars at the yardstick: capital $' + state.capital.toLocaleString('en-US') + ', a ' + state.share + '% farmer share of implied value paid pro-rata to TVL, gas for the first chain over the hold (60 days when under 6 months old, 45 when under a year, 30 otherwise), and a ' + state.hurdle + '% yearly hurdle. Gross minus costs is the net; FARM clears the hurdle even after the typical-miss haircut, THIN clears it at the point estimate, SKIP clears neither. At the current levers: ' + counts.FARM + ' FARM, ' + counts.THIN + ' THIN, ' + counts.SKIP + ' SKIP. Move the levers to test your own size — the board, the counts and the detail views recompute. Gas figures are estimates: the snapshot carries no gas data, so no gas number is derived from it; only the farm plan\'s position-size tier comes from the snapshot, from each protocol\'s TVL.' }),
        el('p', { class: 'sub', text: 'Missing data: a protocol with no listing date gets a neutral age feature and shows its age as unknown; a null seven-day change scores as zero growth; a null category gets the generic farm action. The program never crashes on a null.' }),
        el('p', { class: 'sub', text: DATA.excluded_size + ' protocols not recorded as having a token are set aside by the watchlist rule itself: excluded categories (bridges, liquid staking, exchanges), versioned pool names, wrapped or staked names, and exchange-named products. They are not launches waiting to happen, so the radar does not rank them.' })
      )
    );
  }

  function readingPanel() {
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How to read this board' }),
      el('p', { class: 'sub', text: 'Every value comes from one size curve, fitted to the tokens that already trade — the same code ranks a future snapshot, and no protocol name is special-cased. The band beside each value is the model\'s own uncertainty interval; the verdict nets the farm in dollars after gas and a hurdle. The Method view carries the fitted curve, the backtests, what was tested and left out, and the verdict assumptions in full.' }),
      el('div', { class: 'method' },
        el('div', null, el('b', { text: 'Priced off the traded market' }), el('span', { text: 'The curve is fitted from live-token comps in this snapshot, not from a multiple carried over or a name list.' })),
        el('div', null, el('b', { text: 'Bands, not false precision' }), el('span', { text: 'Launch pricing is uncertain by multiples. The band says how uncertain, from the model\'s own misses.' })),
        el('div', null, el('b', { text: 'Verdicts in dollars' }), el('span', { text: 'A verdict is expected net dollars after gas and the hurdle — move the yardstick levers to test your own size.' }))
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('span', { text: 'Source: ' + DATA.source }),
      el('span', { text: 'The snapshot records what DefiLlama carried on ' + DATA.as_of + '; it is not proof about any token a protocol may have. Implied values and verdicts are this radar\'s own model on stated assumptions, never a price or advice, and farm plans describe on-chain actions that carry smart-contract and market risk.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recomputed = impliedOf(row);
    var m = DATA.model;
    var growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthText = row.change_7d === null ? 'n/a (treated as 0%)' : fmtPct(row.change_7d) + (growthPct !== row.change_7d ? ' (clamped to ' + fmtPct(growthPct) + ')' : '');
    var v = verdictOf(row);
    var vDefault = verdictOf(row, defaultOpts());
    var hurdleCost = round2(state.capital * (state.hurdle / 100) * (row.hold_days / 365));
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · on the watchlist' : ' · beyond the watchlist') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'date unknown') + ' · not recorded as having a token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Size-curve value' }), el('b', { class: 'num', text: fmtUsd(row.curve_value_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: growthText })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age' }), el('b', { class: 'num', text: fmtAge(row.age_days) + (row.listed_at ? '' : ' (no listing date: age unknown)') })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value = curve x growth' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: '80% band' }), el('b', { class: 'num', text: fmtUsd(row.band_low_usd) + ' – ' + fmtUsd(row.band_high_usd) }))
      ),
      el('p', { class: 'check', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' See the Method view. This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Verdict' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Yardstick' }), el('b', { class: 'num', text: '$' + state.capital.toLocaleString('en-US') + ' for ' + row.hold_days + ' days, ' + state.share + '% farmer share' })),
        el('div', null, el('span', { text: 'Expected gross' }), el('b', { class: 'num', text: fmtMoney(v.gross) })),
        el('div', null, el('span', { text: 'Gas on ' + chainOf(row) + ' (est.)' }), el('b', { class: 'num', text: fmtMoney(row.gas_usd) })),
        el('div', null, el('span', { text: 'Hurdle cost (' + state.hurdle + '%/yr)' }), el('b', { class: 'num', text: fmtMoney(hurdleCost) })),
        el('div', { class: 'total' }, el('span', { text: 'Net' }), el('b', { class: 'num', text: fmtMoney(v.net) })),
        el('div', null, el('span', { text: 'Net after typical-miss haircut' }), el('b', { class: 'num', text: fmtMoney(v.netLow) })),
        el('div', { class: 'total' }, el('span', { text: 'Verdict' }), el('b', { class: 'num' }, el('span', { class: 'vbadge v-' + v.verdict.toLowerCase(), text: v.verdict })))
      ),
      el('p', { class: 'check', text: (v.verdict === 'FARM' ? 'FARM: the farm clears the hurdle even after the typical-miss haircut. ' : v.verdict === 'THIN' ? 'THIN: the farm clears the hurdle at the point estimate, but not after the haircut — the margin is the model\'s own uncertainty. ' : 'SKIP: the farm does not clear the hurdle at the point estimate. The plan below farms a $10 test position only. ') + (leversChanged() ? 'The levers differ from the board defaults, where this row is ' + vDefault.verdict + ' at ' + fmtMoney(vDefault.net) + '.' : 'The board carries this verdict at the default yardstick.') })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    app.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.tab === 'board') shell.appendChild(boardTable());
    else if (state.tab === 'live') shell.appendChild(liveTable());
    else shell.appendChild(methodPanel());
    if (state.tab === 'board') shell.appendChild(readingPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  // Verification hook for headless checks: the page's own model functions.
  window.__RADAR_CHECK = { impliedOf: impliedOf, farmSteps: farmSteps, verdictOf: verdictOf, fitCurve: fitCurve, maturityFit: maturityFit, looBand: looBand, ageDays: ageDays, data: DATA };

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; state.tab = 'board'; state.selected = null;
    readHash();
    if (dialog.open && !state.selected) dialog.close();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();

