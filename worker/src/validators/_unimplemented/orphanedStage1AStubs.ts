// QUARANTINED (H3, RealEnhance audit) — see README.md in this directory.
// Extracted from stage1AValidator.ts. Had zero callers anywhere in the
// codebase even before this move.
import { StructuralMask } from "../structuralMask";

export async function computeStructuralChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real mask diff logic using mask object
  return 0.01; // always pass for now
}

export async function computeWindowIoU(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real window IoU logic using mask object
  return 0.99; // always pass for now
}

export async function computeLandcoverChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real landcover diff logic using mask object
  return 0.0; // always pass for now
}
