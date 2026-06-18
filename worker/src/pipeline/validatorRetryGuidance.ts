/**
 * Validator-driven retry guidance injection for Stage 2 automatic retries.
 *
 * Maps validator failure trigger tokens to targeted guidance blocks that are
 * prepended to Stage 2 generation prompts on automatic retries, giving Gemini
 * explicit instruction to avoid repeating the same structural mistakes.
 *
 * Usage contract:
 * - Only injected when retryType === "validator_forced_retry".
 * - Guidance accumulates across retry attempts (attempt 1 triggers opening guidance;
 *   attempt 2 that also fails on fixture adds fixture guidance on top).
 * - Does NOT change validator thresholds, authority, or retry counts.
 */

// ─── Guidance category type ───────────────────────────────────────────────────

export type ValidatorGuidanceCategory =
  | "opening"
  | "fixture"
  | "flooring"
  | "envelope";

// ─── Token → Category mapping ─────────────────────────────────────────────────

/**
 * Maps normalised validator issue type tokens to guidance categories.
 * Covers the full vocabulary from issueTypes.ts plus common compound tokens
 * that appear in reason strings from openingValidator, fixtureValidator, etc.
 */
const TOKEN_TO_CATEGORY: Readonly<Record<string, ValidatorGuidanceCategory>> = {
  // Opening validator tokens
  opening_removed: "opening",
  opening_sealed: "opening",
  opening_obscured: "opening",
  opening_occlusion: "opening",
  opening_infilled: "opening",
  opening_relocated: "opening",
  opening_resized_major: "opening",
  opening_resized_minor: "opening",
  opening_anomaly: "opening",
  opening_resize: "opening",
  gemini_opening_blocked: "opening",
  door_or_closet_partial_occlusion_not_allowed: "opening",
  door_or_closet_blocked: "opening",
  window_occlusion_exceeds_partial_threshold: "opening",
  light_anchor_opening_infilled: "opening",
  light_anchor_opening_removed: "opening",
  light_anchor_opening_relocated: "opening",

  // Fixture validator tokens
  fixture_changed: "fixture",
  fixture_removed: "fixture",
  fixture_anomaly: "fixture",
  built_in_modified: "fixture",
  hvac_changed: "fixture",
  faucet_changed: "fixture",

  // Flooring validator tokens
  floor_changed: "flooring",
  floor_anomaly: "flooring",
  flooring_changed: "flooring",

  // Envelope / wall validator tokens
  wall_changed: "envelope",
  room_envelope_changed: "envelope",
  wall_modified: "envelope",
  ceiling_modified: "envelope",
  envelope_anomaly: "envelope",
  envelope_vertical_edge_loss: "envelope",
  envelope_corner_flattened: "envelope",
  structural_review_failed: "envelope",
};

// ─── Guidance text blocks ─────────────────────────────────────────────────────

const GUIDANCE_BLOCKS: Readonly<Record<ValidatorGuidanceCategory, string>> = {
  opening: `CRITICAL RETRY GUIDANCE — OPENING PRESERVATION:
The previous attempt removed, obscured, cropped, or concealed an existing opening.
Preserve all windows and doors.
Do not place furniture, artwork, wall panels, decorative features, cabinetry, or staging elements in positions that conceal openings.
Ensure all original openings remain clearly visible and structurally unchanged.`,

  fixture: `CRITICAL RETRY GUIDANCE — FIXTURE PRESERVATION:
Preserve all existing built-in fixtures exactly as they appear in the original image.
Do not remove, replace, recolour, redesign, relocate, or materially alter cabinetry, countertops, sinks, appliances, fixed lighting, faucets, HVAC units, wardrobes, shelving, or other built-in fixtures.`,

  flooring: `CRITICAL RETRY GUIDANCE — FLOORING PRESERVATION:
Preserve existing flooring material, colour, pattern, texture, and layout.
Do not replace, recolour, retile, or alter flooring.`,

  envelope: `CRITICAL RETRY GUIDANCE — ENVELOPE PRESERVATION:
Preserve all walls, ceilings, bulkheads, trims, architectural features, and room geometry exactly as they appear in the original image.`,
};

// ─── Ordered output sequence ──────────────────────────────────────────────────

const CATEGORY_ORDER: ValidatorGuidanceCategory[] = [
  "opening",
  "fixture",
  "flooring",
  "envelope",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw validator reason token to lowercase_underscore form,
 * matching how issueTypes.ts and worker.ts normalize reasons.
 */
function normalizeToken(token: string): string {
  return String(token || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Attempt an exact-match lookup then fall back to substring matching
 * for compound tokens such as `unified_failure:opening_removed:...`.
 */
function categorizeToken(normalized: string): ValidatorGuidanceCategory | undefined {
  const direct = TOKEN_TO_CATEGORY[normalized];
  if (direct) return direct;

  // Substring match — earlier entries in the token map take priority
  for (const [key, cat] of Object.entries(TOKEN_TO_CATEGORY)) {
    if (normalized.includes(key)) return cat;
  }
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Accumulate new trigger tokens into an existing set, maintaining uniqueness.
 * Returns a new array; does not mutate the input.
 */
export function accumulateValidatorTriggers(
  existing: string[],
  incoming: string[]
): string[] {
  const existingSet = new Set(existing.map(normalizeToken));
  const result: string[] = [...existing];

  for (const raw of incoming) {
    const norm = normalizeToken(raw);
    if (norm && !existingSet.has(norm)) {
      existingSet.add(norm);
      result.push(norm);
    }
  }

  return result;
}

/**
 * Build the validator-derived retry guidance string from accumulated trigger tokens.
 *
 * Returns the guidance text (or null when no applicable categories are found)
 * along with the set of categories applied — used for structured logging.
 */
export function buildValidatorRetryGuidance(
  triggers: string[],
): {
  guidanceText: string | null;
  categories: ValidatorGuidanceCategory[];
} {
  if (triggers.length === 0) {
    return { guidanceText: null, categories: [] };
  }

  const found = new Set<ValidatorGuidanceCategory>();
  for (const token of triggers) {
    const norm = normalizeToken(token);
    const cat = categorizeToken(norm);
    if (cat) found.add(cat);
  }

  if (found.size === 0) {
    return { guidanceText: null, categories: [] };
  }

  const appliedCategories = CATEGORY_ORDER.filter((cat) => found.has(cat));
  const guidanceText = appliedCategories.map((cat) => GUIDANCE_BLOCKS[cat]).join("\n\n");

  return { guidanceText, categories: appliedCategories };
}
