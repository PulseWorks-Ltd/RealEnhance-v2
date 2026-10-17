// Two-call fabricated-fixture detection — structural sibling of
// fabricatedOpeningCheck.ts (see that file's header for the full history/
// rationale of the two-call design), applied to AnchorFixtureType instead
// of StructuralOpeningType.
//
// MOTIVATING GAP (RealEnhance validator-scope audit, 2026-08-29, finding
// C2): fabricatedOpeningCheck.ts's own motivating incident (job_8505488a)
// was itself anchored on a wall-mounted HEATER FIXTURE used as the visual
// reference point for confirming the fabrication — the same underlying
// failure class (a fixed/structural element appearing with no baseline
// counterpart) applies identically to anchor fixtures (fireplaces,
// built-in cabinetry, kitchen islands, staircases, plumbing fixtures,
// light fixtures, AC/HVAC units, TV wall-mount brackets) as it does to
// openings — fixtureFlooringValidator.ts only ever re-examines fixtures
// that were already extracted from the baseline, exactly the same blind
// spot fabricatedOpeningCheck.ts was built to close for openings. This
// file closes the fixture-side half of that same gap.
//
// Same two-call structure as fabricatedOpeningCheck.ts:
// CALL 1 (list-compare, staged image only): given the full list of
// baseline fixture bboxes, ask whether the STAGED image shows any anchor
// fixture at a location not covered by that list.
// CALL 2 (single-location confirm, baseline image only): only run if call
// 1 flagged something — does this exact spot already show that kind of
// fixture in the baseline photo (a baseline-extraction miss, not a
// fabrication) or not (a genuine fabrication)?
//
// The combination of call 1 + call 2 into a verdict is deterministic,
// code-side logic (combineFabricatedFixtureVerdict below), mirroring
// combineFabricatedOpeningVerdict exactly.
import { toBase64 } from "../utils/images";
import { getGeminiClient } from "../ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../ai/grok";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { HUMAN_EYE_FRAMING, resolveValidatorModel } from "./occlusionVsRemovalCheck";
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline } from "./openingPreservationValidator";

const FABRICATED_FIXTURE_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

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
      reason: `fabricated_fixture_${params.ctx.callLabel}`,
      expectJson: true,
    });
    console.log(
      JSON.stringify({
        event: "GROK_VALIDATOR_USAGE",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: "validator",
        callLabel: `fabricated_fixture_${params.ctx.callLabel}`,
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
    model: FABRICATED_FIXTURE_MODEL,
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 2048, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: params.ctx.attempt ?? 1 },
    model: FABRICATED_FIXTURE_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });
  const responseParts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = responseParts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error(`FABRICATED_FIXTURE_CHECK[${params.ctx.callLabel}]: no text returned`);
  return extractJson(textPart.text);
}

type Call1Result = {
  foundUnlistedFixture: boolean;
  location: string;
  locationBbox: [number, number, number, number] | null;
  description: string;
};

type Call2Result = {
  presentInBaseline: boolean;
  description: string;
};

// Fixture vocabulary matches FIXTURE_SYSTEM_INSTRUCTION in
// fixtureFlooringValidator.ts exactly, so both files describe the same
// protected concept identically rather than drifting apart in wording.
const FIXTURE_VOCABULARY = "fireplace, built-in cabinetry, kitchen island, staircase, plumbing fixture, light fixture, AC/HVAC unit, or TV wall-mount bracket";

function buildCall1Prompt(baseline: StructuralBaseline): string {
  const bboxList = (baseline.anchorFixtures || [])
    .map((f) => `- ${formatBbox(f.bbox)}`)
    .join("\n");
  return `You are checking a STAGED (furnished) room photo for a NEW fixed anchor fixture — a ${FIXTURE_VOCABULARY} — that was NOT present in the original baseline photo of this exact room. Only genuine fixed/permanent installations count; ordinary movable furniture or decor (a floor lamp, a portable heater, a decorative shelf leaned against a wall) is never a match here, no matter how permanent it looks.

Below is the full list of fixture locations already known from the baseline photo, given only as bounding boxes (normalized fractions of image width/height, 0,0 = top-left). This list is deliberately NOT grouped by wall — treat each as an independent region:

${bboxList || "(no fixtures extracted from baseline)"}

Look at the STAGED image. Does it show any ${FIXTURE_VOCABULARY} — a genuine fixed/permanent installation, not movable furniture or decor — at a location that is NOT covered by any of the regions listed above?

${HUMAN_EYE_FRAMING}

If you find such a location, you MUST state exactly where — both in plain language (e.g. "right-hand wall, roughly waist height, beside the window") and as your own best-guess bounding box. Do not just answer yes/no.

Respond with ONLY a single valid JSON object:
{
  "foundUnlistedFixture": true|false,
  "location": "string — plain-language location, empty string if false",
  "locationBbox": [x1,y1,x2,y2] | null,
  "description": "string — what you see at that location, empty string if false"
}`;
}

function buildCall2Prompt(call1: Call1Result): string {
  return `You are looking at ONLY the ORIGINAL (baseline) photo of a room — no staged/furnished version is given here.

A specific location in this photo has been flagged for you to check: "${call1.location}"${call1.locationBbox ? ` (approximate region: ${formatBbox(call1.locationBbox)})` : ""}.

Look carefully at exactly this location in the baseline photo. Does this exact spot already show a ${FIXTURE_VOCABULARY} — as opposed to plain wall, floor, or ordinary movable furniture?

${HUMAN_EYE_FRAMING}

Respond with ONLY a single valid JSON object:
{
  "presentInBaseline": true|false,
  "description": "string — what you actually see at this location in the baseline photo"
}`;
}

export type FabricatedFixtureCheckResult = {
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
  reason: "fabricated_fixture_check: no unlisted fixture detected",
  confidence: 0.85,
  hardFail: false,
  issueType: ISSUE_TYPES.NONE,
  issueTier: "none",
  advisorySignals: [],
};

export async function runFabricatedFixtureCheck(
  baselineImagePath: string,
  stagedImagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<FabricatedFixtureCheckResult> {
  const call1: Call1Result = await callModel({
    images: [{ path: stagedImagePath, label: "STAGED (furnished) image:" }],
    systemInstruction: "You are a careful visual inspector checking a furnished room photo for fixed installations not present in the original room.",
    userPrompt: buildCall1Prompt(baseline),
    ctx: { ...ctx, callLabel: "call1_list_compare" },
  });

  if (!call1?.foundUnlistedFixture) {
    return { ranCall1: true, ranCall2: false, flagged: false, verdict: "clean", outcome: CLEAN_OUTCOME };
  }

  const location = typeof call1.location === "string" ? call1.location : "(unspecified location)";
  const locationBbox = Array.isArray(call1.locationBbox) && call1.locationBbox.length === 4 ? (call1.locationBbox as [number, number, number, number]) : null;
  const call1Description = typeof call1.description === "string" ? call1.description : "";

  const call2: Call2Result = await callModel({
    images: [{ path: baselineImagePath, label: "BASELINE (original) image:" }],
    systemInstruction: "You are a careful visual inspector confirming whether a specific location in a room's original photo shows a fixed anchor fixture.",
    userPrompt: buildCall2Prompt({ foundUnlistedFixture: true, location, locationBbox, description: call1Description }),
    ctx: { ...ctx, callLabel: "call2_baseline_confirm" },
  });

  return combineFabricatedFixtureVerdict({
    location,
    locationBbox,
    call1Description,
    presentInBaseline: call2?.presentInBaseline === true,
    call2Description: typeof call2?.description === "string" ? call2.description : "",
  });
}

// Deterministic, code-side combination — mirrors combineFabricatedOpeningVerdict
// exactly. Pure function, no network calls, unit-testable offline.
export function combineFabricatedFixtureVerdict(params: {
  location: string;
  locationBbox: [number, number, number, number] | null;
  call1Description: string;
  presentInBaseline: boolean;
  call2Description: string;
}): FabricatedFixtureCheckResult {
  const { location, locationBbox, call1Description, presentInBaseline, call2Description } = params;

  if (!presentInBaseline) {
    const outcome: ValidatorOutcome = {
      status: "fail",
      reason: `fixture_fabricated: new fixture detected at ${location}, confirmed absent from baseline — staged: "${call1Description}" | baseline at same location: "${call2Description}"`,
      confidence: 0.85,
      hardFail: true,
      issueType: ISSUE_TYPES.FIXTURE_FABRICATED,
      issueTier: classifyIssueTier(ISSUE_TYPES.FIXTURE_FABRICATED),
      advisorySignals: [`fixture_fabricated:${location}`],
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

  // Baseline-extraction miss: the fixture is real and was already there in
  // the baseline, just absent from the extracted list. Not a fabrication —
  // pass. The caller (runFixtureFlooringValidator) is responsible for
  // applying the same overlap-scoped rescue openingEnvelopeValidator.ts
  // uses, so this verdict alone never blindly discards an already-correct
  // standard-check failure on an unrelated item.
  const outcome: ValidatorOutcome = {
    status: "pass",
    reason: `fabricated_fixture_check: unlisted fixture at ${location} confirmed present in baseline too — baseline-extraction miss, not a fabrication — baseline: "${call2Description}"`,
    confidence: 0.7,
    hardFail: false,
    issueType: ISSUE_TYPES.NONE,
    issueTier: "none",
    advisorySignals: [`fixture_baseline_extraction_miss:${location}`],
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
