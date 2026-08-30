import sharp from "sharp";
import type { BaseArtifacts } from "./baseArtifacts";
import { StructuralMask } from "./structuralMask";

export type Stage1BValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
  meta?: {
    compliance?: string[];
    /**
     * H3 (RealEnhance audit): always true — see this function's doc
     * comment. Present so a caller or log reader can tell, from the result
     * object itself, that no per-class structural comparison occurred.
     */
    unimplemented?: boolean;
    [key: string]: any;
  };
};

/**
 * H3 (RealEnhance audit): this function's per-class structural comparison
 * (walls/windows/doors/floor) was never actually implemented. It depended
 * entirely on semanticSegmenter.ts's segmentImageClasses (a stub that
 * always returns zero masks) and classComparisons.ts (every comparator
 * hardcoded `return {pass:true}`), so it could never register a finding
 * regardless of real image content — both are quarantined under
 * validators/_unimplemented/ now (see that folder's README). On top of
 * that, every return path in this function — including the one genuine,
 * non-stub check below (dimension comparison) — returned `ok:true`
 * unconditionally, so this validator could never hard-fail even in
 * principle. This function is called live from pipeline/stage1B.ts, so its
 * silent no-op gave the impression that Stage 1B structural validation was
 * running, when nothing was actually being checked.
 *
 * This is a status-explicit pass, not a behavior change: the dead
 * per-class call chain has been removed (rather than left calling stubs
 * that could only ever pass) and the one real check (dimension change) is
 * preserved exactly as before, still advisory-only (logged into
 * meta.compliance, does not affect `ok`). Do not read `ok:true` from this
 * function as evidence that structural integrity was verified.
 */
export async function validateStage1BStructural(
  canonicalBasePath: string,
  stage1BPath: string,
  masks: { structuralMask: StructuralMask },
  baseArtifacts?: BaseArtifacts
): Promise<Stage1BValidationResult> {
  const baseMeta = baseArtifacts?.path === canonicalBasePath
    ? { width: baseArtifacts.width, height: baseArtifacts.height }
    : await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage1BPath).metadata();
  const compliance: string[] = [];
  if (baseMeta.width !== outMeta.width || baseMeta.height !== outMeta.height) {
    compliance.push("dimension_change");
  }
  if (compliance.length > 0) {
    console.warn('[validateStage1BStructural] Compliance issues:', compliance);
    return { ok: true, meta: { compliance, unimplemented: true } };
  }
  return { ok: true, meta: { unimplemented: true } };
}
