/**
 * Gemini text/vision model defaults and safety policy (Nov 2026).
 *
 * Google retires gemini-2.5-pro and gemini-2.5-flash on 1 Dec 2026
 * (auto-redirected to gemini-3.8-flash and gemini-3.5-flash-lite). This file
 * is the one place that decides which current models the app uses when a
 * Railway variable isn't set, and it guards every request made through
 * getGeminiClient():
 *
 *  1. Retiring model names (from code or from Railway variables) are swapped
 *     for their replacements, with a one-time warning in the logs.
 *  2. Text/JSON answers get enough output room. Newer Gemini models "think"
 *     before answering and that thinking counts against maxOutputTokens, so a
 *     small limit (e.g. 256) can cut the answer off mid-JSON — which makes a
 *     check fail and can trigger an unnecessary image regeneration. Raising
 *     the cap costs nothing extra: only tokens actually produced are billed.
 *
 * Image models (anything with "image" in its name, or requests asking for
 * IMAGE output) are never touched.
 */

/** Pass/fail checks on generated images, planning, and former 2.5 Pro work. */
export const GEMINI_STRONG_TEXT_MODEL = String(process.env.GEMINI_DEFAULT_STRONG_MODEL || "gemini-3.8-flash").trim();
/** Simple detection/labelling, and first-pass checks that escalate to the strong model. */
export const GEMINI_FAST_TEXT_MODEL = String(process.env.GEMINI_DEFAULT_FAST_MODEL || "gemini-3.5-flash-lite").trim();

/** Minimum output room for text/JSON requests (thinking + answer). */
export const GEMINI_TEXT_MIN_OUTPUT_TOKENS = Math.max(
  1024,
  Number(process.env.GEMINI_TEXT_MIN_OUTPUT_TOKENS || 8192) || 8192
);

/** Retired / retiring model names → the model to use instead. */
export function replacementForRetiredModel(model: string): string | null {
  const m = String(model || "").trim().toLowerCase();
  if (!m || m.includes("image")) return null;
  if (m === "gemini-2.5-pro" || m.startsWith("gemini-2.5-pro-")) return GEMINI_STRONG_TEXT_MODEL;
  if (m === "gemini-2.5-flash" || m.startsWith("gemini-2.5-flash-exp") || m.startsWith("gemini-2.5-flash-preview")) {
    return GEMINI_FAST_TEXT_MODEL;
  }
  if (m === "gemini-2.5-flash-lite" || m.startsWith("gemini-2.5-flash-lite-")) return GEMINI_FAST_TEXT_MODEL;
  if (m === "gemini-2.0-flash" || m.startsWith("gemini-2.0-flash-")) return GEMINI_FAST_TEXT_MODEL;
  if (m.startsWith("gemini-1.5-") || m.startsWith("gemini-1.0-") || m === "gemini-pro" || m === "gemini-pro-vision") {
    return GEMINI_FAST_TEXT_MODEL;
  }
  return null;
}

const warnedModels = new Set<string>();

/** The model to actually call for a text/vision request. */
export function resolveTextModel(model: string): string {
  const replacement = replacementForRetiredModel(model);
  if (!replacement) return model;
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(`[MODEL_RETIRED] "${model}" is retired/retiring; using "${replacement}" instead. Update any Railway variable still set to "${model}".`);
  }
  return replacement;
}

function wantsImageOutput(params: any): boolean {
  const modalities = params?.config?.responseModalities || params?.generationConfig?.responseModalities;
  if (Array.isArray(modalities) && modalities.some((m: unknown) => String(m).toUpperCase() === "IMAGE")) return true;
  return String(params?.model || "").toLowerCase().includes("image");
}

/** Apply the model swap and output-room floor to one generateContent request. */
export function applyTextModelPolicy<T extends { model?: string; config?: any }>(params: T): T {
  if (!params || typeof params !== "object") return params;
  if (wantsImageOutput(params)) return params;
  const next: any = { ...params };
  if (typeof next.model === "string") next.model = resolveTextModel(next.model);
  const max = Number(next.config?.maxOutputTokens);
  if (Number.isFinite(max) && max > 0 && max < GEMINI_TEXT_MIN_OUTPUT_TOKENS) {
    next.config = { ...next.config, maxOutputTokens: GEMINI_TEXT_MIN_OUTPUT_TOKENS };
  }
  return next as T;
}

/** Wrap a GoogleGenAI client so every generateContent call goes through the policy. */
export function withTextModelPolicy<C>(client: C): C {
  const models: any = (client as any)?.models;
  if (!models || typeof models.generateContent !== "function" || models.__textModelPolicy) return client;
  const original = models.generateContent.bind(models);
  models.generateContent = (params: any) => original(applyTextModelPolicy(params));
  if (typeof models.generateContentStream === "function") {
    const originalStream = models.generateContentStream.bind(models);
    models.generateContentStream = (params: any) => originalStream(applyTextModelPolicy(params));
  }
  models.__textModelPolicy = true;
  return client;
}

/**
 * Railway variables that choose a text/vision (not image-generating) model,
 * and the recommended value for each. Logged at worker start-up if any is
 * still set to a retiring model.
 */
export const TEXT_MODEL_ENV_VARS: Array<{ name: string; tier: "strong" | "fast" }> = [
  { name: "GEMINI_VALIDATOR_MODEL_PRIMARY", tier: "fast" },
  { name: "GEMINI_VALIDATOR_MODEL_FAST", tier: "fast" },
  { name: "GEMINI_VALIDATOR_MODEL_ESCALATION", tier: "strong" },
  { name: "GEMINI_VALIDATOR_MODEL_STRONG", tier: "strong" },
  { name: "GEMINI_STAGE1B_FULL_VALIDATOR_MODEL", tier: "strong" },
  { name: "GEMINI_OPENING_LIGHT_ANCHOR_MODEL", tier: "fast" },
  { name: "GEMINI_COMPLIANCE_MODEL", tier: "strong" },
  { name: "OPENING_PRESERVATION_MODEL", tier: "strong" },
  { name: "OPENING_BASELINE_VERIFICATION_MODEL", tier: "strong" },
  { name: "WINDOW_ARTWORK_CHECK_MODEL", tier: "strong" },
  { name: "VANISHED_LANDMARK_CHECK_MODEL", tier: "strong" },
  { name: "FLOOR_VALIDATOR_MODEL", tier: "strong" },
  { name: "FRIDGE_CAVITY_CHECK_MODEL", tier: "strong" },
  { name: "FIREPLACE_OCCLUSION_CHECK_MODEL", tier: "strong" },
  { name: "STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL", tier: "strong" },
  { name: "STAGE1B_DECLUTTER_EFFECTIVENESS_MODEL", tier: "strong" },
  { name: "STRUCTURAL_INVARIANT_MODEL", tier: "strong" },
  { name: "EDIT_OPENINGS_GEMINI_MODEL", tier: "strong" },
  { name: "STAGE1A_OUTLOOK_SURVEY_MODEL", tier: "strong" },
  { name: "ROOM_BRIEF_MODEL", tier: "strong" },
];

export function auditModelEnvVars(log: (msg: string) => void = console.warn): string[] {
  const findings: string[] = [];
  for (const { name, tier } of TEXT_MODEL_ENV_VARS) {
    const value = String(process.env[name] || "").trim();
    if (!value) continue;
    const parts = value.split(",").map((v) => v.trim());
    if (parts.some((p) => replacementForRetiredModel(p))) {
      const recommended = tier === "strong" ? GEMINI_STRONG_TEXT_MODEL : GEMINI_FAST_TEXT_MODEL;
      findings.push(`${name}=${value} → set to ${recommended}`);
    }
  }
  if (findings.length) {
    log(`[MODEL_RETIRED] ${findings.length} Railway variable(s) still name a retiring Gemini model (auto-swapped for now): ${findings.join("; ")}`);
  }
  return findings;
}
