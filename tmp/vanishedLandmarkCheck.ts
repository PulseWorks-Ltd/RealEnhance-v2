// Redefines the relative-landmark mechanism's success criterion per explicit
// user direction: the goal is not narrowly "did this item resize/relocate"
// but "is there any structural inconsistency between baseline and staged,
// including a reference landmark itself vanishing without explanation."
//
// Fixes the specific failure found in the last task's Part 2 test: call 2
// (staged) previously picked its OWN landmark independently, so when the
// baseline's landmark (e.g. an AC unit) had genuinely been removed, the
// staged call just silently substituted a different valid landmark instead
// of ever confirming the original one's absence — turning a real, catchable
// violation into a discarded "not comparable" result. Now call 2 is given
// call 1's EXACT landmark and must explicitly confirm presence/absence of
// THAT SPECIFIC one before anything else — a genuine, confirmed absence is
// now a conclusive fail signal, not a discard.
//
// Three explicit landmark eligibility rules (stated separately in the
// prompt, not compressed into one instruction), per explicit user spec:
//   1. SAME PLANE — a wall item may only be anchored to wall-plane
//      landmarks (not ceiling/floor items), and the equivalent for
//      ceiling/floor items.
//   2. STRUCTURAL & PERMANENT — only openings (door/window/walkthrough),
//      wall corners, AC/HVAC units, built-in fixtures, and built-in
//      cabinetry/joinery are eligible. Lights, art, decor, furniture, and
//      plants are explicitly excluded — not guaranteed to survive staging.
//   3. UNIQUELY IDENTIFIABLE — landmark types that commonly recur multiple
//      times in one room (downlights are the motivating example) are
//      excluded unless the model can unambiguously distinguish the specific
//      instance.
//
// New false-positive risk this design introduces, and the guard against it:
// a valid landmark can be OCCLUDED by new staging furniture without being
// structurally removed. The staged call is required to DESCRIBE what is at
// the landmark's exact location before answering, and must choose between
// three states — "yes" (structurally present, possibly partly hidden by
// movable furniture/decor), "no" (genuinely gone — the wall/ceiling/floor
// is now continuous/different, no trace of it), or "cannot_tell"
// (completely blocked, genuinely undeterminable) — mirroring the
// locate-and-describe-before-concluding discipline used everywhere else
// this session specifically to prevent this class of false positive.
// Critically: only an explicit "no" is a fail signal. "cannot_tell" is
// deliberately NOT a fail signal (safe default on ambiguity, same
// philosophy as every classifier in occlusionVsRemovalCheck.ts).
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

const ELIGIBILITY_RULES = `Any landmark you name below (primary or second) MUST follow ALL THREE of these rules:

RULE 1 — SAME PLANE: the landmark must be on the SAME plane as the item itself. If the item is on a WALL, the landmark must also be a wall-plane feature (not a ceiling light, not a floor rug). If the item is on the CEILING, the landmark must also be a ceiling-plane feature. If the item is on the FLOOR, the landmark must also be a floor-plane feature.

RULE 2 — STRUCTURAL AND PERMANENT: the landmark must be ONE of these types ONLY: a door, window, or walkthrough opening; a wall corner (where two walls meet); an AC/HVAC unit; a built-in fixture; built-in cabinetry or joinery. Do NOT use a light fixture, artwork, decor, furniture, or a plant as a landmark — these can be added, removed, or rearranged during staging and are not reliable structural references.

RULE 3 — UNIQUELY IDENTIFIABLE: the landmark must be singular/unambiguous in this room. Do NOT use a landmark type that commonly appears multiple times in the same room (for example, a downlight/recessed ceiling light — a room usually has several, so "the downlight" does not reliably refer to one specific object). If there are two or more of something, either name a way to distinguish that exact one unambiguously (e.g. "the corner where the back wall meets the LEFT side wall", not just "a corner"), or pick a different, genuinely singular landmark instead.`;

export type LandmarkChoiceObservation = {
  identifiedItemDescription: string;
  itemPlane: "wall" | "ceiling" | "floor" | "unknown";
  primaryLandmark: string;
  relativePosition: string;
  secondLandmark: string;
  relativeExtentFraction: number | null;
};

function buildChoicePrompt(semanticRef: string): string {
  return `Look at THIS photo (only this one photo — no other photo is given to you). Find this item: ${semanticRef}

Answer, for this photo only:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. itemPlane — Is this item on a "wall", the "ceiling", or the "floor"?

${ELIGIBILITY_RULES}

3. primaryLandmark — Name ONE eligible landmark (per the three rules above) near this item. State it clearly enough that someone could look for that exact same landmark again in a different photo of this room.

4. relativePosition — Describe this item's position relative to primaryLandmark only: which direction (left/right/above/below/same spot) and roughly how far (touching / very close / a short distance / far).

5. secondLandmark — Name a SECOND eligible landmark (same three rules), on the roughly opposite side of the item from primaryLandmark.

6. relativeExtentFraction — Does the item's own visible extent span the FULL distance between primaryLandmark and secondLandmark, about half, less than half, or does it extend beyond both? Give your best single number from 0 to 1 (1.0 = spans the complete distance, 0.5 = about half).

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "itemPlane": "wall" | "ceiling" | "floor",
  "primaryLandmark": "string",
  "relativePosition": "string",
  "secondLandmark": "string",
  "relativeExtentFraction": number
}`;
}

export type LandmarkConfirmationObservation = {
  identifiedItemDescription: string;
  primaryLandmarkLocationDescription: string;
  primaryLandmarkStillPresent: "yes" | "no" | "cannot_tell";
  relativePosition: string | null;
  secondLandmarkLocationDescription: string | null;
  secondLandmarkStillPresent: "yes" | "no" | "cannot_tell" | null;
  relativeExtentFraction: number | null;
  whatOccupiesLandmarkLocationNow: string | null;
};

function buildConfirmationPrompt(semanticRef: string, primaryLandmark: string, secondLandmark: string): string {
  return `You are looking at ONE photo (only this one — no other photo is given to you). In an EARLIER, SEPARATE examination of a DIFFERENT (baseline) photo of what should be the same room, these two specific reference landmarks were identified — chosen because they are structural, permanent, and singular features (not decor or furniture):
  - primary landmark: "${primaryLandmark}"
  - second landmark: "${secondLandmark}"

Find this item: ${semanticRef}

Answer, for THIS photo only:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. primaryLandmarkLocationDescription — Look specifically at the exact location where "${primaryLandmark}" should be. Describe concretely and specifically what is visible at that exact location in THIS photo right now — do not just answer yes or no yet. For example: "plain painted wall there, no trace of it" / "partially hidden behind a new nightstand but its top edge and one side are still clearly visible" / "completely blocked by a large wardrobe placed directly in front of that spot, cannot tell if it's still there."

3. primaryLandmarkStillPresent — Based on that description, is "${primaryLandmark}" itself STRUCTURALLY still there? Answer exactly one of: "yes" (structurally present, even if partly hidden by movable furniture/decor), "no" (genuinely gone — that part of the wall/ceiling/floor is now continuous or different, with no trace of it — not just blocked by something new), or "cannot_tell" (completely blocked from view, genuinely unable to determine either way).

4. relativePosition — ONLY IF primaryLandmarkStillPresent is "yes": describe the item's position relative to THAT SAME landmark (direction + distance), so it can be directly compared to how it was described relative to this landmark in the baseline photo. If primaryLandmarkStillPresent is "no" or "cannot_tell", set this to null.

5. secondLandmarkLocationDescription and secondLandmarkStillPresent — Same idea, for "${secondLandmark}": describe what's at its exact expected location first, then classify as "yes"/"no"/"cannot_tell" using the same definitions as above.

6. relativeExtentFraction — ONLY IF BOTH landmarks are "yes": does the item's own visible extent span the full distance between them, about half, less, or beyond both? Best single number 0 to 1. Otherwise null.

7. whatOccupiesLandmarkLocationNow — ONLY IF primaryLandmarkStillPresent is "no": briefly describe what currently occupies that location instead (e.g. "plain continuous painted wall", "a section of the same flooring/carpet as the rest of the room"). Otherwise null.

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "primaryLandmarkLocationDescription": "string",
  "primaryLandmarkStillPresent": "yes" | "no" | "cannot_tell",
  "relativePosition": "string" | null,
  "secondLandmarkLocationDescription": "string" | null,
  "secondLandmarkStillPresent": "yes" | "no" | "cannot_tell" | null,
  "relativeExtentFraction": number | null,
  "whatOccupiesLandmarkLocationNow": "string" | null
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function callGrokSingleImage(params: { imagePath: string; prompt: string; ctx: { jobId: string; imageId: string; callLabel: string } }): Promise<any> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector describing precisely where one item is located in a single room photo, using nearby fixed structural reference points.\n\n${params.prompt}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `vanished_landmark_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `vanished_landmark_${params.ctx.callLabel}`, model: grokVisionModel() }));
  return extractJson(text);
}

export async function observeLandmarkChoice(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<LandmarkChoiceObservation> {
  const raw = await callGrokSingleImage({ imagePath: params.imagePath, prompt: buildChoicePrompt(params.semanticRef), ctx: params.ctx });
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    itemPlane: ["wall", "ceiling", "floor"].includes(raw?.itemPlane) ? raw.itemPlane : "unknown",
    primaryLandmark: typeof raw?.primaryLandmark === "string" ? raw.primaryLandmark : "",
    relativePosition: typeof raw?.relativePosition === "string" ? raw.relativePosition : "",
    secondLandmark: typeof raw?.secondLandmark === "string" ? raw.secondLandmark : "",
    relativeExtentFraction: typeof raw?.relativeExtentFraction === "number" ? raw.relativeExtentFraction : null,
  };
}

export async function observeLandmarkConfirmation(params: {
  imagePath: string;
  semanticRef: string;
  primaryLandmark: string;
  secondLandmark: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<LandmarkConfirmationObservation> {
  const raw = await callGrokSingleImage({
    imagePath: params.imagePath,
    prompt: buildConfirmationPrompt(params.semanticRef, params.primaryLandmark, params.secondLandmark),
    ctx: params.ctx,
  });
  const presentEnum = ["yes", "no", "cannot_tell"];
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    primaryLandmarkLocationDescription: typeof raw?.primaryLandmarkLocationDescription === "string" ? raw.primaryLandmarkLocationDescription : "",
    primaryLandmarkStillPresent: presentEnum.includes(raw?.primaryLandmarkStillPresent) ? raw.primaryLandmarkStillPresent : "cannot_tell",
    relativePosition: typeof raw?.relativePosition === "string" ? raw.relativePosition : null,
    secondLandmarkLocationDescription: typeof raw?.secondLandmarkLocationDescription === "string" ? raw.secondLandmarkLocationDescription : null,
    secondLandmarkStillPresent: presentEnum.includes(raw?.secondLandmarkStillPresent) ? raw.secondLandmarkStillPresent : null,
    relativeExtentFraction: typeof raw?.relativeExtentFraction === "number" ? raw.relativeExtentFraction : null,
    whatOccupiesLandmarkLocationNow: typeof raw?.whatOccupiesLandmarkLocationNow === "string" ? raw.whatOccupiesLandmarkLocationNow : null,
  };
}

export type VanishedLandmarkVerdict = {
  verdict: "fail_vanished_landmark" | "fail_resized" | "fail_repositioned" | "inconclusive_occluded" | "pass";
  vanishedLandmark: "primary" | "second" | null;
  resized: boolean;
  repositioned: boolean;
  extentDeltaPct: number | null;
  positionDirectionChanged: boolean | null;
  reason: string;
};

const DIRECTION_WORDS = ["left", "right", "above", "below", "same spot", "same position"];
function extractDirections(text: string): string[] {
  const t = ` ${String(text || "").toLowerCase()} `;
  const found: string[] = [];
  for (const w of DIRECTION_WORDS) {
    if (t.includes(w)) found.push(w === "same position" ? "same spot" : w);
  }
  return Array.from(new Set(found));
}

// Pure, deterministic, offline-testable. A confirmed ("no") vanished
// landmark is now a CONCLUSIVE FAIL — the whole point of this redesign —
// not a discarded/inconclusive result. "cannot_tell" is deliberately NOT a
// fail (guards against the new occlusion-vs-removal false-positive risk
// this design introduces at the landmark level).
export function compareVanishedLandmarkObservations(
  baseline: LandmarkChoiceObservation,
  staged: LandmarkConfirmationObservation,
  opts: { extentThresholdPct?: number } = {}
): VanishedLandmarkVerdict {
  const extentThresholdPct = opts.extentThresholdPct ?? 25;

  if (staged.primaryLandmarkStillPresent === "no") {
    return {
      verdict: "fail_vanished_landmark",
      vanishedLandmark: "primary",
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `primary landmark "${baseline.primaryLandmark}" was explicitly confirmed absent in the staged photo (searched for specifically, not found) — now occupied by: ${staged.whatOccupiesLandmarkLocationNow || "(not described)"}`,
    };
  }

  if (staged.primaryLandmarkStillPresent === "cannot_tell") {
    return {
      verdict: "inconclusive_occluded",
      vanishedLandmark: null,
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `primary landmark "${baseline.primaryLandmark}" could not be confirmed present or absent (occluded by new furniture/decor) — deliberately not treated as a fail, to avoid an occlusion-vs-removal false positive at the landmark level`,
    };
  }

  // primaryLandmarkStillPresent === "yes" from here on
  if (staged.secondLandmarkStillPresent === "no") {
    return {
      verdict: "fail_vanished_landmark",
      vanishedLandmark: "second",
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `second landmark "${baseline.secondLandmark}" was explicitly confirmed absent in the staged photo (searched for specifically, not found)`,
    };
  }

  // BUG FIX (found live-testing the fallback task): this branch previously
  // only existed for the PRIMARY landmark's cannot_tell case — the second
  // landmark's cannot_tell silently fell through to the extent-comparison
  // code below, where `resized` defaults to `false` when extentDeltaPct
  // can't be computed. That made "couldn't measure the extent because the
  // second landmark is out of frame" indistinguishable from "measured and
  // found no size change," which is exactly backwards per this function's
  // own documented intent (cannot_tell must never silently resolve as
  // effectively-unchanged) and is what silently prevented the vanish-check
  // + fallback task's fallback path from ever triggering on Bedroom 09,
  // where 2 of 3 runs hit this exact case.
  if (staged.secondLandmarkStillPresent === "cannot_tell") {
    return {
      verdict: "inconclusive_occluded",
      vanishedLandmark: null,
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `second landmark "${baseline.secondLandmark}" could not be confirmed present or absent (occluded, or out of the staged photo's frame) — deliberately not treated as a fail, and extent cannot be measured without it`,
    };
  }

  const baseDirs = extractDirections(baseline.relativePosition);
  const stagedDirs = extractDirections(staged.relativePosition || "");
  let positionDirectionChanged: boolean | null = null;
  if (baseDirs.length > 0 && stagedDirs.length > 0) {
    const sameSpotClaimed = stagedDirs.includes("same spot") || baseDirs.includes("same spot");
    const anyOverlap = baseDirs.some((d) => stagedDirs.includes(d));
    positionDirectionChanged = !sameSpotClaimed && !anyOverlap;
  }
  const repositioned = positionDirectionChanged === true;

  let extentDeltaPct: number | null = null;
  let resized = false;
  if (staged.secondLandmarkStillPresent === "yes" && typeof baseline.relativeExtentFraction === "number" && typeof staged.relativeExtentFraction === "number" && baseline.relativeExtentFraction > 0) {
    extentDeltaPct = ((staged.relativeExtentFraction - baseline.relativeExtentFraction) / baseline.relativeExtentFraction) * 100;
    resized = Math.abs(extentDeltaPct) >= extentThresholdPct;
  }

  const verdict: VanishedLandmarkVerdict["verdict"] = resized ? "fail_resized" : repositioned ? "fail_repositioned" : "pass";

  return {
    verdict,
    vanishedLandmark: null,
    resized,
    repositioned,
    extentDeltaPct,
    positionDirectionChanged,
    reason: `both landmarks confirmed present; extentDeltaPct=${extentDeltaPct === null ? "n/a" : extentDeltaPct.toFixed(1) + "%"} positionDirectionChanged=${positionDirectionChanged} (baseDirs=[${baseDirs.join(",")}] stagedDirs=[${stagedDirs.join(",")}])`,
  };
}
