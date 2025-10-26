export type GuardOutcome =
  | { ok: true; prompt: string; autoRewrote?: boolean }
  | { ok: false; prompt: string; reason: string }    // only used when we must block

const STRUCTURAL = /(remove|move|replace|resize|expand|shrink)\s+(window|door|wall|ceiling|stairs?|beam|cabinet|built[- ]?ins?|appliance|sink|toilet)/i;
const OBSTRUCTION = /(place|put|add).*(in front of|covering).*(window|door|egress|sink|switch|outlet|rail)/i;

export function enforceNoStructuralChange(original: string): GuardOutcome {
  const p = original.trim();
  const hits = [STRUCTURAL.test(p), OBSTRUCTION.test(p)].filter(Boolean).length;

  if (!hits) return { ok: true, prompt: p };

  // Soft auto-rewrite: keep furniture movable and clear egress
  const rewrite = p
    .replace(/in front of (a |the )?(window|door)/gi, "near the window/door while keeping it fully visible and unobstructed")
    .replace(/cover(ing)? (a |the )?(window|door)/gi, "placed so windows/doors remain fully visible and unobstructed")
    + " Do not remove, move, resize or cover any fixed architectural features (doors, windows, walls, ceilings, stairs, beams, built-ins, fixed plumbing/electrical). Keep egress clear.";

  // If the rewritten prompt still looks unsafe, only then block:
  if (STRUCTURAL.test(rewrite) || OBSTRUCTION.test(rewrite)) {
    return { ok: false, prompt: p, reason: "Requested change alters/blocks fixed features (doors/windows/walls)." };
  }
  return { ok: true, prompt: rewrite, autoRewrote: true };
}