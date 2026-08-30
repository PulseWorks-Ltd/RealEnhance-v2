/**
 * Validator-Focused Logging Utilities
 *
 * Three independent env-var-driven tiers, from quietest to loudest:
 *
 *   PRODUCTION_LOG_MODE=true            -> essential lifecycle events + the
 *                                          batch forensic summary only.
 *                                          Overrides everything below.
 *   PRODUCTION_LOG_MODE=false,
 *     VALIDATOR_LOGS_FOCUS=1            -> full pipeline/stage progress, but
 *                                          specialist-validator per-item/
 *                                          per-attempt detail suppressed.
 *   PRODUCTION_LOG_MODE=false,
 *     VALIDATOR_LOGS_FOCUS=0 (default)  -> everything (today's behavior).
 *
 * VALIDATOR_FOCUS is a separate, orthogonal manual debug switch (opt-in
 * "validator session only" output via vLog) predating this tiering and left
 * as-is here.
 */

import { VALIDATOR_FOCUS } from "./config";

function isValidatorLogsFocusEnabled(): boolean {
  return process.env.VALIDATOR_LOGS_FOCUS === "1";
}

function isProductionLogModeEnabled(): boolean {
  return process.env.PRODUCTION_LOG_MODE === "true";
}

export function isValidationFocusMode(): boolean {
  return process.env.VALIDATOR_FOCUS_MODE === "on";
}

// Tags carried by nLog() calls that are specialist-validator per-item or
// per-attempt detail (as opposed to general pipeline/stage progress, which
// also goes through nLog). Suppressed only in the middle tier
// (VALIDATOR_LOGS_FOCUS=1) — the top tier (PRODUCTION_LOG_MODE=true)
// suppresses nLog entirely regardless of this list.
const VALIDATOR_DETAIL_TAGS = [
  "[STAGE2_SPLIT_VALIDATOR_RESULT]",
  "[SPECIALIST_CLASSIFICATION]",
  "[VALIDATOR_HARD_FAIL]",
  "[VALIDATOR_ADVISORY]",
  "[OPENING_STRUCTURAL_SIGNAL]",
  "[SPECIALIST_VALIDATION_SUMMARY]",
  "[SPECIALIST_SIGNAL]",
  "[VALIDATOR_RESULT]",
  "[VALIDATOR_INPUT]",
  "[LOCAL_VALIDATOR_TIER]",
  "[UNIFIED_VALIDATOR]",
  "[UNIFIED_AUTHORITY]",
  "[STAGE2_VALIDATION_A]",
  "[STAGE2_VALIDATION_B]",
  "[STAGE2_VALIDATION_BASELINE]",
  "[STAGE2_VALIDATION_ADVISORY]",
  "[STAGE2_SPECIALIST_SIGNALS]",
  "[STAGE2_SPECIALIST_VALIDATORS_MODE]",
  "[STAGE2_OCCLUSION_ALLOWANCE]",
  "[STAGE2_THRESHOLD_MODE]",
  "[STAGE2_ADVISORY_INJECTION]",
  "[STAGE2_DIRECT_GATE]",
  "[STAGE2_DIRECT_GATE_ADVISORY]",
];

function isValidatorDetailTag(firstArg: unknown): boolean {
  if (typeof firstArg !== "string") return false;
  return VALIDATOR_DETAIL_TAGS.some((tag) => firstArg.includes(tag));
}

export function logIfNotFocusMode(...args: any[]) {
  if (isProductionLogModeEnabled()) return;
  if (!isValidationFocusMode()) {
    console.log(...args);
  }
}

/**
 * Validator-focused log
 *
 * Only outputs when VALIDATOR_FOCUS is enabled.
 * Used for concise, structured validation logs.
 *
 * @param args Log arguments
 */
export function vLog(...args: any[]) {
  if (VALIDATOR_FOCUS && !isValidatorLogsFocusEnabled()) {
    console.log(...args);
  }
}

/**
 * Normal log — the general-purpose worker logger.
 *
 * Hard-muted entirely under PRODUCTION_LOG_MODE=true (top tier) and under
 * the legacy VALIDATOR_FOCUS session-swap. Under VALIDATOR_LOGS_FOCUS=1
 * (middle tier), only calls tagged as specialist-validator detail
 * (VALIDATOR_DETAIL_TAGS) are suppressed — general pipeline/stage progress
 * logged via nLog still prints.
 *
 * @param args Log arguments
 */
export function nLog(...args: any[]) {
  if (VALIDATOR_FOCUS) return;
  if (isProductionLogModeEnabled()) return;
  if (isValidatorLogsFocusEnabled() && isValidatorDetailTag(args[0])) return;
  console.log(...args);
}

/**
 * Dedicated logger for modules whose entire output is specialist-validator
 * per-item/per-attempt detail (opening/fixture/floor/envelope baseline
 * extraction, comparison, and review dumps) — every call through this
 * function is "detail" by construction, so no tag matching is needed.
 * Suppressed under PRODUCTION_LOG_MODE=true and under VALIDATOR_LOGS_FOCUS=1
 * alike (this is exactly the "specific log lines of the specialist
 * validators" the middle tier is meant to drop).
 */
export function vDetailLog(...args: any[]) {
  if (VALIDATOR_FOCUS) return;
  if (isProductionLogModeEnabled()) return;
  if (isValidatorLogsFocusEnabled()) return;
  console.log(...args);
}
