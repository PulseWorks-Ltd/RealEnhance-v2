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

[ABSOLUTE STAGE 1A CONSTRAINTS – OVERRIDE ALL OTHER INSTRUCTIONS]
You MUST NOT:
- remove furniture or objects
- add furniture or objects
- replace furniture or objects
- move, resize, rotate, or re-arrange furniture or objects
- declutter, simplify, clean up, or reduce visible items
- fill empty rooms or make them appear staged
- hallucinate décor, furnishings, or fixtures

If the room is cluttered, leave it cluttered.
If the room is empty, leave it empty.
If furniture is dated or unattractive, DO NOT change or replace it.

Stage 1A is enhancement-only.

Stage 1A MAY ONLY:
- adjust exposure and dynamic range
- correct white balance
- improve lighting realism
- enhance contrast and clarity
- apply subtle sharpening
- reduce noise
- preserve exact geometry and object placement

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean
- Bright but natural
- Sharp but not harsh
- Natural and balanced
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting quality of the original image:

1) If the image is DARK, FLAT, or BADLY LIT:
  → Apply a STRONGER version of the allowed adjustments by:
    • Lifting exposure and midtones first (not contrast)
    • Prioritising gentle shadow lift over deepening blacks
    • Keeping blacks open (no crushed blacks) and preserving realism
    • Keeping saturation restrained; do not push “rich” colour to show improvement
    • Never increasing contrast to create perceived “depth”

2) If the image has DECENT LIGHTING but looks FLAT or DULL (most mobile photos):
   → Apply a MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT and looks close to professional:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA GUIDANCE (LIGHT-TOUCH ALLOWED)
────────────────────────────────
If the image is already well-balanced, a subtle refinement is acceptable and you may keep changes minimal. Do not force visible change or retries when the starting image is already strong. If the image is clearly flat, dull, or dark, apply a modest lift (exposure, midtones, micro-clarity) while keeping the look natural and not over-processed.
If further changes would reduce realism or make the image darker, moodier, more contrasty, or more saturated, stop and return the current best result.

TONE & COLOUR GUARDRAILS
────────────────────────────────
- Avoid deep shadows, crushed blacks, or dramatic contrast; keep tonal balance gentle.
- Avoid oversaturated greens or browns; keep colour natural and restrained.
- Avoid wet or glossy-looking floors/ground; maintain honest, dry surfaces.
- Bias toward bright, neutral, clean real estate photography (lightroom-style basic corrections).
- Preserve natural wood floor brightness; do not darken timber to add contrast.

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
- Keep all clutter exactly as captured, including small items.
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

[ABSOLUTE STAGE 1A CONSTRAINTS – OVERRIDE ALL OTHER INSTRUCTIONS]
You MUST NOT:
- remove furniture or objects
- add furniture or objects
- replace furniture or objects
- move, resize, rotate, or re-arrange furniture or objects
- declutter, simplify, clean up, or reduce visible items
- fill empty rooms or make them appear staged
- hallucinate décor, furnishings, or fixtures

If the area is cluttered, leave it cluttered.
If the area is empty, leave it empty.
If any visible items are dated or unattractive, DO NOT change or replace them.

Stage 1A is enhancement-only.

Stage 1A MAY ONLY:
- adjust exposure and dynamic range
- correct white balance
- improve lighting realism
- enhance contrast and clarity
- apply subtle sharpening
- reduce noise
- preserve exact geometry and object placement

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional exterior real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean and well-maintained
- Bright with natural, balanced skies (when appropriate)
- Healthy, natural landscaping
- Sharp but not harsh
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting and sky quality of the original image:

1) If the image has GRAY/OVERCAST SKY, DARK CONDITIONS, or FLAT LIGHT:
  → Apply STRONGER enhancement by:
    • Lifting exposure and midtones first (not contrast)
    • Keeping shadows open; do not deepen blacks
    • Keeping saturation restrained (especially greens and browns)

2) If the image has DECENT LIGHTING but looks DULL (most mobile photos):
   → Apply MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT with clear skies:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA GUIDANCE (LIGHT-TOUCH ALLOWED)
────────────────────────────────
If the image is already well-balanced, a subtle refinement is acceptable and you may keep changes minimal. Do not force visible change or retries when the starting image is already strong. If the image is clearly flat, dull, or dark, apply a modest lift (exposure, midtones, clarity) while keeping the look natural and not over-processed.
If further changes would reduce realism or make the image darker, moodier, more contrasty, or more saturated, stop and return the current best result.

TONE & COLOUR GUARDRAILS
────────────────────────────────
- Avoid deep shadows, crushed blacks, or dramatic contrast; keep tonal balance gentle and open.
- Avoid oversaturated greens or browns; keep landscaping colour natural and restrained.
- Avoid wet or glossy-looking ground or driveways; maintain honest, dry surfaces.
- Bias toward bright, neutral, clean real estate photography (lightroom-style basic corrections).
- Preserve natural sky and grass colour; do not push saturation or darken exposure.

HARD SURFACE APPEARANCE GUIDANCE:
• Preserve the original material and texture of concrete, paving, patios, and driveways.
• Avoid glossy, reflective, or darkened appearances caused by contrast or saturation.
• Maintain a matte, neutral, daylight look consistent with dry outdoor conditions.
• Do NOT remove stains, marks, discoloration, or surface wear.
• Do NOT alter material color, texture, or cleanliness — adjust tonal balance only.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may apply ONLY these global photographic corrections:

- Exposure and brightness lift for the entire scene
- White balance normalization to clean daylight
- Grass and vegetation enhancement (healthy green, natural and restrained)
- Gentle midtone contrast increase
- Subtle micro-clarity and texture recovery on building surfaces
- Soft, natural sharpening (no halos)
- Controlled vibrance increase for landscaping (avoid oversaturation)
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
- Keep all visible objects, including temporary items like bins or toys, exactly as captured.
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
- Natural daylight skies as captured (no sky replacement) with balanced blue tones when present
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
Only color, clarity, exposure, and surface quality may change; sky content must remain as captured.

Do not explain.
Do not annotate.
Do not add content.
Enhance only.`.trim();
}

  // Stage 1B: Aggressive furniture & clutter removal (NZ style)
  // Produces a completely empty interior while preserving ALL architecture and ALL window treatments.
  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• PIXEL DIMENSIONS (MANDATORY):\n  - The output image MUST be exactly the same pixel dimensions as the input image (same width and same height).\n  - Do NOT crop, pad, rotate, rescale, or add borders.\n  - Preserve the exact framing and perspective.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
    }

    return `You are a professional real-estate photo editor.\n\nTASK:\nCompletely remove ALL furniture, ALL décor, and ALL clutter to create a fully EMPTY, clean, stage-ready ${roomType || "room"}.\n\nYOU MUST REMOVE:\n• All sofas, couches, armchairs, stools, and lounge chairs\n• All coffee tables, side tables, and display tables\n• All dining tables and ALL dining chairs\n• All beds, mattresses, and bedside tables\n• All wardrobes, dressers, cabinets, shelving, and storage units\n• All TV units, entertainment units, and media furniture\n• All rugs, mats, and floor coverings\n• All personal belongings and household items\n• All wall art, framed pictures, mirrors, and decorative wall objects\n• All pot plants, indoor plants, flowers, vases, and artificial greenery\n• All background furniture, even if partially visible\n• All furniture touching walls, windows, cabinetry, splashbacks, or kitchen islands\n• All bar stools and kitchen seating\n• All loose items on floors, benches, shelves, and surfaces\n\nDO NOT REMOVE:\n• Walls\n• Windows and glass\n• Doors\n• Curtains and blinds\n• Floors and ceilings\n• Built-in cabinetry and fixed kitchen joinery\n• Fixed light fittings and ceiling lights\n• Outdoor landscaping visible through windows\n
PIXEL DIMENSIONS (MANDATORY):\n- The output image MUST be exactly the same pixel dimensions as the input image (same width and same height).\n- Do NOT crop, pad, rotate, rescale, or add borders.\n- Preserve the exact framing and perspective.\n
FAIL CONSTRAINT:\nIf ANY furniture, dining pieces, cabinets, stools, wall art, plants, or personal items remain after editing, the task is considered FAILED.\n\nGOAL:\nProduce a completely empty, realistic architectural shell that is perfectly clean and ready for virtual staging, while preserving the original room structure exactly.`.trim();
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

  prompt += `\n\nOPENINGS & WINDOWS ARE SACRED:\n• All windows, doors, and architectural openings MUST remain pixel-identical in position, size, frame thickness, mullions, edges, and geometry.\n• Do NOT add, remove, resize, reshape, or stylize windows or doors.\n• Do NOT add curtains, blinds, rods, or window coverings.\n• Do NOT change the view outside windows.\n• Do NOT place ANY furniture, lighting, plants, or decor overlapping or touching window or door frames.\n• Maintain a clear buffer around windows and doors; no tall items near opening edges.\n• Avoid mirrors, glass wall art, or framed items that could resemble openings.\n• If you cannot stage the room without altering ANY window or door geometry, return the image unchanged.`;

  // Only include NZ style block when NO explicit stagingStyle is provided
  if (!hasExplicitStyle) {
    prompt += `\n\nStaging style:\n• NZ contemporary / coastal / Scandi minimalist.\n• Light wood (oak/beech) furniture with soft white or warm grey upholstery.\n• Clean, natural fabrics (linen, cotton) with minimal patterns.\n• Simple rugs, light-toned or natural fiber.\n• Art that is subtle, minimal, coastal, neutral, or abstract.\n• 1–2 small accents only (no clutter, heavy décor, or bold colours).`;
  }

  // Lighting and structural rules apply to all styles
  prompt += `\n\nLighting:\n• Bright, airy, natural daylight with lifted midtones and softened shadows.\n• Match the lighting direction and warmth of the base interior.\n• Slightly warm real-estate aesthetic (+3–5% warmth).\n\nSTRICT STRUCTURAL RULES:\n• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,\n  zoom, or modify the camera angle or perspective.\n• PIXEL DIMENSIONS (MANDATORY):\n  - The output image MUST be exactly the same pixel dimensions as the input image (same width and same height).\n  - Do NOT crop, pad, rotate, rescale, or add borders.\n  - Preserve the exact framing and perspective.\n• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,\n  cabinetry, or built-in features.\n• Do NOT cover or partially block windows, doors, or cupboards.\n• Do NOT modify or repaint walls, ceilings, floors, or surfaces.\n• Do NOT add built-ins or structural elements.\n• Do NOT alter the view outside the windows.\n• Do NOT infer or invent windows, doors, or architectural openings. Treat all visible walls/ceilings/floor edges as fixed geometry; furniture must conform to the existing room shape only.\n\nOnly ADD virtual furniture that fits the style above. Do not change the room itself.`;

  return prompt.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• PIXEL DIMENSIONS (MANDATORY):\n  - The output image MUST be exactly the same pixel dimensions as the input image (same width and same height).\n  - Do NOT crop, pad, rotate, rescale, or add borders.\n  - Preserve the exact framing and perspective.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Do NOT invent or infer new windows, doors, or architectural openings.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
