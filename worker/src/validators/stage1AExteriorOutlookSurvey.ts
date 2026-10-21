// Stage 1A "Enhance Exterior Outlook" — which photos are eligible, and where.
//
// The outlook prompt used to run on every interior photo when the checkbox
// was ticked, and in rooms with no real view Gemini invented windows and
// doorways (Oct 2026). Now one cheap text-only look at the photo comes first:
// is there a real outside view through a window or glass door, where is it,
// is its sky grey, is there greenery, is the glass blown out?
//
// - No usable view: nothing outlook-related runs (plain Stage 1A).
// - Grey/cloudy sky in a usable view: the sky-only prompt is added to the
//   normal Stage 1A call.
// - Usable view: code brightens, warms and greens the view inside its box
//   after Stage 1A (see stage1AExteriorOutlookAdjust.ts) — no AI involved.
//
// Fails closed: any error or unclear answer means "not eligible".
import { callValidatorModel } from "./validatorModelCall";

export const EXTERIOR_OUTLOOK_SURVEY_MODEL = String(process.env.STAGE1A_OUTLOOK_SURVEY_MODEL || "gemini-3.8-flash");
const SURVEY_TIMEOUT_MS = Number(process.env.STAGE1A_OUTLOOK_SURVEY_TIMEOUT_MS || 30000);
// A view smaller than this share of the photo (box area, %) is too small to bother with.
const MIN_VIEW_AREA_PCT = Number(process.env.STAGE1A_OUTLOOK_MIN_VIEW_PCT || 0.5);

export type OutlookView = {
  box: [number, number, number, number]; // x1, y1, x2, y2 as fractions of the photo
  sky: "grey" | "blue" | "none";
  greenery: boolean;
  blownOut: boolean;
  description: string;
};

export type OutlookSurvey = {
  eligible: boolean;
  skyToBlue: boolean;
  views: OutlookView[]; // usable views only
  reason: string;
  raw?: any;
};

export function buildOutlookSurveyPrompt(): string {
  return `Look at this interior real-estate photo and find every window or glass door that shows a real view of the OUTSIDE (sky, garden, trees, lawn, fence, neighbouring houses, street). Ignore mirrors, artwork, screens, interior doorways and openings into other rooms, and glass covered by closed curtains or blinds.

For each one that shows an outside view, give:
- "box": [x1, y1, x2, y2] as fractions of the photo width/height (0 to 1), tightly around the VISIBLE OUTSIDE VIEW only — inside the frame, not including curtains, blinds or the frame itself;
- "blownOut": "yes" if the glass is so bright it shows plain white with no outside detail, otherwise "no";
- "sky": "grey" if overcast, grey, white-cloudy or hazy sky is visible, "blue" if the visible sky is already mostly blue, "none" if no sky shows;
- "greenery": "yes" if trees, shrubs, hedges, lawn or plants are visible outside, otherwise "no";
- "description": a few words (for example "garden and fence through the left window").

Respond with ONLY a JSON object: { "views": [ { "box": [number, number, number, number], "blownOut": "yes" | "no", "sky": "grey" | "blue" | "none", "greenery": "yes" | "no", "description": string } ] }. Use an empty list when no window or glass door shows the outside.`;
}

function cleanBox(b: any): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const v = b.map((n: any) => Number(n));
  if (v.some((n: number) => !Number.isFinite(n))) return null;
  // Some answers come back in percent or per-mille; bring them to 0..1.
  const max = Math.max(...v);
  const scale = max > 100 ? 1000 : max > 1.5 ? 100 : 1;
  const [x1, y1, x2, y2] = v.map((n: number) => Math.min(1, Math.max(0, n / scale)));
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

/** Pure: turns the model's answer into the decision. Unclear answers are not eligible. */
export function evaluateOutlookSurvey(raw: any): OutlookSurvey {
  const items: any[] = Array.isArray(raw?.views) ? raw.views : [];
  const yes = (v: any) => String(v || "").trim().toLowerCase() === "yes";
  const views: OutlookView[] = [];
  for (const it of items) {
    const box = cleanBox(it?.box);
    if (!box) continue;
    const areaPct = (box[2] - box[0]) * (box[3] - box[1]) * 100;
    if (areaPct < MIN_VIEW_AREA_PCT) continue;
    if (yes(it?.blownOut)) continue;
    const skyRaw = String(it?.sky || "").trim().toLowerCase();
    const sky = skyRaw === "grey" || skyRaw === "gray" ? "grey" : skyRaw === "blue" ? "blue" : "none";
    views.push({ box, sky, greenery: yes(it?.greenery), blownOut: false, description: String(it?.description || "").slice(0, 120) });
  }
  if (!views.length) {
    return { eligible: false, skyToBlue: false, views: [], reason: items.length ? "only blown-out or tiny views" : "no outside view", raw };
  }
  const skyToBlue = views.some((v) => v.sky === "grey");
  return { eligible: true, skyToBlue, views, reason: `${views.length} usable view(s)${skyToBlue ? ", grey sky" : ""}`, raw };
}

export async function surveyExteriorOutlook(params: { imagePath: string; jobId: string; imageId: string }): Promise<OutlookSurvey> {
  try {
    const raw = await callValidatorModel({
      images: [{ path: params.imagePath, label: "Photo:" }],
      systemInstruction: "You are a careful visual inspector of real-estate photos.",
      userPrompt: buildOutlookSurveyPrompt(),
      model: EXTERIOR_OUTLOOK_SURVEY_MODEL,
      reasonPrefix: "stage1a_outlook_survey",
      timeoutMs: SURVEY_TIMEOUT_MS,
      ctx: { jobId: params.jobId, imageId: params.imageId, callLabel: "outlook_survey" },
    });
    return evaluateOutlookSurvey(raw);
  } catch (err: any) {
    return { eligible: false, skyToBlue: false, views: [], reason: `survey failed: ${String(err?.message || err).slice(0, 200)}` };
  }
}
