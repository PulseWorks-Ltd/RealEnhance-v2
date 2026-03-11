// worker/src/pipeline/prompts.ts

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
};

export function buildRegionEditPrompt({
  userInstruction,
  roomType,
  sceneType = "interior",
  preserveStructure = true,
}: RegionEditPromptArgs): string {
  const roomLabel = roomType
    ? `This is a ${roomType.replace(/_/g, " ")}.`
    : "This is a real estate photograph of a room.";

  const structuralRules = preserveStructure
    ? `
STRUCTURAL RULES (STRICT):
- You must treat all walls, ceilings, floors, windows, doors, openings, built-in joinery and fixed vents as UNCHANGEABLE structure.
- You must NOT resize, move, add or remove any window, door, wall, opening, bulkhead, or ceiling vent.
- You must NOT change the position, size or number of windows or doors.
- If the user instruction would normally require structural changes (for example "remove the window"), interpret it in the least structural way possible (for example, cover the window completely with matching curtains or blinds) instead of changing the wall or opening.`
    : `
STRUCTURAL RULES:
- Minimise changes to fixed architectural elements (walls, windows, doors, ceilings, vents).
- Prefer editing movable objects and finishes (furniture, decor, lighting) over structure.`;

  return `
You are a professional real-estate photo editor.

${roomLabel}
Scene type: ${sceneType}.

You will receive TWO images:
1. IMAGE 1: The base photograph of the room (the original image to edit)
2. IMAGE 2: A binary mask showing the edit region (WHITE = edit this area, BLACK = don't touch)

Your job is to apply the user's instruction with the edit ORIGINATING from the WHITE pixels in the mask image (IMAGE 2).

USER INSTRUCTION (the edit should originate from where IMAGE 2 shows WHITE pixels):
"""${userInstruction}"""

⚠️ CRITICAL MASK INTERPRETATION RULES:
- IMAGE 2 (the mask) uses this format: WHITE pixels = area to edit, BLACK pixels = area to keep unchanged
- The WHITE mask region is the primary edit origin and intent anchor.
- You may adjust nearby pixels outside the white region when necessary for coherent geometry, perspective, object extent, shadows, and realistic blending.
- Do not treat the mask as a hard stencil boundary.
- Keep non-target areas as stable as possible while preserving realism.
- If the user says "paint this wall red" and IMAGE 2 shows white on the RIGHT side, edits should originate on the RIGHT side.

BLENDING / OUTSKIRTS RULES (IMPORTANT):
- Blend naturally across the scene where required for realism, including soft shadows and perspective-consistent object extent.
- Prefer local changes near the intended edit origin; avoid unnecessary global redesign.
- Never change architectural openings or room structure.
- If the requested change would require structural changes, refuse that structural part and preserve openings exactly.

GENERAL RULES:
- Do NOT invent new angles or viewpoints. Keep the same camera position and perspective.
- Keep lighting direction and overall brightness consistent with the base image.
- Respect the existing colour palette and style of the room unless the instruction explicitly asks to change it.

${structuralRules}

QUALITY RULES:
- Maintain the architectural structure of the room.
- Do not modify windows, doors, walls, or other structural openings.
- If the white mask covers a structural element (for example a window), you may only change surface-level treatment while preserving size and position.

Your output should look like the original photo with the requested edit naturally integrated, while preserving architectural openings and room structure.`;
}
