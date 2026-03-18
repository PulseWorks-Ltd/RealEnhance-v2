import {
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK,
  STAGE2_CAMERA_IMMUTABILITY_BLOCK,
  STAGE2_OUTPUT_FORMAT_BLOCK,
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
- Furniture may be replaced, removed, resized, or repositioned to produce the best realistic staged result for the selected room type.
- Layout may improve when needed for better function, circulation, composition, or buyer appeal.
- Original furniture does NOT need to be preserved, matched, re-skinned, or treated as a style guide.

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

${REFRESH_TRANSFORMATION_FREEDOM_BLOCK}

REFRESH LOGIC — FLEXIBLE STAGING MODE
- Optimize the room for the requested room type, realism, and listing quality.
- Improve layout, scale, and composition when needed, while preserving the same room architecture.
- Preserve room density balance and circulation.
- Keep staging physically coherent: grounded on the floor, aligned to perspective, and believable in scale.
- Never modify structural relationships, openings, built-ins, or fixed fixtures.

STAGING COMPLETENESS REQUIREMENT

The final image must read as a fully staged, listing-ready room, not a partially edited version of the input.

- Add complementary furniture and decor to complete the space.
- Build around existing major furniture where appropriate.
- Use rugs, side tables, lamps, artwork, cushions, plants, and decor to create a cohesive and finished look.
- Ensure the room feels intentionally designed, balanced, and complete.

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
- You may make subtle geometry refinements for realism, but must preserve original footprint, placement, and scale.

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
