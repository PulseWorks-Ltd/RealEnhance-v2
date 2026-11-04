// Photo Adjust: the saved slider values (schema v1), their ranges and defaults.
//
// The values — not just the pixels — are stored with every adjusted version,
// so a version re-opens editable and is always re-rendered from its clean
// parent image (never from an earlier adjusted render).

export const ADJUST_SCHEMA_VERSION = 1 as const;

export type AdjustSliderKey =
  | "brightness"
  | "contrast"
  | "highlights"
  | "shadows"
  | "warmth"
  | "tint"
  | "vibrance"
  | "saturation"
  | "straighten";

export interface AdjustParams {
  v: typeof ADJUST_SCHEMA_VERSION;
  brightness: number; // -100..100 (maps to about -1.5..+1.5 EV)
  contrast: number; // -100..100
  highlights: number; // -100..100 (negative = recover bright windows)
  shadows: number; // -100..100 (positive = lift dark corners)
  warmth: number; // -100..100 (negative = cooler/blue, positive = warmer/yellow)
  tint: number; // -100..100 (negative = green, positive = magenta)
  vibrance: number; // -100..100
  saturation: number; // -100..100
  straighten: number; // degrees, -10..10 (positive = rotate clockwise)
  rotate: 0 | 90 | 180 | 270; // quarter turns, clockwise
}

export interface SliderSpec {
  key: AdjustSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  help: string;
}

export const SLIDER_SPECS: Record<AdjustSliderKey, SliderSpec> = {
  brightness: { key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, help: "Makes the whole photo lighter or darker." },
  contrast: { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, help: "More or less difference between light and dark areas." },
  highlights: { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, help: "Move left to bring back detail in bright windows and lights." },
  shadows: { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, help: "Move right to brighten dark corners without washing out the rest." },
  warmth: { key: "warmth", label: "Warmth", min: -100, max: 100, step: 1, help: "Left for cooler (bluer), right for warmer (more yellow)." },
  tint: { key: "tint", label: "Tint", min: -100, max: 100, step: 1, help: "Left for greener, right for pinker. Fixes odd colour casts." },
  vibrance: { key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, help: "Boosts dull colours gently, leaving strong colours alone." },
  saturation: { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, help: "Makes every colour stronger or weaker." },
  straighten: { key: "straighten", label: "Straighten", min: -10, max: 10, step: 0.1, help: "Tilts the photo so walls and door frames stand upright." },
};

export const LIGHT_SLIDERS: AdjustSliderKey[] = ["brightness", "contrast", "highlights", "shadows"];
export const COLOUR_SLIDERS: AdjustSliderKey[] = ["warmth", "tint", "vibrance", "saturation"];

export const DEFAULT_ADJUST_PARAMS: AdjustParams = Object.freeze({
  v: ADJUST_SCHEMA_VERSION,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  warmth: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  straighten: 0,
  rotate: 0,
}) as AdjustParams;

const SLIDER_KEYS = Object.keys(SLIDER_SPECS) as AdjustSliderKey[];

function clampTo(value: unknown, min: number, max: number, step: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(max, Math.max(min, n));
  // Round to the slider step so stored values stay tidy (0.1° for straighten).
  const decimals = step < 1 ? 1 : 0;
  const rounded = Number(clamped.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normaliseRotate(value: unknown): AdjustParams["rotate"] {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const q = ((Math.round(n / 90) % 4) + 4) % 4;
  return (q * 90) as AdjustParams["rotate"];
}

/** Turn anything (stored JSON, a request body) into safe, in-range values. */
export function sanitizeAdjustParams(input: unknown): AdjustParams {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: AdjustParams = { ...DEFAULT_ADJUST_PARAMS };
  for (const key of SLIDER_KEYS) {
    const spec = SLIDER_SPECS[key];
    out[key] = clampTo(src[key], spec.min, spec.max, spec.step);
  }
  out.rotate = normaliseRotate(src.rotate);
  return out;
}

export function isIdentityAdjust(p: AdjustParams): boolean {
  return SLIDER_KEYS.every((k) => p[k] === 0) && p.rotate === 0;
}

export function adjustParamsEqual(a: AdjustParams, b: AdjustParams): boolean {
  return SLIDER_KEYS.every((k) => a[k] === b[k]) && a.rotate === b.rotate;
}

export function rotateClockwise(r: AdjustParams["rotate"]): AdjustParams["rotate"] {
  return (((r + 90) % 360) as AdjustParams["rotate"]);
}

/** Display value for a slider, e.g. "+12", "−40", "0", "−0.6°". */
export function formatSliderValue(key: AdjustSliderKey, value: number): string {
  if (value === 0) return key === "straighten" ? "0°" : "0";
  const sign = value > 0 ? "+" : "−";
  const abs = Math.abs(value);
  return key === "straighten" ? `${sign}${abs.toFixed(1)}°` : `${sign}${abs}`;
}
