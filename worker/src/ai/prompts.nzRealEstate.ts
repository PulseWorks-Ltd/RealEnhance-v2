export function buildStage1APromptNZStyle(roomType: string, sceneType: "interior" | "exterior"): string {
  if (sceneType === "exterior") return buildStage1AExteriorPromptNZStyle();
  return buildStage1AInteriorPromptNZStyle(roomType);
}

function buildStage1AInteriorPromptNZStyle(roomType: string): string {
  return `\nEnhance this ${roomType || "interior"} image in the style of modern New Zealand \nreal estate photography as seen on professional Trade Me listings.\n\nYour goals:\n• Make the room brighter, airy, warm, clean, and inviting.\n• Apply professional real-estate style tonal balance: lifted midtones, softened\n  shadows, stronger lighting at the back of the room, and clean neutral whites.\n• Produce natural but polished color: +3–4% global warmth, rich but not oversaturated tones.\n• Apply soft HDR-style balancing so interior brightness feels consistent and\n  evenly lit without flattening contrast.\n• Improve clarity and definition on edges, flooring, cabinetry, and fixtures.\n• Give the room a perceptual sense of openness WITHOUT changing geometry.\n\nAllowed enhancements:\n• Increase brightness, midtones, and corner fill light.\n• Clean and remove mild discoloration, haze, or lens cast.\n• Slightly increase clarity and local contrast for a crisp, professional look.\n• Correct white balance to modern clean whites.\n\nHARD RULES — NON-NEGOTIABLE:\n• Use the image EXACTLY as provided. Do NOT rotate, crop, straighten, zoom, warp,\n  or change the camera angle or perspective.\n• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,\n  wardrobes, cabinetry, or fixtures.\n• Do NOT add, remove, modify, or reposition furniture, appliances, artwork,\n  decor, or personal items.\n• Do NOT alter proportions, distances, dimensions, or layout of the room.\n• Do NOT change what is visible through windows.\n\nOnly enhance lighting, color, clarity, and quality. No structural or geometric changes.`.trim();
}

function buildStage1AExteriorPromptNZStyle(): string {
  return `\nEnhance this exterior property image in the style of top New Zealand real estate\nphotographs as commonly seen on professional Trade Me listings.\n\nYour goals:\n• Replace the sky with a bright New Zealand-blue sky and soft natural clouds.\n• Brighten the entire exterior scene with warm, sunny lighting.\n• Enhance all greens to look healthy, vibrant, and well-maintained.\n• Improve clarity and texture on cladding, roofing, decking, and hard surfaces.\n• Clean dirt, mould, and discoloration from driveways, decks, and fences while\n  preserving original material texture.\n• Apply strong professional-level tonal shaping: lifted shadows, warm midtones,\n  crisp highlights, and clean whites.\n\nHARD LANDCOVER RULES:\n• Do NOT add, remove, extend, shrink, recolor, or invent ANY driveway, path,\n  deck, patio, hard-surface area, or structure.\n• Grass must remain grass; hard surfaces must remain hard surfaces.\n• Do NOT reshape, redraw, or replace trees, shrubs, hedges, or plants.\n\nABSOLUTE GEOMETRY RULES:\n• Do NOT rotate, crop, straighten, zoom, or change the camera angle.\n• Do NOT change ANY structural element: walls, rooflines, windows, doors,\n  fences, balconies, gutters, or architectural edges.\n• Do NOT remove or add buildings, structures, or features.\n\nOnly enhance lighting, color, clarity, and cleanliness. No structural changes.`.trim();
}

  // Stage 1B-TIDY: TIDY ONLY (MICRO DECLUTTER - NO FURNITURE REMOVAL)
  // Used by "tidy" mode (replaces old "main" mode)
  // Removes ONLY small clutter, keeps ALL furniture in place
  export function buildStage1BTidyPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return buildStage1BFullDeclutterPromptNZStyle(roomType, sceneType);
    }

    return `You are a professional real-estate image editor.

TASK:
Clean and tidy this room for professional real estate photography while keeping ALL furniture in place.

REMOVE ALL SMALL CLUTTER INCLUDING:
- Items from display cabinets, shelves, and all surfaces
- Items from all side tables (bedside tables, living room side tables)
- Items from coffee tables
- Items from dining tables
- Items from window sills
- Items from countertops and benches
- Photo frames and trinkets from all surfaces
- Wall art and decorative items
- Fridge magnets and papers
- Bathroom sink, shower, and bath clutter
- Shoes on the floor
- Clothes on the floor
- Loose cables and chargers
- Kids toys
- Any small cluttering items

DO NOT REMOVE (FURNITURE MUST STAY):
- Beds
- Sofas and couches
- Dining tables
- Coffee tables
- Side tables
- Desks
- Chairs
- Wardrobes
- Dressers and drawers
- Display cabinets
- TV stands
- Shelving units
- Rugs
- Curtains
- Lamps
- Built-in fixtures and cabinetry`;
  }

  // Stage 1B: FULL DECLUTTER PROMPT (UNIFIED FOR ALL MODES)
  // Used by Light (1x), Auto (1x), and Heavy (2x) modes
  // Removes ALL furniture and clutter to create architecturally empty room
  export function buildStage1BFullDeclutterPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      // Exteriors: Remove all transient items
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
    }

    return `\nYou are a professional real-estate image editor.

TASK:
Remove ALL furniture and ALL clutter from this room.

REMOVE:
- All large furniture
- All partial furniture
- All small furniture
- All wall art
- All lamps
- All plants
- All rugs
- All cushions
- All decor
- All window-sill items
- All counter and bench items
- All loose objects
- All visible storage contents

STRICT RULES:
- Do NOT change walls, doors, windows, floors, ceilings, or room geometry.
- Do NOT change camera angle or perspective.
- Do NOT alter lighting direction.
- Do NOT add any new objects.

OUTPUT STYLE:
- The room must appear architecturally empty.
- Clean straight wall lines must be visible.
- Windows must be fully unobstructed.
- Professional real-estate photography standard.

Return ONLY the edited image.`.trim();
  }

  // Stage 1B-A: COMPREHENSIVE ROOM EMPTYING (PASS A)
  // Used by "standard" (1x), and "stage-ready" (1st pass of 2)
  // Removes ALL movable furniture AND all clutter in ONE comprehensive pass
  export function buildStage1BAPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return buildStage1BFullDeclutterPromptNZStyle(roomType, sceneType);
    }

    // Build room-type specific furniture emphasis
    let furnitureEmphasis = "";
    if (roomType) {
      const lowerRoom = roomType.toLowerCase();
      if (lowerRoom.includes("bedroom") || lowerRoom.includes("bed")) {
        furnitureEmphasis = "\nBEDROOM FOCUS: Beds, side tables/bedside tables, chairs, dressers, drawers, wardrobes";
      } else if (lowerRoom.includes("living") || lowerRoom.includes("lounge")) {
        furnitureEmphasis = "\nLIVING ROOM FOCUS: Sofas, couches, TV units, side tables, coffee tables, dining tables, display units, rugs";
      }
    }

    return `You are a professional real-estate image editor.

TASK:
Completely empty this room for real estate photography. Remove ALL movable furniture and items.
${furnitureEmphasis}

REMOVE EVERYTHING MOVABLE:

FURNITURE (all types):
- Beds, sofas, couches, armchairs, ottomans
- Dining tables, coffee tables, side tables, consoles
- Chairs, stools, benches
- TV units, display cabinets, shelving units
- Dressers, drawers, wardrobes, desks
- Rugs and mats
- Any freestanding furniture

SMALL ITEMS & CLUTTER (remove ALL):
- ALL wall art, paintings, photo frames, mirrors, clocks
- ALL items from countertops, tables, window sills, display cabinets
- ALL partially visible items and edge furniture artifacts
- ALL trinkets, ornaments, fridge magnets, papers
- ALL toys, shoes, clothes from floors
- ALL plants (potted or decorative)
- ALL freestanding lamps (not built-in ceiling fixtures)
- ALL cushions, throws, blankets
- ALL bathroom/kitchen clutter (bottles, jars, toiletries, utensils, appliances)

ABSOLUTE PROTECTION (NEVER REMOVE):
- Curtains, blinds, drapes, window treatments
- Windows, doors, walls, trim, ceilings, floors
- HVAC units, vents, thermostats
- Built-in cabinetry, countertops, and fixtures
- Built-in ceiling lighting fixtures (recessed lights, chandeliers)
- Built-in appliances (ovens, range hoods, dishwashers)

STRICT RULES:
- Do NOT change walls, doors, windows, floors, ceilings, or room geometry.
- Do NOT change camera angle or perspective.
- Do NOT alter lighting direction.
- Do NOT add any new objects.

GOAL: Architecturally empty room showing only permanent structure, ready for virtual staging.`;
  }

  // Stage 1B-B: COMPREHENSIVE CLEANUP (PASS B)
  // Only runs in "standard" (conditional) and "stage-ready" (always) modes as second pass
  // Same comprehensive removal as Pass 1, with emphasis on commonly missed items
  export function buildStage1BBPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return buildStage1BFullDeclutterPromptNZStyle(roomType, sceneType);
    }

    // Build room-type specific furniture emphasis
    let furnitureEmphasis = "";
    if (roomType) {
      const lowerRoom = roomType.toLowerCase();
      if (lowerRoom.includes("bedroom") || lowerRoom.includes("bed")) {
        furnitureEmphasis = "\nBEDROOM FOCUS: Beds, side tables/bedside tables, chairs, dressers, drawers, wardrobes";
      } else if (lowerRoom.includes("living") || lowerRoom.includes("lounge")) {
        furnitureEmphasis = "\nLIVING ROOM FOCUS: Sofas, couches, TV units, side tables, coffee tables, dining tables, display units, rugs";
      }
    }

    return `You are a professional real-estate image editor.

TASK:
This is PASS TWO - final comprehensive cleanup. Remove ANY remaining movable items missed in the first pass.
${furnitureEmphasis}

PRIORITY TARGETS (commonly missed):
- Wall art, paintings, photo frames still visible
- Partially visible furniture (behind curtains, in corners, at edges)
- Items on window sills, tables, display units, countertops
- Toys, shoes, clothes still on floors
- Plants, trinkets, small decorative items
- Any furniture missed in first pass

COMPREHENSIVE REMOVAL (same as Pass 1):

FURNITURE (all types - in case any missed):
- Beds, sofas, couches, armchairs, ottomans
- Dining tables, coffee tables, side tables, consoles
- Chairs, stools, benches
- TV units, display cabinets, shelving units
- Dressers, drawers, wardrobes, desks
- Rugs and mats
- Any freestanding furniture

SMALL ITEMS & CLUTTER (remove ALL):
- ALL wall art, paintings, photo frames, mirrors, clocks
- ALL items from countertops, tables, window sills, display cabinets
- ALL partially visible items and edge furniture artifacts
- ALL trinkets, ornaments, fridge magnets, papers
- ALL toys, shoes, clothes from floors
- ALL plants (potted or decorative)
- ALL freestanding lamps (not built-in ceiling fixtures)
- ALL cushions, throws, blankets
- ALL bathroom/kitchen clutter (bottles, jars, toiletries, utensils, appliances)

ABSOLUTE PROTECTION (NEVER REMOVE):
- Curtains, blinds, drapes, window treatments
- Windows, doors, walls, trim, ceilings, floors
- HVAC units, vents, thermostats
- Built-in cabinetry, countertops, and fixtures
- Built-in ceiling lighting fixtures (recessed lights, chandeliers)
- Built-in appliances (ovens, range hoods, dishwashers)

STRICT RULES:
- Do NOT change walls, doors, windows, floors, ceilings, or room geometry.
- Do NOT change camera angle or perspective.
- Do NOT alter lighting direction.
- Do NOT add any new objects.

GOAL: Completely empty room ready for virtual staging, with ALL movable items removed.`;
  }

  // Stage 1B: Aggressive furniture & clutter removal (NZ style) - LEGACY
  // Produces a completely empty interior while preserving ALL architecture and ALL window treatments.
  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
    }

    return `\nYour task: produce a completely empty version of the EXACT same ${roomType || "room"} interior shown in this photograph.\n\nCRITICAL OUTPUT REQUIREMENTS:\n• Output MUST be the EXACT same room from the EXACT same camera position, angle, and frame.\n• Output MUST show the SAME walls, SAME floor, SAME windows, SAME doors, SAME built-ins — only with ALL movable furniture and decor removed.\n• Do NOT change the scene, do NOT switch to a different room, do NOT generate a new space.\n• Do NOT add ANY new objects, furniture, or decor. ONLY remove existing movable items.\n• This is a DELETION-ONLY operation. No additions, no scene changes, no creative reinterpretation.\n\nREMOVE — FULL LIST (if ANY part is visible, remove ALL visible pixels):\n• Sofas, armchairs, ottomans, coffee/side tables, dining tables, chairs, consoles, TV units\n• Beds, headboards, nightstands, dressers, wardrobes, bookcases, shelving units, desks\n• Rugs, cushions, blankets/throws, baskets\n• Portable lamps (floor/table), freestanding mirrors, sculptures, plants (real/fake)\n• ALL wall decor: artwork, frames, pictures, clocks, mirrors, decorative plates\n• ALL loose items on ANY surface (kitchen/bath/laundry/office): appliances, bottles, jars, trays, soap, fruit bowls, dishes, spices, utensils, toiletries, toys, paperwork, magnets, notes\n\nKEEP EXACTLY — DO NOT REMOVE OR MODIFY:\n• BUILT‑INS & FIXTURES: cabinets, countertops, islands/peninsulas, sinks, taps, fixed shelving, fireplaces, mantels, recessed/hardwired lighting, ceiling fans, switches, outlets\n• APPLIANCES: built‑in stoves/ovens and range hoods (preserve explicitly)\n• ARCHITECTURE: walls, ceilings, floors, trims, skirting/baseboards, doors, door frames, window frames, sills\n• WINDOW TREATMENTS (CRITICAL): Do NOT remove, alter, hide, or occlude curtains, blinds, or ANY window treatments. They MUST remain fully intact and 100% visible.\n\nABSOLUTE RULES — ZERO TOLERANCE:\n• SCENE LOCK: Output MUST be the exact same room from the exact same camera viewpoint. Do NOT generate a different room, different angle, or different property.\n• CAMERA LOCK: Do NOT rotate, crop, reframe, zoom, or change perspective/angle.\n• DELETION ONLY: Do NOT add furniture, decor, objects, or architectural elements. Only remove movable items.\n• STRUCTURE LOCK: Do NOT add/remove/move/reshape any architectural element.\n• SURFACE LOCK: Do NOT repaint, recolor, or re‑texture walls/ceilings/floors.\n• NO NEW STRUCTURE: Do NOT create built‑ins or modify existing counters/cabinetry.\n\nQUALITY: Remove cleanly with no smudges/ghosting; preserve shadows/reflections of kept items; maintain natural edges and textures.\n\nFinal output requirement: A completely empty version of THIS EXACT room with ONLY permanent architecture, built‑ins, built‑in stove/hood, and ALL window treatments preserved and fully visible. Same room, same view, just empty.`.trim();
  }

export function buildStage2PromptNZStyle(roomType: string, sceneType: "interior" | "exterior", opts?: { stagingStyle?: string | null }): string {
  if (sceneType === "exterior") return buildStage2ExteriorPromptNZStyle();
  // Require roomType for interior staging
  if (!roomType || typeof roomType !== 'string' || !roomType.trim()) {
    // Fail gracefully: return a prompt indicating missing roomType
    return '[ERROR] Room type is required for interior staging. Please select a valid room type.';
  }
  return buildStage2InteriorPromptNZStyle(roomType, opts);
}

function buildStage2InteriorPromptNZStyle(roomType: string, opts?: { stagingStyle?: string | null }): string {
  // Check if an explicit staging style is provided
  const hasExplicitStyle = !!opts?.stagingStyle && opts.stagingStyle !== "none";

  // Base introduction - neutral, no style specification when explicit style is provided
  let prompt = `\nStage this ${roomType || "room"} interior for high-end real estate marketing.`;

  // Only include NZ style block when NO explicit stagingStyle is provided
  if (!hasExplicitStyle) {
    prompt += `\n\nStaging style:\n• NZ contemporary / coastal / Scandi minimalist.\n• Light wood (oak/beech) furniture with soft white or warm grey upholstery.\n• Clean, natural fabrics (linen, cotton) with minimal patterns.\n• Simple rugs, light-toned or natural fiber.\n• Art that is subtle, minimal, coastal, neutral, or abstract.\n• 1–2 small accents only (no clutter, heavy décor, or bold colours).`;
  }

  // Lighting and structural rules apply to all styles
  prompt += `\n\nLighting:\n• Bright, airy, natural daylight with lifted midtones and softened shadows.\n• Match the lighting direction and warmth of the base interior.\n• Slightly warm real-estate aesthetic (+3–5% warmth).\n\nSTRICT STRUCTURAL RULES:\n• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,\n  zoom, or modify the camera angle or perspective.\n• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,\n  cabinetry, or built-in features.\n• Do NOT cover or partially block windows, doors, or cupboards.\n• Do NOT modify or repaint walls, ceilings, floors, or surfaces.\n• Do NOT add built-ins or structural elements.\n• Do NOT alter the view outside the windows.\n\nOnly ADD virtual furniture that fits the style above. Do not change the room itself.`;

  return prompt.trim();
}

function buildStage2ExteriorPromptNZStyle(): string {
  return `\nStage this outdoor area with clean, contemporary New Zealand-style outdoor\nfurniture consistent with Trade Me real estate photography.\n\nStaging style:\n• A single outdoor furniture set (lounge or dining).\n• Neutral tones: charcoal, white, light wood, or grey.\n• Add 1–2 potted plants maximum.\n• Keep layout simple, clean, modern, and spacious.\n\nPlacement rules:\n• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).\n• Do NOT place furniture on grass, gardens, or driveways.\n• Ensure scale, lighting, and shadows perfectly match the scene.\n• Do NOT overcrowd the area; NZ staging is minimalistic.\n\nABSOLUTE STRUCTURAL RULES:\n• No rotation/crop/zoom or perspective changes.\n• Do NOT modify architecture, building shape, fences, windows, doors, decking,\n  landscaping, or permanent structures.\n• Do NOT add new structures.\n• Only add outdoor furniture and small potted plants.\n\nGoal:\nCreate a clean, modern, inviting outdoor scene that matches professional NZ\nreal estate staging.`.trim();
}
