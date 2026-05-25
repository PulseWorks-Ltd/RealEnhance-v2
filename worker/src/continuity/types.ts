import type { RoomConsistencyContextV1 } from "../../../shared/src/types";

export type ContinuityRenderMode =
  | "full_secondary_continuity"
  | "continuity_refresh"
  | "localized_repair"
  | "missing_object_insert";

export type ContinuityIntentMetadata = {
  userInstruction?: string;
  editMode?: string;
  promptScope?: string;
  operationLabel?: string;
  rendererIsolationMode?: string;
  layoutHints?: string[];
  anchorConstraints?: string[];
  roomAnchors?: string[];
  plannerVersion?: string;
  rendererVersion?: string;
};

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type SequentialContinuityRenderPlan = {
  status: "future_scoped";
  steps: Array<"render_object" | "lock_object_pixels" | "render_next_object">;
};

export type MaskBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ProtectedEdgeStats = {
  baseboardPixels: number;
  trimPixels: number;
  cornerPixels: number;
  edgeProtectedPixels: number;
  borderProtectedPixels: number;
};

export type PlacementPlan = {
  roomType: string;
  imageWidth: number;
  imageHeight: number;
  futureSequentialRenderPlan?: SequentialContinuityRenderPlan;
  structuralTopologyCage?: {
    vanishingPoints?: Array<{
      id?: string;
      x: number;
      y: number;
    }>;
    floorWallJunctions?: NormalizedPoint[];
    ceilingWallJunctions?: NormalizedPoint[];
    majorRoomPlanes?: Array<{
      id: string;
      planeType: string;
      polygon: NormalizedPoint[];
    }>;
  };
  relationalAnchorGraph?: {
    anchors: Array<{
      id: string;
      anchorType: string;
      label?: string;
      furnitureZoneId?: string;
      planeId?: string;
    }>;
    relationships: Array<{
      from: string;
      relation: string;
      to: string;
    }>;
  };
  furnitureZones: Array<{
    id: string;
    furnitureType: string;
    normalizedBoundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    anchorRelationships: {
      adjacentWall?: string;
      relativeToBed?: string;
      floorPlaneAlignment?: string;
    };
    orientation: {
      yawDegrees: number;
      perspectiveHint: string;
    };
    maskProjection: {
      floorPolygon: NormalizedPoint[];
      wallProjectionPolygon: NormalizedPoint[];
    };
    continuityReference: {
      derivedFromMaster: boolean;
      masterFurnitureId?: string;
    };
  }>;
};

export type SpatialPlannerInput = {
  secondaryImagePath: string;
  masterImagePath: string;
  roomType: string;
  stagingStyle?: string;
  roomConsistency?: RoomConsistencyContextV1;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
};

export type SpatialPlannerResult = {
  plan: PlacementPlan;
  prompt: string;
  rawText: string;
  model: string;
  latencyMs: number;
};

export type CompiledMaskResult = {
  occupancyMaskBuffer: Buffer;
  occupancyMaskPath: string;
  exclusionMaskBuffer: Buffer;
  exclusionMaskPath: string;
  finalMaskBuffer: Buffer;
  finalMaskPath: string;
  width: number;
  height: number;
  zoneCount: number;
  totalPixelCount: number;
  occupancyPixelCount: number;
  exclusionPixelCount: number;
  finalPixelCount: number;
  overlapPixelCount: number;
  occupancyAreaRatio: number;
  exclusionAreaRatio: number;
  finalAreaRatio: number;
  overlapReductionRatio: number;
  insertionBounds: MaskBoundingBox | null;
  protectedEdgeStats: ProtectedEdgeStats;
};

export type MaskValidationResult = {
  width: number;
  height: number;
  totalPixelCount: number;
  occupancyPixelCount: number;
  exclusionPixelCount: number;
  finalPixelCount: number;
  overlapPixelCount: number;
  occupancyAreaRatio: number;
  exclusionAreaRatio: number;
  finalAreaRatio: number;
  overlapReductionRatio: number;
  occupancyStrippedRatio: number;
  insertionBounds: MaskBoundingBox;
  binaryIntegrity: {
    occupancy: boolean;
    exclusion: boolean;
    final: boolean;
  };
  guidanceCorrelation: {
    validatorFlow: string;
    validatorPassRate: null;
    insertionRealismOutcome: null;
    edgeHarshnessReport: null;
    continuityQualityOutcome: null;
    localContrastAnalysis: "pending_instrumentation";
    edgeRealismEvaluation: "pending_instrumentation";
  };
};

export type ImagenRenderInput = {
  secondaryImagePath: string;
  maskPath: string;
  outputPath: string;
  prompt: string;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
};

export type ImagenRenderResult = {
  outputPath: string;
  model: string;
  latencyMs: number;
  mimeType: string;
  guidanceScale: number;
  payload: Record<string, unknown>;
};

export type ContinuityArtifactManifest = {
  sourceLabel: string;
  uri: string;
  mimeType: string;
  artifactName: string;
};

export type ExperimentalSecondaryContinuityInput = {
  secondaryImagePath: string;
  secondaryImageUri?: string | null;
  masterImagePath: string;
  masterImageUri?: string | null;
  outputPath: string;
  roomType: string;
  stagingStyle?: string;
  roomConsistency?: RoomConsistencyContextV1;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
  attempt: number;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
  occupancyConstraintMaskPath?: string;
  queueName?: string;
  workerIdentity?: string;
};

export type VertexExperimentalContinuityJobPayload = {
  type: "vertex-continuity-experimental";
  requestedAt: string;
  secondaryImage: ContinuityArtifactManifest;
  masterImage: ContinuityArtifactManifest;
  occupancyConstraintMask?: ContinuityArtifactManifest | null;
  roomType: string;
  stagingStyle?: string;
  roomConsistency?: RoomConsistencyContextV1;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
  attempt: number;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
  queueName?: string;
  workerIdentity?: string;
};

export class VertexSecondaryContinuityError extends Error {
  readonly fallbackReason: string;
  readonly code: string;

  constructor(message: string, fallbackReason: string, code = fallbackReason) {
    super(message);
    this.name = "VertexSecondaryContinuityError";
    this.fallbackReason = fallbackReason;
    this.code = code;
  }
}