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
  }
): Promise<Stage2LayoutPlan | null> {
  const startedAt = Date.now();

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
    },
    null,
    2
  );

  if (!anchorDirective) {
    return serialized;
  }

  return `${anchorDirective}\n\nPLAN_JSON:\n${serialized}`;
}
