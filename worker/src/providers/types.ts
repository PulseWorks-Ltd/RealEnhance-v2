import type { RoomConsistencyContextV1 } from "../../../shared/src/types";
import type {
  CompiledMaskResult,
  ContinuityIntentMetadata,
  ContinuityRenderMode,
  MaskValidationResult,
  PlacementPlan,
} from "../continuity/types";

export type ImageReference = {
  kind: "local" | "gcs";
  mimeType: string;
  localPath?: string;
  uri?: string;
  sourceLabel: string;
  artifactName?: string;
};

export type ResolveImageSourceInput = {
  sourceLabel: string;
  localPath?: string;
  uri?: string | null;
  mimeType?: string;
  preferGcs?: boolean;
  artifactName?: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
};

export type SpatialPlannerRequest = {
  secondaryImage: ImageReference;
  masterImage: ImageReference;
  roomType: string;
  stagingStyle?: string;
  roomConsistency?: RoomConsistencyContextV1;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
};

export type SpatialPlannerResponse = {
  plan: PlacementPlan;
  prompt: string;
  rawText: string;
  model: string;
  latencyMs: number;
};

export type ImageRenderRequest = {
  sourceImage: ImageReference;
  maskImage: ImageReference;
  outputPath: string;
  prompt: string;
  attempt?: number;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
  guidanceScale?: number;
  workerIdentity?: string;
  debugMasks?: {
    occupancyMaskPath?: string | null;
    exclusionMaskPath?: string | null;
    finalMaskPath?: string | null;
    renderEditMaskPath?: string | null;
    continuityReasoningMaskPath?: string | null;
  };
};

export type ImageRenderResponse = {
  outputPath: string;
  model: string;
  latencyMs: number;
  mimeType: string;
  guidanceScale: number;
  payload: Record<string, unknown>;
};

export type ContinuityRepairRequest = {
  secondaryImage: ImageReference;
  masterImage: ImageReference;
  occupancyConstraintMask?: ImageReference | null;
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
  queueName?: string;
  workerIdentity?: string;
};

export type ContinuityRepairResponse = {
  outputPath: string;
  renderedImage: ImageReference;
  secondaryImage: ImageReference;
  masterImage: ImageReference;
  maskImage: ImageReference;
  masks: CompiledMaskResult;
  validation: MaskValidationResult;
  planner: SpatialPlannerResponse;
  render: ImageRenderResponse;
  artifactDir: string;
  renderMode: ContinuityRenderMode;
};

export interface SpatialPlannerProvider {
  plan(request: SpatialPlannerRequest): Promise<SpatialPlannerResponse>;
}

export interface ImageRendererProvider {
  render(request: ImageRenderRequest): Promise<ImageRenderResponse>;
}

export interface ContinuityRepairProvider {
  repair(request: ContinuityRepairRequest): Promise<ContinuityRepairResponse>;
}