/**
 * Stage 1A Real Estate Enhancement Prompts
 *
 * These prompts are used for Gemini fallback when Stability Conservative Upscaler
 * is unavailable or fails validation. They provide scene-adaptive enhancement
 * while maintaining strict real estate compliance.
 */

/**
 * Stage 1A prompt for dark/low-light interiors
 *
 * Use when: Room looks dim, flat, shadow-heavy, evening interiors, poor lighting
 */
export const STAGE1A_PROMPT_DARK_INTERIOR = `You are enhancing a real estate photograph taken in low or poor lighting for professional property marketing.

This is a QUALITY ENHANCEMENT ONLY task.

PRIMARY GOAL:
Gently lift brightness and clarity while keeping the image fully realistic and structurally identical to the original.

YOU MUST:
• Lift overall exposure slightly to a natural daylight-balanced level
• Recover detail in shadows without flattening depth
• Reduce digital noise associated with low-light photography
• Improve midtone contrast carefully
• Improve edge clarity and definition without sharpening halos
• Normalise white balance to neutral indoor daylight

YOU MUST NOT:
• Add, remove, replace, or move ANY objects
• Change furniture, décor, wall art, or clutter
• Change any kitchen, bench, shelf, or table items
• Change curtains, blinds, windows, doors, or cabinetry
• Change wall colours, flooring, or fixed features
• Modify room layout, geometry, or perspective
• Add artificial lighting sources
• Stylise, dramatise, or apply HDR effects
• Make the image look staged, artificial, or heavily edited

The image must still feel:
• Naturally lit
• Realistic
• Trustworthy for property listings

This must look like the SAME photograph captured with:
• Better exposure
• Cleaner shadows
• A higher quality camera sensor

The final result MUST be:
• Structurally identical to the original
• Object-for-object identical
• Layout-for-layout identical
• But brighter, cleaner, and more professional.

DO NOT generate new details.
DO NOT reinterpret surfaces.
DO NOT replace any visible items.

Enhance only.`;

/**
 * Stage 1A prompt for bright/daylight interiors
 *
 * Use when: Space is well lit, daytime interiors, sunlit rooms
 */
export const STAGE1A_PROMPT_BRIGHT_INTERIOR = `You are enhancing a well-lit real estate photograph for professional property marketing.

This is a QUALITY ENHANCEMENT ONLY task.

PRIMARY GOAL:
Refine clarity and tonal balance while keeping the image fully realistic and structurally identical to the original.

YOU MUST:
• Preserve the existing lighting direction and brightness
• Improve micro-clarity and texture definition gently
• Improve tonal separation between highlights, midtones, and shadows
• Recover minor highlight clipping near windows if present
• Improve image cleanliness and compression artefact reduction
• Maintain true-to-life colour balance

YOU MUST NOT:
• Add, remove, replace, or move ANY objects
• Change furniture, décor, wall art, or clutter
• Change any kitchen, bench, shelf, or table items
• Change curtains, blinds, windows, doors, or cabinetry
• Change wall colours, flooring, or fixed features
• Modify room layout, geometry, or perspective
• Add artificial lighting sources
• Stylise, dramatise, or apply HDR effects
• Over-brighten or over-contrast the image

The result must feel:
• Naturally bright
• Clean but not edited
• Professionally photographed, not AI-generated

This must look like the SAME photograph captured with:
• A higher quality lens
• Better clarity
• Better tonal control

The final result MUST be:
• Structurally identical to the original
• Object-for-object identical
• Layout-for-layout identical
• But more refined and professional.

DO NOT generate new details.
DO NOT reinterpret surfaces.
DO NOT replace any visible items.

Enhance only.`;

/**
 * Stage 1A prompt for exterior/daylight scenes - SKY_STRONG mode
 * Allows sky replacement for open-sky images
 *
 * Use when: Exterior photos with clear open sky, daylight outdoor shots, facades
 */
export const STAGE1A_PROMPT_EXTERIOR_SKY_STRONG = `You are enhancing a real estate EXTERIOR photograph taken in daylight for professional property marketing.

This is a QUALITY ENHANCEMENT task with SKY REPLACEMENT allowed.

PRIMARY GOAL:
Refine clarity, sharpness, and tonal balance while keeping the image fully realistic and structurally identical to the original. You may replace gray/overcast skies with vibrant blue sky.

YOU MUST:
• Improve global sharpness and edge clarity gently
• Improve tonal separation between sky, building, and landscaping
• Replace gray/overcast skies with vibrant blue sky and soft natural clouds
• Recover minor highlight clipping in bright sky areas if present
• Improve shadow detail under eaves and shaded zones naturally
• Reduce compression artefacts
• Maintain true-to-life exterior colour balance (no artificial saturation)

CRITICAL STRUCTURAL PROTECTION:
• NEVER remove or alter roofs, patio covers, pergolas, awnings, or overhead structures
• NEVER remove beams, rafters, gutters, soffits, or fascias
• If ANY structure overlaps the sky region, PRESERVE IT COMPLETELY
• Only enhance/replace sky AROUND structures, never through them

YOU MUST NOT:
• Add, remove, replace, or move ANY objects or structures
• Remove or alter roofs, patio covers, pergolas, carports, or awnings
• Change buildings, fencing, decking, paving, or outdoor furniture
• Change plants, trees, grass, or landscaping layout
• Change reflections in windows or doors
• Modify perspective, camera angle, or lens distortion
• Add artificial lighting, lens flares, or sun rays
• Stylise, dramatise, or apply HDR effects
• Make the image look staged, fake, or AI-generated

The result must feel:
• Naturally lit
• Clean and crisp
• Photographically accurate
• Suitable for property listings

The final result MUST be:
• Structurally identical to the original (ALL STRUCTURES PRESERVED)
• Object-for-object identical
• Layout-for-layout identical
• But cleaner, sharper, and more professional.

DO NOT remove structures that overlap sky.
DO NOT reinterpret landscaping.
DO NOT replace any visible items except sky.

Enhance only.`;

/**
 * Stage 1A prompt for exterior/daylight scenes - SKY_SAFE mode (DEFAULT)
 * Only tonal adjustments, NO sky replacement
 *
 * Use when: Exterior photos with covered areas, pergolas, patios, or uncertain sky boundaries
 */
export const STAGE1A_PROMPT_EXTERIOR_SKY_SAFE = `You are enhancing a real estate EXTERIOR photograph taken in daylight for professional property marketing.

This is a QUALITY ENHANCEMENT ONLY task.
SKY MODE: SAFE - Only tonal adjustments allowed. NO sky replacement.

PRIMARY GOAL:
Refine clarity, sharpness, and tonal balance while keeping the image fully realistic and structurally identical to the original.

YOU MUST:
• Improve global sharpness and edge clarity gently
• Improve tonal separation between sky, building, and landscaping
• For sky: ONLY adjust exposure, contrast, color balance, and dehaze - NO replacement
• Recover minor highlight clipping in bright sky areas if present
• Improve shadow detail under eaves and shaded zones naturally
• Reduce compression artefacts
• Maintain true-to-life exterior colour balance (no artificial saturation)

CRITICAL SKY RESTRICTIONS:
• DO NOT use sky replacement, inpainting, generative fill, or masking on any part of the image
• DO NOT remove or alter ANY part of the sky region
• Only apply global tonal adjustments to the existing sky
• If you CANNOT confidently identify whether a pixel region is sky or structure, PRESERVE IT UNCHANGED
• When in doubt, do nothing to the sky; a safe enhancement is better than removing structures

CRITICAL STRUCTURAL PROTECTION:
• NEVER remove or alter roofs, patio covers, pergolas, awnings, or overhead structures
• NEVER remove beams, rafters, gutters, soffits, or fascias
• If ANY structure could be mistaken for sky, PRESERVE IT COMPLETELY
• When in doubt, assume it is a structure and keep it unchanged

YOU MUST NOT:
• Replace, inpaint, or generatively fill any part of the sky
• Add, remove, replace, or move ANY objects or structures
• Remove or alter roofs, patio covers, pergolas, carports, or awnings
• Change buildings, fencing, decking, paving, or outdoor furniture
• Change plants, trees, grass, or landscaping layout
• Change sky content, cloud shapes, sun position, or weather
• Change reflections in windows or doors
• Modify perspective, camera angle, or lens distortion
• Add artificial lighting, lens flares, or sun rays
• Stylise, dramatise, or apply HDR effects
• Use inpainting, generative fill, or masking operations

The result must feel:
• Naturally lit
• Clean and crisp
• Photographically accurate
• Suitable for property listings

The final result MUST be:
• Structurally identical to the original (ALL STRUCTURES PRESERVED)
• Object-for-object identical
• Layout-for-layout identical
• But cleaner, sharper, and more professional.

DO NOT generate new sky content.
DO NOT reinterpret landscaping.
DO NOT replace any visible items.

Enhance only.`;

// Legacy alias for backwards compatibility
export const STAGE1A_PROMPT_EXTERIOR_DAYLIGHT = STAGE1A_PROMPT_EXTERIOR_SKY_SAFE;

/**
 * Calculate average luminance of an image to determine if it's dark or bright
 */
export async function getAverageLuminance(imagePath: string): Promise<number> {
  try {
    const sharp = (await import("sharp")).default;

    // Get image stats
    const stats = await sharp(imagePath).stats();

    // Calculate average luminance across all channels
    // Luminance = 0.299*R + 0.587*G + 0.114*B (standard formula)
    const avgLuminance =
      stats.channels[0].mean * 0.299 +
      stats.channels[1].mean * 0.587 +
      stats.channels[2].mean * 0.114;

    return avgLuminance;
  } catch (err) {
    console.error("[Stage1A] Error calculating luminance:", err);
    return 128; // Default to mid-brightness if error
  }
}

export type SkyMode = "safe" | "strong";

/**
 * Select the appropriate Stage 1A prompt based on scene type, lighting, and sky mode
 */
export async function selectStage1APrompt(
  sceneType: "interior" | "exterior" | string | undefined,
  inputPath: string,
  skyMode: SkyMode = "safe"
): Promise<string> {
  if (sceneType === "exterior") {
    // Use SKY_STRONG prompt only when explicitly allowed
    if (skyMode === "strong") {
      console.log(`[Stage1A] Exterior with SKY_STRONG mode - sky replacement allowed`);
      return STAGE1A_PROMPT_EXTERIOR_SKY_STRONG;
    }
    // Default to SKY_SAFE - only tonal adjustments
    console.log(`[Stage1A] Exterior with SKY_SAFE mode - tonal adjustments only`);
    return STAGE1A_PROMPT_EXTERIOR_SKY_SAFE;
  }

  // For interiors, analyze brightness
  const meanBrightness = await getAverageLuminance(inputPath);

  // Threshold: < 110 = dark interior, >= 110 = bright interior
  if (meanBrightness < 110) {
    console.log(`[Stage1A] Scene brightness: ${meanBrightness.toFixed(1)} - using DARK_INTERIOR prompt`);
    return STAGE1A_PROMPT_DARK_INTERIOR;
  } else {
    console.log(`[Stage1A] Scene brightness: ${meanBrightness.toFixed(1)} - using BRIGHT_INTERIOR prompt`);
    return STAGE1A_PROMPT_BRIGHT_INTERIOR;
  }
}
