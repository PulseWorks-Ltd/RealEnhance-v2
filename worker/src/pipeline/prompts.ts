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

You will receive TWO images:
1. IMAGE 1: The base photograph of the room (the original image to edit)
2. IMAGE 2: A binary mask showing the edit region (WHITE = edit this area, BLACK = don't touch)

Your job is to apply the user's instruction ONLY to the WHITE pixels in the mask image (IMAGE 2).

USER INSTRUCTION (apply this ONLY where IMAGE 2 shows WHITE pixels):
"""${userInstruction}"""

⚠️ CRITICAL MASK INTERPRETATION RULES:
- IMAGE 2 (the mask) uses this format: WHITE pixels = area to edit, BLACK pixels = area to keep unchanged
- You MUST apply the edit ONLY where IMAGE 2 shows WHITE pixels
- You MUST keep everything pixel-perfect identical where IMAGE 2 shows BLACK pixels
- Think of the mask like a stencil: you can only paint through the white holes
- If the user says "paint this wall red" and IMAGE 2 shows white on the RIGHT side, paint the RIGHT side red
- If IMAGE 2 shows white on the LEFT side, paint the LEFT side
- Do NOT apply the instruction to black-masked areas
- Do NOT edit ANY area where IMAGE 2 is black, no matter what the instruction says
- If you see multiple walls/surfaces in IMAGE 1, ONLY edit the specific wall/surface that has WHITE pixels in IMAGE 2

BLENDING / OUTSKIRTS RULES (IMPORTANT):
- You may perform minimal blending or anti-aliasing around the WHITE mask boundary to ensure seamless transitions, but this must be strictly limited to a very small margin (suggested: no more than a few pixels relative to the image resolution). Use the smallest feather that preserves visual continuity.
- You MUST NOT use this allowance to modify distinct nearby surfaces, different walls, or objects that are clearly outside the masked area. For example, if the mask covers the RIGHT wall, do not change the LEFT wall or any other wall's color, texture, or content.
- Do NOT expand edits to cover additional structural elements (windows, doors, mouldings) that are outside the white mask even partially; instead, if a feature crosses the mask boundary, prefer surface-level treatments (e.g., paint, curtain, patch) that preserve geometry and position.
- If the required edit would necessarily change structure beyond this tiny blending margin (for example moving a window or altering wall shape), refuse and suggest an alternative that preserves structure (e.g., apply a surface treatment or decorative solution).

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
