import sharp from "sharp";
import { nLog } from "../logger";
import type { CompiledMaskResult, NormalizedPoint, PlacementPlan } from "./types";
import { VertexSecondaryContinuityError } from "./types";
import { buildArchitecturalExclusionMask } from "./exclusionMask";

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

export async function compileDeterministicMask(params: {
  plan: PlacementPlan;
  secondaryImagePath: string;
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

  const polygons: string[] = [];
  for (const zone of params.plan.furnitureZones) {
    const wallPolygon = zone.maskProjection.wallProjectionPolygon.length >= 3
      ? zone.maskProjection.wallProjectionPolygon
      : buildFallbackWallPolygon(zone);
    const floorPolygon = zone.maskProjection.floorPolygon.length >= 3
      ? zone.maskProjection.floorPolygon
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
  let occupancyRaw = Buffer.from(occupancyRaster.data);

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
  const exclusionRaw = await sharp(exclusionMask.maskBuffer).raw().toBuffer();

  const finalRaw = Buffer.alloc(width * height);
  let overlapPixelCount = 0;
  for (let index = 0; index < finalRaw.length; index += 1) {
    if (occupancyRaw[index] > 0 && exclusionRaw[index] > 0) {
      overlapPixelCount += 1;
    }
    finalRaw[index] = occupancyRaw[index] > 0 && exclusionRaw[index] === 0 ? 255 : 0;
  }
  const finalPixelCount = countWhitePixels(finalRaw);
  const totalPixelCount = width * height;
  const occupancyAreaRatio = occupancyPixelCount / totalPixelCount;
  const exclusionAreaRatio = exclusionMask.protectedPixelCount / totalPixelCount;
  const finalAreaRatio = finalPixelCount / totalPixelCount;
  const overlapReductionRatio = occupancyPixelCount > 0
    ? overlapPixelCount / occupancyPixelCount
    : 1;
  const insertionBounds = findMaskBoundingBox(finalRaw, width, height);
  const finalMaskBuffer = await sharp(finalRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
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
    artifactPath: params.finalMaskPath,
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
    finalPixelCount,
  });

  return {
    occupancyMaskBuffer,
    occupancyMaskPath: params.occupancyMaskPath,
    exclusionMaskBuffer: exclusionMask.maskBuffer,
    exclusionMaskPath: params.exclusionMaskPath,
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