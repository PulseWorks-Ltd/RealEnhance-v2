// worker/src/pipeline/prompts.ts

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
  hasStage1ABaseline?: boolean;
  editMode?: "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";
  reinstateConfig?: {
    targetType: "window" | "doorway" | "opening" | "auto";
    geometry?: {
      bbox: { x: number; y: number; width: number; height: number };
      confidence?: number;
      openingId?: string;
    };
  };
};

const COMMON_EDIT_PROMPT = `
IMPORTANT: This image has ALREADY been virtually staged. You are making a TARGETED EDIT to an existing staged image — you are NOT re-staging or re-enhancing the room.

Apply the requested edit ONLY within the white mask region.

Do not modify anything outside the mask.
Keep the rest of the image pixel-identical.

COLOR & TONE PRESERVATION:
- Match the existing lighting, color temperature, white balance, and tonal range of the surrounding image exactly.
- Do NOT apply any overall image enhancement, brightening, contrast boost, or color grading.
- Do NOT re-interpret or re-render existing furniture, decor, or surfaces.
- The edited region must blend seamlessly with the surrounding pixels in tone, saturation, and brightness.

Follow the user's instruction exactly.
`;

const STRUCTURAL_LOCK_PROMPT = `
STRUCTURAL CONSTRAINTS — Do not change:
- walls, ceilings, floors
- windows, doors, architectural openings
- camera viewpoint, perspective, or depth
- any existing objects outside the masked region

Follow the user's instruction exactly.
`;

function formatReinstateTargetLabel(targetType: "window" | "doorway" | "opening" | "auto"): string {
  if (targetType === "doorway") return "doorway";
  if (targetType === "window") return "window";
  if (targetType === "opening") return "architectural opening";
  return "requested architectural opening";
}

function buildReinstateModeHint(targetType: "window" | "doorway" | "opening" | "auto"): string {
  const targetLabel = formatReinstateTargetLabel(targetType);
  return `
REINSTATE MODE — ARCHITECTURAL RECOVERY:
You are restoring a ${targetLabel} that should exist in the room.

Inputs:
- BASE_IMAGE_TO_EDIT is the current enhanced image and is the ground truth for lighting, style, furniture, and all non-target content.
- STAGE_1A_BASELINE_IMAGE is a structural reference that shows the original architectural opening.

Instructions:
1. Restore ONLY the requested architectural opening inside the masked region.
2. Use the reference image ONLY to reconstruct the opening (frame, glass, doorway shape, trim, and visible wall boundary).
3. Do NOT restore furniture, decor, rugs, wall art, or any movable objects from the reference image.

OCCLUSION RULES:
- If an object fully blocks the opening, remove that object and restore the opening.
- If an object partially overlaps the opening, restore the opening behind the object and keep the visible object natural.
- If the opening is already visible and structurally correct, make no change.

GEOMETRY RULES:
- The highlighted region corresponds to a precise architectural opening.
- The bounding box defines the exact geometry of the opening.
- Reconstruct the opening exactly within this region.
- Do not expand or shrink the opening beyond this area.
- If objects overlap, preserve their visible edges and reconstruct the opening only behind them.

STRICT RULES:
- Do not alter any other part of the image.
- Do not modify any other openings.
- Do not change camera perspective.
- Match the surrounding enhanced image exactly in colour, tone, lighting, and finish.
`;
}

export function buildRegionEditPrompt({
  userInstruction,
  roomType,
  sceneType = "interior",
  preserveStructure = true,
  hasStage1ABaseline = false,
  editMode,
  reinstateConfig,
}: RegionEditPromptArgs): string {
  const roomLabel = roomType
    ? `This is a ${roomType.replace(/_/g, " ")}.`
    : "This is a real estate photograph of a room.";

  const sceneLabel = `Scene type: ${sceneType}.`;
  const preserveHint = preserveStructure
    ? "Preserve all structural elements unless they are explicitly inside the white mask."
    : "";
  const isReinstateMode = editMode === "Reinstate";

  const addModeHint = editMode === "Add"
    ? `
ADD MODE — PLACEMENT & REALISM GUIDELINES:
The mask shows approximately WHERE the user wants the new item placed. Place one
appropriately-sized item within the masked area — do NOT fill the entire mask with furniture.

PLACEMENT:
- The item must sit naturally on the correct surface (floor, countertop, table, wall).
- It must NOT float, clip through other objects, or overlap existing furniture.
- Respect the room's perspective, depth, and vanishing points — scale the item so it
  appears the correct real-world size at that depth in the scene.

STYLE MATCHING:
- Match the existing décor style, material palette, and colour tones already present
  in the staged image. If the room is mid-century modern, the added item should be
  mid-century modern. If the room is coastal, match that.

LIGHTING & SHADOWS:
- The added item must be lit consistently with the existing light direction and intensity
  in the scene.
- Render a natural shadow or ambient occlusion beneath / behind the item that matches
  the shadow characteristics of other objects in the image.
- Do NOT add the item as a flat, shadow-less cutout.
`
    : "";

  const reinstateModeHint = isReinstateMode
    ? `${buildReinstateModeHint(reinstateConfig?.targetType || "auto")}${reinstateConfig?.geometry?.bbox
        ? `

PRECISE OPENING GEOMETRY:
- x=${reinstateConfig.geometry.bbox.x.toFixed(4)}
- y=${reinstateConfig.geometry.bbox.y.toFixed(4)}
- width=${reinstateConfig.geometry.bbox.width.toFixed(4)}
- height=${reinstateConfig.geometry.bbox.height.toFixed(4)}
`
        : ""}`
    : "";

  const stage1AHint = hasStage1ABaseline && editMode === "Remove"
    ? `
MASK INTERPRETATION FOR REMOVAL:
The white mask region shows you WHERE to focus — it is an approximate area of interest, NOT
a command to repaint the entire region. Read the user's text instruction to understand WHAT
specifically needs to be removed. If the user asks to remove a single item that occupies only
part of the mask, remove ONLY that item and leave everything else in the masked area
untouched. Do not alter, regenerate, or repaint portions of the mask that are not related
to the user's removal request.

STAGE 1A STRUCTURAL REFERENCE (reference only — do NOT reproduce):
You have also been provided a STAGE_1A_BASELINE_IMAGE. This is the original property photo
BEFORE any virtual staging was applied. It may contain the original real furniture, wall art,
rugs, decorations, and other movable items that were present in the property at the time of
photography.

USE THIS REFERENCE ONLY TO:
- Understand what structural surfaces (walls, floor, ceiling, architraves, skirting boards,
  cornices, built-in cabinetry) exist behind the staged item being removed
- Gauge the general geometry, perspective lines, and surface materials in that area

DO NOT:
- Reproduce or copy pixel colors, tones, or lighting from the reference image
- Reintroduce ANY furniture, wall art, rugs, decorations, soft furnishings, or movable items
  that appear in the reference but are NOT in the current enhanced image
- Revert any colour grading, lighting improvements, or styling present in the enhanced image
- Treat the reference as a restoration target — it is a structural hint ONLY

The cleared area MUST match the colour, tone, lighting, and style of the SURROUNDING
ENHANCED IMAGE (the BASE_IMAGE_TO_EDIT), NOT the reference. Seamlessly extend the existing
enhanced surfaces into the area where the removed item was.
`
    : "";

  const inputList = hasStage1ABaseline
    ? `- BASE_IMAGE_TO_EDIT (the current enhanced/staged image — this is the ground truth)
- STAGE_1A_BASELINE_IMAGE (original property photo — structural reference ONLY, do NOT reproduce its contents)
- EDIT_MASK_IMAGE (WHITE = area of interest to focus on, BLACK = locked region)`
    : `- BASE_IMAGE_TO_EDIT
- EDIT_MASK_IMAGE (WHITE = editable region, BLACK = locked region)`;

  return `
You are a professional real-estate photo editor.

${roomLabel}
${sceneLabel}

You will receive:
${inputList}

${COMMON_EDIT_PROMPT}
${isReinstateMode ? reinstateModeHint : STRUCTURAL_LOCK_PROMPT}
${addModeHint}
${stage1AHint}
${isReinstateMode ? "" : preserveHint}

USER INSTRUCTION:
"""${userInstruction}"""
`;
}
