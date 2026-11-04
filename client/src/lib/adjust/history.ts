// Photo Adjust: undo/redo of whole parameter sets (they are tiny, so each
// step stores a full copy — no patches needed).

import { adjustParamsEqual, type AdjustParams } from "./params";

export interface AdjustHistory {
  steps: AdjustParams[];
  index: number;
}

const MAX_STEPS = 100;

export function startHistory(initial: AdjustParams): AdjustHistory {
  return { steps: [initial], index: 0 };
}

export function currentStep(h: AdjustHistory): AdjustParams {
  return h.steps[h.index];
}

/** Record a finished change (slider released, button pressed). No-op if nothing changed. */
export function pushStep(h: AdjustHistory, next: AdjustParams): AdjustHistory {
  if (adjustParamsEqual(currentStep(h), next)) return h;
  const steps = [...h.steps.slice(0, h.index + 1), next];
  const trimmed = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps;
  return { steps: trimmed, index: trimmed.length - 1 };
}

export function canUndo(h: AdjustHistory): boolean {
  return h.index > 0;
}

export function canRedo(h: AdjustHistory): boolean {
  return h.index < h.steps.length - 1;
}

export function undo(h: AdjustHistory): AdjustHistory {
  return canUndo(h) ? { ...h, index: h.index - 1 } : h;
}

export function redo(h: AdjustHistory): AdjustHistory {
  return canRedo(h) ? { ...h, index: h.index + 1 } : h;
}
