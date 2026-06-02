import sharp from "sharp";

import { applyEdit } from "./editApply";

export type FixtureRepairType = "FIXTURE_ADDED" | "FIXTURE_REMOVED" | "FIXTURE_MODIFIED";
export type FixtureClass = "LIGHTING" | "HVAC" | "UNKNOWN";
export type FixtureStateChange = "ADDED" | "REMOVED" | "MODIFIED" | "UNKNOWN";

export type FixtureRepairHint = {
  supported: boolean;
  repairType?: FixtureRepairType;
  fixtureClass?: FixtureClass;
  fixtureStateChange?: FixtureStateChange;
  action?: "added" | "removed" | "modified" | "unknown";
  localizationMode?: "diff_zone_ceiling" | "diff_zone_hvac";
  reasonTokens?: string[];
};

type RepairZone = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const DIFF_THRESHOLD = 24;
const MIN_CHANGED_PIXELS = 120;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getRepairZones(fixtureClass: FixtureClass): RepairZone[] {
  if (fixtureClass === "LIGHTING") {
    return [
      { x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.36 },
      { x0: 0.1, y0: 0.0, x1: 0.9, y1: 0.42 },
    ];
  }

  return [
    { x0: 0.0, y0: 0.08, x1: 0.27, y1: 0.42 },
    { x0: 0.73, y0: 0.08, x1: 1.0, y1: 0.42 },
    { x0: 0.23, y0: 0.0, x1: 0.77, y1: 0.32 },
  ];
}

function createZoneMask(width: number, height: number, zones: RepairZone[]): Uint8Array {
  const mask = new Uint8Array(width * height);

  for (const zone of zones) {
    const left = Math.max(0, Math.floor(clamp01(zone.x0) * width));
    const top = Math.max(0, Math.floor(clamp01(zone.y0) * height));
    const right = Math.min(width, Math.ceil(clamp01(zone.x1) * width));
    const bottom = Math.min(height, Math.ceil(clamp01(zone.y1) * height));

    for (let y = top; y < bottom; y += 1) {
      const rowOffset = y * width;
      for (let x = left; x < right; x += 1) {
        mask[rowOffset + x] = 255;
      }
    }
  }

  return mask;
}

async function loadRgb(imagePath: string, width: number, height: number): Promise<Uint8Array> {
  const { data } = await sharp(imagePath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return new Uint8Array(data);
}

async function buildLocalizedFixtureMask(params: {
  baselinePath: string;
  candidatePath: string;
  fixtureClass: FixtureClass;
}): Promise<{ maskPng: Buffer; changedPixels: number; maskCoverageRatio: number }> {
  const candidateMeta = await sharp(params.candidatePath).metadata();
  if (!candidateMeta.width || !candidateMeta.height) {
    throw new Error("fixture_repair_mask_candidate_metadata_unavailable");
  }

  const width = candidateMeta.width;
  const height = candidateMeta.height;
  const [baselineRaw, candidateRaw] = await Promise.all([
    loadRgb(params.baselinePath, width, height),
    loadRgb(params.candidatePath, width, height),
  ]);

  const zoneMask = createZoneMask(width, height, getRepairZones(params.fixtureClass));
  const diffMaskRaw = new Uint8Array(width * height);
  let changedPixels = 0;

  for (let i = 0; i < width * height; i += 1) {
    if (zoneMask[i] !== 255) continue;

    const pixelOffset = i * 3;
    const dr = Math.abs((candidateRaw[pixelOffset] ?? 0) - (baselineRaw[pixelOffset] ?? 0));
    const dg = Math.abs((candidateRaw[pixelOffset + 1] ?? 0) - (baselineRaw[pixelOffset + 1] ?? 0));
    const db = Math.abs((candidateRaw[pixelOffset + 2] ?? 0) - (baselineRaw[pixelOffset + 2] ?? 0));
    const diff = Math.max(dr, dg, db);

    if (diff >= DIFF_THRESHOLD) {
      diffMaskRaw[i] = 255;
      changedPixels += 1;
    }
  }

  let maskRaw: Uint8Array = diffMaskRaw;
  if (changedPixels < MIN_CHANGED_PIXELS) {
    // Conservative fallback when diff signal is weak: constrain reinstate to fixture-prone zones.
    maskRaw = zoneMask;
    changedPixels = zoneMask.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0);
  }

  const softenedMaskRaw = await sharp(Buffer.from(maskRaw), {
    raw: { width, height, channels: 1 },
  })
    .blur(1.1)
    .threshold(110, { grayscale: true })
    .raw()
    .toBuffer();

  const maskPng = await sharp(softenedMaskRaw, {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toBuffer();

  const maskCoverageRatio = Math.min(1, changedPixels / Math.max(1, width * height));
  return {
    maskPng,
    changedPixels,
    maskCoverageRatio,
  };
}

function buildReinstateInstruction(fixtureClass: FixtureClass, fixtureStateChange: FixtureStateChange): string {
  const target = fixtureClass === "HVAC"
    ? "HVAC fixture state"
    : "lighting fixture state";
  const changeHint = fixtureStateChange.toLowerCase();

  return [
    `Restore the original ${target} (pre-change baseline) in the masked area using the Stage 1A reference. Detected change: ${changeHint}.`,
    "Preserve all furniture, decor, and staging outside the mask.",
    "Do not alter walls, openings, flooring, cabinetry, appliances, or room layout.",
  ].join(" ");
}

export async function runFixtureRepairAttempt(params: {
  jobId?: string;
  imageId?: string;
  attempt?: number;
  stage1ABasePath: string;
  stage2CandidatePath: string;
  hint: FixtureRepairHint;
}): Promise<{
  repairedPath: string;
  changedPixels: number;
  maskCoverageRatio: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  if (!params.hint.supported || !params.hint.repairType || !params.hint.fixtureClass || !params.hint.fixtureStateChange) {
    throw new Error("fixture_repair_not_supported");
  }

  const { maskPng, changedPixels, maskCoverageRatio } = await buildLocalizedFixtureMask({
    baselinePath: params.stage1ABasePath,
    candidatePath: params.stage2CandidatePath,
    fixtureClass: params.hint.fixtureClass,
  });

  const repairedPath = await applyEdit({
    jobId: params.jobId,
    imageId: params.imageId,
    baseImagePath: params.stage2CandidatePath,
    mask: maskPng,
    mode: "Reinstate",
    instruction: buildReinstateInstruction(params.hint.fixtureClass, params.hint.fixtureStateChange),
    stage1AReferencePath: params.stage1ABasePath,
    sceneType: "interior",
  });

  return {
    repairedPath,
    changedPixels,
    maskCoverageRatio,
    durationMs: Date.now() - startedAt,
  };
}
