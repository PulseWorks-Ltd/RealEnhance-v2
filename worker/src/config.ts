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
