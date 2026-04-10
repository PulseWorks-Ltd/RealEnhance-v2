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
Do NOT introduce new functional zones beyond the user-selected room type.
If the selected room type is "kitchen + living", do NOT add dining.
If the selected room type is "living", do NOT add office or dining.
Stage only the explicitly selected room type(s).
Do not expand room function.
`;

const FURNITURE_ADDITION_CONSTRAINTS_FULL = `
FURNITURE ADDITION CONSTRAINTS

Do NOT add any seating of any type (bar stools, chairs, benches) to or around kitchen islands.

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

const STAGE2_FULL_ARCHITECTURAL_IMMUTABILITY_BLOCK =
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK.replace(
    "- add/remove/move/resize walls, windows, doors, or openings",
    "- add/remove/move/resize walls, windows, doors, or openings",
  );

export function buildStage2FullPromptNZ(roomType: string, layoutContextBlock = ""): string {
  const room = roomType || "room";
  const normalizedRoom = room.toLowerCase();
  const livingRoomFocalPointBlock =
    normalizedRoom.includes("living") || normalizedRoom.includes("lounge")
      ? `
LIVING ROOM FOCAL POINT RULE (APPLIES WHEN ROOM TYPE INCLUDES LIVING)
- The primary living-room anchor must be sofa or sectional seating.
- A TV or media console is OPTIONAL only when there is a clearly suitable uninterrupted wall area.
- Suitable TV area means a continuous wall segment that does not conflict with windows, doors, closet openings, walk-through openings, or circulation.
- If no suitable TV area exists, use conversation grouping, fireplace, or view as the living-room focal point instead.
- Do NOT force a TV/media unit into the layout.
`.trim()
      : "";

  return `ROLE: Interior Virtual Staging Specialist — NZ Real Estate

TASK:
This is a FULL staging problem (from empty baseline).
Synthesize a complete, realistic layout from scratch for the selected room type.

${STAGE2_FULL_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STRUCTURAL_HARDENING_LAYER_V2}

${STRUCTURAL_IDENTITY_LOCK_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

FULL-SYNTHESIS LOGIC — MANDATORY
- Create a layout from scratch from visible geometry.
- Establish anchor hierarchy and focal composition.
- Define circulation flow first, then place primary furniture.
- Choose furniture scale relative to room size and camera depth.
- Populate empty planes with coherent, room-appropriate staging.

ROOM-TYPE TARGET
Stage as: ${room}
Selected room type is authoritative for furniture program.

${livingRoomFocalPointBlock}

${layoutContextBlock}

FULL-SPECIFIC RULES
- Do not leave core target zone unstaged.
- Preserve access to doors/windows/openings and traffic flow.
- Keep built-ins/fixed fixtures unchanged and unobstructed.
- Use realistic furniture footprints and contact shadows.
- Prefer coherent full composition over sparse accessory-only staging.

${FURNITURE_ADDITION_CONSTRAINTS_FULL}

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, listing-safe realism.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
 