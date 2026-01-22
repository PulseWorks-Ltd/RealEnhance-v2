import { runMaskedEdgeValidator } from "../maskedEdgeValidator";
import { StageId, ValidationTrigger } from "../stageAwareConfig";

export interface OpeningsIntegrityResult {
  triggers: ValidationTrigger[];
  metrics: {
    openingsCreated?: number;
    openingsClosed?: number;
    maskedEdgeDrift?: number;
  };
}

export async function runOpeningsIntegrityCheck(opts: {
  baselinePath: string;
  candidatePath: string;
  stage: StageId;
  scene: "interior" | "exterior";
  thresholds: {
    createMax: number;
    closeMax: number;
    maskedDriftMax: number;
    openingsMinDelta?: number;
  };
  fatalOnOpeningsDelta: boolean;
}): Promise<OpeningsIntegrityResult> {
  const { baselinePath, candidatePath, thresholds, stage, scene, fatalOnOpeningsDelta } = opts;
  const triggers: ValidationTrigger[] = [];
  const metrics: OpeningsIntegrityResult["metrics"] = {};

  try {
    const result = await runMaskedEdgeValidator({
      originalImagePath: baselinePath,
      enhancedImagePath: candidatePath,
      scene,
      stage,
      mode: "log",
    });

    metrics.openingsCreated = result.createdOpenings;
    metrics.openingsClosed = result.closedOpenings;
    metrics.maskedEdgeDrift = result.maskedEdgeDrift;

    const totalDelta = Math.abs(result.createdOpenings) + Math.abs(result.closedOpenings);
    const openingsMinDelta = thresholds.openingsMinDelta ?? 1;

    if (result.createdOpenings > thresholds.createMax && totalDelta >= openingsMinDelta) {
      triggers.push({
        id: "openings_created_maskededge",
        message: `Openings created: ${result.createdOpenings} > ${thresholds.createMax}`,
        value: result.createdOpenings,
        threshold: thresholds.createMax,
        stage,
        fatal: fatalOnOpeningsDelta,
        nonBlocking: !fatalOnOpeningsDelta,
      });
    }

    if (result.closedOpenings > thresholds.closeMax && totalDelta >= openingsMinDelta) {
      triggers.push({
        id: "openings_closed_maskededge",
        message: `Openings closed: ${result.closedOpenings} > ${thresholds.closeMax}`,
        value: result.closedOpenings,
        threshold: thresholds.closeMax,
        stage,
        fatal: fatalOnOpeningsDelta,
        nonBlocking: !fatalOnOpeningsDelta,
      });
    }

    if (result.maskedEdgeDrift > thresholds.maskedDriftMax && totalDelta >= openingsMinDelta) {
      triggers.push({
        id: "masked_edge_drift",
        message: `Masked edge drift too high: ${result.maskedEdgeDrift.toFixed(3)} > ${thresholds.maskedDriftMax}`,
        value: result.maskedEdgeDrift,
        threshold: thresholds.maskedDriftMax,
        stage,
      });
    }
  } catch (err) {
    console.warn(`[openingsIntegrity] Error during openings integrity check (non-fatal):`, err);
  }

  return { triggers, metrics };
}
