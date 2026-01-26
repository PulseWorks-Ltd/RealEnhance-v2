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
EXTERIOR ENHANCEMENT RECIPE (PHOTOGRAPHIC ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Reduce atmospheric haze / washed-out look with subtle dehaze and gentle micro-contrast.
- Improve midtone contrast for a crisp exterior; avoid HDR or halo artifacts.
- Balance exposure: lift shadows under eaves/darker areas while preserving highlights.
- Neutral, accurate white balance; clean natural tones (no color casts).
- Improve natural greens in foliage/grass slightly toward realistic greens (never neon or oversaturated).
- Soften harsh glare/specular hotspots without removing reflections entirely.
- Improve ground/surface tonal balance without changing materials or textures; no "drying" or material alteration.
- Apply light sharpening only; avoid halos and over-sharpening.`;

const EXTERIOR_QUALITY_TARGET = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXTERIOR QUALITY TARGET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Output should look like a professional real-estate exterior photo with crisp contrast and clean tones.
- Avoid flat or gray output; keep the scene natural and realistic.`;

const SKY_ENHANCEMENT_BLOCK = `SKY ENHANCEMENT (SKY ONLY — DO NOT TOUCH ROOFS/TREES/BUILDINGS)
- Improve the sky to a natural, attractive blue sky with realistic soft clouds.
- Edit the sky region only. Do not change anything outside the sky.
- Preserve rooflines, antennas, trees, foliage edges, and horizon perfectly (no cutouts, no warping).
- Match scene lighting and exposure; avoid over-saturated or fake skies.
- If the sky boundary is ambiguous or risky, skip sky changes entirely rather than damaging roofs/trees.`;

const STYLE_REALISM_EXTERIOR = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE & REALISM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Natural, realistic exterior appearance (real-estate ready).
- No surreal effects; no heavy HDR; no artificial textures.
- The result must still look like a real photograph.`;

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
    "",
    EXTERIOR_QUALITY_TARGET,
  ];

  if (skyEnhancementEnabled) {
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
  opts: { sceneSource?: SceneSource; enableSkyEnhancement?: boolean; replaceSkyIntent?: boolean } = {}
): Promise<string> {
  const sceneSource: SceneSource = opts.sceneSource || (sceneType && sceneType !== "auto" ? "manual" : "auto");
  const skySafetyPass = opts.enableSkyEnhancement === true;
  const replaceSkyIntent = opts.replaceSkyIntent === true;

  if (sceneType === "exterior") {
    const finalReplaceSky = replaceSkyIntent && skySafetyPass && sceneSource === "auto";
    const skyBlockInjected = finalReplaceSky;
    console.log(`[SKY_DECISION] variant=exterior sceneSource=${sceneSource} replaceSkyIntent=${replaceSkyIntent} safetyPass=${skySafetyPass} finalReplaceSky=${finalReplaceSky} skyBlockInjected=${skyBlockInjected}`);
    console.log(`[STAGE1A_VARIANT] variant=exterior finalReplaceSky=${finalReplaceSky}`);
    const prompt = buildStage1AExteriorPrompt({ skyEnhancementEnabled: finalReplaceSky, sceneSource });
    console.log(`[STAGE1A] variant=exterior skyEnhancement=${finalReplaceSky ? "enabled" : "disabled"} source=${sceneSource}`);
    return prompt;
  }

  console.log(`[STAGE1A] variant=interior`);
  return buildStage1AInteriorPrompt();
}
