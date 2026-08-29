// QUARANTINED (H3, RealEnhance audit) — see README.md in this directory.
// Had zero callers anywhere in the codebase even before this move. Every
// return path also hardcoded {ok:true} regardless of findings, so even if
// it had been wired up it could never have failed anything.
import { StructuralValidationResult } from "../types";
import { normaliseDimensionsForValidation } from "../dimensionUtils";
import { validateWindows } from "../windowValidator";
import { validateWallStructure } from "./wallValidator";

export async function validateStage1AStructure(
  basePath: string,
  outPath: string,
  opts: { sceneType: "interior" | "exterior"; maskPath?: string }
): Promise<StructuralValidationResult> {
  // 1) Dimensions
  const dimRes = await normaliseDimensionsForValidation(basePath, outPath);
  const compliance: string[] = [];
  if (dimRes.dimIssue === "dimension_change") {
    compliance.push("dimension_change");
  }
  // 2) Windows
  const winResult = await validateWindows(dimRes.baseImgPath, dimRes.outImgPath);
  if (!winResult.ok) compliance.push(winResult.reason || "window_error");
  // 3) Walls (interior only)
  if (opts.sceneType === "interior") {
    const wallResult = await validateWallStructure(dimRes.baseImgPath, dimRes.outImgPath);
    if (!wallResult.ok) compliance.push(wallResult.reason || "wall_error");
  }
  // For exteriors, landcover handled separately
  if (compliance.length > 0) {
    console.warn('[validateStage1AStructure] Compliance issues:', compliance);
    return { ok: true, meta: { compliance } };
  }
  return { ok: true };
}
