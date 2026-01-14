/**
 * Gemini Prompt Tightening Module
 *
 * Provides progressive prompt constraints for retry attempts.
 * Each tighten level adds stricter instructions to preserve structure.
 */

export type TightenLevel = 0 | 1 | 2 | 3;
export type StageType = "1A" | "1B" | "2";

/**
 * Stage 1A tightening constraints
 * L0: Normal operation
 * L1: Preserve exact geometry; only exposure/colour/clarity/noise/sharpness
 * L2: No additions/removals; no perspective change; minimal edits
 * L3: Ultra-conservative corrections only; if uncertain, do less
 */
const STAGE_1A_TIGHTENING: Record<TightenLevel, string> = {
  0: "",
  1: `
[STRICT STRUCTURAL PRESERVATION - LEVEL 1]
• Preserve exact geometry of all architectural elements
• Only adjust: exposure, color balance, clarity, noise reduction, sharpness
• Do NOT alter perspective, crop, or resize
• Do NOT add or remove any objects
• Output must match input dimensions exactly
`.trim(),
  2: `
[STRICT STRUCTURAL PRESERVATION - LEVEL 2]
• CRITICAL: Zero additions or removals allowed
• CRITICAL: No perspective changes whatsoever
• Only minimal exposure/color corrections permitted
• If any edit might alter geometry, skip that edit
• Maintain exact pixel dimensions
• When in doubt, do less editing
`.trim(),
  3: `
[ULTRA-CONSERVATIVE MODE - LEVEL 3]
• ONLY apply subtle exposure normalization if clearly needed
• ONLY apply minimal color correction if color cast is obvious
• ALL other edits are FORBIDDEN
• If uncertain whether an edit is safe, DO NOT make it
• Output must be pixel-dimension identical to input
• This is a FINAL ATTEMPT - prioritize safety over improvement
`.trim(),
};

/**
 * Stage 1B (declutter) tightening constraints
 * L0: Normal decluttering
 * L1: Remove only small non-structural clutter; never fixtures/built-ins
 * L2: Remove only obvious tiny surface clutter; keep furniture
 * L3: Minimal/no declutter unless completely safe
 */
const STAGE_1B_TIGHTENING: Record<TightenLevel, string> = {
  0: "",
  1: `
[CONSERVATIVE DECLUTTER - LEVEL 1]
• Remove only small, loose, non-structural clutter
• NEVER remove: fixtures, built-ins, permanent installations
• NEVER alter: walls, windows, doors, floor material
• Keep all furniture in place
• Maintain exact image dimensions
`.trim(),
  2: `
[MINIMAL DECLUTTER - LEVEL 2]
• Remove only obvious tiny surface clutter (papers, small items)
• Keep ALL furniture exactly as-is
• NEVER alter any architectural elements
• If unsure whether something is clutter, leave it
• Maintain exact geometry and dimensions
`.trim(),
  3: `
[SAFETY-FIRST DECLUTTER - LEVEL 3]
• Remove ONLY items that are 100% certain to be temporary clutter
• If there's ANY doubt, leave the item
• Architecture must remain IDENTICAL
• This is a FINAL ATTEMPT - safety over cleanliness
• Prefer leaving clutter to risking structural changes
`.trim(),
};

/**
 * Stage 2 (staging) tightening constraints
 * L0: Normal staging
 * L1: Minimal staging; do not alter architecture; keep perspective
 * L2: Very subtle: 1–3 small decor items; avoid rugs/large floor coverings
 * L3: If staging risks structural change, skip staging and only do tiny styling accents
 */
const STAGE_2_TIGHTENING: Record<TightenLevel, string> = {
  0: "",
  1: `
[CONSERVATIVE STAGING - LEVEL 1]
• Add MINIMAL furniture - prioritize quality over quantity
• NEVER alter ANY architectural features (walls, windows, doors, built-ins)
• Maintain exact perspective and camera angle
• All furniture must have feet firmly on the floor
• Keep circulation paths clear (30-60cm minimum)
• Maintain exact image dimensions - NO cropping or resizing
`.trim(),
  2: `
[SUBTLE STAGING - LEVEL 2]
• Add only 1-3 small decor items maximum
• AVOID large floor coverings (rugs, carpets)
• AVOID furniture near windows or doors
• All items must be appropriately scaled
• NO perspective alterations whatsoever
• If placement risks blocking anything, skip that item
• Exact dimensions must be preserved
`.trim(),
  3: `
[ULTRA-SAFE STAGING - LEVEL 3]
• If ANY staging risks structural change, add NOTHING
• Maximum: 1-2 tiny styling accents (small plant, book, pillow)
• Place items ONLY in clear, safe areas away from walls/windows/doors
• This is a FINAL ATTEMPT - architectural preservation is paramount
• If uncertain, output the image unchanged
• Exact pixel dimensions MUST match input
`.trim(),
};

/**
 * Output dimension enforcement constraint (added to all prompts)
 */
const DIMENSION_CONSTRAINT = `
[OUTPUT REQUIREMENTS]
• Return image in EXACT same resolution and aspect ratio as input
• Do NOT crop any edges
• Do NOT change perspective/FOV (no widening or narrowing)
• Do NOT add letterboxing or padding
`.trim();

/**
 * Build a tightened Gemini prompt
 *
 * @param stage - The processing stage (1A, 1B, or 2)
 * @param basePrompt - The original prompt text
 * @param tightenLevel - 0 (normal), 1 (conservative), 2 (strict), 3 (ultra-safe)
 * @returns Modified prompt with tightening constraints prepended
 */
export function buildTightenedPrompt(
  stage: StageType,
  basePrompt: string,
  tightenLevel: TightenLevel
): string {
  // No tightening for level 0
  if (tightenLevel === 0) {
    return basePrompt + "\n\n" + DIMENSION_CONSTRAINT;
  }

  let tighteningText: string;

  switch (stage) {
    case "1A":
      tighteningText = STAGE_1A_TIGHTENING[tightenLevel];
      break;
    case "1B":
      tighteningText = STAGE_1B_TIGHTENING[tightenLevel];
      break;
    case "2":
      tighteningText = STAGE_2_TIGHTENING[tightenLevel];
      break;
    default:
      tighteningText = "";
  }

  // Prepend tightening constraints for maximum visibility to the model
  return `${tighteningText}\n\n${DIMENSION_CONSTRAINT}\n\n${basePrompt}`;
}

/**
 * Get recommended Gemini generation parameters for a tighten level
 *
 * Higher tighten levels use lower temperature for more deterministic output
 */
export function getTightenedGenerationConfig(
  tightenLevel: TightenLevel,
  baseConfig?: { temperature?: number; topP?: number; topK?: number }
): { temperature: number; topP: number; topK: number } {
  const base = {
    temperature: baseConfig?.temperature ?? 0.4,
    topP: baseConfig?.topP ?? 0.9,
    topK: baseConfig?.topK ?? 40,
  };

  switch (tightenLevel) {
    case 0:
      return base;
    case 1:
      return {
        temperature: Math.max(0.1, base.temperature * 0.7),
        topP: Math.max(0.7, base.topP * 0.9),
        topK: Math.max(20, Math.floor(base.topK * 0.8)),
      };
    case 2:
      return {
        temperature: Math.max(0.05, base.temperature * 0.4),
        topP: Math.max(0.6, base.topP * 0.8),
        topK: Math.max(10, Math.floor(base.topK * 0.6)),
      };
    case 3:
      return {
        temperature: 0.01, // Near-deterministic
        topP: 0.5,
        topK: 5,
      };
  }
}

/**
 * Determine tighten level from retry attempt number
 *
 * @param attempt - 0-based attempt number
 * @returns TightenLevel (0, 1, 2, or 3)
 */
export function getTightenLevelFromAttempt(attempt: number): TightenLevel {
  if (attempt <= 0) return 0;
  if (attempt === 1) return 1;
  if (attempt === 2) return 2;
  return 3;
}

/**
 * Log tightening information for debugging
 */
export function logTighteningInfo(
  stage: StageType,
  attempt: number,
  tightenLevel: TightenLevel
): void {
  const levelNames = ["Normal", "Conservative", "Strict", "Ultra-Safe"];
  console.log(`[promptTightening] Stage ${stage} attempt ${attempt + 1}: ${levelNames[tightenLevel]} mode (level ${tightenLevel})`);

  if (tightenLevel > 0) {
    console.log(`[promptTightening] Applying tightened constraints to preserve structure`);
  }
}
