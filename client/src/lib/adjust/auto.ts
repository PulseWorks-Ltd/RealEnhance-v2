// Photo Adjust: image analysis (no DOM, so it can be unit-tested).
//  - buildLumaMask: the blurred luminance used by Highlights/Shadows
//  - autoTone:      the "Auto" button (histogram based, conservative)
//  - estimateStraighten: the Straighten "Auto" button (port of the worker's
//    estimateRollFromEdges in worker/src/pipeline/preprocess.ts)

import { LUMA_B, LUMA_G, LUMA_R, linearToSrgb, srgbToLinear } from "./colour";
import { sanitizeAdjustParams, type AdjustParams } from "./params";

const SRGB_TO_LINEAR_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc / span;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const span = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / span;
      const add = src[Math.min(h - 1, y + r + 1) * w + x];
      const sub = src[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
}

/**
 * Blurred luminance of a (small, analysis-size) RGBA image, returned
 * sRGB-encoded in 8 bits so dark tones keep their precision.
 */
export function buildLumaMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    a[i] =
      LUMA_R * SRGB_TO_LINEAR_LUT[rgba[j]] +
      LUMA_G * SRGB_TO_LINEAR_LUT[rgba[j + 1]] +
      LUMA_B * SRGB_TO_LINEAR_LUT[rgba[j + 2]];
  }
  // Three box passes ≈ a Gaussian; radius about 2% of the long edge.
  const r = Math.max(1, Math.round(Math.max(w, h) * 0.02));
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.min(1, linearToSrgb(a[i])) * 255);
  return out;
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i / (hist.length - 1);
  }
  return 1;
}

function round(x: number): number {
  const r = Math.round(x);
  return Object.is(r, -0) ? 0 : r;
}

/**
 * "Auto": gentle, property-friendly corrections. It only fixes what is clearly
 * off (dark photo, blown windows, crushed corners, a strong colour cast) and
 * leaves geometry alone.
 */
export function autoTone(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Partial<AdjustParams> {
  const hist = new Uint32Array(256);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let mid = 0;
  const n = w * h;
  for (let j = 0; j < n * 4; j += 4) {
    const lr = SRGB_TO_LINEAR_LUT[rgba[j]];
    const lg = SRGB_TO_LINEAR_LUT[rgba[j + 1]];
    const lb = SRGB_TO_LINEAR_LUT[rgba[j + 2]];
    const y = LUMA_R * lr + LUMA_G * lg + LUMA_B * lb;
    const p = linearToSrgb(y);
    hist[Math.min(255, Math.max(0, Math.round(p * 255)))]++;
    // Grey-world colour estimate from mid-tones only (ignores windows/black).
    if (p > 0.2 && p < 0.85) {
      sr += lr;
      sg += lg;
      sb += lb;
      mid++;
    }
  }

  const p02 = percentile(hist, n, 0.02);
  const median = percentile(hist, n, 0.5);
  const p99 = percentile(hist, n, 0.99);

  // Brightness: nudge the median toward a bright, airy 0.52 (half strength).
  const targetMedian = 0.52;
  let ev = 0;
  if (median > 0.02) {
    ev = 0.5 * Math.log2(srgbToLinear(targetMedian) / srgbToLinear(median));
  }
  ev = Math.max(-0.75, Math.min(1.2, ev));
  const brightness = Math.abs(ev) < 0.08 ? 0 : (ev / 1.5) * 100;

  // Highlights: recover windows if the top 1% is near white.
  const highlights = p99 > 0.96 ? -Math.min(60, 25 + (p99 - 0.96) * 900) : 0;

  // Shadows: lift crushed corners.
  const shadows = p02 < 0.06 ? Math.min(45, 15 + (0.06 - p02) * 500) : 0;

  // Colour cast: half-correct the grey-world imbalance, capped.
  let warmth = 0;
  let tint = 0;
  if (mid > n * 0.05 && sg > 0) {
    const rb = Math.log2((sr + 1e-6) / (sb + 1e-6)); // > 0 means too warm
    const gm = Math.log2((sg + 1e-6) / Math.sqrt((sr + 1e-6) * (sb + 1e-6))); // > 0 means too green
    // Interiors are often meant to feel a little warm: ignore small casts.
    if (Math.abs(rb) > 0.12) warmth = Math.max(-25, Math.min(25, (-0.5 * rb) / 0.7 * 100));
    if (Math.abs(gm) > 0.06) tint = Math.max(-20, Math.min(20, (0.5 * gm) / 0.33 * 100));
  }

  return sanitizeAdjustParams({
    brightness: round(brightness),
    contrast: 5,
    highlights: round(highlights),
    shadows: round(shadows),
    warmth: round(warmth),
    tint: round(tint),
    vibrance: 10,
    saturation: 0,
  });
}

function normalizeAngleDeg(angle: number): number {
  let out = angle;
  while (out > 90) out -= 180;
  while (out < -90) out += 180;
  return out;
}

/**
 * Average tilt of near-vertical edges, in degrees (same maths as the
 * worker's estimateRollFromEdges). Positive = lines lean clockwise.
 */
export function estimateRollFromEdges(gray: Uint8Array | Uint8ClampedArray, width: number, height: number): number {
  if (width < 8 || height < 8) return 0;
  let weightedSum = 0;
  let weightTotal = 0;
  const edgeThreshold = 36;
  const maxVerticalDeviation = 25;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1];
      const gy =
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag < edgeThreshold) continue;
      const gradAngle = Math.atan2(gy, gx) * (180 / Math.PI);
      const lineAngle = normalizeAngleDeg(gradAngle + 90);
      const fromVertical = normalizeAngleDeg(lineAngle - 90);
      const absFromVertical = Math.abs(fromVertical);
      if (absFromVertical > maxVerticalDeviation) continue;
      const weight = mag * (1 - absFromVertical / maxVerticalDeviation);
      weightedSum += fromVertical * weight;
      weightTotal += weight;
    }
  }
  if (weightTotal <= 1e-6) return 0;
  return weightedSum / weightTotal;
}

/** Straighten value (clockwise degrees) that undoes the measured tilt. */
export function estimateStraighten(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): number {
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
  }
  const roll = estimateRollFromEdges(gray, w, h);
  // Matches the worker: tiny tilts are noise, big ones are probably the room
  // (stairs, sloped ceilings), not the camera.
  if (Math.abs(roll) < 0.2 || Math.abs(roll) > 6) return 0;
  const v = Number((-roll).toFixed(1));
  return Object.is(v, -0) ? 0 : v;
}
