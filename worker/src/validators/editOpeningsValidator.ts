import {
  extractStructuralBaseline,
  type StructuralOpening,
} from "./openingPreservationValidator";

type OpeningKind = "window" | "door";

type MatchedOpening = {
  kind: OpeningKind;
  baselineId: string;
  editedId: string;
  iou: number;
  centerDelta: number;
  areaDeltaRatio: number;
  aspectDelta: number;
};

export type EditOpeningsComparedAgainst = "stage1a" | "edit_input";

export type EditOpeningsValidationSummary = {
  validator: "edit_openings";
  passed: boolean;
  comparedAgainst: EditOpeningsComparedAgainst;
  reason: string;
  windowsBefore: number;
  windowsAfter: number;
  doorsBefore: number;
  doorsAfter: number;
  countMismatch: boolean;
  displacementViolation: boolean;
  sizeOrShapeViolation: boolean;
  unmatchedBaselineOpenings: string[];
  unmatchedEditedOpenings: string[];
  tolerance: {
    minIoU: number;
    maxCenterDelta: number;
    maxAreaDeltaRatio: number;
    maxAspectDelta: number;
  };
  matches: MatchedOpening[];
};

const MIN_IOU = Number(process.env.EDIT_OPENINGS_MIN_IOU || 0.2);
const MAX_CENTER_DELTA = Number(process.env.EDIT_OPENINGS_MAX_CENTER_DELTA || 0.11);
const MAX_AREA_DELTA_RATIO = Number(process.env.EDIT_OPENINGS_MAX_AREA_DELTA_RATIO || 0.42);
const MAX_ASPECT_DELTA = Number(process.env.EDIT_OPENINGS_MAX_ASPECT_DELTA || 0.45);

function area(bbox: [number, number, number, number]): number {
  const w = Math.max(0, bbox[2] - bbox[0]);
  const h = Math.max(0, bbox[3] - bbox[1]);
  return w * h;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = area([x1, y1, x2, y2]);
  if (inter <= 0) return 0;
  const union = area(a) + area(b) - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function centerDistance(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax = (a[0] + a[2]) / 2;
  const ay = (a[1] + a[3]) / 2;
  const bx = (b[0] + b[2]) / 2;
  const by = (b[1] + b[3]) / 2;
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizeKind(opening: StructuralOpening): OpeningKind | null {
  if (opening.type === "window") return "window";
  if (opening.type === "door") return "door";
  return null;
}

function keyCount(openings: StructuralOpening[], key: OpeningKind): number {
  return openings.reduce((sum, opening) => sum + (normalizeKind(opening) === key ? 1 : 0), 0);
}

function openingAspect(opening: StructuralOpening): number {
  if (Number.isFinite(opening.approxAspectRatio) && opening.approxAspectRatio > 0) {
    return opening.approxAspectRatio;
  }
  if (Number.isFinite(opening.aspect_ratio) && opening.aspect_ratio > 0) {
    return opening.aspect_ratio;
  }
  const w = Math.max(0.0001, opening.bbox[2] - opening.bbox[0]);
  const h = Math.max(0.0001, opening.bbox[3] - opening.bbox[1]);
  return w / h;
}

export async function runEditOpeningsValidator(
  baselineImagePath: string,
  editedImagePath: string,
  comparedAgainst: EditOpeningsComparedAgainst = "stage1a",
): Promise<EditOpeningsValidationSummary> {
  const baseline = await extractStructuralBaseline(baselineImagePath);
  const edited = await extractStructuralBaseline(editedImagePath);

  const baselineOpenings = baseline.openings.filter((opening) => normalizeKind(opening) !== null);
  const editedOpenings = edited.openings.filter((opening) => normalizeKind(opening) !== null);

  const unmatchedBaseline = [...baselineOpenings];
  const unmatchedEdited = [...editedOpenings];
  const matches: MatchedOpening[] = [];

  const kinds: OpeningKind[] = ["window", "door"];
  for (const kind of kinds) {
    const baselineKind = unmatchedBaseline.filter((opening) => normalizeKind(opening) === kind);
    const editedKind = unmatchedEdited.filter((opening) => normalizeKind(opening) === kind);

    for (const baselineOpening of baselineKind) {
      let bestIndex = -1;
      let bestScore = -1;
      let bestIou = 0;
      let bestCenter = 999;

      for (let i = 0; i < editedKind.length; i += 1) {
        const candidate = editedKind[i];
        const overlap = iou(baselineOpening.bbox, candidate.bbox);
        const center = centerDistance(baselineOpening.bbox, candidate.bbox);
        const score = overlap - center;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
          bestIou = overlap;
          bestCenter = center;
        }
      }

      if (bestIndex < 0) continue;

      const matchedEdited = editedKind.splice(bestIndex, 1)[0];
      const baselineIdx = unmatchedBaseline.findIndex((entry) => entry.id === baselineOpening.id);
      if (baselineIdx >= 0) unmatchedBaseline.splice(baselineIdx, 1);
      const editedIdx = unmatchedEdited.findIndex((entry) => entry.id === matchedEdited.id);
      if (editedIdx >= 0) unmatchedEdited.splice(editedIdx, 1);

      const baseArea = Math.max(0.000001, area(baselineOpening.bbox));
      const editedArea = Math.max(0.000001, area(matchedEdited.bbox));
      const areaDeltaRatio = Math.abs(editedArea - baseArea) / baseArea;
      const aspectDelta = Math.abs(openingAspect(matchedEdited) - openingAspect(baselineOpening));

      matches.push({
        kind,
        baselineId: baselineOpening.id,
        editedId: matchedEdited.id,
        iou: Number(bestIou.toFixed(4)),
        centerDelta: Number(bestCenter.toFixed(4)),
        areaDeltaRatio: Number(areaDeltaRatio.toFixed(4)),
        aspectDelta: Number(aspectDelta.toFixed(4)),
      });
    }
  }

  const countMismatch =
    keyCount(baselineOpenings, "window") !== keyCount(editedOpenings, "window")
    || keyCount(baselineOpenings, "door") !== keyCount(editedOpenings, "door");

  const displacementViolation = matches.some((m) => m.iou < MIN_IOU || m.centerDelta > MAX_CENTER_DELTA);
  const sizeOrShapeViolation = matches.some(
    (m) => m.areaDeltaRatio > MAX_AREA_DELTA_RATIO || m.aspectDelta > MAX_ASPECT_DELTA,
  );

  const unmatchedBaselineOpenings = unmatchedBaseline.map((opening) => opening.id);
  const unmatchedEditedOpenings = unmatchedEdited.map((opening) => opening.id);

  const passed =
    !countMismatch
    && !displacementViolation
    && !sizeOrShapeViolation
    && unmatchedBaselineOpenings.length === 0
    && unmatchedEditedOpenings.length === 0;

  const windowsBefore = keyCount(baselineOpenings, "window");
  const windowsAfter = keyCount(editedOpenings, "window");
  const doorsBefore = keyCount(baselineOpenings, "door");
  const doorsAfter = keyCount(editedOpenings, "door");

  const reason = passed
    ? "openings_preserved"
    : countMismatch
      ? "opening_count_changed"
      : unmatchedBaselineOpenings.length > 0 || unmatchedEditedOpenings.length > 0
        ? "opening_set_changed"
        : displacementViolation
          ? "opening_displacement_detected"
          : "opening_size_or_shape_changed";

  return {
    validator: "edit_openings",
    passed,
    comparedAgainst,
    reason,
    windowsBefore,
    windowsAfter,
    doorsBefore,
    doorsAfter,
    countMismatch,
    displacementViolation,
    sizeOrShapeViolation,
    unmatchedBaselineOpenings,
    unmatchedEditedOpenings,
    tolerance: {
      minIoU: MIN_IOU,
      maxCenterDelta: MAX_CENTER_DELTA,
      maxAreaDeltaRatio: MAX_AREA_DELTA_RATIO,
      maxAspectDelta: MAX_ASPECT_DELTA,
    },
    matches,
  };
}
