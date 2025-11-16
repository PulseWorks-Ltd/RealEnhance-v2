// worker/src/ai/prompts-test.ts
// Concise test prompts with embedded temperature per stage and scene.

export type TestScene = "interior" | "exterior" | "auto";
export type TestStage = "1A" | "1B" | "2";

function resolveScene(scene?: TestScene): "interior" | "exterior" {
  if (scene === "interior" || scene === "exterior") return scene;
  return "interior"; // default for safety
}

function formatTemp(t: number): string {
  return Number(t.toFixed(3)).toString();
}

export function getEmbeddedTemp(stage: TestStage, scene?: TestScene): number {
  const s = resolveScene(scene);
  if (stage === "2") {
    return s === "interior" ? 0.10 : 0.08;
  }
  if (stage === "1B") {
    // Declutter + enhance; interior/exterior supported
    return s === "interior" ? 0.35 : 0.28;
  }
  // 1A enhance-only
  return s === "interior" ? 0.30 : 0.20;
}

export function tightenPromptAndLowerTemp(prompt: string, factor = 0.8): string {
  // Reduce embedded temp by factor if a line like "Temperature: X" exists; else inject one at top with 0.1
  const lines = prompt.split(/\r?\n/);
  let foundIdx = lines.findIndex(l => /^\s*temperature\s*:/i.test(l));
  if (foundIdx !== -1) {
    const m = lines[foundIdx].match(/(:)\s*([0-9]*\.?[0-9]+)/);
    if (m) {
      const current = parseFloat(m[2]);
      const next = Math.max(0.05, current * factor);
      lines[foundIdx] = lines[foundIdx].replace(/(:)\s*([0-9]*\.?[0-9]+)/, `$1 ${formatTemp(next)}`);
    }
  } else {
    lines.unshift(`Temperature: 0.10`);
  }
  // Add an extra STRICT block to emphasize constraints
  lines.push(
    "",
    "STRICT MODE (VALIDATION FAILED):",
    "- Follow rules precisely; prioritize safety over creativity.",
    "- Do NOT alter architecture or camera; keep windows/doors fully visible.",
    "- If unsure, omit conflicting items rather than breaking rules."
  );
  return lines.join("\n");
}

const RULE_PREFIX = `This is a RULE-BASED task with NON-NEGOTIABLE constraints. If any instruction conflicts, ALWAYS preserve the original image geometry, camera angle, and architectural layout exactly as given.\n\n`;

export function buildTestStage1APrompt(sceneType: string, roomType?: string) {
  if (sceneType === "interior") {
    return RULE_PREFIX + `
Enhance this ${roomType || "room"} interior image for real estate marketing.

Your ONLY tasks:
• Improve exposure and balance lighting.
• Improve color accuracy and white balance.
• Increase clarity and sharpness.
• Reduce noise and minor artifacts.

HARD RULES — NON-NEGOTIABLE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT change, resize, move, hide, or replace any architecture.
• Do NOT modify windows, doors, trims, cupboards, walls, ceilings, or flooring.
• Do NOT add, remove, or modify any furniture, decor, appliances, or fixtures.
• Do NOT invent geometry or create new surfaces.

Only enhance image quality. No generative structural changes.
Temperature: 0.18
`;
  }
  // exterior
  return RULE_PREFIX + `
Enhance this exterior property image for real estate marketing.

Your tasks:
• Improve exposure, color, clarity, and sharpness.
• Replace an overcast sky with a natural blue sky with soft clouds.
• Add subtle, realistic warm sunlight appropriate to the scene.
• Improve lawn health, fill patchy grass, and trim lawn edges.
• Clean visible driveways, paths, patios, decks, fences, and walls to remove dirt, mould, and stains by roughly 30–40%, while keeping material and pattern identical.

HARD RULES — NON-NEGOTIABLE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT change, resize, move, hide, or replace any buildings, rooflines, cladding, windows, or doors.
• Do NOT alter driveway, deck, or path shape, boundaries, layout, or material pattern (e.g., pavers, concrete joints).
• Do NOT add or remove permanent structures, fences, retaining walls, or permanent landscaping.
• Do NOT add or remove vehicles or large permanent items.

Only enhance existing materials and cleanliness. No generative structural changes.
Temperature: 0.21
`;
}

export function buildTestStage1BPrompt(sceneType: string, roomType?: string) {
  if (sceneType === "interior") {
    return RULE_PREFIX + `
Remove ALL movable furniture and household items from this ${roomType || "room"} interior, to prepare it for digital staging.

REMOVE:
• Sofas, armchairs, beds, side tables, dining tables, chairs, consoles, dressers, nightstands, desks, freestanding shelving units, bookcases, wardrobes, TV units.
• Lamps, rugs, wall art, decor items, toys, electronics, plants.
• Countertop clutter, small appliances, and items on window sills.
• Loose textiles like throws and cushions.

KEEP EXACTLY:
• Built-in stoves/ovens, cabinets, countertops, vanities, fixed shelving.
• ALL windows, blinds, curtains, doors, trims, skirtings, and architectural features.
• Original walls, ceilings, flooring, and their colors and materials.

HARD RULES — NON-NEGOTIABLE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT change, resize, move, hide, or replace any architecture.
• Do NOT alter window shapes, frames, views, or door openings.
• Do NOT repaint or re-texture walls, ceilings, or floors.
• Do NOT create new built-ins or structural elements.

Produce a clean, empty version of the room with identical architecture, ready for staging.
Temperature: 0.30
`;
  }
  // exterior
  return RULE_PREFIX + `
Declutter this exterior property image for real estate marketing.

REMOVE:
• Hoses, garden tools, bins, toys, tarps, and temporary equipment.
• Vehicles, trailers, and temporary construction items.
• Loose clutter on lawns, decks, and driveways.

KEEP EXACTLY:
• All buildings, windows, doors, rooflines, fences, gates, retaining walls.
• All permanent landscaping, trees, shrubs, and garden beds.
• All driveways, paths, decks, and hard surfaces with their original shape and material pattern.

HARD RULES — NON-NEGOTIABLE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT change, resize, move, or remove any permanent structure or landscaping.
• Do NOT alter driveway, deck, or path geometry.

Only remove transient clutter. No structural or material changes.
Temperature: 0.27
`;
}

export function buildTestStage2Prompt(sceneType: string, roomType?: string) {
  if (sceneType === "interior") {
    return RULE_PREFIX + `
Stage this ${roomType || "room"} interior with realistic, modern furniture suitable for real estate marketing.

HARD RULES — BASE IMAGE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT modify any existing pixels of the base room: no changes to walls, ceilings, floors, windows, doors, trims, cupboards, or lighting.
• Do NOT repaint, re-texture, or change materials or colors of any existing surfaces or fixtures.

FURNITURE RULES:
• You may ONLY ADD movable furniture and decor on top of the existing image.
• Furniture must be correctly scaled to the room.
• Do NOT obstruct or cover doors, cupboards, or walkways.
• Do NOT cover any part of a window above ~40% of its height. The upper part of all windows must remain fully visible.
• Furniture must not intersect walls or built-in objects.

Do not add new structural features, built-ins, or architectural changes. Only add furniture and light decor.
Temperature: 0.10
`;
  }
  // exterior
  return RULE_PREFIX + `
Stage this outdoor area with realistic outdoor furniture for real estate marketing. Only proceed if there is sufficient hard-surface area (deck, patio, or paving).

HARD RULES — BASE IMAGE:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe, zoom, or change the camera angle or perspective.
• Do NOT modify any buildings, rooflines, cladding, windows, doors, fences, railings, or permanent landscaping.
• Do NOT change lawn, garden bed shapes, or driveway layout.

FURNITURE RULES:
• Add ONE furniture set (e.g., table + chairs OR lounge set) plus a few potted plants ONLY on hard surfaces (decking, pavers, concrete).
• Do NOT place furniture on grass, garden beds, soil, or driveways.
• Ensure furniture scale and shadows are consistent with existing lighting.

Only add outdoor furniture and potted plants on valid hard surfaces. No structural or landscaping changes.
Temperature: 0.12
`;
}

// ----- Stage 1A: Enhance-only (concise, directive) -----

// ----- Stage 1B: Enhance + Declutter (single-pass) -----
