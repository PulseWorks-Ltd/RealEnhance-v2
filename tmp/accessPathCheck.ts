// Part A of the user's latest request: decompose the single "clearanceDescription
// + accessBlocked" tri-state field (tmp/accessBlockedCheck.ts) into two explicit,
// separately-answered sub-questions — "does the furniture block the ENTIRE
// path?" and "is there still walkway access?" — combined deterministically in
// code, and test with Gemini's own visual judgment (not just Grok), since the
// prior file's noisy 2/3-vs-1/3 signal was only ever measured with Grok. This
// is a NEW file, not an edit to accessBlockedCheck.ts, specifically so the old
// (already-measured) signal remains available as a fixed comparison baseline.
//
// First new mechanism tonight with a genuine, working Gemini call path (every
// other new mechanism was Grok-only) — the Gemini branch is ported directly
// from the proven, already-in-this-file-tree pattern in
// occlusionVsRemovalCheck.ts's runOcclusionObservationCall, adapted for a
// single image instead of two.
import { toBase64 } from "../worker/src/utils/images";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { logGeminiUsage } from "../worker/src/ai/usageTelemetry";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

const ACCESS_PATH_GEMINI_MODEL = String(process.env.ACCESS_PATH_VALIDATOR_MODEL || "gemini-2.5-pro");

// Per explicit user scoping (unchanged from accessBlockedCheck.ts): applies
// to any opening type that requires physical access/passage.
const ACCESS_TYPE_APPLICABLE = new Set(["door", "closet_door", "walkthrough"]);
export function isAccessCheckApplicable(itemType: string): boolean {
  return ACCESS_TYPE_APPLICABLE.has(String(itemType || "").toLowerCase());
}

export type AccessPathTriState = "yes" | "no" | "cannot_tell";

export type AccessPathObservation = {
  clearanceDescription: string;
  blocksEntirePathState: AccessPathTriState;
  hasWalkwayAccessState: AccessPathTriState;
};

function buildPrompt(semanticRef: string): string {
  return `This location is expected to be an opening that provides passage between spaces (a door, closet door, or walkthrough) — specifically: ${semanticRef}

Look at THIS photo (only this one photo) at this location.

1. clearanceDescription — Describe concretely what is on the floor and in the space directly in front of, or across, this location right now. Name specifically what (if anything) occupies that space, roughly how much of the opening's own width/footprint it covers, and whether any gap or side clearance remains next to it.

2. blocksEntirePathState — Does whatever is described above span the ENTIRE width of this opening's own operable path (its full swing arc if hinged, or its full slide track if sliding), leaving no gap anywhere along it? Answer exactly one of: "yes" (the full path is covered end-to-end, no gap anywhere), "no" (any meaningful unobstructed portion remains anywhere along it), "cannot_tell" (you cannot confidently judge the full width from this photo).

3. hasWalkwayAccessState — Independent of the above: could a person actually walk up to and stand directly in front of this opening without first moving anything? Answer exactly one of: "yes" (the immediate approach floor space is clear), "no" (furniture/another object occupies that immediate approach space), "cannot_tell" (you cannot confidently judge this from the photo).

Respond with ONLY a single valid JSON object:
{
  "clearanceDescription": "string",
  "blocksEntirePathState": "yes" | "no" | "cannot_tell",
  "hasWalkwayAccessState": "yes" | "no" | "cannot_tell"
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function observeAccessPath(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string; attempt?: number };
}): Promise<AccessPathObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  const systemInstruction = "You are a careful visual inspector judging whether a specific opening in a room photo is physically accessible or blocked by furniture placement.";
  const userPrompt = buildPrompt(params.semanticRef);
  const requestStartedAt = Date.now();

  let raw: any;
  if (validatorModel === "grok") {
    const text = await grokAnalyzeImages({
      images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
      prompt: `${systemInstruction}\n\n${userPrompt}`,
      jobId: params.ctx.jobId,
      imageId: params.ctx.imageId,
      reason: `access_path_${params.ctx.callLabel}`,
      expectJson: true,
    });
    console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `access_path_${params.ctx.callLabel}`, model: grokVisionModel() }));
    raw = extractJson(text);
  } else {
    const ai = getGeminiClient();
    const response: any = await (ai as any).models.generateContent({
      model: ACCESS_PATH_GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: systemInstruction }, { text: userPrompt }, { text: "Photo:" }, { inlineData: { mimeType: loaded.mime, data: loaded.data } }],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 1024, responseMimeType: "application/json" },
    });
    logGeminiUsage({
      ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: params.ctx.attempt ?? 1 },
      model: ACCESS_PATH_GEMINI_MODEL,
      callType: "validator",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });
    const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p: any) => typeof p?.text === "string");
    if (!textPart) throw new Error(`ACCESS_PATH[${params.ctx.callLabel}]: no text returned`);
    raw = extractJson(textPart.text);
  }

  const triStateEnum = ["yes", "no", "cannot_tell"];
  return {
    clearanceDescription: typeof raw?.clearanceDescription === "string" ? raw.clearanceDescription : "",
    blocksEntirePathState: triStateEnum.includes(raw?.blocksEntirePathState) ? raw.blocksEntirePathState : "cannot_tell",
    hasWalkwayAccessState: triStateEnum.includes(raw?.hasWalkwayAccessState) ? raw.hasWalkwayAccessState : "cannot_tell",
  };
}

export type AccessPathVerdict = {
  verdict: "fail_access_blocked" | "inconclusive_conflicting_signals" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. AND-logic: only fails when BOTH
// sub-answers agree the path is unusable (blocksEntirePath=yes AND
// hasWalkwayAccess=no). Disagreement between the two (yes/yes or no/no) is
// treated as self-contradictory model output, not evidence either way —
// inconclusive, not a fail. Any "cannot_tell" on either field is also
// inconclusive. This is deliberately more conservative than OR-logic: two
// independently-noisy binary signals combined with OR would make false
// positives MORE likely, and the prior single-field version's problem was
// not just under-catching Bedroom 02 but ALSO over-catching Bedroom 11
// FIXED (a confirmed-clean case) — AND-logic is the safer default given
// that prior evidence.
export function evaluateAccessPath(itemType: string, observation: AccessPathObservation): AccessPathVerdict {
  if (!isAccessCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" does not require physical access — this check does not apply` };
  }

  const { blocksEntirePathState: blocks, hasWalkwayAccessState: access } = observation;

  if (blocks === "cannot_tell" || access === "cannot_tell") {
    return { verdict: "inconclusive_conflicting_signals", reason: `at least one sub-answer was "cannot_tell" (blocksEntirePath=${blocks}, hasWalkwayAccess=${access}) — defaulting to not-flagged` };
  }

  if (blocks === "yes" && access === "no") {
    return { verdict: "fail_access_blocked", reason: `both signals agree the path is unusable: blocksEntirePath=yes, hasWalkwayAccess=no — "${observation.clearanceDescription}"` };
  }

  if (blocks === "no" && access === "yes") {
    return { verdict: "pass", reason: `both signals agree the path is clear: blocksEntirePath=no, hasWalkwayAccess=yes — "${observation.clearanceDescription}"` };
  }

  // Only "yes/yes" (claims the path is fully blocked AND that walkway
  // access remains) or "no/no" (claims neither) can reach this point — both
  // are self-contradictory combinations, since a fully-blocked path and
  // clear walkway access can't both be true, and "not fully blocked" would
  // ordinarily still leave SOME access. Not trusted as evidence either way.
  return {
    verdict: "inconclusive_conflicting_signals",
    reason: `sub-answers disagree (blocksEntirePath=${blocks}, hasWalkwayAccess=${access}) — self-contradictory, not trusted as evidence either way, defaulting to not-flagged`,
  };
}
