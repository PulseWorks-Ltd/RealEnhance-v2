// Photo Adjust: the pixel maths.
//
// This file is the reference implementation. The WebGL shader in renderer.ts
// mirrors it line for line (same constants, same order), and the CPU fallback
// renderer calls it directly, so preview, fallback and saved image all agree.
//
// Order (Lightroom-like): sRGB → linear → white balance → exposure →
// highlights/shadows (blurred-luminance masks) → highlight shoulder →
// back to sRGB → contrast → vibrance → saturation.

import type { AdjustParams } from "./params";

export interface AdjustUniforms {
  ev: number; // exposure in stops
  wb: [number, number, number]; // per-channel linear gains (luminance-neutral)
  highlights: number; // -1..1
  shadows: number; // -1..1
  shoulder: number; // 0..1 how much highlight roll-off to blend in
  contrast: number; // -1..1
  vibrance: number; // -1..1
  saturation: number; // -1..1
}

// Tuning constants — shared with the GLSL source (renderer.ts imports them).
export const EV_PER_100 = 1.5; // Brightness +100 = +1.5 stops
export const WARMTH_STOPS = 0.35; // Warmth ±100 = ±0.35 stops red vs blue
export const TINT_GREEN_STOPS = 0.25; // Tint ±100 = ∓0.25 stops green
export const TINT_RB_STOPS = 0.08; // ... with a small red+blue lift for magenta
export const HIGHLIGHT_STOPS = 1.5; // Highlights ±100 = ±1.5 stops in the bright zone
export const SHADOW_STOPS = 2.0; // Shadows ±100 = ±2 stops in the dark zone (dark tones need more to show)
export const MASK_DETAIL_MIX = 0.35; // share of per-pixel luminance in the tone mask (rest is blurred)
export const HIGHLIGHT_ZONE: [number, number] = [0.45, 0.95]; // smoothstep in perceptual luminance
export const SHADOW_ZONE: [number, number] = [0.05, 0.55];
export const SHOULDER_START = 0.8; // linear value where highlight roll-off starts
export const CONTRAST_S_AMOUNT = 0.75;
export const CONTRAST_FLATTEN = 0.5;

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export function computeUniforms(p: AdjustParams): AdjustUniforms {
  const wn = p.warmth / 100;
  const tn = p.tint / 100;
  let gr = Math.pow(2, WARMTH_STOPS * wn + TINT_RB_STOPS * tn);
  let gg = Math.pow(2, -TINT_GREEN_STOPS * tn);
  let gb = Math.pow(2, -WARMTH_STOPS * wn + TINT_RB_STOPS * tn);
  // Keep brightness unchanged: white balance only moves colour.
  const y = LUMA_R * gr + LUMA_G * gg + LUMA_B * gb;
  gr /= y;
  gg /= y;
  gb /= y;
  const ev = (p.brightness / 100) * EV_PER_100;
  return {
    ev,
    wb: [gr, gg, gb],
    highlights: p.highlights / 100,
    shadows: p.shadows / 100,
    shoulder: Math.min(1, Math.max(0, ev / EV_PER_100)),
    contrast: p.contrast / 100,
    vibrance: p.vibrance / 100,
    saturation: p.saturation / 100,
  };
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Soft roll-off above SHOULDER_START so brightened windows don't hard-clip. */
export function shoulderCurve(x: number): number {
  if (x <= SHOULDER_START) return x;
  const room = 1 - SHOULDER_START;
  return SHOULDER_START + room * (1 - Math.exp(-(x - SHOULDER_START) / room));
}

/**
 * Adjust one pixel.
 * @param r,g,b      source colour, sRGB 0..1
 * @param maskSrgb   blurred source luminance at this pixel, sRGB-encoded 0..1
 */
export function adjustPixel(
  r: number,
  g: number,
  b: number,
  maskSrgb: number,
  u: AdjustUniforms
): [number, number, number] {
  // 1. Linear light + white balance + exposure.
  const exp = Math.pow(2, u.ev);
  let lr = srgbToLinear(r) * u.wb[0] * exp;
  let lg = srgbToLinear(g) * u.wb[1] * exp;
  let lb = srgbToLinear(b) * u.wb[2] * exp;

  // 2. Highlights / Shadows: a gain in stops, weighted by tone zone.
  if (u.highlights !== 0 || u.shadows !== 0) {
    const pixelY = LUMA_R * lr + LUMA_G * lg + LUMA_B * lb;
    const maskY = srgbToLinear(maskSrgb) * exp;
    const m = linearToSrgb(Math.min(1, (1 - MASK_DETAIL_MIX) * maskY + MASK_DETAIL_MIX * pixelY));
    const wh = smoothstep(HIGHLIGHT_ZONE[0], HIGHLIGHT_ZONE[1], m);
    const ws = 1 - smoothstep(SHADOW_ZONE[0], SHADOW_ZONE[1], m);
    const gain = Math.pow(2, HIGHLIGHT_STOPS * u.highlights * wh + SHADOW_STOPS * u.shadows * ws);
    lr *= gain;
    lg *= gain;
    lb *= gain;
  }

  // 3. Highlight shoulder (only blended in when brightening).
  if (u.shoulder > 0) {
    lr += (shoulderCurve(lr) - lr) * u.shoulder;
    lg += (shoulderCurve(lg) - lg) * u.shoulder;
    lb += (shoulderCurve(lb) - lb) * u.shoulder;
  }

  // 4. Back to perceptual (sRGB) for contrast and colour.
  let pr = clamp01(linearToSrgb(lr));
  let pg = clamp01(linearToSrgb(lg));
  let pb = clamp01(linearToSrgb(lb));

  if (u.contrast > 0) {
    const k = CONTRAST_S_AMOUNT * u.contrast;
    pr += (pr * pr * (3 - 2 * pr) - pr) * k;
    pg += (pg * pg * (3 - 2 * pg) - pg) * k;
    pb += (pb * pb * (3 - 2 * pb) - pb) * k;
  } else if (u.contrast < 0) {
    const k = -u.contrast;
    pr += (0.5 + (pr - 0.5) * CONTRAST_FLATTEN - pr) * k;
    pg += (0.5 + (pg - 0.5) * CONTRAST_FLATTEN - pg) * k;
    pb += (0.5 + (pb - 0.5) * CONTRAST_FLATTEN - pb) * k;
  }

  // 5. Vibrance (gentle on already-strong colours) then Saturation.
  if (u.vibrance !== 0 || u.saturation !== 0) {
    const y = LUMA_R * pr + LUMA_G * pg + LUMA_B * pb;
    const chroma = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
    const factor = (1 + u.vibrance * (1 - chroma)) * (1 + u.saturation);
    pr = y + (pr - y) * factor;
    pg = y + (pg - y) * factor;
    pb = y + (pb - y) * factor;
  }

  return [clamp01(pr), clamp01(pg), clamp01(pb)];
}

// ---------------------------------------------------------------------------
// Geometry: quarter turns + straighten, with an automatic crop that keeps the
// output the same size and free of empty corners.
// ---------------------------------------------------------------------------

export interface GeometryPlan {
  outW: number;
  outH: number;
  /** total clockwise rotation in radians (quarter turns + straighten) */
  angle: number;
  /** zoom needed so the straightened photo still fills the frame */
  scale: number;
}

export function outputSize(srcW: number, srcH: number, rotate: number): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: srcH, h: srcW } : { w: srcW, h: srcH };
}

/** Zoom so a frame W×H is fully covered after tilting the photo by `deg`. */
export function coverScale(w: number, h: number, deg: number): number {
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.max(c + (h / w) * s, c + (w / h) * s);
}

export function planGeometry(srcW: number, srcH: number, p: Pick<AdjustParams, "rotate" | "straighten">): GeometryPlan {
  const { w, h } = outputSize(srcW, srcH, p.rotate);
  return {
    outW: w,
    outH: h,
    angle: ((p.rotate + p.straighten) * Math.PI) / 180,
    scale: coverScale(w, h, p.straighten),
  };
}

/**
 * Where an output pixel centre (ox, oy) samples from in the source, in source
 * pixel coordinates. Mirrors the vertex/fragment maths in the shader.
 */
export function outputToSource(
  ox: number,
  oy: number,
  srcW: number,
  srcH: number,
  g: GeometryPlan
): [number, number] {
  const x = (ox - g.outW / 2) / g.scale;
  const y = (oy - g.outH / 2) / g.scale;
  // Inverse of a clockwise rotation (image y axis points down).
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  const sx = c * x + s * y;
  const sy = -s * x + c * y;
  return [sx + srcW / 2, sy + srcH / 2];
}
