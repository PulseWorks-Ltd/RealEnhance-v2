export type StructuralFailureType =
  | "CATASTROPHIC_ORIENTATION"
  | "STRUCTURAL_DISTORTION"
  | "OPENING_SUPPRESSION";

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
CRITICAL: Preserve the exact original camera position, lens angle, zoom level, and perspective.
Do NOT rotate, widen, compress, or reorient the room.
All vertical and horizontal architectural lines must align with the original image.
Match vanishing points and wall angles exactly.
`;

const WALL_LOCK_BLOCK = `
CRITICAL: Preserve all original wall planes exactly.
Do NOT extend, compress, or shift any walls.
Maintain identical window and door proportions.
Do not alter ceiling height or wall-to-floor relationships.
Architectural geometry must remain unchanged.
`;

const OPENING_VISIBILITY_BLOCK = `
CRITICAL: Do not obstruct, cover, or visually suppress any doors or windows.
All architectural openings must remain fully visible and functionally accessible.
Do not place furniture in front of doorways or recessed openings.
`;

const CONSTRAINT_RELAXATION_BLOCK = `
If furniture placement conflicts with preserving architectural integrity:
- Reduce furniture quantity if necessary.
- Remove non-essential decorative items.
- Relax strict symmetry requirements.
- Use fewer side tables if required.
- Prioritize architectural accuracy over styling completeness.
`;

export function buildStructuralRetryInjection(opts: {
  compositeFail: boolean;
  failureType: StructuralFailureType | null;
  attemptNumber: number;
}): { retryTier: 1 | 2; retryInjection: string } | null {
  if (opts.compositeFail !== true || opts.attemptNumber < 1) {
    return null;
  }

  const retryTier: 1 | 2 = opts.attemptNumber === 1 ? 1 : 2;
  const failureType = opts.failureType;

  let retryInjection = "";
  if (failureType === "CATASTROPHIC_ORIENTATION") retryInjection += CAMERA_LOCK_BLOCK;
  if (failureType === "STRUCTURAL_DISTORTION") retryInjection += WALL_LOCK_BLOCK;
  if (failureType === "OPENING_SUPPRESSION") retryInjection += OPENING_VISIBILITY_BLOCK;
  if (retryTier >= 2 && (failureType === "STRUCTURAL_DISTORTION" || failureType === "OPENING_SUPPRESSION")) {
    retryInjection += CONSTRAINT_RELAXATION_BLOCK;
  }

  return { retryTier, retryInjection };
}