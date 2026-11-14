// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, its filters, a per-protocol detail drawer with the
// model's own inputs and the protocol's farm plan, the live-token view and the
// benchmarks the prices come from. No network: every byte it shows is in data.js.
//
// The model lives here too, in the same arithmetic main.ts runs: pooledMultiple prices
// a category off its live-token comps, impliedOf recomputes a row from the snapshot
// figures and checks the number board.json carries, and farmSteps derives the plan
// from the row's category, chains, TVL and age. No protocol name is special-cased.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watch: false, tab: 'board', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
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

  // The benchmarks, by category name, as main.ts computed them from the clean comps.
  var compByCategory = {};
  DATA.comps.forEach(function (c) { compByCategory[c.category] = c; });

  /** A whole day count from listed_at to as_of, clamped at zero; null when either date is absent or bad. */
  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / 86400000));
  }

  // pooledMultiple: a category's pricing multiple. Its comps' median market-cap/TVL
  // ratio, pooled toward the global median with pool_weight pseudo-observations, so a
  // category with one comp cannot set the price; a category with no clean comp prices
  // at the global median. The same function main.ts runs, over the same benchmarks.
  function pooledMultiple(category) {
    var row = category === null || category === undefined ? undefined : compByCategory[category];
    if (row === undefined) return { multiple: DATA.global_median, n: 0, median: null, source: 'global' };
    return { multiple: row.pooled, n: row.n, median: row.median, source: 'pooled' };
  }

  // impliedOf: the model in one function. The page recomputes a row from the snapshot
  // figures and checks the number board.json carries, so the page's code and the
  // board's data are visibly the same arithmetic.
  function impliedOf(row) {
    var m = DATA.model;
    var age = ageDays(DATA.as_of, row.listed_at);
    var multiple = pooledMultiple(row.category).multiple;
    var rawGrowth = row.change_7d === null || row.change_7d === undefined || !isFinite(row.change_7d) ? 0 : row.change_7d;
    var growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, rawGrowth));
    var growthMult = 1 + (growthPct / 100) * m.growth_weight;
    var ageForModel = age === null ? m.unknown_age_days : age;
    var maturityMult = m.maturity_floor + (Math.min(Math.max(ageForModel, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturityMult));
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

  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL and age decide the action, the capital, the hold and every cost and time.
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
    if (c.indexOf('ethereum') >= 0) return { first: 'about $12 of gas for the first transaction', setup: 'about $12 of gas', weekly: 'about $4 of gas a week' };
    if (c.indexOf('solana') >= 0) return { first: 'under $0.10 of fees for the first transaction', setup: 'under $0.10 of fees', weekly: 'under $0.10 of fees a week' };
    if (c.indexOf('bitcoin') >= 0) return { first: 'about $3 of network fees for the first transaction', setup: 'about $3 of network fees', weekly: 'about $3 of network fees a week' };
    return { first: 'about $1 of gas for the first transaction', setup: 'about $1 of gas', weekly: 'under $1 of gas a week' };
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
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and open ' + p.name + ' only from the link its own docs publish.', cost: gas.first, time: '10 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and ' + gas.setup, time: '15 minutes to set up' },
      { text: weeklyFor(p, chain), cost: gas.weekly, time: '10 minutes a week' },
      { text: "Open the protocol's points or rewards page, confirm the position is counted, and save a dated screenshot of the balance.", cost: 'no fee to check', time: '10 minutes' },
      { text: 'Hold the position for at least ' + hold + ' days with one qualifying action a week, so the activity spans more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: riskFor(p, chain), cost: gas.setup, time: '15 minutes' },
      { text: "Write the wallet, the dates and every transaction in a farm log, and claim only from the protocol's own link: never pay to claim.", cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
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
    if (params.get('tab')) state.tab = params.get('tab');
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
      else if (key === 'multiple') { av = a.multiple; bv = b.multiple; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
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
    var m = DATA.model;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The radar lifts the floor and ranks ' + DATA.beyond_size + ' more by the same rule. Each value is priced off live-token comps in its own category, never off a name. Implied value is a model, not a promise.' }),
        el('div', { class: 'formula', text: 'implied = TVL x pooled multiple x (1 + clamp(7d growth, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x maturity(age)   ·   pooled multiple = (n x category median + ' + m.pool_weight + ' x global median) / (n + ' + m.pool_weight + ')' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Beyond the watchlist' }), el('b', { text: String(DATA.beyond_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Set aside as wrapped / staked' }), el('b', { text: String(DATA.excluded_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token comps priced from' }), el('b', { text: String(DATA.clean_comps) })),
        el('div', { class: 'fact' }, el('span', { text: 'Global median mcap / TVL' }), el('b', { text: fmtMult(DATA.global_median) }))
      )
    );
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
    var countText = state.tab === 'board' ? rows().length + ' of ' + DATA.board_size + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : DATA.comps.length + ' category benchmarks';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Scope' }), watchBtn),
      el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'View' }), el('div', { class: 'tabs' }, tabBtn('board', 'Pre-token board'), tabBtn('live', 'Live token'), tabBtn('comps', 'Benchmarks'))),
      el('span', { class: 'count', text: countText })
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
        el('td', null, el('div', { class: 'mult' },
          el('span', { class: 'num', text: fmtMult(r.multiple) }),
          el('span', { class: 'sub', text: r.multiple_source === 'global' ? 'global median' : 'n=' + r.comp_n + ' comps' })
        )),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan. "No token" means the snapshot records no token, never that the protocol has none.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'Multiple'),
            sortHeader('implied', 'Implied value'),
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
          el('caption', { text: 'Live token: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking and serve as the comps that price it.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }))),
          tbody
        )
      )
    );
  }

  function compsPanel() {
    var boardByCat = {};
    DATA.rows.forEach(function (r) { var k = r.category || 'Other'; boardByCat[k] = (boardByCat[k] || 0) + 1; });
    var list = DATA.comps.slice().sort(function (a, b) { return b.n - a.n || (a.category < b.category ? -1 : 1); });
    var tbody = el('tbody');
    list.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('b', { text: c.category })),
        el('td', { class: 'num', text: String(c.n) }),
        el('td', { class: 'num', text: fmtMult(c.median) }),
        el('td', { class: 'num', text: fmtMult(c.pooled) }),
        el('td', { class: 'num', text: String(boardByCat[c.category] || 0) })
      ));
    });
    return el('div', null,
      el('section', { class: 'panel model' },
        el('h2', { text: 'How the prices are benchmarked' }),
        el('p', { class: 'sub', text: 'The comps are the snapshot\'s live-token protocols whose market-cap/TVL ratio lies between ' + DATA.model.ratio_min + ' and ' + DATA.model.ratio_max + ': ' + DATA.clean_comps + ' protocols. Ratios outside that band (near-zero market caps and runaway multiples) are dropped before any median is taken, so one broken record cannot set a price.' }),
        el('p', { class: 'sub', text: 'Each category\'s multiple is its comps\' median ratio pooled toward the global median of ' + fmtMult(DATA.global_median) + ' with ' + DATA.model.pool_weight + ' pseudo-observations. A category with many comps prices near its own median; a category with one comp, or none, prices near the global median. Categories with no clean comp at all use the global median outright.' }),
        el('p', { class: 'sub', text: DATA.excluded_size + ' protocols that record no token are set aside by the watchlist rule itself: excluded categories (bridges, liquid staking, exchanges), versioned pool names, wrapped or staked names, and exchange-named products. They are not launches waiting to happen, so the radar does not rank them.' })
      ),
      el('div', { class: 'panel', style: 'margin-top:16px' },
        el('div', { class: 'table-wrap' },
          el('table', null,
            el('caption', { text: 'One benchmark per category: clean comps, their median market-cap/TVL ratio, and the pooled multiple the board prices with.' }),
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Clean comps' }), el('th', { scope: 'col', text: 'Median mcap / TVL' }), el('th', { scope: 'col', text: 'Pooled multiple' }), el('th', { scope: 'col', text: 'Board rows' }))),
            tbody
          )
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked: the same code ranks a future snapshot.' }),
      el('div', { class: 'formula', text: 'implied = round( tvl_usd x pooledMultiple(category) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )' }),
      el('div', { class: 'method' },
        el('div', null, el('b', { text: 'Priced off comps' }), el('span', { text: 'The multiple comes from live tokens in the same category: ' + DATA.clean_comps + ' clean comps, median ratios pooled toward the global ' + fmtMult(DATA.global_median) + '.' })),
        el('div', null, el('b', { text: 'Growth and age' }), el('span', { text: 'Seven-day TVL growth moves the value up or down, clamped so one spike cannot dominate; age is the time listed with no token, capped at ' + m.maturity_days + ' days.' })),
        el('div', null, el('b', { text: 'Separated by status' }), el('span', { text: 'Protocols whose token already trades are never ranked. They appear apart, with the market cap the market itself set.' }))
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('span', { text: 'Source: ' + DATA.source }),
      el('span', { text: 'The snapshot records what DefiLlama carried on ' + DATA.as_of + '; it is not proof a protocol has no token. Implied values are this radar\'s own model, never a price, and farm plans describe on-chain actions that carry smart-contract and market risk.' })
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
    var bench = pooledMultiple(row.category);
    var recomputed = impliedOf(row);
    var m = DATA.model;
    var growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var age = ageDays(DATA.as_of, row.listed_at);
    var ageForModel = age === null ? m.unknown_age_days : age;
    var maturity = m.maturity_floor + (Math.min(Math.max(ageForModel, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    var benchText = bench.source === 'global'
      ? 'global median ' + fmtMult(DATA.global_median) + ' (no comp)'
      : fmtMult(bench.median) + ' median, n=' + bench.n + ', pooled';
    var growthText = row.change_7d === null ? 'n/a (treated as 0%)' : fmtPct(row.change_7d) + (growthPct !== row.change_7d ? ' (clamped to ' + fmtPct(growthPct) + ')' : '');
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · on the watchlist' : ' · beyond the watchlist') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'date unknown') + ' · records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category benchmark' }), el('b', { class: 'num', text: benchText })),
        el('div', null, el('span', { text: 'Pooled multiple' }), el('b', { class: 'num', text: fmtMult(row.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: growthText })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'check', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. ' + (bench.source === 'global' ? 'This category has no clean comp, so the global median prices it. ' : 'The category median is pooled toward the global median with ' + m.pool_weight + ' pseudo-observations. ') + 'The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' Maturity here is ' + maturity.toFixed(4) + '. This is an estimate, not a price.' })
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
    else shell.appendChild(compsPanel());
    if (state.tab === 'board') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  // A verification hook for headless checks: the page's own model functions, run
  // against the same data the board was built from.
  window.__RADAR_CHECK = { impliedOf: impliedOf, farmSteps: farmSteps, pooledMultiple: pooledMultiple, ageDays: ageDays, data: DATA };

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
