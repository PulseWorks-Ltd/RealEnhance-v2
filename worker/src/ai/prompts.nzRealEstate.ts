import { buildStage2FullPromptNZ } from "./prompts/stage2/full.prompt";
import { buildStage2RefreshPromptNZ } from "./prompts/stage2/refresh.prompt";

// ────────────────────────────────
// MULTI-ZONE CONSTRAINT SYSTEM (REFACTORED — DRY)
// ────────────────────────────────
// Base block contains shared rules for all multi-room types
// Zone configs only specify zone-specific instruction — no duplication

// 📦 BASE MULTI-ZONE BLOCK — Shared constraints for ALL multi-room types
const BASE_MULTI_ZONE_BLOCK = `
────────────────────────────────
MULTI-ZONE STAGING — TWO-ZONE LIMIT
────────────────────────────────

This image contains more than one functional zone.

You MUST detect functional zones — but you may stage a MAXIMUM of TWO zones only.

ZONE DETECTION — REQUIRED

Identify candidate zones using:
• furniture groupings
• lighting clusters
• floor covering changes
• wall alignment and openings
• built-in features
• layout context hints (if provided)

Rank zones by visual dominance and usable floor area.

TWO-ZONE STAGING LIMIT — HARD RULE

Stage ONLY the TWO most visually dominant and clearly defined zones.

Do NOT stage a third zone — even if space suggests one may exist outside frame.

If more than two zones are detected:
→ stage the top two only
→ leave remaining zones clean and minimally treated

NO FUNCTION INVENTION

Do NOT invent missing zones.

Partial hints are NOT permission to stage a full zone.

ZONE BOUNDARY PRESERVATION

Do NOT let staging from one zone bleed into another.
Each staged zone must remain spatially contained.

If boundaries are unclear:
→ reduce furniture count
→ stage conservatively
→ prefer under-staging over overreach.

FAIL-SAFE RULE

When uncertain which zones are valid:

→ stage ONE primary zone only.

Never exceed two staged zones.

`;

// 🔧 ZONE-SPECIFIC CONFIGS (inject into base block)
// Refresh-mode configs may include conservative downgrade behavior when separation is weak.
const ZONE_CONFIGS_REFRESH: Record<string, string> = {
  multiple_living: `
ZONE EXPECTATIONS (MULTIPLE LIVING AREAS):
Examples: lounge + dining, dining + study nook, lounge + reading area.

If a kitchen is not clearly visible:
→ do NOT add kitchen staging elements
→ do NOT add cabinetry, counters, or appliances

If a dining area is not clearly visible:
→ do NOT create one.
`,

  kitchen_dining: `
ZONE EXPECTATIONS (KITCHEN + DINING):
The two primary zones are: kitchen zone and dining zone.

Kitchen zone must contain visible counters, cabinetry, or appliance fixtures.
Dining zone must be a separate area suitable for dining furniture.

If a kitchen is NOT clearly visible with cabinetry:
→ do NOT add kitchen elements
→ stage as a single dining zone only

If a dining area cannot be clearly separated from kitchen:
→ stage kitchen zone primarily
→ add minimal dining accessories only (not a full dining set)
`,

  kitchen_living: `
ZONE EXPECTATIONS (KITCHEN + LIVING):
The two primary zones are: kitchen zone and living/lounge zone.

Kitchen zone must contain visible counters, cabinetry, or appliance fixtures.
Living zone must be a separate area suitable for lounge seating.

If a kitchen is NOT clearly visible with cabinetry:
→ do NOT add kitchen elements
→ stage as a single living room only

If a living area cannot be clearly separated from kitchen:
→ stage kitchen zone primarily
→ add minimal lounge accessories only (not a full lounge set)
`,

  living_dining: `
ZONE EXPECTATIONS (LIVING + DINING):
The two primary zones are: living/lounge zone and dining zone.

Living zone: lounge seating, coffee table, living area layout.
Dining zone: dining table and chairs, dining area layout.

If one zone is not clearly visible or definable:
→ stage the dominant zone only
→ do NOT force a second zone
`,
};

// Full-mode configs must not include soft downgrade instructions.
const ZONE_CONFIGS_FULL: Record<string, string> = {
  multiple_living: `
ZONE EXPECTATIONS (MULTIPLE LIVING AREAS):
Examples: lounge + dining, dining + study nook, lounge + reading area.

If a kitchen is not clearly visible:
→ do NOT add kitchen staging elements
→ do NOT add cabinetry, counters, or appliances

If a dining area is not clearly visible:
→ do NOT create one.
`,

  kitchen_dining: `
ZONE EXPECTATIONS (KITCHEN + DINING):
The two primary zones are: kitchen zone and dining zone.

Kitchen zone must contain visible counters, cabinetry, or appliance fixtures.
Dining zone must be a separate area suitable for dining furniture.

If a kitchen is NOT clearly visible with cabinetry:
→ do NOT add kitchen elements
→ stage as a single dining zone only
`,

  kitchen_living: `
ZONE EXPECTATIONS (KITCHEN + LIVING):
The two primary zones are: kitchen zone and living/lounge zone.

Kitchen zone must contain visible counters, cabinetry, or appliance fixtures.
Living zone must be a separate area suitable for lounge seating.

If a kitchen is NOT clearly visible with cabinetry:
→ do NOT add kitchen elements
→ stage as a single living room only
`,

  living_dining: `
ZONE EXPECTATIONS (LIVING + DINING):
The two primary zones are: living/lounge zone and dining zone.

Living zone: lounge seating, coffee table, living area layout.
Dining zone: dining table and chairs, dining area layout.
`,
};

const HARDENED_MULTI_ZONE_FULL_BLOCK = `
MULTI-ZONE FULL STAGING — STRICT ENFORCEMENT

If the selected room type is a multi-room type (e.g., kitchen_dining, kitchen_living, living_dining):

You MUST stage BOTH selected functional zones.

You are constructing the room from empty.

You are NOT refreshing.

You are defining the spatial layout.

1️⃣ Mandatory Anchor Per Zone (Non-Negotiable)

Each selected zone MUST include a defining primary anchor:

Kitchen zone → cabinetry context + island or counter seating context

Dining zone → full dining table with chairs

Living zone → sofa or sectional seating

Decor-only representation is NOT sufficient.

Accessories alone do NOT count as a zone.

If a dining zone is selected, a dining table with seating MUST exist.

2️⃣ No Dominance Collapse

You must NOT:

Stage only the visually dominant zone.

Reduce the secondary zone to minimal accessories.

Collapse dining into kitchen.

Collapse dining into living.

Collapse living into kitchen.

Both zones must be clearly readable and functionally usable.

3️⃣ Explicit Zone Separation

Zones must:

Be spatially distinguishable.

Have separate functional footprints.

Not overlap anchor footprints.

Not bleed furniture across zone boundaries.

Furniture from one zone must not intrude into another zone’s core anchor space.

4️⃣ Proportional Space Allocation

Allocate floor area proportionally to:

Visible open floor space

Logical circulation paths

Architectural boundaries

Do NOT allocate 90% of the space to one zone unless physically constrained by the room geometry.

5️⃣ Circulation Preservation

Maintain:

Clear walkway between zones

Clear access to doors

Clear access to openings

No furniture blocking functional flow between zones

6️⃣ No Third Zone

If two zones are selected:

Stage exactly those two.

Do NOT introduce bedroom, office, or other zone types.

7️⃣ If Geometry Is Truly Insufficient

If the room physically cannot accommodate both zones:

You must still instantiate both anchors.

Scale proportionally.

Do NOT eliminate a selected zone.
`;

const MULTI_ROOM_TYPES = new Set([
  "multiple_living",
  "kitchen_dining",
  "kitchen_living",
  "living_dining",
]);

const SINGLE_ROOM_LOCK = `
SINGLE ROOM TYPE LOCK:
If room type is NOT multi-room:
• Stage ONLY the selected room type
• No secondary room-function staging
• No mixed-use furniture from other room categories
• Any visible non-target areas must remain empty or minimally treated
• In FULL staging from empty, do NOT "fill" non-target areas
Ignore other apparent functions.
`;

const MULTI_ROOM_LOCK = `
MULTI-ROOM TYPE LOCK:
If room type is multi-room:
• Stage ONLY the allowed room types in the selection
• Maximum TWO functional zones
• No third-zone furniture
• If only one allowed zone is clearly visible, stage that one only
• Any non-allowed zone must remain empty or minimally treated
Choose the two visually dominant zones only.
`;

const ROOM_FUNCTION_PRESERVATION_LOCK = `
ROOM FUNCTION PRESERVATION — HARD LOCK:
Room-type enforcement applies to furniture and props only — not architecture.
Do NOT create or extend cabinetry, counters, appliances, fixtures, or built-in structures.
Do NOT construct missing room elements to satisfy room type.
If required room features are not clearly visible:
→ stage with props only
→ do NOT build structure.
`;

const CAMERA_LOCK_BLOCK = `
CAMERA / VIEWPOINT HARD LOCK — NON-NEGOTIABLE

This camera and viewpoint lock overrides all staging, layout, and style instructions.

Do NOT rotate, crop, zoom, warp, reframe, or shift viewpoint.
Keep the camera angle, framing, lens perspective, and vanishing geometry exactly as provided by Stage 1B.

────────────────────────────────
CAMERA & SCALE LOCK — STRICT
────────────────────────────────

Camera framing and zoom are LOCKED.

• Do NOT zoom in or zoom out
• Do NOT widen or narrow field of view
• Do NOT change lens perspective
• Do NOT make the room appear larger or smaller

Object scale must remain consistent with the input image:
• Windows, doors, and fixtures must keep the same apparent size
• Furniture must be scaled to the room — not the room scaled to furniture
• If furniture does not fit at true scale → use smaller furniture or fewer items

Never change camera scale to make staging fit.

NEWLY REVEALED AREA RULE — CONTINUATION ONLY

If a tiny boundary region appears newly visible during rendering,
it may ONLY continue already-visible architecture and materials.

Do NOT invent or add any new:
- openings (windows, doors, arches)
- fixtures or cabinetry
- electrical sockets, light switches, air vents
- extractor fans, wall lights, ceiling fixtures
- plumbing points, built-ins, or structural details

If uncertain, continue existing surfaces conservatively with fewer additions.
Never create new architectural or service elements.
`;

const ROOM_FIRST_FRAMING_BLOCK = `
ROOM-FIRST FRAMING — ARCHITECTURAL PRIORITY (CRITICAL)

The subject of this image is the architectural space — not the furniture.

The purpose of staging is to illustrate scale, function, and livability of the room.

Furniture exists to support the room, not to be showcased itself.

You MUST prioritize in this order:

Architectural clarity and spatial structure (highest priority)

Clear room function and natural layout

Circulation and access flow

Furniture aesthetics and styling (lowest priority)

FUNCTIONAL ORIENTATION RULE

Furniture orientation must follow the natural functional logic of the room — NOT the camera.

For example:

Living seating should face the primary functional focal point (TV wall, fireplace, view, or conversation grouping).

Dining seating should face inward toward the table.

Beds should align naturally with the room’s geometry.

Conversation groupings should face each other.

It is acceptable and realistic for:

The back of a sofa to be visible.

The side of furniture to face the camera.

Seating to face away from the viewer.

Furniture to be perpendicular to the camera angle.

Do NOT rotate or reposition furniture solely to make its front face the camera.

Do NOT optimize staging for furniture visibility.

Do NOT treat furniture as the visual subject.

CAMERA-BIAS PROHIBITION

The camera viewpoint is fixed.

You must not:

Rotate furniture unnaturally to improve front-facing presentation.

Reposition furniture purely to make it more centered in frame.

Create symmetrical layouts solely for aesthetic framing.

Compromise functional realism for visual alignment.

Natural, realistic, architecturally correct layouts are required.

If a functional layout results in partial or rear-facing furniture visibility, this is correct and desirable.

The room structure must remain visually dominant.
`;

const GEOMETRIC_ENVELOPE_LOCK_BLOCK = `
────────────────────────────────
GEOMETRIC ENVELOPE LOCK — ABSOLUTE (NON-NEGOTIABLE)
────────────────────────────────

Treat the input image as a FIXED 3D architectural shell.

The room’s spatial volume, wall planes, ceiling height, floor boundaries,
door openings, window openings, and all structural endpoints are
physically locked and immutable.

You are staging INSIDE a rigid architectural container.

You are NOT allowed to:

• Extend any wall beyond its visible endpoints
• Shorten any wall
• Add, remove, shift, or seal any doorway
• Add, remove, shift, or seal any window
• Widen or narrow any opening
• Change room depth, width, or ceiling height
• Straighten asymmetrical geometry
• “Fix” irregular architecture
• Expand the visible room footprint
• Add new wall planes, partitions, recesses, alcoves, bulkheads, or columns
• Infer hidden structural elements behind curtains, shadows, or furniture
• Continue geometry beyond what is visibly confirmed

The architectural envelope must remain pixel-aligned with the input image.

If a boundary is partially occluded or ambiguous:
→ Preserve it exactly as visible.
→ Do NOT reinterpret it.
→ Do NOT complete it.
→ Do NOT simplify it.

You may only modify movable furniture and decor within this locked envelope.

The structure is frozen.
The volume is frozen.
The openings are frozen.

Furniture must adapt to the room.
The room must NEVER adapt to the furniture.
`;

const OPENING_CONTINUITY_LOCK_BLOCK = `
────────────────────────────────
OPENING CONTINUITY LOCK — CRITICAL
────────────────────────────────

Every doorway, sliding door, window, and glazed opening visible in the input image
must remain:

• Present
• Uncovered
• Unsealed
• Same width
• Same height
• Same position
• Same apparent depth

Do NOT:

• Cover part of an opening with new wall surface
• Extend walls across glass
• Close one panel of double doors
• Convert openings into solid walls
• Add framing around openings
• Reinterpret shadowed areas as walls

If an opening is partially obscured:
→ Preserve its visible geometry exactly.
→ Do NOT complete or modify it.

Loss or alteration of any opening is a hard failure.
`;

const ROOM_VOLUME_CONSERVATION_BLOCK = `
────────────────────────────────
ROOM VOLUME CONSERVATION — HARD RULE
────────────────────────────────

The perceived spatial size of the room must remain unchanged.

Do NOT:

• Make the room appear larger
• Make the room appear smaller
• Increase apparent depth
• Decrease apparent depth
• Extend counters or islands
• Lengthen walls
• Shift wall intersections

Furniture scale must adjust to the visible space.
Never adjust the space to accommodate furniture.

If furniture does not fit naturally:
→ Reduce quantity.
→ Use fewer pieces.
→ Do NOT modify room geometry.
`;

const HIERARCHY_OF_AUTHORITY_BLOCK = `
────────────────────────────────
HIERARCHY OF AUTHORITY — STRICT ORDER
────────────────────────────────

1️⃣ Architectural envelope (absolute authority)
2️⃣ Openings and structural continuity
3️⃣ Built-ins and fixed fixtures
4️⃣ Circulation paths and door access
5️⃣ User-selected room type
6️⃣ Furniture placement
7️⃣ Styling and aesthetics

If any conflict occurs:
Higher level wins.
Always reduce furniture — never alter structure.
`;

const ANTI_OPTIMIZATION_SAFETY_RULE_BLOCK = `
────────────────────────────────
ANTI-OPTIMIZATION SAFETY RULE
────────────────────────────────

You are NOT permitted to improve, simplify, regularize,
or spatially optimize architectural structure.

Even if a wall appears slightly misaligned,
even if symmetry would look better,
even if an opening seems awkward —

Preserve it exactly.

Staging is additive within structure.
It is never corrective of structure.
`;

// 🏗️ Build multi-zone block by injecting zone config into base
function buildMultiZoneConstraintBlock(roomType: string, mode: "full" | "refresh"): string {
  const zoneConfig = mode === "full"
    ? (ZONE_CONFIGS_FULL[roomType] || "")
    : (ZONE_CONFIGS_REFRESH[roomType] || "");
  return BASE_MULTI_ZONE_BLOCK + zoneConfig + `
────────────────────────────────
`;
}



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
  const STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT = `
🔐 Architectural Immutability Constraint
CRITICAL STRUCTURAL RULES:

- You must NOT modify walls, ceilings, floors, or architectural planes.
- You must NOT extend, shrink, reshape, or repaint walls.
- You must NOT create new wall surfaces.
- You must NOT fill gaps with wall material.
- You must NOT alter room proportions.
- You must NOT change camera position, perspective, or field of view.
- You must NOT add furniture or enlarge anchor furniture.
- You may only REMOVE clutter or small movable items.
- If unsure, leave the area unchanged.

GEOMETRIC ZERO-TOLERANCE RULE:

The following are ALWAYS structural failures and must never occur:

• Any shift in camera position, angle, framing, or perspective
• Any wall extension, shrinkage, reshaping, repainting, or continuation
• Any door, window, or opening modification
• Any change to ceiling plane geometry
• Any alteration of room proportions

Surface reconstruction is allowed only where furniture was removed,
and must strictly match surrounding visible structure.

If uncertain, preserve original geometry exactly.
`;

  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `You are performing Stage 1B: FULL FURNITURE REMOVAL for EXTERNAL real estate imagery.

GOAL:
Empty the outdoor space while preserving all fixed structures.

YOUR ONLY JOB: Remove movable outdoor furniture and items. NOTHING MORE.

CRITICAL — DO NOT ADD OR CREATE ANYTHING:

You must NOT add, create, or invent ANY structural features or landscape elements:
- Do NOT create new windows, doors, openings, or architectural features
- Do NOT add or extend decking, paths, or hardscaping
- Do NOT add or remove fixed landscaping, trees, or garden beds
- Do NOT create fences, walls, or structures that don't already exist
- ONLY reveal surfaces (deck boards, paving, grass) that were hidden behind furniture
- When uncertain what's under furniture, recreate matching surface patterns — NEVER invent structures

If you add ANY structural feature that wasn't already visible, the task is FAILED.

CAMERA / VIEWPOINT HARD LOCK — NON-NEGOTIABLE

Do NOT rotate, crop, zoom, warp, reframe, or shift viewpoint.
Keep the camera angle, framing, lens perspective, and vanishing geometry exactly as provided.

NEWLY REVEALED AREA RULE — CONTINUATION ONLY

If a tiny boundary region becomes newly visible during reconstruction,
it may ONLY continue already-visible surfaces and lines.

Do NOT invent or add any new:
- openings (windows, doors, arches)
- fixtures or cabinetry
- electrical sockets, light switches, air vents
- extractor fans, wall lights, ceiling fixtures
- plumbing points, built-ins, or structural details

If uncertain, extend existing texture/paint/material conservatively.
Never create new architectural or service elements.

COLOR PRESERVATION — LOCKED

All surface colors must remain IDENTICAL to the input image:
- Do NOT change wall colors, cladding colors, or paint tones
- Do NOT change deck colors, paving colors, or surface tones
- Do NOT brighten, darken, or shift any surface colors
- When reconstructing behind furniture, match the EXACT surrounding surface color
- Wall colors = LOCKED | Surface colors = LOCKED

REMOVE:
- All outdoor furniture (chairs, tables, loungers, benches)
- BBQs and outdoor cooking equipment
- Umbrellas and shade structures (movable)
- Heaters and portable fixtures
- All movable pots, planters, and decor
- Toys, tools, hoses, bins

KEEP EXACTLY AS-IS:
- Decks, pergolas, railings, fixed awnings
- All fixed structures, fences, walls, retaining walls
- Permanent landscaping (trees, shrubs, hedges, garden beds)
- Exterior lighting fixtures (wall-mounted, overhead)
- Walls, windows, doors, rooflines, gutters
- Driveways, paths, paving — preserve exact shape and materials

DO NOT TOUCH:
- Any permanent structures or architecture
- Decking, paths, driveways, paving
- Fixed lighting, plumbing fixtures
- Windows, doors, frames
- Trees, shrubs, landscaping, and garden beds
- Exterior views and background scenery

${STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT}

Preserve surface textures and shadows.`.trim();
    }

      return `STAGE 1B — FULL FURNITURE REMOVAL (INTERIOR)

    ROOM TYPE CONTEXT:
    This room is classified as: ${roomType || "unknown"}.

    Only preserve a dominant anchor that is appropriate for this room type.

    If no appropriate anchor is visible in the input image:
    → Do NOT create one.
    → Leave the room empty.

    Stage1B must be strictly subtractive.
    You are forbidden from adding any new furniture object not present in the input image.

TASK:
Remove all movable furniture EXCEPT for the single most functionally dominant furniture piece per clearly defined room zone. The room structure, fixtures, and finishes must remain intact.

${STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT}

    PRIMARY OBJECTIVE:
    Create a near-empty architectural shell while preserving exactly one functional anchor per zone.
    Preserve architecture, built-ins, fixtures, and window treatments exactly.

────────────────────────────────
CAMERA & PERSPECTIVE LOCK — STRICT
────────────────────────────────

Camera and lens characteristics are LOCKED.

• Do NOT change camera position, angle, or height
• Do NOT change zoom or field of view
• Do NOT change lens perspective or distortion
• Do NOT shift viewpoint or framing

Room geometry and perspective lines must match the input exactly.
Furniture removal must NOT change apparent room size or depth.

YOUR ONLY JOB: Remove furniture and reconstruct the matching surfaces that were behind it. NOTHING MORE.

    NON-NEGOTIABLE LOCKS — DO NOT ADD OR CREATE ANYTHING:

  ────────────────────────────────
  NEWLY REVEALED AREA RULE — STRUCTURAL CONTINUATION ONLY
  ────────────────────────────────

  If wall, ceiling, or floor areas become visible due to furniture removal:

  • ONLY extend already-visible wall, ceiling, or floor surfaces
  • Match exact texture, material, color, and lighting
  • Preserve original geometry precisely

  You must NEVER:

  • Create or extend doorways
  • Create or extend windows
  • Add arches, alcoves, niches, or openings
  • Complete partially visible frames
  • Infer recessed spaces as openings
  • Extend shadow lines into structural features

  If uncertain whether a region is an opening or solid wall:

  → Default to solid wall continuation.
  → Never assume an opening exists.

  If a doorway or window was not clearly visible in the input image,
  it must NOT appear in the output image.

  Structural hallucination is a failure condition.

You must NOT add, create, or invent ANY structural features:
- Do NOT create new windows, doors, openings, arches, or alcoves
- Do NOT add built-in features, fixtures, or joinery that don't already exist
- Do NOT invent architectural elements or structural details
- Do NOT extend openings beyond their original visible boundaries
- ONLY reveal surfaces that were hidden behind furniture
- When furniture blocks part of a window/door, only extend to its ORIGINAL edges
- When uncertain what's behind furniture, recreate matching wall/floor patterns — NEVER invent openings

If you add ANY structural feature that wasn't already visible, the task is FAILED.

COLOR PRESERVATION — LOCKED

Wall, floor, and ceiling colors must remain IDENTICAL to the input image:
- Do NOT change wall colors, paint tones, or wallpaper colors
- Do NOT change floor colors, carpet tones, or flooring colors
- Do NOT change ceiling colors or paint
- Do NOT brighten, darken, or shift any surface colors
- When reconstructing behind furniture, match the EXACT surrounding wall/floor/ceiling color
- Wall colors = LOCKED | Floor colors = LOCKED | Ceiling colors = LOCKED

ARCHITECTURAL SHELL — PRESERVE & PROTECT

You must KEEP all fixed elements exactly as they are:

Surfaces: Walls, ceilings, continuous floor surfaces (including wall-to-wall carpets), skirting boards, trims, cornices, door frames, arches, closet openings.

Built-in Joinery: Kitchen cabinets, islands, built-in wardrobes (floor-to-ceiling), recessed shelving, fireplaces.

Fixtures: Ceiling lights (pendants/fans), recessed lighting, wall sconces, switches, outlets, thermostats, vents, radiators, towel rails.

WINDOW TREATMENTS — STRUCTURAL
Curtains, blinds, and rods must remain unchanged.
Treat window treatments as fixed elements.
Do NOT remove, replace, resize, restyle, or reposition them.

Mirrors: Keep large wall-mounted or glued mirrors (bathroom vanities, built-in wardrobe doors). Remove only small decorative framed mirrors.

SMALL WALL FIXTURES — STRICT PRESERVATION (CRITICAL)

Light switches, power outlets, wall plates, control panels, thermostats,
data ports, and similar small wall-mounted fixtures are FIXED ELEMENTS.

You must NOT:
• add new switches or outlets
• duplicate switches or outlets
• move switch or outlet positions
• invent missing wall controls
• “complete” partially visible switch plates
• generate new wall hardware when reconstructing surfaces

If a switch or outlet was hidden behind removed furniture:
→ reconstruct the wall surface cleanly
→ do NOT add a replacement fixture.

If uncertain whether a wall detail is a fixture:
→ leave the wall plain.

STRUCTURAL HARDLOCK RULES — MUST FOLLOW

Treat the following as permanent built-in structures, NOT removable objects:
- kitchen islands
- built-in counters
- fixed cabinetry
- bench units
- vanities
- built-in storage
- fixed appliances
- structural fixtures

These must NEVER be:
- removed
- replaced
- converted
- restaged
- resized
- moved
- relabeled as furniture

Kitchen islands must NEVER be converted into dining tables or staging furniture.

BUILT-IN VS LOOSE FURNITURE — IMPORTANT DISTINCTION

Beds, bed frames, mattresses, and bedroom furniture are ALWAYS considered loose removable furniture — even if heavy or made of timber.

Do NOT classify beds or bed frames as built-in joinery.

Only treat an item as built-in if it is visibly attached to walls, floors, or structure with no gaps and no independent frame.

Freestanding beds are NEVER built-ins and should be removed in stage-ready declutter mode when clearly identifiable as freestanding.

Similarly, freestanding furniture items like:
- wardrobes (not built into walls)
- dressers and chests of drawers
- bedside tables
- desks (unless visibly integrated into wall units)
- bookcases (unless built-in shelving)

are ALL removable furniture — remove them completely.

ARCHITECTURE HINTS — CONTEXT ONLY, REMOVAL ONLY

Architecture hints (built-in detection, fixture identification) are provided as
context to help you decide what to KEEP — never what to ADD.

  context_only = true
  removal_only = true
  no_completion = true
  no_inference = true

If any architecture hint conflicts with visible pixels → trust the pixels.
Never add cabinetry, fixtures, or structures that are not clearly visible
in the input image. Do NOT complete partially visible structures.
Do NOT infer hidden built-ins from context clues.

CRITICAL SAFETY RULES:

If unsure whether an item is built-in → treat it as fixed.
If an item is clearly freestanding furniture (including beds), remove it.
Do NOT remove built-in structures or fixed architectural elements. Declutter applies only to movable objects and furniture.
Do NOT alter wall finishes, flooring materials, or structural features.
Do NOT move or cover windows, doors, or architectural elements.
Preserve outdoor items and landscaping visible through windows.

TARGETS FOR REMOVAL (ERASE ALL NON-DOMINANT MOVABLE ITEMS)

Remove ALL movable furniture, decor, rugs, plants, clutter, and personal items EXCEPT:

• Preserve exactly ONE functionally dominant furniture piece per clearly defined room zone.

PARTIAL ANCHOR PRESERVATION — CRITICAL

If a primary anchor furniture item is visible in the BEFORE image,
even if:

• partially cropped by the frame
• partially obscured by clutter
• only one section of a sectional is visible
• positioned at the edge of the image
• visually dominant but not fully in view

It must be retained in the AFTER image.

Do NOT remove a partially visible anchor and replace it with new furniture.
Do NOT invent substitute anchor furniture.
Do NOT recompose the room by deleting the dominant anchor.
Anchor removal for aesthetic improvement is prohibited.

If multiple anchor pieces are visible, retain the most visually dominant anchor
based on size, floor contact area, and visual weight.

Structured-retain declutter removes clutter — not anchor furniture.

ANCHOR SELECTION PRIORITY — STRICT HIERARCHY

Anchor selection must follow this strict order:

1. Determine dominance primarily by physical scale, floor contact area, visual mass, and functional importance within the room.

2. If a clearly dominant large-scale anchor exists, it must be retained — even if partially cropped or positioned at the image edge.

3. A smaller fully visible item must NOT outrank a larger partially visible dominant anchor.

4. Visibility clarity alone does NOT override dominance.

5. Central positioning is a last-resort tie-breaker only when scale and dominance are genuinely equal.

Dominance takes precedence over visibility.

ARCHITECTURAL BOUNDARY PROTECTION — STRUCTURAL SAFETY RULE

When removing furniture, protect architectural boundaries.

You may remove furniture that touches architectural elements ONLY IF:
• The boundary geometry is clearly visible
• The seam direction is unambiguous
• Surface continuation is visually obvious

If removal would require uncertain inference of:
• Window frame geometry
• Sliding door tracks
• Glass panel edges
• Wall corner continuation
• Door frame seams

→ Preserve the furniture item.

Preserved boundary-adjacent items must:
• Be minimal
• Not introduce new structural geometry
• Not alter opening shapes
• Not exceed one dominant anchor per zone

Architectural integrity takes precedence over decluttering completeness.

A zone is a visually distinct functional area (e.g., lounge area, dining area) separated by layout, furniture grouping, or spatial orientation.

Dominant functional anchors by room type:

Living room:
→ Keep the primary sofa OR the main seating anchor (the piece that defines the seating area).
→ Remove all secondary seating (armchairs, recliners, ottomans, side chairs).

Bedroom:
→ Keep the bed.
→ Remove all other freestanding furniture.

Dining:
→ Keep the dining table.
→ Remove additional storage and loose items.

Office:
→ Keep the primary desk.
→ Remove all secondary furniture.

Kitchen:
→ Built-ins remain as already specified. Remove all loose movable items.

If uncertain which item is dominant:
→ Keep the item most central to the room’s primary function.
→ Remove all other movable items.

FUNCTIONAL ANCHOR LIMIT — STRICT

Only ONE movable anchor item per zone may remain.

Do NOT preserve multiple similar furniture pieces.
Do NOT preserve secondary seating.
Do NOT preserve decorative or auxiliary furniture.

Boundary-adjacent preserved items that remain for structural safety
do NOT count as additional anchors,
provided they are not dominant furniture pieces.

QUALITY RULES:
Rebuild floors, skirting, walls, lighting artifacts naturally with matching texture and sharpness.
When reconstructing walls, prefer clean blank wall over adding any wall hardware.

OUTPUT:
Return only the empty room image.`.trim();
  }

  // Stage 1B Light Mode: Remove clutter/mess only, keep all main furniture
  // This mode is for tidying up a space without removing the furniture itself
  export function buildLightDeclutterPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `REALENHANCE — STAGE 1B: LIGHT DECLUTTER (EXTERIOR)

    TASK:
    Remove loose, portable clutter ONLY to depersonalize and tidy the outdoor space.
    Preserve all architecture, hardscape, landscaping, and major outdoor furniture.

    PRIMARY OBJECTIVE — LISTING-READY PRESENTATION

    Your goal is to make the exterior look clean, tidy, and presentation-ready for a real estate listing photo,
    while preserving all structures, hardscape, and major outdoor furniture.

    This is NOT staging or redesign — but the space should look clearly tidied and prepared for photography.

    If an item is loose, personal, messy, or visually distracting — remove it or tidy it.
    If movable textiles or seating setups look messy — straighten and neaten them.

    NO NEW OBJECTS — STRICT

    You must NOT add any new furniture, electronics, decor, or objects that were not clearly present in the original image.

    Do NOT:
    - Add outdoor furniture, decor, planters, or accessories
    - Add replacement items after removing clutter
    - “Fill” empty surfaces with new objects

    If an area becomes empty after decluttering, leave it empty and realistic.

    NON-NEGOTIABLE STRUCTURAL COMPONENTS

    EXTERIOR FIXED UTILITY PRESERVATION — HARD RULE

    When removing:
    • Loose cables
    • Extension leads
    • Hose pipes
    • Temporary attachments

    You must preserve any permanent utility fixture they connect to.

    Permanent fixtures include:
    • Exterior waterproof power sockets
    • Exterior plumbing taps
    • Gas outlets
    • Wall-mounted service boxes
    • Meter boxes
    • Exterior conduit entry points

    These fixtures are part of the building and must NOT be removed,
    covered, relocated, or patched over.

    Only remove the loose item (hose, cable, extension lead).
    Do NOT remove or modify the fixed wall-mounted fixture.

    The building must remain functionally complete after decluttering.

    DECLUTTER OBJECT CLASS RULES — LIGHT MODE (EXTERIOR)

    Remove loose, portable, personal-use items that are not furniture and not built-in.

    ALWAYS REMOVE when visible:
    - garden tools and loose maintenance equipment
    - loose hoses and extension cords on ground
    - rubbish, bags, packaging, and discarded items
    - children’s toys, ride-ons, balls, and play clutter
    - scooters, bikes, skateboards, and sports gear
    - portable heaters, fans, and loose devices
    - movable clutter on decks, patios, paths, and driveways

    REMOVE SMALL SURFACE CLUTTER:
    - small loose items on outdoor tables/benches
    - random containers and scattered accessories
    - loose personal items and visual clutter hotspots
    - small decorative pot plants causing visual clutter (only if clearly minor and portable)

    TIDY BUT DO NOT REMOVE:
    - outdoor dining suites (align chairs neatly around table)
    - outdoor lounge seating (align cushions neatly)
    - umbrellas already present (straighten orientation only)
    - door mats and small outdoor rugs (straighten)
    - BBQ grills and smokers already present (straighten and clean appearance only)

    NEVER REMOVE:
    - major outdoor furniture sets
    - fixed benches and built-in seating
    - permanently installed BBQ/outdoor kitchen components
    - fixed planters or integrated landscaping elements

    EXTERIOR WALL ITEM DECLUTTER — LIGHT MODE

    You may remove:
    - temporary signs
    - taped notices
    - temporary decorations
    - small temporary wall hangings

    Do NOT remove:
    - address numbers
    - security signage
    - permanent plaques
    - mounted fixtures

    STRUCTURE SAFETY — LIGHT MODE

    Do not alter walls, fences, decking, paths, driveways, plumbing fixtures, or fixed structures.
    Do not create holes, openings, or remove architectural elements.
    Only remove loose, portable, non-attached items.
    Match surrounding surface colors when reconstructing behind removed items.

    NATURAL ENVIRONMENT LOCK

    Do NOT modify natural environment elements:
    - Do NOT change grass, soil, plants, or trees
    - Do NOT improve or “fix” lawns or garden health
    - Do NOT alter sky, weather, or lighting conditions
    - Do NOT change season or foliage density

    Only remove loose man-made clutter — not natural features.

    DO NOT TOUCH:
    - Any permanent structures or architecture
    - Decking, paths, driveways, paving
    - Fixed lighting, plumbing fixtures, mounted equipment
    - Windows, doors, frames
    - Landscaping and exterior views

    SAFE MODE:
    If unsure → KEEP IT.

    SURFACE RESTORATION:
    Repair surfaces realistically where items are removed.

    OUTDOOR PRESENTATION TIDY — REQUIRED WHEN NEEDED

    You should tidy presentation when exterior areas appear messy or unprepared.

    Allowed tidying actions:
    - align outdoor chairs neatly around tables
    - align and neaten outdoor cushions
    - fold/straighten loose throws on outdoor seating
    - straighten mats/rugs and obvious skewed soft items
    - organize small remaining items into a cleaner arrangement

    These are expected actions when messiness is visible.
    Do not leave seating areas visibly disordered.

    Strict rules:
    - Do NOT change furniture type, size, style, or position substantially
    - Do NOT change colors or materials
    - Do NOT replace textiles or décor
    - Do NOT add new objects
    - Do NOT remove major objects
    - Do NOT redesign or restyle

    This is presentation tidying only — not staging or redesign.

    ABSOLUTE PROHIBITIONS:
    No staging, no redesign, no recolor, no geometry change.

    ${STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT}

    OUTPUT:
    Return only processed image.`.trim();
    }

    return `REALENHANCE — STAGE 1B: LIGHT DECLUTTER (INTERIOR)

TASK:
Remove small, loose, and personal clutter ONLY to depersonalize the space.
Preserve all architecture and major furniture.

${STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT}

PRIMARY OBJECTIVE — LISTING-READY PRESENTATION

Your goal is to make the room look clean, tidy, and presentation-ready for a real estate listing photo,
while preserving all architecture and major furniture.

This is NOT staging or redesign — but the space should look clearly tidied and prepared for photography.

If an item is loose, personal, messy, or visually distracting — remove it or tidy it.
If textiles or movable items look messy — straighten and neaten them.

NO NEW OBJECTS — STRICT

You must NOT add any new furniture, electronics, decor, or objects that were not clearly present in the original image.

Do NOT:
- Add computers, monitors, TVs, lamps, decor, or accessories
- Add replacement items after removing clutter
- “Fill” empty surfaces with new objects

If an area becomes empty after decluttering, leave it empty and realistic.

DECLUTTER OBJECT CLASS RULES — LIGHT MODE

Remove loose, portable, personal-use items that are not furniture and not built-in.

ALWAYS REMOVE when visible:
- scooters and e-scooters
- bicycles and ride-on items
- skateboards and sports gear
- exercise equipment that is not permanently installed
- portable heaters and fans
- loose floor machines or devices
- backpacks, handbags, school bags, and luggage
- laundry baskets and clothes piles
- toy piles and loose toys
- loose cables and extension cords on floors

REMOVE SMALL SURFACE CLUTTER:
- papers, notebooks, small desk clutter
- bench clutter and toiletries
- random containers and loose items

TIDY BUT DO NOT REMOVE:
- beds (smooth and straighten bedding)
- sofa cushions and pillows (align neatly)
- chairs (push neatly under tables)
- rugs (straighten)

NEVER REMOVE:
- beds, sofas, desks, tables, wardrobes, shelving
- major furniture
- built-in fixtures or appliances

WALL ITEM DECLUTTER — LIGHT MODE

You may remove non-permanent wall clutter such as:
- Loose papers taped to walls
- Random drawings or notes
- Temporary posters
- Small unattractive or personal wall art
- Stickers and decals

Do NOT remove:
- Built-in fixtures
- Wall-mounted TVs
- Permanent mirrors
- Architectural elements

When removing wall items, reconstruct the wall surface cleanly and match paint color.

STRUCTURE SAFETY — LIGHT MODE
Do not alter walls, ceilings, floors, cabinetry, plumbing fixtures, or built-in joinery.
Do not create holes, openings, or remove architectural elements.
Only remove loose, portable, non-attached items.
Match surrounding surface colors when reconstructing behind removed items.

DO NOT TOUCH:
Architecture, built-in joinery, major furniture, curtains, blinds, rugs, fixtures, appliances.

REMOVE ONLY:
Loose personal items, paper, surface clutter, small decor, bench clutter.

SAFE MODE:
If unsure → KEEP IT.

SURFACE RESTORATION:
Repair surfaces realistically where items are removed.

BED & SOFT FURNISHING TIDY — REQUIRED WHEN MESSY

If a bed, sofa, or soft furnishing is visibly messy, you should tidy it.

Required actions when messy:
- Smooth and straighten duvet and bedding
- Flatten and align blankets and throws
- Arrange pillows neatly
- Remove visible wrinkles and bunching

This is presentation tidying — not redesign.
Do not change color, style, or materials.

PRESENTATION TIDYING — REQUIRED WHEN NEEDED

You should tidy presentation when items appear messy or unprepared.

Allowed tidying actions:
- Align pillows and couch cushions
- Push loose chairs neatly under tables
- Straighten rugs
- Neaten visible loose textiles
- Organize small remaining items into a cleaner arrangement

These are expected actions when messiness is visible.
Do not leave beds, sofas, or soft furnishings visibly messy.

Strict rules:
- Do NOT change furniture type, size, style, or position
- Do NOT change colors or materials
- Do NOT replace textiles or décor
- Do NOT add new objects
- Do NOT remove major objects
- Do NOT redesign or restyle

This is presentation tidying only — not staging or redesign.

ABSOLUTE PROHIBITIONS:
No staging, no redesign, no recolor, no geometry change.

OUTPUT:
Return only processed image.`.trim();
  }

export function buildStage2PromptNZStyle(
  roomType: string, 
  sceneType: "interior" | "exterior", 
  opts?: { 
    stagingStyle?: string | null; 
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    mode?: "full" | "refresh";
    layoutContext?: import("./layoutPlanner").LayoutContextResult;
  }
): string {
  if (sceneType === "exterior") return buildStage2ExteriorPromptNZStyle();
  // Require roomType for interior staging
  if (!roomType || typeof roomType !== 'string' || !roomType.trim()) {
    // Fail gracefully: return a prompt indicating missing roomType
    return '[ERROR] Room type is required for interior staging. Please select a valid room type.';
  }
  const normalizedRoomType = String(roomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas"
    ? "multiple_living"
    : normalizedRoomType;

  const sourceStage = opts?.sourceStage || "1A";
  const explicitMode = opts?.mode;
  const refreshOnlyRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);
  const forceRefreshMode = refreshOnlyRoomTypes.has(canonicalRoomType);
  const resolvedMode: "full" | "refresh" = explicitMode
    ? explicitMode
    : (sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh");

  const layoutContextBlock = resolvedMode === "full" && opts?.layoutContext
    ? `
LAYOUT CONTEXT (ADVISORY ONLY)
- room_type_guess: ${opts.layoutContext.room_type_guess || "unknown"}
- open_plan: ${opts.layoutContext.open_plan === true ? "yes" : opts.layoutContext.open_plan === false ? "no" : "unknown"}
- layout_complexity: ${opts.layoutContext.layout_complexity}
- primary_focal_wall: ${opts.layoutContext.primary_focal_wall}
- staging_risk_flags: ${(opts.layoutContext.staging_risk_flags || []).slice(0, 4).join(", ") || "none"}

Use this as soft spatial guidance only.
If any hint conflicts with visible architecture, preserve architecture.
`.trim()
    : "";

  if (resolvedMode === "full") {
    return buildStage2FullPromptNZ(canonicalRoomType, layoutContextBlock);
  }

  return buildStage2RefreshPromptNZ(canonicalRoomType);
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `Stage this outdoor area with clean, contemporary New Zealand-style outdoor
furniture consistent with Trade Me real estate photography.

STRUCTURAL FIXTURE IDENTITY LOCK — MUST FOLLOW
Fixture identity preservation has higher priority than staging style realism.

Visible fixed lighting fixtures are structural elements and must remain visually identical to the input image.

This includes:

pendant lights
chandeliers
ceiling light fixtures
fixed wall lights
wired lighting attached to ceilings or walls

You MUST NOT:

change fixture style or design
change fixture type
change fixture shape or silhouette
replace with a different lighting model
modernize or restyle fixtures
convert pendant lights into different pendant styles
remove or add ceiling fixtures

You MUST:

preserve fixture count, position, and exact visual style
keep fixture geometry and proportions unchanged

Allowed:

brightness adjustment
exposure adjustment
shadow refinement
glow realism improvements

Lighting fixture identity must match the input image exactly.

Visual structure authority overrides staging style goals.
If staging style conflicts with existing fixtures, keep the fixtures unchanged and adjust furniture style instead.

The Stage 1B image is the structural authority for all fixed elements.
Staging must adapt to fixed fixtures — never modify them.

CAMERA / VIEWPOINT HARD LOCK — NON-NEGOTIABLE

Do NOT rotate, crop, zoom, warp, reframe, or shift viewpoint.
Keep the camera angle, framing, lens perspective, and vanishing geometry exactly as provided by Stage 1B.

NEWLY REVEALED AREA RULE — CONTINUATION ONLY

If a tiny boundary region appears newly visible during rendering,
it may ONLY continue already-visible architecture and materials.

Do NOT invent or add any new:
- openings (windows, doors, arches)
- fixtures or cabinetry
- electrical sockets, light switches, air vents
- extractor fans, wall lights, ceiling fixtures
- plumbing points, built-ins, or structural details

If uncertain, continue existing surfaces conservatively with fewer additions.
Never create new architectural or service elements.

────────────────────────
ROOM TYPE AUTHORITY — HARD RULE
────────────────────────

The requested room type is authoritative.

You MUST stage exactly as the requested room type.

Do NOT reinterpret room function based on layout, furniture, or visual cues.

Only override the requested room type if hard structural fixtures make it impossible, such as:
- visible toilet
- visible shower or bath
- bathroom vanity and plumbing
- tiny storage closet with no usable floor space

Otherwise:
Stage exactly as requested, even if the layout is unusual for that room type.

User intent overrides model interpretation.

────────────────────────────────
PRIMARY STAGING OBJECTIVE — USER INTENT FIRST
────────────────────────────────

Your primary goal is to produce a staged result that clearly matches the user-selected room type and staging intent.

Always prioritize what the user requested over what seems more practical, optimal, or typical for the space.

The staged result must visually and unambiguously read as the selected room type.

Do not substitute another dominant room function.
Do not dilute the requested room type by staging it mainly as a different kind of space.

If the space is very large and clearly supports multiple zones, you may stage secondary zones — but the requested room type must remain the dominant and most visually clear outcome.

When there is any ambiguity, choose the staging approach that best matches the user's selected room type.

────────────────────────────────
ROOM TYPE → FURNITURE SET ENFORCEMENT — MUST FOLLOW
────────────────────────────────

Room type selection controls the REQUIRED furniture category.

You MUST place the primary furniture set that defines the requested room type.

Dining room → MUST include:
- dining table
- dining chairs
- table-centered layout
- no sofa as the primary seating element

Living room / lounge → MUST include:
- sofa or sectional
- lounge seating layout
- coffee table or lounge focal point

Bedroom → MUST include:
- bed as primary focal object

Office → MUST include:
- desk + work chair

If the visible layout is ambiguous, you MUST still place the correct furniture set for the requested room type.

Do NOT substitute a different furniture category due to layout preference.

Room type furniture requirements override layout heuristics.

Staging style:
• A single outdoor furniture set (lounge or dining).
• Neutral tones: charcoal, white, light wood, or grey.
• Add 1–2 potted plants maximum.
• Keep layout simple, clean, modern, and spacious.

Placement rules:
• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).
• Do NOT place furniture on grass, gardens, or driveways.
• Ensure scale, lighting, and shadows perfectly match the scene.
• Do NOT overcrowd the area; NZ staging is minimalistic.

────────────────────────────────
CRITICAL OPENING CLEARANCE RULE — HARD PLACEMENT CONSTRAINT
────────────────────────────────

Large openings and access doors have ABSOLUTE placement protection zones.

These include:
• Sliding doors
• Exterior doors
• Main entry doors
• Bi-fold doors
• Full-height glass doors

HARD RULES:

• Do NOT place sofas, beds, dining tables, cabinets, shelving, or large furniture in front of these openings
• Do NOT place any furniture within the door swing or sliding track zone
• Maintain a clear walk path to the handle side of the door
• Maintain visible and usable access to the opening

Minimum clearance requirement:
Keep at least one full human walking path width clear between furniture and door openings.

If layout space is limited:
→ Reduce furniture count
→ Use smaller furniture
→ Remove secondary items

Never block an opening to satisfy staging density.
Access always has higher priority than furniture completeness.

────────────────────────────────
FURNITURE PLACEMENT PRIORITY ORDER
────────────────────────────────

When arranging furniture, follow this strict priority:

1. Preserve door and sliding door access
2. Preserve walk paths
3. Preserve window light and openings
4. Then place primary furniture (sofa / bed / table)
5. Then place secondary furniture
6. Then decor items

If a conflict occurs:
Reduce furniture — never block access.

────────────────────────────────
CASEGOODS PLACEMENT — WALL VISIBILITY RULE
────────────────────────────────

Large storage furniture may only be added where a clearly visible, continuous blank wall is present behind the item in the original image.

Applies to:
• chests of drawers
• dressers
• tallboys
• wardrobes (added furniture, not built-ins)
• dressing tables / vanities
• large cabinets and sideboards

Do NOT place these items:
• against image edges where the backing wall is not visible
• in front of doors, closets, wardrobes, or openings
• where the wall behind the item cannot be clearly seen

If a suitable blank wall is not clearly visible, do not add the item.

────────────────────────────────
WALL-MOUNTED ADDITIONS — PROHIBITED
────────────────────────────────

Do NOT add new wall-mounted furniture or fixtures, including:
• floating nightstands
• wall-mounted desks
• new shelves
• wall cabinets

Only use floor-standing furniture for added staging items.

ABSOLUTE STRUCTURAL RULES:
• No rotation/crop/zoom or perspective changes.
• Do NOT modify architecture, building shape, fences, windows, doors, decking,
  landscaping, or permanent structures.
• Do NOT add new structures.
• Only add outdoor furniture and small potted plants.

────────────────────────────────
STRUCTURE FIRST LAYOUT CONSTRAINT
────────────────────────────────
Before placing ANY outdoor furniture, identify all structural elements:
• Decking, patios, concrete slabs (valid placement surfaces)
• Fences, walls, pergolas, posts
• Fixed outdoor lighting
• Drainage, guttering, downpipes

These elements define the available staging zone.
Furniture must be placed ONLY on valid hard surfaces in remaining open space.

If the staging zone is small due to structural elements:
→ Reduce furniture count (fewer items)
→ NEVER remove or alter structural elements to make room for staging
→ Prefer fewer, well-placed pieces over a crowded layout

IMMUTABLE ELEMENTS — HARD LOCK BLOCK
────────────────────────────────
IMMUTABLE ELEMENTS — HARD LOCK (NON-NEGOTIABLE)
────────────────────────────────

The following elements are FIXED and must remain visually, geometrically,
materially, and color-accurate to the input image.

You MUST NOT add, remove, replace, restyle, recolor, resize, reposition,
or cover these elements — even partially.

FIXED ARCHITECTURE:
• Walls, ceilings, trims, cornices, skirting boards, baseboards
• Floors and floor finishes (timber, tile, vinyl, concrete, carpet)
• Floor COLOR and MATERIAL must remain identical
• Floor plank direction and tile pattern must remain identical
• Doors, frames, architraves, sliders, tracks
• Windows, frames, glazing, sills

FLOORING IDENTITY LOCK — STRICT

Do NOT change, replace, or upgrade flooring material or flooring type.

The floor must remain the same material and visual style as in the original image
(e.g., tile stays tile, timber stays timber, carpet stays carpet, linoleum stays linoleum).

You may clean or subtly enhance the appearance of the same flooring,
but do not substitute it with a different material or style.

WINDOW TREATMENTS — STRUCTURAL
Curtains, blinds, and rods must remain unchanged.
Treat window treatments as fixed elements.
Do NOT remove, replace, resize, restyle, or reposition them.

LIGHTING & CEILING FIXTURES (ALWAYS FIXED — NEVER MODIFY):
• Pendant lights
• Ceiling light fittings
• Downlights and recessed lights
• Ceiling fans
• Smoke alarms and ceiling sensors
• Exterior wall lights and mounted light fixtures

WALL & BUILDING FIXTURES:
• Heat pumps / HVAC units
• Vents and grilles
• Switches and power outlets
• Thermostats and control panels
• Wall-mounted detectors and alarm panels

BUILT-INS:
• Built-in cabinetry
• Built-in wardrobes
• Built-in shelving
• Kitchen cabinetry and islands
• Benchtops and splashbacks
• Plumbing fixtures (sinks, taps)

EXTERIOR VIEW THROUGH WINDOWS:
• Do NOT change the outside scene
• Do NOT upgrade weather, sky, landscape, or buildings

If any of these elements change → THIS IS A FAILURE.

Goal:
Create a clean, modern, inviting outdoor scene that matches professional NZ
real estate staging.`.trim();
}
