import sharp from "sharp";
import { StageAwareConfig } from "../stageAwareConfig";
import { ValidationTrigger } from "./types";

interface PaintOverResult {
  triggers: ValidationTrigger[];
  debugArtifacts?: string[];
}

interface PaintOverParams {
  baselinePath: string;
  candidatePath: string;
  config: StageAwareConfig;
  jobId?: string;
}

interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Minimal 3x3 Sobel kernels applied on a grayscale raw buffer.
const sobel = (data: Uint8Array, width: number, height: number): Uint8Array => {
  const out = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const gx =
        data[idx - width + 1] + 2 * data[idx + 1] + data[idx + width + 1] -
        (data[idx - width - 1] + 2 * data[idx - 1] + data[idx + width - 1]);
      const gy =
        data[idx - width - 1] + 2 * data[idx - width] + data[idx - width + 1] -
        (data[idx + width - 1] + 2 * data[idx + width] + data[idx + width + 1]);
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      out[idx] = mag > 64 ? 255 : 0;
    }
  }
  return out;
};

const laplacianVariance = (data: Uint8Array, width: number, height: number, roi: Roi): number => {
  const values: number[] = [];
  const x0 = Math.max(1, roi.x);
  const y0 = Math.max(1, roi.y);
  const x1 = Math.min(width - 2, roi.x + roi.width - 1);
  const y1 = Math.min(height - 2, roi.y + roi.height - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = y * width + x;
      const val =
        -4 * data[idx] +
        data[idx - 1] +
        data[idx + 1] +
        data[idx - width] +
        data[idx + width];
      values.push(val);
    }
  }
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return variance;
};

const edgeDensity = (edges: Uint8Array, width: number, roi: Roi): number => {
  const x1 = roi.x + roi.width;
  const y1 = roi.y + roi.height;
  let count = 0;
  for (let y = roi.y; y < y1; y++) {
    for (let x = roi.x; x < x1; x++) {
      const idx = y * width + x;
      if (edges[idx]) count += 1;
    }
  }
  const area = Math.max(1, roi.width * roi.height);
  return count / area;
};

// Lightweight connected-components over binary edge map.
const findRois = (edges: Uint8Array, width: number, height: number, minArea: number): Roi[] => {
  const visited = new Uint8Array(width * height);
  const rois: Roi[] = [];
  const offsets = [1, -1, width, -width, width + 1, width - 1, -width + 1, -width - 1];

  for (let i = 0; i < edges.length; i++) {
    if (!edges[i] || visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    let minX = width,
      minY = height,
      maxX = 0,
      maxY = 0,
      pixels = 0;

    while (stack.length) {
      const idx = stack.pop()!;
      const y = Math.floor(idx / width);
      const x = idx - y * width;
      pixels += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const off of offsets) {
        const n = idx + off;
        if (n < 0 || n >= edges.length) continue;
        if (!edges[n] || visited[n]) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }

    const roiWidth = maxX - minX + 1;
    const roiHeight = maxY - minY + 1;
    if (roiWidth * roiHeight < minArea) continue;
    const aspect = roiHeight / Math.max(1, roiWidth);
    if (aspect < 1.8 || aspect > 4.5) continue;
    rois.push({ x: Math.max(0, minX - 4), y: Math.max(0, minY - 4), width: Math.min(width - minX + 4, roiWidth + 8), height: Math.min(height - minY + 4, roiHeight + 8) });
  }

  return rois;
};

const loadResizedGray = async (path: string) => {
  const img = sharp(path).greyscale().resize({ width: 512, height: 512, fit: "inside" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

export const runPaintOverCheck = async (params: PaintOverParams): Promise<PaintOverResult> => {
  const { baselinePath, candidatePath, config, jobId } = params;
  if (!config.paintOverEnable) return { triggers: [] };

  const [base, cand] = await Promise.all([loadResizedGray(baselinePath), loadResizedGray(candidatePath)]);
  if (base.width !== cand.width || base.height !== cand.height) {
    return { triggers: [] };
  }

  const baseEdges = sobel(base.data, base.width, base.height);
  const rois = findRois(baseEdges, base.width, base.height, Math.ceil(config.paintOverMinRoiArea * base.width * base.height));
  if (!rois.length) return { triggers: [] };

  const triggers: ValidationTrigger[] = [];
  const debugArtifacts: string[] = [];

  for (const roi of rois) {
    const baseEdgeDensity = edgeDensity(baseEdges, base.width, roi);
    const baseTexVar = laplacianVariance(base.data, base.width, base.height, roi);

    // Skip low-signal regions in the baseline; they are not reliable openings.
    if (baseEdgeDensity < 0.005 || baseTexVar < 2) continue;

    const candEdges = sobel(cand.data, cand.width, cand.height);
    const candEdgeDensity = edgeDensity(candEdges, cand.width, roi);
    const candTexVar = laplacianVariance(cand.data, cand.width, cand.height, roi);

    const edgeRatio = candEdgeDensity / Math.max(baseEdgeDensity, 1e-6);
    const texRatio = candTexVar / Math.max(baseTexVar, 1e-6);

    const edgeBelow = edgeRatio < config.paintOverEdgeRatioMin;
    const texBelow = texRatio < config.paintOverTexRatioMin;

    if (edgeBelow && texBelow) {
      triggers.push({
        id: "fatal_opening_painted_over",
        score: Math.min(edgeRatio, texRatio),
        fatal: true,
        meta: { roi, edgeRatio, texRatio, baseEdgeDensity, baseTexVar, candEdgeDensity, candTexVar },
      });
    } else if (edgeBelow || texBelow) {
      triggers.push({
        id: "opening_painted_over",
        score: edgeBelow ? edgeRatio : texRatio,
        meta: { roi, edgeRatio, texRatio, baseEdgeDensity, baseTexVar, candEdgeDensity, candTexVar },
      });
    }

    if (config.logArtifactsOnFail && (edgeBelow || texBelow)) {
      const tag = jobId ? `${jobId}-` : "";
      const baseCropPath = `/tmp/struct-debug-${tag}paintover-base-${roi.x}-${roi.y}.png`;
      const candCropPath = `/tmp/struct-debug-${tag}paintover-cand-${roi.x}-${roi.y}.png`;
      await sharp(baselinePath)
        .greyscale()
        .resize(base.width, base.height)
        .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
        .toFile(baseCropPath);
      await sharp(candidatePath)
        .greyscale()
        .resize(cand.width, cand.height)
        .extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height })
        .toFile(candCropPath);
      debugArtifacts.push(baseCropPath, candCropPath);
    }
  }

  return { triggers, debugArtifacts: debugArtifacts.length ? debugArtifacts : undefined };
};
