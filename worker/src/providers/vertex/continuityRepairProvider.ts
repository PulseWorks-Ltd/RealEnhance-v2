import { siblingOutPath } from "../../utils/images";
import { logImageAttemptUrl } from "../../utils/debugImageUrls";
import { nLog } from "../../logger";
import { persistContinuityArtifacts } from "../../continuity/artifactStore";
import { persistMaskEvolutionArtifacts } from "../../continuity/debug/gcsDebugArtifacts";
import { buildDeterministicPlanConstraintMask, compileDeterministicMask } from "../../continuity/maskCompiler";
import { validateCompiledMask } from "../../continuity/maskValidation";
import { ensureLocalImagePath, persistMaskArtifact, persistRemoteImage } from "../imageTransport";
import type { ImageReference } from "../types";
import type { ContinuityRepairProvider, ContinuityRepairRequest, ContinuityRepairResponse } from "../types";
import { VertexImageRendererProvider, buildImagenInsertionPrompt } from "./imageRendererProvider";
import { VertexSpatialPlannerProvider } from "./spatialPlannerProvider";

function withHydratedLocalPath(reference: ImageReference, localPath: string): ImageReference {
  return {
    ...reference,
    localPath,
  };
}

function asLocalRenderReference(reference: ImageReference, localPath: string): ImageReference {
  return {
    ...reference,
    kind: "local",
    localPath,
    uri: undefined,
  };
}

function summarizeImageReference(reference: ImageReference | null | undefined): Record<string, unknown> {
  return {
    kind: reference?.kind || null,
    sourceLabel: reference?.sourceLabel || null,
    uri: reference?.uri || null,
    localPath: reference?.localPath || null,
    mimeType: reference?.mimeType || null,
    artifactName: reference?.artifactName || null,
  };
}

function summarizeRenderPayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  const instances = Array.isArray(payload.instances) ? payload.instances : [];
  const firstInstance = (instances[0] as Record<string, any> | undefined) || undefined;
  const parameters = (payload.parameters as Record<string, any> | undefined) || undefined;
  const referenceImages = Array.isArray(firstInstance?.referenceImages)
    ? firstInstance.referenceImages
    : [];

  return {
    instanceCount: instances.length,
    hasPrompt: typeof firstInstance?.prompt === "string" && firstInstance.prompt.length > 0,
    referenceImageCount: referenceImages.length,
    sourceImageKeys: firstInstance?.image ? Object.keys(firstInstance.image) : [],
    maskImageKeys: firstInstance?.mask?.image ? Object.keys(firstInstance.mask.image) : [],
    referenceImageKeys: referenceImages.map((entry: Record<string, any>) => ({
      referenceImageKeys: entry?.referenceImage ? Object.keys(entry.referenceImage) : [],
      maskImageConfigKeys: entry?.maskImageConfig ? Object.keys(entry.maskImageConfig) : [],
      legacyImageKeys: entry?.image ? Object.keys(entry.image) : [],
      legacyRawReferenceImageKeys: entry?.rawReferenceImage ? Object.keys(entry.rawReferenceImage) : [],
      legacyMaskReferenceImageKeys: entry?.maskReferenceImage ? Object.keys(entry.maskReferenceImage) : [],
      legacyConfigKeys: entry?.config ? Object.keys(entry.config) : [],
    })),
    editMode: parameters?.editMode ?? null,
    maskMode: parameters?.maskMode ?? null,
    numberOfImages: parameters?.numberOfImages ?? null,
    outputMimeType: parameters?.outputMimeType ?? parameters?.outputOptions?.mimeType ?? null,
  };
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }

  return {
    name: null,
    message: String(error),
    stack: null,
  };
}

export class VertexContinuityRepairProvider implements ContinuityRepairProvider {
  constructor(
    private readonly plannerProvider = new VertexSpatialPlannerProvider(),
    private readonly rendererProvider = new VertexImageRendererProvider(),
  ) {}

  async repair(request: ContinuityRepairRequest): Promise<ContinuityRepairResponse> {
    let executionStage = "hydrate-inputs";
    let plannerState: Record<string, unknown> | null = null;
    let renderPayloadSummary: Record<string, unknown> | null = null;
    let artifactSummary: Record<string, unknown> | null = null;

    try {
      const secondaryImage = request.secondaryImage;
      const masterImage = request.masterImage;
      const secondaryWorkingPath = await ensureLocalImagePath({
        reference: secondaryImage,
        sourceLabel: "secondary-continuity-source",
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      const hydratedSecondaryImage = withHydratedLocalPath(secondaryImage, secondaryWorkingPath);
      const masterWorkingPath = await ensureLocalImagePath({
        reference: masterImage,
        sourceLabel: "secondary-continuity-master",
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      const hydratedMasterImage = withHydratedLocalPath(masterImage, masterWorkingPath);
      const occupancyConstraintMaskPath = request.occupancyConstraintMask
        ? await ensureLocalImagePath({
            reference: request.occupancyConstraintMask,
            sourceLabel: "continuity-occupancy-mask",
            jobId: request.jobId,
            imageId: request.imageId,
            continuityGroupId: request.continuityGroupId,
          })
        : undefined;

      nLog("[CONTINUITY_INPUT_MANIFEST]", {
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        stage: "consumer-pre-mask",
        inputs: {
          baseImage: {
            resolvedInputType: secondaryImage.kind === "gcs" ? "REMOTE_GCS" : "LOCAL_TMP",
            localPath: secondaryWorkingPath,
            requestPath: secondaryImage.localPath || null,
            uri: secondaryImage.uri || null,
          },
          masterImage: {
            resolvedInputType: masterImage.kind === "gcs" ? "REMOTE_GCS" : "LOCAL_TMP",
            localPath: masterWorkingPath,
            requestPath: masterImage.localPath || null,
            uri: masterImage.uri || null,
          },
          occupancyConstraintMask: {
            resolvedInputType: request.occupancyConstraintMask?.kind === "gcs" ? "REMOTE_GCS" : request.occupancyConstraintMask?.localPath ? "LOCAL_TMP" : null,
            localPath: occupancyConstraintMaskPath || null,
            uri: request.occupancyConstraintMask?.uri || null,
          },
        },
      });

      nLog("[VERTEX_CONTINUITY_MASTER_INPUT]", {
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        masterImageUri: masterImage.uri || null,
        masterTransport: masterImage.kind,
        secondaryTransport: secondaryImage.kind,
      });

      nLog("[VERTEX_CONTINUITY_OCCUPANCY_MASK]", {
        phase: "branch",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        branch: occupancyConstraintMaskPath ? "constraint-mask-present" : "constraint-mask-absent",
        fallbackMode: occupancyConstraintMaskPath ? "intersect-compiled-occupancy" : "planner-occupancy-without-constraint-mask",
        requestedMask: summarizeImageReference(request.occupancyConstraintMask || null),
        hydratedLocalPath: occupancyConstraintMaskPath || null,
      });

      executionStage = "planner";
      const planner = await this.plannerProvider.plan({
        secondaryImage: hydratedSecondaryImage,
        masterImage: hydratedMasterImage,
        roomType: request.roomType,
        stagingStyle: request.stagingStyle,
        roomConsistency: request.roomConsistency,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
        renderMode: request.renderMode,
        intent: request.intent,
      });
      plannerState = {
        model: planner.model,
        latencyMs: planner.latencyMs,
        zoneCount: planner.plan.furnitureZones.length,
      };

      const occupancyMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-occupancy-mask", ".png");
      const exclusionMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-exclusion-mask", ".png");
      const finalMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-final-mask", ".png");
      let effectiveOccupancyConstraintMaskPath = occupancyConstraintMaskPath;
      if (!effectiveOccupancyConstraintMaskPath) {
        const derivedConstraintMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-occupancy-constraint-derived", ".png");
        const derivedConstraint = await buildDeterministicPlanConstraintMask({
          plan: planner.plan,
          secondaryImagePath: secondaryWorkingPath,
          outputPath: derivedConstraintMaskPath,
        });
        effectiveOccupancyConstraintMaskPath = derivedConstraint.path;
        nLog("[VERTEX_CONTINUITY_OCCUPANCY_MASK]", {
          phase: "derived-constraint-mask",
          continuityGroupId: request.continuityGroupId || null,
          imageId: request.imageId,
          jobId: request.jobId,
          renderMode: request.renderMode,
          source: "deterministic_plan_projection",
          occupancyConstraintMaskPath: derivedConstraint.path,
          occupancyConstraintPixelCount: derivedConstraint.pixelCount,
          width: derivedConstraint.width,
          height: derivedConstraint.height,
        });
      }
      executionStage = "mask-compilation";
      nLog("[VERTEX_CONTINUITY_MASK_COMPILATION]", {
        phase: "start",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        plannerModel: planner.model,
        zoneCount: planner.plan.furnitureZones.length,
        secondaryImagePath: secondaryWorkingPath,
        occupancyConstraintMaskPath: effectiveOccupancyConstraintMaskPath || null,
        occupancyMaskPath,
        exclusionMaskPath,
        finalMaskPath,
      });
      const compiledMask = await compileDeterministicMask({
        plan: planner.plan,
        secondaryImagePath: secondaryWorkingPath,
        masterImagePath: masterWorkingPath,
        occupancyMaskPath,
        exclusionMaskPath,
        finalMaskPath,
        occupancyConstraintMaskPath: effectiveOccupancyConstraintMaskPath,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
      });
      nLog("[VERTEX_CONTINUITY_MASK_COMPILATION]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        occupancyMaskPath: compiledMask.occupancyMaskPath,
        exclusionMaskPath: compiledMask.exclusionMaskPath,
        finalMaskPath: compiledMask.finalMaskPath,
        occupancyConstraintApplied: !!effectiveOccupancyConstraintMaskPath,
        finalPixelCount: compiledMask.finalPixelCount,
        occupancyPixelCount: compiledMask.occupancyPixelCount,
      });

      try {
        const maskEvolutionUpload = await persistMaskEvolutionArtifacts({
          jobId: request.jobId,
          imageId: request.imageId,
          continuityGroupId: request.continuityGroupId,
          attempt: request.attempt,
          width: compiledMask.width,
          height: compiledMask.height,
          rawGeminiMaskPath: compiledMask.geminiMaskArtifacts?.rawGeminiMaskPath || compiledMask.geminiMaskArtifacts?.rawMaskPath,
          alphaNormalizedMaskPath: compiledMask.geminiMaskArtifacts?.alphaNormalizedMaskPath,
          morphologyCleanedMaskPath: compiledMask.geminiMaskArtifacts?.morphologyCleanedMaskPath || compiledMask.geminiMaskArtifacts?.cleanedMaskPath,
          componentFilteredMaskPath: compiledMask.geminiMaskArtifacts?.componentFilteredMaskPath,
          floorContactVisualizationPath: compiledMask.geminiMaskArtifacts?.floorContactVisualizationPath,
          acceptedClusterMaskPath: compiledMask.geminiMaskArtifacts?.acceptedClusterMaskPath,
          occupancyConstraintMaskPath: effectiveOccupancyConstraintMaskPath,
          occupancyMaskPath: compiledMask.occupancyMaskPath,
          finalMaskPath: compiledMask.finalMaskPath,
        });
        nLog("[VERTEX_CONTINUITY_MASK_EVOLUTION_ARTIFACTS]", {
          continuityGroupId: request.continuityGroupId || null,
          imageId: request.imageId,
          jobId: request.jobId,
          renderMode: request.renderMode,
          gcsUri: maskEvolutionUpload.rootGcsUri,
          artifactCount: maskEvolutionUpload.artifacts.length,
          maskEvolutionStripPath: maskEvolutionUpload.maskEvolutionStripPath,
        });
      } catch (maskEvolutionError: any) {
        nLog("[VERTEX_CONTINUITY_MASK_EVOLUTION_ARTIFACTS_FAILURE]", {
          continuityGroupId: request.continuityGroupId || null,
          imageId: request.imageId,
          jobId: request.jobId,
          renderMode: request.renderMode,
          error: maskEvolutionError?.message || String(maskEvolutionError),
        });
      }

      await logImageAttemptUrl({
        ctx: {
          jobId: request.jobId,
          imageId: request.imageId,
          stage: "2",
          attempt: request.attempt,
        },
        localPath: compiledMask.finalMaskPath,
      });
      const validation = await validateCompiledMask({
        sourceImagePath: secondaryWorkingPath,
        compiledMask,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
      });
      const maskImage = await persistMaskArtifact({
        maskPath: compiledMask.finalMaskPath,
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      const renderSourceImage = asLocalRenderReference(secondaryImage, secondaryWorkingPath);
      const renderMaskImage = asLocalRenderReference(maskImage, compiledMask.finalMaskPath);

      const materialPalette = request.roomConsistency?.roomState?.furnitureMemory?.materialPalette || [];
      const lightingProfile = request.roomConsistency?.roomState?.lightingProfile;
      const lightingHint = lightingProfile
        ? `${lightingProfile.brightnessProfile || "balanced"} brightness, ${lightingProfile.warmthProfile || "neutral"} tone, ${lightingProfile.directionHint || "natural"} directional light`
        : "adapted natural lighting";
      const prompt = buildImagenInsertionPrompt({
        plan: planner.plan,
        stagingStyle: request.stagingStyle,
        materialPalette,
        lightingHint,
      });

      executionStage = "render-payload";
      nLog("[VERTEX_CONTINUITY_RENDER_PAYLOAD]", {
        phase: "start",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        promptLength: prompt.length,
        sourceImage: summarizeImageReference(renderSourceImage),
        maskImage: summarizeImageReference(renderMaskImage),
      });
      const render = await this.rendererProvider.render({
        sourceImage: renderSourceImage,
        maskImage: renderMaskImage,
        outputPath: request.outputPath,
        prompt,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
        renderMode: request.renderMode,
        intent: request.intent,
        attempt: request.attempt,
        workerIdentity: request.workerIdentity,
        debugMasks: {
          occupancyMaskPath: compiledMask.occupancyMaskPath,
          exclusionMaskPath: compiledMask.exclusionMaskPath,
          finalMaskPath: compiledMask.finalMaskPath,
        },
      });
      renderPayloadSummary = summarizeRenderPayload(render.payload);
      nLog("[VERTEX_CONTINUITY_RENDER_PAYLOAD]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        payloadSummary: renderPayloadSummary,
      });
      await logImageAttemptUrl({
        ctx: {
          jobId: request.jobId,
          imageId: request.imageId,
          stage: "2",
          attempt: request.attempt,
        },
        localPath: render.outputPath,
      });
      executionStage = "output-publication";
      nLog("[VERTEX_CONTINUITY_OUTPUT_PUBLICATION]", {
        phase: "start",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        renderOutputPath: render.outputPath,
        renderModel: render.model,
        rendererLatencyMs: render.latencyMs,
      });
      const renderedImage = await persistRemoteImage({
        sourceLabel: "continuity-render-output",
        localPath: render.outputPath,
        artifactName: `${request.imageId}-continuity-render-attempt-${request.attempt}.webp`,
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      artifactSummary = {
        renderOutputPath: render.outputPath,
        renderedImageUri: renderedImage.uri || null,
        finalMaskPath: compiledMask.finalMaskPath,
      };
      nLog("[VERTEX_CONTINUITY_OUTPUT_PUBLICATION]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        renderedImageUri: renderedImage.uri || null,
        artifactName: renderedImage.artifactName || null,
      });

      executionStage = "artifact-persistence";
      const persistedArtifacts = await persistContinuityArtifacts({
        continuityGroupId: request.continuityGroupId,
        imageId: request.imageId,
        jobId: request.jobId,
        attempt: request.attempt,
        sourceImagePath: secondaryWorkingPath,
        renderMode: request.renderMode,
        intent: request.intent,
        queueName: request.queueName,
        workerIdentity: request.workerIdentity,
        planner,
        masks: compiledMask,
        validation,
        render,
        renderedImageUri: renderedImage.uri || null,
      });

      nLog("[VERTEX_CONTINUITY_RESULT]", {
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        plannerLatencyMs: planner.latencyMs,
        rendererLatencyMs: render.latencyMs,
        plannerVersion: planner.model,
        rendererVersion: render.model,
        maskDimensions: `${compiledMask.width}x${compiledMask.height}`,
        occupancyPixelCount: compiledMask.occupancyPixelCount,
        exclusionPixelCount: compiledMask.exclusionPixelCount,
        finalPixelCount: compiledMask.finalPixelCount,
        occupancyAreaRatio: Number(compiledMask.occupancyAreaRatio.toFixed(4)),
        sourceTransport: secondaryImage.kind,
        masterTransport: masterImage.kind,
        maskTransport: maskImage.kind,
        artifactDir: persistedArtifacts.artifactDir,
        queueName: request.queueName || null,
        workerIdentity: request.workerIdentity || null,
        renderedImageUri: renderedImage.uri || null,
        result: "success",
      });

      return {
        outputPath: render.outputPath,
        renderedImage,
        secondaryImage,
        masterImage,
        maskImage,
        masks: compiledMask,
        validation,
        planner,
        render,
        artifactDir: persistedArtifacts.artifactDir,
        renderMode: request.renderMode,
      };
    } catch (error: any) {
      nLog("[VERTEX_CONTINUITY_FAILURE]", {
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        queueName: request.queueName || null,
        workerIdentity: request.workerIdentity || null,
        executionStage,
        error: error?.message || String(error),
        ...summarizeError(error),
        inputArtifacts: {
          secondaryImage: summarizeImageReference(request.secondaryImage),
          masterImage: summarizeImageReference(request.masterImage),
          occupancyConstraintMask: summarizeImageReference(request.occupancyConstraintMask || null),
        },
        plannerState,
        renderPayloadSummary,
        artifactSummary,
      });
      throw error;
    }
  }
}