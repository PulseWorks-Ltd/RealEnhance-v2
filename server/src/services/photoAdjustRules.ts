/**
 * Photo Adjust: pure rules (no database or network), unit-tested in
 * photoAdjustRules.test.ts. See photoAdjust.ts for the service.
 */

import { extractKeyFromS3Url } from '../utils/s3.js';

export const SLIDER_RANGES: Record<string, [number, number, number]> = {
  brightness: [-100, 100, 0],
  contrast: [-100, 100, 0],
  highlights: [-100, 100, 0],
  shadows: [-100, 100, 0],
  warmth: [-100, 100, 0],
  tint: [-100, 100, 0],
  vibrance: [-100, 100, 0],
  saturation: [-100, 100, 0],
  straighten: [-10, 10, 1],
};

/** Same rules as client/src/lib/adjust/params.ts sanitizeAdjustParams. */
export function sanitizeAdjustments(input: unknown): Record<string, number> {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, number> = { v: 1 };
  for (const [key, [min, max, decimals]] of Object.entries(SLIDER_RANGES)) {
    const n = Number(src[key]);
    const v = Number.isFinite(n) ? Number(Math.min(max, Math.max(min, n)).toFixed(decimals)) : 0;
    out[key] = Object.is(v, -0) ? 0 : v;
  }
  const r = Number(src.rotate);
  out.rotate = Number.isFinite(r) ? (((Math.round(r / 90) % 4) + 4) % 4) * 90 : 0;
  return out;
}

export function isIdentityAdjustments(a: Record<string, number>): boolean {
  return Object.keys(SLIDER_RANGES).every((k) => !a[k]) && !a.rotate;
}

/** The output must be the source size (or swapped for a 90°/270° turn). */
export function adjustedDimensionsMatch(
  source: { width: number; height: number },
  output: { width: number; height: number },
  rotate: number
): boolean {
  const swapped = rotate === 90 || rotate === 270;
  const ew = swapped ? source.height : source.width;
  const eh = swapped ? source.width : source.height;
  return Math.abs(output.width - ew) <= 1 && Math.abs(output.height - eh) <= 1;
}

/** Candidate S3 keys for a (possibly signed, possibly path-style) image URL. */
export function storageKeysFromUrl(rawUrl?: string | null): string[] {
  if (!rawUrl) return [];
  const keys = new Set<string>();
  const noQuery = String(rawUrl).split('?')[0];
  const fromHelper = extractKeyFromS3Url(noQuery);
  if (fromHelper) keys.add(fromHelper);
  try {
    const path = new URL(noQuery).pathname.replace(/^\/+/, '');
    if (path) {
      keys.add(path);
      const slash = path.indexOf('/');
      if (slash > 0) keys.add(path.slice(slash + 1)); // path-style: bucket/key
    }
  } catch {
    /* not a URL */
  }
  for (const k of Array.from(keys)) {
    try {
      keys.add(decodeURIComponent(k));
    } catch {
      /* keep raw */
    }
  }
  return Array.from(keys).filter(Boolean);
}

/** Whether a job record references one of these storage keys (any output URL field). */
export function jobReferencesKey(job: unknown, keys: string[]): boolean {
  if (!job || keys.length === 0) return false;
  const text = JSON.stringify(job);
  return keys.some((k) => k.length > 8 && text.includes(k));
}
