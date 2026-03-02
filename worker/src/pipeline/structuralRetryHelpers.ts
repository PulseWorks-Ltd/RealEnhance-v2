export type StructuralFailureType =
  | "CATASTROPHIC_ORIENTATION"
  | "STRUCTURAL_DISTORTION"
  | "OPENING_SUPPRESSION"
  | "STRUCTURAL_INVARIANT"
  | "opening_removed"
  | "opening_relocated"
  | "opening_infilled"
  | "other";

type CompositeDecisionLike = {
  failed: boolean;
  reason: string;
};

export function classifyStructuralFailure(
  compositeDecision: CompositeDecisionLike | null | undefined
): StructuralFailureType | null {
  if (!compositeDecision?.failed) return null;

  if (compositeDecision.reason === "catastrophic_override_structDeg_gt_85") {
    return "CATASTROPHIC_ORIENTATION";
  }

  if (compositeDecision.reason === "composite_structural_distortion") {
    return "STRUCTURAL_DISTORTION";
  }

  if (compositeDecision.reason === "functional_opening_suppression") {
    return "OPENING_SUPPRESSION";
  }

  return null;
}

const CAMERA_LOCK_BLOCK = `
CRITICAL STRUCTURAL FAILURE DETECTED:
The previous attempt altered camera orientation or perspective.
Camera position, rotation, and framing are ABSOLUTELY LOCKED.
Do NOT rotate, tilt, shift, zoom, or reframe.
Perspective must remain identical to input.
`;

export function buildStructuralRetryInjection(opts: {
  compositeFail: boolean;
  failureType: StructuralFailureType | null;
  attemptNumber: number;
}): { retryTier: 1 | 2; retryInjection: string } | null {
  if (opts.compositeFail !== true || opts.attemptNumber < 1) {
    return null;
  }

  if (opts.failureType !== "CATASTROPHIC_ORIENTATION") {
    return null;
  }

  if (opts.attemptNumber > 1) {
    return null;
  }

  return {
    retryTier: 1,
    retryInjection: CAMERA_LOCK_BLOCK,
  };
}