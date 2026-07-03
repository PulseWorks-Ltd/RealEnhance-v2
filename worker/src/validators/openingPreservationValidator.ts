import { createHash } from "node:crypto";
import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import { getRedisJson, setRedisJson } from "../utils/persist";
import type { StructuralSignal, SignalRegion } from "./structuralSignal";

export type StructuralOpeningType = "window" | "door" | "closet_door" | "walkthrough";
export type WallPosition = "left_wall" | "right_wall" | "far_wall" | "near_wall";
export type RelativeHorizontalPosition = "left_third" | "center" | "right_third";
export type WallIndex = 0 | 1 | 2 | 3;
export type HorizontalBand = "left_third" | "center_third" | "right_third";
export type VerticalBand = "floor_zone" | "mid_zone" | "ceiling_zone" | "full_height";
export type WallCoverageBand = "5-10" | "10-20" | "20-40" | "40-60" | "60+";
export type OpeningOrientation = "portrait" | "landscape" | "square";
export type PaneStructure = "single_fixed" | "double_fixed" | "fixed_plus_opening" | "sliding_panel" | "multi_pane_grid" | "unknown";
export type DoorLeafState = "closed" | "open" | "ajar" | "unknown";

export type AnchorFixtureType =
  | "ac_unit"
  | "fireplace"
  | "built_in_cabinet"
  | "kitchen_island"
  | "staircase"
  | "other";

export type AnchorFixture = {
  id: string;
  type: AnchorFixtureType;
  wallIndex: WallIndex;
  horizontalBand: HorizontalBand;
  bbox: [number, number, number, number];
  confidence: number;
};

export type WallDescriptor = {
  wallIndex: WallIndex;
  canonicalWallId?: string;
  primaryAnchorLabel?: string;
  observedOrdinal?: number;
  visibility: "full" | "partial" | "minimal";
  visibleExtent?: "full" | "partial" | "minimal";
  architecturalCertainty?: "known" | "partial" | "unknown";
  leftEdgeLocation?: "outside_frame" | "outer_third" | "central_image" | "unknown";
  rightEdgeLocation?: "outside_frame" | "outer_third" | "central_image" | "unknown";
  leftBoundaryVisible?: boolean;
  rightBoundaryVisible?: boolean;
  leftCornerVisible?: boolean;
  rightCornerVisible?: boolean;
  leftCornerConfidence?: number;
  rightCornerConfidence?: number;
  leftCornerPosition?: "none" | "image_edge" | "outer_third" | "inner_third" | "centre";
  rightCornerPosition?: "none" | "image_edge" | "outer_third" | "inner_third" | "centre";
  leftCornerVisibility?: "none" | "trace" | "minimal" | "partial" | "substantial" | "full";
  rightCornerVisibility?: "none" | "trace" | "minimal" | "partial" | "substantial" | "full";
  leftAdjacentWallVisibility?: "none" | "trace" | "minimal" | "partial" | "substantial" | "full";
  rightAdjacentWallVisibility?: "none" | "trace" | "minimal" | "partial" | "substantial" | "full";
  leftReturnWallVisible?: boolean;
  rightReturnWallVisible?: boolean;
  leftReturnWallVisibility?: "none" | "minimal" | "partial" | "full" | "unknown";
  rightReturnWallVisibility?: "none" | "minimal" | "partial" | "full" | "unknown";
  leftFrameEdgeContinuation?: "continues_beyond_frame" | "terminates_at_visible_corner" | "unknown";
  rightFrameEdgeContinuation?: "continues_beyond_frame" | "terminates_at_visible_corner" | "unknown";
  boundaryBehaviour?: "terminates_at_visible_corner" | "continues_beyond_frame" | "unknown";
  terminatesAtCorner?: boolean;
  continuesBeyondFrame?: boolean;
  description: string;
};

export type StructuralOpening = {
  id: string;
  type: StructuralOpeningType;
  bbox: [number, number, number, number];
  area_pct: number;
  wallIndex: WallIndex;
  horizontalBand: HorizontalBand;
  verticalBand: VerticalBand;
  wallCoverageBand: WallCoverageBand;
  orientation: OpeningOrientation;
  paneStructure: PaneStructure;
  doorLeafState: DoorLeafState;
  confidence: number;

  // Legacy compatibility fields used by existing downstream systems
  wallPosition: WallPosition;
  relativeHorizontalPosition: RelativeHorizontalPosition;
  shape: string;
  touchesFloor: boolean;
  touchesCeiling: boolean;
  approxCount: number;
};

export type StructuralBaseline = {
  cameraOrientation?: string;
  openings: StructuralOpening[];
  anchorFixtures?: AnchorFixture[];
  wallDescriptors?: WallDescriptor[];
  observationMeta?: {
    observationHash: string;
    wallCount: number;
    inventoryHash?: string;
    canonicalIdentityHash?: string;
    inventory?: {
      openings: string[];
      permanentFixtures: string[];
      architecturalFeatures: string[];
    };
    validation?: {
      unknownReferences: string[];
      duplicateReferences: string[];
      unusedInventory: string[];
      inconsistencies: string[];
      conflictingObservations?: string[];
      rejectedAnchors: string[];
      chosenAnchors: string[];
      reconciliationActions?: string[];
      reconciliationReasons?: string[];
    };
    baselineConfidence?: number;
    baselineStatus?: "MATCHED" | "RECONCILED" | "IRRECONCILABLE";
    baselineReliability?: "HIGH" | "MEDIUM" | "LOW";
    fallbackInvoked?: boolean;
    baselineExtractionStrategy?: "single_pass_observation" | "graph_reconciliation" | "semantic_relaxed_rebuild";
    baselineConfidenceDegraded?: boolean;
  };
  graphMeta?: {
    graphStable: boolean;
    graphConfidence: number;
    extractionAgreement: number;
    passCount: number;
    openingCountVariance: number;
    imageHash: string;
    graphHash: string;
    cacheStatus: "hit" | "stabilized" | "unstable";
    candidateGraphHashes: string[];
    openingCountRange: { min: number; max: number };
    confirmedAt: string;
    baselineMethod?: "graph_consensus" | "extraction_verification" | "single_pass_observation" | "semantic_relaxed_rebuild";
    geminiCalls?: number;
    observationHash?: string;
    baselineConfidence?: number;
    baselineStatus?: "MATCHED" | "RECONCILED" | "IRRECONCILABLE";
    baselineReliability?: "HIGH" | "MEDIUM" | "LOW";
    fallbackInvoked?: boolean;
    baselineExtractionStrategy?: "single_pass_observation" | "graph_reconciliation" | "semantic_relaxed_rebuild";
    baselineConfidenceDegraded?: boolean;
    reconciliationActions?: string[];
    reconciliationReasons?: string[];
    verification?: {
      attempted: boolean;
      accepted: boolean;
      modelAccepted: boolean;
      additionalOpeningCount: number;
      missingOpeningCount: number;
      materiallyDifferentCount: number;
      notPresentCount: number;
      minorDifferenceCount: number;
      rejectedReasonCodes: string[];
      openingStatuses?: Array<{
        id: string;
        status: BaselineVerificationStatus;
        notes?: string;
      }>;
      additionalOpenings?: BaselineVerificationIssue[];
      missingOpenings?: BaselineVerificationIssue[];
      analysis?: string;
    };
  };
};

export type BaselineArchitectureMode = "single_pass_observation";
type BaselineInternalStatus = "MATCHED" | "RECONCILED" | "IRRECONCILABLE";

type BaselineReliability = "HIGH" | "MEDIUM" | "LOW";

type BaselineVerificationStatus =
  | "confirmed"
  | "confirmed_with_minor_description_difference"
  | "materially_different"
  | "not_present";

type BaselineVerificationOpeningResult = {
  id: string;
  status: BaselineVerificationStatus;
  notes?: string;
};

type BaselineVerificationIssue = {
  id?: string;
  type?: string;
  location?: string;
  notes?: string;
};

type BaselineVerificationResult = {
  openings: BaselineVerificationOpeningResult[];
  additionalOpenings: BaselineVerificationIssue[];
  missingOpenings: BaselineVerificationIssue[];
  baselineAccepted: boolean;
  analysis?: string;
};

type BaselineExtractionOptions = {
  jobId?: string;
  imageId?: string;
  attempt?: number;
  baselineMode?: BaselineArchitectureMode;
  disableCache?: boolean;
};

type BaselineExtractionTimingBreakdown = {
  imageDownloadMs: number;
  imageMaterializationMs: number;
  imageResizeMs: number;
  promptBuildMs: number;
  geminiRequestMs: number;
  responseReceiveMs: number;
  jsonParseMs: number;
  normalizationMs: number;
  graphBuildMs: number;
  persistenceMs: number;
};

function createBaselineTimingBreakdown(): BaselineExtractionTimingBreakdown {
  return {
    imageDownloadMs: 0,
    imageMaterializationMs: 0,
    imageResizeMs: 0,
    promptBuildMs: 0,
    geminiRequestMs: 0,
    responseReceiveMs: 0,
    jsonParseMs: 0,
    normalizationMs: 0,
    graphBuildMs: 0,
    persistenceMs: 0,
  };
}

function sumBaselineTimingBreakdown(timing: BaselineExtractionTimingBreakdown): number {
  return (
    timing.imageDownloadMs +
    timing.imageMaterializationMs +
    timing.imageResizeMs +
    timing.promptBuildMs +
    timing.geminiRequestMs +
    timing.responseReceiveMs +
    timing.jsonParseMs +
    timing.normalizationMs +
    timing.graphBuildMs +
    timing.persistenceMs
  );
}

export type OpeningValidationResult = {
  results: OpeningResult[];
  findings: OpeningDiagnosticFinding[];
  structuralSignals: StructuralSignal[];
  reconciledMatches?: Array<{
    baselineId: string;
    detectedId: string;
    matchSource: "id" | "graph_reconcile";
    score: number;
  }>;
  summary: {
    openingRemoved: boolean;
    openingInfilled: boolean;
    openingSealed: boolean;
    openingRelocated: boolean;
    openingResized: boolean;
    openingClassMismatch: boolean;
    openingClassMismatchEnforcement: "advisory";
    openingBandMismatch: boolean;
    openingStateChanged?: boolean;
    openingApertureExpanded?: boolean;
    openingSignatureMismatch?: boolean;
    stagingOcclusionAdvisory?: boolean;
    frameBoundaryTruncationAdvisory?: boolean;
    semanticAnchorErosionAdvisory?: boolean;
    outOfFrameOpenings: string[];
    openingCount?: {
      before: number;
      after: number;
    };
    analysis?: string;
    semanticOpeningAreaDeltaPct?: number;
    semanticOpeningAspectRatioDelta?: number;
    windowSillDeltaPct?: number;
    confidence: number;
  };
  detectedOpenings: StructuralOpening[];
};

export type OpeningValidationSummary = OpeningValidationResult["summary"];

export type OpeningResult = {
  id: string;
  present: boolean;
  sealed: boolean;
  relocated: boolean;
  outOfFrame: boolean;
  confidence: number;
};

export type OpeningDiagnosticFinding = {
  id: string;
  openingType: StructuralOpeningType;
  status: "missing" | "infilled" | "altered";
  location: string;
  wallIndex: WallIndex;
  bbox: [number, number, number, number];
  machineReasons: string[];
  explanation: string;
  question: string;
  confidence: number;
};

type StructuralBaselineCacheRecord = {
  imageHash: string;
  graphHash: string;
  graph: StructuralBaseline;
  graphStable: boolean;
  graphConfidence: number;
  extractionAgreement: number;
  passCount: number;
  openingCountVariance: number;
  openingCountRange: { min: number; max: number };
  candidateGraphHashes: string[];
  createdAt: string;
  updatedAt: string;
};

const STRUCTURAL_BASELINE_CACHE_PREFIX = "opening:structural-baseline:v1:";
const STRUCTURAL_BASELINE_STABILIZATION_PASSES = 1;
const STRUCTURAL_BASELINE_MIN_AGREEMENT = 1;
const STRUCTURAL_BASELINE_AUTHORITY_MIN_CONFIDENCE = 1;
const OPENING_COORDINATE_PRECISION = Math.max(
  2,
  Math.min(6, Number(process.env.OPENING_COORDINATE_PRECISION || 4))
);
const OPENING_CONFIDENCE_VARIANCE_THRESHOLD = Math.max(
  0,
  Math.min(1, Number(process.env.OPENING_CONFIDENCE_VARIANCE_THRESHOLD || 0.05))
);
const OPENING_BBOX_VARIANCE_THRESHOLD = Math.max(
  0.001,
  Math.min(0.25, Number(process.env.OPENING_BBOX_VARIANCE_THRESHOLD || 0.015))
);
const OPENING_BASELINE_VERIFICATION_EXPERIMENT = false;
const OPENING_BASELINE_VERIFICATION_MODEL = "";
const OPENING_BASELINE_SINGLE_PASS = true;

function roundDeterministic(value: number, precision = OPENING_COORDINATE_PRECISION): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function quantizeBbox(
  bbox: [number, number, number, number]
): [number, number, number, number] {
  return [
    roundDeterministic(clamp01(bbox[0])),
    roundDeterministic(clamp01(bbox[1])),
    roundDeterministic(clamp01(bbox[2])),
    roundDeterministic(clamp01(bbox[3])),
  ];
}

function bboxKey(bbox: [number, number, number, number]): string {
  return quantizeBbox(bbox).join(":");
}

function compareNumbers(left: number, right: number, epsilon = 1e-6): number {
  const delta = left - right;
  if (Math.abs(delta) <= epsilon) return 0;
  return delta < 0 ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareStructuralOpenings(left: StructuralOpening, right: StructuralOpening): number {
  return (
    compareNumbers(left.wallIndex, right.wallIndex) ||
    compareStrings(left.horizontalBand, right.horizontalBand) ||
    compareStrings(left.verticalBand, right.verticalBand) ||
    compareNumbers(bboxCenterX(left.bbox), bboxCenterX(right.bbox), 1e-4) ||
    compareNumbers((left.bbox[1] + left.bbox[3]) / 2, (right.bbox[1] + right.bbox[3]) / 2, 1e-4) ||
    compareStrings(left.type, right.type) ||
    compareStrings(left.paneStructure, right.paneStructure) ||
    compareStrings(bboxKey(left.bbox), bboxKey(right.bbox)) ||
    compareStrings(String(left.id), String(right.id))
  );
}

function compareAnchorFixtures(left: AnchorFixture, right: AnchorFixture): number {
  return (
    compareNumbers(left.wallIndex, right.wallIndex) ||
    compareStrings(left.horizontalBand, right.horizontalBand) ||
    compareNumbers(bboxCenterX(left.bbox), bboxCenterX(right.bbox), 1e-4) ||
    compareStrings(left.type, right.type) ||
    compareStrings(bboxKey(left.bbox), bboxKey(right.bbox)) ||
    compareStrings(String(left.id), String(right.id))
  );
}

function structuralOpeningTelemetrySignature(opening: StructuralOpening): string {
  return [
    opening.type,
    String(opening.wallIndex),
    opening.horizontalBand,
    opening.verticalBand,
    bboxKey(opening.bbox),
  ].join("|");
}

type StructuralBaselinePassTelemetry = {
  passIndex: number;
  graphHash: string;
  openingCount: number;
  openings: Array<{
    id: string;
    signature: string;
    wallIndex: number;
    verticalBand: VerticalBand;
    bbox: [number, number, number, number];
    confidence: number;
  }>;
};

function buildStructuralBaselinePassTelemetry(
  passIndex: number,
  graphHash: string,
  baseline: StructuralBaseline
): StructuralBaselinePassTelemetry {
  return {
    passIndex,
    graphHash,
    openingCount: baseline.openings.length,
    openings: [...baseline.openings]
      .sort(compareStructuralOpenings)
      .map((opening) => ({
        id: String(opening.id),
        signature: structuralOpeningTelemetrySignature(opening),
        wallIndex: opening.wallIndex,
        verticalBand: opening.verticalBand,
        bbox: quantizeBbox(opening.bbox),
        confidence: roundDeterministic(opening.confidence, 3),
      })),
  };
}

function summarizeStructuralBaselineVariance(passTelemetry: StructuralBaselinePassTelemetry[]): {
  graphHashVariance: number;
  signatureVariance: number;
  bboxVariance: number;
  wallIndexVariance: number;
  verticalBandVariance: number;
  confidenceVariance: number;
} {
  if (passTelemetry.length <= 1) {
    return {
      graphHashVariance: 0,
      signatureVariance: 0,
      bboxVariance: 0,
      wallIndexVariance: 0,
      verticalBandVariance: 0,
      confidenceVariance: 0,
    };
  }

  const reference = passTelemetry[0];
  let graphHashVariance = 0;
  let signatureVariance = 0;
  let bboxVariance = 0;
  let wallIndexVariance = 0;
  let verticalBandVariance = 0;
  let confidenceVariance = 0;

  for (const candidate of passTelemetry.slice(1)) {
    if (candidate.graphHash !== reference.graphHash) graphHashVariance += 1;
    const overlap = Math.min(reference.openings.length, candidate.openings.length);
    for (let index = 0; index < overlap; index += 1) {
      const left = reference.openings[index];
      const right = candidate.openings[index];
      if (left.signature !== right.signature) signatureVariance += 1;
      if (left.wallIndex !== right.wallIndex) wallIndexVariance += 1;
      if (left.verticalBand !== right.verticalBand) verticalBandVariance += 1;
      if (
        Math.max(
          Math.abs(left.bbox[0] - right.bbox[0]),
          Math.abs(left.bbox[1] - right.bbox[1]),
          Math.abs(left.bbox[2] - right.bbox[2]),
          Math.abs(left.bbox[3] - right.bbox[3])
        ) >= OPENING_BBOX_VARIANCE_THRESHOLD
      ) {
        bboxVariance += 1;
      }
      if (Math.abs(left.confidence - right.confidence) >= OPENING_CONFIDENCE_VARIANCE_THRESHOLD) {
        confidenceVariance += 1;
      }
    }
    signatureVariance += Math.abs(reference.openings.length - candidate.openings.length);
  }

  return {
    graphHashVariance,
    signatureVariance,
    bboxVariance,
    wallIndexVariance,
    verticalBandVariance,
    confidenceVariance,
  };
}

async function materializeOpeningExtractionImage(
  imageUrl: string,
  options?: { jobId?: string; imageId?: string; attempt?: number; timing?: BaselineExtractionTimingBreakdown }
): Promise<{ data: string; mime: string }> {
  const materializeStartedAt = Date.now();
  const materialized = toBase64(imageUrl);
  const elapsedMs = Date.now() - materializeStartedAt;
  if (options?.timing) {
    options.timing.imageDownloadMs += elapsedMs;
    options.timing.imageMaterializationMs += 0;
    options.timing.imageResizeMs += 0;
  }
  return materialized;
}

function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortObject(entry));
  }
  if (!value || typeof value !== "object") return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      const nextValue = (value as Record<string, unknown>)[key];
      if (nextValue !== undefined) {
        accumulator[key] = stableSortObject(nextValue);
      }
      return accumulator;
    }, {});
}

const CANONICAL_APERTURE_IDENTITY = "window_door_neutral_aperture";

function getCanonicalOpeningIdentityType(type: StructuralOpeningType): string {
  return type === "window" || type === "door"
    ? CANONICAL_APERTURE_IDENTITY
    : type;
}

function bboxCenterY(bbox: [number, number, number, number]): number {
  return (bbox[1] + bbox[3]) / 2;
}

function bboxIntersectionOverSmallerArea(
  left: [number, number, number, number],
  right: [number, number, number, number]
): number {
  const smallerArea = Math.max(0.0001, Math.min(bboxArea(left), bboxArea(right)));
  return bboxIntersectionArea(left, right) / smallerArea;
}

function bboxCentroidDistance(
  left: [number, number, number, number],
  right: [number, number, number, number]
): number {
  const dx = bboxCenterX(left) - bboxCenterX(right);
  const dy = bboxCenterY(left) - bboxCenterY(right);
  return Math.sqrt((dx * dx) + (dy * dy));
}

function hasApertureSimilarity(left: StructuralOpening, right: StructuralOpening): boolean {
  const leftArea = Math.max(0.0001, bboxArea(left.bbox));
  const rightArea = Math.max(0.0001, bboxArea(right.bbox));
  const areaRatio = Math.max(leftArea, rightArea) / Math.min(leftArea, rightArea);
  return wallCoverageBandDistance(left.wallCoverageBand, right.wallCoverageBand) <= 1 || areaRatio <= 1.8;
}

function shouldCanonicalizeOpeningIdentity(
  left: StructuralOpening,
  right: StructuralOpening,
  rightCanonicalWall: WallIndex = right.wallIndex
): boolean {
  if (left.type === right.type) return false;
  if (getCanonicalOpeningIdentityType(left.type) !== getCanonicalOpeningIdentityType(right.type)) return false;
  if (rightCanonicalWall !== left.wallIndex) return false;

  const geometryOverlap = bboxIntersectionOverSmallerArea(left.bbox, right.bbox);
  const centroidDistance = bboxCentroidDistance(left.bbox, right.bbox);
  if (geometryOverlap < 0.45 || centroidDistance > 0.12) return false;

  return hasApertureSimilarity(left, right);
}

function buildCanonicalizationReason(
  left: StructuralOpening,
  right: StructuralOpening,
  rightCanonicalWall: WallIndex = right.wallIndex
): string {
  return [
    `same_wall:${rightCanonicalWall === left.wallIndex}`,
    `geometry_overlap:${bboxIntersectionOverSmallerArea(left.bbox, right.bbox).toFixed(3)}`,
    `centroid_distance:${bboxCentroidDistance(left.bbox, right.bbox).toFixed(3)}`,
    `aperture_similarity:${hasApertureSimilarity(left, right)}`,
  ].join("|");
}

function structuralOpeningSignature(opening: StructuralOpening): Record<string, unknown> {
  const canonicalIdentity = getCanonicalOpeningIdentityType(opening.type);
  const subtypeNeutralIdentity = canonicalIdentity === CANONICAL_APERTURE_IDENTITY;

  return {
    canonicalIdentity,
    bbox: quantizeBbox(opening.bbox),
    wallIndex: opening.wallIndex,
    horizontalBand: opening.horizontalBand,
    verticalBand: opening.verticalBand,
    wallCoverageBand: opening.wallCoverageBand,
    orientation: opening.orientation,
    paneStructure: subtypeNeutralIdentity ? undefined : opening.paneStructure,
    doorLeafState: subtypeNeutralIdentity ? undefined : opening.doorLeafState,
    wallPosition: opening.wallPosition,
    relativeHorizontalPosition: opening.relativeHorizontalPosition,
    shape: subtypeNeutralIdentity ? undefined : opening.shape,
    touchesFloor: subtypeNeutralIdentity ? undefined : opening.touchesFloor,
    touchesCeiling: subtypeNeutralIdentity ? undefined : opening.touchesCeiling,
    approxCount: opening.approxCount,
  };
}

function structuralFixtureSignature(fixture: AnchorFixture): Record<string, unknown> {
  return {
    type: fixture.type,
    wallIndex: fixture.wallIndex,
    horizontalBand: fixture.horizontalBand,
  };
}

function hashStructuralBaselineGraph(baseline: StructuralBaseline): string {
  const canonical = stableSortObject({
    cameraOrientation: baseline.cameraOrientation ?? null,
    openings: (baseline.openings || [])
      .map((opening) => structuralOpeningSignature(opening))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    anchorFixtures: (baseline.anchorFixtures || [])
      .map((fixture) => structuralFixtureSignature(fixture))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function getStructuralBaselineGraphHash(baseline: StructuralBaseline): string {
  return hashStructuralBaselineGraph(baseline);
}

function hashStructuralImage(imageData: string): string {
  return createHash("sha256").update(imageData, "base64").digest("hex");
}

function openingCountVariance(graphs: StructuralBaseline[]): { min: number; max: number; variance: number } {
  const counts = graphs.map((graph) => Number(graph.openings?.length || 0));
  if (counts.length === 0) {
    return { min: 0, max: 0, variance: 0 };
  }
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return { min, max, variance: max - min };
}

const OPENING_VALIDATOR_MODEL = String(
  process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro"
);
const WINDOW_SILL_MAX_SHIFT = Number(process.env.OPENING_WINDOW_SILL_MAX_SHIFT || 0.1);
const OPENING_APERTURE_EXPANSION_MAX = Number(process.env.OPENING_APERTURE_EXPANSION_MAX || 0.45);
const OPENING_STATE_CONFIDENCE_MIN = Number(process.env.OPENING_STATE_CONFIDENCE_MIN || 0.9);
const OPENING_APERTURE_CONFIDENCE_MIN = Number(process.env.OPENING_APERTURE_CONFIDENCE_MIN || 0.9);

const BASELINE_SYSTEM_INSTRUCTION = `You are an observation-only architectural extractor.

You must only answer: "What do I see?"
You must produce three outputs only: inventory, observed walls, and confidence facets.
You must not infer room topology or adjacency.
You must not decide whether walls connect.
You must not assign semantic wall identity.
You must not assign graph relationships.
You must not decide anchor priority.
You must not generate canonical wall IDs.
You must not output PASS/FAIL or structural conclusions.

Stage 1 inventory rules:
- List only permanent architectural elements.
- If none exist, return empty arrays.
- Do not invent items.

Stage 2 wall observation rules:
- observedOrdinal is left-to-right visual order only.
- Describe only what is visible on each observed wall plane.
- Do not name or classify walls semantically.
- Extract structural building wall planes that define the room envelope.
- Do not split walls into separate planes because of built-in joinery faces.
- Built-in cabinetry, pantry faces, appliance surrounds, shelving, and similar joinery are attributes on a structural wall, not separate walls.
- Kitchen island faces, cabinet sides, wardrobe faces, and furniture-like faces are not structural walls.
- Only create additional wall planes for genuine structural returns, recesses, projections, or corners.

Developer Note:
The Envelope Validator intentionally models the architectural envelope, not every visible vertical surface.
Built-in joinery frequently subdivides one structural wall into multiple visible faces.
Treating these as separate walls reduces baseline determinism and provides no additional value for envelope validation.
When in doubt, prefer the underlying structural wall and record joinery as wall attributes rather than creating extra wall identities.

If uncertain, return "unknown".
Do not guess.
Do not invent.

Return strict JSON only.
No markdown.
No comments.
No extra prose.`;

const BASELINE_USER_PROMPT = `Analyze this room image and return baseline observations using this exact schema:

{
  "inventory": {
    "openings": ["window" | "sliding_door" | "hinged_door" | "closet_door" | "walkthrough"],
    "permanentFixtures": ["air_conditioner" | "built_in_cabinet" | "fireplace" | "staircase"],
    "architecturalFeatures": ["recessed_wall" | "chimney" | "structural_column"]
  },
  "observedWalls": [
    {
      "observedOrdinal": number,
      "containsOpenings": string[],
      "containsPermanentFixtures": string[],
      "containsArchitecturalFeatures": string[],
      "openingObservations": [
        {
          "type": "window" | "door" | "closet_door" | "walkthrough",
          "bbox": [x1, y1, x2, y2]
        }
      ],
      "leftSide": {
        "cornerVisible": boolean,
        "cornerPosition": "outer_third" | "middle_third" | "unknown",
        "returnWallVisible": "none" | "minimal" | "partial" | "full" | "unknown"
      },
      "rightSide": {
        "cornerVisible": boolean,
        "cornerPosition": "outer_third" | "middle_third" | "unknown",
        "returnWallVisible": "none" | "minimal" | "partial" | "full" | "unknown"
      },
      "frameEdgeObservations": {
        "leftEdgeLocation": "outside_frame" | "outer_third" | "central_image" | "unknown",
        "rightEdgeLocation": "outside_frame" | "outer_third" | "central_image" | "unknown"
      }
    }
  ]
}

Rules:
- observedWalls must be listed by observed visual order from left-to-right.
- observedOrdinal is only observation order, not wall identity.
- inventory values must use only the allowed ontology values above.
- If uncertain, omit the inventory item. Never invent inventory anchors.
- A wall may reference only inventory items or blank wall labels.
- Allowed blank wall labels: "blank_wall", "largest_blank_wall", "blank_wall_left_of_window", "blank_wall_right_of_window".
- Extract structural wall planes only (the building envelope that materially defines the room).
- Do not create separate observed walls for kitchen island faces, pantry faces, cabinet sides, wardrobe faces, appliance enclosures, shelving, or furniture-like vertical faces.
- If joinery is mounted on a structural wall, keep one structural wall and attach joinery via containsPermanentFixtures/containsArchitecturalFeatures.
- Only split into additional walls when a genuine structural return, recess, projection, or corner is visible.
- Do not output wall adjacency claims.
- bbox values must be normalized (0..1).
- Exclude temporary/movable objects and decor from structural observations.
- Do not infer missing geometry.
- Do not return confidence fields.
- Do not return free-text observations.

Return only valid JSON.`;


const BASELINE_VERIFICATION_SYSTEM_INSTRUCTION = `You are a structural baseline verification reviewer.

You must verify a provided baseline extraction against a room image.
Do not regenerate the full baseline.
Do not perform a fresh extraction.

Review each listed opening and classify exactly one status:
- confirmed
- confirmed_with_minor_description_difference
- materially_different
- not_present

Also report:
- additionalOpenings: openings visible in image but missing from baseline
- missingOpenings: baseline openings that cannot be confirmed in image
- baselineAccepted: true only when inventory is materially correct

Rules:
- Minor differences are tolerated only for descriptive metadata noise.
- Material differences include wrong opening type, wrong approximate location, or wrong inventory composition.
- Return strict JSON only. No markdown, no commentary.`;

const BASELINE_VERIFICATION_USER_PROMPT = `Verify this provided structural baseline against the image.

Input includes:
1) The room image.
2) The baseline JSON from extraction pass 1.

Return JSON in this schema:
{
  "openings": [
    {
      "id": string,
      "status": "confirmed" | "confirmed_with_minor_description_difference" | "materially_different" | "not_present",
      "notes": string
    }
  ],
  "additionalOpenings": [
    {
      "id": string,
      "type": string,
      "location": string,
      "notes": string
    }
  ],
  "missingOpenings": [
    {
      "id": string,
      "type": string,
      "location": string,
      "notes": string
    }
  ],
  "baselineAccepted": boolean,
  "analysis": string
}

Return only valid JSON.`;

function resolveBaselineMode(options?: BaselineExtractionOptions): BaselineArchitectureMode {
  if (options?.baselineMode) return options.baselineMode;
  return "single_pass_observation";
}

function getBaselineVerificationModel(): string {
  return OPENING_BASELINE_VERIFICATION_MODEL || OPENING_VALIDATOR_MODEL;
}

function isBaselineVerificationStatus(value: string): value is BaselineVerificationStatus {
  return (
    value === "confirmed" ||
    value === "confirmed_with_minor_description_difference" ||
    value === "materially_different" ||
    value === "not_present"
  );
}

function normalizeVerificationIssue(entry: unknown): BaselineVerificationIssue | null {
  if (typeof entry === "string") {
    return { notes: entry.trim() || undefined };
  }
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : undefined;
  const type = typeof value.type === "string" && value.type.trim().length > 0 ? value.type.trim() : undefined;
  const location = typeof value.location === "string" && value.location.trim().length > 0 ? value.location.trim() : undefined;
  const notes = typeof value.notes === "string" && value.notes.trim().length > 0
    ? value.notes.trim()
    : (typeof value.reason === "string" && value.reason.trim().length > 0 ? value.reason.trim() : undefined);
  return { id, type, location, notes };
}

function isWallAssignmentOnlyVerificationNote(notes: string | undefined): boolean {
  const text = String(notes || "").toLowerCase();
  if (!text) return false;

  const mentionsWallAssignment = /wall\s*index|wrong wall|assigned to .*wall|incorrectly assigned|located on the .* wall|mislocat|wall assignment/.test(text);
  const mentionsMaterialTypeMismatch = /incorrect type|misclassif|wrong type|not a .*door|not a .*window|not a .*walkthrough|phantom|not visible|missing|absent/.test(text);
  const mentionsSizeOrBBoxMismatch = /size|larger|smaller|split|bounding box|bbox|coordinates|width|height|span|wider|narrow|area/.test(text);

  return mentionsWallAssignment && !mentionsMaterialTypeMismatch && !mentionsSizeOrBBoxMismatch;
}

function validateBaselineVerificationResult(input: any, baseline: StructuralBaseline): BaselineVerificationResult {
  if (!input || typeof input !== "object") {
    throw new Error("Baseline verification result must be an object");
  }

  const baselineIds = new Set(baseline.openings.map((opening) => String(opening.id)));
  const seenIds = new Set<string>();

  const openingsRaw = Array.isArray(input.openings) ? input.openings : [];
  const openings: BaselineVerificationOpeningResult[] = openingsRaw.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid verification opening result at index ${index}`);
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error(`Verification opening id is required at index ${index}`);
    }
    const id = entry.id.trim();
    if (!baselineIds.has(id)) {
      throw new Error(`Verification opening id not found in baseline: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate verification opening id: ${id}`);
    }
    seenIds.add(id);

    const status = String(entry.status || "").trim();
    if (!isBaselineVerificationStatus(status)) {
      throw new Error(`Invalid verification status for opening ${id}`);
    }

    return {
      id,
      status,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
    };
  });

  for (const opening of baseline.openings) {
    const id = String(opening.id);
    if (!seenIds.has(id)) {
      openings.push({ id, status: "materially_different", notes: "missing_verification_result" });
    }
  }

  const additionalOpenings = Array.isArray(input.additionalOpenings)
    ? input.additionalOpenings
      .map((entry: unknown) => normalizeVerificationIssue(entry))
      .filter((entry: BaselineVerificationIssue | null): entry is BaselineVerificationIssue => entry !== null)
    : [];

  const missingOpenings = Array.isArray(input.missingOpenings)
    ? input.missingOpenings
      .map((entry: unknown) => normalizeVerificationIssue(entry))
      .filter((entry: BaselineVerificationIssue | null): entry is BaselineVerificationIssue => entry !== null)
    : [];

  const baselineAccepted = input.baselineAccepted === true;

  return {
    openings: openings.sort((left, right) => compareStrings(left.id, right.id)),
    additionalOpenings,
    missingOpenings,
    baselineAccepted,
    analysis: typeof input.analysis === "string" ? input.analysis : undefined,
  };
}

function openingInventoryToken(opening: StructuralOpening): string {
  return [
    getCanonicalOpeningIdentityType(opening.type),
    String(opening.wallIndex),
    opening.horizontalBand,
    opening.verticalBand,
  ].join("|");
}

function openingInventorySignature(baseline: StructuralBaseline): string {
  return baseline.openings
    .map((opening) => openingInventoryToken(opening))
    .sort(compareStrings)
    .join("::");
}

function mergeCanonicalBaselineFromFallback(
  primary: StructuralBaseline,
  secondary: StructuralBaseline
): StructuralBaseline {
  const mergedByToken = new Map<string, StructuralOpening>();
  for (const opening of [...primary.openings, ...secondary.openings]) {
    const token = openingInventoryToken(opening);
    const existing = mergedByToken.get(token);
    if (!existing || opening.confidence > existing.confidence) {
      mergedByToken.set(token, opening);
    }
  }

  const mergedOpenings = Array.from(mergedByToken.values()).sort(compareStructuralOpenings);
  const mergedAnchorFixtures = [...(primary.anchorFixtures || []), ...(secondary.anchorFixtures || [])]
    .sort(compareAnchorFixtures)
    .slice(0, Math.max((primary.anchorFixtures || []).length, (secondary.anchorFixtures || []).length));

  return {
    cameraOrientation: primary.cameraOrientation || secondary.cameraOrientation,
    openings: mergedOpenings,
    anchorFixtures: mergedAnchorFixtures,
  };
}

function isAnchorFixtureType(value: string): value is AnchorFixtureType {
  return (
    value === "ac_unit" ||
    value === "fireplace" ||
    value === "built_in_cabinet" ||
    value === "kitchen_island" ||
    value === "staircase" ||
    value === "other"
  );
}

function normalizeAnchorFixtureType(value: unknown): AnchorFixtureType {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "ac_unit" || raw === "aircon" || raw === "air_conditioner") return "ac_unit";
  if (raw === "fireplace") return "fireplace";
  if (raw === "built_in_cabinet" || raw === "built_in" || raw === "cabinetry") return "built_in_cabinet";
  if (raw === "kitchen_island" || raw === "island") return "kitchen_island";
  if (raw === "staircase" || raw === "stairs") return "staircase";
  return "other";
}

function extractJsonCandidate(text: string): string {
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;

  let start = -1;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (start === -1) start = index;
      depth += 1;
    } else if (char === "}" && start !== -1) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return text.trim();
}

function parseJsonResponse(rawResponse: any): any {
  const textParts = rawResponse?.candidates?.[0]?.content?.parts || [];
  const rawText = textParts.map((p: any) => p?.text || "").join("\n").trim();
  const jsonCandidate = extractJsonCandidate(rawText);
  return JSON.parse(jsonCandidate);
}

function isOpeningType(value: string): value is StructuralOpeningType {
  return value === "window" || value === "door" || value === "closet_door" || value === "walkthrough";
}

function normalizeOpeningType(value: unknown): StructuralOpeningType | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "window") return "window";
  if (raw === "door" || raw === "exterior_door" || raw === "interior_door") return "door";
  if (raw === "closet" || raw === "closet_door" || raw === "closet door" || raw === "wardrobe_door" || raw === "wardrobe sliding door" || raw === "sliding_closet_panel") return "closet_door";
  if (raw === "archway" || raw === "walkthrough" || raw === "walk-through" || raw === "walk_through" || raw === "pass_through" || raw === "passthrough") return "walkthrough";
  return null;
}

function isWallPosition(value: string): value is WallPosition {
  return value === "left_wall" || value === "right_wall" || value === "far_wall" || value === "near_wall";
}

function isRelativeHorizontalPosition(value: string): value is RelativeHorizontalPosition {
  return value === "left_third" || value === "center" || value === "right_third";
}

function isWallIndex(value: number): value is WallIndex {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isHorizontalBand(value: string): value is HorizontalBand {
  return value === "left_third" || value === "center_third" || value === "right_third";
}

function isVerticalBand(value: string): value is VerticalBand {
  return value === "floor_zone" || value === "mid_zone" || value === "ceiling_zone" || value === "full_height";
}

function isWallCoverageBand(value: string): value is WallCoverageBand {
  return value === "5-10" || value === "10-20" || value === "20-40" || value === "40-60" || value === "60+";
}

function isOpeningOrientation(value: string): value is OpeningOrientation {
  return value === "portrait" || value === "landscape" || value === "square";
}

function isPaneStructure(value: string): value is PaneStructure {
  return (
    value === "single_fixed" ||
    value === "double_fixed" ||
    value === "fixed_plus_opening" ||
    value === "sliding_panel" ||
    value === "multi_pane_grid" ||
    value === "unknown"
  );
}

function isDoorLeafState(value: string): value is DoorLeafState {
  return value === "closed" || value === "open" || value === "ajar" || value === "unknown";
}

function normalizeDoorLeafState(value: unknown, openingType: StructuralOpeningType): DoorLeafState {
  if (openingType !== "door" && openingType !== "closet_door") return "unknown";
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "closed" || raw === "shut" || raw === "sealed") return "closed";
  if (raw === "open" || raw === "opened" || raw === "fully_open") return "open";
  if (raw === "ajar" || raw === "partially_open" || raw === "part-open") return "ajar";
  return "unknown";
}

function normalizePaneStructure(value: unknown): PaneStructure {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "single_fixed" || raw === "single pane" || raw === "single") return "single_fixed";
  if (raw === "double_fixed" || raw === "double pane" || raw === "double") return "double_fixed";
  if (raw === "fixed_plus_opening" || raw === "fixed+opening") return "fixed_plus_opening";
  if (raw === "sliding_panel" || raw === "sliding" || raw === "slider") return "sliding_panel";
  if (raw === "multi_pane_grid" || raw === "grid" || raw === "multi pane") return "multi_pane_grid";
  return "unknown";
}

function deriveOrientation(aspectRatio: number): OpeningOrientation {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return "square";
  if (aspectRatio >= 1.15) return "landscape";
  if (aspectRatio <= 0.85) return "portrait";
  return "square";
}

function deriveWallCoverageBand(areaPct: number): WallCoverageBand {
  const area = Number.isFinite(areaPct) ? Math.max(0, areaPct) : 0;
  if (area < 10) return "5-10";
  if (area < 20) return "10-20";
  if (area < 40) return "20-40";
  if (area < 60) return "40-60";
  return "60+";
}

function wallCoverageBandIndex(value: WallCoverageBand): number {
  if (value === "5-10") return 0;
  if (value === "10-20") return 1;
  if (value === "20-40") return 2;
  if (value === "40-60") return 3;
  return 4;
}

function mapWallPositionToIndex(wallPosition: WallPosition): WallIndex {
  if (wallPosition === "near_wall") return 0;
  if (wallPosition === "right_wall") return 1;
  if (wallPosition === "far_wall") return 2;
  return 3;
}

function mapIndexToWallPosition(wallIndex: WallIndex): WallPosition {
  if (wallIndex === 0) return "near_wall";
  if (wallIndex === 1) return "right_wall";
  if (wallIndex === 2) return "far_wall";
  return "left_wall";
}

function mapLegacyHorizontalToBand(value: RelativeHorizontalPosition): HorizontalBand {
  if (value === "left_third") return "left_third";
  if (value === "right_third") return "right_third";
  return "center_third";
}

function mapBandToLegacyHorizontal(value: HorizontalBand): RelativeHorizontalPosition {
  if (value === "left_third") return "left_third";
  if (value === "right_third") return "right_third";
  return "center";
}

function describeWallIndex(wallIndex: WallIndex): string {
  if (wallIndex === 0) return "near wall";
  if (wallIndex === 1) return "right wall";
  if (wallIndex === 2) return "far wall";
  return "left wall";
}

function describeHorizontalBand(band: HorizontalBand): string {
  if (band === "left_third") return "left side";
  if (band === "right_third") return "right side";
  return "center";
}

function describeOpeningType(type: StructuralOpeningType): string {
  if (type === "window") return "window opening";
  if (type === "door") return "door opening";
  if (type === "closet_door") return "closet door opening";
  return "walk-through opening";
}

function describeOpeningLocation(
  opening: Pick<StructuralOpening, "type" | "wallIndex" | "horizontalBand">
): string {
  return `${describeOpeningType(opening.type)} in the ${describeHorizontalBand(opening.horizontalBand)} of the ${describeWallIndex(opening.wallIndex)}`;
}

function joinFragments(fragments: string[]): string {
  if (fragments.length === 0) return "appears different from the original image";
  if (fragments.length === 1) return fragments[0];
  if (fragments.length === 2) return `${fragments[0]} and ${fragments[1]}`;
  return `${fragments.slice(0, -1).join(", ")}, and ${fragments[fragments.length - 1]}`;
}

function buildAlteredOpeningNarrative(
  opening: Pick<StructuralOpening, "type" | "wallIndex" | "horizontalBand">
, invariantReasons: string[]
): { explanation: string; question: string } {
  const location = describeOpeningLocation(opening);
  const movedWall = invariantReasons.includes("wall_index_changed");
  const shiftedOnWall = invariantReasons.includes("horizontal_band_changed") || invariantReasons.includes("vertical_band_changed");
  const resized = invariantReasons.some((reason) =>
    reason === "wall_coverage_band_changed_gt_one" ||
    reason === "pane_structure_changed" ||
    reason === "orientation_changed" ||
    reason.startsWith("window_sill_shift_gt_") ||
    reason.startsWith("aperture_expanded_gt_")
  );
  const typeChanged = invariantReasons.includes("opening_type_changed");
  const stateChanged = invariantReasons.includes("door_leaf_state_changed");

  const fragments: string[] = [];
  if (movedWall) fragments.push("appears on a different wall than in the original image");
  if (!movedWall && shiftedOnWall) fragments.push("appears shifted from its original wall position");
  if (resized) fragments.push("appears materially different in size or shape");
  if (typeChanged) fragments.push("appears to have changed opening type");
  if (stateChanged) fragments.push("appears in a different door-leaf state");

  let question = `Does the ${location} retain the same position and structure as in the original image?`;
  if (movedWall) {
    question = `Is the ${location} still present on the same wall as in the original image, or does it now appear on a different wall?`;
  } else if (typeChanged) {
    question = `Does the ${location} still appear as the same type of opening as in the original image?`;
  } else if (resized) {
    question = `Does the ${location} retain the same visible size and shape as in the original image?`;
  } else if (shiftedOnWall) {
    question = `Is the ${location} still in the same wall position as in the original image?`;
  }

  return {
    explanation: `The ${location} ${joinFragments(fragments)}.`,
    question,
  };
}

function deriveVerticalBand(opening: Pick<StructuralOpening, "touchesFloor" | "touchesCeiling">): VerticalBand {
  if (opening.touchesFloor && opening.touchesCeiling) return "full_height";
  if (opening.touchesFloor) return "floor_zone";
  if (opening.touchesCeiling) return "ceiling_zone";
  return "mid_zone";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function bboxArea(bbox: [number, number, number, number]): number {
  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  return width * height;
}

function bboxIntersectionArea(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function wallCoverageBandDistance(a: WallCoverageBand, b: WallCoverageBand): number {
  return Math.abs(wallCoverageBandIndex(a) - wallCoverageBandIndex(b));
}

function buildDetectedToBaselineWallRemap(
  baselineOpenings: StructuralOpening[],
  detectedOpenings: StructuralOpening[]
): Map<number, number> {
  const votes = new Map<number, Map<number, number>>();
  const safeVote = (detectedWall: number, baselineWall: number): void => {
    const bucket = votes.get(detectedWall) ?? new Map<number, number>();
    bucket.set(baselineWall, (bucket.get(baselineWall) ?? 0) + 1);
    votes.set(detectedWall, bucket);
  };

  for (const candidate of detectedOpenings) {
    const direct = baselineOpenings.find((base) => String(base.id) === String(candidate.id));
    if (direct) {
      safeVote(candidate.wallIndex, direct.wallIndex);
    }
  }

  const remap = new Map<number, number>();
  votes.forEach((bucket, detectedWall) => {
    let topWall: number | null = null;
    let topCount = 0;
    let tied = false;
    bucket.forEach((count, baselineWall) => {
      if (count > topCount) {
        topWall = baselineWall;
        topCount = count;
        tied = false;
      } else if (count === topCount) {
        tied = true;
      }
    });
    if (!tied && topWall !== null) {
      remap.set(detectedWall, topWall);
    }
  });
  return remap;
}

function reconcileOpeningMatches(
  baselineOpenings: StructuralOpening[],
  detectedOpenings: StructuralOpening[]
): {
  matches: Map<string, { opening: StructuralOpening; source: "id" | "graph_reconcile"; score: number }>;
  matchedDetectedIds: Set<string>;
  debug: Array<{ baselineId: string; detectedId: string; matchSource: "id" | "graph_reconcile"; score: number }>;
} {
  const matches = new Map<string, { opening: StructuralOpening; source: "id" | "graph_reconcile"; score: number }>();
  const matchedDetectedIds = new Set<string>();
  const debug: Array<{ baselineId: string; detectedId: string; matchSource: "id" | "graph_reconcile"; score: number }> = [];

  const wallRemap = buildDetectedToBaselineWallRemap(baselineOpenings, detectedOpenings);

  for (const base of baselineOpenings) {
    const direct = detectedOpenings.find((candidate) =>
      String(candidate.id) === String(base.id) && !matchedDetectedIds.has(String(candidate.id))
    );
    if (!direct) continue;
    matches.set(base.id, { opening: direct, source: "id", score: 999 });
    matchedDetectedIds.add(String(direct.id));
    debug.push({ baselineId: base.id, detectedId: String(direct.id), matchSource: "id", score: 999 });
  }

  const unmatchedBaseline = baselineOpenings.filter((base) => !matches.has(base.id));

  for (const base of unmatchedBaseline) {
    const scoredCandidates = detectedOpenings
      .filter((candidate) => !matchedDetectedIds.has(String(candidate.id)))
      .map((candidate) => {
        const canonicalWall = (wallRemap.get(candidate.wallIndex) ?? candidate.wallIndex) as WallIndex;
        let score = 0;
        const canonicalIdentityApplied = shouldCanonicalizeOpeningIdentity(base, candidate, canonicalWall);

        if (candidate.type === base.type || canonicalIdentityApplied) score += 4;
        if (canonicalWall === base.wallIndex) score += 3;
        if (candidate.horizontalBand === base.horizontalBand) score += 2;
        if (candidate.verticalBand === base.verticalBand) score += 1;
        if (candidate.orientation === base.orientation) score += 0.5;

        const paneComparable = candidate.paneStructure !== "unknown" && base.paneStructure !== "unknown";
        if (!paneComparable || candidate.paneStructure === base.paneStructure) score += 1;

        const wallCoverageDistance = wallCoverageBandDistance(candidate.wallCoverageBand, base.wallCoverageBand);
        if (wallCoverageDistance === 0) score += 1;
        else if (wallCoverageDistance === 1) score += 0.5;

        const iou = bboxIntersectionArea(base.bbox, candidate.bbox) /
          Math.max(0.0001, (base.bbox[2] - base.bbox[0]) * (base.bbox[3] - base.bbox[1]));
        score += Math.max(0, Math.min(2, iou * 2));

        return {
          candidate,
          score,
          canonicalIdentityApplied,
          canonicalIdentityReason: canonicalIdentityApplied
            ? buildCanonicalizationReason(base, candidate, canonicalWall)
            : undefined,
        };
      })
      .sort((left, right) => {
        const scoreCmp = compareNumbers(right.score, left.score, 1e-9);
        if (scoreCmp !== 0) return scoreCmp;
        return compareStructuralOpenings(left.candidate, right.candidate);
      });

    const top = scoredCandidates[0];
    const second = scoredCandidates[1];
    const hasUniqueWinner =
      !!top &&
      top.score >= 7 &&
      (top.score - (second?.score ?? 0) >= 1.25);

    if (!hasUniqueWinner || !top) continue;

    if (top.canonicalIdentityApplied) {
      console.log("[CANONICALIZATION_APPLIED]", JSON.stringify({
        openingId: base.id,
        originalTypes: [base.type, top.candidate.type],
        canonicalIdentity: CANONICAL_APERTURE_IDENTITY,
        reason: top.canonicalIdentityReason,
      }));
    }

    matches.set(base.id, {
      opening: top.candidate,
      source: "graph_reconcile",
      score: Number(top.score.toFixed(3)),
    });
    matchedDetectedIds.add(String(top.candidate.id));
    debug.push({
      baselineId: base.id,
      detectedId: String(top.candidate.id),
      matchSource: "graph_reconcile",
      score: Number(top.score.toFixed(3)),
    });
  }

  return { matches, matchedDetectedIds, debug };
}

export function classifyNonWindowOpeningAreaLoss(params: {
  baseOpening: StructuralOpening;
  detectedOpening: StructuralOpening;
  areaDelta: number;
  invariantReasons: string[];
}): {
  classifyAsInfilled: boolean;
  occlusionLikely: boolean;
  frameBoundaryTruncationLikely: boolean;
  semanticAnchorErosionLikely: boolean;
  continuityCollapseLikely: boolean;
  anchorsLikelyPresent: boolean;
  retention: number;
  overlapToBaseline: number;
} {
  const { baseOpening, detectedOpening, areaDelta, invariantReasons } = params;
  const baseArea = Math.max(0.0001, bboxArea(baseOpening.bbox));
  const detectedArea = Math.max(0.0001, bboxArea(detectedOpening.bbox));
  const retention = clamp01(detectedArea / baseArea);
  const overlap = bboxIntersectionArea(baseOpening.bbox, detectedOpening.bbox);
  const overlapToBaseline = clamp01(overlap / baseArea);

  const hasMajorLocationShift =
    invariantReasons.includes("wall_index_changed") ||
    invariantReasons.includes("horizontal_band_changed") ||
    invariantReasons.includes("vertical_band_changed");
  const hasTypeOrGeometryMutation =
    invariantReasons.includes("opening_type_changed") ||
    invariantReasons.includes("pane_structure_changed") ||
    invariantReasons.includes("orientation_changed");
  const hasCoverageBandJump = invariantReasons.includes("wall_coverage_band_changed_gt_one");
  const baseNearFrame = isEdgeOfFrameOpening(baseOpening, 0.03);
  const detectedNearFrame = isEdgeOfFrameOpening(detectedOpening, 0.03);
  const frameBoundaryTruncationLikely =
    (baseNearFrame || detectedNearFrame) &&
    overlapToBaseline >= 0.3 &&
    !hasMajorLocationShift &&
    !hasTypeOrGeometryMutation;

  const paneAnchorConsistent =
    baseOpening.paneStructure === "unknown" ||
    detectedOpening.paneStructure === "unknown" ||
    baseOpening.paneStructure === detectedOpening.paneStructure;
  const doorStateAnchorConsistent =
    baseOpening.doorLeafState === "unknown" ||
    detectedOpening.doorLeafState === "unknown" ||
    baseOpening.doorLeafState === detectedOpening.doorLeafState;
  const orientationAnchorConsistent =
    !invariantReasons.includes("orientation_changed") ||
    baseOpening.orientation === detectedOpening.orientation;

  const anchorsLikelyPresent =
    paneAnchorConsistent ||
    doorStateAnchorConsistent ||
    frameBoundaryTruncationLikely;

  // "Perceptual existence" rule: if the opening remains in the same region with
  // meaningful retained aperture, treat this as likely staging occlusion unless
  // other strong structural mutation evidence exists.
  const stillPerceptuallyPresent =
    retention >= 0.42 &&
    overlapToBaseline >= 0.35 &&
    !hasMajorLocationShift &&
    !hasTypeOrGeometryMutation;

  const semanticAnchorErosionLikely =
    stillPerceptuallyPresent &&
    !frameBoundaryTruncationLikely &&
    !paneAnchorConsistent &&
    !doorStateAnchorConsistent &&
    orientationAnchorConsistent &&
    areaDelta >= 0.25;

  const severeLoss = retention < 0.3 || areaDelta >= 0.7;
  const moderateLossWithWeakPresence = areaDelta >= 0.35 && (retention < 0.42 || overlapToBaseline < 0.35);
  const continuityCollapseLikely = retention < 0.25 || overlapToBaseline < 0.2;

  const occlusionLikely =
    stillPerceptuallyPresent &&
    anchorsLikelyPresent &&
    !severeLoss &&
    (hasCoverageBandJump || areaDelta < 0.5);

  const classifyAsInfilled =
    severeLoss ||
    (semanticAnchorErosionLikely && continuityCollapseLikely) ||
    (areaDelta >= 0.5 && !stillPerceptuallyPresent) ||
    (moderateLossWithWeakPresence && !occlusionLikely);

  return {
    classifyAsInfilled,
    occlusionLikely,
    frameBoundaryTruncationLikely,
    semanticAnchorErosionLikely,
    continuityCollapseLikely,
    anchorsLikelyPresent,
    retention,
    overlapToBaseline,
  };
}

function isEdgeOfFrameOpening(opening: StructuralOpening, margin = 0.01): boolean {
  const [x1, y1, x2, y2] = opening.bbox;
  return x1 <= margin || y1 <= margin || x2 >= 1 - margin || y2 >= 1 - margin;
}

function normalizeBbox(
  input: any,
  horizontalBand: HorizontalBand,
  verticalBand: VerticalBand
): [number, number, number, number] {
  const arr = Array.isArray(input?.bbox) ? input.bbox : null;
  if (arr && arr.length === 4 && arr.every((v: any) => Number.isFinite(Number(v)))) {
    let x1 = clamp01(Number(arr[0]));
    let y1 = clamp01(Number(arr[1]));
    let x2 = clamp01(Number(arr[2]));
    let y2 = clamp01(Number(arr[3]));
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    if (x2 - x1 < 0.01) x2 = clamp01(x1 + 0.01);
    if (y2 - y1 < 0.01) y2 = clamp01(y1 + 0.01);
    return quantizeBbox([x1, y1, x2, y2]);
  }

  const [x1, x2] = horizontalBand === "left_third"
    ? [0.05, 0.35]
    : horizontalBand === "right_third"
      ? [0.65, 0.95]
      : [0.33, 0.67];

  const [y1, y2] = verticalBand === "floor_zone"
    ? [0.45, 0.98]
    : verticalBand === "ceiling_zone"
      ? [0.02, 0.40]
      : verticalBand === "full_height"
        ? [0.02, 0.98]
        : [0.22, 0.80];

  return quantizeBbox([x1, y1, x2, y2]);
}

function normalizeAreaPct(input: any, bbox: [number, number, number, number]): number {
  const raw = input?.area_pct ?? input?.areaPct;
  if (Number.isFinite(Number(raw))) {
    const numeric = Number(raw);
    const normalized = numeric <= 1 ? numeric * 100 : numeric;
    return Math.max(0, Math.min(100, normalized));
  }
  const bboxArea = Math.max(0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) * 100;
  return Math.max(0, Math.min(100, bboxArea));
}

function normalizeEdgeLocation(value: unknown): "outside_frame" | "outer_third" | "central_image" | "unknown" {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "outside_frame" || raw === "outside frame" || raw === "off_frame" || raw === "exits_frame") return "outside_frame";
  if (raw === "outer_third" || raw === "outer third" || raw === "near_frame_edge" || raw === "image_edge") return "outer_third";
  if (raw === "central_image" || raw === "central image" || raw === "centre" || raw === "center") return "central_image";
  return "unknown";
}

function normalizeCornerPositionObservation(value: unknown): WallDescriptor["leftCornerPosition"] {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "unknown" || raw === "none") return "none";
  if (raw === "middle_third" || raw === "middle third") return "centre";
  if (raw === "near_frame_edge" || raw === "image_edge" || raw === "outside_frame") return "image_edge";
  if (raw === "outer_third" || raw === "outer third") return "outer_third";
  if (raw === "inner_third" || raw === "inner third") return "inner_third";
  if (raw === "centre" || raw === "center" || raw === "central_image") return "centre";
  return "none";
}

function normalizeCornerExtent(value: unknown): WallDescriptor["leftCornerVisibility"] {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "unknown" || raw === "none") return "none";
  if (raw === "minimal" || raw === "trace") return "minimal";
  if (raw === "partial") return "partial";
  if (raw === "full" || raw === "substantial") return "full";
  return "none";
}

function normalizeReturnWallExtent(value: unknown): WallDescriptor["leftReturnWallVisibility"] {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "none") return "none";
  if (raw === "minimal") return "minimal";
  if (raw === "partial") return "partial";
  if (raw === "full" || raw === "substantial") return "full";
  return "unknown";
}

function visibilityFromReturnWallExtent(value: WallDescriptor["leftReturnWallVisibility"]): boolean | undefined {
  if (value === "none") return false;
  if (value === "minimal" || value === "partial" || value === "full") return true;
  return undefined;
}

function inferHorizontalBandFromBbox(bbox: [number, number, number, number]): HorizontalBand {
  const cx = (bbox[0] + bbox[2]) / 2;
  if (cx < 0.33) return "left_third";
  if (cx > 0.66) return "right_third";
  return "center_third";
}

function inferVerticalBandFromBbox(bbox: [number, number, number, number]): VerticalBand {
  const height = bbox[3] - bbox[1];
  const cy = (bbox[1] + bbox[3]) / 2;
  if (height >= 0.8) return "full_height";
  if (cy < 0.33) return "ceiling_zone";
  if (cy > 0.66) return "floor_zone";
  return "mid_zone";
}

function deriveWallClassRank(value: unknown): number {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "largest_plane") return 0;
  if (raw === "second_plane") return 1;
  if (raw === "third_plane") return 2;
  if (raw === "fragment") return 3;
  if (raw === "sliver") return 4;
  return 5;
}

function deriveWallVisibilityScore(value: unknown): number {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "full") return 3;
  if (raw === "partial") return 2;
  if (raw === "minimal") return 1;
  return 0;
}

function wallIndexFromSurfaceOrder(index: number, leftEdge: ReturnType<typeof normalizeEdgeLocation>, rightEdge: ReturnType<typeof normalizeEdgeLocation>): WallIndex {
  if (index <= 3) return index as WallIndex;
  if (leftEdge === "outside_frame" && rightEdge !== "outside_frame") return 3;
  if (rightEdge === "outside_frame" && leftEdge !== "outside_frame") return 1;
  return 2;
}

function normalizeFeatureTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && typeof (item as any).type === "string") {
        return String((item as any).type).trim();
      }
      return "";
    })
    .filter((item) => item.length > 0);
}

function normalizePermanentFeature(value: string): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "unknown" || raw === "none") return null;
  if (raw.includes("air_conditioner") || raw.includes("air conditioner")) return "ac_unit";
  if (raw.includes("sliding") && raw.includes("door")) return "sliding_door";
  if (raw.includes("hinged") && raw.includes("door")) return "door";
  if (raw.includes("door")) return "door";
  if (raw.includes("window")) return "window";
  if (raw.includes("ac") || raw.includes("air conditioning") || raw.includes("aircon")) return "ac_unit";
  if (raw.includes("fireplace")) return "fireplace";
  if (raw.includes("chimney")) return "fireplace";
  if (raw.includes("built-in") || raw.includes("cabinet")) return "built_in_cabinet";
  if (raw.includes("stair")) return "staircase";
  if (raw.includes("island")) return "kitchen_island";
  if (raw.includes("recessed_wall") || raw.includes("recessed wall")) return "recess";
  if (raw.includes("column")) return "structural_column";
  if (raw.includes("recess")) return "recess";
  if (raw.includes("niche")) return "niche";
  return null;
}

function isBlankWallReferenceLabel(value: string): boolean {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return raw.includes("blank_wall") || raw.includes("blank wall") || raw === "wall_plane" || raw.includes("plain wall");
}

function normalizePermanentFeaturesList(value: unknown): string[] {
  const seen = new Set<string>();
  for (const feature of normalizeFeatureTextList(value)) {
    const normalized = normalizePermanentFeature(feature);
    if (!normalized) continue;
    seen.add(normalized);
  }
  return [...seen].sort(compareStrings);
}

function anchorFeatureRank(feature: string): number {
  if (feature === "sliding_door") return 0;
  if (feature === "door") return 1;
  if (feature === "window") return 2;
  if (feature === "ac_unit") return 3;
  if (feature === "fireplace") return 4;
  if (feature === "built_in_cabinet") return 5;
  if (feature === "staircase") return 6;
  if (feature === "kitchen_island") return 7;
  if (feature === "structural_column") return 8;
  if (feature === "recess") return 9;
  if (feature === "niche") return 10;
  return 99;
}

function openingAnchorRank(type: StructuralOpeningType): number {
  if (type === "door") return 0;
  if (type === "window") return 1;
  if (type === "closet_door") return 2;
  return 3;
}

function normalizeFrameContinuation(value: unknown): "continues_beyond_frame" | "terminates_at_visible_corner" | "unknown" {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  if (raw === "continues_out_of_frame") return "continues_beyond_frame";
  if (raw === "visible_corner") return "terminates_at_visible_corner";
  if (raw.includes("continue") || raw.includes("beyond")) return "continues_beyond_frame";
  if (raw.includes("terminate") || raw.includes("corner")) return "terminates_at_visible_corner";
  return "unknown";
}

function normalizeInventoryOpeningLabel(value: string): StructuralOpeningType | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "unknown" || raw === "none") return null;
  if (raw.includes("sliding_door") || (raw.includes("sliding") && raw.includes("door"))) return "door";
  if (raw.includes("hinged_door") || (raw.includes("hinged") && raw.includes("door"))) return "door";
  if (raw.includes("closet")) return "closet_door";
  if (raw.includes("walk") || raw.includes("arch")) return "walkthrough";
  if (raw.includes("door")) return "door";
  if (raw.includes("window")) return "window";
  return null;
}

function deriveObservedWallVisibility(params: {
  leftEdgeLocation: WallDescriptor["leftEdgeLocation"];
  rightEdgeLocation: WallDescriptor["rightEdgeLocation"];
  leftCornerVisible: boolean;
  rightCornerVisible: boolean;
  leftReturnVisible: boolean | undefined;
  rightReturnVisible: boolean | undefined;
  openingCount: number;
}): WallDescriptor["visibility"] {
  const boundaryVisibleCount = Number(params.leftEdgeLocation !== "outside_frame") + Number(params.rightEdgeLocation !== "outside_frame");
  const cornerCount = Number(params.leftCornerVisible) + Number(params.rightCornerVisible);
  const returnCount = Number(params.leftReturnVisible === true) + Number(params.rightReturnVisible === true);
  const openingCount = params.openingCount;

  if (boundaryVisibleCount === 2 && (openingCount > 0 || cornerCount > 0)) return "full";
  if (openingCount > 0 || cornerCount > 0 || returnCount > 0 || boundaryVisibleCount > 0) return "partial";
  return "minimal";
}

function deriveArchitecturalCertainty(
  visibility: WallDescriptor["visibility"],
  leftEdgeLocation: WallDescriptor["leftEdgeLocation"],
  rightEdgeLocation: WallDescriptor["rightEdgeLocation"]
): WallDescriptor["architecturalCertainty"] {
  const boundaryVisibleCount = Number(leftEdgeLocation !== "outside_frame") + Number(rightEdgeLocation !== "outside_frame");
  if (visibility === "full" && boundaryVisibleCount === 2) return "known";
  if (visibility === "minimal") return "unknown";
  return "partial";
}

function normalizeInventoryFromInput(input: any): {
  openings: StructuralOpeningType[];
  permanentFixtures: string[];
  architecturalFeatures: string[];
} {
  const inventory = input?.inventory && typeof input.inventory === "object" ? input.inventory : {};

  const openings = normalizeFeatureTextList(inventory.openings)
    .map((item) => normalizeInventoryOpeningLabel(item))
    .filter((item): item is StructuralOpeningType => item !== null)
    .sort(compareStrings);

  const permanentFixtures = normalizePermanentFeaturesList(inventory.permanentFixtures);
  const architecturalFeatures = normalizePermanentFeaturesList(inventory.architecturalFeatures);

  return {
    openings,
    permanentFixtures,
    architecturalFeatures,
  };
}

function signatureCount(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

function canonicalWallObservationSignature(wall: {
  ordinal: number;
  visibility: string;
  visibleExtent: string;
  leftEdgeLocation: string;
  rightEdgeLocation: string;
  leftCornerVisible: boolean;
  rightCornerVisible: boolean;
  leftCornerPosition?: string;
  rightCornerPosition?: string;
  leftCornerVisibility?: string;
  rightCornerVisibility?: string;
  leftReturnWallVisibility?: string;
  rightReturnWallVisibility?: string;
  leftFrameContinuation: string;
  rightFrameContinuation: string;
  permanentFeatures: string[];
  openings: Array<{
    type: StructuralOpeningType;
    horizontalBand: HorizontalBand;
    verticalBand: VerticalBand;
    wallCoverageBand: WallCoverageBand;
    paneStructure: PaneStructure;
    doorLeafState: DoorLeafState;
    bbox: [number, number, number, number];
  }>;
}): string {
  const canonical = {
    ordinal: wall.ordinal,
    visibility: wall.visibility,
    visibleExtent: wall.visibleExtent,
    edges: {
      left: wall.leftEdgeLocation,
      right: wall.rightEdgeLocation,
      leftContinuation: wall.leftFrameContinuation,
      rightContinuation: wall.rightFrameContinuation,
    },
    corners: {
      leftVisible: wall.leftCornerVisible,
      rightVisible: wall.rightCornerVisible,
      leftPosition: wall.leftCornerPosition || "none",
      rightPosition: wall.rightCornerPosition || "none",
      leftExtent: wall.leftCornerVisibility || "none",
      rightExtent: wall.rightCornerVisibility || "none",
    },
    returnWalls: {
      left: wall.leftReturnWallVisibility || "unknown",
      right: wall.rightReturnWallVisibility || "unknown",
    },
    permanentFeatures: [...wall.permanentFeatures].sort(compareStrings),
    openings: [...wall.openings]
      .map((opening) => ({
        type: opening.type,
        horizontalBand: opening.horizontalBand,
        verticalBand: opening.verticalBand,
        wallCoverageBand: opening.wallCoverageBand,
        paneStructure: opening.paneStructure,
        doorLeafState: opening.doorLeafState,
        bbox: quantizeBbox(opening.bbox),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };

  return createHash("sha256").update(JSON.stringify(stableSortObject(canonical))).digest("hex");
}

function classifyAnchorFixtureType(label: string): AnchorFixtureType | null {
  const normalized = label.toLowerCase();
  if (normalized.includes("power outlet") || normalized.includes("outlet") || normalized.includes("art") || normalized.includes("painting")) return null;
  if (normalized.includes("ac") || normalized.includes("air conditioning") || normalized.includes("aircon")) return "ac_unit";
  if (normalized.includes("fireplace")) return "fireplace";
  if (normalized.includes("built-in") || normalized.includes("cabinet")) return "built_in_cabinet";
  if (normalized.includes("island")) return "kitchen_island";
  if (normalized.includes("stair")) return "staircase";
  if (normalized.includes("recess") || normalized.includes("niche") || normalized.includes("bulkhead") || normalized.includes("column")) return "other";
  return null;
}

function choosePrimaryAnchorLabel(params: {
  openingCandidates: StructuralOpeningType[];
  permanentFixtures: string[];
  architecturalFeatures: string[];
}): string {
  const openings = [...params.openingCandidates]
    .sort((left, right) => compareNumbers(openingAnchorRank(left), openingAnchorRank(right)) || compareStrings(left, right));
  if (openings.length > 0) return openings[0];

  const fixtures = [...params.permanentFixtures]
    .sort((left, right) => compareNumbers(anchorFeatureRank(left), anchorFeatureRank(right)) || compareStrings(left, right));
  if (fixtures.length > 0) return fixtures[0];

  const features = [...params.architecturalFeatures]
    .sort((left, right) => compareNumbers(anchorFeatureRank(left), anchorFeatureRank(right)) || compareStrings(left, right));
  if (features.length > 0) return features[0];

  return "wall_plane";
}

function canonicalizePrimaryAnchorLabel(label: string): string {
  const normalized = String(label || "").trim().toLowerCase();
  if (!normalized) return "wall_plane";
  if (normalized === "sliding_door") return "sliding_door";
  if (normalized.includes("large window") || normalized === "window" || normalized.includes(" window")) return "window";
  if (normalized.includes("large door") || normalized.includes("sliding door") || normalized === "door" || normalized.includes(" door")) return "door";
  if (normalized.includes("closet")) return "closet_door";
  if (normalized.includes("walkthrough") || normalized.includes("archway")) return "walkthrough";
  if (normalized.includes("built-in") || normalized.includes("cabinet")) return "built_in_cabinet";
  if (normalized.includes("air") || normalized.includes("ac") || normalized.includes("aircon")) return "ac_unit";
  if (normalized.includes("fireplace")) return "fireplace";
  if (normalized.includes("column")) return "structural_column";
  if (normalized.includes("recess")) return "recess";
  if (normalized.includes("niche")) return "niche";
  if (normalized.includes("wall") || normalized.includes("plane") || normalized.includes("surface")) return "wall_plane";
  return "wall_plane";
}

function normalizeBaselineFromWallSurfaces(input: any): StructuralBaseline | null {
  const rawObservedWalls = Array.isArray(input?.observedWalls)
    ? input.observedWalls
    : (Array.isArray(input?.wallSurfaces) ? input.wallSurfaces : []);
  if (rawObservedWalls.length === 0) return null;

  const inventory = normalizeInventoryFromInput(input);
  const inventoryOpeningCounts = signatureCount(inventory.openings);
  const inventoryFixtureCounts = signatureCount(inventory.permanentFixtures);
  const inventoryFeatureCounts = signatureCount(inventory.architecturalFeatures);
  const usageOpenings = new Map<string, number>();
  const usageFixtures = new Map<string, number>();
  const usageFeatures = new Map<string, number>();
  const unknownReferences: string[] = [];
  const duplicateReferences: string[] = [];
  const inconsistencies: string[] = [];
  const conflictingObservations: string[] = [];
  const rejectedAnchors: string[] = [];
  const chosenAnchors: string[] = [];

  const normalizedWallSurfaces = rawObservedWalls
    .map((surface: any, index: number) => {
      const observedWall = surface?.observedWall && typeof surface.observedWall === "object" ? surface.observedWall : surface;
      if (!observedWall || typeof observedWall !== "object") return null;

      const geometry = observedWall.wallGeometry || {};
      const frameEdges = observedWall.frameEdgeObservations || {};
      const leftSide = observedWall.leftSide || {};
      const rightSide = observedWall.rightSide || {};
      const corners = observedWall.cornerObservations || {
        left: {
          visible: leftSide.cornerVisible,
          position: leftSide.cornerPosition,
          extent: leftSide.cornerExtent,
        },
        right: {
          visible: rightSide.cornerVisible,
          position: rightSide.cornerPosition,
          extent: rightSide.cornerExtent,
        },
      };
      const returnWalls = observedWall.returnWallObservations || {
        left: {
          visible: leftSide.returnWallVisible ? leftSide.returnWallVisible !== "none" : "unknown",
          extent: leftSide.returnWallVisible,
        },
        right: {
          visible: rightSide.returnWallVisible ? rightSide.returnWallVisible !== "none" : "unknown",
          extent: rightSide.returnWallVisible,
        },
      };
      const openingObservations = Array.isArray(observedWall.openingObservations) ? observedWall.openingObservations : [];

      const leftEdgeLocation = normalizeEdgeLocation(frameEdges.leftEdgeLocation ?? geometry.leftEdge);
      const rightEdgeLocation = normalizeEdgeLocation(frameEdges.rightEdgeLocation ?? geometry.rightEdge);
      const leftFrameContinuation = normalizeFrameContinuation(frameEdges.leftContinuation ?? leftSide.frameContinuation);
      const rightFrameContinuation = normalizeFrameContinuation(frameEdges.rightContinuation ?? rightSide.frameContinuation);
      const parsedOpenings = openingObservations
        .map((opening: any) => {
          const normalizedType = normalizeOpeningType(opening?.type);
          if (!normalizedType) return null;
          const providedHorizontalBand = isHorizontalBand(String(opening?.horizontalBand || ""))
            ? opening.horizontalBand as HorizontalBand
            : null;
          const providedVerticalBand = isVerticalBand(String(opening?.verticalBand || ""))
            ? opening.verticalBand as VerticalBand
            : null;
          const provisionalHorizontalBand = providedHorizontalBand || "center_third";
          const provisionalVerticalBand = providedVerticalBand || "mid_zone";
          const bbox = normalizeBbox(opening, provisionalHorizontalBand, provisionalVerticalBand);
          const horizontalBand = providedHorizontalBand || inferHorizontalBandFromBbox(bbox);
          const verticalBand = providedVerticalBand || inferVerticalBandFromBbox(bbox);
          const areaPct = normalizeAreaPct(opening, bbox);
          const orientation = isOpeningOrientation(String(opening?.orientation || ""))
            ? opening.orientation as OpeningOrientation
            : deriveOrientation(Math.max(0.01, (bbox[2] - bbox[0]) / Math.max(0.01, bbox[3] - bbox[1])));
          const paneStructure = normalizePaneStructure(opening?.paneStructure);
          const doorLeafState = normalizeDoorLeafState(opening?.doorLeafState, normalizedType);
          const wallCoverageBand = isWallCoverageBand(String(opening?.wallCoverageBand || ""))
            ? opening.wallCoverageBand as WallCoverageBand
            : deriveWallCoverageBand(areaPct);
          const confidence = typeof opening?.confidence === "number" && Number.isFinite(opening.confidence)
            ? Math.max(0, Math.min(1, Number(opening.confidence)))
            : 0.8;

          return {
            type: normalizedType,
            bbox,
            areaPct,
            horizontalBand,
            verticalBand,
            wallCoverageBand,
            orientation,
            paneStructure,
            doorLeafState,
            confidence,
          };
        })
        .filter((opening): opening is NonNullable<typeof opening> => opening !== null);

      const wallOrdinal = Number.isFinite(Number(observedWall.observedOrdinal ?? observedWall.ordinal))
        ? Number(observedWall.observedOrdinal ?? observedWall.ordinal)
        : index + 1;

      const claimedOpenings = normalizeFeatureTextList(observedWall.containsOpenings)
        .map((item) => normalizeInventoryOpeningLabel(item))
        .filter((item): item is StructuralOpeningType => item !== null);
      const claimedFixtures = normalizePermanentFeaturesList(
        observedWall.containsPermanentFixtures ?? observedWall.visiblePermanentFeatures
      );
      const claimedFeatures = normalizePermanentFeaturesList(observedWall.containsArchitecturalFeatures);
      const rawClaimedFeatureText = normalizeFeatureTextList(observedWall.containsArchitecturalFeatures);
      const rawClaimedFixtureText = normalizeFeatureTextList(observedWall.containsPermanentFixtures ?? observedWall.visiblePermanentFeatures);

      const validatedOpenings: StructuralOpeningType[] = [];
      for (const item of (claimedOpenings.length > 0 ? claimedOpenings : parsedOpenings.map((opening) => opening.type))) {
        const key = String(item);
        const maxCount = inventoryOpeningCounts.get(key) || 0;
        if (maxCount === 0) {
          unknownReferences.push(`wall_${wallOrdinal}:opening:${key}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${key}`);
          continue;
        }
        const used = usageOpenings.get(key) || 0;
        if (used >= maxCount) {
          duplicateReferences.push(`wall_${wallOrdinal}:opening:${key}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${key}`);
          continue;
        }
        usageOpenings.set(key, used + 1);
        validatedOpenings.push(item);
      }

      const validatedOpeningQuota = signatureCount(validatedOpenings);
      const filteredParsedOpenings: typeof parsedOpenings = [];
      const filteredCounts = new Map<string, number>();
      for (const opening of parsedOpenings) {
        const key = String(opening.type);
        const allowed = validatedOpeningQuota.get(key) || 0;
        const used = filteredCounts.get(key) || 0;
        if (used >= allowed) continue;
        filteredCounts.set(key, used + 1);
        filteredParsedOpenings.push(opening);
      }

      const validatedFixtures: string[] = [];
      for (const item of claimedFixtures) {
        if (isBlankWallReferenceLabel(item)) continue;
        const maxCount = inventoryFixtureCounts.get(item) || 0;
        if (maxCount === 0) {
          unknownReferences.push(`wall_${wallOrdinal}:fixture:${item}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${item}`);
          continue;
        }
        const used = usageFixtures.get(item) || 0;
        if (used >= maxCount) {
          duplicateReferences.push(`wall_${wallOrdinal}:fixture:${item}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${item}`);
          continue;
        }
        usageFixtures.set(item, used + 1);
        validatedFixtures.push(item);
      }

      const validatedFeatures: string[] = [];
      for (const item of claimedFeatures) {
        if (isBlankWallReferenceLabel(item)) continue;
        const maxCount = inventoryFeatureCounts.get(item) || 0;
        if (maxCount === 0) {
          unknownReferences.push(`wall_${wallOrdinal}:feature:${item}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${item}`);
          continue;
        }
        const used = usageFeatures.get(item) || 0;
        if (used >= maxCount) {
          duplicateReferences.push(`wall_${wallOrdinal}:feature:${item}`);
          rejectedAnchors.push(`wall_${wallOrdinal}:${item}`);
          continue;
        }
        usageFeatures.set(item, used + 1);
        validatedFeatures.push(item);
      }

      if (claimedOpenings.length > 0 && parsedOpenings.length === 0) {
        inconsistencies.push(`wall_${wallOrdinal}:claimed_openings_without_geometry`);
      }
      if (parsedOpenings.length > filteredParsedOpenings.length) {
        rejectedAnchors.push(`wall_${wallOrdinal}:opening_geometry_rejected`);
      }

      const hasExplicitBlankWallReference = [...rawClaimedFeatureText, ...rawClaimedFixtureText]
        .some((item) => isBlankWallReferenceLabel(item));

      const primaryAnchor = choosePrimaryAnchorLabel({
        openingCandidates: validatedOpenings,
        permanentFixtures: validatedFixtures,
        architecturalFeatures: validatedFeatures,
      });
      const canonicalPrimaryAnchor = canonicalizePrimaryAnchorLabel(primaryAnchor);
      chosenAnchors.push(`wall_${wallOrdinal}:${canonicalPrimaryAnchor}`);

      const leftCorner = corners.left || {};
      const rightCorner = corners.right || {};
      const leftCornerVisible = leftCorner.visible === true;
      const rightCornerVisible = rightCorner.visible === true;
      const leftCornerPosition = leftCornerVisible
        ? normalizeCornerPositionObservation(leftCorner.position || (leftEdgeLocation === "outside_frame" ? "near_frame_edge" : "outer_third"))
        : "none";
      const rightCornerPosition = rightCornerVisible
        ? normalizeCornerPositionObservation(rightCorner.position || (rightEdgeLocation === "outside_frame" ? "near_frame_edge" : "outer_third"))
        : "none";
      const leftCornerVisibility = leftCornerVisible ? normalizeCornerExtent(leftCorner.extent) : "none";
      const rightCornerVisibility = rightCornerVisible ? normalizeCornerExtent(rightCorner.extent) : "none";

      const leftReturnExtent = normalizeReturnWallExtent(returnWalls?.left?.extent);
      const rightReturnExtent = normalizeReturnWallExtent(returnWalls?.right?.extent);
      const leftReturnVisible = typeof returnWalls?.left?.visible === "boolean"
        ? returnWalls.left.visible
        : visibilityFromReturnWallExtent(leftReturnExtent);
      const rightReturnVisible = typeof returnWalls?.right?.visible === "boolean"
        ? returnWalls.right.visible
        : visibilityFromReturnWallExtent(rightReturnExtent);

      const visibility = deriveObservedWallVisibility({
        leftEdgeLocation,
        rightEdgeLocation,
        leftCornerVisible,
        rightCornerVisible,
        leftReturnVisible,
        rightReturnVisible,
        openingCount: filteredParsedOpenings.length,
      });
      const visibleExtent = visibility;

      if (leftFrameContinuation === "terminates_at_visible_corner" && !leftCornerVisible) {
        conflictingObservations.push(`wall_${wallOrdinal}:left_continuation_without_corner`);
      }
      if (rightFrameContinuation === "terminates_at_visible_corner" && !rightCornerVisible) {
        conflictingObservations.push(`wall_${wallOrdinal}:right_continuation_without_corner`);
      }
      if (leftReturnVisible === true && leftReturnExtent === "none") {
        conflictingObservations.push(`wall_${wallOrdinal}:left_return_visible_but_none`);
      }
      if (rightReturnVisible === true && rightReturnExtent === "none") {
        conflictingObservations.push(`wall_${wallOrdinal}:right_return_visible_but_none`);
      }

      const architecturalCertainty = deriveArchitecturalCertainty(visibility, leftEdgeLocation, rightEdgeLocation);
      const observations = [
        `anchor:${canonicalPrimaryAnchor}`,
        `left_edge:${leftEdgeLocation}`,
        `right_edge:${rightEdgeLocation}`,
        `left_corner:${leftCornerVisible ? leftCornerPosition : "none"}`,
        `right_corner:${rightCornerVisible ? rightCornerPosition : "none"}`,
        `left_return:${leftReturnExtent}`,
        `right_return:${rightReturnExtent}`,
        hasExplicitBlankWallReference ? "blank_wall:explicit" : "blank_wall:implicit",
      ];

      const observationSignature = canonicalWallObservationSignature({
        ordinal: wallOrdinal,
        visibility,
        visibleExtent,
        leftEdgeLocation,
        rightEdgeLocation,
        leftCornerVisible,
        rightCornerVisible,
        leftCornerPosition,
        rightCornerPosition,
        leftCornerVisibility,
        rightCornerVisibility,
        leftReturnWallVisibility: leftReturnExtent,
        rightReturnWallVisibility: rightReturnExtent,
        leftFrameContinuation,
        rightFrameContinuation,
        permanentFeatures: [...validatedFixtures, ...validatedFeatures],
        openings: filteredParsedOpenings,
      });

      return {
        sourceIndex: index,
        ordinal: wallOrdinal,
        visibility,
        visibleExtent,
        leftEdgeLocation,
        rightEdgeLocation,
        leftFrameContinuation,
        rightFrameContinuation,
        leftCornerVisible,
        rightCornerVisible,
        leftCornerPosition,
        rightCornerPosition,
        leftCornerVisibility,
        rightCornerVisibility,
        leftCornerConfidence: typeof leftCorner.confidence === "number" && Number.isFinite(leftCorner.confidence)
          ? Math.max(0, Math.min(1, Number(leftCorner.confidence)))
          : undefined,
        rightCornerConfidence: typeof rightCorner.confidence === "number" && Number.isFinite(rightCorner.confidence)
          ? Math.max(0, Math.min(1, Number(rightCorner.confidence)))
          : undefined,
        leftReturnWallVisible: leftReturnVisible,
        rightReturnWallVisible: rightReturnVisible,
        leftReturnWallVisibility: leftReturnExtent,
        rightReturnWallVisibility: rightReturnExtent,
        architecturalCertainty,
        canonicalPrimaryAnchor,
        chosenOpeningAnchors: validatedOpenings,
        chosenFixtureAnchors: validatedFixtures,
        chosenArchitecturalAnchors: validatedFeatures,
        openings: filteredParsedOpenings,
        observations,
        observationSignature,
      };
    })
    .filter((wall): wall is NonNullable<typeof wall> => wall !== null)
    .sort((left, right) => compareNumbers(left.ordinal, right.ordinal) || compareNumbers(left.sourceIndex, right.sourceIndex));

  const semanticWallSurfaces = normalizedWallSurfaces.filter((wall, index) => {
    const openingScore = wall.openings.length > 0 ? 3 : 0;
    const cornerScore = (wall.leftCornerVisible ? 1 : 0) + (wall.rightCornerVisible ? 1 : 0);
    const returnScore = (wall.leftReturnWallVisible ? 1 : 0) + (wall.rightReturnWallVisible ? 1 : 0);
    const anchorScore = wall.canonicalPrimaryAnchor !== "wall_plane" ? 1 : 0;
    const evidenceScore = openingScore + cornerScore + returnScore + anchorScore;
    if (wall.openings.length > 0) return true;
    if (wall.canonicalPrimaryAnchor === "wall_plane" && (cornerScore > 0 || returnScore > 0)) return true;
    if (evidenceScore >= 2) return true;
    return index === 0;
  });

  const canonicalWallSurfaces = [...semanticWallSurfaces].sort((left, right) => {
    const leftOpeningRank = left.chosenOpeningAnchors.length > 0 ? openingAnchorRank(left.chosenOpeningAnchors[0]) : 99;
    const rightOpeningRank = right.chosenOpeningAnchors.length > 0 ? openingAnchorRank(right.chosenOpeningAnchors[0]) : 99;
    const leftFeatureRank = anchorFeatureRank(left.canonicalPrimaryAnchor);
    const rightFeatureRank = anchorFeatureRank(right.canonicalPrimaryAnchor);
    return (
      compareNumbers(leftOpeningRank, rightOpeningRank) ||
      compareNumbers(leftFeatureRank, rightFeatureRank) ||
      compareNumbers(right.openings.length, left.openings.length) ||
      compareStrings(left.observationSignature, right.observationSignature) ||
      compareNumbers(left.ordinal, right.ordinal) ||
      compareNumbers(left.sourceIndex, right.sourceIndex)
    );
  });

  const anchorCounters = new Map<string, number>();
  const canonicalWallIds = new Map<number, string>();
  for (const wall of canonicalWallSurfaces) {
    const anchor = wall.canonicalPrimaryAnchor || "wall_plane";
    const nextCount = (anchorCounters.get(anchor) || 0) + 1;
    anchorCounters.set(anchor, nextCount);
    if (anchor === "wall_plane") {
      canonicalWallIds.set(wall.ordinal, `blank_wall_${nextCount}`);
    } else {
      canonicalWallIds.set(wall.ordinal, `${anchor}_${nextCount}`);
    }
  }

  const anchorFixtures: AnchorFixture[] = [];
  const openingPrototypes: Array<Omit<StructuralOpening, "id"> & { __stableOrder: number }> = [];
  const wallDescriptors: WallDescriptor[] = [];

  canonicalWallSurfaces.forEach((wall, index) => {
    const wallIndex = wallIndexFromSurfaceOrder(index, wall.leftEdgeLocation, wall.rightEdgeLocation);
    const terminatesAtCorner = wall.leftCornerVisible === true || wall.rightCornerVisible === true;
    const continuesBeyondFrame = wall.leftEdgeLocation === "outside_frame" || wall.rightEdgeLocation === "outside_frame";
    const canonicalWallId = canonicalWallIds.get(wall.ordinal) || `blank_wall_${index + 1}`;

    wallDescriptors.push({
      wallIndex,
      canonicalWallId,
      primaryAnchorLabel: wall.canonicalPrimaryAnchor,
      observedOrdinal: wall.ordinal,
      visibility: wall.visibility,
      visibleExtent: wall.visibleExtent,
      architecturalCertainty: wall.architecturalCertainty,
      leftEdgeLocation: wall.leftEdgeLocation,
      rightEdgeLocation: wall.rightEdgeLocation,
      leftBoundaryVisible: wall.leftEdgeLocation !== "outside_frame",
      rightBoundaryVisible: wall.rightEdgeLocation !== "outside_frame",
      leftCornerVisible: wall.leftCornerVisible,
      rightCornerVisible: wall.rightCornerVisible,
      leftCornerConfidence: wall.leftCornerConfidence,
      rightCornerConfidence: wall.rightCornerConfidence,
      leftCornerPosition: wall.leftCornerPosition,
      rightCornerPosition: wall.rightCornerPosition,
      leftCornerVisibility: wall.leftCornerVisibility,
      rightCornerVisibility: wall.rightCornerVisibility,
      leftAdjacentWallVisibility: wall.leftReturnWallVisible === true ? "partial" : "none",
      rightAdjacentWallVisibility: wall.rightReturnWallVisible === true ? "partial" : "none",
      leftReturnWallVisible: wall.leftReturnWallVisible,
      rightReturnWallVisible: wall.rightReturnWallVisible,
      leftReturnWallVisibility: wall.leftReturnWallVisibility,
      rightReturnWallVisibility: wall.rightReturnWallVisibility,
      leftFrameEdgeContinuation: wall.leftFrameContinuation,
      rightFrameEdgeContinuation: wall.rightFrameContinuation,
      terminatesAtCorner,
      continuesBeyondFrame,
      boundaryBehaviour: terminatesAtCorner
        ? "terminates_at_visible_corner"
        : continuesBeyondFrame
          ? "continues_beyond_frame"
          : "unknown",
      description: wall.observations.slice(0, 6).join("; "),
    });

    const fixtureType = classifyAnchorFixtureType(wall.canonicalPrimaryAnchor);
    if (fixtureType) {
      const fixtureBand = wall.openings[0]?.horizontalBand || "center_third";
      anchorFixtures.push({
        id: `F${anchorFixtures.length + 1}`,
        type: fixtureType,
        wallIndex,
        horizontalBand: fixtureBand,
        bbox: normalizeBbox({ bbox: [fixtureBand === "left_third" ? 0.05 : fixtureBand === "right_third" ? 0.7 : 0.35, 0.25, fixtureBand === "left_third" ? 0.25 : fixtureBand === "right_third" ? 0.95 : 0.65, 0.75] }, fixtureBand, "mid_zone"),
        confidence: 0.7,
      });
    }

    wall.openings.forEach((opening, openingIndex) => {
      openingPrototypes.push({
        __stableOrder: (index * 100) + openingIndex,
        type: opening.type,
        bbox: opening.bbox,
        area_pct: opening.areaPct,
        wallIndex,
        horizontalBand: opening.horizontalBand,
        verticalBand: opening.verticalBand,
        wallCoverageBand: opening.wallCoverageBand,
        orientation: opening.orientation,
        paneStructure: opening.paneStructure,
        doorLeafState: opening.doorLeafState,
        confidence: opening.confidence,
        wallPosition: mapIndexToWallPosition(wallIndex),
        relativeHorizontalPosition: mapBandToLegacyHorizontal(opening.horizontalBand),
        shape: opening.type,
        touchesFloor: opening.verticalBand === "floor_zone" || opening.verticalBand === "full_height",
        touchesCeiling: opening.verticalBand === "ceiling_zone" || opening.verticalBand === "full_height",
        approxCount: 1,
      });
    });
  });

  const sortedOpenings = openingPrototypes
    .sort((left, right) => (
      compareNumbers(left.wallIndex, right.wallIndex) ||
      compareStrings(left.horizontalBand, right.horizontalBand) ||
      compareStrings(left.verticalBand, right.verticalBand) ||
      compareNumbers((left.bbox[0] + left.bbox[2]) / 2, (right.bbox[0] + right.bbox[2]) / 2, 1e-4) ||
      compareNumbers(left.__stableOrder, right.__stableOrder)
    ));

  const openingCounters: Record<StructuralOpeningType, number> = {
    window: 0,
    door: 0,
    closet_door: 0,
    walkthrough: 0,
  };
  const openingPrefix: Record<StructuralOpeningType, string> = {
    window: "W",
    door: "D",
    closet_door: "C",
    walkthrough: "A",
  };

  const openings: StructuralOpening[] = sortedOpenings.map((opening) => {
    openingCounters[opening.type] += 1;
    const id = `${openingPrefix[opening.type]}${openingCounters[opening.type]}`;
    const { __stableOrder, ...rest } = opening;
    return { id, ...rest };
  });

  const unusedInventory: string[] = [];
  inventoryOpeningCounts.forEach((count, key) => {
    const used = usageOpenings.get(key) || 0;
    for (let i = used; i < count; i += 1) unusedInventory.push(`opening:${key}`);
  });
  inventoryFixtureCounts.forEach((count, key) => {
    const used = usageFixtures.get(key) || 0;
    for (let i = used; i < count; i += 1) unusedInventory.push(`fixture:${key}`);
  });
  inventoryFeatureCounts.forEach((count, key) => {
    const used = usageFeatures.get(key) || 0;
    for (let i = used; i < count; i += 1) unusedInventory.push(`feature:${key}`);
  });

  let baselineConfidence = 1;
  baselineConfidence -= unknownReferences.length * 0.08;
  baselineConfidence -= duplicateReferences.length * 0.05;
  baselineConfidence -= rejectedAnchors.length * 0.03;
  baselineConfidence -= inconsistencies.length * 0.06;
  baselineConfidence -= conflictingObservations.length * 0.04;
  baselineConfidence -= unusedInventory.length * 0.04;
  baselineConfidence -= canonicalWallSurfaces.filter((wall) => wall.canonicalPrimaryAnchor === "wall_plane" && (wall.openings.length > 0)).length * 0.03;
  const blankWallCount = canonicalWallSurfaces.filter((wall) => wall.canonicalPrimaryAnchor === "wall_plane").length;
  const blankWallAmbiguityCount = Math.max(0, blankWallCount - 1);
  baselineConfidence -= blankWallAmbiguityCount * 0.02;
  baselineConfidence = Math.max(0, Math.min(1, roundDeterministic(baselineConfidence, 3)));

  openings.sort(compareStructuralOpenings);
  anchorFixtures.sort(compareAnchorFixtures);
  const canonicalWallDescriptors = wallDescriptors
    .sort((left, right) => compareNumbers(left.wallIndex, right.wallIndex) || compareStrings(left.description, right.description));

  const observationHash = createHash("sha256")
    .update(JSON.stringify(normalizedWallSurfaces.map((wall) => wall.observationSignature)))
    .digest("hex");
  const inventoryHash = createHash("sha256")
    .update(JSON.stringify(stableSortObject(inventory)))
    .digest("hex");
  const canonicalIdentityHash = createHash("sha256")
    .update(JSON.stringify(canonicalWallDescriptors.map((wall) => ({ wallIndex: wall.wallIndex, canonicalWallId: wall.canonicalWallId, primaryAnchorLabel: wall.primaryAnchorLabel }))))
    .digest("hex");

  return {
    cameraOrientation: typeof input?.cameraOrientation === "string" ? input.cameraOrientation : undefined,
    openings,
    anchorFixtures,
    observationMeta: {
      observationHash,
      inventoryHash,
      canonicalIdentityHash,
      wallCount: normalizedWallSurfaces.length,
      inventory: {
        openings: inventory.openings,
        permanentFixtures: inventory.permanentFixtures,
        architecturalFeatures: inventory.architecturalFeatures,
      },
      validation: {
        unknownReferences,
        duplicateReferences,
        unusedInventory,
        inconsistencies,
        conflictingObservations,
        rejectedAnchors,
        chosenAnchors,
      },
      baselineConfidence,
    },
    wallDescriptors: canonicalWallDescriptors.length > 0 ? canonicalWallDescriptors : undefined,
  };
}

type BaselineValidationSnapshot = {
  unknownReferences: string[];
  duplicateReferences: string[];
  unusedInventory: string[];
  inconsistencies: string[];
  conflictingObservations?: string[];
  rejectedAnchors: string[];
  chosenAnchors: string[];
  reconciliationActions?: string[];
  reconciliationReasons?: string[];
};

function baselineValidationData(baseline: StructuralBaseline): BaselineValidationSnapshot {
  return {
    unknownReferences: [],
    duplicateReferences: [],
    unusedInventory: [],
    inconsistencies: [],
    conflictingObservations: [],
    rejectedAnchors: [],
    chosenAnchors: [],
    ...(baseline.observationMeta?.validation || {}),
  };
}

function isBaselineValidationPassed(baseline: StructuralBaseline): boolean {
  const validation = baselineValidationData(baseline);
  return validation.unknownReferences.length === 0 &&
    validation.duplicateReferences.length === 0 &&
    validation.inconsistencies.length === 0;
}

function openingTypeCounts(openings: StructuralOpening[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const opening of openings) {
    const key = String(opening.type);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function structuralDisagreementReasons(left: StructuralBaseline, right: StructuralBaseline): string[] {
  const reasons: string[] = [];
  const leftWalls = left.wallDescriptors || [];
  const rightWalls = right.wallDescriptors || [];
  if (leftWalls.length !== rightWalls.length) {
    const leftOpeningWalls = new Set<number>((left.openings || []).map((opening) => opening.wallIndex));
    const rightOpeningWalls = new Set<number>((right.openings || []).map((opening) => opening.wallIndex));

    const leftSubstantiveWallCount = leftWalls.filter((wall) =>
      (wall.primaryAnchorLabel || "wall_plane") !== "wall_plane" || leftOpeningWalls.has(wall.wallIndex)
    ).length;
    const rightSubstantiveWallCount = rightWalls.filter((wall) =>
      (wall.primaryAnchorLabel || "wall_plane") !== "wall_plane" || rightOpeningWalls.has(wall.wallIndex)
    ).length;

    if (leftSubstantiveWallCount !== rightSubstantiveWallCount) {
      reasons.push(`wall_count_mismatch:${leftWalls.length}_vs_${rightWalls.length}`);
    }
  }

  const leftOpenings = openingTypeCounts(left.openings || []);
  const rightOpenings = openingTypeCounts(right.openings || []);
  const allTypes = new Set<string>([...leftOpenings.keys(), ...rightOpenings.keys()]);
  for (const type of allTypes) {
    const leftCount = leftOpenings.get(type) || 0;
    const rightCount = rightOpenings.get(type) || 0;
    if (leftCount !== rightCount) {
      reasons.push(`opening_type_mismatch:${type}:${leftCount}_vs_${rightCount}`);
    }
  }

  const leftByWall = new Map<number, WallDescriptor>(leftWalls.map((wall) => [wall.wallIndex, wall]));
  const rightByWall = new Map<number, WallDescriptor>(rightWalls.map((wall) => [wall.wallIndex, wall]));
  for (const wallIndex of [...new Set<number>([...leftByWall.keys(), ...rightByWall.keys()])]) {
    const l = leftByWall.get(wallIndex);
    const r = rightByWall.get(wallIndex);
    if (!l || !r) continue;

    const leftEdgeAmbiguous = l.leftBoundaryVisible !== true || r.leftBoundaryVisible !== true || l.visibility === "minimal" || r.visibility === "minimal";
    const rightEdgeAmbiguous = l.rightBoundaryVisible !== true || r.rightBoundaryVisible !== true || l.visibility === "minimal" || r.visibility === "minimal";

    if (!leftEdgeAmbiguous && (l.leftCornerVisible === true) !== (r.leftCornerVisible === true)) {
      reasons.push(`corner_topology_mismatch:wall_${wallIndex}:left`);
    }
    if (!rightEdgeAmbiguous && (l.rightCornerVisible === true) !== (r.rightCornerVisible === true)) {
      reasons.push(`corner_topology_mismatch:wall_${wallIndex}:right`);
    }
    if (!leftEdgeAmbiguous && (l.leftReturnWallVisible === true) !== (r.leftReturnWallVisible === true)) {
      reasons.push(`return_topology_mismatch:wall_${wallIndex}:left`);
    }
    if (!rightEdgeAmbiguous && (l.rightReturnWallVisible === true) !== (r.rightReturnWallVisible === true)) {
      reasons.push(`return_topology_mismatch:wall_${wallIndex}:right`);
    }
  }

  return reasons;
}

function pickConservativeString(
  left: string | undefined,
  right: string | undefined,
  fallback: string
): string {
  if (left === right && left) return left;
  if (!left && right) return fallback;
  if (!right && left) return fallback;
  return fallback;
}

function pickConservativeAnchor(left: string | undefined, right: string | undefined): string {
  const l = canonicalizePrimaryAnchorLabel(left || "wall_plane");
  const r = canonicalizePrimaryAnchorLabel(right || "wall_plane");
  if (l === r) return l;
  if (l === "wall_plane" || r === "wall_plane") return "wall_plane";
  return "wall_plane";
}

function reconcileWallDescriptor(
  left: WallDescriptor | undefined,
  right: WallDescriptor | undefined,
  actions: string[]
): WallDescriptor | null {
  const base = left || right;
  if (!base) return null;
  if (!left || !right) {
    actions.push(`wall_${base.wallIndex}:single_source_descriptor`);
    return { ...base };
  }

  const anchor = pickConservativeAnchor(left.primaryAnchorLabel, right.primaryAnchorLabel);
  if ((left.primaryAnchorLabel || "wall_plane") !== (right.primaryAnchorLabel || "wall_plane")) {
    actions.push(`wall_${base.wallIndex}:identity_disagreement_${left.primaryAnchorLabel || "wall_plane"}_vs_${right.primaryAnchorLabel || "wall_plane"}`);
  }

  const leftCornerVisible = left.leftCornerVisible === true && right.leftCornerVisible === true;
  const rightCornerVisible = left.rightCornerVisible === true && right.rightCornerVisible === true;

  return {
    ...base,
    primaryAnchorLabel: anchor,
    leftEdgeLocation: pickConservativeString(left.leftEdgeLocation, right.leftEdgeLocation, "unknown") as WallDescriptor["leftEdgeLocation"],
    rightEdgeLocation: pickConservativeString(left.rightEdgeLocation, right.rightEdgeLocation, "unknown") as WallDescriptor["rightEdgeLocation"],
    leftFrameEdgeContinuation: pickConservativeString(left.leftFrameEdgeContinuation, right.leftFrameEdgeContinuation, "unknown") as WallDescriptor["leftFrameEdgeContinuation"],
    rightFrameEdgeContinuation: pickConservativeString(left.rightFrameEdgeContinuation, right.rightFrameEdgeContinuation, "unknown") as WallDescriptor["rightFrameEdgeContinuation"],
    leftCornerVisible,
    rightCornerVisible,
    leftCornerPosition: leftCornerVisible
      ? (pickConservativeString(left.leftCornerPosition, right.leftCornerPosition, "none") as WallDescriptor["leftCornerPosition"])
      : "none",
    rightCornerPosition: rightCornerVisible
      ? (pickConservativeString(left.rightCornerPosition, right.rightCornerPosition, "none") as WallDescriptor["rightCornerPosition"])
      : "none",
    leftCornerVisibility: leftCornerVisible
      ? (pickConservativeString(left.leftCornerVisibility, right.leftCornerVisibility, "minimal") as WallDescriptor["leftCornerVisibility"])
      : "none",
    rightCornerVisibility: rightCornerVisible
      ? (pickConservativeString(left.rightCornerVisibility, right.rightCornerVisibility, "minimal") as WallDescriptor["rightCornerVisibility"])
      : "none",
    leftReturnWallVisibility: pickConservativeString(left.leftReturnWallVisibility, right.leftReturnWallVisibility, "unknown") as WallDescriptor["leftReturnWallVisibility"],
    rightReturnWallVisibility: pickConservativeString(left.rightReturnWallVisibility, right.rightReturnWallVisibility, "unknown") as WallDescriptor["rightReturnWallVisibility"],
    leftReturnWallVisible: left.leftReturnWallVisible === true && right.leftReturnWallVisible === true,
    rightReturnWallVisible: left.rightReturnWallVisible === true && right.rightReturnWallVisible === true,
    architecturalCertainty: (left.architecturalCertainty === right.architecturalCertainty
      ? left.architecturalCertainty
      : "unknown") as WallDescriptor["architecturalCertainty"],
  };
}

function assignCanonicalWallIds(descriptors: WallDescriptor[]): WallDescriptor[] {
  const counters = new Map<string, number>();
  return descriptors
    .sort((left, right) => compareNumbers(left.wallIndex, right.wallIndex) || compareNumbers(left.observedOrdinal || 0, right.observedOrdinal || 0))
    .map((descriptor) => {
      const anchor = canonicalizePrimaryAnchorLabel(descriptor.primaryAnchorLabel || "wall_plane");
      const next = (counters.get(anchor) || 0) + 1;
      counters.set(anchor, next);
      const canonicalWallId = anchor === "wall_plane" ? `blank_wall_${next}` : `${anchor}_${next}`;
      return {
        ...descriptor,
        primaryAnchorLabel: anchor,
        canonicalWallId,
      };
    });
}

function reconcileFailedBaselines(
  run1: StructuralBaseline,
  run2: StructuralBaseline,
  imageHash: string
): StructuralBaseline | null {
  const disagreement = structuralDisagreementReasons(run1, run2);
  if (disagreement.length > 0) return null;

  const actions: string[] = [];
  const leftByWall = new Map<number, WallDescriptor>((run1.wallDescriptors || []).map((wall) => [wall.wallIndex, wall]));
  const rightByWall = new Map<number, WallDescriptor>((run2.wallDescriptors || []).map((wall) => [wall.wallIndex, wall]));
  const wallIndexes = [...new Set<number>([...leftByWall.keys(), ...rightByWall.keys()])].sort((a, b) => a - b);
  const mergedDescriptors = wallIndexes
    .map((wallIndex) => reconcileWallDescriptor(leftByWall.get(wallIndex), rightByWall.get(wallIndex), actions))
    .filter((wall): wall is WallDescriptor => wall !== null);
  const canonicalDescriptors = assignCanonicalWallIds(mergedDescriptors);

  const preferred = (run1.observationMeta?.baselineConfidence || 0) >= (run2.observationMeta?.baselineConfidence || 0)
    ? run1
    : run2;
  const validation1 = baselineValidationData(run1);
  const validation2 = baselineValidationData(run2);
  const reasons = [
    ...structuralDisagreementReasons(run1, run2),
    ...validation1.unknownReferences,
    ...validation1.duplicateReferences,
    ...validation2.unknownReferences,
    ...validation2.duplicateReferences,
  ].filter(Boolean);

  const confidenceBase = Math.min(
    run1.observationMeta?.baselineConfidence ?? 0.6,
    run2.observationMeta?.baselineConfidence ?? 0.6
  );
  const baselineConfidence = Math.max(0, roundDeterministic(confidenceBase - 0.12 - (actions.length * 0.01), 3));

  const observationHash = createHash("sha256")
    .update(JSON.stringify([
      run1.observationMeta?.observationHash || "",
      run2.observationMeta?.observationHash || "",
      ...canonicalDescriptors.map((wall) => `${wall.wallIndex}:${wall.canonicalWallId || ""}`),
    ]))
    .digest("hex");

  const reconciled: StructuralBaseline = {
    ...preferred,
    wallDescriptors: canonicalDescriptors,
    observationMeta: {
      ...(preferred.observationMeta || { observationHash: "", wallCount: canonicalDescriptors.length }),
      observationHash,
      wallCount: canonicalDescriptors.length,
      baselineStatus: "RECONCILED",
      baselineConfidence,
      validation: {
        unknownReferences: [...new Set([...(validation1.unknownReferences || []), ...(validation2.unknownReferences || [])])],
        duplicateReferences: [...new Set([...(validation1.duplicateReferences || []), ...(validation2.duplicateReferences || [])])],
        unusedInventory: [...new Set([...(validation1.unusedInventory || []), ...(validation2.unusedInventory || [])])],
        inconsistencies: [...new Set([...(validation1.inconsistencies || []), ...(validation2.inconsistencies || [])])],
        rejectedAnchors: [...new Set([...(validation1.rejectedAnchors || []), ...(validation2.rejectedAnchors || [])])],
        chosenAnchors: canonicalDescriptors.map((wall) => `wall_${wall.wallIndex}:${wall.primaryAnchorLabel || "wall_plane"}`),
        reconciliationActions: actions,
        reconciliationReasons: reasons,
      },
    },
  };

  const graphHash = hashStructuralBaselineGraph(reconciled);
  reconciled.graphMeta = {
    ...(reconciled.graphMeta || {
      graphStable: false,
      graphConfidence: 0.5,
      extractionAgreement: 0.5,
      passCount: 2,
      openingCountVariance: 0,
      cacheStatus: "unstable",
      candidateGraphHashes: [graphHash],
      openingCountRange: { min: reconciled.openings.length, max: reconciled.openings.length },
      confirmedAt: new Date().toISOString(),
    }),
    imageHash,
    graphHash,
    cacheStatus: "unstable",
    baselineMethod: "single_pass_observation",
    baselineStatus: "RECONCILED",
    baselineConfidence,
    observationHash,
    reconciliationActions: actions,
    reconciliationReasons: reasons,
  };

  return reconciled;
}

function toWallDescriptorByOrdinal(
  baseline: StructuralBaseline
): Array<{ ordinal: number; descriptor: WallDescriptor }> {
  return [...(baseline.wallDescriptors || [])]
    .map((descriptor, index) => ({
      ordinal: Number.isFinite(Number(descriptor.observedOrdinal))
        ? Number(descriptor.observedOrdinal)
        : index + 1,
      descriptor,
    }))
    .sort((left, right) => compareNumbers(left.ordinal, right.ordinal));
}

function mergeOpeningsRelaxed(
  left: StructuralOpening[],
  right: StructuralOpening[]
): StructuralOpening[] {
  const merged = new Map<string, StructuralOpening>();
  const ingest = (opening: StructuralOpening) => {
    const signature = [
      getCanonicalOpeningIdentityType(opening.type),
      String(opening.wallIndex),
      opening.horizontalBand,
      opening.verticalBand,
      bboxKey(opening.bbox),
    ].join("|");
    const existing = merged.get(signature);
    if (!existing || opening.confidence > existing.confidence) {
      merged.set(signature, opening);
    }
  };

  for (const opening of [...left, ...right]) ingest(opening);

  return [...merged.values()]
    .sort(compareStructuralOpenings)
    .map((opening, index) => ({
      ...opening,
      id: `opening_${index + 1}`,
    }));
}

function mergeFixturesRelaxed(
  left: AnchorFixture[],
  right: AnchorFixture[]
): AnchorFixture[] {
  const merged = new Map<string, AnchorFixture>();
  const ingest = (fixture: AnchorFixture) => {
    const signature = [
      fixture.type,
      String(fixture.wallIndex),
      fixture.horizontalBand,
      bboxKey(fixture.bbox),
    ].join("|");
    const existing = merged.get(signature);
    if (!existing || fixture.confidence > existing.confidence) {
      merged.set(signature, fixture);
    }
  };

  for (const fixture of [...left, ...right]) ingest(fixture);

  return [...merged.values()]
    .sort(compareAnchorFixtures)
    .map((fixture, index) => ({
      ...fixture,
      id: fixture.id || `fixture_${index + 1}`,
    }));
}

function hasUsableBaselineEvidence(baseline: StructuralBaseline | null | undefined): boolean {
  if (!baseline) return false;
  return (baseline.wallDescriptors?.length || 0) > 0
    || (baseline.openings?.length || 0) > 0
    || (baseline.anchorFixtures?.length || 0) > 0;
}

function baselineReliabilityScore(reliability: BaselineReliability | undefined): number {
  if (reliability === "HIGH") return 1;
  if (reliability === "MEDIUM") return 0.7;
  return 0.45;
}

function scoreBaselineCandidate(
  baseline: StructuralBaseline,
  reliability: BaselineReliability,
  confidence: number
): number {
  const wallCount = baseline.wallDescriptors?.length || 0;
  const openingCount = baseline.openings?.length || 0;
  const fixtureCount = baseline.anchorFixtures?.length || 0;
  const disagreementPenalty = (baseline.observationMeta?.validation?.reconciliationReasons?.length || 0) * 0.01;
  return (
    (confidence * 0.55)
    + (baselineReliabilityScore(reliability) * 0.2)
    + (Math.min(wallCount, 4) / 4) * 0.15
    + (Math.min(openingCount + fixtureCount, 6) / 6) * 0.1
    - disagreementPenalty
  );
}

function markBaselineReliability(params: {
  baseline: StructuralBaseline;
  reliability: BaselineReliability;
  fallbackInvoked: boolean;
  baselineExtractionStrategy: "single_pass_observation" | "graph_reconciliation" | "semantic_relaxed_rebuild";
  baselineConfidence: number;
  baselineConfidenceDegraded: boolean;
  baselineStatus: BaselineInternalStatus;
  imageHash: string;
  passCount: number;
  reconciliationActions?: string[];
  reconciliationReasons?: string[];
}): StructuralBaseline {
  const graphHash = hashStructuralBaselineGraph(params.baseline);
  const observationHash = params.baseline.observationMeta?.observationHash || "";
  const confirmedAt = new Date().toISOString();

  return {
    ...params.baseline,
    observationMeta: {
      ...(params.baseline.observationMeta || {
        observationHash,
        wallCount: params.baseline.wallDescriptors?.length || 0,
      }),
      baselineStatus: params.baselineStatus,
      baselineConfidence: params.baselineConfidence,
      baselineReliability: params.reliability,
      fallbackInvoked: params.fallbackInvoked,
      baselineExtractionStrategy: params.baselineExtractionStrategy,
      baselineConfidenceDegraded: params.baselineConfidenceDegraded,
    },
    graphMeta: {
      ...(params.baseline.graphMeta || {
        graphStable: params.baselineStatus === "MATCHED",
        graphConfidence: params.baselineStatus === "MATCHED" ? 1 : 0.6,
        extractionAgreement: params.baselineStatus === "MATCHED" ? 1 : 0.6,
        passCount: params.passCount,
        openingCountVariance: 0,
        cacheStatus: params.baselineStatus === "MATCHED" ? "stabilized" : "unstable",
        candidateGraphHashes: [graphHash],
        openingCountRange: { min: params.baseline.openings.length, max: params.baseline.openings.length },
        confirmedAt,
      }),
      imageHash: params.imageHash,
      graphHash,
      passCount: params.passCount,
      cacheStatus: params.baselineStatus === "MATCHED" ? "stabilized" : "unstable",
      candidateGraphHashes: [graphHash],
      openingCountRange: { min: params.baseline.openings.length, max: params.baseline.openings.length },
      confirmedAt,
      baselineMethod: params.baselineExtractionStrategy === "graph_reconciliation"
        ? "graph_consensus"
        : params.baselineExtractionStrategy,
      observationHash,
      baselineConfidence: params.baselineConfidence,
      baselineStatus: params.baselineStatus,
      baselineReliability: params.reliability,
      fallbackInvoked: params.fallbackInvoked,
      baselineExtractionStrategy: params.baselineExtractionStrategy,
      baselineConfidenceDegraded: params.baselineConfidenceDegraded,
      reconciliationActions: params.reconciliationActions,
      reconciliationReasons: params.reconciliationReasons,
      verification: {
        ...(params.baseline.graphMeta?.verification || {
          attempted: false,
          accepted: true,
          modelAccepted: true,
          additionalOpeningCount: 0,
          missingOpeningCount: 0,
          materiallyDifferentCount: 0,
          notPresentCount: 0,
          minorDifferenceCount: 0,
          rejectedReasonCodes: [],
          openingStatuses: [],
          additionalOpenings: [],
          missingOpenings: [],
        }),
        accepted: params.baselineStatus !== "IRRECONCILABLE",
        modelAccepted: params.baselineStatus !== "IRRECONCILABLE",
        rejectedReasonCodes: params.baselineStatus === "IRRECONCILABLE" ? ["irreconcilable_baseline"] : [],
        analysis: params.reconciliationReasons?.join("; "),
      },
    },
  };
}

function buildRelaxedBaselineFallback(
  run1: StructuralBaseline,
  run2: StructuralBaseline,
  imageHash: string
): StructuralBaseline | null {
  const walls1 = toWallDescriptorByOrdinal(run1);
  const walls2 = toWallDescriptorByOrdinal(run2);
  const maxWalls = Math.max(walls1.length, walls2.length);
  if (maxWalls === 0 && !hasUsableBaselineEvidence(run1) && !hasUsableBaselineEvidence(run2)) {
    return null;
  }

  const actions: string[] = [];
  const mergedWalls: WallDescriptor[] = [];
  for (let index = 0; index < maxWalls; index += 1) {
    const left = walls1[index]?.descriptor;
    const right = walls2[index]?.descriptor;

    const leftAdjusted = left ? { ...left, wallIndex: index as WallIndex, observedOrdinal: index + 1 } : undefined;
    const rightAdjusted = right ? { ...right, wallIndex: index as WallIndex, observedOrdinal: index + 1 } : undefined;
    const merged = reconcileWallDescriptor(leftAdjusted, rightAdjusted, actions);
    if (merged) {
      merged.wallIndex = index as WallIndex;
      merged.observedOrdinal = index + 1;
      mergedWalls.push(merged);
    }
  }

  const canonicalDescriptors = assignCanonicalWallIds(mergedWalls);
  const mergedOpenings = mergeOpeningsRelaxed(run1.openings || [], run2.openings || []);
  const mergedFixtures = mergeFixturesRelaxed(run1.anchorFixtures || [], run2.anchorFixtures || []);

  const preferred = (run1.observationMeta?.baselineConfidence || 0) >= (run2.observationMeta?.baselineConfidence || 0)
    ? run1
    : run2;

  const validation1 = baselineValidationData(run1);
  const validation2 = baselineValidationData(run2);
  const reconciliationReasons = [
    ...structuralDisagreementReasons(run1, run2),
    ...validation1.unknownReferences,
    ...validation1.duplicateReferences,
    ...validation2.unknownReferences,
    ...validation2.duplicateReferences,
    "fallback:semantic_relaxed_rebuild",
  ].filter(Boolean);

  const baselineConfidence = Math.max(
    0.25,
    roundDeterministic(
      Math.min(run1.observationMeta?.baselineConfidence ?? 0.65, run2.observationMeta?.baselineConfidence ?? 0.65) - 0.18,
      3
    )
  );

  const observationHash = createHash("sha256")
    .update(JSON.stringify([
      run1.observationMeta?.observationHash || "",
      run2.observationMeta?.observationHash || "",
      ...canonicalDescriptors.map((wall) => `${wall.wallIndex}:${wall.canonicalWallId || ""}`),
      ...mergedOpenings.map((opening) => `${opening.type}:${opening.wallIndex}:${bboxKey(opening.bbox)}`),
    ]))
    .digest("hex");

  const fallback: StructuralBaseline = {
    ...preferred,
    openings: mergedOpenings,
    anchorFixtures: mergedFixtures,
    wallDescriptors: canonicalDescriptors,
    observationMeta: {
      ...(preferred.observationMeta || { observationHash: "", wallCount: canonicalDescriptors.length }),
      observationHash,
      wallCount: canonicalDescriptors.length,
      baselineStatus: "RECONCILED",
      baselineConfidence,
      validation: {
        unknownReferences: [...new Set([...(validation1.unknownReferences || []), ...(validation2.unknownReferences || [])])],
        duplicateReferences: [...new Set([...(validation1.duplicateReferences || []), ...(validation2.duplicateReferences || [])])],
        unusedInventory: [...new Set([...(validation1.unusedInventory || []), ...(validation2.unusedInventory || [])])],
        inconsistencies: [...new Set([...(validation1.inconsistencies || []), ...(validation2.inconsistencies || [])])],
        rejectedAnchors: [...new Set([...(validation1.rejectedAnchors || []), ...(validation2.rejectedAnchors || [])])],
        chosenAnchors: canonicalDescriptors.map((wall) => `wall_${wall.wallIndex}:${wall.primaryAnchorLabel || "wall_plane"}`),
        reconciliationActions: actions,
        reconciliationReasons,
      },
    },
  };

  return markBaselineReliability({
    baseline: fallback,
    reliability: "LOW",
    fallbackInvoked: true,
    baselineExtractionStrategy: "semantic_relaxed_rebuild",
    baselineConfidence,
    baselineConfidenceDegraded: true,
    baselineStatus: "RECONCILED",
    imageHash,
    passCount: 2,
    reconciliationActions: actions,
    reconciliationReasons,
  });
}

function validateStructuralBaseline(input: any): StructuralBaseline {
  if (!input || typeof input !== "object") {
    throw new Error("Structural baseline must be an object");
  }

  const observedBaseline = normalizeBaselineFromWallSurfaces(input);
  if (observedBaseline) {
    return observedBaseline;
  }

  if (!Array.isArray(input.openings)) {
    throw new Error("Structural baseline openings must be an array");
  }

  const openings: StructuralOpening[] = input.openings.map((opening: any, index: number) => {
    if (!opening || typeof opening !== "object") {
      throw new Error(`Invalid opening at index ${index}`);
    }

    if (typeof opening.id !== "string" || !opening.id.trim()) {
      throw new Error(`Opening id is required at index ${index}`);
    }
    const normalizedType = normalizeOpeningType(opening.type);
    if (!normalizedType || !isOpeningType(normalizedType)) {
      throw new Error(`Opening type must be one of window|door|closet_door|walkthrough at index ${index}`);
    }
    const wallPositionCandidate = isWallPosition(opening.wallPosition)
      ? opening.wallPosition
      : (typeof opening.wallIndex === "number" && isWallIndex(opening.wallIndex)
        ? mapIndexToWallPosition(opening.wallIndex)
        : null);
    if (!wallPositionCandidate) {
      throw new Error(`Opening wallPosition/wallIndex is required at index ${index}`);
    }

    const wallIndexCandidate = typeof opening.wallIndex === "number" && isWallIndex(opening.wallIndex)
      ? opening.wallIndex
      : mapWallPositionToIndex(wallPositionCandidate);

    const relativeHorizontalCandidate = isRelativeHorizontalPosition(opening.relativeHorizontalPosition)
      ? opening.relativeHorizontalPosition
      : (typeof opening.horizontalBand === "string" && isHorizontalBand(opening.horizontalBand)
        ? mapBandToLegacyHorizontal(opening.horizontalBand)
        : "center");

    const horizontalBandCandidate = typeof opening.horizontalBand === "string" && isHorizontalBand(opening.horizontalBand)
      ? opening.horizontalBand
      : mapLegacyHorizontalToBand(relativeHorizontalCandidate);

    const shapeCandidate = typeof opening.shape === "string" && opening.shape.trim()
      ? opening.shape.trim()
      : opening.type;

    const touchesFloorCandidate = typeof opening.touchesFloor === "boolean"
      ? opening.touchesFloor
      : normalizedType === "door" || normalizedType === "closet_door" || normalizedType === "walkthrough";

    const touchesCeilingCandidate = typeof opening.touchesCeiling === "boolean"
      ? opening.touchesCeiling
      : false;

    const approxCountCandidate =
      typeof opening.approxCount === "number" && Number.isFinite(opening.approxCount) && opening.approxCount >= 0
        ? opening.approxCount
        : 1;

    const verticalBandCandidate =
      typeof opening.verticalBand === "string" && isVerticalBand(opening.verticalBand)
        ? opening.verticalBand
        : deriveVerticalBand({
            touchesFloor: touchesFloorCandidate,
            touchesCeiling: touchesCeilingCandidate,
          });

    const bboxCandidate = normalizeBbox(opening, horizontalBandCandidate, verticalBandCandidate);
    const areaPctCandidate = normalizeAreaPct(opening, bboxCandidate);
    const bboxWidth = Math.max(0.01, bboxCandidate[2] - bboxCandidate[0]);
    const bboxHeight = Math.max(0.01, bboxCandidate[3] - bboxCandidate[1]);
    const bboxAspectRatio = bboxWidth / bboxHeight;

    const confidenceCandidate =
      typeof opening.confidence === "number" && Number.isFinite(opening.confidence)
        ? Math.max(0, Math.min(1, opening.confidence))
        : 0.85;

    const wallCoverageBandCandidate =
      typeof opening.wallCoverageBand === "string" && isWallCoverageBand(opening.wallCoverageBand)
        ? opening.wallCoverageBand
        : deriveWallCoverageBand(areaPctCandidate);

    const orientationCandidate =
      typeof opening.orientation === "string" && isOpeningOrientation(opening.orientation)
        ? opening.orientation
        : deriveOrientation(bboxAspectRatio);

    const paneStructureCandidate =
      typeof opening.paneStructure === "string" && isPaneStructure(opening.paneStructure)
        ? opening.paneStructure
        : normalizePaneStructure(opening.paneStructure);

    const doorLeafStateCandidate =
      typeof opening.doorLeafState === "string" && isDoorLeafState(opening.doorLeafState)
        ? opening.doorLeafState
        : normalizeDoorLeafState(opening.doorLeafState, normalizedType);

    return {
      id: opening.id,
      type: normalizedType,
      bbox: bboxCandidate,
      area_pct: areaPctCandidate,
      wallIndex: wallIndexCandidate,
      horizontalBand: horizontalBandCandidate,
      verticalBand: verticalBandCandidate,
      wallCoverageBand: wallCoverageBandCandidate,
      orientation: orientationCandidate,
      paneStructure: paneStructureCandidate,
      doorLeafState: doorLeafStateCandidate,
      confidence: confidenceCandidate,

      wallPosition: wallPositionCandidate,
      relativeHorizontalPosition: relativeHorizontalCandidate,
      shape: shapeCandidate,
      touchesFloor: touchesFloorCandidate,
      touchesCeiling: touchesCeilingCandidate,
      approxCount: approxCountCandidate,
    };
  });

  const anchorFixtures: AnchorFixture[] = Array.isArray(input.anchorFixtures)
    ? input.anchorFixtures
        .map((fixture: any, index: number) => {
          if (!fixture || typeof fixture !== "object") return null;
          const fixtureType = isAnchorFixtureType(String(fixture.type || ""))
            ? (fixture.type as AnchorFixtureType)
            : normalizeAnchorFixtureType(fixture.type);

          const wallIndexCandidate = typeof fixture.wallIndex === "number" && isWallIndex(fixture.wallIndex)
            ? fixture.wallIndex
            : null;
          if (wallIndexCandidate === null) return null;

          const horizontalBandCandidate = typeof fixture.horizontalBand === "string" && isHorizontalBand(fixture.horizontalBand)
            ? fixture.horizontalBand
            : "center_third";
          const bboxCandidate = normalizeBbox(fixture, horizontalBandCandidate, "mid_zone");
          const confidenceCandidate =
            typeof fixture.confidence === "number" && Number.isFinite(fixture.confidence)
              ? Math.max(0, Math.min(1, fixture.confidence))
              : 0.75;

          return {
            id: typeof fixture.id === "string" && fixture.id.trim().length > 0
              ? fixture.id.trim()
              : `F${index + 1}`,
            type: fixtureType,
            wallIndex: wallIndexCandidate,
            horizontalBand: horizontalBandCandidate,
            bbox: bboxCandidate,
            confidence: confidenceCandidate,
          } as AnchorFixture;
        })
        .filter((item: AnchorFixture | null): item is AnchorFixture => item !== null)
    : [];

  const wallDescriptors: WallDescriptor[] = Array.isArray(input.wallDescriptors)
    ? input.wallDescriptors
        .map((descriptor: any) => {
          if (!descriptor || typeof descriptor !== "object") return null;
          const wallIndexCandidate = typeof descriptor.wallIndex === "number" && isWallIndex(descriptor.wallIndex)
            ? descriptor.wallIndex
            : null;
          if (wallIndexCandidate === null) return null;

          const visibilityCandidate = descriptor.visibility === "full" || descriptor.visibility === "partial" || descriptor.visibility === "minimal"
            ? descriptor.visibility
            : "partial";

          const visibleExtentCandidate = descriptor.visibleExtent === "full" || descriptor.visibleExtent === "partial" || descriptor.visibleExtent === "minimal"
            ? descriptor.visibleExtent
            : visibilityCandidate;

          const architecturalCertaintyCandidate = descriptor.architecturalCertainty === "known" || descriptor.architecturalCertainty === "partial" || descriptor.architecturalCertainty === "unknown"
            ? descriptor.architecturalCertainty
            : (visibilityCandidate === "full" ? "known" : visibilityCandidate === "minimal" ? "unknown" : "partial");

          const leftBoundaryVisibleCandidate = descriptor.leftBoundaryVisible === true;
          const rightBoundaryVisibleCandidate = descriptor.rightBoundaryVisible === true;
          const leftCornerVisibleCandidate = descriptor.leftCornerVisible === true;
          const rightCornerVisibleCandidate = descriptor.rightCornerVisible === true;
          const terminatesAtCornerCandidate = descriptor.terminatesAtCorner === true;
          const continuesBeyondFrameCandidate = descriptor.continuesBeyondFrame === true;

          const descriptionCandidate = typeof descriptor.description === "string" && descriptor.description.trim().length > 0
            ? descriptor.description.trim()
            : "";

          if (!descriptionCandidate) return null;

          return {
            wallIndex: wallIndexCandidate,
            visibility: visibilityCandidate,
            visibleExtent: visibleExtentCandidate,
            architecturalCertainty: architecturalCertaintyCandidate,
            leftBoundaryVisible: leftBoundaryVisibleCandidate,
            rightBoundaryVisible: rightBoundaryVisibleCandidate,
            leftCornerVisible: leftCornerVisibleCandidate,
            rightCornerVisible: rightCornerVisibleCandidate,
            terminatesAtCorner: terminatesAtCornerCandidate,
            continuesBeyondFrame: continuesBeyondFrameCandidate,
            description: descriptionCandidate,
          } as WallDescriptor;
        })
        .filter((item: WallDescriptor | null): item is WallDescriptor => item !== null)
    : [];

  const enrichedWallDescriptors = wallDescriptors.map((descriptor) => ({
    ...descriptor,
    leftCornerPosition: descriptor.leftCornerPosition || deriveDescriptorCornerPosition(descriptor, "left"),
    rightCornerPosition: descriptor.rightCornerPosition || deriveDescriptorCornerPosition(descriptor, "right"),
    leftCornerVisibility: descriptor.leftCornerVisibility || deriveDescriptorCornerVisibility(descriptor, "left"),
    rightCornerVisibility: descriptor.rightCornerVisibility || deriveDescriptorCornerVisibility(descriptor, "right"),
    leftAdjacentWallVisibility: descriptor.leftAdjacentWallVisibility || deriveDescriptorAdjacentWallVisibility(wallDescriptors, descriptor, "left"),
    rightAdjacentWallVisibility: descriptor.rightAdjacentWallVisibility || deriveDescriptorAdjacentWallVisibility(wallDescriptors, descriptor, "right"),
    boundaryBehaviour: descriptor.boundaryBehaviour || deriveDescriptorBoundaryBehaviour(descriptor),
  }));

  openings.sort(compareStructuralOpenings);
  anchorFixtures.sort(compareAnchorFixtures);

  return {
    cameraOrientation: typeof input.cameraOrientation === "string" ? input.cameraOrientation : undefined,
    openings,
    anchorFixtures,
    wallDescriptors: enrichedWallDescriptors.length > 0 ? enrichedWallDescriptors : undefined,
  };
}

function bboxCenterX(bbox: [number, number, number, number]): number {
  return (bbox[0] + bbox[2]) / 2;
}

function deriveDescriptorCornerPosition(descriptor: WallDescriptor, side: "left" | "right"): WallDescriptor["leftCornerPosition"] {
  const visible = side === "left" ? descriptor.leftCornerVisible === true : descriptor.rightCornerVisible === true;
  if (!visible) return "none";
  const sideBoundaryVisible = side === "left" ? descriptor.leftBoundaryVisible === true : descriptor.rightBoundaryVisible === true;
  const oppositeBoundaryVisible = side === "left" ? descriptor.rightBoundaryVisible === true : descriptor.leftBoundaryVisible === true;
  if (descriptor.visibility === "minimal") return "image_edge";
  if (sideBoundaryVisible && !oppositeBoundaryVisible) return "image_edge";
  if (sideBoundaryVisible && oppositeBoundaryVisible) return "outer_third";
  return "inner_third";
}

function deriveDescriptorCornerVisibility(descriptor: WallDescriptor, side: "left" | "right"): WallDescriptor["leftCornerVisibility"] {
  const visible = side === "left" ? descriptor.leftCornerVisible === true : descriptor.rightCornerVisible === true;
  if (!visible) return "none";
  if (descriptor.visibility === "minimal") return "trace";
  if (descriptor.visibility === "partial") return "partial";
  return "full";
}

function deriveDescriptorAdjacentWallVisibility(allDescriptors: WallDescriptor[], descriptor: WallDescriptor, side: "left" | "right"): WallDescriptor["leftAdjacentWallVisibility"] {
  const visible = side === "left" ? descriptor.leftCornerVisible === true : descriptor.rightCornerVisible === true;
  if (!visible) return "none";
  const adjacentIndex = side === "left"
    ? ((descriptor.wallIndex + 3) % 4) as WallIndex
    : ((descriptor.wallIndex + 1) % 4) as WallIndex;
  const adjacentDescriptor = allDescriptors.find((item) => item.wallIndex === adjacentIndex);
  if (!adjacentDescriptor) return "none";
  if (adjacentDescriptor.visibility === "minimal") return "minimal";
  if (adjacentDescriptor.visibility === "partial") return "partial";
  return "full";
}

function deriveDescriptorBoundaryBehaviour(descriptor: WallDescriptor): WallDescriptor["boundaryBehaviour"] {
  if (descriptor.terminatesAtCorner === true) return "terminates_at_visible_corner";
  if (descriptor.continuesBeyondFrame === true) return "continues_beyond_frame";
  return "unknown";
}

type WallSequenceContext = {
  openingTokens: string[];
  fixtureTokens: string[];
  allTokens: string[];
};

function buildWallSequenceContext(
  openings: StructuralOpening[],
  fixtures: AnchorFixture[] | undefined,
  wallIndex: WallIndex
): WallSequenceContext {
  const openingItems = openings
    .filter((opening) => opening.wallIndex === wallIndex)
    .map((opening) => ({
      kind: "opening" as const,
      token: `O:${opening.type}`,
      x: bboxCenterX(opening.bbox),
    }));

  const fixtureItems = (fixtures || [])
    .filter((fixture) => fixture.wallIndex === wallIndex && fixture.confidence >= 0.65)
    .map((fixture) => ({
      kind: "fixture" as const,
      token: `F:${fixture.type}`,
      x: bboxCenterX(fixture.bbox),
    }));

  const all = [...openingItems, ...fixtureItems]
    .sort((a, b) => {
      if (Math.abs(a.x - b.x) > 1e-4) return a.x - b.x;
      if (a.kind === b.kind) return compareStrings(a.token, b.token);
      return a.kind === "fixture" ? -1 : 1;
    })
    .map((item) => item.token);

  return {
    openingTokens: openingItems
      .sort((a, b) => compareNumbers(a.x, b.x, 1e-4) || compareStrings(a.token, b.token))
      .map((item) => item.token),
    fixtureTokens: fixtureItems
      .sort((a, b) => compareNumbers(a.x, b.x, 1e-4) || compareStrings(a.token, b.token))
      .map((item) => item.token),
    allTokens: all,
  };
}

function isTokenSubsequence(source: string[], target: string[]): boolean {
  if (source.length === 0) return true;
  let sourceIdx = 0;
  for (const token of target) {
    if (token === source[sourceIdx]) {
      sourceIdx += 1;
      if (sourceIdx >= source.length) return true;
    }
  }
  return false;
}

function hasStableAnchorReference(
  baselineFixtures: AnchorFixture[] | undefined,
  detectedFixtures: AnchorFixture[] | undefined,
  wallIndex: WallIndex
): boolean {
  const base = (baselineFixtures || []).filter((fixture) => fixture.wallIndex === wallIndex && fixture.confidence >= 0.65);
  const det = (detectedFixtures || []).filter((fixture) => fixture.wallIndex === wallIndex && fixture.confidence >= 0.65);
  if (base.length === 0 || det.length === 0) return false;

  return base.some((fixture) =>
    det.some((candidate) =>
      candidate.type === fixture.type &&
      candidate.horizontalBand === fixture.horizontalBand
    )
  );
}

function validateOpeningValidationResult(input: any, baseline: StructuralBaseline): OpeningValidationResult {
  if (!input || typeof input !== "object") {
    throw new Error("Opening validation result must be an object");
  }
  if (!Array.isArray(input.results)) {
    throw new Error("Opening validation result results must be an array");
  }

  const baselineIds = new Set(baseline.openings.map((o) => o.id));

  const results = input.results.map((item: any, index: number) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid opening validation item at index ${index}`);
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(`Opening validation id is required at index ${index}`);
    }
    if (!baselineIds.has(item.id)) {
      throw new Error(`Opening validation id not found in baseline: ${item.id}`);
    }
    if (typeof item.present !== "boolean") {
      throw new Error(`present must be boolean at index ${index}`);
    }
    if (typeof item.sealed !== "boolean") {
      throw new Error(`sealed must be boolean at index ${index}`);
    }
    if (typeof item.relocated !== "boolean") {
      throw new Error(`relocated must be boolean at index ${index}`);
    }
    if (typeof item.outOfFrame !== "boolean") {
      throw new Error(`outOfFrame must be boolean at index ${index}`);
    }
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) {
      throw new Error(`confidence must be a finite number at index ${index}`);
    }

    return {
      id: item.id,
      present: item.present,
      sealed: item.sealed,
      relocated: item.relocated,
      outOfFrame: item.outOfFrame,
      confidence: Math.max(0, Math.min(1, item.confidence)),
    };
  });

  const missingIds = baseline.openings
    .map((opening) => opening.id)
    .filter((openingId) => !results.some((item) => item.id === openingId));

  if (missingIds.length > 0) {
    throw new Error(`Opening validation missing IDs: ${missingIds.join(", ")}`);
  }

  if (!input.summary || typeof input.summary !== "object") {
    throw new Error("Opening validation summary must be an object");
  }
  if (typeof input.summary.openingRemoved !== "boolean") {
    throw new Error("openingRemoved must be boolean in summary");
  }
  if (input.summary.openingInfilled !== undefined && typeof input.summary.openingInfilled !== "boolean") {
    throw new Error("openingInfilled must be boolean in summary when present");
  }
  if (typeof input.summary.openingRelocated !== "boolean") {
    throw new Error("openingRelocated must be boolean in summary");
  }
  if (typeof input.summary.openingResized !== "boolean") {
    throw new Error("openingResized must be boolean in summary");
  }
  if (typeof input.summary.openingClassMismatch !== "boolean") {
    throw new Error("openingClassMismatch must be boolean in summary");
  }
  if (typeof input.summary.openingBandMismatch !== "boolean") {
    throw new Error("openingBandMismatch must be boolean in summary");
  }
  if (input.summary.openingStateChanged !== undefined && typeof input.summary.openingStateChanged !== "boolean") {
    throw new Error("openingStateChanged must be boolean in summary when present");
  }
  if (input.summary.openingApertureExpanded !== undefined && typeof input.summary.openingApertureExpanded !== "boolean") {
    throw new Error("openingApertureExpanded must be boolean in summary when present");
  }
  if (input.summary.stagingOcclusionAdvisory !== undefined && typeof input.summary.stagingOcclusionAdvisory !== "boolean") {
    throw new Error("stagingOcclusionAdvisory must be boolean in summary when present");
  }
  if (input.summary.frameBoundaryTruncationAdvisory !== undefined && typeof input.summary.frameBoundaryTruncationAdvisory !== "boolean") {
    throw new Error("frameBoundaryTruncationAdvisory must be boolean in summary when present");
  }
  if (input.summary.semanticAnchorErosionAdvisory !== undefined && typeof input.summary.semanticAnchorErosionAdvisory !== "boolean") {
    throw new Error("semanticAnchorErosionAdvisory must be boolean in summary when present");
  }
  if (!Array.isArray(input.summary.outOfFrameOpenings)) {
    throw new Error("outOfFrameOpenings must be an array in summary");
  }
  if (typeof input.summary.confidence !== "number" || !Number.isFinite(input.summary.confidence)) {
    throw new Error("summary confidence must be a finite number");
  }

  const summary = {
    openingRemoved: input.summary.openingRemoved === true,
    openingInfilled: input.summary.openingInfilled === true,
    openingSealed:
      input.summary.openingSealed === true ||
      input.summary.openingRemoved === true ||
      input.summary.openingInfilled === true,
    openingRelocated: input.summary.openingRelocated === true || results.some((item) => item.relocated === true),
    openingResized: input.summary.openingResized === true,
    openingClassMismatch: input.summary?.openingClassMismatch === true,
    openingClassMismatchEnforcement: "advisory" as const,
    openingBandMismatch: input.summary.openingBandMismatch === true,
    openingStateChanged: input.summary.openingStateChanged === true,
    openingApertureExpanded: input.summary.openingApertureExpanded === true,
    stagingOcclusionAdvisory: input.summary.stagingOcclusionAdvisory === true,
    frameBoundaryTruncationAdvisory: input.summary.frameBoundaryTruncationAdvisory === true,
    semanticAnchorErosionAdvisory: input.summary.semanticAnchorErosionAdvisory === true,
    outOfFrameOpenings: input.summary.outOfFrameOpenings.filter((openingId: any) => typeof openingId === "string"),
    openingCount:
      input.summary.openingCount &&
      Number.isFinite(Number(input.summary.openingCount.before)) &&
      Number.isFinite(Number(input.summary.openingCount.after))
        ? {
            before: Number(input.summary.openingCount.before),
            after: Number(input.summary.openingCount.after),
          }
        : undefined,
    analysis: typeof input.summary.analysis === "string" ? input.summary.analysis : undefined,
    semanticOpeningAreaDeltaPct:
      typeof input.summary.semanticOpeningAreaDeltaPct === "number" && Number.isFinite(input.summary.semanticOpeningAreaDeltaPct)
        ? Math.abs(input.summary.semanticOpeningAreaDeltaPct)
        : undefined,
    semanticOpeningAspectRatioDelta:
      typeof input.summary.semanticOpeningAspectRatioDelta === "number" && Number.isFinite(input.summary.semanticOpeningAspectRatioDelta)
        ? Math.abs(input.summary.semanticOpeningAspectRatioDelta)
        : undefined,
    windowSillDeltaPct:
      typeof input.summary.windowSillDeltaPct === "number" && Number.isFinite(input.summary.windowSillDeltaPct)
        ? Math.abs(input.summary.windowSillDeltaPct)
        : undefined,
    confidence: Math.max(0, Math.min(1, input.summary.confidence)),
  };

  return { results, findings: [], summary, detectedOpenings: [], structuralSignals: [] };
}

function summarizePerceivedStructuralWalls(rawParsed: any): Record<string, unknown> {
  const inventory = rawParsed && typeof rawParsed.inventory === "object" ? rawParsed.inventory : {};
  const rawObservedWalls = Array.isArray(rawParsed?.observedWalls)
    ? rawParsed.observedWalls
    : (Array.isArray(rawParsed?.wallSurfaces) ? rawParsed.wallSurfaces : []);

  const inventoryOpenings = Array.isArray(inventory?.openings)
    ? inventory.openings.filter((item: unknown) => typeof item === "string")
    : [];
  const inventoryFixtures = Array.isArray(inventory?.permanentFixtures)
    ? inventory.permanentFixtures.filter((item: unknown) => typeof item === "string")
    : [];
  const inventoryFeatures = Array.isArray(inventory?.architecturalFeatures)
    ? inventory.architecturalFeatures.filter((item: unknown) => typeof item === "string")
    : [];

  const blankWallLabels = new Set([
    "blank_wall",
    "largest_blank_wall",
    "blank_wall_left_of_window",
    "blank_wall_right_of_window",
    "wall_plane",
  ]);

  const joineryKeywords = [
    "kitchen island",
    "island",
    "pantry",
    "wardrobe",
    "cabinet side",
    "cabinet face",
    "appliance enclosure",
    "fridge surround",
    "refrigerator surround",
    "shelving",
  ];

  const walls = rawObservedWalls.map((surface: any, index: number) => {
    const wall = surface?.observedWall && typeof surface.observedWall === "object" ? surface.observedWall : surface;
    const observedOrdinal = Number.isFinite(Number(wall?.observedOrdinal))
      ? Number(wall.observedOrdinal)
      : index + 1;

    const containsOpenings = Array.isArray(wall?.containsOpenings)
      ? wall.containsOpenings.filter((item: unknown) => typeof item === "string")
      : [];
    const containsPermanentFixtures = Array.isArray(wall?.containsPermanentFixtures)
      ? wall.containsPermanentFixtures.filter((item: unknown) => typeof item === "string")
      : [];
    const containsArchitecturalFeatures = Array.isArray(wall?.containsArchitecturalFeatures)
      ? wall.containsArchitecturalFeatures.filter((item: unknown) => typeof item === "string")
      : [];

    const openingTypes = Array.isArray(wall?.openingObservations)
      ? wall.openingObservations
          .map((item: any) => (typeof item?.type === "string" ? item.type : null))
          .filter((item: string | null): item is string => item !== null)
      : [];

    const attributes = [
      ...containsOpenings,
      ...containsPermanentFixtures,
      ...containsArchitecturalFeatures,
      ...openingTypes,
    ];
    const loweredAttributes = attributes.map((item) => item.trim().toLowerCase()).filter(Boolean);

    const explicitBlank = loweredAttributes.some((item) => blankWallLabels.has(item));
    const blankWall = explicitBlank || loweredAttributes.length === 0;

    const leftReturn = String(wall?.leftSide?.returnWallVisible || "").trim().toLowerCase();
    const rightReturn = String(wall?.rightSide?.returnWallVisible || "").trim().toLowerCase();
    const leftCornerVisible = wall?.leftSide?.cornerVisible === true;
    const rightCornerVisible = wall?.rightSide?.cornerVisible === true;

    const wallStructuralReturns: string[] = [];
    if (leftReturn && leftReturn !== "none" && leftReturn !== "unknown") wallStructuralReturns.push(`wall_${observedOrdinal}:left:${leftReturn}`);
    if (rightReturn && rightReturn !== "none" && rightReturn !== "unknown") wallStructuralReturns.push(`wall_${observedOrdinal}:right:${rightReturn}`);

    const wallStructuralRecesses = loweredAttributes
      .filter((item) => item.includes("recess") || item === "recessed_wall")
      .map((item) => `wall_${observedOrdinal}:${item}`);

    const wallStructuralProjections = loweredAttributes
      .filter((item) => item.includes("column") || item.includes("chimney"))
      .map((item) => `wall_${observedOrdinal}:${item}`);

    const ignoredJoinery = loweredAttributes.filter((item) => joineryKeywords.some((token) => item.includes(token)));

    return {
      observedOrdinal,
      blankWall,
      attributes: loweredAttributes,
      leftCornerVisible,
      rightCornerVisible,
      structuralReturns: wallStructuralReturns,
      structuralRecesses: wallStructuralRecesses,
      structuralProjections: wallStructuralProjections,
      ignoredJoinery,
    };
  });

  const structuralReturns = walls.flatMap((wall) => wall.structuralReturns);
  const structuralRecesses = walls.flatMap((wall) => wall.structuralRecesses);
  const structuralProjections = walls.flatMap((wall) => wall.structuralProjections);
  const ignoredJoinery = Array.from(new Set(walls.flatMap((wall) => wall.ignoredJoinery)));

  const blankWallCount = walls.filter((wall) => wall.blankWall).length;
  const structuralWallCount = Math.max(0, walls.length - blankWallCount);

  const wallAttributes = walls.map((wall) => ({
    observedOrdinal: wall.observedOrdinal,
    blankWall: wall.blankWall,
    attributes: wall.attributes,
    leftCornerVisible: wall.leftCornerVisible,
    rightCornerVisible: wall.rightCornerVisible,
  }));

  return {
    structuralWallCount,
    blankWallCount,
    inventoryItems: {
      openings: inventoryOpenings,
      permanentFixtures: inventoryFixtures,
      architecturalFeatures: inventoryFeatures,
    },
    wallAttributes,
    structuralReturns,
    structuralRecesses,
    structuralProjections,
    ...(ignoredJoinery.length > 0 ? { ignoredJoinery } : {}),
  };
}

async function extractStructuralBaselineOnce(
  image: { data: string; mime: string },
  options?: { jobId?: string; imageId?: string; attempt?: number; timing?: BaselineExtractionTimingBreakdown }
): Promise<StructuralBaseline> {
  const ai = getGeminiClient();

  const stageStartedAt = Date.now();
  const promptBuildStartedAt = Date.now();
  const promptParts = [
    { text: BASELINE_SYSTEM_INSTRUCTION },
    { text: BASELINE_USER_PROMPT },
    { inlineData: { mimeType: image.mime, data: image.data } },
  ];
  if (options?.timing) {
    options.timing.promptBuildMs += Date.now() - promptBuildStartedAt;
  }
  const requestStartedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: OPENING_VALIDATOR_MODEL,
    contents: [
      {
        role: "user",
        parts: promptParts,
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  } as any);
  if (options?.timing) {
    options.timing.geminiRequestMs += 0;
    options.timing.responseReceiveMs += Date.now() - requestStartedAt;
  }
  logGeminiUsage({
    ctx: {
      jobId: options?.jobId || "",
      imageId: options?.imageId || "",
      stage: "validator",
      attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    },
    model: OPENING_VALIDATOR_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const parseStartedAt = Date.now();
  const parsed = parseJsonResponse(response);
  if (options?.timing) {
    options.timing.jsonParseMs += Date.now() - parseStartedAt;
  }
  console.log("[ENVELOPE_BASELINE_EXTRACTION_SUMMARY]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : undefined,
    ...summarizePerceivedStructuralWalls(parsed),
  }));
  const normalizationStartedAt = Date.now();
  const baseline = validateStructuralBaseline(parsed);
  if (options?.timing) {
    options.timing.normalizationMs += Date.now() - normalizationStartedAt;
  }
  console.log("[OPENING_EXTRACTION_STAGE_DURATION]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : undefined,
    stage: "gemini_structural_extraction",
    durationMs: Date.now() - stageStartedAt,
  }));
  console.log("[OPENING_BASELINE]", JSON.stringify({
    openings: baseline.openings.map((opening) => ({
      id: opening.id,
      type: opening.type,
      wallIndex: opening.wallIndex,
      horizontalBand: opening.horizontalBand,
      verticalBand: opening.verticalBand,
      wallCoverageBand: opening.wallCoverageBand,
      orientation: opening.orientation,
      paneStructure: opening.paneStructure,
      doorLeafState: opening.doorLeafState,
      confidence: opening.confidence,
    })),
    anchorFixtures: (baseline.anchorFixtures || []).map((fixture) => ({
      id: fixture.id,
      type: fixture.type,
      wallIndex: fixture.wallIndex,
      horizontalBand: fixture.horizontalBand,
      confidence: fixture.confidence,
    })),
  }));
  return baseline;
}

async function verifyStructuralBaselineOnce(
  image: { data: string; mime: string },
  baseline: StructuralBaseline,
  options?: { jobId?: string; imageId?: string; attempt?: number; timing?: BaselineExtractionTimingBreakdown }
): Promise<BaselineVerificationResult> {
  const ai = getGeminiClient();
  const promptBuildStartedAt = Date.now();
  const verificationPayload = {
    openings: baseline.openings.map((opening) => ({
      id: opening.id,
      type: opening.type,
      wallIndex: opening.wallIndex,
      horizontalBand: opening.horizontalBand,
      verticalBand: opening.verticalBand,
      bbox: quantizeBbox(opening.bbox),
      confidence: roundDeterministic(opening.confidence, 3),
    })),
  };
  if (options?.timing) {
    options.timing.promptBuildMs += Date.now() - promptBuildStartedAt;
  }

  const stageStartedAt = Date.now();
  const requestStartedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: getBaselineVerificationModel(),
    contents: [
      {
        role: "user",
        parts: [
          { text: BASELINE_VERIFICATION_SYSTEM_INSTRUCTION },
          { text: BASELINE_VERIFICATION_USER_PROMPT },
          { text: `BASELINE_JSON:\n${JSON.stringify(verificationPayload)}` },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  } as any);
  if (options?.timing) {
    options.timing.geminiRequestMs += 0;
    options.timing.responseReceiveMs += Date.now() - requestStartedAt;
  }

  logGeminiUsage({
    ctx: {
      jobId: options?.jobId || "",
      imageId: options?.imageId || "",
      stage: "validator",
      attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    },
    model: getBaselineVerificationModel(),
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const parseStartedAt = Date.now();
  const parsed = parseJsonResponse(response);
  if (options?.timing) {
    options.timing.jsonParseMs += Date.now() - parseStartedAt;
  }
  const normalizationStartedAt = Date.now();
  const verification = validateBaselineVerificationResult(parsed, baseline);
  if (options?.timing) {
    options.timing.normalizationMs += Date.now() - normalizationStartedAt;
  }
  console.log("[OPENING_EXTRACTION_STAGE_DURATION]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : undefined,
    stage: "gemini_structural_verification",
    durationMs: Date.now() - stageStartedAt,
  }));
  return verification;
}

async function stabilizeStructuralBaselineGraphConsensus(
  image: { data: string; mime: string },
  imageHash: string,
  options?: BaselineExtractionOptions,
  timingInput?: BaselineExtractionTimingBreakdown
): Promise<StructuralBaseline> {
  const modeStartedAt = Date.now();
  const timing = timingInput || createBaselineTimingBreakdown();
  const cacheKey = `${STRUCTURAL_BASELINE_CACHE_PREFIX}${imageHash}`;
  const cached = options?.disableCache ? null : await getRedisJson<StructuralBaselineCacheRecord>(cacheKey);

  if (cached?.graphStable && cached.graph) {
    const graphMeta = {
      graphStable: true,
      graphConfidence: cached.graphConfidence,
      extractionAgreement: cached.extractionAgreement,
      passCount: cached.passCount,
      openingCountVariance: cached.openingCountVariance,
      imageHash: cached.imageHash,
      graphHash: cached.graphHash,
      cacheStatus: "hit" as const,
      candidateGraphHashes: cached.candidateGraphHashes || [cached.graphHash],
      openingCountRange: cached.openingCountRange,
      confirmedAt: cached.updatedAt,
      baselineMethod: "graph_consensus" as const,
      geminiCalls: cached.passCount,
      verification: {
        attempted: false,
        accepted: true,
        modelAccepted: true,
        additionalOpeningCount: 0,
        missingOpeningCount: 0,
        materiallyDifferentCount: 0,
        notPresentCount: 0,
        minorDifferenceCount: 0,
        rejectedReasonCodes: [],
        openingStatuses: [],
        additionalOpenings: [],
        missingOpenings: [],
        analysis: undefined,
      },
    };
    console.log("[STRUCTURAL_BASELINE_CACHE_HIT]", JSON.stringify({
      imageHash,
      graphHash: cached.graphHash,
      extractionAgreement: cached.extractionAgreement,
      passCount: cached.passCount,
      openingCountVariance: cached.openingCountVariance,
      baselineMethod: "graph_consensus",
    }));
    console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      extractionCalls: 0,
      cacheStatus: "hit",
    }));
    console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      baselineExtractionDurationMs: Date.now() - modeStartedAt,
      totalGeminiCalls: 0,
    }));
    const totalMs = sumBaselineTimingBreakdown(timing);
    console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      imageDownloadMs: timing.imageDownloadMs,
      imageMaterializationMs: timing.imageMaterializationMs,
      imageResizeMs: timing.imageResizeMs,
      promptBuildMs: timing.promptBuildMs,
      geminiRequestMs: timing.geminiRequestMs,
      responseReceiveMs: timing.responseReceiveMs,
      jsonParseMs: timing.jsonParseMs,
      normalizationMs: timing.normalizationMs,
      graphBuildMs: timing.graphBuildMs,
      persistenceMs: timing.persistenceMs,
      totalMs,
    }));
    return { ...cached.graph, graphMeta };
  }

  const passResults: StructuralBaseline[] = [];
  const passHashes: string[] = [];
  const maxPasses = STRUCTURAL_BASELINE_STABILIZATION_PASSES;
  let lastError: unknown = null;

  for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
    const passStartedAt = Date.now();
    try {
      const baseline = await extractStructuralBaselineOnce(image, {
        jobId: options?.jobId,
        imageId: options?.imageId,
        attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) + passIndex : passIndex + 1,
        timing,
      });
      const hashStartedAt = Date.now();
      const graphHash = hashStructuralBaselineGraph(baseline);
      timing.graphBuildMs += Date.now() - hashStartedAt;
      passResults.push(baseline);
      passHashes.push(graphHash);
      console.log("[STRUCTURAL_BASELINE_PASS_DETAIL]", JSON.stringify({
        jobId: options?.jobId,
        imageId: options?.imageId,
        imageHash,
        durationMs: Date.now() - passStartedAt,
        ...buildStructuralBaselinePassTelemetry(passIndex + 1, graphHash, baseline),
      }));
    } catch (err) {
      lastError = err;
      console.error("[STRUCTURAL_BASELINE_PASS_ERROR]", {
        jobId: options?.jobId,
        imageId: options?.imageId,
        attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
        passIndex: passIndex + 1,
        durationMs: Date.now() - passStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (passResults.length === 0) {
    throw lastError instanceof Error ? lastError : new Error("STRUCTURAL_BASELINE_EXTRACTION_FAILED");
  }

  const graphBuildStartedAt = Date.now();
  const histogram = new Map<string, { count: number; graph: StructuralBaseline }>();
  passResults.forEach((baseline, index) => {
    const hash = passHashes[index];
    const entry = histogram.get(hash);
    if (entry) {
      entry.count += 1;
    } else {
      histogram.set(hash, { count: 1, graph: baseline });
    }
  });

  const ranked = Array.from(histogram.entries()).sort((left, right) => {
    const countCmp = compareNumbers(right[1].count, left[1].count);
    if (countCmp !== 0) return countCmp;
    return compareStrings(left[0], right[0]);
  });
  const [graphHash, consensus] = ranked[0];
  const { min, max, variance } = openingCountVariance(passResults);
  const extractionAgreement = consensus.count / passResults.length;
  const graphConfidence = extractionAgreement;
  const graphStable = consensus.count >= Math.ceil(passResults.length / 2) && extractionAgreement >= STRUCTURAL_BASELINE_MIN_AGREEMENT && variance === 0;
  const confirmedAt = new Date().toISOString();
  const graphMeta = {
    graphStable,
    graphConfidence,
    extractionAgreement,
    passCount: passResults.length,
    openingCountVariance: variance,
    imageHash,
    graphHash,
    cacheStatus: graphStable ? "stabilized" as const : "unstable" as const,
    candidateGraphHashes: ranked.map(([hash]) => hash),
    openingCountRange: { min, max },
    confirmedAt,
    baselineMethod: "graph_consensus" as const,
    geminiCalls: passResults.length,
    verification: {
      attempted: false,
      accepted: true,
      modelAccepted: true,
      additionalOpeningCount: 0,
      missingOpeningCount: 0,
      materiallyDifferentCount: 0,
      notPresentCount: 0,
      minorDifferenceCount: 0,
      rejectedReasonCodes: [],
      openingStatuses: [],
      additionalOpenings: [],
      missingOpenings: [],
      analysis: undefined,
    },
  };
  const varianceSummary = summarizeStructuralBaselineVariance(
    passResults.map((baseline, index) => buildStructuralBaselinePassTelemetry(index + 1, passHashes[index], baseline))
  );
  timing.graphBuildMs += Date.now() - graphBuildStartedAt;

  console.log("[STRUCTURAL_BASELINE_GRAPH_CONFIDENCE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    graphStable,
    graphConfidence,
    extractionAgreement: Number(extractionAgreement.toFixed(3)),
    passCount: passResults.length,
    openingCountVariance: variance,
    candidateGraphHashes: graphMeta.candidateGraphHashes,
    cacheStatus: graphMeta.cacheStatus,
    baselineMethod: "graph_consensus",
  }));
  console.log("[STRUCTURAL_BASELINE_VARIANCE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    passCount: passResults.length,
    openingCountVariance: variance,
    graphHashVariance: varianceSummary.graphHashVariance,
    signatureVariance: varianceSummary.signatureVariance,
    bboxVariance: varianceSummary.bboxVariance,
    wallIndexVariance: varianceSummary.wallIndexVariance,
    verticalBandVariance: varianceSummary.verticalBandVariance,
    confidenceVariance: varianceSummary.confidenceVariance,
  }));

  const stabilizedGraph = { ...consensus.graph, graphMeta };

  console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "consensus",
    extractionCalls: passResults.length,
    cacheStatus: graphMeta.cacheStatus,
  }));
  console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "consensus",
    baselineExtractionDurationMs: Date.now() - modeStartedAt,
    totalGeminiCalls: passResults.length,
  }));

  if (graphStable && !options?.disableCache) {
    const persistenceStartedAt = Date.now();
    const cacheRecord: StructuralBaselineCacheRecord = {
      imageHash,
      graphHash,
      graph: stabilizedGraph,
      graphStable: true,
      graphConfidence,
      extractionAgreement,
      passCount: passResults.length,
      openingCountVariance: variance,
      openingCountRange: { min, max },
      candidateGraphHashes: graphMeta.candidateGraphHashes,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    };
    await setRedisJson(cacheKey, cacheRecord);
    timing.persistenceMs += Date.now() - persistenceStartedAt;
  }

  const totalMs = sumBaselineTimingBreakdown(timing);
  console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageDownloadMs: timing.imageDownloadMs,
    imageMaterializationMs: timing.imageMaterializationMs,
    imageResizeMs: timing.imageResizeMs,
    promptBuildMs: timing.promptBuildMs,
    geminiRequestMs: timing.geminiRequestMs,
    responseReceiveMs: timing.responseReceiveMs,
    jsonParseMs: timing.jsonParseMs,
    normalizationMs: timing.normalizationMs,
    graphBuildMs: timing.graphBuildMs,
    persistenceMs: timing.persistenceMs,
    totalMs,
  }));

  return stabilizedGraph;
}

async function stabilizeStructuralBaselineWithVerification(
  image: { data: string; mime: string },
  imageHash: string,
  options?: BaselineExtractionOptions,
  timingInput?: BaselineExtractionTimingBreakdown
): Promise<StructuralBaseline> {
  const modeStartedAt = Date.now();
  const timing = timingInput || createBaselineTimingBreakdown();
  const cacheKey = `${STRUCTURAL_BASELINE_CACHE_PREFIX}verify:${imageHash}`;
  const cached = options?.disableCache ? null : await getRedisJson<StructuralBaselineCacheRecord>(cacheKey);

  if (cached?.graphStable && cached.graph) {
    console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      extractionCalls: 0,
      cacheStatus: "hit",
    }));
    console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      baselineExtractionDurationMs: Date.now() - modeStartedAt,
      totalGeminiCalls: 0,
    }));
    const totalMs = sumBaselineTimingBreakdown(timing);
    console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      imageDownloadMs: timing.imageDownloadMs,
      imageMaterializationMs: timing.imageMaterializationMs,
      imageResizeMs: timing.imageResizeMs,
      promptBuildMs: timing.promptBuildMs,
      geminiRequestMs: timing.geminiRequestMs,
      responseReceiveMs: timing.responseReceiveMs,
      jsonParseMs: timing.jsonParseMs,
      normalizationMs: timing.normalizationMs,
      graphBuildMs: timing.graphBuildMs,
      persistenceMs: timing.persistenceMs,
      totalMs,
    }));
    return {
      ...cached.graph,
      graphMeta: {
        ...(cached.graph.graphMeta || {}),
        graphStable: true,
        graphConfidence: cached.graphConfidence,
        extractionAgreement: cached.extractionAgreement,
        passCount: cached.passCount,
        openingCountVariance: cached.openingCountVariance,
        imageHash: cached.imageHash,
        graphHash: cached.graphHash,
        cacheStatus: "hit",
        candidateGraphHashes: cached.candidateGraphHashes || [cached.graphHash],
        openingCountRange: cached.openingCountRange,
        confirmedAt: cached.updatedAt,
        baselineMethod: "extraction_verification",
      },
    };
  }

  const primaryBaseline = await extractStructuralBaselineOnce(image, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    timing,
  });
  const primaryHashStartedAt = Date.now();
  const primaryHash = hashStructuralBaselineGraph(primaryBaseline);
  timing.graphBuildMs += Date.now() - primaryHashStartedAt;
  console.log("[BASELINE_EXTRACTION_RESULT]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    baselineMode: "extraction_verification",
    extractionPass: 1,
    graphHash: primaryHash,
    openingCount: primaryBaseline.openings.length,
  }));

  const verification = await verifyStructuralBaselineOnce(image, primaryBaseline, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) + 1 : 2,
    timing,
  });

  const materiallyDifferentCount = verification.openings.filter((entry) => entry.status === "materially_different").length;
  const notPresentCount = verification.openings.filter((entry) => entry.status === "not_present").length;
  const minorDifferenceCount = verification.openings.filter((entry) => entry.status === "confirmed_with_minor_description_difference").length;
  const additionalOpeningCount = verification.additionalOpenings.length;
  const missingOpeningCount = verification.missingOpenings.length;
  const wallAssignmentOnlyCount = verification.openings.filter((entry) =>
    entry.status === "materially_different" && isWallAssignmentOnlyVerificationNote(entry.notes)
  ).length;
  const adjustedMinorDifferenceCount = minorDifferenceCount + wallAssignmentOnlyCount;
  const adjustedMateriallyDifferentCount = Math.max(0, materiallyDifferentCount - wallAssignmentOnlyCount);

  console.log("[BASELINE_VERIFICATION_RESULT]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    baselineMode: "extraction_verification",
    baselineAcceptedByModel: verification.baselineAccepted,
    materiallyDifferentCount: adjustedMateriallyDifferentCount,
    notPresentCount,
    minorDifferenceCount: adjustedMinorDifferenceCount,
    wallAssignmentOnlyCount,
    additionalOpeningCount,
    missingOpeningCount,
    openingStatuses: verification.openings.map((entry) => ({
      id: entry.id,
      status: entry.status === "materially_different" && isWallAssignmentOnlyVerificationNote(entry.notes)
        ? "confirmed_with_minor_description_difference"
        : entry.status,
      notes: entry.notes,
    })),
    additionalOpenings: verification.additionalOpenings,
    missingOpenings: verification.missingOpenings,
    analysis: verification.analysis,
  }));

  const rejectedReasonCodes: string[] = [];
  if (additionalOpeningCount > 0) rejectedReasonCodes.push("additional_openings_detected");
  if (missingOpeningCount > 0) rejectedReasonCodes.push("missing_openings_detected");
  if (adjustedMateriallyDifferentCount > 0 || notPresentCount > 0) rejectedReasonCodes.push("material_opening_mismatch");

  const acceptedByRule = additionalOpeningCount === 0 && missingOpeningCount === 0 && adjustedMateriallyDifferentCount === 0 && notPresentCount === 0;
  const accepted = acceptedByRule;

  if (accepted) {
    const graphHash = primaryHash;
    const confirmedAt = new Date().toISOString();
    const graphMeta = {
      graphStable: true,
      graphConfidence: 1,
      extractionAgreement: 1,
      passCount: 1,
      openingCountVariance: 0,
      imageHash,
      graphHash,
      cacheStatus: "stabilized" as const,
      candidateGraphHashes: [graphHash],
      openingCountRange: { min: primaryBaseline.openings.length, max: primaryBaseline.openings.length },
      confirmedAt,
      baselineMethod: "extraction_verification" as const,
      geminiCalls: 2,
      verification: {
        attempted: true,
        accepted: true,
        modelAccepted: verification.baselineAccepted,
        additionalOpeningCount,
        missingOpeningCount,
        materiallyDifferentCount: adjustedMateriallyDifferentCount,
        notPresentCount,
        minorDifferenceCount: adjustedMinorDifferenceCount,
        rejectedReasonCodes,
        openingStatuses: verification.openings.map((entry) => ({
          id: entry.id,
          status: entry.status === "materially_different" && isWallAssignmentOnlyVerificationNote(entry.notes)
            ? "confirmed_with_minor_description_difference"
            : entry.status,
          notes: entry.notes,
        })),
        additionalOpenings: verification.additionalOpenings,
        missingOpenings: verification.missingOpenings,
        analysis: verification.analysis,
      },
    };

    const acceptedBaseline = {
      ...primaryBaseline,
      graphMeta,
    };
    console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      extractionCalls: 2,
      cacheStatus: graphMeta.cacheStatus,
    }));
    console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      mode: "consensus",
      baselineExtractionDurationMs: Date.now() - modeStartedAt,
      totalGeminiCalls: 2,
    }));
    console.log("[BASELINE_VERIFICATION_ACCEPTED]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      imageHash,
      baselineMode: "extraction_verification",
      openingCount: acceptedBaseline.openings.length,
      graphHash,
      minorDifferenceCount,
    }));

    if (!options?.disableCache) {
      const persistenceStartedAt = Date.now();
      const cacheRecord: StructuralBaselineCacheRecord = {
        imageHash,
        graphHash,
        graph: acceptedBaseline,
        graphStable: true,
        graphConfidence: 1,
        extractionAgreement: 1,
        passCount: 1,
        openingCountVariance: 0,
        openingCountRange: { min: primaryBaseline.openings.length, max: primaryBaseline.openings.length },
        candidateGraphHashes: [graphHash],
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
      };
      await setRedisJson(cacheKey, cacheRecord);
      timing.persistenceMs += Date.now() - persistenceStartedAt;
    }

    const totalMs = sumBaselineTimingBreakdown(timing);
    console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
      jobId: options?.jobId,
      imageId: options?.imageId,
      imageDownloadMs: timing.imageDownloadMs,
      imageMaterializationMs: timing.imageMaterializationMs,
      imageResizeMs: timing.imageResizeMs,
      promptBuildMs: timing.promptBuildMs,
      geminiRequestMs: timing.geminiRequestMs,
      responseReceiveMs: timing.responseReceiveMs,
      jsonParseMs: timing.jsonParseMs,
      normalizationMs: timing.normalizationMs,
      graphBuildMs: timing.graphBuildMs,
      persistenceMs: timing.persistenceMs,
      totalMs,
    }));

    return acceptedBaseline;
  }

  console.log("[BASELINE_VERIFICATION_REJECTED]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    baselineMode: "extraction_verification",
    rejectedReasonCodes,
  }));

  const fallbackBaseline = await extractStructuralBaselineOnce(image, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) + 2 : 3,
    timing,
  });
  const fallbackHashStartedAt = Date.now();
  const fallbackHash = hashStructuralBaselineGraph(fallbackBaseline);
  timing.graphBuildMs += Date.now() - fallbackHashStartedAt;

  const primaryInventory = openingInventorySignature(primaryBaseline);
  const fallbackInventory = openingInventorySignature(fallbackBaseline);
  const inventoryAgreement = primaryInventory === fallbackInventory;

  const canonical = inventoryAgreement
    ? primaryBaseline
    : mergeCanonicalBaselineFromFallback(primaryBaseline, fallbackBaseline);
  const canonicalHashStartedAt = Date.now();
  const canonicalHash = hashStructuralBaselineGraph(canonical);
  timing.graphBuildMs += Date.now() - canonicalHashStartedAt;
  const { min, max, variance } = openingCountVariance([primaryBaseline, fallbackBaseline]);
  const confirmedAt = new Date().toISOString();

  const result: StructuralBaseline = {
    ...canonical,
    graphMeta: {
      graphStable: inventoryAgreement,
      graphConfidence: inventoryAgreement ? 1 : 0.5,
      extractionAgreement: inventoryAgreement ? 1 : 0.5,
      passCount: 2,
      openingCountVariance: variance,
      imageHash,
      graphHash: canonicalHash,
      cacheStatus: inventoryAgreement ? "stabilized" : "unstable",
      candidateGraphHashes: [primaryHash, fallbackHash],
      openingCountRange: { min, max },
      confirmedAt,
      baselineMethod: "extraction_verification",
      geminiCalls: 3,
      verification: {
        attempted: true,
        accepted: false,
        modelAccepted: verification.baselineAccepted,
        additionalOpeningCount,
        missingOpeningCount,
        materiallyDifferentCount: adjustedMateriallyDifferentCount,
        notPresentCount,
        minorDifferenceCount: adjustedMinorDifferenceCount,
        rejectedReasonCodes,
        openingStatuses: verification.openings.map((entry) => ({
          id: entry.id,
          status: entry.status === "materially_different" && isWallAssignmentOnlyVerificationNote(entry.notes)
            ? "confirmed_with_minor_description_difference"
            : entry.status,
          notes: entry.notes,
        })),
        additionalOpenings: verification.additionalOpenings,
        missingOpenings: verification.missingOpenings,
        analysis: verification.analysis,
      },
    },
  };

  console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "consensus",
    extractionCalls: 3,
    cacheStatus: result.graphMeta?.cacheStatus,
  }));
  console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "consensus",
    baselineExtractionDurationMs: Date.now() - modeStartedAt,
    totalGeminiCalls: 3,
  }));
  const totalMs = sumBaselineTimingBreakdown(timing);
  console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageDownloadMs: timing.imageDownloadMs,
    imageMaterializationMs: timing.imageMaterializationMs,
    imageResizeMs: timing.imageResizeMs,
    promptBuildMs: timing.promptBuildMs,
    geminiRequestMs: timing.geminiRequestMs,
    responseReceiveMs: timing.responseReceiveMs,
    jsonParseMs: timing.jsonParseMs,
    normalizationMs: timing.normalizationMs,
    graphBuildMs: timing.graphBuildMs,
    persistenceMs: timing.persistenceMs,
    totalMs,
  }));

  console.log("[BASELINE_EXTRACTION_RESULT]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    baselineMode: "extraction_verification",
    extractionPass: 2,
    graphHash: fallbackHash,
    openingCount: fallbackBaseline.openings.length,
    inventoryAgreement,
    canonicalGraphHash: canonicalHash,
    canonicalOpeningCount: result.openings.length,
  }));

  return result;
}

async function stabilizeStructuralBaselineSinglePass(
  image: { data: string; mime: string },
  imageHash: string,
  options?: BaselineExtractionOptions,
  timingInput?: BaselineExtractionTimingBreakdown
): Promise<StructuralBaseline> {
  const modeStartedAt = Date.now();
  const timing = timingInput || createBaselineTimingBreakdown();
  const markBaseline = (
    baseline: StructuralBaseline,
    params: {
      extractionCalls: number;
      baselineStatus: BaselineInternalStatus;
      reconciliationActions?: string[];
      reconciliationReasons?: string[];
      reliability?: BaselineReliability;
      fallbackInvoked?: boolean;
      baselineExtractionStrategy?: "single_pass_observation" | "graph_reconciliation" | "semantic_relaxed_rebuild";
      baselineConfidenceDegraded?: boolean;
    }
  ): StructuralBaseline => {
    const graphBuildStartedAt = Date.now();
    const graphHash = hashStructuralBaselineGraph(baseline);
    timing.graphBuildMs += Date.now() - graphBuildStartedAt;
    const confirmedAt = new Date().toISOString();
    const baselineConfidence = baseline.observationMeta?.baselineConfidence;
    const observationHash = baseline.observationMeta?.observationHash;

    return markBaselineReliability({
      baseline,
      reliability: params.reliability || (params.baselineStatus === "MATCHED" ? "HIGH" : "MEDIUM"),
      fallbackInvoked: !!params.fallbackInvoked,
      baselineExtractionStrategy: params.baselineExtractionStrategy || (params.baselineStatus === "MATCHED" ? "single_pass_observation" : "graph_reconciliation"),
      baselineConfidence: baselineConfidence ?? 0,
      baselineConfidenceDegraded: !!params.baselineConfidenceDegraded,
      baselineStatus: params.baselineStatus,
      imageHash,
      passCount: params.extractionCalls,
      reconciliationActions: params.reconciliationActions,
      reconciliationReasons: params.reconciliationReasons,
    });
  };

  const run1 = await extractStructuralBaselineOnce(image, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    timing,
  });

  let finalBaseline: StructuralBaseline;
  let extractionCalls = 1;

  if (isBaselineValidationPassed(run1)) {
    finalBaseline = markBaseline(run1, {
      extractionCalls: 1,
      baselineStatus: "MATCHED",
    });
  } else {
    const run2 = await extractStructuralBaselineOnce(image, {
      jobId: options?.jobId,
      imageId: options?.imageId,
      attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) + 1 : 2,
      timing,
    });
    extractionCalls = 2;

    if (isBaselineValidationPassed(run2)) {
      finalBaseline = markBaseline(run2, {
        extractionCalls,
        baselineStatus: "MATCHED",
      });
    } else {
      const reconciled = reconcileFailedBaselines(run1, run2, imageHash);
      if (!reconciled) {
        const irreconcilableReasons = structuralDisagreementReasons(run1, run2);
        console.log("[BASELINE_EXTRACTION_RESULT]", JSON.stringify({
          jobId: options?.jobId,
          imageId: options?.imageId,
          imageHash,
          baselineMode: "single_pass",
          baselineStatus: "IRRECONCILABLE_PRIMARY",
          extractionPass: 2,
          reasons: irreconcilableReasons,
        }));

        const fallbackCandidates: Array<{
          label: string;
          baseline: StructuralBaseline;
          reliability: BaselineReliability;
          confidence: number;
          strategy: "single_pass_observation" | "graph_reconciliation" | "semantic_relaxed_rebuild";
          fallbackInvoked: boolean;
          confidenceDegraded: boolean;
          reasons: string[];
        }> = [];

        if (hasUsableBaselineEvidence(run1)) {
          fallbackCandidates.push({
            label: "primary_run1",
            baseline: run1,
            reliability: "LOW",
            confidence: Math.max(0.25, roundDeterministic((run1.observationMeta?.baselineConfidence ?? 0.55) - 0.2, 3)),
            strategy: "single_pass_observation",
            fallbackInvoked: true,
            confidenceDegraded: true,
            reasons: [...irreconcilableReasons, "fallback:selected_primary_run1"],
          });
        }

        if (hasUsableBaselineEvidence(run2)) {
          fallbackCandidates.push({
            label: "primary_run2",
            baseline: run2,
            reliability: "LOW",
            confidence: Math.max(0.25, roundDeterministic((run2.observationMeta?.baselineConfidence ?? 0.55) - 0.2, 3)),
            strategy: "single_pass_observation",
            fallbackInvoked: true,
            confidenceDegraded: true,
            reasons: [...irreconcilableReasons, "fallback:selected_primary_run2"],
          });
        }

        const relaxedFallback = buildRelaxedBaselineFallback(run1, run2, imageHash);
        if (relaxedFallback && hasUsableBaselineEvidence(relaxedFallback)) {
          fallbackCandidates.push({
            label: "semantic_relaxed_rebuild",
            baseline: relaxedFallback,
            reliability: "LOW",
            confidence: relaxedFallback.observationMeta?.baselineConfidence ?? 0.35,
            strategy: "semantic_relaxed_rebuild",
            fallbackInvoked: true,
            confidenceDegraded: true,
            reasons: [
              ...irreconcilableReasons,
              "fallback:semantic_relaxed_rebuild",
            ],
          });
        }

        if (fallbackCandidates.length === 0) {
          throw new Error(`IRRECONCILABLE_BASELINE:${irreconcilableReasons.join(",") || "unknown"}`);
        }

        const scoredCandidates = fallbackCandidates.map((candidate) => ({
          ...candidate,
          score: scoreBaselineCandidate(candidate.baseline, candidate.reliability, candidate.confidence),
        })).sort((left, right) => right.score - left.score);

        const best = scoredCandidates[0];
        const second = scoredCandidates[1];
        const clearlySuperior = !second || (best.score - second.score) >= 0.12;
        const reliability: BaselineReliability = clearlySuperior ? best.reliability : "LOW";
        const confidenceDegraded = !clearlySuperior || best.confidenceDegraded;

        finalBaseline = markBaseline(best.baseline, {
          extractionCalls,
          baselineStatus: "RECONCILED",
          reconciliationActions: [
            ...(best.baseline.observationMeta?.validation?.reconciliationActions || []),
            "fallback_candidate_selection",
          ],
          reconciliationReasons: [
            ...(best.reasons || []),
            clearlySuperior ? "fallback:clearly_superior_candidate" : "fallback:ambiguous_candidates_use_best_available",
          ],
          reliability,
          fallbackInvoked: true,
          baselineExtractionStrategy: best.strategy,
          baselineConfidenceDegraded: confidenceDegraded,
        });

        console.log("[BASELINE_EXTRACTION_FALLBACK]", JSON.stringify({
          jobId: options?.jobId,
          imageId: options?.imageId,
          imageHash,
          invoked: true,
          selectedStrategy: best.strategy,
          selectedCandidate: best.label,
          selectedScore: roundDeterministic(best.score, 4),
          runnerUpScore: second ? roundDeterministic(second.score, 4) : null,
          clearlySuperior,
          baselineReliability: reliability,
          baselineConfidence: finalBaseline.observationMeta?.baselineConfidence,
          baselineConfidenceDegraded: confidenceDegraded,
        }));
      } else {
        finalBaseline = markBaseline(reconciled, {
          extractionCalls,
          baselineStatus: "RECONCILED",
          reconciliationActions: reconciled.observationMeta?.validation?.reconciliationActions,
          reconciliationReasons: reconciled.observationMeta?.validation?.reconciliationReasons,
          reliability: "MEDIUM",
          fallbackInvoked: false,
          baselineExtractionStrategy: "graph_reconciliation",
          baselineConfidenceDegraded: false,
        });
      }
    }
  }

  console.log("[OPENING_BASELINE_MODE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "single_pass",
    extractionCalls,
    baselineStatus: finalBaseline.graphMeta?.baselineStatus,
  }));
  console.log("[BASELINE_EXTRACTION_RESULT]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageHash,
    baselineMode: "single_pass",
    extractionPass: extractionCalls,
    baselineStatus: finalBaseline.graphMeta?.baselineStatus,
    baselineReliability: finalBaseline.observationMeta?.baselineReliability,
    fallbackInvoked: finalBaseline.observationMeta?.fallbackInvoked,
    baselineExtractionStrategy: finalBaseline.observationMeta?.baselineExtractionStrategy,
    baselineConfidenceDegraded: finalBaseline.observationMeta?.baselineConfidenceDegraded,
    graphHash: finalBaseline.graphMeta?.graphHash,
    openingCount: finalBaseline.openings.length,
    reconciliationActions: finalBaseline.graphMeta?.reconciliationActions || [],
    reconciliationReasons: finalBaseline.graphMeta?.reconciliationReasons || [],
  }));
  console.log("[OPENING_BASELINE_METRICS]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    mode: "single_pass",
    baselineStatus: finalBaseline.graphMeta?.baselineStatus,
    baselineExtractionDurationMs: Date.now() - modeStartedAt,
    totalGeminiCalls: extractionCalls,
  }));
  const totalMs = sumBaselineTimingBreakdown(timing);
  console.log("[OPENING_BASELINE_TIMING]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    imageDownloadMs: timing.imageDownloadMs,
    imageMaterializationMs: timing.imageMaterializationMs,
    imageResizeMs: timing.imageResizeMs,
    promptBuildMs: timing.promptBuildMs,
    geminiRequestMs: timing.geminiRequestMs,
    responseReceiveMs: timing.responseReceiveMs,
    jsonParseMs: timing.jsonParseMs,
    normalizationMs: timing.normalizationMs,
    graphBuildMs: timing.graphBuildMs,
    persistenceMs: timing.persistenceMs,
    totalMs,
  }));

  return finalBaseline;
}

async function stabilizeStructuralBaseline(
  imageUrl: string,
  options?: BaselineExtractionOptions
): Promise<StructuralBaseline> {
  const timing = createBaselineTimingBreakdown();
  const materializationStartedAt = Date.now();
  const image = await materializeOpeningExtractionImage(imageUrl, {
    ...options,
    timing,
  });
  console.log("[OPENING_EXTRACTION_STAGE_DURATION]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : undefined,
    stage: "image_materialization",
    durationMs: Date.now() - materializationStartedAt,
  }));
  const imageHash = hashStructuralImage(image.data);
  return stabilizeStructuralBaselineSinglePass(image, imageHash, options, timing);
}

export async function extractStructuralBaseline(
  imageUrl: string,
  options?: BaselineExtractionOptions
): Promise<StructuralBaseline> {
  return stabilizeStructuralBaseline(imageUrl, options);
}

export async function validateOpeningPreservation(
  baseline: StructuralBaseline,
  newImageUrl: string,
  options?: {
    mode?: "default" | "edit";
    jobId?: string;
    imageId?: string;
    attempt?: number;
    detectedBaseline?: StructuralBaseline;
  }
): Promise<OpeningValidationResult> {
  const detected = options?.detectedBaseline ?? await extractStructuralBaseline(newImageUrl, {
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: options?.attempt,
  });
  const isEditMode = options?.mode === "edit";

  const reconciliation = reconcileOpeningMatches(baseline.openings, detected.openings);
  const reconciliationHash = createHash("sha256")
    .update(
      JSON.stringify(
        stableSortObject(
          reconciliation.debug.map((entry) => ({
            baselineId: entry.baselineId,
            detectedId: entry.detectedId,
            matchSource: entry.matchSource,
            score: roundDeterministic(entry.score, 3),
          }))
        )
      )
    )
    .digest("hex");
  console.log("[OPENING_RECONCILIATION_TRACE]", JSON.stringify({
    jobId: options?.jobId,
    imageId: options?.imageId,
    attempt: options?.attempt,
    reconciliationHash,
    baselineOpeningCount: baseline.openings.length,
    detectedOpeningCount: detected.openings.length,
    matchedCount: reconciliation.debug.length,
    idMatchCount: reconciliation.debug.filter((entry) => entry.matchSource === "id").length,
    graphMatchCount: reconciliation.debug.filter((entry) => entry.matchSource === "graph_reconcile").length,
    unmatchedBaselineIds: baseline.openings
      .map((opening) => opening.id)
      .filter((openingId) => !reconciliation.matches.has(openingId)),
    unmatchedDetectedIds: detected.openings
      .map((opening) => opening.id)
      .filter((openingId) => !reconciliation.matchedDetectedIds.has(openingId)),
  }));

  const openingResults: OpeningResult[] = [];
  const findings: OpeningDiagnosticFinding[] = [];
  const structuralSignals: StructuralSignal[] = [];
  const outOfFrameOpenings: string[] = [];
  let openingRemoved = false;
  let openingInfilled = false;
  let openingRelocated = false;
  let openingResized = false;
  let openingClassMismatch = false;
  let openingBandMismatch = false;
  let openingStateChanged = false;
  let openingApertureExpanded = false;
  let stagingOcclusionAdvisory = false;
  let frameBoundaryTruncationAdvisory = false;
  let semanticAnchorErosionAdvisory = false;
  let maxAreaDelta = 0;
  let maxAspectDelta = 0;
  let maxWindowSillShift = 0;
  const analysisNotes: string[] = [];

  for (const baseOpening of baseline.openings) {
    const matchEntry = reconciliation.matches.get(baseOpening.id);
    const match = matchEntry?.opening;

    if (!match) {
      const edgeOfFrame = isEdgeOfFrameOpening(baseOpening);

      if (edgeOfFrame) {
        outOfFrameOpenings.push(baseOpening.id);
        frameBoundaryTruncationAdvisory = true;
        analysisNotes.push(
          `Baseline opening ${baseOpening.id} (${baseOpening.type}) was near frame edge and is not detectable in AFTER; marked out_of_frame (preserved under uncertainty bias).`
        );
        openingResults.push({
          id: baseOpening.id,
          present: true,
          sealed: false,
          relocated: false,
          outOfFrame: true,
          confidence: 0.7,
        });
        continue;
      }

      openingRemoved = true;
      const likelyInfilled = baseOpening.type !== "window";
      if (likelyInfilled) openingInfilled = true;

      const status = likelyInfilled ? "INFILLED" : "MISSING";
      const reason = likelyInfilled ? "opening_replaced_by_wall_continuity" : "missing_opening";

      // Emit per-opening structural signal with baseline bbox
      const [bx1, by1, bx2, by2] = baseOpening.bbox || [0, 0, 0, 0];
      structuralSignals.push({
        claim: "opening_removed",
        region: { x1: bx1, y1: by1, x2: bx2, y2: by2 },
        confidence: 0.99,
        source: "openingPreservation",
        openingId: baseOpening.id,
        openingType: baseOpening.type,
        wallIndex: baseOpening.wallIndex,
      });

      console.log(`[OPENING_VALIDATION] baseline_id=${baseOpening.id} status=${status} reason=${reason}`);
      analysisNotes.push(
        `Baseline opening ${baseOpening.id} (${baseOpening.type}) near wallIndex=${baseOpening.wallIndex}, band=${baseOpening.horizontalBand}/${baseOpening.verticalBand} is not detectable in AFTER; classified as ${status.toLowerCase()}.`
      );
      const location = describeOpeningLocation(baseOpening);
      findings.push({
        id: baseOpening.id,
        openingType: baseOpening.type,
        status: likelyInfilled ? "infilled" : "missing",
        location,
        wallIndex: baseOpening.wallIndex,
        bbox: baseOpening.bbox,
        machineReasons: [reason],
        explanation: likelyInfilled
          ? `The ${location} is not detectable in the AFTER image and appears to have been replaced by continuous wall surface.`
          : `The ${location} is not detectable in the AFTER image.` ,
        question: likelyInfilled
          ? `Is the ${location} still present in the AFTER image, or does this area now appear to be continuous wall surface?`
          : `Is the ${location} still visible in the AFTER image, or is it no longer present?`,
        confidence: 0.99,
      });

      openingResults.push({
        id: baseOpening.id,
        present: false,
        sealed: true,
        relocated: false,
        outOfFrame: false,
        confidence: 0.99,
      });
      continue;
    }

    const invariantReasons: string[] = [];

    if (match.wallIndex !== baseOpening.wallIndex) {
      // If both positional bands are stable, the wall-index difference is extraction-label
      // drift (same physical opening, Gemini assigned a different wall number between
      // the two independent image passes). This must NOT escalate to openingRelocated
      // because it would cascade into hasMajorLocationShift → occlusionLikely=false
      // → classifyAsInfilled=true for any moderate bbox area delta.
      const wallIndexBandsStable =
        match.horizontalBand === baseOpening.horizontalBand &&
        match.verticalBand === baseOpening.verticalBand;
      if (wallIndexBandsStable) {
        invariantReasons.push("wall_index_extraction_drift");
        analysisNotes.push(
          `Opening ${baseOpening.id} wall index extraction drift (before=${baseOpening.wallIndex}, after=${match.wallIndex}); horizontal+vertical bands stable — treated as label noise, not structural relocation.`
        );
      } else {
        openingRelocated = true;
        invariantReasons.push("wall_index_changed");
        analysisNotes.push(
          `Opening ${baseOpening.id} shifted walls (before=${baseOpening.wallIndex}, after=${match.wallIndex}).`
        );
      }
    }

    if (match.horizontalBand !== baseOpening.horizontalBand) {
      openingBandMismatch = true;
      invariantReasons.push("horizontal_band_changed");
    }

    if (match.verticalBand !== baseOpening.verticalBand) {
      openingBandMismatch = true;
      invariantReasons.push("vertical_band_changed");
    }

    const baseCoverageIdx = wallCoverageBandIndex(baseOpening.wallCoverageBand);
    const matchCoverageIdx = wallCoverageBandIndex(match.wallCoverageBand);
    if (Math.abs(matchCoverageIdx - baseCoverageIdx) > 1) {
      openingResized = true;
      invariantReasons.push("wall_coverage_band_changed_gt_one");
    }

    if (match.type !== baseOpening.type) {
      openingClassMismatch = true;
      invariantReasons.push("opening_type_changed");
      analysisNotes.push(
        `Opening ${baseOpening.id} changed type (before=${baseOpening.type}, after=${match.type}).`
      );
    }

    if (
      baseOpening.paneStructure !== "unknown" &&
      match.paneStructure !== "unknown" &&
      baseOpening.paneStructure !== match.paneStructure
    ) {
      openingResized = true;
      invariantReasons.push("pane_structure_changed");
    }

    if (baseOpening.orientation !== match.orientation) {
      openingResized = true;
      invariantReasons.push("orientation_changed");
    }

    const baseArea = Math.max(0.01, Number(baseOpening.area_pct || 0));
    const detectedArea = Math.max(0.01, Number(match.area_pct || 0));
    const areaDelta = Math.abs((detectedArea - baseArea) / baseArea);
    const areaGrowthRatio = (detectedArea - baseArea) / baseArea;
    maxAreaDelta = Math.max(maxAreaDelta, areaDelta);

    if (
      areaGrowthRatio >= OPENING_APERTURE_EXPANSION_MAX &&
      baseOpening.confidence >= OPENING_APERTURE_CONFIDENCE_MIN &&
      match.confidence >= OPENING_APERTURE_CONFIDENCE_MIN &&
      matchCoverageIdx > baseCoverageIdx
    ) {
      openingApertureExpanded = true;
      openingResized = true;
      invariantReasons.push(`aperture_expanded_gt_${OPENING_APERTURE_EXPANSION_MAX.toFixed(2)}`);
      analysisNotes.push(
        `Opening ${baseOpening.id} visible aperture expanded materially (growth=${areaGrowthRatio.toFixed(3)}, max=${OPENING_APERTURE_EXPANSION_MAX.toFixed(3)}).`
      );
    }

    if (
      (baseOpening.type === "door" || baseOpening.type === "closet_door") &&
      (baseOpening.doorLeafState === "closed" || baseOpening.doorLeafState === "open") &&
      baseOpening.confidence >= OPENING_STATE_CONFIDENCE_MIN &&
      match.confidence >= OPENING_STATE_CONFIDENCE_MIN
    ) {
      const detectedDoorState = match.doorLeafState;
      if (
        (detectedDoorState === "closed" || detectedDoorState === "open") &&
        detectedDoorState !== baseOpening.doorLeafState
      ) {
        openingStateChanged = true;
        invariantReasons.push("door_leaf_state_changed");
        analysisNotes.push(
          `Door state changed for ${baseOpening.id} (before=${baseOpening.doorLeafState}, after=${detectedDoorState}).`
        );
      }
    }

    if (baseOpening.type === "window") {
      const baseBottomY = Number(baseOpening.bbox?.[3] ?? NaN);
      const detectedBottomY = Number(match.bbox?.[3] ?? NaN);
      if (Number.isFinite(baseBottomY) && Number.isFinite(detectedBottomY)) {
        const sillShift = Math.abs(detectedBottomY - baseBottomY);
        maxWindowSillShift = Math.max(maxWindowSillShift, sillShift);
        if (sillShift > WINDOW_SILL_MAX_SHIFT) {
          openingResized = true;
          openingBandMismatch = true;
          invariantReasons.push(`window_sill_shift_gt_${WINDOW_SILL_MAX_SHIFT.toFixed(2)}`);
          analysisNotes.push(
            `Window ${baseOpening.id} sill moved vertically by ${sillShift.toFixed(3)} (max=${WINDOW_SILL_MAX_SHIFT.toFixed(3)}).`
          );
        }
      }
    }

    let areaLossAssessment: ReturnType<typeof classifyNonWindowOpeningAreaLoss> | null = null;
    if (baseOpening.type !== "window" && areaDelta >= 0.35) {
      areaLossAssessment = classifyNonWindowOpeningAreaLoss({
        baseOpening,
        detectedOpening: match,
        areaDelta,
        invariantReasons,
      });
      if (areaLossAssessment.classifyAsInfilled) {
        openingInfilled = true;
        analysisNotes.push(
          `Opening ${baseOpening.id} (${baseOpening.type}) lost substantial visible area (delta=${areaDelta.toFixed(3)}, retention=${areaLossAssessment.retention.toFixed(3)}, overlap=${areaLossAssessment.overlapToBaseline.toFixed(3)}), indicating likely structural infill/sealing.`
        );
      } else if (areaLossAssessment.occlusionLikely) {
        stagingOcclusionAdvisory = true;
        invariantReasons.push("staging_occlusion_advisory");
        analysisNotes.push(
          `Opening ${baseOpening.id} (${baseOpening.type}) shows moderate visible-area loss (delta=${areaDelta.toFixed(3)}, retention=${areaLossAssessment.retention.toFixed(3)}, overlap=${areaLossAssessment.overlapToBaseline.toFixed(3)}), but remains perceptually present in-place; treated as staging occlusion advisory.`
        );
      }
      if (areaLossAssessment.frameBoundaryTruncationLikely) {
        frameBoundaryTruncationAdvisory = true;
        invariantReasons.push("frame_boundary_truncation_advisory");
      }
      if (areaLossAssessment.semanticAnchorErosionLikely && !areaLossAssessment.classifyAsInfilled) {
        semanticAnchorErosionAdvisory = true;
        invariantReasons.push("semantic_anchor_erosion_advisory");
      }
    }

    // Emit opening_resized_major: only when delta ≥ 25%, opening still visible
    // (matched, not occluded), and both confidences > 0.90.
    const sizeReductionRatio = (baseArea - detectedArea) / baseArea;
    if (
      sizeReductionRatio >= 0.25 &&
      match &&
      baseOpening.confidence > 0.9 &&
      match.confidence > 0.9
    ) {
      const [rx1, ry1, rx2, ry2] = baseOpening.bbox || [0, 0, 0, 0];
      structuralSignals.push({
        claim: "opening_resized_major",
        region: { x1: rx1, y1: ry1, x2: rx2, y2: ry2 },
        confidence: Math.min(baseOpening.confidence, match.confidence),
        source: "openingPreservation",
        openingId: baseOpening.id,
        openingType: baseOpening.type,
        wallIndex: baseOpening.wallIndex,
      });
    }

    const baseAspect = Math.max(0.01, (baseOpening.bbox[2] - baseOpening.bbox[0]) / Math.max(0.01, (baseOpening.bbox[3] - baseOpening.bbox[1])));
    const detectedAspect = Math.max(0.01, (match.bbox[2] - match.bbox[0]) / Math.max(0.01, (match.bbox[3] - match.bbox[1])));
    const aspectDelta = Math.abs((detectedAspect - baseAspect) / baseAspect);
    maxAspectDelta = Math.max(maxAspectDelta, aspectDelta);

    const advisoryOnlyReasons = new Set([
      "staging_occlusion_advisory",
      "frame_boundary_truncation_advisory",
      "semantic_anchor_erosion_advisory",
      // Wall-index-only drift with stable bands is extraction noise, not structural mutation.
      // Keep it out of effectiveInvariantReasons so it cannot trigger altered/relocated status.
      "wall_index_extraction_drift",
    ]);
    const effectiveInvariantReasons = invariantReasons.filter((reason) => {
      if (
        reason === "wall_coverage_band_changed_gt_one" &&
        areaLossAssessment?.occlusionLikely === true &&
        areaLossAssessment.classifyAsInfilled !== true
      ) {
        return false;
      }
      return true;
    });
    const altered = effectiveInvariantReasons.some((reason) => !advisoryOnlyReasons.has(reason));
    console.log(
      `[OPENING_VALIDATION] baseline_id=${baseOpening.id} status=${altered ? "ALTERED" : "PRESERVED"} reason=${
        effectiveInvariantReasons.length > 0 ? effectiveInvariantReasons.join("|") : "none"
      }`
    );

    if (effectiveInvariantReasons.length > 0) {
      const location = describeOpeningLocation(baseOpening);
      const narrative = buildAlteredOpeningNarrative(baseOpening, effectiveInvariantReasons);
      findings.push({
        id: baseOpening.id,
        openingType: baseOpening.type,
        status: "altered",
        location,
        wallIndex: baseOpening.wallIndex,
        bbox: baseOpening.bbox,
        machineReasons: effectiveInvariantReasons,
        explanation: narrative.explanation,
        question: narrative.question,
        confidence: Math.min(baseOpening.confidence, match.confidence),
      });
    }

    openingResults.push({
      id: baseOpening.id,
      present: true,
      sealed: false,
      relocated: match.wallIndex !== baseOpening.wallIndex,
      outOfFrame: false,
      confidence: Math.min(baseOpening.confidence, match.confidence),
    });
  }

  // Emit opening_added signals for detected openings that have no baseline match.
  const matchedDetectedIds = reconciliation.matchedDetectedIds;
  for (const det of detected.openings) {
    if (matchedDetectedIds.has(det.id)) continue;
    // Gate 1: high confidence required
    if (det.confidence <= 0.9) continue;
    // Gate 2: not at frame edge (partial visibility)
    if (isEdgeOfFrameOpening(det)) continue;
    // Gate 3: minimum area — reject tiny artefacts (mirrors, shadow lines, furniture edges)
    const [ax1, ay1, ax2, ay2] = det.bbox || [0, 0, 0, 0];
    const detArea = (ax2 - ax1) * (ay2 - ay1);
    if (detArea < 0.005) continue; // < 0.5% of image is too small to be a real opening
    // Gate 4: maximum area — reject full-wall phantom detections
    if (detArea > 0.50) continue;  // > 50% of image is implausible as a new opening
    // Gate 5: must be a structurally meaningful type
    if (det.type !== "window" && det.type !== "door" && det.type !== "walkthrough" && det.type !== "closet_door") continue;
    structuralSignals.push({
      claim: "opening_added",
      region: { x1: ax1, y1: ay1, x2: ax2, y2: ay2 },
      confidence: det.confidence,
      source: "openingPreservation",
      openingId: det.id,
      openingType: det.type,
      wallIndex: det.wallIndex,
    });
  }

  for (const wallIndex of [0, 1, 2, 3] as WallIndex[]) {
    const baselineSeq = buildWallSequenceContext(baseline.openings, baseline.anchorFixtures, wallIndex);
    const detectedSeq = buildWallSequenceContext(detected.openings, detected.anchorFixtures, wallIndex);

    if (baselineSeq.openingTokens.length === 0) continue;

    const openingSubsequenceOk = isTokenSubsequence(baselineSeq.openingTokens, detectedSeq.openingTokens);
    const openingCountDropped = detectedSeq.openingTokens.length < baselineSeq.openingTokens.length;
    const orderedSignatureMismatch = !openingSubsequenceOk || openingCountDropped;
    if (!orderedSignatureMismatch) continue;

    const anchorReferenced = hasStableAnchorReference(baseline.anchorFixtures, detected.anchorFixtures, wallIndex);
    const wallOutOfFrameCount = outOfFrameOpenings.filter((openingId) => {
      const opening = baseline.openings.find((candidate) => candidate.id === openingId);
      return opening?.wallIndex === wallIndex;
    }).length;

    if (openingCountDropped && wallOutOfFrameCount > 0 && !anchorReferenced) {
      analysisNotes.push(
        `Wall ${wallIndex} opening count dropped but edge-of-frame uncertainty applies (out_of_frame=${wallOutOfFrameCount}); treating as preserved.`
      );
      console.log(
        `[OPENING_SIGNATURE_OUT_OF_FRAME] wall=${wallIndex} opening_drop=true out_of_frame=${wallOutOfFrameCount} anchor_reference=false`
      );
      continue;
    }

    // Region-edit mode is more tolerant to sequence-order noise when no stable anchor exists.
    // Sequence-order drift remains advisory unless the opening is independently detected as removed/infilled.
    if (isEditMode && !anchorReferenced && !openingCountDropped) {
      analysisNotes.push(
        `Wall ${wallIndex} opening signature advisory (L->R). BEFORE openings=${baselineSeq.openingTokens.join("->") || "none"}; AFTER openings=${detectedSeq.openingTokens.join("->") || "none"}; anchor_reference=absent.`
      );
      console.log(
        `[OPENING_SIGNATURE_ADVISORY] wall=${wallIndex} before=${baselineSeq.allTokens.join("->") || "none"} after=${detectedSeq.allTokens.join("->") || "none"} anchor_reference=false`
      );
      continue;
    }

    analysisNotes.push(
      `Wall ${wallIndex} opening signature advisory (L->R). BEFORE openings=${baselineSeq.openingTokens.join("->") || "none"}; AFTER openings=${detectedSeq.openingTokens.join("->") || "none"}; anchor_reference=${anchorReferenced ? "present" : "absent"}.`
    );

    console.log(
      `[OPENING_SIGNATURE_ADVISORY] wall=${wallIndex} before=${baselineSeq.allTokens.join("->") || "none"} after=${detectedSeq.allTokens.join("->") || "none"} anchor_reference=${anchorReferenced}`
    );
  }

  const summary = {
    openingRemoved,
    openingInfilled,
    openingSealed: openingRemoved || openingInfilled,
    openingRelocated,
    openingResized,
    openingClassMismatch,
    openingClassMismatchEnforcement: "advisory" as const,
    openingBandMismatch,
    openingStateChanged,
    openingApertureExpanded,
    openingSignatureMismatch: analysisNotes.some((note) => note.includes("opening signature advisory (L->R)")),
    stagingOcclusionAdvisory,
    frameBoundaryTruncationAdvisory,
    semanticAnchorErosionAdvisory,
    outOfFrameOpenings,
    openingCount: {
      before: baseline.openings.length,
      after: detected.openings.length,
    },
    analysis: analysisNotes.join(" "),
    semanticOpeningAreaDeltaPct: maxAreaDelta,
    semanticOpeningAspectRatioDelta: maxAspectDelta,
    windowSillDeltaPct: maxWindowSillShift,
    confidence: openingResults.length
      ? Number((openingResults.reduce((sum, row) => sum + row.confidence, 0) / openingResults.length).toFixed(3))
      : 1,
  };

  return {
    results: openingResults,
    findings,
    structuralSignals,
    reconciledMatches: reconciliation.debug,
    summary,
    detectedOpenings: detected.openings,
  };
}

export function shouldHardFailOpening(
  summary: OpeningValidationSummary,
  opts?: {
    relocationDetected?: boolean;
    invariantStructuralDriftDetected?: boolean;
  }
): boolean {
  if (summary.openingRemoved) return true;
  if (summary.openingInfilled) return true;
  if (summary.openingSealed) return true;
  if (summary.openingRelocated && (opts?.relocationDetected === true || opts?.invariantStructuralDriftDetected === true)) return true;
  if (summary.openingApertureExpanded === true && opts?.invariantStructuralDriftDetected === true) return true;
  return false;
}

export function detectRelocation(
  baseline: StructuralBaseline,
  enhancedDetected: StructuralOpening[]
): boolean {
  for (const base of baseline.openings) {
    const sameClassMatches = enhancedDetected.filter(
      (opening) => getCanonicalOpeningIdentityType(opening.type) === getCanonicalOpeningIdentityType(base.type)
    );

    if (!sameClassMatches.length) continue;

    const exactWallMatch = sameClassMatches.find(
      (opening) => opening.wallIndex === base.wallIndex
    );

    if (!exactWallMatch) {
      return true;
    }
  }

  return false;
}
