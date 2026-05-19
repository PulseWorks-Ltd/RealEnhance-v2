import { nLog } from "../logger";
import type { ExperimentalSecondaryContinuityInput } from "./types";
import { VertexSecondaryContinuityError } from "./types";
import { createContinuityRepairProvider } from "../providers";

export async function runExperimentalSecondaryContinuity(params: ExperimentalSecondaryContinuityInput): Promise<string> {
  try {
    const provider = createContinuityRepairProvider();
    const repairResult = await provider.repair({
      secondaryImagePath: params.secondaryImagePath,
      secondaryImageUri: params.secondaryImageUri,
      masterImagePath: params.masterImagePath,
      masterImageUri: params.masterImageUri,
      outputPath: params.outputPath,
      roomType: params.roomType,
      stagingStyle: params.stagingStyle,
      roomConsistency: params.roomConsistency,
      continuityGroupId: params.continuityGroupId,
      jobId: params.jobId,
      imageId: params.imageId,
      attempt: params.attempt,
    });

    nLog("[VERTEX_CONTINUITY_VALIDATION]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      validatorFlow: "existing_stage2_pipeline",
      delegated: true,
    });
    return repairResult.outputPath;
  } catch (error: any) {
    const fallbackReason = error instanceof VertexSecondaryContinuityError
      ? error.fallbackReason
      : "vertex_secondary_continuity_error";
    nLog("[VERTEX_CONTINUITY_RESULT]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      result: "fallback",
      fallbackReason,
      error: String(error?.message || error),
    });
    if (error instanceof VertexSecondaryContinuityError) {
      throw error;
    }
    throw new VertexSecondaryContinuityError(
      String(error?.message || error || "vertex secondary continuity failed"),
      fallbackReason
    );
  }
}