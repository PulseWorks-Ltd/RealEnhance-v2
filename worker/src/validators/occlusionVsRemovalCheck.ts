// Shared deterministic occlusion-vs-removal mechanism, used by both
// openingEnvelopeValidator.ts and fixtureFlooringValidator.ts.
//
// HISTORY, this is now the second rebuild:
//
// v1 (single holistic "altered: yes/no" per item) was unstable: the same
// hard cases flipped between false-positive and false-negative across
// three prompt rewrites.
//
// v2 (three yes/no booleans — traceVisible / replacedByContinuousSurface /
// itemExtendsBeyondCoveringObject — combined deterministically in code)
// isolated the instability to the model's PERCEPTION, not the combination
// logic (which behaved correctly every time it was inspected) — but the
// perception step was still unreliable, because a yes/no question lets the
// model default to agreeing with what it already "knows" the item to be
// (from the baseline description sitting right next to the question)
// rather than actually re-examining the staged image. Direct evidence:
// Living 10's fully-removed window got `traceVisible: true, "clearly
// visible, although a dining set is placed in front of it"` — a
// fabricated confirmation echoing the baseline's own description of a
// large window, not a real observation of the staged photo.
//
// v3 (this file): the model is never asked yes/no for these three checks.
// It is asked to LOCATE AND DESCRIBE, in free text, what it currently sees
// at each coordinate — a question with no "agree with the premise" shape
// to default to. Classification of that free text into the same three
// boolean signals `combineOcclusionAnswer` needs is now a SEPARATE,
// deterministic, code-only step (kept intentionally simple/inspectable —
// see classifyPresence/classifyReplacement/classifyExtent below), not
// something the model or a holistic judgment produces.
//
// v3.1 — FOURTH QUESTION (size/position): a standalone real-API test
// (tmp/test_resize_direct_question.ts, see conversation record) found
// that the first three questions have a genuine, structural blind spot —
// they only ever ask about presence/coverage, never about whether the
// item's own visible size or position has changed. On Bedroom 09's real
// W1 (a window resized and shifted along the wall between baseline and
// staged, with no removal/coverage involved at all), all three existing
// questions correctly reported "present, unobstructed" every time — 0/4
// runs across both models flagged anything, because nothing asked them
// to. When asked a direct, locate/describe question comparing the item's
// current extent against its known baseline bbox, both models caught it
// cleanly and consistently, 4/4 runs. This question is added here as a
// fourth, independent dimension, following the same non-yes/no design and
// the same downstream code-only classification as the other three — see
// classifyResized/classifyRepositioned below. The model is asked for a
// description, never a boolean; the two boolean signals the standalone
// test took directly from the model are instead derived from that
// description in code, for consistency with the other three checks and
// because the whole point of this file is that model-produced verdicts —
// even boolean ones sitting alongside a description — aren't trusted
// where a deterministic parse of the description will do.
//
// STRUCTURAL FIX for the baseline-description-adjacency problem: the
// observation questions are answered using ONLY each item's id and its
// baseline bounding box (pure geometry — a location, not a description of
// content). No type or description is present anywhere near those
// questions in the prompt. Only afterward, in a clearly separate section
// of the same prompt (introduced only once the observation schema is
// already fully specified), is each item's real type/description revealed
// — and only for the separate materiality judgment, which is a different
// question ("is this worth caring about") that legitimately needs to know
// what the item is. Note the honest limitation: this is one Gemini call,
// so the model technically has the entire prompt in context before
// generating anything — text ordering cannot make information literally
// invisible the way a second, separate call would. What this structure
// does is remove the type/description from being adjacent to, or even
// present anywhere within, the observation section's questions and item
// list, so there is no premise sitting next to the question for the model
// to agree with. See the validator files for how the two phases are laid
// out in the actual prompt text.
import { getGeminiClient } from "../ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../ai/grok";

// STAGE2_VALIDATOR_MODEL — independent of STAGE2_PROMPT_VARIANT (the
// generation-model toggle in pipeline/stage2.ts). Which model GENERATES
// the staged image and which model VALIDATES it are two separate
// decisions; this module reads its own env var and has no reference to
// STAGE2_PROMPT_VARIANT anywhere. Default "gemini" preserves existing
// behavior exactly.
export type ValidatorModel = "gemini" | "grok";
export function resolveValidatorModel(): ValidatorModel {
  return String(process.env.STAGE2_VALIDATOR_MODEL || "gemini").trim().toLowerCase() === "grok" ? "grok" : "gemini";
}
import { toBase64 } from "../utils/images";
import { logGeminiUsage } from "../ai/usageTelemetry";

export const HUMAN_EYE_FRAMING = `Answer every question below the way an ordinary person glancing at the photo would — not the way a forensic pixel-by-pixel comparison would. This cuts both ways: do not miss a genuine removal just because some tiny fragment is technically still rendered somewhere (a real visitor would not notice a sliver and conclude the feature is still there); and do not flag normal, expected furniture or decor placement as a violation just because it sits near or partly in front of something — a real visitor glancing at the room would not perceive that as a structural change. Ask yourself, for each question: what would a person actually notice, standing in the room and glancing at this spot — not what a zoomed-in crop would reveal.`;

export type OcclusionCheckItem = {
  id: string;
  type: string;
  description: string;
  bbox?: [number, number, number, number];
  extra?: Record<string, unknown>;
};

// Raw model output for the observation phase: pure free text, no booleans,
// no categorical tags — nothing the model can fill in without actually
// describing something concrete.
export type OcclusionObservationRaw = {
  id: string;
  currentStateDescription: string;
  currentSurfaceDescription: string;
  coverageExtentDescription: string;
  extentComparisonDescription: string;
};

export type ClassificationConfidence = "high" | "low";

export type ClassifiedSignal = {
  value: boolean;
  confidence: ClassificationConfidence;
  matchedPattern: string;
};

// The full audit trail for one item: raw free text the model wrote, the
// classified signal derived from each piece of text, and (once combined)
// the final verdict. Nothing here is discarded — a human can check the
// classification step against the raw text directly.
export type OcclusionCheckAnswer = {
  id: string;
  traceVisible: boolean;
  replacedByContinuousSurface: boolean;
  itemExtendsBeyondCoveringObject: boolean;
  extentChanged: boolean;
  confidence: number;
  // Audit trail
  rawObservation: OcclusionObservationRaw;
  classification: {
    trace: ClassifiedSignal;
    replacement: ClassifiedSignal;
    extent: ClassifiedSignal;
    resized: ClassifiedSignal;
    repositioned: ClassifiedSignal;
  };
};

export type OcclusionVerdict = "occlusion" | "removed" | "replaced" | "fully_covered" | "resized";

export type OcclusionCombinedResult = OcclusionCheckAnswer & {
  altered: boolean;
  verdict: OcclusionVerdict;
};

// v3 (unchanged from that rebuild, per that task's explicit constraint):
// occlusion (acceptable, NOT altered) requires ALL of:
//     - traceVisible = true
//     - replacedByContinuousSurface = false
//     - itemExtendsBeyondCoveringObject = true
//   any single failure of those three => altered = true.
//
// v3.1 (this task) adds one more conjunct: even when all three original
// checks would say "occlusion" (present, not replaced, not fully covered),
// a material item whose own visible size or position has genuinely
// changed relative to its known baseline extent is still altered — this
// is a different failure mode (a resize/reposition, not a coverage issue)
// and gets its own distinguishable verdict ("resized") rather than being
// folded into "occlusion" or any of the other three labels.
export function combineOcclusionAnswer(answer: OcclusionCheckAnswer): OcclusionCombinedResult {
  const isOcclusion =
    answer.traceVisible === true &&
    answer.replacedByContinuousSurface === false &&
    answer.itemExtendsBeyondCoveringObject === true &&
    answer.extentChanged === false;

  if (isOcclusion) {
    return { ...answer, altered: false, verdict: "occlusion" };
  }
  if (answer.replacedByContinuousSurface) {
    return { ...answer, altered: true, verdict: "replaced" };
  }
  if (!answer.traceVisible) {
    return { ...answer, altered: true, verdict: "removed" };
  }
  if (answer.itemExtendsBeyondCoveringObject === false) {
    return { ...answer, altered: true, verdict: "fully_covered" };
  }
  return { ...answer, altered: true, verdict: "resized" };
}

// ── Deterministic, code-only classification of the free-text answers ──
// Deliberately simple pattern matching, not another model call: the whole
// point of this rebuild is that a holistic judgment (model or otherwise)
// is not trustworthy for this specific question. Absence patterns are
// checked first and win on match (a sentence naming a part while also
// explicitly negating overall presence, e.g. "no frame or glass is
// visible", should classify as absent even though it contains "frame").
// Every classification carries a confidence: "low" means no pattern
// matched and a default was used — these are the cases most worth a human
// spot-check, and are reported as such.

const ABSENCE_PATTERNS: RegExp[] = [
  /\bno (trace|sign|part|portion|evidence|remnant)s?\b[^.]{0,60}\b(visible|remains?|present|found|seen|remaining)\b/,
  /\bnothing resembling\b/,
  /\bnothing( of it| of the (original|window|door|opening|fixture))?( is| remains)? visible\b/,
  /\b(cannot|can't|unable to) (find|locate|see|identify|detect) (any|a|the)\b/,
  /\bno longer (visible|present|there|exists?)\b/,
  /\b(completely|entirely|fully) (gone|removed|absent|missing)\b/,
  /\bnone( of it| of the \w+)?( is| remains| are)? visible\b/,
  /\bnot visible\b/,
  /\b(is|are|was|were) not (present|there|visible)\b/,
  /\bno \w+(?:\s\w+){0,2} (is|are|remains?) visible\b/,
  // "No window frame, glass, blind, sill, or similar structure is visible
  // anywhere in this region" — a real bug found in cross-model testing
  // (Grok's phrasing tends toward longer comma-separated lists of absent
  // parts than Gemini's shorter phrasing): the pattern directly above only
  // allows up to 3 words between "no" and "is/are visible", so a longer
  // list of alternatives fell through and the bare noun "window" then
  // matched the presence-vocabulary check below, wrongly classifying a
  // plainly-stated, detailed absence as presence.
  /\bno [\w,]+(?:[\s,]+(?:or\s+)?[\w]+){0,10} (is|are|remains?) visible\b/,
  // "There is no closet door visible" / "is no X visible" — the negation
  // ("no") precedes the noun, with the verb BEFORE "no" rather than
  // between the noun and "visible". Missing this exact English
  // construction was a real bug found in testing: the bare noun ("door")
  // then fell through to the presence-vocabulary check below and matched,
  // wrongly classifying a plainly-stated absence as presence.
  /\b(?:there )?(?:is|are) no [\w\s]{1,25}?\bvisible\b/,
  // "There is no visible sign of a door" — adjective-before-noun order
  // ("no VISIBLE SIGN of X"), the mirror image of the trace/sign/evidence
  // pattern above which only covered noun-before-visible order ("no sign
  // of X ... visible"). Also a real bug found in testing: this sentence
  // matched no absence pattern and fell through to the bare noun "door"
  // in the presence-vocabulary check.
  /\bno visible (sign|trace|evidence|indication)s? of\b/,
  /\bhas been (removed|eliminated)\b/,
  /\bno longer any (trace|sign|evidence)\b/,
];

// Opening-specific part vocabulary. Real testing found two classes of bug
// here worth recording explicitly, since they're exactly the kind of thing
// this classification step is supposed to make inspectable:
//   (1) VOCABULARY GAP: this list originally covered only opening
//       (window/door) vocabulary, so fixture descriptions like "a light
//       fixture is visible on the ceiling, clearly visible" matched
//       nothing and silently defaulted to "absent" despite plainly
//       asserting presence. Fixed by adding PRESENCE_FIXTURE_PATTERN below
//       and a vocabulary-agnostic AFFIRMATIVE_PRESENCE_PATTERN fallback.
//   (2) KEYWORD COLLISION: generic words like "mirror", "frame", "edge",
//       "corner", "trim", "handle", "knob" describe the ORIGINAL item in
//       some sentences but describe NEW COVERING FURNITURE in others (a
//       leaning decorative mirror placed in front of a door matched
//       "mirror" and was wrongly read as evidence of the door's own
//       mirrored surface). Fixed by dropping the bare collision-prone
//       words and requiring them compounded with door/window context
//       (e.g. "door frame", "mirrored closet door") so a generic mention
//       of unrelated furniture can't trigger a false match.
const PRESENCE_PART_PATTERN =
  /\b(glass|pane|sill|jamb|mullion|header|threshold|hinge|casing|molding|moulding|lintel|reveal|astragal|blind|curtain rod|window|door(?:way)?|opening|door[- ]?frame|window[- ]?frame|door[- ]?handle|door[- ]?knob|door[- ]?trim|door[- ]?leaf|mirrored (?:closet |wardrobe |sliding )?(?:door|panel|track)|sliding (?:door |panel )?track)\b/;

// Fixture/general vocabulary — covers the anchor-fixture types
// (fireplace/hearth/mantel, light fixtures, AC/HVAC, built-ins, islands,
// staircases, plumbing) that PRESENCE_PART_PATTERN was never meant to
// cover, plus a vocabulary-agnostic fallback: any affirmative visibility
// phrase ("is visible", "clearly visible", "remains present", "is still
// there") counts as presence evidence regardless of what the item is,
// since the question always asks the model to describe what it sees and a
// direct affirmative statement is itself concrete evidence, not a bare
// yes/no shortcut. Negation is checked explicitly afterward (see
// classifyPresence) since a naive version of this pattern would otherwise
// match "are NOT visible" as if it were affirmative.
const PRESENCE_FIXTURE_PATTERN =
  /\b(fireplace|hearth|mantel|flue|firebox|wood ?stove|light fixture|pendant|chandelier|downlight|flush[- ]mount|sconce|fan blade|hvac|split unit|condenser|vent|ductwork|cabinet(?:ry)?|shelving|shelf|island|countertop|benchtop|stair(?:case|way)?|tread|riser|baluster|handrail|banister|sink|basin|faucet|tap|stovetop|cooktop|hob|range|oven)\b/;

const AFFIRMATIVE_PRESENCE_PATTERN =
  /\b(is|are|remains?|stays?|appears? to be)\b[^.]{0,25}\b(clearly |fully |still |plainly )?(visible|present|there|intact|unchanged)\b/;

export function classifyPresence(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of ABSENCE_PATTERNS) {
    if (p.test(t)) return { value: false, confidence: "high", matchedPattern: p.source };
  }
  const partMatch = t.match(PRESENCE_PART_PATTERN) || t.match(PRESENCE_FIXTURE_PATTERN);
  if (partMatch) return { value: true, confidence: "high", matchedPattern: partMatch[0] };
  const affirmativeMatch = t.match(AFFIRMATIVE_PRESENCE_PATTERN);
  if (affirmativeMatch && !/\bnot\b/.test(affirmativeMatch[0])) {
    return { value: true, confidence: "high", matchedPattern: affirmativeMatch[0] };
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_absent" };
}

const REPLACED_PATTERNS: RegExp[] = [
  /\b(continuous|unbroken|seamless|uninterrupted)\b[^.]{0,30}\b(wall|surface|drywall|plaster)\b/,
  /\bno (seam|break|gap|joint|discontinuity)\b/,
  /\breplaced (by|with) a\b/,
  /\bflush (against|with)[^.]{0,20}\b(plain )?wall\b/,
  /\bsolid[, ]+continuous wall\b/,
  /\bplain(,)? (unbroken|continuous) wall\b/,
];

const NOT_REPLACED_PATTERNS: RegExp[] = [
  /\bin front of\b/,
  /\bpositioned in front\b/,
  /\bpartially in front\b/,
  /\bplaced (in front of|near|beside|next to)\b/,
  /\b(visible|seen)[^.]{0,15}\b(above|beside|around|beyond|behind|next to)\b/,
  /\btrack[^.]{0,15}visible\b/,
  // Fixture-relevant: the item itself is described as attached/mounted to
  // a surface, which means the item is the subject present at this
  // location, not something a new surface has replaced.
  /\b(attached to|mounted (on|to)|installed (on|in)|fixed to|fitted to|sitting on|resting on)\b/,
];

export function classifyReplacement(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of REPLACED_PATTERNS) {
    if (p.test(t)) return { value: true, confidence: "high", matchedPattern: p.source };
  }
  for (const p of NOT_REPLACED_PATTERNS) {
    if (p.test(t)) return { value: false, confidence: "high", matchedPattern: p.source };
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_not_replaced" };
}

const NO_NEW_OBJECT_PATTERNS: RegExp[] = [
  /\bnothing new\b/,
  /\bno (new )?(object|furniture|item)[^.]{0,20}(occupies|covers|is present)\b/,
  /\bnot occupied\b/,
];
const STAYS_WITHIN_PATTERNS: RegExp[] = [
  /\bstays?( entirely)? within\b/,
  /\bwithin (that|the|its) (region|footprint|extent|bounds?)\b/,
  /\bdoes not extend (beyond|past)\b/,
  /\bremains? within\b/,
];
const EXTENDS_BEYOND_PATTERNS: RegExp[] = [
  /\bextends?[^.]{0,25}\b(beyond|past)\b/,
  /\bexceeds?[^.]{0,25}\b(region|footprint|extent|bounds?)\b/,
  /\blarger than[^.]{0,20}(region|footprint|extent)\b/,
];

// true = item extends beyond the covering object (occlusion-friendly);
// false = the covering object's own edge extends beyond/over the item's
// region (the item is more fully swallowed).
export function classifyExtent(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of NO_NEW_OBJECT_PATTERNS) {
    if (p.test(t)) return { value: true, confidence: "high", matchedPattern: p.source };
  }
  for (const p of STAYS_WITHIN_PATTERNS) {
    if (p.test(t)) return { value: true, confidence: "high", matchedPattern: p.source };
  }
  for (const p of EXTENDS_BEYOND_PATTERNS) {
    if (p.test(t)) return { value: false, confidence: "high", matchedPattern: p.source };
  }
  return { value: true, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_extends_beyond" };
}

// ── Fourth question's classifier: resized / repositioned ──
// Same defensive design as the other three: explicit "unchanged" patterns
// checked FIRST and win on match, so a description that happens to
// mention a size-ish word while actually asserting sameness (e.g. "the
// window is roughly the same size as before, just partly covered by a
// lamp") doesn't get misread. Unlike the other three checks, the SAFE
// default here (no pattern matched at all) is "false" — no change
// detected — not the opposite: this question was added specifically
// because of a real false-negative gap, but the regression risk the task
// called out explicitly is the opposite failure (a NEW false positive on
// a genuinely unchanged item), so an ambiguous/unparseable description
// should not by itself drive a fail.
const SAME_SIZE_PATTERNS: RegExp[] = [
  /\bsame (size|footprint|shape|proportions?|dimensions?)\b/,
  /\broughly the same size\b/,
  /\b(consistent with|matches?)[^.]{0,25}\boriginal (size|footprint|shape|region|extent)\b/,
  /\bunchanged in size\b/,
  /\bno (significant |noticeable |real |visible )?(change|difference)[^.]{0,20}\bsize\b/,
];
const RESIZED_PATTERNS: RegExp[] = [
  /\b(narrower|wider|taller|shorter|smaller|larger|bigger)\b/,
  /\bdifferent (size|proportions?|footprint|shape|dimensions?)\b/,
  /\b(more|less) (square|rectangular|elongated|compressed)\b/,
  /\b(half|double|twice)[^.]{0,15}\b(the )?(original )?(size|width|height)\b/,
  /\bsubstantially (smaller|larger)\b/,
];

export function classifyResized(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of SAME_SIZE_PATTERNS) {
    if (p.test(t)) return { value: false, confidence: "high", matchedPattern: p.source };
  }
  for (const p of RESIZED_PATTERNS) {
    if (p.test(t)) return { value: true, confidence: "high", matchedPattern: p.source };
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_not_resized" };
}

const SAME_POSITION_PATTERNS: RegExp[] = [
  /\bsame (position|location|placement|spot)\b/,
  /\bunchanged (position|location|placement)\b/,
  /\bremains? in the same\b/,
  /\bno (significant |noticeable |real |visible )?(change|difference|shift)[^.]{0,20}\bposition\b/,
];
const REPOSITIONED_PATTERNS: RegExp[] = [
  /\b(left|right|up|down)[- ]?shifted\b/,
  /\bshift(?:ed)?[^.]{0,20}\b(left|right|up|down|along)\b/,
  /\b(moved|relocated|repositioned)\b/,
  /\bdifferent position\b/,
  /\b(further|farther|closer)[^.]{0,15}\b(from|to|than)\b/,
  /\bpositioned[^.]{0,20}\b(left|right|upper|lower|top|bottom) (portion|part|side|edge)\b/,
];

export function classifyRepositioned(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of SAME_POSITION_PATTERNS) {
    if (p.test(t)) return { value: false, confidence: "high", matchedPattern: p.source };
  }
  for (const p of REPOSITIONED_PATTERNS) {
    if (p.test(t)) return { value: true, confidence: "high", matchedPattern: p.source };
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_not_repositioned" };
}

export function classifyObservation(raw: OcclusionObservationRaw): Omit<OcclusionCheckAnswer, "rawObservation"> {
  const trace = classifyPresence(raw.currentStateDescription);
  const replacement = classifyReplacement(raw.currentSurfaceDescription);
  const extent = classifyExtent(raw.coverageExtentDescription);
  const resized = classifyResized(raw.extentComparisonDescription);
  const repositioned = classifyRepositioned(raw.extentComparisonDescription);
  const anyLow = trace.confidence === "low" || replacement.confidence === "low" || extent.confidence === "low";
  return {
    id: raw.id,
    traceVisible: trace.value,
    replacedByContinuousSurface: replacement.value,
    itemExtendsBeyondCoveringObject: extent.value,
    extentChanged: resized.value || repositioned.value,
    confidence: anyLow ? 0.5 : 0.9,
    classification: { trace, replacement, extent, resized, repositioned },
  };
}

function formatBboxRegion(bbox: [number, number, number, number] | undefined): string {
  if (!bbox) return "(no coordinates given)";
  const [x1, y1, x2, y2] = bbox;
  return `x: ${x1.toFixed(2)}–${x2.toFixed(2)}, y: ${y1.toFixed(2)}–${y2.toFixed(2)} (normalized fractions of image width/height, 0,0 = top-left)`;
}

export function buildObservationOnlyItemList(items: OcclusionCheckItem[]): string {
  // Deliberately id + bbox ONLY — no type, no description anywhere here.
  return items.map((it) => `- id: ${it.id}, region: ${formatBboxRegion(it.bbox)}`).join("\n");
}

export function buildObservationQuestionsInstruction(itemLabelPlural: string): string {
  return `For EACH ${itemLabelPlural} region listed below, answer four questions by describing what you actually see — do not answer yes/no, and do not state a conclusion without describing the concrete visual evidence for it.

1. currentStateDescription — Look at the CURRENT (staged) image at this region. Describe literally what is visible there right now. If you can identify any part of the original item's own physical structure — a frame edge, glass, a door leaf, a track, a mounting bracket, a mirror surface, a sill, molding, trim, or similar — name specifically which part(s) you see and roughly where within the region. If you cannot find anything resembling such structure anywhere in or immediately around that region, state that plainly and describe what occupies the space instead.

2. currentSurfaceDescription — Independent of the above, describe what physically covers or occupies this exact region in the CURRENT image. Describe the actual material, surface, or object present (for example: "painted drywall, no seam or break visible," "a large framed painting hanging flush against a plain wall," "a wooden dresser with a mirror door track visible above and beside it," "a dining chair positioned in front of a glass pane"). Do not answer with a category label alone.

3. coverageExtentDescription — Compare the region's own boundary to whatever new furniture, decor, or object occupies it now. Does the new object's own visible edge stay entirely within the region, or does it extend past the region's boundary (name the direction — up/down/left/right — and roughly by how much)? If nothing new occupies the region at all, say so.

4. extentComparisonDescription — Independent of coverage by furniture, look at the item's OWN edges (its own frame/boundary, not anything placed in front of it) in the CURRENT image and compare them to the region given for it above. Does it occupy roughly the same footprint and shape as that region, or is the item itself visibly larger, smaller, taller, wider, more/less square, or shifted in position along the wall relative to that region? Describe concretely what you observe about its own size, shape, and position — do not just answer "changed" or "unchanged," and do not discuss furniture or obstruction here, only the item's own extent.

${HUMAN_EYE_FRAMING}

Do this for EVERY region above BEFORE reading anything else in this prompt. You do not need to know what each region originally contained to answer these four questions — describe only what you currently observe there.`;
}

export function buildObservationSchemaText(): string {
  return `{
      "id": string,
      "currentStateDescription": string,
      "currentSurfaceDescription": string,
      "coverageExtentDescription": string,
      "extentComparisonDescription": string
    }`;
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function runOcclusionObservationCall(params: {
  systemInstruction: string;
  userPrompt: string;
  baselineImagePath: string;
  stagedImagePath: string;
  model: string;
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<any> {
  const original = toBase64(params.baselineImagePath);
  const staged = toBase64(params.stagedImagePath);
  const validatorModel = resolveValidatorModel();
  const requestStartedAt = Date.now();

  if (validatorModel === "grok") {
    const text = await grokAnalyzeImages({
      images: [
        { buffer: Buffer.from(original.data, "base64"), mimeType: original.mime, label: "Image A (original/baseline):" },
        { buffer: Buffer.from(staged.data, "base64"), mimeType: staged.mime, label: "Image B (staged output):" },
      ],
      prompt: `${params.systemInstruction}\n\n${params.userPrompt}`,
      jobId: params.ctx.jobId,
      imageId: params.ctx.imageId,
      reason: `occlusion_check_${params.ctx.callLabel}`,
      expectJson: true,
    });
    console.log(
      JSON.stringify({
        event: "GROK_VALIDATOR_USAGE",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: "validator",
        callLabel: params.ctx.callLabel,
        model: grokVisionModel(),
        latencyMs: Date.now() - requestStartedAt,
      })
    );
    return extractJsonFromModelText(text);
  }

  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: params.model,
    contents: [
      {
        role: "user",
        parts: [
          { text: params.systemInstruction },
          { text: params.userPrompt },
          { text: "Image A (original/baseline):" },
          { inlineData: { mimeType: original.mime, data: original.data } },
          { text: "Image B (staged output):" },
          { inlineData: { mimeType: staged.mime, data: staged.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 4096, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: params.ctx.attempt ?? 1 },
    model: params.model,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error(`OCCLUSION_CHECK[${params.ctx.callLabel}]: no text returned`);
  return extractJsonFromModelText(textPart.text);
}
