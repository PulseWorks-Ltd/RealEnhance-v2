// Reshape-check evaluation on the saved baseline/staged pairs in Test Images.
// Pairs each baseline ("Bedroom NN", "Living NN", "Diningroom NN", "Rental NN",
// "33 Kaipuke - Image NN", Karaka 02) with every staged version of the same
// room (Bedroom (Staged), Bedroom (Staged 2), "... - Staged N", "...-staged-*",
// Living (Staged), Kitchen), runs the Stage 2 reshape checks (brightness-matched
// framing + camera zoom), and writes results.json plus ghost-overlay contact
// sheets: baseline and staged blended 50/50, so doubled window / door /
// ceiling outlines mean the room moved. No AI calls.
//
//   npx tsx src/scripts/reshape-check-pairs.ts ["<output folder>"]
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { checkFraming, checkCameraAlignment, REFRAMED_MEDIAN_DIFF } from "../pipeline/stage2Masked/core";
import { REFRAMED_EARLY_MEDIAN_DIFF } from "../pipeline/stage2Masked/pipeline";

const TI = path.resolve(__dirname, "../../../Test Images");
const BASE_DIRS = ["Bedroom (Baseline)", "Living (Baseline)", "Kitchen"];
const STAGED_DIRS = ["Bedroom (Staged)", "Bedroom (Staged 2)", "Living (Staged)"];
const IMG = /\.(jpe?g|png|webp)$/i;
const SKIP = /(overlay|crop|alpha|extracted|mask|raw\.png|diff|region|wide|seam|zoning|resvariant|clearance|context|_maskcache)/i;
const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/\b0(\d)\b/g, "$1").trim();

type Pair = { group: string; base: string; staged: string };

function findPairs(): Pair[] {
  const baseFor = new Map<string, string>();
  for (const dir of BASE_DIRS) {
    for (const f of fs.readdirSync(path.join(TI, dir))) {
      const m = f.match(/^((?:Bedroom|Living|Diningroom|Rental|Kitchen) \d+|33 Kaipuke - Image \d+)\.(jpe?g|webp)$/i);
      if (m) baseFor.set(key(m[1]), path.join(TI, dir, f));
    }
  }
  baseFor.set(key("Karaka 02"), path.join(TI, "Kitchen", "Karaka - Image 02 Baseline.jpg"));
  const pairs: Pair[] = [];
  const add = (group: string, file: string) => {
    const name = path.basename(file);
    if (!IMG.test(name) || SKIP.test(name) || /baseline/i.test(name)) return;
    const m = name.match(/^(?:enhanced_)?((?:Bedroom|Living|Diningroom|Rental|Kitchen) ?\d+|33 Kaipuke - Image \d+|Karaka(?: - Image)? 02)/i);
    if (!m) return;
    const room = m[1].replace(/^(Bedroom|Living|Diningroom|Rental|Kitchen)(\d)/i, "$1 $2").replace(/Karaka - Image 02/i, "Karaka 02");
    const base = baseFor.get(key(room));
    if (!base || path.resolve(base) === path.resolve(file)) return;
    pairs.push({ group, base, staged: file });
  };
  for (const dir of STAGED_DIRS) for (const f of fs.readdirSync(path.join(TI, dir))) add(dir, path.join(TI, dir, f));
  for (const dir of BASE_DIRS) for (const f of fs.readdirSync(path.join(TI, dir))) {
    if (/(staged|Staged|composite|-2\.webp|aspectfix|tierrebuild|Decluttered)/.test(f)) add(dir, path.join(TI, dir, f));
  }
  return pairs;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function writeSheets(rows: any[], out: string) {
  const TW = 420, perSheet = 9, cols = 3;
  for (let sheet = 0; sheet * perSheet < rows.length; sheet++) {
    const chunk = rows.slice(sheet * perSheet, (sheet + 1) * perSheet);
    const made: Array<{ buf: Buffer; h: number }> = [];
    for (const r of chunk) {
      const m = await sharp(r.basePath).metadata();
      const th = Math.round((TW * (m.height || 1)) / (m.width || 1));
      const A = await sharp(r.basePath).rotate().resize(TW, th, { fit: "fill" }).removeAlpha().raw().toBuffer();
      const B = await sharp(r.stagedPath).rotate().resize(TW, th, { fit: "fill" }).removeAlpha().raw().toBuffer();
      const mix = Buffer.alloc(A.length);
      for (let k = 0; k < A.length; k++) mix[k] = Math.round((A[k] + B[k]) / 2);
      const label = `${r.n}. ${r.staged} | ${r.verdict} | fr ${r.framing} zoom ${r.camScale}`;
      const colour = String(r.verdict).startsWith("ok") ? "#7CFC00" : "#FF6060";
      const svg = Buffer.from(`<svg width="${TW}" height="22"><rect width="100%" height="100%" fill="black"/><text x="4" y="15" font-size="12" font-family="sans-serif" fill="${colour}">${esc(label)}</text></svg>`);
      const tile = await sharp({ create: { width: TW, height: th + 22, channels: 3, background: "#000" } })
        .composite([
          { input: await sharp(mix, { raw: { width: TW, height: th, channels: 3 } }).png().toBuffer(), left: 0, top: 22 },
          { input: svg, left: 0, top: 0 },
        ])
        .png()
        .toBuffer();
      made.push({ buf: tile, h: th + 22 });
    }
    const maxH = Math.max(...made.map((t) => t.h));
    const rowsN = Math.ceil(made.length / cols);
    await sharp({ create: { width: cols * (TW + 6), height: rowsN * (maxH + 6), channels: 3, background: "#fff" } })
      .composite(made.map((t, i) => ({ input: t.buf, left: (i % cols) * (TW + 6), top: Math.floor(i / cols) * (maxH + 6) })))
      .jpeg({ quality: 80 })
      .toFile(path.join(out, `sheet_${String(sheet + 1).padStart(2, "0")}.jpg`));
  }
}

(async () => {
  const outDir = path.resolve(process.argv[2] || path.join(TI, "Reshape Check Review"));
  fs.mkdirSync(outDir, { recursive: true });
  const rows: any[] = [];
  for (const p of findPairs()) {
    const o = fs.readFileSync(p.base);
    const m = await sharp(o).metadata();
    const w = m.width || 0, h = m.height || 0;
    const sb = fs.readFileSync(p.staged);
    const sm = await sharp(sb).metadata();
    const s = await sharp(sb).rotate().resize(w, h, { fit: "fill" }).toBuffer();
    const f = await checkFraming(o, s, new Uint8Array(w * h), w, h);
    const c = await checkCameraAlignment(o, s);
    const early = c.moved || (f.tilesChecked >= 6 && f.medianDiff > REFRAMED_EARLY_MEDIAN_DIFF);
    const full = early || f.medianDiff > REFRAMED_MEDIAN_DIFF;
    rows.push({
      group: p.group, base: path.basename(p.base), staged: path.basename(p.staged),
      basePath: p.base, stagedPath: p.staged,
      aspectBase: +(w / h).toFixed(3), aspectStaged: +((sm.width || 1) / (sm.height || 1)).toFixed(3),
      framing: f.medianDiff, camGain: c.gain, camScale: c.scale, camShift: c.shiftPct, moved: c.moved,
      verdict: early ? "RESHAPED (early)" : full ? "RESHAPED (full check)" : "ok",
    });
  }
  const order: Record<string, number> = { "RESHAPED (early)": 0, "RESHAPED (full check)": 1, ok: 2 };
  rows.sort((x, y) => (order[x.verdict] ?? 3) - (order[y.verdict] ?? 3) || x.group.localeCompare(y.group) || x.staged.localeCompare(y.staged));
  rows.forEach((r, i) => (r.n = i + 1));
  await writeSheets(rows, outDir);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(rows.map(({ basePath, stagedPath, ...r }) => r), null, 2));
  for (const r of rows) console.log(`${r.n} ${r.verdict} | ${r.group} / ${r.staged} | framing ${r.framing} | zoom ${r.camScale} gain ${r.camGain}`);
  console.log(`pairs: ${rows.length} -> ${outDir}`);
  process.exit(0);
})();
