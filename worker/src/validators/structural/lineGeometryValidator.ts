import { validateLineStructure } from "../lineEdgeValidator";
import { StageId, ValidationTrigger } from "../stageAwareConfig";

export interface LineGeometryCheckResult {
  triggers: ValidationTrigger[];
  metrics: {
    lineScore?: number;
    edgeLoss?: number;
  };
}

export async function runLineGeometryCheck(opts: {
  baselinePath: string;
  candidatePath: string;
  stage: StageId;
  threshold: number;
}): Promise<LineGeometryCheckResult> {
  const { baselinePath, candidatePath, stage, threshold } = opts;
  const triggers: ValidationTrigger[] = [];
  const metrics: LineGeometryCheckResult["metrics"] = {};

  try {
    const result = await validateLineStructure({
      originalPath: baselinePath,
      enhancedPath: candidatePath,
      sensitivity: threshold,
    });

    metrics.lineScore = result.score;
    metrics.edgeLoss = result.edgeLoss;

    if (!result.passed && result.score !== undefined) {
      triggers.push({
        id: "line_geometry_score",
        message: `Line geometry score too low: ${result.score.toFixed(3)} < ${threshold}`,
        value: result.score,
        threshold,
        stage,
      });
    }
  } catch (err) {
    console.warn(`[lineGeometryValidator] Error during line geometry check (non-fatal):`, err);
  }

  return { triggers, metrics };
}
