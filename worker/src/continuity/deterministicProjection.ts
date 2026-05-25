import type { NormalizedPoint, PlacementPlan } from "./types";

export type DeterministicZoneProjection = {
  source: "deterministic_bbox_topology_v1";
  anchorPoint: NormalizedPoint;
  floorPolygon: NormalizedPoint[];
  wallPolygon: NormalizedPoint[];
  plannerFloorPolygon: NormalizedPoint[];
  plannerWallPolygon: NormalizedPoint[];
  usedFloorJunctionGuidance: boolean;
  usedWallGuidance: boolean;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function sortByX(points: NormalizedPoint[]): NormalizedPoint[] {
  return [...points].sort((left, right) => left.x - right.x);
}

function interpolatePolylineY(points: NormalizedPoint[], x: number): number | null {
  if (points.length === 0) {
    return null;
  }
  const sorted = sortByX(points);
  if (sorted.length === 1) {
    return sorted[0].y;
  }
  if (x <= sorted[0].x) {
    return sorted[0].y;
  }
  if (x >= sorted[sorted.length - 1].x) {
    return sorted[sorted.length - 1].y;
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1];
    const right = sorted[index];
    if (x < left.x || x > right.x) {
      continue;
    }
    const span = Math.max(1e-6, right.x - left.x);
    const t = (x - left.x) / span;
    return left.y + ((right.y - left.y) * t);
  }
  return sorted[sorted.length - 1].y;
}

function getFloorGuidePoints(plan: PlacementPlan): NormalizedPoint[] {
  const junctions = plan.structuralTopologyCage?.floorWallJunctions || [];
  if (junctions.length >= 2) {
    return junctions;
  }
  const floorPlane = (plan.structuralTopologyCage?.majorRoomPlanes || []).find((plane) => /floor/i.test(String(plane.planeType || "")));
  if (floorPlane?.polygon?.length) {
    return floorPlane.polygon;
  }
  return [];
}

function estimateFloorY(plan: PlacementPlan, x: number, fallback: number): { y: number; guided: boolean } {
  const floorGuides = getFloorGuidePoints(plan);
  const interpolated = interpolatePolylineY(floorGuides, x);
  if (interpolated != null) {
    return {
      y: clamp01(interpolated),
      guided: true,
    };
  }
  return {
    y: clamp01(fallback),
    guided: false,
  };
}

function resolveDepthFactor(furnitureType: string): number {
  const normalized = furnitureType.toLowerCase();
  if (normalized.includes("rug")) return 0.58;
  if (normalized.includes("bed")) return 0.34;
  if (normalized.includes("sofa") || normalized.includes("couch")) return 0.32;
  if (normalized.includes("chair")) return 0.24;
  if (normalized.includes("table") || normalized.includes("desk") || normalized.includes("nightstand")) return 0.22;
  if (normalized.includes("lamp")) return 0.18;
  return 0.26;
}

function shouldProjectWall(zone: PlacementPlan["furnitureZones"][number]): boolean {
  if (zone.anchorRelationships.adjacentWall) {
    return true;
  }
  const normalized = zone.furnitureType.toLowerCase();
  return normalized.includes("bed")
    || normalized.includes("nightstand")
    || normalized.includes("dresser")
    || normalized.includes("cabinet")
    || normalized.includes("lamp");
}

function constrainX(minX: number, maxX: number, value: number): number {
  return Math.max(minX, Math.min(maxX, value));
}

function buildFloorPolygon(plan: PlacementPlan, zone: PlacementPlan["furnitureZones"][number]): {
  polygon: NormalizedPoint[];
  anchorPoint: NormalizedPoint;
  usedFloorJunctionGuidance: boolean;
} {
  const bbox = zone.normalizedBoundingBox;
  const left = clamp01(bbox.x);
  const right = clamp01(bbox.x + bbox.width);
  const top = clamp01(bbox.y);
  const bottom = clamp01(bbox.y + bbox.height);
  const centerX = clamp01((left + right) / 2);
  const fallbackFloorY = clamp01(Math.max(bottom - (bbox.height * 0.7), top + (bbox.height * 0.15)));
  const floorLeft = estimateFloorY(plan, left, fallbackFloorY);
  const floorRight = estimateFloorY(plan, right, fallbackFloorY);
  const floorCenter = estimateFloorY(plan, centerX, fallbackFloorY);
  const usedFloorJunctionGuidance = floorLeft.guided || floorRight.guided || floorCenter.guided;

  const availableDepth = Math.max(0.025, bottom - floorCenter.y);
  const depth = Math.min(Math.max(0.02, bbox.height * resolveDepthFactor(zone.furnitureType)), availableDepth * 0.82);
  const backY = clamp01(Math.max(top + (bbox.height * 0.2), bottom - depth));
  const frontInset = bbox.width * 0.06;
  const backInset = bbox.width * 0.18;
  const perspectiveShift = (centerX - 0.5) * bbox.width * 0.12;
  const minAllowedX = clamp01(left + (bbox.width * 0.04));
  const maxAllowedX = clamp01(right - (bbox.width * 0.04));

  const frontLeftX = constrainX(minAllowedX, maxAllowedX, left + frontInset);
  const frontRightX = constrainX(minAllowedX, maxAllowedX, right - frontInset);
  const backLeftX = constrainX(minAllowedX, maxAllowedX, left + backInset + perspectiveShift);
  const backRightX = constrainX(minAllowedX, maxAllowedX, right - backInset + perspectiveShift);
  const normalizedBackLeftX = Math.min(backLeftX, backRightX - 0.01);
  const normalizedBackRightX = Math.max(backRightX, normalizedBackLeftX + 0.01);

  return {
    polygon: [
      { x: frontLeftX, y: bottom },
      { x: frontRightX, y: bottom },
      { x: normalizedBackRightX, y: backY },
      { x: normalizedBackLeftX, y: backY },
    ],
    anchorPoint: { x: centerX, y: bottom },
    usedFloorJunctionGuidance,
  };
}

function buildWallPolygon(plan: PlacementPlan, zone: PlacementPlan["furnitureZones"][number], floorPolygon: NormalizedPoint[]): {
  polygon: NormalizedPoint[];
  usedWallGuidance: boolean;
} {
  if (!shouldProjectWall(zone)) {
    return {
      polygon: [],
      usedWallGuidance: false,
    };
  }

  const bbox = zone.normalizedBoundingBox;
  const left = clamp01(bbox.x);
  const right = clamp01(bbox.x + bbox.width);
  const top = clamp01(bbox.y);
  const bottom = clamp01(bbox.y + bbox.height);
  const centerX = clamp01((left + right) / 2);
  const floorCenter = estimateFloorY(plan, centerX, bottom);
  const floorBackY = floorPolygon.length >= 4 ? floorPolygon[2].y : bottom;
  const lowerY = clamp01(Math.min(floorCenter.y + ((floorBackY - floorCenter.y) * 0.65), bottom - (bbox.height * 0.12)));
  const perspectiveShift = (centerX - 0.5) * bbox.width * 0.08;

  const topLeftX = constrainX(left, right, left + (bbox.width * 0.08) + perspectiveShift);
  const topRightX = constrainX(left, right, right - (bbox.width * 0.08) + perspectiveShift);
  const lowerLeftX = constrainX(left, right, left + (bbox.width * 0.04));
  const lowerRightX = constrainX(left, right, right - (bbox.width * 0.04));

  return {
    polygon: [
      { x: topLeftX, y: top },
      { x: topRightX, y: top },
      { x: lowerRightX, y: lowerY },
      { x: lowerLeftX, y: lowerY },
    ],
    usedWallGuidance: floorCenter.guided,
  };
}

export function resolveDeterministicZoneProjection(params: {
  plan: PlacementPlan;
  zone: PlacementPlan["furnitureZones"][number];
}): DeterministicZoneProjection {
  const floorProjection = buildFloorPolygon(params.plan, params.zone);
  const wallProjection = buildWallPolygon(params.plan, params.zone, floorProjection.polygon);

  return {
    source: "deterministic_bbox_topology_v1",
    anchorPoint: floorProjection.anchorPoint,
    floorPolygon: floorProjection.polygon,
    wallPolygon: wallProjection.polygon,
    plannerFloorPolygon: params.zone.maskProjection.floorPolygon,
    plannerWallPolygon: params.zone.maskProjection.wallProjectionPolygon,
    usedFloorJunctionGuidance: floorProjection.usedFloorJunctionGuidance,
    usedWallGuidance: wallProjection.usedWallGuidance,
  };
}