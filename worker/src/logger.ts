/**
 * Validator-Focused Logging Utilities
 *
 * Provides logging functions that respect the VALIDATOR_FOCUS mode.
 *
 * When VALIDATOR_FOCUS=1:
 * - vLog() outputs → validator logs only
 * - nLog() is MUTED → all other logs suppressed
 *
 * When VALIDATOR_FOCUS=0 or unset:
 * - vLog() is MUTED → validator logs suppressed
 * - nLog() outputs → normal worker logs appear
 */

import { VALIDATOR_FOCUS } from "./config";

/**
 * Validator-focused log
 *
 * Only outputs when VALIDATOR_FOCUS is enabled.
 * Used for concise, structured validation logs.
 *
 * @param args Log arguments
 */
export function vLog(...args: any[]) {
  if (VALIDATOR_FOCUS) {
    console.log(...args);
  }
}

/**
 * Normal log - HARD MUTE when validator focus enabled
 *
 * Only outputs when VALIDATOR_FOCUS is disabled.
 * Used for ALL non-validation logs (S3, Gemini, Redis, file paths, etc.)
 *
 * IMPORTANT: This provides HARD SUPPRESSION of noisy logs in validator focus mode.
 *
 * @param args Log arguments
 */
export function nLog(...args: any[]) {
  if (!VALIDATOR_FOCUS) {
    console.log(...args);
  }
}
