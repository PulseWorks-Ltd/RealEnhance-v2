export function buildStage1AInteriorPromptNZStandard(roomType: string): string {
  return `As a professional real estate photography editor, enhance this room to meet high-end New Zealand 'High-Key' listing standards. Your goal is to create a bright, sunny, and airy 'Open-Home' atmosphere.

I. ILLUMINATION & HIGH-KEY EXPOSURE
- GLOBAL BRIGHTNESS: Aggressively lift midtones and shadows to achieve a high-key, luminous look. The room should feel filled with natural light.
- WALL & CEILING TARGET: Target a clean, bright white-point for all white surfaces. Remove any dull grey or muddy tones from corners and back walls.
- DIGITAL HDR BALANCE: Simulate an over-exposed interior look that is balanced by a perfectly exposed 'Window Pull.' Recover exterior garden/sky detail so it is crisp and saturated, never blown out.
- LUMINANCE: Ensure the overall image is significantly brighter than the original, prioritizing a 'sunny day' feel over literal shadow accuracy.

II. COLOR & CHROMATIC PURITY
- WHITE BALANCE: Aggressively neutralize yellow (tungsten) or blue (daylight) casts. All trims, ceilings, and doors must render as pure, crisp, neutral whites.
- VIBRANCY: Apply +8% saturation to natural elements (wood floors, carpets, and outdoor greenery) to make the space feel inviting and vibrant.

III. STRUCTURAL & DEPTH LOCK
- ARCHITECTURAL INTEGRITY: Maintain 100% accuracy. Do not warp, rotate, or change perspective.
- OPENING PRESERVATION: Preserve the 'void' of doorways and halls. Do not paint over dark openings; they must remain clear architectural penetrations.
- NO STAGING: Do not add or move any objects or furniture.

The final result must look like a high-end, professionally edited photograph from a top-tier NZ real estate agency.`.trim();
}

export function buildStage1AInteriorPromptNZHighEnd(roomType: string): string {
  // Keep high-end mode on the same structural-safe Pro-Camera directive for consistency.
  return buildStage1AInteriorPromptNZStandard(roomType);
}
