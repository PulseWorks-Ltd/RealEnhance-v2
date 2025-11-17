import { StructuralValidationResult } from "./types";
import { normaliseDimensionsForValidation } from "./dimensionUtils";
import { validateWindows } from "./windowValidator";
import { validateWallStructure } from "./wallValidator";

export async function validateStage1AStructure(
  basePath: string,
  outPath: string,
  opts: { sceneType: "interior" | "exterior"; maskPath?: string }
): Promise<StructuralValidationResult> {
  // 1) Dimensions
  const dimRes = await normaliseDimensionsForValidation(basePath, outPath);
  if (dimRes.dimIssue === "dimension_change") {
    return {
      ok: false,
      issue: "dimension_change",
      message: "Image aspect ratio / dimensions changed in a way that suggests a crop or warp.",
      baseSize: dimRes.baseSize,
      outSize: dimRes.outSize,
    };
  }
  // 2) Windows
  const winResult = await validateWindows(dimRes.baseImgPath, dimRes.outImgPath);
  if (!winResult.ok) return winResult;
  // 3) Walls (interior only)
  if (opts.sceneType === "interior") {
    const wallResult = await validateWallStructure(dimRes.baseImgPath, dimRes.outImgPath);
    if (!wallResult.ok) return wallResult;
  }
  // For exteriors, landcover handled separately
  return { ok: true, issue: "none", baseSize: dimRes.baseSize, outSize: dimRes.outSize };
}