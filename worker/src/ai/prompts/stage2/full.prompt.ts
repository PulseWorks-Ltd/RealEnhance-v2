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

export function buildStage2FullPromptNZ(roomType: string, layoutContextBlock = ""): string {
  const room = roomType || "room";

  return `ROLE: Interior Virtual Staging Specialist — NZ Real Estate

TASK:
This is a FULL staging problem (from empty baseline).
Synthesize a complete, realistic layout from scratch for the selected room type.

${STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STRUCTURAL_HARDENING_LAYER_V2}

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

${layoutContextBlock}

FULL-SPECIFIC RULES
- Do not leave core target zone unstaged.
- Preserve access to doors/windows/openings and traffic flow.
- Keep built-ins/fixed fixtures unchanged and unobstructed.
- Use realistic furniture footprints and contact shadows.
- Prefer coherent full composition over sparse accessory-only staging.

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, listing-safe realism.

${STAGE2_OUTPUT_FORMAT_BLOCK}`.trim();
}
