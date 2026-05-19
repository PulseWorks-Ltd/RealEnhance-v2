import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { nLog } from "../logger";
import { generateContinuityDebugArtifacts } from "./debug/visualizations";
import type {
  CompiledMaskResult,
  ContinuityIntentMetadata,
  ContinuityRenderMode,
  MaskValidationResult,
  PlacementPlan,
} from "./types";

function safeSegment(value: string | null | undefined, fallback: string): string {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || fallback;
}

export function getContinuityArtifactDir(params: {
  continuityGroupId?: string | null;
  imageId: string;
  attempt: number;
}): string {
  return path.join(
    "/workspaces/RealEnhance-v2/worker/artifacts/continuity",
    safeSegment(params.continuityGroupId, "ungrouped"),
    safeSegment(params.imageId, "unknown-image"),
    `attempt-${Math.max(1, params.attempt)}`,
  );
}

async function copyIfPresent(sourcePath: string | undefined, targetPath: string): Promise<void> {
  if (!sourcePath) {
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
}

export async function persistContinuityArtifacts(params: {
  continuityGroupId?: string | null;
  imageId: string;
  jobId: string;
  attempt: number;
  sourceImagePath: string;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
  queueName?: string;
  workerIdentity?: string;
  planner: {
    plan: PlacementPlan;
    prompt: string;
    rawText: string;
    model: string;
    latencyMs: number;
  };
  masks: CompiledMaskResult;
  validation: MaskValidationResult;
  render: {
    outputPath: string;
    model: string;
    latencyMs: number;
    mimeType: string;
    payload: Record<string, unknown>;
  };
  renderedImageUri?: string | null;
}): Promise<{ artifactDir: string; artifactPaths: string[] }> {
  const artifactDir = getContinuityArtifactDir({
    continuityGroupId: params.continuityGroupId,
    imageId: params.imageId,
    attempt: params.attempt,
  });
  await fs.mkdir(artifactDir, { recursive: true });

  const plannerJsonPath = path.join(artifactDir, "planner.json");
  const plannerRawPath = path.join(artifactDir, "planner-raw.txt");
  const validatorOutputPath = path.join(artifactDir, "validator-output.json");
  const imagenPayloadPath = path.join(artifactDir, "imagen-request.json");
  const metadataPath = path.join(artifactDir, "continuity-request.json");
  const occupancyMaskTarget = path.join(artifactDir, "occupancy-mask.png");
  const exclusionMaskTarget = path.join(artifactDir, "exclusion-mask.png");
  const finalMaskTarget = path.join(artifactDir, "final-mask.png");
  const outputTarget = path.join(artifactDir, "imagen-output.png");

  await fs.writeFile(plannerJsonPath, JSON.stringify(params.planner.plan, null, 2));
  await fs.writeFile(plannerRawPath, params.planner.rawText || "");
  await fs.writeFile(imagenPayloadPath, JSON.stringify(params.render.payload, null, 2));
  await fs.writeFile(
    metadataPath,
    JSON.stringify({
      renderMode: params.renderMode,
      intent: params.intent || null,
      queueName: params.queueName || null,
      workerIdentity: params.workerIdentity || null,
      sourceImagePath: params.sourceImagePath,
      renderedImageUri: params.renderedImageUri || null,
      plannerModel: params.planner.model,
      rendererModel: params.render.model,
    }, null, 2)
  );
  await fs.writeFile(
    validatorOutputPath,
    JSON.stringify({
      maskValidation: params.validation,
      insertionQualityTelemetry: {
        validatorFlow: "existing_stage2_pipeline",
        edgeHarshnessMetrics: "pending_instrumentation",
        localContrastAnalysis: "pending_instrumentation",
        edgeRealismEvaluation: "pending_instrumentation",
      },
    }, null, 2)
  );

  await copyIfPresent(params.masks.occupancyMaskPath, occupancyMaskTarget);
  await copyIfPresent(params.masks.exclusionMaskPath, exclusionMaskTarget);
  await copyIfPresent(params.masks.finalMaskPath, finalMaskTarget);
  await sharp(params.render.outputPath).png().toFile(outputTarget);

  const debugArtifacts = await generateContinuityDebugArtifacts({
    sourceImagePath: params.sourceImagePath,
    artifactDir,
    masks: params.masks,
  });

  const artifactPaths = [
    metadataPath,
    plannerJsonPath,
    plannerRawPath,
    imagenPayloadPath,
    validatorOutputPath,
    occupancyMaskTarget,
    exclusionMaskTarget,
    finalMaskTarget,
    debugArtifacts.occupancyOverlayPath,
    debugArtifacts.exclusionOverlayPath,
    debugArtifacts.finalMaskOverlayPath,
    debugArtifacts.renderBoundaryPreviewPath,
    debugArtifacts.insertionRegionPreviewPath,
    outputTarget,
  ];

  nLog("[CONTINUITY_ARTIFACT_PERSIST]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    artifactDir,
    artifactPaths,
  });

  return { artifactDir, artifactPaths };
}