// worker/src/pipeline/prompts.ts

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
  hasStage1ABaseline?: boolean;
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
  hasStage1ABaseline = false,
}: RegionEditPromptArgs): string {
  const roomLabel = roomType
    ? `This is a ${roomType.replace(/_/g, " ")}.`
    : "This is a real estate photograph of a room.";

  const sceneLabel = `Scene type: ${sceneType}.`;
  const preserveHint = preserveStructure
    ? "Preserve all structural elements unless they are explicitly inside the white mask."
    : "";

  const stage1AHint = hasStage1ABaseline
    ? `
STAGE 1A BASELINE REFERENCE:
You have also been provided a STAGE_1A_BASELINE_IMAGE. This is the enhanced empty-room image
BEFORE any furniture was staged. Use it as a direct reference for what the walls, floor, and
architectural surfaces look like behind the item being removed. Reproduce those surfaces
faithfully — match the exact colors, textures, lighting, and perspective visible in the
baseline image for the masked region. Do NOT invent or hallucinate surface details when the
baseline clearly shows them.
`
    : "";

  const inputList = hasStage1ABaseline
    ? `- BASE_IMAGE_TO_EDIT
- STAGE_1A_BASELINE_IMAGE (empty-room reference for what is behind the removed item)
- EDIT_MASK_IMAGE (WHITE = editable region, BLACK = locked region)`
    : `- BASE_IMAGE_TO_EDIT
- EDIT_MASK_IMAGE (WHITE = editable region, BLACK = locked region)`;

  return `
You are a professional real-estate photo editor.

${roomLabel}
${sceneLabel}

You will receive:
${inputList}

${STRICT_EDIT_PROMPT}
${stage1AHint}
${preserveHint}

USER INSTRUCTION:
"""${userInstruction}"""
`;
}
