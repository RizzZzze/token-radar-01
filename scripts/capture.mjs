// Capture the four dashboard screenshots from a live build and verify the
// browser agreement test: the page's recomputed implied values and farm
// plans must match board.json exactly on all rows.
//
// Usage: node scripts/capture.mjs [--out <dir>] [--shots <dir>] [--port <n>]
// Defaults: --out out --shots screenshots --port 9333.
// Serves <out> over loopback, drives headless Chromium over CDP, and writes
// 1-board.png, 2-detail.png, 3-filtered.png, 4-method.png into <shots>.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outDir = resolve(repoRoot, opt("--out", "out"));
const shotsDir = resolve(repoRoot, opt("--shots", "screenshots"));
const debugPort = Number(opt("--port", "9333"));
const chromePath = process.env.CHROME_PATH ??
  join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
};

function serve() {
  return new Promise((resolveListen) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/dashboard/index.html";
      const file = join(outDir, path);
      if (!file.startsWith(outDir) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDebugger() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("chromium debugger did not come up");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async evaluate(sessionId, expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`page error: ${JSON.stringify(res.exceptionDetails).slice(0, 500)}`);
    }
    return res.result.value;
  }
}

async function main() {
  const board = JSON.parse(readFileSync(join(outDir, "board.json"), "utf8"));
  const rows = board.rows;
  const topFarm = rows.find((r) => r.verdict === "FARM");
  if (!topFarm) throw new Error("no FARM row for the detail screenshot");
  const views = [
    { name: "1-board.png", hash: "#board" },
    { name: "2-detail.png", hash: `#detail/${topFarm.slug}` },
    { name: "3-filtered.png", hash: "#filtered?verdict=FARM" },
    { name: "4-method.png", hash: "#method" },
  ];

  const server = await serve();
  const port = server.address().port;
  const profile = join(tmpdir(), `radar-capture-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    "--no-first-run",
    "--disable-extensions",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ], { stdio: "ignore" });

  let failures = 0;
  try {
    const version = await waitForDebugger();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    const cdp = new Cdp(ws);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    mkdirSync(shotsDir, { recursive: true });
    let agreement = null;
    for (const view of views) {
      const url = `http://127.0.0.1:${port}/dashboard/index.html${view.hash}`;
      await cdp.send("Page.navigate", { url }, sessionId);
      let ready = false;
      for (let i = 0; i < 240; i++) {
        await sleep(250);
        ready = await cdp.evaluate(sessionId, "window.__RADAR_READY__ === true").catch(() => false);
        if (ready) break;
      }
      if (!ready) throw new Error(`page never became ready for ${view.name}`);
      await cdp.evaluate(sessionId, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      if (agreement === null) {
        const check = await cdp.evaluate(sessionId, "window.__RADAR_CHECK__");
        const recomputed = await cdp.evaluate(sessionId, "window.__RADAR_RECOMPUTED__");
        const backtest = await cdp.evaluate(sessionId, "window.__RADAR_BACKTEST__");
        agreement = { check, recomputed, backtest };
      }
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const buf = Buffer.from(shot.data, "base64");
      const dest = join(shotsDir, view.name);
      writeFileSync(dest, buf);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
      console.log(`${view.name}: ${buf.length} bytes sha256:${hash} (1440x900)`);
    }
    if (cdp.exceptions.length > 0) {
      console.log("PAGE EXCEPTIONS:");
      for (const e of cdp.exceptions) console.log("  " + e);
      failures++;
    }

    // Agreement test: page recomputation vs board.json, every row.
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    let impliedMismatch = 0;
    let farmMismatch = 0;
    const farmDetails = [];
    for (const rec of agreement.recomputed) {
      const orig = bySlug.get(rec.slug);
      if (!orig) { impliedMismatch++; farmMismatch++; continue; }
      if (orig.implied_value_usd !== rec.implied) impliedMismatch++;
      const a = orig.farm_steps;
      const b = rec.farmSteps;
      if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
        farmMismatch++;
        if (farmDetails.length < 3) farmDetails.push(rec.slug);
      }
    }
    console.log(`agreement: rows=${agreement.recomputed.length} impliedMismatches=${impliedMismatch} farmMismatches=${farmMismatch}`);
    if (farmDetails.length > 0) console.log("farm mismatch slugs: " + farmDetails.join(", "));
    console.log(`page self-check: ${JSON.stringify(agreement.check)}`);
    if (impliedMismatch > 0 || farmMismatch > 0) failures++;

    // Backtest agreement: page recomputation vs data.js values.
    const dataJs = readFileSync(join(outDir, "data.js"), "utf8");
    const dataset = JSON.parse(dataJs.replace(/^window\.RADAR=/, "").replace(/;\n$/, ""));
    const bt = agreement.backtest;
    // Browser and Node JS engines differ by ~1 ULP on transcendentals, so
    // backtest floats agree to a relative 1e-9, not bit-for-bit. The hard
    // gates (implied + farm, above) are exact integers/strings and must be 0.
    let maxRel = 0;
    const displayDiffs = [];
    const cmp = (label, a, b) => {
      const rel = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
      if (rel > maxRel) maxRel = rel;
      if (a.toFixed(4) !== b.toFixed(4)) displayDiffs.push(`${label}: page=${a.toFixed(4)} file=${b.toFixed(4)}`);
      if (rel > 1e-9) console.log(`backtest diff ${label}: page=${a} file=${b} rel=${rel}`);
    };
    cmp("curve.a", bt.curve.a, dataset.model.curve.a);
    cmp("curve.b", bt.curve.b, dataset.model.curve.b);
    cmp("band80", bt.band80, dataset.model.band80);
    cmp("haircut", bt.haircut, dataset.model.haircut);
    cmp("looSd", bt.looSd, dataset.model.looSd);
    bt.specs.forEach((s, i) => {
      cmp(`spec${i}.looMiss`, s.looMiss, dataset.backtest.specs[i].looMiss);
      cmp(`spec${i}.ts70Miss`, s.ts70Miss, dataset.backtest.specs[i].ts70Miss);
    });
    bt.ablation.forEach((a, i) => {
      cmp(`abl${i}.looMiss`, a.looMiss, dataset.backtest.ablation[i].looMiss);
      cmp(`abl${i}.ts70Miss`, a.ts70Miss, dataset.backtest.ablation[i].ts70Miss);
      cmp(`abl${i}.ts50Miss`, a.ts50Miss, dataset.backtest.ablation[i].ts50Miss);
    });
    cmp("ageLog1p.diff", bt.ageLog1p.diff, dataset.backtest.age.log1p.diff);
    cmp("ageLog1p.ciLow", bt.ageLog1p.ciLow, dataset.backtest.age.log1p.ciLow);
    cmp("ageSat.diff", bt.ageSaturating.diff, dataset.backtest.age.saturating.diff);
    cmp("ageSat.ciHigh", bt.ageSaturating.ciHigh, dataset.backtest.age.saturating.ciHigh);
    console.log(`backtest max rel diff (page vs data.js): ${maxRel}`);
    if (displayDiffs.length > 0) {
      console.log("4-decimal display diffs (engine noise on near-unidentified fit):");
      for (const d of displayDiffs) console.log("  " + d);
    }
    if (maxRel > 1e-9) failures++;

    ws.close();
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`capture: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("capture: OK");
}

main().catch((err) => {
  console.error(`capture: ${err.message}`);
  process.exit(1);
});
