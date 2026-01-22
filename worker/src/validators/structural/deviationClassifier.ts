import type { StageId } from "../stageAwareConfig";

export type DeviationSeverity = "pass" | "risk" | "fatal";

export type DeviationConfig = {
  fatalRequiresConfirmation: boolean;
  confirmationSignalsMin: number;
  thresholdsDeg: Record<StageId, number>;
};

export type DeviationContext = {
  structIou?: number | null;
  structIouThreshold?: number;
  edgeIou?: number | null;
  edgeIouThreshold?: number;
  openingsDelta?: number;
  openingsMinDelta?: number;
  openingsValidatorActive?: boolean;
};

export type DeviationClassification = {
  severity: DeviationSeverity;
  thresholdDeg: number;
  confirmationsUsed: string[];
  reason: string;
};

function parseEnvBool(envKey: string, defaultValue: boolean): boolean {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseEnvInt(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function parseEnvFloat(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

export function loadDeviationConfigFromEnv(): DeviationConfig {
  return {
    fatalRequiresConfirmation: parseEnvBool("STRUCT_VALIDATION_DEVIATION_FATAL_REQUIRES_CONFIRMATION", true),
    confirmationSignalsMin: Math.max(1, parseEnvInt("STRUCT_VALIDATION_DEVIATION_CONFIRMATION_SIGNALS_MIN", 1)),
    thresholdsDeg: {
      stage1A: parseEnvFloat("STRUCT_VALIDATION_MAX_DEVIATION_DEG_STAGE1A", 20),
      stage1B: parseEnvFloat("STRUCT_VALIDATION_MAX_DEVIATION_DEG_STAGE1B", 35),
      stage2: parseEnvFloat("STRUCT_VALIDATION_MAX_DEVIATION_DEG_STAGE2", 45),
    },
  };
}

export function classifyDeviation(
  stage: StageId,
  deviationDeg: number | null | undefined,
  ctx: DeviationContext,
  config?: DeviationConfig
): DeviationClassification | null {
  if (deviationDeg === null || deviationDeg === undefined) {
    return null;
  }

  const cfg = config || loadDeviationConfigFromEnv();
  const thresholdDeg = cfg.thresholdsDeg[stage];

  if (deviationDeg <= thresholdDeg) {
    return {
      severity: "pass",
      thresholdDeg,
      confirmationsUsed: [],
      reason: "within_threshold",
    };
  }

  if (stage === "stage2") {
    return {
      severity: "risk",
      thresholdDeg,
      confirmationsUsed: [],
      reason: "stage2_risk_only",
    };
  }

  const confirmations: string[] = [];

  if (
    ctx.structIou !== undefined && ctx.structIou !== null &&
    ctx.structIouThreshold !== undefined && ctx.structIou < ctx.structIouThreshold
  ) {
    confirmations.push("structIou");
  }

  if (
    ctx.edgeIou !== undefined && ctx.edgeIou !== null &&
    ctx.edgeIouThreshold !== undefined && ctx.edgeIou < ctx.edgeIouThreshold
  ) {
    confirmations.push("edgeIou");
  }

  if (
    ctx.openingsValidatorActive &&
    ctx.openingsDelta !== undefined &&
    ctx.openingsMinDelta !== undefined &&
    ctx.openingsDelta >= ctx.openingsMinDelta
  ) {
    confirmations.push("openingsDelta");
  }

  if (cfg.fatalRequiresConfirmation) {
    if (confirmations.length >= cfg.confirmationSignalsMin) {
      return {
        severity: "fatal",
        thresholdDeg,
        confirmationsUsed: confirmations,
        reason: "confirmed_by_context",
      };
    }
    return {
      severity: "risk",
      thresholdDeg,
      confirmationsUsed: confirmations,
      reason: "unconfirmed_no_context",
    };
  }

  return {
    severity: "fatal",
    thresholdDeg,
    confirmationsUsed: confirmations,
    reason: "legacy_no_confirmation",
  };
}
