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

// Square grow/shrink in O(pixels) (separable running counts): for the large
// radii used by the invented-sky repair.
function boxMorph(src: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const pass = (inp: Uint8Array, len: number, n: number, idx: (line: number, k: number) => number) => {
    const out = new Uint8Array(w * h);
    for (let line = 0; line < n; line++) {
      let cnt = 0;
      for (let k = 0; k < Math.min(r, len); k++) cnt += inp[idx(line, k)];
      for (let k = 0; k < len; k++) {
        if (k + r < len) cnt += inp[idx(line, k + r)];
        if (k - r - 1 >= 0) cnt -= inp[idx(line, k - r - 1)];
        const span = Math.min(len - 1, k + r) - Math.max(0, k - r) + 1;
        out[idx(line, k)] = grow ? (cnt > 0 ? 1 : 0) : (cnt === span ? 1 : 0);
      }
    }
    return out;
  };
  const rows = pass(src, w, h, (y, x) => y * w + x);
  return pass(rows, h, w, (x, y) => y * w + x);
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

// ---------------------------------------------------------------------------
// Invented-sky guard. "Enhance Exterior Outlook" may brighten a grey sky to
// blue, but it must not trim trees or hedges to open up sky that the camera
// never saw (production case: Oct 2026, a living room whose window showed
// only shrubs above the fence came back with the shrubs cut down and blue
// sky behind). Where a pixel was vegetation in the image sent to Gemini and
// is now sky, the original vegetation is put back, colour-matched to the
// enhanced vegetation around it so the window keeps the enhanced look.
//
// STAGE1A_INVENTED_SKY_GUARD=off disables it.

export function inventedSkyGuardEnabled(): boolean {
  return String(process.env.STAGE1A_INVENTED_SKY_GUARD || "on").toLowerCase() !== "off";
}

const SKY_MIN_REGION_PCT = 0.05;  // ignore specks smaller than this % of the image
const SKY_MIN_TOTAL_PCT = 0.1;    // repair only when this much new sky in total
const SKY_RING = 40;              // colour-match from vegetation within this many px (work res)
const SKY_FILL = 20;              // also restore sky gaps up to ~2x this (work px) inside the repair
const SKY_MIN_RING_PX = 300;

const isVegetation = (r: number, g: number, b: number) => g > r + 6 && g > b + 4 && g < 235;
const isBlueSky = (r: number, g: number, b: number) => b > r + 15 && b >= g - 4 && b > 110;

// Gemini returns the closest standard shape (e.g. 4:3) and may trim or zoom
// slightly, so before and after don't line up pixel for pixel. Find the
// part of "before" that matches the whole "after" frame (scale and shift per
// axis, coarse-to-fine on small greyscale copies) and return it at full size.
export async function alignBeforeToAfter(before: Buffer, after: Buffer) {
  const bm = await sharp(before).metadata(), am = await sharp(after).metadata();
  const BW = bm.width!, BH = bm.height!, AW = am.width!, AH = am.height!;
  const SW = 320, SH = Math.round((SW * BH) / BW);
  const TW = 128, TH = Math.max(8, Math.round((TW * AH) / AW));
  const [src, tgt] = await Promise.all([
    sharp(before).removeAlpha().resize(SW, SH, { fit: "fill" }).greyscale().raw().toBuffer(),
    sharp(after).removeAlpha().resize(TW, TH, { fit: "fill" }).greyscale().raw().toBuffer(),
  ]);
  const norm = (v: ArrayLike<number>, out: Float32Array) => {
    let s = 0, q = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; q += v[i] * v[i]; }
    const mu = s / v.length, sd = Math.sqrt(Math.max(1e-6, q / v.length - mu * mu));
    for (let i = 0; i < v.length; i++) out[i] = (v[i] - mu) / sd;
    return out;
  };
  const T = norm(tgt, new Float32Array(TW * TH));
  const g = new Float32Array(TW * TH), G = new Float32Array(TW * TH);
  const xs = new Int32Array(TW);
  // rect in source pixels: left, top, width, height
  const score = (l: number, t: number, w: number, h: number) => {
    if (l < 0 || t < 0 || l + w > SW + 0.01 || t + h > SH + 0.01) return Infinity;
    for (let x = 0; x < TW; x++) xs[x] = Math.min(SW - 1, Math.round(l + ((x + 0.5) * w) / TW - 0.5));
    for (let y = 0; y < TH; y++) {
      const row = Math.min(SH - 1, Math.round(t + ((y + 0.5) * h) / TH - 0.5)) * SW;
      for (let x = 0; x < TW; x++) g[y * TW + x] = src[row + xs[x]];
    }
    norm(g, G);
    let d = 0;
    for (let i = 0; i < G.length; i++) d += Math.abs(G[i] - T[i]);
    return d / G.length;
  };
  let best = { l: 0, t: 0, w: SW, h: SH, d: score(0, 0, SW, SH) };
  const identity = best.d;
  for (let fw = 0.88; fw <= 1.0001; fw += 0.03) for (let fh = 0.88; fh <= 1.0001; fh += 0.03) {
    const w = SW * fw, h = SH * fh;
    for (let fx = 0; fx <= 1.0001; fx += 0.25) for (let fy = 0; fy <= 1.0001; fy += 0.25) {
      const d = score((SW - w) * fx, (SH - h) * fy, w, h);
      if (d < best.d) best = { l: (SW - w) * fx, t: (SH - h) * fy, w, h, d };
    }
  }
  for (const step of [2, 1, 0.5]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dl, dt, dw, dh] of [[step, 0, 0, 0], [-step, 0, 0, 0], [0, step, 0, 0], [0, -step, 0, 0], [0, 0, step, 0], [0, 0, -step, 0], [0, 0, 0, step], [0, 0, 0, -step], [-step / 2, 0, step, 0], [0, -step / 2, 0, step]]) {
        const c = { l: best.l + dl, t: best.t + dt, w: best.w + dw, h: best.h + dh };
        const d = score(c.l, c.t, c.w, c.h);
        if (d < best.d - 1e-4) { best = { ...c, d }; improved = true; }
      }
    }
  }
  const k = BW / SW;
  const rect = {
    left: Math.max(0, Math.round(best.l * k)), top: Math.max(0, Math.round(best.t * k)),
    width: Math.round(best.w * k), height: Math.round(best.h * k),
  };
  rect.width = Math.min(rect.width, BW - rect.left);
  rect.height = Math.min(rect.height, BH - rect.top);
  const image = await sharp(before).removeAlpha().extract(rect).resize(AW, AH, { fit: "fill" }).png().toBuffer();
  return { image, rect, match: +best.d.toFixed(3), identityMatch: +identity.toFixed(3) };
}

export type InventedSkyRegion = { x1Pct: number; y1Pct: number; x2Pct: number; y2Pct: number; areaPct: number };

export async function findInventedSky(before: Buffer, after: Buffer) {
  const am = await sharp(after).metadata();
  const W = WORK_W, H = Math.max(8, Math.round((WORK_W * (am.height || 1)) / (am.width || 1)));
  const [b, a] = await Promise.all([
    sharp(before).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
    sharp(after).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
  ]);
  let hit: Uint8Array = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    hit[i] = isVegetation(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]) && isBlueSky(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) ? 1 : 0;
  }
  hit = boxMorph(boxMorph(hit, W, H, 2, true), W, H, 2, false);
  const regions: InventedSkyRegion[] = [];
  const mask = new Uint8Array(W * H);
  let total = 0;
  for (const px of label(hit, W, H)) {
    const areaPct = (px.length / (W * H)) * 100;
    if (areaPct < SKY_MIN_REGION_PCT) continue;
    let x1 = W, y1 = H, x2 = 0, y2 = 0;
    for (const p of px) {
      mask[p] = 1;
      const x = p % W, y = (p / W) | 0;
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    }
    total += areaPct;
    const pct = (v: number) => +(v * 100).toFixed(1);
    regions.push({ x1Pct: pct(x1 / W), y1Pct: pct(y1 / H), x2Pct: pct(x2 / W), y2Pct: pct(y2 / H), areaPct: +areaPct.toFixed(2) });
  }
  return { regions, mask, W, H, b, a, totalPct: +total.toFixed(2), invented: total >= SKY_MIN_TOTAL_PCT };
}

// Returns the repaired image, or null when no sky was invented.
export async function repairInventedSky(beforeRaw: Buffer, after: Buffer) {
  const aligned = await alignBeforeToAfter(beforeRaw, after);
  const before = aligned.image;
  const found = await findInventedSky(before, after);
  const info = { regions: found.regions, totalPct: found.totalPct, gain: null as number[] | null, align: { rect: aligned.rect, match: aligned.match, identityMatch: aligned.identityMatch } };
  if (!found.invented) return { image: null as Buffer | null, ...info };
  const { W, H, b, a } = found;
  // Repair area: the new sky plus a small margin, but only over pixels that
  // were vegetation before or are sky now (never the fence or window frame).
  // Closing first fills gaps between restored leaves (the area test below
  // still keeps the frame, fence and walls untouched).
  const closed = boxMorph(boxMorph(found.mask, W, H, SKY_FILL, true), W, H, SKY_FILL, false);
  const grown = boxMorph(closed, W, H, 3, true);
  const area = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!grown[i]) continue;
    if (isVegetation(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]) || isBlueSky(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])) area[i] = 1;
  }
  // Colour match: vegetation that stayed vegetation near the repair, before vs
  // after, gives the enhancement Gemini applied to the plants (per channel).
  const ring = boxMorph(found.mask, W, H, SKY_RING, true);
  const stats = (useRing: boolean) => {
    const s = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (area[i] || (useRing && !ring[i])) continue;
      if (!isVegetation(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]) || !isVegetation(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])) continue;
      for (let c = 0; c < 3; c++) {
        const x = b[i * 3 + c], y = a[i * 3 + c];
        s[c] += x; s[3 + c] += x * x; s[6 + c] += y; s[9 + c] += y * y;
      }
      n++;
    }
    return { s, n };
  };
  let st = stats(true);
  if (st.n < SKY_MIN_RING_PX) st = stats(false);
  const gain = [1, 1, 1], offset = [0, 0, 0];
  if (st.n >= SKY_MIN_RING_PX) {
    for (let c = 0; c < 3; c++) {
      const mb = st.s[c] / st.n, ma = st.s[6 + c] / st.n;
      const sb = Math.sqrt(Math.max(1, st.s[3 + c] / st.n - mb * mb)), sa = Math.sqrt(Math.max(1, st.s[9 + c] / st.n - ma * ma));
      gain[c] = Math.min(1.5, Math.max(0.7, sa / sb));
      offset[c] = ma - gain[c] * mb;
    }
  }
  info.gain = gain.map((g, c) => +g.toFixed(2)).concat(offset.map((o) => +o.toFixed(1)));
  const am = await sharp(after).metadata();
  const AW = am.width!, AH = am.height!;
  const alpha = await sharp(Buffer.from(area.map((v) => (v ? 255 : 0))), { raw: { width: W, height: H, channels: 1 } })
    .resize(AW, AH, { fit: "fill" }).blur(Math.max(0.8, AW / 900)).extractChannel(0).raw().toBuffer();
  const [fa, fb] = await Promise.all([
    sharp(after).removeAlpha().raw().toBuffer(),
    // light sharpening so the restored plants match the enhanced crispness
    sharp(before).removeAlpha().resize(AW, AH, { fit: "fill" }).sharpen({ sigma: 1 }).raw().toBuffer(),
  ]);
  const out = Buffer.from(fa);
  for (let i = 0; i < AW * AH; i++) {
    const t = alpha[i] / 255;
    if (t <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, Math.min(255, gain[c] * fb[i * 3 + c] + offset[c]));
      out[i * 3 + c] = Math.round(fa[i * 3 + c] * (1 - t) + v * t);
    }
  }
  const image = await sharp(out, { raw: { width: AW, height: AH, channels: 3 } }).png().toBuffer();
  return { image, ...info };
}
