// The token radar's model, version 4: one snapshot of the protocol universe in, one
// ranked board out.
//
// The board ranks every protocol the snapshot's own watchlist rule keeps when the $50M
// floor is lifted: it is not recorded as having a token, and it is not a wrapped,
// staked or bridged product, a versioned pool or an exchange product. On this snapshot
// that is 198 rows: the 40 watchlist protocols plus 158 beyond it. Nothing is
// hand-picked and no protocol name is ever special-cased: the same rule scores every
// row, so a future snapshot with protocols that do not exist yet is ranked by the same
// code.
//
// Implied value is priced off the market that already trades, by a size curve fitted
// from this snapshot's own clean comps — the live-token protocols whose market-cap/TVL
// ratio lies in [0.001, 10] (119 of 144 on this snapshot) — plus a fitted age term.
// The regression is Huber-robust, so one runaway token cannot drag the line:
//
//   log10(mcap) = a + b x log10(tvl_usd / $100M) + d x log1p(age_years)
//   implied     = max(1, round(10^(a + b x) x growth x ageFactor))
//
// where age_years is the listing age in years at the snapshot's frozen as_of date, and
// ageFactor is 10^(d x log1p(age_years)), capped to [0.5, 2]. All three coefficients
// are fitted at run time from the same 119 comps; no age weight is chosen by hand.
// A comp or row with no listing date is scored at one year, the convention the v1
// maturity term used. The age term is a maturity proxy, stated honestly: a live
// comp's age is the age of a protocol that already launched, while a pre-token row's
// age is time spent running without a token, so the term can only proxy maturity,
// never measure launch readiness directly.
//
// The growth factor is a fixed prior at weight 0.5, stated here, not a fitted
// coefficient: the fitted growth weight is ~0 and the factor is out-of-sample neutral,
// so it is kept only so seven-day momentum moves values. The age term's own ablation
// is measured in the backtest this file runs at build time and the dashboard's Method
// view reports: size-only, then +growth, then +age, with leave-one-out miss, median
// miss and within-3x share. On this snapshot the fitted age weight is near zero and
// the age step adds no leave-one-out gain; it is kept at its fitted weight, capped,
// so the equation answers the age question from the data instead of omitting it.
// Everything else the data was asked about and rejected — category offsets, fitted
// growth, chain counts, per-category slopes, a quadratic size term — is measured in
// the same backtest. The uncertainty band is the 80th percentile of the final
// model's own leave-one-out misses, recomputed from the snapshot at run time; the
// verdict haircut is its median miss.
//
// Each row also carries a verdict in dollars: the expected net of farming it at a
// $1,000 yardstick, after gas and a 4% hurdle, against the value the curve implies.
// FARM clears the hurdle even after the typical-miss haircut, THIN clears it at the
// point estimate, SKIP does not clear it. Farm plans are derived from each row's
// category, chains, TVL, age and verdict, never from a hand-written list of names.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  ratio_min: number;
  ratio_max: number;
  huber_c: number;
  huber_iters: number;
  band_quantile: number;
  haircut_quantile: number;
  verdict_capital: number;
  verdict_share: number;
  hurdle_rate: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  ratio_min: 0.001,
  ratio_max: 10,
  huber_c: 1.345,
  huber_iters: 12,
  band_quantile: 0.8,
  haircut_quantile: 0.5,
  verdict_capital: 1000,
  verdict_share: 0.1,
  hurdle_rate: 0.04,
};

/** The v1 model's frozen parameters, used only to score v1 in the backtest comparison. */
const V1 = { pool_weight: 5, growth_weight: 0.5, growth_floor: -60, growth_cap: 120, maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095, unknown_age_days: 365 };

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-4-age';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Categories the watchlist rule refuses: wrapped, staked, bridged and exchange products. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names the watchlist rule refuses at the start of a protocol's name. */
export const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A fitted size-plus-age curve: log10(mcap) = intercept + slope x log10(tvl / $100M) + ageCoef x log1p(age_years). */
export interface CurveFit {
  intercept: number;
  slope: number;
  ageCoef: number;
}

/** One backtest row: a specification's out-of-sample misses, measured at build time. */
export interface BacktestRow {
  name: string;
  loo_miss: number;
  loo_within3: number;
  ts_miss: number;
  ts_within3: number;
}

/** One ablation row: a nested specification's out-of-sample misses, size-only -> +growth -> +age. */
export interface AblationRow {
  name: string;
  loo_miss: number;
  loo_median: number;
  loo_within3: number;
  ts_miss: number;
  ts_median: number;
  ts_within3: number;
}

/** The backtest: every specification measured, the age ablation, plus the band the misses calibrate. */
export interface BacktestData {
  rows: BacktestRow[];
  ablation: AblationRow[];
  loo_n: number;
  ts_train_n: number;
  ts_test_n: number;
  ts_cutoff: string;
  null_date_excluded: number;
  band80: number;
  band50: number;
  loo_sd: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A verdict: FARM clears the hurdle after the haircut, THIN at the point estimate, SKIP neither. */
export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  verdict: Verdict;
  net_usd: number;
  model: {
    curve_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    gross_usd: number;
    cost_usd: number;
    hold_days: number;
    gas_usd: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  verdict: Verdict;
  net_usd: number;
  curve_value_usd: number;
  growth_multiplier: number;
  age_multiplier: number;
  gross_usd: number;
  cost_usd: number;
  hold_days: number;
  gas_usd: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** One clean comp, reduced to the numbers the page's refit needs: size, value, growth, age. */
export interface FitComp {
  slug: string;
  x: number;
  y: number;
  g: number;
  a: number;
}

/** Everything the dashboard needs: the board, the live set, the curve, and the backtest. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  beyond_size: number;
  live_size: number;
  excluded_size: number;
  clean_comps: number;
  curve: CurveFit;
  backtest: BacktestData;
  fit_comps: FitComp[];
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A quantile of a sorted list, by the floor(q x n) order statistic. */
function quantileSorted(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Round to cents. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Days with no listing date score as one year: the convention the v1 maturity term used. */
export const UNKNOWN_AGE_DAYS = 365;

/** The regression's age feature: log1p of age in years, saturating so old listings cannot dominate. */
export function ageFeature(age: number | null): number {
  return Math.log1p((age ?? UNKNOWN_AGE_DAYS) / 365);
}

/** The fitted age multiplier: 10^(ageCoef x age feature), capped to [0.5, 2] as a guard. */
export function ageFactor(age: number | null, ageCoef: number): number {
  const f = 10 ** (ageCoef * ageFeature(age));
  return Math.min(2, Math.max(0.5, f));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking anywhere in a name, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is not recorded as having a token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is set aside by the watchlist rule, or null when it is rankable. */
export function exclusionReason(p: SnapshotProtocol): 'category' | 'version' | 'word' | 'exchange' | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'category';
  if (VERSIONED.test(p.name)) return 'version';
  if (WRAPPED_WORD.test(p.name)) return 'word';
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return 'exchange';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and kept by the watchlist rule. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && exclusionReason(p) === null;
}

/** The clean comps: live-token protocols whose market-cap/TVL ratio is sane enough to price from. */
export function cleanComps(snapshot: Snapshot, model: ModelConstants = MODEL): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.tvl_usd > 0 && p.mcap_usd / p.tvl_usd >= model.ratio_min && p.mcap_usd / p.tvl_usd <= model.ratio_max,
  );
}

// ---------------------------------------------------------------------------
// The fit: ordinary least squares by Gaussian elimination, then Huber reweighting.
// The dashboard's fitCurve is the same arithmetic, so the page refits the curve from
// the comps in data.js and checks the coefficients this program used.
// ---------------------------------------------------------------------------

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0, row = 0; col < n && row < n; col++, row++) {
    let piv = row;
    for (let r = row + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[row], M[piv]] = [M[piv]!, M[row]!];
    if (Math.abs(M[row]![col]!) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === row) continue;
      const f = M[r]![col]! / M[row]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[row]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Least squares for y ~ X, with optional weights. */
function ols(X: number[][], y: number[], weights?: number[]): number[] {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => Array(k).fill(0));
  const b = Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const w = weights ? weights[i]! : 1;
    for (let r = 0; r < k; r++) {
      b[r] += w * X[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) A[r]![c]! += w * X[i]![r]! * X[i]![c]!;
    }
  }
  return solveLinear(A, b);
}

const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i]!, 0);

/** Huber-IRLS fit of y ~ columns: outliers are downweighted, never dropped. */
function huberFit<T>(rows: T[], cols: (r: T) => number[], yOf: (r: T) => number, model: ModelConstants, robust: boolean): number[] {
  const X = rows.map(cols);
  const y = rows.map(yOf);
  let beta = ols(X, y);
  if (!robust) return beta;
  for (let it = 0; it < model.huber_iters; it++) {
    const res = rows.map((_, i) => y[i]! - dot(X[i]!, beta));
    const med = median(res);
    const mad = median(res.map((v) => Math.abs(v - med))) || 1e-6;
    const s = 1.4826 * mad;
    const w = res.map((v) => Math.min(1, (model.huber_c * s) / Math.max(Math.abs(v), 1e-9)));
    const next = ols(X, y, w);
    if (next.every((v, i) => Math.abs(v - beta[i]!) < 1e-10)) {
      beta = next;
      break;
    }
    beta = next;
  }
  return beta;
}

/** One comp's regression features, from its own snapshot record. */
interface CompFeatures {
  slug: string;
  category: string;
  tvl: number;
  mcap: number;
  x: number;
  y: number;
  g: number;
  z: number;
  logChains: number;
  listedAt: string | null;
  ageKnown: boolean;
  growthMult: number;
  maturity: number;
}

function compFeatures(p: SnapshotProtocol, asOf: string, model: ModelConstants): CompFeatures {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const ageForModel = age ?? V1.unknown_age_days;
  return {
    slug: p.slug,
    category: p.category ?? 'Uncategorized',
    tvl: p.tvl_usd,
    mcap: p.mcap_usd!,
    x: Math.log10(p.tvl_usd / 1e8),
    y: Math.log10(p.mcap_usd!),
    g: growthPct / 100,
    z: ageFeature(age),
    logChains: Math.log10(Math.max(1, p.chains.length)),
    listedAt: p.listed_at,
    ageKnown: age !== null,
    growthMult: 1 + (growthPct / 100) * V1.growth_weight,
    maturity: V1.maturity_floor + (Math.min(Math.max(ageForModel, 0), V1.maturity_days) / V1.maturity_days) * V1.maturity_range,
  };
}

/** The final fit: Huber-robust regression of log10(mcap) on size and the age feature. */
function maturityFit(rows: CompFeatures[], model: ModelConstants): CurveFit {
  const beta = huberFit(rows, (r) => [1, r.x, r.z], (r) => r.y, model, true);
  return { intercept: beta[0]!, slope: beta[1]!, ageCoef: beta[2]! };
}

/** A backtest specification: how it fits on training rows and predicts one row, in log10. */
interface Spec {
  name: string;
  fit: (train: CompFeatures[]) => unknown;
  predict: (fit: unknown, r: CompFeatures) => number;
}

function linearSpec(
  name: string,
  cols: (r: CompFeatures) => number[],
  opts: { robust: boolean; familyK: number; slope: boolean; postGrowth: boolean },
  model: ModelConstants,
): Spec {
  return {
    name,
    fit(train) {
      const beta = huberFit(train, cols, (r) => r.y, model, opts.robust);
      const off = new Map<string, number>();
      if (opts.familyK > 0) {
        const byCat = new Map<string, number[]>();
        for (const r of train) {
          const res = r.y - dot(cols(r), beta);
          const list = byCat.get(r.category) ?? [];
          list.push(res);
          byCat.set(r.category, list);
        }
        for (const [cat, list] of byCat) {
          const mean = list.reduce((a, b) => a + b, 0) / list.length;
          off.set(cat, (list.length * mean) / (list.length + opts.familyK));
        }
      }
      const slopes = new Map<string, { adj: number; mx: number }>();
      if (opts.slope) {
        const byCat = new Map<string, [number, number][]>();
        for (const r of train) {
          const res = r.y - dot(cols(r), beta) - (off.get(r.category) ?? 0);
          const list = byCat.get(r.category) ?? [];
          list.push([r.x, res]);
          byCat.set(r.category, list);
        }
        for (const [cat, list] of byCat) {
          if (list.length < 3) continue;
          const mx = list.reduce((a, [x]) => a + x, 0) / list.length;
          let num = 0;
          let den = 0;
          for (const [x, res] of list) {
            num += (x - mx) * res;
            den += (x - mx) ** 2;
          }
          if (den > 1e-9) slopes.set(cat, { adj: (list.length / (list.length + 5)) * (num / den), mx });
        }
      }
      return { beta, off, slopes };
    },
    predict(f, r) {
      const fit = f as { beta: number[]; off: Map<string, number>; slopes: Map<string, { adj: number; mx: number }> };
      let v = dot(cols(r), fit.beta) + (fit.off.get(r.category) ?? 0);
      const s = fit.slopes.get(r.category);
      if (s) v += s.adj * (r.x - s.mx);
      if (opts.postGrowth) v += Math.log10(1 + r.g * model.growth_weight);
      return v;
    },
  };
}

/** The v1 method, scored blind: pooled medians recomputed without the held-out row. */
function v1Spec(): Spec {
  return {
    name: 'Pooled median + growth + maturity (v1)',
    fit: (train) => train,
    predict(f, r) {
      const train = f as CompFeatures[];
      const global = median(train.map((p) => p.mcap / p.tvl));
      const catRows = train.filter((p) => p.category === r.category);
      const mult =
        catRows.length === 0 ? global : (catRows.length * median(catRows.map((p) => p.mcap / p.tvl)) + V1.pool_weight * global) / (catRows.length + V1.pool_weight);
      return Math.log10(Math.max(1, r.tvl * mult * r.growthMult * r.maturity));
    },
  };
}

function flatSpec(): Spec {
  return {
    name: 'Flat global median',
    fit: (train) => median(train.map((p) => p.mcap / p.tvl)),
    predict: (f, r) => Math.log10(Math.max(1, r.tvl * (f as number))),
  };
}

function allSpecs(model: ModelConstants): Spec[] {
  const size = (r: CompFeatures) => [1, r.x];
  return [
    v1Spec(),
    flatSpec(),
    linearSpec('Size curve, OLS', size, { robust: false, familyK: 0, slope: false, postGrowth: false }, model),
    linearSpec('Size curve, robust', size, { robust: true, familyK: 0, slope: false, postGrowth: false }, model),
    linearSpec('Size curve, robust, x fixed growth', size, { robust: true, familyK: 0, slope: false, postGrowth: true }, model),
    linearSpec('Size + fitted age, x fixed growth (this radar)', (r) => [1, r.x, r.z], { robust: true, familyK: 0, slope: false, postGrowth: true }, model),
    linearSpec('+ category offsets', size, { robust: true, familyK: 5, slope: false, postGrowth: true }, model),
    linearSpec('+ fitted growth', (r) => [1, r.x, r.g], { robust: true, familyK: 0, slope: false, postGrowth: false }, model),
    linearSpec('+ chain count', (r) => [1, r.x, r.logChains], { robust: true, familyK: 0, slope: false, postGrowth: true }, model),
    linearSpec('+ growth x size', (r) => [1, r.x, r.g, r.g * r.x], { robust: true, familyK: 0, slope: false, postGrowth: false }, model),
    linearSpec('+ per-category slopes', size, { robust: true, familyK: 0, slope: true, postGrowth: true }, model),
    linearSpec('+ quadratic size', (r) => [1, r.x, r.x * r.x], { robust: true, familyK: 0, slope: false, postGrowth: true }, model),
  ];
}

interface SpecMetrics {
  miss: number;
  within3: number;
}

function specMetrics(errors: number[]): SpecMetrics {
  const abs = errors.map(Math.abs);
  return {
    miss: 10 ** (abs.reduce((a, b) => a + b, 0) / abs.length),
    within3: errors.filter((e) => Math.abs(e) < Math.log10(3)).length / errors.length,
  };
}

/**
 * The backtest: leave-one-out and a 70/30 time-split for every specification, the
 * nested ablation (size-only -> +growth -> +age) with median misses, and the
 * uncertainty band calibrated from the final specification's own leave-one-out misses.
 * Every fit inside a fold uses only that fold's training rows. The time-split trains
 * on the oldest listings and tests the newest, so it splits on the very variable the
 * age term fits: an age coefficient is barely identified on old listings alone, and
 * the split's age number reads that confounding, not the age term's live accuracy.
 * Leave-one-out, which holds out one comp at a time from the full age range, is the
 * age model's honest out-of-sample read.
 */
export function runBacktest(snapshot: Snapshot, model: ModelConstants = MODEL): { backtest: BacktestData; fit: CurveFit; finalLooErrors: number[] } {
  const comps = cleanComps(snapshot, model)
    .map((p) => compFeatures(p, snapshot.as_of, model))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const specs = allSpecs(model);
  const dated = comps
    .filter((c) => c.ageKnown)
    .sort((a, b) => (a.listedAt! < b.listedAt! ? -1 : a.listedAt! > b.listedAt! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const trainTs = dated.slice(0, cut);
  const testTs = dated.slice(cut);

  const rows: BacktestRow[] = [];
  const ablationByName = new Map<string, AblationRow>();
  const ablationNames: Record<string, string> = {
    'Size curve, robust': 'Size only',
    'Size curve, robust, x fixed growth': 'Size + growth',
    'Size + fitted age, x fixed growth (this radar)': 'Size + growth + fitted age',
  };
  let finalLooErrors: number[] = [];
  for (const spec of specs) {
    const looErrors = comps.map((r, i) => spec.predict(spec.fit(comps.filter((_, j) => j !== i)), r) - r.y);
    const tsFit = spec.fit(trainTs);
    const tsErrors = testTs.map((r) => spec.predict(tsFit, r) - r.y);
    const loo = specMetrics(looErrors);
    const ts = specMetrics(tsErrors);
    if (spec.name.includes('this radar')) finalLooErrors = looErrors;
    const ablationName = ablationNames[spec.name];
    if (ablationName !== undefined) {
      ablationByName.set(ablationName, {
        name: ablationName,
        loo_miss: round4(loo.miss),
        loo_median: round4(10 ** median(looErrors.map(Math.abs))),
        loo_within3: round4(loo.within3),
        ts_miss: round4(ts.miss),
        ts_median: round4(10 ** median(tsErrors.map(Math.abs))),
        ts_within3: round4(ts.within3),
      });
    }
    rows.push({ name: spec.name, loo_miss: round4(loo.miss), loo_within3: round4(loo.within3), ts_miss: round4(ts.miss), ts_within3: round4(ts.within3) });
  }
  const ablation = ['Size only', 'Size + growth', 'Size + growth + fitted age'].map((n) => ablationByName.get(n)!);
  const absSorted = [...finalLooErrors].map(Math.abs).sort((a, b) => a - b);
  const band80 = 10 ** quantileSorted(absSorted, model.band_quantile);
  const band50 = 10 ** quantileSorted(absSorted, model.haircut_quantile);
  const looSd = Math.sqrt(finalLooErrors.reduce((a, e) => a + e * e, 0) / finalLooErrors.length);
  const fit = maturityFit(comps, model);
  return {
    backtest: {
      rows,
      ablation,
      loo_n: comps.length,
      ts_train_n: trainTs.length,
      ts_test_n: testTs.length,
      ts_cutoff: dated[cut]!.listedAt!,
      null_date_excluded: comps.length - dated.length,
      band80: round4(band80),
      band50: round4(band50),
      loo_sd: round4(looSd),
    },
    fit,
    finalLooErrors,
  };
}

// ---------------------------------------------------------------------------
// Scoring, verdicts, and farm plans.
// ---------------------------------------------------------------------------

/** The multipliers and the implied value one protocol gets under the fitted curve. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fit: CurveFit,
  model: ModelConstants,
): { implied: number; curveValue: number; growthPct: number; growthMult: number; ageMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageMult = ageFactor(age, fit.ageCoef);
  const curveValue = 10 ** (fit.intercept + fit.slope * Math.log10(protocol.tvl_usd / 1e8));
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(curveValue * growthMult * ageMult)));
  return { implied, curveValue: Math.round(curveValue), growthPct, growthMult, ageMult, age };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** What transactions cost on a chain, in dollars, from the chain's own name. */
export function gasNums(chain: string): { setup: number; weekly: number } {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return { setup: 12, weekly: 4 };
  if (c.includes('solana')) return { setup: 0.1, weekly: 0.1 };
  if (c.includes('bitcoin')) return { setup: 3, weekly: 3 };
  return { setup: 1, weekly: 1 };
}

/** What transactions cost on a chain, in words, from the chain's own name. */
function gasFor(chain: string): { first: string; setup: string; weekly: string } {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return { first: 'about $12 of gas for the first transaction', setup: 'about $12 of gas', weekly: 'about $4 of gas a week' };
  if (c.includes('solana')) return { first: 'under $0.10 of fees for the first transaction', setup: 'under $0.10 of fees', weekly: 'under $0.10 of fees a week' };
  if (c.includes('bitcoin')) return { first: 'about $3 of network fees for the first transaction', setup: 'about $3 of network fees', weekly: 'about $3 of network fees a week' };
  return { first: 'about $1 of gas for the first transaction', setup: 'about $1 of gas', weekly: 'under $1 of gas a week' };
}

/**
 * The verdict in dollars: the expected gross of farming at the yardstick capital,
 * minus gas and the hurdle, at the point estimate and after the typical-miss haircut.
 * Thresholds use unrounded dollars; the stored figures are rounded to cents.
 */
export function verdictFor(
  ratio: number,
  holdDays: number,
  gasTotal: number,
  haircut: number,
  opts: { capital: number; share: number; hurdle: number },
): { gross: number; costs: number; net: number; netLow: number; verdict: Verdict } {
  const gross = opts.capital * ratio * opts.share;
  const costs = gasTotal + opts.capital * opts.hurdle * (holdDays / 365);
  const net = gross - costs;
  const netLow = gross / haircut - costs;
  const verdict: Verdict = netLow > 0 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
  return { gross: round2(gross), costs: round2(costs), net: round2(net), netLow: round2(netLow), verdict };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('interest rate')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('basis')) return `Open a $${capital} delta-neutral basis position on ${name} on ${chain} and keep both legs open.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('dex') || c.includes('liquidity manager') || c.includes('amm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('stablecoin') || c.includes('dual-token')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator')) return `Deposit $${capital} of USDC into a ${name} yield vault on ${chain} and keep the shares.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('payment') || c.includes('card')) return `Deposit $${capital} with ${name} on ${chain} and complete one payment or card spend.`;
  if (c.includes('governance')) return `Stake $${capital} with ${name} on ${chain} and cast one governance vote.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold it.`;
  if (c.includes('otc')) return `Deposit $${capital} with ${name} on ${chain} and complete one OTC trade.`;
  if (c.includes('btc') || c.includes('bitcoin')) return `Deposit $${capital} of BTC into ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('cedefi')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the position open.`;
  if (c === 'chain') return `Bridge $${capital} of USDC onto ${name} and use its main app once.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action: the repeatable touch that keeps the farm counted. */
function weeklyFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator')) return `Check the vault's allocation on ${chain} and add a small top-up when the strategy changes.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('interest rate')) return `Open or close one small hedge and check the margin and funding on ${chain}.`;
  if (c.includes('basis')) return `Check both legs of the basis position and rebalance a small amount when the spread moves.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Add a small supply top-up and check the borrow health factor on ${chain}.`;
  if (c.includes('prediction')) return `Place one more small market position and check the open markets.`;
  if (c.includes('bridge')) return `Bridge a small amount back or use the bridged funds once more in the app.`;
  if (c.includes('dex') || c.includes('liquidity manager') || c.includes('amm')) return `Add a small amount of liquidity, or claim and re-stake the pool rewards.`;
  if (c.includes('staking') || c.includes('restak')) return `Restake the staking rewards or add a small stake.`;
  if (c.includes('rwa') || c.includes('stablecoin') || c.includes('dual-token')) return `Mint a small top-up and confirm the yield or redemption terms still hold.`;
  if (c.includes('governance')) return `Vote on one live proposal, or delegate the stake when no proposal is open.`;
  return `Make one qualifying action, such as a deposit, a swap, a borrow or a vote.`;
}

/** The category's risk to check before withdrawing, in one sentence. */
function riskFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('liquidity manager') || c.includes('amm')) return `Check impermanent loss and the pool's ratio before withdrawing, then withdraw a small test amount first.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Check the borrow health factor and the borrow rate, then repay or withdraw a small test amount first.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('interest rate')) return `Check the liquidation price and funding rate, then close a small part of the hedge first.`;
  if (c.includes('bridge')) return `Check the bridge delay and that the destination wallet holds gas on ${chain}, then bridge a small test amount first.`;
  if (c.includes('staking') || c.includes('restak')) return `Check the unbonding period and any slashing terms, then unstake a small test amount first.`;
  if (c.includes('rwa')) return `Check the issuer's redemption window and any lockup, then redeem a small test amount first.`;
  if (c.includes('curator') || c.includes('allocator')) return `Check the vault's withdrawal queue and strategy drift, then redeem a small test amount first.`;
  if (c.includes('stablecoin') || c.includes('dual-token')) return `Check the peg and the redemption terms, then redeem a small test amount first.`;
  if (c.includes('prediction')) return `Check the market's resolution rules, then close a small part of the position first.`;
  return `Check the withdrawal terms and any lockup, then withdraw a small test amount first.`;
}

/**
 * A protocol's farm plan: each step names its week, its action, its dollar cost and
 * its time, derived from the protocol's own record (category, chains, TVL, age) and
 * its verdict. A SKIP row farms a $10 test position in six steps, a THIN row adds the
 * weekly cadence, and a FARM row adds an exit rule on top: withdraw instead of adding
 * capital when TVL falls 15% week over week or the points page stops counting the
 * position. The dashboard's farmSteps is the same derivation, step for step.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, verdict: Verdict, netUsd: number, model: ModelConstants = MODEL): FarmStep[] {
  const chain = chainOf(p);
  const capital = verdict === 'SKIP' ? 10 : capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const gas = gasFor(chain);
  const netPhrase = netUsd < 0 ? `about -$${Math.abs(netUsd).toFixed(2)}` : `about $${netUsd.toFixed(2)}`;
  const steps: FarmStep[] = [
    {
      text: `Week 1: verdict ${verdict} - at the $${model.verdict_capital.toLocaleString('en-US')} yardstick this farm nets ${netPhrase} after gas and the ${Math.round(model.hurdle_rate * 100)}% hurdle. Use a fresh wallet that holds only the funds you plan to farm, and open ${p.name} only from the link its own docs publish.`,
      cost: gas.first,
      time: '10 minutes',
    },
    {
      text: `Week 1: ${actionFor(p, capital, chain)}`,
      cost: `$${capital} of capital and ${gas.setup}`,
      time: '15 minutes to set up',
    },
  ];
  if (verdict !== 'SKIP') {
    steps.push({
      text: `Week 2: ${weeklyFor(p, chain)} Repeat weekly until the exit rule or the hold below says otherwise.`,
      cost: gas.weekly,
      time: '10 minutes a week',
    });
  }
  steps.push(
    {
      text: `Week 2: open the protocol's points or rewards page, confirm the position is counted, and save a dated screenshot of the balance.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Weeks 1-${weeks}: hold the position for at least ${hold} days with one qualifying action a week, so the activity spans more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before exit: ${riskFor(p, chain)}`,
      cost: gas.setup,
      time: '15 minutes',
    },
    {
      text: `Throughout: write the wallet, the dates and every transaction in a farm log, and claim only from the protocol's own link: never pay to claim.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  if (verdict === 'FARM') {
    steps.splice(4, 0, {
      text: `Exit rule: if ${p.name}'s TVL falls 15% week over week, or the points page stops counting the position for two weeks in a row, start the exit below instead of adding more capital.`,
      cost: gas.setup,
      time: '5 minutes a week to check',
    });
  }
  return steps;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  fit: CurveFit,
  backtest: BacktestData,
  model: ModelConstants = MODEL,
): BoardRow[] {
  const chosen = snapshot.protocols.filter(isRankable);
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit, model);
    const hold = holdDaysFor(v.age);
    const gas = gasNums(chainOf(p));
    const gasTotal = round2(gas.setup + gas.weekly * Math.ceil(hold / 7));
    const verdict = verdictFor(v.implied / p.tvl_usd, hold, gasTotal, backtest.band50, {
      capital: model.verdict_capital,
      share: model.verdict_share,
      hurdle: model.hurdle_rate,
    });
    return { p, v, hold, gasTotal, verdict };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    band_low_usd: Math.max(1, Math.round(s.v.implied / backtest.band80)),
    band_high_usd: Math.round(s.v.implied * backtest.band80),
    verdict: s.verdict.verdict,
    net_usd: s.verdict.net,
    model: {
      curve_value_usd: s.v.curveValue,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      age_multiplier: round4(s.v.ageMult),
      gross_usd: s.verdict.gross,
      cost_usd: s.verdict.costs,
      hold_days: s.hold,
      gas_usd: s.gasTotal,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age, s.verdict.verdict, s.verdict.net, model).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: boolean): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    band_low_usd: row.band_low_usd,
    band_high_usd: row.band_high_usd,
    verdict: row.verdict,
    net_usd: row.net_usd,
    curve_value_usd: row.model.curve_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    gross_usd: row.model.gross_usd,
    cost_usd: row.model.cost_usd,
    hold_days: row.model.hold_days,
    gas_usd: row.model.gas_usd,
    watchlist,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { backtest, fit } = runBacktest(snapshot, model);
  const board = buildBoard(snapshot, fit, backtest, model);
  const live = liveRows(snapshot);
  const watchSet = new Set(snapshot.watchlist);
  const beyond = board.filter((r) => !watchSet.has(r.slug)).length;
  const excluded = snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length;
  const fitComps: FitComp[] = cleanComps(snapshot, model)
    .map((p) => {
      const rawGrowth = finite(p.change_7d, 0);
      const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
      return { slug: p.slug, x: Math.log10(p.tvl_usd / 1e8), y: Math.log10(p.mcap_usd!), g: growthPct / 100, a: ageFeature(ageDays(snapshot.as_of, p.listed_at)) };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    beyond_size: beyond,
    live_size: live.length,
    excluded_size: excluded,
    clean_comps: fitComps.length,
    curve: fit,
    backtest,
    fit_comps: fitComps,
    verdict_counts: verdictCounts,
    rows: board.map((r) => radarRow(r, watchSet.has(r.slug))),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
