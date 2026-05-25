import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { runWithSelectedImageModel } from "../ai/runWithImageModelFallback";
import { nLog } from "../logger";
import { toBase64 } from "../utils/images";
import type { NormalizedPoint, PlacementPlan } from "./types";
import { VertexSecondaryContinuityError } from "./types";
import { getVertexGenAiClient } from "../providers/vertex/adc";
import { resolveDeterministicZoneProjection } from "./deterministicProjection";

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

type OccupancyStageKey =
  | "raw_gemini_mask"
  | "alpha_normalized_mask"
  | "thresholded_mask"
  | "morphology_cleaned_mask"
  | "component_filtered_mask"
  | "accepted_cluster_mask"
  | "merged_union_mask"
  | "final_safety_mask";

type OccupancyStageMetric = {
  clusterId: string;
  clusterRole: "required" | "optional";
  stage: OccupancyStageKey;
  occupancyPixels: number;
  occupancyAreaRatio: number;
  componentCount: number;
  rejectedReason: string | null;
  includedInFinalUnion?: boolean;
};

type ComponentDecision = {
  componentId: number;
  pixelCount: number;
  areaRatio: number;
  score: number;
  accepted: boolean;
  rejectedReason: string | null;
  anchorScore: number;
  priorOverlapRatio: number;
  floorOverlapRatio: number;
  constraintOverlapRatio: number;
  compactness: number;
  wallTouchRatio: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
};

type RankedComponentResult = {
  acceptedMask: Buffer;
  rejectedMask: Buffer;
  acceptedCount: number;
  anchorScore: number;
  floorContactRatio: number;
  constraintAffinityScore: number;
  compactnessScore: number;
  decisions: ComponentDecision[];
};

type ClusterContributionSummary = {
  clusterId: string;
  role: "required" | "optional";
  contributionRatio: number;
  includedInFinalUnion: boolean;
  acceptedOccupancyRatio: number;
  mergedUnionRatioAfterCluster: number;
};

type AdaptiveOccupancyExpectation = {
  effectiveMinAreaRatio: number;
  requiredTargetAreaRatio: number;
  optionalTargetAreaRatio: number;
  optionalWeight: number;
};

type PriorCluster = {
  clusterId: string;
  clusterLabel: string;
  required: boolean;
  zoneIds: string[];
  furnitureTypes: string[];
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
  | "low_anchor_relevance"
  | "low_constraint_affinity";

type ClusterAttemptSummary = {
  clusterId: string;
  required: boolean;
  clusterLabel: string;
  attempt: number;
  failureMode: AttemptFailureMode;
  score: number;
  occupancyAreaRatio: number;
  connectedComponentCount: number;
  floorContactRatio: number;
  wallTouchRatio: number;
  topRegionRatio: number;
  anchorProximityScore: number;
  constraintAffinityScore: number;
  selectedThreshold: number;
  selectedInversion: boolean;
};

type GeminiMaskSafetyTelemetry = {
  occupancyAreaRatio: number;
  connectedComponentCount: number;
  floorContactRatio: number;
  anchorProximityScore: number;
  constraintAffinityScore: number;
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

type GeometryAdaptiveRecoveryProfile = {
  projectionAreaRatio: number;
  projectionCompactness: number;
  floorGuideConfidence: number;
  requiredClusterDensity: number;
  areaRecoveryMaxGrowthRatio: number;
  areaRecoveryMaxIterations: number;
  floorDropMultiplier: number;
  floorHorizontalBonus: number;
  floorGrowthMultiplier: number;
  floorIterationBonus: number;
};

type StarvationClusterSignal = {
  clusterId: string;
  required: boolean;
  clusterLabel: string;
  anchorX: number;
  anchorY: number;
  expectedAreaRatioMin: number;
  expectedAreaRatioTarget: number;
  rateLimitFailures: number;
  retryExhausted: boolean;
  priorMask: Buffer;
};

type StarvationFallbackTelemetry = {
  activated: boolean;
  activationReason: string | null;
  starvedClusterIds: string[];
  retryExhaustedClusterIds: string[];
  seedPixelsAdded: number;
  seedAreaRatioAdded: number;
  occupancyInflationPixels: number;
  occupancyInflationAreaRatio: number;
  legalityOverlapBefore: number;
  legalityOverlapAfter: number;
  legalityOverlapDelta: number;
  supportOverlapBefore: number;
  supportOverlapAfter: number;
  supportOverlapDelta: number;
  targetShortfallPixels: number;
  maxSeedPixels: number;
};

const geminiOccupancyInvocationCounts = new Map<string, number>();

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
  rawGeminiMaskPath?: string;
  thresholdedMaskPath?: string;
  alphaNormalizedMaskPath?: string;
  morphologyCleanedMaskPath?: string;
  componentFilteredMaskPath?: string;
  acceptedClusterMaskPath?: string;
  finalUnionMaskPath?: string;
  occupancyCollapseAnalysisPath?: string;
  occupancyStageGridPath?: string;
  componentAnalysisPath?: string;
  componentRetainedPath?: string;
  componentRemovedPath?: string;
  alphaHeatmapPath?: string;
  alphaHistogramPath?: string;
  occupancyMetricDebugPath?: string;
  thresholdComparisonPath?: string;
  stageComparisonPath?: string;
  measurementStage?: string;
  alphaAware?: boolean;
  measurementThreshold?: number;
  normalizationWidth?: number;
  normalizationHeight?: number;
  normalizationSource?: string;
  cleanedMaskRaw: Buffer;
  rawMaskPath: string;
  cleanedMaskPath: string;
  componentsPath: string;
  qualityReportPath: string;
  retryComparisonPath: string;
  anchorDistanceHeatmapPath: string;
  floorContactVisualizationPath: string;
  acceptedRejectedOverlayPath: string;
  perClusterMaskPaths: string[];
  usedConservativeFallback: boolean;
  retryCount: number;
  clusterCount: number;
  requiredClusterCount: number;
  optionalClusterCount: number;
  clusterApiCallCount: number;
  estimatedCallReductionRatio: number;
  qualityScore: number;
  model: string;
  latencyMs: number;
  safety: GeminiMaskSafetyTelemetry;
};

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getProcessMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMb: Number((usage.rss / (1024 * 1024)).toFixed(1)),
    heapTotalMb: Number((usage.heapTotal / (1024 * 1024)).toFixed(1)),
    heapUsedMb: Number((usage.heapUsed / (1024 * 1024)).toFixed(1)),
    externalMb: Number((usage.external / (1024 * 1024)).toFixed(1)),
    arrayBuffersMb: Number((usage.arrayBuffers / (1024 * 1024)).toFixed(1)),
  };
}

function isGeminiMaskMemoryDebugEnabled(): boolean {
  return parseBooleanEnv(process.env.CONTINUITY_GEMINI_MASK_MEMORY_DEBUG);
}

function estimateBytes(params: { width: number; height: number; channels: number }): number {
  return Math.max(0, params.width) * Math.max(0, params.height) * Math.max(1, params.channels);
}

function releaseBuffer(buffer: Buffer | undefined): void {
  if (!buffer || buffer.length === 0) {
    return;
  }
  buffer.fill(0);
}

function logGeminiMaskMemory(params: {
  enabled: boolean;
  phase: string;
  continuityGroupId?: string | null;
  imageId: string;
  jobId: string;
  clusterId?: string;
  attempt?: number;
  extra?: Record<string, unknown>;
}) {
  if (!params.enabled) {
    return;
  }

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_MEMORY]", {
    phase: params.phase,
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    clusterId: params.clusterId || null,
    attempt: Number.isFinite(params.attempt) ? params.attempt : null,
    ...getProcessMemorySnapshot(),
    ...(params.extra || {}),
  });
}

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveOccupancyProcessingDimensions(params: {
  sourceWidth: number;
  sourceHeight: number;
  requestedMaxEdge: number;
}): { width: number; height: number; scale: number; maxEdge: number } {
  const safeMaxEdge = Math.max(512, Math.min(2048, Math.floor(params.requestedMaxEdge)));
  const longEdge = Math.max(params.sourceWidth, params.sourceHeight);
  if (longEdge <= safeMaxEdge) {
    return {
      width: params.sourceWidth,
      height: params.sourceHeight,
      scale: 1,
      maxEdge: safeMaxEdge,
    };
  }

  const scale = safeMaxEdge / longEdge;
  const width = Math.max(1, Math.round(params.sourceWidth * scale));
  const height = Math.max(1, Math.round(params.sourceHeight * scale));
  return {
    width,
    height,
    scale,
    maxEdge: safeMaxEdge,
  };
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

function computeBufferCompactness(mask: Buffer, width: number, height: number): number {
  const bbox = computeBoundingBox(mask, width, height);
  if (!bbox || bbox.pixelCount <= 0) {
    return 0;
  }
  const area = Math.max(1, (bbox.maxX - bbox.minX + 1) * (bbox.maxY - bbox.minY + 1));
  return bbox.pixelCount / area;
}

function deriveGeometryAdaptiveRecoveryProfile(params: {
  plan: PlacementPlan;
  priorClusters: PriorCluster[];
  deterministicConstraintMask: Buffer;
  width: number;
  height: number;
}): GeometryAdaptiveRecoveryProfile {
  const totalPixels = Math.max(1, params.width * params.height);
  const projectionAreaRatio = countMaskPixels(params.deterministicConstraintMask) / totalPixels;
  const projectionCompactness = computeBufferCompactness(params.deterministicConstraintMask, params.width, params.height);
  const requiredClusterCount = params.priorClusters.filter((cluster) => cluster.required).length;
  const requiredClusterDensity = requiredClusterCount / Math.max(1, params.priorClusters.length);

  const floorJunctionCount = Array.isArray(params.plan.structuralTopologyCage?.floorWallJunctions)
    ? params.plan.structuralTopologyCage?.floorWallJunctions?.length || 0
    : 0;
  const hasFloorPlane = !!(params.plan.structuralTopologyCage?.majorRoomPlanes || []).find((plane) => /floor/i.test(String(plane.planeType || "")));
  const floorGuideConfidence = clamp01(
    (Math.min(1, floorJunctionCount / 6) * 0.7) + (hasFloorPlane ? 0.3 : 0),
  );

  const sparsityPressure = clamp01((0.22 - projectionAreaRatio) / 0.22);
  const diffusePressure = clamp01((0.5 - projectionCompactness) / 0.5);
  const anchorSparsity = clamp01(1 - requiredClusterDensity);

  const areaAggression = clamp01(
    (sparsityPressure * 0.45)
    + (anchorSparsity * 0.35)
    + (diffusePressure * 0.2),
  );
  const floorAggression = clamp01(
    ((1 - floorGuideConfidence) * 0.6)
    + (anchorSparsity * 0.4),
  );

  return {
    projectionAreaRatio,
    projectionCompactness,
    floorGuideConfidence,
    requiredClusterDensity,
    areaRecoveryMaxGrowthRatio: 0.35 + (areaAggression * 1.1),
    areaRecoveryMaxIterations: 1 + Math.round(areaAggression * 3),
    floorDropMultiplier: 1 + (floorAggression * 1.4),
    floorHorizontalBonus: Math.round(floorAggression * 2),
    floorGrowthMultiplier: 1 + (floorAggression * 0.8),
    floorIterationBonus: Math.round(floorAggression * 2),
  };
}

async function buildConstraintBoundedAreaRecovery(params: {
  mask: Buffer;
  constraintMask: Buffer;
  supportMask: Buffer;
  width: number;
  height: number;
  targetAreaRatio: number;
  maxGrowthRatio: number;
  maxIterations: number;
}): Promise<{
  mask: Buffer;
  beforePixels: number;
  afterPixels: number;
  iterations: number;
  addedPixels: number;
}> {
  const totalPixels = Math.max(1, params.width * params.height);
  const targetPixels = Math.max(0, Math.floor(params.targetAreaRatio * totalPixels));
  const beforePixels = countMaskPixels(params.mask);
  if (beforePixels <= 0 || beforePixels >= targetPixels) {
    return {
      mask: Buffer.from(params.mask),
      beforePixels,
      afterPixels: beforePixels,
      iterations: 0,
      addedPixels: 0,
    };
  }

  const working = Buffer.from(params.mask);
  const maxGrowthPixels = Math.max(
    1,
    Math.floor(beforePixels * Math.max(0.15, Math.min(2.8, params.maxGrowthRatio))),
  );
  let addedPixels = 0;
  let iterations = 0;

  for (let iter = 0; iter < Math.max(1, params.maxIterations); iter += 1) {
    iterations = iter + 1;
    const dilated = await sharp(working, {
      raw: { width: params.width, height: params.height, channels: 1 },
    }).dilate(1).threshold(1, { grayscale: true }).raw().toBuffer();

    let passAdded = 0;
    for (let i = 0; i < working.length; i += 1) {
      if (working[i] > 0) {
        continue;
      }
      if (dilated[i] === 0 || params.constraintMask[i] === 0 || params.supportMask[i] === 0) {
        continue;
      }
      working[i] = 255;
      addedPixels += 1;
      passAdded += 1;
      if (addedPixels >= maxGrowthPixels) {
        break;
      }
    }

    if (countMaskPixels(working) >= targetPixels || addedPixels >= maxGrowthPixels) {
      break;
    }

    if (passAdded === 0) {
      for (let i = 0; i < working.length; i += 1) {
        if (working[i] > 0) {
          continue;
        }
        if (dilated[i] === 0 || params.constraintMask[i] === 0) {
          continue;
        }
        working[i] = 255;
        addedPixels += 1;
        passAdded += 1;
        if (addedPixels >= maxGrowthPixels) {
          break;
        }
      }
    }

    if (passAdded === 0) {
      break;
    }
  }

  return {
    mask: working,
    beforePixels,
    afterPixels: countMaskPixels(working),
    iterations,
    addedPixels,
  };
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

function normalizeFurnitureType(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function classifyClusterRole(furnitureType: string): "anchor" | "support" | "decor" {
  const normalized = normalizeFurnitureType(furnitureType);
  if (normalized.includes("bed") || normalized.includes("sofa") || normalized.includes("couch") || normalized.includes("dining_table") || normalized.includes("desk") || normalized.includes("table")) {
    return "anchor";
  }
  if (normalized.includes("nightstand") || normalized.includes("bedside") || normalized.includes("chair") || normalized.includes("rug") || normalized.includes("coffee_table") || normalized.includes("side_table")) {
    return "support";
  }
  return "decor";
}

function inferClusterFamily(params: { roomType: string; furnitureType: string }): string {
  const roomType = normalizeFurnitureType(params.roomType);
  const furnitureType = normalizeFurnitureType(params.furnitureType);
  if (roomType.includes("bedroom")) {
    if (furnitureType.includes("bed") || furnitureType.includes("nightstand") || furnitureType.includes("bedside") || furnitureType.includes("lamp") || furnitureType.includes("rug")) {
      return "bedside_composition";
    }
  }
  if (roomType.includes("living")) {
    if (furnitureType.includes("sofa") || furnitureType.includes("couch") || furnitureType.includes("coffee_table") || furnitureType.includes("side_table") || furnitureType.includes("rug")) {
      return "seating_composition";
    }
  }
  if (roomType.includes("dining")) {
    if (furnitureType.includes("dining_table") || furnitureType.includes("chair") || furnitureType.includes("centerpiece")) {
      return "dining_composition";
    }
  }
  if (roomType.includes("office") || roomType.includes("study")) {
    if (furnitureType.includes("desk") || furnitureType.includes("chair") || furnitureType.includes("monitor") || furnitureType.includes("lamp")) {
      return "desk_composition";
    }
  }
  if (classifyClusterRole(furnitureType) === "anchor") {
    return `anchor_${furnitureType}`;
  }
  if (classifyClusterRole(furnitureType) === "support") {
    return "support_group";
  }
  return "decor_group";
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

function buildFallbackProjectionWallPolygon(zone: PlacementPlan["furnitureZones"][number]): NormalizedPoint[] {
  const bbox = zone.normalizedBoundingBox;
  const top = bbox.y;
  const mid = Math.min(1, bbox.y + bbox.height * 0.62);
  const left = bbox.x;
  const right = Math.min(1, bbox.x + bbox.width);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: mid },
    { x: left, y: mid },
  ];
}

function buildFallbackProjectionFloorPolygon(zone: PlacementPlan["furnitureZones"][number]): NormalizedPoint[] {
  const bbox = zone.normalizedBoundingBox;
  const mid = Math.min(1, bbox.y + bbox.height * 0.56);
  const bottom = Math.min(1, bbox.y + bbox.height);
  const left = bbox.x;
  const right = Math.min(1, bbox.x + bbox.width);
  const inset = Math.min(0.08, bbox.width * 0.16);
  return [
    { x: Math.min(1, left + inset), y: mid },
    { x: Math.max(0, right - inset), y: mid },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function toDeterministicPixelPoint(point: NormalizedPoint, width: number, height: number): string {
  const x = Math.max(0, Math.min(width, Math.round(point.x * width)));
  const y = Math.max(0, Math.min(height, Math.round(point.y * height)));
  return `${x},${y}`;
}

function deterministicPolygonSvg(points: NormalizedPoint[], width: number, height: number): string {
  if (points.length < 3) {
    return "";
  }
  const svgPoints = points.map((point) => toDeterministicPixelPoint(point, width, height)).join(" ");
  return `<polygon points="${svgPoints}" fill="#ffffff" />`;
}

async function buildDeterministicConstraintMask(plan: PlacementPlan, width: number, height: number): Promise<Buffer> {
  const polygons: string[] = [];
  for (const zone of plan.furnitureZones) {
    const projection = resolveDeterministicZoneProjection({
      plan,
      zone,
    });
    const wallPolygon = projection.wallPolygon.length >= 3
      ? projection.wallPolygon
      : buildFallbackProjectionWallPolygon(zone);
    const floorPolygon = projection.floorPolygon.length >= 3
      ? projection.floorPolygon
      : buildFallbackProjectionFloorPolygon(zone);
    polygons.push(deterministicPolygonSvg(wallPolygon, width, height));
    polygons.push(deterministicPolygonSvg(floorPolygon, width, height));
  }

  if (polygons.length === 0) {
    return Buffer.alloc(width * height, 0);
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#000000" />
      ${polygons.join("\n")}
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .removeAlpha()
    .grayscale()
    .threshold(1, { grayscale: true })
    .raw()
    .toBuffer();
}

function computeMaskConstraintAffinity(mask: Buffer, constraintMask: Buffer, width: number, height: number): number {
  const total = countMaskPixels(mask);
  if (total === 0 || mask.length !== constraintMask.length) {
    return 0;
  }

  let overlap = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0 && constraintMask[i] > 0) {
      overlap += 1;
    }
  }
  const overlapRatio = overlap / Math.max(1, total);
  if (overlapRatio > 0) {
    return overlapRatio;
  }

  const occupancyComponents = analyzeConnectedComponents(mask, width, height, 1).components;
  const constraintComponents = analyzeConnectedComponents(constraintMask, width, height, 1).components;
  if (occupancyComponents.length === 0 || constraintComponents.length === 0) {
    return 0;
  }

  const diag = Math.sqrt((width * width) + (height * height));
  const sigma = Math.max(1, diag * 0.18);
  let weighted = 0;
  let weightTotal = 0;
  for (const component of occupancyComponents) {
    let minDistance = Number.POSITIVE_INFINITY;
    for (const constraintComponent of constraintComponents) {
      const dx = component.centroidX - constraintComponent.centroidX;
      const dy = component.centroidY - constraintComponent.centroidY;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      if (distance < minDistance) {
        minDistance = distance;
      }
    }
    const proximity = Math.exp(-(minDistance / sigma));
    weighted += proximity * component.pixelCount;
    weightTotal += component.pixelCount;
  }
  return (weightTotal > 0 ? (weighted / weightTotal) : 0) * 0.35;
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

async function buildSupportSurfaceMask(plan: PlacementPlan, floorMask: Buffer, width: number, height: number): Promise<Buffer> {
  const support = Buffer.from(floorMask);
  const rugs = plan.furnitureZones.filter((zone) => {
    const type = normalizeFurnitureType(zone.furnitureType);
    return type.includes("rug") || type.includes("carpet") || type.includes("runner") || type.includes("mat");
  });
  if (rugs.length === 0) {
    return support;
  }

  for (const rug of rugs) {
    const floorPolygon = Array.isArray(rug.maskProjection?.floorPolygon)
      ? rug.maskProjection.floorPolygon
      : [];
    if (floorPolygon.length >= 3) {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          <rect width="100%" height="100%" fill="#000000" />
          <polygon points="${polygonPointsAttribute(floorPolygon, width, height)}" fill="#ffffff" />
        </svg>
      `;
      const rugMask = await sharp(Buffer.from(svg))
        .removeAlpha()
        .grayscale()
        .threshold(1, { grayscale: true })
        .raw()
        .toBuffer();
      for (let i = 0; i < support.length; i += 1) {
        if (rugMask[i] > 0) {
          support[i] = 255;
        }
      }
      continue;
    }

    const bbox = rug.normalizedBoundingBox;
    const startX = Math.max(0, Math.floor(bbox.x * width));
    const endX = Math.min(width - 1, Math.ceil((bbox.x + bbox.width) * width));
    const startY = Math.max(0, Math.floor((bbox.y + (bbox.height * 0.45)) * height));
    const endY = Math.min(height - 1, Math.ceil((bbox.y + bbox.height) * height));
    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        support[(y * width) + x] = 255;
      }
    }
  }

  return support;
}

function resolveAdaptiveFloorContactTarget(plan: PlacementPlan, profile: RoomTypeBandProfile): {
  effectiveMinFloorContactRatio: number;
  rugZoneCount: number;
  rugAreaRatio: number;
  reductionApplied: number;
} {
  const base = profile.minFloorContactRatio;
  const rugs = plan.furnitureZones.filter((zone) => {
    const type = normalizeFurnitureType(zone.furnitureType);
    return type.includes("rug") || type.includes("carpet") || type.includes("runner") || type.includes("mat");
  });
  const rugAreaRatio = rugs.reduce((sum, zone) => {
    const bbox = zone.normalizedBoundingBox;
    return sum + Math.max(0, bbox.width) * Math.max(0, bbox.height);
  }, 0);

  const rawReduction = rugAreaRatio > 0.02
    ? Math.min(0.22, (rugAreaRatio - 0.02) * 1.4)
    : 0;
  const reductionApplied = Math.max(0, Math.min(base - 0.35, rawReduction));
  const effectiveMinFloorContactRatio = Math.max(0.35, base - reductionApplied);
  return {
    effectiveMinFloorContactRatio,
    rugZoneCount: rugs.length,
    rugAreaRatio,
    reductionApplied,
  };
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

function mergeAreaBands(bands: Array<{ min: number; target: number; max: number }>): { min: number; target: number; max: number } {
  if (bands.length === 0) {
    return { min: 0.003, target: 0.012, max: 0.06 };
  }
  const summed = bands.reduce((acc, band) => ({
    min: acc.min + band.min,
    target: acc.target + band.target,
    max: acc.max + band.max,
  }), { min: 0, target: 0, max: 0 });
  return {
    min: Math.max(0.004, Math.min(0.18, summed.min * 0.7)),
    target: Math.max(0.01, Math.min(0.22, summed.target * 0.75)),
    max: Math.max(0.03, Math.min(0.35, summed.max * 0.8)),
  };
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

async function buildPriorClusters(plan: PlacementPlan, width: number, height: number, floorMask: Buffer): Promise<PriorCluster[]> {
  const floorJunctions = parsePoints(plan.structuralTopologyCage?.floorWallJunctions);
  const families = new Map<string, PlacementPlan["furnitureZones"]>();
  for (const zone of plan.furnitureZones) {
    const family = inferClusterFamily({ roomType: plan.roomType, furnitureType: zone.furnitureType });
    const existing = families.get(family) || [];
    existing.push(zone);
    families.set(family, existing);
  }

  const clustered: Array<{ clusterId: string; clusterLabel: string; required: boolean; zones: PlacementPlan["furnitureZones"] }> = [];
  for (const [family, zones] of families.entries()) {
    const required = zones.some((zone) => classifyClusterRole(zone.furnitureType) === "anchor");
    clustered.push({
      clusterId: family,
      clusterLabel: family.replace(/_/g, " "),
      required,
      zones,
    });
  }

  const output: PriorCluster[] = [];
  for (const cluster of clustered) {
    const zonePriorMasks: Buffer[] = [];
    const anchorPoints: Array<{ x: number; y: number }> = [];
    const areaBands: Array<{ min: number; target: number; max: number }> = [];

    for (const zone of cluster.zones) {
      const bbox = zone.normalizedBoundingBox;
      const anchorXNorm = clamp01(bbox.x + (bbox.width / 2));
      const floorY = estimateFloorY(floorJunctions, anchorXNorm);
      const anchorYNorm = clamp01(Math.max(bbox.y + (bbox.height * 0.6), floorY));
      anchorPoints.push({ x: anchorXNorm * width, y: anchorYNorm * height });
      areaBands.push(getZoneAreaBand(zone.furnitureType));
      zonePriorMasks.push(await buildZonePriorMask({ zone, width, height, floorMask }));
    }

    let priorMask = Buffer.alloc(width * height, 0);
    for (const zoneMask of zonePriorMasks) {
      priorMask = Buffer.from(safeMaskUnion(priorMask, zoneMask));
    }
    const priorMaskPng = await sharp(priorMask, {
      raw: { width, height, channels: 1 },
    }).png().toBuffer();
    const mergedBand = mergeAreaBands(areaBands);
    const anchorX = anchorPoints.reduce((sum, point) => sum + point.x, 0) / Math.max(1, anchorPoints.length);
    const anchorY = anchorPoints.reduce((sum, point) => sum + point.y, 0) / Math.max(1, anchorPoints.length);

    output.push({
      clusterId: cluster.clusterId,
      clusterLabel: cluster.clusterLabel,
      required: cluster.required,
      zoneIds: cluster.zones.map((zone) => zone.id),
      furnitureTypes: cluster.zones.map((zone) => zone.furnitureType),
      anchorX,
      anchorY,
      expectedAreaRatioMin: mergedBand.min,
      expectedAreaRatioTarget: mergedBand.target,
      expectedAreaRatioMax: mergedBand.max,
      priorMask,
      priorMaskPngBase64: priorMaskPng.toString("base64"),
    });
  }

  return output;
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
    case "low_constraint_affinity":
      return "Align occupancy tightly with deterministic projection geometry for the target furniture; avoid offset or drifted regions.";
    default:
      return "Generate precise furniture-only occupancy with strict structural preservation.";
  }
}

function buildOccupancyPrompt(plan: PlacementPlan, priorCluster: PriorCluster, failureMode: AttemptFailureMode): string {
  const zones = plan.furnitureZones.filter((item) => priorCluster.zoneIds.includes(item.id));
  const zoneHints = zones.map((zone) => {
    const bbox = zone.normalizedBoundingBox;
    return `${zone.id}:${zone.furnitureType}[x:${bbox.x.toFixed(3)},y:${bbox.y.toFixed(3)},w:${bbox.width.toFixed(3)},h:${bbox.height.toFixed(3)}]`;
  }).join(" | ");
  const clusterHint = `cluster_id=${priorCluster.clusterId}; label=${priorCluster.clusterLabel}; required=${priorCluster.required}; anchor_px=(${Math.round(priorCluster.anchorX)},${Math.round(priorCluster.anchorY)}); furniture=${priorCluster.furnitureTypes.join(",")}; zones=${zoneHints}; expected_area_band=[min:${priorCluster.expectedAreaRatioMin.toFixed(4)},target:${priorCluster.expectedAreaRatioTarget.toFixed(4)},max:${priorCluster.expectedAreaRatioMax.toFixed(4)}]`;
  return [
    "Generate a binary occupancy mask IMAGE for ONLY the target furniture cluster described below.",
    "Output IMAGE ONLY. No text, no JSON.",
    "Mask semantics: WHITE=editable projected furniture occupancy, BLACK=protected.",
    "Hard constraints:",
    "- Include only the specified furniture composition occupancy, perspective-aware.",
    "- Maintain relational coherence between the clustered furniture pieces.",
    "- Preserve architecture, envelope, openings, walls, ceiling.",
    "- Do not output giant room-spanning regions.",
    "- Do not infer hidden geometry.",
    "- Keep region localized and composition-coherent.",
    "- Prefer strong overlap with the provided deterministic projection guide (white regions) while preserving furniture semantics.",
    `Target furniture cluster: ${clusterHint}`,
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

function computeComponentSupportOverlap(params: {
  component: ConnectedComponentStats;
  labelMap: Int32Array;
  supportMask: Buffer;
  width: number;
}): number {
  let supportPixels = 0;
  for (let y = params.component.minY; y <= params.component.maxY; y += 1) {
    for (let x = params.component.minX; x <= params.component.maxX; x += 1) {
      const idx = (y * params.width) + x;
      if (params.labelMap[idx] !== params.component.id) {
        continue;
      }
      if (params.supportMask[idx] > 0) {
        supportPixels += 1;
      }
    }
  }
  return supportPixels / Math.max(1, params.component.pixelCount);
}

function computeComponentMaskOverlap(params: {
  component: ConnectedComponentStats;
  labelMap: Int32Array;
  referenceMask: Buffer;
  width: number;
}): number {
  let overlapPixels = 0;
  for (let y = params.component.minY; y <= params.component.maxY; y += 1) {
    for (let x = params.component.minX; x <= params.component.maxX; x += 1) {
      const idx = (y * params.width) + x;
      if (params.labelMap[idx] !== params.component.id) {
        continue;
      }
      if (params.referenceMask[idx] > 0) {
        overlapPixels += 1;
      }
    }
  }
  return overlapPixels / Math.max(1, params.component.pixelCount);
}

function computeComponentConstraintAffinity(params: {
  component: ConnectedComponentStats;
  labelMap: Int32Array;
  constraintMask: Buffer;
  constraintComponents: ConnectedComponentStats[];
  width: number;
  height: number;
}): number {
  const overlapRatio = computeComponentMaskOverlap({
    component: params.component,
    labelMap: params.labelMap,
    referenceMask: params.constraintMask,
    width: params.width,
  });
  if (overlapRatio > 0) {
    return overlapRatio;
  }
  if (params.constraintComponents.length === 0) {
    return 0;
  }

  const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
  const sigma = Math.max(1, diag * 0.18);
  let minDistance = Number.POSITIVE_INFINITY;
  for (const constraintComponent of params.constraintComponents) {
    const dx = params.component.centroidX - constraintComponent.centroidX;
    const dy = params.component.centroidY - constraintComponent.centroidY;
    const distance = Math.sqrt((dx * dx) + (dy * dy));
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return Math.exp(-(minDistance / sigma)) * 0.35;
}

function computeBoundingBoxGap(a: ConnectedComponentStats, b: ConnectedComponentStats): number {
  const dx = a.maxX < b.minX
    ? (b.minX - a.maxX)
    : b.maxX < a.minX
      ? (a.minX - b.maxX)
      : 0;
  const dy = a.maxY < b.minY
    ? (b.minY - a.maxY)
    : b.maxY < a.minY
      ? (a.minY - b.maxY)
      : 0;
  return Math.max(dx, dy);
}

function computeAnchorAffinityScore(params: {
  component: ConnectedComponentStats;
  anchors: Array<{ x: number; y: number; weight: number }>;
  width: number;
  height: number;
}): number {
  if (params.anchors.length === 0) {
    return 0;
  }
  const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
  const sigma = Math.max(1, diag * 0.2);
  let weighted = 0;
  let weightTotal = 0;
  for (const anchor of params.anchors) {
    const dx = params.component.centroidX - anchor.x;
    const dy = params.component.centroidY - anchor.y;
    const distance = Math.sqrt((dx * dx) + (dy * dy));
    const affinity = Math.exp(-(distance / sigma));
    const weight = Math.max(0.1, anchor.weight);
    weighted += affinity * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weighted / weightTotal : 0;
}

function removeSmallComponents(params: {
  mask: Buffer;
  supportMask: Buffer;
  constraintMask: Buffer;
  width: number;
  height: number;
  minPixels: number;
}): {
  output: Buffer;
  removedCount: number;
  preservedSatelliteCount: number;
} {
  if (params.minPixels <= 1) {
    return {
      output: Buffer.from(params.mask),
      removedCount: 0,
      preservedSatelliteCount: 0,
    };
  }

  const analyzed = analyzeConnectedComponents(params.mask, params.width, params.height, 1);
  const constraintComponents = analyzeConnectedComponents(params.constraintMask, params.width, params.height, 1).components;
  const largeComponents = analyzed.components.filter((component) => component.pixelCount >= params.minPixels);
  const semanticSatelliteMinPixels = Math.max(6, Math.floor(params.minPixels * 0.35));
  const minSemanticSupportOverlap = Math.max(
    0.05,
    Math.min(0.8, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_SATELLITE_SUPPORT_OVERLAP", 0.18)),
  );
  const minSatelliteConstraintAffinity = Math.max(
    0,
    Math.min(0.95, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_SATELLITE_CONSTRAINT_AFFINITY", 0.08)),
  );
  const maxSatelliteAttachmentGap = Math.max(
    0,
    Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MAX_SATELLITE_ATTACHMENT_GAP", 24)),
  );

  const allowedIds = new Set<number>();
  for (const component of largeComponents) {
    allowedIds.add(component.id);
  }

  for (const component of analyzed.components) {
    if (component.pixelCount >= params.minPixels || component.pixelCount < semanticSatelliteMinPixels) {
      continue;
    }
    if (largeComponents.length === 0) {
      continue;
    }

    const supportOverlap = computeComponentSupportOverlap({
      component,
      labelMap: analyzed.labelMap,
      supportMask: params.supportMask,
      width: params.width,
    });
    const constraintAffinity = computeComponentConstraintAffinity({
      component,
      labelMap: analyzed.labelMap,
      constraintMask: params.constraintMask,
      constraintComponents,
      width: params.width,
      height: params.height,
    });
    if (supportOverlap < minSemanticSupportOverlap || constraintAffinity < minSatelliteConstraintAffinity) {
      continue;
    }

    let nearestGap = Number.POSITIVE_INFINITY;
    for (const anchorComponent of largeComponents) {
      nearestGap = Math.min(nearestGap, computeBoundingBoxGap(component, anchorComponent));
      if (nearestGap <= maxSatelliteAttachmentGap) {
        break;
      }
    }
    if (nearestGap <= maxSatelliteAttachmentGap) {
      allowedIds.add(component.id);
    }
  }

  const removedCount = analyzed.components.filter((component) => !allowedIds.has(component.id)).length;
  const preservedSatelliteCount = analyzed.components.filter((component) => {
    return component.pixelCount < params.minPixels && allowedIds.has(component.id);
  }).length;

  return {
    output: keepAllowedComponents(params.mask, analyzed.labelMap, allowedIds),
    removedCount,
    preservedSatelliteCount,
  };
}

function keepMostSupportedComponents(params: {
  mask: Buffer;
  supportMask: Buffer;
  constraintMask: Buffer;
  width: number;
  height: number;
  maxComponents: number;
  anchors: Array<{ x: number; y: number; weight: number }>;
}): {
  output: Buffer;
  componentCount: number;
  retainedCount: number;
} {
  const analyzed = analyzeConnectedComponents(params.mask, params.width, params.height, 1);
  const constraintComponents = analyzeConnectedComponents(params.constraintMask, params.width, params.height, 1).components;
  if (analyzed.components.length <= params.maxComponents) {
    return {
      output: Buffer.from(params.mask),
      componentCount: analyzed.components.length,
      retainedCount: analyzed.components.length,
    };
  }

  const maxPixels = analyzed.components.reduce((max, component) => Math.max(max, component.pixelCount), 1);
  const anchorBlend = Math.max(0, Math.min(0.28, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_ANCHOR_BLEND", 0.16)));
  const supportBlend = Math.max(0.2, Math.min(0.5, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_SUPPORT_BLEND", 0.34)));
  const constraintBlend = Math.max(0.08, Math.min(0.42, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_CONSTRAINT_BLEND", 0.24)));
  const sizeBlend = Math.max(0.08, 1 - anchorBlend - supportBlend - constraintBlend);
  const normalizedWeightSum = sizeBlend + supportBlend + anchorBlend + constraintBlend;
  const kept = analyzed.components
    .map((component) => {
      const supportOverlap = computeComponentSupportOverlap({
        component,
        labelMap: analyzed.labelMap,
        supportMask: params.supportMask,
        width: params.width,
      });
      const constraintAffinity = computeComponentConstraintAffinity({
        component,
        labelMap: analyzed.labelMap,
        constraintMask: params.constraintMask,
        constraintComponents,
        width: params.width,
        height: params.height,
      });
      const sizeScore = Math.sqrt(component.pixelCount / Math.max(1, maxPixels));
      const anchorScore = computeAnchorAffinityScore({
        component,
        anchors: params.anchors,
        width: params.width,
        height: params.height,
      });
      return {
        component,
        score: (
          (sizeScore * sizeBlend)
          + (supportOverlap * supportBlend)
          + (anchorScore * anchorBlend)
          + (constraintAffinity * constraintBlend)
        ) / Math.max(0.0001, normalizedWeightSum),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, params.maxComponents));
  const allowedIds = new Set(kept.map((entry) => entry.component.id));
  return {
    output: keepAllowedComponents(params.mask, analyzed.labelMap, allowedIds),
    componentCount: analyzed.components.length,
    retainedCount: kept.length,
  };
}

async function applyMorphologicalClose(mask: Buffer, width: number, height: number, radius: number): Promise<Buffer> {
  if (radius <= 0) {
    return Buffer.from(mask);
  }
  return sharp(mask, {
    raw: { width, height, channels: 1 },
  })
    .dilate(radius)
    .erode(radius)
    .raw()
    .toBuffer();
}

async function stabilizeFragmentedMask(params: {
  mask: Buffer;
  supportMask: Buffer;
  constraintMask: Buffer;
  anchors: Array<{ x: number; y: number; weight: number }>;
  width: number;
  height: number;
  targetMaxComponents: number;
  closeRadius: number;
  maxCloseRadius: number;
  minIslandPixels: number;
  maxAreaExpansionRatio: number;
  minFinalAreaRatio: number;
}): Promise<{
  mask: Buffer;
  beforeComponents: number;
  afterComponents: number;
  beforePixels: number;
  afterPixels: number;
  closePasses: number;
  largestTrimApplied: boolean;
  islandsRemoved: number;
  satelliteIslandsRetained: number;
  fallbackAreaRejected: boolean;
  constrainedMergeApplied: boolean;
  beforeConstraintAffinity: number;
  afterConstraintAffinity: number;
}> {
  const beforePixels = countMaskPixels(params.mask);
  const beforeComponents = analyzeConnectedComponents(params.mask, params.width, params.height, 1).components.length;
  const beforeConstraintAffinity = computeMaskConstraintAffinity(params.mask, params.constraintMask, params.width, params.height);
  if (beforeComponents <= params.targetMaxComponents || beforePixels === 0) {
    return {
      mask: Buffer.from(params.mask),
      beforeComponents,
      afterComponents: beforeComponents,
      beforePixels,
      afterPixels: beforePixels,
      closePasses: 0,
      largestTrimApplied: false,
      islandsRemoved: 0,
      satelliteIslandsRetained: 0,
      fallbackAreaRejected: false,
      constrainedMergeApplied: false,
      beforeConstraintAffinity,
      afterConstraintAffinity: beforeConstraintAffinity,
    };
  }

  let working = Buffer.from(params.mask);
  let workingComponents = beforeComponents;
  let closePasses = 0;
  let islandsRemoved = 0;
  let satelliteIslandsRetained = 0;
  let fallbackAreaRejected = false;
  let constrainedMergeApplied = false;
  const minRetainedAreaRatio = Math.max(0.15, Math.min(0.95, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_RETAINED_AREA_RATIO", 0.4)));
  const minStepRetainedAreaRatioBase = Math.max(0.7, Math.min(1, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_STEP_RETAINED_RATIO", 0.9)));
  const maxCloseRadius = Math.max(params.closeRadius, params.maxCloseRadius);
  const maxStepConstraintDrop = Math.max(
    0,
    Math.min(0.4, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MAX_STEP_CONSTRAINT_DROP", 0.08)),
  );

  for (let radius = Math.max(1, params.closeRadius); radius <= maxCloseRadius; radius += 1) {
    const closed = await applyMorphologicalClose(working, params.width, params.height, radius);
    const pruned = removeSmallComponents({
      mask: closed,
      supportMask: params.supportMask,
      constraintMask: params.constraintMask,
      width: params.width,
      height: params.height,
      minPixels: params.minIslandPixels,
    });
    const candidatePixels = countMaskPixels(pruned.output);
    const candidateComponents = analyzeConnectedComponents(pruned.output, params.width, params.height, 1).components.length;
    const workingPixels = countMaskPixels(working);
    const candidateConstraintAffinity = computeMaskConstraintAffinity(pruned.output, params.constraintMask, params.width, params.height);
    const workingConstraintAffinity = computeMaskConstraintAffinity(working, params.constraintMask, params.width, params.height);
    const areaRatio = candidatePixels / Math.max(1, beforePixels);
    const stepRetainedRatio = candidatePixels / Math.max(1, workingPixels);
    const componentPressure = workingComponents / Math.max(1, params.targetMaxComponents);
    const adaptiveStepRetentionFloor = Math.max(
      0.72,
      minStepRetainedAreaRatioBase - (Math.max(0, componentPressure - 1) * 0.08),
    );
    const absoluteAreaRatio = candidatePixels / Math.max(1, params.width * params.height);
    const retainedEnoughArea = candidatePixels > 0 && areaRatio >= minRetainedAreaRatio;
    if (
      candidateComponents < workingComponents
      && areaRatio <= params.maxAreaExpansionRatio
      && retainedEnoughArea
      && stepRetainedRatio >= adaptiveStepRetentionFloor
      && absoluteAreaRatio >= params.minFinalAreaRatio
      && candidateConstraintAffinity >= Math.max(0, workingConstraintAffinity - maxStepConstraintDrop)
    ) {
      working = Buffer.from(pruned.output);
      workingComponents = candidateComponents;
      closePasses += 1;
      islandsRemoved += pruned.removedCount;
      satelliteIslandsRetained += pruned.preservedSatelliteCount;
    }
    if (workingComponents <= params.targetMaxComponents) {
      break;
    }
  }

  let largestTrimApplied = false;
  if (workingComponents > params.targetMaxComponents) {
    const trimmed = keepMostSupportedComponents({
      mask: working,
      supportMask: params.supportMask,
      constraintMask: params.constraintMask,
      width: params.width,
      height: params.height,
      maxComponents: params.targetMaxComponents,
      anchors: params.anchors,
    });
    const workingAreaRatio = countMaskPixels(working) / Math.max(1, params.width * params.height);
    const trimmedPixels = countMaskPixels(trimmed.output);
    const retainedRatio = trimmedPixels / Math.max(1, countMaskPixels(working));
    const trimmedConstraintAffinity = computeMaskConstraintAffinity(trimmed.output, params.constraintMask, params.width, params.height);
    const workingConstraintAffinity = computeMaskConstraintAffinity(working, params.constraintMask, params.width, params.height);
    const minRetainedRatioForAreaFloor = Math.max(0.55, params.minFinalAreaRatio / Math.max(0.0001, workingAreaRatio));
    const absoluteAreaRatio = trimmedPixels / Math.max(1, params.width * params.height);
    if (
      retainedRatio >= minRetainedRatioForAreaFloor
      && absoluteAreaRatio >= params.minFinalAreaRatio
      && trimmedConstraintAffinity >= Math.max(0, workingConstraintAffinity - maxStepConstraintDrop)
    ) {
      working = Buffer.from(trimmed.output);
      workingComponents = analyzeConnectedComponents(working, params.width, params.height, 1).components.length;
      largestTrimApplied = true;
    } else {
      fallbackAreaRejected = true;
    }
  }

  if (workingComponents > params.targetMaxComponents && fallbackAreaRejected) {
    for (let radius = Math.max(1, params.closeRadius); radius <= Math.max(params.closeRadius, params.maxCloseRadius); radius += 1) {
      const merged = await applyMorphologicalClose(working, params.width, params.height, radius);
      const constrained = Buffer.alloc(merged.length, 0);
      for (let i = 0; i < merged.length; i += 1) {
        constrained[i] = merged[i] > 0 && params.constraintMask[i] > 0 ? 255 : 0;
      }

      const constrainedPixels = countMaskPixels(constrained);
      const constrainedAreaRatio = constrainedPixels / Math.max(1, params.width * params.height);
      if (constrainedAreaRatio < params.minFinalAreaRatio) {
        continue;
      }

      const constrainedComponents = analyzeConnectedComponents(constrained, params.width, params.height, 1).components.length;
      if (constrainedComponents < workingComponents) {
        working = constrained;
        workingComponents = constrainedComponents;
        constrainedMergeApplied = true;
      }

      if (workingComponents <= params.targetMaxComponents) {
        break;
      }
    }
  }

  return {
    mask: working,
    beforeComponents,
    afterComponents: workingComponents,
    beforePixels,
    afterPixels: countMaskPixels(working),
    closePasses,
    largestTrimApplied,
    islandsRemoved,
    satelliteIslandsRetained,
    fallbackAreaRejected,
    constrainedMergeApplied,
    beforeConstraintAffinity,
    afterConstraintAffinity: computeMaskConstraintAffinity(working, params.constraintMask, params.width, params.height),
  };
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

function buildAlphaHistogram(alpha: Buffer): { bins: number[]; min: number; max: number; mean: number; nonZeroPixels: number } {
  const bins = new Array(256).fill(0);
  let min = 255;
  let max = 0;
  let sum = 0;
  let nonZeroPixels = 0;
  for (const value of alpha) {
    bins[value] += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    if (value > 0) {
      nonZeroPixels += 1;
    }
  }
  return {
    bins,
    min: alpha.length > 0 ? min : 0,
    max: alpha.length > 0 ? max : 0,
    mean: alpha.length > 0 ? sum / alpha.length : 0,
    nonZeroPixels,
  };
}

function countAlphaAwarePixels(alpha: Buffer): number {
  return countMaskPixels(alpha);
}

async function writeRgbaPng(rgba: Buffer, width: number, height: number, outputPath: string): Promise<void> {
  await sharp(rgba, {
    raw: { width, height, channels: 4 },
  }).png().toFile(outputPath);
}

function buildStageComparisonRgba(params: {
  rawMask: Buffer;
  thresholdedMask: Buffer;
  alphaNormalizedMask: Buffer;
  morphologyCleanedMask: Buffer;
  componentFilteredMask: Buffer;
  acceptedClusterMask: Buffer;
  finalUnionMask: Buffer;
  width: number;
  height: number;
}): Buffer {
  const stages = [
    { mask: params.rawMask, color: [255, 255, 255, 255] as const },
    { mask: params.thresholdedMask, color: [255, 190, 64, 255] as const },
    { mask: params.alphaNormalizedMask, color: [64, 210, 255, 255] as const },
    { mask: params.morphologyCleanedMask, color: [168, 255, 64, 255] as const },
    { mask: params.componentFilteredMask, color: [255, 96, 160, 255] as const },
    { mask: params.acceptedClusterMask, color: [72, 210, 118, 255] as const },
    { mask: params.finalUnionMask, color: [255, 255, 255, 255] as const },
  ];
  const tileWidth = params.width;
  const tileHeight = params.height;
  const canvas = Buffer.alloc(tileWidth * tileHeight * stages.length * 4, 0);
  stages.forEach((stage, stageIndex) => {
    for (let i = 0; i < stage.mask.length; i += 1) {
      if (stage.mask[i] === 0) {
        continue;
      }
      const x = i % params.width;
      const y = Math.floor(i / params.width) + (stageIndex * tileHeight);
      const offset = ((y * tileWidth) + x) * 4;
      canvas[offset] = stage.color[0];
      canvas[offset + 1] = stage.color[1];
      canvas[offset + 2] = stage.color[2];
      canvas[offset + 3] = stage.color[3];
    }
  });
  return canvas;
}

function buildComponentOverlay(mask: Buffer, width: number, height: number): Buffer {
  const components = analyzeConnectedComponents(mask, width, height, 1);
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
  return componentRgba;
}

function buildBinaryMaskOverlay(mask: Buffer, width: number, height: number, color: { r: number; g: number; b: number; a: number }): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) {
      continue;
    }
    const offset = i * 4;
    rgba[offset] = color.r;
    rgba[offset + 1] = color.g;
    rgba[offset + 2] = color.b;
    rgba[offset + 3] = color.a;
  }
  return rgba;
}

function computeStageMetric(params: {
  clusterId: string;
  clusterRole: "required" | "optional";
  stage: OccupancyStageKey;
  mask: Buffer;
  width: number;
  height: number;
  rejectedReason?: string | null;
  includedInFinalUnion?: boolean;
}): OccupancyStageMetric {
  return {
    clusterId: params.clusterId,
    clusterRole: params.clusterRole,
    stage: params.stage,
    occupancyPixels: countMaskPixels(params.mask),
    occupancyAreaRatio: countMaskPixels(params.mask) / Math.max(1, params.width * params.height),
    componentCount: analyzeConnectedComponents(params.mask, params.width, params.height, 1).components.length,
    rejectedReason: params.rejectedReason ?? null,
    includedInFinalUnion: params.includedInFinalUnion,
  };
}

function buildOccupancyStageGridRgba(params: {
  rawMask: Buffer;
  thresholdedMask: Buffer;
  componentFilteredMask: Buffer;
  acceptedMask: Buffer;
  unionMask: Buffer;
  finalMask: Buffer;
  width: number;
  height: number;
}): Buffer {
  const masks = [
    params.rawMask,
    params.thresholdedMask,
    params.componentFilteredMask,
    params.acceptedMask,
    params.unionMask,
    params.finalMask,
  ];
  const output = Buffer.alloc(params.width * params.height * 6 * 4, 0);
  const colors = [
    { r: 255, g: 177, b: 66, a: 255 },
    { r: 64, g: 156, b: 255, a: 255 },
    { r: 170, g: 120, b: 255, a: 255 },
    { r: 72, g: 210, b: 118, a: 255 },
    { r: 236, g: 194, b: 74, a: 255 },
    { r: 255, g: 84, b: 84, a: 255 },
  ];

  for (let panel = 0; panel < masks.length; panel += 1) {
    const mask = masks[panel];
    const color = colors[panel];
    const panelOffset = panel * params.width * params.height * 4;
    for (let i = 0; i < mask.length; i += 1) {
      const offset = panelOffset + (i * 4);
      output[offset + 3] = 255;
      if (mask[i] > 0) {
        output[offset] = color.r;
        output[offset + 1] = color.g;
        output[offset + 2] = color.b;
      } else {
        output[offset] = 18;
        output[offset + 1] = 18;
        output[offset + 2] = 18;
      }
    }
  }

  return output;
}

function buildAlphaHeatmapRgba(alpha: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < alpha.length; i += 1) {
    const offset = i * 4;
    rgba[offset] = alpha[i];
    rgba[offset + 1] = Math.round(alpha[i] * 0.7);
    rgba[offset + 2] = Math.round(255 - alpha[i]);
    rgba[offset + 3] = 180;
  }
  return rgba;
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

function measureFloorContactRatio(mask: Buffer, floorMask: Buffer, width: number, height: number): number {
  if (mask.length === 0 || width <= 0 || height <= 0) {
    return 0;
  }

  const maxDropPixels = Math.max(
    4,
    Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_FLOOR_CONTACT_MAX_DROP_PIXELS", Math.max(10, height * 0.08))),
  );

  let supportColumns = 0;
  let groundedColumns = 0;
  for (let x = 0; x < width; x += 1) {
    let bottomY = -1;
    for (let y = height - 1; y >= 0; y -= 1) {
      if (mask[(y * width) + x] > 0) {
        bottomY = y;
        break;
      }
    }
    if (bottomY < 0) {
      continue;
    }

    supportColumns += 1;
    const probeMaxY = Math.min(height - 1, bottomY + maxDropPixels);
    let grounded = false;
    for (let y = bottomY; y <= probeMaxY; y += 1) {
      if (floorMask[(y * width) + x] > 0) {
        grounded = true;
        break;
      }
    }
    if (grounded) {
      groundedColumns += 1;
    }
  }

  return supportColumns > 0 ? groundedColumns / supportColumns : 0;
}

function buildGravityAwareFloorBridge(params: {
  mask: Buffer;
  floorMask: Buffer;
  width: number;
  height: number;
  targetFloorContactRatio: number;
  maxDropPixels: number;
  maxHorizontalReach: number;
  maxGrowthRatio: number;
  maxIterations: number;
}): {
  mask: Buffer;
  beforeFloorContactRatio: number;
  afterFloorContactRatio: number;
  beforePixels: number;
  afterPixels: number;
  addedPixels: number;
  iterations: number;
} {
  const beforePixels = countMaskPixels(params.mask);
  const beforeFloorContactRatio = measureFloorContactRatio(params.mask, params.floorMask, params.width, params.height);
  if (beforePixels === 0 || beforeFloorContactRatio >= params.targetFloorContactRatio) {
    return {
      mask: Buffer.from(params.mask),
      beforeFloorContactRatio,
      afterFloorContactRatio: beforeFloorContactRatio,
      beforePixels,
      afterPixels: beforePixels,
      addedPixels: 0,
      iterations: 0,
    };
  }

  const working = Buffer.from(params.mask);
  const maxGrowthPixels = Math.max(1, Math.floor(beforePixels * Math.max(0.05, params.maxGrowthRatio)));
  let addedPixels = 0;
  let iterations = 0;

  for (let iter = 0; iter < Math.max(1, params.maxIterations); iter += 1) {
    iterations = iter + 1;
    let passAdded = 0;

    for (let x = 0; x < params.width; x += 1) {
      let bottomY = -1;
      for (let y = params.height - 1; y >= 0; y -= 1) {
        if (working[(y * params.width) + x] > 0) {
          bottomY = y;
          break;
        }
      }
      if (bottomY < 0) {
        continue;
      }

      const probeMaxY = Math.min(params.height - 1, bottomY + params.maxDropPixels);
      let alreadyGrounded = false;
      for (let y = bottomY; y <= probeMaxY; y += 1) {
        if (params.floorMask[(y * params.width) + x] > 0) {
          alreadyGrounded = true;
          break;
        }
      }
      if (alreadyGrounded) {
        continue;
      }

      let bestTarget: { tx: number; ty: number; cost: number } | null = null;
      for (let dx = -params.maxHorizontalReach; dx <= params.maxHorizontalReach; dx += 1) {
        const tx = x + dx;
        if (tx < 0 || tx >= params.width) {
          continue;
        }
        for (let ty = bottomY + 1; ty <= probeMaxY; ty += 1) {
          if (params.floorMask[(ty * params.width) + tx] === 0) {
            continue;
          }
          const vertical = ty - bottomY;
          const cost = (vertical * 3) + Math.abs(dx);
          if (!bestTarget || cost < bestTarget.cost) {
            bestTarget = { tx, ty, cost };
          }
          break;
        }
      }

      if (!bestTarget) {
        continue;
      }

      const startY = bottomY + 1;
      const dy = Math.max(0, bestTarget.ty - startY);
      const dx = bestTarget.tx - x;
      const steps = Math.max(1, Math.max(Math.abs(dx), dy));
      for (let step = 0; step <= steps; step += 1) {
        const xx = Math.max(0, Math.min(params.width - 1, Math.round(x + ((dx * step) / steps))));
        const yy = Math.max(0, Math.min(params.height - 1, Math.round(startY + ((dy * step) / steps))));
        const idx = (yy * params.width) + xx;
        if (params.floorMask[idx] === 0 || working[idx] > 0) {
          continue;
        }
        working[idx] = 255;
        passAdded += 1;
        addedPixels += 1;
        if (addedPixels >= maxGrowthPixels) {
          break;
        }
      }

      if (addedPixels >= maxGrowthPixels) {
        break;
      }
    }

    const ratio = measureFloorContactRatio(working, params.floorMask, params.width, params.height);
    if (ratio >= params.targetFloorContactRatio || passAdded === 0 || addedPixels >= maxGrowthPixels) {
      break;
    }
  }

  const afterFloorContactRatio = measureFloorContactRatio(working, params.floorMask, params.width, params.height);
  return {
    mask: working,
    beforeFloorContactRatio,
    afterFloorContactRatio,
    beforePixels,
    afterPixels: countMaskPixels(working),
    addedPixels,
    iterations,
  };
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

function buildAnchorDistanceHeatmap(width: number, height: number, priorClusters: PriorCluster[]): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  const sigma = Math.max(1, Math.sqrt((width * width) + (height * height)) * 0.14);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maxWeight = 0;
      for (const cluster of priorClusters) {
        const dx = x - cluster.anchorX;
        const dy = y - cluster.anchorY;
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
  alphaRaw: Buffer;
  width: number;
  height: number;
  minComponentPixels: number;
  morphologyCloseRadius: number;
  morphologyOpenRadius: number;
  areaTarget: number;
}): Promise<{
  threshold: number;
  inverted: boolean;
  sourceChannel: "grayscale" | "alpha";
  thresholdedMask: Buffer;
  mask: Buffer;
  labelMap: Int32Array;
  components: ConnectedComponentStats[];
  thresholdScan: Array<{
    sourceChannel: "grayscale" | "alpha";
    threshold: number;
    inverted: boolean;
    occupancyPixels: number;
    occupancyAreaRatio: number;
  }>;
} | null> {
  const thresholdBase = Math.max(1, Math.min(254, Math.round(readNumberEnv("CONTINUITY_GEMINI_MASK_THRESHOLD", 170))));
  const thresholdCandidates = Array.from(new Set([thresholdBase, 250, 192, 128, 96, 64, 32, 16]));

  const candidates: Array<{
    sourceChannel: "grayscale" | "alpha";
    threshold: number;
    inverted: boolean;
    thresholded: Buffer;
    mask: Buffer;
    labelMap: Int32Array;
    components: ConnectedComponentStats[];
    areaRatio: number;
  }> = [];

  for (const sourceChannel of ["grayscale", "alpha"] as const) {
    const sourceRaw = sourceChannel === "alpha" ? params.alphaRaw : params.grayscaleRaw;
    for (const threshold of thresholdCandidates) {
      for (const inverted of [false, true]) {
        const thresholded = Buffer.alloc(sourceRaw.length, 0);
        for (let i = 0; i < sourceRaw.length; i += 1) {
          const lit = sourceRaw[i] >= threshold;
          const isWhite = inverted ? !lit : lit;
          thresholded[i] = isWhite ? 255 : 0;
        }

        let pipeline = sharp(thresholded, {
          raw: { width: params.width, height: params.height, channels: 1 },
        }).threshold(127, { grayscale: true });

        if (params.morphologyCloseRadius > 0) {
          pipeline = pipeline.dilate(params.morphologyCloseRadius).erode(params.morphologyCloseRadius);
        }
        if (params.morphologyOpenRadius > 0) {
          pipeline = pipeline.erode(params.morphologyOpenRadius).dilate(params.morphologyOpenRadius);
        }

        const candidateRaster = await pipeline.raw().toBuffer({ resolveWithObject: true });
        let candidateMask: Buffer = Buffer.from(candidateRaster.data as Uint8Array);
        if ((candidateRaster.info.channels || 1) !== 1) {
          candidateMask = (await sharp(Buffer.from(candidateRaster.data as Uint8Array), {
            raw: {
              width: params.width,
              height: params.height,
              channels: candidateRaster.info.channels || 1,
            },
          })
            .removeAlpha()
            .grayscale()
            .raw()
            .toBuffer()) as Buffer;
        }
        const analyzed = analyzeConnectedComponents(candidateMask, params.width, params.height, params.minComponentPixels);
        const occupancyPixelCount = countMaskPixels(candidateMask);
        if (occupancyPixelCount === 0) {
          continue;
        }
        candidates.push({
          sourceChannel,
          threshold,
          inverted,
          thresholded,
          mask: candidateMask,
          labelMap: analyzed.labelMap,
          components: analyzed.components,
          areaRatio: occupancyPixelCount / (params.width * params.height),
        });
      }
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
    sourceChannel: selected.sourceChannel,
    thresholdedMask: selected.thresholded,
    mask: selected.mask,
    labelMap: selected.labelMap,
    components: selected.components,
    thresholdScan: candidates.map((candidate) => ({
      sourceChannel: candidate.sourceChannel,
      threshold: candidate.threshold,
      inverted: candidate.inverted,
      occupancyPixels: countMaskPixels(candidate.mask),
      occupancyAreaRatio: candidate.areaRatio,
    })),
  };
}

function rankComponents(params: {
  components: ConnectedComponentStats[];
  labelMap: Int32Array;
  candidateMask: Buffer;
  priorCluster: PriorCluster;
  floorMask: Buffer;
  constraintMask: Buffer;
  width: number;
  height: number;
  maxRetainedComponents: number;
}): RankedComponentResult {
  const constraintBlend = Math.max(0.08, Math.min(0.45, readNumberEnv("CONTINUITY_GEMINI_MASK_COMPONENT_CONSTRAINT_BLEND", 0.24)));
  const constraintComponents = analyzeConnectedComponents(params.constraintMask, params.width, params.height, 1).components;
  const scored = params.components.map((component) => {
    const bboxArea = Math.max(1, (component.maxX - component.minX + 1) * (component.maxY - component.minY + 1));
    const compactness = component.pixelCount / bboxArea;
    const componentAreaRatio = component.pixelCount / Math.max(1, params.width * params.height);
    const dx = component.centroidX - params.priorCluster.anchorX;
    const dy = component.centroidY - params.priorCluster.anchorY;
    const dist = Math.sqrt((dx * dx) + (dy * dy));
    const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
    const anchorScore = Math.exp(-(dist / Math.max(1, diag * 0.2)));

    let priorOverlap = 0;
    let floorOverlap = 0;
    let constraintOverlap = 0;
    let wallTouch = 0;
    const wallBand = Math.max(1, Math.floor(params.width * 0.06));
    for (let y = component.minY; y <= component.maxY; y += 1) {
      for (let x = component.minX; x <= component.maxX; x += 1) {
        const idx = y * params.width + x;
        if (params.labelMap[idx] !== component.id || params.candidateMask[idx] === 0) {
          continue;
        }
        if (params.priorCluster.priorMask[idx] > 0) {
          priorOverlap += 1;
        }
        if (params.floorMask[idx] > 0) {
          floorOverlap += 1;
        }
        if (params.constraintMask[idx] > 0) {
          constraintOverlap += 1;
        }
        if (x < wallBand || x >= (params.width - wallBand)) {
          wallTouch += 1;
        }
      }
    }

    const priorOverlapRatio = priorOverlap / Math.max(1, component.pixelCount);
    const floorOverlapRatio = floorOverlap / Math.max(1, component.pixelCount);
    const constraintOverlapRatio = constraintOverlap / Math.max(1, component.pixelCount);
    const constraintAffinity = computeComponentConstraintAffinity({
      component,
      labelMap: params.labelMap,
      constraintMask: params.constraintMask,
      constraintComponents,
      width: params.width,
      height: params.height,
    });
    const wallTouchRatio = wallTouch / Math.max(1, component.pixelCount);
    const supportConfidence = Math.max(priorOverlapRatio, floorOverlapRatio * 0.92);
    const sizeConfidence = Math.min(1, Math.sqrt(componentAreaRatio / Math.max(0.0005, params.priorCluster.expectedAreaRatioMin * 0.45)));

    const score =
      (anchorScore * 0.18)
      + (priorOverlapRatio * 0.16)
      + (floorOverlapRatio * 0.14)
      + (supportConfidence * 0.13)
      + (sizeConfidence * 0.1)
      + (compactness * 0.08)
      + (constraintAffinity * constraintBlend)
      - (wallTouchRatio * 0.15);

    return {
      component,
      score,
      anchorScore,
      priorOverlapRatio,
      floorOverlapRatio,
      constraintOverlapRatio,
      constraintAffinity,
      compactness,
      wallTouchRatio,
    };
  }).sort((left, right) => right.score - left.score);

  const totalPixelCount = Math.max(1, params.width * params.height);
  const baseScoreThreshold = 0.16;
  const recoveryScoreThreshold = params.priorCluster.required ? 0.07 : 0.11;
  const satelliteRescueScoreThreshold = params.priorCluster.required ? 0.05 : 0.09;
  const desiredAreaRatio = params.priorCluster.required
    ? params.priorCluster.expectedAreaRatioMin
    : Math.min(params.priorCluster.expectedAreaRatioMin, params.priorCluster.expectedAreaRatioTarget * 0.8);
  const expandedRetainedLimit = params.priorCluster.required
    ? Math.max(params.maxRetainedComponents, params.maxRetainedComponents * 4)
    : Math.max(params.maxRetainedComponents, params.maxRetainedComponents * 2);

  const accepted: typeof scored = [];
  let acceptedPixelCount = 0;

  for (const entry of scored) {
    const currentAreaRatio = acceptedPixelCount / totalPixelCount;
    const underTarget = currentAreaRatio < desiredAreaRatio;
    const withinBaseLimit = accepted.length < params.maxRetainedComponents;
    const withinRecoveryLimit = accepted.length < expandedRetainedLimit;
    const structurallySupported = (
      entry.priorOverlapRatio >= 0.015
      || entry.floorOverlapRatio >= 0.12
      || entry.anchorScore >= 0.22
      || entry.constraintAffinity >= 0.08
    ) && entry.wallTouchRatio <= 0.55;

    const useBaseRetention = withinBaseLimit && entry.score > baseScoreThreshold;
    const useRecoveryRetention = !useBaseRetention
      && underTarget
      && withinRecoveryLimit
      && entry.score > recoveryScoreThreshold
      && structurallySupported;

    const semanticallyAttachedSatellite = (
      entry.floorOverlapRatio >= 0.08
      || entry.priorOverlapRatio >= 0.012
      || entry.constraintAffinity >= 0.06
      || (entry.anchorScore >= 0.18 && entry.compactness >= 0.08)
    ) && entry.wallTouchRatio <= 0.65;

    const useSatelliteRescue = !useBaseRetention
      && !useRecoveryRetention
      && underTarget
      && withinRecoveryLimit
      && entry.score > satelliteRescueScoreThreshold
      && semanticallyAttachedSatellite;

    if (!useBaseRetention && !useRecoveryRetention && !useSatelliteRescue) {
      continue;
    }

    accepted.push(entry);
    acceptedPixelCount += entry.component.pixelCount;
  }

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
  const floorContactRatio = measureFloorContactRatio(acceptedMask, params.floorMask, params.width, params.height);
  const constraintAffinityScore = computeMaskConstraintAffinity(acceptedMask, params.constraintMask, params.width, params.height);
  const compactnessScore = accepted.length
    ? accepted.reduce((sum, entry) => sum + entry.compactness, 0) / accepted.length
    : 0;

  const acceptedAreaRatio = acceptedPixelCount / totalPixelCount;
  const decisions: ComponentDecision[] = scored.map((entry) => {
    let rejectedReason: string | null = null;
    if (!acceptedIds.has(entry.component.id)) {
      if (acceptedAreaRatio >= desiredAreaRatio) {
        rejectedReason = "target_already_satisfied";
      } else if (entry.score <= recoveryScoreThreshold) {
        rejectedReason = "score_below_recovery_floor";
      } else if (entry.wallTouchRatio > 0.55) {
        rejectedReason = "wall_touch_too_high";
      } else if (entry.constraintAffinity < 0.05) {
        rejectedReason = "low_constraint_affinity";
      } else if (entry.priorOverlapRatio < 0.015 && entry.floorOverlapRatio < 0.12 && entry.anchorScore < 0.22) {
        rejectedReason = "weak_structural_support";
      } else {
        rejectedReason = "recovery_limit_reached";
      }
    }

    return {
      componentId: entry.component.id,
      pixelCount: entry.component.pixelCount,
      areaRatio: entry.component.pixelCount / Math.max(1, params.width * params.height),
      score: entry.score,
      accepted: acceptedIds.has(entry.component.id),
      rejectedReason,
      anchorScore: entry.anchorScore,
      priorOverlapRatio: entry.priorOverlapRatio,
      floorOverlapRatio: entry.floorOverlapRatio,
      constraintOverlapRatio: entry.constraintOverlapRatio,
      compactness: entry.compactness,
      wallTouchRatio: entry.wallTouchRatio,
      minX: entry.component.minX,
      minY: entry.component.minY,
      maxX: entry.component.maxX,
      maxY: entry.component.maxY,
      centroidX: entry.component.centroidX,
      centroidY: entry.component.centroidY,
    };
  });

  return {
    acceptedMask,
    rejectedMask,
    acceptedCount: accepted.length,
    anchorScore,
    floorContactRatio,
    constraintAffinityScore,
    compactnessScore,
    decisions,
  };
}

function computeAdaptiveOccupancyExpectation(params: {
  profile: RoomTypeBandProfile;
  roomType: string;
  priorClusters: PriorCluster[];
}): AdaptiveOccupancyExpectation {
  const normalizedRoomType = normalizeFurnitureType(params.roomType);
  const requiredTargetAreaRatio = params.priorClusters
    .filter((cluster) => cluster.required)
    .reduce((sum, cluster) => sum + cluster.expectedAreaRatioMin, 0);
  const optionalTargetAreaRatio = params.priorClusters
    .filter((cluster) => !cluster.required)
    .reduce((sum, cluster) => sum + cluster.expectedAreaRatioMin, 0);
  const optionalWeight = params.priorClusters.filter((cluster) => !cluster.required).length <= 1 ? 0.2 : 0.35;

  let adaptiveFloor = Math.max(requiredTargetAreaRatio * 0.7, requiredTargetAreaRatio + (optionalTargetAreaRatio * optionalWeight));
  if (normalizedRoomType.includes("office") || normalizedRoomType.includes("study")) {
    adaptiveFloor = Math.max(0.012, adaptiveFloor);
  } else if (normalizedRoomType.includes("living")) {
    adaptiveFloor = Math.max(0.018, adaptiveFloor);
  } else if (normalizedRoomType.includes("bedroom")) {
    adaptiveFloor = Math.max(0.02, adaptiveFloor);
  } else {
    adaptiveFloor = Math.max(0.015, adaptiveFloor);
  }

  return {
    effectiveMinAreaRatio: Math.min(params.profile.minAreaRatio, adaptiveFloor),
    requiredTargetAreaRatio,
    optionalTargetAreaRatio,
    optionalWeight,
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
  constraintAffinityScore: number;
}): AttemptFailureMode {
  if (params.occupancyAreaRatio < params.profile.minAreaRatio) return "too_sparse";
  if (params.occupancyAreaRatio > params.profile.maxAreaRatio) return "too_broad";
  if (params.connectedCount > params.profile.maxComponents) return "fragmented";
  if (params.topRegionRatio > params.profile.maxTopRegionRatio) return "ceiling_heavy";
  if (params.wallTouchRatio > params.profile.maxWallTouchRatio) return "wall_heavy";
  if (params.floorContactRatio < params.profile.minFloorContactRatio) return "low_floor_contact";
  if (params.anchorScore < 0.35) return "low_anchor_relevance";
  if (params.constraintAffinityScore < 0.2) return "low_constraint_affinity";
  return "none";
}

function evaluateQuality(params: {
  occupancyAreaRatio: number;
  connectedCount: number;
  floorContactRatio: number;
  anchorScore: number;
  constraintAffinityScore: number;
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
  const constraintScore = Math.max(0, Math.min(1, params.constraintAffinityScore));
  const wallPenalty = Math.max(0, (params.wallTouchRatio - params.profile.maxWallTouchRatio) * 2.2);
  const topPenalty = Math.max(0, (params.topRegionRatio - params.profile.maxTopRegionRatio) * 2.2);
  const compactnessScore = Math.max(0, Math.min(1, params.compactnessScore));

  const score = Math.max(0,
    (occupancyBandScore * 0.2)
    + (componentCoherenceScore * 0.18)
    + (floorContactScore * 0.18)
    + (anchorScore * 0.16)
    + (constraintScore * 0.16)
    + (compactnessScore * 0.14)
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

function computeMaskOverlapRatio(mask: Buffer, guideMask: Buffer): number {
  let maskPixels = 0;
  let overlapPixels = 0;
  const total = Math.min(mask.length, guideMask.length);
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 0) {
      continue;
    }
    maskPixels += 1;
    if (guideMask[i] > 0) {
      overlapPixels += 1;
    }
  }
  if (maskPixels <= 0) {
    return 0;
  }
  return overlapPixels / maskPixels;
}

function buildStarvationFallbackSeed(params: {
  baseMask: Buffer;
  starvedClusters: StarvationClusterSignal[];
  constraintMask: Buffer;
  supportMask: Buffer;
  width: number;
  height: number;
  maxSeedPixels: number;
}): { seedMask: Buffer; addedPixels: number } {
  const total = params.width * params.height;
  const seedMask = Buffer.alloc(total, 0);
  if (params.maxSeedPixels <= 0 || params.starvedClusters.length === 0) {
    return { seedMask, addedPixels: 0 };
  }

  const candidateMask = Buffer.alloc(total, 0);
  for (const cluster of params.starvedClusters) {
    for (let i = 0; i < total; i += 1) {
      if (cluster.priorMask[i] > 0 && params.constraintMask[i] > 0 && params.supportMask[i] > 0 && params.baseMask[i] === 0) {
        candidateMask[i] = 255;
      }
    }
  }

  const components = analyzeConnectedComponents(candidateMask, params.width, params.height, 6);
  if (components.components.length === 0) {
    return { seedMask, addedPixels: 0 };
  }

  const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
  const epsilon = Math.max(1, diag * 0.18);
  const componentScores = components.components.map((component) => {
    let touchingBase = 0;
    for (let y = component.minY; y <= component.maxY; y += 1) {
      for (let x = component.minX; x <= component.maxX; x += 1) {
        const idx = y * params.width + x;
        if (components.labelMap[idx] !== component.id || candidateMask[idx] === 0) {
          continue;
        }
        const left = x > 0 ? params.baseMask[idx - 1] : 0;
        const right = x < (params.width - 1) ? params.baseMask[idx + 1] : 0;
        const up = y > 0 ? params.baseMask[idx - params.width] : 0;
        const down = y < (params.height - 1) ? params.baseMask[idx + params.width] : 0;
        if (left > 0 || right > 0 || up > 0 || down > 0) {
          touchingBase += 1;
        }
      }
    }

    const bestAnchorAffinity = params.starvedClusters.reduce((best, cluster) => {
      const dx = component.centroidX - cluster.anchorX;
      const dy = component.centroidY - cluster.anchorY;
      const dist = Math.sqrt((dx * dx) + (dy * dy));
      return Math.max(best, Math.exp(-(dist / epsilon)));
    }, 0);
    const continuityAffinity = touchingBase > 0 ? Math.min(1, touchingBase / Math.max(1, component.pixelCount * 0.22)) : 0;
    const score = (bestAnchorAffinity * 0.62) + (continuityAffinity * 0.38);
    return {
      componentId: component.id,
      pixelCount: component.pixelCount,
      score,
      requiredSignal: params.starvedClusters.some((cluster) => cluster.required),
    };
  }).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.pixelCount - a.pixelCount;
  });

  let remaining = params.maxSeedPixels;
  for (const entry of componentScores) {
    if (remaining <= 0) {
      break;
    }
    if (entry.pixelCount > remaining) {
      continue;
    }
    for (let i = 0; i < total; i += 1) {
      if (components.labelMap[i] === entry.componentId && candidateMask[i] > 0) {
        seedMask[i] = 255;
      }
    }
    remaining -= entry.pixelCount;
  }

  if (countMaskPixels(seedMask) === 0 && componentScores.length > 0) {
    const best = componentScores[0];
    for (let i = 0; i < total; i += 1) {
      if (components.labelMap[i] === best.componentId && candidateMask[i] > 0) {
        seedMask[i] = 255;
      }
    }
    const seeded = countMaskPixels(seedMask);
    if (seeded > params.maxSeedPixels && params.maxSeedPixels > 0) {
      let kept = 0;
      for (let i = 0; i < total; i += 1) {
        if (seedMask[i] === 0) {
          continue;
        }
        kept += 1;
        if (kept > params.maxSeedPixels) {
          seedMask[i] = 0;
        }
      }
    }
  }

  const addedPixels = countMaskPixels(seedMask);
  return { seedMask, addedPixels };
}

function buildConservativeFallbackMask(priorClusters: PriorCluster[], floorMask: Buffer, width: number, height: number): Buffer {
  const output = Buffer.alloc(width * height, 0);
  for (const cluster of priorClusters) {
    const radius = Math.max(6, Math.round(Math.sqrt(width * height * cluster.expectedAreaRatioTarget) * 0.18));
    const cx = Math.round(cluster.anchorX);
    const cy = Math.round(cluster.anchorY);
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
  constraintAffinityScore: number;
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
  const floorContactRatio = measureFloorContactRatio(params.mask, params.floorMask, params.width, params.height);
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
    constraintAffinityScore: params.constraintAffinityScore,
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
    constraintAffinityScore: params.constraintAffinityScore,
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

async function resizeBinaryMaskRaw(params: {
  mask: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}): Promise<Buffer> {
  if (params.sourceWidth === params.targetWidth && params.sourceHeight === params.targetHeight) {
    return Buffer.from(params.mask);
  }

  return sharp(params.mask, {
    raw: { width: params.sourceWidth, height: params.sourceHeight, channels: 1 },
  })
    .resize(params.targetWidth, params.targetHeight, { fit: "fill", kernel: sharp.kernel.nearest })
    .removeAlpha()
    .grayscale()
    .threshold(1, { grayscale: true })
    .raw()
    .toBuffer();
}

async function writeOverlayImage(baseImagePath: string, rgba: Buffer, width: number, height: number, outputPath: string): Promise<void> {
  await sharp(baseImagePath)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
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
  const morphologyCloseRadius = Math.max(0, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MORPH_CLOSE_RADIUS", morphologyRadius || 1)));
  const morphologyOpenRadius = Math.max(0, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MORPH_OPEN_RADIUS", 0)));
  const topologyCloseRadius = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_CLOSE_RADIUS", 1)));
  const topologyMaxCloseRadius = Math.max(topologyCloseRadius, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MAX_CLOSE_RADIUS", 3)));
  const topologyMinIslandRatio = Math.max(0, Math.min(0.005, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_ISLAND_RATIO", 0.00008)));
  const topologyMaxAreaExpansionRatio = Math.max(1, Math.min(1.8, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MAX_AREA_EXPANSION", 1.3)));
  const topologyMinFinalAreaFactor = Math.max(0.7, Math.min(1.6, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_MIN_FINAL_AREA_FACTOR", 1.0)));
  const floorProjectionEnabled = !parseBooleanEnv(process.env.CONTINUITY_GEMINI_MASK_DISABLE_FLOOR_PROJECTION);
  const floorProjectionMaxDropPixels = Math.max(4, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_FLOOR_PROJECTION_MAX_DROP_PIXELS", 96)));
  const floorProjectionHorizontalReach = Math.max(0, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_FLOOR_PROJECTION_HORIZONTAL_REACH", 2)));
  const floorProjectionMaxGrowthRatio = Math.max(0.05, Math.min(2.5, readNumberEnv("CONTINUITY_GEMINI_MASK_FLOOR_PROJECTION_MAX_GROWTH_RATIO", 1.4)));
  const floorProjectionMaxIterations = Math.max(1, Math.min(6, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_FLOOR_PROJECTION_MAX_ITERATIONS", 3))));
  const maxRetainedComponents = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_RETAINED_COMPONENTS", 6)));
  const maxAttempts = Math.max(1, Math.floor(readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_RETRIES", 3)));
  const requestedMaxOccupancyEdge = readNumberEnv("CONTINUITY_GEMINI_MASK_MAX_EDGE", 1536);
  const memoryDebugEnabled = isGeminiMaskMemoryDebugEnabled();
  const invocationKey = `${params.jobId}:${params.imageId}`;
  const invocationCount = (geminiOccupancyInvocationCounts.get(invocationKey) || 0) + 1;
  geminiOccupancyInvocationCounts.set(invocationKey, invocationCount);

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_INVOCATION]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    invocationKey,
    invocationCount,
    pid: process.pid,
    model,
  });

  logGeminiMaskMemory({
    enabled: memoryDebugEnabled,
    phase: "start",
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
    extra: {
      model,
      maxAttempts,
      maxRetainedComponents,
      morphologyRadius,
      morphologyCloseRadius,
      morphologyOpenRadius,
      minComponentPixels,
    },
  });

  const metadata = await sharp(params.secondaryImagePath).metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  if (!sourceWidth || !sourceHeight) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for Gemini occupancy generation",
      "gemini_occupancy_mask_missing_dimensions"
    );
  }

  const processingDims = resolveOccupancyProcessingDimensions({
    sourceWidth,
    sourceHeight,
    requestedMaxEdge: requestedMaxOccupancyEdge,
  });
  const width = processingDims.width;
  const height = processingDims.height;

  // Reduce sharp cache pressure for high-frequency occupancy transforms.
  sharp.cache({ memory: 0, files: 0, items: 0 });

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_DIMS]", {
    phase: "source-metadata",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    sourceWidth,
    sourceHeight,
    processingWidth: width,
    processingHeight: height,
    occupancyScale: Number(processingDims.scale.toFixed(4)),
    maxOccupancyEdge: processingDims.maxEdge,
    estimatedSourceSingleChannelBytes: estimateBytes({ width: sourceWidth, height: sourceHeight, channels: 1 }),
    estimatedSourceRgbaBytes: estimateBytes({ width: sourceWidth, height: sourceHeight, channels: 4 }),
    estimatedProcessingSingleChannelBytes: estimateBytes({ width, height, channels: 1 }),
    estimatedProcessingRgbaBytes: estimateBytes({ width, height, channels: 4 }),
  });

  const profile = getRoomTypeBandProfile(params.plan.roomType);
  const adaptiveFloorTarget = resolveAdaptiveFloorContactTarget(params.plan, profile);
  const effectiveFloorContactMin = parseBooleanEnv(process.env.CONTINUITY_GEMINI_MASK_DISABLE_ADAPTIVE_FLOOR_TARGET)
    ? profile.minFloorContactRatio
    : adaptiveFloorTarget.effectiveMinFloorContactRatio;
  const floorMask = await buildFloorPriorMask(params.plan, width, height);
  const supportSurfaceMask = await buildSupportSurfaceMask(params.plan, floorMask, width, height);
  const deterministicConstraintMaskSource = await buildDeterministicConstraintMask(params.plan, sourceWidth, sourceHeight);
  const deterministicConstraintMask = await resizeBinaryMaskRaw({
    mask: deterministicConstraintMaskSource,
    sourceWidth,
    sourceHeight,
    targetWidth: width,
    targetHeight: height,
  });
  const priorClusters = await buildPriorClusters(params.plan, width, height, floorMask);
  const geometryRecoveryProfile = deriveGeometryAdaptiveRecoveryProfile({
    plan: params.plan,
    priorClusters,
    deterministicConstraintMask,
    width,
    height,
  });
  const adaptiveExpectation = computeAdaptiveOccupancyExpectation({
    profile,
    roomType: params.plan.roomType,
    priorClusters,
  });

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_GEOMETRY_ADAPTIVE_RECOVERY]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    projectionAreaRatio: Number(geometryRecoveryProfile.projectionAreaRatio.toFixed(4)),
    projectionCompactness: Number(geometryRecoveryProfile.projectionCompactness.toFixed(4)),
    floorGuideConfidence: Number(geometryRecoveryProfile.floorGuideConfidence.toFixed(4)),
    requiredClusterDensity: Number(geometryRecoveryProfile.requiredClusterDensity.toFixed(4)),
    areaRecoveryMaxGrowthRatio: Number(geometryRecoveryProfile.areaRecoveryMaxGrowthRatio.toFixed(3)),
    areaRecoveryMaxIterations: geometryRecoveryProfile.areaRecoveryMaxIterations,
    floorDropMultiplier: Number(geometryRecoveryProfile.floorDropMultiplier.toFixed(3)),
    floorHorizontalBonus: geometryRecoveryProfile.floorHorizontalBonus,
    floorGrowthMultiplier: Number(geometryRecoveryProfile.floorGrowthMultiplier.toFixed(3)),
    floorIterationBonus: geometryRecoveryProfile.floorIterationBonus,
  });

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_FLOOR_TARGET]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    baseMinFloorContactRatio: profile.minFloorContactRatio,
    effectiveMinFloorContactRatio: effectiveFloorContactMin,
    rugZoneCount: adaptiveFloorTarget.rugZoneCount,
    rugAreaRatio: Number(adaptiveFloorTarget.rugAreaRatio.toFixed(4)),
    reductionApplied: Number(adaptiveFloorTarget.reductionApplied.toFixed(4)),
    adaptiveDisabled: parseBooleanEnv(process.env.CONTINUITY_GEMINI_MASK_DISABLE_ADAPTIVE_FLOOR_TARGET),
  });

  const outDir = path.dirname(params.occupancyMaskPath);
  const rawMaskPath = path.join(outDir, "gemini-occupancy-mask-raw.png");
  const cleanedMaskPath = path.join(outDir, "gemini-occupancy-mask-cleaned.png");
  const componentsPath = path.join(outDir, "occupancy-mask-components.png");
  const alphaHeatmapPath = path.join(outDir, "alpha-heatmap.png");
  const alphaHistogramPath = path.join(outDir, "alpha-histogram.json");
  const occupancyMetricDebugPath = path.join(outDir, "occupancy-metric-debug.json");
  const stageComparisonPath = path.join(outDir, "occupancy-stage-comparison.png");
  const occupancyCollapseAnalysisPath = path.join(outDir, "occupancy-collapse-analysis.json");
  const occupancyStageGridPath = path.join(outDir, "occupancy-stage-grid.png");
  const componentAnalysisPath = path.join(outDir, "component-analysis.json");
  const componentRetainedPath = path.join(outDir, "component-retained.png");
  const componentRemovedPath = path.join(outDir, "component-removed.png");
  const qualityReportPath = path.join(outDir, "occupancy-quality-report.json");
  const retryComparisonPath = path.join(outDir, "occupancy-retry-comparison.json");
  const anchorDistanceHeatmapPath = path.join(outDir, "anchor-distance-heatmap.png");
  const floorContactVisualizationPath = path.join(outDir, "floor-contact-visualization.png");
  const acceptedRejectedOverlayPath = path.join(outDir, "accepted-vs-rejected-components.png");
  const deterministicConstraintMaskPath = path.join(outDir, "deterministic-constraint-mask.png");
  const clusterMaskDir = path.join(outDir, "cluster-occupancy-masks");
  const stageDebugDir = path.join(outDir, "occupancy-stage-debug");
  await fs.mkdir(clusterMaskDir, { recursive: true });
  await fs.mkdir(stageDebugDir, { recursive: true });
  await writeMaskPng(deterministicConstraintMask, width, height, deterministicConstraintMaskPath);

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_CONSTRAINT_AFFINITY]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    deterministicConstraintSourceAreaRatio: Number((countMaskPixels(deterministicConstraintMaskSource) / Math.max(1, sourceWidth * sourceHeight)).toFixed(4)),
    deterministicConstraintAreaRatio: Number((countMaskPixels(deterministicConstraintMask) / Math.max(1, width * height)).toFixed(4)),
    deterministicConstraintMaskPath,
  });

  const secondaryImage = toBase64(params.secondaryImagePath);
  const masterImage = toBase64(params.masterImagePath);
  const deterministicConstraintGuidePng = await sharp(deterministicConstraintMask, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  const deterministicConstraintGuideBase64 = deterministicConstraintGuidePng.toString("base64");

  logGeminiMaskMemory({
    enabled: memoryDebugEnabled,
    phase: "inputs-encoded",
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
    extra: {
      width,
      height,
      sourceWidth,
      sourceHeight,
      occupancyScale: Number(processingDims.scale.toFixed(4)),
      clusterCount: priorClusters.length,
      secondaryBase64Length: secondaryImage.data.length,
      masterBase64Length: masterImage.data.length,
    },
  });

  const ai = getVertexGenAiClient();

  const clusterSummaries: ClusterAttemptSummary[] = [];
  const starvationSignals: StarvationClusterSignal[] = [];
  const stageMetricsByCluster = new Map<string, OccupancyStageMetric[]>();
  const componentAuditByCluster = new Map<string, {
    clusterId: string;
    clusterRole: "required" | "optional";
    decisions: ComponentDecision[];
  }>();
  const clusterContributions: ClusterContributionSummary[] = [];
  const perClusterMaskPaths: string[] = [];
  const clusterDebugArtifacts: Array<{
    clusterId: string;
    measurementStage: string;
    alphaAware: boolean;
    threshold: number;
    artifactPath: string;
    rawGeminiMaskPath: string;
    thresholdedMaskPath: string;
    alphaNormalizedMaskPath: string;
    morphologyCleanedMaskPath: string;
    componentFilteredMaskPath: string;
    acceptedClusterMaskPath: string;
    alphaHeatmapPath: string;
    alphaHistogramPath: string;
    stageComparisonPath: string;
  }> = [];
  let unionAccepted = Buffer.alloc(width * height, 0);
  let unionRejected = Buffer.alloc(width * height, 0);
  let unionRawBest = Buffer.alloc(width * height, 0);
  let clusterApiCallCount = 0;

  for (const priorCluster of priorClusters) {
    let bestClusterMask: Buffer = Buffer.alloc(width * height, 0);
    let bestClusterRawMask: Buffer = Buffer.alloc(width * height, 0);
    let bestClusterScore = -1;
    let bestClusterThreshold = 170;
    let bestClusterInversion = false;
    let clusterRateLimitFailures = 0;
    let clusterFailureMode: AttemptFailureMode = "none";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = buildOccupancyPrompt(params.plan, priorCluster, clusterFailureMode);
      let run: Awaited<ReturnType<typeof runWithSelectedImageModel>>;
      logGeminiMaskMemory({
        enabled: memoryDebugEnabled,
        phase: "cluster-attempt-before-model",
        continuityGroupId: params.continuityGroupId,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        attempt,
      });
      try {
        clusterApiCallCount += 1;
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
                  { text: "DETERMINISTIC_PROJECTION_GUIDE" },
                  { inlineData: { mimeType: "image/png", data: deterministicConstraintGuideBase64 } },
                  { text: "TARGET_CLUSTER_PRIOR" },
                  { inlineData: { mimeType: "image/png", data: priorCluster.priorMaskPngBase64 } },
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
          context: "continuity_gemini_occupancy_mask_cluster",
          meta: {
            jobId: params.jobId,
            imageId: params.imageId,
            stage: "2",
            attempt,
            reason: `continuity_occupancy_mask_cluster_${priorCluster.clusterId}`,
            callType: "image_generation",
          },
        });
        logGeminiMaskMemory({
          enabled: memoryDebugEnabled,
          phase: "cluster-attempt-after-model",
          continuityGroupId: params.continuityGroupId,
          imageId: params.imageId,
          jobId: params.jobId,
          clusterId: priorCluster.clusterId,
          attempt,
        });
      } catch (error) {
        if (!isRateLimitedError(error)) {
          throw error;
        }

        clusterRateLimitFailures += 1;
        nLog("[VERTEX_CONTINUITY_GEMINI_CLUSTER_RETRY]", {
          continuityGroupId: params.continuityGroupId || null,
          imageId: params.imageId,
          jobId: params.jobId,
          clusterId: priorCluster.clusterId,
          attempt,
          reason: "rate_limited",
          error: String((error as { message?: unknown }).message || error),
        });

        clusterSummaries.push({
          clusterId: priorCluster.clusterId,
          required: priorCluster.required,
          clusterLabel: priorCluster.clusterLabel,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          constraintAffinityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        clusterFailureMode = "too_sparse";
        await waitMs(Math.min(2500, 400 * attempt));
        continue;
      }

      const parts: any[] = (run.resp as any)?.candidates?.[0]?.content?.parts || [];
      const imagePart = findFirstInlineImagePart(parts);
      if (!imagePart) {
        clusterSummaries.push({
          clusterId: priorCluster.clusterId,
          required: priorCluster.required,
          clusterLabel: priorCluster.clusterLabel,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          constraintAffinityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        clusterFailureMode = "too_sparse";
        continue;
      }

      const rawBuffer = Buffer.from(imagePart.data, "base64");
      logGeminiMaskMemory({
        enabled: memoryDebugEnabled,
        phase: "cluster-attempt-after-base64-decode",
        continuityGroupId: params.continuityGroupId,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        attempt,
        extra: {
          rawBufferBytes: rawBuffer.length,
        },
      });
      const clusterStageDir = path.join(stageDebugDir, priorCluster.clusterId);
      await fs.mkdir(clusterStageDir, { recursive: true });

      const rawGeminiMaskPath = path.join(clusterStageDir, "raw-gemini-mask.png");
      const thresholdedMaskPath = path.join(clusterStageDir, "thresholded-mask.png");
      const alphaNormalizedMaskPath = path.join(clusterStageDir, "alpha-normalized-mask.png");
      const morphologyCleanedMaskPath = path.join(clusterStageDir, "morphology-cleaned-mask.png");
      const componentFilteredMaskPath = path.join(clusterStageDir, "component-filtered-mask.png");
      const acceptedClusterMaskPath = path.join(clusterStageDir, "accepted-cluster-mask.png");
      const alphaHeatmapClusterPath = path.join(clusterStageDir, "alpha-heatmap.png");
      const alphaHistogramClusterPath = path.join(clusterStageDir, "alpha-histogram.json");
      const thresholdComparisonClusterPath = path.join(clusterStageDir, "threshold-comparison.json");
      const occupancyMetricDebugClusterPath = path.join(clusterStageDir, "occupancy-metric-debug.json");
      const componentDebugOverlayPath = path.join(clusterStageDir, "component-debug-overlay.png");
      const stageComparisonClusterPath = path.join(clusterStageDir, "stage-comparison.png");

      const resizedRaw = await sharp(rawBuffer)
        .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
        .png()
        .toBuffer();
      await fs.writeFile(rawGeminiMaskPath, resizedRaw);

      const rawNoAlpha = await sharp(resizedRaw)
        .removeAlpha()
        .grayscale()
        .raw()
        .toBuffer();
      const alpha = await sharp(resizedRaw)
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer();
      const rawVisibleMask = Buffer.alloc(width * height, 0);
      for (let i = 0; i < width * height; i += 1) {
        if (rawNoAlpha[i] > 0 || alpha[i] > 0) {
          rawVisibleMask[i] = 255;
        }
      }
      const gray = rawNoAlpha;

      nLog("[VERTEX_CONTINUITY_GEMINI_MASK_DIMS]", {
        phase: "cluster-transform",
        continuityGroupId: params.continuityGroupId || null,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        attempt,
        width,
        height,
        sourceWidth,
        sourceHeight,
        occupancyScale: Number(processingDims.scale.toFixed(4)),
        rawBufferBytes: rawBuffer.length,
        resizedPngBytes: resizedRaw.length,
        resizedRgbaBytes: estimateBytes({ width, height, channels: 4 }),
        grayBytes: gray.length,
        alphaBytes: alpha.length,
        expectedGrayBytes: estimateBytes({ width, height, channels: 1 }),
        expectedRgbaBytes: estimateBytes({ width, height, channels: 4 }),
      });

      logGeminiMaskMemory({
        enabled: memoryDebugEnabled,
        phase: "cluster-attempt-after-channel-extraction",
        continuityGroupId: params.continuityGroupId,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        attempt,
      });

      const alphaHistogram = buildAlphaHistogram(alpha);
      await fs.writeFile(alphaHistogramClusterPath, JSON.stringify(alphaHistogram, null, 2));
      await writeRgbaPng(buildAlphaHeatmapRgba(alpha, width, height), width, height, alphaHeatmapClusterPath);

      const selected = await selectBinarizationCandidate({
        grayscaleRaw: gray,
        alphaRaw: alpha,
        width,
        height,
        minComponentPixels,
        morphologyCloseRadius,
        morphologyOpenRadius,
        areaTarget: priorCluster.expectedAreaRatioTarget,
      });

      if (!selected) {
        releaseBuffer(rawBuffer);
        releaseBuffer(resizedRaw);
        releaseBuffer(rawNoAlpha);
        releaseBuffer(alpha);
        releaseBuffer(rawVisibleMask);
        clusterSummaries.push({
          clusterId: priorCluster.clusterId,
          required: priorCluster.required,
          clusterLabel: priorCluster.clusterLabel,
          attempt,
          failureMode: "too_sparse",
          score: 0,
          occupancyAreaRatio: 0,
          connectedComponentCount: 0,
          floorContactRatio: 0,
          wallTouchRatio: 0,
          topRegionRatio: 0,
          anchorProximityScore: 0,
          constraintAffinityScore: 0,
          selectedThreshold: 0,
          selectedInversion: false,
        });
        clusterFailureMode = "too_sparse";
        continue;
      }

      logGeminiMaskMemory({
        enabled: memoryDebugEnabled,
        phase: "cluster-attempt-after-binarization",
        continuityGroupId: params.continuityGroupId,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        attempt,
        extra: {
          selectedThreshold: selected.threshold,
          selectedChannel: selected.sourceChannel,
          selectedInverted: selected.inverted,
        },
      });

      await writeMaskPng(selected.thresholdedMask, width, height, thresholdedMaskPath);
      const alphaNormalizedMask = Buffer.alloc(alpha.length, 0);
      for (let i = 0; i < alpha.length; i += 1) {
        alphaNormalizedMask[i] = alpha[i] > 0 ? 255 : 0;
      }
      await writeMaskPng(alphaNormalizedMask, width, height, alphaNormalizedMaskPath);
      await writeMaskPng(selected.mask, width, height, morphologyCleanedMaskPath);

      const preFilterAnalysis = analyzeConnectedComponents(selected.mask, width, height, 1);
      const postFilterAnalysis = analyzeConnectedComponents(selected.mask, width, height, minComponentPixels);
      const retainedIds = new Set(postFilterAnalysis.components.map((component) => component.id));
      const componentFilteredMask = keepAllowedComponents(selected.mask, preFilterAnalysis.labelMap, retainedIds);
      await writeMaskPng(componentFilteredMask, width, height, componentFilteredMaskPath);

      const componentOverlay = buildComponentOverlay(componentFilteredMask, width, height);
      await writeRgbaPng(componentOverlay, width, height, componentDebugOverlayPath);

      const ranked = rankComponents({
        components: postFilterAnalysis.components,
        labelMap: postFilterAnalysis.labelMap,
        candidateMask: componentFilteredMask,
        priorCluster,
        floorMask: supportSurfaceMask,
        constraintMask: deterministicConstraintMask,
        width,
        height,
        maxRetainedComponents,
      });

      const clusterMask = Buffer.from(ranked.acceptedMask);
      await writeMaskPng(clusterMask, width, height, acceptedClusterMaskPath);
      const occupancyAreaRatio = countMaskPixels(clusterMask) / (width * height);
      const connected = analyzeConnectedComponents(clusterMask, width, height, 1).components.length;
      const wallTouchRatio = measureWallTouchRatio(clusterMask, width, height);
      const topRegionRatio = measureTopRegionRatio(clusterMask, width, height);
      const floorContactRatio = ranked.floorContactRatio;
      const anchorScore = ranked.anchorScore;
      const constraintAffinityScore = ranked.constraintAffinityScore;

      const failureMode = classifyFailureMode({
        occupancyAreaRatio,
        profile: {
          ...profile,
          minAreaRatio: priorCluster.expectedAreaRatioMin,
          targetAreaRatio: priorCluster.expectedAreaRatioTarget,
          maxAreaRatio: priorCluster.expectedAreaRatioMax,
        },
        connectedCount: connected,
        wallTouchRatio,
        topRegionRatio,
        floorContactRatio,
        anchorScore,
        constraintAffinityScore,
      });

      const thresholdComparison = selected.thresholdScan;
      await fs.writeFile(thresholdComparisonClusterPath, JSON.stringify(thresholdComparison, null, 2));

      const occupiedPixelCountRaw = countMaskPixels(selected.mask);
      const occupiedPixelCountThresholded = countMaskPixels(selected.thresholdedMask);
      const occupiedPixelCountAlpha = countMaskPixels(alphaNormalizedMask);
      const occupiedPixelCountComponentFiltered = countMaskPixels(componentFilteredMask);
      const occupiedPixelCountAccepted = countMaskPixels(clusterMask);

      const measurementStage = selected.sourceChannel === "alpha" ? "alpha_normalized_mask" : "thresholded_mask";
      const clusterRole = priorCluster.required ? "required" : "optional";
      const stageMetrics: OccupancyStageMetric[] = [
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "raw_gemini_mask",
          mask: rawVisibleMask,
          width,
          height,
        }),
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "alpha_normalized_mask",
          mask: alphaNormalizedMask,
          width,
          height,
        }),
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "thresholded_mask",
          mask: selected.thresholdedMask,
          width,
          height,
        }),
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "morphology_cleaned_mask",
          mask: selected.mask,
          width,
          height,
        }),
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "component_filtered_mask",
          mask: componentFilteredMask,
          width,
          height,
        }),
        computeStageMetric({
          clusterId: priorCluster.clusterId,
          clusterRole,
          stage: "accepted_cluster_mask",
          mask: clusterMask,
          width,
          height,
          rejectedReason: failureMode === "none" ? null : failureMode,
        }),
      ];
      stageMetricsByCluster.set(priorCluster.clusterId, stageMetrics);
      componentAuditByCluster.set(priorCluster.clusterId, {
        clusterId: priorCluster.clusterId,
        clusterRole,
        decisions: ranked.decisions,
      });

      const clusterDebug = {
        clusterId: priorCluster.clusterId,
        clusterLabel: priorCluster.clusterLabel,
        required: priorCluster.required,
        measurementStage: "final_union_mask",
        alphaAware: selected.sourceChannel === "alpha",
        threshold: selected.threshold,
        inversion: selected.inverted,
        selectedSourceChannel: selected.sourceChannel,
        width,
        height,
        normalizationWidth: width,
        normalizationHeight: height,
        normalizationSource: "gemini_resized_output",
        alphaHistogram,
        stageMetrics: [
          {
            measurementStage: "raw_gemini_mask",
            occupancyPixels: countMaskPixels(rawVisibleMask),
            totalPixels: width * height,
            occupancyAreaRatio: countMaskPixels(rawVisibleMask) / (width * height),
            width,
            height,
            alphaAware: true,
            threshold: null,
            artifactPath: rawGeminiMaskPath,
            componentCount: preFilterAnalysis.components.length,
          },
          {
            measurementStage: "alpha_normalized_mask",
            occupancyPixels: occupiedPixelCountAlpha,
            totalPixels: width * height,
            occupancyAreaRatio: occupiedPixelCountAlpha / (width * height),
            width,
            height,
            alphaAware: true,
            threshold: 1,
            artifactPath: alphaNormalizedMaskPath,
            componentCount: preFilterAnalysis.components.length,
          },
          {
            measurementStage: "thresholded_mask",
            occupancyPixels: occupiedPixelCountThresholded,
            totalPixels: width * height,
            occupancyAreaRatio: occupiedPixelCountThresholded / (width * height),
            width,
            height,
            alphaAware: selected.sourceChannel === "alpha",
            threshold: selected.threshold,
            artifactPath: thresholdedMaskPath,
            componentCount: preFilterAnalysis.components.length,
          },
          {
            measurementStage: "morphology_cleaned_mask",
            occupancyPixels: occupiedPixelCountRaw,
            totalPixels: width * height,
            occupancyAreaRatio: occupiedPixelCountRaw / (width * height),
            width,
            height,
            alphaAware: selected.sourceChannel === "alpha",
            threshold: selected.threshold,
            artifactPath: morphologyCleanedMaskPath,
            componentCount: preFilterAnalysis.components.length,
          },
          {
            measurementStage: "component_filtered_mask",
            occupancyPixels: occupiedPixelCountComponentFiltered,
            totalPixels: width * height,
            occupancyAreaRatio: occupiedPixelCountComponentFiltered / (width * height),
            width,
            height,
            alphaAware: selected.sourceChannel === "alpha",
            threshold: selected.threshold,
            artifactPath: componentFilteredMaskPath,
            componentCount: postFilterAnalysis.components.length,
          },
          {
            measurementStage: "accepted_cluster_mask",
            occupancyPixels: occupiedPixelCountAccepted,
            totalPixels: width * height,
            occupancyAreaRatio: occupiedPixelCountAccepted / (width * height),
            width,
            height,
            alphaAware: selected.sourceChannel === "alpha",
            threshold: selected.threshold,
            artifactPath: acceptedClusterMaskPath,
            componentCount: analyzeConnectedComponents(clusterMask, width, height, 1).components.length,
          },
        ],
        componentDecisionSummary: ranked.decisions,
      };
      await fs.writeFile(occupancyMetricDebugClusterPath, JSON.stringify(clusterDebug, null, 2));
      clusterDebugArtifacts.push({
        clusterId: priorCluster.clusterId,
        measurementStage,
        alphaAware: selected.sourceChannel === "alpha",
        threshold: selected.threshold,
        artifactPath: occupancyMetricDebugClusterPath,
        rawGeminiMaskPath,
        thresholdedMaskPath,
        alphaNormalizedMaskPath,
        morphologyCleanedMaskPath,
        componentFilteredMaskPath,
        acceptedClusterMaskPath,
        alphaHeatmapPath: alphaHeatmapClusterPath,
        alphaHistogramPath: alphaHistogramClusterPath,
        stageComparisonPath: stageComparisonClusterPath,
      });

      await writeRgbaPng(
        buildStageComparisonRgba({
          rawMask: alphaNormalizedMask,
          thresholdedMask: selected.thresholdedMask,
          alphaNormalizedMask,
          morphologyCleanedMask: selected.mask,
          componentFilteredMask,
          acceptedClusterMask: clusterMask,
          finalUnionMask: unionAccepted,
          width,
          height,
        }),
        width,
        height * 7,
        stageComparisonClusterPath,
      );

      const quality = evaluateQuality({
        occupancyAreaRatio,
        connectedCount: connected,
        floorContactRatio,
        anchorScore,
        constraintAffinityScore,
        wallTouchRatio,
        topRegionRatio,
        compactnessScore: ranked.compactnessScore,
        profile: {
          ...profile,
          minAreaRatio: priorCluster.expectedAreaRatioMin,
          targetAreaRatio: priorCluster.expectedAreaRatioTarget,
          maxAreaRatio: priorCluster.expectedAreaRatioMax,
        },
      });

      clusterSummaries.push({
        clusterId: priorCluster.clusterId,
        required: priorCluster.required,
        clusterLabel: priorCluster.clusterLabel,
        attempt,
        failureMode,
        score: quality.score,
        occupancyAreaRatio,
        connectedComponentCount: connected,
        floorContactRatio,
        wallTouchRatio,
        topRegionRatio,
        anchorProximityScore: anchorScore,
        constraintAffinityScore,
        selectedThreshold: selected.threshold,
        selectedInversion: selected.inverted,
      });

      if (quality.score > bestClusterScore) {
        bestClusterScore = quality.score;
        bestClusterMask = Buffer.from(clusterMask);
        bestClusterRawMask = Buffer.from(selected.mask);
        bestClusterThreshold = selected.threshold;
        bestClusterInversion = selected.inverted;
      }

      releaseBuffer(rawBuffer);
      releaseBuffer(resizedRaw);
      releaseBuffer(rawNoAlpha);
      releaseBuffer(alpha);
      releaseBuffer(rawVisibleMask);

      if (failureMode === "none") {
        logGeminiMaskMemory({
          enabled: memoryDebugEnabled,
          phase: "cluster-attempt-accepted",
          continuityGroupId: params.continuityGroupId,
          imageId: params.imageId,
          jobId: params.jobId,
          clusterId: priorCluster.clusterId,
          attempt,
          extra: {
            qualityScore: Number(quality.score.toFixed(4)),
            occupancyAreaRatio: Number(occupancyAreaRatio.toFixed(4)),
          },
        });
        break;
      }
      clusterFailureMode = failureMode;
    }

    if (bestClusterScore < 0) {
      const retryExhausted = clusterRateLimitFailures >= maxAttempts;
      starvationSignals.push({
        clusterId: priorCluster.clusterId,
        required: priorCluster.required,
        clusterLabel: priorCluster.clusterLabel,
        anchorX: priorCluster.anchorX,
        anchorY: priorCluster.anchorY,
        expectedAreaRatioMin: priorCluster.expectedAreaRatioMin,
        expectedAreaRatioTarget: priorCluster.expectedAreaRatioTarget,
        rateLimitFailures: clusterRateLimitFailures,
        retryExhausted,
        priorMask: Buffer.from(priorCluster.priorMask),
      });

      nLog("[VERTEX_CONTINUITY_GEMINI_CLUSTER_SKIP]", {
        continuityGroupId: params.continuityGroupId || null,
        imageId: params.imageId,
        jobId: params.jobId,
        clusterId: priorCluster.clusterId,
        required: priorCluster.required,
        rateLimitFailures: clusterRateLimitFailures,
        retryExhausted,
      });
      continue;
    }

    unionAccepted = Buffer.from(safeMaskUnion(unionAccepted, bestClusterMask));
    unionRawBest = Buffer.from(safeMaskUnion(unionRawBest, bestClusterRawMask));
    const contributionPixels = countMaskPixels(bestClusterMask);
    clusterContributions.push({
      clusterId: priorCluster.clusterId,
      role: priorCluster.required ? "required" : "optional",
      contributionRatio: contributionPixels / Math.max(1, width * height),
      includedInFinalUnion: contributionPixels > 0,
      acceptedOccupancyRatio: contributionPixels / Math.max(1, width * height),
      mergedUnionRatioAfterCluster: countMaskPixels(unionAccepted) / Math.max(1, width * height),
    });

    const existingMetrics = stageMetricsByCluster.get(priorCluster.clusterId) || [];
    existingMetrics.push(
      computeStageMetric({
        clusterId: priorCluster.clusterId,
        clusterRole: priorCluster.required ? "required" : "optional",
        stage: "merged_union_mask",
        mask: unionAccepted,
        width,
        height,
        includedInFinalUnion: contributionPixels > 0,
      }),
    );
    stageMetricsByCluster.set(priorCluster.clusterId, existingMetrics);

    const rejectedForCluster = Buffer.alloc(bestClusterRawMask.length, 0);
    for (let i = 0; i < bestClusterRawMask.length; i += 1) {
      if (bestClusterRawMask[i] > 0 && bestClusterMask[i] === 0) {
        rejectedForCluster[i] = 255;
      }
    }
    unionRejected = Buffer.from(safeMaskUnion(unionRejected, rejectedForCluster));

    const perClusterMaskPath = path.join(clusterMaskDir, `${priorCluster.clusterId}-gemini-mask.png`);
    await writeMaskPng(bestClusterMask, width, height, perClusterMaskPath);
    perClusterMaskPaths.push(perClusterMaskPath);

    nLog("[VERTEX_CONTINUITY_GEMINI_CLUSTER_MASK]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      clusterId: priorCluster.clusterId,
      required: priorCluster.required,
      score: Number(bestClusterScore.toFixed(4)),
      selectedThreshold: bestClusterThreshold,
      selectedInversion: bestClusterInversion,
    });

    logGeminiMaskMemory({
      enabled: memoryDebugEnabled,
      phase: "cluster-merged-into-union",
      continuityGroupId: params.continuityGroupId,
      imageId: params.imageId,
      jobId: params.jobId,
      clusterId: priorCluster.clusterId,
      extra: {
        unionAcceptedPixels: countMaskPixels(unionAccepted),
      },
    });
  }

  let usedConservativeFallback = false;
  let starvationFallbackTelemetry: StarvationFallbackTelemetry = {
    activated: false,
    activationReason: null,
    starvedClusterIds: starvationSignals.map((signal) => signal.clusterId),
    retryExhaustedClusterIds: starvationSignals.filter((signal) => signal.retryExhausted).map((signal) => signal.clusterId),
    seedPixelsAdded: 0,
    seedAreaRatioAdded: 0,
    occupancyInflationPixels: 0,
    occupancyInflationAreaRatio: 0,
    legalityOverlapBefore: computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height),
    legalityOverlapAfter: computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height),
    legalityOverlapDelta: 0,
    supportOverlapBefore: computeMaskOverlapRatio(unionAccepted, supportSurfaceMask),
    supportOverlapAfter: computeMaskOverlapRatio(unionAccepted, supportSurfaceMask),
    supportOverlapDelta: 0,
    targetShortfallPixels: 0,
    maxSeedPixels: 0,
  };

  const topologyMinIslandPixels = Math.max(8, Math.floor(width * height * topologyMinIslandRatio));
  const topologyMinFinalAreaRatio = Math.max(
    0.006,
    Math.min(0.18, adaptiveExpectation.effectiveMinAreaRatio * topologyMinFinalAreaFactor),
  );
  const topologyAnchorBlend = Math.max(0, Math.min(0.28, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_ANCHOR_BLEND", 0.16)));
  const topologySupportBlend = Math.max(0.2, Math.min(0.5, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_SUPPORT_BLEND", 0.34)));
  const topologyConstraintBlend = Math.max(0.08, Math.min(0.42, readNumberEnv("CONTINUITY_GEMINI_MASK_TOPOLOGY_CONSTRAINT_BLEND", 0.24)));
  const topologyAnchorPoints = priorClusters.map((cluster) => ({
    x: cluster.anchorX,
    y: cluster.anchorY,
    weight: cluster.required ? 1.2 : 0.9,
  }));
  const preTopologyPixels = countMaskPixels(unionAccepted);
  const preTopologyAreaRatio = preTopologyPixels / Math.max(1, width * height);
  const topologyStabilized = await stabilizeFragmentedMask({
    mask: unionAccepted,
    supportMask: supportSurfaceMask,
    constraintMask: deterministicConstraintMask,
    anchors: topologyAnchorPoints,
    width,
    height,
    targetMaxComponents: profile.maxComponents,
    closeRadius: topologyCloseRadius,
    maxCloseRadius: topologyMaxCloseRadius,
    minIslandPixels: topologyMinIslandPixels,
    maxAreaExpansionRatio: topologyMaxAreaExpansionRatio,
    minFinalAreaRatio: topologyMinFinalAreaRatio,
  });
  unionAccepted = Buffer.from(topologyStabilized.mask);
  const postTopologyPixels = countMaskPixels(unionAccepted);
  const postTopologyAreaRatio = postTopologyPixels / Math.max(1, width * height);

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_TOPOLOGY_CLEANUP]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    closeRadius: topologyCloseRadius,
    maxCloseRadius: topologyMaxCloseRadius,
    minIslandPixels: topologyMinIslandPixels,
    beforeComponents: topologyStabilized.beforeComponents,
    afterComponents: topologyStabilized.afterComponents,
    beforePixels: topologyStabilized.beforePixels,
    afterPixels: topologyStabilized.afterPixels,
    closePasses: topologyStabilized.closePasses,
    largestTrimApplied: topologyStabilized.largestTrimApplied,
    islandsRemoved: topologyStabilized.islandsRemoved,
    satelliteIslandsRetained: topologyStabilized.satelliteIslandsRetained,
    minFinalAreaRatio: Number(topologyMinFinalAreaRatio.toFixed(4)),
    fallbackAreaRejected: topologyStabilized.fallbackAreaRejected,
    constrainedMergeApplied: topologyStabilized.constrainedMergeApplied,
    anchorBlend: Number(topologyAnchorBlend.toFixed(3)),
    supportBlend: Number(topologySupportBlend.toFixed(3)),
    constraintBlend: Number(topologyConstraintBlend.toFixed(3)),
    anchorPointCount: topologyAnchorPoints.length,
    beforeConstraintAffinity: Number(topologyStabilized.beforeConstraintAffinity.toFixed(4)),
    afterConstraintAffinity: Number(topologyStabilized.afterConstraintAffinity.toFixed(4)),
  });

  let floorProjectionBeforePixels = postTopologyPixels;
  let floorProjectionAfterPixels = postTopologyPixels;
  if (floorProjectionEnabled) {
    const adaptiveMaxDropPixels = Math.min(
      Math.max(floorProjectionMaxDropPixels, Math.floor(height * 0.1)),
      Math.max(floorProjectionMaxDropPixels, Math.floor(height * 0.3), Math.floor(floorProjectionMaxDropPixels * geometryRecoveryProfile.floorDropMultiplier)),
    );
    const adaptiveHorizontalReach = floorProjectionHorizontalReach + geometryRecoveryProfile.floorHorizontalBonus;
    const adaptiveFloorGrowthRatio = Math.min(2.8, floorProjectionMaxGrowthRatio * geometryRecoveryProfile.floorGrowthMultiplier);
    const adaptiveFloorIterations = Math.min(8, floorProjectionMaxIterations + geometryRecoveryProfile.floorIterationBonus);

    const floorProjection = buildGravityAwareFloorBridge({
      mask: unionAccepted,
      floorMask: supportSurfaceMask,
      width,
      height,
      targetFloorContactRatio: effectiveFloorContactMin,
      maxDropPixels: adaptiveMaxDropPixels,
      maxHorizontalReach: adaptiveHorizontalReach,
      maxGrowthRatio: adaptiveFloorGrowthRatio,
      maxIterations: adaptiveFloorIterations,
    });
    unionAccepted = Buffer.from(floorProjection.mask);
    floorProjectionBeforePixels = floorProjection.beforePixels;
    floorProjectionAfterPixels = floorProjection.afterPixels;

    nLog("[VERTEX_CONTINUITY_GEMINI_MASK_FLOOR_PROJECTION]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      maxDropPixels: adaptiveMaxDropPixels,
      horizontalReach: adaptiveHorizontalReach,
      maxGrowthRatio: adaptiveFloorGrowthRatio,
      maxIterations: adaptiveFloorIterations,
      beforeFloorContactRatio: Number(floorProjection.beforeFloorContactRatio.toFixed(4)),
      afterFloorContactRatio: Number(floorProjection.afterFloorContactRatio.toFixed(4)),
      beforePixels: floorProjection.beforePixels,
      afterPixels: floorProjection.afterPixels,
      addedPixels: floorProjection.addedPixels,
      iterationsUsed: floorProjection.iterations,
    });
  }

  const starvationRetryExhaustedSignals = starvationSignals.filter((signal) => signal.retryExhausted);
  const starvedRequiredCount = starvationRetryExhaustedSignals.filter((signal) => signal.required).length;
  const starvedAnchorPoorOptionalCount = starvationRetryExhaustedSignals.filter((signal) => !signal.required).length;
  const starvationDetected = starvationRetryExhaustedSignals.length > 0;
  const retryExhaustionConfirmed = starvationRetryExhaustedSignals.length > 0;
  const preStarvationFallbackPixels = countMaskPixels(unionAccepted);
  const preStarvationFallbackAreaRatio = preStarvationFallbackPixels / Math.max(1, width * height);
  const occupancyBelowMinimum = preStarvationFallbackAreaRatio < adaptiveExpectation.effectiveMinAreaRatio;
  const legalityOverlapBefore = computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height);
  const supportOverlapBefore = computeMaskOverlapRatio(unionAccepted, supportSurfaceMask);
  const legalityOverlapStrongThreshold = Math.max(0.35, Math.min(0.9, readNumberEnv("CONTINUITY_GEMINI_MASK_STARVATION_FALLBACK_MIN_LEGALITY", 0.58)));
  const legalityOverlapStrong = legalityOverlapBefore >= legalityOverlapStrongThreshold;
  const legalSupportIntersectionPixels = (() => {
    let total = 0;
    for (let i = 0; i < deterministicConstraintMask.length; i += 1) {
      if (deterministicConstraintMask[i] > 0 && supportSurfaceMask[i] > 0) {
        total += 1;
      }
    }
    return total;
  })();
  const deterministicLegalitySpaceExists = legalSupportIntersectionPixels > Math.max(32, Math.floor(width * height * 0.0002));
  const supportSurfacesCoherent = (countMaskPixels(supportSurfaceMask) / Math.max(1, width * height)) >= 0.01;
  const anchorPoorScene = geometryRecoveryProfile.requiredClusterDensity < Math.max(0.2, Math.min(0.8, readNumberEnv("CONTINUITY_GEMINI_MASK_STARVATION_FALLBACK_ANCHOR_POOR_DENSITY", 0.52)));
  const starvationSeedEnabled = !parseBooleanEnv(process.env.CONTINUITY_GEMINI_MASK_DISABLE_STARVATION_SEED_FALLBACK);
  const starvationFallbackEligible = starvationSeedEnabled
    && starvationDetected
    && retryExhaustionConfirmed
    && occupancyBelowMinimum
    && legalityOverlapStrong
    && deterministicLegalitySpaceExists
    && supportSurfacesCoherent
    && (starvedRequiredCount > 0 || (anchorPoorScene && starvedAnchorPoorOptionalCount > 0));

  if (starvationFallbackEligible) {
    const totalPixels = Math.max(1, width * height);
    const targetShortfallPixels = Math.max(0, Math.round((adaptiveExpectation.effectiveMinAreaRatio * totalPixels) - preStarvationFallbackPixels));
    const starvationExpectedAreaRatio = starvationRetryExhaustedSignals
      .reduce((sum, signal) => sum + (signal.required ? signal.expectedAreaRatioMin : Math.min(signal.expectedAreaRatioMin, signal.expectedAreaRatioTarget * 0.5)), 0);
    const requiredStarvationPressure = starvedRequiredCount > 0 ? 1 : 0;
    const seedHardCapRatio = Math.max(0.0015, Math.min(0.04, starvationExpectedAreaRatio * (requiredStarvationPressure > 0 ? 0.9 : 0.55)));
    const seedHardCapPixels = Math.max(16, Math.round(totalPixels * seedHardCapRatio));
    const shortfallBudgetDefault = requiredStarvationPressure > 0 ? 0.75 : 0.35;
    const seedShortfallBudgetRatio = Math.max(0.18, Math.min(0.85, readNumberEnv("CONTINUITY_GEMINI_MASK_STARVATION_FALLBACK_SHORTFALL_BUDGET", shortfallBudgetDefault)));
    const seedShortfallBudgetPixels = Math.max(8, Math.round(targetShortfallPixels * seedShortfallBudgetRatio));
    const maxSeedPixels = Math.min(seedHardCapPixels, seedShortfallBudgetPixels);
    const seed = buildStarvationFallbackSeed({
      baseMask: unionAccepted,
      starvedClusters: starvationRetryExhaustedSignals,
      constraintMask: deterministicConstraintMask,
      supportMask: supportSurfaceMask,
      width,
      height,
      maxSeedPixels,
    });

    if (seed.addedPixels > 0) {
      unionAccepted = Buffer.from(safeMaskUnion(unionAccepted, seed.seedMask));
      usedConservativeFallback = true;
      const legalityOverlapAfter = computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height);
      const supportOverlapAfter = computeMaskOverlapRatio(unionAccepted, supportSurfaceMask);
      const inflationPixels = countMaskPixels(unionAccepted) - preStarvationFallbackPixels;
      starvationFallbackTelemetry = {
        activated: true,
        activationReason: "retry_exhaustion_under_informed_anchor_poor_or_required",
        starvedClusterIds: starvationSignals.map((signal) => signal.clusterId),
        retryExhaustedClusterIds: starvationRetryExhaustedSignals.map((signal) => signal.clusterId),
        seedPixelsAdded: seed.addedPixels,
        seedAreaRatioAdded: seed.addedPixels / totalPixels,
        occupancyInflationPixels: inflationPixels,
        occupancyInflationAreaRatio: inflationPixels / totalPixels,
        legalityOverlapBefore,
        legalityOverlapAfter,
        legalityOverlapDelta: legalityOverlapAfter - legalityOverlapBefore,
        supportOverlapBefore,
        supportOverlapAfter,
        supportOverlapDelta: supportOverlapAfter - supportOverlapBefore,
        targetShortfallPixels,
        maxSeedPixels,
      };

      nLog("[VERTEX_CONTINUITY_GEMINI_MASK_STARVATION_FALLBACK]", {
        continuityGroupId: params.continuityGroupId || null,
        imageId: params.imageId,
        jobId: params.jobId,
        activationReason: starvationFallbackTelemetry.activationReason,
        starvedClusterIds: starvationFallbackTelemetry.starvedClusterIds,
        retryExhaustedClusterIds: starvationFallbackTelemetry.retryExhaustedClusterIds,
        seedPixelsAdded: starvationFallbackTelemetry.seedPixelsAdded,
        seedAreaRatioAdded: Number(starvationFallbackTelemetry.seedAreaRatioAdded.toFixed(6)),
        legalityOverlapBefore: Number(starvationFallbackTelemetry.legalityOverlapBefore.toFixed(4)),
        legalityOverlapAfter: Number(starvationFallbackTelemetry.legalityOverlapAfter.toFixed(4)),
        legalityOverlapDelta: Number(starvationFallbackTelemetry.legalityOverlapDelta.toFixed(4)),
        supportOverlapBefore: Number(starvationFallbackTelemetry.supportOverlapBefore.toFixed(4)),
        supportOverlapAfter: Number(starvationFallbackTelemetry.supportOverlapAfter.toFixed(4)),
        supportOverlapDelta: Number(starvationFallbackTelemetry.supportOverlapDelta.toFixed(4)),
        occupancyInflationPixels: starvationFallbackTelemetry.occupancyInflationPixels,
        occupancyInflationAreaRatio: Number(starvationFallbackTelemetry.occupancyInflationAreaRatio.toFixed(6)),
        maxSeedPixels: starvationFallbackTelemetry.maxSeedPixels,
        targetShortfallPixels: starvationFallbackTelemetry.targetShortfallPixels,
      });
    }
  }

  const preAreaRecoveryPixels = countMaskPixels(unionAccepted);
  const preAreaRecoveryAreaRatio = preAreaRecoveryPixels / Math.max(1, width * height);
  let areaRecoveryIterations = 0;
  let areaRecoveryAddedPixels = 0;
  if (preAreaRecoveryAreaRatio < adaptiveExpectation.effectiveMinAreaRatio) {
    const areaRecovery = await buildConstraintBoundedAreaRecovery({
      mask: unionAccepted,
      constraintMask: deterministicConstraintMask,
      supportMask: supportSurfaceMask,
      width,
      height,
      targetAreaRatio: adaptiveExpectation.effectiveMinAreaRatio,
      maxGrowthRatio: geometryRecoveryProfile.areaRecoveryMaxGrowthRatio,
      maxIterations: geometryRecoveryProfile.areaRecoveryMaxIterations,
    });
    unionAccepted = Buffer.from(areaRecovery.mask);
    areaRecoveryIterations = areaRecovery.iterations;
    areaRecoveryAddedPixels = areaRecovery.addedPixels;
  }
  const postAreaRecoveryPixels = countMaskPixels(unionAccepted);
  const postAreaRecoveryAreaRatio = postAreaRecoveryPixels / Math.max(1, width * height);

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_AREA_RECOVERY]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    minAreaTargetRatio: Number(adaptiveExpectation.effectiveMinAreaRatio.toFixed(4)),
    beforePixels: preAreaRecoveryPixels,
    afterPixels: postAreaRecoveryPixels,
    beforeAreaRatio: Number(preAreaRecoveryAreaRatio.toFixed(4)),
    afterAreaRatio: Number(postAreaRecoveryAreaRatio.toFixed(4)),
    addedPixels: areaRecoveryAddedPixels,
    iterations: areaRecoveryIterations,
  });

  if (!starvationFallbackTelemetry.activated) {
    nLog("[VERTEX_CONTINUITY_GEMINI_MASK_STARVATION_FALLBACK]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      activated: false,
      starvedClusterIds: starvationFallbackTelemetry.starvedClusterIds,
      retryExhaustedClusterIds: starvationFallbackTelemetry.retryExhaustedClusterIds,
      legalityOverlapBefore: Number(starvationFallbackTelemetry.legalityOverlapBefore.toFixed(4)),
      supportOverlapBefore: Number(starvationFallbackTelemetry.supportOverlapBefore.toFixed(4)),
    });
  }

  const finalPixels = countMaskPixels(unionAccepted);
  const finalAreaRatio = finalPixels / Math.max(1, width * height);
  const floorProjectionBeforeAreaRatio = floorProjectionBeforePixels / Math.max(1, width * height);
  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_AREA_ATTRIBUTION]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    preTopologyPixels,
    postTopologyPixels,
    postFloorProjectionPixels: finalPixels,
    preTopologyAreaRatio: Number(preTopologyAreaRatio.toFixed(4)),
    postTopologyAreaRatio: Number(postTopologyAreaRatio.toFixed(4)),
    postFloorProjectionAreaRatio: Number(finalAreaRatio.toFixed(4)),
    topologyPixelDelta: postTopologyPixels - preTopologyPixels,
    floorProjectionPixelDelta: finalPixels - floorProjectionBeforePixels,
    topologyAreaDeltaRatio: Number((postTopologyAreaRatio - preTopologyAreaRatio).toFixed(4)),
    floorProjectionAreaDeltaRatio: Number((finalAreaRatio - floorProjectionBeforeAreaRatio).toFixed(4)),
    floorProjectionBeforePixels,
    floorProjectionAfterPixels,
    postFloorProjectionConstraintAffinity: Number(computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height).toFixed(4)),
  });

  const anchorProximityScore = priorClusters.length > 0
    ? priorClusters.reduce((sum, cluster) => sum + measureAnchorProximityScore(unionAccepted, width, height, cluster.anchorX, cluster.anchorY), 0) / priorClusters.length
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
    profile: {
      ...profile,
      minAreaRatio: adaptiveExpectation.effectiveMinAreaRatio,
      minFloorContactRatio: effectiveFloorContactMin,
    },
    floorMask: supportSurfaceMask,
    anchorScore: anchorProximityScore,
    constraintAffinityScore: computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height),
    compactnessScore: compactness,
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
  });

  logGeminiMaskMemory({
    enabled: memoryDebugEnabled,
    phase: "post-safety-evaluation",
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
    extra: {
      finalOccupancyPixels: countMaskPixels(unionAccepted),
      usedConservativeFallback,
    },
  });

  const unionRawExport = await resizeBinaryMaskRaw({
    mask: unionRawBest,
    sourceWidth: width,
    sourceHeight: height,
    targetWidth: sourceWidth,
    targetHeight: sourceHeight,
  });
  const unionAcceptedExport = await resizeBinaryMaskRaw({
    mask: unionAccepted,
    sourceWidth: width,
    sourceHeight: height,
    targetWidth: sourceWidth,
    targetHeight: sourceHeight,
  });

  nLog("[VERTEX_CONTINUITY_GEMINI_MASK_EXPORT]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    processingOccupancyPixels: countMaskPixels(unionAccepted),
    sourceExportOccupancyPixels: countMaskPixels(unionAcceptedExport),
    sourceExportConstraintAffinity: Number(computeMaskConstraintAffinity(unionAcceptedExport, deterministicConstraintMaskSource, sourceWidth, sourceHeight).toFixed(4)),
    processingWidth: width,
    processingHeight: height,
    sourceWidth,
    sourceHeight,
  });

  await writeMaskPng(unionRawExport, sourceWidth, sourceHeight, rawMaskPath);
  await writeMaskPng(unionAcceptedExport, sourceWidth, sourceHeight, cleanedMaskPath);
  await writeRgbaPng(
    buildBinaryMaskOverlay(unionAccepted, width, height, { r: 72, g: 210, b: 118, a: 180 }),
    width,
    height,
    componentRetainedPath,
  );
  await writeRgbaPng(
    buildBinaryMaskOverlay(unionRejected, width, height, { r: 255, g: 84, b: 84, a: 180 }),
    width,
    height,
    componentRemovedPath,
  );

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

  const heatmap = buildAnchorDistanceHeatmap(width, height, priorClusters);
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

  if (clusterDebugArtifacts.length > 0) {
    const representative = clusterDebugArtifacts[0];
    await fs.copyFile(representative.alphaHeatmapPath, alphaHeatmapPath);
    await fs.copyFile(representative.alphaHistogramPath, alphaHistogramPath);
    await fs.copyFile(representative.stageComparisonPath, stageComparisonPath);
  } else {
    await fs.writeFile(alphaHistogramPath, JSON.stringify({ bins: [], min: 0, max: 0, mean: 0, nonZeroPixels: 0 }, null, 2));
  }

  const finalUnionMetric = {
    measurementStage: "final_union_mask",
    occupancyPixels: countMaskPixels(unionAccepted),
    totalPixels: width * height,
    occupancyAreaRatio: countMaskPixels(unionAccepted) / (width * height),
    width,
    height,
    alphaAware: false,
    threshold: null,
    artifactPath: cleanedMaskPath,
    componentCount: analyzeConnectedComponents(unionAccepted, width, height, 1).components.length,
  };

  for (const priorCluster of priorClusters) {
    const existingMetrics = stageMetricsByCluster.get(priorCluster.clusterId) || [];
    existingMetrics.push(
      computeStageMetric({
        clusterId: priorCluster.clusterId,
        clusterRole: priorCluster.required ? "required" : "optional",
        stage: "final_safety_mask",
        mask: unionAccepted,
        width,
        height,
        includedInFinalUnion: clusterContributions.some((item) => item.clusterId === priorCluster.clusterId && item.includedInFinalUnion),
      }),
    );
    stageMetricsByCluster.set(priorCluster.clusterId, existingMetrics);
  }

  const occupancyMetricDebug = {
    width,
    height,
    normalizationWidth: width,
    normalizationHeight: height,
    normalizationSource: "occupancy_processing_dimensions",
    occupancyThresholdUsed: readNumberEnv("CONTINUITY_GEMINI_MASK_THRESHOLD", 170),
    alphaStatsPath: alphaHistogramPath,
    alphaHeatmapPath,
    measurementStages: clusterDebugArtifacts.map((artifact) => ({
      clusterId: artifact.clusterId,
      measurementStage: artifact.measurementStage,
      alphaAware: artifact.alphaAware,
      threshold: artifact.threshold,
      artifactPath: artifact.artifactPath,
    })),
    finalUnionMetric,
    rejectionReason: finalUnionMetric.occupancyAreaRatio < adaptiveExpectation.effectiveMinAreaRatio ? "area_too_sparse" : null,
    adaptiveExpectation,
  };
  nLog("[VERTEX_CONTINUITY_GEMINI_OCCUPANCY_METRIC_DEBUG]", occupancyMetricDebug);
  await fs.writeFile(occupancyMetricDebugPath, JSON.stringify(occupancyMetricDebug, null, 2));

  const occupancyLossByCluster = Array.from(stageMetricsByCluster.entries()).map(([clusterId, metrics]) => {
    const morphology = metrics.find((metric) => metric.stage === "morphology_cleaned_mask");
    const filtered = metrics.find((metric) => metric.stage === "component_filtered_mask");
    const accepted = metrics.find((metric) => metric.stage === "accepted_cluster_mask");
    const merged = metrics.find((metric) => metric.stage === "merged_union_mask");
    const final = metrics.find((metric) => metric.stage === "final_safety_mask");
    return {
      clusterId,
      clusterRole: metrics[0]?.clusterRole || "optional",
      occupancyLossByStage: {
        morphologyToComponentFiltered: Number((((morphology?.occupancyAreaRatio || 0) - (filtered?.occupancyAreaRatio || 0))).toFixed(6)),
        componentFilteredToAccepted: Number((((filtered?.occupancyAreaRatio || 0) - (accepted?.occupancyAreaRatio || 0))).toFixed(6)),
        acceptedToMergedUnion: Number((((accepted?.occupancyAreaRatio || 0) - (merged?.occupancyAreaRatio || 0))).toFixed(6)),
        mergedUnionToFinalSafety: Number((((merged?.occupancyAreaRatio || 0) - (final?.occupancyAreaRatio || 0))).toFixed(6)),
      },
    };
  });

  const requiredClusterOccupancy = clusterContributions
    .filter((item) => item.role === "required" && item.includedInFinalUnion)
    .reduce((sum, item) => sum + item.contributionRatio, 0);
  const optionalClusterOccupancy = clusterContributions
    .filter((item) => item.role === "optional" && item.includedInFinalUnion)
    .reduce((sum, item) => sum + item.contributionRatio, 0);
  const skippedOptionalClusters = priorClusters
    .filter((cluster) => !cluster.required && !clusterContributions.some((item) => item.clusterId === cluster.clusterId && item.includedInFinalUnion))
    .map((cluster) => cluster.clusterId);

  const occupancyCollapseAnalysis = {
    rawOccupancyRatio: countMaskPixels(unionRawBest) / Math.max(1, width * height),
    acceptedOccupancyRatio: finalUnionMetric.occupancyAreaRatio,
    requiredClusterOccupancy,
    optionalClusterOccupancy,
    requiredOccupancyRatio: requiredClusterOccupancy,
    optionalOccupancyRatio: optionalClusterOccupancy,
    adaptiveExpectation,
    occupancyLossByStage: {
      rawToAccepted: Number(((countMaskPixels(unionRawBest) / Math.max(1, width * height)) - finalUnionMetric.occupancyAreaRatio).toFixed(6)),
    },
    occupancyLossByCluster,
    skippedOptionalClusters,
    finalThreshold: adaptiveExpectation.effectiveMinAreaRatio,
    rejectionReason: finalUnionMetric.occupancyAreaRatio < adaptiveExpectation.effectiveMinAreaRatio ? "area_too_sparse" : null,
    clusterContributions,
    perClusterStageMetrics: Object.fromEntries(Array.from(stageMetricsByCluster.entries())),
  };
  await fs.writeFile(occupancyCollapseAnalysisPath, JSON.stringify(occupancyCollapseAnalysis, null, 2));

  await fs.writeFile(componentAnalysisPath, JSON.stringify({
    width,
    height,
    clusters: Array.from(componentAuditByCluster.values()),
  }, null, 2));

  const representativeMetricCluster = priorClusters.find((cluster) => stageMetricsByCluster.has(cluster.clusterId))?.clusterId;
  const representativeMetrics = representativeMetricCluster ? stageMetricsByCluster.get(representativeMetricCluster) || [] : [];
  const representativeRaw = representativeMetricCluster ? clusterDebugArtifacts.find((artifact) => artifact.clusterId === representativeMetricCluster) : null;
  if (representativeRaw) {
    const representativeClusterStages = representativeMetrics;
    const thresholdedMask = representativeClusterStages.find((metric) => metric.stage === "thresholded_mask");
    const componentFilteredMaskMetric = representativeClusterStages.find((metric) => metric.stage === "component_filtered_mask");
    const acceptedMaskMetric = representativeClusterStages.find((metric) => metric.stage === "accepted_cluster_mask");
    await writeRgbaPng(
      buildOccupancyStageGridRgba({
        rawMask: unionRawBest,
        thresholdedMask: thresholdedMask ? await sharp(representativeRaw.thresholdedMaskPath).raw().toBuffer() as Buffer : unionRawBest,
        componentFilteredMask: componentFilteredMaskMetric ? await sharp(representativeRaw.componentFilteredMaskPath).raw().toBuffer() as Buffer : unionAccepted,
        acceptedMask: acceptedMaskMetric ? await sharp(representativeRaw.acceptedClusterMaskPath).raw().toBuffer() as Buffer : unionAccepted,
        unionMask: unionAccepted,
        finalMask: unionAccepted,
        width,
        height,
      }),
      width,
      height * 6,
      occupancyStageGridPath,
    );

    nLog("[VERTEX_CONTINUITY_GEMINI_MASK_DIMS]", {
      phase: "stage-grid-materialization",
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      clusterId: representativeMetricCluster || null,
      width,
      height,
      stageGridWidth: width,
      stageGridHeight: height * 6,
      expectedStageGridRgbaBytes: estimateBytes({ width, height: height * 6, channels: 4 }),
    });
  }

  logGeminiMaskMemory({
    enabled: memoryDebugEnabled,
    phase: "post-artifact-materialization",
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
    extra: {
      clusterApiCallCount,
      clusterCount: priorClusters.length,
    },
  });

  const requiredClusterCount = priorClusters.filter((cluster) => cluster.required).length;
  const optionalClusterCount = Math.max(0, priorClusters.length - requiredClusterCount);
  const baselineObjectCallCount = Math.max(1, params.plan.furnitureZones.length * maxAttempts);
  const estimatedCallReductionRatio = Math.max(0, Math.min(1, 1 - (clusterApiCallCount / baselineObjectCallCount)));

  const qualityPayload = {
    roomTypeProfile: profile,
    safety: evaluated.safety,
    quality: evaluated.quality,
    usedConservativeFallback,
    priorClusterCount: priorClusters.length,
    requiredClusterCount,
    optionalClusterCount,
    baselineObjectCallCount,
    clusterApiCallCount,
    estimatedCallReductionRatio,
    perClusterMaskPaths,
    requiredOccupancyRatio: requiredClusterOccupancy,
    optionalOccupancyRatio: optionalClusterOccupancy,
    adaptiveExpectation,
    clusterContributions,
    starvationFallback: starvationFallbackTelemetry,
  };
  await fs.writeFile(qualityReportPath, JSON.stringify(qualityPayload, null, 2));
  await fs.writeFile(retryComparisonPath, JSON.stringify(clusterSummaries, null, 2));

  const representativeClusterArtifact = clusterDebugArtifacts[0];

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
    retryCount: clusterSummaries.length,
    clusterCount: priorClusters.length,
    requiredClusterCount,
    optionalClusterCount,
    clusterApiCallCount,
    estimatedCallReductionRatio: Number(estimatedCallReductionRatio.toFixed(4)),
    usedConservativeFallback,
    postSafetyConstraintAffinity: Number(computeMaskConstraintAffinity(unionAccepted, deterministicConstraintMask, width, height).toFixed(4)),
  });

  logGeminiMaskMemory({
    enabled: memoryDebugEnabled,
    phase: "complete",
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    jobId: params.jobId,
    extra: {
      latencyMs: Date.now() - startedAt,
      clusterApiCallCount,
      clusterCount: priorClusters.length,
    },
  });

  return {
    rawGeminiMaskPath: representativeClusterArtifact?.rawGeminiMaskPath,
    thresholdedMaskPath: representativeClusterArtifact?.thresholdedMaskPath,
    alphaNormalizedMaskPath: representativeClusterArtifact?.alphaNormalizedMaskPath,
    morphologyCleanedMaskPath: representativeClusterArtifact?.morphologyCleanedMaskPath,
    componentFilteredMaskPath: representativeClusterArtifact?.componentFilteredMaskPath,
    acceptedClusterMaskPath: representativeClusterArtifact?.acceptedClusterMaskPath,
    finalUnionMaskPath: cleanedMaskPath,
    occupancyCollapseAnalysisPath,
    occupancyStageGridPath,
    componentAnalysisPath,
    componentRetainedPath,
    componentRemovedPath,
    alphaHeatmapPath,
    alphaHistogramPath,
    occupancyMetricDebugPath,
    thresholdComparisonPath: representativeClusterArtifact ? path.join(stageDebugDir, representativeClusterArtifact.clusterId, "threshold-comparison.json") : undefined,
    stageComparisonPath,
    measurementStage: "final_union_mask",
    alphaAware: representativeClusterArtifact?.alphaAware,
    measurementThreshold: representativeClusterArtifact?.threshold,
    normalizationWidth: width,
    normalizationHeight: height,
    normalizationSource: "occupancy_processing_dimensions",
    cleanedMaskRaw: unionAcceptedExport,
    rawMaskPath,
    cleanedMaskPath,
    componentsPath,
    qualityReportPath,
    retryComparisonPath,
    anchorDistanceHeatmapPath,
    floorContactVisualizationPath,
    acceptedRejectedOverlayPath,
    perClusterMaskPaths,
    usedConservativeFallback,
    retryCount: clusterSummaries.length,
    clusterCount: priorClusters.length,
    requiredClusterCount,
    optionalClusterCount,
    clusterApiCallCount,
    estimatedCallReductionRatio,
    qualityScore: evaluated.quality.score,
    model,
    latencyMs: Date.now() - startedAt,
    safety: evaluated.safety,
  };
}
