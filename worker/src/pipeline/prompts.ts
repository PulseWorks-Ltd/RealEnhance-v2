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
- Outside the mask region, the image must remain pixel-perfect identical.
- If the user instruction would normally require structural changes (for example "remove the window"), interpret it in the least structural way possible (for example, cover the window completely with matching curtains or blinds) instead of changing the wall or opening.`
    : `
STRUCTURAL RULES:
- Minimise changes to fixed architectural elements (walls, windows, doors, ceilings, vents).
- Prefer editing movable objects and finishes (furniture, decor, lighting) over structure.`;

  return `
You are a professional real-estate photo editor.

${roomLabel}
Scene type: ${sceneType}.

You are given:
- A base image of the room.
- A binary mask image that marks the region to edit: white = area to edit, black = area to keep unchanged.

Your job is to apply ONLY the user's instruction, and ONLY inside the white masked region.

USER INSTRUCTION (apply this ONLY to the white masked area):
"""${userInstruction}"""

⚠️ CRITICAL MASK RULES - READ CAREFULLY:
- The mask image shows WHITE pixels = area WHERE YOU MUST apply the edit
- The mask image shows BLACK pixels = area YOU MUST NOT touch (keep pixel-perfect identical)
- You may ONLY modify pixels where the mask is WHITE
- Everything where the mask is BLACK must remain 100% unchanged from the base image
- Do NOT apply the instruction to any black-masked areas
- Do NOT change anything outside the white mask region, even if it seems like it should be changed
- If you see multiple walls/areas in the image, ONLY edit the one(s) covered by WHITE mask pixels

GENERAL RULES:
- Do NOT invent new angles or viewpoints. Keep the same camera position and perspective.
- Keep lighting direction and overall brightness consistent with the base image.
- Respect the existing colour palette and style of the room unless the instruction explicitly asks to change it.

${structuralRules}

QUALITY RULES:
- Do NOT change the floor, walls, windows, doors, ceilings, or any structure outside the white mask area.
- If the white mask covers a structural element (for example a window), you may only change its surface treatment (curtains, blinds, reflections) while keeping its size and position identical.

Your output should look like the original photo, but with the user instruction perfectly applied inside the mask region and no unintended changes anywhere else.`;
}
