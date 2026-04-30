

import sharp from "sharp";
import { regionEditWithGemini } from "../ai/gemini";
import { buildRegionEditPrompt } from "./prompts";
import { toBase64, siblingOutPath, writeImageDataUrl } from "../utils/images";
import { detectOpeningsFromStage1A, type OpeningRegion } from "../utils/openingGeometry";

const MIN_PROJECTION_DILATE_PX = 2;
const MAX_PROJECTION_DILATE_PX = 4;
const EXPANDED_EDIT_PADDING_RATIO = 0.2;
const MIN_EXPANDED_EDIT_DIMENSION_PX = 64;
const MIN_EXPANDED_EDIT_AREA_PX = 4096;
const MIN_EXPANDED_EDGE_FEATHER_PX = 2;
const MAX_EXPANDED_EDGE_FEATHER_PX = 5;

type PixelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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

function projectionDilatePx(width: number, height: number): number {
  const scaled = Math.round(Math.max(width, height) * 0.0025);
  return Math.max(MIN_PROJECTION_DILATE_PX, Math.min(MAX_PROJECTION_DILATE_PX, scaled || 5));
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
  const maskRaw = Buffer.alloc(width * height, 0);
  for (let y = box.y; y < box.y + box.height; y += 1) {
    const rowOffset = y * width;
    for (let x = box.x; x < box.x + box.width; x += 1) {
      maskRaw[rowOffset + x] = 255;
    }
  }

  return sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function computeExpandedEdgeFeatherPx(box: PixelBox): number {
  const scaled = Math.round(Math.max(box.width, box.height) * 0.01);
  return Math.max(MIN_EXPANDED_EDGE_FEATHER_PX, Math.min(MAX_EXPANDED_EDGE_FEATHER_PX, scaled || 0));
}

async function compositeExpandedCrop(
  originalImagePath: string,
  generatedBuffer: Buffer,
  box: PixelBox,
  featherPx: number,
): Promise<Buffer> {
  const alignedGenerated = await sharp(generatedBuffer)
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();

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

  const overlayBuffer = await sharp(alignedGenerated, {
    raw: { width: box.width, height: box.height, channels: 3 },
  })
    .joinChannel(alphaRaw, { raw: { width: box.width, height: box.height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(originalImagePath)
    .composite([{ input: overlayBuffer, left: box.x, top: box.y }])
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
  reinstateConfig?: ReinstateConfig;
  onAnchorValidation?: (result: { passed: boolean; overlapPct: number }) => void;  roomType?: string;
  sceneType?: "interior" | "exterior";}

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
  reinstateConfig,
  onAnchorValidation,
  roomType,
  sceneType,
}: ApplyEditArgs): Promise<string> {
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
        const intersectingOpenings = userMaskBbox
          ? filteredOpenings.filter((opening) => intersectsNormBbox(userMaskBbox, opening.normalizedBbox))
          : [];
        const targetOpening = userMaskBbox ? selectBestOpening(intersectingOpenings, userMaskBbox) : null;

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
    }

    const dir = require("path").dirname(baseImagePath);
    const baseName = require("path").basename(baseImagePath, require("path").extname(baseImagePath));
    const outPath = require("path").join(dir, `${baseName}-region-edit.webp`);

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

    // 🔹 For Add/Remove/Replace modes (or if Restore failed), use Gemini
    console.log("[editApply] Using Gemini for mode:", mode);

    const fullSceneReferenceBuffer = await sharp(baseImagePath).webp().toBuffer();
    console.log("[editApply] Images converted to base64 (implicit)");

    // For Remove mode, load Stage 1A baseline so Gemini can see what's behind the item
    let stage1AReferenceBuffer: Buffer | undefined;
    if ((mode === "Remove" || mode === "Reinstate") && stage1AReferencePath) {
      try {
        stage1AReferenceBuffer = await sharp(stage1AReferencePath).webp().toBuffer();
        console.log("[editApply] Stage 1A baseline loaded for edit reference", {
          path: stage1AReferencePath,
          size: stage1AReferenceBuffer.length,
          mode,
        });
      } catch (err) {
        console.warn("[editApply] Could not load Stage 1A reference, proceeding without it", err);
      }
    }

    const prompt = buildRegionEditPrompt({
      userInstruction: instruction,
      roomType,
      sceneType: sceneType || "interior",
      preserveStructure: true,
      hasStage1ABaseline: (mode === "Remove" || mode === "Reinstate") && !!stage1AReferenceBuffer,
      editMode: mode,
      reinstateConfig,
    });
    const cropPromptSuffix = `

CROPPED REGION EDIT RULES:
- You are editing ONLY the provided cropped region.
- The white center area is the target edit zone.
- The gray surrounding area is an allowed spill zone for realistic object placement.
- You may extend slightly into the gray area when needed for natural edges, shadows, or object placement.
- Do NOT redesign the surrounding environment.
- Do NOT make global changes to the room.`;
    const finalPrompt = `${prompt}${cropPromptSuffix}`;
    console.log("[editApply] Prompt built, length:", finalPrompt.length);

    const maskPixelBBox = await getMaskPixelBBox(maskPngBuffer!, meta.width, meta.height);
    const expandedBox = maskPixelBBox
      ? expandPixelBox(maskPixelBBox, meta.width, meta.height)
      : null;
    const useExpandedCrop = isExpandedCropUsable(expandedBox);

    if (useExpandedCrop) {
      const croppedEditableImageBuffer = await sharp(baseImagePath)
        .extract({ left: expandedBox.x, top: expandedBox.y, width: expandedBox.width, height: expandedBox.height })
        .webp()
        .toBuffer();
      const croppedMaskPngBuffer = await cropMaskToBox(maskPngBuffer!, expandedBox);
      const guidanceMaskPngBuffer = await buildSoftGuidanceMask(croppedMaskPngBuffer, expandedBox.width, expandedBox.height);

      console.log("[editApply] Using expanded crop region", {
        maskPixelBBox,
        expandedBox,
      });

      const editedBuffer = await regionEditWithGemini({
        prompt: finalPrompt,
        jobId,
        imageId,
        baseImageBuffer: croppedEditableImageBuffer,
        fullSceneReferenceBuffer,
        referenceImageBuffer: stage1AReferenceBuffer,
        maskPngBuffer: guidanceMaskPngBuffer,
        maskMode: "guidance",
        roomType,
        sceneType: sceneType || "interior",
        editMode: mode,
      });

      const effectiveAllowedMask = await buildFullImageBoxMask(expandedBox, meta.width, meta.height);
      const allowedMaskArtifactPath = allowedMaskArtifactPathForOutput(outPath);
      await sharp(effectiveAllowedMask).png().toFile(allowedMaskArtifactPath);

      const recomposed = await compositeExpandedCrop(
        baseImagePath,
        editedBuffer,
        expandedBox,
        computeExpandedEdgeFeatherPx(expandedBox),
      );

      await sharp(recomposed).webp().toFile(outPath);

      const maskStats = await sharp(effectiveAllowedMask).stats();
      console.log("[editApply] Enforced mask zones", {
        enforcementMode: "expanded_crop_hard_boundary",
        expandedBox,
        allowedPixels: maskStats.channels[0]?.sum ?? 0,
        allowedMaskArtifactPath,
      });

      console.log("[editApply] Saved enforced region edit image to", outPath);
      return outPath;
    }

    console.log("[editApply] Expanded crop unavailable, falling back to legacy full-image edit", {
      maskPixelBBox,
      expandedBox,
      minDimensionPx: MIN_EXPANDED_EDIT_DIMENSION_PX,
      minAreaPx: MIN_EXPANDED_EDIT_AREA_PX,
    });

    const editedBuffer = await regionEditWithGemini({
      prompt: prompt,
      jobId,
      imageId,
      baseImageBuffer: fullSceneReferenceBuffer,
      referenceImageBuffer: stage1AReferenceBuffer,
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

    const blendedComposite = await blendMaskEdgeTones(
      strictComposite,
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
