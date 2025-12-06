/**
 * Validator-Focused Logging Utilities
 *
 * Provides logging functions that respect the VALIDATOR_FOCUS mode.
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
 * Normal log
 *
 * Only outputs when VALIDATOR_FOCUS is disabled.
 * Used for regular worker logs.
 *
 * @param args Log arguments
 */
export function nLog(...args: any[]) {
  if (!VALIDATOR_FOCUS) {
    console.log(...args);
  }
}

/**
 * Conditional log
 *
 * Wraps console.log to respect VALIDATOR_FOCUS mode.
 * Alias for nLog.
 *
 * @param args Log arguments
 */
export function cLog(...args: any[]) {
  if (!VALIDATOR_FOCUS) {
    console.log(...args);
  }
}
