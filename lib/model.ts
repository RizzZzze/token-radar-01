// Token radar model: pure functions over a frozen snapshot.
//
// Every number the entry reports comes from the procedures in this file.
// No wall clock, no unseeded randomness: two runs over the same snapshot
// produce identical output.

export interface Proto {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

// ---------------------------------------------------------------- constants

export const MODEL_VERSION = "radar-5-age-tested";
export const HUBER_C = 1.345;
export const HUBER_MAX_ITER = 12;
export const PIVOT_EPS = 1e-12;
export const HUBER_TOL = 1e-10;
export const MAD_FLOOR = 1e-6;
export const GROWTH_WEIGHT = 0.5;
export const GROWTH_LO = -60;
export const GROWTH_HI = 120;
export const COMP_RATIO_LO = 0.001;
export const COMP_RATIO_HI = 10;
export const BAND_Q = 0.8;
export const HAIRCUT_Q = 0.5;
export const YARDSTICK_USD = 1000;
export const SHARE = 0.1;
export const HURDLE = 0.04;
export const TAU_GRID = [60, 90, 180, 365, 730, 1095, 1825, 3650];
export const BOOTSTRAP_SEED = 20261115;
export const BOOTSTRAP_RESAMPLES = 2000;
export const SIZE_REF_USD = 1e8;
export const IMPLIED_CAP = 1e14;

// ---------------------------------------------------------------- validation

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function normalizeProto(p: unknown, i: number): Proto {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new Error(`snapshot: protocols[${i}] must be an object`);
  }
  const q = p as Record<string, unknown>;
  if (typeof q.slug !== "string" || typeof q.name !== "string") {
    throw new Error(`snapshot: protocols[${i}] needs a string slug and name`);
  }
  if (typeof q.tvl_usd !== "number" || !Number.isFinite(q.tvl_usd)) {
    throw new Error(`snapshot: protocols[${i}] needs a finite tvl_usd`);
  }
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    slug: q.slug,
    name: q.name,
    category: strOrNull(q.category),
    chains: Array.isArray(q.chains) ? q.chains.filter((c) => typeof c === "string") : [],
    tvl_usd: q.tvl_usd,
    change_7d: numOrNull(q.change_7d),
    mcap_usd: numOrNull(q.mcap_usd),
    listed_at: strOrNull(q.listed_at),
    gecko_id: strOrNull(q.gecko_id),
    symbol: strOrNull(q.symbol),
  };
}

export function parseSnapshot(raw: unknown): Snapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("snapshot: root must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== "string" || !isRealDate(o.as_of)) {
    throw new Error("snapshot: as_of must be a YYYY-MM-DD date");
  }
  if (typeof o.source !== "string") {
    throw new Error("snapshot: source must be a string");
  }
  if (!Number.isSafeInteger(o.floor_usd) || (o.floor_usd as number) <= 0) {
    throw new Error("snapshot: floor_usd must be a positive safe integer");
  }
  if (!Array.isArray(o.protocols)) {
    throw new Error("snapshot: protocols must be an array");
  }
  if (!Array.isArray(o.watchlist) || o.watchlist.some((w) => typeof w !== "string")) {
    throw new Error("snapshot: watchlist must be an array of strings");
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd as number,
    protocols: o.protocols.map((p, i) => normalizeProto(p, i)),
    watchlist: [...(o.watchlist as string[])],
  };
}

// ---------------------------------------------------------------- age

function utcDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from listed_at to as_of, clamped at 0; null when missing/broken. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null || !isRealDate(listedAt)) return null;
  const diff = Math.round((utcDay(asOf) - utcDay(listedAt)) / 86400000);
  return Math.max(0, diff);
}

// ---------------------------------------------------------------- classification

export function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const REJECTED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

export type ExclusionReason = "category" | "version" | "wrapped" | "exchange";

/** First matching exclusion wins; null means the protocol passes. */
export function exclusionReason(p: Proto): ExclusionReason | null {
  if (p.category !== null && REJECTED_CATEGORIES.has(p.category)) return "category";
  if (VERSION_MARK.test(p.name)) return "version";
  if (WRAPPED_WORD.test(p.name)) return "wrapped";
  for (const e of EXCHANGES) {
    if (p.name.startsWith(e)) return "exchange";
  }
  return null;
}

export function rankableProtocols(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => isPreToken(p) && exclusionReason(p) === null);
}

/** Token-bearing protocols with a usable market-cap/TVL ratio. */
export function cleanComps(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => {
    if (p.mcap_usd === null || p.tvl_usd <= 0) return false;
    const r = p.mcap_usd / p.tvl_usd;
    return r >= COMP_RATIO_LO && r <= COMP_RATIO_HI;
  });
}

// ---------------------------------------------------------------- small numerics

export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error("median of empty list");
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Order statistic floor(q*n) over an ascending-sorted list. */
export function quantileSorted(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new Error("quantile of empty list");
  const idx = Math.min(n - 1, Math.floor(q * n));
  return sortedAsc[idx];
}

export function meanOf(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

// ------------------------------------------------------- linear algebra

/**
 * Solve A x = b by Gauss elimination with partial pivoting, carried to
 * reduced form (each pivot column is cleared in every other row).
 * A column whose best pivot is below 1e-12 gets coefficient 0; free
 * columns contribute nothing because their coefficients are 0.
 */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  const pivotRowForCol: number[] = new Array(n).fill(-1);
  let r = 0;
  for (let col = 0; col < n && r < n; col++) {
    let piv = r;
    let best = Math.abs(M[r][col]);
    for (let i = r + 1; i < n; i++) {
      const v = Math.abs(M[i][col]);
      if (v > best) {
        best = v;
        piv = i;
      }
    }
    if (best < PIVOT_EPS) continue;
    if (piv !== r) {
      const tmp = M[r];
      M[r] = M[piv];
      M[piv] = tmp;
    }
    pivotRowForCol[col] = r;
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      const f = M[i][col] / M[r][col];
      if (f !== 0) {
        for (let j = col; j <= n; j++) M[i][j] -= f * M[r][j];
      }
    }
    r++;
  }
  const x: number[] = new Array(n).fill(0);
  for (let col = 0; col < n; col++) {
    const pr = pivotRowForCol[col];
    if (pr < 0) {
      x[col] = 0;
      continue;
    }
    x[col] = M[pr][n] / M[pr][col];
  }
  return x;
}

function normalEquations(
  X: number[][],
  y: number[],
  w: number[] | null,
): { A: number[][]; b: number[] } {
  const k = X[0].length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const b: number[] = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const wi = w === null ? 1 : w[i];
    const row = X[i];
    for (let a = 0; a < k; a++) {
      b[a] += wi * row[a] * y[i];
      for (let c = 0; c < k; c++) A[a][c] += wi * row[a] * row[c];
    }
  }
  return { A, b };
}

export function olsFit(X: number[][], y: number[], w: number[] | null = null): number[] {
  const { A, b } = normalEquations(X, y, w);
  return solveLinear(A, b);
}

/**
 * Huber-robust fit: OLS start, then IRLS (at most 12 rounds).
 * Residual -> median -> MAD (floor 1e-6) -> scale 1.4826*MAD ->
 * weights min(1, c*s/max(|resid|,1e-9)) -> weighted OLS.
 * Stops when every coefficient moves less than 1e-10.
 */
export function huberFit(X: number[][], y: number[]): number[] {
  let beta = olsFit(X, y, null);
  for (let iter = 0; iter < HUBER_MAX_ITER; iter++) {
    const resid = X.map((row, i) => {
      let pred = 0;
      for (let j = 0; j < row.length; j++) pred += row[j] * beta[j];
      return y[i] - pred;
    });
    const med = medianOf(resid);
    const mad = Math.max(MAD_FLOOR, medianOf(resid.map((r) => Math.abs(r - med))));
    const s = 1.4826 * mad;
    const w = resid.map((r) => Math.min(1, (HUBER_C * s) / Math.max(Math.abs(r), 1e-9)));
    const next = olsFit(X, y, w);
    let maxMove = 0;
    for (let j = 0; j < beta.length; j++) maxMove = Math.max(maxMove, Math.abs(next[j] - beta[j]));
    beta = next;
    if (maxMove < HUBER_TOL) break;
  }
  return beta;
}

// ---------------------------------------------------------------- features

export function sizeX(tvl: number): number {
  return Math.log10(tvl / SIZE_REF_USD);
}

export function clampPct(pct: number | null): number {
  const p = pct === null ? 0 : pct;
  return Math.min(GROWTH_HI, Math.max(GROWTH_LO, p));
}

/** Fixed growth prior multiplier (never fitted). */
export function growthMult(pct: number | null): number {
  return 1 + (clampPct(pct) * GROWTH_WEIGHT) / 100;
}

export function growthG(pct: number | null): number {
  return clampPct(pct) / 100;
}

export function ageFeature(age: number | null): number {
  return age === null ? 0 : Math.log1p(age / 365);
}

export function maturityFeature(age: number | null, tau: number): number {
  return age === null ? 0 : 1 - Math.exp(-age / tau);
}

// ---------------------------------------------------------------- fit rows

export interface FitRow {
  slug: string;
  tvl: number;
  mcap: number;
  pct: number | null;
  age: number | null;
  category: string | null;
  nChains: number;
  listedAt: string | null;
}

export function toFitRow(p: Proto, asOf: string): FitRow {
  return {
    slug: p.slug,
    tvl: p.tvl_usd,
    mcap: p.mcap_usd as number,
    pct: p.change_7d,
    age: ageDays(asOf, p.listed_at),
    category: p.category,
    nChains: p.chains.length,
    listedAt: p.listed_at,
  };
}

const LOG3 = Math.log10(3);

export interface ErrorMetrics {
  miss: number;
  within3: number;
  medianMiss: number;
}

export function looSdOf(errors: number[]): number {
  // Root mean square of the signed LOO errors (divisor n, mean not removed).
  return Math.sqrt(meanOf(errors.map((e) => e * e)));
}

export function errorMetrics(errors: number[]): ErrorMetrics {
  const abs = errors.map((e) => Math.abs(e));
  let within = 0;
  for (const a of abs) if (a < LOG3) within++;
  return {
    miss: Math.pow(10, meanOf(abs)),
    within3: errors.length === 0 ? 0 : within / errors.length,
    medianMiss: Math.pow(10, medianOf(abs)),
  };
}

// ---------------------------------------------------------------- spec fitters

export interface Predictor {
  predict(row: FitRow): number; // log10 market cap
}

export type Fitter = (train: FitRow[]) => Predictor;

function dot(beta: number[], x: number[]): number {
  let s = 0;
  for (let j = 0; j < beta.length; j++) s += beta[j] * x[j];
  return s;
}

function regressionFitter(
  design: (row: FitRow) => number[],
  robust: boolean,
  useGrowth: boolean,
): Fitter {
  return (train: FitRow[]) => {
    const X = train.map(design);
    const y = train.map((r) => Math.log10(r.mcap));
    const beta = robust ? huberFit(X, y) : olsFit(X, y, null);
    return {
      predict: (row: FitRow) =>
        dot(beta, design(row)) + (useGrowth ? Math.log10(growthMult(row.pct)) : 0),
    };
  };
}

const designSize = (r: FitRow): number[] => [1, sizeX(r.tvl)];
const designSizeAge = (r: FitRow): number[] => [1, sizeX(r.tvl), ageFeature(r.age)];
const designSizeGrowthFit = (r: FitRow): number[] => [1, sizeX(r.tvl), growthG(r.pct)];
const designSizeChains = (r: FitRow): number[] => [1, sizeX(r.tvl), Math.log10(Math.max(1, r.nChains))];
const designSizeGrowthX = (r: FitRow): number[] => [1, sizeX(r.tvl), growthG(r.pct) * sizeX(r.tvl)];
const designSizeQuad = (r: FitRow): number[] => {
  const x = sizeX(r.tvl);
  return [1, x, x * x];
};

function designSizeMaturity(tau: number): (r: FitRow) => number[] {
  return (r: FitRow) => [1, sizeX(r.tvl), maturityFeature(r.age, tau)];
}

/** Spec 1: pooled median (pool weight 5) x growth x v1 maturity. */
function pooledMedianFitter(train: FitRow[]): Predictor {
  const logRatio = (r: FitRow): number => Math.log10(r.mcap) - Math.log10(r.tvl);
  const globalMed = medianOf(train.map(logRatio));
  const byCat = new Map<string, number[]>();
  for (const r of train) {
    if (r.category === null) continue;
    const arr = byCat.get(r.category) ?? [];
    arr.push(logRatio(r));
    byCat.set(r.category, arr);
  }
  const catMed = new Map<string, { med: number; n: number }>();
  for (const [cat, arr] of byCat) catMed.set(cat, { med: medianOf(arr), n: arr.length });
  return {
    predict: (row: FitRow) => {
      const cm = row.category === null ? undefined : catMed.get(row.category);
      const pooled =
        cm === undefined ? globalMed : (cm.n * cm.med + 5 * globalMed) / (cm.n + 5);
      const age = row.age === null ? 365 : row.age;
      const mat = 0.6 + 0.4 * (Math.min(Math.max(age, 0), 1095) / 1095);
      return (
        Math.log10(row.tvl) + pooled + Math.log10(growthMult(row.pct)) + Math.log10(mat)
      );
    },
  };
}

/** Spec 2: flat global median of log market cap. */
function globalMedianFitter(train: FitRow[]): Predictor {
  const med = medianOf(train.map((r) => Math.log10(r.mcap)));
  return { predict: () => med };
}

/** Base fit shared by specs 7 and 11: robust size curve x fixed growth. */
function baseFit(train: FitRow[]): { beta: number[] } {
  const X = train.map(designSize);
  const y = train.map((r) => Math.log10(r.mcap));
  return { beta: huberFit(X, y) };
}

function basePredict(beta: number[], row: FitRow): number {
  return dot(beta, designSize(row)) + Math.log10(growthMult(row.pct));
}

/** Spec 7: category offset from base residuals, shrunk n/(n+5). */
function categoryOffsetFitter(train: FitRow[]): Predictor {
  const { beta } = baseFit(train);
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of train) {
    if (r.category === null) continue;
    const resid = Math.log10(r.mcap) - basePredict(beta, r);
    const cur = sums.get(r.category) ?? { sum: 0, n: 0 };
    cur.sum += resid;
    cur.n += 1;
    sums.set(r.category, cur);
  }
  const offsets = new Map<string, number>();
  for (const [cat, { sum, n }] of sums) offsets.set(cat, (sum / n) * (n / (n + 5)));
  return {
    predict: (row: FitRow) =>
      basePredict(beta, row) + (row.category === null ? 0 : (offsets.get(row.category) ?? 0)),
  };
}

/** Spec 11: per-category slope on centered size, shrunk n/(n+5). */
function categorySlopeFitter(train: FitRow[]): Predictor {
  const { beta } = baseFit(train);
  const groups = new Map<string, FitRow[]>();
  for (const r of train) {
    if (r.category === null) continue;
    const arr = groups.get(r.category) ?? [];
    arr.push(r);
    groups.set(r.category, arr);
  }
  const adj = new Map<string, { slope: number; xbar: number }>();
  for (const [cat, rows] of groups) {
    if (rows.length < 3) continue;
    const xs = rows.map((r) => sizeX(r.tvl));
    const xbar = meanOf(xs);
    let num = 0;
    let den = 0;
    for (let i = 0; i < rows.length; i++) {
      const resid = Math.log10(rows[i].mcap) - basePredict(beta, rows[i]);
      num += (xs[i] - xbar) * resid;
      den += (xs[i] - xbar) * (xs[i] - xbar);
    }
    if (den > 1e-9) {
      adj.set(cat, { slope: (num / den) * (rows.length / (rows.length + 5)), xbar });
    }
  }
  return {
    predict: (row: FitRow) => {
      const a = row.category === null ? undefined : adj.get(row.category);
      return basePredict(beta, row) + (a === undefined ? 0 : a.slope * (sizeX(row.tvl) - a.xbar));
    },
  };
}

export interface SpecDef {
  name: string;
  fitter: Fitter;
}

export const SPECS: SpecDef[] = [
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
  { name: "robust + quadratic size", fitter: regressionFitter(designSizeQuad, true, true) },
];

// ---------------------------------------------------------------- evaluation

export function looErrors(fitter: Fitter, rows: FitRow[]): number[] {
  const errors: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = [...rows.slice(0, i), ...rows.slice(i + 1)];
    const pred = fitter(train);
    errors.push(pred.predict(rows[i]) - Math.log10(rows[i].mcap));
  }
  return errors;
}

export function splitErrors(fitter: Fitter, train: FitRow[], test: FitRow[]): number[] {
  const pred = fitter(train);
  return test.map((r) => pred.predict(r) - Math.log10(r.mcap));
}

export function timeSplit(rows: FitRow[], trainCount: number): { train: FitRow[]; test: FitRow[] } {
  const dated = rows
    .filter((r) => r.listedAt !== null)
    .sort((a, b) => {
      if (a.listedAt !== b.listedAt) return a.listedAt! < b.listedAt! ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  return { train: dated.slice(0, trainCount), test: dated.slice(trainCount) };
}

// ------------------------------------------------------- saturating-age tau

function meanAbsError(errors: number[]): number {
  return meanOf(errors.map((e) => Math.abs(e)));
}

/** Tau picked by 5-fold CV inside train only (fold = position mod 5, slug order). */
export function pickTauNestedCV(train: FitRow[]): number {
  let bestTau = TAU_GRID[0];
  let bestScore = Infinity;
  for (const tau of TAU_GRID) {
    const fitter = regressionFitter(designSizeMaturity(tau), true, true);
    const allErrors: number[] = [];
    for (let f = 0; f < 5; f++) {
      const subTrain: FitRow[] = [];
      const subTest: FitRow[] = [];
      for (let i = 0; i < train.length; i++) {
        if (i % 5 === f) subTest.push(train[i]);
        else subTrain.push(train[i]);
      }
      if (subTest.length === 0) continue;
      allErrors.push(...splitErrors(fitter, subTrain, subTest));
    }
    const score = meanAbsError(allErrors);
    if (score < bestScore) {
      bestScore = score;
      bestTau = tau;
    }
  }
  return bestTau;
}

/** Tau picked by LOO inside train only. */
export function pickTauLoo(train: FitRow[]): number {
  let bestTau = TAU_GRID[0];
  let bestScore = Infinity;
  for (const tau of TAU_GRID) {
    const fitter = regressionFitter(designSizeMaturity(tau), true, true);
    const score = meanAbsError(looErrors(fitter, train));
    if (score < bestScore) {
      bestScore = score;
      bestTau = tau;
    }
  }
  return bestTau;
}

/** LOO errors for the saturating-age form, tau re-picked per fold. */
export function looErrorsSaturating(rows: FitRow[]): { errors: number[]; taus: number[] } {
  const errors: number[] = [];
  const taus: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = [...rows.slice(0, i), ...rows.slice(i + 1)];
    const tau = pickTauNestedCV(train);
    taus.push(tau);
    const fitter = regressionFitter(designSizeMaturity(tau), true, true);
    const pred = fitter(train);
    errors.push(pred.predict(rows[i]) - Math.log10(rows[i].mcap));
  }
  return { errors, taus };
}

/** Split errors for the saturating-age form, tau picked by LOO inside train. */
export function splitErrorsSaturating(
  train: FitRow[],
  test: FitRow[],
): { errors: number[]; tau: number } {
  const tau = pickTauLoo(train);
  const fitter = regressionFitter(designSizeMaturity(tau), true, true);
  return { errors: splitErrors(fitter, train, test), tau };
}

// ---------------------------------------------------------------- bootstrap

export interface BootstrapResult {
  diff: number;
  ciLow: number;
  ciHigh: number;
}

/**
 * Paired bootstrap over LOO absolute errors: diff = |err A| - |err B|.
 * 2000 resamples, mulberry32 seed 20261115, CI from the 2.5%/97.5%
 * percentiles of resample means.
 */
export function pairedBootstrap(errA: number[], errB: number[]): BootstrapResult {
  const n = errA.length;
  const diffs = errA.map((a, i) => Math.abs(a) - Math.abs(errB[i]));
  const rng = mulberry32(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      s += diffs[idx];
    }
    means.push(s / n);
  }
  const sorted = [...means].sort((a, b) => a - b);
  return {
    diff: meanOf(diffs),
    ciLow: quantileSorted(sorted, 0.025),
    ciHigh: quantileSorted(sorted, 0.975),
  };
}

// ---------------------------------------------------------------- backtest

export interface SpecResult {
  name: string;
  looMiss: number;
  looWithin3: number;
  ts70Miss: number;
  ts70Within3: number;
}

export interface AblationRow {
  name: string;
  looMiss: number;
  looMedian: number;
  ts70Miss: number;
  ts50Miss: number;
}

export interface BacktestResult {
  curve: { a: number; b: number };
  specs: SpecResult[];
  ablation: AblationRow[];
  band80: number;
  haircut: number;
  looSd: number;
  ageLog1p: BootstrapResult & { coef: number; wouldBeMin: number; wouldBeMax: number };
  ageSaturating: BootstrapResult & {
    coef: number;
    fullTau: number;
    split70Tau: number;
    split50Tau: number;
    looTauCounts: Record<string, number>;
  };
  splitInfo: {
    dated: number;
    undated: number;
    ts70: { train: number; test: number; cutoff: string | null };
    ts50: { train: number; test: number; cutoff: string | null };
  };
  looErrorsFinal: number[];
}

export function runBacktest(comps: FitRow[], boardAges: (number | null)[]): BacktestResult {
  const finalFitter = SPECS[4].fitter;
  const sizeOnlyFitter = SPECS[3].fitter;
  const ageFitFitter = SPECS[5].fitter;

  // Full-data curve fit (the radar's curve).
  const X = comps.map(designSize);
  const y = comps.map((r) => Math.log10(r.mcap));
  const beta = huberFit(X, y);
  const curve = { a: beta[0], b: beta[1] };

  // LOO + time splits for the 12 specifications.
  const split70 = timeSplit(comps, 62);
  const split50 = timeSplit(comps, 44);
  const specs: SpecResult[] = [];
  let looFinal: number[] = [];
  let looSizeOnly: number[] = [];
  let looAgeFit: number[] = [];
  let ts70SizeOnly: number[] = [];
  let ts70Final: number[] = [];
  let ts70AgeFit: number[] = [];
  let ts50SizeOnly: number[] = [];
  let ts50Final: number[] = [];
  let ts50AgeFit: number[] = [];
  for (let s = 0; s < SPECS.length; s++) {
    const loo = looErrors(SPECS[s].fitter, comps);
    const ts70 = splitErrors(SPECS[s].fitter, split70.train, split70.test);
    const lm = errorMetrics(loo);
    const tm = errorMetrics(ts70);
    specs.push({ name: SPECS[s].name, looMiss: lm.miss, looWithin3: lm.within3, ts70Miss: tm.miss, ts70Within3: tm.within3 });
    if (s === 3) {
      looSizeOnly = loo;
      ts70SizeOnly = ts70;
      ts50SizeOnly = splitErrors(SPECS[s].fitter, split50.train, split50.test);
    }
    if (s === 4) {
      looFinal = loo;
      ts70Final = ts70;
      ts50Final = splitErrors(SPECS[s].fitter, split50.train, split50.test);
    }
    if (s === 5) {
      looAgeFit = loo;
      ts70AgeFit = ts70;
      ts50AgeFit = splitErrors(SPECS[s].fitter, split50.train, split50.test);
    }
  }

  // Saturating-age form with honest tau selection.
  const satLoo = looErrorsSaturating(comps);
  const sat70 = splitErrorsSaturating(split70.train, split70.test);
  const sat50 = splitErrorsSaturating(split50.train, split50.test);

  const ablation: AblationRow[] = [
    {
      name: "size only",
      looMiss: errorMetrics(looSizeOnly).miss,
      looMedian: errorMetrics(looSizeOnly).medianMiss,
      ts70Miss: errorMetrics(ts70SizeOnly).miss,
      ts50Miss: errorMetrics(ts50SizeOnly).miss,
    },
    {
      name: "size + growth",
      looMiss: errorMetrics(looFinal).miss,
      looMedian: errorMetrics(looFinal).medianMiss,
      ts70Miss: errorMetrics(ts70Final).miss,
      ts50Miss: errorMetrics(ts50Final).miss,
    },
    {
      name: "size + growth + fitted age",
      looMiss: errorMetrics(looAgeFit).miss,
      looMedian: errorMetrics(looAgeFit).medianMiss,
      ts70Miss: errorMetrics(ts70AgeFit).miss,
      ts50Miss: errorMetrics(ts50AgeFit).miss,
    },
    {
      name: "size + growth + saturating age",
      looMiss: errorMetrics(satLoo.errors).miss,
      looMedian: errorMetrics(satLoo.errors).medianMiss,
      ts70Miss: errorMetrics(sat70.errors).miss,
      ts50Miss: errorMetrics(sat50.errors).miss,
    },
  ];

  // Bands from the final specification's LOO absolute errors. Rounded to
  // 4 decimals HERE, in the backtest result, so every downstream consumer
  // (row bands, verdicts, dataset summary, page refit) uses the same
  // stored values instead of full precision.
  const absFinal = looFinal.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const band80 = round4(Math.pow(10, quantileSorted(absFinal, BAND_Q)));
  const haircut = round4(Math.pow(10, quantileSorted(absFinal, HAIRCUT_Q)));
  const looSd = looSdOf(looFinal);

  // Bootstrap: each age form against the final specification.
  const bootLog1p = pairedBootstrap(looAgeFit, looFinal);
  const bootSat = pairedBootstrap(satLoo.errors, looFinal);

  // Full-data age coefficients and the would-be age factor range over board rows.
  const ageBeta = huberFit(
    comps.map(designSizeAge),
    y,
  );
  const factors = boardAges.map((age) => Math.pow(10, ageBeta[2] * ageFeature(age)));
  const fullTau = pickTauNestedCV(comps);
  const satBeta = huberFit(
    comps.map(designSizeMaturity(fullTau)),
    y,
  );

  const looTauCounts: Record<string, number> = {};
  for (const t of satLoo.taus) looTauCounts[String(t)] = (looTauCounts[String(t)] ?? 0) + 1;

  const datedCount = comps.filter((r) => r.listedAt !== null).length;
  return {
    curve,
    specs,
    ablation,
    band80,
    haircut,
    looSd,
    ageLog1p: {
      ...bootLog1p,
      coef: ageBeta[2],
      wouldBeMin: Math.min(...factors),
      wouldBeMax: Math.max(...factors),
    },
    ageSaturating: {
      ...bootSat,
      coef: satBeta[2],
      fullTau,
      split70Tau: sat70.tau,
      split50Tau: sat50.tau,
      looTauCounts,
    },
    splitInfo: {
      dated: datedCount,
      undated: comps.length - datedCount,
      ts70: {
        train: split70.train.length,
        test: split70.test.length,
        cutoff: split70.test.length > 0 ? split70.test[0].listedAt : null,
      },
      ts50: {
        train: split50.train.length,
        test: split50.test.length,
        cutoff: split50.test.length > 0 ? split50.test[0].listedAt : null,
      },
    },
    looErrorsFinal: looFinal,
  };
}

// ---------------------------------------------------------------- verdict economics

export interface GasSchedule {
  setup: number;
  weekly: number;
}

export function gasSchedule(firstChain: string | null): GasSchedule {
  if (firstChain !== null) {
    const c = firstChain.toLowerCase();
    if (c.includes("ethereum")) return { setup: 12, weekly: 4 };
    if (c.includes("solana")) return { setup: 0.1, weekly: 0.1 };
    if (c.includes("bitcoin")) return { setup: 3, weekly: 3 };
  }
  return { setup: 1, weekly: 1 };
}

export function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

export function tierCapital(tvl: number): number {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 150;
  if (tvl >= 1e8) return 100;
  return 50;
}

export type Verdict = "FARM" | "THIN" | "SKIP";

export interface Economics {
  curveValue: number;
  growthPct: number;
  growthMultiplier: number;
  implied: number;
  bandLow: number;
  bandHigh: number;
  gross: number;
  cost: number;
  net: number;
  netLow: number;
  gasTotal: number;
  hold: number;
  verdict: Verdict;
}

export function economics(
  tvl: number,
  pct: number | null,
  age: number | null,
  firstChain: string | null,
  curve: { a: number; b: number },
  band80: number,
  haircut: number,
): Economics {
  const curveValue = Math.pow(10, curve.a + curve.b * sizeX(tvl));
  const mult = growthMult(pct);
  const implied = Math.max(1, Math.min(IMPLIED_CAP, Math.round(curveValue * mult)));
  const bandLow = Math.max(1, Math.round(implied / band80));
  const bandHigh = Math.round(implied * band80);
  const hold = holdDays(age);
  const gas = gasSchedule(firstChain);
  const gasTotal = round2(gas.setup + gas.weekly * Math.ceil(hold / 7));
  const gross = YARDSTICK_USD * (implied / tvl) * SHARE;
  const cost = gasTotal + YARDSTICK_USD * HURDLE * (hold / 365);
  const net = gross - cost;
  const netLow = gross / haircut - cost;
  const verdict: Verdict = netLow > 0 ? "FARM" : net > 0 ? "THIN" : "SKIP";
  return {
    curveValue,
    growthPct: clampPct(pct),
    growthMultiplier: mult,
    implied,
    bandLow,
    bandHigh,
    gross: round2(gross),
    cost: round2(cost),
    net: round2(net),
    netLow: round2(netLow),
    gasTotal,
    hold,
    verdict,
  };
}

// ---------------------------------------------------------------- farm plans

export interface FarmContext {
  verdict: Verdict;
  category: string | null;
  firstChain: string | null;
  tier: number;
  hold: number;
  net: number;
  netLow: number;
  setupGas: number;
  weeklyGas: number;
}

interface CategoryGroup {
  keys: string[];
  exactChain?: boolean;
  main: string;
  weekly: string;
  risk: string;
}

const CATEGORY_GROUPS: CategoryGroup[] = [
  {
    keys: ["curator", "allocator"],
    main: "Deposit {pos} into the vault on {chain} through the protocol's official app",
    weekly: "Top up the vault or check the position and collect any points",
    risk: "vault withdrawal terms and any lock-up",
  },
  {
    keys: ["perpetual", "derivative", "interest-rate", "interest rate"],
    main: "Open a margined position of {pos} on {chain} with a small hedge on the other side",
    weekly: "Check the margined position, rebalance the hedge, and keep the position open",
    risk: "liquidation risk and the health of the hedge",
  },
  {
    keys: ["basis"],
    main: "Open a delta-neutral basis position of {pos} on {chain}",
    weekly: "Check the basis position and rebalance the hedge to stay delta-neutral",
    risk: "funding and liquidation risk on both legs",
  },
  {
    keys: ["lend", "cdp", "collateral"],
    main: "Supply {pos} to the lending market on {chain}",
    weekly: "Check the supplied position and top it up if the market moved",
    risk: "health factor and liquidation risk",
  },
  {
    keys: ["prediction"],
    main: "Take a {pos} position in an open market on {chain}",
    weekly: "Review the open markets and keep one live position",
    risk: "the market resolution rules",
  },
  {
    keys: ["bridge"],
    main: "Bridge {pos} to {chain} and put the funds to work in the protocol's main app",
    weekly: "Check the bridged funds and keep them working in the main app",
    risk: "bridge delays and destination-chain fees",
  },
  {
    keys: ["dex", "liquidity manager", "amm"],
    main: "Provide {pos} of liquidity on {chain} in the protocol's main pool",
    weekly: "Check the liquidity position and rebalance the range if needed",
    risk: "impermanent loss",
  },
  {
    keys: ["staking", "restaking"],
    main: "Stake {pos} on {chain} through the protocol's official staking flow",
    weekly: "Check the staked position and restake or collect any rewards",
    risk: "unbonding delays",
  },
  {
    keys: ["rwa"],
    main: "Mint {pos} of the yield-bearing asset on {chain}",
    weekly: "Check the minted asset and its yield accrual",
    risk: "the redemption window",
  },
  {
    keys: ["stablecoin", "dual-token", "dual token"],
    main: "Mint or deposit {pos} of the stable asset on {chain}",
    weekly: "Check the stable position and its peg",
    risk: "peg risk",
  },
  {
    keys: ["yield", "farm", "aggregator"],
    main: "Deposit {pos} into the yield vault on {chain}",
    weekly: "Check the vault position and harvest or compound",
    risk: "the withdrawal queue",
  },
  {
    keys: ["insurance"],
    main: "Buy {pos} of cover on {chain}",
    weekly: "Check the cover position and its expiry",
    risk: "cover terms and claim windows",
  },
  {
    keys: ["payment", "card"],
    main: "Deposit {pos} on {chain} and make one spend through the protocol",
    weekly: "Make one more spend and check the balance",
    risk: "spending and withdrawal terms",
  },
  {
    keys: ["governance"],
    main: "Stake {pos} and cast a vote on {chain}",
    weekly: "Vote on any new proposal and check the stake",
    risk: "unbonding delays and vote timing",
  },
  {
    keys: ["index"],
    main: "Buy {pos} of the index on {chain}",
    weekly: "Check the index position and rebalance if the weights moved",
    risk: "rebalance and withdrawal terms",
  },
  {
    keys: ["otc"],
    main: "Deposit {pos} and complete one OTC trade on {chain}",
    weekly: "Check for a new OTC listing and keep the deposit working",
    risk: "settlement and withdrawal terms",
  },
  {
    keys: ["btc", "bitcoin"],
    main: "Deposit {pos} of BTC on {chain}",
    weekly: "Check the BTC deposit and its rewards",
    risk: "withdrawal delays",
  },
  {
    keys: ["cedefi"],
    main: "Deposit {pos} into the vault on {chain}",
    weekly: "Check the vault position and top up if needed",
    risk: "vault withdrawal terms",
  },
  {
    keys: [],
    exactChain: true,
    main: "Bridge {pos} to {chain} and use the main app",
    weekly: "Use the main app once and check the position",
    risk: "bridge delays",
  },
];

const GENERIC_GROUP: CategoryGroup = {
  keys: [],
  main: "Deposit {pos} through the protocol's official app on {chain}",
  weekly: "Check the position and keep it qualifying",
  risk: "withdrawal terms",
};

export function categoryGroup(category: string | null): CategoryGroup {
  if (category === null) return GENERIC_GROUP;
  const lower = category.toLowerCase();
  for (const g of CATEGORY_GROUPS) {
    if (g.exactChain) {
      if (lower === "chain") return g;
      continue;
    }
    for (const k of g.keys) {
      if (lower.includes(k)) return g;
    }
  }
  return GENERIC_GROUP;
}

export function fmtMoney(v: number): string {
  const abs = Math.abs(v).toFixed(2);
  return v < 0 ? `-$${abs}` : `$${abs}`;
}

function joinStep(text: string, cost: string, time: string): string {
  let action = text.trim();
  const suffix = `. Cost: ${cost}. Time: ${time}`;
  // Too short: add a hold-and-check sentence.
  while ((action + suffix).length < 20) {
    action += " Hold and check the position weekly.";
  }
  let joined = action + suffix;
  // Too long: cut the action text with an ellipsis, keeping Cost/Time visible.
  if (joined.length > 600) {
    const maxAction = 600 - suffix.length - 3;
    action = action.slice(0, Math.max(0, maxAction)) + "...";
    joined = action + suffix;
  }
  return joined;
}

export function buildFarmSteps(ctx: FarmContext): string[] {
  const group = categoryGroup(ctx.category);
  const chain = ctx.firstChain ?? "the protocol's chain";
  const weeks = Math.ceil(ctx.hold / 7);
  const pos = ctx.verdict === "SKIP" ? "$10.00" : fmtMoney(ctx.tier);
  const fill = (t: string): string => t.replace("{pos}", pos).replace("{chain}", chain);

  const step1 =
    `Verdict ${ctx.verdict}: the $1,000 yardstick at a 10% share leaves net ` +
    `${fmtMoney(ctx.net)} after costs at a 4% hurdle (low-end net ${fmtMoney(ctx.netLow)}). ` +
    `Use a fresh wallet and only the links from the protocol's official docs`;
  let step2 = fill(group.main) + `. Allow ${fmtMoney(ctx.setupGas)} for setup gas`;
  if (ctx.verdict === "SKIP") step2 += ". Keep this a small test position";
  const step3 = `${fill(group.weekly)}. Repeat this check every week until the hold ends`;
  const step4 =
    "Open the protocol's points or rewards page, confirm the position is counting, " +
    "and save a dated screenshot of the balance";
  const step5 =
    `Hold for at least ${ctx.hold} days, completing one qualifying action each week ` +
    `to keep the position active`;
  const step6 =
    "Exit rule: if TVL falls 15% week over week, or the points page stops counting " +
    "the position for two weeks in a row, start exiting and do not add capital";
  const step7 = `Before exiting, check ${group.risk} and withdraw a small test amount first`;
  const step8 =
    "Keep a farm log of every deposit and screenshot, and claim only through " +
    "official links — never pay to claim";

  const steps: string[] = [];
  steps.push(joinStep(step1, "$0.00", "Week 1"));
  steps.push(joinStep(step2, pos, "Week 1"));
  if (ctx.verdict !== "SKIP") {
    steps.push(joinStep(step3, fmtMoney(ctx.weeklyGas), "Week 2"));
  }
  steps.push(joinStep(step4, "$0.00", "Week 2"));
  steps.push(joinStep(step5, "$0.00", `Weeks 1-${weeks}`));
  if (ctx.verdict === "FARM") {
    steps.push(joinStep(step6, "$0.00", `Weeks 1-${weeks}`));
  }
  steps.push(joinStep(step7, fmtMoney(ctx.weeklyGas), "Before exit"));
  steps.push(joinStep(step8, "$0.00", "Ongoing"));
  return steps;
}

// ---------------------------------------------------------------- board rows

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
  token_status: string;
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
    gross_usd: number;
    cost_usd: number;
    hold_days: number;
    gas_usd: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export function buildBoardRows(
  snapshot: Snapshot,
  curve: { a: number; b: number },
  band80: number,
  haircut: number,
): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const p of rankableProtocols(snapshot.protocols)) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const firstChain = p.chains.length > 0 ? p.chains[0] : null;
    const econ = economics(p.tvl_usd, p.change_7d, age, firstChain, curve, band80, haircut);
    const gas = gasSchedule(firstChain);
    const steps = buildFarmSteps({
      verdict: econ.verdict,
      category: p.category,
      firstChain,
      tier: tierCapital(p.tvl_usd),
      hold: econ.hold,
      net: econ.net,
      netLow: econ.netLow,
      setupGas: gas.setup,
      weeklyGas: gas.weekly,
    });
    rows.push({
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: "pre-token",
      age_days: age,
      implied_value_usd: econ.implied,
      band_low_usd: econ.bandLow,
      band_high_usd: econ.bandHigh,
      verdict: econ.verdict,
      net_usd: econ.net,
      model: {
        curve_value_usd: Math.round(econ.curveValue),
        growth_pct: econ.growthPct,
        growth_multiplier: round4(econ.growthMultiplier),
        gross_usd: econ.gross,
        cost_usd: econ.cost,
        hold_days: econ.hold,
        gas_usd: econ.gasTotal,
        age_days: age,
      },
      farm_steps: steps,
    });
  }
  rows.sort((a, b) => {
    if (a.implied_value_usd !== b.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
  return rows;
}

/** Gate rules over the board; throws with a clear message on violation. */
export function validateBoard(rows: BoardRow[], watchlist: string[]): void {
  if (rows.length < 100 || rows.length > 4000) {
    throw new Error(`board: ${rows.length} rows, need 100-4000`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (seen.has(r.slug)) throw new Error(`board: duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (r.rank !== i + 1) throw new Error(`board: rank ${r.rank} at position ${i + 1}`);
    if (i > 0 && rows[i].implied_value_usd > rows[i - 1].implied_value_usd) {
      throw new Error("board: implied value rises with rank");
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > IMPLIED_CAP) {
      throw new Error(`board: bad implied value for ${r.slug}`);
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      throw new Error(`board: ${r.slug} has ${r.farm_steps.length} farm steps`);
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) throw new Error(`board: farm step length ${len} for ${r.slug}`);
    }
  }
  const allSame = rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd);
  if (rows.length >= 2 && allSame) throw new Error("board: all implied values identical");
  for (const slug of watchlist) {
    if (!seen.has(slug)) throw new Error(`board: watchlist slug ${slug} missing`);
  }
}

// ---------------------------------------------------------------- live rows

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

export function buildLiveRows(protocols: Proto[]): LiveRow[] {
  const rows = protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.category !== "CEX")
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      ratio: Math.round((p.mcap_usd as number) / p.tvl_usd * 1e4) / 1e4,
      change_7d: p.change_7d,
    }));
  rows.sort((a, b) => {
    if (a.mcap_usd !== b.mcap_usd) return b.mcap_usd - a.mcap_usd;
    if (a.tvl_usd !== b.tvl_usd) return b.tvl_usd - a.tvl_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return rows.slice(0, 24);
}
