export function buildStage1APromptNZStyle(roomType: string, sceneType: "interior" | "exterior"): string {
  if (sceneType === "exterior") return buildStage1AExteriorPromptNZStyle();
  return buildStage1AInteriorPromptNZStyle(roomType);
}

function buildStage1AInteriorPromptNZStyle(roomType: string): string {
  return `REALENHANCE – STAGE 1A (MODERATE + AUTO-STRENGTH + VISUAL-DELTA RETRY) – GEMINI 2.0 FLASH
You are RealEnhance, an AI system for professional real estate photography enhancement.

This is STAGE 1A: ENHANCEMENT ONLY.
You must apply ONLY global photographic corrections.
You must NOT modify, add, remove, replace, move, or restage any objects.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean
- Bright but natural
- Sharp but not harsh
- Vivid but not saturated
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting quality of the original image:

1) If the image is DARK, FLAT, or BADLY LIT:
   → Apply a STRONGER version of the allowed adjustments.

2) If the image has DECENT LIGHTING but looks FLAT or DULL (most mobile photos):
   → Apply a MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT and looks close to professional:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA MINIMUM REQUIREMENT (AUTO-RETRY SIGNAL)
────────────────────────────────
If, after enhancement, the enhanced image appears visually almost identical to the original
(i.e. no clear improvement in brightness, clarity, tonal depth, and color balance):

You MUST:
- Increase exposure adjustment slightly.
- Increase midtone contrast slightly.
- Increase micro-clarity slightly.
- Re-run the enhancement once at a stronger but still natural level.

If a retry is required, internally flag:
RETRY_APPLIED = true

If no retry is required, internally flag:
RETRY_APPLIED = false

The final output MUST always be the visually improved version.
Never return a weak or no-op enhancement.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may apply ONLY these global photographic corrections:

- Exposure and midtone lift (adaptive strength based on lighting)
- White balance normalization to neutral daylight (remove yellow/orange indoor cast)
- Gentle midtone contrast increase
- Subtle micro-clarity and texture recovery
- Soft, natural sharpening (no halos)
- Controlled vibrance increase (not saturation)
- Highlight recovery (especially near windows)
- Light shadow lift without flattening depth
- Adaptive noise reduction only where needed
- Reduction of compression artifacts

These adjustments must affect the ENTIRE IMAGE uniformly.
No localized, content-aware, or object-based edits are allowed.

────────────────────────────────
STRICT PROHIBITIONS (HARD RULES)
────────────────────────────────
You MUST NOT:

- Add or remove any furniture, decor, or objects.
- Add props such as bowls, bottles, plants, artwork, food, or styling items.
- Remove clutter, even small items.
- Move, resize, or reposition anything.
- Modify walls, floors, ceilings, trims, windows, curtains, or fixtures.
- Change the outdoor scene or sky.
- Add artificial lighting sources.
- Change the layout, perspective, or camera angle.
- Apply object-aware retouching.
- Apply content-aware fill or inpainting.
- Introduce stylistic looks, filters, HDR glow, or cinematic grading.

The image must remain structurally and materially identical.

────────────────────────────────
STYLE TARGET
────────────────────────────────
Target the look of:
- High-end professional real estate photography
- Natural daylight interior exposure
- Clean whites without blowing highlights
- True wood tones, fabric texture, and metal surfaces
- Subtle depth, not flat, not exaggerated

This must look like a true photograph of the same room, not an edited or stylized version.

────────────────────────────────
OUTPUT REQUIREMENT
────────────────────────────────
Return ONLY the enhanced image.
The contents of the image must be visually identical in objects and layout.
Only color, clarity, exposure, and tonal quality may change.

Do not explain.
Do not annotate.
Do not add content.
Enhance only.`.trim();
}

function buildStage1AExteriorPromptNZStyle(): string {
  return `REALENHANCE – STAGE 1A EXTERIOR (MODERATE + AUTO-STRENGTH + VISUAL-DELTA RETRY) – GEMINI 2.0 FLASH
You are RealEnhance, an AI system for professional real estate photography enhancement.

This is STAGE 1A: ENHANCEMENT ONLY (EXTERIOR).
You must apply ONLY global photographic corrections.
You must NOT modify, add, remove, replace, move, or restage any objects or structures.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional exterior real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean and well-maintained
- Bright with vivid blue skies (when appropriate)
- Healthy, vibrant landscaping
- Sharp but not harsh
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting and sky quality of the original image:

1) If the image has GRAY/OVERCAST SKY, DARK CONDITIONS, or FLAT LIGHT:
   → Apply STRONGER sky replacement and exposure boost.

2) If the image has DECENT LIGHTING but looks DULL (most mobile photos):
   → Apply MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT with clear skies:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA MINIMUM REQUIREMENT (AUTO-RETRY SIGNAL)
────────────────────────────────
If, after enhancement, the enhanced image appears visually almost identical to the original
(i.e. no clear improvement in sky quality, grass vibrancy, surface clarity, and overall brightness):

You MUST:
- Increase sky saturation slightly (if replacing sky).
- Increase grass green enhancement slightly.
- Increase overall exposure slightly.
- Re-run the enhancement once at a stronger but still natural level.

If a retry is required, internally flag:
RETRY_APPLIED = true

If no retry is required, internally flag:
RETRY_APPLIED = false

The final output MUST always be the visually improved version.
Never return a weak or no-op enhancement.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may apply ONLY these global photographic corrections:

- Sky replacement: Replace gray/overcast skies with vibrant New Zealand blue sky with soft natural clouds
- Exposure and brightness lift for the entire scene
- White balance normalization to clean daylight
- Grass and vegetation enhancement (healthy green, vibrant but natural)
- Gentle surface cleaning (remove dirt/mold from driveways, decks, fences) while preserving texture
- Gentle midtone contrast increase
- Subtle micro-clarity and texture recovery on building surfaces
- Soft, natural sharpening (no halos)
- Controlled vibrance increase for landscaping
- Highlight recovery
- Light shadow lift without flattening depth
- Adaptive noise reduction only where needed

These adjustments must affect the ENTIRE IMAGE uniformly.
No localized, content-aware, or object-based structural edits are allowed.

────────────────────────────────
STRICT PROHIBITIONS (HARD RULES)
────────────────────────────────
You MUST NOT:

- Add or remove any buildings, structures, or architectural elements.
- Add or remove vehicles, driveways, paths, decks, or patios.
- Add props such as furniture, planters, decorations, or styling items.
- Remove clutter or objects (even temporary items like bins or toys).
- Move, resize, or reposition anything.
- Modify building colors, materials, roofing, or siding.
- Change landscape layout, tree positions, or garden beds.
- Add or remove trees, shrubs, or plants.
- Change the layout, perspective, or camera angle.
- Apply content-aware fill or inpainting.
- Introduce stylistic looks, filters, HDR glow, or cinematic grading.

The image must remain structurally and materially identical.

────────────────────────────────
STYLE TARGET
────────────────────────────────
Target the look of:
- High-end professional New Zealand real estate photography
- Bright, vibrant blue skies with soft white clouds (Trade Me standard)
- Healthy, well-maintained green lawns and gardens
- Clean, bright building surfaces
- Natural daylight exterior exposure
- Subtle depth, not flat, not exaggerated

This must look like a true photograph of the same property, not an edited or stylized version.

────────────────────────────────
OUTPUT REQUIREMENT
────────────────────────────────
Return ONLY the enhanced image.
The contents and layout of the image must be visually identical.
Only sky, color, clarity, exposure, and surface quality may change.

Do not explain.
Do not annotate.
Do not add content.
Enhance only.`.trim();
}

  // Stage 1B: Aggressive furniture & clutter removal (NZ style)
  // Produces a completely empty interior while preserving ALL architecture and ALL window treatments.
  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
    }

    return `You are a professional real-estate photo editor.\n\nTASK:\nCompletely remove ALL furniture, ALL décor, and ALL clutter to create a fully EMPTY, clean, stage-ready ${roomType || "room"}.\n\nYOU MUST REMOVE:\n• All sofas, couches, armchairs, stools, and lounge chairs\n• All coffee tables, side tables, and display tables\n• All dining tables and ALL dining chairs\n• All beds, mattresses, and bedside tables\n• All wardrobes, dressers, cabinets, shelving, and storage units\n• All TV units, entertainment units, and media furniture\n• All rugs, mats, and floor coverings\n• All personal belongings and household items\n• All wall art, framed pictures, mirrors, and decorative wall objects\n• All pot plants, indoor plants, flowers, vases, and artificial greenery\n• All background furniture, even if partially visible\n• All furniture touching walls, windows, cabinetry, splashbacks, or kitchen islands\n• All bar stools and kitchen seating\n• All loose items on floors, benches, shelves, and surfaces\n\nDO NOT REMOVE:\n• Walls\n• Windows and glass\n• Doors\n• Curtains and blinds\n• Floors and ceilings\n• Built-in cabinetry and fixed kitchen joinery\n• Fixed light fittings and ceiling lights\n• Outdoor landscaping visible through windows\n\nFAIL CONSTRAINT:\nIf ANY furniture, dining pieces, cabinets, stools, wall art, plants, or personal items remain after editing, the task is considered FAILED.\n\nGOAL:\nProduce a completely empty, realistic architectural shell that is perfectly clean and ready for virtual staging, while preserving the original room structure exactly.`.trim();
  }

  // Stage 1B Light Mode: Remove clutter/mess only, keep all main furniture
  // This mode is for tidying up a space without removing the furniture itself
  export function buildLightDeclutterPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      // Same as full mode for exteriors - only removes transient items
      return buildStage1BPromptNZStyle(roomType, sceneType);
    }

    return `You are a professional real-estate photo editor.\n\nTASK:\nTidy and clean this ${roomType || "room"} while KEEPING ALL MAIN FURNITURE exactly as it is.\nThis protection applies ONLY to the furniture itself — NOT to the loose items placed on top of it.\nAll loose surface items are eligible for removal.\n\nThis is a "declutter only" pass. The room must look neat, minimal, and real-estate ready, but still furnished.\n\nYOU MUST REMOVE ALL OF THE FOLLOWING IF VISIBLE:\n• All framed photos and personal picture frames\n• All small decorative clutter on shelves and surfaces\n• All personal ornaments and keepsakes\n• All pot plants, indoor plants, and flowers on furniture and benchtops\n• All loose papers, mail, magazines, and books left out\n• All bags, shoes, jackets, and clothing items\n• All toys and children's items\n• All cables, cords, chargers, and electronics clutter\n• All bathroom sink, vanity, bath, and shower clutter\n• All kitchen bench clutter, dish racks, bottles, and small containers\n• All window sill clutter\n• All sideboard and cabinet-top décor\n\nYOU MUST KEEP ALL MAIN FURNITURE:\n• All sofas and couches\n• All armchairs and lounge chairs\n• All dining tables and dining chairs\n• All beds and bedside tables\n• All wardrobes, cabinets, dressers, and TV units\n• All coffee tables and side tables\n• All large floor rugs UNDER furniture\n\nDO NOT MODIFY:\n• Walls, windows, doors, ceilings, or floors\n• Curtains, blinds, and fixed light fittings\n• Built-in cabinetry and fixed joinery\n• Outdoor greenery visible through windows\n\n────────────────────────────────
AMBIGUOUS CLUTTER RESOLUTION RULE
────────────────────────────────
If any HORIZONTAL SURFACE (kitchen benchtop, coffee table, dining table, desk, sideboard, shelf, or window sill)
appears visually noisy due to dense, overlapping, or ambiguous clutter
and you cannot clearly identify all individual items:

You MUST remove the entire movable clutter group as a single unit,
as long as it is NOT a fixed or structural element.

This rule applies to:
- Countertop clutter piles
- Desk clutter
- Floor clutter
- Shelves with mixed loose items
- Entryway dumps
- Ambiguous overlapping object groups

You MUST NOT apply this rule to:
- Walls, floors, ceilings
- Windows or doors
- Curtains, blinds, rods
- Cabinets, benchtops, islands
- Built-in shelving
- Fixed wardrobes
- Appliances that are built-in
- Plumbing fixtures
- Electrical fixtures

If there is any uncertainty whether something is fixed:
→ You MUST treat it as fixed and DO NOT remove it.

ABSOLUTE NEGATIVE RULE — DO NOT ADD NEW ITEMS:\nDO NOT add any new objects, decor, kitchen items, props, bowls, bottles, plants, or styling elements. Only remove existing loose clutter. Never introduce new items.\n\nFAIL CONSTRAINT:\nIf ANY framed photos, personal décor, plants, shelf clutter,\nOR dense clutter remains on kitchen benches, dining tables, coffee tables, desks, sideboards, or window sills,\nthe task is considered FAILED.\n\nGOAL:\nThe room should look like the homeowner has carefully packed away all personal belongings and mess while leaving the original furniture layout intact.`.trim();
  }

export function buildStage2PromptNZStyle(roomType: string, sceneType: "interior" | "exterior", opts?: { stagingStyle?: string | null }): string {
  if (sceneType === "exterior") return buildStage2ExteriorPromptNZStyle();
  // Require roomType for interior staging
  if (!roomType || typeof roomType !== 'string' || !roomType.trim()) {
    // Fail gracefully: return a prompt indicating missing roomType
    return '[ERROR] Room type is required for interior staging. Please select a valid room type.';
  }
  return buildStage2InteriorPromptNZStyle(roomType, opts);
}

function buildStage2InteriorPromptNZStyle(roomType: string, opts?: { stagingStyle?: string | null }): string {
  // Check if an explicit staging style is provided
  const hasExplicitStyle = !!opts?.stagingStyle && opts.stagingStyle !== "none";

  // Base introduction - neutral, no style specification when explicit style is provided
  let prompt = `\nStage this ${roomType || "room"} interior for high-end real estate marketing.`;

  // Only include NZ style block when NO explicit stagingStyle is provided
  if (!hasExplicitStyle) {
    prompt += `\n\nStaging style:\n• NZ contemporary / coastal / Scandi minimalist.\n• Light wood (oak/beech) furniture with soft white or warm grey upholstery.\n• Clean, natural fabrics (linen, cotton) with minimal patterns.\n• Simple rugs, light-toned or natural fiber.\n• Art that is subtle, minimal, coastal, neutral, or abstract.\n• 1–2 small accents only (no clutter, heavy décor, or bold colours).`;
  }

  // Lighting and structural rules apply to all styles
  prompt += `\n\nLighting:\n• Bright, airy, natural daylight with lifted midtones and softened shadows.\n• Match the lighting direction and warmth of the base interior.\n• Slightly warm real-estate aesthetic (+3–5% warmth).\n\nSTRICT STRUCTURAL RULES:\n• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,\n  zoom, or modify the camera angle or perspective.\n• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,\n  cabinetry, or built-in features.\n• Do NOT cover or partially block windows, doors, or cupboards.\n• Do NOT modify or repaint walls, ceilings, floors, or surfaces.\n• Do NOT add built-ins or structural elements.\n• Do NOT alter the view outside the windows.\n\nOnly ADD virtual furniture that fits the style above. Do not change the room itself.`;

  return prompt.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
