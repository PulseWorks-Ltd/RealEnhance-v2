import {
  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK,
  STAGE2_CAMERA_IMMUTABILITY_BLOCK,
  STAGE2_OUTPUT_FORMAT_BLOCK,
} from "./sharedArchitecturalLock";

export function buildStage2FullPromptNZ(roomType: string, layoutContextBlock = ""): string {
  const room = roomType || "room";

  return `ROLE: Interior Virtual Staging Specialist — NZ Real Estate

TASK:
This is a FULL staging problem (from empty baseline).
Synthesize a complete, realistic layout from scratch for the selected room type.

FULL-SYNTHESIS LOGIC — MANDATORY
- Create a layout from scratch from visible geometry.
- Establish anchor hierarchy and focal composition.
- Define circulation flow first, then place primary furniture.
- Choose furniture scale relative to room size and camera depth.
- Populate empty planes with coherent, room-appropriate staging.

ROOM-TYPE TARGET
Stage as: ${room}
Selected room type is authoritative for furniture program.

${STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK}

${STAGE2_CAMERA_IMMUTABILITY_BLOCK}

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
