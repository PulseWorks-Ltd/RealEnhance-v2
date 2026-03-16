export function buildStage1AInteriorPromptNZStandard(roomType: string): string {
  return `As a professional real estate photography editor, enhance this ${roomType || "room"} to meet high-end New Zealand listing standards. Your goal is to replicate a professional full-frame camera look using multi-exposure bracketed (HDR) techniques.

I. LIGHTING & EXPOSURE (PRO-CAMERA SIMULATION)
- BRIGHTNESS: Lift midtones and shadows to create an airy, open-home feel. Ensure corners and back walls are well-illuminated without muddy noise.
- WINDOW PULL: Recover detail in all window/door apertures. The exterior view must be clearly visible, properly saturated, and NOT blown out or clipped to white.
- DYNAMIC RANGE: Balance exposure so interior details and exterior views coexist realistically, mimicking a professional flambient (flash + ambient) shot.
- CONTRAST: Increase local contrast (clarity) on architectural junctions (baseboards, window frames, door trims) to create crisp, high-definition edges.

II. COLOR & SATURATION (NEUTRALIZATION)
- WHITE BALANCE: Neutralize all color casts. Identify white surfaces (ceilings, window trims, baseboards) and ensure they render as clean, neutral whites, removing yellow tungsten or blue daylight tints.
- SATURATION: Apply +5% selective saturation to natural textures (wood flooring, carpets, exterior greenery) while maintaining neutral tones for walls and ceilings.
- VIBRANCY: Enhance the sunny-day feel by lifting global vibrancy slightly without altering the original color family of the room.

III. STRUCTURAL INTEGRITY (ARCHITECTURAL LOCK)
- GEOMETRY: Maintain 100% architectural accuracy. Do not rotate, straighten, crop, reframe, or warp perspective.
- PERMANENT FEATURES: Do not add, remove, or modify walls, floors, ceilings, windows, doors, or built-in fixtures.
- NO STAGING: Do not add, remove, or move any furniture or decor.
- DEPTH VOIDS: Do not fill in dark openings. Doorways to other rooms must remain visible as dark penetrative voids to preserve floor-plan logic.

IV. FINAL OUTPUT QUALITY
- Ensure the image is sharp, clear, and noise-free.
- Avoid aggressive highlight compression that makes the image look flat or grey.
- Final output must look like a professional, high-end photograph taken with a tripod-mounted DSLR.

WINDOW / OPENING PRESERVATION RULE:
- Do NOT overexpose exterior sky visible through windows.
- Preserve visible window frame edges and contrast.
- Maintain clear boundary between wall surface and window opening.
- Do not flatten bright exterior areas into pure white.
- Avoid highlight clipping inside openings.
- Preserve all visible architectural edge definition.

Your only task is to optimize lighting, color, and clarity of the existing room. Do not alter structure, geometry, layout, or contents.`.trim();
}

export function buildStage1AInteriorPromptNZHighEnd(roomType: string): string {
  // Keep high-end mode on the same structural-safe Pro-Camera directive for consistency.
  return buildStage1AInteriorPromptNZStandard(roomType);
}
