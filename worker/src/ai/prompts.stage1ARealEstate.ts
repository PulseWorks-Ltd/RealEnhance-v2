// Stage 1A must remain enhancement-only. No declutter, no staging, no object changes.

type SceneVariant = "interior" | "exterior";

const ABSOLUTE_CONSTRAINTS_INTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE STAGE 1A CONSTRAINTS
(OVERRIDES ALL OTHER INSTRUCTIONS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST NOT:
- Remove, add, replace, move, resize, rotate, or alter any furniture or objects
- Declutter, simplify, tidy, clean up, or reduce visible items
- Add décor, styling, or furnishings
- Alter walls, floors, ceilings, doors, windows, or fixtures
- Change room layout, geometry, or camera perspective
- Hallucinate or invent any objects or details

If the room is cluttered, leave it cluttered.
If the room is empty, leave it empty.
If furniture is dated or unattractive, leave it exactly as-is.`;

const STRUCTURAL_PRESERVATION_INTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRUCTURAL & GEOMETRY PRESERVATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Preserve exact room dimensions and proportions
- Preserve all architectural features and openings
- Preserve camera angle, field of view, and lens characteristics`;

const ALLOWED_ENHANCEMENTS_INTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STAGE 1A – INTERIOR ALLOWED ENHANCEMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MAY ONLY perform photographic enhancements:

- Improve exposure balance, focusing on lifting midtones and shadow areas (walls, ceilings, corners) without flattening contrast
- Protect highlights around windows and light sources; avoid blown-out pure white window regions
- Correct white balance to achieve natural, neutral whites while preserving subtle warmth where appropriate
- Reduce mixed lighting colour casts gently (e.g. warm artificial + cool daylight)
- Apply subtle noise reduction in darker areas
- Apply very light sharpening and clarity to improve crispness (avoid halos, over-sharpening, or crunchy textures)
- Apply modest saturation only if needed to restore realism`;

const STYLE_REALISM_INTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE & REALISM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Natural, realistic interior appearance
- No HDR look
- No over-processing
- The result must look like the same room photographed in better light`;

const OUTPUT_REQ_INTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT REQUIREMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- The final image must look identical in content to the original
- Only lighting, colour, and clarity may differ`;

const ABSOLUTE_CONSTRAINTS_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE STAGE 1A CONSTRAINTS
(OVERRIDES ALL OTHER INSTRUCTIONS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST NOT:
- Remove, add, replace, move, resize, rotate, or alter any objects or structures
- Alter buildings, roofs, chimneys, trees, fences, paths, or landscaping
- Declutter or simplify the scene
- Add people, vehicles, or décor
- Change camera angle, geometry, or perspective

If elements appear messy or imperfect, leave them exactly as-is.`;

const STRUCTURAL_PRESERVATION_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRUCTURAL & GEOMETRY PRESERVATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Preserve exact rooflines, horizons, and silhouettes
- Preserve all architectural features and boundaries
- Preserve natural lighting direction and shadow placement`;

const ALLOWED_ENHANCEMENTS_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STAGE 1A – EXTERIOR ALLOWED ENHANCEMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MAY ONLY perform photographic enhancements:

- Reduce haze and improve clarity subtly while maintaining realism
- Improve overall contrast and exposure balance
- Reduce harsh glare and excessive specular highlights (do not remove reflections entirely)
- Improve grass and foliage colour slightly toward natural greens (never neon or over-saturated)
- If surfaces appear wet or dull due to lighting, you may lift midtones and reduce excessive shine to improve exposure balance (tonal correction only; do NOT change materials)
- Apply light sharpening and clarity
- Maintain natural shadow depth and lighting realism`;

const SKY_ENHANCEMENT_BLOCK = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXTERIOR SKY ENHANCEMENT – CONDITIONAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ONLY APPLY THIS SECTION IF:
- The image is an exterior scene
- Scene type was AUTO-DETECTED as exterior
- Sky enhancement is explicitly enabled

You MAY:
- Enhance or replace the SKY ONLY
- Improve sky colour, brightness, and cloud definition
- Replace a dull or overcast sky with a natural blue sky

You MUST:
- Treat the sky strictly as a background element
- Preserve exact rooflines, trees, buildings, and horizons
- Match sky lighting direction to the original scene
- Keep skies realistic and natural (no exaggerated drama)

You MUST NOT:
- Extend sky into non-sky regions
- Alter or remove roofs, trees, antennas, or structures
- Change shadows on buildings or ground
- Apply sky enhancement if the sky boundary is ambiguous

If the sky region is unclear or risky, DO NOT modify it.`;

const STYLE_REALISM_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE & REALISM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Clean, natural, real-estate appropriate appearance
- No artificial HDR or surreal effects
- The result must still look like a real photograph`;

const OUTPUT_REQ_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT REQUIREMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- The final image must match the original scene content
- Only lighting, colour, clarity, and (when allowed) sky may differ`;

/** Build Stage 1A Interior prompt (enhancement-only) */
export function buildStage1AInteriorPrompt(): string {
  return [
    "You are a professional real-estate photo editor.",
    "",
    "Your task is to ENHANCE the photographic quality of an INTERIOR image.",
    "This is NOT decluttering and NOT staging.",
    "",
    ABSOLUTE_CONSTRAINTS_INTERIOR,
    "",
    STRUCTURAL_PRESERVATION_INTERIOR,
    "",
    ALLOWED_ENHANCEMENTS_INTERIOR,
    "",
    STYLE_REALISM_INTERIOR,
    "",
    OUTPUT_REQ_INTERIOR,
    "",
    "The final image must be structurally identical and object-for-object identical.",
    "Enhance only."
  ].join("\n");
}

/** Build Stage 1A Exterior prompt (enhancement + conditional sky) */
export function buildStage1AExteriorPrompt(opts: { skyEnhancementEnabled: boolean; sceneSource: "auto" | "manual" }): string {
  const { skyEnhancementEnabled, sceneSource } = opts;
  const blocks = [
    "You are a professional real-estate photo editor.",
    "",
    "Your task is to ENHANCE the photographic quality of an EXTERIOR image.",
    "This is NOT decluttering and NOT staging.",
    "",
    ABSOLUTE_CONSTRAINTS_EXTERIOR,
    "",
    STRUCTURAL_PRESERVATION_EXTERIOR,
    "",
    ALLOWED_ENHANCEMENTS_EXTERIOR,
  ];

  if (skyEnhancementEnabled && sceneSource === "auto") {
    blocks.push("", SKY_ENHANCEMENT_BLOCK);
  }

  blocks.push("", STYLE_REALISM_EXTERIOR, "", OUTPUT_REQ_EXTERIOR, "", "The final image must be structurally identical and object-for-object identical.", "Enhance only.");

  return blocks.join("\n");
}

type SceneSource = "auto" | "manual";

/**
 * Select the appropriate Stage 1A prompt based on scene type.
 * - Interior: canonical enhancement-only prompt
 * - Exterior: enhancement-only plus conditional sky block when auto-detected & enabled
 */
export async function selectStage1APrompt(
  sceneType: SceneVariant | string | undefined,
  _inputPath: string,
  _skyMode: "safe" | "strong" = "safe",
  opts: { sceneSource?: SceneSource; enableSkyEnhancement?: boolean } = {}
): Promise<string> {
  const sceneSource: SceneSource = opts.sceneSource || (sceneType && sceneType !== "auto" ? "manual" : "auto");
  const enableSkyEnhancement = opts.enableSkyEnhancement === true;

  if (sceneType === "exterior") {
    const prompt = buildStage1AExteriorPrompt({ skyEnhancementEnabled: enableSkyEnhancement && sceneSource === "auto", sceneSource });
    console.log(`[STAGE1A] variant=exterior skyEnhancement=${enableSkyEnhancement && sceneSource === "auto" ? "enabled" : "disabled"} source=${sceneSource}`);
    return prompt;
  }

  console.log(`[STAGE1A] variant=interior`);
  return buildStage1AInteriorPrompt();
}
