import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import type { CompiledMaskResult, NormalizedPoint, PlacementPlan } from "../types";
import { resolveDeterministicZoneProjection } from "../deterministicProjection";

type OverlayColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

export type ContinuityDebugArtifacts = {
  occupancyOverlayPath: string;
  exclusionOverlayPath: string;
  finalMaskOverlayPath: string;
  renderBoundaryPreviewPath: string;
  insertionRegionPreviewPath: string;
  topologyOverlayPath: string;
  zoneArtifactDir: string;
  zoneManifestPath: string;
};

type ZoneArtifactEntry = {
  zoneId: string;
  furnitureType: string;
  masterFurnitureId: string | null;
  normalizedBoundingBox: PlacementPlan["furnitureZones"][number]["normalizedBoundingBox"];
  anchorPoint: NormalizedPoint;
  floorPolygonPointCount: number;
  wallPolygonPointCount: number;
  plannerFloorPolygonPointCount: number;
  plannerWallPolygonPointCount: number;
  occupancyPixelCount: number;
  finalPixelCount: number;
  projectedOverlayPath: string;
  occupancyMaskPath: string;
  finalMaskPath: string;
  notes: string[];
};

function maskToOverlay(mask: Buffer, width: number, height: number, color: OverlayColor): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const alpha = mask[index] > 0 ? color.alpha : 0;
    const offset = index * 4;
    rgba[offset] = color.red;
    rgba[offset + 1] = color.green;
    rgba[offset + 2] = color.blue;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

function buildBoundaryMask(mask: Buffer, width: number, height: number): Buffer {
  const boundary = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) {
        continue;
      }
      const neighbors = [
        x > 0 ? mask[index - 1] : 0,
        x < width - 1 ? mask[index + 1] : 0,
        y > 0 ? mask[index - width] : 0,
        y < height - 1 ? mask[index + width] : 0,
      ];
      if (neighbors.some((value) => value === 0)) {
        boundary[index] = 255;
      }
    }
  }
  return boundary;
}

function toPixelPoint(point: NormalizedPoint, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(width - 1, Math.round(point.x * width))),
    y: Math.max(0, Math.min(height - 1, Math.round(point.y * height))),
  };
}

function polygonPointsAttribute(points: NormalizedPoint[], width: number, height: number): string {
  return points
    .map((point) => {
      const pixel = toPixelPoint(point, width, height);
      return `${pixel.x},${pixel.y}`;
    })
    .join(" ");
}

function clampBox(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function buildZoneProjectionSvg(params: {
  zone: PlacementPlan["furnitureZones"][number];
  plan: PlacementPlan;
  width: number;
  height: number;
}): string {
  const bbox = params.zone.normalizedBoundingBox;
  const x = clampBox(Math.round(bbox.x * params.width), params.width - 1);
  const y = clampBox(Math.round(bbox.y * params.height), params.height - 1);
  const rectWidth = Math.max(1, Math.min(params.width - x, Math.round(bbox.width * params.width)));
  const rectHeight = Math.max(1, Math.min(params.height - y, Math.round(bbox.height * params.height)));
  const deterministicProjection = resolveDeterministicZoneProjection({
    plan: params.plan,
    zone: params.zone,
  });
  const floorPolygon = deterministicProjection.floorPolygon;
  const wallPolygon = deterministicProjection.wallPolygon;
  const plannerFloorPolygon = deterministicProjection.plannerFloorPolygon;
  const plannerWallPolygon = deterministicProjection.plannerWallPolygon;
  const floorPoints = floorPolygon.length >= 3
    ? polygonPointsAttribute(floorPolygon, params.width, params.height)
    : "";
  const wallPoints = wallPolygon.length >= 3
    ? polygonPointsAttribute(wallPolygon, params.width, params.height)
    : "";
  const plannerFloorPoints = plannerFloorPolygon.length >= 3
    ? polygonPointsAttribute(plannerFloorPolygon, params.width, params.height)
    : "";
  const plannerWallPoints = plannerWallPolygon.length >= 3
    ? polygonPointsAttribute(plannerWallPolygon, params.width, params.height)
    : "";
  const anchorPoint = toPixelPoint(deterministicProjection.anchorPoint, params.width, params.height);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">
      ${plannerWallPoints ? `<polygon points="${plannerWallPoints}" fill="none" stroke="rgba(255,159,67,0.72)" stroke-width="2" stroke-dasharray="8 6" />` : ""}
      ${plannerFloorPoints ? `<polygon points="${plannerFloorPoints}" fill="none" stroke="rgba(54,162,235,0.72)" stroke-width="2" stroke-dasharray="8 6" />` : ""}
      ${wallPoints ? `<polygon points="${wallPoints}" fill="rgba(255,99,132,0.18)" stroke="rgba(255,99,132,0.96)" stroke-width="3" />` : ""}
      ${floorPoints ? `<polygon points="${floorPoints}" fill="rgba(75,192,192,0.22)" stroke="rgba(75,192,192,0.98)" stroke-width="3" />` : ""}
      <rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2" stroke-dasharray="8 6" />
      <circle cx="${anchorPoint.x}" cy="${anchorPoint.y}" r="5" fill="rgba(255,255,255,0.98)" stroke="rgba(0,0,0,0.65)" stroke-width="2" />
    </svg>
  `;
}

function countWhitePixels(mask: Buffer): number {
  let count = 0;
  for (const value of mask) {
    if (value > 0) {
      count += 1;
    }
  }
  return count;
}

async function rasterizeZoneMask(params: {
  zone: PlacementPlan["furnitureZones"][number];
  plan: PlacementPlan;
  width: number;
  height: number;
}): Promise<Buffer> {
  const projection = resolveDeterministicZoneProjection({
    plan: params.plan,
    zone: params.zone,
  });
  const floorPolygon = projection.floorPolygon;
  const wallPolygon = projection.wallPolygon;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">
      <rect width="100%" height="100%" fill="#000000" />
      ${wallPolygon.length >= 3 ? `<polygon points="${polygonPointsAttribute(wallPolygon, params.width, params.height)}" fill="#ffffff" />` : ""}
      ${floorPolygon.length >= 3 ? `<polygon points="${polygonPointsAttribute(floorPolygon, params.width, params.height)}" fill="#ffffff" />` : ""}
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .removeAlpha()
    .grayscale()
    .threshold(1, { grayscale: true })
    .raw()
    .toBuffer();
}

function applyExclusionMask(zoneMask: Buffer, exclusionMask: Buffer): Buffer {
  const finalMask = Buffer.alloc(zoneMask.length, 0);
  for (let index = 0; index < zoneMask.length; index += 1) {
    finalMask[index] = zoneMask[index] > 0 && exclusionMask[index] === 0 ? 255 : 0;
  }
  return finalMask;
}

async function writeRawMask(mask: Buffer, width: number, height: number, outputPath: string): Promise<void> {
  await sharp(mask, {
    raw: { width, height, channels: 1 },
  }).png().toFile(outputPath);
}

async function writeSvgComposite(baseImagePath: string, svg: string, outputPath: string): Promise<void> {
  await sharp(baseImagePath)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .png()
    .toFile(outputPath);
}

async function writeZoneArtifacts(params: {
  sourceImagePath: string;
  zoneArtifactDir: string;
  width: number;
  height: number;
  plan: PlacementPlan;
  exclusionRaw: Buffer;
}): Promise<{ zoneArtifactDir: string; zoneManifestPath: string }> {
  await fs.mkdir(params.zoneArtifactDir, { recursive: true });

  const zoneEntries: ZoneArtifactEntry[] = [];
  for (const zone of params.plan.furnitureZones) {
    const baseName = zone.id.replace(/[^a-zA-Z0-9._-]+/g, "-") || "zone";
    const projectedOverlayPath = path.join(params.zoneArtifactDir, `${baseName}-projected-overlay.png`);
    const occupancyMaskPath = path.join(params.zoneArtifactDir, `${baseName}-occupancy-mask.png`);
    const finalMaskPath = path.join(params.zoneArtifactDir, `${baseName}-final-mask.png`);

      const projection = resolveDeterministicZoneProjection({
        plan: params.plan,
        zone,
      });

      const zoneProjectionSvg = buildZoneProjectionSvg({
      zone,
        plan: params.plan,
      width: params.width,
      height: params.height,
    });
    await writeSvgComposite(params.sourceImagePath, zoneProjectionSvg, projectedOverlayPath);

    const zoneOccupancyRaw = await rasterizeZoneMask({
      zone,
        plan: params.plan,
      width: params.width,
      height: params.height,
    });
    await writeRawMask(zoneOccupancyRaw, params.width, params.height, occupancyMaskPath);

    const zoneFinalRaw = applyExclusionMask(zoneOccupancyRaw, params.exclusionRaw);
    await writeRawMask(zoneFinalRaw, params.width, params.height, finalMaskPath);

    const notes: string[] = [];
    if (!zone.continuityReference.masterFurnitureId) {
      notes.push("No numeric master-region coordinates exist; only masterFurnitureId continuity label is available.");
    }
    if (zone.maskProjection.floorPolygon.length < 3) {
      notes.push("Floor polygon missing or degenerate.");
    }
    if (zone.maskProjection.wallProjectionPolygon.length < 3) {
      notes.push("Wall polygon missing or degenerate.");
    }

    zoneEntries.push({
      zoneId: zone.id,
      furnitureType: zone.furnitureType,
      masterFurnitureId: zone.continuityReference.masterFurnitureId || null,
      normalizedBoundingBox: zone.normalizedBoundingBox,
        anchorPoint: projection.anchorPoint,
        floorPolygonPointCount: projection.floorPolygon.length,
        wallPolygonPointCount: projection.wallPolygon.length,
        plannerFloorPolygonPointCount: projection.plannerFloorPolygon.length,
        plannerWallPolygonPointCount: projection.plannerWallPolygon.length,
      occupancyPixelCount: countWhitePixels(zoneOccupancyRaw),
      finalPixelCount: countWhitePixels(zoneFinalRaw),
      projectedOverlayPath,
      occupancyMaskPath,
      finalMaskPath,
      notes,
    });
  }

  const zoneManifestPath = path.join(params.zoneArtifactDir, "zone-projection-manifest.json");
  await fs.writeFile(zoneManifestPath, JSON.stringify({
    summary: {
      zoneCount: zoneEntries.length,
      coordinateSpace: "planner-provided normalized secondary-image coordinates",
      masterRegionCoordinatesAvailable: false,
        geometrySource: "deterministic_bbox_topology_v1",
    },
    zones: zoneEntries,
  }, null, 2));

  return {
    zoneArtifactDir: params.zoneArtifactDir,
    zoneManifestPath,
  };
}

async function writeTopologyOverlay(params: {
  sourceImagePath: string;
  outputPath: string;
  width: number;
  height: number;
  plan: PlacementPlan;
}): Promise<void> {
  const cage = params.plan.structuralTopologyCage;
  if (!cage) {
    await sharp(params.sourceImagePath).png().toFile(params.outputPath);
    return;
  }

  const planeSvg = (cage.majorRoomPlanes || []).map((plane) => {
    if (!plane.polygon || plane.polygon.length < 3) return "";
    return `<polygon points="${polygonPointsAttribute(plane.polygon, params.width, params.height)}" fill="rgba(255,206,86,0.10)" stroke="rgba(255,206,86,0.88)" stroke-width="2" />`;
  }).join("\n");
  const junctionSvg = [...(cage.floorWallJunctions || []), ...(cage.ceilingWallJunctions || [])]
    .map((point) => {
      const pixel = toPixelPoint(point, params.width, params.height);
      return `<circle cx="${pixel.x}" cy="${pixel.y}" r="4" fill="rgba(255,99,132,0.92)" />`;
    })
    .join("\n");
  const vanishingSvg = (cage.vanishingPoints || []).map((point) => {
    const pixel = toPixelPoint(point, params.width, params.height);
    return `<g><circle cx="${pixel.x}" cy="${pixel.y}" r="6" fill="rgba(75,192,192,0.96)" /><circle cx="${pixel.x}" cy="${pixel.y}" r="18" fill="none" stroke="rgba(75,192,192,0.7)" stroke-width="2" /></g>`;
  }).join("\n");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}">
      ${planeSvg}
      ${junctionSvg}
      ${vanishingSvg}
    </svg>
  `;
  await writeSvgComposite(params.sourceImagePath, svg, params.outputPath);
}

async function writeComposite(baseImagePath: string, overlays: Buffer[], width: number, height: number, outputPath: string): Promise<void> {
  const composite = overlays.map((overlay) => ({
    input: overlay,
    raw: { width, height, channels: 4 as const },
    blend: "over" as const,
  }));
  await sharp(baseImagePath).composite(composite).png().toFile(outputPath);
}

export async function generateContinuityDebugArtifacts(params: {
  sourceImagePath: string;
  artifactDir: string;
  masks: CompiledMaskResult;
  plan: PlacementPlan;
}): Promise<ContinuityDebugArtifacts> {
  await fs.mkdir(params.artifactDir, { recursive: true });

  const occupancyRaw = await sharp(params.masks.occupancyMaskBuffer).raw().toBuffer();
  const exclusionRaw = await sharp(params.masks.exclusionMaskBuffer).raw().toBuffer();
  const finalRaw = await sharp(params.masks.finalMaskBuffer).raw().toBuffer();
  const width = params.masks.width;
  const height = params.masks.height;

  const occupancyOverlayPath = path.join(params.artifactDir, "occupancy-overlay.png");
  const exclusionOverlayPath = path.join(params.artifactDir, "exclusion-overlay.png");
  const finalMaskOverlayPath = path.join(params.artifactDir, "final-mask-overlay.png");
  const renderBoundaryPreviewPath = path.join(params.artifactDir, "render-boundary-preview.png");
  const insertionRegionPreviewPath = path.join(params.artifactDir, "insertion-region-preview.png");
  const topologyOverlayPath = path.join(params.artifactDir, "planner-topology-overlay.png");
  const zoneArtifactDir = path.join(params.artifactDir, "zones");

  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(occupancyRaw, width, height, { red: 255, green: 136, blue: 64, alpha: 110 })],
    width,
    height,
    occupancyOverlayPath,
  );
  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(exclusionRaw, width, height, { red: 64, green: 156, blue: 255, alpha: 96 })],
    width,
    height,
    exclusionOverlayPath,
  );
  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(finalRaw, width, height, { red: 72, green: 210, blue: 118, alpha: 108 })],
    width,
    height,
    finalMaskOverlayPath,
  );

  const renderBoundaryOverlay = Buffer.alloc(width * height * 4);
  const boundaryMask = buildBoundaryMask(finalRaw, width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (finalRaw[index] > 0) {
      renderBoundaryOverlay[offset] = 72;
      renderBoundaryOverlay[offset + 1] = 210;
      renderBoundaryOverlay[offset + 2] = 118;
      renderBoundaryOverlay[offset + 3] = 104;
    } else {
      renderBoundaryOverlay[offset] = 0;
      renderBoundaryOverlay[offset + 1] = 0;
      renderBoundaryOverlay[offset + 2] = 0;
      renderBoundaryOverlay[offset + 3] = 78;
    }
    if (boundaryMask[index] > 0) {
      renderBoundaryOverlay[offset] = 255;
      renderBoundaryOverlay[offset + 1] = 84;
      renderBoundaryOverlay[offset + 2] = 84;
      renderBoundaryOverlay[offset + 3] = 220;
    }
  }
  await writeComposite(
    params.sourceImagePath,
    [renderBoundaryOverlay],
    width,
    height,
    renderBoundaryPreviewPath,
  );

  const bounds = params.masks.insertionBounds;
  if (bounds) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="rgba(72,210,118,0.16)" stroke="rgba(255,84,84,0.92)" stroke-width="3" />
      </svg>
    `;
    await sharp(params.sourceImagePath)
      .composite([{ input: Buffer.from(svg), blend: "over" }])
      .png()
      .toFile(insertionRegionPreviewPath);
  } else {
    await sharp(params.sourceImagePath).png().toFile(insertionRegionPreviewPath);
  }

  await writeTopologyOverlay({
    sourceImagePath: params.sourceImagePath,
    outputPath: topologyOverlayPath,
    width,
    height,
    plan: params.plan,
  });

  const zoneArtifacts = await writeZoneArtifacts({
    sourceImagePath: params.sourceImagePath,
    zoneArtifactDir,
    width,
    height,
    plan: params.plan,
    exclusionRaw,
  });

  return {
    occupancyOverlayPath,
    exclusionOverlayPath,
    finalMaskOverlayPath,
    renderBoundaryPreviewPath,
    insertionRegionPreviewPath,
    topologyOverlayPath,
    zoneArtifactDir: zoneArtifacts.zoneArtifactDir,
    zoneManifestPath: zoneArtifacts.zoneManifestPath,
  };
}