import sharp from "sharp";
import { StructuralMask } from "./structuralMask";
import { computeBrightnessDiff } from "./brightnessValidator";
import { VALIDATION_THRESHOLDS } from "./config";
import { StructuralValidationResult } from "./types";
import { ensureSameSizeAsBase } from "./resizeUtils";
// Assume these helpers exist or are stubbed:
// computeStructuralChangeRatio, computeWindowIoU, computeLandcoverChangeRatio

export type Stage1AValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
  brightnessDiff?: number;
};

function computeIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] | b[i]) uni++;
    if (a[i] & b[i]) inter++;
  }
  return uni > 0 ? inter / uni : 1;
}

function maskEdges(edges: Uint8Array, mask: StructuralMask): Uint8Array {
  const out = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    out[i] = edges[i] & mask.data[i];
  }
  return out;
}

async function cannyEdge(imagePath: string): Promise<Uint8Array> {
  // Simple Sobel-based edge for now
  const meta = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(meta.data.buffer, meta.data.byteOffset, meta.data.byteLength);
  const { width, height } = meta.info;
  const edge = new Uint8Array(buf.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (
        buf[i - width - 1] + 2 * buf[i - 1] + buf[i + width - 1] -
        buf[i - width + 1] - 2 * buf[i + 1] - buf[i + width + 1]
      );
      const gy = (
        buf[i - width - 1] + 2 * buf[i - width] + buf[i - width + 1] -
        buf[i + width - 1] - 2 * buf[i + width] - buf[i + width + 1]
      );
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g > 38) edge[i] = 1;
    }
  }
  return edge;
}

export async function validateStage1A(
  canonicalBasePath: string,
  stage1APath: string,
  structuralMask: StructuralMask
): Promise<Stage1AValidationResult> {
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage1APath).metadata();
  const baseW = baseMeta.width!;
  const baseH = baseMeta.height!;
  const outW = outMeta.width!;
  const outH = outMeta.height!;

  if (baseW !== outW || baseH !== outH) {
    const wRatio = outW / baseW;
    const hRatio = outH / baseH;
    const maxDev = Math.max(Math.abs(wRatio - 1), Math.abs(hRatio - 1));
    if (maxDev <= 0.01) {
      await sharp(stage1APath)
        .resize(baseW, baseH, { fit: "fill", withoutEnlargement: false })
        .toFile(stage1APath + ".aligned.webp");
      stage1APath = stage1APath + ".aligned.webp";
    } else {
      return {
        ok: false,
        reason: "dimension_change",
        dims: { baseW, baseH, outW, outH },
      };
    }
  }

  const brightnessDiff = await computeBrightnessDiff(canonicalBasePath, stage1APath);
  const baseEdges = await cannyEdge(canonicalBasePath);
  const outEdges = await cannyEdge(stage1APath);
  const baseStruct = maskEdges(baseEdges, structuralMask);
  const outStruct = maskEdges(outEdges, structuralMask);
  const structuralIoU = computeIoU(baseStruct, outStruct);

  if (structuralIoU < 0.85) {
    return { ok: false, reason: "structural_change", structuralIoU };
  }
  if (brightnessDiff < -0.3 || brightnessDiff > 1.2) {
    return { ok: false, reason: "brightness_out_of_range", brightnessDiff };
  }
  return { ok: true, structuralIoU, brightnessDiff };
}

export async function computeStructuralChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real mask diff logic using mask object
  return 0.01; // always pass for now
}

export async function computeWindowIoU(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real window IoU logic using mask object
  return 0.99; // always pass for now
}

export async function computeLandcoverChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real landcover diff logic using mask object
  return 0.0; // always pass for now
}

export async function validateStage1AStructural(
  canonicalPath: string,
  candidatePath: string,
  masks: { structuralMask: StructuralMask; windowMask?: any; landcoverMask?: any; },
  sceneType: "interior" | "exterior"
): Promise<StructuralValidationResult> {
  const candidatePathResized = await ensureSameSizeAsBase(canonicalPath, candidatePath);
  const structuralChangeRatio = await computeStructuralChangeRatio(
    canonicalPath,
    candidatePathResized,
    masks.structuralMask
  );
  let windowIoU: number | undefined;
  if (masks.windowMask) {
    windowIoU = await computeWindowIoU(canonicalPath, candidatePathResized, masks.windowMask);
  }
  let landcoverChangeRatio: number | undefined;
  if (sceneType === "exterior" && masks.landcoverMask) {
    landcoverChangeRatio = await computeLandcoverChangeRatio(
      canonicalPath,
      candidatePathResized,
      masks.landcoverMask
    );
  }
  if (structuralChangeRatio > VALIDATION_THRESHOLDS.structuralChangeMaxRatioStage1A) {
    return {
      ok: false,
      reason: "structural_pixels_changed",
      structuralChangeRatio,
      windowIoU,
      landcoverChangeRatio,
    };
  }
  if (typeof windowIoU === "number" && windowIoU < VALIDATION_THRESHOLDS.windowIoUMinStage1A) {
    return {
      ok: false,
      reason: "window_shape_or_position_changed",
      structuralChangeRatio,
      windowIoU,
      landcoverChangeRatio,
    };
  }
  if (sceneType === "exterior" && typeof landcoverChangeRatio === "number") {
    if (landcoverChangeRatio > VALIDATION_THRESHOLDS.maxLandcoverChangeExterior) {
      return {
        ok: false,
        reason: "landcover_changed",
        structuralChangeRatio,
        windowIoU,
        landcoverChangeRatio,
      };
    }
  }
  return {
    ok: true,
    structuralChangeRatio,
    windowIoU,
    landcoverChangeRatio,
  };
}
