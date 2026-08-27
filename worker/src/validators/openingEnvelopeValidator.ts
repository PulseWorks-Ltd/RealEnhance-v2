// Split-validator, half 1 of 2: openings (windows/doors/walkthroughs/closet
// doors) using the deterministic occlusion-vs-removal mechanism from
// occlusionVsRemovalCheck.ts (v3: locate-and-describe, not yes/no — see
// that file's header for the full history), plus the room envelope/
// geometry check.
//
// Envelope is NOT put through the occlusion-vs-removal question structure.
// Real testing showed the envelope validator has its own separate,
// pre-existing false-positive tendency on the Bedroom 11 FIXED case
// (unrelated to anything built in this validator) — that is explicitly
// parked and out of scope here; this file continues to reuse the existing,
// unmodified runEnvelopeValidator().
//
// TWO-PHASE PROMPT STRUCTURE (the fix this file implements):
// Phase A (OBSERVATION) gives the model ONLY each opening's id and its
// baseline bounding box — pure geometry, no type, no description — and
// asks it to describe what it currently sees at that location, before
// anything else in the prompt is read. Phase B (IDENTIFICATION +
// MATERIALITY) comes afterward in the prompt text, and is the first place
// each item's real type/description is revealed, used only to judge
// materiality (a legitimately different question — "is this worth caring
// about," not "what do you see"). This is one Gemini call, so the model
// technically has the whole prompt in context before generating anything;
// what this ordering achieves is that the type/description is never
// adjacent to, or part of, the observation questions or their item list —
// there is no premise sitting next to those questions for the model to
// echo. See occlusionVsRemovalCheck.ts's header for the same caveat stated
// in full.
//
// ONE DELIBERATE, NARROW EXCEPTION (sliding/pocket door fix): Phase A now
// also reveals a per-item STRUCTURAL hint (via buildObservationOnlyItemList's
// extra.structuralHint) for door-type items, most importantly flagging
// sliding-panel doors. Confirmed real gap this closes: baseline extraction
// already detects doorLeafState and paneStructure (StructuralOpening), but
// neither ever reached the observation prompt before this fix — Phase A's
// item list was id+bbox only, and Phase B's paneStructure reveal happens
// only after the observation questions are already answered, informing
// nothing but the separate materiality judgment. A closed sliding/pocket
// door can genuinely look like plain wall at a glance; without being told
// "closed is an expected state here, look for track/frame/jamb," a real,
// visually-confirmed case (Bedroom 14 Run 2's closet) produced a confident
// false "removed" verdict. This is judged NOT to reproduce the yes/no
// agreement-bias problem the hidden-type/description design exists to
// prevent, for the same reason the resize/reposition question's baseline
// bbox reveal and the flooring check's baseline material description
// reveal don't: it's a targeted structural FACT to look for, not a content
// description sitting next to a yes/no question for the model to echo.
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline, StructuralOpening } from "./openingPreservationValidator";
import { runEnvelopeValidator } from "./envelopeValidator";
import { runFabricatedOpeningCheck, type FabricatedOpeningCheckResult } from "./fabricatedOpeningCheck";
import { runWindowArtworkCheckForOpenings, type WindowArtworkItemResult } from "./windowArtworkCheck";
import { runVanishedLandmarkCheckForItems, isVanishedLandmarkOverrideEligible, type VanishedLandmarkItemResult } from "./vanishedLandmarkCheck";
import type { PickedItem } from "./semanticItemRef";
import { newValidatorChecksBlocking } from "./validatorModelCall";
import {
  HUMAN_EYE_FRAMING,
  buildObservationOnlyItemList,
  buildObservationQuestionsInstruction,
  buildObservationSchemaText,
  classifyObservation,
  combineOcclusionAnswer,
  runOcclusionObservationCall,
  type OcclusionCombinedResult,
  type OcclusionObservationRaw,
} from "./occlusionVsRemovalCheck";

function buildStructuralHint(o: StructuralOpening): string | undefined {
  const isDoorLike = o.type === "door" || o.type === "closet_door" || o.type === "walkthrough";
  if (!isDoorLike) return undefined;
  const leafState = o.doorLeafState && o.doorLeafState !== "unknown" ? o.doorLeafState : undefined;
  const isSliding = o.paneStructure === "sliding_panel";
  if (isSliding) {
    return `baseline structural note: this location is a SLIDING PANEL door${leafState ? `, baseline leaf state: ${leafState}` : ""} — a CLOSED sliding or pocket door is a completely normal, unaltered state and can look like a plain section of wall at a glance; look specifically for a track, frame, jamb, pocket edge, or reveal as evidence the opening mechanism is still there`;
  }
  if (leafState) {
    return `baseline structural note: this location is a door, baseline leaf state: ${leafState}`;
  }
  return undefined;
}

const OPENING_ENVELOPE_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

type Materiality = "material" | "low_materiality";
type EnrichedOpeningResult = OcclusionCombinedResult & { materiality: Materiality; materialityReason: string; type: string; description: string };

export type OpeningEnvelopeValidatorResult = {
  opening: ValidatorOutcome;
  envelope: ValidatorOutcome;
  itemResults: EnrichedOpeningResult[];
  materialAlteredItems: EnrichedOpeningResult[];
  lowMaterialityItems: EnrichedOpeningResult[];
  fabricatedOpeningCheck: FabricatedOpeningCheckResult;
  windowArtworkCheck: WindowArtworkItemResult[];
  vanishedLandmarkCheck: VanishedLandmarkItemResult[];
};

function toPickedItems(openings: StructuralOpening[]): PickedItem[] {
  return (openings || []).map((o) => ({
    id: o.id,
    type: o.type,
    description: o.description,
    wallIndex: o.wallIndex,
    horizontalBand: o.horizontalBand,
    verticalBand: o.verticalBand,
    bbox: o.bbox,
  }));
}

const OPENING_SYSTEM_INSTRUCTION = `You are checking whether architectural openings (windows, doors, walkthroughs, closet doors) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture, which is expected and acceptable.

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...], "materiality": [...]}. No explanations outside the JSON. No markdown. No comments.`;

function buildOpeningPhaseAPrompt(baseline: StructuralBaseline): string {
  return `PHASE A — OBSERVATION ONLY. Below are opening regions from the original photo, identified only by id and their approximate location (no type or description — do not guess what kind of feature each one is beyond any structural note shown; just look and describe). A bracketed structural note, where present, is a fact about what to look for, not a description of the item — it does not tell you whether anything has changed.

${buildObservationOnlyItemList(baseline.openings.map((o) => ({ id: o.id, type: "", description: "", bbox: o.bbox, extra: { structuralHint: buildStructuralHint(o) } })))}

${buildObservationQuestionsInstruction("opening")}

"observations" schema — one entry per id above, in the same order:
[${buildObservationSchemaText()}]`;
}

function buildOpeningPhaseBPrompt(baseline: StructuralBaseline): string {
  const identified = baseline.openings.map((o) => ({ id: o.id, type: o.type, description: o.description || o.type, confidence: o.confidence, paneStructure: o.paneStructure }));
  return `PHASE B — IDENTIFICATION AND MATERIALITY. Now that you have completed your observations above, here is what each region actually is, for reference:
${JSON.stringify(identified, null, 2)}

For EACH item, judge MATERIALITY: is this a genuine, load-bearing architectural feature a real person walking into the room would notice and rely on (true for nearly every door, window, or walkthrough)? Low confidence combined with an ambiguous detection can push toward low_materiality; a clearly-identified door or window that's merely partially cropped by the frame edge is still material. Note for doors specifically: a sliding door/window (paneStructure sliding_panel, or described as "sliding") does not need floor clearance to function — furniture nearby is normal and does not by itself indicate coverage; judge only whether the door/window itself is visually present, using your Phase A observations for that item.

"materiality" schema — one entry per id, same order:
[{"id": string, "materiality": "material" | "low_materiality", "materialityReason": string}]`;
}

export async function runOpeningEnvelopeValidator(
  baselineImagePath: string,
  stagedImagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<OpeningEnvelopeValidatorResult> {
  const [raw, envelopeResult, fabricatedOpeningCheck, windowArtworkCheck, vanishedLandmarkCheck] = await Promise.all([
    runOcclusionObservationCall({
      systemInstruction: OPENING_SYSTEM_INSTRUCTION,
      userPrompt: `${buildOpeningPhaseAPrompt(baseline)}\n\n${buildOpeningPhaseBPrompt(baseline)}`,
      baselineImagePath,
      stagedImagePath,
      model: OPENING_ENVELOPE_MODEL,
      ctx: { ...ctx, callLabel: "opening" },
    }),
    runEnvelopeValidator(baselineImagePath, stagedImagePath, {
      ...ctx,
      slidingDoorHints: baseline.openings
        .filter((o) => o.paneStructure === "sliding_panel")
        .map((o) => o.description || `${o.type} on ${o.wallPosition || `wall ${o.wallIndex}`}`),
    }),
    // Independent of the two calls above — see fabricatedOpeningCheck.ts's
    // header for why this exists as a separate two-call structure rather
    // than folding into either. Always runs call 1 (cheap, single call);
    // call 2 only fires when call 1 actually flags something, so the
    // common (clean-image) case costs one extra call, not two.
    runFabricatedOpeningCheck(baselineImagePath, stagedImagePath, baseline, ctx),
    // Window-replaced-by-artwork: a direct, hard-coded implausibility
    // override, deliberately independent of the standard occlusion
    // question — see windowArtworkCheck.ts's header. One batched call
    // covering every window in the room (skipped entirely if there are
    // none); self-contained error handling degrades to a safe non-blocking
    // result, never throws into this Promise.all.
    runWindowArtworkCheckForOpenings(baseline.openings, stagedImagePath, ctx),
    // Vanished-landmark: catches drift near an opening that the standard
    // per-item check can't see (a nearby structural landmark vanishing,
    // not the opening's own bbox changing) — see vanishedLandmarkCheck.ts's
    // header. Same self-contained error handling as above.
    runVanishedLandmarkCheckForItems(toPickedItems(baseline.openings), baselineImagePath, stagedImagePath, ctx, "openings"),
  ]);

  const observations: OcclusionObservationRaw[] = Array.isArray(raw?.observations) ? raw.observations : [];
  const materialityById = new Map<string, { materiality: Materiality; materialityReason: string }>(
    (Array.isArray(raw?.materiality) ? raw.materiality : []).map((m: any) => [m.id, { materiality: m.materiality, materialityReason: m.materialityReason }])
  );
  const byId = new Map(baseline.openings.map((o) => [o.id, { type: o.type, description: o.description || o.type }]));

  const itemResults: EnrichedOpeningResult[] = observations.map((obs) => {
    const classified = classifyObservation(obs);
    const combined = combineOcclusionAnswer({ ...classified, rawObservation: obs });
    const materiality = materialityById.get(obs.id) || { materiality: "material" as Materiality, materialityReason: "materiality_not_returned_defaulting_material" };
    const meta = byId.get(obs.id) || { type: "unknown", description: "unknown item" };
    return { ...combined, materiality: materiality.materiality, materialityReason: materiality.materialityReason, ...meta };
  });

  const materialAlteredItems = itemResults.filter((r) => r.materiality === "material" && r.altered);
  const lowMaterialityItems = itemResults.filter((r) => r.materiality === "low_materiality");

  const standardOpening: ValidatorOutcome =
    materialAlteredItems.length === 0
      ? { status: "pass", reason: "opening_envelope_validator: no material alteration detected", confidence: 0.9, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: [] }
      : {
          status: "fail",
          reason: `opening_envelope_validator: ${materialAlteredItems.map((a) => `${a.id} (${a.description}): verdict=${a.verdict} — ${a.verdict === "resized" ? a.rawObservation.extentComparisonDescription : a.rawObservation.currentStateDescription}`).join(" | ")}`,
          confidence: Math.min(...materialAlteredItems.map((a) => a.confidence ?? 0.8)),
          hardFail: true,
          issueType: ISSUE_TYPES.OPENING_INFILLED,
          issueTier: classifyIssueTier(ISSUE_TYPES.OPENING_INFILLED),
          advisorySignals: materialAlteredItems.map((a) => `${a.id}:${a.verdict}`),
        };

  // Combine with the fabricated-opening check's verdict (deterministic,
  // code-side — see the task's own decision-logic spec):
  // - "clean" (call 1 found nothing unlisted) → standard result stands.
  // - "fabricated" (call 2 confirmed absent from baseline) → hard fail,
  //   overriding a standard "pass" it wouldn't otherwise have caught (this
  //   is exactly the gap that motivated building this check).
  // - "baseline_extraction_miss" (call 2 found it present in baseline too)
  //   → the standard check's own confusion about this same missing/
  //   misplaced baseline entry is presumed connected; if the standard
  //   check hard-failed, override it to pass rather than block a job over
  //   an extraction gap this check has independently confirmed is benign.
  let opening = standardOpening;
  if (fabricatedOpeningCheck.verdict === "fabricated") {
    opening = fabricatedOpeningCheck.outcome;
  } else if (fabricatedOpeningCheck.verdict === "baseline_extraction_miss" && standardOpening.status === "fail") {
    opening = {
      ...standardOpening,
      status: "pass",
      hardFail: false,
      issueType: ISSUE_TYPES.NONE,
      issueTier: "none",
      reason: `${standardOpening.reason} | OVERRIDDEN by fabricated_opening_check (baseline_extraction_miss): ${fabricatedOpeningCheck.outcome.reason}`,
    };
  }

  // Window-artwork override — one-directional only (can only turn a pass
  // into a fail, never rescue an existing fail; there is no rescue
  // semantic defined for this check). newValidatorChecksBlocking() gates
  // whether this can actually block/retry a job (advisory-only by default —
  // see validatorModelCall.ts) — `opening.hardFail || blocking` so a
  // disabled blocking switch can never downgrade an ALREADY-hard-failed
  // result (e.g. from fabricatedOpeningCheck above) back to non-blocking.
  const windowArtworkFailures = windowArtworkCheck.filter((w) => w.verdict === "fail_window_replaced_by_artwork");
  if (windowArtworkFailures.length > 0) {
    const blocking = newValidatorChecksBlocking();
    opening = {
      ...opening,
      status: "fail",
      hardFail: opening.hardFail || blocking,
      confidence: Math.min(opening.confidence, 0.75),
      issueType: ISSUE_TYPES.WINDOW_ARTWORK_REPLACEMENT,
      issueTier: classifyIssueTier(ISSUE_TYPES.WINDOW_ARTWORK_REPLACEMENT),
      reason: `${opening.reason} | window_artwork_replacement: ${windowArtworkFailures.map((w) => `${w.itemId} (${w.description}): ${w.reason}`).join(" | ")}`,
      advisorySignals: [...opening.advisorySignals, ...windowArtworkFailures.map((w) => `window_artwork_replaced:${w.itemId}`)],
    };
  }

  // Vanished-landmark override — same one-directional shape and blocking
  // gate as above.
  const vanishFailures = vanishedLandmarkCheck.filter((v) => isVanishedLandmarkOverrideEligible(v.verdict));
  if (vanishFailures.length > 0) {
    const blocking = newValidatorChecksBlocking();
    opening = {
      ...opening,
      status: "fail",
      hardFail: opening.hardFail || blocking,
      confidence: Math.min(opening.confidence, 0.75),
      issueType: ISSUE_TYPES.LANDMARK_VANISHED,
      issueTier: classifyIssueTier(ISSUE_TYPES.LANDMARK_VANISHED),
      reason: `${opening.reason} | vanished_landmark_check: ${vanishFailures.map((v) => `${v.itemId} (${v.description}): ${v.verdict} — ${v.reason}`).join(" | ")}`,
      advisorySignals: [...opening.advisorySignals, ...vanishFailures.map((v) => `vanished_landmark:${v.itemId}:${v.verdict}`)],
    };
  }

  return { opening, envelope: envelopeResult, itemResults, materialAlteredItems, lowMaterialityItems, fabricatedOpeningCheck, windowArtworkCheck, vanishedLandmarkCheck };
}
