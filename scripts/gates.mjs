// Local gate checks mirroring the sealed scorer's seven rows, plus the
// entry's own structural checks. Usage:
//   node scripts/gates.mjs --out <dir> --input <snapshot.json|dir>
// Exits non-zero on any failure; prints one PASS/FAIL line per gate.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDossier } from "../vendor/makefun-board.ts";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outDir = resolve(repoRoot, opt("--out", "out"));
const inputArg = opt("--input", "/input/snapshot.json");

let failures = 0;
function gate(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures++;
}

function readSnapshot() {
  let file = inputArg;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "snapshot.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function listFiles(dir, base = "") {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

function parsePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const whole = buf.length >= 12 && buf.subarray(buf.length - 12).equals(iend);
  return { width, height, whole };
}

const snap = readSnapshot();
const slugSet = new Set(snap.protocols.map((p) => p.slug));

// G1: dashboard files.
{
  const dir = join(outDir, "dashboard");
  const files = listFiles(dir);
  const totalBytes = files.reduce((s, f) => s + statSync(join(dir, f)).size, 0);
  const hasIndex = files.includes("index.html");
  const hasCss = files.some((f) => f.endsWith(".css"));
  const hasJs = files.some((f) => f.endsWith(".js"));
  const nameOk = files.every((f) => {
    const base = f.split("/").pop();
    return /^[A-Za-z0-9._-]{1,128}$/.test(base) && !base.startsWith(".") && !base.startsWith("-");
  });
  const noDotDirs = files.every((f) => !f.split("/").slice(0, -1).some((d) => d.startsWith(".")));
  let noHttp = true;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    if (text.includes("http://") || text.includes("https://")) noHttp = false;
  }
  gate("dashboard_files",
    hasIndex && hasCss && hasJs && files.length <= 400 && totalBytes <= 4 * 1024 * 1024 && nameOk && noDotDirs && noHttp,
    `${files.length} files, ${totalBytes} bytes, index/css/js=${hasIndex}/${hasCss}/${hasJs}, namesOk=${nameOk}, noHttp=${noHttp}`);
}

// G2+G3+G4+G5: board.
const boardPath = join(outDir, "board.json");
const boardBytes = statSync(boardPath).size;
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const rows = board.rows;
{
  let ok = Array.isArray(rows) && rows.length >= 100 && rows.length <= 4000 && boardBytes <= 8 * 1024 * 1024;
  const seen = new Set();
  for (const r of rows) {
    if (!slugSet.has(r.slug) || seen.has(r.slug)) ok = false;
    seen.add(r.slug);
    if (typeof r.name !== "string" || r.name.length === 0) ok = false;
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) ok = false;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) ok = false;
    if (!Array.isArray(r.farm_steps)) ok = false;
  }
  gate("board_file", ok, `${rows.length} rows, ${boardBytes} bytes, slugs unique + in snapshot`);
}
{
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  let ranksOk = byRank.every((r, i) => r.rank === i + 1);
  let sortedOk = true;
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) sortedOk = false;
  }
  const allSame = rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd);
  gate("sorted_by_value", ranksOk && sortedOk && !allSame,
    `ranks 1..${rows.length} exact=${ranksOk}, non-increasing=${sortedOk}, allSame=${allSame}`);
}
{
  const present = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !present.has(s));
  gate("coverage", missing.length === 0,
    `${snap.watchlist.length - missing.length}/${snap.watchlist.length} watchlist slugs covered`);
}
{
  let ok = true;
  let bad = "";
  const want = { SKIP: 6, THIN: 7, FARM: 8 };
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) { ok = false; bad = `${r.slug} count`; break; }
    if (want[r.verdict] !== undefined && r.farm_steps.length !== want[r.verdict]) {
      ok = false; bad = `${r.slug} ${r.verdict} has ${r.farm_steps.length} steps`; break;
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600 || !s.includes("Cost: ") || !s.includes("Time: ")) {
        ok = false; bad = `${r.slug} step len ${len}`; break;
      }
    }
    if (!ok) break;
  }
  gate("farm_steps", ok, ok ? "counts 6/7/8 by verdict, lengths 20-600, Cost/Time present" : bad);
}

// G6: screenshots.
{
  const dir = join(outDir, "screenshots");
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  const plainName = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  let ok = files.length >= 3 && files.length <= 4;
  const dims = [];
  for (const f of files) {
    if (!plainName.test(f)) ok = false;
    const buf = readFileSync(join(dir, f));
    if (buf.length > 512 * 1024) ok = false;
    const png = parsePng(buf);
    if (!png || !png.whole) { ok = false; continue; }
    const long = Math.max(png.width, png.height);
    const short = Math.min(png.width, png.height);
    if (long > 1440 || short < 800) ok = false;
    dims.push(`${f} ${png.width}x${png.height} ${buf.length}B`);
  }
  gate("screenshots", ok, dims.join("; "));
}

// G7: dossier matches, byte for byte.
{
  const dossierPath = join(outDir, "dossier.json");
  const existing = readFileSync(dossierPath);
  const rebuilt = Buffer.from(buildDossier(outDir, { text_max_bytes: 65536 }));
  const identical = existing.equals(rebuilt);
  const parsed = JSON.parse(existing.toString("utf8"));
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const textBytes = Buffer.byteLength(text, "utf8");
  const dashDir = join(outDir, "dashboard");
  const dashFiles = listFiles(dashDir);
  let whole = true;
  for (const f of dashFiles) {
    const content = readFileSync(join(dashDir, f), "utf8");
    if (!text.includes(content)) whole = false;
  }
  gate("dossier_matches", identical && existing.length <= 1.5 * 1024 * 1024 && textBytes <= 65536 && whole,
    `byte-identical=${identical}, dossier ${existing.length} bytes, text ${textBytes}/65536 bytes, all ${dashFiles.length} dashboard files whole=${whole}`);
}

if (failures > 0) {
  console.log(`gates: ${failures} failure(s)`);
  process.exit(1);
}
console.log("gates: all 7 PASS");
