import sharp from "sharp";

// Stage 1A blown-out window guard.
//
// When window glass is overexposed (plain white), the camera recorded nothing
// of the view, so anything Gemini paints there — sky, fence, lattice, roofs —
// is invented, not enhanced (production case: Bedroom 14, Oct 2026, with
// "Enhance Exterior Outlook" on). This code-only check (no AI call) finds
// areas that were pure white in the image sent to Gemini and, where Gemini's
// output now shows detailed scenery there, puts the original white back.
// Plain white or smooth sky in those areas is left alone.
//
// STAGE1A_BLOWN_WINDOW_GUARD=off disables it.

export function blownWindowGuardEnabled(): boolean {
  return String(process.env.STAGE1A_BLOWN_WINDOW_GUARD || "on").toLowerCase() !== "off";
}

const WORK_W = 1024;
const CLIP = 250;              // min(R,G,B) at or above this = blown out
const MIN_REGION_PCT = 0.25;   // ignore specks smaller than this % of the image
const EDGE_STEP = 30;          // brightness step that counts as an edge
const INVENTED_EDGE_GAIN = 0.04; // edge density the output gained inside the region
const INVENTED_OTHER = 0.12;     // share of pixels that are neither white nor sky
const MAX_EDGE_BEFORE = 0.02;    // the pane must be truly featureless in the original:
                                 // glass already showing a roof, fence or bushes
                                 // (production, Oct 2026: 5.4% and 24.7%) is a real view
const GROW_MIN = 200;            // repair also covers bright neighbours (blind slats, frame)
const GROW_BOX_PCT = 1.5;        // ...but only within the pane's box, grown by this much

export type BlownRegion = {
  x1Pct: number; y1Pct: number; x2Pct: number; y2Pct: number;
  areaPct: number; edgeBefore: number; edgeAfter: number;
  whitePct: number; skyPct: number; otherPct: number; invented: boolean;
};

function label(mask: Uint8Array, w: number, h: number) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps: number[][] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = comps.length, px: number[] = [];
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!; px.push(p);
      const x = p % w, y = (p / w) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
      }
    }
    comps.push(px);
  }
  return comps;
}

function morph(src: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let dy = -r; dy <= r && (grow ? !v : v); dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
      if (grow && s) { v = 1; break; }
      if (!grow && !s) { v = 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

export async function findInventedBlownWindows(before: Buffer, after: Buffer) {
  const bm = await sharp(before).metadata();
  const W = WORK_W, H = Math.max(8, Math.round((WORK_W * (bm.height || 1)) / (bm.width || 1)));
  const [bRgb, aRgb] = await Promise.all([
    sharp(before).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
    sharp(after).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
  ]);
  const [bG, aG] = await Promise.all([
    sharp(before).removeAlpha().resize(W, H, { fit: "fill" }).greyscale().blur(1).raw().toBuffer(),
    sharp(after).removeAlpha().resize(W, H, { fit: "fill" }).greyscale().blur(1).raw().toBuffer(),
  ]);
  let blown: Uint8Array = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) blown[i] = Math.min(bRgb[i * 3], bRgb[i * 3 + 1], bRgb[i * 3 + 2]) >= CLIP ? 1 : 0;
  // close small gaps (blind slats, glazing bars) so a pane is one region
  blown = morph(morph(blown, W, H, 3, true), W, H, 3, false);
  const edge = (g: Buffer, i: number) => {
    const x = i % W, y = (i / W) | 0;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    return Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + W] - g[i - W]) >= EDGE_STEP;
  };
  const regions: BlownRegion[] = [];
  const inventedMask = new Uint8Array(W * H);
  for (const px of label(blown, W, H)) {
    if ((px.length / (W * H)) * 100 < MIN_REGION_PCT) continue;
    // judge the inside only (the pane's own border is a real edge)
    const own = new Uint8Array(W * H);
    for (const p of px) own[p] = 1;
    const inner = morph(own, W, H, 3, false);
    let n = 0, eB = 0, eA = 0, white = 0, sky = 0, other = 0;
    let x1 = W, y1 = H, x2 = 0, y2 = 0;
    for (const p of px) {
      const x = p % W, y = (p / W) | 0;
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
      if (!inner[p]) continue;
      n++;
      if (edge(bG, p)) eB++;
      if (edge(aG, p)) eA++;
      const r = aRgb[p * 3], g = aRgb[p * 3 + 1], b = aRgb[p * 3 + 2];
      if (Math.min(r, g, b) >= 225) white++;
      else if (b > r + 15 && b >= g) sky++;
      else other++;
    }
    if (n < 50) continue;
    const edgeBefore = eB / n, edgeAfter = eA / n, otherPct = other / n;
    const invented = edgeBefore <= MAX_EDGE_BEFORE && edgeAfter - edgeBefore > INVENTED_EDGE_GAIN && otherPct > INVENTED_OTHER;
    if (invented) {
      // Repair the whole bright window, not just the pure-white pixels: Gemini
      // may also have removed blinds or redrawn the frame. Grow from the pane
      // into neighbouring bright pixels (slats, frame), kept inside the pane's
      // own box so a bright wall is never touched.
      const gx = Math.round((W * GROW_BOX_PCT) / 100), gy = Math.round((H * GROW_BOX_PCT) / 100);
      const bx1 = Math.max(0, x1 - gx), bx2 = Math.min(W - 1, x2 + gx), by1 = Math.max(0, y1 - gy), by2 = Math.min(H - 1, y2 + gy);
      const stack = [...px];
      for (const p of px) inventedMask[p] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % W, y = (p / W) | 0;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < bx1 || nx > bx2 || ny < by1 || ny > by2) continue;
          const q = ny * W + nx;
          if (inventedMask[q] || Math.min(bRgb[q * 3], bRgb[q * 3 + 1], bRgb[q * 3 + 2]) < GROW_MIN) continue;
          inventedMask[q] = 1;
          stack.push(q);
        }
      }
    }
    const pct = (v: number) => +(v * 100).toFixed(1);
    regions.push({
      x1Pct: pct(x1 / W), y1Pct: pct(y1 / H), x2Pct: pct(x2 / W), y2Pct: pct(y2 / H),
      areaPct: pct(px.length / (W * H)), edgeBefore: pct(edgeBefore), edgeAfter: pct(edgeAfter),
      whitePct: pct(white / n), skyPct: pct(sky / n), otherPct: pct(otherPct), invented,
    });
  }
  return { regions, inventedMask, W, H };
}

// Returns the repaired image (original pixels put back where a view was
// invented), or null when nothing needed repairing.
export async function repairInventedBlownWindows(before: Buffer, after: Buffer) {
  const found = await findInventedBlownWindows(before, after);
  if (!found.regions.some((r) => r.invented)) return { image: null as Buffer | null, regions: found.regions };
  const am = await sharp(after).metadata();
  const AW = am.width!, AH = am.height!;
  // slightly grown and feathered so the pane's edge blends
  const grown = morph(found.inventedMask, found.W, found.H, 2, true);
  const alpha = await sharp(Buffer.from(grown.map((v) => (v ? 255 : 0))), { raw: { width: found.W, height: found.H, channels: 1 } })
    .resize(AW, AH, { fit: "fill" }).blur(Math.max(0.6, AW / 1200)).extractChannel(0).raw().toBuffer();
  const [a, b] = await Promise.all([
    sharp(after).removeAlpha().raw().toBuffer(),
    sharp(before).removeAlpha().resize(AW, AH, { fit: "fill" }).raw().toBuffer(),
  ]);
  const out = Buffer.from(a);
  for (let i = 0; i < AW * AH; i++) {
    const t = alpha[i] / 255;
    if (t <= 0) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[i * 3 + c] * (1 - t) + b[i * 3 + c] * t);
  }
  const image = await sharp(out, { raw: { width: AW, height: AH, channels: 3 } }).png().toBuffer();
  return { image, regions: found.regions };
}
