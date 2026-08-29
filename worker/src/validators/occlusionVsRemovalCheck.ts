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
import { AsyncLocalStorage } from "node:async_hooks";
import { getGeminiClient } from "../ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../ai/grok";

// STAGE2_VALIDATOR_MODEL — independent of STAGE2_PROMPT_VARIANT (the
// generation-model toggle in pipeline/stage2.ts). Which model GENERATES
// the staged image and which model VALIDATES it are two separate
// decisions; this module reads its own env var and has no reference to
// STAGE2_PROMPT_VARIANT anywhere. Default "gemini" preserves existing
// behavior exactly.
export type ValidatorModel = "gemini" | "grok";

// Per-call-tree override for resolveValidatorModel() below — e.g. worker.ts's
// specialist-validation retry loop forcing Gemini for one final attempt
// after Grok has already failed to run twice (a 500, an empty response, a
// timeout). Deliberately AsyncLocalStorage-based rather than a mutable
// module/env variable: this whole validator subsystem runs several jobs
// concurrently (confirmed in production logs — WORKER_CONCURRENCY>1), and a
// shared mutable "current override" would leak one job's forced model
// choice into another job's concurrent validation calls. AsyncLocalStorage
// scopes the override to only the async call tree started inside
// runWithForcedValidatorModel, with no cross-job interference.
const validatorModelOverride = new AsyncLocalStorage<ValidatorModel>();

export function runWithForcedValidatorModel<T>(model: ValidatorModel, fn: () => Promise<T>): Promise<T> {
  return validatorModelOverride.run(model, fn);
}

export function resolveValidatorModel(): ValidatorModel {
  const forced = validatorModelOverride.getStore();
  if (forced) return forced;
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
  // Fifth question (sliding/pocket door fix): see classifyStructuralEvidence
  // and combineOcclusionAnswer's "preserved_closed" path below.
  structuralEvidenceDescription: string;
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
  // True when the fifth question found concrete structural evidence (a
  // track, frame, jamb, pocket edge, reveal, hinge, threshold, or sill) —
  // see combineOcclusionAnswer's "preserved_closed" path. Does NOT by
  // itself mean occlusion; it only rescues what would otherwise be
  // "removed"/"replaced" specifically.
  structuralEvidenceFound: boolean;
  confidence: number;
  // Audit trail
  rawObservation: OcclusionObservationRaw;
  classification: {
    trace: ClassifiedSignal;
    replacement: ClassifiedSignal;
    extent: ClassifiedSignal;
    resized: ClassifiedSignal;
    repositioned: ClassifiedSignal;
    structuralEvidence: ClassifiedSignal;
  };
};

export type OcclusionVerdict = "occlusion" | "removed" | "replaced" | "fully_covered" | "resized" | "preserved_closed";

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
// v3.1 adds one more conjunct: even when all three original checks would
// say "occlusion" (present, not replaced, not fully covered), a material
// item whose own visible size or position has genuinely changed relative
// to its known baseline extent is still altered — this is a different
// failure mode (a resize/reposition, not a coverage issue) and gets its
// own distinguishable verdict ("resized") rather than being folded into
// "occlusion" or any of the other three labels.
//
// v3.2 (sliding/pocket door fix) adds a rescue path, NOT a fifth conjunct
// on isOcclusion — it only ever activates once isOcclusion has already
// failed, and only ever overrides "replaced" or "removed" specifically.
// Real, confirmed case (Bedroom 14 Run 2's closet, user-verified by direct
// visual crop inspection): a CLOSED sliding/pocket door can genuinely fail
// both traceVisible (Q1 sees no door leaf, correctly — the leaf is
// retracted into the wall) and replacedByContinuousSurface (Q2 describes
// the visible surface as plain wall, also correctly — that's what a closed
// pocket door's face looks like) while the opening itself is completely
// intact. The fifth question (structuralEvidenceDescription) asks
// specifically for track/frame/jamb/pocket/hinge/threshold/sill evidence —
// a different, more forceful observation than "does this look like a
// wall," the same design principle that made the resize/reposition and
// flooring-boundary questions work where a generic description question
// didn't. Deliberately does NOT touch "fully_covered" or "resized" — this
// signal has no bearing on either failure mode.
export function combineOcclusionAnswer(answer: OcclusionCheckAnswer): OcclusionCombinedResult {
  const isOcclusion =
    answer.traceVisible === true &&
    answer.replacedByContinuousSurface === false &&
    answer.itemExtendsBeyondCoveringObject === true &&
    answer.extentChanged === false;

  if (isOcclusion) {
    return { ...answer, altered: false, verdict: "occlusion" };
  }
  if (
    answer.structuralEvidenceFound === true &&
    (answer.replacedByContinuousSurface === true || !answer.traceVisible)
  ) {
    return { ...answer, altered: false, verdict: "preserved_closed" };
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
  // "There is no visible door, frame, handle, or seam indicating an
  // opening" — real production case (job_b29d5e7d, "Bedroom 14", Run 2):
  // "no visible" is directly followed by the noun itself (door/frame/
  // handle/seam), not by sign/trace/evidence/indication as the pattern
  // above expects, and the noun list is followed by a purpose clause
  // ("indicating an opening") rather than ending cleanly. This fell
  // through to the bare "door" match in PRESENCE_PART_PATTERN and was
  // wrongly classified as presence despite the model plainly stating the
  // opposite. Only needs to match the first noun after "no visible" —
  // the absence-patterns-win-first design handles the rest.
  /\bno visible (door|window|opening|frame|handle|knob|hinge|seam|track|sill|jamb|threshold|casing|molding|moulding)/,
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

// AUDIT FIX: this function had zero negation guarding anywhere — the
// ad-hoc `!/\bnot\b/.test(affirmativeMatch[0])` check only ever existed on
// the last branch, and PRESENCE_PART_PATTERN/PRESENCE_FIXTURE_PATTERN (the
// most-hit branch in practice) had none at all. Confirmed vulnerable
// offline before this fix: classifyPresence("The window isn't visible
// anywhere in this region; only a blank painted wall is present where it
// used to be.") returned {value: true, matchedPattern: "window"} — the
// bare noun match fired with no check that "window" sat right next to an
// explicit negation.
export function classifyPresence(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of ABSENCE_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  // Bare single-noun match is unlike every other pattern in this file: a
  // lone noun has no fixed word-order relationship to a nearby negation.
  // "There isn't a window visible" (cue before) and "the window isn't
  // visible" (cue after) are equally natural phrasing, but isLikelyNegated
  // only looks backward from the match. Checked in both directions here —
  // a match negated either way should not stand — without adding any new
  // vocabulary pattern.
  const partMatch = t.match(PRESENCE_PART_PATTERN) || t.match(PRESENCE_FIXTURE_PATTERN);
  if (partMatch && partMatch.index !== undefined) {
    const matchEnd = partMatch.index + partMatch[0].length;
    const negatedBefore = isLikelyNegated(t, partMatch.index);
    const negatedAfter = NEGATION_CUE_PATTERN.test(t.slice(matchEnd, matchEnd + 50));
    if (!negatedBefore && !negatedAfter) {
      return { value: true, confidence: "high", matchedPattern: partMatch[0] };
    }
  }
  // AFFIRMATIVE_PRESENCE_PATTERN's own [^.]{0,25} gap can itself contain a
  // negation ("is NOT clearly visible") — checked through the match's END
  // (not just its start) so an interior negation is still caught, the way
  // the old ad-hoc check did, but via the shared, contraction-aware helper
  // instead of a bespoke literal-"not" test that missed "isn't"/"doesn't".
  const affirmativeMatch = t.match(AFFIRMATIVE_PRESENCE_PATTERN);
  if (affirmativeMatch && affirmativeMatch.index !== undefined) {
    const matchEnd = affirmativeMatch.index + affirmativeMatch[0].length;
    if (!isLikelyNegated(t, matchEnd)) {
      return { value: true, confidence: "high", matchedPattern: affirmativeMatch[0] };
    }
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_absent" };
}

const REPLACED_PATTERNS: RegExp[] = [
  // "plain" added alongside continuous/unbroken/seamless/uninterrupted:
  // real production case (job_b29d5e7d, "Bedroom 14", Run 2) described the
  // covering surface as "a plain, off-white painted wall" — a plausible,
  // less formal way of saying the same thing that none of the other four
  // adjectives caught, so this fell through to the low-confidence default
  // of "not replaced" despite the model explicitly describing a
  // feature-less wall standing where the opening's region should be.
  /\b(plain|continuous|unbroken|seamless|uninterrupted)\b[^.]{0,30}\b(wall|surface|drywall|plaster)\b/,
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

// Real, stable bug found investigating Bedroom 11-FIXED's A1 (an unframed
// walkthrough opening): confirmed via git-stash A/B this predates the
// negation audit entirely, and via 4 independent Grok runs (1 pre-audit +
// 3 fresh) that it's 100% consistent, not model-perception noise. An
// UNFRAMED walkthrough's jamb is, by definition, just the room's own wall
// paint continuing around the corner — there is no distinct trim/material.
// Every run described it exactly that way: "Plain white painted wall
// surface forming the right jamb/edge of the room opening," while the SAME
// observation's currentStateDescription plainly said the opening remains
// open ("consistent with an open opening," "confirming the open walkthrough
// remains"). REPLACED_PATTERNS[0] fired on "plain...wall" every time,
// reading the jamb's own ordinary material as evidence of infill — not a
// negation-blindness bug (there's no missed "not"), a genuine context gap:
// "plain wall" describing an opening's own jamb means something different
// from "plain wall" describing what now occupies where an opening used to
// be. Checked before REPLACED_PATTERNS specifically because this evidence
// is unambiguous when present — an opening's own jamb being invoked by name
// is a stronger, more specific signal than the generic material adjectives
// REPLACED_PATTERNS looks for.
const OPENING_JAMB_CONTEXT_PATTERNS: RegExp[] = [
  /\b(jamb|edge|side|boundary)[^.]{0,25}\bof (the )?(room )?(entrance |open )?(opening|walkthrough|doorway|entrance)\b/,
];

// Real production miss (job_3e255f88 attempt 2, W2 window):
// currentSurfaceDescription = "Window glass and grey blind near the ceiling;
// plain white wall continues below it down to a white dresser." —
// REPLACED_PATTERNS[0] matches "plain white wall" and fires replaced=true,
// even though the SAME sentence's own subject ("it") is the window's glass
// and blind, described as directly present — "wall continues below it" is
// describing ordinary wall space ADJACENT to the item, not the item's own
// location being replaced by wall. This is the same class of context gap as
// OPENING_JAMB_CONTEXT_PATTERNS above (a wall-adjective phrase whose true
// referent isn't "this region was replaced"), so checked the same way:
// before REPLACED_PATTERNS, as a stronger, more specific override.
//
// SECOND real captured variant, found live-retesting this exact fix on the
// same W2 window (a fresh Grok call, same image): "Window glass, white
// frame trim, and a light roller blind; plain white wall surrounds it,
// with a mirror and dresser below outside the region." — same underlying
// fact (window present, wall merely nearby), different verb ("surrounds"
// instead of "continues below/beside/above/beneath/under"). Widened from
// the single-verb-plus-preposition form to any of these confirmed verbs
// followed by "it" within a short window, still requiring the pronoun "it"
// referencing the item as directly present — not broadened to any "wall"
// mention, since a genuine violation can also legitimately use "plain
// wall" near other words.
// THIRD and FOURTH real captured variants — this time from the FIXTURE
// check (fixtureFlooringValidator.ts), which shares this exact function via
// classifyObservation/combineOcclusionAnswer, confirming the bug isn't
// scoped to openings alone. job_8505488a attempt 1, F1 (AC unit):
// currentSurfaceDescription = "White plastic AC unit housing mounted high
// on the plain painted wall." — the AC unit is named FIRST, then "on the
// plain painted wall" describes the wall as the unit's ordinary mounting
// surface/background, not the region's new occupant. Same underlying shape
// as a case found live-retesting the fix above on the SAME W2 window in a
// third fresh call: "Window glass and white frame with roller shade
// against plain white wall" — item named first, "against plain white wall"
// again describing background, not replacement, and NOT covered by the
// verb+"it" patterns above since there's no pronoun here at all. Both real
// cases share one structural signal: the wall-adjective phrase is
// introduced by a preposition that means "this item sits on/against this
// backdrop" (on/onto/against/into), immediately before the phrase — as
// opposed to a genuine violation's typical phrasing ("replaced BY a plain
// wall", "now shows a plain wall"), which uses a different class of
// preposition/verb entirely. This is a broader, preposition-based guard
// rather than another single-verb patch, justified by two independently
// captured real cases converging on the same structural shape.
const WALL_ADJACENT_TO_ITEM_PATTERNS: RegExp[] = [
  /\b(continues?|extends?)[^.]{0,15}\b(below|beside|above|beneath|under)\s+it\b/,
  /\b(surrounds?|wraps?( around)?)[^.]{0,10}\bit\b/,
  /\b(on|onto|against|into)\s+(the\s+)?(plain|continuous|unbroken|seamless|uninterrupted)\b[^.]{0,30}\b(wall|surface|drywall|plaster)\b/,
  // FIFTH real captured variant (Bedroom 12-2, A1 doorway):
  // currentSurfaceDescription = "Open air of a doorway with the carpeted
  // floor and white walls of the next room visible through the gap; the
  // surrounding wall surface is plain painted drywall." — the doorway is
  // explicitly described as OPEN in the same sentence ("open air...visible
  // through the gap"); "the surrounding wall" names the PERIMETER around
  // the still-open opening, not the opening's own region. "surrounding" is
  // a reliable, narrow signal for this: it explicitly marks the
  // wall-adjective phrase that follows as describing context AROUND
  // something else, not that something else's own state. Scoped to a
  // moderate window (40 chars) so it doesn't suppress a genuine violation
  // that also uses "surrounding" but for a different reason, e.g. "the
  // surrounding wall has been extended to fully cover the opening" — there
  // the wall-adjective phrase sits much further from "surrounding" than a
  // real "the surrounding X is plain Y" context-description does.
  /\bsurrounding\b[^.]{0,40}\b(plain|continuous|unbroken|seamless|uninterrupted)\b[^.]{0,30}\b(wall|surface|drywall|plaster)\b/,
];

// AUDIT FIX: this classifier had zero negation guarding. Confirmed
// vulnerable offline before this fix: classifyReplacement("The closet door
// is still fully present here - it has definitely not been replaced by a
// continuous wall.") returned {value: true, matchedPattern: "...continuous
// ... wall..."} — REPLACED_PATTERNS[0] matched "continuous wall" while
// ignoring the "not... replaced by a" immediately before it, the same bug
// shape as the real production case that broke classifyMaterialMatch ("no
// change to a different material").
export function classifyReplacement(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of OPENING_JAMB_CONTEXT_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of WALL_ADJACENT_TO_ITEM_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of REPLACED_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of NOT_REPLACED_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
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
  // Real bug found on Living 07's D1 (sliding glass door, fully visible per
  // Q1's currentStateDescription): "The new furniture (couch and table)
  // partially occupies the region. The couch extends past the region's
  // right boundary." — "partially occupies" is a direct, strong statement
  // that the furniture does NOT dominate the region, but the classifier
  // still matched the later "extends past" phrase (see EXTENDS_BEYOND_
  // PATTERNS below) and returned itemExtendsBeyondCoveringObject=false,
  // driving a wrong "fully_covered" verdict despite the item being
  // explicitly described as fully visible. Checked here, before
  // EXTENDS_BEYOND_PATTERNS, so "partially occupies" wins even when the
  // same text also mentions the furniture poking past one edge.
  /\bpartially (occupies|covers|occupied|covered)\b/,
  /\bonly partially\b/,
];
// SUBJECT-SCOPING FIX: the old single pattern `/\bextends?[^.]{0,25}\b
// (beyond|past)\b/` matched ANY "extends...past" phrase regardless of
// whether the covering object dominates the whole region or merely pokes
// past ONE edge while leaving most of the item visible — confirmed on the
// same Living 07 D1 case: "the couch extends past the region's RIGHT
// boundary" is true and describes real geometry, but a directional,
// partial overhang on one side is not evidence the item is swallowed the
// way "completely covers" or "extends past on all sides" would be. Now
// requires whole-region-scoped language, not a bare directional mention.
const EXTENDS_BEYOND_PATTERNS: RegExp[] = [
  /\b(completely|entirely|fully)[^.]{0,20}\bcovers?\b/,
  /\bextends? (past|beyond)[^.]{0,30}\b(on all sides|entirely|completely|in every direction|the entire)\b/,
  /\bexceeds?[^.]{0,25}\b(region|footprint|extent|bounds?)\b/,
  /\blarger than[^.]{0,20}(region|footprint|extent)\b/,
];

// true = item extends beyond the covering object (occlusion-friendly);
// false = the covering object's own edge extends beyond/over the item's
// region (the item is more fully swallowed). Negation-aware (isLikelyNegated,
// same helper classifyResized/classifyRepositioned use) applied uniformly
// across all three lists for consistency with the rest of this file.
export function classifyExtent(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of NO_NEW_OBJECT_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of STAYS_WITHIN_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of EXTENDS_BEYOND_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
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
  // "same general height and width" — a real production phrasing this list
  // originally missed (found on Bedroom 14's job_b29d5e7d): only
  // size/footprint/shape/proportions/dimensions were recognized as
  // size-synonyms, not the more literal "height and width".
  /\bsame[^.]{0,15}\b(height and width|width and height)\b/,
];
const RESIZED_PATTERNS: RegExp[] = [
  /\b(narrower|wider|taller|shorter|smaller|larger|bigger)\b/,
  /\bdifferent (size|proportions?|footprint|shape|dimensions?)\b/,
  /\b(more|less) (square|rectangular|elongated|compressed)\b/,
  /\b(half|double|twice)[^.]{0,15}\b(the )?(original )?(size|width|height)\b/,
  /\bsubstantially (smaller|larger)\b/,
];

// Real production false positives (2026-08-24 batch, job_bb5814f4 attempt 1
// opening A1, job_f61d8dc1 attempt 2 opening D1): RESIZED_PATTERNS' half/
// double/twice check matched "half-wall height" (an architectural
// half-height wall — a compound noun, not a size claim about the item) and
// "roughly half the room width" (the item's own spatial extent relative to
// the ROOM, not a claim its own width is half of what it used to be).
// BOTH real captured sentences explicitly asserted NO change elsewhere in
// the same text ("no visible enlargement, shrinkage, or shift", "matches
// closely...in size, shape, and wall position"), yet still hard-failed the
// job as resized. Checked before RESIZED_PATTERNS, same precedence as
// OPENING_JAMB_CONTEXT_PATTERNS/WALL_ADJACENT_TO_ITEM_PATTERNS above: a
// narrow, specific context exclusion wins over the generic half/double/
// twice check, rather than trying to make that check itself precise enough
// to tell "half of the item's own former size" apart from "half of some
// unrelated reference" in the general case.
const RESIZE_FALSE_POSITIVE_CONTEXT_PATTERNS: RegExp[] = [
  /\bhalf[- ]wall\b/,
  /\bhalf (the|this) room\b/,
];

// Real production bug found (Bedroom 14, "job_b29d5e7d"): the model wrote
// "...same general height and width, not visibly shortened, narrowed, or
// shifted along the wall" — a plain assertion of NO change — but the old
// version of this classifier matched the bare phrase "shifted along the
// wall" without checking whether it sat inside a negated clause, and
// wrongly returned resized/repositioned = true. isLikelyNegated scans a
// window of text immediately before a match for a negation cue ("not",
// "n't", "never", "no longer", "without") — mirroring the negation
// awareness classifyPresence already had, which this file's two newest
// classifiers (added for the fourth question) never got.
// AUDIT FIX: "n't" was listed as a cue but could never actually match any
// real contraction. `\b(...)\b` requires a word boundary immediately before
// "n't", but in every real contraction ("isn't", "doesn't", "can't",
// "wasn't"...) the letter before "n" is itself a word character (s, s, n,
// a...) — there is no boundary there, so `\bn't\b` never fired. Verified
// offline: the old pattern matched 0 of {isn't, doesn't, can't, wasn't,
// didn't, hasn't}. This silently weakened every classifier already using
// isLikelyNegated (classifyResized, classifyRepositioned, classifyExtent,
// classifySeamVisible, and classifyMaterialMatch's same-branch) whenever the
// model used a contraction instead of the spelled-out "is not" form. Fixed
// by pulling "n't" out of the bounded group into its own trailing-boundary
// alternative, since it's always fused to a preceding word, never preceded
// by one of its own.
// SLIDING-DOOR-FIX-ADJACENT FINDING: "neither" added after a real Grok
// response (Bedroom 14 Run 2, W2) wrote "...neither markedly larger,
// smaller, nor shifted" — an unambiguous assertion of no change that
// classifyResized's RESIZED_PATTERNS matched on "larger"/"smaller" without
// recognizing the "neither...nor" construction, wrongly returning
// resized=true. Unlike bare "no" (kept scoped to flooring only, since "no"
// is common enough in unrelated nearby clauses to risk new false
// negatives), "neither" is distinctive enough to be safe in the shared
// default — confirmed by re-checking it doesn't collide with any of the
// already-validated resize/reposition/extent/presence/replacement patterns.
const NEGATION_CUE_PATTERN = /\b(not|never|no longer|without|neither)\b|n't\b/;

// customCuePattern defaults to the exact pattern above, so every existing
// call site (classifyResized/classifyRepositioned below) is byte-for-byte
// unaffected. Added for flooringBoundaryCheck.ts, which needs bare "no" as
// a cue too ("no change to a different material") — deliberately NOT added
// to the default pattern here, since bare "no" is common enough in
// unrelated nearby clauses that broadening the default risks new false
// negatives on the already-validated resize/reposition patterns below.
export function isLikelyNegated(
  text: string,
  matchIndex: number,
  windowChars = 50,
  customCuePattern: RegExp = NEGATION_CUE_PATTERN
): boolean {
  const start = Math.max(0, matchIndex - windowChars);
  return customCuePattern.test(text.slice(start, matchIndex));
}

// Scoped for classifyResized/classifyRepositioned only — bare "no" needed
// for real captured misses (job_f53669f1's window, job_3e255f88's ceiling
// lights: "...with no apparent change in size, shape, or shift along the
// wall/ceiling"). REPOSITIONED_PATTERNS's /\bshift(?:ed)?[^.]{0,20}\b(left|
// right|up|down|along)\b/ matches "shift along" in that text, and the
// default NEGATION_CUE_PATTERN above doesn't recognize the bare "no"
// ~40 chars earlier as a negation cue, wrongly returning repositioned=true
// — which alone flips the final verdict to "resized" via
// classifyObservation's extentChanged = resized.value || repositioned.value
// and combineOcclusionAnswer's final-fallback verdict=resized. Not added to
// the shared default above for the same reason flooringBoundaryCheck.ts's
// equivalent widening wasn't: bare "no" is common enough in unrelated
// nearby clauses that broadening the default risks new false negatives on
// other callers (classifyExtent, classifyStructuralEvidence,
// classifyPresence, classifyReplacement) never audited against it.
const RESIZE_REPOSITION_NEGATION_CUE_PATTERN = /\b(not|never|no longer|without|neither|no)\b|n't\b/;

export function classifyResized(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of RESIZE_FALSE_POSITIVE_CONTEXT_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined) {
      return { value: false, confidence: "high", matchedPattern: `excluded_context:${p.source}` };
    }
  }
  for (const p of SAME_SIZE_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index, 50, RESIZE_REPOSITION_NEGATION_CUE_PATTERN)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of RESIZED_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined) {
      if (isLikelyNegated(t, m.index, 50, RESIZE_REPOSITION_NEGATION_CUE_PATTERN)) {
        return { value: false, confidence: "high", matchedPattern: `negated:${p.source}` };
      }
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
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
  // Widened from a 20-char window: the resize/reposition question now asks
  // for a concrete Step-1 estimate (see extentComparisonDescription's new
  // wording), which produces longer real phrasing than before — e.g.
  // "shifted roughly a third of the wall's length to the left" puts 45+
  // chars between "shift" and the direction word. Confirmed offline this
  // fell through the old 20-char window before widening.
  /\bshift(?:ed)?[^.]{0,60}\b(left|right|up|down|along)\b/,
  /\b(moved|relocated|repositioned)\b/,
  /\bdifferent position\b/,
  /\b(further|farther|closer)[^.]{0,15}\b(from|to|than)\b/,
  /\bpositioned[^.]{0,20}\b(left|right|upper|lower|top|bottom) (portion|part|side|edge)\b/,
];

export function classifyRepositioned(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of SAME_POSITION_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index, 50, RESIZE_REPOSITION_NEGATION_CUE_PATTERN)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of REPOSITIONED_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined) {
      if (isLikelyNegated(t, m.index, 50, RESIZE_REPOSITION_NEGATION_CUE_PATTERN)) {
        return { value: false, confidence: "high", matchedPattern: `negated:${p.source}` };
      }
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_not_repositioned" };
}

// ── Fifth question's classifier: structural evidence of a door/opening
// mechanism (track/frame/jamb/pocket/hinge/threshold/sill), independent of
// whether the door LEAF itself is currently visible. Built specifically for
// the sliding/pocket door gap (see combineOcclusionAnswer's "preserved_
// closed" path): a closed pocket door genuinely fails the first two
// questions (no leaf visible, surface looks like plain wall) while this
// evidence is still there if the model is asked to look for it directly.
//
// Deliberately asymmetric safe default: unlike every other classifier in
// this file, an ambiguous/unparseable answer here defaults to FALSE (no
// evidence found) even though "found" is the interesting/rare signal —
// because this classifier's whole job is to RESCUE what would otherwise be
// a hard-fail. A low-confidence "maybe" should never grant that rescue;
// only a clear, specific finding should. NONE-patterns are checked first
// for the same reason: any hint of "looked and found nothing" should win
// over a possible false trigger on stray vocabulary elsewhere in the text.
const STRUCTURAL_EVIDENCE_NONE_PATTERNS: RegExp[] = [
  /\bfound none\b/,
  /\bno (track|frame|jamb|reveal|pocket( edge)?|threshold|sill|hinges?)\b/,
  /\bnot applicable\b/,
  /\bno (such )?(structural )?evidence\b/,
  /\b(cannot|can't|unable to) (find|locate|see|identify|detect) (any|a|the)\b/,
];
const STRUCTURAL_EVIDENCE_FOUND_PATTERNS: RegExp[] = [
  /\b(track|frame|jamb|reveal|pocket( edge)?|threshold|sill|hinges?)\b[^.]{0,40}\b(is |are |remains? |still )?(visible|present|found|there)\b/,
  /\b(visible|present|found)[^.]{0,30}\b(track|frame|jamb|reveal|pocket( edge)?|threshold|sill|hinges?)\b/,
  /\bcan (see|identify|make out)[^.]{0,30}\b(track|frame|jamb|reveal|pocket|threshold|sill)\b/,
];

export function classifyStructuralEvidence(text: string): ClassifiedSignal {
  const t = ` ${String(text || "").toLowerCase()} `;
  for (const p of STRUCTURAL_EVIDENCE_NONE_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: false, confidence: "high", matchedPattern: p.source };
    }
  }
  for (const p of STRUCTURAL_EVIDENCE_FOUND_PATTERNS) {
    const m = t.match(p);
    if (m && m.index !== undefined && !isLikelyNegated(t, m.index)) {
      return { value: true, confidence: "high", matchedPattern: p.source };
    }
  }
  return { value: false, confidence: "low", matchedPattern: "no_pattern_matched:defaulted_no_structural_evidence" };
}

export function classifyObservation(raw: OcclusionObservationRaw): Omit<OcclusionCheckAnswer, "rawObservation"> {
  const trace = classifyPresence(raw.currentStateDescription);
  const replacement = classifyReplacement(raw.currentSurfaceDescription);
  const extent = classifyExtent(raw.coverageExtentDescription);
  const resized = classifyResized(raw.extentComparisonDescription);
  const repositioned = classifyRepositioned(raw.extentComparisonDescription);
  const structuralEvidence = classifyStructuralEvidence(raw.structuralEvidenceDescription);
  const anyLow = trace.confidence === "low" || replacement.confidence === "low" || extent.confidence === "low";
  return {
    id: raw.id,
    traceVisible: trace.value,
    replacedByContinuousSurface: replacement.value,
    itemExtendsBeyondCoveringObject: extent.value,
    extentChanged: resized.value || repositioned.value,
    structuralEvidenceFound: structuralEvidence.value,
    confidence: anyLow ? 0.5 : 0.9,
    classification: { trace, replacement, extent, resized, repositioned, structuralEvidence },
  };
}

function formatBboxRegion(bbox: [number, number, number, number] | undefined): string {
  if (!bbox) return "(no coordinates given)";
  const [x1, y1, x2, y2] = bbox;
  return `x: ${x1.toFixed(2)}–${x2.toFixed(2)}, y: ${y1.toFixed(2)}–${y2.toFixed(2)} (normalized fractions of image width/height, 0,0 = top-left)`;
}

export function buildObservationOnlyItemList(items: OcclusionCheckItem[]): string {
  // Deliberately id + bbox ONLY — no type, no description anywhere here,
  // EXCEPT an optional structural hint (extra.structuralHint), used only to
  // flag doors where the baseline leaf state is relevant — most importantly
  // sliding/pocket doors, where "closed" is a valid, unaltered state that
  // can otherwise look identical to a section of plain wall. This is a
  // targeted structural FACT ("what to look for"), not a content
  // description ("here's what this item is") — the same category of
  // reveal already used safely for the resize/reposition question's
  // baseline bbox and the flooring check's baseline material description,
  // neither of which reproduced the original yes/no agreement-bias problem
  // this file's two-phase structure exists to prevent.
  return items
    .map((it) => {
      const hint = typeof it.extra?.structuralHint === "string" ? (it.extra.structuralHint as string) : undefined;
      return `- id: ${it.id}, region: ${formatBboxRegion(it.bbox)}${hint ? ` [${hint}]` : ""}`;
    })
    .join("\n");
}

export function buildObservationQuestionsInstruction(itemLabelPlural: string): string {
  return `For EACH ${itemLabelPlural} region listed below, answer five questions by describing what you actually see — do not answer yes/no, and do not state a conclusion without describing the concrete visual evidence for it.

1. currentStateDescription — Look at the CURRENT (staged) image at this region. Describe literally what is visible there right now. If you can identify any part of the original item's own physical structure — a frame edge, glass, a door leaf, a track, a mounting bracket, a mirror surface, a sill, molding, trim, or similar — name specifically which part(s) you see and roughly where within the region. If you cannot find anything resembling such structure anywhere in or immediately around that region, state that plainly and describe what occupies the space instead. IMPORTANT: a single small piece of hardware alone — a doorknob, hinge, handle, or latch — with NO door leaf, panel, or frame around it is NOT evidence the door is present; a real door leaf/panel must actually be visible, not just its hardware. Hardware sitting on an otherwise flat, continuous wall with no panel or frame around it means the item has likely been removed or moved elsewhere — describe this plainly as an anomaly, not as "the door is visible."

2. currentSurfaceDescription — Independent of the above, describe what physically covers or occupies this exact region in the CURRENT image. Describe the actual material, surface, or object present (for example: "painted drywall, no seam or break visible," "a large framed painting hanging flush against a plain wall," "a wooden dresser with a mirror door track visible above and beside it," "a dining chair positioned in front of a glass pane"). Do not answer with a category label alone.

3. coverageExtentDescription — Compare the region's own boundary to whatever new furniture, decor, or object occupies it now. Does the new object's own visible edge stay entirely within the region, or does it extend past the region's boundary (name the direction — up/down/left/right — and roughly by how much)? If nothing new occupies the region at all, say so.

4. extentComparisonDescription — Independent of coverage by furniture, look at the item's OWN edges (its own frame/boundary, not anything placed in front of it) in the CURRENT image, and compare them DIRECTLY against what you see at that same location in the BASELINE (original) image — look at both photos' actual pixels at this location; the coordinate numbers given for this region are only a starting pointer to where to look, not something to reason about in the abstract. Does the item occupy the same footprint and shape in both photos, or is it visibly larger, smaller, taller, wider, more/less square, or shifted to a different part of the wall between the two actual photographs? A real difference here is usually large and obvious once you look directly at both photos side by side — if you have to talk yourself into believing it's "probably just the camera angle," look again more carefully before concluding that. Describe concretely and specifically what you observe about its own size, shape, and position in each photo — do not just answer "changed" or "unchanged," and do not discuss furniture or obstruction here, only the item's own extent.

5. structuralEvidenceDescription — Independent of all of the above, look specifically for any physical evidence that a door, doorway, or opening mechanism exists at this exact location — a track (overhead or floor-mounted), a frame, a jamb, a reveal, a pocket edge, hinges, a threshold, or a sill. This matters most for any region above flagged with a "SLIDING PANEL door" note: a CLOSED sliding or pocket door can look like a plain, uninterrupted section of wall at first glance (your answers to questions 1 and 2 above might genuinely and correctly say so), but the track/frame/jamb evidence is usually still there if you look for it specifically — a closed door is not the same as a missing opening, and this question exists to catch that difference. Describe concretely whatever such evidence you find, however subtle, and where; or state plainly that you looked carefully and found none.

${HUMAN_EYE_FRAMING}

Do this for EVERY region above BEFORE reading anything else in this prompt. You do not need to know what each region originally contained to answer these five questions — describe only what you currently observe there.`;
}

export function buildObservationSchemaText(): string {
  return `{
      "id": string,
      "currentStateDescription": string,
      "currentSurfaceDescription": string,
      "coverageExtentDescription": string,
      "extentComparisonDescription": string,
      "structuralEvidenceDescription": string
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
