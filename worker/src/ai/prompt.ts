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

  // Stage 2 selection helpers
  stagingPreference?: "refresh" | "full";
  stage1BRan?: boolean;
};

function bool(v: unknown): "true" | "false" {
  return v ? "true" : "false";
}

function getDeclutterInstructions(level: "light" | "standard" | "heavy"): string[] {
  const fixtureProtection = [
    "DO NOT REMOVE OR ALTER FIXED FIXTURES OR UTILITIES:",
    "- Plumbing: taps/faucets/spouts, sinks/basins, shower heads, drains",
    "- Electrical: plug points/outlets, switches, wall plates, breakers, visible wiring",
    "- Lighting: ALL fixed light fittings (pendants, sconces, downlights), ceiling fans",
    "- HVAC/Utilities: heat pump/AC units (indoor wall units and outdoor condensers), vents/grilles, thermostats",
    "- Exterior fixed equipment: outdoor taps/spigots, meters/utility boxes, mounted hose reels, exterior lighting",
    "- Built-ins: built-in appliances (cooktops, ovens, rangehoods, dishwashers), built-in cabinetry/wardrobes",
    "- Architecture: doors/windows/frames/tracks, flooring, walls, ceilings, room geometry",
    "If unsure whether something is fixed or movable, assume it is FIXED and leave it unchanged.",
  ];

  if (level === "light") {
    return [
      "DECLUTTER INTENSITY: LIGHT – remove only obvious items (bins, hoses, visible trash). Minimize other edits.",
      ...fixtureProtection,
    ];
  }
  if (level === "heavy") {
    return [
      "DECLUTTER INTENSITY: HEAVY (COMPLETE ROOM CLEARING) – remove ALL movable furniture and items to create a completely empty room.",
      "REMOVE: ALL furniture (sofas, chairs, beds, tables, dressers, nightstands, desks, bookcases, wardrobes, shelving units, entertainment centers, consoles), ALL rugs, ALL lamps (portable only), ALL wall art (paintings, frames, mirrors, decorations), ALL decorative items (vases, plants, sculptures, candles, ornaments). REMOVE ONLY PORTABLE / MOVABLE APPLIANCES AND COUNTERTOP ITEMS (e.g., kettles, toasters, freestanding microwaves, coffee machines, loose fans/heaters, small countertop devices). KEEP ALL BUILT-IN / FIXED APPLIANCES AND FIXED EQUIPMENT (e.g., cooktops, ovens, rangehoods, dishwashers, heat pumps/AC units, wall-mounted heaters).",
      "KEEP ONLY: built-in stoves, countertops, cabinets, built-in shelving, recessed lighting, ceiling fans, window frames, door frames, baseboards, crown molding, fireplaces, mantels, ALL curtains, ALL blinds, ALL window treatments (MUST remain 100% visible and unchanged).",
      "GOAL: Produce a completely empty room with bare walls and floors, preserving ONLY fixed architectural elements, built-in stoves, and ALL window treatments (curtains/blinds).",
      ...fixtureProtection,
    ];
  }
  return [
    "DECLUTTER INTENSITY: STANDARD – remove priority items and tidy visible clutter without over-editing.",
    ...fixtureProtection,
  ];
}

// Added to reduce fixture changes and unsafe placements in Stage 2 staging; prompt-only mitigation.
const STAGE2_SAFETY_RULES_APPENDIX = `IMPORTANT STAGING SAFETY RULES (MUST FOLLOW):
- Do NOT modify, replace, remove, or reinterpret any fixed fixtures or finishes. Only add removable furniture and décor.
  Fixed fixtures/finishes include (but are not limited to): faucets, sinks, taps, cooktops (gas/electric), ovens, rangehoods,
  light fittings, switches, ceiling fans, built-in cabinetry, wardrobes/closets, doors, windows, frames, tracks,
  flooring materials, wall/ceiling structure, and room geometry.
- Any change to fixed fixtures/finishes is forbidden.

FURNITURE PLACEMENT RULES:
- Furniture that normally sits against a wall (e.g., TV units + TVs, dressers/chests of drawers, wardrobes, desks,
  dressing tables, sideboards/buffets) must ONLY be placed when a full, continuous wall surface is clearly visible
  in the source image where the item will go.
- If wall continuity OR clearance cannot be confidently verified from the image, do NOT place wall-dependent furniture in that area.
- Never block or partially obstruct doors, door swing paths, closet doors, windows, or walkways/circulation paths.

BEDROOM CAUTION:
- Bedrooms are high-risk. Assume closet doors or entry doors may exist outside the visible frame.
- Be conservative in bedrooms: prefer minimal staging (bed, rug, lamps, light décor) over dense layouts.
- Avoid placing dressers/drawers unless the wall is clearly visible and the placement is unquestionably clear.

NO PERSPECTIVE / VISIBILITY CHEATING:
- Do NOT change camera angle, perspective, framing, crop, or architectural visibility to accommodate furniture.
- Do NOT hide/remove architectural elements to justify placement.

STYLE:
- Favor safe, neutral, MLS-appropriate staging over dramatic or “wow” staging.
- If uncertain, stage less rather than risk obstruction or unrealistic placement.`;

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

  const stage1BRan = Boolean(opts.stage1BRan);
  const stagingMode: "refresh" | "full" = stage1BRan
    ? "refresh"
    : opts.stagingPreference === "refresh"
      ? "refresh"
      : "full";

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
      : "Identify the SINGLE most practical use for this room based on its layout, features, and size. Stage it accordingly as one unified space (bedroom/living/dining/office/kitchen).",
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
  const prompt = `You are a professional real-estate photo editor.

[INPUT]
You will be provided with a real estate photograph (interior or exterior).

[OUTPUT]
Return the edited image only.

[STAGE]
Stage 1A – Photo Quality Enhancement Only

[GOAL]
Improve overall image quality for real estate marketing while preserving the exact original scene with ZERO scene changes.

[CAPABILITIES]
preserveStructure=true
allowStaging=false
allowRetouch=true
declutterLevel=none
furnitureReplacementMode=false

[ABSOLUTE STRUCTURAL PRESERVATION – OVERRIDES ALL ELSE]
The original scene, layout, architecture, objects, furniture, fixtures, and contents MUST remain EXACTLY the same.
DO NOT add, remove, move, resize, replace, hide, or hallucinate ANY object.
DO NOT change camera view, framing, angle, perspective, or geometry.

If ANY uncertainty exists about whether a change alters the scene, OMIT the change.

[ALLOWED ACTIONS – PHOTO QUALITY ONLY]
✓ Exposure balancing (natural, subtle)
✓ White balance correction (neutral, realistic)
✓ Contrast and tonal balance (no crushed blacks or blown highlights)
✓ Minor vertical straightening ONLY (no perspective warping)
✓ Subtle sharpening (no halos, no edge glow)
✓ Noise reduction (preserve texture and fine detail)

[NOT ALLOWED]
✗ Decluttering
✗ Object removal or addition
✗ Furniture changes
✗ Surface or material changes
✗ Any staging or layout edits
✗ Over-processed or HDR appearance

[FALLBACK RULE]
If any enhancement risks altering the scene or realism, revert to the original image and apply NO changes.

[OUTPUT GOAL]
A cleaner, brighter, professionally polished version of the SAME image with identical contents and geometry.`;

  return prompt;
}

/**
 * Stage 1b: Furniture/Decor Removal (runs after quality enhancement when furniture replacement is enabled)
 * Focus: Complete removal of ALL furniture, decor, and clutter to create empty room
 * Cost: Included in Stage 1 (no additional cost)
 */
export function buildRemovalPrompt(opts: PromptOptions): string {
  const { sceneType = "auto", resolvedScene, goal } = opts;

  const activeScene: "interior" | "exterior" =
    resolvedScene ??
    (sceneType === "exterior" ? "exterior"
      : sceneType === "interior" ? "interior"
      : autoSceneFromGoal(goal));

  if (activeScene !== "interior") {
    throw new Error("Stage 1B prompt is only supported for interior scenes");
  }

  const prompt = `You are a professional real-estate photo editor.

[INPUT]
You will be provided with a real estate photograph of an OCCUPIED interior room.

[OUTPUT]
Return the edited image only.

[STAGE]
Stage 1B – Light Declutter + Photo Polish

[GOAL]
Lightly declutter an occupied room for real estate marketing while preserving all structure and ALL furniture placement.

[CAPABILITIES]
preserveStructure=true
allowStaging=false
allowRetouch=true
declutterLevel=light
furnitureReplacementMode=false
sceneType=interior

[ABSOLUTE STRUCTURAL PRESERVATION – OVERRIDES ALL ELSE]
Camera view, perspective, framing, walls, doors, windows, fixtures, built-ins, appliances, and furniture placement are LOCKED.
DO NOT alter architecture, layout, room size perception, or geometry.
DO NOT add new objects or rearrange existing furniture.

If unsure whether an item is fixed or removable, ASSUME IT IS FIXED and do not alter it.
If unsure whether removing an item would reduce realism or make the room feel barren, leave it.

[DECLUTTER – LIGHT ONLY]
Remove ONLY obvious, temporary, low-risk personal clutter. Minimize edits. Prefer leaving borderline items.

REMOVE (only if clearly temporary and easily movable):
• Bins / laundry hampers
• Trash bags or visible rubbish
• Loose packaging or empty containers
• Laundry piles or scattered clothing
• Small scattered toys
• Floor cables ONLY if clearly not fixed or installed
• Excess countertop clutter (loose toiletries, mail piles, dirty dishes)
• Personal hygiene items (toothbrushes, razors)
• Pet bowls or temporary pet bedding

KEEP (ALWAYS – DO NOT REMOVE OR MOVE):
• ALL furniture
• ALL rugs
• ALL lamps and light fixtures
• ALL wall art, mirrors, décor, plants
• ALL curtains, blinds, drapes
• ALL appliances
• ALL built-ins, cabinetry, counters, shelves, fireplaces

QUALITY REQUIREMENTS
• Traceless removal only (no smears, ghosting, missing shadows, or warped textures)
• Preserve lighting consistency and surface realism

[PHOTO QUALITY – ALWAYS APPLY]
✓ Exposure balancing
✓ White balance correction
✓ Subtle sharpening
✓ Noise reduction

[FALLBACK RULE]
If decluttering is ambiguous or risky, OMIT declutter and apply photo polish only.

[OUTPUT GOAL]
A slightly tidier but clearly lived-in room with identical furniture, structure, and layout.`;

  return prompt;
}

export function buildStagingOnlyPrompt(opts: PromptOptions): string {
  const stage1BRan = Boolean(opts.stage1BRan);
  const stagingMode: "refresh" | "full" = stage1BRan
    ? "refresh"
    : opts.stagingPreference === "refresh"
      ? "refresh"
      : "full";

  const promptStage2A = `You are a professional real-estate photo editor specializing in light virtual staging.

  [INPUT]
  You will be provided with a real estate photograph of an interior room.

  [OUTPUT]
  Return the edited image only.

  [STAGE]
  Stage 2A – Refresh Staging (Décor Only)

  [GOAL]
  Gently refresh the room using minimal décor additions while preserving all existing furniture, layout, and structure.

  [CAPABILITIES]
  preserveStructure=true
  allowStaging=true
  allowRetouch=true
  declutterLevel=standard
  furnitureReplacementMode=false
  sceneType=interior

  [STYLE]
  neutral_scandinavian  
  Color palette: white, soft grey, natural wood, muted textiles  
  Overall look: subtle, clean, and welcoming (never decorative-heavy)

  [ABSOLUTE STRUCTURAL PRESERVATION – OVERRIDES ALL ELSE]
  Camera view, framing, walls, doors, windows, furniture size, and furniture position are LOCKED.
  DO NOT change layout, room function, or introduce new zones.

  If unsure whether an action affects structure, layout, or realism, OMIT it.

  [ALLOWED DÉCOR – WHITELIST ONLY]
  ✓ Rugs  
  ✓ Plants  
  ✓ Table lamps  
  ✓ Floor lamps  
  ✓ Small side tables  
  ✓ Wall art (FRAMED PRINTS ONLY – no mirrors, clocks, shelves)

  Guideline: Aim for 1–3 décor additions TOTAL. Fewer is preferred.

  [NOT ALLOWED]
  ✗ Beds, sofas, dining tables, desks
  ✗ Large furniture or furniture replacement
  ✗ Mirrors, shelving, clocks
  ✗ Décor that changes room function

  [DÉCOR PLACEMENT CONSTRAINTS]
  • Do NOT block doors, walkways, or circulation
  • Do NOT cover windows or frames
  • Do NOT overlap or clip existing objects
  • Maintain realistic scale and grounded placement

  [DECLUTTER]
  Perform a standard tidy only. Do not sterilize the room.

  [PHOTO QUALITY – ALWAYS APPLY]
  ✓ Exposure balancing
  ✓ White balance correction
  ✓ Subtle sharpening
  ✓ Noise reduction

  [FALLBACK RULE]
  If a décor item violates rules, omit that item.
  If ALL décor is blocked, revert to Stage 1B output (declutter + polish only).

  [OUTPUT GOAL]
  A subtly refreshed room with original furniture intact and minimal, tasteful styling.`;

  const promptStage2B = `You are a professional real-estate photo editor specializing in full virtual staging.

  [INPUT]
  You will be provided with a real estate photograph of an interior room.

  [OUTPUT]
  Return the edited image only.

  [STAGE]
  Stage 2B – Full Virtual Staging

  [GOAL]
  Fully stage the room to clearly demonstrate its most likely practical use for real estate marketing while preserving strict structural realism.

  [CAPABILITIES]
  preserveStructure=true
  allowStaging=true
  allowRetouch=true
  declutterLevel=heavy
  furnitureReplacementMode=true
  sceneType=interior

  [STYLE]
  neutral_scandinavian  
  Modern, clean, realistic, neutral real-estate staging  
  Avoid ornate, antique, bold, or personalized styles

  [ABSOLUTE STRUCTURAL PRESERVATION – OVERRIDES ALL ELSE]
  Camera view, framing, walls, doors, windows, and geometry are LOCKED.
  DO NOT alter architecture, expand space, or invent openings or structures.

  If unsure whether an action affects structure or realism, OMIT it.

  [ROOM FUNCTION]
  Determine ONE most likely practical function (living, bedroom, dining, office).
  Stage ONLY for that function.
  If ambiguous, choose the function requiring the fewest assumptions and least furniture.

  [FURNITURE & PLACEMENT RULES]
  • Scale must match room size
  • No floating furniture
  • Maintain ≥80 cm clear walkways
  • Windows ≥95% visible
  • Do NOT block doors or circulation
  • Preserve natural flow and usability

  AVOID:
  • Oversized furniture
  • Ornate or antique styles
  • Unrealistic or crowded layouts

  [STAGING LADDER – DESCEND IF BLOCKED]
  Always attempt the highest level first. Once descending, do NOT attempt higher levels again.

  1) Full staging with compliant furniture and décor  
  2) Reduced furniture set (essential items only)  
  3) Décor-only staging  
  4) Declutter + photo polish only  

  Item-level rule:
  • If a single item violates rules → OMIT that item only.
  • If a level cannot be completed safely → descend.

  [DECLUTTER]
  Perform heavy declutter before staging.
  Remove personal clutter while preserving realism.
  Do not remove fixed or built-in elements.

  [PHOTO QUALITY – ALWAYS APPLY]
  ✓ Exposure balancing
  ✓ White balance correction
  ✓ Subtle sharpening
  ✓ Noise reduction

  [FALLBACK RULE]
  If all staging levels are blocked, return a clean, decluttered, photo-polished empty room.

  [OUTPUT GOAL]
  A fully staged, realistic, structurally sound room clearly communicating its intended function.`;

  return stagingMode === "refresh" ? promptStage2A : promptStage2B;
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
