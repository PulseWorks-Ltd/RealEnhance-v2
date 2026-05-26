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
  } else {
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
  }

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

  const semanticBase = renderMaskMode === "semantic_tight"
    ? conservativeSemanticStabilization(semanticOccupancyRaw, width, height)
    : Buffer.from(occupancyRaw);
  const renderEditMasked = applyExclusionMask(semanticBase, exclusionRaw);
  const renderEditRaw = renderMaskMode === "legacy"
    ? Buffer.from(continuityReasoningRaw)
    : renderEditMasked.masked;

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
    renderEditMaskPixelCount,
    continuityReasoningMaskPixelCount: continuityReasoningPixelCount,
  });

  return {
    renderMaskMode,
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
    maskComparisonMetrics: {
      floorCoverageRatio,
      supportCoverageRatio,
      editableFloorRatio,
      occupancyCompactness,
      occupancyPerimeterComplexity,
      diagonalBridgeLength,
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