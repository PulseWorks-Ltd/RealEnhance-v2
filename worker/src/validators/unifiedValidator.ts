export type Stage2LocalSignals = {
  structuralDegreeChange: number;
  wallDrift: number;
  maskedEdgeDrift: number;
  edgeOpeningRisk: number;
  openingCountMismatch: number;
  floorPlaneShift: number;
  fixtureMismatch: number;
  islandDetectionDrift: number;
};

export type UnifiedValidatorDecision = "PROCEED_TO_GEMINI" | "RETRY";

export type UnifiedValidatorSeverity = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "CATASTROPHIC";

export type UnifiedValidatorResult = {
  decision: UnifiedValidatorDecision;
  severity: UnifiedValidatorSeverity;
  score: number;
  warnings: string[];
};

const SIGNAL_WEIGHTS: Record<keyof Stage2LocalSignals, number> = {
  structuralDegreeChange: 4,
  wallDrift: 3,
  floorPlaneShift: 3,
  maskedEdgeDrift: 2,
  edgeOpeningRisk: 2,
  openingCountMismatch: 2,
  fixtureMismatch: 1,
  islandDetectionDrift: 1,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeSignals(signals: Stage2LocalSignals): Stage2LocalSignals {
  return {
    structuralDegreeChange: clamp01(signals.structuralDegreeChange),
    wallDrift: clamp01(signals.wallDrift),
    maskedEdgeDrift: clamp01(signals.maskedEdgeDrift),
    edgeOpeningRisk: clamp01(signals.edgeOpeningRisk),
    openingCountMismatch: clamp01(signals.openingCountMismatch),
    floorPlaneShift: clamp01(signals.floorPlaneShift),
    fixtureMismatch: clamp01(signals.fixtureMismatch),
    islandDetectionDrift: clamp01(signals.islandDetectionDrift),
  };
}

function classifySeverity(score: number): Exclude<UnifiedValidatorSeverity, "CATASTROPHIC"> {
  if (score < 2) return "LOW";
  if (score <= 4) return "MODERATE";
  if (score <= 6) return "HIGH";
  return "CRITICAL";
}

export function runUnifiedValidator(signals: Stage2LocalSignals): UnifiedValidatorResult {
  const normalized = normalizeSignals(signals);

  const catastrophicRules: Array<{ key: keyof Stage2LocalSignals; threshold: number }> = [
    { key: "structuralDegreeChange", threshold: 0.9 },
    { key: "wallDrift", threshold: 0.9 },
    { key: "floorPlaneShift", threshold: 0.9 },
  ];

  for (const rule of catastrophicRules) {
    if (normalized[rule.key] > rule.threshold) {
      return {
        decision: "RETRY",
        severity: "CATASTROPHIC",
        score: 0,
        warnings: [`${rule.key}>${rule.threshold.toFixed(2)}`],
      };
    }
  }

  let score = 0;
  const warnings: string[] = [];
  for (const key of Object.keys(SIGNAL_WEIGHTS) as Array<keyof Stage2LocalSignals>) {
    const value = normalized[key];
    score += SIGNAL_WEIGHTS[key] * value;
    if (value > 0) {
      warnings.push(key);
    }
  }

  const roundedScore = Number(score.toFixed(4));
  const severity = classifySeverity(roundedScore);
  const decision: UnifiedValidatorDecision = "PROCEED_TO_GEMINI";

  return {
    decision,
    severity,
    score: roundedScore,
    warnings,
  };
}
