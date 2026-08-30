// QUARANTINED (H3, RealEnhance audit) — see README.md in this directory.
// Had zero callers anywhere in the codebase even before this move.
import { StructuralValidationResult } from "../types";

export async function validateExteriorLandcover(basePath: string, outPath: string): Promise<StructuralValidationResult> {
  // TODO: Implement real landcover comparison
  // For now, always pass
  return { ok: true, reason: "none" };
}
