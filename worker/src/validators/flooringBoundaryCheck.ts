// Flooring boundary check — replaces reliance on floorIntegrityValidator.ts's
// dominant-material-class design within the split-validator ("off") path.
//
// WHY: floorIntegrityValidator.ts asks for exactly one baseline_material and
// one staged_material for the WHOLE room and compares the two classes. It
// cannot express "is a material BOUNDARY preserved" at all — there is no
// concept of a zone or a seam anywhere in its schema. Confirmed structurally
// blind on a real case: Living 07's baseline has two flooring materials
// (carpet + a lighter linoleum/vinyl-look zone) separated by a visible
// diagonal seam; the staged output unified the whole floor to carpet,
// erasing the second material and its boundary entirely. Both Gemini and
// Grok, asked the dominant-material-class question, answered "carpet vs
// carpet" 4/4 — not because either model failed to see the unified floor,
// but because the question never asked about a second zone or a boundary,
// so there was nothing in the schema for either model to report it with.
//
// A standalone exploratory test (tmp/test_flooring_locate_describe.ts) found
// that a locate-and-describe question — pointing at the specific zone
// location and asking the model to describe the material actually present
// there now, referenced against the known baseline zone description — caught
// the same violation 4/4 across both models immediately. This file builds
// that proven question into the real validator pipeline, following the
// exact same architecture as occlusionVsRemovalCheck.ts's checks (openings/
// fixtures, and the fourth resize/reposition question added earlier
// tonight): locate/describe questions, zero yes/no booleans produced BY THE
// MODEL, deterministic code-side classification of free text into the
// booleans a verdict needs, and the same STAGE2_VALIDATOR_MODEL routing via
// resolveValidatorModel().
//
// ONE DELIBERATE DEPARTURE from the opening/fixture questions' structure:
// those hide the item's type/description from the model during the
// observation phase specifically because a YES/NO presence question sitting
// next to "this is a window" let the model default to agreeing with the
// premise instead of re-examining the image (see occlusionVsRemovalCheck.ts
// header). This question is inherently comparative — "does the material at
// this location match the material described here" cannot be asked without
// stating what to compare against, the same way the resize/reposition
// question cannot be asked without revealing the baseline bbox. The
// exploratory script proved this directly: it embedded the baseline zone's
// material description right next to the question and still caught the
// violation 4/4 across both models — revealing the comparison target here
// does not reproduce the yes/no agreement-bias failure mode.
//
// BASELINE ZONE DATA: no such data existed anywhere in the codebase before
// this file (checked: StructuralBaseline has no flooring field, and no
// `flooringDescription`/zone-polygon field exists in worker/src). This file
// adds a small, self-contained baseline extraction step, following the same
// single-call, temperature-0, JSON-schema pattern already proven for
// openings/fixtures (extractStructuralBaselineOnce in
// openingPreservationValidator.ts) — always Gemini, independent of
// STAGE2_VALIDATOR_MODEL, exactly like that existing baseline extraction is
// always Gemini regardless of which model later validates the staged image.
import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { classifyIssueTier, createStructuredIssue, ISSUE_TYPES, mapIssueTierToSeverity, type StructuredIssue } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";
import { HUMAN_EYE_FRAMING, isLikelyNegated, runOcclusionObservationCall, type ClassificationConfidence, type ClassifiedSignal } from "./occlusionVsRemovalCheck";

const FLOORING_ZONE_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

// Broader than occlusionVsRemovalCheck.ts's default negation-cue pattern:
// adds bare "no" (not just "no longer"), needed for constructions like "no
// change to a different material" — see the real bug this fixed, documented
// at classifyMaterialMatch below. Not added to the shared default itself,
// to avoid risking new false negatives on the already-validated resize/
// reposition classifiers that pattern also guards.
const FLOORING_NEGATION_CUE_PATTERN = /\b(not|n't|never|no longer|no|without)\b/;

export type FlooringZone = {
  id: string;
  bbox: [number, number, number, number];
  materialDescription: string;
};

function formatBboxRegion(bbox: [number, number, number, number]): string {
  const [x1, y1, x2, y2] = bbox;
  return `x: ${x1.toFixed(2)}–${x2.toFixed(2)}, y: ${y1.toFixed(2)}–${y2.toFixed(2)} (normalized fractions of image width/height, 0,0 = top-left)`;
}

const ZONE_EXTRACTION_PROMPT = `You are examining a single room photo to identify its flooring material(s).

If the ENTIRE visible floor area shows a single, uniform flooring material throughout (one carpet, one type of wood, one tile, etc.), return exactly ONE zone covering the whole visible floor area, with a concrete description of that material (color, texture, pattern — not a category label alone).

If there are TWO OR MORE clearly distinct flooring materials visible — for example carpet in one area and a smoother/harder material like tile, vinyl, or wood in another, with a visible seam, threshold, or boundary line marking the transition — return one zone per distinct material, each with its own bounding box (normalized 0.0-1.0 fractions of image width/height, 0,0 = top-left) tightly covering that material's visible extent, and a concrete description of that specific material.

If no floor is clearly visible anywhere in this photo, return an empty zones array.

Respond with ONLY a single valid JSON object: {"zones": [{"id": string, "bbox": [x1,y1,x2,y2], "materialDescription": string}]}`;

export async function extractFlooringZones(
  baselineImagePath: string,
  ctx: { jobId?: string; imageId?: string; attempt?: number }
): Promise<FlooringZone[]> {
  const image = toBase64(baselineImagePath);
  const ai = getGeminiClient();
  const requestStartedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: FLOORING_ZONE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: ZONE_EXTRACTION_PROMPT },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 1024, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: ctx.jobId || "", imageId: ctx.imageId || "", stage: "validator", attempt: ctx.attempt ?? 1 },
    model: FLOORING_ZONE_MODEL,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("FLOORING_ZONE_EXTRACTION: no text returned");
  const cleaned = String(textPart.text || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("FLOORING_ZONE_EXTRACTION: invalid JSON");
  }
  const zones: FlooringZone[] = Array.isArray(parsed?.zones)
    ? parsed.zones
        .filter((z: any) => z && typeof z.id === "string" && Array.isArray(z.bbox) && z.bbox.length === 4 && typeof z.materialDescription === "string")
        .map((z: any) => ({ id: z.id, bbox: z.bbox as [number, number, number, number], materialDescription: z.materialDescription }))
    : [];

  console.log("[FLOORING_ZONE_BASELINE]", JSON.stringify({
    jobId: ctx.jobId,
    imageId: ctx.imageId,
    zoneCount: zones.length,
    zones: zones.map((z) => ({ id: z.id, bbox: z.bbox, materialDescription: z.materialDescription })),
  }));

  return zones;
}

// Raw model output for the observation phase — free text only, mirroring
// occlusionVsRemovalCheck.ts's OcclusionObservationRaw. boundaryDescription
// is only asked (and only meaningful) when the room has 2+ zones; for a
// single-zone room the field is omitted from the prompt/schema entirely
// rather than asked-but-ignored, since there is no boundary to describe.
export type FlooringObservationRaw = {
  id: string;
  materialDescription: string;
  boundaryDescription?: string;
};

function buildFlooringObservationPrompt(zones: FlooringZone[]): string {
  const multiZone = zones.length >= 2;
  const zoneList = zones
    .map((z) => `- id: ${z.id}, region: ${formatBboxRegion(z.bbox)}. In the ORIGINAL photo, this region's flooring material is: "${z.materialDescription}".`)
    .join("\n");

  const boundaryNote = multiZone
    ? `\nThis room has ${zones.length} distinct flooring material zones (listed above). Where two zones border each other, the ORIGINAL photo shows a visible seam, threshold, or boundary line marking the transition between the two materials.`
    : "";

  const questionTwo = multiZone
    ? `\n2. boundaryDescription — This zone originally bordered at least one other, different flooring material along a shared edge. Look at the STAGED image and describe what you see along that shared edge now: is a seam, threshold, or visible transition between two different floor materials still there, or does the flooring now appear to be a single continuous material with no boundary visible anywhere along that edge? Describe concretely what you observe — do not just answer yes/no.`
    : "";

  const schemaFields = multiZone
    ? `{"id": string, "materialDescription": string, "boundaryDescription": string}`
    : `{"id": string, "materialDescription": string}`;

  return `You are comparing an ORIGINAL (baseline) room photo against a STAGED (furnished) version of the same room, checking whether the flooring material(s) shown in the baseline are still genuinely present in the staged version.

${zoneList}${boundaryNote}

For EACH zone above, answer by describing what you actually observe — do not answer yes/no, and do not state a conclusion without describing the concrete visual evidence for it:

1. materialDescription — Look at the STAGED image at this same location. Describe concretely what flooring material you see there now (color, texture, pattern) — not a category label alone. State explicitly whether it is the same material described for this zone above, or whether it now looks like a different material (and if different, describe what it now resembles instead).${questionTwo}

${HUMAN_EYE_FRAMING}

Respond with ONLY a single valid JSON object: {"zones": [${schemaFields}]}`;
}

// ── Deterministic, code-only classification ──
// Same discipline as every other classifier in occlusionVsRemovalCheck.ts.
// FIRST REAL-API ITERATION (kept here as a record, mirroring how every
// other classifier's comments document real bugs found): an initial version
// checked SAME-patterns before CHANGED-patterns with narrow ~30-40 char
// windows. Run against the real Living 07 failure, it missed the violation
// entirely on all three zones. The model's actual answers were completely
// unambiguous — e.g. zone 2: "The original smooth, solid dark gray flooring
// is gone. This area is now covered with the same dark charcoal gray...
// carpet that is in the main part of the room (Zone 1)" — but two problems
// caused a false "preserved": (1) SAME-patterns were checked first, and the
// word "same" appears in that sentence describing a cross-zone
// CONTAMINATION ("now matches Zone 1's material", not "matches its own
// original material"), so a naive same-check win-first order was actively
// dangerous here, the opposite of the ABSENCE-patterns-first design used
// elsewhere in this file family; (2) "is gone" / "has been eliminated" / "no
// longer present" weren't in the pattern lists at all — a vocabulary gap,
// same class of bug as every other check tonight. Fixed by checking
// CHANGED/LOST patterns first (matching classifyPresence's absence-wins
// design) and widening windows / adding the missing phrasing, all
// calibrated against this real response text.
const MATERIAL_CHANGED_PATTERNS: RegExp[] = [
  /\bis (now )?gone\b/,
  /\bno longer (the same|matches?|present|there|visible)\b/,
  /\bdifferent material\b/,
  /\bnow (looks?|appears?|resembles?)[^.]{0,20}\blike\b/,
  /\binstead of\b/,
  /\bhas (changed|been changed) to\b/,
  /\brather than\b/,
  /\bhas been (unified|replaced|eliminated|erased)\b/,
  // "now covered with the same ... carpet that is in ... (Zone 1)" — the
  // real bug case above: referencing a DIFFERENT zone by name/number as the
  // source of the current material is itself strong evidence this zone's
  // own material was swapped, regardless of the word "same" appearing
  // nearby (it's "same as that OTHER zone", not "same as its own baseline").
  /\bnow covered (with|by)[^.]{0,80}\bzone\s*\d/i,
];
const MATERIAL_SAME_PATTERNS: RegExp[] = [
  /\bsame material\b/,
  /\bstill (looks?|appears?|is)[^.]{0,15}\bthe same\b/,
  /\b(consistent with|matches?)[^.]{0,25}\b(the )?(original|baseline|description|zone)\b/,
  /\bunchanged\b/,
  /\bno (visible )?(change|difference)[^.]{0,20}\bmaterial\b/,
  /\bcontinues? to be\b/,
  /\b(is|appears?( to be)?|remains?) the same\b/,
];

// NEGATION FIX: real test run (Grok, Bedroom 12 clean, run 2) produced "...
// it remains fully visible around the bed, nightstands, and dresser with NO
// CHANGE TO A DIFFERENT MATERIAL" — an explicit, unambiguous assertion of NO
// change — but `/\bdifferent material\b/` matched the bare substring
// "different material" without checking whether it sat inside a negated
// clause ("no change to a..."), wrongly returning
// materialMatchesOriginalZone=false on a genuinely clean case. This is the
// exact negation-blindness bug class already fixed twice tonight in
// occlusionVsRemovalCheck.ts (classifyResized/classifyRepositioned) — reused
// here via isLikelyNegated, but with FLOORING_NEGATION_CUE_PATTERN (which
// also covers bare "no", not just "no longer") since "no change to a
// different material" doesn't use "no longer". Confirmed via an offline
// re-check against the exact failing text after this fix: now correctly
// returns materialMatchesOriginalZone=true.
export function classifyMaterialMatch(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of MATERIAL_CHANGED_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index, 50, FLOORING_NEGATION_CUE_PATTERN)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of MATERIAL_SAME_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  return { value: true, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_material_matches" };
}

// Same real-case calibration as above. Zone 1's boundary answer mixed a
// PRESERVED boundary (to zone 3) and a LOST boundary (to zone 2) in one
// paragraph — a genuine multi-neighbor case this single-boolean-per-zone
// schema can't fully disambiguate, but that's fine: the check only needs to
// know whether ANY bordering boundary was lost to correctly flag the zone,
// so LOST-patterns matching anywhere in the text is the right behavior, not
// a limitation to work around. Confirmed real misses from the first
// iteration: "is no longer present" (subject 58+ chars before the match —
// past the old 30-char window), "has been eliminated", "with no visible
// seam" (the same adjective-between-negation-and-noun gap already fixed
// once in occlusionVsRemovalCheck.ts's ABSENCE_PATTERNS, recurring here
// because this is a separate pattern list), and "remains a distinct AND
// visible edge" (two adjectives joined by "and" before the noun, wider than
// a single optional-word slot could match).
const BOUNDARY_LOST_PATTERNS: RegExp[] = [
  /\bno (visible |longer visible )?(seam|threshold|boundary|transition|break|line)\b/,
  /\b(single|one) (continuous |uniform )?(flooring |floor )?(surface|expanse|material)\b/,
  /\bhas been eliminated\b/,
  /\bno longer present\b/,
  // "the boundary...is no longer visible" — subject-before-negation order,
  // the same class of gap as "is no longer visible" appearing standalone
  // rather than directly after "no [noun]"; a real miss found testing this
  // exact case (Living 07, zone 1's own boundary answer: "the boundary on
  // the right...is no longer visible", which the noun-then-"no [noun]"
  // pattern above can't reach since the noun comes first here, not after).
  /\bno longer visible\b/,
  /\bunified\b/,
  /\bsame material (throughout|everywhere|across)\b/,
  /\bflows? continuously\b/,
  /\bextends? continuously\b/,
  /\bcontinuous expanse\b/,
];
const BOUNDARY_VISIBLE_PATTERNS: RegExp[] = [
  /\bremains?[^.]{0,40}\b(edge|seam|boundary|line)\b/,
  /\bstill[^.]{0,20}\b(a |the )?(clear |visible )?(seam|threshold|boundary|transition|edge)\b/,
  /\bclearly (visible|separat)/,
  /\b(seam|threshold|boundary|transition|edge)[^.]{0,60}\bvisible\b/,
];

// Same negation fix applied here for consistency, even though the
// BOUNDARY_LOST list's own patterns mostly already embed "no"/"no longer" —
// a doubly-negated construction ("not... no longer visible") is rare but
// the uniform treatment costs nothing and matches how both pattern lists
// in classifyMaterialMatch above are now handled.
export function classifySeamVisible(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  // Loss patterns checked first: "no seam visible" would otherwise also
  // match a naive "visible" affirmative check.
  for (const p of BOUNDARY_LOST_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of BOUNDARY_VISIBLE_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  return { value: true, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_boundary_visible" };
}

export type FlooringVerdict = "preserved" | "material_changed" | "boundary_lost";

export type FlooringZoneCombinedResult = {
  id: string;
  materialDescription: string;
  baselineMaterialDescription: string;
  materialMatchesOriginalZone: boolean;
  seamStillVisibleAnywhere: boolean | null; // null = not applicable (single-zone room)
  confidence: number;
  altered: boolean;
  verdict: FlooringVerdict;
  rawObservation: FlooringObservationRaw;
  classification: {
    material: ClassifiedSignal;
    boundary: ClassifiedSignal | null;
  };
};

export function combineFlooringObservation(
  raw: FlooringObservationRaw,
  baselineMaterialDescription: string,
  multiZone: boolean
): FlooringZoneCombinedResult {
  const material = classifyMaterialMatch(raw.materialDescription);
  const boundary = multiZone ? classifySeamVisible(raw.boundaryDescription || "") : null;

  const materialMatchesOriginalZone = material.value;
  const seamStillVisibleAnywhere = boundary ? boundary.value : null;

  let altered = false;
  let verdict: FlooringVerdict = "preserved";
  if (!materialMatchesOriginalZone) {
    altered = true;
    verdict = "material_changed";
  } else if (multiZone && seamStillVisibleAnywhere === false) {
    altered = true;
    verdict = "boundary_lost";
  }

  const lowConfidence = material.confidence === "low" || (boundary ? boundary.confidence === "low" : false);

  return {
    id: raw.id,
    materialDescription: raw.materialDescription,
    baselineMaterialDescription,
    materialMatchesOriginalZone,
    seamStillVisibleAnywhere,
    confidence: lowConfidence ? 0.5 : 0.9,
    altered,
    verdict,
    rawObservation: raw,
    classification: { material, boundary },
  };
}

export type FlooringBoundaryCheckResult = {
  floor: ValidatorOutcome;
  applicable: boolean;
  zones: FlooringZone[];
  itemResults: FlooringZoneCombinedResult[];
  alteredZones: FlooringZoneCombinedResult[];
};

const NOT_APPLICABLE_OUTCOME: ValidatorOutcome = {
  status: "pass",
  reason: "flooring_boundary_check: no meaningful flooring zone data extracted from baseline — check not applicable",
  confidence: 0.5,
  hardFail: false,
  issueType: ISSUE_TYPES.NONE,
  issueTier: "none",
  advisorySignals: [],
};

export async function runFlooringBoundaryCheck(
  baselineImagePath: string,
  stagedImagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number },
  precomputedZones?: FlooringZone[]
): Promise<FlooringBoundaryCheckResult> {
  const zones = precomputedZones ?? await extractFlooringZones(baselineImagePath, ctx);

  if (zones.length === 0) {
    return { floor: NOT_APPLICABLE_OUTCOME, applicable: false, zones: [], itemResults: [], alteredZones: [] };
  }

  const multiZone = zones.length >= 2;
  const raw = await runOcclusionObservationCall({
    systemInstruction: "You are a careful visual inspector comparing two room photos for flooring material continuity.",
    userPrompt: buildFlooringObservationPrompt(zones),
    baselineImagePath,
    stagedImagePath,
    model: FLOORING_ZONE_MODEL,
    ctx: { ...ctx, callLabel: "flooring_boundary" },
  });

  const observations: FlooringObservationRaw[] = Array.isArray(raw?.zones) ? raw.zones : [];
  const byId = new Map(zones.map((z) => [z.id, z]));

  const itemResults: FlooringZoneCombinedResult[] = observations.map((obs) => {
    const zone = byId.get(obs.id);
    return combineFlooringObservation(obs, zone?.materialDescription || "(unknown baseline zone)", multiZone);
  });

  const alteredZones = itemResults.filter((r) => r.altered);

  const structuredIssues: StructuredIssue[] = alteredZones.length === 0
    ? []
    : [createStructuredIssue({
        type: "floor_change",
        object: "floor_material",
        action: alteredZones.some((z) => z.verdict === "material_changed") ? "replaced" : "changed",
        severity: mapIssueTierToSeverity(classifyIssueTier(ISSUE_TYPES.FLOOR_CHANGED)),
        source: "flooring_boundary_check",
        confidence: Math.min(...alteredZones.map((z) => z.confidence)),
        evidence: alteredZones.map((z) => `${z.id}:${z.verdict}`),
      })];

  const floor: ValidatorOutcome =
    alteredZones.length === 0
      ? { status: "pass", reason: "flooring_boundary_check: all zones preserved (material and, where applicable, boundary)", confidence: 0.9, hardFail: false, issueType: ISSUE_TYPES.NONE, issueTier: "none", advisorySignals: [] }
      : {
          status: "fail",
          reason: `flooring_boundary_check: ${alteredZones.map((z) => `${z.id} (baseline: "${z.baselineMaterialDescription}"): verdict=${z.verdict} — ${z.verdict === "boundary_lost" ? z.rawObservation.boundaryDescription : z.rawObservation.materialDescription}`).join(" | ")}`,
          confidence: Math.min(...alteredZones.map((z) => z.confidence)),
          hardFail: true,
          issueType: ISSUE_TYPES.FLOOR_CHANGED,
          issueTier: classifyIssueTier(ISSUE_TYPES.FLOOR_CHANGED),
          advisorySignals: alteredZones.map((z) => `${z.id}:${z.verdict}`),
          primaryStructuredIssue: structuredIssues[0],
          structuredIssues,
        };

  console.log("[FLOORING_BOUNDARY_CHECK_RESULT]", JSON.stringify({
    jobId: ctx.jobId,
    imageId: ctx.imageId,
    zoneCount: zones.length,
    multiZone,
    status: floor.status,
    alteredZoneIds: alteredZones.map((z) => z.id),
  }));

  return { floor, applicable: true, zones, itemResults, alteredZones };
}
