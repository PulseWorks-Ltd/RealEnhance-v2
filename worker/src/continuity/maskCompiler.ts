import fs from "fs/promises";
import sharp from "sharp";
import { nLog } from "../logger";
import type { CompiledMaskResult, NormalizedPoint, PlacementPlan } from "./types";
import { VertexSecondaryContinuityError } from "./types";
import { buildArchitecturalExclusionMask } from "./exclusionMask";
import { resolveDeterministicZoneProjection } from "./deterministicProjection";
import { generateGeminiOccupancyMask, useGeminiOccupancyMaskMode } from "./geminiOccupancyMask";

function toPixelPoint(point: NormalizedPoint, width: number, height: number): string {
  const x = Math.max(0, Math.min(width, Math.round(point.x * width)));
  const y = Math.max(0, Math.min(height, Math.round(point.y * height)));
  return `${x},${y}`;
}

function buildFallbackWallPolygon(zone: PlacementPlan["furnitureZones"][number]): NormalizedPoint[] {
  const bbox = zone.normalizedBoundingBox;
  const top = bbox.y;
  const mid = Math.min(1, bbox.y + bbox.height * 0.62);
  const left = bbox.x;
  const right = Math.min(1, bbox.x + bbox.width);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: mid },
    { x: left, y: mid },
  ];
}

function buildFallbackFloorPolygon(zone: PlacementPlan["furnitureZones"][number]): NormalizedPoint[] {
  const bbox = zone.normalizedBoundingBox;
  const mid = Math.min(1, bbox.y + bbox.height * 0.56);
  const bottom = Math.min(1, bbox.y + bbox.height);
  const left = bbox.x;
  const right = Math.min(1, bbox.x + bbox.width);
  const inset = Math.min(0.08, bbox.width * 0.16);
  return [
    { x: Math.min(1, left + inset), y: mid },
    { x: Math.max(0, right - inset), y: mid },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function polygonSvg(points: NormalizedPoint[], width: number, height: number): string {
  if (points.length < 3) {
    return "";
  }
  const svgPoints = points.map((point) => toPixelPoint(point, width, height)).join(" ");
  return `<polygon points="${svgPoints}" fill="#ffffff" />`;
}

function countWhitePixels(buffer: Buffer): number {
  let count = 0;
  for (const value of buffer) {
    if (value > 0) {
      count += 1;
    }
  }
  return count;
}

function findMaskBoundingBox(buffer: Buffer, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (buffer[index] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function resolveRenderMaskMode(): "legacy" | "semantic_tight" {
  const raw = String(process.env.CONTINUITY_RENDER_MASK_MODE || "legacy").trim().toLowerCase();
  return raw === "semantic_tight" ? "semantic_tight" : "legacy";
}

function deriveMaskPath(basePath: string, stem: string): string {
  if (basePath.includes("-vertex-continuity-final-mask")) {
    return basePath.replace("-vertex-continuity-final-mask", `-vertex-continuity-${stem}`);
  }
  if (basePath.toLowerCase().endsWith(".png")) {
    return `${basePath.slice(0, -4)}-${stem}.png`;
  }
  return `${basePath}-${stem}.png`;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isContinuityDebugArtifactsEnabled(): boolean {
  if (process.env.CONTINUITY_DEBUG_ARTIFACTS != null) {
    return parseBooleanEnv(process.env.CONTINUITY_DEBUG_ARTIFACTS);
  }
  return String(process.env.NODE_ENV || "development").trim().toLowerCase() !== "production";
}

function isRenderExclusionClipGuardEnabled(): boolean {
  if (process.env.CONTINUITY_RENDER_EXCLUSION_CLIP_GUARD != null) {
    return parseBooleanEnv(process.env.CONTINUITY_RENDER_EXCLUSION_CLIP_GUARD);
  }
  return true;
}

function conservativeSemanticStabilization(mask: Buffer, width: number, height: number): Buffer {
  const stabilized = Buffer.from(mask);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let activeNeighborCount = 0;
      for (const [dx, dy] of neighbors) {
        const nIndex = (y + dy) * width + (x + dx);
        if ((mask[nIndex] ?? 0) > 0) {
          activeNeighborCount += 1;
        }
      }

      const isActive = (mask[index] ?? 0) > 0;
      if (!isActive && activeNeighborCount >= 6) {
        stabilized[index] = 255;
      } else if (isActive && activeNeighborCount <= 1) {
        stabilized[index] = 0;
      }
    }
  }

  return stabilized;
}

function computePerimeter(mask: Buffer, width: number, height: number): number {
  let perimeter = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((mask[index] ?? 0) === 0) {
        continue;
      }
      const left = x > 0 ? mask[index - 1] : 0;
      const right = x < width - 1 ? mask[index + 1] : 0;
      const top = y > 0 ? mask[index - width] : 0;
      const bottom = y < height - 1 ? mask[index + width] : 0;
      if (left === 0 || right === 0 || top === 0 || bottom === 0) {
        perimeter += 1;
      }
    }
  }
  return perimeter;
}

function computeDiagonalBridgeLength(mask: Buffer, width: number, height: number): number {
  let diagonalBridgeLength = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if ((mask[index] ?? 0) === 0) {
        continue;
      }
      const left = (mask[index - 1] ?? 0) > 0;
      const right = (mask[index + 1] ?? 0) > 0;
      const top = (mask[index - width] ?? 0) > 0;
      const bottom = (mask[index + width] ?? 0) > 0;
      const diagonal =
        (mask[index - width - 1] ?? 0) > 0
        || (mask[index - width + 1] ?? 0) > 0
        || (mask[index + width - 1] ?? 0) > 0
        || (mask[index + width + 1] ?? 0) > 0;
      const orthogonalCount = Number(left) + Number(right) + Number(top) + Number(bottom);
      if (diagonal && orthogonalCount <= 1) {
        diagonalBridgeLength += 1;
      }
    }
  }
  return diagonalBridgeLength;
}

function computeBottomBandPixelCount(mask: Buffer, width: number, height: number, startRatio = 0.62): number {
  const yStart = Math.max(0, Math.min(height - 1, Math.floor(height * startRatio)));
  let count = 0;
  for (let y = yStart; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((mask[y * width + x] ?? 0) > 0) {
        count += 1;
      }
    }
  }
  return count;
}

function applyExclusionMask(baseMask: Buffer, exclusionRaw: Buffer): { masked: Buffer; overlapPixelCount: number } {
  const masked = Buffer.alloc(baseMask.length);
  let overlapPixelCount = 0;
  for (let index = 0; index < baseMask.length; index += 1) {
    if ((baseMask[index] ?? 0) > 0 && (exclusionRaw[index] ?? 0) > 0) {
      overlapPixelCount += 1;
    }
    masked[index] = (baseMask[index] ?? 0) > 0 && (exclusionRaw[index] ?? 0) === 0 ? 255 : 0;
  }
  return {
    masked,
    overlapPixelCount,
  };
}

async function readBinaryMaskFromPath(params: {
  filePath: string;
  width: number;
  height: number;
}): Promise<Buffer | null> {
  try {
    await fs.access(params.filePath);
  } catch {
    return null;
  }

  return sharp(params.filePath)
    .removeAlpha()
    .grayscale()
    .resize(params.width, params.height, { fit: "fill", kernel: sharp.kernel.nearest })
    .threshold(127, { grayscale: true })
    .raw()
    .toBuffer();
}

async function resolveSemanticRenderSeedMask(params: {
  width: number;
  height: number;
  geminiMaskArtifacts?: CompiledMaskResult["geminiMaskArtifacts"];
  fallbackMask: Buffer;
}): Promise<{ mask: Buffer; sourceStage: string; sharpTransforms: number }> {
  const candidates: Array<{ path: string | undefined; sourceStage: string }> = [
    { path: params.geminiMaskArtifacts?.rawGeminiMaskPath, sourceStage: "raw_gemini_mask" },
    { path: params.geminiMaskArtifacts?.rawMaskPath, sourceStage: "raw_mask" },
    { path: params.geminiMaskArtifacts?.alphaNormalizedMaskPath, sourceStage: "alpha_normalized_mask" },
    { path: params.geminiMaskArtifacts?.thresholdedMaskPath, sourceStage: "thresholded_mask" },
    { path: params.geminiMaskArtifacts?.morphologyCleanedMaskPath, sourceStage: "morphology_cleaned_mask" },
    { path: params.geminiMaskArtifacts?.componentFilteredMaskPath, sourceStage: "component_filtered_mask" },
  ];

  for (const candidate of candidates) {
    if (!candidate.path) {
      continue;
    }
    const loaded = await readBinaryMaskFromPath({
      filePath: candidate.path,
      width: params.width,
      height: params.height,
    });
    if (loaded) {
      return {
        mask: loaded,
        sourceStage: candidate.sourceStage,
        sharpTransforms: 1,
      };
    }
  }

  return {
    mask: Buffer.from(params.fallbackMask),
    sourceStage: "semantic_fallback_occupancy",
    sharpTransforms: 0,
  };
}

function unionBinaryMasks(primary: Buffer, secondary: Buffer): Buffer {
  const merged = Buffer.alloc(primary.length);
  for (let i = 0; i < primary.length; i += 1) {
    merged[i] = (primary[i] ?? 0) > 0 || (secondary[i] ?? 0) > 0 ? 255 : 0;
  }
  return merged;
}

function extractClusterIdFromMaskPath(maskPath: string): string | null {
  const fileName = maskPath.split("/").pop() || "";
  const suffix = "-gemini-mask.png";
  if (!fileName.endsWith(suffix)) {
    return null;
  }
  const clusterId = fileName.slice(0, -suffix.length).trim();
  return clusterId.length > 0 ? clusterId : null;
}

async function resolveClusterRoleMap(geminiMaskArtifacts?: CompiledMaskResult["geminiMaskArtifacts"]): Promise<Map<string, boolean>> {
  const roleMap = new Map<string, boolean>();
  if (!geminiMaskArtifacts?.retryComparisonPath) {
    return roleMap;
  }

  try {
    const raw = await fs.readFile(geminiMaskArtifacts.retryComparisonPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<{ clusterId?: string; required?: boolean }>;
    for (const entry of parsed) {
      const clusterId = String(entry?.clusterId || "").trim();
      if (!clusterId) {
        continue;
      }
      if (!roleMap.has(clusterId)) {
        roleMap.set(clusterId, Boolean(entry?.required));
        continue;
      }
      roleMap.set(clusterId, roleMap.get(clusterId) === true || Boolean(entry?.required));
    }
  } catch {
    return roleMap;
  }

  return roleMap;
}

function tinySemanticCleanup(mask: Buffer, width: number, height: number): Buffer {
  const cleaned = Buffer.from(mask);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const active = (mask[index] ?? 0) > 0;
      let activeNeighborCount = 0;
      for (const [dx, dy] of neighbors) {
        const nIndex = (y + dy) * width + (x + dx);
        if ((mask[nIndex] ?? 0) > 0) {
          activeNeighborCount += 1;
        }
      }

      // Tight cleanup only: repair tiny pinholes and isolated specks.
      if (!active && activeNeighborCount >= 7) {
        cleaned[index] = 255;
      } else if (active && activeNeighborCount === 0) {
        cleaned[index] = 0;
      }
    }
  }

  return cleaned;
}

function buildMergeConflictOverlayRgba(pass1Mask: Buffer, pass2Mask: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < pass1Mask.length; i += 1) {
    const offset = i * 4;
    const inPass1 = (pass1Mask[i] ?? 0) > 0;
    const inPass2 = (pass2Mask[i] ?? 0) > 0;
    if (inPass1 && inPass2) {
      rgba[offset] = 255;
      rgba[offset + 1] = 214;
      rgba[offset + 2] = 10;
      rgba[offset + 3] = 220;
    } else if (inPass1) {
      rgba[offset] = 34;
      rgba[offset + 1] = 197;
      rgba[offset + 2] = 94;
      rgba[offset + 3] = 160;
    } else if (inPass2) {
      rgba[offset] = 59;
      rgba[offset + 1] = 130;
      rgba[offset + 2] = 246;
      rgba[offset + 3] = 160;
    }
  }
  return rgba;
}

function buildSuppressionOverlayRgba(pass2SuppressedMask: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < pass2SuppressedMask.length; i += 1) {
    if ((pass2SuppressedMask[i] ?? 0) === 0) {
      continue;
    }
    const offset = i * 4;
    rgba[offset] = 239;
    rgba[offset + 1] = 68;
    rgba[offset + 2] = 68;
    rgba[offset + 3] = 220;
  }
  return rgba;
}

function buildGroundingConfidenceOverlayRgba(params: {
  mergedMask: Buffer;
  pass1Mask: Buffer;
  pass2Mask: Buffer;
  width: number;
  height: number;
}): Buffer {
  const rgba = Buffer.alloc(params.width * params.height * 4, 0);
  const heightDenominator = Math.max(1, params.height - 1);
  for (let y = 0; y < params.height; y += 1) {
    const yNorm = y / heightDenominator;
    const groundingFactor = 0.35 + (0.65 * yNorm);
    for (let x = 0; x < params.width; x += 1) {
      const index = y * params.width + x;
      if ((params.mergedMask[index] ?? 0) === 0) {
        continue;
      }
      const offset = index * 4;
      const baseConfidence = (params.pass1Mask[index] ?? 0) > 0 ? 0.88 : ((params.pass2Mask[index] ?? 0) > 0 ? 0.68 : 0.58);
      const confidence = Math.max(0, Math.min(1, baseConfidence * groundingFactor));
      rgba[offset] = Math.round(255 * (1 - confidence));
      rgba[offset + 1] = Math.round(255 * confidence);
      rgba[offset + 2] = 32;
      rgba[offset + 3] = 210;
    }
  }
  return rgba;
}

function filterPass2BySemanticArbitration(params: {
  pass2Mask: Buffer;
  pass1Mask: Buffer;
  width: number;
  height: number;
}): {
  filteredMask: Buffer;
  suppressedMask: Buffer;
  retainedComponents: number;
  suppressedComponents: number;
} {
  const filteredMask = Buffer.alloc(params.pass2Mask.length, 0);
  const suppressedMask = Buffer.alloc(params.pass2Mask.length, 0);
  const visited = new Uint8Array(params.pass2Mask.length);
  const offsets = [-1, 1, -params.width, params.width];
  const pass1Bounds = findMaskBoundingBox(params.pass1Mask, params.width, params.height);
  const pass1Center = pass1Bounds
    ? {
      x: pass1Bounds.x + (pass1Bounds.width / 2),
      y: pass1Bounds.y + (pass1Bounds.height / 2),
    }
    : null;
  const diag = Math.sqrt((params.width * params.width) + (params.height * params.height));
  const totalPixels = Math.max(1, params.width * params.height);
  const tinyAreaThreshold = Math.max(6, Math.floor(totalPixels * 0.000006));

  let retainedComponents = 0;
  let suppressedComponents = 0;

  for (let index = 0; index < params.pass2Mask.length; index += 1) {
    if ((params.pass2Mask[index] ?? 0) === 0 || visited[index] === 1) {
      continue;
    }

    const component: number[] = [];
    const queue: number[] = [index];
    visited[index] = 1;
    let minX = params.width;
    let minY = params.height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;

    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      const x = current % params.width;
      const y = Math.floor(current / params.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;

      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= params.pass2Mask.length || visited[next] === 1 || (params.pass2Mask[next] ?? 0) === 0) {
          continue;
        }
        const nx = next % params.width;
        if (Math.abs(nx - x) > 1) {
          continue;
        }
        visited[next] = 1;
        queue.push(next);
      }
    }

    const area = component.length;
    const areaRatio = area / totalPixels;
    const centroidX = sumX / Math.max(1, area);
    const centroidY = sumY / Math.max(1, area);
    const groundingScore = maxY / Math.max(1, params.height - 1);
    const topHeavy = minY < Math.floor(params.height * 0.18);
    const compactness = area / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));

    let anchorDistanceScore = 1;
    if (pass1Center) {
      const dx = centroidX - pass1Center.x;
      const dy = centroidY - pass1Center.y;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      anchorDistanceScore = 1 - Math.max(0, Math.min(1, distance / Math.max(1, diag)));
    }

    const keep = (
      area >= tinyAreaThreshold
      && !topHeavy
      && (groundingScore >= 0.44 || areaRatio >= 0.0025)
      && (anchorDistanceScore >= 0.36 || areaRatio >= 0.004)
      && compactness >= 0.14
    );

    const target = keep ? filteredMask : suppressedMask;
    for (const pixelIndex of component) {
      target[pixelIndex] = 255;
    }
    if (keep) {
      retainedComponents += 1;
    } else {
      suppressedComponents += 1;
    }
  }

  return {
    filteredMask,
    suppressedMask,
    retainedComponents,
    suppressedComponents,
  };
}

type SemanticRenderComposition = {
  pass1Mask: Buffer;
  pass2Mask: Buffer;
  mergedMask: Buffer;
  sourceStage: string;
  passCount: number;
  repairPassCount: number;
  arbitrationSuppressedComponents: number;
  arbitrationRetainedComponents: number;
  sharpTransforms: number;
  semanticArtifacts?: CompiledMaskResult["semanticArtifacts"];
};

async function buildSemanticRenderComposition(params: {
  width: number;
  height: number;
  geminiMaskArtifacts?: CompiledMaskResult["geminiMaskArtifacts"];
  fallbackMask: Buffer;
  finalMaskPath: string;
}): Promise<SemanticRenderComposition> {
  const debugArtifactsEnabled = isContinuityDebugArtifactsEnabled();
  const semanticPass1MaskPath = deriveMaskPath(params.finalMaskPath, "semantic-pass-1-mask");
  const semanticPass2MaskPath = deriveMaskPath(params.finalMaskPath, "semantic-pass-2-mask");
  const semanticMergedMaskPath = deriveMaskPath(params.finalMaskPath, "semantic-merged-mask");
  const semanticMergeConflictsOverlayPath = deriveMaskPath(params.finalMaskPath, "semantic-merge-conflicts-overlay");
  const semanticOverlapSuppressionOverlayPath = deriveMaskPath(params.finalMaskPath, "semantic-overlap-suppression-overlay");
  const semanticGroundingConfidenceOverlayPath = deriveMaskPath(params.finalMaskPath, "semantic-grounding-confidence-overlay");

  let sharpTransforms = 0;
  const roleMap = await resolveClusterRoleMap(params.geminiMaskArtifacts);
  const pass1Mask = Buffer.alloc(params.width * params.height, 0);
  const pass2Mask = Buffer.alloc(params.width * params.height, 0);

  for (const clusterPath of params.geminiMaskArtifacts?.perClusterMaskPaths || []) {
    const clusterId = extractClusterIdFromMaskPath(clusterPath);
    if (!clusterId) {
      continue;
    }
    const clusterMask = await readBinaryMaskFromPath({
      filePath: clusterPath,
      width: params.width,
      height: params.height,
    });
    if (!clusterMask) {
      continue;
    }
    sharpTransforms += 1;
    const target = roleMap.get(clusterId) === true ? pass1Mask : pass2Mask;
    for (let i = 0; i < target.length; i += 1) {
      target[i] = (target[i] ?? 0) > 0 || (clusterMask[i] ?? 0) > 0 ? 255 : 0;
    }
  }

  let sourceStage = "semantic_cluster_composition";
  if (countWhitePixels(pass1Mask) === 0 && countWhitePixels(pass2Mask) === 0) {
    const semanticSeed = await resolveSemanticRenderSeedMask({
      width: params.width,
      height: params.height,
      geminiMaskArtifacts: params.geminiMaskArtifacts,
      fallbackMask: params.fallbackMask,
    });
    sharpTransforms += semanticSeed.sharpTransforms;
    semanticSeed.mask.copy(pass1Mask);
    sourceStage = `${semanticSeed.sourceStage}_fallback`;
  }

  const pass2Suppressed = Buffer.alloc(pass2Mask.length, 0);
  const pass2NoDup = Buffer.alloc(pass2Mask.length, 0);
  for (let i = 0; i < pass2Mask.length; i += 1) {
    if ((pass2Mask[i] ?? 0) === 0) {
      continue;
    }
    if ((pass1Mask[i] ?? 0) > 0) {
      pass2Suppressed[i] = 255;
      continue;
    }
    pass2NoDup[i] = 255;
  }

  const pass2Arbitrated = filterPass2BySemanticArbitration({
    pass2Mask: pass2NoDup,
    pass1Mask,
    width: params.width,
    height: params.height,
  });
  const tinyThreshold = Math.max(6, Math.floor((params.width * params.height) * 0.000006));
  const pass2Filtered = removeTinyConnectedComponents(pass2Arbitrated.filteredMask, params.width, params.height, tinyThreshold);
  for (let i = 0; i < pass2Suppressed.length; i += 1) {
    if ((pass2Arbitrated.suppressedMask[i] ?? 0) > 0) {
      pass2Suppressed[i] = 255;
      continue;
    }
    if ((pass2Arbitrated.filteredMask[i] ?? 0) > 0 && (pass2Filtered[i] ?? 0) === 0) {
      pass2Suppressed[i] = 255;
    }
  }

  let mergedMask = unionBinaryMasks(pass1Mask, pass2Filtered);
  mergedMask = removeTinyConnectedComponents(mergedMask, params.width, params.height, tinyThreshold);
  mergedMask = tinySemanticCleanup(mergedMask, params.width, params.height);

  let semanticArtifacts: CompiledMaskResult["semanticArtifacts"] | undefined;
  if (debugArtifactsEnabled) {
    await sharp(pass1Mask, { raw: { width: params.width, height: params.height, channels: 1 } }).png().toFile(semanticPass1MaskPath);
    await sharp(pass2Filtered, { raw: { width: params.width, height: params.height, channels: 1 } }).png().toFile(semanticPass2MaskPath);
    await sharp(mergedMask, { raw: { width: params.width, height: params.height, channels: 1 } }).png().toFile(semanticMergedMaskPath);
    await sharp(buildMergeConflictOverlayRgba(pass1Mask, pass2Filtered, params.width, params.height), {
      raw: { width: params.width, height: params.height, channels: 4 },
    }).png().toFile(semanticMergeConflictsOverlayPath);
    await sharp(buildSuppressionOverlayRgba(pass2Suppressed, params.width, params.height), {
      raw: { width: params.width, height: params.height, channels: 4 },
    }).png().toFile(semanticOverlapSuppressionOverlayPath);
    await sharp(buildGroundingConfidenceOverlayRgba({
      mergedMask,
      pass1Mask,
      pass2Mask: pass2Filtered,
      width: params.width,
      height: params.height,
    }), {
      raw: { width: params.width, height: params.height, channels: 4 },
    }).png().toFile(semanticGroundingConfidenceOverlayPath);
    semanticArtifacts = {
      semanticPass1MaskPath,
      semanticPass2MaskPath,
      semanticMergedMaskPath,
      semanticMergeConflictsOverlayPath,
      semanticOverlapSuppressionOverlayPath,
      semanticGroundingConfidenceOverlayPath,
    };
  }

  return {
    pass1Mask,
    pass2Mask: pass2Filtered,
    mergedMask,
    sourceStage,
    passCount: countWhitePixels(pass2Filtered) > 0 ? 2 : 1,
    repairPassCount: 3,
    arbitrationRetainedComponents: pass2Arbitrated.retainedComponents,
    arbitrationSuppressedComponents: pass2Arbitrated.suppressedComponents,
    sharpTransforms,
    semanticArtifacts,
  };
}

function countConnectedComponents(mask: Buffer, width: number, height: number): number {
  const visited = new Uint8Array(mask.length);
  let componentCount = 0;
  const offsets = [-1, 1, -width, width];

  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) === 0 || visited[index] === 1) {
      continue;
    }
    componentCount += 1;
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= mask.length || visited[next] === 1 || (mask[next] ?? 0) === 0) {
          continue;
        }
        const nx = next % width;
        if (Math.abs(nx - x) > 1) {
          continue;
        }
        visited[next] = 1;
        queue.push(next);
      }
    }
  }

  return componentCount;
}

function removeTinyConnectedComponents(mask: Buffer, width: number, height: number, minArea: number): Buffer {
  const filtered = Buffer.from(mask);
  const visited = new Uint8Array(mask.length);
  const offsets = [-1, 1, -width, width];

  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) === 0 || visited[index] === 1) {
      continue;
    }

    const component: number[] = [];
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= mask.length || visited[next] === 1 || (mask[next] ?? 0) === 0) {
          continue;
        }
        const nx = next % width;
        if (Math.abs(nx - x) > 1) {
          continue;
        }
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (component.length < minArea) {
      for (const pixelIndex of component) {
        filtered[pixelIndex] = 0;
      }
    }
  }

  return filtered;
}

export async function buildDeterministicPlanConstraintMask(params: {
  plan: PlacementPlan;
  secondaryImagePath: string;
  outputPath: string;
}): Promise<{ path: string; pixelCount: number; width: number; height: number }> {
  const metadata = await sharp(params.secondaryImagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for deterministic constraint mask",
      "constraint_mask_missing_dimensions"
    );
  }

  const polygons: string[] = [];
  for (const zone of params.plan.furnitureZones) {
    const projection = resolveDeterministicZoneProjection({
      plan: params.plan,
      zone,
    });
    const wallPolygon = projection.wallPolygon.length >= 3
      ? projection.wallPolygon
      : buildFallbackWallPolygon(zone);
    const floorPolygon = projection.floorPolygon.length >= 3
      ? projection.floorPolygon
      : buildFallbackFloorPolygon(zone);
    polygons.push(polygonSvg(wallPolygon, width, height));
    polygons.push(polygonSvg(floorPolygon, width, height));
  }

  if (polygons.length === 0) {
    throw new VertexSecondaryContinuityError(
      "Constraint mask builder received no projected occupancy polygons",
      "constraint_mask_empty_polygons"
    );
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#000000" />
      ${polygons.join("\n")}
    </svg>
  `;

  const rawMask = await sharp(Buffer.from(svg))
    .removeAlpha()
    .grayscale()
    .threshold(1, { grayscale: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const maskBuffer = await sharp(Buffer.from(rawMask.data), {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();

  await sharp(maskBuffer).toFile(params.outputPath);

  return {
    path: params.outputPath,
    pixelCount: countWhitePixels(rawMask.data),
    width,
    height,
  };
}

export async function compileDeterministicMask(params: {
  plan: PlacementPlan;
  secondaryImagePath: string;
  masterImagePath: string;
  occupancyMaskPath: string;
  exclusionMaskPath: string;
  finalMaskPath: string;
  occupancyConstraintMaskPath?: string;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
}): Promise<CompiledMaskResult> {
  const pipelineStartedAt = Date.now();
  let maskGenerationMs = 0;
  let topologyMs = 0;
  let morphologyMs = 0;
  let occupancyMergeMs = 0;
  let renderMaskPrepMs = 0;

  const memoryAtStart = process.memoryUsage();
  let peakExternalMb = memoryAtStart.external / (1024 * 1024);
  let peakArrayBuffersMb = memoryAtStart.arrayBuffers / (1024 * 1024);
  const updatePeakMemory = () => {
    const usage = process.memoryUsage();
    peakExternalMb = Math.max(peakExternalMb, usage.external / (1024 * 1024));
    peakArrayBuffersMb = Math.max(peakArrayBuffersMb, usage.arrayBuffers / (1024 * 1024));
  };

  nLog("[VERTEX_CONTINUITY_MASK_COMPILATION]", {
    phase: "compiler-start",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    secondaryImagePath: params.secondaryImagePath,
    occupancyConstraintMaskPath: params.occupancyConstraintMaskPath || null,
  });

  try {
  const metadata = await sharp(params.secondaryImagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for mask compilation",
      "mask_missing_dimensions"
    );
  }

  const renderMaskMode = resolveRenderMaskMode();

  let occupancyRaw: Buffer;
  let occupancyGenerationMode: CompiledMaskResult["occupancyGenerationMode"] = "polygon_projection_v1";
  let geminiMaskArtifacts: CompiledMaskResult["geminiMaskArtifacts"];

  if (useGeminiOccupancyMaskMode()) {
    const generationStartedAt = Date.now();
    const geminiMask = await generateGeminiOccupancyMask({
      secondaryImagePath: params.secondaryImagePath,
      masterImagePath: params.masterImagePath,
      plan: params.plan,
      occupancyMaskPath: params.occupancyMaskPath,
      continuityGroupId: params.continuityGroupId,
      jobId: params.jobId,
      imageId: params.imageId,
    });
    occupancyRaw = Buffer.from(geminiMask.cleanedMaskRaw);
    occupancyGenerationMode = "gemini_image_mask_v1";
    geminiMaskArtifacts = {
      rawGeminiMaskPath: geminiMask.rawGeminiMaskPath,
      thresholdedMaskPath: geminiMask.thresholdedMaskPath,
      alphaNormalizedMaskPath: geminiMask.alphaNormalizedMaskPath,
      morphologyCleanedMaskPath: geminiMask.morphologyCleanedMaskPath,
      componentFilteredMaskPath: geminiMask.componentFilteredMaskPath,
      acceptedClusterMaskPath: geminiMask.acceptedClusterMaskPath,
      finalUnionMaskPath: geminiMask.finalUnionMaskPath,
      semanticPass1MaskPath: geminiMask.semanticPass1MaskPath,
      semanticPass2MaskPath: geminiMask.semanticPass2MaskPath,
      semanticMergedMaskPath: geminiMask.semanticMergedMaskPath,
      occupancyCollapseAnalysisPath: geminiMask.occupancyCollapseAnalysisPath,
      occupancyStageGridPath: geminiMask.occupancyStageGridPath,
      componentAnalysisPath: geminiMask.componentAnalysisPath,
      componentRetainedPath: geminiMask.componentRetainedPath,
      componentRemovedPath: geminiMask.componentRemovedPath,
      alphaHeatmapPath: geminiMask.alphaHeatmapPath,
      alphaHistogramPath: geminiMask.alphaHistogramPath,
      occupancyMetricDebugPath: geminiMask.occupancyMetricDebugPath,
      thresholdComparisonPath: geminiMask.thresholdComparisonPath,
      stageComparisonPath: geminiMask.stageComparisonPath,
      measurementStage: geminiMask.measurementStage,
      alphaAware: geminiMask.alphaAware,
      measurementThreshold: geminiMask.measurementThreshold,
      normalizationWidth: geminiMask.normalizationWidth,
      normalizationHeight: geminiMask.normalizationHeight,
      normalizationSource: geminiMask.normalizationSource,
      rawMaskPath: geminiMask.rawMaskPath,
      cleanedMaskPath: geminiMask.cleanedMaskPath,
      componentsPath: geminiMask.componentsPath,
      qualityReportPath: geminiMask.qualityReportPath,
      retryComparisonPath: geminiMask.retryComparisonPath,
      anchorDistanceHeatmapPath: geminiMask.anchorDistanceHeatmapPath,
      floorContactVisualizationPath: geminiMask.floorContactVisualizationPath,
      acceptedRejectedOverlayPath: geminiMask.acceptedRejectedOverlayPath,
      perClusterMaskPaths: geminiMask.perClusterMaskPaths,
      usedConservativeFallback: geminiMask.usedConservativeFallback,
      retryCount: geminiMask.retryCount,
      clusterCount: geminiMask.clusterCount,
      requiredClusterCount: geminiMask.requiredClusterCount,
      optionalClusterCount: geminiMask.optionalClusterCount,
      clusterApiCallCount: geminiMask.clusterApiCallCount,
      estimatedCallReductionRatio: geminiMask.estimatedCallReductionRatio,
      qualityScore: geminiMask.qualityScore,
      model: geminiMask.model,
      latencyMs: geminiMask.latencyMs,
      occupancyAreaRatio: geminiMask.safety.occupancyAreaRatio,
      connectedComponentCount: geminiMask.safety.connectedComponentCount,
      floorContactRatio: geminiMask.safety.floorContactRatio,
      anchorProximityScore: geminiMask.safety.anchorProximityScore,
      topRegionOccupancyRatio: geminiMask.safety.topRegionOccupancyRatio,
      wallTouchOccupancyRatio: geminiMask.safety.wallTouchOccupancyRatio,
    };
    maskGenerationMs = Date.now() - generationStartedAt;
  } else {
    const generationStartedAt = Date.now();
    const polygons: string[] = [];
    for (const zone of params.plan.furnitureZones) {
      const projection = resolveDeterministicZoneProjection({
        plan: params.plan,
        zone,
      });
      const wallPolygon = projection.wallPolygon.length >= 3
        ? projection.wallPolygon
        : buildFallbackWallPolygon(zone);
      const floorPolygon = projection.floorPolygon.length >= 3
        ? projection.floorPolygon
        : buildFallbackFloorPolygon(zone);
      polygons.push(polygonSvg(wallPolygon, width, height));
      polygons.push(polygonSvg(floorPolygon, width, height));
    }

    if (polygons.length === 0) {
      throw new VertexSecondaryContinuityError(
        "Mask compiler received no projected occupancy polygons",
        "mask_empty_polygons"
      );
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#000000" />
        ${polygons.join("\n")}
      </svg>
    `;

    const occupancyRaster = await sharp(Buffer.from(svg))
      .removeAlpha()
      .grayscale()
      .threshold(1, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    occupancyRaw = Buffer.from(occupancyRaster.data);
    maskGenerationMs = Date.now() - generationStartedAt;
  }
  updatePeakMemory();

  const semanticOccupancyRaw = Buffer.from(occupancyRaw);

  let occupancyConstraintApplied = false;
  let occupancyConstraintPixelCount = 0;
  if (params.occupancyConstraintMaskPath) {
    occupancyConstraintApplied = true;
    const constraintRaw = await sharp(params.occupancyConstraintMaskPath)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    occupancyConstraintPixelCount = countWhitePixels(constraintRaw.data);
    for (let index = 0; index < occupancyRaw.length; index += 1) {
      occupancyRaw[index] = occupancyRaw[index] > 0 && (constraintRaw.data[index] ?? 0) > 0 ? 255 : 0;
    }
  }
  updatePeakMemory();

  const occupancyMaskBuffer = await sharp(occupancyRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  await sharp(occupancyMaskBuffer).toFile(params.occupancyMaskPath);

  const occupancyPixelCount = countWhitePixels(occupancyRaw);

  const exclusionMask = await buildArchitecturalExclusionMask({
    secondaryImagePath: params.secondaryImagePath,
    exclusionMaskPath: params.exclusionMaskPath,
    continuityGroupId: params.continuityGroupId,
    jobId: params.jobId,
    imageId: params.imageId,
  });
  const exclusionRaw = await sharp(exclusionMask.maskBuffer)
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();

  const continuityReasoningMask = applyExclusionMask(occupancyRaw, exclusionRaw);
  const continuityReasoningRaw = continuityReasoningMask.masked;
  const continuityReasoningPixelCount = countWhitePixels(continuityReasoningRaw);

  const renderMaskPrepStartedAt = Date.now();
  let renderMaskSourceStage = "legacy_continuity_reasoning";
  let semanticConnectedComponentCount = countConnectedComponents(continuityReasoningRaw, width, height);
  let sharpTransformsFromSemanticSeed = 0;
  let semanticPassCount = 1;
  let occupancyRepairPassCount = 0;
  let semanticArtifacts: CompiledMaskResult["semanticArtifacts"];
  let semanticArbitrationSuppressedComponents = 0;
  let semanticArbitrationRetainedComponents = 0;
  const semanticBase = Buffer.from(occupancyRaw);

  if (renderMaskMode === "semantic_tight") {
    const occupancyMergeStartedAt = Date.now();
    const semanticComposition = await buildSemanticRenderComposition({
      width,
      height,
      geminiMaskArtifacts,
      fallbackMask: semanticOccupancyRaw,
      finalMaskPath: params.finalMaskPath,
    });
    occupancyMergeMs = Date.now() - occupancyMergeStartedAt;
    sharpTransformsFromSemanticSeed = semanticComposition.sharpTransforms;
    renderMaskSourceStage = semanticComposition.sourceStage;
    semanticConnectedComponentCount = countConnectedComponents(semanticComposition.mergedMask, width, height);
    semanticPassCount = semanticComposition.passCount;
    occupancyRepairPassCount = semanticComposition.repairPassCount;
    semanticArbitrationSuppressedComponents = semanticComposition.arbitrationSuppressedComponents;
    semanticArbitrationRetainedComponents = semanticComposition.arbitrationRetainedComponents;
    semanticArtifacts = semanticComposition.semanticArtifacts;

    semanticComposition.mergedMask.copy(semanticBase);
  }

  const semanticMergedPixelCount = countWhitePixels(semanticBase);
  const renderEditMasked = applyExclusionMask(semanticBase, exclusionRaw);
  const renderEditMaskedPixelCount = countWhitePixels(renderEditMasked.masked);
  const renderExclusionClipLossRatio = semanticMergedPixelCount > 0
    ? Math.max(0, (semanticMergedPixelCount - renderEditMaskedPixelCount) / semanticMergedPixelCount)
    : 0;
  const renderExclusionRetainedRatio = semanticMergedPixelCount > 0
    ? renderEditMaskedPixelCount / semanticMergedPixelCount
    : 1;
  const exclusionMaxClipRatio = Math.max(0, Math.min(0.95, Number(process.env.CONTINUITY_RENDER_EXCLUSION_MAX_CLIP_RATIO || 0.22)));
  const exclusionMinRetainedRatio = Math.max(0.05, Math.min(1, Number(process.env.CONTINUITY_RENDER_EXCLUSION_MIN_RETAINED_RATIO || 0.72)));
  const exclusionGuardTriggered = (
    renderMaskMode === "semantic_tight"
    && isRenderExclusionClipGuardEnabled()
    && semanticMergedPixelCount > 0
    && (
      renderExclusionClipLossRatio > exclusionMaxClipRatio
      || renderExclusionRetainedRatio < exclusionMinRetainedRatio
    )
  );
  const renderEditRaw = renderMaskMode === "legacy"
    ? Buffer.from(continuityReasoningRaw)
    : (exclusionGuardTriggered ? Buffer.from(semanticBase) : renderEditMasked.masked);
  if (exclusionGuardTriggered) {
    renderMaskSourceStage = `${renderMaskSourceStage}_exclusion_guard_bypass`;
  }
  renderMaskPrepMs = Date.now() - renderMaskPrepStartedAt;
  updatePeakMemory();

  const renderEditMaskPath = deriveMaskPath(params.finalMaskPath, "render-edit-mask");
  const continuityReasoningMaskPath = deriveMaskPath(params.finalMaskPath, "continuity-reasoning-mask");

  const finalRaw = Buffer.from(continuityReasoningRaw);
  const overlapPixelCount = continuityReasoningMask.overlapPixelCount;
  const finalPixelCount = countWhitePixels(finalRaw);
  const renderEditMaskPixelCount = countWhitePixels(renderEditRaw);
  const totalPixelCount = width * height;
  const occupancyAreaRatio = occupancyPixelCount / totalPixelCount;
  const exclusionAreaRatio = exclusionMask.protectedPixelCount / totalPixelCount;
  const finalAreaRatio = finalPixelCount / totalPixelCount;
  const continuityReasoningMaskAreaRatio = continuityReasoningPixelCount / totalPixelCount;
  const renderEditMaskAreaRatio = renderEditMaskPixelCount / totalPixelCount;
  const overlapReductionRatio = occupancyPixelCount > 0
    ? overlapPixelCount / occupancyPixelCount
    : 1;
  const insertionBounds = findMaskBoundingBox(finalRaw, width, height);
  const continuityReasoningMaskBounds = findMaskBoundingBox(continuityReasoningRaw, width, height);
  const renderEditMaskBounds = findMaskBoundingBox(renderEditRaw, width, height);
  const continuityReasoningFloorPixels = computeBottomBandPixelCount(continuityReasoningRaw, width, height);
  const renderEditFloorPixels = computeBottomBandPixelCount(renderEditRaw, width, height);
  const floorCoverageRatio = continuityReasoningPixelCount > 0
    ? continuityReasoningFloorPixels / continuityReasoningPixelCount
    : 0;
  const editableFloorRatio = continuityReasoningFloorPixels > 0
    ? renderEditFloorPixels / continuityReasoningFloorPixels
    : 0;
  const supportCoverageRatio = continuityReasoningPixelCount > 0
    ? Math.max(0, continuityReasoningPixelCount - renderEditMaskPixelCount) / continuityReasoningPixelCount
    : 0;
  const renderEditPerimeter = computePerimeter(renderEditRaw, width, height);
  const occupancyCompactness = (() => {
    if (!renderEditMaskBounds || renderEditMaskPixelCount <= 0) {
      return 0;
    }
    const boxArea = Math.max(1, renderEditMaskBounds.width * renderEditMaskBounds.height);
    return renderEditMaskPixelCount / boxArea;
  })();
  const occupancyPerimeterComplexity = renderEditMaskPixelCount > 0
    ? renderEditPerimeter / Math.sqrt(renderEditMaskPixelCount)
    : 0;
  const diagonalBridgeLength = computeDiagonalBridgeLength(renderEditRaw, width, height);
  updatePeakMemory();

  const renderEditMaskBuffer = await sharp(renderEditRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  const continuityReasoningMaskBuffer = await sharp(continuityReasoningRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  const finalMaskBuffer = await sharp(finalRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  await sharp(renderEditMaskBuffer).toFile(renderEditMaskPath);
  await sharp(continuityReasoningMaskBuffer).toFile(continuityReasoningMaskPath);
  await sharp(finalMaskBuffer).toFile(params.finalMaskPath);

  nLog("[VERTEX_CONTINUITY_MASK]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    width,
    height,
    zoneCount: params.plan.furnitureZones.length,
    occupancyMaskPath: params.occupancyMaskPath,
  });

  nLog("[VERTEX_CONTINUITY_MASKS]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    width,
    height,
    zoneCount: params.plan.furnitureZones.length,
    occupancyPixelCount,
    exclusionPixelCount: exclusionMask.protectedPixelCount,
    finalPixelCount,
    occupancyAreaRatio: Number(occupancyAreaRatio.toFixed(4)),
    exclusionAreaRatio: Number(exclusionAreaRatio.toFixed(4)),
    finalAreaRatio: Number(finalAreaRatio.toFixed(4)),
    occupancyConstraintApplied,
    occupancyConstraintPixelCount,
    occupancyGenerationMode,
    renderMaskMode,
    semanticMergedPixelCount,
    renderEditMaskedPixelCount,
    renderExclusionClipLossRatio: Number(renderExclusionClipLossRatio.toFixed(6)),
    renderExclusionRetainedRatio: Number(renderExclusionRetainedRatio.toFixed(6)),
    exclusionGuardTriggered,
    semanticArbitrationSuppressedComponents,
    semanticArbitrationRetainedComponents,
    semanticPassCount,
    occupancyMergeMs,
    occupancyRepairPassCount,
    renderEditMaskPixelCount,
    continuityReasoningMaskPixelCount: continuityReasoningPixelCount,
    geminiMaskModel: geminiMaskArtifacts?.model || null,
    protectedEdgeStats: exclusionMask.protectedEdgeStats,
  });

  nLog("[CONTINUITY_FINAL_MASK]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    maskDimensions: `${width}x${height}`,
    occupancyPixelCount,
    exclusionPixelCount: exclusionMask.protectedPixelCount,
    finalPixelCount,
    overlapPixelCount,
    occupancyAreaRatio: Number(occupancyAreaRatio.toFixed(4)),
    exclusionAreaRatio: Number(exclusionAreaRatio.toFixed(4)),
    finalAreaRatio: Number(finalAreaRatio.toFixed(4)),
    overlapReductionRatio: Number(overlapReductionRatio.toFixed(4)),
    insertionBounds,
    occupancyGenerationMode,
    artifactPath: params.finalMaskPath,
    renderEditMaskPath,
    continuityReasoningMaskPath,
    renderMaskSourceStage,
    semanticMergedPixelCount,
    renderEditMaskedPixelCount,
    renderExclusionClipLossRatio: Number(renderExclusionClipLossRatio.toFixed(6)),
    renderExclusionRetainedRatio: Number(renderExclusionRetainedRatio.toFixed(6)),
    exclusionGuardTriggered,
    semanticPass1MaskPath: semanticArtifacts?.semanticPass1MaskPath || null,
    semanticPass2MaskPath: semanticArtifacts?.semanticPass2MaskPath || null,
    semanticMergedMaskPath: semanticArtifacts?.semanticMergedMaskPath || null,
  });

  nLog("[RENDER_MASK_LINEAGE_AUDIT]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    renderMaskMode,
    renderEditMaskLineage: renderMaskMode === "legacy"
      ? ["continuity_reasoning_mask"]
      : [
        "semantic_pass_1",
        "semantic_pass_2",
        "semantic_merge_arbitration",
        exclusionGuardTriggered ? "exclusion_guard_bypass" : "architectural_exclusion_intersection",
      ],
    continuityReasoningMaskLineage: [
      "occupancy_base",
      "architectural_exclusion_intersection",
      "support_legality_reasoning",
    ],
    renderMaskAppliedSupportGeometry: false,
    renderMaskAppliedTopologyInflation: false,
    renderMaskAppliedLegalityPropagation: false,
    renderMaskAppliedFloorProjectionExpansion: false,
    renderMaskIntersectionCount: renderMaskMode === "legacy" ? 0 : 1,
    renderMaskIntersectionType: renderMaskMode === "legacy"
      ? "none"
      : (exclusionGuardTriggered ? "guarded_bypass" : "semantic_and_exclusion"),
    exclusionGuardTriggered,
    semanticArbitrationSuppressedComponents,
    semanticArbitrationRetainedComponents,
  });

  const intermediateMaskCount = renderMaskMode === "semantic_tight" ? 10 : 5;
  const sharpTransformCount = (
    11
    + sharpTransformsFromSemanticSeed
    + (params.occupancyConstraintMaskPath ? 1 : 0)
    + (useGeminiOccupancyMaskMode() ? 0 : 1)
  );

  nLog("[CONTINUITY_MASK_PIPELINE_PERF]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    renderMaskMode,
    maskGenerationMs,
    topologyMs,
    morphologyMs,
    semanticPassCount,
    occupancyMergeMs,
    renderMaskPrepMs,
    occupancyRepairPassCount,
    peakExternalMb: Number(peakExternalMb.toFixed(2)),
    peakArrayBuffersMb: Number(peakArrayBuffersMb.toFixed(2)),
    sharpTransformCount,
    intermediateMaskCount,
    totalMaskPipelineMs: Date.now() - pipelineStartedAt,
  });

  nLog("[VERTEX_CONTINUITY_MASK_COMPILATION]", {
    phase: "compiler-complete",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    width,
    height,
    finalMaskPath: params.finalMaskPath,
    occupancyConstraintApplied: !!params.occupancyConstraintMaskPath,
    occupancyGenerationMode,
    finalPixelCount,
    renderMaskMode,
    semanticPassCount,
    occupancyMergeMs,
    occupancyRepairPassCount,
    renderEditMaskPixelCount,
    continuityReasoningMaskPixelCount: continuityReasoningPixelCount,
  });

  return {
    renderMaskMode,
    renderMaskSourceStage,
    semanticPassCount,
    occupancyMergeMs,
    occupancyRepairPassCount,
    occupancyMaskBuffer,
    occupancyMaskPath: params.occupancyMaskPath,
    occupancyGenerationMode,
    exclusionMaskBuffer: exclusionMask.maskBuffer,
    exclusionMaskPath: params.exclusionMaskPath,
    renderEditMaskBuffer,
    renderEditMaskPath,
    renderEditMaskPixelCount,
    renderEditMaskAreaRatio,
    renderEditMaskBounds,
    continuityReasoningMaskBuffer,
    continuityReasoningMaskPath,
    continuityReasoningMaskPixelCount: continuityReasoningPixelCount,
    continuityReasoningMaskAreaRatio,
    continuityReasoningMaskBounds,
    semanticArtifacts,
    maskComparisonMetrics: {
      floorCoverageRatio,
      supportCoverageRatio,
      editableFloorRatio,
      occupancyCompactness,
      occupancyPerimeterComplexity,
      diagonalBridgeLength,
      connectedComponentCount: semanticConnectedComponentCount,
    },
    finalMaskBuffer,
    finalMaskPath: params.finalMaskPath,
    width,
    height,
    zoneCount: params.plan.furnitureZones.length,
    totalPixelCount,
    occupancyPixelCount,
    exclusionPixelCount: exclusionMask.protectedPixelCount,
    finalPixelCount,
    overlapPixelCount,
    occupancyAreaRatio,
    exclusionAreaRatio,
    finalAreaRatio,
    overlapReductionRatio,
    insertionBounds,
    protectedEdgeStats: exclusionMask.protectedEdgeStats,
    geminiMaskArtifacts,
  };
  } catch (error: any) {
    nLog("[VERTEX_CONTINUITY_MASK_COMPILATION]", {
      phase: "compiler-failure",
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      secondaryImagePath: params.secondaryImagePath,
      occupancyConstraintMaskPath: params.occupancyConstraintMaskPath || null,
      error: error?.message || String(error),
      stack: error instanceof Error ? error.stack || null : null,
    });
    throw error;
  }
}