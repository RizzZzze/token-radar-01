// Token radar: snapshot in, ranked board + dashboard data + dossier out.
//
// Reads /input/snapshot.json (or --input <file|dir>), runs the backtest,
// fits the size curve, ranks every rankable pre-token protocol, and writes
// board.json, data.js, dashboard/, screenshots/ and dossier.json to
// /output (or $MAKEFUN_OUTPUT_DIR). Deterministic: no clock, no randomness
// beyond the fixed-seed bootstrap inside the model.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ageDays,
  BAND_Q,
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  buildBoardRows,
  buildLiveRows,
  cleanComps,
  COMP_RATIO_HI,
  COMP_RATIO_LO,
  exclusionReason,
  GROWTH_WEIGHT,
  HAIRCUT_Q,
  HUBER_C,
  HUBER_MAX_ITER,
  HURDLE,
  isPreToken,
  MODEL_VERSION,
  parseSnapshot,
  rankableProtocols,
  runBacktest,
  SHARE,
  TAU_GRID,
  toFitRow,
  validateBoard,
  YARDSTICK_USD,
  type BoardRow,
  type BacktestResult,
  type FitRow,
  type Snapshot,
} from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

interface CliOptions {
  input: string;
  outputDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  let input = "/input/snapshot.json";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      if (i + 1 >= argv.length) throw new Error("--input needs a value");
      input = argv[++i];
    } else if (arg.startsWith("--input=")) {
      input = arg.slice("--input=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { input, outputDir: process.env.MAKEFUN_OUTPUT_DIR ?? "/output" };
}

function readSnapshot(input: string): Snapshot {
  let file = input;
  if (existsSync(input) && statSync(input).isDirectory()) {
    file = join(input, "snapshot.json");
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return parseSnapshot(raw);
}

interface Dataset {
  snapshot: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocols: number;
    watchlist: number;
  };
  model: {
    version: string;
    growthWeight: number;
    compRatio: [number, number];
    huberC: number;
    huberIters: number;
    bandQuantile: number;
    haircutQuantile: number;
    yardstickUsd: number;
    share: number;
    hurdle: number;
    tauGrid: number[];
    bootstrapSeed: number;
    bootstrapResamples: number;
    curve: { a: number; b: number };
    band80: number;
    haircut: number;
    looSd: number;
  };
  counts: {
    board: number;
    watchlist: number;
    live: number;
    excluded: number;
    comps: number;
    protocols: number;
    excludedReasons: Record<string, number>;
  };
  backtest: {
    specs: {
      name: string;
      looMiss: number;
      looWithin3: number;
      ts70Miss: number;
      ts70Within3: number;
    }[];
    ablation: {
      name: string;
      looMiss: number;
      looMedian: number;
      ts70Miss: number;
      ts50Miss: number;
    }[];
    age: {
      log1p: {
        diff: number;
        ciLow: number;
        ciHigh: number;
        coef: number;
        wouldBeMin: number;
        wouldBeMax: number;
      };
      saturating: {
        diff: number;
        ciLow: number;
        ciHigh: number;
        coef: number;
        fullTau: number;
        split70Tau: number;
        split50Tau: number;
        looTauCounts: Record<string, number>;
      };
      splits: {
        dated: number;
        undated: number;
        ts70: { train: number; test: number; cutoff: string | null };
        ts50: { train: number; test: number; cutoff: string | null };
      };
      decision: string;
    };
  };
  comps: {
    slug: string;
    tvl: number;
    mcap: number;
    pct: number | null;
    age: number | null;
    listedAt: string | null;
    category: string | null;
    nChains: number;
  }[];
  verdicts: Record<string, number>;
  rows: {
    rank: number;
    slug: string;
    name: string;
    category: string | null;
    chains: string[];
    tvl: number;
    pct: number | null;
    listedAt: string | null;
    age: number | null;
    watchlist: boolean;
    implied: number;
    bandLow: number;
    bandHigh: number;
    verdict: string;
    net: number;
    gross: number;
    cost: number;
    hold: number;
    gas: number;
    curveValue: number;
    growthPct: number;
    growthMult: number;
  }[];
  live: {
    slug: string;
    name: string;
    category: string | null;
    tvl: number;
    mcap: number;
    ratio: number;
    pct: number | null;
  }[];
}

function buildDataset(
  snapshot: Snapshot,
  comps: FitRow[],
  boardRows: BoardRow[],
  bt: BacktestResult,
): Dataset {

  const excludedReasons: Record<string, number> = {
    category: 0,
    version: 0,
    wrapped: 0,
    exchange: 0,
  };
  let excluded = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const reason = exclusionReason(p);
    if (reason !== null) {
      excluded++;
      excludedReasons[reason]++;
    }
  }

  const verdicts: Record<string, number> = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of boardRows) verdicts[r.verdict]++;

  const watchlist = new Set(snapshot.watchlist);
  const live = buildLiveRows(snapshot.protocols);

  return {
    snapshot: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
    },
    model: {
      version: MODEL_VERSION,
      growthWeight: GROWTH_WEIGHT,
      compRatio: [COMP_RATIO_LO, COMP_RATIO_HI],
      huberC: HUBER_C,
      huberIters: HUBER_MAX_ITER,
      bandQuantile: BAND_Q,
      haircutQuantile: HAIRCUT_Q,
      yardstickUsd: YARDSTICK_USD,
      share: SHARE,
      hurdle: HURDLE,
      tauGrid: [...TAU_GRID],
      bootstrapSeed: BOOTSTRAP_SEED,
      bootstrapResamples: BOOTSTRAP_RESAMPLES,
      curve: bt.curve,
      band80: bt.band80,
      haircut: bt.haircut,
      looSd: bt.looSd,
    },
    counts: {
      board: boardRows.length,
      watchlist: snapshot.watchlist.length,
      live: live.length,
      excluded,
      comps: comps.length,
      protocols: snapshot.protocols.length,
      excludedReasons,
    },
    backtest: {
      specs: bt.specs,
      ablation: bt.ablation,
      age: {
        log1p: {
          diff: bt.ageLog1p.diff,
          ciLow: bt.ageLog1p.ciLow,
          ciHigh: bt.ageLog1p.ciHigh,
          coef: bt.ageLog1p.coef,
          wouldBeMin: bt.ageLog1p.wouldBeMin,
          wouldBeMax: bt.ageLog1p.wouldBeMax,
        },
        saturating: {
          diff: bt.ageSaturating.diff,
          ciLow: bt.ageSaturating.ciLow,
          ciHigh: bt.ageSaturating.ciHigh,
          coef: bt.ageSaturating.coef,
          fullTau: bt.ageSaturating.fullTau,
          split70Tau: bt.ageSaturating.split70Tau,
          split50Tau: bt.ageSaturating.split50Tau,
          looTauCounts: bt.ageSaturating.looTauCounts,
        },
        splits: bt.splitInfo,
        decision:
          "Both age forms lose in leave-one-out with bootstrap intervals excluding zero " +
          "on the worse side, and collapse in time splits, so price carries no age term. " +
          "Age still sets the farm-plan hold window and is shown on every row.",
      },
    },
    comps: comps.map((c) => ({
      slug: c.slug,
      tvl: c.tvl,
      mcap: c.mcap,
      pct: c.pct,
      age: c.age,
      listedAt: c.listedAt,
      category: c.category,
      nChains: c.nChains,
    })),
    verdicts,
    rows: boardRows.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: [...r.chains],
      tvl: r.tvl_usd,
      pct: r.change_7d,
      listedAt: r.listed_at,
      age: r.age_days,
      watchlist: watchlist.has(r.slug),
      implied: r.implied_value_usd,
      bandLow: r.band_low_usd,
      bandHigh: r.band_high_usd,
      verdict: r.verdict,
      net: r.net_usd,
      gross: r.model.gross_usd,
      cost: r.model.cost_usd,
      hold: r.model.hold_days,
      gas: r.model.gas_usd,
      curveValue: r.model.curve_value_usd,
      growthPct: r.model.growth_pct,
      growthMult: r.model.growth_multiplier,
    })),
    live: live.map((l) => ({
      slug: l.slug,
      name: l.name,
      category: l.category,
      tvl: l.tvl_usd,
      mcap: l.mcap_usd,
      ratio: l.ratio,
      pct: l.change_7d,
    })),
  };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const snapshot = readSnapshot(opts.input);
  const root = dirname(fileURLToPath(import.meta.url));

  // Clean comps in slug order: fold positions and every fit read this order.
  const comps = cleanComps(snapshot.protocols)
    .map((p) => toFitRow(p, snapshot.as_of))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // One backtest run drives both the board and the dashboard record.
  const boardProtos = rankableProtocols(snapshot.protocols);
  const boardAges = boardProtos.map((p) => ageDays(snapshot.as_of, p.listed_at));
  const bt = runBacktest(comps, boardAges);
  const boardRows = buildBoardRows(snapshot, bt.curve, bt.band80, bt.haircut);
  validateBoard(boardRows, snapshot.watchlist);
  const dataset = buildDataset(snapshot, comps, boardRows, bt);

  mkdirSync(opts.outputDir, { recursive: true });
  writeFileSync(join(opts.outputDir, "board.json"), JSON.stringify({ rows: boardRows }, null, 2) + "\n", "utf8");
  writeFileSync(join(opts.outputDir, "data.js"), `window.RADAR=${JSON.stringify(dataset)};\n`, "utf8");

  const dashboardSrc = join(root, "dashboard");
  if (!existsSync(dashboardSrc) || !statSync(dashboardSrc).isDirectory()) {
    throw new Error("dashboard/ directory missing from the repository");
  }
  cpSync(dashboardSrc, join(opts.outputDir, "dashboard"), { recursive: true });

  const screenshotsSrc = join(root, "screenshots");
  if (!existsSync(screenshotsSrc) || !statSync(screenshotsSrc).isDirectory()) {
    throw new Error("screenshots/ directory missing from the repository");
  }
  cpSync(screenshotsSrc, join(opts.outputDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(opts.outputDir, { text_max_bytes: 65536 });
  writeFileSync(join(opts.outputDir, "dossier.json"), dossier);
}

try {
  main();
} catch (err) {
  console.error(`radar: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
