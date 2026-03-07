import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { focusLog } from "../utils/logFocus";

export type Stage2LayoutPlan = {
  room_type: string;
  layout: Array<{
    item: string;
    placement: string;
  }>;
  avoid_zones: string[];
};

const LAYOUT_PLANNER_PROMPT =
  "Analyze this empty room and produce a structured furniture layout plan suitable for real estate staging.";

function normalizeText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text;
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
  };
}

export async function planStage2Layout(
  imagePath: string,
  opts?: { jobId?: string }
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

    focusLog("LAYOUT_PLANNER", "[pipeline/layoutPlanner] plan ready", {
      jobId: opts?.jobId,
      elapsedMs: Date.now() - startedAt,
      roomType: normalized.room_type,
      layoutItems: normalized.layout.length,
      avoidZones: normalized.avoid_zones.length,
    });

    return normalized;
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
  return JSON.stringify(
    {
      room_type: plan.room_type,
      layout: plan.layout,
      avoid_zones: plan.avoid_zones,
    },
    null,
    2
  );
}
