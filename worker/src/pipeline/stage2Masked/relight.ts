// Stage 2 masked staging — "relit" final.
//
// The real room (with the traced furniture pasted in) is kept pixel for pixel,
// and only the LIGHTING of Gemini's blend is laid on top: a smooth per-area
// brightness/colour factor (lamp glow, soft shadows, warmth). Lighting alone
// can't move a wall, add a window or redraw a skirting board, so the room's
// lines stay exactly as in the photo, and there is no pasted edge anywhere.
//
// Why (Nov 2026 test run, Bedroom_05): Gemini's blend relit a full-height
// wall return next to the bed, the patch check called that an object-sized
// change, and the whole blend was thrown away — with it the lamp glow and the
// shadows, leaving hard-edged pale boxes round the lamps.
//
// Safeguards:
//  - Lighting is only taken where the blend shows the same surface (same
//    texture and colour, just lighter or darker). Where Gemini changed the
//    content (an object added or removed, a moved line, a reframed corner)
//    nothing is taken; the factor there is filled in from the surrounding
//    lighting instead.
//  - The factor is smoothed edge-aware (guided by the real photo), so it stops
//    at real edges — light does not wash across a wall corner.
//  - Capped: at most HARM_MAX_SHADOW darker, RELIGHT_MAX_BRIGHTEN lighter,
//    and only around the furniture (the same soft zone the shadows use), so
//    the structure check outside it still applies.
//  - The furniture keeps its staged pixels; only a gentle lighting change is
//    applied to it, and only if Gemini kept the furniture as it was.
//  - Nothing is borrowed where the blend shows floor over the real wall.
// STAGE2_RELIGHT_FINAL=off goes back to the shadows-only app-built final.

import sharp from "sharp";
import { HARM_MAX_SHADOW } from "./core";

export const RELIGHT_FINAL = String(process.env.STAGE2_RELIGHT_FINAL ?? "on").trim().toLowerCase() !== "off";
export const RELIGHT_MAX_BRIGHTEN = Math.max(1.02, Number(process.env.STAGE2_RELIGHT_MAX_BRIGHTEN || 1.3));
const RELIGHT_WORK_WIDTH = 1024;      // the lighting map is smooth: worked out at this width, then scaled up
const TEX_LIMIT = 9;                   // texture disagreement (0-255) above which the blend changed content
const CHROMA_LIMIT = 0.06;             // colour-balance change allowed (lamp light is warmer)
const FURN_MIN = 0.8, FURN_MAX = 1.06; // lighting change allowed on the furniture itself
const FURN_KEPT_MAX_DIFF = 25;         // average difference on the furniture core: above = Gemini redrew it

/** Separable box mean (radius r) on a single-channel float image. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Guided filter (He et al.): smooths p while keeping the edges of guide I. */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

async function rawRgb(buf: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(buf).removeAlpha().resize(w, h, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer();
}
async function rawGrey(png: Buffer, w: number, h: number, blur = 0): Promise<Buffer> {
  let s = sharp(png).resize(w, h, { fit: "fill" });
  if (blur > 0) s = s.blur(blur);
  return s.grayscale().raw().toBuffer();
}

/**
 * safe: real room + traced furniture (no shadows). blend: Gemini's harmonised
 * image. solidPng/corePng: furniture outline and its solid core. zonePng: the
 * shadow zone around the furniture. noShadowPng: where nothing may be borrowed.
 */
export async function compositeRelight(safe: Buffer, blend: Buffer, solidPng: Buffer, corePng: Buffer, zonePng: Buffer, noShadowPng: Buffer | null = null) {
  const meta = await sharp(safe).metadata();
  const fw = meta.width || 0, fh = meta.height || 0;
  const lw = Math.min(RELIGHT_WORK_WIDTH, fw), lh = Math.max(8, Math.round((lw * fh) / fw));
  const n = lw * lh;
  const [A, B, solid, core, zone, noSh] = await Promise.all([
    rawRgb(safe, lw, lh),
    rawRgb(blend, lw, lh),
    rawGrey(solidPng, lw, lh),
    rawGrey(corePng, lw, lh),
    rawGrey(zonePng, lw, lh),
    noShadowPng ? rawGrey(noShadowPng, lw, lh) : Promise.resolve(null),
  ]);

  // 1. Remove the blend's overall colour/brightness shift (measured away from
  //    the furniture) so a general re-light is not taken as local lighting.
  const sums = [0, 0, 0, 0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (solid[i] > 12 || zone[i] > 12) continue;
    for (let c = 0; c < 3; c++) { sums[c] += A[i * 3 + c]; sums[c + 3] += B[i * 3 + c]; }
    cnt++;
  }
  const gains = [0, 1, 2].map((c) => (cnt > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));

  // 2. Luminance and local texture of both, to tell lighting from content.
  const sL = new Float32Array(n), bL = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sL[i] = (A[i * 3] + A[i * 3 + 1] + A[i * 3 + 2]) / 3;
    bL[i] = (B[i * 3] * gains[0] + B[i * 3 + 1] * gains[1] + B[i * 3 + 2] * gains[2]) / 3;
  }
  const r1 = Math.max(2, Math.round(lw * 0.006));
  const sM = boxMean(sL, lw, lh, r1), bM = boxMean(bL, lw, lh, r1);
  const texRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = (bM[i] + 4) / (sM[i] + 4);
    texRaw[i] = Math.abs((bL[i] - bM[i]) - (sL[i] - sM[i]) * k);
  }
  const tex = boxMean(texRaw, lw, lh, r1);

  // 3. Per-channel lighting factor where the blend shows the same surface.
  const valid = new Float32Array(n);
  const pc = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let coreN = 0, coreDiff = 0;
  for (let i = 0; i < n; i++) {
    const a0 = A[i * 3], a1 = A[i * 3 + 1], a2 = A[i * 3 + 2];
    const b0 = B[i * 3] * gains[0], b1 = B[i * 3 + 1] * gains[1], b2 = B[i * 3 + 2] * gains[2];
    for (let c = 0; c < 3; c++) pc[c][i] = ([b0, b1, b2][c] + 2) / ([a0, a1, a2][c] + 2);
    if (core[i] > 200) { coreN++; coreDiff += Math.max(Math.abs(a0 - b0), Math.abs(a1 - b1), Math.abs(a2 - b2)); continue; }
    if (noSh && noSh[i] > 127) continue;
    if (sL[i] < 12) continue;
    const sa = a0 + a1 + a2 || 1, sb = b0 + b1 + b2 || 1;
    const chroma = Math.max(Math.abs(a0 / sa - b0 / sb), Math.abs(a1 / sa - b1 / sb), Math.abs(a2 / sa - b2 / sb));
    if (tex[i] > TEX_LIMIT || chroma > CHROMA_LIMIT) continue;
    valid[i] = 1;
  }
  const furnitureKept = coreN > 0 && coreDiff / coreN <= FURN_KEPT_MAX_DIFF;

  // 4. Fill the factor from valid neighbours (normalised averaging), then
  //    smooth it edge-aware with the real photo as the guide.
  const r2 = Math.max(3, Math.round(lw * 0.012)), r3 = Math.max(3, Math.round(lw * 0.01));
  const den = boxMean(valid, lw, lh, r2);
  const guide = new Float32Array(n);
  for (let i = 0; i < n; i++) guide[i] = sL[i] / 255;
  const lightMax = RELIGHT_MAX_BRIGHTEN, lightMin = 1 - HARM_MAX_SHADOW;
  const bg: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const pv = new Float32Array(n);
    for (let i = 0; i < n; i++) pv[i] = pc[c][i] * valid[i];
    const num = boxMean(pv, lw, lh, r2);
    const filled = new Float32Array(n);
    for (let i = 0; i < n; i++) filled[i] = den[i] > 0.05 ? num[i] / den[i] : 1;
    bg.push(guidedFilter(guide, filled, lw, lh, r3, 0.002));
  }
  // 4b. Where Gemini's floor covered the real wall (no-borrow area) nothing is
  //    taken from the blend, but the lighting around it carries on across it
  //    — a wide fill from the valid surroundings. Without this the area kept
  //    no shadow at all and showed as a bright block next to the furniture
  //    (Nov 2026, Bedroom_02: a pale rectangle beside the bed).
  let bgNo: Float32Array[] | null = null;
  if (noSh) {
    const rW = Math.max(r2 * 3, Math.round(lw * 0.04));
    const denW = boxMean(valid, lw, lh, rW);
    bgNo = [];
    for (let c = 0; c < 3; c++) {
      const pv = new Float32Array(n);
      for (let i = 0; i < n; i++) pv[i] = pc[c][i] * valid[i];
      const num = boxMean(pv, lw, lh, rW);
      const filled = new Float32Array(n);
      for (let i = 0; i < n; i++) filled[i] = denW[i] > 0.02 ? num[i] / denW[i] : 1;
      bgNo.push(guidedFilter(guide, filled, lw, lh, r3, 0.002));
    }
  }
  // Furniture: its own gentle lighting, from its own pixels only.
  const fur: Float32Array[] = [];
  if (furnitureKept) {
    const cv = new Float32Array(n);
    for (let i = 0; i < n; i++) cv[i] = core[i] > 200 ? 1 : 0;
    const r4 = Math.max(3, Math.round(lw * 0.02));
    const cden = boxMean(cv, lw, lh, r4);
    for (let c = 0; c < 3; c++) {
      const pv = new Float32Array(n);
      for (let i = 0; i < n; i++) pv[i] = pc[c][i] * cv[i];
      const num = boxMean(pv, lw, lh, r4);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = cden[i] > 0.05 ? Math.min(FURN_MAX, Math.max(FURN_MIN, num[i] / cden[i])) : 1;
      fur.push(f);
    }
  }

  // 5. Where it applies: the furniture and its zone, soft-edged.
  const whereRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) whereRaw[i] = Math.max(zone[i], solid[i], noSh ? noSh[i] : 0) > 127 ? 1 : 0;
  const where = boxMean(boxMean(whereRaw, lw, lh, r2), lw, lh, r2);
  const noShSoft = noSh ? boxMean(Float32Array.from(noSh, (v) => (v > 127 ? 1 : 0)), lw, lh, r1) : null;

  // 6. Final factor per channel (colour kept close to the brightness change,
  //    so no colour casts), encoded for scaling up to full size.
  const factorImg = Buffer.alloc(n * 3);
  const FMIN = 0.3, FMAX = 1.7; // encoding range
  let maxDark = 0, maxLight = 0;
  for (let i = 0; i < n; i++) {
    const ca = core[i] / 255;
    // In the no-borrow area: the surroundings' lighting, shadows only.
    const ns = noShSoft && bgNo ? noShSoft[i] : 0;
    const bgc = [0, 1, 2].map((c) => (ns > 0 ? bg[c][i] * (1 - ns) + bgNo![c][i] * ns : bg[c][i]));
    const lumF = (bgc[0] + bgc[1] + bgc[2]) / 3;
    const lumC = Math.min(ns > 0.5 ? 1 : lightMax, Math.max(lightMin, lumF));
    const wgt = where[i];
    for (let c = 0; c < 3; c++) {
      let f = Math.min(lumC * 1.06, Math.max(lumC * 0.94, bgc[c] * (lumC / Math.max(0.01, lumF))));
      f = 1 + (f - 1) * wgt;
      if (furnitureKept) f = f * (1 - ca) + fur[c][i] * ca; else f = f * (1 - ca) + ca;
      factorImg[i * 3 + c] = Math.round(((Math.min(FMAX, Math.max(FMIN, f)) - FMIN) / (FMAX - FMIN)) * 255);
    }
    const g = (1 + (lumC - 1) * wgt) * (1 - ca) + ca;
    if (1 - g > maxDark) maxDark = 1 - g;
    if (g - 1 > maxLight) maxLight = g - 1;
  }
  const big = await sharp(factorImg, { raw: { width: lw, height: lh, channels: 3 } })
    .resize(fw, fh, { fit: "fill", kernel: sharp.kernel.cubic }).raw().toBuffer();
  const S = await sharp(safe).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(fw * fh * 3);
  for (let i = 0; i < fw * fh * 3; i++) {
    const f = FMIN + (big[i] / 255) * (FMAX - FMIN);
    out[i] = Math.min(255, Math.round(S[i] * f));
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    colourGains: gains.map((g2) => Number(g2.toFixed(3))),
    strongestShadowPct: Math.round(maxDark * 100),
    strongestLightPct: Math.round(maxLight * 100),
    furnitureLightingUsed: furnitureKept,
    furnitureDiffVsBlend: coreN ? Number((coreDiff / coreN).toFixed(1)) : 0,
    lightingTakenPctOfZone: (() => {
      let inZone = 0, taken = 0;
      for (let i = 0; i < n; i++) if (whereRaw[i]) { inZone++; if (valid[i]) taken++; }
      return Number(((taken / Math.max(1, inZone)) * 100).toFixed(1));
    })(),
  };
}
