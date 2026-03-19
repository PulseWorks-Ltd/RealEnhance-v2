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

You will receive these labeled image inputs:
- BASE_IMAGE_TO_EDIT: the original image that must be edited.
- EDIT_MASK_IMAGE: binary mask where WHITE = area to edit and BLACK = area to preserve.
- OPTIONAL_REFERENCE_IMAGE: may be provided for architectural continuity only. This image is NEVER the edit target.

Your job is to apply the user's instruction with the edit ORIGINATING from WHITE pixels in EDIT_MASK_IMAGE.

USER INSTRUCTION (the edit should originate from where EDIT_MASK_IMAGE shows WHITE pixels):
"""${userInstruction}"""

⚠️ CRITICAL MASK INTERPRETATION RULES:
- EDIT_MASK_IMAGE uses this format: WHITE pixels = area to edit, BLACK pixels = area to keep unchanged
- You MUST apply the edit ONLY where EDIT_MASK_IMAGE shows WHITE pixels
- You MUST keep everything pixel-perfect identical where EDIT_MASK_IMAGE shows BLACK pixels
- Think of the mask like a stencil: you can only paint through the white holes
- If the user says "paint this wall red" and EDIT_MASK_IMAGE shows white on the RIGHT side, paint the RIGHT side red
- If EDIT_MASK_IMAGE shows white on the LEFT side, paint the LEFT side
- Do NOT apply the instruction to black-masked areas
- Do NOT edit ANY area where EDIT_MASK_IMAGE is black, no matter what the instruction says
- If you see multiple walls/surfaces in BASE_IMAGE_TO_EDIT, ONLY edit the specific wall/surface that has WHITE pixels in EDIT_MASK_IMAGE

REFERENCE IMAGE RULES (IF OPTIONAL_REFERENCE_IMAGE IS PROVIDED):
- Use OPTIONAL_REFERENCE_IMAGE only to preserve structure/openings continuity.
- Do NOT copy textures or objects from OPTIONAL_REFERENCE_IMAGE.
- Do NOT treat OPTIONAL_REFERENCE_IMAGE as the mask or edit target.

STRUCTURAL SAFEGUARD:
- Architectural elements such as walls, windows, doors, ceilings, floors, and built-in fixtures must remain unchanged.
- Do not add, remove, cover, move, or resize any window, door, or structural opening.
- If the requested edit would require modifying architectural structure, do not perform the edit.

MASK BOUNDARY RULES (HARD):
- Treat the mask boundary as a hard edit boundary.
- Do NOT blend, feather, or modify pixels outside the WHITE mask region unless a later explicit ADD MODE geometry rule permits strictly necessary object depth extension.
- Do NOT modify nearby surfaces, other walls, or unrelated objects outside the WHITE mask.
- Do NOT expand edits to structural elements (windows, doors, openings, mouldings) outside the WHITE mask.

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
