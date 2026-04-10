// worker/src/pipeline/prompts.ts

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
};

const STRICT_EDIT_PROMPT = `
IMPORTANT: This image has ALREADY been virtually staged. You are making a TARGETED EDIT to an existing staged image — you are NOT re-staging or re-enhancing the room.

Apply the requested edit ONLY within the white mask region.

Do not modify anything outside the mask.
Keep the rest of the image pixel-identical.

COLOR & TONE PRESERVATION:
- Match the existing lighting, color temperature, white balance, and tonal range of the surrounding image exactly.
- Do NOT apply any overall image enhancement, brightening, contrast boost, or color grading.
- Do NOT re-interpret or re-render existing furniture, decor, or surfaces.
- The edited region must blend seamlessly with the surrounding pixels in tone, saturation, and brightness.

STRUCTURAL CONSTRAINTS — Do not change:
- walls, ceilings, floors
- windows, doors, architectural openings
- camera viewpoint, perspective, or depth
- any existing objects outside the masked region

Follow the user's instruction exactly.
`;

export function buildRegionEditPrompt({
  userInstruction,
  roomType,
  sceneType = "interior",
  preserveStructure = true,
}: RegionEditPromptArgs): string {
  const roomLabel = roomType
    ? `This is a ${roomType.replace(/_/g, " ")}.`
    : "This is a real estate photograph of a room.";

  const sceneLabel = `Scene type: ${sceneType}.`;
  const preserveHint = preserveStructure
    ? "Preserve all structural elements unless they are explicitly inside the white mask."
    : "";

  return `
You are a professional real-estate photo editor.

${roomLabel}
${sceneLabel}

You will receive:
- BASE_IMAGE_TO_EDIT
- EDIT_MASK_IMAGE (WHITE = editable region, BLACK = locked region)

${STRICT_EDIT_PROMPT}

${preserveHint}

USER INSTRUCTION:
"""${userInstruction}"""
`;
}
