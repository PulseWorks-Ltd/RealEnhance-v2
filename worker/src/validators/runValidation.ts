import { VALIDATION_PROFILES, ValidationResult, StageId, SceneType } from "./config";
import { runGlobalEdgeMetrics } from "./globalStructuralValidator";
import { computeStructuralEdgeMask } from "./structuralMask";
import { validateStage2 } from "./stage2StructuralValidator";
import { runLandcoverCheck } from "./landcoverValidator";
import { validateWindows } from "./windowValidator";
import { checkSizeMatch } from "./sizeValidator";
import { computeBrightnessDiff } from "./brightnessValidator";

export async function validateStageOutput(
  stage: StageId,
  sceneType: SceneType,
  basePath: string,
  candidatePath: string
): Promise<ValidationResult> {
  const profile = VALIDATION_PROFILES.find(p => p.stage === stage && (p.sceneType === sceneType || p.sceneType === "any"));
  if (!profile) {
    return { ok: true, stage, sceneType, reason: "ok", message: "No validation profile configured; treating as pass" };
  }
  try {
    if (profile.enforceSizeMatch) {
      const sizeOk = await checkSizeMatch(basePath, candidatePath);
      if (!sizeOk) {
        return { ok: false, stage, sceneType, reason: "size_mismatch", message: "Image dimensions do not match base." };
      }
    }

    let globalEdgeIoU: number | undefined;
    let structuralIoU: number | undefined;

    if (profile.minGlobalEdgeIoU !== undefined) {
      const m = await runGlobalEdgeMetrics(basePath, candidatePath);
      globalEdgeIoU = m.edgeIoU;
      if (globalEdgeIoU < profile.minGlobalEdgeIoU) {
        return { ok: false, stage, sceneType, globalEdgeIoU, reason: "structural_geometry", message: `Global edge IoU too low (${globalEdgeIoU.toFixed(3)}).` };
      }
    }

    if (profile.minStructuralIoU !== undefined) {
      // Build structural mask from base and compute masked IoU
      const mask = await computeStructuralEdgeMask(basePath);
      const m = await validateStage2(basePath, candidatePath, mask);
      structuralIoU = m.structuralIoU;
      if (structuralIoU !== undefined && profile.minStructuralIoU !== undefined && structuralIoU < profile.minStructuralIoU) {
        return { ok: false, stage, sceneType, structuralIoU, reason: "structural_geometry", message: `Structural IoU too low (${structuralIoU.toFixed(3)}).` };
      }
    }

    let brightnessDiff: number | undefined;
    if (profile.maxBrightnessDiff !== undefined) {
      brightnessDiff = await computeBrightnessDiff(basePath, candidatePath);
      if (Math.abs(brightnessDiff) > profile.maxBrightnessDiff) {
        return { ok: false, stage, sceneType, brightnessDiff, reason: "brightness_out_of_range", message: `Brightness change too large (${brightnessDiff.toFixed(3)}).` };
      }
    }

    if (profile.enforceLandcover && sceneType === "exterior") {
      const landOk = await runLandcoverCheck(basePath, candidatePath);
      if (!landOk) {
        return { ok: false, stage, sceneType, reason: "landcover", message: "Landcover changed (e.g., grass vs driveway)." };
      }
    }

    if (profile.enforceWindowIoU) {
      const winRes = await validateWindows(basePath, candidatePath);
      if (!winRes.ok) {
        return { ok: false, stage, sceneType, reason: winRes.issue, message: winRes.message };
      }
    }

    return { ok: true, stage, sceneType, structuralIoU, globalEdgeIoU, brightnessDiff, reason: "ok" };
  } catch (err: any) {
    return { ok: false, stage, sceneType, reason: "validator_error", message: err?.message || String(err) };
  }
}
