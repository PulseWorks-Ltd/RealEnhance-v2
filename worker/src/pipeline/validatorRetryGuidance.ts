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

type AutoRetryGuidanceInput = {
  triggers: string[];
  roomType?: string;
  anchorWall?: string | null;
};

type AutoRetryGuidanceOutput = {
  text: string | null;
  validatorInstructions: string[];
  layoutInstruction: string | null;
  instructionCount: number;
};

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

const OPENING_TRIGGER_TOKENS = [
  "opening_removed",
  "opening_sealed",
  "opening_infilled",
  "opening_relocated",
  "opening_resized",
  "opening_resize",
  "opening_obscured",
  "opening_occlusion",
  "window_occlusion_exceeds_partial_threshold",
  "door_or_closet_blocked",
  "door_or_closet_partial_occlusion_not_allowed",
  "light_anchor_opening_removed",
  "light_anchor_opening_infilled",
  "light_anchor_opening_relocated",
];

const FIXTURE_PENDANT_TOKENS = ["pendant", "chandelier"];
const FIXTURE_HVAC_TOKENS = ["hvac", "air_conditioner", "ac_unit", "split_unit"];
const FIXTURE_COUNTERTOP_TOKENS = ["countertop", "counter_top", "benchtop", "worktop"];

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

function hasAnyToken(haystack: string[], tokens: string[]): boolean {
  for (const value of haystack) {
    for (const token of tokens) {
      if (value.includes(token)) return true;
    }
  }
  return false;
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = normalizeToken(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
  }
  return out;
}

function inferAnchorPlacementInstruction(roomType?: string, anchorWall?: string | null): string | null {
  const normalizedRoom = normalizeToken(roomType || "");
  const normalizedWall = normalizeToken(anchorWall || "");

  const wallPhrase = normalizedWall.includes("right")
    ? "against the wall on the right"
    : normalizedWall.includes("left")
      ? "against the wall on the left"
      : (normalizedWall.includes("rear") || normalizedWall.includes("back"))
        ? "against the rear wall"
        : "against the rear wall";

  if (normalizedRoom.includes("bedroom")) {
    return `Place the bed ${wallPhrase}.`;
  }
  if (normalizedRoom.includes("living")) {
    return normalizedWall.includes("rear") || normalizedWall.includes("back")
      ? "Place the sofa against the rear wall."
      : `Place the sofa ${wallPhrase}.`;
  }
  if (normalizedRoom.includes("dining")) {
    return "Place the dining table centrally within the room.";
  }
  return null;
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

export function buildAutoRetryGuidance(input: AutoRetryGuidanceInput): AutoRetryGuidanceOutput {
  const normalizedTriggers = input.triggers.map(normalizeToken).filter(Boolean);
  const lines: string[] = [];

  if (hasAnyToken(normalizedTriggers, OPENING_TRIGGER_TOKENS)) {
    lines.push("Do not remove, seal, cover, wall over, resize or relocate any window openings.");
  }

  if (hasAnyToken(normalizedTriggers, FIXTURE_PENDANT_TOKENS)) {
    lines.push("Do not remove or materially alter any existing pendant lights.");
  }

  if (hasAnyToken(normalizedTriggers, FIXTURE_HVAC_TOKENS)) {
    lines.push("Do not remove or materially alter any existing HVAC units.");
  }

  if (hasAnyToken(normalizedTriggers, FIXTURE_COUNTERTOP_TOKENS)) {
    lines.push("Do not alter or replace existing countertop materials or finishes.");
  }

  if (hasAnyToken(normalizedTriggers, ["fixture_changed", "fixture_removed", "built_in_modified"])) {
    lines.push("Do not remove or materially alter any existing built-in fixtures.");
  }

  if (hasAnyToken(normalizedTriggers, ["floor_changed", "flooring_changed", "floor_anomaly"])) {
    lines.push("Do not alter existing flooring materials or finishes.");
  }

  if (hasAnyToken(normalizedTriggers, ["envelope_vertical_edge_loss", "envelope_corner_flattened", "wall_changed", "room_envelope_changed", "envelope_confirmed_structural_change"])) {
    lines.push("Do not alter wall geometry, recesses, corners, or room envelope surfaces.");
  }

  const validatorInstructions = dedupeLines(lines);
  const layoutInstruction = inferAnchorPlacementInstruction(input.roomType, input.anchorWall);
  const combined = layoutInstruction
    ? [...validatorInstructions, layoutInstruction]
    : [...validatorInstructions];
  const limited = combined.slice(0, 5);

  return {
    text: limited.length > 0 ? limited.join("\n") : null,
    validatorInstructions,
    layoutInstruction,
    instructionCount: limited.length,
  };
}
