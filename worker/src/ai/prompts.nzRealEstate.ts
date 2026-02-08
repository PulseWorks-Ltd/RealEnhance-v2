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

      return `You are performing Stage 1B: FULL FURNITURE REMOVAL for New Zealand real estate imagery.

    GOAL:
    Produce a COMPLETELY EMPTY ROOM ready for virtual staging.
    All movable items must be removed.

    ─────────────────────────────
    ABSOLUTE PROTECTED ELEMENTS (ZERO TOUCH)
    ─────────────────────────────
    Do NOT remove or modify:
    - Walls, ceilings, floors, baseboards
    - Windows, doors, frames, tracks
    - Built-in cabinetry, wardrobes, shelving
    - Kitchen units, islands, splashbacks, rangehoods
    - Bathroom fixtures and vanities
    - Fixed lighting (pendants, downlights, track lights, sconces)
    - Electrical outlets and switches
    - Heat pumps, vents, HVAC systems
    - Smoke detectors, alarms
    - Exterior views through windows

    ─────────────────────────────
    REMOVE ALL MOVABLE ITEMS
    ─────────────────────────────
    Remove ALL furniture and decor, including:
    - Beds, sofas, chairs, tables
    - Dining sets
    - Coffee tables
    - Ottomans, stools
    - TV units
    - Rugs
    - Lamps (floor and table)
    - Plants
    - Curtains if loose or decorative

    PARTIALLY VISIBLE ITEMS:
    If ANY portion of a movable object is visible (even <10%),
    REMOVE THE ENTIRE OBJECT.
    Leaving remnants is NOT allowed.

    ─────────────────────────────
    QUALITY REQUIREMENTS
    ─────────────────────────────
    - Clean, realistic inpainting
    - No texture damage to floors or walls
    - No blur, smudge, or ghost artifacts
    - Preserve baseboards and floor continuity

    DO NOT add any objects.
    DO NOT restyle.`.trim();
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

     return `You are performing Stage 1B: LIGHT DECLUTTER for New Zealand real estate imagery.

GOAL:
Clean and simplify the space while preserving core furniture and all fixed elements.
This is NOT a styling task. Do not add or replace items.

─────────────────────────────
ABSOLUTE PROTECTED ELEMENTS (ZERO TOUCH)
─────────────────────────────
Do NOT remove, modify, recolor, resize, or replace:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, islands, splashbacks, rangehoods
- Bathroom fixtures and vanities
- Fixed lighting (pendants, downlights, track lights, sconces)
- Electrical outlets and switches
- Heat pumps, vents, HVAC systems
- Smoke detectors, alarms
- Exterior views through windows

─────────────────────────────
REMOVE ALL CLUTTER
─────────────────────────────
Remove ALL small and loose items, including:
- Dishes, cutlery, food items
- Small decor, books, plants
- Loose cables
- Shoes, bags, coats
- Laundry, towels
- Pet items, bins
- Small stools, ottomans

PARTIALLY VISIBLE ITEMS:
If ANY part of a removable item is visible, remove the ENTIRE item.
Leaving fragments or partial objects is a FAILURE.

─────────────────────────────
FURNITURE PRESERVATION
─────────────────────────────
Keep core furniture:
- Beds
- Sofas
- Armchairs
- Dining tables
- Dining chairs (unless excessive)
- Coffee tables
- TV units
- Rugs

─────────────────────────────
QUALITY REQUIREMENTS
─────────────────────────────
- Clean inpainting with no blur, ghost shadows, or texture damage
- Preserve floor, wall, and ceiling materials exactly
- Maintain realistic lighting and shadows

DO NOT add new objects.
DO NOT restyle the room.`.trim();
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

  return `ROLE: Interior Furniture Refresh Specialist — NZ Real Estate

TASK:
Refresh ALL existing furniture with modern equivalents.
Preserve layout, architecture, and flow EXACTLY.

MODEL:
Temperature: 0.10
TopP: 0.70
TopK: 24

────────────────────────────────
ARCHITECTURAL SHELL — DO NOT TOUCH
────────────────────────────────
Preserve EXACTLY:
- Walls, floors, ceilings, doors, windows
- Fixed joinery and built-ins
- Fixtures, lighting, vents
- Exterior views

────────────────────────────────
ROOM TYPE LOCK (NON-NEGOTIABLE)
────────────────────────────────
The roomType is PROVIDED by the system: ${room}.
Treat this image as staging for THIS ROOM TYPE ONLY.
Do NOT infer or reinterpret the room function from visuals.

────────────────────────────────
SINGLE-ZONE RULE
────────────────────────────────
Stage exactly ONE functional zone only.
If other zones are visible in-frame, leave them EMPTY.
Never add furniture to secondary zones; maintain clear circulation.

────────────────────────────────
FURNITURE LIMITS (HARD CAPS)
────────────────────────────────
- Primary items: max 2
- Secondary items: max 1
- Tertiary items: 0 by default
If unsure, OMIT the item.

────────────────────────────────
KITCHEN OVERRIDES ALL
────────────────────────────────
- NO sofas, armchairs, TVs, coffee tables, or rugs.
- NO dining table unless roomType = dining_room.
- Bar stools ONLY if island overhang is visible.
- Max 2 stools. Align under overhang.

────────────────────────────────
REFRESH MODE — STRICT LOGIC
────────────────────────────────
1. Identify ALL visible furniture items.
2. Replace EACH item with a modern equivalent.
3. Preserve: type, position, orientation, functional role.
4. Do NOT add new furniture; empty areas remain empty.
5. If replacement risks artifacts, keep the original item unchanged.

CONSISTENCY RULE:
- No mixing old and new. Replace fully or not at all.

────────────────────────────────
STYLE PROFILE
────────────────────────────────
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures. Decor: max 1–2 items total.

────────────────────────────────
RENDERING & PHYSICS
────────────────────────────────
- Correct contact shadows.
- Accurate reflections on floors.
- Seamless reconstruction behind replaced items.
- No blur, no ghosting, no artifacts.

────────────────────────────────
FAIL CONDITIONS
────────────────────────────────
- Any architectural alteration
- Furniture blocking walkways
- Floating or mis-scaled furniture
- Partial refresh or inconsistent style

────────────────────────────────
OUTPUT
────────────────────────────────
Return ONLY the refreshed image.`.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
