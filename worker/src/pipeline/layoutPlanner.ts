import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { focusLog } from "../utils/logFocus";
import type { AnchorFixture, AnchorFixtureType, StructuralBaseline, WallCoverageBand, WallIndex } from "../validators/openingPreservationValidator";

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
  target: "anchor_wall" | "window_zone" | "door_zone" | "closet_zone" | "fixture_zone";
  rule: string;
};

export type FixturePreservationDirective = {
  fixtureId: string;
  type: AnchorFixtureType;
  wallLabel: string;
  directive: string;
};

export type FurnitureVisibilityRules = {
  allow_crop?: boolean;
  assume_wall_continuation?: boolean;
  rules?: string[];
};

export type SecondaryMediaWall = {
  available: boolean;
  wallIndex?: WallIndex;
  wallLabel?: string;
  mountMode?: "wall_mount" | "console_only" | "freestanding";
};

/**
 * The functional role a wall plays in the deterministic room plan — used to
 * label WallPlanEntry.role and drive its default allowed/forbidden set.
 * Precedence when multiple would apply: protected_architecture >
 * avoid_circulation > anchor > secondary_media > neutral (see
 * buildWallPlanEntries — allowed/forbidden still accumulate contributions
 * from every applicable category regardless of which role wins the label).
 */
export type WallRole = "anchor" | "secondary_media" | "protected_architecture" | "avoid_circulation" | "neutral";

export type WallPlanEntry = {
  wallIndex: WallIndex;
  label: string;
  hasWindow: boolean;
  hasDoor: boolean;
  architecture: Array<{ id: string; type: AnchorFixtureType }>;
  role: WallRole;
  allowed: string[];
  forbidden: string[];
  priority: "high" | "medium" | "low";
  notes: string[];
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
  /**
   * Deterministic answer to "is there a genuinely low-window wall, other
   * than the primary anchor wall, suitable for a TV/media unit?" — grounds
   * the living-room TV/media decision in the structural baseline instead of
   * leaving it to the model's own visual guess.
   */
  secondaryMediaWall?: SecondaryMediaWall;
  /**
   * Deterministic preservation guidance for architectural fixtures the
   * structural baseline already detected (fireplace/mantel, built-in
   * cabinetry, kitchen island, staircase, AC unit) — framed as design
   * affordances (what's favored/allowed around it), not just what to avoid.
   */
  fixturePreservation?: FixturePreservationDirective[];
  /**
   * Full per-wall breakdown — the canonical room plan. Every wall gets a
   * role, an allowed/forbidden item list, and a priority, so Stage 2 gets
   * one coherent planning object instead of several adjacent directives.
   */
  walls?: WallPlanEntry[];
  /**
   * Flat "DO NOT" list aggregated from the per-wall plan — negative rules
   * are often easier for image models to obey than implied constraints.
   */
  negativePlacementRules?: string[];
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
- For living room prefer sofa_group anchor.
- Add a tv_unit anchor only when a clearly suitable uninterrupted wall area exists with no conflicting openings.
- For dining room use dining_table anchor.
- AnchorRegion values must be normalized 0..1.
- If uncertain, still return layout with conservative anchorConfidence.`;

function buildPlannerPriorityBlock(retryInstructions?: string | null): string {
  const userInstructions = String(retryInstructions || "").trim();
  if (!userInstructions) {
    return `
PLANNING PRIORITY HIERARCHY (STRICT):
P0 Structural Constraints + Continuity Constraints (NON-NEGOTIABLE)
P2 Room Type Rules
P3 Staging Style Rules
P4 Default Layout Heuristics
`;
  }

  return `
PLANNING PRIORITY HIERARCHY (STRICT):
P0 Structural Constraints + Continuity Constraints (NON-NEGOTIABLE)
P1 User Retry Instructions (HIGH PRIORITY WITHIN P0 SAFETY ENVELOPE)
P2 Room Type Rules
P3 Staging Style Rules
P4 Default Layout Heuristics

USER RETRY INSTRUCTIONS (P1):
${userInstructions}
`;
}

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
  if (normalized.includes("living")) return "sofa_group";
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
  hasStaircase: boolean;
  windowCount: number;
  nonWindowOpenings: number;
  totalOpeningCoverage: number;
  hasMultipleInterferingOpenings: boolean;
  fixtures: AnchorFixture[];
};

function toNormalizedWallLabel(wallIndex: WallIndex): string {
  if (wallIndex === 0) return "front_wall";
  if (wallIndex === 1) return "right_wall";
  if (wallIndex === 2) return "back_wall";
  return "left_wall";
}

function oppositeWallIndex(wallIndex: WallIndex): WallIndex {
  return ((wallIndex + 2) % 4) as WallIndex;
}

function normalizeRoomTypeKey(roomType: string): string {
  return normalizeText(roomType).toLowerCase().replace(/-/g, "_");
}

function resolveAnchorItemForRoom(roomType: string): AnchorItem {
  const normalized = normalizeRoomTypeKey(roomType);
  if (normalized.includes("bed")) return "bed";
  if (normalized.includes("living")) return "sofa_group";
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

/**
 * Representative coverage fraction (0..1) for a wallCoverageBand bucket.
 * Uses the already-computed, validator-consistent band instead of
 * re-deriving an approximate bbox x-width fraction.
 */
function wallCoverageBandToFraction(band: WallCoverageBand): number {
  switch (band) {
    case "5-10": return 0.10;
    case "10-20": return 0.20;
    case "20-40": return 0.40;
    case "40-60": return 0.60;
    case "60+": return 0.75;
    default: return 0;
  }
}

function openingCoverage(opening: StructuralBaseline["openings"][number]): number {
  return opening.wallCoverageBand
    ? wallCoverageBandToFraction(opening.wallCoverageBand)
    : bboxCoverage(opening.bbox);
}

function buildWallSuitability(baseline: StructuralBaseline): WallSuitability[] {
  const byWall = new Map<WallIndex, StructuralBaseline["openings"]>();
  (baseline.openings || []).forEach((opening) => {
    const wall = opening.wallIndex;
    const existing = byWall.get(wall) || [];
    existing.push(opening);
    byWall.set(wall, existing);
  });

  const fixturesByWall = new Map<WallIndex, AnchorFixture[]>();
  (baseline.anchorFixtures || []).forEach((fixture) => {
    const existing = fixturesByWall.get(fixture.wallIndex) || [];
    existing.push(fixture);
    fixturesByWall.set(fixture.wallIndex, existing);
  });

  const allWalls: WallIndex[] = [0, 1, 2, 3];
  return allWalls.map((wallIndex) => {
    const openings = byWall.get(wallIndex) || [];
    const fixtures = fixturesByWall.get(wallIndex) || [];
    const hasDoor = openings.some((opening) => opening.type === "door" || opening.type === "walkthrough");
    const hasClosetDoor = openings.some((opening) => opening.type === "closet_door");
    const hasStaircase = fixtures.some((fixture) => fixture.type === "staircase");
    const windowCount = openings.filter((opening) => opening.type === "window").length;
    const nonWindowOpenings = openings.filter((opening) => opening.type !== "window").length;
    const totalOpeningCoverage = openings.reduce((acc, opening) => acc + openingCoverage(opening), 0);
    const hasMultipleInterferingOpenings = openings.length >= 2 && totalOpeningCoverage >= 0.55;

    let classification: WallSuitabilityClass = "ideal";
    // A staircase makes a wall structurally unsuitable for anchor/media
    // furniture just like a door does — you can't build against or block it.
    if (hasDoor || hasClosetDoor || hasMultipleInterferingOpenings || hasStaircase) {
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
      hasStaircase,
      windowCount,
      nonWindowOpenings,
      totalOpeningCoverage,
      hasMultipleInterferingOpenings,
      fixtures,
    };
  });
}

const SECONDARY_MEDIA_WALL_MAX_COVERAGE = 0.20;

/**
 * Composite ranking for TV/media wall candidates. Wall suitability (window/
 * door presence) alone isn't how a person actually picks a TV wall —
 * sightline from the seating anchor, circulation, and screen glare matter
 * too:
 *  - visibility: best sightline is the wall directly opposite the seating
 *    anchor (the sofa faces it head-on); adjacent walls give an angled but
 *    workable sightline.
 *  - circulation: a wall with any non-window opening nearby (even one that
 *    doesn't disqualify it outright, e.g. a nearby closet door) is
 *    penalized — more openings means more foot traffic near the screen.
 *  - glare: penalizes the candidate's own window coverage (light hitting the
 *    screen face-on), plus a smaller penalty when the seating wall itself
 *    has a window (backlighting the screen from behind the viewer).
 */
function scoreMediaWallCandidate(
  candidate: WallSuitability,
  anchorWallIndex: WallIndex,
  allWalls: WallSuitability[]
): number {
  let score = candidate.score;

  score += candidate.wallIndex === oppositeWallIndex(anchorWallIndex) ? 40 : 15;
  score -= candidate.nonWindowOpenings * 15;
  score -= Math.round(candidate.totalOpeningCoverage * 20);

  const anchorWallWindowCount = allWalls.find((wall) => wall.wallIndex === anchorWallIndex)?.windowCount ?? 0;
  if (anchorWallWindowCount > 0) {
    score -= 10;
  }

  return score;
}

/**
 * Deterministic answer to "besides the primary anchor wall, is there a wall
 * genuinely suitable for a TV/media unit?" — ranks every non-disallowed
 * candidate by the composite score above (visibility + circulation + glare
 * + base wall suitability), then derives the mount mode from the winning
 * wall's own window characteristics: wall_mount (no window), console_only
 * (window below SECONDARY_MEDIA_WALL_MAX_COVERAGE), or freestanding (no
 * wall clears either bar but a non-disallowed wall exists). Only fully
 * unavailable when every remaining wall is disallowed.
 */
function findSecondaryMediaWall(
  suitability: WallSuitability[],
  anchorWallIndex: WallIndex
): SecondaryMediaWall {
  const candidates = suitability.filter(
    (wall) => wall.wallIndex !== anchorWallIndex && wall.classification !== "disallowed"
  );
  if (candidates.length === 0) {
    return { available: false };
  }

  const best = candidates
    .map((wall) => ({ wall, compositeScore: scoreMediaWallCandidate(wall, anchorWallIndex, suitability) }))
    .sort((a, b) => b.compositeScore - a.compositeScore)[0].wall;

  const mountMode: NonNullable<SecondaryMediaWall["mountMode"]> =
    best.classification === "ideal" ? "wall_mount" :
    best.totalOpeningCoverage < SECONDARY_MEDIA_WALL_MAX_COVERAGE ? "console_only" :
    "freestanding";

  return { available: true, wallIndex: best.wallIndex, wallLabel: best.label, mountMode };
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

function fixtureToAvoidZone(fixture: AnchorFixture): string {
  const [x1, y1, x2, y2] = fixture.bbox || [0, 0, 0, 0];
  return `${fixture.type}:${fixture.id}:bbox(${x1.toFixed(3)},${y1.toFixed(3)},${x2.toFixed(3)},${y2.toFixed(3)})`;
}

const ANCHOR_FIXTURE_LABELS: Record<AnchorFixtureType, string> = {
  ac_unit: "wall-mounted air conditioning unit",
  fireplace: "fireplace and mantel",
  built_in_cabinet: "built-in cabinetry",
  kitchen_island: "kitchen island",
  staircase: "staircase",
  other: "architectural fixture",
};

type FixtureAffordance = {
  allowed: string[];
  forbidden: string[];
  priority: "high" | "medium" | "low";
  notes: string[];
};

/**
 * Frames a detected architectural fixture as a design affordance — what's
 * favored/allowed around it, not just what to avoid. A fireplace is a
 * preferred focal point (artwork, mirror, or a TV if this wall was also
 * selected as the media wall); built-ins can be styled but not covered; a
 * kitchen island can be styled but not obstructed; a staircase must stay
 * clear.
 */
function buildFixtureAffordance(
  fixture: AnchorFixture,
  opts: { isMediaWall: boolean }
): FixtureAffordance {
  switch (fixture.type) {
    case "fireplace":
      return opts.isMediaWall
        ? {
            allowed: ["television"],
            forbidden: ["cover_mantel", "remove_mantel", "alter_surround"],
            priority: "high",
            notes: ["Preferred focal point. Preserve the mantel and surround exactly as shown — the TV may be mounted above or placed beside it without altering the fireplace."],
          }
        : {
            allowed: ["artwork", "mirror"],
            forbidden: ["television", "cover_mantel", "remove_mantel", "alter_surround"],
            priority: "high",
            notes: ["Preferred focal point. Preserve the mantel and surround exactly as shown. Favor artwork centered above the mantel or an indoor floor plant beside it; leave the wall above bare if neither suits the composition."],
          };
    case "built_in_cabinet":
      return {
        allowed: ["small_decor", "books"],
        forbidden: ["cover_doors", "cover_hardware", "large_furniture_flush_against"],
        priority: "medium",
        notes: ["Can be decorated with small styling items or books on open shelving. Cannot cover doors or hardware, or block them from opening."],
      };
    case "kitchen_island":
      return {
        allowed: ["styling_items"],
        forbidden: ["furniture_on_top", "block_circulation"],
        priority: "medium",
        notes: ["Can be styled with small items. Cannot be obstructed or have furniture placed on top."],
      };
    case "staircase":
      return {
        allowed: [],
        forbidden: ["furniture", "decor_on_treads", "block_circulation"],
        priority: "high",
        notes: ["Keep treads, risers, and railings fully clear for safe circulation."],
      };
    case "ac_unit":
      return {
        allowed: [],
        forbidden: ["furniture_blocking_airflow", "cover_unit"],
        priority: "medium",
        notes: ["Keep clear of furniture/decor that would block airflow or visibility."],
      };
    default:
      return {
        allowed: [],
        forbidden: ["cover", "remove", "alter"],
        priority: "medium",
        notes: ["Preserve exactly as shown; avoid placing furniture or decor that obscures it."],
      };
  }
}

function formatFixtureDirectiveText(fixture: AnchorFixture, wallLabel: string, affordance: FixtureAffordance): string {
  const label = ANCHOR_FIXTURE_LABELS[fixture.type] || ANCHOR_FIXTURE_LABELS.other;
  return `${label} (${fixture.id}, ${wallLabel}): ${affordance.notes.join(" ")}`;
}

function buildFixturePreservationDirectives(
  fixtures: AnchorFixture[] | undefined,
  secondaryMediaWall: SecondaryMediaWall | undefined
): FixturePreservationDirective[] {
  if (!fixtures || fixtures.length === 0) return [];
  return fixtures.map((fixture) => {
    const wallLabel = toNormalizedWallLabel(fixture.wallIndex);
    const isMediaWall = secondaryMediaWall?.available === true && secondaryMediaWall.wallIndex === fixture.wallIndex;
    const affordance = buildFixtureAffordance(fixture, { isMediaWall });
    return {
      fixtureId: fixture.id,
      type: fixture.type,
      wallLabel,
      directive: formatFixtureDirectiveText(fixture, wallLabel, affordance),
    };
  });
}

const ANCHOR_ITEM_TO_LAYOUT_LABEL: Record<AnchorItem, string> = {
  bed: "bed",
  tv_unit: "tv_unit",
  dining_table: "dining_table",
  sofa_group: "sofa",
};

/**
 * Builds the canonical per-wall room plan — every wall gets a role, an
 * allowed/forbidden item list, and a priority. allowed/forbidden accumulate
 * contributions from circulation safety, detected architecture, and the
 * anchor/media assignments; role/priority are then derived by precedence
 * (protected_architecture > avoid_circulation > anchor > secondary_media >
 * neutral) purely for labeling — the underlying allowed/forbidden sets
 * still reflect every applicable constraint regardless of which role wins.
 */
function buildWallPlanEntries(
  suitability: WallSuitability[],
  anchorWallIndex: WallIndex,
  anchorItem: AnchorItem,
  secondaryMediaWall: SecondaryMediaWall | undefined
): WallPlanEntry[] {
  return suitability.map((wall) => {
    const hasWindow = wall.windowCount > 0;
    const hasDoor = wall.hasDoor || wall.hasClosetDoor;
    const isAnchorWall = wall.wallIndex === anchorWallIndex;
    const isMediaWall = secondaryMediaWall?.available === true && secondaryMediaWall.wallIndex === wall.wallIndex;

    const allowed = new Set<string>();
    const forbidden = new Set<string>();
    const notes: string[] = [];

    if (hasDoor || wall.hasMultipleInterferingOpenings || wall.hasStaircase) {
      forbidden.add("furniture");
      forbidden.add("large_decor");
      if (!wall.hasStaircase) notes.push("Keep clear for door/walkthrough circulation.");
    } else {
      allowed.add("decor");
      allowed.add("small_furniture");
      if (!hasWindow) allowed.add("large_furniture");
    }

    wall.fixtures.forEach((fixture) => {
      const affordance = buildFixtureAffordance(fixture, { isMediaWall });
      affordance.allowed.forEach((item) => allowed.add(item));
      affordance.forbidden.forEach((item) => forbidden.add(item));
      notes.push(...affordance.notes);
    });

    if (isAnchorWall) {
      allowed.add(ANCHOR_ITEM_TO_LAYOUT_LABEL[anchorItem]);
      notes.push(`Primary anchor: ${anchorItem}.`);
    } else if (isMediaWall) {
      allowed.add("television");
      notes.push(`Secondary media wall (${secondaryMediaWall!.mountMode}).`);
    }

    const role: WallRole =
      wall.fixtures.length > 0 ? "protected_architecture" :
      (hasDoor || wall.hasMultipleInterferingOpenings || wall.hasStaircase) ? "avoid_circulation" :
      isAnchorWall ? "anchor" :
      isMediaWall ? "secondary_media" :
      "neutral";

    const priority: WallPlanEntry["priority"] =
      wall.fixtures.length > 0 || hasDoor || wall.hasMultipleInterferingOpenings || wall.hasStaircase || isAnchorWall
        ? "high"
        : isMediaWall ? "medium" : "low";

    return {
      wallIndex: wall.wallIndex,
      label: wall.label,
      hasWindow,
      hasDoor,
      architecture: wall.fixtures.map((fixture) => ({ id: fixture.id, type: fixture.type })),
      role,
      allowed: Array.from(allowed),
      forbidden: Array.from(forbidden),
      priority,
      notes,
    };
  });
}

/**
 * Flat "DO NOT" list aggregated from the per-wall plan — negative rules are
 * often easier for image models to obey than implied constraints.
 */
function buildNegativePlacementRules(walls: WallPlanEntry[]): string[] {
  const rules: string[] = [];

  walls.forEach((wall) => {
    if (wall.hasWindow) {
      rules.push(`Do not mount a TV directly over the window on ${wall.label}.`);
      rules.push(`Do not place a tall plant directly in front of the window on ${wall.label}.`);
      if (!wall.allowed.includes("large_furniture")) {
        rules.push(`Do not place large artwork or mirrors on ${wall.label} where they would overlap the window.`);
      }
    }
    if (wall.hasDoor) {
      rules.push(`Do not place furniture or decor blocking the door/walkthrough on ${wall.label}.`);
    }
    wall.architecture.forEach((fixture) => {
      switch (fixture.type) {
        case "fireplace":
          rules.push(`Do not block or cover the fireplace/mantel on ${wall.label}.`);
          break;
        case "built_in_cabinet":
          rules.push(`Do not cover built-in cabinetry doors or hardware on ${wall.label}.`);
          break;
        case "kitchen_island":
          rules.push(`Do not obstruct the kitchen island on ${wall.label}.`);
          break;
        case "staircase":
          rules.push(`Do not obstruct the staircase on ${wall.label}.`);
          break;
        case "ac_unit":
          rules.push(`Do not hide or block airflow to the AC unit on ${wall.label}.`);
          break;
        default:
          rules.push(`Do not cover or alter the architectural fixture on ${wall.label}.`);
      }
    });
  });

  return Array.from(new Set(rules));
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

  // A fireplace wall must not host the primary seating/bed/dining anchor —
  // you arrange furniture facing a fireplace, not backing into it, and its
  // avoid-zone would otherwise overlap the anchor region directly. It stays
  // fully eligible for the secondary media wall below (TV above the mantel
  // is the intended pairing) and for `suitability`/`buildWallPlanEntries`
  // generally — only the anchor selection pool excludes it, falling back to
  // the full wall set if every wall happens to have a fireplace.
  const anchorEligibleWalls = suitability.filter((wall) => !wall.fixtures.some((fixture) => fixture.type === "fireplace"));
  const anchorPool = anchorEligibleWalls.length > 0 ? anchorEligibleWalls : suitability;

  const idealWalls = anchorPool.filter((wall) => wall.classification === "ideal").sort((a, b) => b.score - a.score);
  const conditionalWalls = anchorPool.filter((wall) => wall.classification === "conditional_window").sort((a, b) => b.score - a.score);
  const fallbackWalls = [...anchorPool].sort((a, b) => b.score - a.score);

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

  // The deterministic anchor for living rooms is always sofa_group (a sofa
  // tolerates a window wall fine) — the TV/media unit is a secondary,
  // optional item that genuinely needs its own low-window wall. Evaluate
  // that separately against the structural baseline rather than leaving it
  // to the model's own visual judgment.
  const secondaryMediaWall = (anchorItem === "sofa_group" && normalizeRoomTypeKey(roomType).includes("living"))
    ? findSecondaryMediaWall(suitability, selectedWallIndex)
    : undefined;

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

  const fixturePreservation = buildFixturePreservationDirectives(opts.structuralBaseline.anchorFixtures, secondaryMediaWall);
  fixturePreservation.forEach((entry) => {
    decorRestrictions.push({ target: "fixture_zone", rule: entry.directive });
  });

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

  const avoidZones = [
    ...(opts.structuralBaseline.openings || []).map(openingToAvoidZone),
    ...(opts.structuralBaseline.anchorFixtures || []).map(fixtureToAvoidZone),
  ];

  const walls = buildWallPlanEntries(suitability, selectedWallIndex, anchorItem, secondaryMediaWall);
  const negativePlacementRules = buildNegativePlacementRules(walls);

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
    secondaryMediaWall,
    fixturePreservation: fixturePreservation.length > 0 ? fixturePreservation : undefined,
    walls,
    negativePlacementRules: negativePlacementRules.length > 0 ? negativePlacementRules : undefined,
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
    stagingStyle?: string;
    retryInstructions?: string | null;
    anchorPlannerEnabled?: boolean;
    structuralBaseline?: StructuralBaseline | null;
    anchorConfidenceThreshold?: number;
    useGeminiFallback?: boolean;
  }
): Promise<Stage2LayoutPlan | null> {
  const startedAt = Date.now();
  const plannerPriorityBlock = buildPlannerPriorityBlock(opts?.retryInstructions);

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
      secondaryMediaWall: deterministicPlan.secondaryMediaWall || null,
      fixturePreservationCount: deterministicPlan.fixturePreservation?.length || 0,
      negativePlacementRuleCount: deterministicPlan.negativePlacementRules?.length || 0,
      walls: wallSuitability.map((wall) => ({
        wallIndex: wall.wallIndex,
        wall: wall.label,
        classification: wall.classification,
        score: wall.score,
        hasDoor: wall.hasDoor,
        hasClosetDoor: wall.hasClosetDoor,
        hasStaircase: wall.hasStaircase,
        windowCount: wall.windowCount,
        nonWindowOpenings: wall.nonWindowOpenings,
        openingCoverage: Number(wall.totalOpeningCoverage.toFixed(3)),
        multiOpeningInterference: wall.hasMultipleInterferingOpenings,
        fixtureTypes: wall.fixtures.map((fixture) => fixture.type),
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
      {
        text: `${LAYOUT_PLANNER_PROMPT}

CONTEXT:
- Room type target: ${String(opts?.roomType || "unknown")}
- Staging style target: ${String(opts?.stagingStyle || "standard_listing")}
${plannerPriorityBlock}`,
      },
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

/**
 * Renders the plan as ONE coherent "ROOM LAYOUT PLAN (DETERMINISTIC)"
 * section rather than several adjacent, differently-formatted blocks — the
 * anchor wall, secondary furniture, media placement, protected architecture,
 * avoid zones, and negative placement rules all read as parts of a single
 * planning object, which should be easier for the model to hold together
 * than separate directives scattered across the prompt.
 */
export function formatStage2LayoutPlanForPrompt(plan: Stage2LayoutPlan): string {
  const sections: string[] = [];

  if (plan.anchorItem) {
    const lines = [
      `- Item: ${plan.anchorItem}`,
      plan.anchorWall ? `- Wall: ${plan.anchorWall}` : null,
      plan.anchorOrientation ? `- Orientation: ${plan.anchorOrientation}` : null,
      plan.anchorConstraints?.mountMode ? `- Placement mode: ${plan.anchorConstraints.mountMode}` : null,
      plan.anchorConstraints?.avoidCoveringWindows === true ? "- Do not cover windows on or near anchor wall." : null,
      plan.anchorConstraints?.avoidAboveWindow === true ? "- Do not place this anchor over any window." : null,
      plan.furnitureVisibilityRules?.allow_crop === true ? "- May be partially cropped by frame edges when composition is natural." : null,
      plan.furnitureVisibilityRules?.assume_wall_continuation === true ? "- Assume anchor wall continues beyond visible frame edges." : null,
      plan.anchorRegion
        ? `- Prefer region (soft guidance, not a hard mask — do NOT modify architecture, openings, or fixtures to satisfy it): x=${plan.anchorRegion.x.toFixed(3)} y=${plan.anchorRegion.y.toFixed(3)} width=${plan.anchorRegion.width.toFixed(3)} height=${plan.anchorRegion.height.toFixed(3)}`
        : null,
      ...(plan.anchorConstraints?.rules || []).map((rule) => `- ${rule}`),
    ].filter((line): line is string => Boolean(line));
    sections.push(["Anchor Wall (MANDATORY)", ...lines].join("\n"));
  }

  const anchorLayoutLabel = plan.anchorItem ? ANCHOR_ITEM_TO_LAYOUT_LABEL[plan.anchorItem] : undefined;
  const secondaryItems = (plan.layout || []).filter((entry) => entry.item !== anchorLayoutLabel);
  if (secondaryItems.length > 0) {
    sections.push([
      "Secondary Furniture",
      ...secondaryItems.map((entry) => `- ${entry.item}: ${entry.placement}`),
    ].join("\n"));
  }

  if (plan.secondaryMediaWall) {
    const mediaLines = plan.secondaryMediaWall.available
      ? [
          `- Wall: ${plan.secondaryMediaWall.wallLabel}`,
          `- Mode: ${
            plan.secondaryMediaWall.mountMode === "wall_mount" ? "wall-mount safe — wall has no window" :
            plan.secondaryMediaWall.mountMode === "console_only" ? "console-only — no wall mount, wall has a window" :
            "freestanding TV unit only — no wall is clear enough for a mounted or console-against-wall placement; position away from windows and circulation, facing the seating group"
          }`,
          "- You may add a TV/media unit there.",
        ]
      : ["- None available — do NOT include a TV/media unit. Use conversation grouping, fireplace, or view as the focal point instead."];
    sections.push(["Media Placement", ...mediaLines].join("\n"));
  }

  if (plan.fixturePreservation && plan.fixturePreservation.length > 0) {
    sections.push([
      "Protected Architecture (MANDATORY)",
      ...plan.fixturePreservation.map((entry) => `- ${entry.directive}`),
    ].join("\n"));
  }

  if (plan.avoid_zones && plan.avoid_zones.length > 0) {
    sections.push([
      "Avoid Zones",
      "Do not place furniture inside these zones unless explicitly permitted above:",
      ...plan.avoid_zones.map((zone) => `- ${zone}`),
    ].join("\n"));
  }

  if (plan.negativePlacementRules && plan.negativePlacementRules.length > 0) {
    sections.push([
      "Negative Placement Rules (DO NOT)",
      ...plan.negativePlacementRules.map((rule) => `- ${rule}`),
    ].join("\n"));
  }

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
      secondaryMediaWall: plan.secondaryMediaWall,
      fixturePreservation: plan.fixturePreservation,
      walls: plan.walls,
      negativePlacementRules: plan.negativePlacementRules,
    },
    null,
    2
  );

  if (sections.length === 0) {
    return serialized;
  }

  return `ROOM LAYOUT PLAN (DETERMINISTIC)\nUse this plan exactly — it reflects the room's actual architecture. Do not deviate from its constraints.\n\n${sections.join("\n\n")}\n\nPLAN_JSON:\n${serialized}`;
}
