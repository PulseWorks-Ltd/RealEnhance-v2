/**
 * Structured signals emitted by specialist validators.
 *
 * Each signal represents a single, meaningful, human-visible structural claim
 * tied to a specific image region.  These are NOT pass/fail decisions — they
 * are hypotheses forwarded to Gemini for visual adjudication.
 *
 * Design constraints:
 *   - Intentionally minimal: claim + region + confidence, nothing more.
 *   - Region is REQUIRED — a signal without spatial context is not actionable.
 *   - Confidence is the specialist's internal certainty.  It influences
 *     question framing but is never shown to Gemini directly.
 */

/** Exhaustive set of structural claims the system can investigate. */
export type StructuralClaim =
  | "opening_removed"
  | "opening_added"
  | "opening_resized_major"
  | "wall_plane_modified"
  | "corner_flattened"
  | "recess_removed";

/**
 * Normalised bounding-box for a region of interest.
 * All values are 0–1 relative to image dimensions.
 */
export type SignalRegion = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** A single structural hypothesis emitted by a specialist validator. */
export type StructuralSignal = {
  claim: StructuralClaim;
  region: SignalRegion;
  confidence: number;

  /* ── Optional provenance (for debug logging; never sent to Gemini) ── */

  /** Source validator that produced this signal. */
  source?: string;
  /** Baseline opening ID (e.g. "D2", "W1") when signal is opening-related. */
  openingId?: string;
  /** Opening type from baseline, if applicable. */
  openingType?: string;
  /** Wall index from baseline (0-3), if applicable. */
  wallIndex?: number;
};

/** Possible Gemini adjudication outcomes for a single claim. */
export type ClaimResult = "CONFIRMED" | "NOT_PRESENT" | "UNCERTAIN";

/** Gemini's response to a single structural claim investigation. */
export type AdjudicatedClaim = {
  claim: StructuralClaim;
  region: SignalRegion;
  result: ClaimResult;
  detail?: string;
};

/** Claims that, when CONFIRMED by Gemini, constitute a prohibited structural change. */
export const PROHIBITED_STRUCTURAL_CLAIMS = new Set<StructuralClaim>([
  "opening_removed",
  "opening_added",
  "opening_resized_major",
  "wall_plane_modified",
  "corner_flattened",
  "recess_removed",
]);

// ── Signal deduplication ──────────────────────────────────────────────

/** Intersection-over-Union of two normalised bounding boxes. */
function regionIoU(a: SignalRegion, b: SignalRegion): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  if (intersection === 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return intersection / (areaA + areaB - intersection);
}

/**
 * Deduplicate structural signals.
 *
 * Two signals are duplicates when they share the same claim AND their regions
 * overlap with IoU ≥ `iouThreshold`.  When a duplicate pair is found the
 * signal with higher confidence is kept.
 */
export function deduplicateSignals(
  signals: StructuralSignal[],
  iouThreshold = 0.30,
): StructuralSignal[] {
  if (signals.length <= 1) return signals;

  // Sort descending by confidence so the first seen for each group wins.
  const sorted = [...signals].sort((a, b) => b.confidence - a.confidence);
  const keep: StructuralSignal[] = [];

  for (const sig of sorted) {
    const isDuplicate = keep.some(
      (kept) => kept.claim === sig.claim && regionIoU(kept.region, sig.region) >= iouThreshold,
    );
    if (!isDuplicate) {
      keep.push(sig);
    }
  }

  return keep;
}

// ── Signal → targeted question conversion ─────────────────────────────

/** Human-readable region description for Gemini prompt context. */
function describeRegion(r: SignalRegion): string {
  const cx = (r.x1 + r.x2) / 2;
  const cy = (r.y1 + r.y2) / 2;
  const horizontal =
    cx < 0.25 ? "far left" :
    cx < 0.45 ? "left of center" :
    cx < 0.55 ? "center" :
    cx < 0.75 ? "right of center" :
    "far right";
  const vertical =
    cy < 0.35 ? "upper" :
    cy < 0.65 ? "mid-height" :
    "lower";
  const pct = (v: number) => Math.round(v * 100);
  return `${vertical} ${horizontal} region (approx ${pct(r.x1)}%-${pct(r.x2)}% horizontal, ${pct(r.y1)}%-${pct(r.y2)}% vertical)`;
}

/**
 * Neutral, non-leading question for each structural claim type.
 *
 * From the plan's amendment 1: questions must use neutral tone.
 * Never say "was removed" — always "is X still present?"
 */
const CLAIM_QUESTION_MAP: Record<StructuralClaim, string> = {
  opening_removed:
    "In the AFTER image, is there still a penetrative opening (window, door, or walk-through) at the indicated region, or has the opening been replaced by a continuous wall surface?",
  opening_added:
    "Comparing BEFORE and AFTER at the indicated region: does a new architectural opening (window, door, walk-through) appear in AFTER that was not present in BEFORE?",
  opening_resized_major:
    "At the indicated region, compare the opening's frame edges in BEFORE vs AFTER. Has the opening's visible area reduced significantly (≥25%), with wall surface expanding into what was previously void?",
  wall_plane_modified:
    "At the indicated region, do the same number of distinct wall planes exist in AFTER as in BEFORE? Look specifically for a vertical boundary line between two wall surfaces: is it still present, or have the planes merged into one continuous surface?",
  corner_flattened:
    "At the indicated region in BEFORE, two wall planes meet at a vertical corner. In AFTER, is that vertical corner still present, or have the two planes merged into a single flat surface?",
  recess_removed:
    "At the indicated region in BEFORE, there is a recessed area or alcove. In AFTER, is the recess still present with visible depth, or has it been filled to create a flat wall surface?",
};

/**
 * Build the structural claim investigation block for injection into the
 * Gemini prompt.  Each signal becomes a numbered question pinpointed to
 * a specific image region.
 *
 * Returns empty string when there are no signals (no prompt modification).
 */
export function buildStructuralClaimBlock(signals: StructuralSignal[]): string {
  if (!signals || signals.length === 0) return "";

  const questions = signals.map((sig, i) => {
    const regionDesc = describeRegion(sig.region);
    const question = CLAIM_QUESTION_MAP[sig.claim] || `Verify structural consistency at the indicated region.`;
    const openingCtx = sig.openingId ? ` (baseline opening ${sig.openingId}, type: ${sig.openingType || "unknown"})` : "";
    return `${i + 1}. CLAIM: ${sig.claim}${openingCtx}\n   REGION: ${regionDesc}\n   QUESTION: ${question}`;
  });

  return `

STRUCTURAL CLAIM INVESTIGATION (respond per-claim in structuralClaims array):
For each claim below, visually examine the specified region in BEFORE and AFTER images.
Respond with EXACTLY one of: "CONFIRMED", "NOT_PRESENT", or "UNCERTAIN".
- CONFIRMED: the structural change described IS visible in the images.
- NOT_PRESENT: the structural change described is NOT visible — the structure appears unchanged.
- UNCERTAIN: the region is unclear, occluded, or ambiguous — cannot determine.

${questions.join("\n\n")}

Include a "structuralClaims" array in your JSON response with one entry per claim:
[{ "claim": "<claim_type>", "result": "CONFIRMED"|"NOT_PRESENT"|"UNCERTAIN", "detail": "<brief visual reasoning>" }]`;
}

/**
 * Parse Gemini's structuralClaims response array into typed AdjudicatedClaim[].
 *
 * From the plan's amendment 2: parse failure → UNCERTAIN, not fallback pass.
 */
export function parseStructuralClaims(
  raw: unknown,
  expectedSignals: StructuralSignal[],
): AdjudicatedClaim[] {
  if (!Array.isArray(raw)) {
    // Parse failure → every claim becomes UNCERTAIN
    return expectedSignals.map((sig) => ({
      claim: sig.claim,
      region: sig.region,
      result: "UNCERTAIN" as ClaimResult,
      detail: "parse_failure: structuralClaims not present or not an array",
    }));
  }

  const resultMap = new Map<string, { result: ClaimResult; detail?: string }>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const claim = String(item.claim || "").toLowerCase().trim();
    const resultStr = String(item.result || "").toUpperCase().trim();
    const result: ClaimResult =
      resultStr === "CONFIRMED" ? "CONFIRMED" :
      resultStr === "NOT_PRESENT" ? "NOT_PRESENT" :
      "UNCERTAIN";
    const detail = typeof item.detail === "string" ? item.detail : undefined;
    resultMap.set(claim, { result, detail });
  }

  return expectedSignals.map((sig) => {
    const match = resultMap.get(sig.claim);
    if (match) {
      return {
        claim: sig.claim,
        region: sig.region,
        result: match.result,
        detail: match.detail,
      };
    }
    // Claim not in response → UNCERTAIN (amendment 2)
    return {
      claim: sig.claim,
      region: sig.region,
      result: "UNCERTAIN" as ClaimResult,
      detail: "claim_not_in_response",
    };
  });
}
