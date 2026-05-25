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

async function writeMaskOverlayOnImage(params: {
  imagePath: string;
  maskBuffer: Buffer;
  width: number;
  height: number;
  outputPath: string;
}): Promise<void> {
  const rgba = Buffer.alloc(params.width * params.height * 4, 0);
  for (let index = 0; index < params.width * params.height; index += 1) {
    const offset = index * 4;
    if (params.maskBuffer[index] > 0) {
      rgba[offset] = 72;
      rgba[offset + 1] = 210;
      rgba[offset + 2] = 118;
      rgba[offset + 3] = 112;
    } else {
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 0;
    }
  }

  await sharp(params.imagePath)
    .composite([
      {
        input: rgba,
        raw: { width: params.width, height: params.height, channels: 4 },
        blend: "over",
      },
    ])
    .png()
    .toFile(params.outputPath);
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
  const renderedOccupancyOverlayPath = path.join(artifactDir, "rendered-occupancy-overlay.png");
  const geminiRawMaskTarget = path.join(artifactDir, "gemini-occupancy-mask-raw.png");
  const geminiCleanedMaskTarget = path.join(artifactDir, "gemini-occupancy-mask-cleaned.png");
  const occupancyComponentsTarget = path.join(artifactDir, "occupancy-mask-components.png");
  const occupancyQualityTarget = path.join(artifactDir, "occupancy-quality-report.json");
  const occupancyRetryComparisonTarget = path.join(artifactDir, "occupancy-retry-comparison.json");
  const anchorDistanceHeatmapTarget = path.join(artifactDir, "anchor-distance-heatmap.png");
  const floorContactVisualizationTarget = path.join(artifactDir, "floor-contact-visualization.png");
  const acceptedRejectedOverlayTarget = path.join(artifactDir, "accepted-vs-rejected-components.png");
  const perClusterMaskDir = path.join(artifactDir, "cluster-occupancy-masks");

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
      occupancyGenerationMode: params.masks.occupancyGenerationMode,
      geminiMaskArtifacts: params.masks.geminiMaskArtifacts || null,
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
  await copyIfPresent(params.masks.geminiMaskArtifacts?.rawMaskPath, geminiRawMaskTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.cleanedMaskPath, geminiCleanedMaskTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.componentsPath, occupancyComponentsTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.qualityReportPath, occupancyQualityTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.retryComparisonPath, occupancyRetryComparisonTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.anchorDistanceHeatmapPath, anchorDistanceHeatmapTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.floorContactVisualizationPath, floorContactVisualizationTarget);
  await copyIfPresent(params.masks.geminiMaskArtifacts?.acceptedRejectedOverlayPath, acceptedRejectedOverlayTarget);

  if (params.masks.geminiMaskArtifacts?.perClusterMaskPaths?.length) {
    await fs.mkdir(perClusterMaskDir, { recursive: true });
    for (const sourceMaskPath of params.masks.geminiMaskArtifacts.perClusterMaskPaths) {
      const targetMaskPath = path.join(perClusterMaskDir, path.basename(sourceMaskPath));
      await copyIfPresent(sourceMaskPath, targetMaskPath);
    }
  }

  await writeMaskOverlayOnImage({
    imagePath: outputTarget,
    maskBuffer: await sharp(params.masks.occupancyMaskBuffer).raw().toBuffer(),
    width: params.masks.width,
    height: params.masks.height,
    outputPath: renderedOccupancyOverlayPath,
  });

  const debugArtifacts = await generateContinuityDebugArtifacts({
    sourceImagePath: params.sourceImagePath,
    artifactDir,
    masks: params.masks,
    plan: params.planner.plan,
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
    debugArtifacts.topologyOverlayPath,
    debugArtifacts.zoneManifestPath,
    renderedOccupancyOverlayPath,
    ...(params.masks.geminiMaskArtifacts
      ? [
        geminiRawMaskTarget,
        geminiCleanedMaskTarget,
        occupancyComponentsTarget,
        occupancyQualityTarget,
        occupancyRetryComparisonTarget,
        anchorDistanceHeatmapTarget,
        floorContactVisualizationTarget,
        acceptedRejectedOverlayTarget,
      ]
      : []),
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