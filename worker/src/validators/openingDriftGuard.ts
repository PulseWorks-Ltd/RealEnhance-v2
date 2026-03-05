import type { Opening } from "../vision/detectOpenings";

export type OpeningDriftGuardResult = {
  verdict: "pass" | "retry";
  reason?: "opening_geometry_drift";
  openingDeltaDetected: boolean;
  driftExceedsThreshold: boolean;
  widthDeltaMax: number;
  heightDeltaMax: number;
  centerShiftMax: number;
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function centerDistance(a: Opening, b: Opening): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

function findClosestByType(source: Opening, candidates: Opening[]): Opening | null {
  const sameType = candidates.filter((c) => c.type === source.type);
  if (sameType.length === 0) return null;
  let best = sameType[0];
  let bestDist = centerDistance(source, best);
  for (let i = 1; i < sameType.length; i += 1) {
    const d = centerDistance(source, sameType[i]);
    if (d < bestDist) {
      best = sameType[i];
      bestDist = d;
    }
  }
  return best;
}

export function evaluateOpeningDriftGuard(
  baselineOpenings: Opening[],
  candidateOpenings: Opening[],
  opts?: {
    widthDeltaThreshold?: number;
    heightDeltaThreshold?: number;
    centerShiftThreshold?: number;
  }
): OpeningDriftGuardResult {
  const widthDeltaThreshold = clamp(opts?.widthDeltaThreshold ?? 0.08, 0.01, 0.5);
  const heightDeltaThreshold = clamp(opts?.heightDeltaThreshold ?? 0.08, 0.01, 0.5);
  const centerShiftThreshold = clamp(opts?.centerShiftThreshold ?? 0.10, 0.01, 0.5);

  if (!baselineOpenings.length || !candidateOpenings.length) {
    return {
      verdict: "pass",
      openingDeltaDetected: false,
      driftExceedsThreshold: false,
      widthDeltaMax: 0,
      heightDeltaMax: 0,
      centerShiftMax: 0,
    };
  }

  let widthDeltaMax = 0;
  let heightDeltaMax = 0;
  let centerShiftMax = 0;
  let anyThresholdExceeded = false;
  let missingSameTypeMatchCount = 0;

  const baselineWindows = baselineOpenings.filter((o) => o.type === "window").length;
  const baselineDoors = baselineOpenings.filter((o) => o.type === "door").length;
  const candidateWindows = candidateOpenings.filter((o) => o.type === "window").length;
  const candidateDoors = candidateOpenings.filter((o) => o.type === "door").length;

  for (const base of baselineOpenings) {
    const cand = findClosestByType(base, candidateOpenings);
    if (!cand) {
      missingSameTypeMatchCount += 1;
      continue;
    }
    const widthDelta = Math.abs(base.width - cand.width);
    const heightDelta = Math.abs(base.height - cand.height);
    const centerShift = centerDistance(base, cand);

    // Tiny windows are more volatile in generative output; soften thresholds.
    const baselineArea = base.width * base.height;
    const tinyWindowScale = base.type === "window" && baselineArea < 0.06 ? 1.5 : 1;
    const widthThresholdForOpening = widthDeltaThreshold * tinyWindowScale;
    const heightThresholdForOpening = heightDeltaThreshold * tinyWindowScale;
    const centerThresholdForOpening = centerShiftThreshold * tinyWindowScale;

    if (widthDelta > widthDeltaMax) widthDeltaMax = widthDelta;
    if (heightDelta > heightDeltaMax) heightDeltaMax = heightDelta;
    if (centerShift > centerShiftMax) centerShiftMax = centerShift;

    if (
      widthDelta > widthThresholdForOpening ||
      heightDelta > heightThresholdForOpening ||
      centerShift > centerThresholdForOpening
    ) {
      anyThresholdExceeded = true;
    }
  }

  const openingDeltaDetected =
    baselineOpenings.length !== candidateOpenings.length ||
    baselineWindows !== candidateWindows ||
    baselineDoors !== candidateDoors ||
    missingSameTypeMatchCount > 0 ||
    widthDeltaMax > 0 ||
    heightDeltaMax > 0 ||
    centerShiftMax > 0;

  const driftExceedsThreshold = anyThresholdExceeded;

  if (openingDeltaDetected && driftExceedsThreshold) {
    return {
      verdict: "retry",
      reason: "opening_geometry_drift",
      openingDeltaDetected,
      driftExceedsThreshold,
      widthDeltaMax,
      heightDeltaMax,
      centerShiftMax,
    };
  }

  return {
    verdict: "pass",
    openingDeltaDetected,
    driftExceedsThreshold,
    widthDeltaMax,
    heightDeltaMax,
    centerShiftMax,
  };
}
