import sharp from "sharp";

export type BBox = [number, number, number, number];

export interface WindowMask {
  mask: Uint8Array; // width*height, 0 or 255
  bbox: BBox; // [x,y,w,h]
  area: number; // pixels in mask
}

export interface WindowDetectionLocal {
  width: number;
  height: number;
  windows: WindowMask[];
}

function percentileThreshold(hist: number[], total: number, pct: number): number {
  let acc = 0;
  const target = total * pct;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 200; // fallback
}

function computeHistogram(buf: Uint8Array): number[] {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  return hist;
}

function floodFillBinary(
  bin: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  visited: Uint8Array
) {
  const stack: number[] = [sy, sx];
  let minx = sx,
    miny = sy,
    maxx = sx,
    maxy = sy,
    area = 0;
  const pts: number[] = [];
  while (stack.length) {
    const x = stack.pop() as number;
    const y = stack.pop() as number;
    const idx = y * w + x;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    if (visited[idx]) continue;
    if (bin[idx] === 0) continue;
    visited[idx] = 1;
    area++;
    pts.push(idx);
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
    // 4-connectivity
    stack.push(y, x - 1);
    stack.push(y, x + 1);
    stack.push(y - 1, x);
    stack.push(y + 1, x);
  }
  return { area, minx, miny, maxx, maxy, pts };
}

export async function detectWindowsLocal(imagePath: string): Promise<WindowDetectionLocal> {
  const { data, info } = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Compute global threshold from percentile (bright windows)
  const hist = computeHistogram(src);
  const pct = Number(process.env.WINDOW_BRIGHT_THRESH_PCTL || 0.7);
  const thr = percentileThreshold(hist, src.length, Math.max(0.5, Math.min(0.95, pct)));

  // Binary mask of bright regions
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < src.length; i++) bin[i] = src[i] >= thr ? 255 : 0;

  // Simple morphology: blur-like smoothing via 1-iteration neighbor majority
  const smooth = new Uint8Array(bin); // copy
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (bin[(y + dy) * W + (x + dx)]) count++;
        }
      }
      smooth[y * W + x] = count >= 5 ? 255 : 0;
    }
  }

  // Connected components to get bright regions
  const visited = new Uint8Array(W * H);
  const regions: WindowMask[] = [];
  const minArea = Math.floor(W * H * 0.02);
  const maxArea = Math.floor(W * H * 0.4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (visited[idx] || !smooth[idx]) continue;
      const ff = floodFillBinary(smooth, W, H, x, y, visited);
      if (ff.area < minArea || ff.area > maxArea) continue;

      // Build component mask
      const mask = new Uint8Array(W * H);
      for (const p of ff.pts) mask[p] = 255;

      // Aspect ratio heuristic for windows (avoid very tall/skinny or tiny squares)
      const bx = ff.minx;
      const by = ff.miny;
      const bw = ff.maxx - ff.minx + 1;
      const bh = ff.maxy - ff.miny + 1;
      const ar = bw / Math.max(1, bh);
      if (ar < 0.25 || ar > 6.0) continue;

      regions.push({ mask, bbox: [bx, by, bw, bh], area: ff.area });
    }
  }

  // Limit number of windows to a reasonable count (6)
  regions.sort((a, b) => b.area - a.area);
  const limited = regions.slice(0, 6);

  return { width: W, height: H, windows: limited };
}

export function iouMasks(a: Uint8Array, b: Uint8Array): number {
  let inter = 0,
    uni = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const aa = a[i] ? 1 : 0;
    const bb = b[i] ? 1 : 0;
    if (aa & bb) inter++;
    if (aa | bb) uni++;
  }
  return uni > 0 ? inter / uni : 0;
}

export function centroidFromMask(mask: Uint8Array, w: number) {
  let sx = 0,
    sy = 0,
    c = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const y = Math.floor(i / w);
      const x = i - y * w;
      sx += x;
      sy += y;
      c++;
    }
  }
  if (c === 0) return { cx: 0, cy: 0 };
  return { cx: sx / c, cy: sy / c };
}

export function occlusionScore(
  originalGray: Uint8Array,
  enhancedGray: Uint8Array,
  mask: Uint8Array
): { brightnessDrop: number; edgeDrop: number } {
  // Compute mean brightness inside mask for original/enhanced
  let oSum = 0,
    eSum = 0,
    count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      oSum += originalGray[i];
      eSum += enhancedGray[i];
      count++;
    }
  }
  const oMean = count ? oSum / count : 0;
  const eMean = count ? eSum / count : 0;
  const brightnessDrop = oMean > 0 ? Math.max(0, (oMean - eMean) / oMean) : 0;

  // Edge density (very simplified: absolute diff of neighbors)
  // Here we approximate by total variation inside mask
  let oVar = 0,
    eVar = 0;
  // Assume we know width by inferring sqrt length if needed; caller should precompute if used standalone.
  // For simplicity in validator we will recompute using sharp to get width.
  // Keep placeholder here.
  eVar = eVar; // no-op to satisfy linter in isolation
  oVar = oVar;
  const edgeDrop = 0; // computed in validator where width/height are known

  return { brightnessDrop, edgeDrop };
}
