import { siblingOutPath } from "../../utils/images";
import { logImageAttemptUrl } from "../../utils/debugImageUrls";
import { nLog } from "../../logger";
import { persistContinuityArtifacts } from "../../continuity/artifactStore";
import { compileDeterministicMask } from "../../continuity/maskCompiler";
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

export class VertexContinuityRepairProvider implements ContinuityRepairProvider {
  constructor(
    private readonly plannerProvider = new VertexSpatialPlannerProvider(),
    private readonly rendererProvider = new VertexImageRendererProvider(),
  ) {}

  async repair(request: ContinuityRepairRequest): Promise<ContinuityRepairResponse> {
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

      const occupancyMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-occupancy-mask", ".png");
      const exclusionMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-exclusion-mask", ".png");
      const finalMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-final-mask", ".png");
      const compiledMask = await compileDeterministicMask({
        plan: planner.plan,
        secondaryImagePath: secondaryWorkingPath,
        occupancyMaskPath,
        exclusionMaskPath,
        finalMaskPath,
        occupancyConstraintMaskPath,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
      });
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

      const render = await this.rendererProvider.render({
        sourceImage: secondaryImage,
        maskImage,
        outputPath: request.outputPath,
        prompt,
        continuityGroupId: request.continuityGroupId,
        jobId: request.jobId,
        imageId: request.imageId,
        renderMode: request.renderMode,
        intent: request.intent,
        workerIdentity: request.workerIdentity,
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
      const renderedImage = await persistRemoteImage({
        sourceLabel: "continuity-render-output",
        localPath: render.outputPath,
        artifactName: `${request.imageId}-continuity-render-attempt-${request.attempt}.webp`,
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });

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
        error: error?.message || String(error),
      });
      throw error;
    }
  }
}