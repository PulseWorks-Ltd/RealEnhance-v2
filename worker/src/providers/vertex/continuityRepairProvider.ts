import { siblingOutPath } from "../../utils/images";
import { logImageAttemptUrl } from "../../utils/debugImageUrls";
import { nLog } from "../../logger";
import { persistContinuityArtifacts } from "../../continuity/artifactStore";
import { compileDeterministicMask } from "../../continuity/maskCompiler";
import { validateCompiledMask } from "../../continuity/maskValidation";
import { ensureLocalImagePath, loadImageReference, persistMaskArtifact } from "../imageTransport";
import type { ContinuityRepairProvider, ContinuityRepairRequest, ContinuityRepairResponse } from "../types";
import { VertexImageRendererProvider, buildImagenInsertionPrompt } from "./imageRendererProvider";
import { VertexSpatialPlannerProvider } from "./spatialPlannerProvider";

export class VertexContinuityRepairProvider implements ContinuityRepairProvider {
  constructor(
    private readonly plannerProvider = new VertexSpatialPlannerProvider(),
    private readonly rendererProvider = new VertexImageRendererProvider(),
  ) {}

  async repair(request: ContinuityRepairRequest): Promise<ContinuityRepairResponse> {
    try {
      const secondaryImage = await loadImageReference({
        sourceLabel: "secondary-continuity-source",
        localPath: request.secondaryImagePath,
        uri: request.secondaryImageUri,
        preferGcs: true,
        artifactName: `${request.imageId}-secondary-source${request.attempt}.webp`,
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      const masterImage = await loadImageReference({
        sourceLabel: "secondary-continuity-master",
        localPath: request.masterImagePath,
        uri: request.masterImageUri,
        preferGcs: true,
        artifactName: `${request.imageId}-approved-master${request.attempt}.webp`,
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });
      const secondaryWorkingPath = await ensureLocalImagePath({
        reference: secondaryImage,
        sourceLabel: "secondary-continuity-source",
        jobId: request.jobId,
        imageId: request.imageId,
        continuityGroupId: request.continuityGroupId,
      });

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
            requestPath: request.secondaryImagePath,
            uri: secondaryImage.uri || request.secondaryImageUri || null,
          },
          masterImage: {
            resolvedInputType: masterImage.kind === "gcs" ? "REMOTE_GCS" : "LOCAL_TMP",
            localPath: masterImage.localPath || null,
            requestPath: request.masterImagePath,
            uri: masterImage.uri || request.masterImageUri || null,
          },
          occupancyConstraintMask: {
            resolvedInputType: request.occupancyConstraintMaskPath ? "LOCAL_TMP" : null,
            localPath: request.occupancyConstraintMaskPath || null,
          },
        },
      });

      nLog("[VERTEX_CONTINUITY_MASTER_INPUT]", {
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        masterImageUri: request.masterImageUri || null,
        masterTransport: masterImage.kind,
        secondaryTransport: secondaryImage.kind,
      });

      const planner = await this.plannerProvider.plan({
        secondaryImage,
        masterImage,
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
        occupancyConstraintMaskPath: request.occupancyConstraintMaskPath,
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
        result: "success",
      });

      return {
        outputPath: render.outputPath,
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