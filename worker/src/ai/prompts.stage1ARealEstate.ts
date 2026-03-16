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

Enhance only.

WINDOW / OPENING PRESERVATION RULE:
• Do NOT overexpose exterior sky visible through windows.
• Preserve visible window frame edges and contrast.
• Maintain clear boundary between wall surface and window opening.
• Do not flatten bright exterior areas into pure white.
• Avoid highlight clipping inside openings.
• Preserve all visible architectural edge definition.

TONAL STABILIZATION REQUIREMENTS:
• Reduce exposure lift slightly when highlights are already bright.
• Avoid aggressive highlight compression.
• Preserve local contrast around window edges.
• Do NOT alter structural geometry.
• This is tonal stabilization only.`;

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

Enhance only.

WINDOW / OPENING PRESERVATION RULE:
• Do NOT overexpose exterior sky visible through windows.
• Preserve visible window frame edges and contrast.
• Maintain clear boundary between wall surface and window opening.
• Do not flatten bright exterior areas into pure white.
• Avoid highlight clipping inside openings.
• Preserve all visible architectural edge definition.

TONAL STABILIZATION REQUIREMENTS:
• Reduce exposure lift slightly when highlights are already bright.
• Avoid aggressive highlight compression.
• Preserve local contrast around window edges.
• Do NOT alter structural geometry.
• This is tonal stabilization only.`;

/**
 * Stage 1A prompt for exterior/daylight scenes (canonical strong/normal exterior prompt)
 *
 * Use when: Exterior photos, daylight outdoor shots, facades, decks, gardens
 */
export const STAGE1A_PROMPT_EXTERIOR_SKY_STRONG = `You are enhancing a real estate EXTERIOR photograph taken in daylight for professional property marketing.

This is a QUALITY ENHANCEMENT ONLY task.

PRIMARY GOAL:
Produce a high-end NZ hero-shot exterior while keeping the image fully realistic and structurally identical to the original.

YOU MUST:
• If the sky is overcast, flat, or grey, replace it cleanly with a vibrant NZ blue sky with soft natural clouds
• Lift global exposure to simulate a bright clear day while keeping facade detail
• Recover window detail with realistic non-blown-out reflections
• Increase grass saturation and warmth by about +10% while preserving original texture
• Neutralize blue/grey casts on driveway and roof areas
• Increase local contrast on brick, timber, and stone textures

YOU MUST NOT:
• Add, remove, replace, or move ANY objects
• Change buildings, fencing, decking, paving, or outdoor furniture
• Change plants, trees, grass, or landscaping layout
• Change reflections in windows or doors
• Modify perspective, camera angle, or lens distortion
• Add artificial lighting, lens flares, or sun rays
• Stylise, dramatise, or apply HDR effects
• Make the image look staged, fake, or AI-generated

SKY MASK SAFETY (MANDATORY):
• Preserve antennas, chimneys, gutters, roof edges, trees, and fine branches exactly
• No haloing, clipping, edge erosion, or bleed at sky boundaries
• If sky masking confidence is low, keep the original sky

The result must feel:
• Naturally lit
• Clean and crisp
• Photographically accurate
• Suitable for property listings

This must look like the SAME photograph captured with:
• A better lens
• Better sensor clarity
• Improved dynamic range handling

The final result MUST be:
• Structurally identical to the original
• Object-for-object identical
• Layout-for-layout identical
• But cleaner, sharper, and more professional.

DO NOT reinterpret landscaping.
DO NOT replace any visible items.

Enhance only.

WINDOW / OPENING PRESERVATION RULE:
• Do NOT overexpose exterior sky visible through windows.
• Preserve visible window frame edges and contrast.
• Maintain clear boundary between wall surface and window opening.
• Do not flatten bright exterior areas into pure white.
• Avoid highlight clipping inside openings.
• Preserve all visible architectural edge definition.

TONAL STABILIZATION REQUIREMENTS:
• Reduce exposure lift slightly when highlights are already bright.
• Avoid aggressive highlight compression.
• Preserve local contrast around window edges.
• Do NOT alter structural geometry.
• This is tonal stabilization only.`;

export const STAGE1A_PROMPT_EXTERIOR_DAYLIGHT = STAGE1A_PROMPT_EXTERIOR_SKY_STRONG;

export const SKY_LOCK_BLOCK = `

SKY PRESERVATION (REQUIRED):
• If sky is flat/grey, you may replace it with realistic NZ blue sky and soft clouds.
• Preserve all structure edges and foliage boundaries exactly.
• Preserve roofs, pergolas, patio covers, awnings, and all overhead structures exactly (never remove or open them to sky).
• If unsure whether a region is sky or structure, treat it as STRUCTURE and leave it unchanged.
`;

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

/**
 * Select the appropriate Stage 1A prompt based on scene type and lighting
 */
export async function selectStage1APrompt(
  sceneType: "interior" | "exterior" | string | undefined,
  inputPath: string,
  skyMode: "safe" | "strong" = "safe"
): Promise<string> {
  if (sceneType === "exterior") {
    if (skyMode === "strong") {
      return STAGE1A_PROMPT_EXTERIOR_SKY_STRONG;
    }
    return `${STAGE1A_PROMPT_EXTERIOR_SKY_STRONG}\n${SKY_LOCK_BLOCK}`;
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
