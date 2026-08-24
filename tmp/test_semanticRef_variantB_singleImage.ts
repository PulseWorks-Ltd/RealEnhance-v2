// VARIANT B — semantic reference + single-image-two-call.
// STANDALONE. Reuses compareSingleImageObservations from the last task's
// singleImageResizeCheck.ts UNCHANGED (already offline-verified, pure,
// deterministic) — the only thing that changes is the single-image
// observation call's INPUT pointer: no bbox coordinates anywhere in the
// prompt, only the same rich semantic description used in Variant A
// (semanticItemRef.ts). Each call still shows exactly ONE photo and asks
// the model for its own bboxEstimate OUTPUT (needed for the deterministic
// comparison) — only the pointer that tells it where/what to look for
// changes from coordinates to natural-language identity + landmarks.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";
import { toBase64 } from "../worker/src/utils/images";
import { compareSingleImageObservations, type SingleImageObservation } from "./singleImageResizeCheck";
import { buildSemanticReference, pickLargestOpening, pickLargestFixture, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

type SemanticObservation = SingleImageObservation & { identifiedItemDescription: string };

function buildSemanticSingleImagePrompt(semanticRef: string): string {
  return `Look at THIS photo (only this one photo — no other photo is given to you). Find this item: ${semanticRef}

Answer, for this photo only:

1. identifiedItemDescription — Briefly state, in your own words, what item you actually find matching that description in THIS photo, and roughly where. If you cannot find it at all, say so plainly.

2. referencePoints — What fixed architectural reference points are visible nearby that could be used to precisely judge position — a ceiling light fixture, a doorway, a room corner, a switch plate, a curtain rod bracket, etc.? Name them and roughly where they are in this photo.

3. boundaryDescription — Using those reference points as anchors, describe precisely where this item's OWN edges actually are in THIS photo.

4. bboxEstimate — Your own best concrete estimate of this item's own bounding box AS YOU SEE IT IN THIS PHOTO, as normalized fractions of the image width/height (0,0 = top-left, 1,1 = bottom-right): [x1, y1, x2, y2].

5. touchesFrameEdge — Does the item's own visible extent touch the edge of the photo frame? Answer "none" or a comma-separated list of "top","bottom","left","right".

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "referencePoints": "string",
  "boundaryDescription": "string",
  "bboxEstimate": [x1, y1, x2, y2],
  "touchesFrameEdge": "string"
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function observeSingleImageSemantic(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<SemanticObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }
  const prompt = buildSemanticSingleImagePrompt(params.semanticRef);
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector describing precisely where one item is located in a single room photo, using nearby fixed reference points.\n\n${prompt}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `semantic_ref_variantB_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `semantic_ref_variantB_${params.ctx.callLabel}`, model: grokVisionModel() }));
  const raw = extractJson(text);
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    referencePoints: typeof raw?.referencePoints === "string" ? raw.referencePoints : "",
    boundaryDescription: typeof raw?.boundaryDescription === "string" ? raw.boundaryDescription : "",
    bboxEstimate: Array.isArray(raw?.bboxEstimate) && raw.bboxEstimate.length === 4 ? (raw.bboxEstimate as [number, number, number, number]) : null,
    touchesFrameEdge: typeof raw?.touchesFrameEdge === "string" ? raw.touchesFrameEdge : "unknown",
  };
}

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
  expectFlagged: boolean;
};

const CASES: Case[] = [
  {
    label: "Bedroom 09 window (KNOWN GENUINE RESIZE — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 09.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 09 (Enhanced).webp"),
    jobId: "vb-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: true,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN GENUINE RESIZE/RELOCATION — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "vb-b12-door",
    pick: (b) => pickLargestOpening(b, ["door", "walkthrough"]),
    expectFlagged: true,
  },
  {
    label: "f53669f1 window (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "vb-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "vb-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFlagged: false,
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  const summary: string[] = [];

  for (const c of CASES) {
    console.log(`\n${"=".repeat(80)}\n${c.label}\n${"=".repeat(80)}`);

    let item: PickedItem | null = null;
    try {
      const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId: c.jobId, imageId: c.jobId });
      item = c.pick(baseline);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!item) {
      console.log(`  Could not pick a target item from baseline extraction — skipping this case.`);
      summary.push(`${c.label}: SKIPPED (no item)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    console.log(`  semantic reference: "${semanticRef}"`);

    let flaggedCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const [baselineObs, stagedObs] = await Promise.all([
        observeSingleImageSemantic({ imagePath: c.baselinePath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `baseline_run${run}` } }),
        observeSingleImageSemantic({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `staged_run${run}` } }),
      ]);
      console.log(`  BASELINE identity: "${baselineObs.identifiedItemDescription}"`);
      console.log(`  BASELINE: boundary="${baselineObs.boundaryDescription}" | bbox=${JSON.stringify(baselineObs.bboxEstimate)} | edge=${baselineObs.touchesFrameEdge}`);
      console.log(`  STAGED identity: "${stagedObs.identifiedItemDescription}"`);
      console.log(`  STAGED: boundary="${stagedObs.boundaryDescription}" | bbox=${JSON.stringify(stagedObs.bboxEstimate)} | edge=${stagedObs.touchesFrameEdge}`);

      const verdict = compareSingleImageObservations(baselineObs, stagedObs);
      console.log(`  VERDICT: resized=${verdict.resized} repositioned=${verdict.repositioned} (${verdict.reason})`);
      if (verdict.resized || verdict.repositioned) flaggedCount++;

      console.log(`  >>> MANUAL IDENTITY CHECK REQUIRED: do both identifiedItemDescription fields name "${item.type}"? <<<`);
    }

    const line = `${c.label}: flagged ${flaggedCount}/${RUNS_PER_CASE} runs (expected flagged=${c.expectFlagged})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Variant B)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
