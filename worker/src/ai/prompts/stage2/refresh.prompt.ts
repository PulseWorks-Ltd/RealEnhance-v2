import {
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK,
  STAGE2_CAMERA_IMMUTABILITY_BLOCK,
  STAGE2_OUTPUT_FORMAT_BLOCK,
} from "./sharedArchitecturalLock";

export function buildStage2RefreshPromptNZ(roomType: string): string {
  const room = roomType || "room";

  return `ROLE: Interior Furniture Refresh Specialist — NZ Real Estate

TASK:
This is a REFRESH problem (from furnished/decluttered baseline), not an empty-room synthesis.
Refresh furniture and styling while preserving all architectural and anchor geometry.

REFRESH LOGIC — MANDATORY
- Preserve anchor geometry and anchor scale.
- Preserve room density balance and circulation.
- Replace furnishings only where necessary to improve cohesion.
- Never reposition structural relationships.
- No layout redesign, no room-function reinterpretation.

ROOM-TYPE TARGET
Stage as: ${room}
Requested room type controls styling intent, never structure edits.

${STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

REFRESH-SPECIFIC RULES
- Keep walkways and door/sliding-door access clear.
- Keep built-ins/fixed fixtures unchanged and visible.
- Keep opening continuity (no blocked/sealed openings).
- Maintain realistic furniture grounding and shadows.
- Avoid over-staging; refine existing composition.

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, realistic listing-safe finish.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
