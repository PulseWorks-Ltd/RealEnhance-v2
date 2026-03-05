import sharp from "sharp";

export interface Opening {
  type: "window" | "door";
  cx: number;
  cy: number;
  width: number;
  height: number;
}

type Candidate = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  type: "window" | "door";
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function percentileThreshold(hist: number[], total: number, pct: number): number {
  let acc = 0;
  const target = total * pct;
  for (let i = 0; i < hist.length; i += 1) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 128;
}

function buildHistogram(buf: Uint8Array): number[] {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i += 1) hist[buf[i]] += 1;
  return hist;
}

function majoritySmooth(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let c = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (mask[(y + dy) * w + (x + dx)]) c += 1;
        }
      }
      out[y * w + x] = c >= 5 ? 255 : 0;
    }
  }
  return out;
}

function floodFillBinary(
  mask: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  visited: Uint8Array
): { area: number; minx: number; miny: number; maxx: number; maxy: number } {
  const stack: number[] = [sx, sy];
  let area = 0;
  let minx = sx;
  let miny = sy;
  let maxx = sx;
  let maxy = sy;

  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const idx = y * w + x;
    if (visited[idx] || mask[idx] === 0) continue;
    visited[idx] = 1;
    area += 1;
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;

    stack.push(y, x - 1);
    stack.push(y, x + 1);
    stack.push(y - 1, x);
    stack.push(y + 1, x);
  }

  return { area, minx, miny, maxx, maxy };
}

function iou(a: Candidate, b: Candidate): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function gradientMagnitude(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const gx =
        -gray[(y - 1) * w + (x - 1)] - 2 * gray[y * w + (x - 1)] - gray[(y + 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] + 2 * gray[y * w + (x + 1)] + gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      out[i] = Math.min(255, Math.floor(Math.hypot(gx, gy) / 4));
    }
  }
  return out;
}

function edgeScore(grad: Uint8Array, w: number, h: number, c: Candidate): number {
  const x1 = Math.max(0, c.x);
  const y1 = Math.max(0, c.y);
  const x2 = Math.min(w - 1, c.x + c.w - 1);
  const y2 = Math.min(h - 1, c.y + c.h - 1);
  let strong = 0;
  let total = 0;
  const thr = 28;

  for (let x = x1; x <= x2; x += 1) {
    const ti = y1 * w + x;
    const bi = y2 * w + x;
    if (grad[ti] > thr) strong += 1;
    if (grad[bi] > thr) strong += 1;
    total += 2;
  }
  for (let y = y1; y <= y2; y += 1) {
    const li = y * w + x1;
    const ri = y * w + x2;
    if (grad[li] > thr) strong += 1;
    if (grad[ri] > thr) strong += 1;
    total += 2;
  }
  return total > 0 ? strong / total : 0;
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    if (kept.some((k) => iou(k, c) > 0.55)) continue;
    kept.push(c);
    if (kept.length >= 10) break;
  }
  return kept;
}

function toOpening(c: Candidate, w: number, h: number): Opening {
  return {
    type: c.type,
    cx: clamp01((c.x + c.w / 2) / w),
    cy: clamp01((c.y + c.h / 2) / h),
    width: clamp01(c.w / w),
    height: clamp01(c.h / h),
  };
}

export async function detectOpenings(imagePath: string): Promise<Opening[]> {
  const raw = await sharp(imagePath)
    .greyscale()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = raw.info.width || 0;
  const h = raw.info.height || 0;
  if (!w || !h) return [];

  const gray = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const hist = buildHistogram(gray);
  const brightThr = percentileThreshold(hist, gray.length, 0.74);
  const darkThr = percentileThreshold(hist, gray.length, 0.28);

  const brightMask = new Uint8Array(w * h);
  const darkMask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    brightMask[i] = gray[i] >= brightThr ? 255 : 0;
    darkMask[i] = gray[i] <= darkThr ? 255 : 0;
  }

  const smoothBright = majoritySmooth(brightMask, w, h);
  const smoothDark = majoritySmooth(darkMask, w, h);
  const grad = gradientMagnitude(gray, w, h);

  const minArea = Math.floor(w * h * 0.008);
  const maxArea = Math.floor(w * h * 0.35);
  const candidates: Candidate[] = [];

  const collect = (mask: Uint8Array, source: "bright" | "dark") => {
    const visited = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const idx = y * w + x;
        if (visited[idx] || !mask[idx]) continue;
        const cc = floodFillBinary(mask, w, h, x, y, visited);
        if (cc.area < minArea || cc.area > maxArea) continue;

        const cw = cc.maxx - cc.minx + 1;
        const ch = cc.maxy - cc.miny + 1;
        if (cw < Math.floor(w * 0.06) || ch < Math.floor(h * 0.08)) continue;

        const ar = cw / Math.max(1, ch);
        const cx = (cc.minx + cw / 2) / w;
        const cy = (cc.miny + ch / 2) / h;
        const floorTouch = (cc.miny + ch) / h >= 0.93;

        let type: "window" | "door" | null = null;
        if (source === "bright") {
          if (ar >= 0.65 && ar <= 3.8 && cy <= 0.78) type = "window";
          if (ar >= 0.28 && ar <= 1.2 && ch / h >= 0.28 && floorTouch) type = "door";
        } else {
          if (ar >= 0.22 && ar <= 1.1 && ch / h >= 0.32 && floorTouch) type = "door";
        }
        if (!type) continue;

        const cand: Candidate = {
          x: cc.minx,
          y: cc.miny,
          w: cw,
          h: ch,
          score: 0,
          type,
        };
        const eScore = edgeScore(grad, w, h, cand);
        if (eScore < 0.12) continue;
        cand.score = eScore + (type === "window" ? 0.05 : 0);
        candidates.push(cand);
      }
    }
  };

  collect(smoothBright, "bright");
  collect(smoothDark, "dark");

  const deduped = dedupeCandidates(candidates);
  return deduped.map((c) => toOpening(c, w, h));
}
