// QUARANTINED (H3, RealEnhance audit) — see README.md in this directory.
// Was only ever reachable when LOCAL_VALIDATOR_TIER=full, which is not
// this project's active setting. Do not import this into a live validator
// path; runValidation.ts's LOCAL_VALIDATOR_TIER=full branch now returns an
// explicit "not implemented" result instead of calling this.
import { StructuralValidationResult } from "../types";

export async function validateWallStructure(basePath: string, outPath: string): Promise<StructuralValidationResult> {
  // TODO: Implement real wall line detection and comparison
  // For now, always pass
  return { ok: true, reason: "none" };
}
