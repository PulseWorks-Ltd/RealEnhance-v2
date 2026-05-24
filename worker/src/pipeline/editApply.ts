

import sharp from "sharp";
import { type FurnitureDetectionResult, type FurnitureItem } from "../ai/furnitureDetector";
import { regionEditWithGemini } from "../ai/gemini";
import {
  runFurnitureDetectionSafe as runSharedFurnitureDetectionSafe,
  type FurnitureDetectionSceneType,
} from "../ai/runFurnitureDetectionSafe";
import {
  buildSecondaryContinuityEditPrompt,
  buildEditPrompt,
  buildSemanticAddPrompt,
  buildSceneHint,
  normalizeEditMode,
  type EditContext,
} from "./prompts";
import { CONTINUITY_RENDER_QUEUE } from "../../../shared/src/constants";
import { runExperimentalSecondaryContinuity } from "../continuity/experimentalSecondaryContinuity";
import { VertexSecondaryContinuityError } from "../continuity/types";
import { nLog } from "../logger";
import { siblingOutPath, writeImageDataUrl } from "../utils/images";
import { detectOpeningsFromStage1A, type OpeningRegion } from "../utils/openingGeometry";
import path from "path";

const MIN_PROJECTION_DILATE_PX = 2;
const MAX_PROJECTION_DILATE_PX = 4;
const EXPANDED_EDIT_PADDING_RATIO = 0.2;
const MIN_EXPANDED_EDIT_DIMENSION_PX = 64;
const MIN_EXPANDED_EDIT_AREA_PX = 4096;
const MIN_EXPANDED_EDGE_FEATHER_PX = 2;
const MAX_EXPANDED_EDGE_FEATHER_PX = 5;
const MAX_REGION_EXPANSION_IMAGE_RATIO = 0.4;
const REGION_OVERLAP_MERGE_RATIO = 0.05;
const MAX_EXPANDED_REGION_AREA_RATIO = 0.35;
const MAX_REGION_EDIT_ATTEMPTS = 2;
const DEFAULT_REGION_INFERENCE_SIZE = 1024;
const MIN_REGION_INFERENCE_SIZE = 256;
const MAX_REGION_INFERENCE_SIZE = 2048;
const DELTA_DIFF_THRESHOLD = 24;
const DELTA_MASK_MIN_CHANGED_PIXELS = 12;
const HARMONIZE_MIN_SAMPLE_PIXELS = 48;
const HARMONIZE_DEFAULT_BAND_PX = 8;
const HARMONIZE_BOUNDARY_WEIGHT = 0.82;
const HARMONIZE_INTERIOR_WEIGHT = 0.16;
const HARMONIZE_MAX_GAIN_DELTA = 0.08;
const HARMONIZE_MAX_BIAS = 10;
const HARMONIZE_MAX_BLUR_SIGMA = 0.9;
const HARMONIZE_MAX_SHARPEN_M2 = 0.38;

type RegionRetryReason = "gemini_error" | "timeout" | "dimension_mismatch" | "empty_image" | "corrupted_image";

type PixelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ObjectClass = "LARGE" | "MEDIUM" | "SMALL";

type RegionComponent = {
  maskPngBuffer: Buffer;
  bbox: PixelBox;
  area: number;
};

type RegionPromptAssignment = {
  instruction: string;
  objectClass: ObjectClass;
  assignmentSource: "global" | "segment";
  keyword: string | null;
};

type TargetRegion = RegionComponent & RegionPromptAssignment;

type ExpandedRegion = TargetRegion & {
  expandedBox: PixelBox;
  expansionFactor: number;
};

type PromptObjectMatch = {
  keyword: string;
  objectClass: ObjectClass;
  pattern: RegExp;
};

type PromptObjectHit = {
  keyword: string;
  objectClass: ObjectClass;
  index: number;
  length: number;
  matchedText: string;
};

type RegionPromptPayload = {
  systemPrompt: string;
  userPrompt: string;
  promptText: string;
};

type RegionTransformMetadata = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  paddedWidth: number;
  paddedHeight: number;
  scaleX: number;
  scaleY: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  inferenceWidth: number;
  inferenceHeight: number;
};

type PreparedRegionInference = {
  transformedImageBuffer: Buffer;
  transformedMaskBuffer: Buffer;
  metadata: RegionTransformMetadata;
};

type ReverseTransformResult = {
  restoredCropBuffer: Buffer;
  reverseUnpaddedBuffer: Buffer;
  geminiReturnedBuffer: Buffer;
  restorePath: "crop-native" | "inference-unpad" | "crop-ratio-resize" | "inference-ratio-unpad" | "safe-cover-fallback";
  generatedWidth: number;
  generatedHeight: number;
};

type RegionEditResult = {
  restoredBuffer: Buffer;
  transformMetadata: RegionTransformMetadata;
  reverseTransform: ReverseTransformResult;
};

type CompositeExpandedCropDebug = {
  rawBinaryMask?: Buffer;
  featheredMask?: Buffer;
  finalAlphaMask?: Buffer;
  compositePreview?: Buffer;
  changedPixels?: number;
};
type HarmonizationSignalStats = {
  pixelCount: number;
  lumaMean: number;
  lumaStd: number;
  edgeEnergy: number;
  hfEnergy: number;
};

type HarmonizationPlan = {
  gain: number;
  bias: number;
  blurSigma: number;
  sharpenM2: number;
  sourceStats: HarmonizationSignalStats;
  targetStats: HarmonizationSignalStats;
};

function normalizeSceneDetailLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildStructuredSceneHint(params: {
  sceneType: "interior" | "exterior";
  roomType?: string;
  editContext?: EditContext;
}): string {
  const roomLabel = normalizeSceneDetailLabel(params.editContext?.roomType || params.roomType);
  const styleLabel = normalizeSceneDetailLabel(params.editContext?.stagingStyle);
  const sceneDetail = roomLabel && styleLabel
    ? `${roomLabel} with ${styleLabel} styling`
    : roomLabel || styleLabel || undefined;

  return buildSceneHint(params.sceneType, sceneDetail);
}

function composePromptText(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt.trim()}

${userPrompt.trim()}`.trim();
}

function shouldRunFurnitureDetection(ctx: {
  mode: EditMode;
  hasUserMask: boolean;
  maskCoverageRatio: number;
}): boolean {
  if (ctx.mode === "Reinstate") {
    return false;
  }

  if (ctx.mode === "Remove") {
    if (!ctx.hasUserMask) return true;
    if (ctx.maskCoverageRatio < 0.15) return true;
    return false;
  }

  return false;
}

async function runFurnitureDetectionSafe(params: {
  jobId?: string;
  imageId?: string;
  imagePath: string;
  mode: EditMode;
  hasUserMask: boolean;
  maskCoverageRatio: number;
  sceneType?: FurnitureDetectionSceneType;
  timeoutMs?: number;
}): Promise<FurnitureDetectionResult | null> {
  if (!shouldRunFurnitureDetection({
    mode: params.mode,
    hasUserMask: params.hasUserMask,
    maskCoverageRatio: params.maskCoverageRatio,
  })) {
    if (params.mode === "Reinstate") {
      console.info("DETECTOR_SKIPPED_REINSTATE", {
        event: "DETECTOR_SKIPPED_REINSTATE",
        jobId: params.jobId,
        imageId: params.imageId,
        mode: params.mode,
        imagePath: path.basename(params.imagePath),
      });
    }
    return null;
  }

  const response = await runSharedFurnitureDetectionSafe({
    imagePath: params.imagePath,
    sceneType: params.sceneType,
    timeoutMs: params.timeoutMs,
    logContext: {
      jobId: params.jobId,
      imageId: params.imageId,
      mode: params.mode,
      extra: {
        maskCoverageRatio: Number(params.maskCoverageRatio.toFixed(4)),
      },
    },
  });
  return response.result;
}

class RetryableRegionEditError extends Error {
  reason: RegionRetryReason;

  constructor(reason: RegionRetryReason, message: string) {
    super(message);
    this.name = "RetryableRegionEditError";
    this.reason = reason;
  }
}

const PROMPT_OBJECT_MATCHERS: PromptObjectMatch[] = [
  { keyword: "bed", objectClass: "LARGE", pattern: /\bbeds?\b/i },
  { keyword: "sofa", objectClass: "LARGE", pattern: /\bsofas?\b|\bcouches?\b/i },
  { keyword: "table", objectClass: "MEDIUM", pattern: /\btables?\b|\bdesks?\b/i },
  { keyword: "chair", objectClass: "SMALL", pattern: /\bchairs?\b/i },
  { keyword: "lamp", objectClass: "SMALL", pattern: /\blamps?\b/i },
  { keyword: "plant", objectClass: "SMALL", pattern: /\bplants?\b/i },
];

const EDIT_VERB_PATTERN = /\b(add|remove|replace|reinstate|restore|swap|place|insert|delete|take out)\b/gi;
const CLAUSE_BOUNDARY_PATTERN = /(?:\s*(?:,|;|\band\b|\bthen\b)\s*)/gi;

function normalizeSharpResizePosition(position: unknown): any {
  const original = position;
  if (position && typeof position === "object" && !Array.isArray(position)) {
    return position;
  }

  if (typeof position === "string") {
    const canonical = position.trim().toLowerCase().replace(/[_-]+/g, " ");
    if (canonical === "top left") {
      const normalized = "left top";
      console.log("[EDIT_POSITION_NORMALIZED]", { original, normalized });
      return normalized;
    }
    return position;
  }

  const fallback = "left top";
  console.log("[EDIT_POSITION_NORMALIZED]", { original, normalized: fallback });
  return fallback;
}

function allowedMaskArtifactPathForOutput(outPath: string): string {
  return `${outPath}.allowed-mask.png`;
}

function regionAllowedMaskArtifactPathForOutput(outPath: string, regionIndex: number): string {
  return siblingOutPath(outPath, `.allowed-mask.region-${regionIndex + 1}`, ".png");
}

function debugOverlayArtifactPathForOutput(outPath: string): string {
  return siblingOutPath(outPath, ".debug-overlay", ".png");
}

function isEditDebugOverlayEnabled(): boolean {
  return String(process.env.EDIT_DEBUG_OVERLAY || "").trim().toLowerCase() === "true";
}

function projectionDilatePx(width: number, height: number): number {
  const scaled = Math.round(Math.max(width, height) * 0.0025);
  return Math.max(MIN_PROJECTION_DILATE_PX, Math.min(MAX_PROJECTION_DILATE_PX, scaled || 5));
}

function shouldWriteReintegrationDebug(jobId?: string, imageId?: string): boolean {
  const enabled = String(process.env.REINTEGRATION_DEBUG_ENABLED || "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) return false;

  const targetJobId = String(process.env.REINTEGRATION_DEBUG_JOB_ID || "").trim();
  const targetImageId = String(process.env.REINTEGRATION_DEBUG_IMAGE_ID || "").trim();
  if (!targetJobId && !targetImageId) return true;
  if (targetJobId && String(jobId || "").trim() === targetJobId) return true;
  if (targetImageId && String(imageId || "").trim() === targetImageId) return true;
  return false;
}

function reintegrationDebugDirForOutput(outPath: string, regionIndex: number): string {
  return siblingOutPath(outPath, `.reintegration-debug.region-${regionIndex + 1}`, "");
}

async function writeReintegrationDebugImage(
  debugDir: string,
  filename: string,
  image: Buffer,
): Promise<void> {
  await sharp(image).png().toFile(path.join(debugDir, filename));
}

async function writeReintegrationDebugMetadata(
  debugDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await require("fs/promises").mkdir(debugDir, { recursive: true });
  await require("fs/promises").writeFile(
    path.join(debugDir, "metadata.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

function aspectRatio(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return width / height;
}

function isAspectRatioClose(left: number, right: number, tolerance = 0.02): boolean {
  if (left <= 0 || right <= 0) return false;
  return Math.abs(left - right) <= tolerance;
}

function resolveRegionInferenceSize(): number {
  const raw = Number.parseInt(String(process.env.REGION_EDIT_INFERENCE_SIZE || "").trim(), 10);
  if (!Number.isFinite(raw)) return DEFAULT_REGION_INFERENCE_SIZE;
  return Math.max(MIN_REGION_INFERENCE_SIZE, Math.min(MAX_REGION_INFERENCE_SIZE, raw));
}

async function prepareRegionInferencePayload(params: {
  editableCropBuffer: Buffer;
  guidanceMaskBuffer: Buffer;
  box: PixelBox;
}): Promise<PreparedRegionInference> {
  const { editableCropBuffer, guidanceMaskBuffer, box } = params;
  const inferenceWidth = resolveRegionInferenceSize();
  const inferenceHeight = inferenceWidth;

  const cropWidth = Math.max(1, box.width);
  const cropHeight = Math.max(1, box.height);
  const proportionalScale = Math.min(inferenceWidth / cropWidth, inferenceHeight / cropHeight);

  const paddedWidth = Math.max(1, Math.min(inferenceWidth, Math.round(cropWidth * proportionalScale)));
  const paddedHeight = Math.max(1, Math.min(inferenceHeight, Math.round(cropHeight * proportionalScale)));
  const paddingLeft = Math.floor((inferenceWidth - paddedWidth) / 2);
  const paddingRight = inferenceWidth - paddedWidth - paddingLeft;
  const paddingTop = Math.floor((inferenceHeight - paddedHeight) / 2);
  const paddingBottom = inferenceHeight - paddedHeight - paddingTop;

  const resizedEditableCrop = await sharp(editableCropBuffer)
    .resize(paddedWidth, paddedHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .png()
    .toBuffer();

  const transformedImageBuffer = await sharp({
    create: {
      width: inferenceWidth,
      height: inferenceHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: resizedEditableCrop, left: paddingLeft, top: paddingTop }])
    .png()
    .toBuffer();

  const resizedGuidanceMask = await sharp(guidanceMaskBuffer)
    .removeAlpha()
    .grayscale()
    .resize(paddedWidth, paddedHeight, { fit: "fill", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  const transformedMaskBuffer = await sharp(
    Buffer.alloc(inferenceWidth * inferenceHeight, 0),
    { raw: { width: inferenceWidth, height: inferenceHeight, channels: 1 } },
  )
    .composite([{ input: resizedGuidanceMask, left: paddingLeft, top: paddingTop }])
    .png()
    .toBuffer();

  const metadata: RegionTransformMetadata = {
    cropX: box.x,
    cropY: box.y,
    cropWidth,
    cropHeight,
    paddedWidth,
    paddedHeight,
    scaleX: paddedWidth / cropWidth,
    scaleY: paddedHeight / cropHeight,
    paddingTop,
    paddingBottom,
    paddingLeft,
    paddingRight,
    inferenceWidth,
    inferenceHeight,
  };

  return {
    transformedImageBuffer,
    transformedMaskBuffer,
    metadata,
  };
}

async function reverseRegionInferenceTransform(
  generatedBuffer: Buffer,
  metadata: RegionTransformMetadata,
): Promise<ReverseTransformResult> {
  const generatedMeta = await sharp(generatedBuffer).metadata().catch(() => null);
  const generatedWidth = Number(generatedMeta?.width || 0);
  const generatedHeight = Number(generatedMeta?.height || 0);
  const generatedAspect = aspectRatio(generatedWidth, generatedHeight);
  const cropAspect = aspectRatio(metadata.cropWidth, metadata.cropHeight);
  const inferenceAspect = aspectRatio(metadata.inferenceWidth, metadata.inferenceHeight);

  const cropNativeMatch = generatedWidth === metadata.cropWidth && generatedHeight === metadata.cropHeight;
  const inferenceMatch = generatedWidth === metadata.inferenceWidth && generatedHeight === metadata.inferenceHeight;

  const normalizedGenerated = await sharp(generatedBuffer)
    .removeAlpha()
    .png()
    .toBuffer();

  if (cropNativeMatch) {
    return {
      restoredCropBuffer: normalizedGenerated,
      reverseUnpaddedBuffer: normalizedGenerated,
      geminiReturnedBuffer: normalizedGenerated,
      restorePath: "crop-native",
      generatedWidth,
      generatedHeight,
    };
  }

  if (inferenceMatch) {
    const depaddedCrop = await sharp(normalizedGenerated)
      .extract({
        left: metadata.paddingLeft,
        top: metadata.paddingTop,
        width: metadata.paddedWidth,
        height: metadata.paddedHeight,
      })
      .png()
      .toBuffer();

    const restoredCropBuffer = await sharp(depaddedCrop)
      .resize(metadata.cropWidth, metadata.cropHeight, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .removeAlpha()
      .toBuffer();

    return {
      restoredCropBuffer,
      reverseUnpaddedBuffer: depaddedCrop,
      geminiReturnedBuffer: normalizedGenerated,
      restorePath: "inference-unpad",
      generatedWidth,
      generatedHeight,
    };
  }

  if (isAspectRatioClose(generatedAspect, cropAspect)) {
    const restoredCropBuffer = await sharp(normalizedGenerated)
      .resize(metadata.cropWidth, metadata.cropHeight, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .removeAlpha()
      .toBuffer();
    return {
      restoredCropBuffer,
      reverseUnpaddedBuffer: restoredCropBuffer,
      geminiReturnedBuffer: normalizedGenerated,
      restorePath: "crop-ratio-resize",
      generatedWidth,
      generatedHeight,
    };
  }

  if (isAspectRatioClose(generatedAspect, inferenceAspect)) {
    const resizedInference = await sharp(normalizedGenerated)
      .resize(metadata.inferenceWidth, metadata.inferenceHeight, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();

    const depaddedCrop = await sharp(resizedInference)
      .extract({
        left: metadata.paddingLeft,
        top: metadata.paddingTop,
        width: metadata.paddedWidth,
        height: metadata.paddedHeight,
      })
      .png()
      .toBuffer();

    const restoredCropBuffer = await sharp(depaddedCrop)
      .resize(metadata.cropWidth, metadata.cropHeight, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .removeAlpha()
      .toBuffer();

    return {
      restoredCropBuffer,
      reverseUnpaddedBuffer: depaddedCrop,
      geminiReturnedBuffer: normalizedGenerated,
      restorePath: "inference-ratio-unpad",
      generatedWidth,
      generatedHeight,
    };
  }

  const restoredCropBuffer = await sharp(normalizedGenerated)
    .resize(metadata.cropWidth, metadata.cropHeight, {
      fit: "cover",
      position: normalizeSharpResizePosition("left top"),
      kernel: sharp.kernel.lanczos3,
    })
    .removeAlpha()
    .toBuffer();

  console.warn("[editApply] REVERSE_TRANSFORM_FALLBACK", {
    generatedWidth,
    generatedHeight,
    generatedAspect,
    cropAspect,
    inferenceAspect,
    metadata,
  });

  return {
    restoredCropBuffer,
    reverseUnpaddedBuffer: restoredCropBuffer,
    geminiReturnedBuffer: normalizedGenerated,
    restorePath: "safe-cover-fallback",
    generatedWidth,
    generatedHeight,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function buildRingMasks(binaryMask: Buffer, width: number, height: number, bandPx: number): {
  innerEdge: Uint8Array;
  outerBand: Uint8Array;
  interiorMask: Uint8Array;
} {
  const total = width * height;
  const innerEdge = new Uint8Array(total);
  const outerBand = new Uint8Array(total);
  const interiorMask = new Uint8Array(total);

  const radius = Math.max(1, bandPx);
  const indexOf = (x: number, y: number) => (y * width) + x;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = indexOf(x, y);
      const inMask = (binaryMask[idx] ?? 0) > 127;
      if (!inMask) continue;

      interiorMask[idx] = 255;

      let nearestOutside = radius + 1;
      for (let oy = -radius; oy <= radius; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nIdx = indexOf(nx, ny);
          if ((binaryMask[nIdx] ?? 0) > 127) continue;
          const d = Math.max(Math.abs(ox), Math.abs(oy));
          if (d < nearestOutside) nearestOutside = d;
        }
      }

      if (nearestOutside <= radius) {
        innerEdge[idx] = 255;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = indexOf(x, y);
      const inMask = (binaryMask[idx] ?? 0) > 127;
      if (inMask) continue;

      let nearestInside = radius + 1;
      for (let oy = -radius; oy <= radius; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nIdx = indexOf(nx, ny);
          if ((binaryMask[nIdx] ?? 0) <= 127) continue;
          const d = Math.max(Math.abs(ox), Math.abs(oy));
          if (d < nearestInside) nearestInside = d;
        }
      }

      if (nearestInside <= radius) {
        outerBand[idx] = 255;
      }
    }
  }

  return { innerEdge, outerBand, interiorMask };
}

function computeSignalStats(rgbRaw: Buffer, width: number, height: number, mask: Uint8Array): HarmonizationSignalStats {
  const total = width * height;
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let edgeAccum = 0;
  let hfAccum = 0;

  const lumaAt = (idx: number): number => {
    const base = idx * 3;
    const r = rgbRaw[base] ?? 0;
    const g = rgbRaw[base + 1] ?? 0;
    const b = rgbRaw[base + 2] ?? 0;
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width) + x;
      if ((mask[idx] ?? 0) === 0) continue;

      const center = lumaAt(idx);
      sum += center;
      sumSq += center * center;
      count += 1;

      const right = x + 1 < width ? lumaAt(idx + 1) : center;
      const down = y + 1 < height ? lumaAt(idx + width) : center;
      edgeAccum += Math.abs(center - right) + Math.abs(center - down);

      const left = x > 0 ? lumaAt(idx - 1) : center;
      const up = y > 0 ? lumaAt(idx - width) : center;
      const localMean = (left + right + up + down) * 0.25;
      hfAccum += Math.abs(center - localMean);
    }
  }

  if (count === 0) {
    return {
      pixelCount: 0,
      lumaMean: 0,
      lumaStd: 0,
      edgeEnergy: 0,
      hfEnergy: 0,
    };
  }

  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return {
    pixelCount: count,
    lumaMean: mean,
    lumaStd: Math.sqrt(variance),
    edgeEnergy: edgeAccum / count,
    hfEnergy: hfAccum / count,
  };
}

function deriveHarmonizationPlan(sourceStats: HarmonizationSignalStats, targetStats: HarmonizationSignalStats): HarmonizationPlan {
  const sourceStd = Math.max(1, sourceStats.lumaStd);
  const targetStd = Math.max(1, targetStats.lumaStd);
  const gain = clampNumber(
    targetStd / sourceStd,
    1 - HARMONIZE_MAX_GAIN_DELTA,
    1 + HARMONIZE_MAX_GAIN_DELTA,
  );
  const bias = clampNumber(
    targetStats.lumaMean - (sourceStats.lumaMean * gain),
    -HARMONIZE_MAX_BIAS,
    HARMONIZE_MAX_BIAS,
  );

  const sourceEdge = Math.max(1, sourceStats.edgeEnergy);
  const targetEdge = Math.max(1, targetStats.edgeEnergy);
  const edgeRatio = targetEdge / sourceEdge;

  const sourceHf = Math.max(1, sourceStats.hfEnergy);
  const targetHf = Math.max(1, targetStats.hfEnergy);
  const hfRatio = targetHf / sourceHf;

  let blurSigma = 0;
  let sharpenM2 = 0;
  if (edgeRatio < 0.94 || hfRatio < 0.94) {
    const softness = Math.max(0, 1 - Math.min(edgeRatio, hfRatio));
    blurSigma = clampNumber(softness * 2.1, 0, HARMONIZE_MAX_BLUR_SIGMA);
  } else if (edgeRatio > 1.06 || hfRatio > 1.06) {
    const crispness = Math.max(0, Math.max(edgeRatio, hfRatio) - 1);
    sharpenM2 = clampNumber(crispness * 1.5, 0, HARMONIZE_MAX_SHARPEN_M2);
  }

  return {
    gain,
    bias,
    blurSigma,
    sharpenM2,
    sourceStats,
    targetStats,
  };
}

async function harmonizePatchToLocalNeighborhood(params: {
  candidateBuffer: Buffer;
  referenceBuffer: Buffer;
  binaryMaskBuffer: Buffer;
  width: number;
  height: number;
  context: string;
}): Promise<Buffer> {
  const { candidateBuffer, referenceBuffer, binaryMaskBuffer, width, height, context } = params;

  const [candidateRaw, referenceRaw, maskRaw] = await Promise.all([
    sharp(candidateBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(referenceBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(binaryMaskBuffer)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const ringBand = Math.max(3, Math.min(14, Math.round(Math.max(width, height) * 0.015))) || HARMONIZE_DEFAULT_BAND_PX;
  const { innerEdge, outerBand, interiorMask } = buildRingMasks(maskRaw.data, width, height, ringBand);
  const sourceStats = computeSignalStats(candidateRaw.data, width, height, innerEdge);
  const targetStats = computeSignalStats(referenceRaw.data, width, height, outerBand);

  if (sourceStats.pixelCount < HARMONIZE_MIN_SAMPLE_PIXELS || targetStats.pixelCount < HARMONIZE_MIN_SAMPLE_PIXELS) {
    console.log("[editApply] LOCAL_HARMONIZE_SKIPPED", {
      context,
      reason: "insufficient_samples",
      sourcePixels: sourceStats.pixelCount,
      targetPixels: targetStats.pixelCount,
    });
    return candidateBuffer;
  }

  const plan = deriveHarmonizationPlan(sourceStats, targetStats);

  let corrected = await sharp(candidateBuffer)
    .linear([plan.gain, plan.gain, plan.gain], [plan.bias, plan.bias, plan.bias])
    .removeAlpha()
    .png()
    .toBuffer();

  if (plan.blurSigma > 0.01) {
    corrected = await sharp(corrected)
      .blur(plan.blurSigma)
      .png()
      .toBuffer();
  }

  if (plan.sharpenM2 > 0.01) {
    corrected = await sharp(corrected)
      .sharpen({
        sigma: 1.1,
        m1: 1.0,
        m2: plan.sharpenM2,
        x1: 2.0,
        y2: 8.0,
        y3: 16.0,
      })
      .png()
      .toBuffer();
  }

  const boundaryMask = await sharp(Buffer.from(innerEdge), {
    raw: { width, height, channels: 1 },
  })
    .blur(Math.max(0.6, ringBand * 0.35))
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaRaw = Buffer.alloc(width * height, 0);
  for (let i = 0; i < alphaRaw.length; i += 1) {
    const inMask = (interiorMask[i] ?? 0) > 0;
    if (!inMask) continue;
    const boundaryWeight = ((boundaryMask.data[i] ?? 0) / 255) * HARMONIZE_BOUNDARY_WEIGHT;
    const interiorWeight = HARMONIZE_INTERIOR_WEIGHT;
    const weight = clampNumber(boundaryWeight + interiorWeight, 0, 1);
    alphaRaw[i] = Math.round(weight * 255);
  }

  const overlay = await sharp(corrected)
    .joinChannel(alphaRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  console.log("[editApply] LOCAL_HARMONIZE_APPLIED", {
    context,
    ringBand,
    gain: Number(plan.gain.toFixed(4)),
    bias: Number(plan.bias.toFixed(4)),
    blurSigma: Number(plan.blurSigma.toFixed(4)),
    sharpenM2: Number(plan.sharpenM2.toFixed(4)),
    sourceStats: {
      lumaMean: Number(plan.sourceStats.lumaMean.toFixed(3)),
      lumaStd: Number(plan.sourceStats.lumaStd.toFixed(3)),
      edgeEnergy: Number(plan.sourceStats.edgeEnergy.toFixed(3)),
      hfEnergy: Number(plan.sourceStats.hfEnergy.toFixed(3)),
      pixelCount: plan.sourceStats.pixelCount,
    },
    targetStats: {
      lumaMean: Number(plan.targetStats.lumaMean.toFixed(3)),
      lumaStd: Number(plan.targetStats.lumaStd.toFixed(3)),
      edgeEnergy: Number(plan.targetStats.edgeEnergy.toFixed(3)),
      hfEnergy: Number(plan.targetStats.hfEnergy.toFixed(3)),
      pixelCount: plan.targetStats.pixelCount,
    },
  });

  return sharp(candidateBuffer)
    .composite([{ input: overlay, blend: "over" }])
    .removeAlpha()
    .png()
    .toBuffer();
}

async function buildDeltaMaskForCrop(params: {
  originalCropBuffer: Buffer;
  editedCropBuffer: Buffer;
  croppedMaskPngBuffer: Buffer;
  width: number;
  height: number;
}): Promise<{ alphaMask: Buffer; changedPixels: number }> {
  const { originalCropBuffer, editedCropBuffer, croppedMaskPngBuffer, width, height } = params;

  const [originalRaw, editedRaw, maskRaw] = await Promise.all([
    sharp(originalCropBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(editedCropBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(croppedMaskPngBuffer)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const deltaRaw = Buffer.alloc(width * height, 0);
  let changedPixels = 0;

  for (let i = 0; i < width * height; i += 1) {
    if ((maskRaw.data[i] ?? 0) <= 0) continue;
    const idx = i * 3;
    const dr = Math.abs((originalRaw.data[idx] ?? 0) - (editedRaw.data[idx] ?? 0));
    const dg = Math.abs((originalRaw.data[idx + 1] ?? 0) - (editedRaw.data[idx + 1] ?? 0));
    const db = Math.abs((originalRaw.data[idx + 2] ?? 0) - (editedRaw.data[idx + 2] ?? 0));
    if (dr + dg + db < DELTA_DIFF_THRESHOLD) continue;
    deltaRaw[i] = 255;
    changedPixels += 1;
  }

  if (changedPixels < DELTA_MASK_MIN_CHANGED_PIXELS) {
    return {
      alphaMask: Buffer.alloc(width * height, 0),
      changedPixels,
    };
  }

  return {
    alphaMask: deltaRaw,
    changedPixels,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function buildRingMasks(binaryMask: Buffer, width: number, height: number, bandPx: number): {
  innerEdge: Uint8Array;
  outerBand: Uint8Array;
  interiorMask: Uint8Array;
} {
  const total = width * height;
  const innerEdge = new Uint8Array(total);
  const outerBand = new Uint8Array(total);
  const interiorMask = new Uint8Array(total);

  const radius = Math.max(1, bandPx);
  const indexOf = (x: number, y: number) => (y * width) + x;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = indexOf(x, y);
      const inMask = (binaryMask[idx] ?? 0) > 127;
      if (!inMask) continue;

      interiorMask[idx] = 255;

      let nearestOutside = radius + 1;
      for (let oy = -radius; oy <= radius; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nIdx = indexOf(nx, ny);
          if ((binaryMask[nIdx] ?? 0) > 127) continue;
          const d = Math.max(Math.abs(ox), Math.abs(oy));
          if (d < nearestOutside) nearestOutside = d;
        }
      }

      if (nearestOutside <= radius) {
        innerEdge[idx] = 255;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = indexOf(x, y);
      const inMask = (binaryMask[idx] ?? 0) > 127;
      if (inMask) continue;

      let nearestInside = radius + 1;
      for (let oy = -radius; oy <= radius; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nIdx = indexOf(nx, ny);
          if ((binaryMask[nIdx] ?? 0) <= 127) continue;
          const d = Math.max(Math.abs(ox), Math.abs(oy));
          if (d < nearestInside) nearestInside = d;
        }
      }

      if (nearestInside <= radius) {
        outerBand[idx] = 255;
      }
    }
  }

  return { innerEdge, outerBand, interiorMask };
}

function computeSignalStats(rgbRaw: Buffer, width: number, height: number, mask: Uint8Array): HarmonizationSignalStats {
  const total = width * height;
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let edgeAccum = 0;
  let hfAccum = 0;

  const lumaAt = (idx: number): number => {
    const base = idx * 3;
    const r = rgbRaw[base] ?? 0;
    const g = rgbRaw[base + 1] ?? 0;
    const b = rgbRaw[base + 2] ?? 0;
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width) + x;
      if ((mask[idx] ?? 0) === 0) continue;

      const center = lumaAt(idx);
      sum += center;
      sumSq += center * center;
      count += 1;

      const right = x + 1 < width ? lumaAt(idx + 1) : center;
      const down = y + 1 < height ? lumaAt(idx + width) : center;
      edgeAccum += Math.abs(center - right) + Math.abs(center - down);

      const left = x > 0 ? lumaAt(idx - 1) : center;
      const up = y > 0 ? lumaAt(idx - width) : center;
      const localMean = (left + right + up + down) * 0.25;
      hfAccum += Math.abs(center - localMean);
    }
  }

  if (count === 0) {
    return {
      pixelCount: 0,
      lumaMean: 0,
      lumaStd: 0,
      edgeEnergy: 0,
      hfEnergy: 0,
    };
  }

  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return {
    pixelCount: count,
    lumaMean: mean,
    lumaStd: Math.sqrt(variance),
    edgeEnergy: edgeAccum / count,
    hfEnergy: hfAccum / count,
  };
}

function deriveHarmonizationPlan(sourceStats: HarmonizationSignalStats, targetStats: HarmonizationSignalStats): HarmonizationPlan {
  const sourceStd = Math.max(1, sourceStats.lumaStd);
  const targetStd = Math.max(1, targetStats.lumaStd);
  const gain = clampNumber(
    targetStd / sourceStd,
    1 - HARMONIZE_MAX_GAIN_DELTA,
    1 + HARMONIZE_MAX_GAIN_DELTA,
  );
  const bias = clampNumber(
    targetStats.lumaMean - (sourceStats.lumaMean * gain),
    -HARMONIZE_MAX_BIAS,
    HARMONIZE_MAX_BIAS,
  );

  const sourceEdge = Math.max(1, sourceStats.edgeEnergy);
  const targetEdge = Math.max(1, targetStats.edgeEnergy);
  const edgeRatio = targetEdge / sourceEdge;

  const sourceHf = Math.max(1, sourceStats.hfEnergy);
  const targetHf = Math.max(1, targetStats.hfEnergy);
  const hfRatio = targetHf / sourceHf;

  let blurSigma = 0;
  let sharpenM2 = 0;
  if (edgeRatio < 0.94 || hfRatio < 0.94) {
    const softness = Math.max(0, 1 - Math.min(edgeRatio, hfRatio));
    blurSigma = clampNumber(softness * 2.1, 0, HARMONIZE_MAX_BLUR_SIGMA);
  } else if (edgeRatio > 1.06 || hfRatio > 1.06) {
    const crispness = Math.max(0, Math.max(edgeRatio, hfRatio) - 1);
    sharpenM2 = clampNumber(crispness * 1.5, 0, HARMONIZE_MAX_SHARPEN_M2);
  }

  return {
    gain,
    bias,
    blurSigma,
    sharpenM2,
    sourceStats,
    targetStats,
  };
}

async function harmonizePatchToLocalNeighborhood(params: {
  candidateBuffer: Buffer;
  referenceBuffer: Buffer;
  binaryMaskBuffer: Buffer;
  width: number;
  height: number;
  context: string;
}): Promise<Buffer> {
  const { candidateBuffer, referenceBuffer, binaryMaskBuffer, width, height, context } = params;

  const [candidateRaw, referenceRaw, maskRaw] = await Promise.all([
    sharp(candidateBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(referenceBuffer)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(binaryMaskBuffer)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const ringBand = Math.max(3, Math.min(14, Math.round(Math.max(width, height) * 0.015))) || HARMONIZE_DEFAULT_BAND_PX;
  const { innerEdge, outerBand, interiorMask } = buildRingMasks(maskRaw.data, width, height, ringBand);
  const sourceStats = computeSignalStats(candidateRaw.data, width, height, innerEdge);
  const targetStats = computeSignalStats(referenceRaw.data, width, height, outerBand);

  if (sourceStats.pixelCount < HARMONIZE_MIN_SAMPLE_PIXELS || targetStats.pixelCount < HARMONIZE_MIN_SAMPLE_PIXELS) {
    console.log("[editApply] LOCAL_HARMONIZE_SKIPPED", {
      context,
      reason: "insufficient_samples",
      sourcePixels: sourceStats.pixelCount,
      targetPixels: targetStats.pixelCount,
    });
    return candidateBuffer;
  }

  const plan = deriveHarmonizationPlan(sourceStats, targetStats);

  let corrected = await sharp(candidateBuffer)
    .linear([plan.gain, plan.gain, plan.gain], [plan.bias, plan.bias, plan.bias])
    .removeAlpha()
    .png()
    .toBuffer();

  if (plan.blurSigma > 0.01) {
    corrected = await sharp(corrected)
      .blur(plan.blurSigma)
      .png()
      .toBuffer();
  }

  if (plan.sharpenM2 > 0.01) {
    corrected = await sharp(corrected)
      .sharpen({
        sigma: 1.1,
        m1: 1.0,
        m2: plan.sharpenM2,
        x1: 2.0,
        y2: 8.0,
        y3: 16.0,
      })
      .png()
      .toBuffer();
  }

  const boundaryMask = await sharp(Buffer.from(innerEdge), {
    raw: { width, height, channels: 1 },
  })
    .blur(Math.max(0.6, ringBand * 0.35))
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaRaw = Buffer.alloc(width * height, 0);
  for (let i = 0; i < alphaRaw.length; i += 1) {
    const inMask = (interiorMask[i] ?? 0) > 0;
    if (!inMask) continue;
    const boundaryWeight = ((boundaryMask.data[i] ?? 0) / 255) * HARMONIZE_BOUNDARY_WEIGHT;
    const interiorWeight = HARMONIZE_INTERIOR_WEIGHT;
    const weight = clampNumber(boundaryWeight + interiorWeight, 0, 1);
    alphaRaw[i] = Math.round(weight * 255);
  }

  const overlay = await sharp(corrected)
    .joinChannel(alphaRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  console.log("[editApply] LOCAL_HARMONIZE_APPLIED", {
    context,
    ringBand,
    gain: Number(plan.gain.toFixed(4)),
    bias: Number(plan.bias.toFixed(4)),
    blurSigma: Number(plan.blurSigma.toFixed(4)),
    sharpenM2: Number(plan.sharpenM2.toFixed(4)),
    sourceStats: {
      lumaMean: Number(plan.sourceStats.lumaMean.toFixed(3)),
      lumaStd: Number(plan.sourceStats.lumaStd.toFixed(3)),
      edgeEnergy: Number(plan.sourceStats.edgeEnergy.toFixed(3)),
      hfEnergy: Number(plan.sourceStats.hfEnergy.toFixed(3)),
      pixelCount: plan.sourceStats.pixelCount,
    },
    targetStats: {
      lumaMean: Number(plan.targetStats.lumaMean.toFixed(3)),
      lumaStd: Number(plan.targetStats.lumaStd.toFixed(3)),
      edgeEnergy: Number(plan.targetStats.edgeEnergy.toFixed(3)),
      hfEnergy: Number(plan.targetStats.hfEnergy.toFixed(3)),
      pixelCount: plan.targetStats.pixelCount,
    },
  });

  return sharp(candidateBuffer)
    .composite([{ input: overlay, blend: "over" }])
    .png()
    .toBuffer();
}

async function normalizeMaskToImageSpace(mask: Buffer, width: number, height: number): Promise<Buffer> {
  const maskImage = sharp(mask, { failOn: "error" });
  const maskMeta = await maskImage.metadata();
  const needsResize = maskMeta.width !== width || maskMeta.height !== height;

  let pipeline = sharp(mask, { failOn: "error" })
    .removeAlpha()
    .grayscale();

  if (needsResize) {
    pipeline = pipeline.resize(width, height, {
      fit: "fill",
      kernel: sharp.kernel.nearest,
    });
    console.log("[editApply] Mask normalized with fill to exact base image dimensions");
  } else {
    console.log("[editApply] Mask dimensions already match base image");
  }

  return await pipeline
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();
}

async function getMaskPixelBBox(maskPngBuffer: Buffer, width: number, height: number): Promise<PixelBox | null> {
  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = raw.data[y * width + x] ?? 0;
      if (value <= 127) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  return {
    x: minX,
    y: minY,
    width: (maxX - minX) + 1,
    height: (maxY - minY) + 1,
  };
}

async function splitMaskIntoRegions(maskPngBuffer: Buffer, width: number, height: number): Promise<RegionComponent[]> {
  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const visited = new Uint8Array(width * height);
  const regions: RegionComponent[] = [];
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = (y * width) + x;
      if (visited[startIndex] || (raw.data[startIndex] ?? 0) <= 127) continue;

      const queue: number[] = [startIndex];
      const pixels: number[] = [];
      visited[startIndex] = 1;

      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]!;
        const px = index % width;
        const py = Math.floor(index / width);
        pixels.push(index);

        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;

        for (const [dx, dy] of neighborOffsets) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

          const nextIndex = (ny * width) + nx;
          if (visited[nextIndex] || (raw.data[nextIndex] ?? 0) <= 127) continue;

          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }

      const maskRaw = Buffer.alloc(width * height, 0);
      for (const pixelIndex of pixels) {
        maskRaw[pixelIndex] = 255;
      }

      regions.push({
        maskPngBuffer: await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer(),
        bbox: {
          x: minX,
          y: minY,
          width: (maxX - minX) + 1,
          height: (maxY - minY) + 1,
        },
        area: pixels.length,
      });
    }
  }

  return regions;
}

function getObjectClass(prompt: string): ObjectClass {
  const text = String(prompt || "").toLowerCase();
  if (/\bbed\b|\bsofa\b|\bcouch\b/.test(text)) return "LARGE";
  if (/\btable\b|\bdesk\b/.test(text)) return "MEDIUM";
  if (/\bchair\b|\bplant\b|\blamp\b/.test(text)) return "SMALL";
  return "MEDIUM";
}

function getObjectClassRank(objectClass: ObjectClass): number {
  if (objectClass === "LARGE") return 3;
  if (objectClass === "MEDIUM") return 2;
  return 1;
}

function hasLeadingEditVerb(text: string): boolean {
  return /^(add|remove|replace|reinstate|restore|swap|place|insert|delete|take out)\b/i.test(text.trim());
}

function inferPrimaryEditVerb(prompt: string): string | null {
  const match = String(prompt || "").match(/\b(add|remove|replace|reinstate|restore|swap|place|insert|delete|take out)\b/i);
  return match?.[1]?.toLowerCase() || null;
}

function normalizeSegmentInstruction(segment: string, fallbackVerb: string | null): string {
  const trimmed = String(segment || "").trim().replace(/[.;,:]+$/g, "");
  if (!trimmed) return "";
  if (hasLeadingEditVerb(trimmed) || !fallbackVerb) return trimmed;
  return `${fallbackVerb} ${trimmed}`;
}

function cleanSegmentText(text: string): string {
  return String(text || "")
    .replace(/^(?:and|then|also)\b\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;,:]+$/g, "");
}

function findEditVerbMatches(text: string): Array<{ verb: string; index: number; end: number }> {
  const matches: Array<{ verb: string; index: number; end: number }> = [];
  const pattern = new RegExp(EDIT_VERB_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      verb: match[1]!.toLowerCase(),
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

function findPromptObjectHits(text: string): PromptObjectHit[] {
  const hits: PromptObjectHit[] = [];

  for (const matcher of PROMPT_OBJECT_MATCHERS) {
    const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({
        keyword: matcher.keyword,
        objectClass: matcher.objectClass,
        index: match.index,
        length: match[0].length,
        matchedText: match[0],
      });

      if (match.index === pattern.lastIndex) {
        pattern.lastIndex += 1;
      }
    }
  }

  hits.sort((left, right) => left.index - right.index || right.length - left.length);

  const deduped: PromptObjectHit[] = [];
  for (const hit of hits) {
    const overlapsExisting = deduped.some((existing) => {
      const existingEnd = existing.index + existing.length;
      const hitEnd = hit.index + hit.length;
      return hit.index < existingEnd && existing.index < hitEnd;
    });
    if (!overlapsExisting) {
      deduped.push(hit);
    }
  }

  return deduped;
}

function findClauseStart(text: string, hitIndex: number, verbMatches: Array<{ verb: string; index: number; end: number }>): number {
  const precedingVerb = [...verbMatches].reverse().find((verb) => verb.index <= hitIndex);
  const boundaryMatches = Array.from(text.matchAll(new RegExp(CLAUSE_BOUNDARY_PATTERN.source, "gi")));
  const precedingBoundary = [...boundaryMatches]
    .reverse()
    .find((boundary) => boundary.index !== undefined && boundary.index < hitIndex);

  const precedingBoundaryEnd = precedingBoundary ? precedingBoundary.index! + precedingBoundary[0].length : -1;
  if (precedingVerb && (!precedingBoundary || precedingVerb.index >= precedingBoundaryEnd)) {
    return precedingVerb.index;
  }

  return precedingBoundary ? precedingBoundary.index! + precedingBoundary[0].length : 0;
}

function findClauseEnd(text: string, startIndex: number, hit: PromptObjectHit, nextHit: PromptObjectHit | undefined): number {
  const boundaryMatches = Array.from(text.matchAll(new RegExp(CLAUSE_BOUNDARY_PATTERN.source, "gi")));
  const defaultEnd = nextHit ? nextHit.index : text.length;
  const boundaryBeforeNextHit = boundaryMatches.find((boundary) => {
    if (boundary.index === undefined) return false;
    return boundary.index > (hit.index + hit.length) && boundary.index < defaultEnd;
  });

  if (boundaryBeforeNextHit) {
    return Math.max(startIndex, boundaryBeforeNextHit.index);
  }

  return Math.max(startIndex, defaultEnd);
}

function extractPromptObjectSegments(prompt: string): RegionPromptAssignment[] {
  const normalizedPrompt = String(prompt || "").trim();
  const objectHits = findPromptObjectHits(normalizedPrompt);
  if (objectHits.length === 0) return [];

  const verbMatches = findEditVerbMatches(normalizedPrompt);
  const primaryVerb = verbMatches[0]?.verb || inferPrimaryEditVerb(normalizedPrompt);
  const assignments: RegionPromptAssignment[] = [];

  for (let index = 0; index < objectHits.length; index += 1) {
    const hit = objectHits[index]!;
    const nextHit = objectHits[index + 1];
    const clauseStart = findClauseStart(normalizedPrompt, hit.index, verbMatches);
    const clauseEnd = findClauseEnd(normalizedPrompt, clauseStart, hit, nextHit);
    const rawClause = normalizedPrompt.slice(clauseStart, clauseEnd);
    const instruction = normalizeSegmentInstruction(cleanSegmentText(rawClause), primaryVerb);
    if (!instruction) continue;
    if (assignments.some((candidate) => candidate.instruction.toLowerCase() === instruction.toLowerCase())) {
      continue;
    }

    assignments.push({
      instruction,
      objectClass: hit.objectClass,
      assignmentSource: "segment",
      keyword: hit.keyword,
    });
  }

  return assignments;
}

function findPromptObjectMatch(text: string): PromptObjectMatch | null {
  for (const matcher of PROMPT_OBJECT_MATCHERS) {
    if (matcher.pattern.test(text)) return matcher;
  }
  return null;
}

function assignPromptInstructionsToRegions(prompt: string, regions: RegionComponent[]): TargetRegion[] {
  const normalizedPrompt = String(prompt || "").trim();
  const defaultAssignment: RegionPromptAssignment = {
    instruction: normalizedPrompt,
    objectClass: getObjectClass(normalizedPrompt),
    assignmentSource: "global",
    keyword: null,
  };

  if (regions.length <= 1) {
    console.log("[editApply] CLAUSE_MAPPING", [{ clause: normalizedPrompt, regionIndex: 0 }]);
    return regions.map((region) => ({ ...region, ...defaultAssignment }));
  }

  const segmentAssignments = extractPromptObjectSegments(normalizedPrompt);

  segmentAssignments.sort((left, right) => getObjectClassRank(right.objectClass) - getObjectClassRank(left.objectClass));

  if (segmentAssignments.length < 2) {
    console.log("[editApply] CLAUSE_MAPPING", regions.map((_region, regionIndex) => ({
      clause: normalizedPrompt,
      regionIndex,
    })));
    return regions.map((region) => ({ ...region, ...defaultAssignment }));
  }

  const regionsByArea = regions
    .map((region, index) => ({ region, index }))
    .sort((left, right) => right.region.area - left.region.area);

  const assignedByIndex = new Map<number, RegionPromptAssignment>();
  for (let segmentIndex = 0; segmentIndex < Math.min(segmentAssignments.length, regionsByArea.length); segmentIndex += 1) {
    assignedByIndex.set(regionsByArea[segmentIndex]!.index, segmentAssignments[segmentIndex]!);
  }

  console.log("[editApply] Prompt-to-region mapping", {
    regionCount: regions.length,
    segmentCount: segmentAssignments.length,
    assignments: regionsByArea.map(({ region, index }) => ({
      regionIndex: index,
      area: region.area,
      assignedInstruction: assignedByIndex.get(index)?.instruction || null,
      assignmentSource: assignedByIndex.get(index)?.assignmentSource || "skipped",
      keyword: assignedByIndex.get(index)?.keyword || null,
    })),
  });

  console.log("[editApply] CLAUSE_MAPPING", regionsByArea
    .map(({ index }) => {
      const assigned = assignedByIndex.get(index);
      if (!assigned) return null;
      return {
        clause: assigned.instruction,
        regionIndex: index,
      };
    })
    .filter((value) => !!value));

  return regions
    .map((region, index) => {
      const assigned = assignedByIndex.get(index);
      return assigned ? { ...region, ...assigned } : null;
    })
    .filter((region): region is TargetRegion => !!region);
}

function computeAdaptiveExpansionFactor(params: {
  objectClass: ObjectClass;
  area: number;
  imageWidth: number;
  imageHeight: number;
}): number {
  const { objectClass, area, imageWidth, imageHeight } = params;
  const imageArea = Math.max(1, imageWidth * imageHeight);
  const areaRatio = area / imageArea;

  let factor = objectClass === "LARGE"
    ? 1.42
    : objectClass === "SMALL"
      ? 1.15
      : 1.25;

  if (areaRatio < 0.01) {
    factor += 0.08;
  } else if (areaRatio < 0.03) {
    factor += 0.04;
  } else if (areaRatio > 0.15) {
    factor -= 0.08;
  } else if (areaRatio > 0.07) {
    factor -= 0.04;
  }

  const minFactor = objectClass === "LARGE" ? 1.35 : objectClass === "SMALL" ? 1.1 : 1.2;
  const maxFactor = objectClass === "LARGE" ? 1.5 : objectClass === "SMALL" ? 1.2 : 1.3;
  return Math.max(minFactor, Math.min(maxFactor, factor));
}

function expandPixelBoxAdaptive(
  box: PixelBox,
  imageWidth: number,
  imageHeight: number,
  factor: number,
): PixelBox {
  const desiredExtraWidth = Math.max(0, Math.round(box.width * (factor - 1)));
  const desiredExtraHeight = Math.max(0, Math.round(box.height * (factor - 1)));

  const padX = Math.min(
    Math.ceil(desiredExtraWidth / 2),
    Math.floor(imageWidth * MAX_REGION_EXPANSION_IMAGE_RATIO),
  );
  const padY = Math.min(
    Math.ceil(desiredExtraHeight / 2),
    Math.floor(imageHeight * MAX_REGION_EXPANSION_IMAGE_RATIO),
  );

  const x1 = Math.max(0, box.x - padX);
  const y1 = Math.max(0, box.y - padY);
  const x2 = Math.min(imageWidth, box.x + box.width + padX);
  const y2 = Math.min(imageHeight, box.y + box.height + padY);

  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
  };
}

function buildInterpolatedBox(baseBox: PixelBox, expandedBox: PixelBox, t: number): PixelBox {
  const expandedRight = expandedBox.x + expandedBox.width;
  const expandedBottom = expandedBox.y + expandedBox.height;
  const baseRight = baseBox.x + baseBox.width;
  const baseBottom = baseBox.y + baseBox.height;

  const x = Math.round(baseBox.x - ((baseBox.x - expandedBox.x) * t));
  const y = Math.round(baseBox.y - ((baseBox.y - expandedBox.y) * t));
  const right = Math.round(baseRight + ((expandedRight - baseRight) * t));
  const bottom = Math.round(baseBottom + ((expandedBottom - baseBottom) * t));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function capExpandedBoxArea(box: PixelBox, bbox: PixelBox, imageWidth: number, imageHeight: number): PixelBox {
  const maxArea = Math.max(pixelBoxArea(bbox), Math.floor(imageWidth * imageHeight * MAX_EXPANDED_REGION_AREA_RATIO));
  if (pixelBoxArea(box) <= maxArea) return box;

  let low = 0;
  let high = 1;
  let best = bbox;

  for (let iteration = 0; iteration < 16; iteration += 1) {
    const mid = (low + high) / 2;
    const candidate = buildInterpolatedBox(bbox, box, mid);
    if (pixelBoxArea(candidate) <= maxArea) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }

  return best;
}

function isExpandedBoxAreaWithinLimit(box: PixelBox, imageWidth: number, imageHeight: number): boolean {
  return pixelBoxArea(box) <= Math.floor(imageWidth * imageHeight * MAX_EXPANDED_REGION_AREA_RATIO);
}

function pixelBoxArea(box: PixelBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function pixelBoxIntersectionArea(a: PixelBox, b: PixelBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function shouldMergeExpandedRegions(a: ExpandedRegion, b: ExpandedRegion): boolean {
  const intersection = pixelBoxIntersectionArea(a.expandedBox, b.expandedBox);
  if (intersection <= 0) return false;
  const smallerArea = Math.max(1, Math.min(pixelBoxArea(a.expandedBox), pixelBoxArea(b.expandedBox)));
  return (intersection / smallerArea) >= REGION_OVERLAP_MERGE_RATIO;
}

function mergePixelBoxes(a: PixelBox, b: PixelBox): PixelBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

async function unionMaskBuffers(maskBuffers: Buffer[], width: number, height: number): Promise<Buffer> {
  const unionRaw = Buffer.alloc(width * height, 0);

  for (const maskBuffer of maskBuffers) {
    const raw = await sharp(maskBuffer)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 0; i < unionRaw.length; i += 1) {
      if ((raw.data[i] ?? 0) > 127) unionRaw[i] = 255;
    }
  }

  return sharp(unionRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function buildExpandedRegions(params: {
  regions: TargetRegion[];
  imageWidth: number;
  imageHeight: number;
}): Promise<ExpandedRegion[]> {
  const { regions, imageWidth, imageHeight } = params;

  let expandedRegions: ExpandedRegion[] = regions.map((region) => {
    const expansionFactor = computeAdaptiveExpansionFactor({
      objectClass: region.objectClass,
      area: region.area,
      imageWidth,
      imageHeight,
    });
    const expandedBox = capExpandedBoxArea(
      expandPixelBoxAdaptive(region.bbox, imageWidth, imageHeight, expansionFactor),
      region.bbox,
      imageWidth,
      imageHeight,
    );

    return {
      ...region,
      expansionFactor,
      expandedBox,
    };
  });

  let merged = true;
  while (merged) {
    merged = false;

    for (let i = 0; i < expandedRegions.length; i += 1) {
      for (let j = i + 1; j < expandedRegions.length; j += 1) {
        if (!shouldMergeExpandedRegions(expandedRegions[i]!, expandedRegions[j]!)) continue;

        const left = expandedRegions[i]!;
        const right = expandedRegions[j]!;
        if (left.instruction.trim().toLowerCase() !== right.instruction.trim().toLowerCase()) {
          continue;
        }
        const mergedMaskPngBuffer = await unionMaskBuffers(
          [left.maskPngBuffer, right.maskPngBuffer],
          imageWidth,
          imageHeight,
        );
        const mergedBbox = mergePixelBoxes(left.bbox, right.bbox);
        const mergedArea = left.area + right.area;
        const expansionFactor = computeAdaptiveExpansionFactor({
          objectClass: left.objectClass,
          area: mergedArea,
          imageWidth,
          imageHeight,
        });
        const mergedExpandedBox = capExpandedBoxArea(
          expandPixelBoxAdaptive(mergedBbox, imageWidth, imageHeight, expansionFactor),
          mergedBbox,
          imageWidth,
          imageHeight,
        );

        if (!isExpandedBoxAreaWithinLimit(mergedExpandedBox, imageWidth, imageHeight)) {
          console.log("[editApply] Skipping expanded region merge due to area cap", {
            leftBox: left.expandedBox,
            rightBox: right.expandedBox,
            mergedBbox,
            mergedExpandedBox,
          });
          continue;
        }

        expandedRegions.splice(i, 2, {
          maskPngBuffer: mergedMaskPngBuffer,
          bbox: mergedBbox,
          area: mergedArea,
          instruction: left.instruction,
          objectClass: left.objectClass,
          assignmentSource: left.assignmentSource,
          keyword: left.keyword,
          expansionFactor,
          expandedBox: mergedExpandedBox,
        });
        merged = true;
        break;
      }

      if (merged) break;
    }
  }

  return expandedRegions.sort((a, b) => b.area - a.area);
}

function expandPixelBox(box: PixelBox, imageWidth: number, imageHeight: number, paddingRatio = EXPANDED_EDIT_PADDING_RATIO): PixelBox {
  const padX = Math.max(1, Math.ceil(box.width * paddingRatio));
  const padY = Math.max(1, Math.ceil(box.height * paddingRatio));

  const x1 = Math.max(0, box.x - padX);
  const y1 = Math.max(0, box.y - padY);
  const x2 = Math.min(imageWidth, box.x + box.width + padX);
  const y2 = Math.min(imageHeight, box.y + box.height + padY);

  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
  };
}

function isExpandedCropUsable(box: PixelBox | null): box is PixelBox {
  if (!box) return false;
  if (box.width < MIN_EXPANDED_EDIT_DIMENSION_PX) return false;
  if (box.height < MIN_EXPANDED_EDIT_DIMENSION_PX) return false;
  return (box.width * box.height) >= MIN_EXPANDED_EDIT_AREA_PX;
}

async function cropMaskToBox(maskPngBuffer: Buffer, box: PixelBox): Promise<Buffer> {
  return sharp(maskPngBuffer)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .png()
    .toBuffer();
}

async function buildSoftGuidanceMask(croppedMaskPngBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  const croppedMaskRaw = await sharp(croppedMaskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const guidanceRaw = Buffer.alloc(width * height, 128);
  for (let i = 0; i < width * height; i += 1) {
    if ((croppedMaskRaw.data[i] ?? 0) > 127) {
      guidanceRaw[i] = 255;
    }
  }

  return sharp(guidanceRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function buildFullImageBoxMask(box: PixelBox, width: number, height: number): Promise<Buffer> {
  return buildFullImageBoxesMask([box], width, height);
}

function buildRegionScopedPrompt(params: {
  userInstruction: string;
  roomType?: string;
  editContext?: EditContext;
  sceneType: "interior" | "exterior";
  editMode: "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";
  reinstateConfig?: any;
  hasStage1ABaseline: boolean;
  totalRegions: number;
  regionIndex: number;
}): RegionPromptPayload {
  const {
    userInstruction,
    roomType,
    editContext,
    sceneType,
    editMode,
    reinstateConfig,
    hasStage1ABaseline,
    totalRegions,
    regionIndex,
  } = params;

  const normalizedMode = normalizeEditMode(editMode);
  const useSecondaryContinuityEditMode = editContext?.secondaryContinuity?.enabled === true && normalizedMode !== "reinstate";

  const basePrompt = useSecondaryContinuityEditMode
    ? buildSecondaryContinuityEditPrompt({
        userIntent: userInstruction,
        sceneHint: buildStructuredSceneHint({
          sceneType,
          roomType,
          editContext,
        }),
        editContext,
      })
    : buildEditPrompt({
        mode: normalizedMode,
        userIntent: userInstruction,
        sceneHint: buildStructuredSceneHint({
          sceneType,
          roomType,
          editContext,
        }),
      });

  const reinstateTargetNote = normalizedMode === "reinstate" && reinstateConfig?.targetType
    ? `\n\nReinstate target: ${String(reinstateConfig.targetType).trim().toLowerCase()}.`
    : "";
  const baselineNote = hasStage1ABaseline && !useSecondaryContinuityEditMode
    ? "\n\nReference note: Use any provided Stage 1A reference only to infer original region content or structural surfaces. Do not copy unrelated furniture or redesign the scene."
    : "";

  const regionScopeSuffix = `

REGION-SPECIFIC INSTRUCTION:
- Apply only this region's assigned edit instruction: ${userInstruction}
- This is region ${regionIndex + 1} of ${totalRegions}.

CONSISTENCY RULES:
- Preserve consistency with existing objects in image.
- Match perspective, lighting, scale, and material cues already present.
- Do not duplicate edits intended for other masked regions.`;

  const cropPromptSuffix = `

CROPPED REGION EDIT RULES:
- You are editing ONLY the provided cropped region.
- The white center area is the target edit zone.
- The gray surrounding area is an allowed spill zone for realistic object placement.
- You may extend slightly into the gray area when needed for natural edges, shadows, or object placement.
- Do NOT redesign the surrounding environment.
- Do NOT make global changes to the room.`;

  const userPrompt = `${basePrompt.user.trim()}${reinstateTargetNote}${baselineNote}${regionScopeSuffix}${cropPromptSuffix}`.trim();

  return {
    systemPrompt: basePrompt.system,
    userPrompt,
    promptText: composePromptText(basePrompt.system, userPrompt),
  };
}

async function runRegionEditWithRetry(params: {
  prompt: string;
  systemPrompt?: string;
  userPrompt?: string;
  jobId?: string;
  imageId?: string;
  croppedEditableImageBuffer: Buffer;
  stage1AReferenceBuffer?: Buffer;
  approvedMasterReferenceBuffer?: Buffer;
  guidanceMaskPngBuffer: Buffer;
  roomType?: string;
  sceneType: "interior" | "exterior";
  mode: EditMode;
  regionIndex: number;
  totalRegions: number;
  expandedBox: PixelBox;
}): Promise<RegionEditResult> {
  const {
    prompt,
    systemPrompt,
    userPrompt,
    jobId,
    imageId,
    croppedEditableImageBuffer,
    stage1AReferenceBuffer,
    approvedMasterReferenceBuffer,
    guidanceMaskPngBuffer,
    roomType,
    sceneType,
    mode,
    regionIndex,
    totalRegions,
    expandedBox,
  } = params;

  const preparedInference = await prepareRegionInferencePayload({
    editableCropBuffer: croppedEditableImageBuffer,
    guidanceMaskBuffer: guidanceMaskPngBuffer,
    box: expandedBox,
  });

  console.log("[editApply] REGION_TRANSFORM_METADATA", {
    regionIndex,
    metadata: preparedInference.metadata,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_REGION_EDIT_ATTEMPTS; attempt += 1) {
    const isRetry = attempt > 1;
    const retrySuffix = `

RETRY INSTRUCTION:
- Retry only region ${regionIndex + 1} of ${totalRegions}.
- ONLY modify this assigned region.
- Do not modify surrounding area.
- Do not introduce additional objects.
- Keep structure unchanged.
- Preserve the existing surrounding composition exactly.
- Do not alter content intended for any other region.`;
    const attemptUserPrompt = isRetry
      ? `${(userPrompt || prompt).trim()}${retrySuffix}`
      : (userPrompt || prompt).trim();
    const attemptPrompt = systemPrompt
      ? composePromptText(systemPrompt, attemptUserPrompt)
      : attemptUserPrompt;

    try {
      console.log("[editApply] Region edit attempt", {
        regionIndex,
        totalRegions,
        attempt,
        maxAttempts: MAX_REGION_EDIT_ATTEMPTS,
        expandedBox,
        isRetry,
      });

      const editedBuffer = await regionEditWithGemini({
        prompt: attemptPrompt,
        systemPrompt,
        userPrompt: attemptUserPrompt,
        jobId,
        imageId,
        baseImageBuffer: preparedInference.transformedImageBuffer,
        referenceImageBuffer: stage1AReferenceBuffer,
        secondaryContinuityReferenceBuffer: approvedMasterReferenceBuffer,
        maskPngBuffer: preparedInference.transformedMaskBuffer,
        maskMode: "guidance",
        roomType,
        sceneType,
        editMode: mode,
      });
      const validated = await validateRegionEditResultOrThrow(editedBuffer, regionIndex);
      const reverseTransform = await reverseRegionInferenceTransform(validated, preparedInference.metadata);
      return {
        restoredBuffer: reverseTransform.restoredCropBuffer,
        transformMetadata: preparedInference.metadata,
        reverseTransform,
      };
    } catch (error) {
      lastError = error;
      const retryReason = getRetryReason(error);
      if (!retryReason) {
        throw error;
      }

      console.warn("[editApply] REGION_RETRY", {
        regionIndex,
        attempt,
        reason: retryReason,
      });
      console.warn("[editApply] Region edit attempt failed", {
        regionIndex,
        totalRegions,
        attempt,
        maxAttempts: MAX_REGION_EDIT_ATTEMPTS,
        expandedBox,
        reason: retryReason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Region ${regionIndex + 1} edit failed after ${MAX_REGION_EDIT_ATTEMPTS} attempts`);
}

async function buildFullImageBoxesMask(boxes: PixelBox[], width: number, height: number): Promise<Buffer> {
  const maskRaw = Buffer.alloc(width * height, 0);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      const rowOffset = y * width;
      for (let x = box.x; x < box.x + box.width; x += 1) {
        maskRaw[rowOffset + x] = 255;
      }
    }
  }

  return sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function computeExpandedEdgeFeatherPx(box: PixelBox): number {
  const scaled = Math.round(Math.max(box.width, box.height) * 0.01);
  return Math.max(MIN_EXPANDED_EDGE_FEATHER_PX, Math.min(MAX_EXPANDED_EDGE_FEATHER_PX, scaled || 0));
}

function validateGeneratedCropDimensions(
  generatedMeta: { width?: number; height?: number },
  expectedBox: PixelBox,
  regionIndex: number,
): boolean {
  const widthMatch = Number(generatedMeta.width || 0) === expectedBox.width;
  const heightMatch = Number(generatedMeta.height || 0) === expectedBox.height;
  console.log("[editApply] Generated crop validation", {
    regionIndex,
    expectedWidth: expectedBox.width,
    expectedHeight: expectedBox.height,
    actualWidth: generatedMeta.width,
    actualHeight: generatedMeta.height,
    widthMatch,
    heightMatch,
  });
  return widthMatch && heightMatch;
}

function getRetryReason(error: unknown): RegionRetryReason | null {
  if (error instanceof RetryableRegionEditError) {
    return error.reason;
  }

  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (!message) return "gemini_error";
  if (message.includes("timeout") || message.includes("timed out") || message.includes("deadline")) {
    return "timeout";
  }
  if (
    message.includes("gemini") ||
    message.includes("generatecontent") ||
    message.includes("candidate") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("api") ||
    message.includes("network")
  ) {
    return "gemini_error";
  }
  return null;
}

async function validateRegionEditResultOrThrow(
  generatedBuffer: Buffer,
  regionIndex: number,
): Promise<Buffer> {
  if (!generatedBuffer?.length) {
    throw new RetryableRegionEditError("empty_image", `Region ${regionIndex + 1} returned an empty image buffer`);
  }

  const generatedMeta = await sharp(generatedBuffer).metadata().catch(() => null);
  if (!generatedMeta?.width || !generatedMeta?.height) {
    throw new RetryableRegionEditError("corrupted_image", `Region ${regionIndex + 1} returned unreadable image data`);
  }

  return sharp(generatedBuffer)
    .removeAlpha()
    .toBuffer();
}

async function ensureExactCropSize(
  generatedBuffer: Buffer,
  expectedBox: PixelBox,
  regionIndex: number,
): Promise<Buffer> {
  const generatedMeta = await sharp(generatedBuffer).metadata().catch(() => null);
  console.log("[editApply] REGION_AUDIT: generation result dimensions", {
    regionIndex,
    generatedWidth: generatedMeta?.width,
    generatedHeight: generatedMeta?.height,
    cropWidth: expectedBox.width,
    cropHeight: expectedBox.height,
  });
  const exactMatch = validateGeneratedCropDimensions(generatedMeta || {}, expectedBox, regionIndex);

  if (exactMatch) {
    return sharp(generatedBuffer)
      .removeAlpha()
      .toBuffer();
  }

  console.warn("[editApply] EDIT_DEBUG: resizing generated crop to exact expanded box", {
    regionIndex,
    expectedWidth: expectedBox.width,
    expectedHeight: expectedBox.height,
    actualWidth: generatedMeta?.width,
    actualHeight: generatedMeta?.height,
  });

  return sharp(generatedBuffer)
    .resize(expectedBox.width, expectedBox.height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();
}

function logMaskAlignment(regionIndex: number, bbox: PixelBox, expandedBox: PixelBox): void {
  const mappedMaskBounds = {
    x: bbox.x - expandedBox.x,
    y: bbox.y - expandedBox.y,
    width: bbox.width,
    height: bbox.height,
  };
  const exceedsCropBounds =
    mappedMaskBounds.x < 0 ||
    mappedMaskBounds.y < 0 ||
    (mappedMaskBounds.x + mappedMaskBounds.width) > expandedBox.width ||
    (mappedMaskBounds.y + mappedMaskBounds.height) > expandedBox.height;

  if (exceedsCropBounds) {
    console.warn("[editApply] MASK ALIGNMENT ERROR", {
      regionIndex,
      bbox,
      expandedBox,
      mappedMaskBounds,
    });
    return;
  }

  console.log("[editApply] EDIT_DEBUG: mask alignment validated", {
    regionIndex,
    bbox,
    expandedBox,
    mappedMaskBounds,
  });
}

function buildDebugBoxSvg(
  width: number,
  height: number,
  expandedBoxes: PixelBox[],
  compositeBoxes: PixelBox[],
): string {
  const expandedRects = expandedBoxes.map((box) => {
    const x = box.x + 1;
    const y = box.y + 1;
    const rectWidth = Math.max(1, box.width - 2);
    const rectHeight = Math.max(1, box.height - 2);
    return `<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="none" stroke="#22c55e" stroke-width="3" />`;
  }).join("");

  const compositeRects = compositeBoxes.map((box) => {
    const x = box.x + 4;
    const y = box.y + 4;
    const rectWidth = Math.max(1, box.width - 8);
    const rectHeight = Math.max(1, box.height - 8);
    return `<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="none" stroke="#2563eb" stroke-width="2" stroke-dasharray="8 6" />`;
  }).join("");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${expandedRects}
      ${compositeRects}
    </svg>
  `;
}

async function buildDebugMaskOverlay(maskPngBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  const rawMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const redRgb = Buffer.alloc(width * height * 3, 0);
  const alpha = Buffer.alloc(width * height, 0);

  for (let i = 0; i < width * height; i += 1) {
    redRgb[(i * 3)] = 255;
    alpha[i] = (rawMask.data[i] ?? 0) > 127 ? 96 : 0;
  }

  return sharp(redRgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function writeDebugOverlayArtifact(params: {
  outPath: string;
  baseImage: string | Buffer;
  maskPngBuffer: Buffer;
  expandedBoxes: PixelBox[];
  compositeBoxes: PixelBox[];
  width: number;
  height: number;
}): Promise<void> {
  if (!isEditDebugOverlayEnabled()) return;

  const { outPath, baseImage, maskPngBuffer, expandedBoxes, compositeBoxes, width, height } = params;
  const overlayPath = debugOverlayArtifactPathForOutput(outPath);
  const maskOverlay = await buildDebugMaskOverlay(maskPngBuffer, width, height);
  const boxOverlay = Buffer.from(buildDebugBoxSvg(width, height, expandedBoxes, compositeBoxes));

  await sharp(baseImage)
    .composite([
      { input: maskOverlay, blend: "over" },
      { input: boxOverlay, blend: "over" },
    ])
    .png()
    .toFile(overlayPath);

  console.log("[editApply] EDIT_DEBUG: wrote debug overlay artifact", {
    overlayPath,
    regionCount: expandedBoxes.length,
  });
}

async function compositeExpandedCrop(
  originalImagePath: string | Buffer,
  generatedBuffer: Buffer,
  croppedMaskPngBuffer: Buffer,
  box: PixelBox,
  featherPx: number,
): Promise<{ compositedImage: Buffer; debug: CompositeExpandedCropDebug }> {
  const alignedGenerated = await sharp(generatedBuffer)
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();

  const originalCropBuffer = await sharp(originalImagePath)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .removeAlpha()
    .toBuffer();

  const { alphaMask, changedPixels } = await buildDeltaMaskForCrop({
    originalCropBuffer,
    editedCropBuffer: alignedGenerated,
    croppedMaskPngBuffer,
    width: box.width,
    height: box.height,
  });

  if (changedPixels < DELTA_MASK_MIN_CHANGED_PIXELS) {
    console.log("[editApply] DELTA_COMPOSITE_SKIPPED", {
      box,
      changedPixels,
      threshold: DELTA_MASK_MIN_CHANGED_PIXELS,
    });
    return {
      compositedImage: await sharp(originalImagePath).png().toBuffer(),
      debug: {
        rawBinaryMask: Buffer.alloc(box.width * box.height, 0),
        featheredMask: Buffer.alloc(box.width * box.height, 0),
        finalAlphaMask: Buffer.alloc(box.width * box.height, 0),
        compositePreview: originalCropBuffer,
        changedPixels,
      },
    };
  }

  const harmonizedGenerated = await harmonizePatchToLocalNeighborhood({
    candidateBuffer: alignedGenerated,
    referenceBuffer: originalCropBuffer,
    binaryMaskBuffer: croppedMaskPngBuffer,
    width: box.width,
    height: box.height,
    context: "expanded_crop",
  });

  const alphaRaw = Buffer.alloc(box.width * box.height, 255);
  if (featherPx > 0) {
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const edgeDistance = Math.min(x, y, (box.width - 1) - x, (box.height - 1) - y);
        if (edgeDistance >= featherPx) continue;
        const alpha = Math.max(0, Math.min(255, Math.round((edgeDistance / featherPx) * 255)));
        alphaRaw[(y * box.width) + x] = alpha;
      }
    }
  }

  for (let i = 0; i < alphaRaw.length; i += 1) {
    const deltaAlpha = alphaMask[i] ?? 0;
    alphaRaw[i] = Math.round(((alphaRaw[i] ?? 0) * deltaAlpha) / 255);
  }

  const finalAlphaMask = Buffer.from(alphaRaw);
  const overlayBuffer = await sharp(harmonizedGenerated)
    .joinChannel(alphaRaw, { raw: { width: box.width, height: box.height, channels: 1 } })
    .png()
    .toBuffer();

  const compositedImage = await sharp(originalImagePath)
    .composite([{ input: overlayBuffer, left: box.x, top: box.y }])
    .png()
    .toBuffer();

  return {
    compositedImage,
    debug: {
      rawBinaryMask: alphaMask,
      featheredMask: Buffer.from(alphaRaw),
      finalAlphaMask,
      compositePreview: await sharp(harmonizedGenerated)
        .joinChannel(finalAlphaMask, { raw: { width: box.width, height: box.height, channels: 1 } })
        .png()
        .toBuffer(),
      changedPixels,
    },
  };
}

function resolveMaskFeatherPx(box: PixelBox): number {
  return Math.max(2, Math.min(4, computeExpandedEdgeFeatherPx(box)));
}

async function compositeMaskedSourceIntoBase(params: {
  baseImage: string | Buffer;
  sourceImage: string | Buffer;
  maskPngBuffer: Buffer;
  width: number;
  height: number;
  featherPx: number;
}): Promise<Buffer> {
  const { baseImage, sourceImage, maskPngBuffer, width, height, featherPx } = params;

  const baseBuffer = await sharp(baseImage)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .png()
    .toBuffer();

  const sourceBuffer = await sharp(sourceImage)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .png()
    .toBuffer();

  const normalizedMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const featheredMask = featherPx > 0
    ? await sharp(normalizedMask)
      .blur(Math.max(0.3, featherPx / 2))
      .png()
      .toBuffer()
    : normalizedMask;

  const invertedMask = await sharp(featheredMask)
    .negate()
    .png()
    .toBuffer();

  const baseMasked = await sharp(baseBuffer)
    .composite([{ input: invertedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const sourceMasked = await sharp(sourceBuffer)
    .composite([{ input: featheredMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(baseMasked)
    .composite([{ input: sourceMasked, blend: "over" }])
    .png()
    .toBuffer();
}

async function compositeBaselineCrop(params: {
  originalImage: string | Buffer;
  baselineImage: Buffer;
  croppedMaskPngBuffer: Buffer;
  box: PixelBox;
  featherPx: number;
  mode: EditMode;
  regionIndex?: number;
}): Promise<Buffer> {
  const { originalImage, baselineImage, croppedMaskPngBuffer, box, featherPx, mode, regionIndex } = params;

  const enhancedCrop = await sharp(originalImage)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .removeAlpha()
    .png()
    .toBuffer();

  const baselineCrop = await sharp(baselineImage)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .removeAlpha()
    .png()
    .toBuffer();

  console.log("[editApply] BASELINE_COMPOSITE_CROP", {
    mode,
    regionIndex,
    expandedBox: box,
    cropWidth: box.width,
    cropHeight: box.height,
    featherPx,
  });

  const outputCrop = await compositeMaskedSourceIntoBase({
    baseImage: enhancedCrop,
    sourceImage: baselineCrop,
    maskPngBuffer: croppedMaskPngBuffer,
    width: box.width,
    height: box.height,
    featherPx,
  });

  return sharp(originalImage)
    .composite([{ input: outputCrop, left: box.x, top: box.y }])
    .png()
    .toBuffer();
}

async function buildMaskRegions(maskPngBuffer: Buffer, width: number, height: number): Promise<{
  innerMask: Buffer;
  projectionMask: Buffer;
  dilatedMask: Buffer;
  outsideMask: Buffer;
}> {
  const innerMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const dilatePx = projectionDilatePx(width, height);
  const dilatedMask = await sharp(innerMask)
    .dilate(dilatePx)
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const innerRaw = await sharp(innerMask)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const dilatedRaw = await sharp(dilatedMask)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const projectionRaw = Buffer.alloc(innerRaw.data.length, 0);
  const outsideRaw = Buffer.alloc(innerRaw.data.length, 0);

  for (let i = 0; i < innerRaw.data.length; i += 1) {
    const inner = (innerRaw.data[i] ?? 0) > 127;
    const dilated = (dilatedRaw.data[i] ?? 0) > 127;
    projectionRaw[i] = dilated && !inner ? 255 : 0;
    outsideRaw[i] = dilated ? 0 : 255;
  }

  const projectionMask = await sharp(projectionRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();

  const outsideMask = await sharp(outsideRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();

  return {
    innerMask,
    projectionMask,
    dilatedMask,
    outsideMask,
  };
}

async function computeOutsideAllowedChangedPct(
  baseImagePath: string,
  editedImagePath: string,
  allowedMask: Buffer
): Promise<number | null> {
  try {
    const baseRaw = await sharp(baseImagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const editedRaw = await sharp(editedImagePath)
      .resize(baseRaw.info.width, baseRaw.info.height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const allowedRaw = await sharp(allowedMask)
      .removeAlpha()
      .grayscale()
      .resize(baseRaw.info.width, baseRaw.info.height, {
        fit: "contain",
        position: normalizeSharpResizePosition("top-left"),
        background: { r: 0, g: 0, b: 0, alpha: 1 },
        kernel: sharp.kernel.nearest,
      })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = baseRaw.info.width * baseRaw.info.height;
    if (pixels === 0) return null;

    let outsideCount = 0;
    let outsideChanged = 0;
    const changeThreshold = 14;
    for (let i = 0; i < pixels; i += 1) {
      const allowed = allowedRaw.data[i] ?? 0;
      if (allowed > 127) continue;
      outsideCount += 1;

      const idx = i * 3;
      const dr = Math.abs((baseRaw.data[idx] ?? 0) - (editedRaw.data[idx] ?? 0));
      const dg = Math.abs((baseRaw.data[idx + 1] ?? 0) - (editedRaw.data[idx + 1] ?? 0));
      const db = Math.abs((baseRaw.data[idx + 2] ?? 0) - (editedRaw.data[idx + 2] ?? 0));
      if (dr + dg + db >= changeThreshold) {
        outsideChanged += 1;
      }
    }

    if (outsideCount === 0) return 0;
    return Number(((outsideChanged / outsideCount) * 100).toFixed(4));
  } catch {
    return null;
  }
}

async function compositeStrictMask(
  originalImagePath: string,
  generatedBuffer: Buffer,
  maskPngBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const alignedGenerated = await sharp(generatedBuffer)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();

  const normalizedMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const invertedMask = await sharp(normalizedMask)
    .negate()
    .png()
    .toBuffer();

  const originalMasked = await sharp(originalImagePath)
    .resize(width, height, { fit: "fill" })
    .png()
    .composite([{ input: invertedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const generatedMasked = await sharp(alignedGenerated)
    .composite([{ input: normalizedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(originalMasked)
    .composite([{ input: generatedMasked, blend: "over" }])
    .png()
    .toBuffer();
}

/**
 * Blend edge tones: compute mean RGB in a narrow band just outside the mask (original)
 * and just inside the mask (composite). Apply a per-channel multiplicative correction
 * to the masked region so the generated content matches surrounding tones seamlessly.
 * Falls back to the unmodified composite if the correction is negligible or fails.
 */
async function blendMaskEdgeTones(
  compositeBuffer: Buffer,
  originalImagePath: string,
  maskPngBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  try {
    const BAND_PX = Math.max(2, Math.round(Math.max(width, height) * 0.005));

    // Build inner-edge band (erode mask, XOR with original mask)
    const binaryMask = await sharp(maskPngBuffer)
      .removeAlpha().grayscale().threshold(127, { grayscale: true })
      .raw().toBuffer();

    const erodedMask = await sharp(maskPngBuffer)
      .removeAlpha().grayscale().threshold(127, { grayscale: true })
      .erode(BAND_PX).raw().toBuffer();

    const dilatedMask = await sharp(maskPngBuffer)
      .removeAlpha().grayscale().threshold(127, { grayscale: true })
      .dilate(BAND_PX).raw().toBuffer();

    const pixels = width * height;
    // Inner edge: inside mask but outside eroded mask
    // Outer edge: outside mask but inside dilated mask
    const innerEdge = Buffer.alloc(pixels);
    const outerEdge = Buffer.alloc(pixels);
    for (let i = 0; i < pixels; i++) {
      const inMask = (binaryMask[i] ?? 0) > 127;
      const inEroded = (erodedMask[i] ?? 0) > 127;
      const inDilated = (dilatedMask[i] ?? 0) > 127;
      innerEdge[i] = inMask && !inEroded ? 1 : 0;
      outerEdge[i] = !inMask && inDilated ? 1 : 0;
    }

    // Sample from composite (inner edge) and original (outer edge)
    const compRaw = await sharp(compositeBuffer).resize(width, height, { fit: "fill" })
      .removeAlpha().raw().toBuffer();
    const origRaw = await sharp(originalImagePath).resize(width, height, { fit: "fill" })
      .removeAlpha().raw().toBuffer();

    let innerR = 0, innerG = 0, innerB = 0, innerCount = 0;
    let outerR = 0, outerG = 0, outerB = 0, outerCount = 0;

    for (let i = 0; i < pixels; i++) {
      const idx = i * 3;
      if (innerEdge[i]) {
        innerR += compRaw[idx]!;
        innerG += compRaw[idx + 1]!;
        innerB += compRaw[idx + 2]!;
        innerCount++;
      }
      if (outerEdge[i]) {
        outerR += origRaw[idx]!;
        outerG += origRaw[idx + 1]!;
        outerB += origRaw[idx + 2]!;
        outerCount++;
      }
    }

    if (innerCount < 10 || outerCount < 10) {
      console.log("[editApply] blendMaskEdgeTones: insufficient edge pixels, skipping", { innerCount, outerCount });
      return compositeBuffer;
    }

    const avgInner = [innerR / innerCount, innerG / innerCount, innerB / innerCount];
    const avgOuter = [outerR / outerCount, outerG / outerCount, outerB / outerCount];

    // Compute per-channel correction ratios (clamped to prevent extreme shifts)
    const corrections = avgInner.map((inner, ch) => {
      if (inner < 1) return 1;
      const ratio = avgOuter[ch]! / inner;
      return Math.max(0.85, Math.min(1.15, ratio));
    });

    const maxShift = Math.max(...corrections.map(c => Math.abs(c - 1)));
    if (maxShift < 0.01) {
      console.log("[editApply] blendMaskEdgeTones: negligible correction, skipping", {
        corrections, avgInner, avgOuter,
      });
      return compositeBuffer;
    }

    console.log("[editApply] blendMaskEdgeTones: applying correction", {
      corrections: corrections.map(c => c.toFixed(4)),
      avgInner: avgInner.map(v => v.toFixed(1)),
      avgOuter: avgOuter.map(v => v.toFixed(1)),
      bandPx: BAND_PX,
      innerEdgePx: innerCount,
      outerEdgePx: outerCount,
    });

    // Apply correction only to pixels inside the mask
    const corrected = Buffer.from(compRaw);
    for (let i = 0; i < pixels; i++) {
      if ((binaryMask[i] ?? 0) <= 127) continue;
      const idx = i * 3;
      corrected[idx] = Math.min(255, Math.max(0, Math.round(compRaw[idx]! * corrections[0]!)));
      corrected[idx + 1] = Math.min(255, Math.max(0, Math.round(compRaw[idx + 1]! * corrections[1]!)));
      corrected[idx + 2] = Math.min(255, Math.max(0, Math.round(compRaw[idx + 2]! * corrections[2]!)));
    }

    return sharp(corrected, { raw: { width, height, channels: 3 } }).png().toBuffer();
  } catch (err) {
    console.warn("[editApply] blendMaskEdgeTones failed (non-blocking):", (err as any)?.message || err);
    return compositeBuffer;
  }
}

function classifyOutsideLeakPct(pct: number | null): "none" | "soft_anomaly" | "real_leak" | "unknown" {
  if (!Number.isFinite(pct as number)) return "unknown";
  const value = Number(pct);
  if (value <= 0.2) return "none";
  if (value <= 1) return "soft_anomaly";
  return "real_leak";
}

function intersectsNormBbox(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
}

function intersectionAreaNormBbox(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function getNormBboxCenter(bbox: [number, number, number, number]): { cx: number; cy: number } {
  return {
    cx: bbox[0] + ((bbox[2] - bbox[0]) / 2),
    cy: bbox[1] + ((bbox[3] - bbox[1]) / 2),
  };
}

function describeRelativeImagePosition(cx: number, cy: number): string {
  const horizontal = cx < 0.33 ? "left" : cx > 0.67 ? "right" : "center";
  const vertical = cy < 0.33 ? "upper" : cy > 0.67 ? "lower" : "middle";

  if (horizontal === "center" && vertical === "middle") {
    return "center";
  }

  if (horizontal === "center") {
    return vertical;
  }

  if (vertical === "middle") {
    return horizontal;
  }

  return `${vertical}-${horizontal}`;
}

type SemanticAddPlacementRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  area: number;
  relativePosition: string;
};

type SemanticAddPlacementGuidance = {
  placementRegion: SemanticAddPlacementRegion;
  placementRegions: Array<SemanticAddPlacementRegion & { index: number }>;
  regionCount: number;
  totalArea: number;
};

function pixelBoxToNormalizedPlacementRegion(box: PixelBox, width: number, height: number): SemanticAddPlacementRegion {
  const normalizedX = box.x / width;
  const normalizedY = box.y / height;
  const normalizedWidth = box.width / width;
  const normalizedHeight = box.height / height;
  const centerX = normalizedX + (normalizedWidth / 2);
  const centerY = normalizedY + (normalizedHeight / 2);

  return {
    x: Number(normalizedX.toFixed(4)),
    y: Number(normalizedY.toFixed(4)),
    width: Number(normalizedWidth.toFixed(4)),
    height: Number(normalizedHeight.toFixed(4)),
    centerX: Number(centerX.toFixed(4)),
    centerY: Number(centerY.toFixed(4)),
    area: Number((normalizedWidth * normalizedHeight).toFixed(4)),
    relativePosition: describeRelativeImagePosition(centerX, centerY),
  };
}

async function buildSemanticAddPlacementGuidance(
  maskPngBuffer: Buffer,
  width: number,
  height: number,
): Promise<SemanticAddPlacementGuidance | null> {
  const regions = await splitMaskIntoRegions(maskPngBuffer, width, height);
  if (regions.length === 0) return null;

  const sortedRegions = [...regions].sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  const placementRegions = sortedRegions.map((region, index) => ({
    index,
    ...pixelBoxToNormalizedPlacementRegion(region.bbox, width, height),
  }));

  const aggregateBox = sortedRegions.reduce((acc, region) => {
    const right = region.bbox.x + region.bbox.width;
    const bottom = region.bbox.y + region.bbox.height;
    if (acc === null) {
      return {
        x: region.bbox.x,
        y: region.bbox.y,
        right,
        bottom,
      };
    }
    return {
      x: Math.min(acc.x, region.bbox.x),
      y: Math.min(acc.y, region.bbox.y),
      right: Math.max(acc.right, right),
      bottom: Math.max(acc.bottom, bottom),
    };
  }, null as null | { x: number; y: number; right: number; bottom: number });

  const aggregatePlacementRegion = aggregateBox
    ? pixelBoxToNormalizedPlacementRegion({
        x: aggregateBox.x,
        y: aggregateBox.y,
        width: Math.max(1, aggregateBox.right - aggregateBox.x),
        height: Math.max(1, aggregateBox.bottom - aggregateBox.y),
      }, width, height)
    : null;

  const totalArea = placementRegions.reduce((sum, region) => sum + region.area, 0);

  return {
    placementRegion: aggregatePlacementRegion || placementRegions[0]!,
    placementRegions,
    regionCount: placementRegions.length,
    totalArea: Number(totalArea.toFixed(4)),
  };
}

async function buildSemanticAddPlacementRegion(
  maskPngBuffer: Buffer,
  width: number,
  height: number,
): Promise<SemanticAddPlacementRegion | null> {
  const bbox = await maskToNormalizedBbox(maskPngBuffer, width, height);
  if (!bbox) return null;

  const center = getNormBboxCenter(bbox);
  const regionWidth = Math.max(0, bbox[2] - bbox[0]);
  const regionHeight = Math.max(0, bbox[3] - bbox[1]);
  const area = regionWidth * regionHeight;

  return {
    x: Number(bbox[0].toFixed(4)),
    y: Number(bbox[1].toFixed(4)),
    width: Number(regionWidth.toFixed(4)),
    height: Number(regionHeight.toFixed(4)),
    centerX: Number(center.cx.toFixed(4)),
    centerY: Number(center.cy.toFixed(4)),
    area: Number(area.toFixed(4)),
    relativePosition: describeRelativeImagePosition(center.cx, center.cy),
  };
}

function computeNormalizedCenterDistance(
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt((dx * dx) + (dy * dy));
}

async function maskToNormalizedBbox(maskPngBuffer: Buffer, width: number, height: number): Promise<[number, number, number, number] | null> {
  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = raw.data[y * width + x] ?? 0;
      if (value <= 127) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  return [
    minX / width,
    minY / height,
    (maxX + 1) / width,
    (maxY + 1) / height,
  ];
}

async function computeMaskCoverageRatio(maskPngBuffer: Buffer, width: number, height: number): Promise<number> {
  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = width * height;
  if (pixels <= 0) return 0;

  let coveredPixels = 0;
  for (let index = 0; index < pixels; index += 1) {
    if ((raw.data[index] ?? 0) > 127) {
      coveredPixels += 1;
    }
  }

  return coveredPixels / pixels;
}

function openingMatchesReinstateTarget(
  opening: OpeningRegion,
  targetType: ReinstateConfig["targetType"],
): boolean {
  if (targetType === "auto") return true;
  if (targetType === "opening") return true;
  return opening.type === targetType;
}

function selectBestOpening(
  openings: OpeningRegion[],
  userMaskBbox: [number, number, number, number],
): OpeningRegion | null {
  const maskCenter = getNormBboxCenter(userMaskBbox);
  const ranked = openings
    .map((opening) => {
      const intersectionScore = intersectionAreaNormBbox(userMaskBbox, opening.normalizedBbox);
      const confidenceScore = Math.max(0, Math.min(1, opening.confidence));
      const openingCenter = getNormBboxCenter(opening.normalizedBbox);
      const distance = computeNormalizedCenterDistance(maskCenter, openingCenter);
      const proximityScore = 1 - Math.min(distance, 1);
      const score =
        (0.5 * intersectionScore) +
        (0.3 * confidenceScore) +
        (0.2 * proximityScore);

      return {
        opening,
        score,
        intersectionScore,
        confidenceScore,
        proximityScore,
      };
    })
    .filter((entry) => entry.intersectionScore > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.intersectionScore !== a.intersectionScore) return b.intersectionScore - a.intersectionScore;
      return b.confidenceScore - a.confidenceScore;
    });

  const topCandidates = ranked.slice(0, 3).map((entry) => ({
    score: Number(entry.score.toFixed(6)),
    intersection: Number(entry.intersectionScore.toFixed(6)),
    confidence: Number(entry.confidenceScore.toFixed(6)),
    proximity: Number(entry.proximityScore.toFixed(6)),
    bbox: entry.opening.bbox,
  }));

  const best = ranked[0] || null;
  if (best) {
    console.log("[Reinstate Selection]", {
      chosen: topCandidates[0],
      alternatives: topCandidates.slice(1),
    });
  }

  return best?.opening ?? null;
}

async function buildMaskFromOpeningBBox(
  bbox: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  paddingPx = 5,
): Promise<Buffer> {
  const x1 = Math.max(0, Math.floor(bbox.x * width) - paddingPx);
  const y1 = Math.max(0, Math.floor(bbox.y * height) - paddingPx);
  const x2 = Math.min(width, Math.ceil((bbox.x + bbox.width) * width) + paddingPx);
  const y2 = Math.min(height, Math.ceil((bbox.y + bbox.height) * height) + paddingPx);

  const maskRaw = Buffer.alloc(width * height, 0);
  for (let y = y1; y < y2; y += 1) {
    const rowOffset = y * width;
    for (let x = x1; x < x2; x += 1) {
      maskRaw[rowOffset + x] = 255;
    }
  }

  return sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function normalizedRectToPixelBox(
  bbox: [number, number, number, number],
  width: number,
  height: number,
): PixelBox | null {
  const [x, y, boxWidth, boxHeight] = bbox.map((value) => Number(value) || 0) as [number, number, number, number];
  if (boxWidth <= 0 || boxHeight <= 0) return null;

  const left = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(y * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((x + boxWidth) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((y + boxHeight) * height)));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

async function unionMaskWithPixelBoxes(
  maskPngBuffer: Buffer,
  boxes: PixelBox[],
  width: number,
  height: number,
): Promise<Buffer> {
  if (boxes.length === 0) return maskPngBuffer;

  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const unionRaw = Buffer.from(raw.data);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      const rowOffset = y * width;
      for (let x = box.x; x < box.x + box.width; x += 1) {
        unionRaw[rowOffset + x] = 255;
      }
    }
  }

  return sharp(unionRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function subtractMaskWithPixelBoxes(
  maskPngBuffer: Buffer,
  boxes: PixelBox[],
  width: number,
  height: number,
): Promise<Buffer> {
  if (boxes.length === 0) return maskPngBuffer;

  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const subtractedRaw = Buffer.from(raw.data);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      const rowOffset = y * width;
      for (let x = box.x; x < box.x + box.width; x += 1) {
        subtractedRaw[rowOffset + x] = 0;
      }
    }
  }

  return sharp(subtractedRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function binaryMaskToRaw(maskPngBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  const raw = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return Buffer.from(raw.data);
}

async function rawMaskToPng(maskRaw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function getMaskPixelBBoxFromRaw(maskRaw: Buffer, width: number, height: number): PixelBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = maskRaw[(y * width) + x] ?? 0;
      if (value <= 127) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  return {
    x: minX,
    y: minY,
    width: (maxX - minX) + 1,
    height: (maxY - minY) + 1,
  };
}

function expandPixelBoxWithTolerance(box: PixelBox, width: number, height: number, tolerancePx: number): PixelBox {
  const left = Math.max(0, box.x - tolerancePx);
  const top = Math.max(0, box.y - tolerancePx);
  const right = Math.min(width, box.x + box.width + tolerancePx);
  const bottom = Math.min(height, box.y + box.height + tolerancePx);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function isPixelBoxFullyInside(inner: PixelBox, outer: PixelBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    (inner.x + inner.width) <= (outer.x + outer.width) &&
    (inner.y + inner.height) <= (outer.y + outer.height)
  );
}

function pixelBoxEdgeDistance(a: PixelBox, b: PixelBox): number {
  const horizontalGap = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const verticalGap = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return Math.sqrt((horizontalGap * horizontalGap) + (verticalGap * verticalGap));
}

async function smoothMaskBoundary(maskPngBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .erode(1)
    .dilate(1)
    .png()
    .toBuffer();
}

async function refineMaskAgainstDetectedObjects(params: {
  jobId?: string;
  imageId?: string;
  mode: EditMode;
  baseImagePath: string;
  maskPngBuffer: Buffer;
  width: number;
  height: number;
  sceneType?: FurnitureDetectionSceneType;
}): Promise<Buffer> {
  const { baseImagePath, maskPngBuffer, width, height } = params;
  let currentMaskPngBuffer = maskPngBuffer;
  let currentMaskRaw = await binaryMaskToRaw(currentMaskPngBuffer, width, height);
  let currentMaskBox = getMaskPixelBBoxFromRaw(currentMaskRaw, width, height);
  if (!currentMaskBox) return maskPngBuffer;

  const containmentTolerancePx = 8;
  const snapThresholdPx = 10;
  const accidentalTouchThreshold = 0.15;
  const intentionalRemovalThreshold = 0.6;
  const maskCoverageRatio = await computeMaskCoverageRatio(maskPngBuffer, width, height);

  try {
    const detection = await runFurnitureDetectionSafe({
      jobId: params.jobId,
      imageId: params.imageId,
      imagePath: baseImagePath,
      mode: params.mode,
      hasUserMask: true,
      maskCoverageRatio,
      sceneType: params.sceneType === "exterior" ? "exterior" : "interior",
    });
    if (!detection || detection.status !== "success" || !Array.isArray(detection.furnitureItems)) {
      console.log("[editApply] MASK_OBJECT_REFINEMENT", {
        mode: params.mode,
        detectorStatus: detection?.status || "skipped",
        maskCoverageRatio: Number(maskCoverageRatio.toFixed(4)),
        refinementCount: 0,
      });
      return maskPngBuffer;
    }

    const candidateBoxes = detection.furnitureItems
      .filter((item) => item.location?.bbox && item.confidence >= 0.35)
      .map((item) => ({
        item,
        box: normalizedRectToPixelBox(item.location!.bbox, width, height),
      }))
      .filter((entry): entry is { item: FurnitureItem; box: PixelBox } => !!entry.box);

    const decisions: Array<Record<string, unknown>> = [];
    let refinementCount = 0;

    for (const entry of candidateBoxes) {
      if (!currentMaskBox) break;

      const intersectionArea = pixelBoxIntersectionArea(currentMaskBox, entry.box);
      const overlapRatio = intersectionArea / Math.max(1, pixelBoxArea(entry.box));
      const tolerantMaskBox = expandPixelBoxWithTolerance(
        currentMaskBox,
        width,
        height,
        containmentTolerancePx,
      );
      const fullyInsideMask = isPixelBoxFullyInside(entry.box, tolerantMaskBox);
      const edgeDistancePx = pixelBoxEdgeDistance(currentMaskBox, entry.box);

      let action = "ignore_ambiguous";
      if (fullyInsideMask) {
        action = "ignore_already_covered";
      } else if (overlapRatio > intentionalRemovalThreshold) {
        currentMaskPngBuffer = await unionMaskWithPixelBoxes(currentMaskPngBuffer, [entry.box], width, height);
        currentMaskRaw = await binaryMaskToRaw(currentMaskPngBuffer, width, height);
        currentMaskBox = getMaskPixelBBoxFromRaw(currentMaskRaw, width, height);
        refinementCount += 1;
        action = "expand_intentional_overlap";
      } else if (intersectionArea > 0 && overlapRatio < accidentalTouchThreshold) {
        currentMaskPngBuffer = await subtractMaskWithPixelBoxes(currentMaskPngBuffer, [entry.box], width, height);
        currentMaskRaw = await binaryMaskToRaw(currentMaskPngBuffer, width, height);
        currentMaskBox = getMaskPixelBBoxFromRaw(currentMaskRaw, width, height);
        refinementCount += 1;
        action = "shrink_accidental_touch";
      } else if (intersectionArea === 0 && edgeDistancePx <= snapThresholdPx) {
        currentMaskPngBuffer = await unionMaskWithPixelBoxes(currentMaskPngBuffer, [entry.box], width, height);
        currentMaskRaw = await binaryMaskToRaw(currentMaskPngBuffer, width, height);
        currentMaskBox = getMaskPixelBBoxFromRaw(currentMaskRaw, width, height);
        refinementCount += 1;
        action = "snap_expand_to_boundary";
      }

      decisions.push({
        label: entry.item.label,
        type: entry.item.type,
        confidence: entry.item.confidence,
        bbox: entry.box,
        overlapRatio: Number(overlapRatio.toFixed(4)),
        edgeDistancePx: Number(edgeDistancePx.toFixed(2)),
        action,
      });
    }

    if (refinementCount > 0) {
      currentMaskPngBuffer = await smoothMaskBoundary(currentMaskPngBuffer, width, height);
      currentMaskRaw = await binaryMaskToRaw(currentMaskPngBuffer, width, height);
      currentMaskBox = getMaskPixelBBoxFromRaw(currentMaskRaw, width, height);
    }

    console.log("[editApply] MASK_OBJECT_REFINEMENT", {
      mode: params.mode,
      maskCoverageRatio: Number(maskCoverageRatio.toFixed(4)),
      maskBbox: getMaskPixelBBoxFromRaw(await binaryMaskToRaw(maskPngBuffer, width, height), width, height),
      containmentTolerancePx,
      snapThresholdPx,
      accidentalTouchThreshold,
      intentionalRemovalThreshold,
      refinementCount,
      effectiveMaskBox: currentMaskBox,
      decisions,
    });

    return currentMaskPngBuffer;
  } catch (error) {
    console.warn("[editApply] Mask refinement skipped (non-blocking):", error instanceof Error ? error.message : String(error));
    return maskPngBuffer;
  }
}

export type ReinstateConfig = {
  targetType: "window" | "doorway" | "opening" | "auto";
  geometry?: {
    bbox: { x: number; y: number; width: number; height: number };
    confidence?: number;
    openingId?: string;
  };
};

export type EditMode = "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";

export interface ApplyEditArgs {
  jobId?: string;
  imageId?: string;
  baseImagePath: string;      // path to the enhanced image we’re editing
  mask: Buffer;               // binary mask (white = edit, black = keep)
  mode: EditMode;             // "Add" | "Remove" | "Restore"
  instruction: string;        // user’s natural-language instruction
  restoreFromPath?: string;   // optional path to original/enhanced image for restore mode
  stage1AReferencePath?: string; // optional Stage-1A enhanced reference image (remove mode)
  approvedMasterReferencePath?: string;
  reinstateConfig?: ReinstateConfig;
  onAnchorValidation?: (result: { passed: boolean; overlapPct: number }) => void;
  roomType?: string;
  editContext?: EditContext;
  sceneType?: "interior" | "exterior";
}

/**
 * Run a region edit with Gemini, using a mask and user instruction.
 * Returns the path to the edited image on disk.
 */
export async function applyEdit({
  jobId,
  imageId,
  baseImagePath,
  mask,
  mode,
  instruction,
  restoreFromPath,
  stage1AReferencePath,
  approvedMasterReferencePath,
  reinstateConfig,
  onAnchorValidation,
  roomType,
  editContext,
  sceneType,
}: ApplyEditArgs): Promise<string> {
    const normalizedMode = normalizeEditMode(mode);
    console.log("[editApply] Starting edit", {
      baseImagePath,
      mode,
      instruction,
      hasMask: !!mask,
      maskSize: mask?.length ?? 0,
      hasRestoreFrom: !!restoreFromPath,
      hasStage1AReference: !!stage1AReferencePath,
    });

    const baseImage = sharp(baseImagePath);
    const meta = await baseImage.metadata();
    console.log("[editApply] Base image dimensions:", {
      width: meta.width,
      height: meta.height,
    });

    if (!meta.width || !meta.height) {
      throw new Error("Base image is missing width/height metadata for mask alignment");
    }

    // Normalize mask to image coordinates and encode as PNG
    let maskPngBuffer: Buffer | undefined;
    if (mask) {
      maskPngBuffer = await normalizeMaskToImageSpace(mask, meta.width, meta.height);
      console.log("[editApply] Mask normalized to image coordinate space");
      // Save debug PNG
      const debugMaskPath = require("path").join(require("path").dirname(baseImagePath), "debug-mask.png");
      await sharp(maskPngBuffer).toFile(debugMaskPath);
      // Log mask stats
      const maskStats = await sharp(maskPngBuffer).stats();
      console.log("[editApply] Mask stats:", {
        debugMaskPath,
        // Use meta.width and meta.height for dimensions if needed
        channels: maskStats.channels,
        min: maskStats.channels.map((c:any)=>c.min),
        max: maskStats.channels.map((c:any)=>c.max),
        sum: maskStats.channels.map((c:any)=>c.sum),
      });
    }

    if (mode === "Reinstate" && maskPngBuffer && stage1AReferencePath) {
      try {
        const userMaskBbox = await maskToNormalizedBbox(maskPngBuffer, meta.width, meta.height);
        const openings = await detectOpeningsFromStage1A(stage1AReferencePath, { jobId, imageId });
        const filteredOpenings = openings.filter((opening) => openingMatchesReinstateTarget(opening, reinstateConfig?.targetType || "auto"));
        const fallbackOpenings = userMaskBbox
          ? openings.filter((opening) => intersectsNormBbox(userMaskBbox, opening.normalizedBbox))
          : [];
        const intersectingOpenings = userMaskBbox
          ? filteredOpenings.filter((opening) => intersectsNormBbox(userMaskBbox, opening.normalizedBbox))
          : [];
        const effectiveIntersectingOpenings = intersectingOpenings.length > 0 ? intersectingOpenings : fallbackOpenings;
        const targetOpening = userMaskBbox ? selectBestOpening(effectiveIntersectingOpenings, userMaskBbox) : null;

        if (targetOpening && targetOpening.confidence >= 0.65) {
          maskPngBuffer = await buildMaskFromOpeningBBox(targetOpening.bbox, meta.width, meta.height, 5);
          if (reinstateConfig) {
            reinstateConfig.geometry = {
              bbox: targetOpening.bbox,
              confidence: targetOpening.confidence,
              openingId: targetOpening.openingId,
            };
          }
          console.log("[Reinstate Geometry]", {
            detectedOpenings: openings.length,
            matched: intersectingOpenings.length,
            fallbackMatched: fallbackOpenings.length,
            usingRefinedMask: true,
            bbox: targetOpening.bbox,
            confidence: targetOpening.confidence,
            openingId: targetOpening.openingId,
          });
        } else {
          console.log("[Reinstate] No reliable opening geometry found, using user mask");
          console.log("[Reinstate Geometry]", {
            detectedOpenings: openings.length,
            matched: intersectingOpenings.length,
            usingRefinedMask: false,
            bbox: userMaskBbox,
          });
        }
      } catch (err) {
        console.warn("[Reinstate] No reliable opening geometry found, using user mask", (err as any)?.message || err);
      }

      console.info("DETECTOR_SKIPPED_REINSTATE", {
        event: "DETECTOR_SKIPPED_REINSTATE",
        jobId,
        imageId,
        mode,
        imagePath: path.basename(baseImagePath),
      });
    }

    if (mode === "Remove" && maskPngBuffer) {
      maskPngBuffer = await refineMaskAgainstDetectedObjects({
        jobId,
        imageId,
        mode,
        baseImagePath,
        maskPngBuffer,
        width: meta.width,
        height: meta.height,
        sceneType,
      });
    }

    const dir = require("path").dirname(baseImagePath);
    const baseName = require("path").basename(baseImagePath, require("path").extname(baseImagePath));
    const outPath = require("path").join(dir, `${baseName}-region-edit.webp`);

    const shouldRouteSecondaryContinuityEdit = editContext?.secondaryContinuity?.enabled === true && normalizedMode !== "reinstate";
    const continuityGroupId = editContext?.secondaryContinuity?.continuityGroupId || editContext?.secondaryContinuity?.roomId || null;
    const normalizedJobId = String(jobId || "unknown-job").trim() || "unknown-job";
    const normalizedImageId = String(imageId || "unknown-image").trim() || "unknown-image";
    const queueName = CONTINUITY_RENDER_QUEUE;
    const workerIdentity = process.env.WORKER_ROLE || "worker";
    const executionAuthority = "main-worker";
    const renderMode = normalizedMode === "add" ? "missing_object_insert" : "localized_repair";
    const provider = String(process.env.SECONDARY_CONTINUITY_PROVIDER || "vertex").trim().toLowerCase();

    if (shouldRouteSecondaryContinuityEdit && (!approvedMasterReferencePath || !maskPngBuffer)) {
      nLog("[CONTINUITY_DISPATCH_FAILURE]", {
        jobId: normalizedJobId,
        imageId: normalizedImageId,
        continuityGroupId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "orchestrator-preflight",
        dispatchTarget: "worker-vertex-experimental",
        provider,
        stage2Mode: null,
        hasApprovedMasterReferencePath: !!approvedMasterReferencePath,
        hasMaskPngBuffer: !!maskPngBuffer,
        error: "secondary_continuity_edit_missing_dispatch_inputs",
      });
      nLog("[CONTINUITY_INLINE_EXECUTION_DETECTED]", {
        jobId: normalizedJobId,
        imageId: normalizedImageId,
        continuityGroupId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "inline-blocked",
        dispatchTarget: "legacy-edit-inline",
        provider,
        stage2Mode: null,
        reason: "secondary_continuity_edit_missing_dispatch_inputs",
      });
      throw new VertexSecondaryContinuityError(
        "Secondary continuity edits must dispatch through the experimental queue and cannot execute inline in the normal worker",
        "secondary_continuity_edit_missing_dispatch_inputs"
      );
    }

    if (shouldRouteSecondaryContinuityEdit && approvedMasterReferencePath && maskPngBuffer) {
      const occupancyConstraintMaskPath = siblingOutPath(outPath, ".vertex-occupancy-constraint", ".png");
      await sharp(maskPngBuffer).png().toFile(occupancyConstraintMaskPath);

      nLog("[CONTINUITY_RENDER_REQUEST]", {
        jobId: normalizedJobId,
        imageId: normalizedImageId,
        continuityGroupId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "orchestrator-request",
        dispatchTarget: "worker-vertex-experimental",
        provider,
        stage2Mode: null,
        mode,
        approvedMasterReferencePath,
        occupancyConstraintMaskPath,
      });

      return await runExperimentalSecondaryContinuity({
        secondaryImagePath: baseImagePath,
        masterImagePath: approvedMasterReferencePath,
        outputPath: outPath,
        roomType: roomType || editContext?.roomType || "unknown",
        stagingStyle: editContext?.stagingStyle,
        continuityGroupId,
        jobId: normalizedJobId,
        imageId: normalizedImageId,
        attempt: 1,
        renderMode,
        occupancyConstraintMaskPath,
        intent: {
          userInstruction: instruction,
          editMode: mode,
          promptScope: "localized_edit",
          operationLabel: "secondary_continuity_edit",
          rendererIsolationMode: "continuity_strict_insertion",
          layoutHints: editContext?.layoutHints,
          anchorConstraints: editContext?.anchorConstraints,
          plannerVersion: process.env.SECONDARY_CONTINUITY_PLANNER || "gemini25pro",
          rendererVersion: process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3",
        },
      });
    }

    // 🔹 Handle "Restore" mode with pixel-level copying (NEVER use Gemini)
    if (mode === "Restore") {
      console.log("[editApply] Restore mode check:", { mode, hasRestorePath: !!restoreFromPath, hasMask: !!maskPngBuffer });

      // Validate required inputs for Restore mode
      if (!restoreFromPath) {
        const errMsg = "Restore mode requires restoreFromPath but none was provided";
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }

      if (!maskPngBuffer) {
        const errMsg = "Restore mode requires a mask but none was provided";
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }

      console.log("[editApply] Restore mode: copying pixels from", restoreFromPath);

      try {
        // Load the restore source image
        const restoreImage = sharp(restoreFromPath);
        const restoreMeta = await restoreImage.metadata();

        // Ensure restore image matches base dimensions
        let restoreBuffer: Buffer;
        if (restoreMeta.width !== meta.width || restoreMeta.height !== meta.height) {
          console.log("[editApply] Resizing restore image to match base");
          restoreBuffer = await restoreImage
            .resize(meta.width!, meta.height!, { fit: "fill" })
            .toBuffer();
        } else {
          restoreBuffer = await restoreImage.toBuffer();
        }

        // Create inverted mask (for keeping non-masked areas from base)
        const invertedMask = await sharp(maskPngBuffer)
          .negate()
          .toBuffer();

        // Composite: base with inverted mask + restore with original mask
        const baseImageBuffer = await sharp(baseImagePath).toBuffer();

        // Step 1: Apply inverted mask to base (keep non-masked areas)
        const maskedBase = await sharp(baseImageBuffer)
          .composite([
            {
              input: invertedMask,
              blend: "dest-in",
            },
          ])
          .toBuffer();

        // Step 2: Apply mask to restore source (get masked areas)
        const maskedRestore = await sharp(restoreBuffer)
          .composite([
            {
              input: maskPngBuffer,
              blend: "dest-in",
            },
          ])
          .toBuffer();

        // Step 3: Combine both (overlay masked restore on top of masked base)
        await sharp(maskedBase)
          .composite([
            {
              input: maskedRestore,
              blend: "over",
            },
          ])
          .webp()
          .toFile(outPath);

        console.log("[editApply] Restore complete (pixel-level), saved to", outPath);
        return outPath;
      } catch (err) {
        // NEVER fall back to Gemini for Restore mode - throw error to notify user
        const errMsg = `Restore operation failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }
    }

    let baselineCompositeBuffer: Buffer | undefined;
    let stage1AReferenceBuffer: Buffer | undefined;
    let approvedMasterReferenceBuffer: Buffer | undefined;
    const useBaselineCompositeMode = normalizedMode === "reinstate" && !!stage1AReferencePath;
    if (normalizedMode === "reinstate" && stage1AReferencePath) {
      try {
        const baselineMeta = await sharp(stage1AReferencePath).metadata().catch(() => null);
        baselineCompositeBuffer = await sharp(stage1AReferencePath)
          .resize(meta.width!, meta.height!, { fit: "fill" })
          .removeAlpha()
          .png()
          .toBuffer();
        stage1AReferenceBuffer = await sharp(stage1AReferencePath).webp().toBuffer();
        console.log("[editApply] Stage 1A baseline loaded for deterministic edit", {
          path: stage1AReferencePath,
          mode,
          originalWidth: baselineMeta?.width,
          originalHeight: baselineMeta?.height,
          targetWidth: meta.width,
          targetHeight: meta.height,
          resized: baselineMeta?.width !== meta.width || baselineMeta?.height !== meta.height,
        });
      } catch (err) {
        console.warn("[editApply] Could not load Stage 1A reference, proceeding without it", err);
      }
    }

    const useSecondaryContinuityEditMode = editContext?.secondaryContinuity?.enabled === true && normalizedMode !== "reinstate";
    if (useSecondaryContinuityEditMode && approvedMasterReferencePath) {
      try {
        const approvedMasterMeta = await sharp(approvedMasterReferencePath).metadata().catch(() => null);
        approvedMasterReferenceBuffer = await sharp(approvedMasterReferencePath).webp().toBuffer();
        console.log("[editApply] SECONDARY_CONTINUITY_EDIT_MODE", {
          jobId,
          imageId,
          mode,
          approvedMasterReferencePath,
          referenceWidth: approvedMasterMeta?.width,
          referenceHeight: approvedMasterMeta?.height,
          continuityGroupId: editContext?.secondaryContinuity?.continuityGroupId || editContext?.secondaryContinuity?.roomId || null,
        });
      } catch (err) {
        console.warn("[editApply] Could not load approved master reference, continuing with prompt-only continuity mode", err);
      }
    }

    // 🔹 For Add/Remove/Replace modes (or if Restore failed), use Gemini unless baseline-driven restore is available
    if (!useBaselineCompositeMode || !baselineCompositeBuffer) {
      console.log("[editApply] Using Gemini for mode:", mode);
    } else {
      console.log("[editApply] Using baseline-driven deterministic composite for mode:", mode);
    }

    const fullSceneReferenceBuffer = await sharp(baseImagePath).webp().toBuffer();
    console.log("[editApply] Images converted to base64 (implicit)");

    const isSemanticAddMode = normalizedMode === "add";
    if (isSemanticAddMode) {
      const placementGuidance = await buildSemanticAddPlacementGuidance(maskPngBuffer!, meta.width, meta.height);
      const semanticAddGuidanceMaskBuffer = await buildSoftGuidanceMask(maskPngBuffer!, meta.width, meta.height);
      const semanticAddPrompt = buildSemanticAddPrompt({
        userIntent: instruction,
        sceneHint: buildStructuredSceneHint({
          sceneType: sceneType || "interior",
          roomType,
          editContext,
        }),
        placementGuidance: placementGuidance || undefined,
      });

      console.log("[editApply] SEMANTIC_ADD_EDIT", {
        jobId,
        imageId,
        mode,
        placementGuidance,
        maskCoverageRatio: Number((await computeMaskCoverageRatio(maskPngBuffer!, meta.width, meta.height)).toFixed(4)),
        guidanceMask: "soft_full_image_guidance",
      });

      const editedBuffer = await regionEditWithGemini({
        prompt: semanticAddPrompt,
        jobId,
        imageId,
        baseImageBuffer: fullSceneReferenceBuffer,
        maskPngBuffer: semanticAddGuidanceMaskBuffer,
        maskMode: "guidance",
        roomType,
        sceneType: sceneType || "interior",
        editMode: mode,
        semanticAddMode: true,
      });

      await sharp(editedBuffer).webp().toFile(outPath);
      console.log("[editApply] Saved semantic add edit to", outPath);
      return outPath;
    }

    const fallbackPrompt = useSecondaryContinuityEditMode
      ? buildSecondaryContinuityEditPrompt({
          userIntent: instruction,
          sceneHint: buildStructuredSceneHint({
            sceneType: sceneType || "interior",
            roomType,
            editContext,
          }),
          editContext,
        })
      : buildEditPrompt({
          mode: normalizedMode,
          userIntent: instruction,
          sceneHint: buildStructuredSceneHint({
            sceneType: sceneType || "interior",
            roomType,
            editContext,
          }),
        });
    const fallbackUserPrompt = useSecondaryContinuityEditMode
      ? fallbackPrompt.user.trim()
      : `${fallbackPrompt.user.trim()}${normalizedMode === "reinstate" && reinstateConfig?.targetType
          ? `\n\nReinstate target: ${String(reinstateConfig.targetType).trim().toLowerCase()}.`
          : ""}${(mode === "Remove" || mode === "Reinstate") && !!stage1AReferenceBuffer
          ? "\n\nReference note: Use any provided Stage 1A reference only to infer original region content or structural surfaces. Do not copy unrelated furniture or redesign the scene."
          : ""}`.trim();
    const fallbackPromptText = composePromptText(fallbackPrompt.system, fallbackUserPrompt);

    console.log("[editApply] EDIT_CONTEXT_LOG", {
      roomType: editContext?.roomType || roomType || null,
      stagingStyle: editContext?.stagingStyle || null,
      layoutHints: (editContext?.layoutHints || []).slice(0, 5),
      anchorConstraints: (editContext?.anchorConstraints || []).slice(0, 5),
    });

    const detectedRegions = await splitMaskIntoRegions(maskPngBuffer!, meta.width, meta.height);
    const targetRegions = assignPromptInstructionsToRegions(instruction, detectedRegions);
    const expandedRegions = await buildExpandedRegions({
      regions: targetRegions,
      imageWidth: meta.width,
      imageHeight: meta.height,
    });
    const useExpandedCrop = expandedRegions.length > 0 && expandedRegions.every((region) => isExpandedCropUsable(region.expandedBox));

    if (useExpandedCrop) {
      try {
        console.log("[editApply] Adaptive region plan", {
          regionCount: expandedRegions.length,
          regions: expandedRegions.map((region, index) => ({
            index,
            bbox: region.bbox,
            expandedBox: region.expandedBox,
            area: region.area,
            expansionFactor: Number(region.expansionFactor.toFixed(3)),
            instruction: region.instruction,
            objectClass: region.objectClass,
            assignmentSource: region.assignmentSource,
          })),
        });
        console.log("[editApply] EDIT_DEBUG: adaptive region count", { regionCount: expandedRegions.length });

        let workingImageBuffer = await sharp(baseImagePath).png().toBuffer();
        const processedExpandedBoxes: PixelBox[] = [];
        const perRegionAllowedMaskPaths: string[] = [];

        const reintegrationDebugEnabled = shouldWriteReintegrationDebug(jobId, imageId);

        for (let regionIndex = 0; regionIndex < expandedRegions.length; regionIndex += 1) {
          const region = expandedRegions[regionIndex]!;
          logMaskAlignment(regionIndex, region.bbox, region.expandedBox);
          const croppedEditableImageBuffer = await sharp(workingImageBuffer)
            .extract({
              left: region.expandedBox.x,
              top: region.expandedBox.y,
              width: region.expandedBox.width,
              height: region.expandedBox.height,
            })
            .webp()
            .toBuffer();
          if (!croppedEditableImageBuffer.length) {
            throw new Error(`Region ${regionIndex + 1} crop buffer is empty`);
          }
          const croppedMaskPngBuffer = await cropMaskToBox(region.maskPngBuffer, region.expandedBox);
          const guidanceMaskPngBuffer = await buildSoftGuidanceMask(
            croppedMaskPngBuffer,
            region.expandedBox.width,
            region.expandedBox.height,
          );
          console.log("[editApply] Processing adaptive region", {
            regionIndex,
            totalRegions: expandedRegions.length,
            expandedBox: region.expandedBox,
            area: region.area,
            expansionFactor: Number(region.expansionFactor.toFixed(3)),
            instruction: region.instruction,
            assignmentSource: region.assignmentSource,
          });
          console.log("[editApply] REGION_AUDIT: crop extracted", {
            regionIndex,
            cropWidth: region.expandedBox.width,
            cropHeight: region.expandedBox.height,
            expandedBox: region.expandedBox,
            geminiInputKind: "editable_crop_only",
          });
          console.log("[editApply] EDIT_DEBUG: region geometry", {
            regionIndex,
            bbox: region.bbox,
            expandedBox: region.expandedBox,
            expansionFactor: Number(region.expansionFactor.toFixed(3)),
          });

          if (useBaselineCompositeMode && baselineCompositeBuffer) {
            workingImageBuffer = await compositeBaselineCrop({
              originalImage: workingImageBuffer,
              baselineImage: baselineCompositeBuffer,
              croppedMaskPngBuffer,
              box: region.expandedBox,
              featherPx: resolveMaskFeatherPx(region.expandedBox),
              mode,
              regionIndex,
            });
            processedExpandedBoxes.push(region.expandedBox);

            const perRegionAllowedMask = await buildFullImageBoxMask(region.expandedBox, meta.width, meta.height);
            const perRegionAllowedMaskPath = regionAllowedMaskArtifactPathForOutput(outPath, regionIndex);
            await sharp(perRegionAllowedMask).png().toFile(perRegionAllowedMaskPath);
            perRegionAllowedMaskPaths.push(perRegionAllowedMaskPath);
            continue;
          }

          const regionPrompt = buildRegionScopedPrompt({
            userInstruction: region.instruction,
            roomType,
            editContext,
            sceneType: sceneType || "interior",
            editMode: mode,
            reinstateConfig,
            hasStage1ABaseline: (mode === "Remove" || mode === "Reinstate") && !!stage1AReferenceBuffer,
            totalRegions: expandedRegions.length,
            regionIndex,
          });
          console.log("[editApply] PROMPT_PREVIEW", {
            regionIndex,
            preview: regionPrompt.promptText.slice(0, 200),
          });

          let exactSizedEditedBuffer: Buffer | null = null;
          let regionEditResult: RegionEditResult | null = null;
          try {
            regionEditResult = await runRegionEditWithRetry({
              prompt: regionPrompt.promptText,
              systemPrompt: regionPrompt.systemPrompt,
              userPrompt: regionPrompt.userPrompt,
              jobId,
              imageId,
              croppedEditableImageBuffer,
              stage1AReferenceBuffer,
              approvedMasterReferenceBuffer,
              guidanceMaskPngBuffer,
              roomType,
              sceneType: sceneType || "interior",
              mode,
              regionIndex,
              totalRegions: expandedRegions.length,
              expandedBox: region.expandedBox,
            });

            exactSizedEditedBuffer = await ensureExactCropSize(regionEditResult.restoredBuffer, region.expandedBox, regionIndex);
          } catch (error) {
            console.warn("[editApply] Skipping region after retry failure", {
              regionIndex,
              totalRegions: expandedRegions.length,
              expandedBox: region.expandedBox,
              reason: getRetryReason(error) || "non_retryable",
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }

          const compositeResult = await compositeExpandedCrop(
            workingImageBuffer,
            exactSizedEditedBuffer,
            croppedMaskPngBuffer,
            region.expandedBox,
            computeExpandedEdgeFeatherPx(region.expandedBox),
          );
          workingImageBuffer = compositeResult.compositedImage;
          processedExpandedBoxes.push(region.expandedBox);

          if (reintegrationDebugEnabled && regionEditResult) {
            const debugDir = reintegrationDebugDirForOutput(outPath, regionIndex);
            await require("fs/promises").mkdir(debugDir, { recursive: true });

            const originalRegionCrop = await sharp(workingImageBuffer)
              .extract({ left: region.bbox.x, top: region.bbox.y, width: region.bbox.width, height: region.bbox.height })
              .png()
              .toBuffer();

            await Promise.all([
              writeReintegrationDebugImage(debugDir, "01-original-full.png", await sharp(baseImagePath).png().toBuffer()),
              writeReintegrationDebugImage(debugDir, "02-original-crop.png", originalRegionCrop),
              writeReintegrationDebugImage(debugDir, "03-expanded-crop.png", croppedEditableImageBuffer),
              writeReintegrationDebugImage(debugDir, "04-padded-inference-image.png", await prepareRegionInferencePayload({
                editableCropBuffer: croppedEditableImageBuffer,
                guidanceMaskBuffer: guidanceMaskPngBuffer,
                box: region.expandedBox,
              }).then((p) => p.transformedImageBuffer)),
              writeReintegrationDebugImage(debugDir, "05-gemini-returned-image.png", regionEditResult.reverseTransform.geminiReturnedBuffer),
              writeReintegrationDebugImage(debugDir, "06-reverse-unpadded-image.png", regionEditResult.reverseTransform.reverseUnpaddedBuffer),
              writeReintegrationDebugImage(debugDir, "07-restored-crop-space-image.png", exactSizedEditedBuffer),
              writeReintegrationDebugImage(debugDir, "08-raw-binary-mask.png", await sharp(compositeResult.debug.rawBinaryMask || Buffer.alloc(region.expandedBox.width * region.expandedBox.height, 0), {
                raw: { width: region.expandedBox.width, height: region.expandedBox.height, channels: 1 },
              }).png().toBuffer()),
              writeReintegrationDebugImage(debugDir, "09-feathered-mask.png", await sharp(compositeResult.debug.featheredMask || Buffer.alloc(region.expandedBox.width * region.expandedBox.height, 0), {
                raw: { width: region.expandedBox.width, height: region.expandedBox.height, channels: 1 },
              }).png().toBuffer()),
              writeReintegrationDebugImage(debugDir, "10-final-alpha-mask.png", await sharp(compositeResult.debug.finalAlphaMask || Buffer.alloc(region.expandedBox.width * region.expandedBox.height, 0), {
                raw: { width: region.expandedBox.width, height: region.expandedBox.height, channels: 1 },
              }).png().toBuffer()),
              writeReintegrationDebugImage(debugDir, "11-composite-preview.png", compositeResult.debug.compositePreview || exactSizedEditedBuffer),
              writeReintegrationDebugImage(debugDir, "12-final-merged-output.png", workingImageBuffer),
            ]);

            await writeReintegrationDebugMetadata(debugDir, {
              regionIndex,
              jobId,
              imageId,
              bbox: region.bbox,
              expandedBox: region.expandedBox,
              transform: regionEditResult.transformMetadata,
              reverseTransform: {
                restorePath: regionEditResult.reverseTransform.restorePath,
                generatedWidth: regionEditResult.reverseTransform.generatedWidth,
                generatedHeight: regionEditResult.reverseTransform.generatedHeight,
              },
              composite: {
                featherPx: computeExpandedEdgeFeatherPx(region.expandedBox),
                changedPixels: compositeResult.debug.changedPixels ?? null,
                compositeOffset: { x: region.expandedBox.x, y: region.expandedBox.y },
              },
            });
          }

          const perRegionAllowedMask = await buildFullImageBoxMask(region.expandedBox, meta.width, meta.height);
          const perRegionAllowedMaskPath = regionAllowedMaskArtifactPathForOutput(outPath, regionIndex);
          await sharp(perRegionAllowedMask).png().toFile(perRegionAllowedMaskPath);
          perRegionAllowedMaskPaths.push(perRegionAllowedMaskPath);
        }

        const effectiveAllowedMask = await buildFullImageBoxesMask(processedExpandedBoxes, meta.width, meta.height);
        const allowedMaskArtifactPath = allowedMaskArtifactPathForOutput(outPath);
        await sharp(effectiveAllowedMask).png().toFile(allowedMaskArtifactPath);
        await sharp(workingImageBuffer).webp().toFile(outPath);
        await writeDebugOverlayArtifact({
          outPath,
          baseImage: workingImageBuffer,
          maskPngBuffer: maskPngBuffer!,
          expandedBoxes: expandedRegions.map((region) => region.expandedBox),
          compositeBoxes: processedExpandedBoxes,
          width: meta.width,
          height: meta.height,
        });

        const maskStats = await sharp(effectiveAllowedMask).stats();
        console.log("[editApply] Enforced mask zones", {
          enforcementMode: expandedRegions.length > 1
            ? "multi_region_expanded_hard_boundary"
            : "expanded_crop_hard_boundary",
          regionCount: expandedRegions.length,
          processedExpandedBoxes,
          allowedPixels: maskStats.channels[0]?.sum ?? 0,
          allowedMaskArtifactPath,
          perRegionAllowedMaskPaths,
        });

        console.log("[editApply] Saved enforced region edit image to", outPath);
        return outPath;
      } catch (err) {
        console.warn("[editApply] Adaptive region pipeline failed, falling back to legacy full-image edit", {
          error: (err as any)?.message || err,
        });
      }
    }

    console.log("[editApply] Expanded crop unavailable, falling back to legacy full-image edit", {
      regionCount: expandedRegions.length,
      regions: expandedRegions.map((region) => ({
        bbox: region.bbox,
        expandedBox: region.expandedBox,
        area: region.area,
      })),
      minDimensionPx: MIN_EXPANDED_EDIT_DIMENSION_PX,
      minAreaPx: MIN_EXPANDED_EDIT_AREA_PX,
    });

    if (useBaselineCompositeMode && baselineCompositeBuffer) {
      console.log("[editApply] BASELINE_COMPOSITE_FULL_IMAGE", {
        mode,
        width: meta.width,
        height: meta.height,
      });

      const fullComposite = await compositeMaskedSourceIntoBase({
        baseImage: baseImagePath,
        sourceImage: baselineCompositeBuffer,
        maskPngBuffer: maskPngBuffer!,
        width: meta.width,
        height: meta.height,
        featherPx: 3,
      });

      const effectiveAllowedMask = await sharp(maskPngBuffer!)
        .removeAlpha()
        .grayscale()
        .threshold(127, { grayscale: true })
        .png()
        .toBuffer();
      const allowedMaskArtifactPath = allowedMaskArtifactPathForOutput(outPath);
      await sharp(effectiveAllowedMask).png().toFile(allowedMaskArtifactPath);
      await sharp(fullComposite).webp().toFile(outPath);

      const maskStats = await sharp(effectiveAllowedMask).stats();
      console.log("[editApply] Saved deterministic baseline edit image to", outPath);
      console.log("[editApply] Enforced mask zones", {
        enforcementMode: "baseline_mask_composite",
        regionCount: expandedRegions.length,
        processedExpandedBoxes: [],
        allowedPixels: maskStats.channels[0]?.sum ?? 0,
        allowedMaskArtifactPath,
        perRegionAllowedMaskPaths: [],
      });
      return outPath;
    }

    const editedBuffer = await regionEditWithGemini({
      prompt: fallbackPromptText,
      systemPrompt: fallbackPrompt.system,
      userPrompt: fallbackUserPrompt,
      jobId,
      imageId,
      baseImageBuffer: fullSceneReferenceBuffer,
      referenceImageBuffer: stage1AReferenceBuffer,
      secondaryContinuityReferenceBuffer: approvedMasterReferenceBuffer,
      maskPngBuffer,
      maskMode: "binary",
      roomType,
      sceneType: sceneType || "interior",
      editMode: mode,
    });

    const effectiveAllowedMask = await sharp(maskPngBuffer!)
      .removeAlpha()
      .grayscale()
      .threshold(127, { grayscale: true })
      .png()
      .toBuffer();
    const allowedMaskArtifactPath = allowedMaskArtifactPathForOutput(outPath);
    await sharp(effectiveAllowedMask).png().toFile(allowedMaskArtifactPath);
    const strictComposite = await compositeStrictMask(
      baseImagePath,
      editedBuffer,
      maskPngBuffer!,
      meta.width,
      meta.height,
    );

    const harmonizedStrictComposite = await harmonizePatchToLocalNeighborhood({
      candidateBuffer: strictComposite,
      referenceBuffer: await sharp(baseImagePath)
        .resize(meta.width!, meta.height!, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .removeAlpha()
        .png()
        .toBuffer(),
      binaryMaskBuffer: maskPngBuffer!,
      width: meta.width,
      height: meta.height,
      context: "full_image_fallback",
    });

    const blendedComposite = await blendMaskEdgeTones(
      harmonizedStrictComposite,
      baseImagePath,
      maskPngBuffer!,
      meta.width!,
      meta.height!,
    );

    await sharp(blendedComposite).webp().toFile(outPath);

    const maskStats = await sharp(effectiveAllowedMask).stats();
    console.log("[editApply] Enforced mask zones", {
      enforcementMode: "strict_inner_only_fallback",
      innerMaskPixels: maskStats.channels[0]?.sum ?? 0,
      allowedMaskArtifactPath,
    });

    // Strict manual edit mode intentionally bypasses anchor validation.

    console.log("[editApply] Saved enforced region edit image to", outPath);
    return outPath;
  }
