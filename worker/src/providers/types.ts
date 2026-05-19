import type { RoomConsistencyContextV1 } from "../../../shared/src/types";
import type { CompiledMaskResult, MaskValidationResult, PlacementPlan } from "../continuity/types";

export type ImageReference = {
  kind: "local" | "gcs";
  mimeType: string;
  localPath?: string;
  uri?: string;
  sourceLabel: string;
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
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
};

export type ImageRenderResponse = {
  outputPath: string;
  model: string;
  latencyMs: number;
  mimeType: string;
  payload: Record<string, unknown>;
};

export type ContinuityRepairRequest = {
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
};

export type ContinuityRepairResponse = {
  outputPath: string;
  secondaryImage: ImageReference;
  masterImage: ImageReference;
  maskImage: ImageReference;
  masks: CompiledMaskResult;
  validation: MaskValidationResult;
  planner: SpatialPlannerResponse;
  render: ImageRenderResponse;
  artifactDir: string;
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