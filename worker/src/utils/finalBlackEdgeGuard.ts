import sharp from "sharp";
import { promises as fs } from "fs";

type Rect = { left: number; top: number; width: number; height: number };

type ScanStats = {
  width: number;
  height: number;
  borderPx: number;
  globalDarkRatio: number;
  topDarkRatio: number;
  bottomDarkRatio: number;
  leftDarkRatio: number;
  rightDarkRatio: number;
  cornerMaxDarkRatio: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function isDarkPixel(r: number, g: number, b: number, a: number): boolean {
  return a <= 24 || (r <= 20 && g <= 20 && b <= 20);
}

function rectDarkRatio(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  rect: Rect
): number {
  const left = clamp(rect.left, 0, width - 1);
  const top = clamp(rect.top, 0, height - 1);
  const right = clamp(rect.left + rect.width - 1, 0, width - 1);
  const bottom = clamp(rect.top + rect.height - 1, 0, height - 1);

  let dark = 0;
  let total = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const index = (y * width + x) * channels;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = channels > 3 ? data[index + 3] : 255;
      if (isDarkPixel(r, g, b, a)) dark++;
      total++;
    }
  }
  return total > 0 ? dark / total : 0;
}

async function scanForBlackEdges(imagePath: string): Promise<{ trigger: boolean; stats: ScanStats }> {
  const sample = await sharp(imagePath)
    .ensureAlpha()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = sample.info.width || 0;
  const height = sample.info.height || 0;
  const channels = sample.info.channels || 4;
  if (!width || !height) {
    return {
      trigger: false,
      stats: {
        width: 0,
        height: 0,
        borderPx: 0,
        globalDarkRatio: 0,
        topDarkRatio: 0,
        bottomDarkRatio: 0,
        leftDarkRatio: 0,
        rightDarkRatio: 0,
        cornerMaxDarkRatio: 0,
      },
    };
  }

  const borderPx = clamp(Math.round(Math.min(width, height) * 0.03), 6, 24);
  const cornerPx = clamp(Math.round(Math.min(width, height) * 0.08), 16, 64);

  const topDarkRatio = rectDarkRatio(sample.data, width, height, channels, { left: 0, top: 0, width, height: borderPx });
  const bottomDarkRatio = rectDarkRatio(sample.data, width, height, channels, { left: 0, top: height - borderPx, width, height: borderPx });
  const leftDarkRatio = rectDarkRatio(sample.data, width, height, channels, { left: 0, top: 0, width: borderPx, height });
  const rightDarkRatio = rectDarkRatio(sample.data, width, height, channels, { left: width - borderPx, top: 0, width: borderPx, height });

  const cornerRatios = [
    rectDarkRatio(sample.data, width, height, channels, { left: 0, top: 0, width: cornerPx, height: cornerPx }),
    rectDarkRatio(sample.data, width, height, channels, { left: width - cornerPx, top: 0, width: cornerPx, height: cornerPx }),
    rectDarkRatio(sample.data, width, height, channels, { left: 0, top: height - cornerPx, width: cornerPx, height: cornerPx }),
    rectDarkRatio(sample.data, width, height, channels, { left: width - cornerPx, top: height - cornerPx, width: cornerPx, height: cornerPx }),
  ];

  const globalDarkRatio = rectDarkRatio(sample.data, width, height, channels, { left: 0, top: 0, width, height });
  const edgeMax = Math.max(topDarkRatio, bottomDarkRatio, leftDarkRatio, rightDarkRatio);
  const cornerMaxDarkRatio = Math.max(...cornerRatios);

  const trigger =
    (edgeMax >= 0.28 && globalDarkRatio < 0.35) ||
    (cornerMaxDarkRatio >= 0.2 && cornerMaxDarkRatio > globalDarkRatio * 2.2 && globalDarkRatio < 0.25);

  return {
    trigger,
    stats: {
      width,
      height,
      borderPx,
      globalDarkRatio,
      topDarkRatio,
      bottomDarkRatio,
      leftDarkRatio,
      rightDarkRatio,
      cornerMaxDarkRatio,
    },
  };
}

export async function detectBlackCornerArtifact(imagePath: string): Promise<{ detected: boolean; stats: ScanStats }> {
  const sample = await sharp(imagePath)
    .ensureAlpha()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = sample.info.width || 0;
  const height = sample.info.height || 0;
  const channels = sample.info.channels || 4;
  if (!width || !height) {
    return {
      detected: false,
      stats: {
        width: 0,
        height: 0,
        borderPx: 0,
        globalDarkRatio: 0,
        topDarkRatio: 0,
        bottomDarkRatio: 0,
        leftDarkRatio: 0,
        rightDarkRatio: 0,
        cornerMaxDarkRatio: 0,
      },
    };
  }

  const cornerRegionRatio = Math.max(0.005, Number(process.env.BLACK_CORNER_REGION_RATIO || 0.02));
  const nearBlackLuma = clamp(Math.round(Number(process.env.BLACK_CORNER_NEAR_BLACK_LUMA || 18)), 0, 255);
  const cornerArtifactRatio = Math.max(0, Math.min(1, Number(process.env.BLACK_CORNER_ARTIFACT_RATIO || 0.6)));
  const globalMeanBrightnessGuard = clamp(Number(process.env.BLACK_CORNER_GLOBAL_BRIGHTNESS_GUARD || 40), 0, 255);

  const regionW = Math.max(1, Math.floor(width * cornerRegionRatio));
  const regionH = Math.max(1, Math.floor(height * cornerRegionRatio));

  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    const r = sample.data[i] || 0;
    const g = sample.data[i + 1] || 0;
    const b = sample.data[i + 2] || 0;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  const cornerRatio = (x0: number, y0: number) => {
    let dark = 0;
    let total = 0;
    const x1 = Math.min(width, x0 + regionW);
    const y1 = Math.min(height, y0 + regionH);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (lumaAt(x, y) < nearBlackLuma) dark++;
        total++;
      }
    }
    return total > 0 ? dark / total : 0;
  };

  let globalLumaSum = 0;
  let globalNearBlackCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const luma = lumaAt(x, y);
      globalLumaSum += luma;
      if (luma < nearBlackLuma) globalNearBlackCount++;
    }
  }
  const meanBrightness = globalLumaSum / Math.max(1, width * height);
  const globalDarkRatio = globalNearBlackCount / Math.max(1, width * height);

  const topLeft = cornerRatio(0, 0);
  const topRight = cornerRatio(Math.max(0, width - regionW), 0);
  const bottomLeft = cornerRatio(0, Math.max(0, height - regionH));
  const bottomRight = cornerRatio(Math.max(0, width - regionW), Math.max(0, height - regionH));

  const cornerRatios = [topLeft, topRight, bottomLeft, bottomRight];
  const cornerMaxDarkRatio = Math.max(...cornerRatios);
  const strongCorners = cornerRatios.map((r) => r > cornerArtifactRatio);
  const adjacentCornerSignal =
    (strongCorners[0] && strongCorners[1]) ||
    (strongCorners[0] && strongCorners[2]) ||
    (strongCorners[1] && strongCorners[3]) ||
    (strongCorners[2] && strongCorners[3]);

  const detected =
    meanBrightness > globalMeanBrightnessGuard &&
    (cornerMaxDarkRatio > cornerArtifactRatio || adjacentCornerSignal);

  return {
    detected,
    stats: {
      width,
      height,
      borderPx: Math.min(regionW, regionH),
      globalDarkRatio,
      topDarkRatio: Math.max(topLeft, topRight),
      bottomDarkRatio: Math.max(bottomLeft, bottomRight),
      leftDarkRatio: Math.max(topLeft, bottomLeft),
      rightDarkRatio: Math.max(topRight, bottomRight),
      cornerMaxDarkRatio,
    },
  };
}

async function detectContentBounds(imagePath: string): Promise<{ width: number; height: number; bounds: Rect | null }> {
  const raw = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = raw.info.width || 0;
  const height = raw.info.height || 0;
  const channels = raw.info.channels || 4;
  if (!width || !height) return { width, height, bounds: null };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * channels;
      const r = raw.data[index];
      const g = raw.data[index + 1];
      const b = raw.data[index + 2];
      const a = channels > 3 ? raw.data[index + 3] : 255;
      if (!isDarkPixel(r, g, b, a)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { width, height, bounds: null };
  }

  const pad = 1;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);

  return {
    width,
    height,
    bounds: {
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
    },
  };
}

export async function applyFinalBlackEdgeGuard(imagePath: string): Promise<{ changed: boolean; reason: string; stats?: ScanStats }> {
  try {
    const scan = await scanForBlackEdges(imagePath);
    if (!scan.trigger) {
      return { changed: false, reason: "not_detected", stats: scan.stats };
    }

    const { width, height, bounds } = await detectContentBounds(imagePath);
    if (!bounds || !width || !height) {
      return { changed: false, reason: "no_content_bounds", stats: scan.stats };
    }

    if (bounds.left === 0 && bounds.top === 0 && bounds.width === width && bounds.height === height) {
      return { changed: false, reason: "already_full_frame", stats: scan.stats };
    }

    const leftTrim = bounds.left;
    const rightTrim = width - (bounds.left + bounds.width);
    const topTrim = bounds.top;
    const bottomTrim = height - (bounds.top + bounds.height);
    const maxTrimX = Math.floor(width * 0.12);
    const maxTrimY = Math.floor(height * 0.12);
    if (leftTrim > maxTrimX || rightTrim > maxTrimX || topTrim > maxTrimY || bottomTrim > maxTrimY) {
      return { changed: false, reason: "trim_too_aggressive", stats: scan.stats };
    }

    const originalArea = width * height;
    const croppedArea = bounds.width * bounds.height;
    if (croppedArea / Math.max(1, originalArea) < 0.72) {
      return { changed: false, reason: "area_drop_too_large", stats: scan.stats };
    }

    const tmpPath = imagePath.replace(/(\.[^./]+)$/, "-blackedge$1");
    await sharp(imagePath).extract(bounds).toFile(tmpPath);
    await fs.rename(tmpPath, imagePath);

    return { changed: true, reason: "cropped", stats: scan.stats };
  } catch {
    return { changed: false, reason: "guard_error" };
  }
}

export async function assertNoDarkBorder(
  imagePath: string,
  borderPx = 3,
  threshold = 5,
  maxDarkRatio = 0.02
): Promise<void> {
  const raw = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = raw.info.width || 0;
  const height = raw.info.height || 0;
  const channels = raw.info.channels || 4;
  if (!width || !height) return;

  const bpx = Math.max(1, Math.min(borderPx, Math.floor(Math.min(width, height) / 2)));
  const darkThreshold = clamp(Math.round(threshold), 0, 255);
  const allowedRatio = Math.max(0, Math.min(1, maxDarkRatio));

  let darkCount = 0;
  let borderCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder = x < bpx || y < bpx || x >= width - bpx || y >= height - bpx;
      if (!onBorder) continue;

      borderCount++;

      const i = (y * width + x) * channels;
      const r = raw.data[i];
      const g = raw.data[i + 1];
      const b = raw.data[i + 2];
      if (r < darkThreshold && g < darkThreshold && b < darkThreshold) {
        darkCount++;
      }
    }
  }

  const ratio = borderCount > 0 ? darkCount / borderCount : 0;
  if (ratio > allowedRatio) {
    const err: any = new Error("BLACK_BORDER_DETECTED");
    err.code = "BLACK_BORDER_DETECTED";
    err.darkRatio = ratio;
    err.maxDarkRatio = allowedRatio;
    err.borderPx = bpx;
    err.threshold = darkThreshold;
    throw err;
  }
}
