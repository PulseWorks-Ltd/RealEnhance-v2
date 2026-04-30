

import sharp from "sharp";
import { type FurnitureDetectionResult, type FurnitureItem } from "../ai/furnitureDetector";
import { regionEditWithGemini } from "../ai/gemini";
import {
  runFurnitureDetectionSafe as runSharedFurnitureDetectionSafe,
  type FurnitureDetectionSceneType,
} from "../ai/runFurnitureDetectionSafe";
import { buildRegionEditPrompt, type EditContext } from "./prompts";
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
}): string {
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

  const prompt = buildRegionEditPrompt({
    userInstruction,
    roomType,
    editContext,
    sceneType,
    preserveStructure: true,
    hasStage1ABaseline,
    editMode,
    reinstateConfig,
  });

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

  return `${prompt}${regionScopeSuffix}${cropPromptSuffix}`;
}

async function runRegionEditWithRetry(params: {
  prompt: string;
  jobId?: string;
  imageId?: string;
  croppedEditableImageBuffer: Buffer;
  stage1AReferenceBuffer?: Buffer;
  guidanceMaskPngBuffer: Buffer;
  roomType?: string;
  sceneType: "interior" | "exterior";
  mode: EditMode;
  regionIndex: number;
  totalRegions: number;
  expandedBox: PixelBox;
}): Promise<Buffer> {
  const {
    prompt,
    jobId,
    imageId,
    croppedEditableImageBuffer,
    stage1AReferenceBuffer,
    guidanceMaskPngBuffer,
    roomType,
    sceneType,
    mode,
    regionIndex,
    totalRegions,
    expandedBox,
  } = params;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_REGION_EDIT_ATTEMPTS; attempt += 1) {
    const isRetry = attempt > 1;
    const attemptPrompt = isRetry
      ? `${prompt}

RETRY INSTRUCTION:
- Retry only region ${regionIndex + 1} of ${totalRegions}.
- ONLY modify this assigned region.
- Do not modify surrounding area.
- Do not introduce additional objects.
- Keep structure unchanged.
- Preserve the existing surrounding composition exactly.
- Do not alter content intended for any other region.`
      : prompt;

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
        jobId,
        imageId,
        baseImageBuffer: croppedEditableImageBuffer,
        referenceImageBuffer: stage1AReferenceBuffer,
        maskPngBuffer: guidanceMaskPngBuffer,
        maskMode: "guidance",
        roomType,
        sceneType,
        editMode: mode,
      });

      return await validateRegionEditResultOrThrow(editedBuffer, regionIndex);
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

  const overlayBuffer = await sharp(alignedGenerated)
    .joinChannel(alphaRaw, { raw: { width: box.width, height: box.height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(originalImagePath)
    .composite([{ input: overlayBuffer, left: box.x, top: box.y }])
    .png()
    .toBuffer();
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
  reinstateConfig,
  onAnchorValidation,
  roomType,
  editContext,
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
    const useBaselineCompositeMode = (mode === "Remove" || mode === "Reinstate") && !!stage1AReferencePath;
    if ((mode === "Remove" || mode === "Reinstate") && stage1AReferencePath) {
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

    // 🔹 For Add/Remove/Replace modes (or if Restore failed), use Gemini unless baseline-driven restore is available
    if (!useBaselineCompositeMode || !baselineCompositeBuffer) {
      console.log("[editApply] Using Gemini for mode:", mode);
    } else {
      console.log("[editApply] Using baseline-driven deterministic composite for mode:", mode);
    }

    const fullSceneReferenceBuffer = await sharp(baseImagePath).webp().toBuffer();
    console.log("[editApply] Images converted to base64 (implicit)");

    const fallbackPrompt = buildRegionEditPrompt({
      userInstruction: instruction,
      roomType,
      editContext,
      sceneType: sceneType || "interior",
      preserveStructure: true,
      hasStage1ABaseline: (mode === "Remove" || mode === "Reinstate") && !!stage1AReferenceBuffer,
      editMode: mode,
      reinstateConfig,
    });

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
            preview: regionPrompt.slice(0, 200),
          });

          let exactSizedEditedBuffer: Buffer | null = null;
          try {
            const editedBuffer = await runRegionEditWithRetry({
              prompt: regionPrompt,
              jobId,
              imageId,
              croppedEditableImageBuffer,
              stage1AReferenceBuffer,
              guidanceMaskPngBuffer,
              roomType,
              sceneType: sceneType || "interior",
              mode,
              regionIndex,
              totalRegions: expandedRegions.length,
              expandedBox: region.expandedBox,
            });

            exactSizedEditedBuffer = await ensureExactCropSize(editedBuffer, region.expandedBox, regionIndex);
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

          workingImageBuffer = await compositeExpandedCrop(
            workingImageBuffer,
            exactSizedEditedBuffer,
            region.expandedBox,
            computeExpandedEdgeFeatherPx(region.expandedBox),
          );
          processedExpandedBoxes.push(region.expandedBox);

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
      prompt: fallbackPrompt,
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
