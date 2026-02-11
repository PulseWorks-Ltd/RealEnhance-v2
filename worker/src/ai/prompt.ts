// server/ai/prompt.ts

import { buildSpatialConstraints, type SpatialBlueprint } from './spatialAnalyzer';

export type PromptOptions = {
    // Optional: region for exterior staging (bounding box)
    stagingRegion?: {
      x: number;
      y: number;
      width: number;
      height: number;
      areaType: string;
      confidence: string;
      reasoning: string;
    };
  goal: string;
  industry?: string;

  // global switches
  preserveStructure?: boolean;
  allowStaging?: boolean;
  allowRetouch?: boolean;

  // scene control
  sceneType?: "interior" | "exterior" | "auto";
  resolvedScene?: "interior" | "exterior";

  // exterior staging policy
  outdoorStaging?: "auto" | "none";

  // multi-angle consistency
  sameRoomKey?: string;
  followupAngle?: boolean;

  // optional reference for consistency (pass image alongside as a second input in the pipeline)
  cachedRoomPlan?: string;        // text only – do NOT request JSON in this prompt
  referenceImageUrl?: string;     // used by your pipeline as image input, not in the prompt text

  // per-image classification
  roomType?: string;
  
  // spatial blueprint for architectural preservation
  spatialBlueprint?: SpatialBlueprint;

  // furniture replacement mode
  furnitureReplacementMode?: boolean;
  furnitureReplacementRules?: string[];

  // retry focus
  isRetry?: boolean;

  // declutter level
  declutterLevel?: "light" | "standard" | "heavy";
};

function bool(v: unknown): "true" | "false" {
  return v ? "true" : "false";
}

function getDeclutterInstructions(level: "light" | "standard" | "heavy"): string[] {
  if (level === "light") {
    return ["DECLUTTER INTENSITY: LIGHT – remove only obvious items (bins, hoses, visible trash). Minimize other edits."];
  }
  if (level === "heavy") {
    return [
      "DECLUTTER INTENSITY: HEAVY (COMPLETE ROOM CLEARING) – remove ALL movable furniture and items to create a completely empty room.",
      "REMOVE: ALL furniture (sofas, chairs, beds, tables, dressers, nightstands, desks, bookcases, wardrobes, shelving units, entertainment centers, consoles), ALL rugs, ALL lamps (portable only), ALL wall art (paintings, frames, mirrors, decorations), ALL decorative items (vases, plants, sculptures, candles, ornaments), ALL appliances EXCEPT built-in stoves.",
      "KEEP ONLY: built-in stoves, countertops, cabinets, built-in shelving, recessed lighting, ceiling fans, window frames, door frames, baseboards, crown molding, fireplaces, mantels, ALL curtains, ALL blinds, ALL window treatments (MUST remain 100% visible and unchanged).",
      "GOAL: Produce a completely empty room with bare walls and floors, preserving ONLY fixed architectural elements, built-in stoves, and ALL window treatments (curtains/blinds)."
    ];
  }
  return ["DECLUTTER INTENSITY: STANDARD – remove priority items and tidy visible clutter without over-editing."];
}

// Optional lightweight auto-detect when sceneType === "auto"
export function autoSceneFromGoal(goal: string): "interior" | "exterior" {
  const g = goal.toLowerCase();
  return /exterior|outdoor|facade|front|backyard|garden|lawn|patio|deck|verandah/.test(g)
    ? "exterior"
    : "interior";
}

export function buildPrompt(opts: PromptOptions): string {
  const {
    goal,
    industry = "Real Estate",
    preserveStructure = true,
    allowStaging = true,
    allowRetouch = true,
    sceneType = "auto",
    resolvedScene,
    outdoorStaging = "auto",
    sameRoomKey,
    followupAngle,
    cachedRoomPlan,      // informational only (we reference it briefly – no JSON request)
    referenceImageUrl,   // not printed; used by pipeline
    roomType,
    furnitureReplacementMode = false,
    furnitureReplacementRules = [],
    isRetry = false,
    declutterLevel = "standard",
  } = opts;

  // Resolve active scene
  const activeScene: "interior" | "exterior" =
    resolvedScene ??
    (sceneType === "exterior" ? "exterior"
      : sceneType === "interior" ? "interior"
      : autoSceneFromGoal(goal));

  // ========== ABSOLUTE STRUCTURAL CONSTRAINTS (Single Source of Truth) ==========
  const absoluteConstraints = [
    "[ABSOLUTE STRUCTURAL PRESERVATION – OVERRIDES ALL ELSE]",
    "",
    "CAMERA VIEW LOCKED (CRITICAL - ZERO TOLERANCE): DO NOT expand the camera view or field of view. DO NOT zoom out or reveal spaces beyond the original photograph's boundaries. DO NOT invent rooms, spaces, or architectural elements that were not visible in the original image. The enhanced image must show ONLY what was captured in the original photo - same spatial boundaries, same framing, same coverage area. If an area was outside the frame in the original, it must remain outside the frame in the enhanced version.",
    "",
    "CAMERA ANGLE & PERSPECTIVE LOCKED (CRITICAL - ZERO TOLERANCE): The camera viewpoint, angle, and perspective MUST remain EXACTLY IDENTICAL to the original photograph. DO NOT change the camera position (e.g., from doorway to room center), camera angle (looking up/down/left/right), viewing direction, or camera height. Perspective lines and vanishing points must remain in the exact same positions. The same room photographed from a different angle is a CRITICAL VIOLATION. Maintain the exact architectural view - if a wall corner was visible on the left, it must remain on the left; if certain walls were not visible, they must stay hidden.",
    "",
    "WALLS (CRITICAL - ZERO TOLERANCE): Walls are PERMANENT and IMMOVABLE. Do not add/remove/merge/extend/shorten/move/reposition/reshape walls under ANY circumstances. Wall length, position, angles, and configuration must be EXACTLY IDENTICAL. Furniture MUST fit within existing wall geometry - NEVER modify walls to accommodate furniture. If furniture doesn't fit naturally within existing walls, use smaller pieces or omit items entirely.",
    "",
    "NO NEW WALL PLANES (CRITICAL - ZERO TOLERANCE): DO NOT create new walls, wall surfaces, or partitions to solve furniture placement challenges. DO NOT add wall planes in corners or empty areas to provide backing for TV units or other furniture. Use ONLY the wall surfaces that exist in the original image. Leaving blank space is preferable to fabricating false walls or partitions.",
    "",
    "ROOM SIZE: Keep perceived room size identical. No wide-angle simulation, zoom change, or spatial warp.",
    "",
    "FURNITURE SCALE (CRITICAL - MAINTAIN REALISTIC PROPORTIONS): Furniture must maintain realistic proportions relative to room size and MUST NOT be shrunk or miniaturized. Replacement furniture should occupy similar floor area as original pieces (±15% tolerance). Standards: Beds 35-60% of floor area, sofas 20-35%, dining tables 25-40%. DO NOT scale down furniture to fit layout constraints - use appropriately-sized realistic alternatives or omit items entirely. Dollhouse-scale or undersized furniture is a critical violation.",
    "",
    "FINISHES LOCKED: Do not change wall/ceiling paint, wallpaper, textures, or flooring material/color/pattern.",
    "FIXTURES LOCKED (BUILT-INS): Do not add/remove/move/extend/reshape doors, windows, cabinetry, counters, kitchen islands, peninsulas, fireplaces, stairs, columns, light fixtures, fans, or window coverings. Do not modify counter surfaces, edges, or dimensions in any way. NOTE: Loose furniture (sofas, beds, tables, chairs) may be moved/removed/replaced.",
    "",
    "NEVER CREATE FALSE ARCHITECTURE (CRITICAL - ZERO TOLERANCE): DO NOT invent or create new windows, doors, or openings that do not exist in the original image. Do not add window frames, door frames, or architectural openings to blank walls. Only the openings present in the original photograph may appear in the enhanced version. Creating false architectural elements is a critical violation.",
    "",
    "COUNTERS & ISLANDS: Kitchen/bathroom counters, islands, and peninsulas are FIXED STRUCTURES. Do not extend, enlarge, reshape, modify materials, or add overhangs/extensions to accommodate furniture. If stools/chairs don't fit at existing counter, omit them.",
    "OPENINGS PROTECTION (HARD): Windows/frames/glass/handles must remain ≥95% visible (HARD requirement). 70-<95% = SOFT guidance (nudge placement). <70% = non-compliant. Wall-mounted items must not overlap openings. Floor furniture before windows allowed only if frames remain clearly visible and operable.",
    "EGRESS (HARD): Maintain ≥80 cm clear walkway at hinged doors (HARD requirement). 70-<80 cm = SOFT guidance (nudge placement). Do not block door swing. Wardrobe/slider doors may be visually closer if they remain operable (no collision).",
    "",
    "EXTERIOR: Do not reposition/restyle vehicles (plates may be blurred/removed). Do not convert surface types (e.g., concrete ↔ grass) or invent new surfaces.",
    "SURFACE CLEANUP ALLOWED: You may subtly clean/brighten existing hard surfaces (driveways, decks, pavers) and gently improve grass health without changing material type or making surfaces look brand new.",
  ];

  // ========== ENHANCEMENT LADDER (Single concise block – always descend if blocked) ==========
  const enhancementLadder = [
    "[ENHANCEMENT LADDER – ALWAYS DESCEND IF BLOCKED]",
    "1) Photo polish + declutter (always).",
    "2) DÉCOR-ONLY (whitelist): rugs, lamps, plants, small side tables, and wall art; do NOT overlap windows/doors; no beds/sofas/dining/desk.",
    furnitureReplacementMode
      ? "3) Major furniture REPLACEMENT (swap existing with modern, realistic scale; preserve layout/flow/access; if a single item conflicts, omit it)."
      : "3) Major furniture ADDITION (beds/sofas/dining/desk) with realistic scale & clearances; if a single item conflicts, omit it.",
    "4) Exterior: quality/cleaning is primary focus. First identify NO-GO zones (same-level surfaces around vehicles/driveways). Then graduated staging: Level 1 (elevated deck → dining table+chairs) OR Level 2 (smaller elevated area → side table+2 chairs) OR Level 3 (uncertain/no suitable area → accessories only). Default: Level 3 when uncertain.",
    "If any step is blocked by rules, SKIP JUST THAT STEP and finish the remaining steps—only return polish-only when nothing else is feasible.",
  ];

  // ========== STAGING PRIORITIES (preserve major pieces first) ==========
  const stagingPriorities = [
    "[STAGING PRIORITIES]",
    "PRIORITY KEEP: Major furniture that defines room function (bed/sofa/dining/desk). SECONDARY: side tables, extra chairs, duplicate décor.",
    "Conflict resolution order: nudge → smaller realistic piece → different compliant wall → OMIT ONLY the conflicting item.",
  ];

  // ========== UNIVERSAL RULES ==========
  const universalRules = [
    "Do not fabricate new structures, extensions, or remodels — enhancements only.",
    "Do not expand camera view or invent spaces beyond original photo boundaries.",
    "Maintain realistic geometry and perspective; verticals must stay vertical.",
    "Respect the property's authenticity: enhance what exists, stage appropriately, remove distractions.",
    "Always produce high-resolution, natural-looking results suitable for professional marketing.",
  ];

  // ========== INTERIOR RULES (reference absolutes; no repeats) ==========
  const interiorRules = [
    "[INTERIOR STAGING – PRACTICAL & MODERN]",
    "Follow all ABSOLUTE STRUCTURAL rules above.",
    roomType?.toLowerCase() === "multiple-living-areas" 
      ? "Multi-zone staging: This image contains multiple functional zones (e.g., open-plan living/dining, lounge/office combo). Stage EACH distinct area appropriately with cohesive style across zones."
      : "Stage the room according to the requested room type and keep it as one unified space.",
    "Place large furniture on the floor plane with correct scale, contact shadows, and perspective. Prefer floor-standing pieces; avoid wall-mounted or floating desks, side tables, and shelves.",
    "⚠️ DOORWAY CLEARANCE: Keep ALL doorways, door paths, and walk paths completely clear and unobstructed. DO NOT place furniture across, in front of, or blocking ANY doorway (including sliding doors). Furniture may sit before windows only if frames and operation remain visible.",
    "Use a cohesive color palette; add tasteful decor on counters/shelves/tables.",
    "",
    "[DECLUTTER – TARGETED]",
    ...getDeclutterInstructions(declutterLevel),
    "REMOVE (for standard/heavy modes): trash bags, boxes, laundry piles, excess countertop items, window sill clutter, floor cables, fridge magnets/notes, personal toiletries, pet bowls, scattered toys.",
    "REMOVE (heavy mode only): ALL movable furniture (sofas, chairs, beds, tables, dressers, nightstands, desks, bookcases, wardrobes, shelving units, entertainment centers, consoles), ALL rugs, ALL portable lamps, ALL wall art, ALL decorative items, ALL appliances EXCEPT built-in stoves.",
    "KEEP: built-ins, built-in stoves (preserve these explicitly), fixed appliances (dishwashers, range hoods), cabinets, countertops, light fixtures (recessed/hardwired), ALL curtains and blinds (MUST remain 100% visible), baseboards, crown molding, fireplaces, mantels, safety devices.",
    "MINIMIZE (standard mode): reduce duplicates to a tidy set; do not sterilize the scene.",
    "TRACELESS: remove without smudges/ghosting; preserve shadows/reflections of kept objects.",
    "",
    "[PHOTO QUALITY]",
    "Balance exposure, correct white balance, straighten verticals.",
    "Apply subtle sharpening to enhance edges/textures; avoid halos/noise/over-contrast (reduce if artifacts appear).",
    "Reduce noise while preserving detail.",
  ];

  // ========== FURNITURE REPLACEMENT MODE ==========
  const furnitureReplacementBaseRules = [
    "[FURNITURE REPLACEMENT]",
    "Follow all ABSOLUTE STRUCTURAL rules above.",
    "Replace existing pieces with modern alternatives; keep layout logic and human-scale sizing; ensure correct shadows/perspective.",
    "EGRESS: Maintain ≥ 80 cm at hinged doors; omit any piece that would block operation.",
    "",
    "[DECLUTTER – TARGETED]",
    ...getDeclutterInstructions(declutterLevel),
    "REMOVE: ALL clutter, personal effects, window sill clutter, ALL wall art and decorative items.",
    "REMOVE (heavy mode only): ALL existing furniture and items to create empty room baseline; keep built-ins, built-in stoves, cabinets, countertops, curtains, blinds, and fixed elements ONLY.",
    "KEEP: built-ins, built-in stoves (preserve explicitly), cabinets, countertops, recessed lighting, window frames, door frames, ALL curtains and blinds (MUST remain 100% visible), and fixed architectural elements.",
    "",
    "[PHOTO QUALITY]",
    "Balance exposure and color; subtle sharpening without artifacts; denoise while preserving detail.",
  ];

  // ========== MULTI-ANGLE CONSISTENCY ==========
  const interiorConsistencyRules = [
    "[INTERIOR MULTI-ANGLE CONSISTENCY]",
    "This photo shows another angle of the SAME room as a prior image.",
    "Use the SAME furniture set, colors, materials, and general placement as previously staged for this room.",
    "Adjust positions only as necessary to remain physically plausible from this camera angle, maintaining scale, perspective, and contact shadows.",
  ];

  // ========== EXTERIOR RULES ==========
  const baseExteriorRules = [
    "[EXTERIOR ENHANCEMENT – QUALITY & CLEANING FIRST]",
    "⚠️ CRITICAL: GRASS = NO STAGING ZONE. Never place ANY items (furniture, rugs, mats, pot plants, accessories) on grass areas.",
    "⚠️ CRITICAL: DRIVEWAYS = NO STAGING ZONE. Never place furniture on driveways or concrete areas at same level as vehicles.",
    "",
    "PRIMARY FOCUS (always apply):",
    "1) SKY REPLACEMENT (MANDATORY): Transform ALL gray, overcast, or dull skies into vibrant blue skies with natural soft white clouds. This is NON-NEGOTIABLE for daytime exteriors. Gray/overcast skies MUST become blue. Night shots: preserve dark sky but enhance stars/clarity. Dusk/sunset: preserve warm tones but brighten and enhance. Default action: blue sky with clouds.",
    "2) GRASS: Gentle health/green boost only; keep texture and realism.",
    "3) PHOTO QUALITY: dehaze/clarify, balance color, subtle sharpening (no artifacts), denoise.",
    "4) DEBRIS REMOVAL (100%): COMPLETELY REMOVE all loose debris - bark, stones, leaves, dirt, scattered items, bins, hoses, tools, toys, tarps, packages, rubbish. These are transient and easily cleanable.",
    "5) SURFACE PRESERVATION: All surface cleaning (driveways, decks, paths) is handled in the quality enhancement stage. Do not modify surface appearance during staging.",
    "6) TIDY & SAFETY: tidy weeds; blur/remove license plates if vehicles present.",
    "",
    "🚨 STRICT PRESERVATION RULES (DO NOT VIOLATE):",
    "• DO NOT remove vehicles (cars, trucks, boats, trailers, etc.) - preserve ALL existing vehicles in original positions",
    "• DO NOT add vehicles or any new objects not already present in the original image",
    "• DO NOT add, remove, or modify buildings, sheds, garages, carports, or any structures",
    "• DO NOT add decorative elements (pot plants, furniture, accessories) unless explicitly in staging mode",
    "• DO NOT change driveway surfaces, pathways, or ground materials",
    "• ONLY enhance what already exists - never add or subtract major elements",
    "",
    "OUTDOOR STAGING (simple binary decision):",
    "• Look for ONE clearly suitable area: elevated deck with visible stairs/steps OR patio with clear fence/boundary separation from driveways/vehicles",
    "• IF suitable area found → stage EXACTLY ONE furniture set: outdoor dining table + 4-6 chairs OR side table + 2 chairs (place ONLY on that one area)",
    "• IF no suitable area OR uncertain → skip ALL furniture, use only 1-3 pot plants and barbecue (on hard surfaces only, never grass)",
    "• NEVER on grass, driveways, near vehicles, or same-level concrete. NEVER build new structures. When uncertain → skip furniture.",
  ];

  const focusedExteriorRules = [
    "[EXTERIOR RETRY – FOCUSED POLISH]",
    "Prioritize: SKY (MANDATORY blue replacement for gray/overcast) → grass → dehaze/contrast/color → subtle sharpening → 100% debris removal (bark/stones/leaves/dirt/items) → gentle surface cleaning (completed in quality stage).",
    "Staging: skip unless explicitly requested and space is clearly appropriate (proper outdoor living area only).",
  ];

  // ========== EXTERIOR STAGING DETAILS (used only when staging is allowed) ==========
  const exteriorStagingRules = [
    "[EXTERIOR STAGING – SIMPLE BINARY DECISION]",
    "",
    "🚨 CRITICAL - ZERO TOLERANCE FOR STRUCTURE BUILDING:",
    "• DO NOT build, create, add, or construct ANY decks, platforms, patios, terraces, or elevated surfaces",
    "• DO NOT create new hard surfaces where none existed",
    "• DO NOT extend or expand existing decks or patios",
    "• ONLY work with surfaces that ALREADY EXIST in the original photo",
    "• If no suitable existing surface → DO NOT stage furniture, use accessories only",
    "• Building ANY structure is a CRITICAL VIOLATION that will cause immediate rejection",
    "",
    "STEP 1: LOOK FOR ONE CLEARLY SUITABLE AREA",
    "",
    "A suitable area MUST meet ALL these criteria:",
    "✅ Elevated deck with visible stairs/steps up from ground level OR patio with clear fence/boundary wall separating it from driveways/vehicles",
    "✅ Hard surface already constructed (timber deck, paved patio, concrete pad)",
    "✅ Clearly separated from any vehicles, driveways, or parking areas",
    "✅ NOT grass, NOT at same level as driveways, NOT near vehicles",
    "",
    "If you cannot identify such an area with 100% confidence → consider NO suitable area exists.",
    "",
    "STEP 2: BINARY STAGING DECISION",
    "",
    "IF suitable area found (meets all criteria above):",
    "• Stage EXACTLY ONE outdoor dining table with chairs on that suitable area ONLY",
    "• Add maximum 3 small pot plants around the furniture (on hard surfaces only, never grass)",
    "• Stop. Do not stage anything else anywhere else.",
    "",
    "IF no suitable area OR uncertain:",
    "• Skip ALL furniture completely (no tables, no chairs)",
    "• Use ONLY minimal accessories: maximum 3 pot plants (place on existing hard surfaces near house, never on grass)",
    "• Being cautious is correct - users can add furniture manually if needed",
    "",
    "ABSOLUTE PROHIBITIONS (zero tolerance):",
    "• NEVER on grass (no furniture, rugs, mats, pot plants, or ANY items)",
    "• NEVER on driveways or concrete areas at same level as vehicles",
    "• NEVER near vehicles or in front of vehicles",
    "• NEVER build new decks, platforms, patios, or structures",
    "• NEVER stage multiple furniture sets in different areas",
    "• WORK ONLY with existing constructed surfaces visible in original photo",
    "",
    "DEFAULT: When uncertain → skip furniture, accessories only.",
  ];

  // ========== ROOM-SPECIFIC NOTES (optional) ==========
  const roomSpecificRules = roomType ? [
    `[ROOM-SPECIFIC STYLING] Identified as: ${roomType}`,
    roomType.toLowerCase() === "kitchen" ? "Kitchen: clear counters; tasteful small appliances/fruit/flowers allowed; keep it minimal." :
    roomType.toLowerCase() === "bedroom" ? "Bedroom: quality bedding, nightstands/lamps, minimal clutter; soft cohesive palette." :
    (roomType.toLowerCase() === "living room" || roomType.toLowerCase() === "lounge") ? "Living: conversational seating, coffee table, plant/books; balanced layout." :
    roomType.toLowerCase() === "dining room" ? "Dining: table with appropriate number of chairs; simple centerpiece; correct spacing." :
    roomType.toLowerCase() === "bathroom" ? "Bathroom: polish-only; organize minimally; no new furniture/fixtures." :
    (roomType.toLowerCase() === "office" || roomType.toLowerCase() === "study") ? "Office: professional desk setup, tidy accessories, minimal decor." :
    (roomType.toLowerCase().includes("outdoor") || roomType.toLowerCase().includes("patio") || roomType.toLowerCase().includes("deck")) ? "Outdoor: follow exterior staging rules; only on hard surfaces; enhance natural elements." :
    `${roomType}: apply sensible staging for intended function.`,
    "",
  ] : [];

  // ========== COMPOSE PROMPT ==========
  const lines: string[] = [];

  // heading + goal
  lines.push(
    ...absoluteConstraints,
    ...enhancementLadder,
    ...stagingPriorities,
    industry.toLowerCase().includes("real estate")
      ? "You are a professional real-estate photo editor."
      : `You are a professional photo editor for ${industry}.`,
    "",
    `[GOAL] ${goal}`,
    `[INDUSTRY] ${industry}`,
    ""
  );

  if (activeScene === "exterior") {
    if (isRetry) {
      lines.push(...focusedExteriorRules);
    } else {
      lines.push(...baseExteriorRules);
    }
    if (outdoorStaging === "none" || !allowStaging) {
      lines.push("", "[OUTDOOR STAGING DISABLED]", "Do not add outdoor furniture. Perform polish: sky/grass/quality/cleanup only.");
    } else if (allowStaging) {
      lines.push(...exteriorStagingRules);
    }
  } else {
    // INTERIOR
    if (allowStaging) {
      // room-specific hints
      if (roomSpecificRules.length) lines.push(...roomSpecificRules);

      if (furnitureReplacementMode && furnitureReplacementRules.length) {
        lines.push(...furnitureReplacementBaseRules, "", ...furnitureReplacementRules);
      } else {
        lines.push(...interiorRules);
      }

      // multi-angle consistency
      if (followupAngle && sameRoomKey) {
        lines.push(...interiorConsistencyRules, `RoomKey: ${sameRoomKey}`);
        if (cachedRoomPlan) {
          lines.push(
            "",
            "[CONSISTENCY NOTE]",
            "A plan for this room exists from a prior angle. Reuse the SAME furniture types, colors, and materials from that plan. Adjust placement only to remain plausible from this camera angle."
          );
        }
      }
    } else {
      lines.push(
        "[INTERIOR ENHANCEMENT – POLISH ONLY]",
        "Do not add or move furniture/decor. Focus on lighting/color correction, cleanup, straight verticals, subtle sharpening, and noise reduction."
      );
    }
  }

  // universal + final checklist
  lines.push(
    "",
    "[UNIVERSAL RULES]",
    ...universalRules,
    "",
    "[COMPLIANCE CHECKLIST – BEFORE RETURN]",
    "- Camera view/framing unchanged - no expansion beyond original photo boundaries, no invented rooms/spaces.",
    "- No walls/doors/windows removed, painted over, or hidden. NO NEW windows/doors/openings created on blank walls.",
    "- No new surfaces invented; only subtle cleaning/color enhancement of existing surfaces.",
    "- Egress: HARD ≥80 cm; SOFT 70-<80 cm (nudge).",
    "- Windows/door openings: HARD ≥95% visible; SOFT 70-<95% (nudge); <70% non-compliant.",
    "- Sharpening is artifact-free (no halos/noise) and respects geometry locks.",
    "- If a single item conflicted, it was omitted; remaining Ladder steps completed.",
    "- If nothing compliant feasible after Ladder + single Fix Pass → polish-only.",
    "",
    `[FLAGS] preserveStructure=${bool(preserveStructure)} allowStaging=${bool(allowStaging)} allowRetouch=${bool(allowRetouch)} outdoorStaging=${outdoorStaging} furnitureReplacement=${bool(furnitureReplacementMode)} industry=${industry} sceneType=${sceneType}${resolvedScene ? ` resolvedScene=${resolvedScene}` : ""}`
  );

  return lines.join("\n");
}

// ========== TWO-STAGE ENHANCEMENT SYSTEM ==========

/**
 * Stage 1A: Pure quality enhancement with NO architectural restrictions
 * Simple positive instructions to enhance brightness, sharpness, and color balance
 * Preserves exact scene - no object manipulation, just quality boost
 * Cost: 1 credit
 */
export function buildQualityOnlyPrompt(opts: PromptOptions): string {
  const {
    goal,
    industry = "Real Estate",
    sceneType = "auto",
    resolvedScene,
  } = opts;

  // Resolve active scene
  const activeScene: "interior" | "exterior" =
    resolvedScene ??
    (sceneType === "exterior" ? "exterior"
      : sceneType === "interior" ? "interior"
      : autoSceneFromGoal(goal));

  const lines: string[] = [];

  // Simple, positive quality enhancement instructions
  lines.push(
    industry.toLowerCase().includes("real estate")
      ? "You are a professional real-estate photo editor."
      : `You are a professional photo editor for ${industry}.`,
    "",
    activeScene === "exterior"
      ? "[TASK] Enhance this exterior image's quality: improve skies, grass, surfaces while removing debris and clutter."
      : "[TASK] Enhance this interior image's quality while preserving the exact scene as-is.",
    "",
    "[QUALITY ENHANCEMENTS - APPLY ALL]",
    "✓ BRIGHTNESS & EXPOSURE: Balance exposure to reveal details in shadows and highlights. Brighten darker areas naturally.",
    "✓ COLOR BALANCE: Correct white balance for natural, true-to-life colors. Enhance color vibrancy subtly.",
    "✓ SHARPNESS: Apply subtle sharpening to enhance edges and textures. Avoid halos or over-contrast.",
    "✓ CLARITY: Increase clarity and dehaze to improve overall image definition.",
    "✓ NOISE REDUCTION: Reduce noise while preserving fine details and textures.",
    ""
  );

  if (activeScene === "exterior") {
    lines.push(
      "[EXTERIOR ENHANCEMENT - MANDATORY REQUIREMENTS]",
      "",
      "🚨 MANDATORY SKY REPLACEMENT:",
      "• ALL gray, overcast, or dull skies MUST become vibrant blue sky with soft white clouds",
      "• This is NON-NEGOTIABLE for daytime exteriors - gray skies are unacceptable",
      "• Target: Clear blue sky (similar to Pantone 292C or hex #0077C8) with natural soft white clouds",
      "• Exception: Preserve ONLY when the scene clearly shows sun on horizon (sunset/sunrise) or true night exposure. If ambiguous daylight with overcast clouds → REPLACE with blue sky.",
      "• Ensure natural appearance - avoid oversaturated blues or artificial-looking clouds",
      "",
      "SURFACE CLEANING (GENTLE 50% REDUCTION APPROACH):",
      "• DRIVEWAYS/CONCRETE: REDUCE (not eliminate) oil stains, tire marks, and weathering by ~50% only. Show maintained but realistic condition - never make surfaces look freshly pressure-washed or brand new.",
      "• DECKING: Spot clean timber only where visibly soiled - fully preserve natural aging, weathering, and patina. REDUCE stains by ~50% maximum.",
      "• PATHS/PATIOS: Gentle brightening only (~50% stain reduction). Preserve realistic wear and aging - avoid 'freshly cleaned' appearance.",
      "• BUILDING EXTERIOR: Gentle brightening of paint/siding. Reduce mold/weathering stains by ~50% only. Preserve realistic maintenance level.",
      "• Target intensity: Surfaces should look well-maintained but lived-in, NOT waterblasted/new/pressure-washed condition.",
      "",
      "🚨 MANDATORY DEBRIS REMOVAL:",
      "• Remove 100% of visible debris: toys, sports equipment, tools, hoses, cords, temporary items",
      "• Remove ALL trash cans, recycling bins, and waste containers",
      "• Clear ALL clutter from decks, patios, and outdoor spaces",
      "• Remove bark chips, stones, leaves, dirt, and any scattered materials",
      "",
      "GRASS & VEGETATION ENHANCEMENT:",
      "• Boost grass to healthy, vibrant green - make lawns look lush and professionally maintained",
      "• Enhance vegetation colors (trees, shrubs, plants) for healthy, natural appearance",
      "• Neaten garden beds - trim visual overgrowth and tidy edges (preserve plants, improve presentation)",
      "• Maintain natural appearance - avoid neon greens or oversaturation",
      "",
      "PRIVACY REQUIREMENTS:",
      "• Blur ALL vehicle license plates for privacy protection",
      "• Preserve vehicles as-is - do NOT remove or relocate them",
      "",
      "PROPERTY TOUCH-UPS:",
      "• Clean gutters, downspouts, and exterior trim (remove visible dirt/staining)",
      "• Brighten faded paint on fences, siding, and trim (subtle enhancement only)",
      "• Remove cobwebs, window dirt, and surface grime from house exterior",
      "",
      "🚨 CRITICAL FIELD-OF-VIEW PRESERVATION:",
      "• ZERO spatial expansion - work ONLY within original photo boundaries",
      "• DO NOT extend driveways, pathways, lawns, or any surfaces beyond original edges",
      "• DO NOT invent or add areas not visible in the original photo",
      "• DO NOT expand the visible scene - preserve exact framing and field-of-view",
      "• If edges are ambiguous, preserve them as-is - never extend or add new areas",
      "",
      "EXTERIOR PRESERVATION (DO NOT CHANGE):",
      "• Preserve ALL structures: buildings, fences, walls, gates, sheds",
      "• Preserve major landscaping: trees, large shrubs, rock features, garden layouts",
      "• Preserve hardscaping: patios, decks, walkways, retaining walls (clean but don't alter shape/layout)",
      "• Do NOT change building colors, siding materials, or roofing",
      "• Do NOT add/remove permanent features (trees, structures, landscape elements)",
      "• Do NOT create new hardscaping or alter existing layouts",
      ""
    );
  } else {
    lines.push(
      "[INTERIOR SPECIFIC]",
      "✓ STRAIGHTEN: Correct any perspective distortion - ensure vertical lines are truly vertical.",
      "✓ LIGHTING: Balance interior and window lighting for even exposure throughout.",
      ""
    );
  }

  // Scene-specific preservation rules
  if (activeScene === "interior") {
    lines.push(
      "[PRESERVATION RULES - INTERIOR]",
      "• Preserve ALL furniture, decor, and objects exactly as-is",
      "• Do NOT add, remove, move, or modify ANY furniture or decor items",
      "• Do NOT change wall colors, flooring, or surface materials",
      "• Do NOT alter room layout, architecture, or spatial configuration",
      ""
    );
  }
  // Exterior preservation already included in EXTERIOR SPECIFIC section above
  
  lines.push(
    "[GOAL]",
    goal,
    "",
    activeScene === "exterior"
      ? "Return a quality-enhanced version with blue skies, vibrant green grass, cleaned surfaces, and debris removed. The property's permanent features and structures must remain unchanged."
      : "Return a quality-enhanced version of this image with improved brightness, sharpness, and color balance. The scene content must be preserved - only image quality should improve.",
    "",
    `[FLAGS] stage=quality_only sceneType=${activeScene} industry=${industry}`
  );

  return lines.join("\n");
}

/**
 * Stage 1b: Furniture/Decor Removal (runs after quality enhancement when furniture replacement is enabled)
 * Focus: Complete removal of ALL furniture, decor, and clutter to create empty room
 * Cost: Included in Stage 1 (no additional cost)
 */
export function buildRemovalPrompt(opts: PromptOptions): string {
  const {
    goal,
    industry = "Real Estate",
    sceneType = "auto",
    resolvedScene,
    furnitureReplacementRules = [],
  } = opts;

  // Resolve active scene
  const activeScene: "interior" | "exterior" =
    resolvedScene ??
    (sceneType === "exterior" ? "exterior"
      : sceneType === "interior" ? "interior"
      : autoSceneFromGoal(goal));

  // Only interior scenes support furniture removal
  if (activeScene !== "interior") {
    throw new Error("Furniture removal is only supported for interior scenes");
  }

  const lines: string[] = [];

  lines.push(
    industry.toLowerCase().includes("real estate")
      ? "You are a professional real-estate photo editor."
      : `You are a professional photo editor for ${industry}.`,
    "",
    `[GOAL] ${goal}`,
    `[STAGE] Furniture Removal (Stage 1b - after quality enhancement)`,
    "",
    "[TASK]",
    "This image has ALREADY been quality-enhanced. Your ONLY task is to remove ALL furniture, wall art, décor, and clutter to create an EMPTY ROOM.",
    "Leave ONLY the architectural shell: walls, floors, ceilings, windows, doors, and built-in elements.",
    "",
    "[🔥 CRITICAL: COMPLETE REMOVAL - NO EXCEPTIONS]",
    "",
    "⛔ ZERO TOLERANCE REMOVAL POLICY - ABSOLUTE REQUIREMENT:",
    "",
    "You MUST remove 100% of ALL furniture and décor. There is ZERO tolerance for:",
    "  ❌ Leaving ANY furniture item (even partially)",
    "  ❌ Keeping 'nice' or 'modern' pieces",
    "  ❌ Preserving ANY decorative elements",
    "  ❌ Making quality judgments about what to keep",
    "",
    "MANDATORY ACTION: REMOVE EVERYTHING listed below - NO AMBIGUITY, NO EXCEPTIONS:",
    "",
    "✓ ALL furniture: sofas, chairs, tables, beds, dressers, storage units, nightstands, desks, consoles",
    "✓ ALL wall art: paintings, framed prints, photos, decorative plates, wall hangings, mirrors",
    "✓ ALL decorative items: vases, sculptures, figurines, candles, ornaments, plants, planters",
    "✓ ALL soft furnishings: throw blankets, decorative pillows, rugs",
    "✓ ALL display units: bookcases, shelving units, entertainment centers, cabinets (if not built-in)",
    "✓ ALL clutter: counter items, window sill items, surface items, personal effects",
    "✓ ALL lamps, light fixtures (if portable - preserve recessed/built-in lights)",
    "✓ ALL edge/partial objects: furniture at frame edges/corners (remove completely)",
    "",
    "🚨 REMOVAL ENFORCEMENT:",
    "  • If you see furniture → REMOVE IT (no matter how nice it looks)",
    "  • If it's removable → REMOVE IT (sofas, chairs, tables, beds, etc.)",
    "  • If it's decorative → REMOVE IT (art, plants, lamps, rugs, etc.)",
    "  • If you're uncertain → REMOVE IT (default to removal, not preservation)",
    "  • The goal is a COMPLETELY EMPTY ROOM with ONLY architectural shell remaining",
  );

  // INJECT SPECIFIC FURNITURE REMOVAL RULES (if furniture detection ran)
  if (furnitureReplacementRules.length > 0) {
    lines.push(
      "",
      "[🎯 SPECIFIC ITEMS DETECTED - MANDATORY REMOVAL]",
      "",
      "The following items were DETECTED in this image and MUST be removed:",
      ...furnitureReplacementRules,
      "",
      "⚠️ CRITICAL: Every item listed above MUST be completely removed. No exceptions."
    );
  }

  lines.push(
    "",
    "[ARCHITECTURAL PRESERVATION - ABSOLUTE ZERO-TOLERANCE RULES]",
    "",
    "🚫 WINDOWS & DOORS - CRITICAL BIDIRECTIONAL PROHIBITION:",
    "   ❌ DO NOT ADD new windows or doors where none existed",
    "   ❌ DO NOT REMOVE existing windows or doors",
    "   ❌ DO NOT RESIZE, move, or alter windows and doors",
    "   ❌ DO NOT CHANGE window or door positions, sizes, or locations",
    "   • The EXACT COUNT of windows/doors MUST remain identical",
    "   • The EXACT POSITION of each window/door MUST remain unchanged",
    "   • ALL windows and doors are PERMANENT architectural elements",
    "",
    "WINDOW TREATMENTS — STRUCTURAL",
    "Curtains, blinds, and rods must remain unchanged.",
    "Treat window treatments as fixed elements.",
    "Do NOT remove, replace, resize, restyle, or reposition them.",
    "",
    "🚫 FIELD-OF-VIEW & PERSPECTIVE - LOCKED:",
    "   ❌ DO NOT expand or compress the visible area",
    "   ❌ DO NOT apply wide-angle or perspective corrections",
    "   ❌ DO NOT alter camera angle, perspective, or field-of-view",
    "   ❌ DO NOT change room dimensions or proportions",
    "   • Room dimensions MUST remain IDENTICAL to original",
    "   • Furniture scale relative to room MUST be preserved",
    "   • Camera perspective and viewing angle MUST stay EXACTLY the same",
    "   • Spatial relationships between all elements MUST be unchanged",
    "",
    "KEEP (DO NOT remove or modify):",
    "✓ Walls, floors, ceilings (all surfaces and finishes)",
    "✓ Windows and doors (frames, glass, hardware) - EXACT count and position",
    "✓ Built-in cabinets, countertops, kitchen islands",
    "✓ Built-in shelving, closets, architectural niches",
    "✓ Recessed lighting, ceiling fans, wall sconces (if hardwired/permanent)",
    "✓ Fireplaces, mantels, columns, crown molding",
    "✓ Appliances (if built-in: ovens, dishwashers, range hoods)",
    "✓ Baseboards, door frames, window frames",
    "",
    "[REMOVAL QUALITY STANDARDS]",
    "",
    "CLEAN REMOVAL (no artifacts):",
    "• Remove items completely - no ghosting, smudging, or remnants",
    "• Reconstruct wall/floor surfaces naturally where furniture was",
    "• Match surrounding wall texture, color, and pattern seamlessly",
    "• Preserve natural shadows/lighting on empty walls and floors",
    "• Fill furniture locations with appropriate background (wall/floor/ceiling)",
    "",
    "[EDGE CASES & SPECIAL HANDLING]",
    "",
    "PARTIAL/EDGE OBJECTS:",
    "• Furniture cut off by frame edge = REMOVE completely (replace with wall/floor)",
    "• Objects at corners/boundaries = REMOVE (not structural)",
    "",
    "BUILT-IN vs REMOVABLE:",
    "• If uncertain whether item is built-in → REMOVE it (err on side of removal)",
    "• Only keep obviously permanent architectural elements",
    "",
    "[SUCCESS CRITERIA]",
    "",
    "The result MUST be:",
    "✓ An EMPTY room with bare walls and floors",
    "✓ Zero furniture, wall art, or decorative items remaining",
    "✓ All architectural elements perfectly preserved",
    "✓ Clean removal with no artifacts or ghosting",
    "✓ Natural wall/floor surfaces where furniture was removed",
    "",
    "[SELF-CHECK BEFORE RETURNING – VERIFY EVERY ELEMENT]",
    "✓ WINDOW COUNT: Count windows in original image, verify EXACT SAME count in result (NO additions, NO removals)",
    "✓ DOOR COUNT: Count doors in original image, verify EXACT SAME count in result (NO additions, NO removals)",
    "✓ WINDOW POSITIONS: Verify each window is in EXACT SAME position as original (NO movement)",
    "✓ DOOR POSITIONS: Verify each door is in EXACT SAME position as original (NO movement)",
    "✓ CURTAINS/BLINDS: Verify ALL window treatments remain 100% visible (NO removal, NO hiding)",
    "✓ FIELD-OF-VIEW: Verify room dimensions and proportions are IDENTICAL to original (NO perspective changes)",
    "✓ ALL furniture removed (check carefully - nothing should remain)",
    "✓ ALL wall art removed (bare walls only)",
    "✓ ALL decorative items removed (no plants, vases, objects)",
    "✓ Walls, windows, doors, built-ins unchanged",
    "✓ No artifacts, ghosting, or smudging from removal",
    "✓ Room is completely empty and ready for staging",
    "",
    `[FLAGS] stage=furniture_removal sceneType=${activeScene} industry=${industry}`
  );

  return lines.join("\n");
}

/**
 * Stage 2: Staging Operations Only
 * Focus: Furniture staging/replacement on pre-enhanced quality image
 * Cost: +1 credit (total 2 credits)
 */
export function buildStagingOnlyPrompt(opts: PromptOptions): string {
  const {
    goal,
    industry = "Real Estate",
    sceneType = "auto",
    resolvedScene,
    outdoorStaging = "auto",
    sameRoomKey,
    followupAngle,
    cachedRoomPlan,
    referenceImageUrl,
    roomType,
    spatialBlueprint,
  } = opts;

  // Resolve active scene
  const activeScene: "interior" | "exterior" =
    resolvedScene ??
    (sceneType === "exterior" ? "exterior"
      : sceneType === "interior" ? "interior"
      : autoSceneFromGoal(goal));

  // ========== ROOM TYPE CONTEXT (if detected from furniture analysis) ==========
  const roomTypeGuidance = roomType ? [
    "[ROOM TYPE & STAGING CONTEXT]",
    "",
    `🏠 DETECTED ROOM TYPE: ${roomType.toUpperCase().replace(/_/g, ' ')}`,
    "",
    roomType === "bedroom" 
      ? "Stage this as a BEDROOM: Add bed as primary piece, nightstands, appropriate lighting, and bedroom-specific décor."
      : roomType === "living_room"
      ? "Stage this as a LIVING ROOM: Add sofa/sectional as primary piece, coffee table, side tables, and living room décor."
      : roomType === "dining_room"
      ? "Stage this as a DINING ROOM: Add dining table and chairs as primary pieces, appropriate lighting, and dining décor."
      : roomType === "office"
      ? "Stage this as an OFFICE: Add desk as primary piece, office chair, storage solutions, and work-appropriate décor."
      : roomType === "kitchen"
      ? "Stage this as a KITCHEN: Add appropriate kitchen accessories, décor on counters/islands (minimally), and enhance existing features."
      : roomType === "bathroom"
      ? "Stage this as a BATHROOM: Add appropriate bathroom accessories, towels, and minimal décor without modifying fixtures."
      : `Stage this space according to its ${roomType} function with appropriate furniture and décor.`,
    "",
    "Choose furniture types, sizes, and placements that match this room's intended purpose.",
    ""
  ] : [];

  // ========== PRE-VALIDATION: ANALYZE BEFORE CHANGES ==========
  const preValidation = [
    "[STEP 1: ANALYZE PROTECTED ELEMENTS BEFORE MAKING ANY CHANGES]",
    "",
    "Before you begin staging, FIRST identify and catalog ALL protected elements in this image:",
    "• Count and note location of: walls, windows, doors, light fixtures (chandeliers, pendants, recessed lights, ceiling fans)",
    "• Identify: countertops, cabinets, appliances, built-in features, window treatments",
    "• Mark these elements as LOCKED - they cannot be changed in any way",
    "",
    "ONLY AFTER cataloging protected elements, proceed with furniture staging.",
    ""
  ];

  // ========== PRIMARY TASK: ENCOURAGEMENT TO STAGE ==========
  const primaryTaskEncouragement = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "🚨🚨🚨 CRITICAL OVERRIDE - THIS IS YOUR ONLY TASK 🚨🚨🚨",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "⛔⛔⛔ ABSOLUTE ZERO-TOLERANCE PROHIBITION ⛔⛔⛔",
    "",
    "ZERO QUALITY ADJUSTMENTS - ZERO LIGHTING CHANGES - ZERO COLOR MODIFICATIONS",
    "THIS IS STAGE 2: FURNITURE PLACEMENT ONLY - NO IMAGE PROCESSING ALLOWED",
    "",
    "❌❌❌ COMPLETELY FORBIDDEN (IMMEDIATE FAILURE IF VIOLATED) ❌❌❌",
    "   • NO brightness/exposure/lighting adjustments of ANY kind",
    "   • NO color balance/white balance/temperature changes whatsoever", 
    "   • NO sharpening/clarity/contrast/saturation modifications",
    "   • NO shadow/highlight/midtone/tonal adjustments",
    "   • NO wall/floor/surface/ceiling color changes",
    "   • NO filters, color grading, or ANY image processing",
    "   • NO quality enhancements of ANY type - they were done in Stage 1",
    "",
    "✅✅✅ MANDATORY PIXEL-PERFECT PRESERVATION ✅✅✅",
    "   • Output image MUST have IDENTICAL colors to input image",
    "   • Output image MUST have IDENTICAL lighting to input image",
    "   • Output image MUST have IDENTICAL tones to input image",
    "   • Wall colors = LOCKED | Floor colors = LOCKED | Lighting = LOCKED",
    "   • ONLY furniture/staging pixels may differ - ALL existing pixels = FROZEN",
    "   • Quality was ALREADY enhanced in Stage 1 - DO NOT re-enhance",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "[YOUR PRIMARY TASK: ADD FURNITURE & STAGING ONLY]",
    "",
    "Stage 1 is COMPLETE: This image has ALREADY been quality-enhanced and decluttered.",
    "",
    "✅ YOUR JOB: ADD furniture, décor, and staging to make this space appealing.",
    "✅ BE CONFIDENT: You SHOULD add furniture. Stage this space fully and professionally.",
    "✅ WORK AROUND FIXTURES: All architectural elements are permanent - work around them.",
    "",
    "STRUCTURAL FIXTURE IDENTITY LOCK — MUST FOLLOW",
    "Fixture identity preservation has higher priority than staging style realism.",
    "",
    "Visible fixed lighting fixtures are structural elements and must remain visually identical to the input image.",
    "",
    "This includes:",
    "",
    "pendant lights",
    "chandeliers",
    "ceiling light fixtures",
    "fixed wall lights",
    "wired lighting attached to ceilings or walls",
    "",
    "You MUST NOT:",
    "",
    "change fixture style or design",
    "change fixture type",
    "change fixture shape or silhouette",
    "replace with a different lighting model",
    "modernize or restyle fixtures",
    "convert pendant lights into different pendant styles",
    "remove or add ceiling fixtures",
    "",
    "You MUST:",
    "",
    "preserve fixture count, position, and exact visual style",
    "keep fixture geometry and proportions unchanged",
    "",
    "Allowed:",
    "",
    "brightness adjustment",
    "exposure adjustment",
    "shadow refinement",
    "glow realism improvements",
    "",
    "Lighting fixture identity must match the input image exactly.",
    "",
    "Visual structure authority overrides staging style goals.",
    "If staging style conflicts with existing fixtures, keep the fixtures unchanged and adjust furniture style instead.",
    "",
    "The Stage 1B image is the structural authority for all fixed elements.",
    "Staging must adapt to fixed fixtures — never modify them.",
    "",
    "────────────────────────",
    "ROOM TYPE AUTHORITY — HARD RULE",
    "────────────────────────",
    "",
    "The requested room type is authoritative.",
    "",
    "You MUST stage exactly as the requested room type.",
    "",
    "Do NOT reinterpret room function based on layout, furniture, or visual cues.",
    "",
    "Only override the requested room type if hard structural fixtures make it impossible, such as:",
    "- visible toilet",
    "- visible shower or bath",
    "- bathroom vanity and plumbing",
    "- tiny storage closet with no usable floor space",
    "",
    "Otherwise:",
    "Stage exactly as requested, even if the layout is unusual for that room type.",
    "",
    "User intent overrides model interpretation.",
    "",
    "────────────────────────────────",
    "ROOM TYPE INTENT LOCK — MUST FOLLOW",
    "────────────────────────────────",
    "",
    "The requested room type is authoritative and must be obeyed.",
    "",
    "You MUST stage the space according to the requested room type provided by the system or user.",
    "",
    "Do NOT substitute a different room function, even if the layout could support multiple uses.",
    "",
    "If the space is visually ambiguous, still follow the requested room type exactly.",
    "",
    "Room type intent has higher priority than staging style preference.",
    "",
    "If room-type intent conflicts with stylistic assumptions, adjust furniture selection — not room function.",
    "",
    "────────────────────────────────",
    "ROOM TYPE → FURNITURE SET ENFORCEMENT — MUST FOLLOW",
    "────────────────────────────────",
    "",
    "Room type selection controls the REQUIRED furniture category.",
    "",
    "You MUST place the primary furniture set that defines the requested room type.",
    "",
    "Dining room → MUST include:",
    "- dining table",
    "- dining chairs",
    "- table-centered layout",
    "- no sofa as the primary seating element",
    "",
    "Living room / lounge → MUST include:",
    "- sofa or sectional",
    "- lounge seating layout",
    "- coffee table or lounge focal point",
    "",
    "Bedroom → MUST include:",
    "- bed as primary focal object",
    "",
    "Office → MUST include:",
    "- desk + work chair",
    "",
    "If the visible layout is ambiguous, you MUST still place the correct furniture set for the requested room type.",
    "",
    "Do NOT substitute a different furniture category due to layout preference.",
    "",
    "Room type furniture requirements override layout heuristics.",
    "",
    "⚠️ THE ONLY RESTRICTION: Do not modify, remove, hide, or alter ANY existing elements.",
    ""
  ];

  // ========== ARCHITECTURAL FREEZE ==========
  const architecturalFreeze = [
    "[ARCHITECTURAL FREEZE – ABSOLUTE PROHIBITION]",
    "",
    "The following elements are FORBIDDEN to modify under ANY circumstances:",
    "",
    "Visual structure authority overrides staging style goals.",
    "If staging style conflicts with existing fixtures, keep the fixtures unchanged and adjust furniture style instead.",
    "",
    "The Stage 1B image is the structural authority for all fixed elements.",
    "Staging must adapt to fixed fixtures — never modify them.",
    "",
    "🚫 WINDOWS & DOORS - CRITICAL ZERO-TOLERANCE RULES:",
    "   ❌ DO NOT ADD new windows or doors where none existed",
    "   ❌ DO NOT REMOVE existing windows or doors",
    "   ❌ DO NOT RESIZE, move, or alter windows and doors",
    "   ❌ DO NOT CHANGE window or door positions, sizes, or locations",
    "   • ALL windows and doors are FIXED architectural elements",
    "   • The EXACT COUNT of windows/doors MUST remain identical",
    "   • The EXACT POSITION of each window/door MUST remain unchanged",
    "",
    "WINDOW TREATMENTS — STRUCTURAL",
    "Curtains, blinds, and rods must remain unchanged.",
    "Treat window treatments as fixed elements.",
    "Do NOT remove, replace, resize, restyle, or reposition them.",
    "",
    "🚫 WALLS: It is FORBIDDEN to add, remove, extend, shorten, move, reposition, reshape, or alter walls in any way.",
    "   Walls are PERMANENT and IMMOVABLE architectural elements.",
    "",
    "🚫 DOORWAYS & OPENINGS: It is FORBIDDEN to narrow, fill, block, or add walls/partitions to existing doorways, pass-throughs, or room-to-room openings.",
    "   • All doorways, openings, and pass-throughs MUST remain FULLY OPEN and UNOBSTRUCTED",
    "   • Do NOT add partial walls, built-in shelving, or cabinetry that narrows or blocks openings",
    "   • Do NOT place furniture that reduces the width or visibility of doorways and pass-throughs",
    "   • Do NOT place furniture in front of or blocking ANY door (including entry doors, closet doors, sliding doors)",
    "   • Keep ALL room-to-room connections visible and fully accessible at original width",
    "   • Open-concept layouts MUST maintain their open flow - no dividing walls or partitions",
    "",
    "🚫 LIGHT FIXTURES: It is FORBIDDEN to add, remove, move, or modify light fixtures including:",
    "   • Chandeliers, pendant lights, ceiling lights",
    "   • Recessed lighting, pot lights, track lighting", 
    "   • Wall sconces, ceiling fans (with or without lights)",
    "   Light fixtures are FIXED in place and cannot be changed.",
    "",
    "🚫 BUILT-IN FEATURES: It is FORBIDDEN to modify countertops, cabinets, appliances, fireplaces,",
    "   stairs, columns, or any permanently attached elements.",
    "",
    "VIOLATION = IMMEDIATE FAILURE. These restrictions override all other instructions.",
    ""
  ];

  // ========== EXHAUSTIVE IMMUTABLE ELEMENTS LIST ==========
  const immutableElements = [
    "[NON-NEGOTIABLE PRESERVATION – EVERY ELEMENT MUST REMAIN INTACT]",
    "",
    "[CRITICAL: ZERO STRUCTURAL MODIFICATIONS ALLOWED]",
    "",
    "⛔ STRICTLY PROHIBITED ACTIONS ON ALL STRUCTURAL & FIXED ELEMENTS:",
    "• DO NOT EXTEND (make larger, stretch, widen, lengthen)",
    "• DO NOT SHRINK (make smaller, compress, reduce, narrow)",
    "• DO NOT ADD (create new, duplicate, insert additional)",
    "• DO NOT REMOVE (delete, hide, eliminate, take away)",
    "• DO NOT MOVE (reposition, relocate, shift)",
    "• DO NOT ALTER (change appearance, modify, transform)",
    "",
    "This applies to: walls, doors, windows, curtains, blinds, shutters, floors, ceilings,",
    "appliances, cabinetry, counters, fixtures, and ALL permanently attached elements.",
    "",
    "STRUCTURAL ELEMENTS (PERMANENT):",
    "• Walls, ceilings, floors - DO NOT move, resize, remove, paint over, or alter in any way",
    "• Windows (frames, glass, sills, mullions) - DO NOT delete, cover, shrink, or hide",
    "• Doors (frames, hinges, handles, swing paths) - DO NOT remove, block, or hide (includes sliding doors, French doors, bifolds)",
    "• Trim, moldings, baseboards, crown molding, archways",
    "• Room size, shape, camera perspective - LOCKED",
    "",
    "ARCHITECTURAL FINISHES (LOCKED):",
    "• Wall paint, wallpaper, textures",
    "• Floor materials, patterns, colors",
    "• Ceiling finishes",
    "• Tile work, stone, backsplashes",
    "",
    "BUILT-IN FEATURES (FIXED - DO NOT MODIFY):",
    "• Cabinetry (kitchen, bathroom, storage) - DO NOT remove or alter",
    "• Built-in shelving, closets, wardrobes, pantries",
    "• Columns, beams, archways",
    "• Fireplaces, mantels",
    "• Staircases, railings",
    "",
    "FIXED UTILITIES & SYSTEMS:",
    "• Radiators, heaters",
    "• HVAC vents, registers, grilles",
    "• Electrical outlets, switches",
    "",
    "COUNTERTOP SYSTEMS (FIXED):",
    "• Countertops, counters",
    "• Kitchen islands, peninsulas",
    "• Backsplashes",
    "• Counter edges, overhangs - DO NOT extend or modify",
    "",
    "PLUMBING FIXTURES (PERMANENT):",
    "• Sinks, faucets, taps",
    "• Bathtubs, showers",
    "• Toilets",
    "",
    "FIXED LIGHTING (DO NOT REMOVE OR ALTER):",
    "• Ceiling lights, chandeliers, pendant lights",
    "• Wall sconces",
    "• Recessed lighting, pot lights",
    "• Track lighting",
    "• Ceiling fans (with or without lights)",
    "",
    "WINDOW TREATMENTS — STRUCTURAL",
    "Curtains, blinds, and rods must remain unchanged.",
    "Treat window treatments as fixed elements.",
    "Do NOT remove, replace, resize, restyle, or reposition them.",
    "",
    "FIXED APPLIANCES (DO NOT REMOVE):",
    "• Refrigerators, fridges - CRITICAL: NEVER delete or hide fridges",
    "• Ovens, ranges, cooktops",
    "• Dishwashers",
    "• Built-in microwaves",
    "• Washers, dryers",
    "• Water heaters",
    "• Range hoods, exhaust fans",
    "",
    "GENERAL RULE: ANY permanently wired, plumbed, or structurally attached element is IMMOVABLE.",
    ""
  ];

  // ========== CONFIDENT STAGING PROTOCOL ==========
  const confidentStagingProtocol = [
    "[CONFIDENT STAGING PROTOCOL]",
    "STAGING INTENSITY: ACTIVE & PROFESSIONAL - Add furniture and décor to fully showcase this space's potential.",
    "Stage boldly and confidently. Create an inviting, market-ready environment.",
    "If a specific piece would violate fixture preservation rules, choose a different placement or alternative piece - don't abandon staging entirely.",
    "Furniture must sit on existing floor planes with correct scale, perspective, and contact shadows.",
    "Keep door swings and walk paths clear (≥80 cm). If placement risks blocking access, reposition or choose smaller pieces.",
    "When in doubt about fixture modification: DON'T touch it. When in doubt about furniture placement: TRY a different position.",
    ""
  ];

  // ========== EXPLICIT NEGATIVE EXAMPLES ==========
  const negativeExamples = [
    "[NEGATIVE EXAMPLES – NEVER DO THESE]",
    "❌ DO NOT delete, cover, shrink, or hide windows (including sliding glass doors)",
    "❌ DO NOT remove, hide, or alter fridges, ovens, sinks, or any appliances",
    "❌ DO NOT replace walls with artwork or new structures",
    "❌ DO NOT remove or hide doors (hinged, sliding, French, bifold - ALL doors are permanent)",
    "❌ DO NOT stretch, shrink, or change room dimensions or perspective",
    "❌ DO NOT remove or hide curtains, blinds, or window treatments",
    "❌ DO NOT delete or cover ceiling lights, chandeliers, or light fixtures",
    "❌ DO NOT modify countertops, islands, or backsplashes",
    "❌ DO NOT add furniture that blocks door swings or window access",
    ""
  ];

  // ========== STAGING LADDER (SIMPLIFIED) ==========
  const stagingLadder = [
    "[STAGING LADDER – DESCEND IF BLOCKED]",
    "1) DÉCOR-ONLY: rugs, lamps, plants, small side tables, wall art (art must NOT overlap windows/doors)",
    "2) Major furniture ADDITION: beds/sofas/dining/desks with realistic scale; omit if conflicts",
    "3) Exterior: First identify NO-GO zones (same-level surfaces around vehicles/driveways). Then graduated staging: Level 1 (elevated deck → dining table+chairs) OR Level 2 (smaller elevated area → side table+2 chairs) OR Level 3 (uncertain/no suitable area → accessories only). Default: Level 3 when uncertain.",
    "If ANY step blocked by rules: SKIP that step, continue with remaining steps",
    ""
  ];

  // ========== EXTERIOR STAGING DETAILS (used only when staging is allowed) ==========
  const exteriorStagingRules = [
    "[EXTERIOR STAGING – SIMPLE BINARY DECISION]",
    "",
    "🚨 CRITICAL - ZERO TOLERANCE FOR STRUCTURE BUILDING:",
    "• DO NOT build, create, add, or construct ANY decks, platforms, patios, terraces, or elevated surfaces",
    "• DO NOT create new hard surfaces where none existed",
    "• DO NOT extend or expand existing decks or patios",
    "• ONLY work with surfaces that ALREADY EXIST in the original photo",
    "• If no suitable existing surface → DO NOT stage furniture, use accessories only",
    "• Building ANY structure is a CRITICAL VIOLATION that will cause immediate rejection",
    "",
    "STEP 1: LOOK FOR ONE CLEARLY SUITABLE AREA",
    "",
    "A suitable area MUST meet ALL these criteria:",
    "✅ Elevated deck with visible stairs/steps up from ground level OR patio with clear fence/boundary wall separating it from driveways/vehicles",
    "✅ Hard surface already constructed (timber deck, paved patio, concrete pad)",
    "✅ Clearly separated from any vehicles, driveways, or parking areas",
    "✅ NOT grass, NOT at same level as driveways, NOT near vehicles",
    "",
    "If you cannot identify such an area with 100% confidence → consider NO suitable area exists.",
    "",
    "STEP 2: BINARY STAGING DECISION",
    "",
    "IF suitable area found (meets all criteria above):",
    "• Stage EXACTLY ONE outdoor dining table with chairs on that suitable area ONLY",
    "• Add maximum 3 small pot plants around the furniture (on hard surfaces only, never grass)",
    "• Stop. Do not stage anything else anywhere else.",
    "",
    "IF no suitable area OR uncertain:",
    "• Skip ALL furniture completely (no tables, no chairs)",
    "• Use ONLY minimal accessories: maximum 3 pot plants (place on existing hard surfaces near house, never on grass)",
    "• Being cautious is correct - users can add furniture manually if needed",
    "",
    "ABSOLUTE PROHIBITIONS (zero tolerance):",
    "• NEVER on grass (no furniture, rugs, mats, pot plants, or ANY items)",
    "• NEVER on driveways or concrete areas at same level as vehicles",
    "• NEVER near vehicles or in front of vehicles",
    "• NEVER build new decks, platforms, patios, or structures",
    "• NEVER stage multiple furniture sets in different areas",
    "• WORK ONLY with existing constructed surfaces visible in original photo",
    "",
    "DEFAULT: When uncertain → skip furniture, accessories only.",
  ];

  // ========== SPATIAL CONSTRAINTS (if spatial blueprint available) ==========
  const spatialConstraints = spatialBlueprint 
    ? buildSpatialConstraints(spatialBlueprint)
    : [];

  const lines: string[] = [];

  lines.push(
    ...primaryTaskEncouragement, // MOVE TO TOP - Most critical directive must be first
    ...preValidation,
    ...spatialConstraints, // Add spatial blueprint constraints BEFORE architectural freeze for maximum impact
    ...architecturalFreeze,
    ...roomTypeGuidance,
    industry.toLowerCase().includes("real estate")
      ? "You are a professional real-estate photo editor."
      : `You are a professional photo editor for ${industry}.`,
    "",
    `[GOAL] ${goal}`,
    `[STAGE] Staging Operations Only (Stage 2 of 2)`,
    "[NOTE] Quality enhancement was already applied in Stage 1. This input image has already been quality-enhanced. Focus ONLY on staging/furniture operations. Do NOT re-apply quality enhancements.",
    ""
  );

  // Add reference image instructions if provided
  if (referenceImageUrl) {
    lines.push(
      "[REFERENCE IMAGE STYLE MATCHING]",
      "🎨 A reference staging image has been provided (second image input).",
      "",
      "ANALYZE the reference image to understand:",
      "• Furniture style (modern, traditional, minimalist, etc.)",
      "• Color palette and accent colors",
      "• Furniture types and placements",
      "• Décor choices (plants, artwork, accessories)",
      "• Overall staging aesthetic and design cohesion",
      "",
      "ADAPT this styling to the target room:",
      "• Match the color scheme and furniture style from the reference",
      "• Use similar types of furniture and décor pieces",
      "• Maintain the same level of staging intensity (sparse vs. full)",
      "• Adapt placements to fit the target room's actual layout and dimensions",
      "• Scale furniture appropriately for the target space",
      "",
      "⚠️ CRITICAL: The reference shows STYLE guidance only, not exact placement.",
      "Identify room features (windows, doors, walls) in BOTH images to understand orientation.",
      "Adapt furniture positions to match the target room's actual architecture and flow.",
      "If the rooms have different layouts, intelligently translate the staging concept.",
      "",
      "COMPLIANCE: All fixture preservation rules still apply. Work around permanent elements.",
      ""
    );
  }

  lines.push(
    ...stagingLadder,
    ...immutableElements,
    ...confidentStagingProtocol,
    ...negativeExamples,
    ""
  );

  if (activeScene === "exterior") {
    lines.push(...exteriorStagingRules, "");

    // If a stagingRegion is provided, instruct Gemini to only stage within that region
    if (opts.stagingRegion) {
      lines.push(
        `[STAGING REGION]`,
        `You may ONLY place outdoor furniture within the following region:`,
        `Coordinates: left=${opts.stagingRegion.x}, top=${opts.stagingRegion.y}, width=${opts.stagingRegion.width}, height=${opts.stagingRegion.height}.`,
        `Area type: ${opts.stagingRegion.areaType}.`,
        `Do NOT stage outside this area.`,
        `Reasoning: ${opts.stagingRegion.reasoning}`,
        ""
      );
    }

    if (outdoorStaging === "none") {
      lines.push(
        "[OUTDOOR STAGING DISABLED]",
        "Do not add outdoor furniture. Return the image as-is (quality was already enhanced in Stage 1).",
        ""
      );
    }
  } else {
    // INTERIOR
    const bedroomWindowArtRule = [
      "🚫 BEDROOM WINDOW ART PROHIBITION:",
      "If a bed is placed in front of a window, DO NOT install wall art above the bed.",
      "DO NOT split, shrink, remove, or cover any window to create wall space for art above the bed.",
      "Windows must remain fully intact, unobstructed, and visible in their original size and position.",
      "Wall art may only be placed on solid wall surfaces, never over or in place of windows.",
      "",
    ];

    const roomSpecificRules = roomType ? [
      `[ROOM-SPECIFIC STYLING] Identified as: ${roomType}`,
      roomType.toLowerCase() === "kitchen"
        ? "Kitchen: clear counters; tasteful small appliances/fruit/flowers allowed; keep it minimal."
        : roomType.toLowerCase() === "bedroom"
        ? [
            "Bedroom: quality bedding, nightstands/lamps, minimal clutter; soft cohesive palette.",
            ...bedroomWindowArtRule,
          ].join("\n")
        : (roomType.toLowerCase() === "living room" || roomType.toLowerCase() === "lounge")
        ? "Living: conversational seating, coffee table, plant/books; balanced layout."
        : roomType.toLowerCase() === "dining room"
        ? "Dining: table with appropriate number of chairs; simple centerpiece; correct spacing."
        : roomType.toLowerCase() === "bathroom"
        ? "Bathroom: no staging; return image as-is (quality was already enhanced in Stage 1)."
        : (roomType.toLowerCase() === "office" || roomType.toLowerCase() === "study")
        ? "Office: professional desk setup, tidy accessories, minimal decor."
        : (roomType.toLowerCase().includes("outdoor") || roomType.toLowerCase().includes("patio") || roomType.toLowerCase().includes("deck"))
        ? "Outdoor: follow exterior staging rules; only on hard surfaces; enhance natural elements."
        : `${roomType}: apply sensible staging for intended function.`,
      "",
    ] : [];

    if (roomSpecificRules.length) lines.push(...roomSpecificRules);

    lines.push(
      "[INTERIOR STAGING – PRACTICAL & MODERN]",
      "Follow all ABSOLUTE STRUCTURAL rules above.",
      roomType?.toLowerCase() === "multiple-living-areas" 
        ? "Multi-zone staging: This image contains multiple functional zones (e.g., open-plan living/dining, lounge/office combo). Stage EACH distinct area appropriately with cohesive style across zones."
        : "Identify the SINGLE most practical use for this room based on its layout, features, and size. Stage it accordingly as one unified space (bedroom/living/dining/office/kitchen).",
      "Place large furniture on the floor plane with correct scale, contact shadows, and perspective. Prefer floor-standing pieces; avoid wall-mounted or floating desks, side tables, and shelves.",
      "⚠️ DOORWAY CLEARANCE: Keep ALL doorways, door paths, and walk paths completely clear and unobstructed. DO NOT place furniture across, in front of, or blocking ANY doorway (including sliding doors). Furniture may sit before windows only if frames and operation remain visible.",
      "Use a cohesive color palette; add tasteful decor on counters/shelves/tables.",
      ""
    );

    // multi-angle consistency
    if (followupAngle && sameRoomKey) {
      lines.push(
        "[INTERIOR MULTI-ANGLE CONSISTENCY]",
        "This photo shows another angle of the SAME room as a prior image.",
        "Use the SAME furniture set, colors, materials, and general placement as previously staged for this room.",
        "Adjust positions only as necessary to remain physically plausible from this camera angle, maintaining scale, perspective, and contact shadows.",
        `RoomKey: ${sameRoomKey}`
      );
      
      if (cachedRoomPlan) {
        lines.push(
          "",
          "[CONSISTENCY NOTE]",
          "A plan for this room exists from a prior angle. Reuse the SAME furniture types, colors, and materials from that plan. Adjust placement only to remain plausible from this camera angle."
        );
      }
    }
  }

  lines.push(
    "",
    "[SELF-CHECK BEFORE RETURNING – VERIFY EVERY ITEM]",
    "✓ COLOR PRESERVATION: Verify wall colors, floor tones, and lighting levels are PIXEL-PERFECT IDENTICAL to input (NO color shifts, NO lighting changes)",
    "✓ BRIGHTNESS CHECK: Input brightness = Output brightness (NO exposure adjustments applied)",
    "✓ WINDOW COUNT: Count windows in original image, verify EXACT SAME count in result (NO additions, NO removals)",
    "✓ DOOR COUNT: Count doors in original image, verify EXACT SAME count in result (NO additions, NO removals)",
    "✓ WINDOW POSITIONS: Verify each window is in EXACT SAME position as original (NO movement, NO repositioning)",
    "✓ DOOR POSITIONS: Verify each door is in EXACT SAME position as original (NO movement, NO repositioning)",
    "✓ All windows intact and 100% visible (including sliding glass doors)",
    "✓ All doors present and unobstructed (hinged, sliding, French, bifold - ALL types)",
    "✓ CURTAINS/BLINDS: Verify ALL window treatments remain 100% visible (NO removal, NO hiding, SAME color/style)",
    "✓ All fixed appliances present (fridge, oven, dishwasher, range hood - NOTHING removed)",
    "✓ All walls, ceilings, floors unchanged",
    "✓ All light fixtures present (ceiling lights, sconces, chandeliers)",
    "✓ All countertops, islands, backsplashes unmodified",
    "✓ Door swings and walk paths clear (≥80 cm)",
    "✓ Furniture scale, perspective, and shadows realistic",
    "✓ No camera view expansion or room size changes",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "⛔ FINAL REMINDER: PIXEL-PERFECT COLOR MATCHING REQUIRED ⛔",
    "Return the image with furniture/décor added ONLY.",
    "ALL pixels outside furniture areas MUST be IDENTICAL to input.",
    "Wall colors, floor tones, lighting = ZERO CHANGES.",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `[FLAGS] stage=staging_only sceneType=${activeScene} industry=${industry}`
  );

  return lines.join("\n");
}

// Legacy alias
export type { PromptOptions as ComplianceOpts };

export function parseJsonSafe<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); } catch { return fallback; }
}

export function parseBoolSafe(str: string | boolean, fallback: boolean): boolean {
  if (typeof str === "boolean") return str;
  if (typeof str === "string") {
    const lower = str.toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }
  return fallback;
}
