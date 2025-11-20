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
• FIRST, identify all visible access points: doors, sliding doors, archways, and open passages to other rooms, decks, or balconies.
• THEN, imagine the natural walking routes between:
  - the main room entrance and any sliding doors or balcony/patio doors, and
  - the main room entrance and the primary seating area.
• Keep these walking routes CLEAR: maintain at least ~80–90 cm of unobstructed floor along each route.
  - NEVER place sofas, armchairs, coffee tables, side tables, or floor lamps across these routes.
  - Furniture legs may be near a route but must not force people to squeeze around them.
• NEVER block doors or doorways. No furniture or decor may overlap any visible door leaf, frame, archway, or doorway opening.
• NEVER block sliding doors or balcony doors. Do not place any furniture in front of a sliding door panel or track.
• NEVER block cupboards/wardrobes or access panels.
• Maintain clear walking paths in and out of the room and between main furniture pieces.
  - Leave a realistic circulation space around beds, sofas, dining tables, etc. (people should clearly be able to walk through).
• Do NOT cover any part of a window above approximately 40% of its height.
  - Curtains and blinds that already exist must remain fully visible and unobstructed above this height.
• Furniture must not intersect or overlap walls, windows, doors, skirting boards, or other built-in objects.
  - No part of a sofa, bed, table, or decor may visually slice into or pass through a wall or built-in.

WINDOW & GLAZING PROTECTION RULES:
• NEVER place wall-mounted décor or furniture over ANY window, sliding door, glass panel, or glazed opening.
• This includes: artwork, framed prints, mirrors, shelves, wall-mounted lights, floating panels, or any object that would visually appear attached to the wall.
• Windows and glass doors must remain completely free of added objects.
• No item may overlap, intersect, or partially cover the glazing, the frame, curtains, blinds, tracks, or hardware.
• Treat the full window area — frame + glass + sill + curtains/blinds — as a protected “no-mount zone.”

ROOM-TYPE-SPECIFIC LAYOUT (IF APPLICABLE):
• If this is a LIVING ROOM:
  - Provide a main seating area (sofa and/or armchairs) oriented toward the obvious focal point (e.g., TV wall, fireplace, or main window).
  - Place the main sofa so that it does NOT sit in the middle of a clear access route to any door or sliding door.
  - If there is a sliding door or large opening to a deck or garden, keep a direct, straight visual path to that opening, with no furniture crossing it.
  - ALWAYS include at least: one main sofa, one coffee table, one rug under the main seating group, and secondary seating (armchair or second sofa) if it fits without blocking access routes.
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

DECOR, ART, AND STYLING:
• This must look professionally styled for a real estate listing, not like a nearly empty rental.
• Always add a small but noticeable amount of decor:
  - Sofas should have a few cushions and optionally a throw.
  - Coffee tables and side tables should have 1–3 decor items (e.g., books, a tray, a vase, or a small plant).
  - At least one plant (floor or tabletop) should be included if it suits the style.
• Large blank walls should usually have art:
  - If there is a main wall behind a sofa or bed, add 1–3 framed artworks in a simple, cohesive style.
  - Wall art must ONLY be placed on clear, solid wall surfaces.
  - Do NOT mount art or décor on windows, sliding doors, or any glazed surface.
  - If a wall contains a window, place art on the solid wall portions only, leaving full clearance around the frame and curtains.
• Overall density:
  - Aim for roughly 5–12 distinct decor items in a living room (cushions count as a group, not individually).
  - Surfaces should remain 30–50% clear – stylish and inviting, not cluttered.
• Avoid highly personal or controversial items (family photos, religious or political symbols, logos, or text that might identify brands).

STYLE & DENSITY:
• Style: contemporary, neutral, and broadly appealing for real estate marketing.
• Keep colors soft and coordinated with the existing finishes.
• Do NOT clutter the room. Prefer fewer, well-chosen items over many small objects.
• Avoid highly personal or controversial items (family photos, religious or political symbols, logos, or text that might identify brands).

SELF-CHECK BEFORE FINALIZING:
• Confirm that all doors, sliding doors, and walkways are clearly usable with no furniture blocking them.
• Confirm that no wall-mounted object touches or overlaps any window, sliding door, or other glazed opening.
• Confirm that there is enough decor and art for the room to feel professionally styled and inviting, but not cluttered.
If any of these checks fail, adjust the furniture and decor placement until all are true.

OUTPUT GOAL:
• The final image should look like a professionally staged property photo.
• The architecture of the room must remain EXACTLY the same as the input image.
• Only the added furniture and decor should change the scene, and they must obey all rules above.
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
