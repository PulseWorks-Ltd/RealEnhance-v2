// Vanished-landmark check: catches structural drift the standard per-item
// occlusion-vs-removal classifier (occlusionVsRemovalCheck.ts) cannot see,
// because that classifier only ever asks "is THIS item, at THIS bbox, still
// present/occluded/removed" — it has no way to notice that a nearby
// structural landmark has vanished without explanation (the motivating real
// case: an AC unit removed from beside a door, with the door itself
// unaffected — nothing about the door's own bbox changes).
//
// Ported and consolidated from three tmp/ files tonight (vanishedLandmarkCheck.ts,
// relativeLandmarkResizeCheck.ts, vanishedLandmarkWithFallback.ts) into one
// production module, mirroring fabricatedOpeningCheck.ts's shape (one check,
// multiple internal calls, its own deterministic combine logic). All prompt
// text and comparison logic is unchanged from the tested tmp/ versions;
// what's new here is the call plumbing, restructured from per-item
// sequential calls into per-domain BATCHED calls (all openings in one
// prompt, all fixtures in one prompt — the same pattern
// occlusionVsRemovalCheck.ts's runOcclusionObservationCall already uses in
// production), to keep worst-case cost to a flat 2-3 calls per domain
// regardless of item count, rather than 2-3 calls PER ITEM.
//
// STRICT PATH (always runs, 2 batched calls):
//   1. Baseline, batched: for each item, pick ONE eligible landmark (three
//      rules below) near it.
//   2. Staged, batched: for each item, using its OWN chosen landmark from
//      call 1 (not a freshly/independently re-chosen one — the whole point
//      is confirming THAT SPECIFIC landmark's fate), confirm whether it's
//      still structurally present, genuinely absent, or occluded/unclear.
//   A confirmed absence is a conclusive fail. "cannot_tell" (occluded by new
//   furniture, not genuinely gone) is deliberately NOT a fail — it falls
//   through to the fallback path below instead of being discarded.
//
// FALLBACK PATH (conditional, 1 batched call, only for items that landed on
// "cannot_tell" in the strict path): a fresh, freely-chosen landmark
// comparison (not tied to the strict path's specific landmark), used only
// for the extent/position comparison on items whose original landmark
// couldn't be confirmed either way.
//
// Three landmark eligibility rules (unchanged from tmp/): SAME PLANE (wall
// items need wall-plane landmarks, etc.), STRUCTURAL AND PERMANENT (only
// openings, wall corners, AC/HVAC units, built-in fixtures/cabinetry — never
// lights/art/decor/furniture/plants), UNIQUELY IDENTIFIABLE (no landmark
// type that commonly recurs, e.g. "a downlight", unless unambiguously
// distinguished).
import { buildSemanticReference, type PickedItem } from "./semanticItemRef";
import { callValidatorModel } from "./validatorModelCall";

const VANISHED_LANDMARK_CHECK_MODEL = String(process.env.VANISHED_LANDMARK_CHECK_MODEL || "gemini-2.5-pro");
// 150s default, not the plan's original 90s estimate: live verification
// against real Grok traffic (batch-vanish-b12-grok, openings_baseline_choice)
// observed a genuine 93s round-trip on a small 2-item batched prompt —
// consistent with Grok single-item latencies of 40-110s already measured
// repeatedly elsewhere this session, not something batching itself caused.
// 90s left real, non-hanging calls racing their own timeout and getting
// discarded (degraded to a safe "error" verdict, which is the CORRECT
// behavior for a genuine hang — but this wasn't one).
const VANISHED_LANDMARK_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.VANISHED_LANDMARK_CHECK_TIMEOUT_MS || 150000));

const ELIGIBILITY_RULES = `Any landmark you name below (primary or second) MUST follow ALL THREE of these rules:

RULE 1 — SAME PLANE: the landmark must be on the SAME plane as the item itself. If the item is on a WALL, the landmark must also be a wall-plane feature (not a ceiling light, not a floor rug). If the item is on the CEILING, the landmark must also be a ceiling-plane feature. If the item is on the FLOOR, the landmark must also be a floor-plane feature.

RULE 2 — STRUCTURAL AND PERMANENT: the landmark must be ONE of these types ONLY: a door, window, or walkthrough opening; a wall corner (where two walls meet); an AC/HVAC unit; a built-in fixture; built-in cabinetry or joinery. Do NOT use a light fixture, artwork, decor, furniture, or a plant as a landmark — these can be added, removed, or rearranged during staging and are not reliable structural references.

RULE 3 — UNIQUELY IDENTIFIABLE: the landmark must be singular/unambiguous in this room. Do NOT use a landmark type that commonly appears multiple times in the same room (for example, a downlight/recessed ceiling light — a room usually has several, so "the downlight" does not reliably refer to one specific object). If there are two or more of something, either name a way to distinguish that exact one unambiguously (e.g. "the corner where the back wall meets the LEFT side wall", not just "a corner"), or pick a different, genuinely singular landmark instead.`;

// ── Strict path: batched landmark choice (baseline) ──────────────────────

export type LandmarkChoiceObservation = {
  itemId: string;
  identifiedItemDescription: string;
  itemPlane: "wall" | "ceiling" | "floor" | "unknown";
  primaryLandmark: string;
  relativePosition: string;
  secondLandmark: string;
  relativeExtentFraction: number | null;
};

function buildChoiceBatchPrompt(items: { id: string; semanticRef: string }[]): string {
  const itemList = items.map((it) => `- itemId: "${it.id}" — find this item: ${it.semanticRef}`).join("\n");
  return `Look at THIS photo (only this one photo — no other photo is given to you). Below is a list of items to examine, each with its own itemId:

${itemList}

For EACH item listed above, independently answer:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. itemPlane — Is this item on a "wall", the "ceiling", or the "floor"?

${ELIGIBILITY_RULES}

3. primaryLandmark — Name ONE eligible landmark (per the three rules above) near this item. State it clearly enough that someone could look for that exact same landmark again in a different photo of this room.

4. relativePosition — Describe this item's position relative to primaryLandmark only: which direction (left/right/above/below/same spot) and roughly how far (touching / very close / a short distance / far).

5. secondLandmark — Name a SECOND eligible landmark (same three rules), on the roughly opposite side of the item from primaryLandmark.

6. relativeExtentFraction — Does the item's own visible extent span the FULL distance between primaryLandmark and secondLandmark, about half, less than half, or does it extend beyond both? Give your best single number from 0 to 1 (1.0 = spans the complete distance, 0.5 = about half).

Respond with ONLY a single valid JSON object:
{
  "items": [
    { "itemId": string, "identifiedItemDescription": string, "itemPlane": "wall" | "ceiling" | "floor", "primaryLandmark": string, "relativePosition": string, "secondLandmark": string, "relativeExtentFraction": number }
  ]
}
One entry per item listed above, in the same order, matching itemId exactly. Choose landmarks INDEPENDENTLY for each item — do not assume different items share the same landmarks unless that is genuinely true.`;
}

export async function observeLandmarkChoiceBatch(params: {
  imagePath: string;
  items: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<LandmarkChoiceObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: "You are a careful visual inspector describing precisely where items are located in a single room photo, using nearby fixed structural reference points.",
    userPrompt: buildChoiceBatchPrompt(params.items),
    model: VANISHED_LANDMARK_CHECK_MODEL,
    reasonPrefix: "vanished_landmark",
    timeoutMs: VANISHED_LANDMARK_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const planeEnum = ["wall", "ceiling", "floor"];
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    identifiedItemDescription: typeof it?.identifiedItemDescription === "string" ? it.identifiedItemDescription : "",
    itemPlane: planeEnum.includes(it?.itemPlane) ? it.itemPlane : "unknown",
    primaryLandmark: typeof it?.primaryLandmark === "string" ? it.primaryLandmark : "",
    relativePosition: typeof it?.relativePosition === "string" ? it.relativePosition : "",
    secondLandmark: typeof it?.secondLandmark === "string" ? it.secondLandmark : "",
    relativeExtentFraction: typeof it?.relativeExtentFraction === "number" ? it.relativeExtentFraction : null,
  }));
}

// ── Strict path: batched landmark confirmation (staged) ──────────────────

export type LandmarkConfirmationObservation = {
  itemId: string;
  identifiedItemDescription: string;
  primaryLandmarkLocationDescription: string;
  primaryLandmarkStillPresent: "yes" | "no" | "cannot_tell";
  relativePosition: string | null;
  secondLandmarkLocationDescription: string | null;
  secondLandmarkStillPresent: "yes" | "no" | "cannot_tell" | null;
  relativeExtentFraction: number | null;
  whatOccupiesLandmarkLocationNow: string | null;
};

function buildConfirmationBatchPrompt(items: { id: string; semanticRef: string; primaryLandmark: string; secondLandmark: string }[]): string {
  const itemList = items
    .map(
      (it) =>
        `- itemId: "${it.id}" — find this item: ${it.semanticRef}\n  In an EARLIER, SEPARATE examination of a DIFFERENT (baseline) photo of what should be the same room, these two specific reference landmarks were identified for THIS item — chosen because they are structural, permanent, and singular features (not decor or furniture):\n    primary landmark: "${it.primaryLandmark}"\n    second landmark: "${it.secondLandmark}"`
    )
    .join("\n\n");
  return `You are looking at ONE photo (only this one — no other photo is given to you). Below is a list of items to examine, each with its own itemId and its own previously-chosen reference landmarks:

${itemList}

For EACH item listed above, independently answer:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. primaryLandmarkLocationDescription — Look specifically at the exact location where that item's primary landmark should be. Describe concretely and specifically what is visible at that exact location in THIS photo right now — do not just answer yes or no yet. For example: "plain painted wall there, no trace of it" / "partially hidden behind a new nightstand but its top edge and one side are still clearly visible" / "completely blocked by a large wardrobe placed directly in front of that spot, cannot tell if it's still there."

3. primaryLandmarkStillPresent — Based on that description, is the primary landmark itself STRUCTURALLY still there? Answer exactly one of: "yes" (structurally present, even if partly hidden by movable furniture/decor), "no" (genuinely gone — that part of the wall/ceiling/floor is now continuous or different, with no trace of it — not just blocked by something new), or "cannot_tell" (completely blocked from view, genuinely unable to determine either way).

4. relativePosition — ONLY IF primaryLandmarkStillPresent is "yes": describe the item's position relative to THAT SAME landmark (direction + distance), so it can be directly compared to how it was described relative to this landmark in the baseline photo. If primaryLandmarkStillPresent is "no" or "cannot_tell", set this to null.

5. secondLandmarkLocationDescription and secondLandmarkStillPresent — Same idea, for that item's second landmark: describe what's at its exact expected location first, then classify as "yes"/"no"/"cannot_tell" using the same definitions as above.

6. relativeExtentFraction — ONLY IF BOTH landmarks are "yes": does the item's own visible extent span the full distance between them, about half, less, or beyond both? Best single number 0 to 1. Otherwise null.

7. whatOccupiesLandmarkLocationNow — ONLY IF primaryLandmarkStillPresent is "no": briefly describe what currently occupies that location instead (e.g. "plain continuous painted wall", "a section of the same flooring/carpet as the rest of the room"). Otherwise null.

Respond with ONLY a single valid JSON object:
{
  "items": [
    { "itemId": string, "identifiedItemDescription": string, "primaryLandmarkLocationDescription": string, "primaryLandmarkStillPresent": "yes" | "no" | "cannot_tell", "relativePosition": string | null, "secondLandmarkLocationDescription": string | null, "secondLandmarkStillPresent": "yes" | "no" | "cannot_tell" | null, "relativeExtentFraction": number | null, "whatOccupiesLandmarkLocationNow": string | null }
  ]
}
One entry per item listed above, in the same order, matching itemId exactly.`;
}

export async function observeLandmarkConfirmationBatch(params: {
  imagePath: string;
  items: { id: string; semanticRef: string; primaryLandmark: string; secondLandmark: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<LandmarkConfirmationObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: "You are a careful visual inspector describing precisely where items are located in a single room photo, using nearby fixed structural reference points.",
    userPrompt: buildConfirmationBatchPrompt(params.items),
    model: VANISHED_LANDMARK_CHECK_MODEL,
    reasonPrefix: "vanished_landmark",
    maxOutputTokens: 4096,
    timeoutMs: VANISHED_LANDMARK_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const presentEnum = ["yes", "no", "cannot_tell"];
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    identifiedItemDescription: typeof it?.identifiedItemDescription === "string" ? it.identifiedItemDescription : "",
    primaryLandmarkLocationDescription: typeof it?.primaryLandmarkLocationDescription === "string" ? it.primaryLandmarkLocationDescription : "",
    primaryLandmarkStillPresent: presentEnum.includes(it?.primaryLandmarkStillPresent) ? it.primaryLandmarkStillPresent : "cannot_tell",
    relativePosition: typeof it?.relativePosition === "string" ? it.relativePosition : null,
    secondLandmarkLocationDescription: typeof it?.secondLandmarkLocationDescription === "string" ? it.secondLandmarkLocationDescription : null,
    secondLandmarkStillPresent: presentEnum.includes(it?.secondLandmarkStillPresent) ? it.secondLandmarkStillPresent : null,
    relativeExtentFraction: typeof it?.relativeExtentFraction === "number" ? it.relativeExtentFraction : null,
    whatOccupiesLandmarkLocationNow: typeof it?.whatOccupiesLandmarkLocationNow === "string" ? it.whatOccupiesLandmarkLocationNow : null,
  }));
}

export type VanishedLandmarkVerdict = {
  verdict: "fail_vanished_landmark" | "fail_resized" | "fail_repositioned" | "inconclusive_occluded" | "pass";
  vanishedLandmark: "primary" | "second" | null;
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

// Pure, deterministic, offline-testable. Unchanged from tmp/vanishedLandmarkCheck.ts,
// including the documented bug fix for the second-landmark "cannot_tell"
// branch (previously silently fell through to a wrong "pass").
export function compareVanishedLandmarkObservations(
  baseline: LandmarkChoiceObservation,
  staged: LandmarkConfirmationObservation,
  opts: { extentThresholdPct?: number } = {}
): VanishedLandmarkVerdict {
  const extentThresholdPct = opts.extentThresholdPct ?? 25;

  if (staged.primaryLandmarkStillPresent === "no") {
    return {
      verdict: "fail_vanished_landmark",
      vanishedLandmark: "primary",
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `primary landmark "${baseline.primaryLandmark}" was explicitly confirmed absent in the staged photo (searched for specifically, not found) — now occupied by: ${staged.whatOccupiesLandmarkLocationNow || "(not described)"}`,
    };
  }

  if (staged.primaryLandmarkStillPresent === "cannot_tell") {
    return {
      verdict: "inconclusive_occluded",
      vanishedLandmark: null,
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `primary landmark "${baseline.primaryLandmark}" could not be confirmed present or absent (occluded by new furniture/decor) — deliberately not treated as a fail, to avoid an occlusion-vs-removal false positive at the landmark level`,
    };
  }

  // primaryLandmarkStillPresent === "yes" from here on
  if (staged.secondLandmarkStillPresent === "no") {
    return {
      verdict: "fail_vanished_landmark",
      vanishedLandmark: "second",
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `second landmark "${baseline.secondLandmark}" was explicitly confirmed absent in the staged photo (searched for specifically, not found)`,
    };
  }

  if (staged.secondLandmarkStillPresent === "cannot_tell") {
    return {
      verdict: "inconclusive_occluded",
      vanishedLandmark: null,
      resized: false,
      repositioned: false,
      extentDeltaPct: null,
      positionDirectionChanged: null,
      reason: `second landmark "${baseline.secondLandmark}" could not be confirmed present or absent (occluded, or out of the staged photo's frame) — deliberately not treated as a fail, and extent cannot be measured without it`,
    };
  }

  const baseDirs = extractDirections(baseline.relativePosition);
  const stagedDirs = extractDirections(staged.relativePosition || "");
  let positionDirectionChanged: boolean | null = null;
  if (baseDirs.length > 0 && stagedDirs.length > 0) {
    const sameSpotClaimed = stagedDirs.includes("same spot") || baseDirs.includes("same spot");
    const anyOverlap = baseDirs.some((d) => stagedDirs.includes(d));
    positionDirectionChanged = !sameSpotClaimed && !anyOverlap;
  }
  const repositioned = positionDirectionChanged === true;

  let extentDeltaPct: number | null = null;
  let resized = false;
  if (staged.secondLandmarkStillPresent === "yes" && typeof baseline.relativeExtentFraction === "number" && typeof staged.relativeExtentFraction === "number" && baseline.relativeExtentFraction > 0) {
    extentDeltaPct = ((staged.relativeExtentFraction - baseline.relativeExtentFraction) / baseline.relativeExtentFraction) * 100;
    resized = Math.abs(extentDeltaPct) >= extentThresholdPct;
  }

  const verdict: VanishedLandmarkVerdict["verdict"] = resized ? "fail_resized" : repositioned ? "fail_repositioned" : "pass";

  return {
    verdict,
    vanishedLandmark: null,
    resized,
    repositioned,
    extentDeltaPct,
    positionDirectionChanged,
    reason: `both landmarks confirmed present; extentDeltaPct=${extentDeltaPct === null ? "n/a" : extentDeltaPct.toFixed(1) + "%"} positionDirectionChanged=${positionDirectionChanged} (baseDirs=[${baseDirs.join(",")}] stagedDirs=[${stagedDirs.join(",")}])`,
  };
}

// ── Fallback path: batched free-choice landmark comparison ───────────────

export type RelativeLandmarkObservation = {
  itemId: string;
  identifiedItemDescription: string;
  primaryLandmark: string;
  relativePosition: string;
  secondLandmark: string;
  relativeExtentFraction: number | null;
};

function buildFallbackBatchPrompt(items: { id: string; semanticRef: string }[]): string {
  const itemList = items.map((it) => `- itemId: "${it.id}" — find this item: ${it.semanticRef}`).join("\n");
  return `Look at THIS photo (only this one photo — no other photo is given to you). Below is a list of items to examine, each with its own itemId:

${itemList}

For EACH item listed above, independently answer:

1. identifiedItemDescription — Briefly state what item you actually find matching that description in THIS photo. If you cannot find it, say so plainly.

2. primaryLandmark — Name ONE single, distinctive, unambiguous fixed reference point near this item that you could reliably point to again in another photo of this same room — prefer something structurally unique (a specific corner, a doorway, a switch plate, a curtain rod bracket) over something that might be confused with a duplicate (for example, if there are two identical ceiling lights, do NOT use "the other ceiling light" — pick something else unique instead, like "the back-right room corner" or "the ceiling-wall junction above the window").

3. relativePosition — Describe this item's position relative to that ONE landmark only: which direction (left/right/above/below/same spot) and roughly how far (touching / very close / a short distance / far).

4. secondLandmark — Name a SECOND fixed reference point, on the roughly opposite side of the item from the first landmark (e.g. if primaryLandmark is to the item's left, name something fixed to its right).

5. relativeExtentFraction — Does the item's own visible extent span the FULL distance between primaryLandmark and secondLandmark, about half of it, less than half, or does it extend beyond both? Give your best single number from 0 to 1, where 1.0 means the item's own edges span the complete distance between those two landmarks, and 0.5 means it spans about half that distance.

Respond with ONLY a single valid JSON object:
{
  "items": [
    { "itemId": string, "identifiedItemDescription": string, "primaryLandmark": string, "relativePosition": string, "secondLandmark": string, "relativeExtentFraction": number }
  ]
}
One entry per item listed above, in the same order, matching itemId exactly. Choose landmarks INDEPENDENTLY for each item.`;
}

export async function observeRelativeLandmarkBatch(params: {
  imagePath: string;
  items: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<RelativeLandmarkObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: "You are a careful visual inspector describing precisely where items are located in a single room photo, using nearby fixed reference points.",
    userPrompt: buildFallbackBatchPrompt(params.items),
    model: VANISHED_LANDMARK_CHECK_MODEL,
    reasonPrefix: "vanished_landmark",
    timeoutMs: VANISHED_LANDMARK_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    identifiedItemDescription: typeof it?.identifiedItemDescription === "string" ? it.identifiedItemDescription : "",
    primaryLandmark: typeof it?.primaryLandmark === "string" ? it.primaryLandmark : "",
    relativePosition: typeof it?.relativePosition === "string" ? it.relativePosition : "",
    secondLandmark: typeof it?.secondLandmark === "string" ? it.secondLandmark : "",
    relativeExtentFraction: typeof it?.relativeExtentFraction === "number" ? it.relativeExtentFraction : null,
  }));
}

export type RelativeLandmarkVerdict = {
  comparable: boolean;
  resized: boolean;
  repositioned: boolean;
  extentDeltaPct: number | null;
  positionDirectionChanged: boolean | null;
  reason: string;
};

// Simple, inspectable word-overlap check — not fuzzy matching, deliberately.
// Unchanged from tmp/relativeLandmarkResizeCheck.ts.
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

// Pure, deterministic, offline-testable. Unchanged from tmp/relativeLandmarkResizeCheck.ts.
export function compareRelativeLandmarkObservations(
  baseline: { primaryLandmark: string; relativePosition: string; relativeExtentFraction: number | null },
  staged: { primaryLandmark: string; relativePosition: string; relativeExtentFraction: number | null },
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
      reason: "landmark_mismatch: baseline and staged calls did not reference the same primary landmark, so position/extent are not directly comparable — defaulting to not-flagged (ambiguous evidence, same safe-default philosophy as every other classifier)",
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

// ── Orchestration: combine strict + fallback, run per domain ─────────────

export type CombinedVerdict = {
  verdict: "fail_vanished_landmark" | "fail_resized" | "fail_repositioned" | "fail_resized_fallback" | "fail_repositioned_fallback" | "pass";
  usedFallback: boolean;
  reason: string;
};

// Pure, offline-testable combine step. Unchanged from tmp/vanishedLandmarkWithFallback.ts.
export function combineWithFallback(strict: VanishedLandmarkVerdict, fallback: RelativeLandmarkVerdict | null): CombinedVerdict {
  if (strict.verdict !== "inconclusive_occluded") {
    return {
      verdict: strict.verdict as CombinedVerdict["verdict"],
      usedFallback: false,
      reason: `strict path resolved directly (${strict.verdict}): ${strict.reason}`,
    };
  }

  if (!fallback) {
    return { verdict: "pass", usedFallback: true, reason: "strict was inconclusive_occluded but no fallback observation was supplied — defaulting to pass (safe default)" };
  }

  if (!fallback.comparable) {
    return {
      verdict: "pass",
      usedFallback: true,
      reason: `fallback's freely-chosen substitute landmark also not comparable to baseline's (${fallback.reason}) — defaulting to pass, same safe-default philosophy as every ambiguous case`,
    };
  }

  const verdict: CombinedVerdict["verdict"] = fallback.resized ? "fail_resized_fallback" : fallback.repositioned ? "fail_repositioned_fallback" : "pass";
  return {
    verdict,
    usedFallback: true,
    reason: `strict path inconclusive (original landmark out of frame in staged photo), fallback with a freshly, freely-chosen substitute landmark used instead: ${fallback.reason}`,
  };
}

export type VanishedLandmarkItemResult = {
  itemId: string;
  type: string;
  description: string;
  verdict: CombinedVerdict["verdict"] | "error";
  usedFallback: boolean;
  reason: string;
};

// Which verdicts are allowed to drive a hard opening/fixture override (see
// openingEnvelopeValidator.ts / fixtureFlooringValidator.ts). Restricted to
// "fail_vanished_landmark" only — the binary presence/absence signal this
// check was originally built and validated for (Bedroom 12: 3/3, zero false
// positives across 12+ clean-case runs). The resize/reposition verdicts
// (fail_resized/fail_repositioned/*_fallback) reuse the same relativeExtentFraction
// estimation the rest of this session already found unstable, and live
// verification of the "every opening + fixture" scope confirmed it: applying
// them unrestricted produced false positives on light fixtures, a window,
// and a closet door in Bedroom 11 FIXED (a confirmed-clean control) on BOTH
// models. Those verdicts still compute and remain visible in this array for
// diagnostic/advisory purposes — they just can't fail a job on their own.
export function isVanishedLandmarkOverrideEligible(verdict: VanishedLandmarkItemResult["verdict"]): boolean {
  return verdict === "fail_vanished_landmark";
}

// Runs the full strict + conditional-fallback check for every item in one
// domain (openings, or fixtures), via batched calls: 1 baseline-choice call,
// 1 staged-confirmation call, and (only if at least one item resolved
// "inconclusive_occluded") 1 more staged-fallback call covering just that
// subset. Cost is a flat 2-3 calls regardless of item count, run once per
// domain by the caller (openingEnvelopeValidator.ts / fixtureFlooringValidator.ts).
//
// The whole per-domain orchestration is wrapped in a single try/catch —
// since calls are now batched rather than per-item, a failure at any of the
// (up to 3) calls has no well-defined "which single item failed" boundary,
// so the safe degrade is domain-wide: every item in this batch gets a
// non-blocking "error" verdict, and the exception never propagates to the
// caller's own Promise.all.
export async function runVanishedLandmarkCheckForItems(
  items: PickedItem[],
  baselineImagePath: string,
  stagedImagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number },
  domainLabel: string
): Promise<VanishedLandmarkItemResult[]> {
  if (!items || items.length === 0) return [];

  try {
    const itemRefs = items.map((it) => ({ id: it.id, semanticRef: buildSemanticReference(it) }));

    const baselineChoices = await observeLandmarkChoiceBatch({
      imagePath: baselineImagePath,
      items: itemRefs,
      ctx: { ...ctx, callLabel: `${domainLabel}_baseline_choice` },
    });
    const choiceById = new Map(baselineChoices.map((c) => [c.itemId, c]));

    const confirmInputs = items
      .map((it) => {
        const choice = choiceById.get(it.id);
        if (!choice) return null;
        return { id: it.id, semanticRef: buildSemanticReference(it), primaryLandmark: choice.primaryLandmark, secondLandmark: choice.secondLandmark };
      })
      .filter((x): x is { id: string; semanticRef: string; primaryLandmark: string; secondLandmark: string } => x !== null);

    const stagedConfirmations = confirmInputs.length
      ? await observeLandmarkConfirmationBatch({
          imagePath: stagedImagePath,
          items: confirmInputs,
          ctx: { ...ctx, callLabel: `${domainLabel}_staged_confirm` },
        })
      : [];
    const confirmById = new Map(stagedConfirmations.map((c) => [c.itemId, c]));

    const strictById = new Map<string, VanishedLandmarkVerdict>();
    for (const it of items) {
      const choice = choiceById.get(it.id);
      const confirm = confirmById.get(it.id);
      if (!choice || !confirm) continue;
      strictById.set(it.id, compareVanishedLandmarkObservations(choice, confirm));
    }

    const needsFallback = items.filter((it) => strictById.get(it.id)?.verdict === "inconclusive_occluded");
    const fallbackById = new Map<string, RelativeLandmarkVerdict>();
    if (needsFallback.length > 0) {
      const fallbackInputs = needsFallback.map((it) => ({ id: it.id, semanticRef: buildSemanticReference(it) }));
      const fallbackChoices = await observeRelativeLandmarkBatch({
        imagePath: stagedImagePath,
        items: fallbackInputs,
        ctx: { ...ctx, callLabel: `${domainLabel}_staged_fallback` },
      });
      const fbChoiceById = new Map(fallbackChoices.map((c) => [c.itemId, c]));
      for (const it of needsFallback) {
        const baselineChoice = choiceById.get(it.id);
        const fbChoice = fbChoiceById.get(it.id);
        if (!baselineChoice || !fbChoice) continue;
        fallbackById.set(it.id, compareRelativeLandmarkObservations(baselineChoice, fbChoice));
      }
    }

    return items.map((it) => {
      const strict = strictById.get(it.id);
      if (!strict) {
        return { itemId: it.id, type: it.type, description: it.description || it.type, verdict: "error", usedFallback: false, reason: "no strict verdict computed (missing model response for this item)" };
      }
      const fallback = fallbackById.get(it.id) || null;
      const combined = combineWithFallback(strict, fallback);
      return { itemId: it.id, type: it.type, description: it.description || it.type, verdict: combined.verdict, usedFallback: combined.usedFallback, reason: combined.reason };
    });
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "vanished_landmark",
        domain: domainLabel,
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return items.map((it) => ({ itemId: it.id, type: it.type, description: it.description || it.type, verdict: "error", usedFallback: false, reason: `check failed, degraded to non-blocking: ${String(e?.message || e)}` }));
  }
}
