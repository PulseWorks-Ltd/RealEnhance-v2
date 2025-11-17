import { StructuralValidationResult } from "./types";

export async function validateWallStructure(basePath: string, outPath: string): Promise<StructuralValidationResult> {
  // TODO: Implement real wall line detection and comparison
  // For now, always pass
  return { ok: true, reason: "none" };
}
