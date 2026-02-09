export interface CurtainRailDetection {
  railLikely: boolean | "unknown";
  confidence: number;
}

/**
 * Heuristic curtain rail detector.
 * Looks for strong thin horizontal edge clusters near top of window regions.
 * Uses existing edge/line maps if available.
 */
export function detectCurtainRail(features: {
  horizontalLinesNearTop?: number;
  windowTopEdgeDensity?: number;
}): CurtainRailDetection {
  const hasLines = typeof features.horizontalLinesNearTop === "number";
  const hasDensity = typeof features.windowTopEdgeDensity === "number";
  if (!hasLines && !hasDensity) {
    return { railLikely: "unknown", confidence: 0 };
  }

  const score =
    (features.horizontalLinesNearTop ?? 0) * 0.6 +
    (features.windowTopEdgeDensity ?? 0) * 0.4;

  return {
    railLikely: score > 0.55,
    confidence: Math.min(Math.max(score, 0), 1),
  };
}
