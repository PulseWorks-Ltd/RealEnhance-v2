// Two-call fabricated-opening / wall-breach detection.
//
// Motivating case: job_8505488a attempt 2 generated a real, hallucinated
// doorway on a wall that was fully continuous in the baseline, exposing a
// fabricated partial room beyond it — confirmed by direct visual inspection
// (crop comparison anchored on a wall-mounted heater fixture present
// identically in both images). Every existing check (opening, envelope,
// fixture, floor) passed this image. Root cause, confirmed by reading the
// code: openingEnvelopeValidator.ts's per-item observation list is built
// exclusively from baseline.openings — it only ever re-examines openings
// that were already extracted from the baseline, so a wholly new opening
// with no baseline counterpart is structurally never something it asks
// about. This is a blind spot, not a classifier bug.
//
// A prior attempt to close this gap by adding a single holistic
// "describe wall-plane continuity" question to the existing envelope call
// was tested against both known real fabrication cases (this job and
// job_4f09191f's fabricated return wall) and failed on both, with EITHER
// Grok or Gemini as the model — the model's own free-text answer was
// itself factually wrong about the images (e.g. describing the fabricated
// opening as "the same passage" already present in the baseline), not
// misread by a downstream classifier. That approach was reverted.
//
// This file is a different, two-call structure instead of one holistic
// question, specifically to avoid asking the model to hold "is this the
// same room overall" and "is there a new opening at this precise spot" in
// its attention at the same time — the same holistic-vs-narrow distinction
// behind every other locate-and-describe check in this codebase:
//
// CALL 1 (list-compare, staged image only): given the full list of
// baseline opening bboxes (deliberately NOT wall-grouped — wall-assignment
// in the baseline extraction has been confirmed unstable elsewhere this
// session, and grouping by wall would reintroduce that instability here),
// ask whether the STAGED image shows any door/window/walkthrough/opening
// at a location not covered by that list. If yes, the model must state
// where, in both plain language and its own best-guess bbox.
//
// CALL 2 (single-location confirm, baseline image only): only run if call
// 1 flagged something. Given ONLY the baseline photo and call 1's stated
// location, ask a narrow yes/no question — does this exact spot show an
// opening in the baseline photo? This distinguishes a genuine fabrication
// (call 2 says no — baseline was solid there) from a baseline-extraction
// miss (call 2 says yes — the opening was real all along, just missing
// from the extracted list, e.g. through the same wall-assignment
// instability noted above).
//
// The combination of call 1 + call 2 into a verdict is deterministic,
// code-side logic (see combineFabricatedOpeningCalls below) — neither call
// is asked to render an overall pass/fail judgment itself.
import { toBase64 } from "../utils/images";
import { getGeminiClient } from "../ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../ai/grok";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { HUMAN_EYE_FRAMING, resolveValidatorModel } from "./occlusionVsRemovalCheck";
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline } from "./openingPreservationValidator";

const FABRICATED_OPENING_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

function formatBbox(bbox: [number, number, number, number]): string {
  const [x1, y1, x2, y2] = bbox;
  return `x: ${x1.toFixed(2)}–${x2.toFixed(2)}, y: ${y1.toFixed(2)}–${y2.toFixed(2)}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function callModel(params: {
  images: { path: string; label: string }[];
  systemInstruction: string;
  userPrompt: string;
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<any> {
  const loaded = params.images.map((img) => ({ ...toBase64(img.path), label: img.label }));
  const validatorModel = resolveValidatorModel();
  const requestStartedAt = Date.now();

  if (validatorModel === "grok") {
    const text = await grokAnalyzeImages({
      images: loaded.map((l) => ({ buffer: Buffer.from(l.data, "base64"), mimeType: l.mime, label: l.label })),
      prompt: `${params.systemInstruction}\n\n${params.userPrompt}`,
      jobId: params.ctx.jobId,
      imageId: params.ctx.imageId,
      reason: `fabricated_opening_${params.ctx.callLabel}`,
      expectJson: true,
    });
    console.log(
      JSON.stringify({
        event: "GROK_VALIDATOR_USAGE",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: "validator",
        callLabel: `fabricated_opening_${params.ctx.callLabel}`,
        model: grokVisionModel(),
        latencyMs: Date.now() - requestStartedAt,
      })
    );
    return extractJson(text);
  }

  const ai = getGeminiClient();
  const parts: any[] = [{ text: params.systemInstruction }, { text: params.userPrompt }];
  for (const l of loaded) {
    parts.push({ text: l.label });
    parts.push({ inlineData: { mimeType: l.mime, data: l.data } });
  }
  const response: any = await (ai as any).models.generateContent({
    model: FABRICATED_OPENING_MODEL,
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 2048, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: params.ctx.attempt ?? 1 },
    model: FABRICATED_OPENING_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });
  const responseParts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = responseParts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error(`FABRICATED_OPENING_CHECK[${params.ctx.callLabel}]: no text returned`);
  return extractJson(textPart.text);
}

type Call1Result = {
  foundUnlistedOpening: boolean;
  location: string;
  locationBbox: [number, number, number, number] | null;
  description: string;
};

type Call2Result = {
  presentInBaseline: boolean;
  description: string;
};

function buildCall1Prompt(baseline: StructuralBaseline): string {
  const bboxList = baseline.openings
    .map((o) => `- ${formatBbox(o.bbox)}`)
    .join("\n");
  return `You are checking a STAGED (furnished) room photo for a NEW opening — a door, window, walkthrough, or any gap/void in a wall that exposes space beyond it — that was NOT present in the original baseline photo of this exact room.

Below is the full list of opening locations already known from the baseline photo, given only as bounding boxes (normalized fractions of image width/height, 0,0 = top-left). This list is deliberately NOT grouped by wall — treat each as an independent region:

${bboxList || "(no openings extracted from baseline)"}

Look at the STAGED image. Does it show any door, window, walkthrough, or opening-like feature — an actual gap or void in a wall, not a picture, mirror, or decor — at a location that is NOT covered by any of the regions listed above?

${HUMAN_EYE_FRAMING}

If you find such a location, you MUST state exactly where — both in plain language (e.g. "far-left wall, spanning from the ceiling down to about waist height") and as your own best-guess bounding box. Do not just answer yes/no.

Respond with ONLY a single valid JSON object:
{
  "foundUnlistedOpening": true|false,
  "location": "string — plain-language location, empty string if false",
  "locationBbox": [x1,y1,x2,y2] | null,
  "description": "string — what you see at that location, empty string if false"
}`;
}

function buildCall2Prompt(call1: Call1Result): string {
  return `You are looking at ONLY the ORIGINAL (baseline) photo of a room — no staged/furnished version is given here.

A specific location in this photo has been flagged for you to check: "${call1.location}"${call1.locationBbox ? ` (approximate region: ${formatBbox(call1.locationBbox)})` : ""}.

Look carefully at exactly this location in the baseline photo. Does this exact spot show a door, window, walkthrough, or any opening/gap in the wall — as opposed to a continuous, unbroken wall surface?

${HUMAN_EYE_FRAMING}

Respond with ONLY a single valid JSON object:
{
  "presentInBaseline": true|false,
  "description": "string — what you actually see at this location in the baseline photo"
}`;
}

export type FabricatedOpeningCheckResult = {
  ranCall1: boolean;
  ranCall2: boolean;
  flagged: boolean;
  location?: string;
  locationBbox?: [number, number, number, number] | null;
  call1Description?: string;
  presentInBaseline?: boolean;
  call2Description?: string;
  verdict: "clean" | "fabricated" | "baseline_extraction_miss";
  outcome: ValidatorOutcome;
};

const CLEAN_OUTCOME: ValidatorOutcome = {
  status: "pass",
  reason: "fabricated_opening_check: no unlisted opening detected",
  confidence: 0.85,
  hardFail: false,
  issueType: ISSUE_TYPES.NONE,
  issueTier: "none",
  advisorySignals: [],
};

export async function runFabricatedOpeningCheck(
  baselineImagePath: string,
  stagedImagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<FabricatedOpeningCheckResult> {
  const call1: Call1Result = await callModel({
    images: [{ path: stagedImagePath, label: "STAGED (furnished) image:" }],
    systemInstruction: "You are a careful visual inspector checking a furnished room photo for structural additions not present in the original room.",
    userPrompt: buildCall1Prompt(baseline),
    ctx: { ...ctx, callLabel: "call1_list_compare" },
  });

  if (!call1?.foundUnlistedOpening) {
    return { ranCall1: true, ranCall2: false, flagged: false, verdict: "clean", outcome: CLEAN_OUTCOME };
  }

  const location = typeof call1.location === "string" ? call1.location : "(unspecified location)";
  const locationBbox = Array.isArray(call1.locationBbox) && call1.locationBbox.length === 4 ? (call1.locationBbox as [number, number, number, number]) : null;
  const call1Description = typeof call1.description === "string" ? call1.description : "";

  const call2: Call2Result = await callModel({
    images: [{ path: baselineImagePath, label: "BASELINE (original) image:" }],
    systemInstruction: "You are a careful visual inspector confirming whether a specific location in a room's original photo shows an architectural opening.",
    userPrompt: buildCall2Prompt({ foundUnlistedOpening: true, location, locationBbox, description: call1Description }),
    ctx: { ...ctx, callLabel: "call2_baseline_confirm" },
  });

  return combineFabricatedOpeningVerdict({
    location,
    locationBbox,
    call1Description,
    presentInBaseline: call2?.presentInBaseline === true,
    call2Description: typeof call2?.description === "string" ? call2.description : "",
  });
}

// Deterministic, code-side combination — the actual "decision logic" this
// task asked for. Pure function, no network calls, so it can (and must, per
// this session's standing discipline) be unit-tested offline before any
// live call exercises it. The three branches match the task's own spec
// exactly: nothing flagged → clean; flagged + absent from baseline →
// fabricated; flagged + present in baseline → benign extraction miss.
export function combineFabricatedOpeningVerdict(params: {
  location: string;
  locationBbox: [number, number, number, number] | null;
  call1Description: string;
  presentInBaseline: boolean;
  call2Description: string;
}): FabricatedOpeningCheckResult {
  const { location, locationBbox, call1Description, presentInBaseline, call2Description } = params;

  if (!presentInBaseline) {
    const outcome: ValidatorOutcome = {
      status: "fail",
      reason: `opening_fabricated: new opening detected at ${location}, confirmed absent from baseline — staged: "${call1Description}" | baseline at same location: "${call2Description}"`,
      confidence: 0.85,
      hardFail: true,
      issueType: ISSUE_TYPES.OPENING_FABRICATED,
      issueTier: classifyIssueTier(ISSUE_TYPES.OPENING_FABRICATED),
      advisorySignals: [`opening_fabricated:${location}`],
    };
    return {
      ranCall1: true,
      ranCall2: true,
      flagged: true,
      location,
      locationBbox,
      call1Description,
      presentInBaseline,
      call2Description,
      verdict: "fabricated",
      outcome,
    };
  }

  // Baseline-extraction miss: the opening is real and was already there in
  // the baseline, just absent from the extracted list (the same kind of
  // wall-assignment instability already confirmed elsewhere this session).
  // Not a fabrication — pass. Per the task's explicit logic, this verdict
  // is also meant to override any conclusion the standard opening/envelope
  // checks may have separately reached about the same confused item, since
  // their confusion is downstream of the same missing baseline entry — the
  // caller (runOpeningEnvelopeValidator) is responsible for applying that
  // override using this result's location, since only it holds the
  // standard checks' own itemResults to reconcile against.
  const outcome: ValidatorOutcome = {
    status: "pass",
    reason: `fabricated_opening_check: unlisted opening at ${location} confirmed present in baseline too — baseline-extraction miss, not a fabrication — baseline: "${call2Description}"`,
    confidence: 0.7,
    hardFail: false,
    issueType: ISSUE_TYPES.NONE,
    issueTier: "none",
    advisorySignals: [`baseline_extraction_miss:${location}`],
  };
  return {
    ranCall1: true,
    ranCall2: true,
    flagged: true,
    location,
    locationBbox,
    call1Description,
    presentInBaseline,
    call2Description,
    verdict: "baseline_extraction_miss",
    outcome,
  };
}
