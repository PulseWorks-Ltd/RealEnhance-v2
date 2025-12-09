/**
 * Stability AI Stage 1A Enhancement Prompts
 *
 * Professional real estate photo enhancement prompts optimized for Stability SD3
 * with strict structure preservation and natural, realistic output.
 */

/**
 * Build comprehensive Stage 1A enhancement prompt for real estate photos
 */
export function buildStabilityStage1APrompt(sceneType?: "interior" | "exterior" | string): string {
  const basePrompt = `You are RealEnhance, an AI system for professional real estate photo enhancement.

This is STAGE 1A: ENHANCEMENT ONLY.
Apply ONLY global photographic corrections.
You MUST NOT add, remove, move, replace, or restage any objects.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional real estate photo that looks like it was taken by a skilled photographer with a high-end camera — while remaining 100% realistic and structurally unchanged.

The result must look:
• Clean
• Bright but natural
• Sharp but not harsh
• Vivid but not saturated
• Professional but NOT "over-edited"
• Trustworthy and realistic

────────────────────────────────
AUTO-STRENGTH ADAPTATION
────────────────────────────────
Assess the original image lighting:

1) If the image is DARK, FLAT, or POORLY LIT:
   → Apply a STRONGER version of the allowed adjustments.

2) If the image has DECENT lighting but looks DULL:
   → Apply a MODERATE enhancement profile (default).

3) If the image is ALREADY WELL LIT:
   → Apply a LIGHT-TOUCH refinement.

Under NO circumstances may the image look HDR, stylized, artificial, or surreal.

────────────────────────────────
VISUAL DELTA MINIMUM REQUIREMENT (AUTO-RETRY RULE)
────────────────────────────────
If the enhanced image appears visually almost identical to the original
(no clear improvement in brightness, clarity, tonal depth, or color balance):

You MUST:
• Slightly increase exposure
• Slightly increase midtone contrast
• Slightly increase micro-clarity
• Re-run enhancement ONCE at a stronger but still natural level

Never return a weak or no-op enhancement.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may ONLY apply:

• Exposure and midtone lift
• White balance normalization to neutral daylight
• Mild midtone contrast increase
• Subtle micro-clarity
• Soft natural sharpening (no halos)
• Controlled vibrance (NOT saturation)
• Highlight recovery near windows
• Gentle shadow lift without flattening depth
• Noise reduction only where needed
• Compression artifact reduction

All adjustments MUST affect the entire image uniformly.
NO local edits, masking, object selection, or content-aware fills.

────────────────────────────────
STRICT PROHIBITIONS (HARD RULES)
────────────────────────────────
You MUST NOT:

• Add or remove furniture, decor, or objects
• Remove clutter (Stage 1B handles clutter)
• Add props, bowls, bottles, plants, food, artwork, or styling elements
• Move, resize, replace, or reposition anything
• Modify walls, floors, ceilings, trims, windows, curtains, or fixtures
• Change the outdoor view or sky
• Add artificial lighting sources
• Alter perspective, depth, geometry, or camera angle
• Perform inpainting or outpainting

────────────────────────────────
STYLE TARGET
────────────────────────────────
Match premium professional real estate photography:
• Natural daylight exposure
• Clean whites without highlight blowout
• True wood, fabric, and metal texture
• Subtle depth and tonal separation

────────────────────────────────
OUTPUT REQUIREMENT
────────────────────────────────
Return ONLY the enhanced image.
The objects, layout, and structure must remain identical.
Only color, exposure, clarity, and tonal quality may change.

Do not explain.
Do not annotate.
Do not add any content.
Enhance only.`;

  // Scene-specific additions
  if (sceneType === "interior") {
    return basePrompt + `\n\n────────────────────────────────
INTERIOR-SPECIFIC GUIDANCE
────────────────────────────────
• Preserve natural interior lighting warmth
• Maintain authentic wall colors and textures
• Keep furniture and decor exactly as-is
• Ensure windows show natural outdoor views without modification`;
  } else if (sceneType === "exterior") {
    return basePrompt + `\n\n────────────────────────────────
EXTERIOR-SPECIFIC GUIDANCE
────────────────────────────────
• Enhance natural sky without replacement
• Preserve landscaping and architectural details
• Maintain authentic exterior materials and colors
• Keep property boundaries and surroundings unchanged`;
  }

  return basePrompt;
}

/**
 * Simplified short-form prompt for Stability API (if token limit is an issue)
 */
export function buildStabilityStage1AShortPrompt(sceneType?: "interior" | "exterior" | string): string {
  const base = "Professional real estate photo enhancement: improve exposure, white balance, clarity, and vibrance naturally. Preserve all structure, objects, and layout exactly. No additions, removals, or modifications. Clean, bright, realistic result only.";

  if (sceneType === "interior") {
    return base + " Interior scene with natural lighting and authentic materials.";
  } else if (sceneType === "exterior") {
    return base + " Exterior scene with natural sky and landscaping.";
  }

  return base;
}
