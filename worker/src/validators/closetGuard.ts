import type { Opening } from "../vision/detectOpenings";

export type ClosetGuardResult = {
  verdict: "pass" | "retry";
  reason?: "potential_closet_removal";
  baselineClosetLikeCount: number;
  missingClosetLikeCount: number;
};

function isClosetLike(opening: Opening): boolean {
  const heightRule = opening.height > 0.4;
  const widthRule = opening.width > 0.1;
  const bottomTouchesFloor = opening.cy + opening.height / 2 >= 0.95;
  const verticalAspect = opening.height / Math.max(0.001, opening.width) >= 1.2;
  return heightRule && widthRule && bottomTouchesFloor && verticalAspect;
}

function isMatchedClosetLike(base: Opening, candidate: Opening): boolean {
  const cxDelta = Math.abs(base.cx - candidate.cx);
  const cyDelta = Math.abs(base.cy - candidate.cy);
  const wDelta = Math.abs(base.width - candidate.width);
  const hDelta = Math.abs(base.height - candidate.height);
  return cxDelta <= 0.14 && cyDelta <= 0.16 && wDelta <= 0.2 && hDelta <= 0.22;
}

export function evaluateClosetGuard(
  baselineOpenings: Opening[],
  candidateOpenings: Opening[]
): ClosetGuardResult {
  const baselineClosetLike = baselineOpenings.filter(isClosetLike);
  if (baselineClosetLike.length === 0) {
    return {
      verdict: "pass",
      baselineClosetLikeCount: 0,
      missingClosetLikeCount: 0,
    };
  }

  let missing = 0;
  for (const base of baselineClosetLike) {
    const hasMatch = candidateOpenings.some((cand) => isMatchedClosetLike(base, cand));
    if (!hasMatch) missing += 1;
  }

  if (missing > 0) {
    return {
      verdict: "retry",
      reason: "potential_closet_removal",
      baselineClosetLikeCount: baselineClosetLike.length,
      missingClosetLikeCount: missing,
    };
  }

  return {
    verdict: "pass",
    baselineClosetLikeCount: baselineClosetLike.length,
    missingClosetLikeCount: 0,
  };
}
