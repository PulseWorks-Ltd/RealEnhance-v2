// worker/src/pipeline/prompts.ts

import { buildIntentPrompt } from "./intentPrompts";
import { classifyEditIntent, isStructuralEdit, type EditIntent } from "./intentClassifier";

type RegionEditPromptArgs = {
  userInstruction: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  preserveStructure?: boolean;
  editContext?: EditContext;
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

export type EditMode = "remove" | "replace" | "add" | "reinstate";

type LegacyEditMode = "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";

type BuildEditPromptParams = {
  mode: EditMode;
  userIntent?: string;
  sceneHint?: string;
};

export type EditContext = {
  roomType?: "bedroom" | "living_room" | "kitchen" | string;
  stagingStyle?: string;
  layoutHints?: string[];
  anchorConstraints?: string[];
};

export const BASE_SYSTEM_PROMPT = `
You are generating a replacement image patch for a masked region of a photo.

This is a patch generation task, not a subtle edit task.

You must regenerate the content inside the target region according to the instruction.

Rules:
- Do not preserve original content unless the instruction explicitly requires restoration.
- Output must be photorealistic.
- Match lighting, perspective, geometry, materials, and environment consistency.
- Blend seamlessly with the surrounding image outside the region.
- Do not redesign the wider scene outside the requested region.

The generated region must remain consistent with the surrounding image.

Do not introduce changes that would visibly conflict with adjacent areas, including:
- mismatched colours (for example changing a white wall to blue)
- inconsistent materials or textures
- lighting or shadow direction differences

The edit must blend seamlessly so the full image appears natural and unchanged outside the intended modification.
`;

const BLENDING_CONSTRAINTS = `
Photorealism and blending requirements:
- Match the surrounding lighting direction, exposure, shadows, white balance, and perspective.
- Match nearby surfaces, materials, texture scale, and edge continuity.
- Ensure the generated patch integrates naturally with the surrounding image.
- Do not leave outlines, ghosting, seams, or incomplete reconstruction artifacts.
`.trim();

const DESTRUCTIVE_REGENERATION_CLAUSE = `
Regenerate the region sufficiently to achieve the requested outcome.

Do not make minimal or barely visible changes, but also do not introduce unnecessary changes that conflict with surrounding context.
`.trim();

const NON_TARGET_PROTECTION_CLAUSE = `
Do not redesign or reinterpret the wider image outside the requested patch.
Keep architectural perspective and environmental continuity consistent with the surrounding scene.
`.trim();

const STRUCTURE_LOCK = `
Preserve EXACTLY:
- walls
- windows
- doors
- ceilings
- floors
- roofline
- perspective
- camera viewpoint
- architectural openings
- built-in fixtures

Do not alter architectural structure.
Do not add or remove openings.
Do not change room geometry.
`.trim();

function formatReinstateTargetLabel(targetType: "window" | "doorway" | "opening" | "auto"): string {
  if (targetType === "doorway") return "doorway";
  if (targetType === "window") return "window";
  if (targetType === "opening") return "reference content";
  return "reference content";
}

function buildModeSceneHint(sceneHint?: string): string {
  return sceneHint?.trim() || "Context: This is an interior scene.";
}

function resolveIntentForMode(mode: EditMode, intent: EditIntent): EditIntent {
  if (mode === "remove") {
    if (intent === "trim_landscaping" || intent === "clean_surface" || intent === "repair_surface") {
      return "declutter";
    }
  }

  if (mode === "reinstate") {
    return "generic";
  }

  return intent;
}

function buildRemovePrompt(userIntent?: string, sceneHint?: string): string {
  return `
Remove the specified content from this region and reconstruct the area as if the removed content never existed.

${STRUCTURE_LOCK}

${buildModeSceneHint(sceneHint)}

Removal requirements:
- Rebuild the background and surrounding surfaces completely inside the region.
- Restore plausible wall, floor, ceiling, ground, sky, landscaping, or architectural surface continuity as needed.
- Preserve realistic geometry, depth, texture, and lighting.
- Reconstruct the background so it matches surrounding surfaces exactly.
- The result must be visually indistinguishable from adjacent areas.

${BLENDING_CONSTRAINTS}

${DESTRUCTIVE_REGENERATION_CLAUSE}

${NON_TARGET_PROTECTION_CLAUSE}

User intent: ${userIntent?.trim() || "Remove unwanted elements."}
`;
}

function buildReplacePrompt(userIntent?: string, sceneHint?: string): string {
  return `
Replace the entire content of this region with the requested new content.

${STRUCTURE_LOCK}

${buildModeSceneHint(sceneHint)}

Replacement requirements:
- Fully overwrite the existing content inside the region.
- Generate the requested replacement content at realistic scale and placement.
- Match surrounding materials, perspective, lighting, and scene depth.
- Replace the content while maintaining consistency with surrounding materials, colours, and lighting.
- Do not introduce contrasting or conflicting elements unless explicitly requested.

${BLENDING_CONSTRAINTS}

${DESTRUCTIVE_REGENERATION_CLAUSE}

${NON_TARGET_PROTECTION_CLAUSE}

Requested replacement: ${userIntent?.trim() || "Replace the current content with the most plausible requested result."}
`;
}

function buildAddPrompt(userIntent?: string, sceneHint?: string): string {
  return `
Add the requested content into this region as a complete, photorealistic insertion.

${STRUCTURE_LOCK}

${buildModeSceneHint(sceneHint)}

Addition requirements:
- Generate the added content so it is clearly present, physically grounded, and realistically supported.
- Match scale, perspective, contact shadows, and material realism.
- Keep the addition coherent with the surrounding scene and spatial layout.
- Ensure the added object integrates naturally with the surrounding environment in colour, lighting, and perspective.

${BLENDING_CONSTRAINTS}

${DESTRUCTIVE_REGENERATION_CLAUSE}

${NON_TARGET_PROTECTION_CLAUSE}

Requested addition: ${userIntent?.trim() || "Add the requested content naturally within the region."}
`;
}

function buildReinstatePrompt(
  userIntent?: string,
  sceneHint?: string,
  targetType: "window" | "doorway" | "opening" | "auto" = "auto"
): string {
  const targetLabel = formatReinstateTargetLabel(targetType);
  return `
Restore the original ${targetLabel} content that should exist inside this region.

${buildModeSceneHint(sceneHint)}

Reinstatement requirements:
- Restore the original structure, material, and appearance faithfully.
- Do not redesign or improve the content. Restore it faithfully.
- If exact content is partially unclear, infer only the most plausible original state from the surrounding context.
- Preserve realistic architectural alignment, material continuity, and environmental consistency.
- Restore the original content while preserving consistency with surrounding areas.
- Do not reinterpret or improve; match the existing scene.

${BLENDING_CONSTRAINTS}

${DESTRUCTIVE_REGENERATION_CLAUSE}

${NON_TARGET_PROTECTION_CLAUSE}

Restoration request: ${userIntent?.trim() || "Reinstate the original content that belongs in this region."}
`;
}

function humanizeContextLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeContextItems(items: string[] | undefined, limit = 5): string[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    const text = humanizeContextLabel(item);
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(text);
    if (normalized.length >= limit) break;
  }

  return normalized;
}

function buildLegacySceneDetail(editContext: EditContext | undefined, roomType: string | undefined): string | undefined {
  const roomLabel = humanizeContextLabel(editContext?.roomType || roomType);
  const styleLabel = humanizeContextLabel(editContext?.stagingStyle);

  if (roomLabel && styleLabel) {
    return `${roomLabel} with ${styleLabel} styling`;
  }

  return roomLabel || styleLabel || undefined;
}

export function normalizeEditMode(mode: string): EditMode {
  switch (String(mode || "").trim()) {
    case "Restore":
    case "Reinstate":
      return "reinstate";
    case "Remove":
      return "remove";
    case "Replace":
      return "replace";
    case "Add":
      return "add";
    default:
      throw new Error(`Unsupported edit mode: ${mode}`);
  }
}

export function buildSceneHint(sceneType: "interior" | "exterior", sceneDetail?: string): string {
  const normalizedDetail = humanizeContextLabel(sceneDetail);
  return normalizedDetail
    ? `Context: This is an ${sceneType} scene showing ${normalizedDetail}.`
    : `Context: This is an ${sceneType} scene.`;
}

export function buildEditPrompt({ mode, userIntent, sceneHint }: BuildEditPromptParams): { system: string; user: string } {
  const normalizedUserIntent = String(userIntent || "").trim();
  if (isStructuralEdit(normalizedUserIntent)) {
    const error = new Error("Structural edits are not supported. Please try a non-structural edit.") as Error & { code?: string };
    error.code = "STRUCTURAL_EDIT_NOT_ALLOWED";
    throw error;
  }

  const rawIntent = classifyEditIntent(normalizedUserIntent);
  const resolvedIntent = resolveIntentForMode(mode, rawIntent);
  const intentPrompt = buildIntentPrompt(resolvedIntent, normalizedUserIntent);
  console.info("EDIT_INTENT_CLASSIFICATION", {
    mode,
    rawIntent,
    resolvedIntent,
    userInstruction: normalizedUserIntent,
  });

  let modePrompt = "";

  switch (mode) {
    case "remove":
      modePrompt = buildRemovePrompt(userIntent, sceneHint);
      break;
    case "replace":
      modePrompt = buildReplacePrompt(userIntent, sceneHint);
      break;
    case "add":
      modePrompt = buildAddPrompt(userIntent, sceneHint);
      break;
    case "reinstate":
      modePrompt = buildReinstatePrompt(userIntent, sceneHint);
      break;
    default:
      throw new Error(`Unsupported edit mode: ${mode}`);
  }

  return {
    system: BASE_SYSTEM_PROMPT.trim(),
    user: `${intentPrompt.trim()}\n\n${modePrompt.trim()}`.trim(),
  };
}

export function buildRegionEditPrompt({
  userInstruction,
  roomType,
  sceneType = "interior",
  editContext,
  editMode = "Replace",
  reinstateConfig,
}: RegionEditPromptArgs): string {
  const normalizedMode = normalizeEditMode(editMode as LegacyEditMode);
  const sceneHint = buildSceneHint(sceneType, buildLegacySceneDetail(editContext, roomType));
  const prompt = buildEditPrompt({
    mode: normalizedMode,
    userIntent: userInstruction,
    sceneHint,
  });

  const reinstateGeometry = normalizedMode === "reinstate" && reinstateConfig?.geometry?.bbox
    ? `

Reference geometry:
- x=${reinstateConfig.geometry.bbox.x.toFixed(4)}
- y=${reinstateConfig.geometry.bbox.y.toFixed(4)}
- width=${reinstateConfig.geometry.bbox.width.toFixed(4)}
- height=${reinstateConfig.geometry.bbox.height.toFixed(4)}`
    : "";
  const reinstateTarget = normalizedMode === "reinstate"
    ? `

Reference target: restore the ${formatReinstateTargetLabel(reinstateConfig?.targetType || "auto")}.${reinstateGeometry}`
    : "";

  return `${prompt.system.trim()}

${prompt.user.trim()}${reinstateTarget}`.trim();
}
