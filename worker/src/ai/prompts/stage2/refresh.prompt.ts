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
`.trim();

const ROOM_PROGRAM_EXCLUSIVITY_REFRESH = `
Do not introduce furniture belonging to another room program.
`.trim();

export function buildStage2RefreshPromptNZ(roomType: string): string {
  const room = roomType || "room";

  return `ROLE: Interior Furniture Refresh Specialist — NZ Real Estate

TASK:
This is a REFRESH problem (from furnished/decluttered baseline), not an empty-room synthesis.
Refresh furniture and styling while preserving all architectural and anchor geometry.

${STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

${STRUCTURAL_IDENTITY_LOCK_REFRESH}

REFRESH LOGIC — MANDATORY
- Preserve anchor geometry and anchor scale.
- Preserve room density balance and circulation.
- Replace furnishings only where necessary to improve cohesion.
- Never reposition structural relationships.
- No layout redesign, no room-function reinterpretation.

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

${ROOM_PROGRAM_EXCLUSIVITY_REFRESH}

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, realistic listing-safe finish.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
