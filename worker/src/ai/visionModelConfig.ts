// worker/src/ai/visionModelConfig.ts
// Single source of truth for the Gemini vision/analysis model used across all AI detector modules.

/**
 * The Gemini model used for vision analysis & detection tasks (NOT image generation).
 * All detector modules (fixture, scene, wall, fov, etc.) reference this constant.
 * Override via GEMINI_VISION_MODEL env var.
 */
export const GEMINI_VISION_MODEL: string =
  process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
