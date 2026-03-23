// worker/src/pipeline/prompts.ts

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
};

const STRICT_EDIT_PROMPT = `
Apply the requested edit ONLY within the white mask.

Do not modify anything outside the mask.

Keep the rest of the image unchanged.

Do not change:
- walls
- ceilings
- floors
- windows
- doors
- camera viewpoint

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
