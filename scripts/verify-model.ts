// Verification runner: prints every §7 number the model procedures must
// reproduce, plus diagnostics for definitions pinned only by those numbers.
// Not part of the graded program; run with: node scripts/verify-model.ts
import { readFileSync } from "node:fs";
import {
  ageDays,
  buildBoardRows,
  buildLiveRows,
  cleanComps,
  exclusionReason,
  isPreToken,
  looErrors,
  meanOf,
  medianOf,
  parseSnapshot,
  rankableProtocols,
  runBacktest,
  SPECS,
  toFitRow,
} from "../lib/model.ts";

const inputPath = process.argv[2] ??
  "/home/hatch/workspace/make-fun-bounty/account/token-radar-kit/token-radar-01-kit-current/input/snapshot.json";
const snap = parseSnapshot(JSON.parse(readFileSync(inputPath, "utf8")));
const comps = cleanComps(snap.protocols);
const fitRows = comps.map((p) => toFitRow(p, snap.as_of));
const boardProtos = rankableProtocols(snap.protocols);
const boardAges = boardProtos.map((p) => ageDays(snap.as_of, p.listed_at));

const f4 = (v: number): string => v.toFixed(4);

console.log("counts: protocols=" + snap.protocols.length +
  " watchlist=" + snap.watchlist.length +
  " rankable=" + boardProtos.length +
  " comps=" + comps.length);
const excl: Record<string, number> = {};
for (const p of snap.protocols) {
  if (!isPreToken(p)) continue;
  const r = exclusionReason(p);
  if (r !== null) excl[r] = (excl[r] ?? 0) + 1;
}
console.log("excluded: " + JSON.stringify(excl));

const bt = runBacktest(fitRows, boardAges);
console.log("curve: a=" + bt.curve.a + " b=" + bt.curve.b);
console.log("--- 12 specs (looMiss looWithin3 ts70Miss ts70Within3) ---");
for (const s of bt.specs) {
  console.log(`${s.name}: ${f4(s.looMiss)} ${f4(s.looWithin3)} ${f4(s.ts70Miss)} ${f4(s.ts70Within3)}`);
}
console.log("--- ablation (looMiss looMedian ts70Miss ts50Miss) ---");
for (const a of bt.ablation) {
  console.log(`${a.name}: ${f4(a.looMiss)} ${f4(a.looMedian)} ${f4(a.ts70Miss)} ${f4(a.ts50Miss)}`);
}
console.log("band80=" + f4(bt.band80) + " haircut=" + f4(bt.haircut) + " looSd=" + f4(bt.looSd));
console.log("splitInfo: " + JSON.stringify(bt.splitInfo));
console.log("ageLog1p: diff=" + f4(bt.ageLog1p.diff) +
  " CI=[" + f4(bt.ageLog1p.ciLow) + "," + f4(bt.ageLog1p.ciHigh) + "]" +
  " coef=" + bt.ageLog1p.coef +
  " wouldBe=[" + f4(bt.ageLog1p.wouldBeMin) + "," + f4(bt.ageLog1p.wouldBeMax) + "]");
console.log("ageSat: diff=" + f4(bt.ageSaturating.diff) +
  " CI=[" + f4(bt.ageSaturating.ciLow) + "," + f4(bt.ageSaturating.ciHigh) + "]" +
  " coef=" + bt.ageSaturating.coef + " fullTau=" + bt.ageSaturating.fullTau +
  " split70Tau=" + bt.ageSaturating.split70Tau + " split50Tau=" + bt.ageSaturating.split50Tau +
  " looTauCounts=" + JSON.stringify(bt.ageSaturating.looTauCounts));

// loo_sd definition candidates.
const errs = bt.looErrorsFinal;
const meanErr = meanOf(errs);
const absErrs = errs.map((e) => Math.abs(e));
const meanAbs = meanOf(absErrs);
const sd = (vals: number[], m: number, ddof: number): number =>
  Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - ddof));
console.log("looSd candidates: signedSample=" + f4(sd(errs, meanErr, 1)) +
  " signedPop=" + f4(sd(errs, meanErr, 0)) +
  " absSample=" + f4(sd(absErrs, meanAbs, 1)) +
  " absPop=" + f4(sd(absErrs, meanAbs, 0)) +
  " meanSigned=" + f4(meanErr) +
  " medianAbs=" + f4(medianOf(absErrs)));

// Board + verdicts.
const rows = buildBoardRows(snap, bt.curve, bt.band80, bt.haircut);
const verdicts: Record<string, number> = {};
for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
console.log("board rows=" + rows.length + " verdicts=" + JSON.stringify(verdicts));
console.log("live rows=" + buildLiveRows(snap.protocols).length);
console.log("top3: " + rows.slice(0, 3).map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}:${r.verdict}`).join(" | "));
console.log("looErrorsFinal length=" + errs.length + " (spec5 check)");
// Cross-check: spec5 LOO recomputed standalone must equal backtest's.
const standalone = looErrors(SPECS[4].fitter, fitRows);
let maxDiff = 0;
for (let i = 0; i < errs.length; i++) maxDiff = Math.max(maxDiff, Math.abs(errs[i] - standalone[i]));
console.log("standalone LOO maxDiff=" + maxDiff);
