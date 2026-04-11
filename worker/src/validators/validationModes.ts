import { nLog } from "../logger";

export type Mode = "off" | "log" | "block";

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
  if (v === "off") return "off";
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

  const markLegacyUsed = (...names: string[]) => {
    legacyUsed.push(...names);
  };

  // Local mode resolution
  const localPrimary = process.env.LOCAL_VALIDATOR_MODE;
  let localMode = normalizeMode(localPrimary, "log");
  if (!localPrimary) {
    const legacyLocal =
      legacyInputs.STRUCTURE_VALIDATOR_MODE ||
      legacyInputs.VALIDATOR_MODE ||
      legacyInputs.STAGE1B_VALIDATION_MODE ||
      legacyInputs.STAGE1B_LOCAL_VALIDATE_MODE;
    if (legacyLocal) {
      localMode = normalizeMode(legacyLocal, "log");
      const used: string[] = [];
      if (legacyInputs.STRUCTURE_VALIDATOR_MODE) used.push("STRUCTURE_VALIDATOR_MODE");
      if (legacyInputs.VALIDATOR_MODE) used.push("VALIDATOR_MODE");
      if (legacyInputs.STAGE1B_VALIDATION_MODE) used.push("STAGE1B_VALIDATION_MODE");
      if (legacyInputs.STAGE1B_LOCAL_VALIDATE_MODE) used.push("STAGE1B_LOCAL_VALIDATE_MODE");
      markLegacyUsed(...used);
    }
  }

  // Gemini mode resolution
  const geminiPrimary = process.env.GEMINI_VALIDATOR_MODE;
  let geminiMode = normalizeMode(geminiPrimary, "block");
  if (!geminiPrimary) {
    const legacyGemini = legacyInputs.VALIDATOR_MODE || legacyInputs.STAGE1B_VALIDATION_MODE;
    if (legacyGemini) {
      geminiMode = normalizeMode(legacyGemini, "block");
      const used: string[] = [];
      if (legacyInputs.VALIDATOR_MODE) used.push("VALIDATOR_MODE");
      if (legacyInputs.STAGE1B_VALIDATION_MODE) used.push("STAGE1B_VALIDATION_MODE");
      markLegacyUsed(...used);
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
  return true; // SINGLE-AUTHORITY: Gemini blocking is always enabled
}

export function explainResolvedModes(): Resolution {
  return resolveModes();
}

export function logValidationModes(): void {
  const { localMode, geminiMode, legacyInputs, legacyUsed } = resolveModes();
  if (logged) return;
  legacyUsed.forEach((key) => {
    const replacement = key === "VALIDATOR_MODE" ? "LOCAL_VALIDATOR_MODE / GEMINI_VALIDATOR_MODE" : "LOCAL_VALIDATOR_MODE";
    warnDeprecated(key, replacement);
  });
  nLog(`[validator-config] Resolved modes: local=${localMode} gemini=${geminiMode}`);
  if (legacyUsed.length) {
    nLog(`[validator-config] Legacy env vars in play: ${legacyUsed.join(", ")}`);
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
