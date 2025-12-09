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

  // Stage 1B: Aggressive furniture & clutter removal (NZ style)
  // Produces a completely empty interior while preserving ALL architecture and ALL window treatments.
  export function buildStage1BPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
    }

    return `You are a professional real-estate photo editor.\n\nTASK:\nCompletely remove ALL furniture, ALL décor, and ALL clutter to create a fully EMPTY, clean, stage-ready ${roomType || "room"}.\n\nYOU MUST REMOVE:\n• All sofas, couches, armchairs, stools, and lounge chairs\n• All coffee tables, side tables, and display tables\n• All dining tables and ALL dining chairs\n• All beds, mattresses, and bedside tables\n• All wardrobes, dressers, cabinets, shelving, and storage units\n• All TV units, entertainment units, and media furniture\n• All rugs, mats, and floor coverings\n• All personal belongings and household items\n• All wall art, framed pictures, mirrors, and decorative wall objects\n• All pot plants, indoor plants, flowers, vases, and artificial greenery\n• All background furniture, even if partially visible\n• All furniture touching walls, windows, cabinetry, splashbacks, or kitchen islands\n• All bar stools and kitchen seating\n• All loose items on floors, benches, shelves, and surfaces\n\nDO NOT REMOVE:\n• Walls\n• Windows and glass\n• Doors\n• Curtains and blinds\n• Floors and ceilings\n• Built-in cabinetry and fixed kitchen joinery\n• Fixed light fittings and ceiling lights\n• Outdoor landscaping visible through windows\n\nFAIL CONSTRAINT:\nIf ANY furniture, dining pieces, cabinets, stools, wall art, plants, or personal items remain after editing, the task is considered FAILED.\n\nGOAL:\nProduce a completely empty, realistic architectural shell that is perfectly clean and ready for virtual staging, while preserving the original room structure exactly.`.trim();
  }

  // Stage 1B Light Mode: Remove clutter/mess only, keep all main furniture
  // This mode is for tidying up a space without removing the furniture itself
  export function buildLightDeclutterPromptNZStyle(roomType?: string, sceneType: "interior" | "exterior" = "interior"): string {
    if (sceneType === "exterior") {
      // Same as full mode for exteriors - only removes transient items
      return buildStage1BPromptNZStyle(roomType, sceneType);
    }

    return `You are a professional real-estate photo editor.\n\nTASK:\nTidy and clean this ${roomType || "room"} while KEEPING ALL MAIN FURNITURE exactly as it is. This is a "declutter only" pass. The room must look neat, styled, and real-estate ready, but still furnished.\n\nYOU MUST REMOVE ALL OF THE FOLLOWING IF VISIBLE:\n• All framed photos and personal picture frames\n• All small decorative clutter on shelves and surfaces\n• All personal ornaments and keepsakes\n• All pot plants, indoor plants, and flowers on furniture and benchtops\n• All loose papers, mail, magazines, and books left out\n• All bags, shoes, jackets, and clothing items\n• All toys and children's items\n• All cables, cords, chargers, and electronics clutter\n• All bathroom sink, vanity, bath, and shower clutter\n• All kitchen bench clutter, dish racks, bottles, and small containers\n\nYOU MUST KEEP ALL MAIN FURNITURE:\n• All sofas and couches\n• All armchairs and lounge chairs\n• All dining tables and dining chairs\n• All beds and bedside tables\n• All wardrobes, cabinets, dressers, and TV units\n• All coffee tables and side tables\n• All large floor rugs UNDER furniture\n\nDO NOT MODIFY:\n• Walls, windows, doors, ceilings, or floors\n• Curtains, blinds, and fixed light fittings\n• Built-in cabinetry and fixed joinery\n• Outdoor greenery visible through windows\n\nFAIL CONSTRAINT:\nIf ANY framed photos, shelf clutter, plants, or personal decorative items remain visible after editing, the task is considered FAILED.\n\nGOAL:\nThe room should look like the homeowner has carefully packed away all personal belongings and mess while leaving the original furniture layout intact.`.trim();
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
