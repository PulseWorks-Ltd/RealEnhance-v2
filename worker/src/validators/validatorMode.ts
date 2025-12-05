/**
 * Validator Mode Configuration System
 *
 * This module provides centralized configuration for all validators in the RealEnhance worker.
 * It supports different operational modes to control validator behavior without code changes.
 *
 * Environment Variables:
 *   VALIDATOR_MODE - Global default mode for all validators
 *   STRUCTURE_VALIDATOR_MODE - Specific mode for structural validators (overrides VALIDATOR_MODE)
 *   REALISM_VALIDATOR_MODE - Specific mode for realism validators (overrides VALIDATOR_MODE)
 *
 * Modes:
 *   - off: Validator is completely disabled, not executed
 *   - log: Validator runs and logs results, never blocks images
 *   - retry: Validator can trigger automatic retries (not implemented yet)
 *   - block: Validator can block images that fail validation
 */

export type ValidatorMode = "off" | "log" | "retry" | "block";

export type ValidatorKind = "global" | "structure" | "realism";

/**
 * Get the configured validator mode for a specific validator kind.
 *
 * Priority order:
 * 1. Kind-specific environment variable (e.g., STRUCTURE_VALIDATOR_MODE)
 * 2. Global VALIDATOR_MODE environment variable
 * 3. Default: "off" (safe default - no validation)
 *
 * @param kind - The kind of validator to check
 * @returns The validator mode to use
 */
export function getValidatorMode(kind: ValidatorKind = "global"): ValidatorMode {
  let raw: string | undefined;

  switch (kind) {
    case "structure":
      raw = process.env.STRUCTURE_VALIDATOR_MODE || process.env.VALIDATOR_MODE;
      break;
    case "realism":
      raw = process.env.REALISM_VALIDATOR_MODE || process.env.VALIDATOR_MODE;
      break;
    case "global":
    default:
      raw = process.env.VALIDATOR_MODE;
      break;
  }

  // Validate and return
  if (raw === "log" || raw === "retry" || raw === "block" || raw === "off") {
    return raw;
  }

  // Safe default: off
  return "off";
}

/**
 * Check if a validator should run at all.
 *
 * @param kind - The kind of validator
 * @returns true if the validator should run
 */
export function isValidatorEnabled(kind: ValidatorKind = "global"): boolean {
  const mode = getValidatorMode(kind);
  return mode !== "off";
}

/**
 * Check if a validator should block images on failure.
 *
 * @param kind - The kind of validator
 * @returns true if the validator should block failing images
 */
export function shouldValidatorBlock(kind: ValidatorKind = "global"): boolean {
  const mode = getValidatorMode(kind);
  return mode === "block";
}

/**
 * Check if a validator should trigger retries on failure.
 *
 * @param kind - The kind of validator
 * @returns true if the validator should trigger retries
 */
export function shouldValidatorRetry(kind: ValidatorKind = "global"): boolean {
  const mode = getValidatorMode(kind);
  return mode === "retry";
}

/**
 * Check if a validator is in log-only mode.
 *
 * @param kind - The kind of validator
 * @returns true if the validator should only log results
 */
export function isLogOnlyMode(kind: ValidatorKind = "global"): boolean {
  const mode = getValidatorMode(kind);
  return mode === "log";
}

/**
 * Log validator configuration at startup for debugging.
 */
export function logValidatorConfig(): void {
  console.log("[validator-config] === Validator Configuration ===");
  console.log(`[validator-config] VALIDATOR_MODE: ${process.env.VALIDATOR_MODE || "(not set)"}`);
  console.log(`[validator-config] STRUCTURE_VALIDATOR_MODE: ${process.env.STRUCTURE_VALIDATOR_MODE || "(not set)"}`);
  console.log(`[validator-config] REALISM_VALIDATOR_MODE: ${process.env.REALISM_VALIDATOR_MODE || "(not set)"}`);
  console.log(`[validator-config] Resolved modes:`);
  console.log(`[validator-config]   - global: ${getValidatorMode("global")}`);
  console.log(`[validator-config]   - structure: ${getValidatorMode("structure")}`);
  console.log(`[validator-config]   - realism: ${getValidatorMode("realism")}`);
  console.log("[validator-config] ================================");
}
