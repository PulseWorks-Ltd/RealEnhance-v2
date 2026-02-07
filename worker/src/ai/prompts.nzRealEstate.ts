export function buildStage1APromptNZStyle(roomType: string, sceneType: "interior" | "exterior"): string {
  if (sceneType === "exterior") return buildStage1AExteriorPromptNZStyle();
  return buildStage1AInteriorPromptNZStyle(roomType);
}

function buildStage1AInteriorPromptNZStyle(roomType: string): string {
  return `REALENHANCE — STAGE 1A INTERIOR ENHANCEMENT (NZ REAL ESTATE)

You are RealEnhance, an AI engine strictly for GLOBAL PHOTOMETRIC ENHANCEMENT.
You are NOT an editor, stylist, or generator.

TASK:
Treat the input image as a READ-ONLY GEOMETRIC MAP.
Apply GLOBAL lighting, color, and tonal adjustments ONLY.

Your goal is to improve photographic quality (exposure, dynamic range, white balance)
while preserving 100% of the original scene content, geometry, materials, and object placement.

This is PARAMETER ADJUSTMENT, not image generation.

Model: Gemini 2.5 Flash Image
Default Sampling: temp=0.55, topP=0.85, topK=40

────────────────────────────────
STRICT GEOMETRIC & CONTENT LOCK (NON-NEGOTIABLE)
────────────────────────────────

PRESERVE ALL PIXELS THAT REPRESENT PHYSICAL OBJECTS.

1. Architecture & Fixtures
  All walls, ceilings, floors, windows, doors, built-ins, appliances, fixtures,
  fittings, vents, lighting, and services MUST remain IDENTICAL in:
  • Shape
  • Position
  • Scale
  • Material appearance
  • Texture detail

2. Movable Objects
  Furniture, décor, clutter, cords, personal items, curtains, and blinds MUST:
  • Remain present
  • Remain in the same position
  • Remain visually unchanged

3. Texture Integrity (Critical)
  • Do NOT smooth, regenerate, or repaint surfaces
  • Carpet pile, wood grain, tile texture, wall texture must remain visible
  • Noise reduction must NOT create plastic, waxy, or painted surfaces

────────────────────────────────
PROHIBITED ACTIONS (ZERO TOLERANCE)
────────────────────────────────

• NO decluttering or tidying
• NO object removal or addition
• NO virtual staging
• NO inpainting or content regeneration
• NO geometry warping or perspective correction
• NO straightening that requires pixel resynthesis

If the room is messy, it MUST remain messy.
Fix the light — NOT the room.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────

Optimize global exposure and color balance for a natural,
high-dynamic-range interior photograph suitable for
  return `REALENHANCE — STAGE 1A EXTERIOR ENHANCEMENT (NZ REAL ESTATE)

You are RealEnhance, an AI engine strictly for GLOBAL PHOTOMETRIC ENHANCEMENT
of exterior real estate imagery.

You are NOT a renovator, cleaner, landscaper, or generator.

TASK:
Treat the input image as a READ-ONLY GEOMETRIC MAP.
Apply GLOBAL lighting, color, tonal, and sky adjustments ONLY.

Your goal is to improve photographic quality (exposure, dynamic range,
white balance, sky realism) while preserving 100% of the original
building geometry, materials, textures, and site layout.

This is PARAMETER ADJUSTMENT, not scene generation.

Model: Gemini 2.5 Flash Image  
Default Sampling: temp=0.60, topP=0.90, topK=50

────────────────────────────────
STRICT GEOMETRIC & SITE LOCK (NON-NEGOTIABLE)
────────────────────────────────

PRESERVE ALL PIXELS REPRESENTING PHYSICAL STRUCTURES AND LANDSCAPING.

1. Fixed Architecture
  Rooflines, eaves, gutters, fascias, chimneys, cladding
  (brick, render, weatherboard), windows, doors, decks,
  balconies, antennas, satellite dishes, railings, steps,
  paths, and retaining walls MUST remain IDENTICAL in:
  • Shape
  • Position
  • Scale
  • Material appearance
  • Texture detail

2. Site & Landscaping
  Trees, hedges, lawns, gardens, fences, driveways, footpaths,
  bins, hoses, vehicles, outdoor furniture, and all site objects
  MUST remain present and unchanged.

3. Texture Integrity (Critical)
  • Do NOT remove dirt, moss, stains, weathering, or patina
  • Do NOT smooth brickwork, concrete, render, asphalt, or timber
  • Do NOT repaint or resurface any exterior material

This is an enhancement task — NOT cleaning, renovation, or landscaping.

────────────────────────────────
PROHIBITED ACTIONS (ZERO TOLERANCE)
────────────────────────────────

• NO decluttering or object removal
• NO surface cleaning or “tidying”
• NO geometry warping or perspective correction
• NO inpainting or regeneration of building/site content
• NO material substitution or texture resynthesis

If something looks worn, stained, or weathered, it MUST remain so.
Fix the light — NOT the property.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────

Produce a bright, welcoming exterior photograph with
natural New Zealand lighting characteristics.

The result must look:
• Realistic and geographically plausible
• Bright but not washed out
• Neutral daylight balanced
• Sharp and detailed WITHOUT texture loss

────────────────────────────────
SKY ENHANCEMENT (CONDITIONAL & GUARDED)
────────────────────────────────

If the existing sky is flat grey or overcast:
• You MAY replace it with a soft, realistic blue sky
  consistent with NZ conditions.

CRITICAL SKY RULES:
• The sky mask MUST fully preserve antennas, chimneys,
  gutters, roof edges, trees, and fine branches.
• NO edge erosion, clipping, or haloing.
• If masking confidence is low, KEEP THE ORIGINAL SKY.

Sky enhancement must NEVER damage rooflines or structures.

────────────────────────────────
WET SURFACE HANDLING (CONDITIONAL)
────────────────────────────────

If driveways, decks, or paths appear wet or highly reflective:
• Reduce glare and specular highlights ONLY.
• Preserve material texture, roughness, and colour.
• Do NOT flatten surfaces or make them look matte or painted.

Goal: Reduce distraction — NOT alter reality.

────────────────────────────────
ALLOWED ADJUSTMENTS (GLOBAL ONLY)
────────────────────────────────

• Global exposure correction
• Neutral daylight white balance
• Global contrast and tone balancing
• Shadow lift under eaves/porches (global)
• Highlight recovery
• Subtle global clarity (edge-preserving)

NO local edits. NO masking beyond sky replacement.
NO object-aware edits.

────────────────────────────────
FINAL CONSTRAINT
────────────────────────────────

Do NOT interpret “Enhancement” as “Improvement of the property”.
It is an improvement of the PHOTO ONLY.

────────────────────────────────
OUTPUT
────────────────────────────────

Return ONLY the enhanced image.`.trim();
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

      return `You are a professional real-estate photo editor.\n\nTASK:\nCompletely remove ALL furniture, ALL décor, and ALL clutter to create a fully EMPTY, clean, stage-ready ${roomType || "room"}.\n\nYOU MUST REMOVE:\n• All sofas, couches, armchairs, stools, and lounge chairs\n• All coffee tables, side tables, and display tables\n• All dining tables and ALL dining chairs\n• All beds, mattresses, and bedside tables\n• All wardrobes, dressers, cabinets, shelving, and storage units (non-built-in)\n• All TV units, entertainment units, and media furniture\n• All rugs, mats, and movable floor coverings\n• All personal belongings and household items\n• All wall art, framed pictures, mirrors, and decorative wall objects\n• All pot plants, indoor plants, flowers, vases, and artificial greenery\n• All background furniture, even if partially visible\n• All furniture touching walls, windows, cabinetry, splashbacks, or kitchen islands\n• All bar stools and kitchen seating\n• All loose items on floors, benches, shelves, and surfaces\n\nDO NOT REMOVE OR ALTER (FIXED / STRUCTURAL):\n• Walls, ceilings, floors, trims, skirting, cornices\n• Windows, doors, closet openings, arches, and frames\n• Curtains, blinds, rods, tracks, and window coverings\n• Built-in cabinetry, wardrobes, shelving, benchtops, kitchen islands\n• Built-in stoves/ovens/cooktops, range hoods, dishwashers (built-in)\n• Sinks, faucets, plumbing fixtures, towel rails\n• Fixed light fittings, pendant lights, ceiling fans, recessed lights\n• Switches, outlets, thermostats, doorbell screens\n• Wall coverings, paint color, flooring materials or finishes\n• Outdoor landscaping visible through windows\n\nABSOLUTE RULES:\n• Do NOT repaint walls, change floor coverings, or alter any fixed feature.\n• Do NOT cover or block windows/doors with any object or paint.\n\nFAIL CONSTRAINT:\nIf ANY furniture, dining pieces, loose cabinets, stools, wall art, plants, or personal items remain after editing, the task is considered FAILED.\n\nGOAL:\nProduce a completely empty, realistic architectural shell that is perfectly clean and ready for virtual staging, while preserving the original room structure exactly.`.trim();
  }

  // Stage 1B Light Mode: Remove clutter/mess only, keep all main furniture
  // This mode is for tidying up a space without removing the furniture itself
  export function buildLightDeclutterPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `REALENHANCE — STAGE 1B: LIGHT DECLUTTER (EXTERIOR)

TASK:
Remove transient garden clutter and refuse to tidy the exterior presentation.
Preserve 100% of the building structure, permanent landscaping, and hardscaping.
Model: Gemini 3 Pro Image
Default Sampling: temp=0.50, topP=0.86, topK=45

────────────────────────────────
EXTERIOR GEOMETRIC LOCK (PRESERVE EXACTLY)
────────────────────────────────

YOU MUST PRESERVE (Pixels & Geometry):
1. Building Structure: Rooflines, gutters, downpipes, chimneys, soffits, cladding (brick/weatherboard), deck railings, antennas, satellite dishes.
2. Hardscaping: Driveways, paths, patios, retaining walls, fences, gates, letterboxes.
3. Landscaping: Trees, hedges, lawn borders, flower beds.
4. Ground Cover: DO NOT REMOVE intentional ground cover (gravel, pebble stones, bark mulch, wood chips). Treat these as FIXED texture.
5. Large Assets: Cars, boats, trailers, and outdoor furniture (tables/chairs/BBQs) must be KEPT unless they are clearly broken/rubbish.

────────────────────────────────
TARGETS FOR REMOVAL (THE "KILL" LIST)
────────────────────────────────

REMOVE ONLY the following movable items:
1. Maintenance Items: Garden hoses (and reels), buckets, brooms, mops, ladders, tools, wheelbarrows, lawnmowers.
2. Refuse: Wheelie bins, recycling crates, rubbish bags, cardboard, loose packaging.
3. Loose Clutter: Toys, bikes, sports equipment, tarps, loose firewood piles (if not stacked neatly).
4. Organic Debris: Stray leaves on decks/patios (do not remove leaves from garden beds).

────────────────────────────────
INPAINTING & RESTORATION RULES
────────────────────────────────
When removing an item (e.g., a bin against a wall):
1. Fill the Void: Seamlessly extend the background texture (weatherboards, brick pattern, or grass) to cover the gap.
2. Shadows: You MUST remove the cast shadow of the object.
3. Consistency: Do not blur the area. The replacement siding/grass must match the sharpness of the surrounding area.

STRICT PROHIBITION:
- DO NOT clean the roof or driveway (no pressure washing).
- DO NOT repair paint or cracks.
- DO NOT remove permanent fixtures (heat pumps, wall-mounted clotheslines, swimming pool equipment).

────────────────────────────────
OUTPUT
────────────────────────────────
Return ONLY the processed image.`.trim();
    }

     return `REALENHANCE — STAGE 1B: LIGHT DECLUTTER (INTERIOR)

  TASK:
  Remove small, loose, and personal clutter ONLY to depersonalize the space.
  Preserve 100% of the room’s architecture, geometry, and major furniture.

  Model: Gemini 3 Pro Image (fallback Gemini 2.5)
  Default Sampling: temp=0.45, topP=0.80, topK=40

  ────────────────────────────────
  THE “DO NOT TOUCH” VAULT (ABSOLUTE)
  ────────────────────────────────

  YOU MUST PRESERVE EXACTLY (pixels, geometry, textures):

  1. Architecture:
    Walls, ceilings, floors, stairs, windows, doors, fireplaces, openings.

  2. Fixed Joinery:
    Kitchen cabinetry, islands, benchtops, built-in shelving, wardrobes.

  3. Major Furniture:
    Sofas, armchairs, dining tables, dining chairs, beds, bedside tables,
    dressers, TV units, coffee tables, side tables, desks.

  4. Soft Furnishings:
    Curtains, blinds, rods, tracks, and ALL floor rugs
    (under furniture OR standalone).

  5. Fixtures:
    Lighting, switches, outlets, plumbing fixtures, built-in appliances,
    heat pumps / AC units.

  CRITICAL SAFETY RULES:
  - If an object rests on the floor and is larger than a microwave → KEEP IT.
  - If you are unsure whether something is clutter or furniture → KEEP IT.
  - NEVER remove containers (tables, benches, shelves). Only remove items ON them.
  - NEVER remove anything visible OUTSIDE the windows.

  ────────────────────────────────
  TARGETS FOR REMOVAL (LIGHT DECLUTTER ONLY)
  ────────────────────────────────

  REMOVE ONLY small, loose items such as:

  1. Personal Items:
    Framed photos, personal ornaments, keepsakes, clothing, shoes, bags.

  2. Loose Paper:
    Mail, magazines, newspapers, notebooks, loose books on tables or floors.

  3. Daily Mess:
    Cups, plates, bottles, food items, remote controls, cables, chargers.

  4. Surface Clutter:
    - Small decor (bowls, vases, figurines) on surfaces
    - Potted plants sitting ON furniture or benchtops
      (Keep large floor plants)
    - Kitchen bench clutter (dish racks, bottles, small appliances)
    - Bathroom vanity clutter (toiletries, soaps, bottles)

  EXCEPTION:
  - Do NOT remove books neatly arranged inside built-in bookshelves.

  ────────────────────────────────
  AMBIGUOUS CLUTTER HANDLING (SAFE MODE)
  ────────────────────────────────

  If a surface (desk, counter, shelf) contains a dense mix of loose items:

  - Remove ONLY the loose items on top.
  - PRESERVE the surface plane and its material.
  - Do NOT remove the table, shelf, or bench.
  - Do NOT hallucinate new objects to fill space.
  - Leave the surface clear and realistic.

  If removing more items would make the room feel staged or redesigned:
  → STOP early. This is LIGHT declutter, not styling.

  ────────────────────────────────
  SURFACE RESTORATION (REQUIRED)
  ────────────────────────────────

  When an item is removed:
  1. Regenerate the underlying surface realistically
    (wood grain, stone veining, carpet texture).
  2. Remove cast shadows and reflections caused by the removed item.
  3. Do NOT blur, smear, or flatten textures.

  ────────────────────────────────
  ABSOLUTE PROHIBITIONS
  ────────────────────────────────

  - NO staging or redesign
  - NO adding new objects or decor
  - NO geometry changes
  - NO texture smoothing
  - NO repainting or recoloring

  The room must look packed-up and real-estate ready,
  NOT styled, redesigned, or artificial.

  ────────────────────────────────
  OUTPUT
  ────────────────────────────────

  Return ONLY the processed image.`.trim();
  }

export function buildStage2PromptNZStyle(roomType: string, sceneType: "interior" | "exterior", opts?: { stagingStyle?: string | null; sourceStage?: "1A" | "1B-light" | "1B-stage-ready" }): string {
  if (sceneType === "exterior") return buildStage2ExteriorPromptNZStyle();
  // Require roomType for interior staging
  if (!roomType || typeof roomType !== 'string' || !roomType.trim()) {
    // Fail gracefully: return a prompt indicating missing roomType
    return '[ERROR] Room type is required for interior staging. Please select a valid room type.';
  }
  return buildStage2InteriorPromptNZStyle(roomType, opts);
}

function buildStage2InteriorPromptNZStyle(roomType: string, opts?: { stagingStyle?: string | null; sourceStage?: "1A" | "1B-light" | "1B-stage-ready" }): string {
  // Check if an explicit staging style is provided
  const hasExplicitStyle = !!opts?.stagingStyle && opts.stagingStyle !== "none";
  const sourceStage = opts?.sourceStage || "1A";
  const sourceContext = sourceStage === "1B-light"
    ? "INPUT CONTEXT: Stage 1B LIGHT declutter (main furniture remains). Refresh and lightly complement existing pieces; do NOT remove or replace major furniture."
    : sourceStage === "1B-stage-ready"
      ? "INPUT CONTEXT: Stage 1B FULL removal (room is empty). You may stage freely."
      : "INPUT CONTEXT: Stage 1A enhanced only (room may be empty). You may stage freely.";

  // Base introduction - neutral, no style specification when explicit style is provided
  let prompt = `\nStage this ${roomType || "room"} interior for high-end real estate marketing.\n\n${sourceContext}`;

  // Only include NZ style block when NO explicit stagingStyle is provided
  if (!hasExplicitStyle) {
    prompt += `\n\nStaging style:\n• NZ contemporary / coastal / Scandi minimalist.\n• Light wood (oak/beech) furniture with soft white or warm grey upholstery.\n• Clean, natural fabrics (linen, cotton) with minimal patterns.\n• Simple rugs, light-toned or natural fiber.\n• Art that is subtle, minimal, coastal, neutral, or abstract.\n• 1–2 small accents only (no clutter, heavy décor, or bold colours).`;
  }

  // Furniture, placement, lighting, and strict structural rules
  prompt += `\n\nFurniture Priority (add ONLY if space allows; never cram):\n• Primary: bed + headboard (bedrooms), sofa (living), dining table + chairs (dining), desk + chair (office), island stools only if island exists.\n• Secondary: one bedside table (bedrooms), one side table (living), credenza/console (dining/living) only if clear space remains.\n• Tertiary: lamp, small accent chair, or minimal decor ONLY if ample empty space remains.\n\nPlacement Rules:\n• Place beds/headboards against a full wall; never across doors or windows.\n• TVs should be on a full wall and never block doors/windows.\n• Dining tables must not block door access or walk paths.\n• Maintain clear circulation paths from doors to windows and around the room.\n• Never cover windows/doors with furniture, mirrors, or art.\n\nLighting:\n• Bright, airy, natural daylight with lifted midtones and softened shadows.\n• Match the lighting direction and warmth of the base interior.\n• Slightly warm real-estate aesthetic (+3–5% warmth).\n\nSTRICT STRUCTURAL RULES:\n• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,\n  zoom, or modify the camera angle or perspective.\n• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,\n  cabinetry, or built-in features.\n• Do NOT cover or partially block windows, doors, cupboards, or closets.\n• Do NOT modify or repaint walls, ceilings, floors, or surfaces.\n• Do NOT add built-ins, change fixtures, or alter fixed lighting/fans.\n• Do NOT alter the view outside the windows.\n\nOnly ADD virtual furniture that fits the style above. Do not change the room itself.`;

  return prompt.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
