import { nLog } from "../logger";

export type Mode = "log" | "block";

type Resolution = {
  localMode: Mode;
  geminiMode: Mode;
  legacyInputs: Record<string, string | undefined>;
  legacyUsed: string[];
};

let cachedResolution: Resolution | null = null;
let logged = false;

function normalizeMode(value: string | undefined, fallback: Mode): Mode {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "block") return "block";
  if (v === "log") return "log";
  return fallback;
}

function warnDeprecated(varName: string, replacement: string) {
  nLog(`[validator-config] DEPRECATED env var ${varName} detected; use ${replacement} instead.`);
}

function resolveModes(): Resolution {
  if (cachedResolution) return cachedResolution;

  const legacyInputs: Record<string, string | undefined> = {
    VALIDATOR_MODE: process.env.VALIDATOR_MODE,
    STRUCTURE_VALIDATOR_MODE: process.env.STRUCTURE_VALIDATOR_MODE,
    REALISM_VALIDATOR_MODE: process.env.REALISM_VALIDATOR_MODE,
    STAGE1B_VALIDATION_MODE: process.env.STAGE1B_VALIDATION_MODE,
    STAGE1B_LOCAL_VALIDATE_MODE: process.env.STAGE1B_LOCAL_VALIDATE_MODE,
  };

  const legacyUsed: string[] = [];

  // Local mode resolution
  const localPrimary = process.env.LOCAL_VALIDATOR_MODE;
  let localMode = normalizeMode(localPrimary, "log");
  if (!localPrimary) {
    const legacyLocal = legacyInputs.STRUCTURE_VALIDATOR_MODE || legacyInputs.VALIDATOR_MODE || legacyInputs.STAGE1B_VALIDATION_MODE;
    if (legacyLocal) {
      localMode = normalizeMode(legacyLocal, "log");
      legacyUsed.push("STRUCTURE_VALIDATOR_MODE", "VALIDATOR_MODE", "STAGE1B_VALIDATION_MODE");
    }
  }

  // Gemini mode resolution
  const geminiPrimary = process.env.GEMINI_VALIDATOR_MODE;
  let geminiMode = normalizeMode(geminiPrimary, "block");
  if (!geminiPrimary) {
    const legacyGemini = legacyInputs.VALIDATOR_MODE || legacyInputs.STAGE1B_VALIDATION_MODE;
    if (legacyGemini) {
      geminiMode = normalizeMode(legacyGemini, "block");
      legacyUsed.push("VALIDATOR_MODE", "STAGE1B_VALIDATION_MODE");
    }
  }

  cachedResolution = { localMode, geminiMode, legacyInputs, legacyUsed };
  return cachedResolution;
}

export function getLocalValidatorMode(): Mode {
  return resolveModes().localMode;
}

export function getGeminiValidatorMode(): Mode {
  return resolveModes().geminiMode;
}

export function isGeminiBlockingEnabled(): boolean {
  return getGeminiValidatorMode() === "block";
}

export function explainResolvedModes(): Resolution {
  return resolveModes();
}

export function logValidationModes(): void {
  const { localMode, geminiMode, legacyInputs } = resolveModes();
  if (logged) return;
  Object.entries(legacyInputs).forEach(([key, val]) => {
    if (val && (key === "VALIDATOR_MODE" || key === "STRUCTURE_VALIDATOR_MODE" || key === "STAGE1B_VALIDATION_MODE" || key === "REALISM_VALIDATOR_MODE")) {
      warnDeprecated(key, key === "VALIDATOR_MODE" ? "LOCAL_VALIDATOR_MODE / GEMINI_VALIDATOR_MODE" : "LOCAL_VALIDATOR_MODE");
    }
  });
  nLog(`[validator-config] Resolved modes: local=${localMode} gemini=${geminiMode}`);
  const legacyUsed = Object.entries(legacyInputs)
    .filter(([, val]) => !!val)
    .map(([k]) => k)
    .join(", ");
  if (legacyUsed) {
    nLog(`[validator-config] Legacy env vars in play: ${legacyUsed}`);
  }
  nLog(`[validator-config] Legacy env snapshot: ${JSON.stringify(legacyInputs)}`);
  logged = true;
}

export function assertNoLocalBlocking(stage: string, localReasons: string[] = [], jobId?: string) {
  const reasonText = localReasons.length ? localReasons.join("; ") : "unspecified";
  const msg = `🚨 INVALID CONFIG: local validator attempted direct block; Gemini-only policy violated stage=${stage} jobId=${jobId || "unknown"} reasons=${reasonText}`;
  console.error(msg);
  if ((process.env.NODE_ENV || "production").toLowerCase() !== "production") {
    throw new Error(msg);
  }
}
