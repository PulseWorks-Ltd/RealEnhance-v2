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
