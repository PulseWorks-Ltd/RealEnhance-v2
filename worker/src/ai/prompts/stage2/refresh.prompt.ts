import {
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK,
  STAGE2_CAMERA_IMMUTABILITY_BLOCK,
  STAGE2_OUTPUT_FORMAT_BLOCK,
  STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK,
} from "./sharedArchitecturalLock";

const STRUCTURAL_IDENTITY_LOCK_REFRESH = `
STRUCTURAL FIXTURE & PLUMBING IDENTITY LOCK — REFRESH MODE

The following elements are STRICTLY IMMUTABLE:

CEILING FIXTURES:
- Pendant lights
- Ceiling fans
- Downlights / recessed lights
- Track lighting
- Surface-mounted fixtures

You must NOT add, remove, relocate, resize, or replace any ceiling fixture.
Existing lighting must remain exactly as shown.

INTERIOR PLUMBING FIXTURES:
- Sink faucets
- Basin taps
- Wall-mounted taps
- Mixer units

You must NOT add, remove, relocate, resize, or replace any interior plumbing fixture.

Exterior taps may remain unchanged, but do NOT reconstruct removed hoses or loose attachments.

Any violation of these rules is a structural error.
`.trim();

const VISIBLE_EXTENT_LOCK_BLOCK = `
VISIBLE EXTENT LOCK (ABSOLUTE)

The visible size, proportion, and pixel footprint of all architectural elements must remain unchanged.

This includes:
- wall lengths and visible boundaries
- window and door width/height
- glass area and opening proportions

Do NOT:
- extend wall surfaces to cover openings
- shrink, crop, or partially occlude windows to fit furniture
- alter the ratio between wall and opening areas

If furniture does not fit, adjust or remove the furniture — never modify architecture.
`.trim();


const KITCHEN_FIXED_FINISH_FREEZE_BLOCK = `
KITCHEN FIXED-FINISH FREEZE — ABSOLUTE

Kitchen built-in finishes are permanent property materials and must remain visually identical to the source image.

The following elements must retain their exact:
- color
- tone
- material identity
- texture
- reflectivity
- finish appearance
- surface patterning
- visual age/wear characteristics

INCLUDING:
- cabinetry
- benchtops / countertops
- splashbacks / backsplashes
- flooring
- islands
- fixed shelving
- wall paint colors
- tile finishes
- appliance finishes

DO NOT:
- recolor
- brighten
- warm
- modernize
- repaint
- resurface
- restyle
- replace
- visually reinterpret
- enhance perceived luxury/material quality
- alter material appearance through grading or relighting

Lighting correction may improve overall image exposure only, but must NOT visually change fixed kitchen materials or finishes in any way.

If staging style conflicts with existing kitchen finishes, adapt the décor and accessories to the existing finishes — never alter the finishes to match the staging style.

Do NOT visually “refresh”, “modernize”, “brighten”, or “luxury-upgrade” kitchen finishes.
`.trim();

const CONSTRAINT_PRIORITY_ORDER_BLOCK = `
CONSTRAINT PRIORITY ORDER

1. Architecture & openings (highest priority)
2. Camera geometry & framing
3. Built-ins & fixed fixtures
4. Anchor furniture scale, position, and footprint
5. Layout optimization (lowest priority)

If any rule conflicts:
- Lower priority rules must yield
- Never modify architecture, camera geometry, or built-ins to satisfy layout or anchor placement
- Never modify anchor scale or footprint to satisfy layout optimization
- Specifically: do NOT shrink or compress anchor furniture (e.g. beds, sofas) to create space for additional items
- If additional furniture cannot fit around the anchor at original scale → OMIT the additional furniture
`.trim();

const CONTINUITY_WEIGHTING_BLOCK = `
CONTINUITY WEIGHTING

Prioritize continuity of:
- major furniture placement
- furnishing category
- spatial layout
- side relationships
- room function
- overall style palette

Minor decorative objects may vary naturally provided the room remains clearly the same staged space.

Do NOT force exact replication of:
- artwork
- lamp shape
- rug pattern
- pillow count
- minor decor accessories
`.trim();

const REFRESH_COMPLETENESS_ENFORCEMENT_BLOCK = `
REFRESH COMPLETENESS — REQUIRED

All visible soft furnishings and decor must be updated to match the target style.

This includes:
- bedding, pillows, throws
- artwork and wall decor
- rugs
- small decor items (vases, lamps, accessories)

Do NOT leave original soft furnishings or decor unchanged if they do not match the target style.

Do NOT partially update a scene.

The final image must appear as a fully restyled space, not a mix of old and new elements.
`.trim();

const FURNITURE_ADDITION_CONSTRAINTS_REFRESH = `
FURNITURE ADDITION CONSTRAINTS

Do NOT add any seating of any type (bar stools, chairs, benches) to or around kitchen islands.

If seating already exists in the input image, you may restyle or repaint it, but its position and count must remain unchanged.

KITCHEN MICRO-STAGING POLICY (APPLIES TO ANY VISIBLE KITCHEN ZONE)
- No new floor furniture in kitchen areas.
- Do NOT add dining tables, chairs, stools, benches, islands, carts, or freestanding cabinets in kitchen areas.
- Kitchen additions are limited to countertop / window-sill / open-shelf styling only.
- Maximum kitchen additions per image:
  * Small appliances: up to 2 total (e.g., kettle, toaster, coffee machine, blender)
  * Decor/accessories: up to 3 total (e.g., vase, fruit bowl, cookbooks, utensil holder, knife block, oven gloves, dish towel)
- Keep all kitchen additions physically grounded, realistic, and modest in scale.

ROOM-TYPE CONDITIONING
- If selected room type is kitchen only: apply only the kitchen micro-staging policy in kitchen areas; do NOT add any other furniture in kitchen areas.
- If selected room type includes kitchen + living or kitchen + dining: stage the non-kitchen zone normally, but kitchen zone remains micro-staging only with the limits above.
`.trim();

const REFRESH_TRANSFORMATION_FREEDOM_BLOCK = `
REFRESH TRANSFORMATION FREEDOM

Refresh mode is judged by the quality and realism of the final staged image, not by similarity to the input furniture.

ALLOWED STAGING TRANSFORMATIONS
- Non-anchor furniture may be replaced, removed, or repositioned to produce the best realistic staged result for the selected room type.
- Layout may improve when needed for better function, circulation, composition, or buyer appeal.
- Original non-anchor furniture does NOT need to be preserved, matched, re-skinned, or treated as a style guide.

ANCHOR FURNITURE SIZE LOCK — NON-NEGOTIABLE
- The primary anchor furniture item (e.g. bed, sofa) must NOT be resized, scaled down, or scaled up under any circumstances.
- You must NOT shrink, compress, or reduce the anchor to manufacture additional floor space for other furniture.
- If additional furniture does not fit around the anchor at its original scale, OMIT the additional furniture entirely.
- Solving a layout conflict by altering anchor scale is a structural error.

NON-NEGOTIABLE LIMITS
- The room itself must remain the same room.
- Architecture, built-ins, fixed fixtures, openings, and camera geometry must remain unchanged.
- All staging must remain physically coherent, correctly grounded, and believable in perspective.
`.trim();

export function buildStage2RefreshPromptNZ(roomType: string): string {
  const room = roomType || "room";

  return `ROLE: Interior Furniture Refresh Specialist — NZ Real Estate

TASK:
This is a REFRESH problem (from furnished/decluttered baseline), not an empty-room synthesis.
Refresh furniture and styling while preserving the same room architecture and camera geometry.

${STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

${STRUCTURAL_IDENTITY_LOCK_REFRESH}

${VISIBLE_EXTENT_LOCK_BLOCK}

${STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK}

${KITCHEN_FIXED_FINISH_FREEZE_BLOCK}

${CONSTRAINT_PRIORITY_ORDER_BLOCK}

${REFRESH_TRANSFORMATION_FREEDOM_BLOCK}

REFRESH LOGIC — FLEXIBLE STAGING MODE
- Optimize the room for the requested room type, realism, and listing quality.
- Adapt furnishings to the existing room geometry and camera framing.
- Preserve room density balance and circulation.
- Keep staging physically coherent: grounded on the floor, aligned to perspective, and believable in scale.
- Never modify structural relationships, openings, built-ins, or fixed fixtures.

STAGING COMPLETENESS REQUIREMENT

CONSISTENCY RULE

All visible elements must belong to the same design language and finish level.

Mixed styling (old + new, mismatched decor, inconsistent bedding/artwork) is not allowed.

The final image must read as a fully staged, listing-ready room, not a partially edited version of the input.

- Add complementary furniture and decor to complete the space.
- Build around existing major furniture where appropriate.
- Use rugs, side tables, lamps, artwork, cushions, plants, and decor to create a cohesive and finished look.
- Ensure the room feels intentionally designed, balanced, and complete.

${REFRESH_COMPLETENESS_ENFORCEMENT_BLOCK}

${CONTINUITY_WEIGHTING_BLOCK}

Avoid:

- leaving large empty or under-furnished areas
- minimal or incomplete staging
- half-finished compositions that look sparsely edited

ANCHOR STABILITY GUIDANCE (HARD CONSTRAINT)

The primary anchor furniture item MUST remain exactly where it is in the input image.

- Keep the anchor in the same position relative to walls, floor plane, and visible openings.
- Keep the same footprint, scale, and overall proportions as the input image.
- Keep alignment, orientation, and floor/wall contact points visually consistent with the original placement.

Do NOT:

- move or relocate the anchor item
- scale the anchor item larger or smaller
- replace the anchor with a different furniture piece
- remove the anchor and restage the room without it
- introduce layout changes that create architectural conflicts (e.g. blocking windows, misaligned placement against walls)

Allowed transformation (paint-over only):

- You may restyle the anchor by painting over the existing piece.
- You may change fabric, color, material, finish, and detailing.
- Geometry of the anchor is FROZEN — no size change, no footprint change, no scale change is permitted for any reason.

Composition rule:

- Arrange all additional staging around the fixed anchor item.
- The anchor defines the layout; other furniture must adapt to it.

ROOM-TYPE TARGET
Stage as: ${room}
Requested room type controls styling intent, never structure edits.

REFRESH-SPECIFIC RULES
- Keep walkways and door/sliding-door access clear.
- Keep built-ins/fixed fixtures unchanged and visible.
- Keep opening continuity (no blocked/sealed openings).
- Maintain realistic furniture grounding and shadows.
- Avoid over-staging; refine existing composition.

${FURNITURE_ADDITION_CONSTRAINTS_REFRESH}

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, realistic listing-safe finish.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
