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
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline } from "./openingPreservationValidator";
import { runEnvelopeValidator } from "./envelopeValidator";
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

const OPENING_ENVELOPE_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

type Materiality = "material" | "low_materiality";
type EnrichedOpeningResult = OcclusionCombinedResult & { materiality: Materiality; materialityReason: string; type: string; description: string };

export type OpeningEnvelopeValidatorResult = {
  opening: ValidatorOutcome;
  envelope: ValidatorOutcome;
  itemResults: EnrichedOpeningResult[];
  materialAlteredItems: EnrichedOpeningResult[];
  lowMaterialityItems: EnrichedOpeningResult[];
};

const OPENING_SYSTEM_INSTRUCTION = `You are checking whether architectural openings (windows, doors, walkthroughs, closet doors) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture, which is expected and acceptable.

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...], "materiality": [...]}. No explanations outside the JSON. No markdown. No comments.`;

function buildOpeningPhaseAPrompt(baseline: StructuralBaseline): string {
  return `PHASE A — OBSERVATION ONLY. Below are opening regions from the original photo, identified only by id and their approximate location (no other information — do not guess what type of feature each one is; just look and describe).

${buildObservationOnlyItemList(baseline.openings.map((o) => ({ id: o.id, type: "", description: "", bbox: o.bbox })))}

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
  const [raw, envelopeResult] = await Promise.all([
    runOcclusionObservationCall({
      systemInstruction: OPENING_SYSTEM_INSTRUCTION,
      userPrompt: `${buildOpeningPhaseAPrompt(baseline)}\n\n${buildOpeningPhaseBPrompt(baseline)}`,
      baselineImagePath,
      stagedImagePath,
      model: OPENING_ENVELOPE_MODEL,
      ctx: { ...ctx, callLabel: "opening" },
    }),
    runEnvelopeValidator(baselineImagePath, stagedImagePath, ctx),
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

  const opening: ValidatorOutcome =
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

  return { opening, envelope: envelopeResult, itemResults, materialAlteredItems, lowMaterialityItems };
}
