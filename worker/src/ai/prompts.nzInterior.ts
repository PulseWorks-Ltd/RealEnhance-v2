export function buildStage1AInteriorPromptNZStandard(roomType: string): string {
  return `REALENHANCE — STAGE 1A INTERIOR ENHANCEMENT (NZ HIGH-END)

TASK:
Perform a professional 'Flambient' style development.
Treat this as a light-balancing exercise, NOT a repainting exercise.

I. TEXTURE & MICRO-CONTRAST LOCK (CRITICAL)
- PRESERVE SURFACE DEPTH: Do NOT 'white-over' or flatten horizontal surfaces.
- SPECIFIC ANCHORS: The grain of timber tables, the mottled texture of stone countertops, and the weave of fabric must remain visible and detailed.
- BLACK POINT: Maintain deep, rich blacks in shadows (under furniture, in corners) to provide architectural depth. If a surface loses its texture, the exposure is too high.

II. WINDOW RECOVERY (THE 'WINDOW PULL')
- EXTERIOR VISIBILITY: The view through windows must be clearly visible and exposure-matched to the interior.
- NO BLEEDING: Highlights from windows must not bleed onto sills or walls. Architectural boundaries must remain tack-sharp.

III. PHOTOMETRIC ADJUSTMENTS
- LUMINOUS AIRY FEEL: Lift midtones, but anchor the highlights.
- WHITE BALANCE: Target 'Gallery White' (Neutral 5500K). Remove muddy yellow or blue-grey casts without making the room look sterile or blue.
- DEPTH PRESERVATION: Maintain natural light fall-off in corners to ensure 3D volume.

IV. EXTERIOR VIEW PRESERVATION (INTERIOR IMAGES ONLY)
- Treat all views through windows, doors, and glass openings as fixed architectural elements.
- NO SKY ENHANCEMENT: Do not change sky color, add clouds, or replace blown-out window regions with synthetic sky.
- NO LANDSCAPING ALTERATIONS: Do not add, saturate, or modify exterior foliage, trees, lawns, or gardens.
- NO OUTDOOR COLOR SHIFTS: Interior white-balance and exposure corrections must not alter outdoor content or color.

V. STRUCTURAL & DEPTH LOCK
- ARCHITECTURAL INTEGRITY: Maintain 100% accuracy. Do not warp, rotate, or change perspective.
- OPENING PRESERVATION: Preserve the 'void' of doorways and halls. Do not paint over dark openings; they must remain clear architectural penetrations.
- NO STAGING: Do not add or move any objects or furniture.

The final result must look like a high-end, professionally edited photograph from a top-tier NZ real estate agency.`.trim();
}

export function buildStage1AInteriorPromptNZHighEnd(roomType: string): string {
  // Keep high-end mode on the same structural-safe Pro-Camera directive for consistency.
  return buildStage1AInteriorPromptNZStandard(roomType);
}
