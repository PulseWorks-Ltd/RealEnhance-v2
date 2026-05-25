import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { runWithSelectedImageModel } from "../ai/runWithImageModelFallback";
import { nLog } from "../logger";
import { toBase64 } from "../utils/images";
import type { NormalizedPoint, PlacementPlan } from "./types";
import { VertexSecondaryContinuityError } from "./types";
import { getVertexGenAiClient } from "../providers/vertex/adc";

type ConnectedComponentStats = {
  id: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
};

type PriorZone = {
  zoneId: string;
  furnitureType: string;
  anchorX: number;
  anchorY: number;
  expectedAreaRatioMin: number;
  expectedAreaRatioTarget: number;
  expectedAreaRatioMax: number;
  priorMask: Buffer;
  priorMaskPngBase64: string;
};

type AttemptFailureMode =
  | "none"
  | "too_sparse"
  | "too_broad"
  | "fragmented"
  | "wall_heavy"
  | "ceiling_heavy"
  | "low_floor_contact"
  | "low_anchor_relevance";

type ZoneAttemptSummary = {
  zoneId: string;
  attempt: number;
  failureMode: AttemptFailureMode;
  score: number;
  occupancyAreaRatio: number;
  connectedComponentCount: number;
  floorContactRatio: number;
  wallTouchRatio: number;
  topRegionRatio: number;
  anchorProximityScore: number;
  selectedThreshold: number;
  selectedInversion: boolean;
};

type GeminiMaskSafetyTelemetry = {
  occupancyAreaRatio: number;
  connectedComponentCount: number;
  floorContactRatio: number;
  anchorProximityScore: number;
  topRegionOccupancyRatio: number;
  wallTouchOccupancyRatio: number;
  boundingAreaRatio: number;
  boundingFillRatio: number;
};

type OccupancyQualityBreakdown = {
  score: number;
  occupancyBandScore: number;
  componentCoherenceScore: number;
  floorContactScore: number;
  anchorScore: number;
  wallPenalty: number;
  topPenalty: number;
  compactnessScore: number;
};

type RoomTypeBandProfile = {
  minAreaRatio: number;
  targetAreaRatio: number;
  maxAreaRatio: number;
  minFloorContactRatio: number;
  maxComponents: number;
  maxTopRegionRatio: number;
  maxWallTouchRatio: number;
};

export type GeminiOccupancyMaskResult = {
  cleanedMaskRaw: Buffer;
  rawMaskPath: string;
  cleanedMaskPath: string;
  componentsPath: string;
  qualityReportPath: string;
  retryComparisonPath: string;
  anchorDistanceHeatmapPath: string;
  floorContactVisualizationPath: string;
  acceptedRejectedOverlayPath: string;
  perObjectMaskPaths: string[];
  usedConservativeFallback: boolean;
  retryCount: number;
  qualityScore: number;
  model: string;
  latencyMs: number;
  safety: GeminiMaskSafetyTelemetry;
};

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRateLimitedError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = String((error as { message?: unknown }).message || error);
  return message.includes("429") || message.includes("RESOURCE_EXHAUSTED") || message.includes("Too Many Requests");
}

async function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function useGeminiOccupancyMaskMode(): boolean {
  return parseBooleanEnv(process.env.CONTINUITY_USE_GEMINI_OCCUPANCY_MASK);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function floorTypeMultiplier(furnitureType: string): number {
  const normalized = furnitureType.toLowerCase();
  if (normalized.includes("bed")) return 1.8;
  if (normalized.includes("couch") || normalized.includes("sofa")) return 1.5;
  if (normalized.includes("rug")) return 1.9;
  if (normalized.includes("table")) return 1.25;
  if (normalized.includes("chair")) return 0.9;
  if (normalized.includes("lamp")) return 0.45;
  return 1;
}

function getRoomTypeBandProfile(roomType: string): RoomTypeBandProfile {
  const normalized = roomType.toLowerCase();
  const defaults: Record<string, RoomTypeBandProfile> = {
    bedroom: {
      minAreaRatio: 0.02,
      targetAreaRatio: 0.09,
      maxAreaRatio: 0.28,
      minFloorContactRatio: 0.6,
      maxComponents: 8,
      maxTopRegionRatio: 0.16,
      maxWallTouchRatio: 0.32,
    },
    living_room: {
      minAreaRatio: 0.03,
      targetAreaRatio: 0.11,
      maxAreaRatio: 0.32,
      minFloorContactRatio: 0.58,
      maxComponents: 10,
      maxTopRegionRatio: 0.18,
      maxWallTouchRatio: 0.36,
    },
    dining_room: {
      minAreaRatio: 0.025,
      targetAreaRatio: 0.1,
      maxAreaRatio: 0.3,
      minFloorContactRatio: 0.57,
      maxComponents: 9,
      maxTopRegionRatio: 0.18,
      maxWallTouchRatio: 0.34,
    },
  };

  const base = defaults[normalized] || {
    minAreaRatio: 0.02,
    targetAreaRatio: 0.1,
    maxAreaRatio: 0.3,
    minFloorContactRatio: 0.55,
    maxComponents: 9,
    maxTopRegionRatio: 0.18,
    maxWallTouchRatio: 0.35,
  };

  const minAreaRatio = readNumberEnv("CONTINUITY_GEMINI_MASK_MIN_AREA_RATIO", base.minAreaRatio);
  const targetAreaRatio = readNumberEnv("CONTINUITY_GEMINI_MASK_TARGET_AREA_RATIO", base.targetAreaRatio);
  const maxAreaRatio = readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_AREA_RATIO", base.maxAreaRatio);
  return {
    minAreaRatio,
    targetAreaRatio,
    maxAreaRatio,
    minFloorContactRatio: readNumberEnv("CONTINUITY_GEMINI_MASK_MIN_FLOOR_CONTACT_RATIO", base.minFloorContactRatio),
    maxComponents: Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_COMPONENTS", base.maxComponents))),
    maxTopRegionRatio: readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_TOP_REGION_RATIO", base.maxTopRegionRatio),
    maxWallTouchRatio: readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_WALL_TOUCH_RATIO", base.maxWallTouchRatio),
  };
}

function polygonPointsAttribute(points: NormalizedPoint[], width: number, height: number): string {
  return points
    .map((point) => {
      const px = Math.max(0, Math.min(width - 1, Math.round(point.x * width)));
      const py = Math.max(0, Math.min(height - 1, Math.round(point.y * height)));
      return `${px},${py}`;
    })
    .join(" ");
}

async function buildFloorPriorMask(plan: PlacementPlan, width: number, height: number): Promise<Buffer> {
  const floorPlane = (plan.structuralTopologyCage?.majorRoomPlanes || []).find((plane) => /floor/i.test(String(plane.planeType || "")));
  if (floorPlane?.polygon?.length && floorPlane.polygon.length >= 3) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#000000" />
        <polygon points="${polygonPointsAttribute(floorPlane.polygon, width, height)}" fill="#ffffff" />
      </svg>
    `;
    return sharp(Buffer.from(svg)).removeAlpha().grayscale().threshold(1, { grayscale: true }).raw().toBuffer();
  }

  const fallback = Buffer.alloc(width * height, 0);
  const startRow = Math.floor(height * 0.6);
  for (let y = startRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fallback[(y * width) + x] = 255;
    }
  }
  return fallback;
}

function getZoneAreaBand(furnitureType: string): { min: number; target: number; max: number } {
  const normalized = furnitureType.toLowerCase();
  if (normalized.includes("bed")) return { min: 0.02, target: 0.065, max: 0.18 };
  if (normalized.includes("rug")) return { min: 0.01, target: 0.04, max: 0.14 };
  if (normalized.includes("sofa") || normalized.includes("couch")) return { min: 0.015, target: 0.05, max: 0.16 };
  if (normalized.includes("table")) return { min: 0.008, target: 0.025, max: 0.09 };
  if (normalized.includes("nightstand") || normalized.includes("bedside")) return { min: 0.004, target: 0.015, max: 0.05 };
  if (normalized.includes("lamp")) return { min: 0.0015, target: 0.005, max: 0.02 };
  return { min: 0.003, target: 0.012, max: 0.06 };
}

async function buildZonePriorMask(params: {
  zone: PlacementPlan["furnitureZones"][number];
  width: number;
  height: number;
  floorMask: Buffer;
}): Promise<Buffer> {
  const bbox = params.zone.normalizedBoundingBox;
  const cx = Math.round((bbox.x + (bbox.width / 2)) * params.width);
  const cy = Math.round((bbox.y + bbox.height) * params.height);
  const rw = Math.max(5, Math.round(params.width * bbox.width * floorTypeMultiplier(params.zone.furnitureType) * 0.5));
  const rh = Math.max(4, Math.round(params.height * bbox.height * 0.22));

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">
      <rect width="100%" height="100%" fill="#000000" />
      <ellipse cx="${cx}" cy="${cy}" rx="${rw}" ry="${rh}" fill="#ffffff" />
    </svg>
  `;

  const raw = await sharp(Buffer.from(svg)).removeAlpha().grayscale().threshold(1, { grayscale: true }).raw().toBuffer();
  const intersected = Buffer.alloc(raw.length, 0);
  for (let i = 0; i < raw.length; i += 1) {
    intersected[i] = raw[i] > 0 && params.floorMask[i] > 0 ? 255 : 0;
  }
  return intersected;
}

function parsePoints(points: NormalizedPoint[] | undefined): NormalizedPoint[] {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }));
}

function estimateFloorY(floorJunctions: NormalizedPoint[], xNorm: number): number {
  if (floorJunctions.length < 2) {
    return 0.72;
  }
  const sorted = [...floorJunctions].sort((a, b) => a.x - b.x);
  if (xNorm <= sorted[0].x) return sorted[0].y;
  if (xNorm >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;
  for (let i = 1; i < sorted.length; i += 1) {
    const left = sorted[i - 1];
    const right = sorted[i];
    if (xNorm < left.x || xNorm > right.x) continue;
    const span = Math.max(1e-6, right.x - left.x);
    const t = (xNorm - left.x) / span;
    return left.y + ((right.y - left.y) * t);
  }
  return sorted[sorted.length - 1].y;
}

function buildPriorZones(plan: PlacementPlan, width: number, height: number, floorMask: Buffer): Promise<PriorZone[]> {
  const floorJunctions = parsePoints(plan.structuralTopologyCage?.floorWallJunctions);
  return Promise.all(plan.furnitureZones.map(async (zone) => {
    const bbox = zone.normalizedBoundingBox;
    const anchorXNorm = clamp01(bbox.x + (bbox.width / 2));
    const floorY = estimateFloorY(floorJunctions, anchorXNorm);
    const anchorYNorm = clamp01(Math.max(bbox.y + (bbox.height * 0.6), floorY));
    const areaBand = getZoneAreaBand(zone.furnitureType);
    const priorMask = await buildZonePriorMask({
      zone,
      width,
      height,
      floorMask,
    });
    const priorMaskPng = await sharp(priorMask, {
      raw: { width, height, channels: 1 },
    }).png().toBuffer();

    return {
      zoneId: zone.id,
      furnitureType: zone.furnitureType,
      anchorX: anchorXNorm * width,
      anchorY: anchorYNorm * height,
      expectedAreaRatioMin: areaBand.min,
      expectedAreaRatioTarget: areaBand.target,
      expectedAreaRatioMax: areaBand.max,
      priorMask,
      priorMaskPngBase64: priorMaskPng.toString("base64"),
    };
  }));
}

function buildAttemptInstruction(failureMode: AttemptFailureMode): string {
  switch (failureMode) {
    case "too_sparse":
      return "Increase occupancy only around clearly visible furniture silhouettes. Avoid tiny fragments. Keep regions continuous.";
    case "too_broad":
      return "Reduce occupancy coverage significantly. Keep mask tightly bounded to furniture only. Preserve room envelope and walls.";
    case "fragmented":
      return "Produce continuous connected occupancy silhouettes per furniture object. Avoid speckle and isolated fragments.";
    case "wall_heavy":
      return "Avoid side-wall masking. Keep occupancy on furniture volumes and floor-contact regions only.";
    case "ceiling_heavy":
      return "Avoid ceiling/top-wall occupancy. Keep occupancy grounded to plausible floor-contact furniture regions.";
    case "low_floor_contact":
      return "Improve floor-contact plausibility for furniture occupancy. Avoid floating mask regions.";
    case "low_anchor_relevance":
      return "Align occupancy near expected furniture anchors and continuity target locations. Remove distant unrelated regions.";
    default:
      return "Generate precise furniture-only occupancy with strict structural preservation.";
  }
}

function buildOccupancyPrompt(plan: PlacementPlan, priorZone: PriorZone, failureMode: AttemptFailureMode): string {
  const zone = plan.furnitureZones.find((item) => item.id === priorZone.zoneId);
  const bbox = zone?.normalizedBoundingBox || { x: 0, y: 0, width: 1, height: 1 };
  const zoneHint = `zone_id=${priorZone.zoneId}; type=${priorZone.furnitureType}; anchor_px=(${Math.round(priorZone.anchorX)},${Math.round(priorZone.anchorY)}); bbox_norm=[x:${bbox.x.toFixed(3)},y:${bbox.y.toFixed(3)},w:${bbox.width.toFixed(3)},h:${bbox.height.toFixed(3)}]; expected_area_band=[min:${priorZone.expectedAreaRatioMin.toFixed(4)},target:${priorZone.expectedAreaRatioTarget.toFixed(4)},max:${priorZone.expectedAreaRatioMax.toFixed(4)}]`;
  return [
    "Generate a binary occupancy mask IMAGE for ONLY the target furniture zone described below.",
    "Output IMAGE ONLY. No text, no JSON.",
    "Mask semantics: WHITE=editable projected furniture occupancy, BLACK=protected.",
    "Hard constraints:",
    "- Include only the specified furniture occupancy, perspective-aware.",
    "- Preserve architecture, envelope, openings, walls, ceiling.",
    "- Do not output giant room-spanning regions.",
    "- Do not infer hidden geometry.",
    "- Keep region localized and silhouette-like.",
    `Target furniture zone: ${zoneHint}`,
    `Room type: ${plan.roomType}`,
    `Stabilization instruction: ${buildAttemptInstruction(failureMode)}`,
  ].join("\n");
}

function findFirstInlineImagePart(parts: any[]): { mimeType: string; data: string } | null {
  for (const part of parts) {
    const inlineData = part?.inlineData;
    if (!inlineData?.data) {
      continue;
    }
    const mimeType = String(inlineData.mimeType || "image/png").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      continue;
    }
    return {
      mimeType,
      data: String(inlineData.data),
    };
  }
  return null;
}

function analyzeConnectedComponents(mask: Buffer, width: number, height: number, minPixels: number): {
  labelMap: Int32Array;
  components: ConnectedComponentStats[];
} {
  const labelMap = new Int32Array(width * height);
  const components: ConnectedComponentStats[] = [];
  let componentId = 0;

  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (mask[startIndex] === 0 || labelMap[startIndex] !== 0) {
        continue;
      }

      componentId += 1;
      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      labelMap[startIndex] = componentId;

      let pixelCount = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let sumX = 0;
      let sumY = 0;

      while (head < tail) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;

        pixelCount += 1;
        sumX += cx;
        sumY += cy;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const index = ny * width + nx;
          if (mask[index] === 0 || labelMap[index] !== 0) {
            continue;
          }
          labelMap[index] = componentId;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      if (pixelCount < minPixels) {
        continue;
      }

      components.push({
        id: componentId,
        pixelCount,
        minX,
        minY,
        maxX,
        maxY,
        centroidX: sumX / Math.max(1, pixelCount),
        centroidY: sumY / Math.max(1, pixelCount),
      });
    }
  }

  return { labelMap, components };
}

function keepAllowedComponents(mask: Buffer, labelMap: Int32Array, allowedIds: Set<number>): Buffer {
  const output = Buffer.alloc(mask.length, 0);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) {
      continue;
    }
    if (allowedIds.has(labelMap[index])) {
      output[index] = 255;
    }
  }
  return output;
}

function countMaskPixels(mask: Buffer): number {
  let count = 0;
  for (const value of mask) {
    if (value > 0) {
      count += 1;
    }
  }
  return count;
}

function computeBoundingBox(mask: Buffer, width: number, height: number): { minX: number; minY: number; maxX: number; maxY: number; pixelCount: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) continue;
      pixelCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (pixelCount === 0 || maxX < minX || maxY < minY) {
    return null;
  }
  return { minX, minY, maxX, maxY, pixelCount };
}

function measureWallTouchRatio(mask: Buffer, width: number, height: number): number {
  const occupancyPixelCount = countMaskPixels(mask);
  if (occupancyPixelCount === 0) {
    return 0;
  }
  const wallBand = Math.max(1, Math.floor(width * 0.06));
  let wallTouchPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= wallBand && x < (width - wallBand)) {
        continue;
      }
      if (mask[(y * width) + x] > 0) {
        wallTouchPixels += 1;
      }
    }
  }
  return wallTouchPixels / occupancyPixelCount;
}

function measureTopRegionRatio(mask: Buffer, width: number, height: number): number {
  const occupancyPixelCount = countMaskPixels(mask);
  if (occupancyPixelCount === 0) {
    return 0;
  }
  const topRows = Math.max(1, Math.floor(height * 0.35));
  let topPixels = 0;
  for (let y = 0; y < topRows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[(y * width) + x] > 0) {
        topPixels += 1;
      }
    }
  }
  return topPixels / occupancyPixelCount;
}

function measureFloorContactRatio(mask: Buffer, floorMask: Buffer): number {
  const occupancyPixelCount = countMaskPixels(mask);
  if (occupancyPixelCount === 0) {
    return 0;
  }
  let floorOverlap = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0 && floorMask[i] > 0) {
      floorOverlap += 1;
    }
  }
  return floorOverlap / occupancyPixelCount;
}

function measureAnchorProximityScore(mask: Buffer, width: number, height: number, anchorX: number, anchorY: number): number {
  const componentData = analyzeConnectedComponents(mask, width, height, 1).components;
  if (componentData.length === 0) {
    return 0;
  }
  const diag = Math.sqrt((width * width) + (height * height));
  let weighted = 0;
  let totalWeight = 0;
  for (const component of componentData) {
    const dx = component.centroidX - anchorX;
    const dy = component.centroidY - anchorY;
    const distance = Math.sqrt((dx * dx) + (dy * dy));
    const normalized = distance / Math.max(1, diag * 0.2);
    const score = Math.exp(-normalized);
    weighted += score * component.pixelCount;
    totalWeight += component.pixelCount;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0;
}

function buildAnchorDistanceHeatmap(width: number, height: number, priorZones: PriorZone[]): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  const sigma = Math.max(1, Math.sqrt((width * width) + (height * height)) * 0.14);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maxWeight = 0;
      for (const zone of priorZones) {
        const dx = x - zone.anchorX;
        const dy = y - zone.anchorY;
        const distSq = (dx * dx) + (dy * dy);
        const weight = Math.exp(-distSq / (2 * sigma * sigma));
        if (weight > maxWeight) {
          maxWeight = weight;
        }
      }
      const idx = (y * width + x) * 4;
      const red = Math.round(255 * maxWeight);
      const blue = Math.round(180 * (1 - maxWeight));
      rgba[idx] = red;
      rgba[idx + 1] = Math.round(64 * maxWeight);
      rgba[idx + 2] = blue;
      rgba[idx + 3] = 180;
    }
  }
  return rgba;
}

function buildFloorContactVisualization(floorMask: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < floorMask.length; i += 1) {
    const offset = i * 4;
    if (floorMask[i] > 0) {
      rgba[offset] = 70;
      rgba[offset + 1] = 130;
      rgba[offset + 2] = 255;
      rgba[offset + 3] = 110;
    } else {
      rgba[offset + 3] = 0;
    }
  }
  return rgba;
}

function buildAcceptedRejectedOverlay(params: {
  acceptedMask: Buffer;
  rejectedMask: Buffer;
  width: number;
  height: number;
}): Buffer {
  const rgba = Buffer.alloc(params.width * params.height * 4, 0);
  for (let i = 0; i < params.acceptedMask.length; i += 1) {
    const offset = i * 4;
    if (params.acceptedMask[i] > 0) {
      rgba[offset] = 72;
      rgba[offset + 1] = 210;
      rgba[offset + 2] = 118;
      rgba[offset + 3] = 120;
      continue;
    }
    if (params.rejectedMask[i] > 0) {
      rgba[offset] = 255;
      rgba[offset + 1] = 84;
      rgba[offset + 2] = 84;
      rgba[offset + 3] = 125;
    }
  }
  return rgba;
}

async function selectBinarizationCandidate(params: {
  grayscaleRaw: Buffer;
  width: number;
  height: number;
  minComponentPixels: number;
  morphologyRadius: number;
  areaTarget: number;
}): Promise<{
  threshold: number;
  inverted: boolean;
  mask: Buffer;
  labelMap: Int32Array;
  components: ConnectedComponentStats[];
} | null> {
  const thresholdBase = Math.max(1, Math.min(254, Math.round(readNumberEnv("CONTINUITY_GEMINI_MASK_THRESHOLD", 170))));
  const thresholdCandidates = Array.from(new Set([thresholdBase, 160, 144, 128, 112, 96, 80, 64]));

  const candidates: Array<{
    threshold: number;
    inverted: boolean;
    mask: Buffer;
    labelMap: Int32Array;
    components: ConnectedComponentStats[];
    areaRatio: number;
  }> = [];

  for (const threshold of thresholdCandidates) {
    for (const inverted of [false, true]) {
      const thresholded = Buffer.alloc(params.grayscaleRaw.length, 0);
      for (let i = 0; i < params.grayscaleRaw.length; i += 1) {
        const lit = params.grayscaleRaw[i] >= threshold;
        const isWhite = inverted ? !lit : lit;
        thresholded[i] = isWhite ? 255 : 0;
      }

      let pipeline = sharp(thresholded, {
        raw: { width: params.width, height: params.height, channels: 1 },
      }).threshold(127, { grayscale: true });

      if (params.morphologyRadius > 0) {
        pipeline = pipeline.erode(params.morphologyRadius).dilate(params.morphologyRadius);
      }

      const candidateMask = await pipeline.raw().toBuffer();
      const analyzed = analyzeConnectedComponents(candidateMask, params.width, params.height, params.minComponentPixels);
      const occupancyPixelCount = countMaskPixels(candidateMask);
      if (occupancyPixelCount === 0) {
        continue;
      }
      candidates.push({
        threshold,
        inverted,
        mask: candidateMask,
        labelMap: analyzed.labelMap,
        components: analyzed.components,
        areaRatio: occupancyPixelCount / (params.width * params.height),
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const selected = [...candidates].sort((a, b) => {
    const da = Math.abs(a.areaRatio - params.areaTarget);
    const db = Math.abs(b.areaRatio - params.areaTarget);
    if (da !== db) return da - db;
    return b.components.length - a.components.length;
  })[0];

  return {
    threshold: selected.threshold,
    inverted: selected.inverted,
    mask: selected.mask,
    labelMap: selected.labelMap,
    components: selected.components,
  };
}

function rankComponents(params: {
  components: ConnectedComponentStats[];
  labelMap: Int32Array;
  candidateMask: Buffer;
  priorZone: PriorZone;
  floorMask: Buffer;
  width: number;
  height: number;
  maxRetainedComponents: number;
}): {
  acceptedMask: Buffer;
  rejectedMask: Buffer;
  acceptedCount: number;
  anchorScore: number;
  floorContactRatio: number;
  compactnessScore: number;
} {
  const scored = params.components.map((component) => {
    const bboxArea = Math.max(1, (component.maxX - component.minX + 1) * (component.maxY - component.minY + 1));
    const compactness = component.pixelCount / bboxArea;
    const dx = component.centroidX - params.priorZone.anchorX;
    const dy = component.centroidY - params.priorZone.anchorY;
    const dist = Math.sqrt((dx * dx) + (dy * dy));
    const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
    const anchorScore = Math.exp(-(dist / Math.max(1, diag * 0.2)));

    let priorOverlap = 0;
    let floorOverlap = 0;
    let wallTouch = 0;
    const wallBand = Math.max(1, Math.floor(params.width * 0.06));
    for (let y = component.minY; y <= component.maxY; y += 1) {
      for (let x = component.minX; x <= component.maxX; x += 1) {
        const idx = y * params.width + x;
        if (params.labelMap[idx] !== component.id || params.candidateMask[idx] === 0) {
          continue;
        }
        if (params.priorZone.priorMask[idx] > 0) {
          priorOverlap += 1;
        }
        if (params.floorMask[idx] > 0) {
          floorOverlap += 1;
        }
        if (x < wallBand || x >= (params.width - wallBand)) {
          wallTouch += 1;
        }
      }
    }

    const priorOverlapRatio = priorOverlap / Math.max(1, component.pixelCount);
    const floorOverlapRatio = floorOverlap / Math.max(1, component.pixelCount);
    const wallTouchRatio = wallTouch / Math.max(1, component.pixelCount);

    const score =
      (anchorScore * 0.34)
      + (priorOverlapRatio * 0.26)
      + (floorOverlapRatio * 0.2)
      + (compactness * 0.16)
      - (wallTouchRatio * 0.22);

    return {
      component,
      score,
      anchorScore,
      floorOverlapRatio,
      compactness,
      wallTouchRatio,
    };
  }).sort((left, right) => right.score - left.score);

  const accepted = scored.slice(0, params.maxRetainedComponents).filter((entry) => entry.score > 0.18);
  const acceptedIds = new Set(accepted.map((entry) => entry.component.id));

  const acceptedMask = keepAllowedComponents(params.candidateMask, params.labelMap, acceptedIds);
  const rejectedMask = Buffer.alloc(params.candidateMask.length, 0);
  for (let i = 0; i < params.candidateMask.length; i += 1) {
    if (params.candidateMask[i] === 0) continue;
    if (!acceptedIds.has(params.labelMap[i])) {
      rejectedMask[i] = 255;
    }
  }

  const anchorScore = accepted.length
    ? accepted.reduce((sum, entry) => sum + entry.anchorScore, 0) / accepted.length
    : 0;
  const floorContactRatio = measureFloorContactRatio(acceptedMask, params.floorMask);
  const compactnessScore = accepted.length
    ? accepted.reduce((sum, entry) => sum + entry.compactness, 0) / accepted.length
    : 0;

  return {
    acceptedMask,
    rejectedMask,
    acceptedCount: accepted.length,
    anchorScore,
    floorContactRatio,
    compactnessScore,
  };
}

function classifyFailureMode(params: {
  occupancyAreaRatio: number;
  profile: RoomTypeBandProfile;
  connectedCount: number;
  wallTouchRatio: number;
  topRegionRatio: number;
  floorContactRatio: number;
  anchorScore: number;
}): AttemptFailureMode {
  if (params.occupancyAreaRatio < params.profile.minAreaRatio) return "too_sparse";
  if (params.occupancyAreaRatio > params.profile.maxAreaRatio) return "too_broad";
  if (params.connectedCount > params.profile.maxComponents) return "fragmented";
  if (params.topRegionRatio > params.profile.maxTopRegionRatio) return "ceiling_heavy";
  if (params.wallTouchRatio > params.profile.maxWallTouchRatio) return "wall_heavy";
  if (params.floorContactRatio < params.profile.minFloorContactRatio) return "low_floor_contact";
  if (params.anchorScore < 0.35) return "low_anchor_relevance";
  return "none";
}

function evaluateQuality(params: {
  occupancyAreaRatio: number;
  connectedCount: number;
  floorContactRatio: number;
  anchorScore: number;
  wallTouchRatio: number;
  topRegionRatio: number;
  compactnessScore: number;
  profile: RoomTypeBandProfile;
}): OccupancyQualityBreakdown {
  const occupancyBandDistance = Math.abs(params.occupancyAreaRatio - params.profile.targetAreaRatio) / Math.max(0.001, params.profile.targetAreaRatio);
  const occupancyBandScore = Math.max(0, 1 - occupancyBandDistance);
  const componentCoherenceScore = Math.max(0, 1 - ((params.connectedCount - 1) / Math.max(1, params.profile.maxComponents - 1)));
  const floorContactScore = Math.max(0, Math.min(1, params.floorContactRatio / Math.max(0.01, params.profile.minFloorContactRatio)));
  const anchorScore = Math.max(0, Math.min(1, params.anchorScore));
  const wallPenalty = Math.max(0, (params.wallTouchRatio - params.profile.maxWallTouchRatio) * 2.2);
  const topPenalty = Math.max(0, (params.topRegionRatio - params.profile.maxTopRegionRatio) * 2.2);
  const compactnessScore = Math.max(0, Math.min(1, params.compactnessScore));

  const score = Math.max(0,
    (occupancyBandScore * 0.22)
    + (componentCoherenceScore * 0.2)
    + (floorContactScore * 0.2)
    + (anchorScore * 0.2)
    + (compactnessScore * 0.18)
    - (wallPenalty * 0.1)
    - (topPenalty * 0.1)
  );

  return {
    score,
    occupancyBandScore,
    componentCoherenceScore,
    floorContactScore,
    anchorScore,
    wallPenalty,
    topPenalty,
    compactnessScore,
  };
}

function safeMaskUnion(baseMask: Buffer, addMask: Buffer): Buffer {
  const output = Buffer.from(baseMask);
  for (let i = 0; i < output.length; i += 1) {
    if (addMask[i] > 0) {
      output[i] = 255;
    }
  }
  return output;
}

function buildConservativeFallbackMask(priorZones: PriorZone[], floorMask: Buffer, width: number, height: number): Buffer {
  const output = Buffer.alloc(width * height, 0);
  for (const zone of priorZones) {
    const radius = Math.max(6, Math.round(Math.sqrt(width * height * zone.expectedAreaRatioTarget) * 0.18));
    const cx = Math.round(zone.anchorX);
    const cy = Math.round(zone.anchorY);
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if ((dx * dx) + (dy * dy) > radius * radius) {
          continue;
        }
        const idx = y * width + x;
        if (floorMask[idx] > 0) {
          output[idx] = 255;
        }
      }
    }
  }
  return output;
}

function ensureSafetyOrThrow(params: {
  mask: Buffer;
  width: number;
  height: number;
  profile: RoomTypeBandProfile;
  floorMask: Buffer;
  anchorScore: number;
  compactnessScore: number;
  continuityGroupId?: string | null;
  imageId: string;
  jobId: string;
}): { safety: GeminiMaskSafetyTelemetry; quality: OccupancyQualityBreakdown } {
  const occupancyPixelCount = countMaskPixels(params.mask);
  const totalPixelCount = params.width * params.height;
  const occupancyAreaRatio = occupancyPixelCount / totalPixelCount;
  const connected = analyzeConnectedComponents(params.mask, params.width, params.height, 1).components;
  const connectedComponentCount = connected.length;
  const floorContactRatio = measureFloorContactRatio(params.mask, params.floorMask);
  const wallTouchOccupancyRatio = measureWallTouchRatio(params.mask, params.width, params.height);
  const topRegionOccupancyRatio = measureTopRegionRatio(params.mask, params.width, params.height);

  const bounding = computeBoundingBox(params.mask, params.width, params.height);
  const boundingArea = bounding ? Math.max(1, (bounding.maxX - bounding.minX + 1) * (bounding.maxY - bounding.minY + 1)) : 0;
  const boundingAreaRatio = bounding ? boundingArea / totalPixelCount : 0;
  const boundingFillRatio = bounding ? occupancyPixelCount / boundingArea : 0;

  const safety: GeminiMaskSafetyTelemetry = {
    occupancyAreaRatio,
    connectedComponentCount,
    floorContactRatio,
    anchorProximityScore: params.anchorScore,
    topRegionOccupancyRatio,
    wallTouchOccupancyRatio,
    boundingAreaRatio,
    boundingFillRatio,
  };

  const quality = evaluateQuality({
    occupancyAreaRatio,
    connectedCount: connectedComponentCount,
    floorContactRatio,
    anchorScore: params.anchorScore,
    wallTouchRatio: wallTouchOccupancyRatio,
    topRegionRatio: topRegionOccupancyRatio,
    compactnessScore: params.compactnessScore,
    profile: params.profile,
  });

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_SAFETY]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    ...Object.fromEntries(Object.entries(safety).map(([k, v]) => [k, Number(v.toFixed(4))])),
    qualityScore: Number(quality.score.toFixed(4)),
  });

  if (occupancyPixelCount === 0) {
    throw new VertexSecondaryContinuityError("Gemini occupancy mask is empty after cleanup", "gemini_occupancy_mask_empty");
  }
  if (occupancyAreaRatio < params.profile.minAreaRatio) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask area too sparse (${occupancyAreaRatio.toFixed(3)} < ${params.profile.minAreaRatio.toFixed(3)})`,
      "gemini_occupancy_mask_area_too_sparse"
    );
  }
  if (occupancyAreaRatio > params.profile.maxAreaRatio) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask area too large (${occupancyAreaRatio.toFixed(3)} > ${params.profile.maxAreaRatio.toFixed(3)})`,
      "gemini_occupancy_mask_area_exceeded"
    );
  }
  if (connectedComponentCount > params.profile.maxComponents) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask has too many disconnected regions (${connectedComponentCount} > ${params.profile.maxComponents})`,
      "gemini_occupancy_mask_components_exceeded"
    );
  }
  if (floorContactRatio < params.profile.minFloorContactRatio) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask has insufficient floor contact (${floorContactRatio.toFixed(3)} < ${params.profile.minFloorContactRatio.toFixed(3)})`,
      "gemini_occupancy_mask_floor_contact_low"
    );
  }
  if (topRegionOccupancyRatio > params.profile.maxTopRegionRatio) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask touches excessive ceiling/wall-top area (${topRegionOccupancyRatio.toFixed(3)} > ${params.profile.maxTopRegionRatio.toFixed(3)})`,
      "gemini_occupancy_mask_top_region_exceeded"
    );
  }
  if (wallTouchOccupancyRatio > params.profile.maxWallTouchRatio) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask touches excessive side-wall area (${wallTouchOccupancyRatio.toFixed(3)} > ${params.profile.maxWallTouchRatio.toFixed(3)})`,
      "gemini_occupancy_mask_wall_touch_exceeded"
    );
  }
  if (params.anchorScore < 0.28) {
    throw new VertexSecondaryContinuityError(
      `Gemini occupancy mask has low anchor relevance (${params.anchorScore.toFixed(3)} < 0.280)`,
      "gemini_occupancy_mask_anchor_relevance_low"
    );
  }

  return { safety, quality };
}

async function writeMaskPng(mask: Buffer, width: number, height: number, outputPath: string): Promise<void> {
  await sharp(mask, {
    raw: { width, height, channels: 1 },
  }).png().toFile(outputPath);
}

async function writeOverlayImage(baseImagePath: string, rgba: Buffer, width: number, height: number, outputPath: string): Promise<void> {
  await sharp(baseImagePath)
    .composite([
      {
        input: rgba,
        raw: { width, height, channels: 4 },
        blend: "over",
      },
    ])
    .png()
    .toFile(outputPath);
}

export async function generateGeminiOccupancyMask(params: {
  secondaryImagePath: string;
  masterImagePath: string;
  plan: PlacementPlan;
  occupancyMaskPath: string;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
}): Promise<GeminiOccupancyMaskResult> {
  const startedAt = Date.now();
  const model = String(process.env.CONTINUITY_GEMINI_OCCUPANCY_MODEL || "gemini-2.5-flash-image").trim();
  const minComponentPixels = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MIN_COMPONENT_PIXELS", 120)));
  const morphologyRadius = Math.max(0, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MORPH_RADIUS", 1)));
  const maxRetainedComponents = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_RETAINED_COMPONENTS", 6)));
  const maxAttempts = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_RETRIES", 3)));

  const metadata = await sharp(params.secondaryImagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for Gemini occupancy generation",
      "gemini_occupancy_mask_missing_dimensions"
    );
  }

  const profile = getRoomTypeBandProfile(params.plan.roomType);
  const floorMask = await buildFloorPriorMask(params.plan, width, height);
  const priorZones = await buildPriorZones(params.plan, width, height, floorMask);

  const outDir = path.dirname(params.occupancyMaskPath);
  const rawMaskPath = path.join(outDir, "gemini-occupancy-mask-raw.png");
  const cleanedMaskPath = path.join(outDir, "gemini-occupancy-mask-cleaned.png");
  const componentsPath = path.join(outDir, "occupancy-mask-components.png");
  const qualityReportPath = path.join(outDir, "occupancy-quality-report.json");
  const retryComparisonPath = path.join(outDir, "occupancy-retry-comparison.json");
  const anchorDistanceHeatmapPath = path.join(outDir, "anchor-distance-heatmap.png");
  const floorContactVisualizationPath = path.join(outDir, "floor-contact-visualization.png");
  const acceptedRejectedOverlayPath = path.join(outDir, "accepted-vs-rejected-components.png");
  const perObjectDir = path.join(outDir, "per-object-masks");
  await fs.mkdir(perObjectDir, { recursive: true });

  const secondaryImage = toBase64(params.secondaryImagePath);
  const masterImage = toBase64(params.masterImagePath);

  const ai = getVertexGenAiClient();

  const zoneSummaries: ZoneAttemptSummary[] = [];
  const perObjectMaskPaths: string[] = [];
  let unionAccepted = Buffer.alloc(width * height, 0);
  let unionRejected = Buffer.alloc(width * height, 0);
  let unionRawBest = Buffer.alloc(width * height, 0);

  let lastFailureMode: AttemptFailureMode = "none";
  for (const priorZone of priorZones) {
    let bestZoneMask: Buffer = Buffer.alloc(width * height, 0);
    let bestZoneRawMask: Buffer = Buffer.alloc(width * height, 0);
    let bestZoneScore = -1;
    let bestZoneThreshold = 170;
    let bestZoneInversion = false;
    let zoneRateLimitFailures = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = buildOccupancyPrompt(params.plan, priorZone, lastFailureMode);
      let run: Awaited<ReturnType<typeof runWithSelectedImageModel>>;
      try {
        run = await runWithSelectedImageModel({
          stageLabel: "2",
          ai: ai as any,
          model,
          baseRequest: {
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  { text: "TARGET_ZONE_PRIOR" },
                  { inlineData: { mimeType: "image/png", data: priorZone.priorMaskPngBase64 } },
                  { text: "APPROVED_MASTER_STAGED_IMAGE" },
                  { inlineData: { mimeType: masterImage.mime, data: masterImage.data } },
                  { text: "SECONDARY_TARGET_IMAGE" },
                  { inlineData: { mimeType: secondaryImage.mime, data: secondaryImage.data } },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              topP: 0.1,
              candidateCount: 1,
            },
          } as any,
          context: "continuity_gemini_occupancy_mask_zone",
          meta: {
            jobId: params.jobId,
            imageId: params.imageId,
            stage: "2",
            attempt,
            reason: `continuity_occupancy_mask_zone_${priorZone.zoneId}`,
            callType: "image_generation",
          },
        });
      } catch (error) {
        if (!isRateLimitedError(error)) {
          throw error;
        }

        zoneRateLimitFailures += 1;
        nLog("[VERTEX_CONTINUITY_GEMINI_ZONE_RETRY]", {
          continuityGroupId: params.continuityGroupId || null,
          imageId: params.imageId,
          jobId: params.jobId,
          zoneId: priorZone.zoneId,
          attempt,
          reason: "rate_limited",
          error: String((error as { message?: unknown }).message || error),
        });

        zoneSummaries.push({
          zoneId: priorZone.zoneId,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        lastFailureMode = "too_sparse";
        await waitMs(Math.min(2500, 400 * attempt));
        continue;
      }

      const parts: any[] = (run.resp as any)?.candidates?.[0]?.content?.parts || [];
      const imagePart = findFirstInlineImagePart(parts);
      if (!imagePart) {
        zoneSummaries.push({
          zoneId: priorZone.zoneId,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        lastFailureMode = "too_sparse";
        continue;
      }

      const rawBuffer = Buffer.from(imagePart.data, "base64");
      const gray = await sharp(rawBuffer)
        .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
        .removeAlpha()
        .grayscale()
        .raw()
        .toBuffer();

      const selected = await selectBinarizationCandidate({
        grayscaleRaw: gray,
        width,
        height,
        minComponentPixels,
        morphologyRadius,
        areaTarget: priorZone.expectedAreaRatioTarget,
      });

      if (!selected) {
        zoneSummaries.push({
          zoneId: priorZone.zoneId,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        lastFailureMode = "too_sparse";
        continue;
      }

      const ranked = rankComponents({
        components: selected.components,
        labelMap: selected.labelMap,
        candidateMask: selected.mask,
        priorZone,
        floorMask,
        width,
        height,
        maxRetainedComponents,
      });

      const zoneMask = Buffer.from(ranked.acceptedMask);
      const occupancyAreaRatio = countMaskPixels(zoneMask) / (width * height);
      const connected = analyzeConnectedComponents(zoneMask, width, height, 1).components.length;
      const wallTouchRatio = measureWallTouchRatio(zoneMask, width, height);
      const topRegionRatio = measureTopRegionRatio(zoneMask, width, height);
      const floorContactRatio = ranked.floorContactRatio;
      const anchorScore = ranked.anchorScore;

      const failureMode = classifyFailureMode({
        occupancyAreaRatio,
        profile: {
          ...profile,
          minAreaRatio: priorZone.expectedAreaRatioMin,
          targetAreaRatio: priorZone.expectedAreaRatioTarget,
          maxAreaRatio: priorZone.expectedAreaRatioMax,
        },
        connectedCount: connected,
        wallTouchRatio,
        topRegionRatio,
        floorContactRatio,
        anchorScore,
      });

      const quality = evaluateQuality({
        occupancyAreaRatio,
        connectedCount: connected,
        floorContactRatio,
        anchorScore,
        wallTouchRatio,
        topRegionRatio,
        compactnessScore: ranked.compactnessScore,
        profile: {
          ...profile,
          minAreaRatio: priorZone.expectedAreaRatioMin,
          targetAreaRatio: priorZone.expectedAreaRatioTarget,
          maxAreaRatio: priorZone.expectedAreaRatioMax,
        },
      });

      zoneSummaries.push({
        zoneId: priorZone.zoneId,
        attempt,
        failureMode,
        score: quality.score,
        occupancyAreaRatio,
        connectedComponentCount: connected,
        floorContactRatio,
        wallTouchRatio,
        topRegionRatio,
        anchorProximityScore: anchorScore,
        selectedThreshold: selected.threshold,
        selectedInversion: selected.inverted,
      });

      if (quality.score > bestZoneScore) {
        bestZoneScore = quality.score;
        bestZoneMask = Buffer.from(zoneMask);
        bestZoneRawMask = Buffer.from(selected.mask);
        bestZoneThreshold = selected.threshold;
        bestZoneInversion = selected.inverted;
      }

      if (failureMode === "none") {
        break;
      }
      lastFailureMode = failureMode;
    }

    if (bestZoneScore < 0) {
      // If all attempts failed (including rate limits), keep a conservative per-zone prior projection.
      bestZoneMask = buildConservativeFallbackMask([priorZone], floorMask, width, height);
      bestZoneRawMask = Buffer.from(bestZoneMask);
      bestZoneScore = 0;
      bestZoneThreshold = 0;
      bestZoneInversion = false;
      nLog("[VERTEX_CONTINUITY_GEMINI_ZONE_FALLBACK]", {
        continuityGroupId: params.continuityGroupId || null,
        imageId: params.imageId,
        jobId: params.jobId,
        zoneId: priorZone.zoneId,
        rateLimitFailures: zoneRateLimitFailures,
      });
    }

    unionAccepted = Buffer.from(safeMaskUnion(unionAccepted, bestZoneMask));
    unionRawBest = Buffer.from(safeMaskUnion(unionRawBest, bestZoneRawMask));

    const rejectedForZone = Buffer.alloc(bestZoneRawMask.length, 0);
    for (let i = 0; i < bestZoneRawMask.length; i += 1) {
      if (bestZoneRawMask[i] > 0 && bestZoneMask[i] === 0) {
        rejectedForZone[i] = 255;
      }
    }
    unionRejected = Buffer.from(safeMaskUnion(unionRejected, rejectedForZone));

    const perObjectMaskPath = path.join(perObjectDir, `${priorZone.zoneId}-gemini-mask.png`);
    await writeMaskPng(bestZoneMask, width, height, perObjectMaskPath);
    perObjectMaskPaths.push(perObjectMaskPath);

    nLog("[VERTEX_CONTINUITY_GEMINI_ZONE_MASK]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      zoneId: priorZone.zoneId,
      score: Number(bestZoneScore.toFixed(4)),
      selectedThreshold: bestZoneThreshold,
      selectedInversion: bestZoneInversion,
    });
  }

  let usedConservativeFallback = false;
  if (countMaskPixels(unionAccepted) === 0) {
    unionAccepted = Buffer.from(buildConservativeFallbackMask(priorZones, floorMask, width, height));
    usedConservativeFallback = true;
  }

  const anchorProximityScore = priorZones.length > 0
    ? priorZones.reduce((sum, zone) => sum + measureAnchorProximityScore(unionAccepted, width, height, zone.anchorX, zone.anchorY), 0) / priorZones.length
    : 0;

  const compactness = (() => {
    const bbox = computeBoundingBox(unionAccepted, width, height);
    if (!bbox) return 0;
    const area = Math.max(1, (bbox.maxX - bbox.minX + 1) * (bbox.maxY - bbox.minY + 1));
    return bbox.pixelCount / area;
  })();

  const evaluated = ensureSafetyOrThrow({
    mask: unionAccepted,
    width,
    height,
    profile,
    floorMask,
    anchorScore: anchorProximityScore,
    compactnessScore: compactness,
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
  });

  await writeMaskPng(unionRawBest, width, height, rawMaskPath);
  await writeMaskPng(unionAccepted, width, height, cleanedMaskPath);

  const components = analyzeConnectedComponents(unionAccepted, width, height, 1);
  const componentRgba = Buffer.alloc(width * height * 4, 0);
  const colorById = new Map<number, [number, number, number]>();
  for (const comp of components.components) {
    const seed = comp.id * 1103515245;
    colorById.set(comp.id, [
      60 + ((seed >>> 3) % 170),
      60 + ((seed >>> 11) % 170),
      60 + ((seed >>> 19) % 170),
    ]);
  }
  for (let i = 0; i < components.labelMap.length; i += 1) {
    const id = components.labelMap[i];
    const offset = i * 4;
    if (id === 0 || !colorById.has(id)) {
      componentRgba[offset + 3] = 255;
      continue;
    }
    const [r, g, b] = colorById.get(id)!;
    componentRgba[offset] = r;
    componentRgba[offset + 1] = g;
    componentRgba[offset + 2] = b;
    componentRgba[offset + 3] = 255;
  }
  await sharp(componentRgba, {
    raw: { width, height, channels: 4 },
  }).png().toFile(componentsPath);

  const heatmap = buildAnchorDistanceHeatmap(width, height, priorZones);
  await writeOverlayImage(params.secondaryImagePath, heatmap, width, height, anchorDistanceHeatmapPath);

  const floorViz = buildFloorContactVisualization(floorMask, width, height);
  await writeOverlayImage(params.secondaryImagePath, floorViz, width, height, floorContactVisualizationPath);

  const acceptedRejected = buildAcceptedRejectedOverlay({
    acceptedMask: unionAccepted,
    rejectedMask: unionRejected,
    width,
    height,
  });
  await writeOverlayImage(params.secondaryImagePath, acceptedRejected, width, height, acceptedRejectedOverlayPath);

  const qualityPayload = {
    roomTypeProfile: profile,
    safety: evaluated.safety,
    quality: evaluated.quality,
    usedConservativeFallback,
    priorZoneCount: priorZones.length,
    perObjectMaskPaths,
  };
  await fs.writeFile(qualityReportPath, JSON.stringify(qualityPayload, null, 2));
  await fs.writeFile(retryComparisonPath, JSON.stringify(zoneSummaries, null, 2));

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK]", {
    phase: "complete",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    model,
    latencyMs: Date.now() - startedAt,
    rawMaskPath,
    cleanedMaskPath,
    componentsPath,
    qualityScore: Number(evaluated.quality.score.toFixed(4)),
    retryCount: zoneSummaries.length,
    usedConservativeFallback,
  });

  return {
    cleanedMaskRaw: unionAccepted,
    rawMaskPath,
    cleanedMaskPath,
    componentsPath,
    qualityReportPath,
    retryComparisonPath,
    anchorDistanceHeatmapPath,
    floorContactVisualizationPath,
    acceptedRejectedOverlayPath,
    perObjectMaskPaths,
    usedConservativeFallback,
    retryCount: zoneSummaries.length,
    qualityScore: evaluated.quality.score,
    model,
    latencyMs: Date.now() - startedAt,
    safety: evaluated.safety,
  };
}
