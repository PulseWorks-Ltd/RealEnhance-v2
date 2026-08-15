// Split-validator, half 2 of 2: anchor fixtures (fireplace, built-in
// cabinetry, kitchen island, staircase, plumbing, light fixtures, AC units,
// etc.) using the same locate-and-describe occlusion-vs-removal mechanism
// as openingEnvelopeValidator.ts (see occlusionVsRemovalCheck.ts's header
// for the full history), plus flooring material/boundary integrity.
//
// FLOORING now runs via runFlooringBoundaryCheck() (flooringBoundaryCheck.ts),
// SUPERSEDING the old runFloorIntegrityValidator() within this split-validator
// path. Reasoning: floorIntegrityValidator.ts asks for one dominant material
// class for the whole room and cannot express "is a material boundary
// preserved" — confirmed structurally blind on a real case (Living 07's
// carpet/linoleum boundary loss: both Gemini and Grok answered "carpet vs
// carpet" 4/4 through the old question, because nothing in its schema could
// surface a second zone or a seam). The new check is a strict capability
// superset — a single-material room degenerates to exactly the old
// validator's own comparison, done via the same locate-and-describe +
// code-side-classification pattern as every other check here, and a
// multi-zone room additionally catches boundary loss the old validator
// could never see regardless of model. Running both would only add cost,
// not detection power, so the old validator is not called from this file
// anymore. floorIntegrityValidator.ts itself is untouched and still backs
// the original ("on") validator chain in runValidation.ts.
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline } from "./openingPreservationValidator";
import { runFlooringBoundaryCheck } from "./flooringBoundaryCheck";
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

const FIXTURE_FLOORING_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

type Materiality = "material" | "low_materiality";
type EnrichedFixtureResult = OcclusionCombinedResult & { materiality: Materiality; materialityReason: string; type: string; description: string };

export type FixtureFlooringValidatorResult = {
  fixture: ValidatorOutcome;
  floor: ValidatorOutcome;
  itemResults: EnrichedFixtureResult[];
  materialAlteredItems: EnrichedFixtureResult[];
  lowMaterialityItems: EnrichedFixtureResult[];
};

const FIXTURE_SYSTEM_INSTRUCTION = `You are checking whether fixed anchor fixtures (fireplaces, built-in cabinetry, kitchen islands, staircases, plumbing fixtures, light fixtures, AC/HVAC units, and similar permanent installations) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture or decor, which is expected and acceptable (a real example: a fireplace hearth with a plant placed in front of part of it is normal staging, not a violation, as long as the hearth/mantel structure itself remains identifiable).

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...], "materiality": [...]}. No explanations outside the JSON. No markdown. No comments.`;

function buildFixturePhaseAPrompt(fixtures: StructuralBaseline["anchorFixtures"]): string {
  return `PHASE A — OBSERVATION ONLY. Below are fixture regions from the original photo, identified only by id and their approximate location (no other information — do not guess what type of fixture each one is; just look and describe).

${buildObservationOnlyItemList((fixtures || []).map((f) => ({ id: f.id, type: "", description: "", bbox: f.bbox })))}

${buildObservationQuestionsInstruction("fixture")}

"observations" schema — one entry per id above, in the same order:
[${buildObservationSchemaText()}]`;
}

function buildFixturePhaseBPrompt(fixtures: StructuralBaseline["anchorFixtures"]): string {
  const identified = (fixtures || []).map((f) => ({ id: f.id, type: f.type, description: f.description || f.type, confidence: f.confidence }));
  return `PHASE B — IDENTIFICATION AND MATERIALITY. Now that you have completed your observations above, here is what each region actually is, for reference:
${JSON.stringify(identified, null, 2)}

For EACH item, judge MATERIALITY: is this a genuine, permanent, load-bearing fixture a real person walking into the room would notice and rely on? Low confidence combined with an ambiguous "other" type can push toward low_materiality (e.g. a small unclear decorative object). A clearly-identified fireplace, built-in, island, staircase, plumbing fixture, or light fixture is almost always material even if partially cropped by the frame. Use your Phase A observations for that item to inform this.

"materiality" schema — one entry per id, same order:
[{"id": string, "materiality": "material" | "low_materiality", "materialityReason": string}]`;
}

export async function runFixtureFlooringValidator(
  baselineImagePath: string,
  stagedImagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<FixtureFlooringValidatorResult> {
  const fixtures = baseline.anchorFixtures || [];

  const [raw, floorCheckResult] = await Promise.all([
    fixtures.length === 0
      ? Promise.resolve({ observations: [], materiality: [] })
      : runOcclusionObservationCall({
          systemInstruction: FIXTURE_SYSTEM_INSTRUCTION,
          userPrompt: `${buildFixturePhaseAPrompt(fixtures)}\n\n${buildFixturePhaseBPrompt(fixtures)}`,
          baselineImagePath,
          stagedImagePath,
          model: FIXTURE_FLOORING_MODEL,
          ctx: { ...ctx, callLabel: "fixture" },
        }),
    runFlooringBoundaryCheck(baselineImagePath, stagedImagePath, ctx),
  ]);
  const floorResult = floorCheckResult.floor;

  const observations: OcclusionObservationRaw[] = Array.isArray(raw?.observations) ? raw.observations : [];
  const materialityById = new Map<string, { materiality: Materiality; materialityReason: string }>(
    (Array.isArray(raw?.materiality) ? raw.materiality : []).map((m: any) => [m.id, { materiality: m.materiality, materialityReason: m.materialityReason }])
  );
  const byId = new Map(fixtures.map((f) => [f.id, { type: f.type, description: f.description || f.type }]));

  const itemResults: EnrichedFixtureResult[] = observations.map((obs) => {
    const classified = classifyObservation(obs);
    const combined = combineOcclusionAnswer({ ...classified, rawObservation: obs });
    const materiality = materialityById.get(obs.id) || { materiality: "material" as Materiality, materialityReason: "materiality_not_returned_defaulting_material" };
    const meta = byId.get(obs.id) || { type: "unknown", description: "unknown item" };
    return { ...combined, materiality: materiality.materiality, materialityReason: materiality.materialityReason, ...meta };
  });

  const materialAlteredItems = itemResults.filter((r) => r.materiality === "material" && r.altered);
  const lowMaterialityItems = itemResults.filter((r) => r.materiality === "low_materiality");

  const fixture: ValidatorOutcome =
    materialAlteredItems.length === 0
      ? { status: "pass", reason: "fixture_flooring_validator: no material alteration detected", confidence: 0.9, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: [] }
      : {
          status: "fail",
          reason: `fixture_flooring_validator: ${materialAlteredItems.map((a) => `${a.id} (${a.description}): verdict=${a.verdict} — ${a.verdict === "resized" ? a.rawObservation.extentComparisonDescription : a.rawObservation.currentStateDescription}`).join(" | ")}`,
          confidence: Math.min(...materialAlteredItems.map((a) => a.confidence ?? 0.8)),
          hardFail: true,
          issueType: ISSUE_TYPES.FIXTURE_CHANGED,
          issueTier: classifyIssueTier(ISSUE_TYPES.FIXTURE_CHANGED),
          advisorySignals: materialAlteredItems.map((a) => `${a.id}:${a.verdict}`),
        };

  return { fixture, floor: floorResult, itemResults, materialAlteredItems, lowMaterialityItems };
}
