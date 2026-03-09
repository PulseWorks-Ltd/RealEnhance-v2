import {
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK,
  STAGE2_CAMERA_IMMUTABILITY_BLOCK,
  STAGE2_OUTPUT_FORMAT_BLOCK,
} from "./sharedArchitecturalLock";

const STRUCTURAL_HARDENING_LAYER_V2 = `
────────────────────────────────
STRUCTURAL HARDENING LAYER — V2
────────────────────────────────
GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE
The architectural envelope must remain visually and geometrically identical.
You must NOT:
• change wall positions, lengths, or angles
• alter corner locations
• modify ceiling height or plane geometry
• change window-to-wall ratio
• change door-to-wall ratio
• alter visible wall spacing
• adjust depth perspective or compression
• modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align
with the original image.
ANTI-OPTIMIZATION RULE
Do NOT “improve” room proportions.
Do NOT straighten perspective.
Do NOT rebalance structural lighting.
Do NOT extend wall planes for compositional symmetry.
Do NOT reinterpret spatial depth.
Structure overrides staging decisions.
STRUCTURAL PRIORITY ORDER
1. Architectural envelope (highest priority)
2. Openings and built-ins
3. Camera geometry
4. Furniture placement
5. Decorative styling (lowest)
If any staging action conflicts with structure:
→ Preserve structure.
`;

const STRUCTURAL_IDENTITY_LOCK_BLOCK = `
────────────────────────────────
STRUCTURAL IDENTITY LOCK — ZERO ADDITIONS
────────────────────────────────
You must NOT add, remove, replace, resize, restyle, or reposition any of the following:
• Ceiling-mounted lighting fixtures (pendants, downlights, fans, surface mounts)
• Plumbing fixtures (faucets, taps, mixers, sink hardware)
• Fixed appliances
• Wall-mounted HVAC units
• Curtain rails, rods, tracks, blind housings
Existing fixture count, type, and position must remain identical.
If staging includes a dining table, do NOT add a new pendant or ceiling light above it unless a pendant already exists in that position in the input image.
If curtains or drapes are visible in the input image, they must remain present.
Do NOT remove window fabric coverings during staging.
`;

const WINDOW_GEOMETRY_PROTECTION_BLOCK = `
WINDOW GEOMETRY PROTECTION

Do NOT modify wall returns, wall angles, corner geometry, window side margins, or window height for aesthetic balance.
Do NOT adjust sill height or window proportions to accommodate furniture.
If furniture conflicts with architecture, reposition or resize the furniture instead.
Furniture must adapt to the room. The room must never adapt to furniture.
`.trim();

const ROOM_PROGRAM_CONSTRAINTS_BLOCK = `
ROOM PROGRAM CONSTRAINTS

The selected room type strictly determines the furniture program.

Do not introduce furniture that implies a different room function.

kitchen_living
Allowed:
• lounge seating
• coffee table
Forbidden:
• dining table
• dining chairs

living_room
Allowed:
• lounge seating only
Forbidden:
• dining furniture
• office furniture

kitchen_dining
Allowed:
• dining table
• dining seating
Forbidden:
• sofas
• lounge seating

living_dining
Allowed:
• lounge seating
• dining table

Guideline:
Create two zones: a dining zone and a lounge zone.

multiple_living
Allowed:
• multiple lounge seating areas
• reading chairs
Forbidden:
• dining tables unless a dining zone is clearly present.
`.trim();

const FURNITURE_ADDITION_CONSTRAINTS_FULL = `
FURNITURE ADDITION CONSTRAINTS

Do NOT add any seating of any type (bar stools, chairs, benches) to or around kitchen islands.
`.trim();

const STAGE2_FULL_ARCHITECTURAL_IMMUTABILITY_BLOCK =
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK.replace(
    "- add/remove/move/resize walls, windows, doors, or openings",
    "- add/remove/move/resize walls, windows, doors, or openings",
  );

export function buildStage2FullPromptNZ(roomType: string, layoutContextBlock = ""): string {
  const room = roomType || "room";

  return `ROLE: Interior Virtual Staging Specialist — NZ Real Estate

TASK:
This is a FULL staging problem (from empty baseline).
Synthesize a complete, realistic layout from scratch for the selected room type.

${STAGE2_FULL_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STRUCTURAL_HARDENING_LAYER_V2}

${STRUCTURAL_IDENTITY_LOCK_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

${WINDOW_GEOMETRY_PROTECTION_BLOCK}

FULL SYNTHESIS MODE LOGIC
- This is stage-from-empty synthesis.
- Build a complete, realistic furniture composition for the selected room type.

${ROOM_PROGRAM_CONSTRAINTS_BLOCK}

STAGING / LAYOUT LOGIC
- Room-type target: ${room}
- Create a layout from scratch from visible geometry.
- Establish anchor hierarchy and focal composition.
- Define circulation flow first, then place primary furniture.
- Choose furniture scale relative to room size and camera depth.
- Populate empty planes with coherent, room-appropriate staging.
- Do not leave core target zone unstaged.
- Preserve access to doors/windows/openings and traffic flow.
- Keep built-ins/fixed fixtures unchanged and unobstructed.
- Use realistic furniture footprints and contact shadows.
- Prefer coherent full composition over sparse accessory-only staging.

${layoutContextBlock}

${FURNITURE_ADDITION_CONSTRAINTS_FULL}

STYLE MODIFIERS
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, listing-safe realism.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
 