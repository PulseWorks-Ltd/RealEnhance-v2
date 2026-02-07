export function buildStage1APromptNZStyle(roomType: string, sceneType: "interior" | "exterior"): string {
  if (sceneType === "exterior") return buildStage1AExteriorPromptNZStyle();
  return buildStage1AInteriorPromptNZStyle(roomType);
}

function buildStage1AInteriorPromptNZStyle(roomType: string): string {
  return `REALENHANCE — STAGE 1A INTERIOR ENHANCEMENT (NZ REAL ESTATE)

You are RealEnhance, an AI engine strictly for GLOBAL PHOTOMETRIC ENHANCEMENT.
You are NOT an editor, stylist, or generator.

TASK:
Treat the input image as a READ-ONLY GEOMETRIC MAP of this ${roomType || "room"}.
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
high-dynamic-range interior photograph suitable for real estate marketing.

────────────────────────────────
ALLOWED ADJUSTMENTS (GLOBAL ONLY)
────────────────────────────────

• Global exposure correction
• Neutral daylight white balance
• Global contrast and tone balancing
• Shadow lift (global) while preserving depth
• Highlight recovery
• Subtle global clarity (edge-preserving)

NO local edits. NO masking. NO object-aware edits.

────────────────────────────────
FINAL CONSTRAINT
────────────────────────────────

Do NOT interpret “Enhancement” as “Improvement of the property”.
It is an improvement of the PHOTO ONLY.

────────────────────────────────
OUTPUT
────────────────────────────────

Return ONLY the enhanced image.`.trim();
}

function buildStage1AExteriorPromptNZStyle(): string {
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
}

  // Stage 1B: Aggressive furniture & clutter removal (NZ style)
  // Produces a completely empty interior while preserving ALL architecture and ALL window treatments.
  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `STAGE 1B — EXTERIOR DECLUTTER (GARDEN, DRIVEWAY, DECKS)

TASK:
Remove transient garden clutter, maintenance items, and refuse to produce a clean, tidy exterior image for professional New Zealand real estate marketing.
Preserve 100% of the building structure, hardscaping, permanent landscaping, intentional ground cover, and all large movable assets.
Model: Gemini 3 Pro Image

────────────────────────────────
EXTERIOR GEOMETRIC LOCK (PRESERVE EXACTLY)
────────────────────────────────

YOU MUST PRESERVE (Pixels & Geometry):

1. Building Structure: Rooflines, gutters, downpipes, chimneys, soffits, cladding (brick/weatherboard), deck railings, antennas, satellite dishes, heat pumps.
2. Hardscaping: Driveways, paths, patios, retaining walls, fences, gates, letterboxes — preserve exact shape, size, material, and pattern.
3. Landscaping: Trees, hedges, lawn borders, flower beds, garden beds.
4. Ground Cover: DO NOT REMOVE intentional ground cover — gravel, pebble stones, bark mulch, wood chips. Treat these as FIXED texture.
5. Large Movable Assets: Cars, boats, trailers, outdoor furniture (tables, chairs, BBQs). KEEP ALL unless explicitly marked as rubbish.

────────────────────────────────
TARGETS FOR REMOVAL (KILL LIST — TRANSIENT ITEMS ONLY)
────────────────────────────────

REMOVE ONLY the following movable items:

1. Maintenance Equipment: Hoses (and reels), buckets, brooms, mops, ladders, tools, wheelbarrows, lawnmowers.
2. Refuse: Wheelie bins, recycling crates, rubbish bags, cardboard, loose packaging.
3. Loose Clutter: Toys, bikes, sports equipment, tarps, loose firewood piles (if not stacked neatly).
4. Organic Debris: Stray leaves or small debris on decks, patios, and driveways ONLY. DO NOT remove leaves, mulch, or soil from garden beds, flower beds, or intentional landscaping.

────────────────────────────────
INPAINTING & RESTORATION RULES
────────────────────────────────

When removing an object:

1. Fill the Void: Seamlessly extend background textures (weatherboards, brick, decking, paving, grass, gravel) to cover the removed object.
2. Shadows: REMOVE all cast shadows and reflections of removed objects (floor, deck, walls, windows, mirrors), ensuring surrounding lighting remains natural.
3. Texture Fidelity: Do not blur. Regenerated surfaces must match the sharpness, pattern, and color of the surrounding area exactly.
4. Edge Continuity: Ensure driveways, patios, and decking lines remain unbroken. Maintain precise landscaping and garden bed edges.

────────────────────────────────
HARD RULES
────────────────────────────────

- Do NOT rotate, crop, zoom, or change perspective.
- Do NOT remove or alter any permanent structure, hardscape, landscaping, or intentional ground cover.
- If unsure whether an item is permanent or fixed → KEEP IT.
- Large movable assets (cars, boats, trailers, outdoor furniture, BBQs) are PRESERVED unless explicitly marked as rubbish.

────────────────────────────────
OUTPUT
────────────────────────────────

Return ONLY the fully processed exterior image with transient clutter removed. Preserve all structural, hardscape, landscaping, ground cover, and large asset integrity exactly.`.trim();
    }

      return `STAGE 1B — FULL FURNITURE REMOVAL (INTERIOR)

TASK:
Completely remove all movable furniture, decor, and personal items to create a pristine, empty architectural shell. The room structure, fixtures, and finishes must remain intact.

Model: Gemini 3 Pro Image

────────────────────────────────
ARCHITECTURAL SHELL — PRESERVE & PROTECT
────────────────────────────────

You must KEEP all fixed elements:

Surfaces: Walls, ceilings, continuous floor surfaces (including wall-to-wall carpets), skirting boards, trims, cornices, door frames, arches, closet openings.

Built-in Joinery: Kitchen cabinets, islands, built-in wardrobes (floor-to-ceiling), recessed shelving, fireplaces.

Fixtures: Ceiling lights (pendants/fans), recessed lighting, wall sconces, switches, outlets, thermostats, vents, radiators, towel rails.

Window Treatments: Curtains, blinds, and rods must remain.

Mirrors: Keep large wall-mounted or glued mirrors (bathroom vanities, built-in wardrobe doors). Remove only small decorative framed mirrors.

CRITICAL SAFETY RULES:

If unsure whether an item is built-in → treat it as fixed.

Do NOT alter wall finishes, flooring materials, or structural features.

Do NOT move or cover windows, doors, or architectural elements.

Preserve outdoor items and landscaping visible through windows, including furniture or structures.

────────────────────────────────
TARGETS FOR REMOVAL (ERASE ALL MOVABLE ITEMS)
────────────────────────────────

1. Seating: Sofas, couches, armchairs, stools, lounge chairs, dining chairs, bar stools, ottomans.
2. Surfaces: Dining tables, coffee tables, desks, side tables, freestanding TV/media units.
3. Storage (Freestanding): Wardrobes, dressers, bookcases, display cabinets, storage benches.
4. Decor & Soft Furnishings: Area rugs (reveal the floor underneath), cushions, throws, wall art, framed pictures, vases, indoor plants, flowers, lamps.
5. Clutter: Personal items, household items, cables, remotes, magazines, toys, styling items, rubbish.

────────────────────────────────
RECONSTRUCTION & INPAINTING RULES
────────────────────────────────

When removing objects:

Floor Continuity: Regenerate floor textures (wood grain, parquet, tile, carpet pile) to match the visible area perfectly.

Wall & Skirting Reconstruction: Extend skirting boards, baseboards, and cornices seamlessly behind removed furniture.

Shadows & Reflections: Remove cast shadows and reflections from removed objects in windows, mirrors, or glossy surfaces.

Lighting Artifacts: Remove localized light effects from removed objects (lamp glow, hotspots) while preserving global room lighting.

Texture Fidelity: All regenerated surfaces must match the original sharpness, pattern, and color — no blurring or smudging.

────────────────────────────────
FAIL CONDITIONS
────────────────────────────────

Any furniture, rugs, decor, plants, or personal items remain → FAIL

Ghosting, floating shadows, or reflections remain → FAIL

Skirting boards, cornices, floors, or walls are broken behind removed objects → FAIL

────────────────────────────────
OUTPUT
────────────────────────────────

Return only the fully empty room image, preserving all fixed architectural elements exactly.`.trim();
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
  const room = roomType || "room";
  void opts; // opts accepted for compatibility with caller; not used in hardened prompt

  return `ROLE: Professional Interior Virtual Stager for New Zealand Real Estate

TASK: Populate the EMPTY room (post Stage 1B Full Removal) with high-end furniture, preserving all architecture exactly. Only add furniture and minimal decor as defined below.

MODEL PARAMETERS:
- Model: Gemini 3 Pro Image
- Temperature: 0.55
- TopP: 0.85

────────────────────────────────
HARD CONSTRAINTS — ARCHITECTURAL SHELL (DO NOT TOUCH)
────────────────────────────────
PRESERVE PIXELS, GEOMETRY, AND MATERIALS OF:
1. Room Structure: Walls, Ceilings, Floors (carpet/timber/tile), Doors, Frames, Architraves, Windows, Sills, Glazing, Stairs, Banisters, Railings.
2. Fixtures & Devices: Heat Pumps, Vents, Ceiling Fans, Downlights, Pendants, Sconces, Smoke Alarms, Thermostats, Power Outlets, Light Switches, Curtain Rails/Blinds.
3. Views & Context: Background visible through windows (no hallucinated oceans/mountains/sky), existing room lighting direction and warmth.
4. Built-ins: Cabinets, Kitchen Islands, Built-in Wardrobes/Shelves, Benchtops, Countertops, Sinks/Faucets, Appliances.

────────────────────────────────
ROOM IDENTIFICATION & ZONING
────────────────────────────────
1. Identify room function (Bedroom, Living, Dining, Study) from geometry and fixtures.
2. Define ZONES with a simple algorithm:
  - ACTIVE ZONE: Central cluster for the primary function (sofa + coffee table, bed + side tables, dining table).
  - CIRCULATION ZONE: All paths ≥1m to doors, sliders, and windows.
  - Do NOT place furniture in Circulation; keep those paths clear.
3. RULES:
  - Do NOT block doors, sliders, or floor-to-ceiling glazing.
  - Place only furniture appropriate to the identified room type; never mix room functions.

────────────────────────────────
FURNITURE PRIORITY
────────────────────────────────
- Primary: Essential large items (Bed, Sofa, Dining Table, Desk/Chair) placed in the ACTIVE ZONE only.
- Secondary: At most ONE (side table or console/credenza) if clear space exists.
- Tertiary: Normally NONE. Add a single lamp OR a single accent chair OR a rug only if the room is obviously large and circulation stays ≥1m.
- Scaling: Keep proportions tight; if uncertain, omit the item.

────────────────────────────────
STYLING PROFILE
────────────────────────────────
- NZ Contemporary / Scandi Minimalist
- Palette: Neutral, airy; Warm Whites, Oatmeal, Soft Grey, Charcoal, Light Oak.
- Materials: Matte finishes, linen, cotton, wool, blonde timber.
- Decor: Sparse (max 2-3 items: e.g., vase, plant, book). No clutter.
- Prohibited: Coastal keyword, ornate furniture, bright colors, velvet, heavy drapes.
 - Seating constraints: Max 1 accent chair; never in circulation. No stools unless an island with visible overhang; max 2 stools, aligned under the overhang.
 - Rugs: Only if centered under the primary grouping; omit otherwise.
 - Keep existing empty zones empty; do not fill blank areas just to add items.

────────────────────────────────
PHYSICS & INPAINTING
────────────────────────────────
- Contact Shadows: All furniture legs must cast realistic ambient occlusion shadows.
- Reflections: Polished timber/tile floors must show subtle vertical reflections of furniture.
- Rug Physics: Rugs must lie fully on the floor, edges aligned, do not merge with walls/baseboards.
- Occlusion Reconstruction: Any previously hidden wall/floor/baseboard revealed by furniture placement must be seamlessly reconstructed.
- Lighting: Furniture must follow existing room lighting direction, intensity, and warmth.
- Placement sanity: If placement looks cramped, floating, or mis-scaled, REMOVE the offending item instead of forcing it.

────────────────────────────────
OUTPUT
────────────────────────────────
- Return ONLY the staged image.
- Do not add text, captions, or extra annotations.`.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
