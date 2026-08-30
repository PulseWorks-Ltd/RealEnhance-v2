// VARIANT A — semantic reference + comparative-in-one-call.
// STANDALONE — does not modify occlusionVsRemovalCheck.ts or any production
// validator. Reuses that file's own classifyResized/classifyRepositioned
// (unmodified, already offline-verified) so only ONE variable changes versus
// the ORIGINAL pre-session wording (recovered via `git show 2e1bd47e` —
// commit before tonight's four camera-angle wording rewrites): the item
// pointer. Original used a bbox region ("...compare them to the region
// given for it above..."); this uses a rich semantic description built from
// the item's own baseline `description` field + landmark framing (see
// semanticItemRef.ts), no coordinates anywhere in the prompt.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { classifyResized, classifyRepositioned, resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";
import { toBase64 } from "../worker/src/utils/images";
import { buildSemanticReference, pickLargestOpening, pickLargestFixture, type PickedItem } from "./semanticItemRef";

process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";

const ROOT = path.join(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

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
    jobId: "va-b09-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: true,
  },
  {
    label: "Bedroom 12 sliding door (KNOWN GENUINE RESIZE/RELOCATION — positive control)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "va-b12-door",
    pick: (b) => pickLargestOpening(b, ["door", "walkthrough"]),
    expectFlagged: true,
  },
  {
    label: "f53669f1 window (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "va-f53669f1-window",
    pick: (b) => pickLargestOpening(b, ["window"]),
    expectFlagged: false,
  },
  {
    label: "3e255f88 ceiling lights (KNOWN FALSE POSITIVE — must NOT flag)",
    baselinePath: path.join(PRODIMG, "baseline_3e255f88.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_3e255f88.webp"),
    jobId: "va-3e255f88-lights",
    pick: (b) => pickLargestFixture(b, ["light_fixture"]),
    expectFlagged: false,
  },
];

const RUNS_PER_CASE = 3;

function buildPrompt(semanticRef: string): string {
  return `You are comparing two photos of the same room. Image A is the baseline/original photo. Image B is the current/staged photo.

The item to examine is: ${semanticRef}

1. identifiedItemDescription — Briefly state, in your own words, what item you actually find at that description in Image A, and separately what you find in Image B. This must be the SAME real-world item in both photos, not a different object that merely happens to be nearby. If you cannot find it in one or both photos, say so plainly.

2. extentComparisonDescription — Independent of coverage by furniture, look at the item's OWN edges (its own frame/boundary, not anything placed in front of it) in Image B, and compare them to how it appears in Image A. Two photos of the exact same real object, taken from slightly different camera positions or with different lenses, will always show small apparent differences in size and position — that is normal and does NOT mean the item was resized or moved. Only describe it as a size or position change if it is large and obvious: roughly 25% or more different in apparent size relative to the wall or frame it occupies, or clearly shifted to a different part of the wall — the kind of difference an ordinary person glancing at both photos would immediately call "bigger," "smaller," or "moved," not a subtle or borderline difference you have to look closely to notice. If the difference is anything less than that, describe it as the same size and position. IMPORTANT: this camera-angle allowance only excuses SMALL, subtle differences — it is NOT a reason to dismiss a difference that is actually large and obvious. If the item's own edges clearly take up a noticeably bigger or smaller share of the wall or frame around it in Image B than in Image A, or it has clearly moved to a different spot on the wall, report that plainly as a real change even if the two photos were taken from somewhat different positions. Describe concretely what you observe about its own size, shape, and position in each photo — do not just answer "changed" or "unchanged," and do not discuss furniture or obstruction here, only the item's own extent.

Respond with ONLY a single valid JSON object:
{
  "identifiedItemDescription": "string",
  "extentComparisonDescription": "string"
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function runOneCall(baselinePath: string, stagedPath: string, semanticRef: string, ctx: { jobId: string; imageId: string; callLabel: string }): Promise<{ identifiedItemDescription: string; extentComparisonDescription: string }> {
  const baseline = toBase64(baselinePath);
  const staged = toBase64(stagedPath);
  const prompt = buildPrompt(semanticRef);
  const validatorModel = resolveValidatorModel();

  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }

  const text = await grokAnalyzeImages({
    images: [
      { buffer: Buffer.from(baseline.data, "base64"), mimeType: baseline.mime, label: "Image A (original/baseline):" },
      { buffer: Buffer.from(staged.data, "base64"), mimeType: staged.mime, label: "Image B (staged output):" },
    ],
    prompt,
    jobId: ctx.jobId,
    imageId: ctx.imageId,
    reason: `semantic_ref_variantA_${ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: ctx.jobId, imageId: ctx.imageId, stage: "validator", callLabel: `semantic_ref_variantA_${ctx.callLabel}`, model: grokVisionModel() }));
  const raw = extractJson(text);
  return {
    identifiedItemDescription: typeof raw?.identifiedItemDescription === "string" ? raw.identifiedItemDescription : "",
    extentComparisonDescription: typeof raw?.extentComparisonDescription === "string" ? raw.extentComparisonDescription : "",
  };
}

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
    let identityCorrectCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const result = await runOneCall(c.baselinePath, c.stagedPath, semanticRef, { jobId: c.jobId, imageId: c.jobId, callLabel: `run${run}` });
      console.log(`  identifiedItemDescription: "${result.identifiedItemDescription}"`);
      console.log(`  extentComparisonDescription: "${result.extentComparisonDescription}"`);

      const resized = classifyResized(result.extentComparisonDescription);
      const repositioned = classifyRepositioned(result.extentComparisonDescription);
      const flagged = resized.value || repositioned.value;
      console.log(`  VERDICT: resized=${resized.value} (${resized.matchedPattern}) repositioned=${repositioned.value} (${repositioned.matchedPattern}) => flagged=${flagged}`);
      if (flagged) flaggedCount++;

      console.log(`  >>> MANUAL IDENTITY CHECK REQUIRED: does identifiedItemDescription actually name "${item.type}"? <<<`);
    }

    const line = `${c.label}: flagged ${flaggedCount}/${RUNS_PER_CASE} runs (expected flagged=${c.expectFlagged})`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Variant A)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
