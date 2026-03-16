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

If furniture placement is causing perspective warping, prioritize fewer, simpler items to maintain structural integrity.
`;

const STRUCTURAL_DISTORTION_BLOCK = `
CRITICAL STRUCTURAL FAILURE DETECTED:
The previous attempt introduced geometric drift or wall/plane distortion.
Treat the input architecture as immutable.
Do NOT reshape, extend, bend, or reinterpret wall/ceiling/floor geometry.
Maintain exact room proportions and depth.

If furniture placement is causing structural distortion, reduce furniture quantity and complexity.
Prioritize fewer, simpler items over dense styling.
`;

const OPENING_PRESERVATION_BLOCK = `
CRITICAL STRUCTURAL FAILURE DETECTED:
The previous attempt suppressed, relocated, infilled, or altered architectural openings.
All windows, doors, closet doors, and walkthrough openings are ABSOLUTELY LOCKED.
Do NOT block, seal, shrink, move, or replace any opening with decor, furniture, or wall-like surfaces.
All openings must remain visibly present and functionally usable.

CRITICAL ARCHITECTURAL REQUIREMENT:
Sliding glass doors, internal doorways/openings, windows, and wall arches are ARCHITECTURAL ANCHORS.
- You are FORBIDDEN from placing headboards, tall casegoods, artwork, mirrors, or decor that requires a solid wall where an opening exists.
- If placing a bed, the bed/headboard MUST be against an existing solid wall plane, never over a window/door/opening zone.
- Architectural anchors must remain clear, penetrative openings to the exterior/interior circulation path.
- If a placement conflicts with an opening anchor, remove or reposition the furniture item.

If furniture placement conflicts with opening visibility/function, remove or simplify furniture near openings.
`;

const GENERIC_STRUCTURAL_LOCK_BLOCK = `
CRITICAL STRUCTURAL FAILURE DETECTED:
The previous attempt violated structural constraints.
Architecture is immutable: preserve exact camera, geometry, openings, and built-ins.

If furniture placement causes any structural risk, use fewer, simpler movable items and keep clear circulation.
`;

export function buildStructuralRetryInjection(opts: {
  compositeFail: boolean;
  failureType: StructuralFailureType | null;
  attemptNumber: number;
}): { retryTier: 1 | 2; retryInjection: string } | null {
  if (opts.compositeFail !== true || opts.attemptNumber < 1) {
    return null;
  }

  const failureType = opts.failureType;
  const retryTier: 1 | 2 = opts.attemptNumber > 1 ? 2 : 1;

  if (failureType === "CATASTROPHIC_ORIENTATION") {
    return {
      retryTier,
      retryInjection: CAMERA_LOCK_BLOCK,
    };
  }

  if (failureType === "STRUCTURAL_DISTORTION") {
    return {
      retryTier,
      retryInjection: STRUCTURAL_DISTORTION_BLOCK,
    };
  }

  if (failureType === "STRUCTURAL_INVARIANT") {
    return {
      retryTier,
      retryInjection: `${STRUCTURAL_DISTORTION_BLOCK}\n${OPENING_PRESERVATION_BLOCK}`,
    };
  }

  if (
    failureType === "OPENING_SUPPRESSION" ||
    failureType === "opening_removed" ||
    failureType === "opening_relocated" ||
    failureType === "opening_infilled"
  ) {
    return {
      retryTier,
      retryInjection: OPENING_PRESERVATION_BLOCK,
    };
  }

  return {
    retryTier,
    retryInjection: GENERIC_STRUCTURAL_LOCK_BLOCK,
  };
}