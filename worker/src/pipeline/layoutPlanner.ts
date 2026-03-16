import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { focusLog } from "../utils/logFocus";
import type { StructuralBaseline, WallIndex } from "../validators/openingPreservationValidator";

export type AnchorOrientation = "facing_camera" | "facing_anchor_wall";
export type AnchorItem = "bed" | "tv_unit" | "dining_table" | "sofa_group";

export type AnchorRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AnchorConstraints = {
  allowWallMount?: boolean;
  avoidAboveWindow?: boolean;
  avoidCoveringWindows?: boolean;
  mountMode?: "wall_mount" | "console_only" | "freestanding";
  rules?: string[];
};

export type DecorRestriction = {
  target: "anchor_wall" | "window_zone" | "door_zone" | "closet_zone";
  rule: string;
};

export type FurnitureVisibilityRules = {
  allow_crop?: boolean;
  assume_wall_continuation?: boolean;
  rules?: string[];
};

export type Stage2LayoutPlan = {
  room_type: string;
  layout: Array<{
    item: string;
    placement: string;
  }>;
  avoid_zones: string[];
  anchorItem?: AnchorItem;
  anchorWall?: string;
  anchorOrientation?: AnchorOrientation;
  anchorConstraints?: AnchorConstraints;
  anchorRegion?: AnchorRegion;
  anchorConfidence?: number;
  decorRestrictions?: DecorRestriction[];
  furnitureVisibilityRules?: FurnitureVisibilityRules;
};

const LAYOUT_PLANNER_PROMPT = `Analyze this empty room and produce a structured furniture layout plan suitable for real estate staging.

Return strict JSON with this shape:
{
  "room_type": string,
  "layout": [{ "item": string, "placement": string }],
  "avoid_zones": string[],
  "anchorItem": "bed" | "tv_unit" | "dining_table" | "sofa_group",
  "anchorWall": string,
  "anchorOrientation": "facing_camera" | "facing_anchor_wall",
  "anchorConstraints": {
    "allowWallMount": boolean,
    "avoidAboveWindow": boolean,
    "avoidCoveringWindows": boolean,
    "mountMode": "wall_mount" | "console_only" | "freestanding",
    "rules": string[]
  },
  "anchorRegion": { "x": number, "y": number, "width": number, "height": number },
  "anchorConfidence": number
}

Rules:
- For bedroom use bed anchor.
- For living room use tv_unit anchor.
- For dining room use dining_table anchor.
- AnchorRegion values must be normalized 0..1.
- If uncertain, still return layout with conservative anchorConfidence.`;

function normalizeText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text;
}

function normalizeAnchorItem(value: unknown): AnchorItem | undefined {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "bed") return "bed";
  if (normalized === "tv" || normalized === "tv_unit" || normalized === "television") return "tv_unit";
  if (normalized === "dining_table" || normalized === "table") return "dining_table";
  if (normalized === "sofa_group" || normalized === "sofa") return "sofa_group";
  return undefined;
}

function normalizeAnchorOrientation(value: unknown): AnchorOrientation | undefined {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "facing_camera") return "facing_camera";
  if (normalized === "facing_anchor_wall") return "facing_anchor_wall";
  return undefined;
}

function normalizeAnchorRegion(value: any): AnchorRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return undefined;
  if (width <= 0 || height <= 0) return undefined;

  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0.01, Math.min(1, width)),
    height: Math.max(0.01, Math.min(1, height)),
  };
}

function normalizeAnchorConstraints(value: any): AnchorConstraints | undefined {
  if (!value || typeof value !== "object") return undefined;

  const mountModeRaw = normalizeText(value.mountMode).toLowerCase();
  const mountMode = mountModeRaw === "wall_mount" || mountModeRaw === "console_only" || mountModeRaw === "freestanding"
    ? mountModeRaw
    : undefined;

  const rules = Array.isArray(value.rules)
    ? value.rules.map((entry: any) => normalizeText(entry)).filter((entry) => entry.length > 0)
    : undefined;

  const result: AnchorConstraints = {
    allowWallMount: typeof value.allowWallMount === "boolean" ? value.allowWallMount : undefined,
    avoidAboveWindow: typeof value.avoidAboveWindow === "boolean" ? value.avoidAboveWindow : undefined,
    avoidCoveringWindows: typeof value.avoidCoveringWindows === "boolean" ? value.avoidCoveringWindows : undefined,
    mountMode: mountMode as AnchorConstraints["mountMode"],
    rules,
  };

  return Object.values(result).some((entry) => entry !== undefined) ? result : undefined;
}

function inferAnchorItemFromRoomType(roomType: string): AnchorItem | undefined {
  const normalized = roomType.toLowerCase();
  if (normalized.includes("bed")) return "bed";
  if (normalized.includes("living")) return "tv_unit";
  if (normalized.includes("dining")) return "dining_table";
  return undefined;
}

function normalizeAnchorWall(value: unknown): string | undefined {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("north") || raw.includes("front") || raw === "0" || raw.includes("wall_0")) return "front_wall";
  if (raw.includes("east") || raw.includes("right") || raw === "1" || raw.includes("wall_1")) return "right_wall";
  if (raw.includes("south") || raw.includes("back") || raw === "2" || raw.includes("wall_2")) return "back_wall";
  if (raw.includes("west") || raw.includes("left") || raw === "3" || raw.includes("wall_3")) return "left_wall";
  return raw;
}

function anchorWallToIndex(anchorWall: string | undefined): WallIndex | null {
  if (!anchorWall) return null;
  if (anchorWall === "front_wall") return 0;
  if (anchorWall === "right_wall") return 1;
  if (anchorWall === "back_wall") return 2;
  if (anchorWall === "left_wall") return 3;
  return null;
}

function wallHasWindow(baseline: StructuralBaseline | undefined, wallIndex: WallIndex | null): boolean {
  if (!baseline || wallIndex === null) return false;
  return (baseline.openings || []).some((opening) => opening.wallIndex === wallIndex && opening.type === "window");
}

type WallSuitabilityClass = "ideal" | "conditional_window" | "disallowed";

type WallSuitability = {
  wallIndex: WallIndex;
  label: string;
  classification: WallSuitabilityClass;
  score: number;
  hasDoor: boolean;
  hasClosetDoor: boolean;
  windowCount: number;
  nonWindowOpenings: number;
  totalOpeningCoverage: number;
  hasMultipleInterferingOpenings: boolean;
};

function toNormalizedWallLabel(wallIndex: WallIndex): string {
  if (wallIndex === 0) return "front_wall";
  if (wallIndex === 1) return "right_wall";
  if (wallIndex === 2) return "back_wall";
  return "left_wall";
}

function normalizeRoomTypeKey(roomType: string): string {
  return normalizeText(roomType).toLowerCase().replace(/-/g, "_");
}

function resolveAnchorItemForRoom(roomType: string): AnchorItem {
  const normalized = normalizeRoomTypeKey(roomType);
  if (normalized.includes("bed")) return "bed";
  if (normalized.includes("living")) return "tv_unit";
  if (normalized.includes("dining")) return "dining_table";
  return "sofa_group";
}

function bboxCoverage(bbox: [number, number, number, number] | undefined): number {
  if (!bbox || bbox.length !== 4) return 0;
  const x1 = Math.max(0, Math.min(1, Number(bbox[0])));
  const x2 = Math.max(0, Math.min(1, Number(bbox[2])));
  if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) return 0;
  return x2 - x1;
}

function buildWallSuitability(baseline: StructuralBaseline): WallSuitability[] {
  const byWall = new Map<WallIndex, StructuralBaseline["openings"]>();
  (baseline.openings || []).forEach((opening) => {
    const wall = opening.wallIndex;
    const existing = byWall.get(wall) || [];
    existing.push(opening);
    byWall.set(wall, existing);
  });

  const allWalls: WallIndex[] = [0, 1, 2, 3];
  return allWalls.map((wallIndex) => {
    const openings = byWall.get(wallIndex) || [];
    const hasDoor = openings.some((opening) => opening.type === "door" || opening.type === "walkthrough");
    const hasClosetDoor = openings.some((opening) => opening.type === "closet_door");
    const windowCount = openings.filter((opening) => opening.type === "window").length;
    const nonWindowOpenings = openings.filter((opening) => opening.type !== "window").length;
    const totalOpeningCoverage = openings.reduce((acc, opening) => acc + bboxCoverage(opening.bbox), 0);
    const hasMultipleInterferingOpenings = openings.length >= 2 && totalOpeningCoverage >= 0.55;

    let classification: WallSuitabilityClass = "ideal";
    if (hasDoor || hasClosetDoor || hasMultipleInterferingOpenings) {
      classification = "disallowed";
    } else if (windowCount > 0) {
      classification = "conditional_window";
    }

    let score = 100;
    if (classification === "disallowed") score = -1000;
    else if (classification === "conditional_window") score = 70;

    score -= Math.round(totalOpeningCoverage * 30);
    score -= openings.length * 5;

    return {
      wallIndex,
      label: toNormalizedWallLabel(wallIndex),
      classification,
      score,
      hasDoor,
      hasClosetDoor,
      windowCount,
      nonWindowOpenings,
      totalOpeningCoverage,
      hasMultipleInterferingOpenings,
    };
  });
}

function buildAnchorRegionForWall(anchorWall: WallIndex, opts?: { preferLowerHalf?: boolean }): AnchorRegion {
  const preferLowerHalf = opts?.preferLowerHalf === true;
  if (anchorWall === 0 || anchorWall === 2) {
    return {
      x: 0.2,
      y: preferLowerHalf ? 0.55 : 0.5,
      width: 0.6,
      height: 0.38,
    };
  }

  if (anchorWall === 1) {
    return {
      x: 0.56,
      y: preferLowerHalf ? 0.56 : 0.5,
      width: 0.4,
      height: 0.38,
    };
  }

  return {
    x: 0.04,
    y: preferLowerHalf ? 0.56 : 0.5,
    width: 0.4,
    height: 0.38,
  };
}

function openingToAvoidZone(opening: StructuralBaseline["openings"][number]): string {
  const [x1, y1, x2, y2] = opening.bbox || [0, 0, 0, 0];
  const kind = opening.type === "closet_door" ? "closet" : opening.type;
  return `${kind}:${opening.id}:bbox(${x1.toFixed(3)},${y1.toFixed(3)},${x2.toFixed(3)},${y2.toFixed(3)})`;
}

function buildBaseLayoutItems(anchorItem: AnchorItem, roomType: string): Stage2LayoutPlan["layout"] {
  const normalized = normalizeRoomTypeKey(roomType);

  if (anchorItem === "bed") {
    return [
      { item: "bed", placement: "Place the bed with headboard aligned to anchor wall and keep opening paths clear." },
      { item: "nightstand", placement: "Add up to one compact bedside table where circulation remains clear." },
    ];
  }

  if (anchorItem === "tv_unit") {
    return [
      { item: "tv_unit", placement: "Place a freestanding media console centered on anchor wall." },
      { item: "sofa", placement: "Orient sofa seating toward the TV anchor while preserving door and opening clearance." },
    ];
  }

  if (anchorItem === "dining_table") {
    return [
      { item: "dining_table", placement: "Center dining table in usable floor area with clear access around doors/openings." },
      { item: "dining_chairs", placement: "Add chairs only where pullback clearance does not overlap openings." },
    ];
  }

  if (normalized.includes("living")) {
    return [
      { item: "sofa", placement: "Anchor main sofa to selected wall while keeping structural openings accessible." },
      { item: "coffee_table", placement: "Center compact coffee table within seating area and clear circulation." },
    ];
  }

  return [
    { item: "sofa", placement: "Place primary seating at anchor wall with clear opening circulation." },
  ];
}

function buildDeterministicLayoutPlan(opts: {
  roomType?: string;
  structuralBaseline: StructuralBaseline;
}): Stage2LayoutPlan {
  const roomType = normalizeText(opts.roomType || "unknown") || "unknown";
  const anchorItem = resolveAnchorItemForRoom(roomType);
  const suitability = buildWallSuitability(opts.structuralBaseline);

  const idealWalls = suitability.filter((wall) => wall.classification === "ideal").sort((a, b) => b.score - a.score);
  const conditionalWalls = suitability.filter((wall) => wall.classification === "conditional_window").sort((a, b) => b.score - a.score);
  const fallbackWalls = [...suitability].sort((a, b) => b.score - a.score);

  const selected = idealWalls[0] || conditionalWalls[0] || fallbackWalls[0];
  const anchorWall = selected?.label || "front_wall";
  const selectedWallIndex = (anchorWallToIndex(anchorWall) ?? 0) as WallIndex;

  const usingFallback = !idealWalls[0] && !conditionalWalls[0];
  const usingWindowWall = selected?.classification === "conditional_window";
  const anchorConstraints: AnchorConstraints = {
    mountMode: anchorItem === "tv_unit" && usingWindowWall ? "console_only" : "freestanding",
    allowWallMount: !(anchorItem === "tv_unit" && usingWindowWall),
    avoidCoveringWindows: usingWindowWall || anchorItem === "tv_unit",
    avoidAboveWindow: anchorItem === "bed" && usingWindowWall,
    rules: [],
  };

  const decorRestrictions: DecorRestriction[] = [
    {
      target: "door_zone",
      rule: "Do not place furniture or decor that blocks any door/walkthrough opening.",
    },
    {
      target: "closet_zone",
      rule: "Do not block closet doors and do not place wall art/decor above closet-door regions.",
    },
  ];

  if (usingWindowWall) {
    decorRestrictions.push({
      target: "window_zone",
      rule: "Preserve full window visibility and avoid decor above the anchor where it would overlap window area.",
    });
  }

  if (anchorItem === "bed") {
    anchorConstraints.rules?.push("Headboard must align to anchor wall plane.");
    if (usingWindowWall) {
      anchorConstraints.rules?.push("Use low-profile headboard and keep visible window frame/sill unchanged.");
      anchorConstraints.rules?.push("No artwork above headboard when anchored on a window wall.");
    }
  }

  if (anchorItem === "tv_unit") {
    anchorConstraints.rules?.push("Seating must face the TV/media anchor.");
    if (usingWindowWall) {
      anchorConstraints.rules?.push("TV must remain console-based only; no wall-mounted TV on window wall.");
    }
  }

  if (usingFallback) {
    anchorConstraints.rules?.push("Fallback wall mode: assume wall continuation beyond frame edges when needed.");
  }

  const furnitureVisibilityRules: FurnitureVisibilityRules = {
    allow_crop: true,
    assume_wall_continuation: usingFallback || selectedWallIndex === 1 || selectedWallIndex === 3,
    rules: [
      "Furniture may extend beyond frame boundaries when composition is natural.",
      "Do not force the full anchor furniture item to be visible.",
    ],
  };

  const anchorRegion = buildAnchorRegionForWall(selectedWallIndex, {
    preferLowerHalf: anchorItem === "bed" && usingWindowWall,
  });

  const avoidZones = (opts.structuralBaseline.openings || []).map(openingToAvoidZone);

  return {
    room_type: roomType,
    layout: buildBaseLayoutItems(anchorItem, roomType),
    avoid_zones: avoidZones,
    anchorItem,
    anchorWall,
    anchorOrientation: "facing_anchor_wall",
    anchorConstraints,
    anchorRegion,
    anchorConfidence: 0.98,
    decorRestrictions,
    furnitureVisibilityRules,
  };
}

function applyAnchorDeterministicGuards(plan: Stage2LayoutPlan, opts?: {
  roomType?: string;
  structuralBaseline?: StructuralBaseline | null;
  anchorConfidenceThreshold?: number;
}): Stage2LayoutPlan {
  const roomType = normalizeText(opts?.roomType || plan.room_type || "").toLowerCase();
  const anchorConfidenceThreshold = Number.isFinite(Number(opts?.anchorConfidenceThreshold))
    ? Math.max(0, Math.min(1, Number(opts?.anchorConfidenceThreshold)))
    : 0.7;

  const normalizedPlan: Stage2LayoutPlan = {
    ...plan,
    anchorItem: normalizeAnchorItem(plan.anchorItem) || inferAnchorItemFromRoomType(roomType),
    anchorWall: normalizeAnchorWall(plan.anchorWall),
    anchorOrientation: normalizeAnchorOrientation(plan.anchorOrientation),
    anchorConstraints: normalizeAnchorConstraints(plan.anchorConstraints),
    anchorRegion: normalizeAnchorRegion(plan.anchorRegion),
    anchorConfidence: Number.isFinite(Number(plan.anchorConfidence))
      ? Math.max(0, Math.min(1, Number(plan.anchorConfidence)))
      : 0,
  };

  if (!normalizedPlan.anchorItem || (normalizedPlan.anchorConfidence || 0) < anchorConfidenceThreshold) {
    delete normalizedPlan.anchorItem;
    delete normalizedPlan.anchorWall;
    delete normalizedPlan.anchorOrientation;
    delete normalizedPlan.anchorConstraints;
    delete normalizedPlan.anchorRegion;
    delete normalizedPlan.anchorConfidence;
    return normalizedPlan;
  }

  const wallIndex = anchorWallToIndex(normalizedPlan.anchorWall);
  const hasWindowOnAnchorWall = wallHasWindow(opts?.structuralBaseline || undefined, wallIndex);
  const constraints: AnchorConstraints = {
    ...(normalizedPlan.anchorConstraints || {}),
  };
  const rules = Array.isArray(constraints.rules) ? [...constraints.rules] : [];

  if (normalizedPlan.anchorItem === "tv_unit" && hasWindowOnAnchorWall) {
    constraints.mountMode = "console_only";
    constraints.allowWallMount = false;
    constraints.avoidCoveringWindows = true;
    rules.push("Do not mount TV on window wall.");
  }

  if (normalizedPlan.anchorItem === "bed" && hasWindowOnAnchorWall) {
    constraints.avoidAboveWindow = true;
    rules.push("Do not place headboard over windows.");
  }

  constraints.rules = rules.filter((value, idx) => rules.indexOf(value) === idx);
  normalizedPlan.anchorConstraints = constraints;
  return normalizedPlan;
}

function normalizeLayoutPlan(input: any): Stage2LayoutPlan | null {
  if (!input || typeof input !== "object") return null;

  const roomType = normalizeText(input.room_type);
  const layoutRaw = Array.isArray(input.layout) ? input.layout : [];
  const avoidZonesRaw = Array.isArray(input.avoid_zones) ? input.avoid_zones : [];

  const layout = layoutRaw
    .map((entry: any) => ({
      item: normalizeText(entry?.item),
      placement: normalizeText(entry?.placement),
    }))
    .filter((entry) => entry.item.length > 0 && entry.placement.length > 0);

  const avoidZones = avoidZonesRaw
    .map((entry: any) => normalizeText(entry))
    .filter((entry) => entry.length > 0);

  if (!roomType || layout.length === 0) return null;

  const decorRestrictions = Array.isArray(input.decorRestrictions)
    ? input.decorRestrictions
      .map((entry: any) => ({
        target: normalizeText(entry?.target) as DecorRestriction["target"],
        rule: normalizeText(entry?.rule),
      }))
      .filter((entry: DecorRestriction) => entry.target.length > 0 && entry.rule.length > 0)
    : undefined;

  const furnitureVisibilityRules = input.furnitureVisibilityRules && typeof input.furnitureVisibilityRules === "object"
    ? {
      allow_crop: typeof input.furnitureVisibilityRules.allow_crop === "boolean"
        ? input.furnitureVisibilityRules.allow_crop
        : undefined,
      assume_wall_continuation: typeof input.furnitureVisibilityRules.assume_wall_continuation === "boolean"
        ? input.furnitureVisibilityRules.assume_wall_continuation
        : undefined,
      rules: Array.isArray(input.furnitureVisibilityRules.rules)
        ? input.furnitureVisibilityRules.rules
          .map((entry: any) => normalizeText(entry))
          .filter((entry: string) => entry.length > 0)
        : undefined,
    }
    : undefined;

  return {
    room_type: roomType,
    layout,
    avoid_zones: avoidZones,
    anchorItem: normalizeAnchorItem(input.anchorItem),
    anchorWall: normalizeAnchorWall(input.anchorWall),
    anchorOrientation: normalizeAnchorOrientation(input.anchorOrientation),
    anchorConstraints: normalizeAnchorConstraints(input.anchorConstraints),
    anchorRegion: normalizeAnchorRegion(input.anchorRegion),
    anchorConfidence: Number.isFinite(Number(input.anchorConfidence))
      ? Math.max(0, Math.min(1, Number(input.anchorConfidence)))
      : undefined,
    decorRestrictions,
    furnitureVisibilityRules,
  };
}

export async function planStage2Layout(
  imagePath: string,
  opts?: {
    jobId?: string;
    roomType?: string;
    anchorPlannerEnabled?: boolean;
    structuralBaseline?: StructuralBaseline | null;
    anchorConfidenceThreshold?: number;
    useGeminiFallback?: boolean;
  }
): Promise<Stage2LayoutPlan | null> {
  const startedAt = Date.now();

  const deterministicEnabled = opts?.anchorPlannerEnabled === true;
  const useGeminiFallback = opts?.useGeminiFallback !== false;

  if (deterministicEnabled && opts?.structuralBaseline?.openings?.length) {
    const wallSuitability = buildWallSuitability(opts.structuralBaseline);
    const deterministicPlan = buildDeterministicLayoutPlan({
      roomType: opts?.roomType,
      structuralBaseline: opts.structuralBaseline,
    });
    const selectedWallIndex = anchorWallToIndex(deterministicPlan.anchorWall);

    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] deterministic plan ready", {
      jobId: opts?.jobId,
      elapsedMs: Date.now() - startedAt,
      roomType: deterministicPlan.room_type,
      layoutItems: deterministicPlan.layout.length,
      avoidZones: deterministicPlan.avoid_zones.length,
      anchorItem: deterministicPlan.anchorItem || null,
      anchorWall: deterministicPlan.anchorWall || null,
      anchorOrientation: deterministicPlan.anchorOrientation || null,
    });

    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] deterministic wall suitability", {
      jobId: opts?.jobId,
      roomType: deterministicPlan.room_type,
      anchorItem: deterministicPlan.anchorItem || null,
      selectedAnchorWall: deterministicPlan.anchorWall || null,
      selectedWallIndex,
      fallbackMode: wallSuitability.every((wall) => wall.classification === "disallowed"),
      hasWindowWallFallback: wallSuitability.some((wall) => wall.classification === "conditional_window") &&
        !wallSuitability.some((wall) => wall.classification === "ideal"),
      walls: wallSuitability.map((wall) => ({
        wallIndex: wall.wallIndex,
        wall: wall.label,
        classification: wall.classification,
        score: wall.score,
        hasDoor: wall.hasDoor,
        hasClosetDoor: wall.hasClosetDoor,
        windowCount: wall.windowCount,
        nonWindowOpenings: wall.nonWindowOpenings,
        openingCoverage: Number(wall.totalOpeningCoverage.toFixed(3)),
        multiOpeningInterference: wall.hasMultipleInterferingOpenings,
      })),
    });

    return deterministicPlan;
  }

  if (!useGeminiFallback) {
    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] deterministic planner unavailable and Gemini fallback disabled", {
      jobId: opts?.jobId,
      elapsedMs: Date.now() - startedAt,
      hasBaseline: Boolean(opts?.structuralBaseline),
      openings: opts?.structuralBaseline?.openings?.length || 0,
    });
    return null;
  }

  try {
    const ai = getGeminiClient();
    if (!ai) return null;

    const { data, mime } = toBase64(imagePath);
    const model = (ai as any).getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        topK: 20,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    });

    const response = await model.generateContent([
      {
        inlineData: {
          mimeType: mime,
          data,
        },
      },
      { text: LAYOUT_PLANNER_PROMPT },
    ]);

    const text = response?.response?.text?.();
    if (!text) {
      focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] empty response", {
        jobId: opts?.jobId,
        elapsedMs: Date.now() - startedAt,
      });
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] non-JSON response", {
        jobId: opts?.jobId,
        elapsedMs: Date.now() - startedAt,
      });
      return null;
    }

    const normalized = normalizeLayoutPlan(parsed);
    if (!normalized) {
      focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] invalid layout plan", {
        jobId: opts?.jobId,
        elapsedMs: Date.now() - startedAt,
      });
      return null;
    }

    const resolvedPlan = opts?.anchorPlannerEnabled
      ? applyAnchorDeterministicGuards(normalized, {
          roomType: opts?.roomType,
          structuralBaseline: opts?.structuralBaseline,
          anchorConfidenceThreshold: opts?.anchorConfidenceThreshold,
        })
      : normalized;

    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] plan ready", {
      jobId: opts?.jobId,
      elapsedMs: Date.now() - startedAt,
      roomType: resolvedPlan.room_type,
      layoutItems: resolvedPlan.layout.length,
      avoidZones: resolvedPlan.avoid_zones.length,
      anchorItem: resolvedPlan.anchorItem || null,
      anchorWall: resolvedPlan.anchorWall || null,
      anchorOrientation: resolvedPlan.anchorOrientation || null,
    });

    return resolvedPlan;
  } catch (error: any) {
    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] failed", {
      jobId: opts?.jobId,
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    return null;
  }
}

export function formatStage2LayoutPlanForPrompt(plan: Stage2LayoutPlan): string {
  const anchorDirective = plan.anchorItem
    ? [
        "ANCHOR DIRECTIVE (MANDATORY):",
        `- Primary focal element: ${plan.anchorItem}`,
        plan.anchorWall ? `- Anchor wall: ${plan.anchorWall}` : null,
        plan.anchorOrientation ? `- Anchor orientation: ${plan.anchorOrientation}` : null,
        plan.anchorConstraints?.mountMode ? `- Placement mode: ${plan.anchorConstraints.mountMode}` : null,
        plan.anchorConstraints?.avoidCoveringWindows === true ? "- Do not cover windows on or near anchor wall." : null,
        plan.anchorConstraints?.avoidAboveWindow === true ? "- Do not place this anchor over any window." : null,
        plan.furnitureVisibilityRules?.allow_crop === true ? "- Anchor furniture may be partially cropped by frame edges when composition is natural." : null,
        plan.furnitureVisibilityRules?.assume_wall_continuation === true ? "- Assume anchor wall continues beyond visible frame edges." : null,
      ].filter((line): line is string => Boolean(line)).join("\n")
    : "";

  const serialized = JSON.stringify(
    {
      room_type: plan.room_type,
      layout: plan.layout,
      avoid_zones: plan.avoid_zones,
      anchor: plan.anchorItem
        ? {
            item: plan.anchorItem,
            wall: plan.anchorWall,
            orientation: plan.anchorOrientation,
            constraints: plan.anchorConstraints,
            region: plan.anchorRegion,
            confidence: plan.anchorConfidence,
          }
        : undefined,
      decorRestrictions: plan.decorRestrictions,
      furnitureVisibilityRules: plan.furnitureVisibilityRules,
    },
    null,
    2
  );

  if (!anchorDirective) {
    return serialized;
  }

  return `${anchorDirective}\n\nPLAN_JSON:\n${serialized}`;
}
