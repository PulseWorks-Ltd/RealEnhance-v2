// PART 2 mechanism: relative-landmark comparison instead of raw bbox
// subtraction. Motivated by Part 1's finding (see conversation record): the
// POSITION dimension showed real stability in landmark-relative language
// (3e255f88's "left of the other ceiling light" held consistently across
// both single-image calls and all 3 runs), but the SIZE dimension showed
// the same underlying perceptual inconsistency just expressed differently —
// f53669f1's window was read as reaching each curtain's OUTER fold in the
// baseline call and only its INNER side in the staged call, consistently,
// across all 3 runs. Expectation set BEFORE running live data: this should
// help repositioned-detection more than resized-detection, since the
// resized failure looks like a genuine single-image boundary-perception
// problem that landmark-relative framing doesn't obviously fix — tested
// anyway rather than assumed, same discipline as everything else tonight.
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

export type RelativeLandmarkObservation = {
  identifiedItemDescription: string;
  primaryLandmark: string;
  relativePosition: string;
  secondLandmark: string;
  relativeExtentFraction: number | null;
};

function buildPrompt(semanticRef: string): string {
  return `Look at THIS photo (only this one photo — no other photo is given to you). Find this item: ${semanticRef}

Answer, for this photo only:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. primaryLandmark — Name ONE single, distinctive, unambiguous fixed reference point near this item that you could reliably point to again in another photo of this same room — prefer something structurally unique (a specific corner, a doorway, a switch plate, a curtain rod bracket) over something that might be confused with a duplicate (for example, if there are two identical ceiling lights, do NOT use "the other ceiling light" — pick something else unique instead, like "the back-right room corner" or "the ceiling-wall junction above the window").

3. relativePosition — Describe this item's position relative to that ONE landmark only: which direction (left/right/above/below/same spot) and roughly how far (touching / very close / a short distance / far).

4. secondLandmark — Name a SECOND fixed reference point, on the roughly opposite side of the item from the first landmark (e.g. if primaryLandmark is to the item's left, name something fixed to its right).

5. relativeExtentFraction — Does the item's own visible extent span the FULL distance between primaryLandmark and secondLandmark, about half of it, less than half, or does it extend beyond both? Give your best single number from 0 to 1, where 1.0 means the item's own edges span the complete distance between those two landmarks, and 0.5 means it spans about half that distance.

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "primaryLandmark": "string",
  "relativePosition": "string",
  "secondLandmark": "string",
  "relativeExtentFraction": number
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function observeRelativeLandmark(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<RelativeLandmarkObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }
  const prompt = buildPrompt(params.semanticRef);
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector describing precisely where one item is located in a single room photo, using nearby fixed reference points.\n\n${prompt}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `relative_landmark_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `relative_landmark_${params.ctx.callLabel}`, model: grokVisionModel() }));
  const raw = extractJson(text);
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    primaryLandmark: typeof raw?.primaryLandmark === "string" ? raw.primaryLandmark : "",
    relativePosition: typeof raw?.relativePosition === "string" ? raw.relativePosition : "",
    secondLandmark: typeof raw?.secondLandmark === "string" ? raw.secondLandmark : "",
    relativeExtentFraction: typeof raw?.relativeExtentFraction === "number" ? raw.relativeExtentFraction : null,
  };
}

export type RelativeLandmarkVerdict = {
  comparable: boolean;
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

// Simple, inspectable word-overlap check — not fuzzy matching, deliberately:
// this file's whole job is a transparent, deterministic decision, same
// design philosophy as occlusionVsRemovalCheck.ts's pattern classifiers.
function landmarksMatch(a: string, b: string): boolean {
  const wordsA = new Set(
    String(a || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["that", "this", "near", "with", "wall", "room", "photo"].includes(w))
  );
  const wordsB = new Set(
    String(b || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["that", "this", "near", "with", "wall", "room", "photo"].includes(w))
  );
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap >= 1;
}

// Pure, deterministic, offline-testable — mirrors compareSingleImageObservations's
// role in singleImageResizeCheck.ts, but the inputs are now landmark-relative
// statements rather than independently-estimated bbox coordinates.
export function compareRelativeLandmarkObservations(
  baseline: RelativeLandmarkObservation,
  staged: RelativeLandmarkObservation,
  opts: { extentThresholdPct?: number } = {}
): RelativeLandmarkVerdict {
  const extentThresholdPct = opts.extentThresholdPct ?? 25;

  const primaryMatches = landmarksMatch(baseline.primaryLandmark, staged.primaryLandmark);
  if (!primaryMatches) {
    return {
      comparable: false,
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: "landmark_mismatch: baseline and staged calls did not reference the same primary landmark, so position/extent are not directly comparable — defaulting to not-flagged (ambiguous evidence, same safe-default philosophy as every other classifier tonight)",
    };
  }

  const baseDirs = extractDirections(baseline.relativePosition);
  const stagedDirs = extractDirections(staged.relativePosition);
  let positionDirectionChanged: boolean | null = null;
  if (baseDirs.length > 0 && stagedDirs.length > 0) {
    const sameSpotClaimed = stagedDirs.includes("same spot") || baseDirs.includes("same spot");
    const anyOverlap = baseDirs.some((d) => stagedDirs.includes(d));
    positionDirectionChanged = !sameSpotClaimed && !anyOverlap;
  }
  const repositioned = positionDirectionChanged === true;

  let extentDeltaPct: number | null = null;
  if (typeof baseline.relativeExtentFraction === "number" && typeof staged.relativeExtentFraction === "number" && baseline.relativeExtentFraction > 0) {
    extentDeltaPct = ((staged.relativeExtentFraction - baseline.relativeExtentFraction) / baseline.relativeExtentFraction) * 100;
  }
  const resized = extentDeltaPct !== null && Math.abs(extentDeltaPct) >= extentThresholdPct;

  return {
    comparable: true,
    resized,
    repositioned,
    extentDeltaPct,
    positionDirectionChanged,
    reason: `extentDeltaPct=${extentDeltaPct === null ? "n/a" : extentDeltaPct.toFixed(1) + "%"} positionDirectionChanged=${positionDirectionChanged} (baseDirs=[${baseDirs.join(",")}] stagedDirs=[${stagedDirs.join(",")}]) landmarks=(${baseline.primaryLandmark} | ${staged.primaryLandmark})`,
  };
}
