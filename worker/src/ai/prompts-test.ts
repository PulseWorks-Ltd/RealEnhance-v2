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
Remove ALL movable furniture, decor, and household items from this ${roomType || "room"}
interior, to prepare it for digital staging.

REMOVE (full list):
• All sofas, armchairs, ottomans, coffee tables, side tables, dining tables,
  chairs, consoles, bookcases, shelving units, nightstands, beds, TV units.
• All lamps, rugs, cushions, blankets, throws, baskets, plants (real or fake).
• ALL wall-mounted artwork, frames, pictures, clocks, mirrors, and decorative
  plates or ornaments on walls.
• ALL decor and clutter on ANY surface:
  – kitchen counters  
  – benchtops  
  – islands  
  – shelves  
  – desks  
  – cabinets  
  – sideboards  
  – window sills  
  – breakfast bars  
• ALL bottles, jars, trays, soap, fruit bowls, dishes, spices, utensils,
  appliances, and ANY visible loose items in the kitchen area.
• All partially visible furniture or decor: if ANY part of a removable item is
  visible, remove ALL of its visible pixels. Do NOT leave partial fragments.

KEEP EXACTLY:
• Built-in stoves/ovens, range hoods, sinks, taps, cabinets, countertops,
  fixed shelving, and all permanently attached fixtures.
• All windows, blinds, curtains, doors, trims, skirting boards, and all
  architectural features.
• Original walls, ceilings, flooring, and their colors and materials.

STRICT RULES:
• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, reframe,
  zoom, or change the camera angle or perspective.
• Do NOT change, move, or replace any architecture.
• Do NOT alter the shape, size, location, or framing of windows or doors.
• Do NOT repaint, brighten, recolor, or re-texture walls, ceilings, or floors.
• Do NOT create new structures, cabinets, or built-in elements.

Produce a completely empty, clutter-free room with ONLY the permanent
architecture and fixed kitchen fixtures remaining — ready for virtual staging.
Temperature: 0.60
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
    const rt = roomType || "room";
    return RULE_PREFIX + `
You are a professional real estate photo stylist.
Your job is to VIRTUALLY STAGE this empty ${rt} with realistic, modern furniture that suits the architecture and is ready for sale listing photos.

GENERAL BEHAVIOUR:
• Treat the input image as a locked background plate.
• Think like a real interior designer preparing a real listing: logical layout, comfortable circulation, and correct scale.
• If the supplied room type seems wrong for the space, quietly pick the best matching common room type instead and stage for that.

HARD RULES — BASE IMAGE (MUST NEVER BE BROKEN):
• Use the image EXACTLY as provided.
• Do NOT rotate, crop, reframe, zoom, or change the camera angle or perspective.
• Do NOT modify any existing pixels of the base room:
  - No changes to walls, ceilings, floors, windows, blinds, curtains, doors, trims, cupboards, fireplaces, or built-in shelving.
  - Do NOT repaint, re-texture, or change materials or colors of any existing surfaces or fixtures.
• Do NOT add, remove, or move any structural elements or built-ins (no new walls, windows, doors, fireplaces, cabinets, niches, etc.).

ALLOWED ACTIONS (WHAT YOU MAY DO):
• You may ONLY ADD movable furniture and decor on top of the existing image.
• Allowed examples: sofas, armchairs, coffee tables, dining tables & chairs, beds, bedside tables, freestanding lamps, rugs, plants, small decor on furniture, lightweight wall art.
• NO new built-in joinery, no new windows or doors, no new wall openings, no new ceiling features.

FURNITURE SCALE & PERSPECTIVE:
• Furniture must be kept at TRUE, REALISTIC SCALE relative to the room.
• Use doors, windows, ceiling height, and existing skirting/architraves as reference points.
• Do NOT shrink, stretch, or distort furniture unnaturally just to fit a space.
• Respect the camera perspective lines of the original image. New objects must follow the same perspective and horizon.

PLACEMENT & SAFETY RULES:
• NEVER block doors or doorways. No furniture or decor may overlap any visible door leaf, frame, or doorway opening.
• NEVER block cupboards/wardrobes or access panels.
• Maintain clear walking paths in and out of the room and between main furniture pieces.
  - Leave a realistic circulation space around beds, sofas, dining tables, etc. (people should clearly be able to walk through).
• Do NOT cover any part of a window above approximately 40% of its height.
  - Curtains and blinds that already exist must remain fully visible and unobstructed above this height.
• Furniture must not intersect or overlap walls, windows, doors, skirting boards, or other built-in objects.
  - No part of a sofa, bed, table, or decor may visually slice into or pass through a wall or built-in.

ROOM-TYPE-SPECIFIC LAYOUT (IF APPLICABLE):
• If this is a LIVING ROOM:
  - Provide a main seating area (sofa and/or armchairs) oriented toward the obvious focal point (e.g., TV wall, fireplace, or main window).
  - Include a coffee table and optionally a rug under the main seating group.
  - Optionally add a sideboard, side tables, floor lamp, and a small number of plants or decor.
• If this is a BEDROOM:
  - Include a bed at an appropriate size for the room (single, double, queen, or king).
  - Place bedside tables and lamps on one or both sides where space allows.
  - Leave clear walking access around the bed where possible.
  - Optional: a dresser, chair, or small desk if it fits comfortably.
• If this is a DINING ROOM:
  - Include a dining table and chairs at realistic scale.
  - Ensure chairs can be pulled out without hitting walls or other objects.
• If this is a HOME OFFICE:
  - Include a desk, chair, and optionally some shelving or a side chair, laid out for comfortable use.

STYLE & DENSITY:
• Style: contemporary, neutral, and broadly appealing for real estate marketing.
• Keep colors soft and coordinated with the existing finishes.
• Do NOT clutter the room. Prefer fewer, well-chosen items over many small objects.
• Avoid highly personal or controversial items (family photos, religious or political symbols, logos, or text that might identify brands).

OUTPUT GOAL:
• The final image should look like a professionally staged property photo.
• The architecture of the room must remain EXACTLY the same as the input image.
• Only the added furniture and decor should change the scene, and they must obey all rules above.
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
