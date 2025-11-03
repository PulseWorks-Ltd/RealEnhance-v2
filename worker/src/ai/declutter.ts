// server/ai/declutter.ts

export type Scene = "interior" | "exterior";

export type ClutterSignals = {
  // Common (interior & exterior)
  smallObjectCount: number;        // loose items: bottles, toys, shoes, tools, etc.
  paperOrTextCount: number;        // notes, posters, fridge magnets, mail
  floorVisibility: number;         // 0..1  (1 = floor fully visible, 0 = not visible)
  surfaceVisibility: number;       // 0..1  (1 = counters/tables mostly clear, 0 = covered)
  messConfidence: number;          // 0..1  (model confidence that the scene is messy)
  duplicateSmallItems: number;     // groups/sets of repeated small items

  // Interior-only (optional)
  roomTypePred?: string;
  doorObstruction?: number;        // 0..1  (1 = clearly blocked)
  countertopItemsCount?: number;

  // Exterior-only (optional)
  binOrHoseCount?: number;
  looseYardItemsCount?: number;    // buckets, toys, tools, tarps
  weedOrDebrisScore?: number;      // 0..1
};

export type DeclutterLevel = "light" | "standard" | "heavy";

export function scoreClutter(signals: ClutterSignals, scene: Scene): number {
  let s = 0;

  // Universal
  s += Math.min(signals.smallObjectCount ?? 0, 20) * 2;             // 0..40
  s += Math.min(signals.paperOrTextCount ?? 0, 10) * 2;             // 0..20
  s += Math.max(0, 1 - (signals.floorVisibility ?? 1)) * 10;        // 0..10
  s += Math.max(0, 1 - (signals.surfaceVisibility ?? 1)) * 10;      // 0..10
  s += (signals.messConfidence ?? 0) * 20;                           // 0..20
  s += Math.min(signals.duplicateSmallItems ?? 0, 10) * 1;           // 0..10

  if (scene === "interior") {
    s += (signals.doorObstruction ?? 0) * 10;                        // 0..10
    s += Math.min(signals.countertopItemsCount ?? 0, 15) * 1;        // 0..15

    const rt = (signals.roomTypePred || "").toLowerCase();
    // bathrooms/garages: naturally "polish-only-ish" → soften the score
    if (["bathroom", "garage"].includes(rt)) s *= 0.7;
  } else {
    s += Math.min(signals.binOrHoseCount ?? 0, 8) * 3;               // 0..24
    s += Math.min(signals.looseYardItemsCount ?? 0, 12) * 2;         // 0..24
    s += (signals.weedOrDebrisScore ?? 0) * 15;                       // 0..15
  }

  // Clamp 0..100
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function decideDeclutterLevel(score: number, scene: Scene): DeclutterLevel {
  if (scene === "exterior") {
    // keep exterior natural; avoid "sterile" gardens/driveways
    if (score < 25) return "light";
    if (score < 50) return "standard";
    return "standard"; // clamp heavy → standard outdoors
  }

  // Interior
  if (score < 20) return "light";
  if (score < 55) return "standard";
  return "heavy";
}

// Safety dampers to avoid aggressive cleaning in sensitive contexts
export function applyDeclutterDampers(
  level: DeclutterLevel,
  scene: Scene,
  opts?: {
    roomType?: string;
    isRetry?: boolean;
    allowStaging?: boolean;
    userOverride?: DeclutterLevel | "auto"; // if user explicitly chose a level
  }
): DeclutterLevel {
  // Respect manual override if given (and not "auto")
  if (opts?.userOverride && opts.userOverride !== "auto") {
    return opts.userOverride;
  }

  let out = level;

  // On retries, turn it down a notch to avoid over-scrubbing
  if (opts?.isRetry) {
    out = out === "heavy" ? "standard" : out === "standard" ? "light" : "light";
  }

  // If staging is off, don't go hard on declutter (keeps "polish-only + tidy" feel)
  if (opts?.allowStaging === false && out === "heavy") out = "standard";

  const rt = (opts?.roomType || "").toLowerCase();

  // Bathrooms/garages: never "heavy"
  if (["bathroom", "garage"].includes(rt) && out === "heavy") out = "standard";
  // Laundry/hallway: cap at standard
  if (["laundry", "hallway"].includes(rt) && out === "heavy") out = "standard";

  return out;
}

/**
 * Minimal vision prompt you can send to your detector to get the signals.
 * (You can inline this text where you build your vision call.)
 */
export const VISION_SIGNAL_INSTRUCTION = `
Return a compact JSON with these fields only:
{
  "smallObjectCount": number,
  "paperOrTextCount": number,
  "floorVisibility": number,        // 0..1
  "surfaceVisibility": number,      // 0..1
  "messConfidence": number,         // 0..1
  "duplicateSmallItems": number,
  "roomTypePred": string,           // if interior
  "doorObstruction": number,        // 0..1 (if interior)
  "countertopItemsCount": number,   // if interior
  "binOrHoseCount": number,         // if exterior
  "looseYardItemsCount": number,    // if exterior
  "weedOrDebrisScore": number       // 0..1 (if exterior)
}
No prose, no explanations—JSON only.
`.trim();
