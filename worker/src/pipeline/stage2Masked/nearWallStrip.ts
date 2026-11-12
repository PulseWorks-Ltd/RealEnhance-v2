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

export const NEAR_WALL_CROP_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.STAGE2_NEAR_WALL_CROP ?? "1").trim().toLowerCase()
);

export type NearWallCrop = {
  side: "left" | "right";
  // Kept (staged) part of the photo, in full-size pixels: x from left to right (exclusive).
  left: number;
  right: number;
  W: number;
  H: number;
  stripPct: number; // strip width, % of photo width
  edge: { topX: number; bottomX: number }; // the strip's edge, full-size pixels
  score: number; // share of rows where the edge is present (0..1)
  texturedPct: number; // share of "busy" pixels in the strip (%)
};

export type NearWallDetection = { crop: NearWallCrop | null; reason: string; best?: any };

// Tuning (on a 400 px wide grey copy).
const WORK_W = 400;
const MIN_STRIP = 0.05; // strip at least 5% of the width...
const MAX_STRIP = 0.3; // ...and at most 30%
const MAX_SLANT = 0.025; // edge may lean up to 2.5% of the width over the full height
const EDGE_T = 6; // brightness step (0-255, after a light blur) that counts as an edge
const MIN_SCORE = 0.9; // edge present on 90% of rows overall...
const MIN_END_SCORE = 0.75; // ...and on 75% of the top 6% and bottom 6% rows (runs out of frame)
const TEXTURE_T = 14; // gradient that counts as "busy"
const MAX_TEXTURED = 0.06; // strip must be plain: at most 6% busy pixels
const SEAM_MARGIN = 2; // full-size px past the edge, so no edge pixels are staged

export async function detectNearWallStrip(img: Buffer | string): Promise<NearWallDetection> {
  const meta = await sharp(img).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  if (!W || !H) return { crop: null, reason: "no image size" };
  const w = Math.min(WORK_W, W);
  const h = Math.max(8, Math.round((H * w) / W));
  const { data } = await sharp(img).rotate().greyscale().resize(w, h, { fit: "fill" }).blur(1).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[y * w + x];
  // Horizontal brightness step at each pixel.
  const gx = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) gx[y * w + x] = (at(x + 1, y) - at(x - 1, y)) / 2;
  const endRows = Math.max(2, Math.round(h * 0.06));
  const maxSlant = Math.max(1, Math.round(w * MAX_SLANT));

  type Line = { x0: number; d: number; score: number; top: number; bottom: number };
  const scan = (side: "left" | "right"): Line | null => {
    let best: Line | null = null;
    const lo = Math.round(w * MIN_STRIP), hi = Math.round(w * MAX_STRIP);
    for (let off = lo; off <= hi; off++) {
      const x0 = side === "left" ? off : w - 1 - off;
      for (let d = -maxSlant; d <= maxSlant; d++) {
        let hit = 0, topHit = 0, botHit = 0;
        for (let y = 0; y < h; y++) {
          const xc = Math.round(x0 + (d * y) / (h - 1));
          let v = 0;
          for (let dx = -1; dx <= 1; dx++) {
            const x = xc + dx;
            if (x < 1 || x >= w - 1) continue;
            v = Math.max(v, Math.abs(gx[y * w + x]));
          }
          // Either direction: the strip can be darker than the wall behind it
          // and lighter than the carpet below (Bedroom_05).
          if (v >= EDGE_T) { hit++; if (y < endRows) topHit++; if (y >= h - endRows) botHit++; }
        }
        const score = hit / h;
        const top = topHit / endRows;
        const bottom = botHit / endRows;
        if (!best || score > best.score || (score === best.score && Math.min(top, bottom) > Math.min(best.top, best.bottom))) {
          best = { x0, d, score, top, bottom };
        }
      }
    }
    return best;
  };

  const candidates: Array<{ side: "left" | "right"; line: Line; texturedPct: number; ok: boolean; why: string }> = [];
  for (const side of ["left", "right"] as const) {
    const line = scan(side);
    if (!line) continue;
    const xTop = line.x0, xBot = line.x0 + line.d;
    // How plain is the strip? (pixels between the photo edge and the line, 2 px clear of it)
    let busy = 0, total = 0;
    for (let y = 1; y < h - 1; y++) {
      const xl = Math.round(line.x0 + (line.d * y) / (h - 1));
      const from = side === "left" ? 1 : xl + 3;
      const to = side === "left" ? xl - 3 : w - 2;
      for (let x = from; x <= to; x++) {
        const gxx = Math.abs(gx[y * w + x]);
        const gyy = Math.abs((at(x, y + 1) - at(x, y - 1)) / 2);
        if (gxx > TEXTURE_T || gyy > TEXTURE_T) busy++;
        total++;
      }
    }
    const textured = total ? busy / total : 1;
    let why = "";
    if (line.score < MIN_SCORE) why = `edge not full height (${Math.round(line.score * 100)}% of rows)`;
    else if (line.top < MIN_END_SCORE || line.bottom < MIN_END_SCORE) why = `edge doesn't run out of frame at top and bottom (top ${Math.round(line.top * 100)}%, bottom ${Math.round(line.bottom * 100)}%)`;
    else if (textured > MAX_TEXTURED) why = `strip not plain (${(textured * 100).toFixed(1)}% busy)`;
    candidates.push({ side, line: { ...line, x0: xTop, d: xBot - xTop }, texturedPct: +(textured * 100).toFixed(1), ok: !why, why });
  }
  const ok = candidates.filter((c) => c.ok);
  const describe = candidates.map((c) => `${c.side}: ${c.ok ? "found" : c.why}`).join("; ");
  if (!ok.length) return { crop: null, reason: describe || "no edge", best: candidates };
  // Strips on both sides: take the stronger one (a later version could take both).
  const pick = ok.sort((a, b) => b.line.score - a.line.score)[0];
  const sx = W / w;
  const topX = pick.line.x0 * sx, bottomX = (pick.line.x0 + pick.line.d) * sx;
  let left = 0, right = W;
  if (pick.side === "left") left = Math.min(W - 1, Math.ceil(Math.max(topX, bottomX) + sx + SEAM_MARGIN));
  else right = Math.max(1, Math.floor(Math.min(topX, bottomX) - sx - SEAM_MARGIN));
  const keptW = right - left;
  if (keptW < W * 0.6) return { crop: null, reason: `strip too wide (${Math.round((1 - keptW / W) * 100)}%)`, best: candidates };
  return {
    crop: {
      side: pick.side, left, right, W, H,
      stripPct: +(((W - keptW) / W) * 100).toFixed(1),
      edge: { topX: Math.round(topX), bottomX: Math.round(bottomX) },
      score: +pick.line.score.toFixed(3),
      texturedPct: pick.texturedPct,
    },
    reason: describe,
    best: candidates,
  };
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

/** The staged picture (cropped-photo size) pasted back next to the untouched strip. */
export async function pasteBackIntoFullPhoto(fullInputPath: string, stagedCropped: Buffer, crop: NearWallCrop): Promise<Buffer> {
  const kw = crop.right - crop.left;
  const piece = await sharp(stagedCropped).resize(kw, crop.H, { fit: "fill" }).png().toBuffer();
  return sharp(fullInputPath).rotate().composite([{ input: piece, left: crop.left, top: 0 }]).png().toBuffer();
}
