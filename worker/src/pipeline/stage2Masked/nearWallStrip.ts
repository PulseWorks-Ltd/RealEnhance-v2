/**
 * Near-wall strip (Nov 2026).
 *
 * Some photos have a wall return, door frame or similar close to the camera
 * along the left or right edge: a plain, full-height strip whose straight
 * edge runs out of the photo at BOTH the top and the bottom. Nothing can
 * stand in front of it (no floor is visible there), so it is never staged —
 * but Gemini often removes or redraws it, and the floor-line checks get
 * confused next to it (Bedroom_05: 3 of 3 stagings failed there).
 *
 * When such a strip is found, Stage 2 runs on the photo WITHOUT the strip,
 * and the finished picture is pasted back next to the untouched strip. The
 * seam sits exactly on the strip's edge — an object in front of the room —
 * so furniture that runs behind it is hidden there, as in a real photo.
 *
 * Detection is code only (no Gemini calls). STAGE2_NEAR_WALL_CROP=0 turns it off.
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { closestGeminiAspectRatio } from "../../ai/gemini";

export const NEAR_WALL_CROP_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.STAGE2_NEAR_WALL_CROP ?? "1").trim().toLowerCase()
);

export type NearWallStrip = {
  side: "left" | "right";
  // The strip's edge: x (full-size px) at each of `seamRows` evenly spaced
  // rows from top to bottom. It may lean or bend a little (phone lenses).
  seam: number[];
  stripPct: number; // widest point of the strip, % of photo width
  score: number; // share of rows where the edge is clear (0..1)
  busyPct: number; // share of "busy" pixels in the strip (%)
};

export type NearWallCrop = {
  // Part of the photo that is staged, in full-size pixels (right exclusive).
  // Where an edge leans, the box reaches its outermost point, so a thin
  // wedge of the strip is staged too; the paste-back puts it back.
  left: number;
  right: number;
  W: number;
  H: number;
  strips: NearWallStrip[];
  side: "left" | "right" | "both";
  stripPct: number; // total width left out of staging, % of photo width
  score: number;
};

export type NearWallDetection = { crop: NearWallCrop | null; reason: string; best?: any };

// Tuning (on a 400 px wide grey copy).
const WORK_W = 400;
const ZONE_MIN = 0.02; // the edge sits 2%...
const ZONE_MAX = 0.35; // ...to 35% in from the left or right of the photo
const MIN_STRIP = 0.03; // and the strip is at least 3% wide on average
const EDGE_T = 5; // brightness step (0-255, after a light blur) that counts as an edge
const MIN_SCORE = 0.85; // edge clear on 85% of rows overall...
const MIN_END_SCORE = 0.6; // ...and on 60% of the top 8% and bottom 8% rows (runs out of frame)
const MAX_BEND = 0.02; // path may bend up to 2% of the width away from a straight line (RMS)
const MAX_LEAN = 0.3; // and lean up to 30% of the width over the full height (camera tilt)
const TEXTURE_T = 14; // gradient that counts as "busy"
const MAX_BUSY = 0.22; // strip mostly plain (a door handle or wood grain is fine)
const MAX_FLOOR_STEP = 32; // strip's bottom vs its middle: a jump this big means floor in front
const MOVE_PENALTY = 4; // path-finding: cost of shifting one pixel sideways per row

type Path = { xs: number[]; score: number; top: number; bottom: number; bendPct: number; leanPct: number };

// Strongest top-to-bottom edge path within columns [lo, hi] (dynamic programming).
function bestPath(edge: Float32Array, w: number, h: number, lo: number, hi: number): number[] | null {
  if (hi - lo < 2) return null;
  const n = hi - lo + 1;
  let prev = new Float32Array(n), cur = new Float32Array(n);
  const from = new Int8Array(n * h);
  for (let i = 0; i < n; i++) prev[i] = Math.min(30, edge[lo + i]);
  for (let y = 1; y < h; y++) {
    for (let i = 0; i < n; i++) {
      let best = prev[i], step = 0;
      if (i > 0 && prev[i - 1] - MOVE_PENALTY > best) { best = prev[i - 1] - MOVE_PENALTY; step = -1; }
      if (i < n - 1 && prev[i + 1] - MOVE_PENALTY > best) { best = prev[i + 1] - MOVE_PENALTY; step = 1; }
      cur[i] = best + Math.min(30, edge[y * w + lo + i]);
      from[y * n + i] = step;
    }
    [prev, cur] = [cur, prev];
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (prev[i] > prev[end]) end = i;
  const xs = new Array<number>(h);
  let i = end;
  for (let y = h - 1; y >= 0; y--) {
    xs[y] = lo + i;
    if (y > 0) i += from[y * n + i];
  }
  return xs;
}

export async function detectNearWallStrip(img: Buffer | string): Promise<NearWallDetection> {
  const meta = await sharp(img).metadata();
  let W = meta.width || 0, H = meta.height || 0;
  if ((meta.orientation || 1) >= 5) [W, H] = [H, W];
  if (!W || !H) return { crop: null, reason: "no image size" };
  const w = Math.min(WORK_W, W);
  const h = Math.max(8, Math.round((H * w) / W));
  const { data } = await sharp(img).rotate().greyscale().resize(w, h, { fit: "fill" }).blur(1).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[y * w + x];
  // Horizontal brightness step at each pixel (either direction: a strip can be
  // darker than the wall behind it and lighter than the carpet below).
  const edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) edge[y * w + x] = Math.abs(at(x + 1, y) - at(x - 1, y)) / 2;
  const endRows = Math.max(2, Math.round(h * 0.08));

  const measure = (xs: number[]): Path => {
    let hit = 0, topHit = 0, botHit = 0;
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const x = xs[y] + dx;
        if (x >= 1 && x < w - 1) v = Math.max(v, edge[y * w + x]);
      }
      if (v >= EDGE_T) { hit++; if (y < endRows) topHit++; if (y >= h - endRows) botHit++; }
    }
    // Straight-line fit: how much it bends, and how much it leans.
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (let y = 0; y < h; y++) { sy += y; sx += xs[y]; syy += y * y; sxy += y * xs[y]; }
    const b = (h * sxy - sy * sx) / Math.max(1e-6, h * syy - sy * sy);
    const a = (sx - b * sy) / h;
    let rss = 0;
    for (let y = 0; y < h; y++) rss += (xs[y] - (a + b * y)) ** 2;
    return {
      xs, score: hit / h, top: topHit / endRows, bottom: botHit / endRows,
      bendPct: (Math.sqrt(rss / h) / w) * 100, leanPct: (Math.abs(b * (h - 1)) / w) * 100,
    };
  };

  // Strip-side checks: how busy it is, and whether floor shows at its foot.
  const stripChecks = (side: "left" | "right", xs: number[]) => {
    let busy = 0, total = 0;
    const rowMean = new Array<number>(h).fill(NaN);
    for (let y = 1; y < h - 1; y++) {
      const from = side === "left" ? 1 : xs[y] + 3;
      const to = side === "left" ? xs[y] - 3 : w - 2;
      let sum = 0, cnt = 0;
      for (let x = from; x <= to; x++) {
        const g = Math.max(edge[y * w + x], Math.abs((at(x, y + 1) - at(x, y - 1)) / 2));
        if (g > TEXTURE_T) busy++;
        total++;
        sum += at(x, y); cnt++;
      }
      if (cnt) rowMean[y] = sum / cnt;
    }
    const avg = (y0: number, y1: number) => {
      let s = 0, c = 0;
      for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) if (!Number.isNaN(rowMean[y])) { s += rowMean[y]; c++; }
      return c ? s / c : NaN;
    };
    const middle = avg(Math.round(h * 0.4), Math.round(h * 0.6));
    const foot = avg(Math.round(h * 0.9), h);
    return { busy: total ? busy / total : 1, floorStep: Math.abs(foot - middle) };
  };

  const found: NearWallStrip[] = [];
  const notes: string[] = [];
  const tried: any[] = [];
  for (const side of ["left", "right"] as const) {
    // Work from the photo edge inwards; the innermost valid edge wins (a door
    // leaf in front of its frame: the strip is both).
    let start = Math.round(w * ZONE_MIN);
    const limit = Math.round(w * ZONE_MAX);
    let accepted: { p: Path; busy: number } | null = null;
    let lastWhy = "no edge";
    for (let round = 0; round < 5 && start < limit - 2; round++) {
      const lo = side === "left" ? start : w - 1 - limit;
      const hi = side === "left" ? limit : w - 1 - start;
      const xs = bestPath(edge, w, h, lo, hi);
      if (!xs) break;
      const p = measure(xs);
      const inner = side === "left" ? Math.max(...xs) : w - 1 - Math.min(...xs);
      const meanOff = (side === "left" ? xs.reduce((a, b) => a + b, 0) / h : w - 1 - xs.reduce((a, b) => a + b, 0) / h) / w;
      const sc = stripChecks(side, xs);
      let why = "";
      if (p.score < MIN_SCORE) why = `edge not full height (${Math.round(p.score * 100)}% of rows)`;
      else if (p.top < MIN_END_SCORE || p.bottom < MIN_END_SCORE) why = `edge doesn't run out of frame at top and bottom (top ${Math.round(p.top * 100)}%, bottom ${Math.round(p.bottom * 100)}%)`;
      else if (p.bendPct > MAX_BEND * 100) why = `edge not straight (bends ${p.bendPct.toFixed(1)}%)`;
      else if (p.leanPct > MAX_LEAN * 100) why = `edge leans too much (${p.leanPct.toFixed(0)}%)`;
      else if (meanOff < MIN_STRIP) why = `strip too thin (${(meanOff * 100).toFixed(1)}%)`;
      else if (sc.busy > MAX_BUSY) why = `strip not plain (${(sc.busy * 100).toFixed(0)}% busy)`;
      else if (sc.floorStep > MAX_FLOOR_STEP) why = `floor visible at the strip's foot (step ${sc.floorStep.toFixed(0)})`;
      tried.push({ side, round, meanX: +(meanOff * 100).toFixed(1), score: +p.score.toFixed(2), top: +p.top.toFixed(2), bottom: +p.bottom.toFixed(2), bend: +p.bendPct.toFixed(1), lean: +p.leanPct.toFixed(0), busy: +(sc.busy * 100).toFixed(0), floorStep: +sc.floorStep.toFixed(0), why: why || "ok" });
      if (!why) accepted = { p, busy: sc.busy };
      else lastWhy = why;
      start = inner + 3;
    }
    if (accepted) {
      const sx = W / w;
      const seam = accepted.p.xs.map((x) => (x + 0.5) * sx);
      const widest = side === "left" ? Math.max(...seam) : W - Math.min(...seam);
      found.push({ side, seam, stripPct: +((widest / W) * 100).toFixed(1), score: +accepted.p.score.toFixed(3), busyPct: +(accepted.busy * 100).toFixed(1) });
      notes.push(`${side}: found`);
    } else notes.push(`${side}: ${lastWhy}`);
  }
  const reason = notes.join("; ");
  if (!found.length) return { crop: null, reason, best: tried };
  // Staged box. Gemini only draws certain picture shapes (4:3, 3:2, 1:1, ...);
  // a cropped photo between two of them gets stretched and reframed (photo 5,
  // Nov 2026: 1.12:1 asked for 5:4 -> Gemini zoomed 5-8% and the floor checks
  // failed). So the cut line is chosen near each edge to land on a Gemini
  // shape. Where an edge leans, the cut may leave a little of the strip in
  // the staged picture (replaced by the paste-back) or a little of the room
  // unstaged (kept as the real photo) — but never floor in the lower half.
  const L = found.find((s) => s.side === "left");
  const R = found.find((s) => s.side === "right");
  const box = chooseStagedBox(W, H, L || null, R || null);
  if (!box.ok) return { crop: null, reason: `${reason}; ${box.why}`, best: tried };
  const { left, right } = box;
  return {
    crop: {
      left, right, W, H, strips: found,
      side: L && R ? "both" : L ? "left" : "right",
      stripPct: +((1 - (right - left) / W) * 100).toFixed(1),
      score: Math.min(...found.map((s) => s.score)),
    },
    reason: `${reason}; staged ${right - left}x${H} (${box.shape}, off by ${box.offPct}%)`,
    best: tried,
  };
}

const MAX_SHAPE_OFF = 0.025; // cropped picture within 2.5% of a Gemini shape
const MAX_STRIP_IN_BOX = 0.025; // at most 2.5% of the width of strip left in the staged picture
const MAX_ROOM_OUT = 0.06; // at most 6% of the width of room left unstaged (upper part)...
const MAX_ROOM_OUT_LOW = 0.015; // ...and 1.5% in the lower 55% (where furniture stands)

function geminiShapeOff(w: number, h: number): { shape: string; off: number } {
  const shape = closestGeminiAspectRatio(w, h);
  const [a, b] = shape.split(":").map(Number);
  return { shape, off: Math.abs(Math.log(w / h) - Math.log(a / b)) };
}

// Cut-line positions for one strip that keep the wedges within limits.
function cutRange(s: NearWallStrip, W: number): { lo: number; hi: number } | null {
  const n = s.seam.length;
  const lowFrom = Math.floor(n * 0.45);
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < n; i++) {
    const x = s.seam[i];
    const roomOut = (i >= lowFrom ? MAX_ROOM_OUT_LOW : MAX_ROOM_OUT) * W;
    if (s.side === "left") {
      // cut at c: strip inside box where x > c (amount x - c); room outside where x < c.
      lo = Math.max(lo, x - MAX_STRIP_IN_BOX * W);
      hi = Math.min(hi, x + roomOut);
    } else {
      // cut at c (box right edge): strip inside where x < c (c - x); room outside where x > c.
      lo = Math.max(lo, x - roomOut);
      hi = Math.min(hi, x + MAX_STRIP_IN_BOX * W);
    }
  }
  lo = Math.max(0, Math.ceil(lo));
  hi = Math.min(W, Math.floor(hi));
  return lo <= hi ? { lo, hi } : null;
}

function chooseStagedBox(W: number, H: number, L: NearWallStrip | null, R: NearWallStrip | null):
  | { ok: true; left: number; right: number; shape: string; offPct: number }
  | { ok: false; why: string } {
  const lr = L ? cutRange(L, W) : { lo: 0, hi: 0 };
  const rr = R ? cutRange(R, W) : { lo: W, hi: W };
  if (!lr || !rr) return { ok: false, why: "edge leans too much to cut cleanly" };
  // Prefer cuts close to each edge's middle.
  const mid = (s: NearWallStrip | null, fallback: number) => (s ? s.seam.reduce((a, b) => a + b, 0) / s.seam.length : fallback);
  const lMid = mid(L, 0), rMid = mid(R, W);
  let best: { left: number; right: number; shape: string; off: number; dist: number } | null = null;
  const step = Math.max(1, Math.round(W / 800));
  for (let l = lr.lo; l <= lr.hi; l += step) {
    for (let r = rr.lo; r <= rr.hi; r += step) {
      if (r - l < W * 0.55) continue;
      const { shape, off } = geminiShapeOff(r - l, H);
      const dist = Math.abs(l - lMid) + Math.abs(r - rMid);
      if (!best || off < best.off - 1e-4 || (Math.abs(off - best.off) <= 1e-4 && dist < best.dist)) best = { left: l, right: r, shape, off, dist };
    }
  }
  if (!best) return { ok: false, why: "strips too wide" };
  if (best.off > MAX_SHAPE_OFF) return { ok: false, why: `no cut gives a picture shape Gemini can draw (nearest ${best.shape}, off by ${(best.off * 100).toFixed(1)}%)` };
  return { ok: true, left: best.left, right: best.right, shape: best.shape, offPct: +(best.off * 100).toFixed(1) };
}

/** The photo without the strip, written next to the job's work files. */
export async function writeCroppedInput(inputPath: string, crop: NearWallCrop, workDir: string): Promise<string> {
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, "near_wall_crop_input.png");
  await sharp(inputPath).rotate().extract({ left: crop.left, top: 0, width: crop.right - crop.left, height: crop.H }).png().toFile(out);
  return out;
}

/** Full-photo box [x1,y1,x2,y2] (0..1) -> cropped-photo box, or null if it lies inside the strip. */
export function remapBox(b: [number, number, number, number], crop: NearWallCrop): [number, number, number, number] | null {
  const kw = (crop.right - crop.left) / crop.W;
  const k0 = crop.left / crop.W;
  const x1 = (b[0] - k0) / kw, x2 = (b[2] - k0) / kw;
  if (x2 <= 0.005 || x1 >= 0.995) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(x1), b[1], c(x2), b[3]];
}

/** Door / opening lists with boxes moved into the cropped photo's coordinates. */
export function remapBoxedItems<T extends { bbox?: any }>(items: T[] | null | undefined, crop: NearWallCrop): T[] {
  const out: T[] = [];
  for (const it of items || []) {
    if (!Array.isArray(it?.bbox) || it.bbox.length !== 4) { out.push(it); continue; }
    const nb = remapBox(it.bbox.map(Number) as any, crop);
    if (nb) out.push({ ...it, bbox: nb });
  }
  return out;
}

/** The structural baseline (windows, doors, fixtures) for the cropped photo. */
export function remapBaselineForCrop<B>(baseline: B, crop: NearWallCrop): B {
  if (!baseline || typeof baseline !== "object") return baseline;
  const b: any = { ...(baseline as any) };
  if (Array.isArray(b.openings)) b.openings = remapBoxedItems(b.openings, crop);
  if (Array.isArray(b.anchorFixtures)) b.anchorFixtures = remapBoxedItems(b.anchorFixtures, crop);
  return b as B;
}

/**
 * The staged picture (cropped-photo size) pasted back into the full photo;
 * then the real strip goes back on top, up to its edge (1 px soft blend).
 */
export async function pasteBackIntoFullPhoto(fullInputPath: string, stagedCropped: Buffer, crop: NearWallCrop): Promise<Buffer> {
  const { W, H } = crop;
  const kw = crop.right - crop.left;
  const piece = await sharp(stagedCropped).resize(kw, H, { fit: "fill" }).removeAlpha().png().toBuffer();
  const base = await sharp(fullInputPath).rotate().removeAlpha().composite([{ input: piece, left: crop.left, top: 0 }]).png().toBuffer();
  // Mask: 255 on the strip side of each edge.
  const mask = Buffer.alloc(W * H);
  for (const s of crop.strips) {
    const n = s.seam.length;
    for (let y = 0; y < H; y++) {
      const t = n > 1 ? (y / Math.max(1, H - 1)) * (n - 1) : 0;
      const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
      const xEdge = n > 1 ? s.seam[i] + (s.seam[i + 1] - s.seam[i]) * (t - i) : s.seam[0];
      for (let x = 0; x < W; x++) {
        // Distance past the edge into the strip (+) or the room (-), in px.
        const d = s.side === "left" ? xEdge - (x + 0.5) : x + 0.5 - xEdge;
        const v = d >= 1 ? 255 : d <= -1 ? 0 : Math.round(((d + 1) / 2) * 255);
        if (v > mask[y * W + x]) mask[y * W + x] = v;
      }
    }
  }
  const { data: rgb } = await sharp(fullInputPath).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = mask[i];
  }
  const strip = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return sharp(base).composite([{ input: strip, left: 0, top: 0 }]).png().toBuffer();
}
