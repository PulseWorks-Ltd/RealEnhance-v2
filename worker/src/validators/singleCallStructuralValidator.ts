// Env-var-gated alternative to the specialist validator chain
// (openingValidator + fixtureValidator + floorIntegrityValidator +
// envelopeValidator). One real Gemini call, per-item checklist comparison
// against the real baseline extraction data (openings + anchorFixtures,
// including each item's `description` field) rather than re-describing
// items separately.
//
// Named "single-call" (not "unified") deliberately — this codebase already
// has an unrelated, pre-existing "Unified Validator" (runUnifiedValidation,
// worker/src/validators/runValidation.ts). This component is not that one
// and does not touch it; the two run at different points in the same job
// attempt when this toggle is on.
//
// REDESIGN (materiality + alteration, two separate judgments per item):
// The original design treated every detected item as equally load-bearing,
// which made it vulnerable to failing on detection noise (a low-confidence
// edge-of-frame fragment) rather than judging what an actual viewer would
// notice and rely on. Each item now gets:
//   1. MATERIALITY — is this a genuine, load-bearing feature a real viewer
//      would notice (door/window/walkthrough/built-in/fixture), or a minor,
//      ambiguous, low-confidence, edge-of-frame detail? Grounded in real
//      extracted signals (confidence, whether the bbox touches the frame
//      edge, opening pane structure) computed here in code and handed to
//      the model as input, not left to a purely free-floating guess.
//   2. ALTERATION — only material items can fail the image on their own.
//      Two specific false-positive mechanisms found in prior real testing
//      are addressed directly in the system instruction: (a) over-eager
//      "obstruction" calls on partial/nearby furniture placement rather
//      than genuine, substantial coverage; (b) no door-type awareness
//      (sliding doors don't need the floor clearance a hinged door does).
//
// SCOPE, unchanged and still stated honestly: this checks the same *items*
// the baseline extractor already names — openings and anchor fixtures. It
// does not independently re-implement floor-material-integrity checking or
// room-envelope/geometry-drift checking. See
// buildSpecialistResultsFromSingleCallValidator() below for exactly how
// this gap is surfaced to the caller rather than silently hidden.
import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { ISSUE_TYPES, classifyIssueTier } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import type { StructuralBaseline } from "./openingPreservationValidator";

const SINGLE_CALL_STRUCTURAL_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const FRAME_EDGE_EPSILON = 0.02;

export type Materiality = "material" | "low_materiality";

export type SingleCallItemCheck = {
  id: string;
  materiality: Materiality;
  materialityReason: string;
  altered: boolean;
  alterationReason: string;
  confidence: number;
};

export type SingleCallStructuralValidatorRaw = {
  items: SingleCallItemCheck[];
};

type EnrichedItemCheck = SingleCallItemCheck & { type: string; description: string; category: "opening" | "fixture" };

export type SingleCallStructuralValidatorResult = {
  status: "pass" | "fail";
  itemResults: EnrichedItemCheck[];
  materialAlteredItems: EnrichedItemCheck[];
  lowMaterialityItems: EnrichedItemCheck[];
  raw: SingleCallStructuralValidatorRaw;
};

function touchesFrameEdge(bbox: [number, number, number, number] | undefined): boolean {
  if (!bbox) return false;
  const [x1, y1, x2, y2] = bbox;
  return x1 <= FRAME_EDGE_EPSILON || y1 <= FRAME_EDGE_EPSILON || x2 >= 1 - FRAME_EDGE_EPSILON || y2 >= 1 - FRAME_EDGE_EPSILON;
}

const SINGLE_CALL_STRUCTURAL_SYSTEM_INSTRUCTION = `You are a structural change-detection engine. Your job is to judge whether a room's staged (furnished) photo would MISLEAD someone who later visits the room in person — not to catalog every difference between two images.

You are given two photos of the same room: the ORIGINAL (baseline) photo and a STAGED (furnished) version. You are also given a list of specific architectural openings and fixtures detected in the original photo, each with a stable id, type, description, and real extraction metadata: confidence (0-1), whether its bounding box touches the edge of the frame, and — for openings — its pane structure (e.g. sliding_panel vs fixed).

For EACH item in the list, make TWO SEPARATE judgments, in this order. Report both explicitly — do not collapse them into one verdict.

1. MATERIALITY — is this a genuine, load-bearing architectural feature that a real person walking into the room would notice and rely on (almost always true for doors, windows, walkthroughs, built-ins, HVAC units, plumbing fixtures, light fixtures)? Or is it a minor, ambiguous, or uncertain detail that would not register as a real feature to someone actually standing in the room?
   Use the given signals as evidence, not a rigid rule: low confidence combined with an ambiguous type (e.g. "other") or a bounding box touching the frame edge should push toward low_materiality. But a clearly-identified door or window that merely happens to be partially cropped by the frame edge is still almost always material — it is a real door or window, just not fully in view. Reserve low_materiality mainly for genuinely uncertain, fragmentary, or low-confidence detections (e.g. a small unclear sliver of "other" at the extreme edge that could plausibly be detection noise) — not just because something is near the edge or the exact wall count is ambiguous.

2. ALTERATION — answer honestly regardless of materiality (report both), but only material items with altered:true can make the image fail overall. Compared to the original, has this item been altered, resized, removed, or genuinely and substantially covered/blocked from view? Apply these standards precisely, and do the REMOVAL check first, before considering obstruction:
   - REMOVAL CHECK (do this first, always): Look carefully at the exact location in the staged photo where this item's defining visual feature should be — for a window, actual glass and a frame; for a door, an actual door leaf, frame, track, or opening gap; for a walkthrough, an actual gap in the wall. Look at the FULL extent of that location, including any strip or edge not covered by new furniture — large furniture is often placed in front of part of an item while a sliver of its frame, track, or glass remains visible at the margin. If even a small but genuine trace of the item's defining feature (an edge of glass, a strip of frame or mirror track, a visible gap) is visible ANYWHERE at that location, it still exists — this is NOT removal, move on to the OBSTRUCTION CHECK below instead. Only conclude REMOVAL when NO trace of the item's defining feature is visible anywhere at that location — the wall is fully continuous, painted, or covered corner-to-corner by a picture/mirror/panel with no edge of the original item showing at all. Do not conclude removal just because a large piece of furniture covers most of the item; check the margins first.
   - OBSTRUCTION CHECK (if any trace of the item's defining feature is visible, even partially): Obstruction must be SUBSTANTIAL enough that the item is no longer usable or recognizable as itself. Furniture placed in the same general area as an item, coming close to it, or covering part of it while a visible edge/strip/track remains, is NOT obstruction — the item is still there and still identifiable. If a clear gap is visible between furniture/decor and the item, or the item remains identifiable even partially, it is NOT altered — do not flag proximity or partial coverage as obstruction.
   - Apply door-type-appropriate reasoning using each item's paneStructure and description, but only after confirming via the removal check that the door/window itself is still actually present. A sliding door or sliding window (paneStructure: sliding_panel, or described as "sliding") does NOT require floor clearance in front of it to function — it slides sideways within its own track, so furniture placed nearby does not obstruct it unless the door itself is visually covered. A hinged/swinging door DOES need its swing path clear to open — furniture blocking that path is a legitimate concern for that type only. A walkthrough opening (no door leaf) just needs to remain visually open. Do not apply hinged-door clearance assumptions to a sliding or walkthrough item.

Furniture, decor, and rugs placed elsewhere in the room, unrelated to a specific listed item, are expected and are never a violation. This does NOT excuse decor that has been placed directly over the location of a now-missing opening — that is removal (see REMOVAL CHECK above), not normal staging.

Answer honestly. If genuinely uncertain about alteration for a MATERIAL item, report altered:true with a reason explaining the specific uncertainty — do not round up an uncertain real concern to false. But do not manufacture obstruction or uncertainty for items you have already judged low_materiality; their alteration answer is recorded but never decides the overall result.

You must output strict JSON only. No explanations outside the JSON. No markdown. No comments.`;

function buildSingleCallStructuralUserPrompt(baseline: StructuralBaseline): string {
  const items = [
    ...baseline.openings.map((o) => ({
      id: o.id,
      type: o.type,
      description: o.description || o.type,
      wallIndex: o.wallIndex,
      bbox: o.bbox,
      confidence: o.confidence,
      touchesFrameEdge: touchesFrameEdge(o.bbox),
      paneStructure: o.paneStructure,
    })),
    ...(baseline.anchorFixtures || []).map((f) => ({
      id: f.id,
      type: f.type,
      description: f.description || f.type,
      wallIndex: f.wallIndex,
      bbox: f.bbox,
      confidence: f.confidence,
      touchesFrameEdge: touchesFrameEdge(f.bbox),
      paneStructure: undefined,
    })),
  ];
  return `Items to check, detected in the original (baseline) photo — DO NOT re-detect, only judge materiality and alteration for each one against the staged photo:
${JSON.stringify(items, null, 2)}

Return JSON in this exact schema:
{
  "items": [
    {
      "id": string,
      "materiality": "material" | "low_materiality",
      "materialityReason": string,
      "altered": boolean,
      "alterationReason": string,
      "confidence": number
    }
  ]
}
One entry per item id given above, in the same order. confidence is 0-1, your confidence in the alteration judgment.`;
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function runSingleCallStructuralValidator(
  baselineImagePath: string,
  stagedImagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<SingleCallStructuralValidatorResult> {
  const original = toBase64(baselineImagePath);
  const staged = toBase64(stagedImagePath);
  const ai = getGeminiClient();

  const requestStartedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: SINGLE_CALL_STRUCTURAL_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: SINGLE_CALL_STRUCTURAL_SYSTEM_INSTRUCTION },
          { text: buildSingleCallStructuralUserPrompt(baseline) },
          { text: "Image A (original/baseline):" },
          { inlineData: { mimeType: original.mime, data: original.data } },
          { text: "Image B (staged output):" },
          { inlineData: { mimeType: staged.mime, data: staged.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: ctx.jobId, imageId: ctx.imageId, stage: "validator", attempt: ctx.attempt ?? 1 },
    model: SINGLE_CALL_STRUCTURAL_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("SINGLE_CALL_STRUCTURAL_VALIDATOR: no text returned");
  const raw = extractJsonFromModelText(textPart.text) as SingleCallStructuralValidatorRaw;
  if (!Array.isArray(raw?.items)) throw new Error("SINGLE_CALL_STRUCTURAL_VALIDATOR: malformed response, no items array");

  const byId = new Map<string, { type: string; description: string; category: "opening" | "fixture" }>();
  for (const o of baseline.openings) byId.set(o.id, { type: o.type, description: o.description || o.type, category: "opening" });
  for (const f of baseline.anchorFixtures || []) byId.set(f.id, { type: f.type, description: f.description || f.type, category: "fixture" });

  const itemResults: EnrichedItemCheck[] = raw.items.map((item) => {
    const meta = byId.get(item.id) || { type: "unknown", description: "unknown item", category: "opening" as const };
    return { ...item, ...meta };
  });
  const materialAlteredItems = itemResults.filter((r) => r.materiality === "material" && r.altered);
  const lowMaterialityItems = itemResults.filter((r) => r.materiality === "low_materiality");

  return {
    status: materialAlteredItems.length > 0 ? "fail" : "pass",
    itemResults,
    materialAlteredItems,
    lowMaterialityItems,
    raw,
  };
}

// ── Adapter: reshapes a single SingleCallStructuralValidatorResult into
// the same {opening, fixture} ValidatorOutcome slots the specialist chain
// produces, so the call site can synthesize an equivalent
// `orchestrateSpecialistsWithRetry`-shaped result without touching any
// downstream merge/whitelist/Unified-Validator logic. floor/envelope
// slots are explicitly marked as NOT independently checked by this
// validator (status "pass", but with a distinguishing reason string) —
// see the module-level scope comment. Callers relying on floor/envelope
// coverage should treat this toggle as a partial, not full, replacement
// until that gap is closed. ──
export function buildSpecialistResultsFromSingleCallValidator(result: SingleCallStructuralValidatorResult): {
  opening: ValidatorOutcome;
  fixture: ValidatorOutcome;
  floor: ValidatorOutcome;
  envelope: ValidatorOutcome;
} {
  const openingAltered = result.materialAlteredItems.filter((i) => i.category === "opening");
  const fixtureAltered = result.materialAlteredItems.filter((i) => i.category === "fixture");

  const buildOutcome = (altered: typeof result.materialAlteredItems, issueType: string): ValidatorOutcome => {
    if (altered.length === 0) {
      return { status: "pass", reason: "single_call_structural_validator: no material alteration detected", confidence: 0.9, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: [] };
    }
    const reason = altered.map((a) => `${a.id} (${a.description}): ${a.alterationReason}`).join(" | ");
    return {
      status: "fail",
      reason: `single_call_structural_validator: ${reason}`,
      confidence: Math.min(...altered.map((a) => a.confidence ?? 0.8)),
      hardFail: true,
      issueType: issueType as ValidatorOutcome["issueType"],
      issueTier: classifyIssueTier(issueType as ValidatorOutcome["issueType"]),
      advisorySignals: altered.map((a) => a.id),
    };
  };

  return {
    opening: buildOutcome(openingAltered, ISSUE_TYPES.OPENING_INFILLED),
    fixture: buildOutcome(fixtureAltered, ISSUE_TYPES.FIXTURE_CHANGED),
    floor: { status: "pass", reason: "single_call_structural_validator: floor material integrity not independently checked by this validator (out of scope — see module comment)", confidence: 0, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: ["single_call_validator_floor_not_checked"] },
    envelope: { status: "pass", reason: "single_call_structural_validator: room envelope/geometry not independently checked by this validator (out of scope — see module comment)", confidence: 0, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: ["single_call_validator_envelope_not_checked"] },
  };
}
