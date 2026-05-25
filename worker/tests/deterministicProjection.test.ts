import type { PlacementPlan } from "../src/continuity/types";
import { resolveDeterministicZoneProjection } from "../src/continuity/deterministicProjection";

function makePlan(): PlacementPlan {
  return {
    roomType: "bedroom",
    imageWidth: 1600,
    imageHeight: 1000,
    structuralTopologyCage: {
      floorWallJunctions: [
        { x: 0.05, y: 0.56 },
        { x: 0.5, y: 0.6 },
        { x: 0.95, y: 0.57 },
      ],
      majorRoomPlanes: [
        {
          id: "floor-plane",
          planeType: "floor",
          polygon: [
            { x: 0.0, y: 0.58 },
            { x: 1.0, y: 0.58 },
            { x: 1.0, y: 1.0 },
            { x: 0.0, y: 1.0 },
          ],
        },
      ],
    },
    furnitureZones: [
      {
        id: "bed-zone",
        furnitureType: "bed",
        normalizedBoundingBox: { x: 0.24, y: 0.34, width: 0.38, height: 0.42 },
        anchorRelationships: {
          adjacentWall: "headboard wall",
          floorPlaneAlignment: "floor",
        },
        orientation: {
          yawDegrees: 0,
          perspectiveHint: "match existing camera perspective",
        },
        maskProjection: {
          floorPolygon: [
            { x: 0.02, y: 0.1 },
            { x: 0.95, y: 0.1 },
            { x: 0.98, y: 0.9 },
            { x: 0.01, y: 0.88 },
          ],
          wallProjectionPolygon: [],
        },
        continuityReference: {
          derivedFromMaster: true,
          masterFurnitureId: "master-bed",
        },
      },
    ],
  };
}

describe("deterministic continuity projection", () => {
  it("derives constrained geometry from bbox and topology instead of planner polygons", () => {
    const plan = makePlan();
    const zone = plan.furnitureZones[0];

    const projection = resolveDeterministicZoneProjection({ plan, zone });

    expect(projection.source).toBe("deterministic_bbox_topology_v1");
    expect(projection.usedFloorJunctionGuidance).toBe(true);
    expect(projection.floorPolygon).toHaveLength(4);
    expect(projection.wallPolygon).toHaveLength(4);
    expect(projection.floorPolygon.every((point) => point.x >= zone.normalizedBoundingBox.x)).toBe(true);
    expect(projection.floorPolygon.every((point) => point.x <= zone.normalizedBoundingBox.x + zone.normalizedBoundingBox.width)).toBe(true);
    expect(projection.floorPolygon[0].y).toBeCloseTo(zone.normalizedBoundingBox.y + zone.normalizedBoundingBox.height, 4);
    expect(projection.floorPolygon[2].y).toBeLessThan(projection.floorPolygon[1].y);
    expect(projection.anchorPoint.y).toBeCloseTo(zone.normalizedBoundingBox.y + zone.normalizedBoundingBox.height, 4);
    expect(projection.plannerFloorPolygon).toEqual(zone.maskProjection.floorPolygon);
  });
});