import { siblingOutPath } from "../../utils/images";
import { logImageAttemptUrl } from "../../utils/debugImageUrls";
import { nLog } from "../../logger";
import { persistContinuityArtifacts } from "../../continuity/artifactStore";
import { compileDeterministicMask } from "../../continuity/maskCompiler";
import { validateCompiledMask } from "../../continuity/maskValidation";
import { loadImageReference, persistMaskArtifact } from "../imageTransport";
import type { ContinuityRepairProvider, ContinuityRepairRequest, ContinuityRepairResponse } from "../types";
import { VertexImageRendererProvider, buildImagenInsertionPrompt } from "./imageRendererProvider";
import { VertexSpatialPlannerProvider } from "./spatialPlannerProvider";

export class VertexContinuityRepairProvider implements ContinuityRepairProvider {
  constructor(
    private readonly plannerProvider = new VertexSpatialPlannerProvider(),
    private readonly rendererProvider = new VertexImageRendererProvider(),
  ) {}

  async repair(request: ContinuityRepairRequest): Promise<ContinuityRepairResponse> {
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

    const planner = await this.plannerProvider.plan({
      secondaryImage,
      masterImage,
      roomType: request.roomType,
      stagingStyle: request.stagingStyle,
      roomConsistency: request.roomConsistency,
      continuityGroupId: request.continuityGroupId,
      jobId: request.jobId,
      imageId: request.imageId,
    });

    const occupancyMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-occupancy-mask", ".png");
    const exclusionMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-exclusion-mask", ".png");
    const finalMaskPath = siblingOutPath(request.outputPath, "-vertex-continuity-final-mask", ".png");
    const compiledMask = await compileDeterministicMask({
      plan: planner.plan,
      secondaryImagePath: request.secondaryImagePath,
      occupancyMaskPath,
      exclusionMaskPath,
      finalMaskPath,
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
      sourceImagePath: request.secondaryImagePath,
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
      sourceImagePath: request.secondaryImagePath,
      planner,
      masks: compiledMask,
      validation,
      render,
    });

    nLog("[VERTEX_CONTINUITY_RESULT]", {
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      plannerLatencyMs: planner.latencyMs,
      rendererLatencyMs: render.latencyMs,
      maskDimensions: `${compiledMask.width}x${compiledMask.height}`,
      occupancyPixelCount: compiledMask.occupancyPixelCount,
      exclusionPixelCount: compiledMask.exclusionPixelCount,
      finalPixelCount: compiledMask.finalPixelCount,
      validatorFlow: "existing_stage2_pipeline",
      sourceTransport: secondaryImage.kind,
      masterTransport: masterImage.kind,
      maskTransport: maskImage.kind,
      artifactDir: persistedArtifacts.artifactDir,
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
    };
  }
}