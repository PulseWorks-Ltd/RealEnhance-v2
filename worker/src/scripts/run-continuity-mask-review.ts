import fs from "fs/promises";
import path from "path";
import { bootstrapGoogleCredentialsFromEnv } from "../bootstrap/googleCredentials";
import { generateContinuityDebugArtifacts } from "../continuity/debug/visualizations";
import { compileDeterministicMask } from "../continuity/maskCompiler";
import { validateCompiledMask } from "../continuity/maskValidation";
import type { PlacementPlan } from "../continuity/types";
import type { ImageReference } from "../providers/types";
import { ensureLocalImagePath } from "../providers/imageTransport";
import { VertexSpatialPlannerProvider } from "../providers/vertex/spatialPlannerProvider";

type CliArgs = {
  secondaryUri: string;
  masterUri: string;
  roomType?: string;
  stagingStyle?: string;
  jobId: string;
  imageId: string;
  continuityGroupId: string;
  outputDir: string;
  plannerJsonPath?: string;
  replayManifestPath?: string;
};

type PlannerExecutionResult = {
  plan: PlacementPlan;
  prompt: string;
  rawText: string;
  model: string;
  latencyMs: number;
  replayMode: "live" | "saved_planner_json" | "saved_review_manifest";
  replaySourcePath: string | null;
};

function readFlag(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function requireFlag(name: string): string {
  const value = readFlag(name);
  if (!value) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return value;
}

function inferMimeTypeFromUri(uri: string): string {
  const normalized = uri.toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function parseArgs(): CliArgs {
  const plannerJsonPath = readFlag("planner-json");
  const replayManifestPath = readFlag("replay-manifest");
  const requestedRoomType = readFlag("room-type");
  if (!requestedRoomType && !plannerJsonPath && !replayManifestPath) {
    throw new Error("Missing required flag: --room-type (required unless --planner-json or --replay-manifest is provided)");
  }

  const imageId = readFlag("image-id") || `mask-review-${Date.now()}`;
  const continuityGroupId = readFlag("continuity-group-id") || `manual-review-${imageId}`;
  const outputDir = readFlag("output-dir")
    || path.join("/workspaces/RealEnhance-v2/worker/artifacts/manual-mask-review", imageId);

  return {
    secondaryUri: requireFlag("secondary-uri"),
    masterUri: requireFlag("master-uri"),
    roomType: requestedRoomType,
    stagingStyle: readFlag("staging-style"),
    jobId: readFlag("job-id") || `manual-mask-review-${Date.now()}`,
    imageId,
    continuityGroupId,
    outputDir,
    plannerJsonPath,
    replayManifestPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlacementPlan(value: unknown): value is PlacementPlan {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.roomType !== "string") {
    return false;
  }
  if (!Array.isArray(value.furnitureZones)) {
    return false;
  }
  return true;
}

async function loadPlacementPlanFromPath(filePath: string): Promise<PlacementPlan> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isPlacementPlan(parsed)) {
    throw new Error(`Planner replay payload at ${filePath} is not a valid PlacementPlan JSON`);
  }
  return parsed;
}

async function resolvePlannerReplay(args: CliArgs): Promise<{ plan: PlacementPlan; replayMode: PlannerExecutionResult["replayMode"]; replaySourcePath: string }> {
  if (args.plannerJsonPath) {
    const replayPath = path.resolve(args.plannerJsonPath);
    return {
      plan: await loadPlacementPlanFromPath(replayPath),
      replayMode: "saved_planner_json",
      replaySourcePath: replayPath,
    };
  }

  if (args.replayManifestPath) {
    const manifestPath = path.resolve(args.replayManifestPath);
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifestParsed: unknown = JSON.parse(manifestRaw);
    if (!isRecord(manifestParsed)) {
      throw new Error(`Replay manifest at ${manifestPath} is not a valid object`);
    }
    const outputDir = typeof manifestParsed.outputDir === "string"
      ? manifestParsed.outputDir
      : path.dirname(manifestPath);
    const plannerPath = path.join(outputDir, "planner.json");
    return {
      plan: await loadPlacementPlanFromPath(plannerPath),
      replayMode: "saved_review_manifest",
      replaySourcePath: plannerPath,
    };
  }

  throw new Error("Planner replay resolution requested without replay inputs");
}

async function getPlannerExecutionResult(params: {
  args: CliArgs;
  secondaryReference: ImageReference;
  masterReference: ImageReference;
  secondaryLocalPath: string;
  masterLocalPath: string;
}): Promise<PlannerExecutionResult> {
  const replayRequested = !!params.args.plannerJsonPath || !!params.args.replayManifestPath;
  if (replayRequested) {
    const replay = await resolvePlannerReplay(params.args);
    return {
      plan: replay.plan,
      prompt: `REPLAY_MODE=${replay.replayMode}`,
      rawText: JSON.stringify(replay.plan, null, 2),
      model: "planner_replay",
      latencyMs: 0,
      replayMode: replay.replayMode,
      replaySourcePath: replay.replaySourcePath,
    };
  }

  if (!params.args.roomType) {
    throw new Error("Live planner mode requires --room-type");
  }

  const plannerProvider = new VertexSpatialPlannerProvider();
  const planResult = await plannerProvider.plan({
    secondaryImage: { ...params.secondaryReference, localPath: params.secondaryLocalPath },
    masterImage: { ...params.masterReference, localPath: params.masterLocalPath },
    roomType: params.args.roomType,
    stagingStyle: params.args.stagingStyle,
    continuityGroupId: params.args.continuityGroupId,
    jobId: params.args.jobId,
    imageId: params.args.imageId,
    renderMode: "full_secondary_continuity",
  });

  return {
    ...planResult,
    replayMode: "live",
    replaySourcePath: null,
  };
}

function parseQuotedValue(fileText: string, key: string): string | undefined {
  const keyIndex = fileText.indexOf(`${key}=`);
  if (keyIndex < 0) {
    return undefined;
  }
  const valueStart = keyIndex + key.length + 1;
  const firstChar = fileText[valueStart];
  if (firstChar !== '"') {
    const lineEnd = fileText.indexOf("\n", valueStart);
    const rawValue = fileText.slice(valueStart, lineEnd >= 0 ? lineEnd : undefined).trim();
    return rawValue || undefined;
  }

  let value = "";
  let cursor = valueStart + 1;
  let escaped = false;
  while (cursor < fileText.length) {
    const char = fileText[cursor];
    if (char === '"' && !escaped) {
      break;
    }
    value += char;
    if (char === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
    cursor += 1;
  }
  return decodeQuotedEnvValue(value);
}

function decodeQuotedEnvValue(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current !== "\\") {
      decoded += current;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      decoded += current;
      continue;
    }

    if (next === "n") {
      decoded += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      decoded += "\r";
      index += 1;
      continue;
    }
    if (next === "t") {
      decoded += "\t";
      index += 1;
      continue;
    }
    if (next === '"' || next === "\\") {
      decoded += next;
      index += 1;
      continue;
    }

    decoded += next;
    index += 1;
  }
  return decoded;
}

async function loadContinuityEnvFromFile(envPath: string): Promise<void> {
  const fileText = await fs.readFile(envPath, "utf8");
  const requiredKeys = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_GCS_BUCKET",
    "SECONDARY_CONTINUITY_PLANNER",
  ];

  for (const key of requiredKeys) {
    if (String(process.env[key] || "").trim()) {
      continue;
    }
    const value = parseQuotedValue(fileText, key);
    if (value) {
      process.env[key] = value;
    }
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs();
  await loadContinuityEnvFromFile("/workspaces/RealEnhance-v2/server/.env");
  await bootstrapGoogleCredentialsFromEnv();

  await fs.mkdir(args.outputDir, { recursive: true });

  const secondaryReference: ImageReference = {
    kind: "gcs",
    uri: args.secondaryUri,
    mimeType: inferMimeTypeFromUri(args.secondaryUri),
    sourceLabel: "secondary-continuity-source",
    artifactName: path.basename(args.secondaryUri),
  };
  const masterReference: ImageReference = {
    kind: "gcs",
    uri: args.masterUri,
    mimeType: inferMimeTypeFromUri(args.masterUri),
    sourceLabel: "secondary-continuity-master",
    artifactName: path.basename(args.masterUri),
  };

  const secondaryLocalPath = await ensureLocalImagePath({
    reference: secondaryReference,
    sourceLabel: secondaryReference.sourceLabel,
    jobId: args.jobId,
    imageId: args.imageId,
    continuityGroupId: args.continuityGroupId,
  });
  const masterLocalPath = await ensureLocalImagePath({
    reference: masterReference,
    sourceLabel: masterReference.sourceLabel,
    jobId: args.jobId,
    imageId: args.imageId,
    continuityGroupId: args.continuityGroupId,
  });

  const planResult = await getPlannerExecutionResult({
    args,
    secondaryReference,
    masterReference,
    secondaryLocalPath,
    masterLocalPath,
  });

  const occupancyMaskPath = path.join(args.outputDir, "occupancy-mask.png");
  const exclusionMaskPath = path.join(args.outputDir, "exclusion-mask.png");
  const finalMaskPath = path.join(args.outputDir, "final-mask.png");

  const compiledMask = await compileDeterministicMask({
    plan: planResult.plan,
    secondaryImagePath: secondaryLocalPath,
    masterImagePath: masterLocalPath,
    occupancyMaskPath,
    exclusionMaskPath,
    finalMaskPath,
    continuityGroupId: args.continuityGroupId,
    jobId: args.jobId,
    imageId: args.imageId,
  });

  const validation = await validateCompiledMask({
    sourceImagePath: secondaryLocalPath,
    compiledMask,
    continuityGroupId: args.continuityGroupId,
    jobId: args.jobId,
    imageId: args.imageId,
  });

  const debugArtifacts = await generateContinuityDebugArtifacts({
    sourceImagePath: secondaryLocalPath,
    artifactDir: args.outputDir,
    masks: compiledMask,
    plan: planResult.plan,
  });

  await writeJson(path.join(args.outputDir, "planner.json"), planResult.plan);
  await fs.writeFile(path.join(args.outputDir, "planner-prompt.txt"), planResult.prompt);
  await fs.writeFile(path.join(args.outputDir, "planner-raw.txt"), planResult.rawText || "");
  await writeJson(path.join(args.outputDir, "validation.json"), validation);
  await writeJson(path.join(args.outputDir, "review-manifest.json"), {
    jobId: args.jobId,
    imageId: args.imageId,
    continuityGroupId: args.continuityGroupId,
    roomType: args.roomType || planResult.plan.roomType,
    stagingStyle: args.stagingStyle || null,
    plannerReplay: {
      mode: planResult.replayMode,
      sourcePath: planResult.replaySourcePath,
    },
    secondaryUri: args.secondaryUri,
    masterUri: args.masterUri,
    secondaryLocalPath,
    masterLocalPath,
    outputDir: args.outputDir,
    artifacts: {
      occupancyGenerationMode: compiledMask.occupancyGenerationMode,
      occupancyMaskPath,
      exclusionMaskPath,
      finalMaskPath,
      geminiRawMaskPath: compiledMask.geminiMaskArtifacts?.rawMaskPath || null,
      geminiCleanedMaskPath: compiledMask.geminiMaskArtifacts?.cleanedMaskPath || null,
      geminiRawGeminiMaskPath: compiledMask.geminiMaskArtifacts?.rawGeminiMaskPath || null,
      geminiThresholdedMaskPath: compiledMask.geminiMaskArtifacts?.thresholdedMaskPath || null,
      geminiAlphaNormalizedMaskPath: compiledMask.geminiMaskArtifacts?.alphaNormalizedMaskPath || null,
      geminiMorphologyCleanedMaskPath: compiledMask.geminiMaskArtifacts?.morphologyCleanedMaskPath || null,
      geminiComponentFilteredMaskPath: compiledMask.geminiMaskArtifacts?.componentFilteredMaskPath || null,
      geminiAcceptedClusterMaskPath: compiledMask.geminiMaskArtifacts?.acceptedClusterMaskPath || null,
      geminiFinalUnionMaskPath: compiledMask.geminiMaskArtifacts?.finalUnionMaskPath || null,
      geminiThresholdComparisonPath: compiledMask.geminiMaskArtifacts?.thresholdComparisonPath || null,
      geminiAlphaHeatmapPath: compiledMask.geminiMaskArtifacts?.alphaHeatmapPath || null,
      geminiAlphaHistogramPath: compiledMask.geminiMaskArtifacts?.alphaHistogramPath || null,
      geminiOccupancyMetricDebugPath: compiledMask.geminiMaskArtifacts?.occupancyMetricDebugPath || null,
      geminiOccupancyCollapseAnalysisPath: compiledMask.geminiMaskArtifacts?.occupancyCollapseAnalysisPath || null,
      geminiOccupancyStageGridPath: compiledMask.geminiMaskArtifacts?.occupancyStageGridPath || null,
      geminiComponentAnalysisPath: compiledMask.geminiMaskArtifacts?.componentAnalysisPath || null,
      geminiComponentRetainedPath: compiledMask.geminiMaskArtifacts?.componentRetainedPath || null,
      geminiComponentRemovedPath: compiledMask.geminiMaskArtifacts?.componentRemovedPath || null,
      geminiStageComparisonPath: compiledMask.geminiMaskArtifacts?.stageComparisonPath || null,
      occupancyComponentsPath: compiledMask.geminiMaskArtifacts?.componentsPath || null,
      occupancyQualityReportPath: compiledMask.geminiMaskArtifacts?.qualityReportPath || null,
      occupancyRetryComparisonPath: compiledMask.geminiMaskArtifacts?.retryComparisonPath || null,
      anchorDistanceHeatmapPath: compiledMask.geminiMaskArtifacts?.anchorDistanceHeatmapPath || null,
      floorContactVisualizationPath: compiledMask.geminiMaskArtifacts?.floorContactVisualizationPath || null,
      acceptedRejectedOverlayPath: compiledMask.geminiMaskArtifacts?.acceptedRejectedOverlayPath || null,
      perClusterMaskPaths: compiledMask.geminiMaskArtifacts?.perClusterMaskPaths || [],
      occupancyOverlayPath: debugArtifacts.occupancyOverlayPath,
      exclusionOverlayPath: debugArtifacts.exclusionOverlayPath,
      finalMaskOverlayPath: debugArtifacts.finalMaskOverlayPath,
      topologyOverlayPath: debugArtifacts.topologyOverlayPath,
      renderBoundaryPreviewPath: debugArtifacts.renderBoundaryPreviewPath,
      insertionRegionPreviewPath: debugArtifacts.insertionRegionPreviewPath,
      zoneArtifactDir: debugArtifacts.zoneArtifactDir,
      zoneManifestPath: debugArtifacts.zoneManifestPath,
    },
    summary: {
      zoneCount: planResult.plan.furnitureZones.length,
      plannerMode: planResult.replayMode,
      plannerReplaySourcePath: planResult.replaySourcePath,
      occupancyGenerationMode: compiledMask.occupancyGenerationMode,
      geminiMaskModel: compiledMask.geminiMaskArtifacts?.model || null,
      geminiQualityScore: compiledMask.geminiMaskArtifacts?.qualityScore || null,
      geminiRetryCount: compiledMask.geminiMaskArtifacts?.retryCount || null,
      geminiUsedConservativeFallback: compiledMask.geminiMaskArtifacts?.usedConservativeFallback || false,
      geminiClusterCount: compiledMask.geminiMaskArtifacts?.clusterCount || null,
      geminiRequiredClusterCount: compiledMask.geminiMaskArtifacts?.requiredClusterCount || null,
      geminiOptionalClusterCount: compiledMask.geminiMaskArtifacts?.optionalClusterCount || null,
      geminiClusterApiCallCount: compiledMask.geminiMaskArtifacts?.clusterApiCallCount || null,
      geminiEstimatedCallReductionRatio: compiledMask.geminiMaskArtifacts?.estimatedCallReductionRatio || null,
      occupancyPixelCount: compiledMask.occupancyPixelCount,
      finalPixelCount: compiledMask.finalPixelCount,
      occupancyAreaRatio: compiledMask.occupancyAreaRatio,
      finalAreaRatio: compiledMask.finalAreaRatio,
      insertionBounds: compiledMask.insertionBounds,
    },
  });

  console.log(JSON.stringify({
    outputDir: args.outputDir,
    plannerMode: planResult.replayMode,
    plannerReplaySourcePath: planResult.replaySourcePath,
    occupancyGenerationMode: compiledMask.occupancyGenerationMode,
    finalMaskOverlayPath: debugArtifacts.finalMaskOverlayPath,
    occupancyOverlayPath: debugArtifacts.occupancyOverlayPath,
    topologyOverlayPath: debugArtifacts.topologyOverlayPath,
    zoneManifestPath: debugArtifacts.zoneManifestPath,
    geminiRawMaskPath: compiledMask.geminiMaskArtifacts?.rawMaskPath || null,
    geminiCleanedMaskPath: compiledMask.geminiMaskArtifacts?.cleanedMaskPath || null,
    geminiRawGeminiMaskPath: compiledMask.geminiMaskArtifacts?.rawGeminiMaskPath || null,
    geminiThresholdedMaskPath: compiledMask.geminiMaskArtifacts?.thresholdedMaskPath || null,
    geminiAlphaNormalizedMaskPath: compiledMask.geminiMaskArtifacts?.alphaNormalizedMaskPath || null,
    geminiMorphologyCleanedMaskPath: compiledMask.geminiMaskArtifacts?.morphologyCleanedMaskPath || null,
    geminiComponentFilteredMaskPath: compiledMask.geminiMaskArtifacts?.componentFilteredMaskPath || null,
    geminiAcceptedClusterMaskPath: compiledMask.geminiMaskArtifacts?.acceptedClusterMaskPath || null,
    geminiFinalUnionMaskPath: compiledMask.geminiMaskArtifacts?.finalUnionMaskPath || null,
    geminiThresholdComparisonPath: compiledMask.geminiMaskArtifacts?.thresholdComparisonPath || null,
    geminiAlphaHeatmapPath: compiledMask.geminiMaskArtifacts?.alphaHeatmapPath || null,
    geminiAlphaHistogramPath: compiledMask.geminiMaskArtifacts?.alphaHistogramPath || null,
    geminiOccupancyMetricDebugPath: compiledMask.geminiMaskArtifacts?.occupancyMetricDebugPath || null,
    geminiOccupancyCollapseAnalysisPath: compiledMask.geminiMaskArtifacts?.occupancyCollapseAnalysisPath || null,
    geminiOccupancyStageGridPath: compiledMask.geminiMaskArtifacts?.occupancyStageGridPath || null,
    geminiComponentAnalysisPath: compiledMask.geminiMaskArtifacts?.componentAnalysisPath || null,
    geminiComponentRetainedPath: compiledMask.geminiMaskArtifacts?.componentRetainedPath || null,
    geminiComponentRemovedPath: compiledMask.geminiMaskArtifacts?.componentRemovedPath || null,
    geminiStageComparisonPath: compiledMask.geminiMaskArtifacts?.stageComparisonPath || null,
    occupancyComponentsPath: compiledMask.geminiMaskArtifacts?.componentsPath || null,
    occupancyQualityReportPath: compiledMask.geminiMaskArtifacts?.qualityReportPath || null,
    occupancyRetryComparisonPath: compiledMask.geminiMaskArtifacts?.retryComparisonPath || null,
    anchorDistanceHeatmapPath: compiledMask.geminiMaskArtifacts?.anchorDistanceHeatmapPath || null,
    floorContactVisualizationPath: compiledMask.geminiMaskArtifacts?.floorContactVisualizationPath || null,
    acceptedRejectedOverlayPath: compiledMask.geminiMaskArtifacts?.acceptedRejectedOverlayPath || null,
    perClusterMaskPaths: compiledMask.geminiMaskArtifacts?.perClusterMaskPaths || [],
    plannerJsonPath: path.join(args.outputDir, "planner.json"),
    validationJsonPath: path.join(args.outputDir, "validation.json"),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});