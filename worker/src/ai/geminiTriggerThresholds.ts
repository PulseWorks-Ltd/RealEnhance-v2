/**
 * Gemini Trigger Thresholds
 *
 * These thresholds determine when to use Gemini instead of Stability
 * for primary Stage 1A enhancement based on image quality metrics.
 *
 * Images that fail any of these thresholds are considered "low quality"
 * and benefit more from Gemini's advanced processing.
 */

export const GEMINI_TRIGGER_THRESHOLDS = {
  /** Minimum mean brightness (0-255). Below this = underexposed/dark */
  MIN_BRIGHTNESS: 95,

  /** Maximum noise standard deviation. Above this = high noise/poor lighting */
  MAX_NOISE_STDDEV: 38,

  /** Minimum dynamic range (p95 - p5). Below this = flat/low contrast */
  MIN_DYNAMIC_RANGE: 72,

  /** Maximum blur estimate. Above this = blurry/soft focus */
  MAX_LAPLACIAN_ESTIMATE: 0.55
};
