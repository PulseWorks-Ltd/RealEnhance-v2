/**
 * Worker Configuration
 *
 * Centralized configuration for the RealEnhance worker service.
 */

/**
 * VALIDATOR_FOCUS mode
 *
 * When enabled (set to "1" or "true"), the worker outputs only concise,
 * structured logs containing:
 * - Image label + URLs (original, 1A, 1B, final)
 * - Stage-1B structural validator summary
 * - Unified Structural Validator summary
 * - Classic structure validator summary
 *
 * All other logs are suppressed to focus on validation metrics.
 */
export const VALIDATOR_FOCUS =
  process.env.VALIDATOR_FOCUS === "1" || process.env.VALIDATOR_FOCUS === "true";

export enum LocalValidatorTier {
  NONE = "none",
  CORE = "core",
  FULL = "full",
}

const LOCAL_VALIDATOR_TIER_RAW = String(process.env.LOCAL_VALIDATOR_TIER || LocalValidatorTier.CORE)
  .trim()
  .toLowerCase();

export const LOCAL_VALIDATOR_TIER: LocalValidatorTier =
  LOCAL_VALIDATOR_TIER_RAW === LocalValidatorTier.NONE
    ? LocalValidatorTier.NONE
    : LOCAL_VALIDATOR_TIER_RAW === LocalValidatorTier.FULL
      ? LocalValidatorTier.FULL
      : LocalValidatorTier.CORE;

export type StructuralSignalsMode = "log_only" | "active";

const STRUCTURAL_SIGNALS_MODE_RAW = String(process.env.STRUCTURAL_SIGNALS_MODE || "active")
  .trim()
  .toLowerCase();

export const STRUCTURAL_SIGNALS_MODE: StructuralSignalsMode =
  STRUCTURAL_SIGNALS_MODE_RAW === "active" ? "active" : "active"; // force active — structural claim enforcement always on

export const STRUCTURAL_SIGNALS_ACTIVE = STRUCTURAL_SIGNALS_MODE === "active";

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// Default-off safety switch for Phase 2 specialist advisory visibility.
// When disabled, Unified->Gemini behavior remains unchanged.
export const STAGE2_ENABLE_SPECIALIST_ADVISORY = parseBooleanEnv(
  process.env.STAGE2_ENABLE_SPECIALIST_ADVISORY
);

// Default-off safety switch for Stage 2 categorical issueType enforcement.
// When disabled, lower-confidence or fixture-specific signals bypass the pre-unified gate.
// High-confidence critical structural signals hard-fail unconditionally regardless.
export const STAGE2_ENABLE_ISSUETYPE_HARDFAIL = parseBooleanEnv(
  process.env.STAGE2_ENABLE_ISSUETYPE_HARDFAIL
);
