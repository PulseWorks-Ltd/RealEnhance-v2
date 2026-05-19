import type { ContinuityRepairRequest } from "../src/providers/types";
import { VertexSecondaryContinuityError, type PlacementPlan } from "../src/continuity/types";

const mockEnsureLocalImagePath = jest.fn();

jest.mock("../src/providers/imageTransport", () => ({
  ensureLocalImagePath: (...args: unknown[]) => mockEnsureLocalImagePath(...args),
  persistMaskArtifact: jest.fn(),
  persistRemoteImage: jest.fn(),
  toGenAiPart: jest.fn(),
}));

jest.mock("../src/utils/debugImageUrls", () => ({
  logImageAttemptUrl: jest.fn(async () => undefined),
}));

jest.mock("../src/logger", () => ({
  nLog: jest.fn(),
}));

import { VertexContinuityRepairProvider } from "../src/providers/vertex/continuityRepairProvider";
import { VertexSpatialPlannerProvider } from "../src/providers/vertex/spatialPlannerProvider";

function makePlan(): PlacementPlan {
  return {
    roomType: "bedroom",
    imageWidth: 1248,
    imageHeight: 832,
    furnitureZones: [
      {
        id: "zone-1",
        furnitureType: "bed",
        normalizedBoundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
        anchorRelationships: {},
        orientation: {
          yawDegrees: 0,
          perspectiveHint: "match existing camera perspective",
        },
        maskProjection: {
          floorPolygon: [],
          wallProjectionPolygon: [],
        },
        continuityReference: {
          derivedFromMaster: true,
          masterFurnitureId: "bed-master",
        },
      },
    ],
  };
}

function makeRepairRequest(): ContinuityRepairRequest {
  return {
    secondaryImage: {
      kind: "gcs",
      uri: "gs://bucket/secondary.jpg",
      mimeType: "image/jpeg",
      sourceLabel: "secondary-continuity-source",
      artifactName: "secondary.jpg",
    },
    masterImage: {
      kind: "gcs",
      uri: "gs://bucket/master.jpg",
      mimeType: "image/jpeg",
      sourceLabel: "secondary-continuity-master",
      artifactName: "master.jpg",
    },
    occupancyConstraintMask: null,
    outputPath: "/tmp/out.webp",
    roomType: "bedroom",
    stagingStyle: "standard_listing",
    jobId: "job-hydrated-manifest",
    imageId: "img-hydrated-manifest",
    attempt: 1,
    renderMode: "full_secondary_continuity",
  };
}

describe("vertex continuity planner hydration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes hydrated references to the planner for worker manifest inputs", async () => {
    mockEnsureLocalImagePath
      .mockResolvedValueOnce("/tmp/hydrated-secondary.jpg")
      .mockResolvedValueOnce("/tmp/hydrated-master.jpg");

    const plannerProvider = {
      plan: jest.fn(async (params) => {
        expect(params.secondaryImage.uri).toBe("gs://bucket/secondary.jpg");
        expect(params.secondaryImage.localPath).toBe("/tmp/hydrated-secondary.jpg");
        expect(params.masterImage.uri).toBe("gs://bucket/master.jpg");
        expect(params.masterImage.localPath).toBe("/tmp/hydrated-master.jpg");
        throw new Error("stop_after_hydrated_planner_assertions");
      }),
    };
    const rendererProvider = {
      render: jest.fn(),
    };

    const provider = new VertexContinuityRepairProvider(plannerProvider as any, rendererProvider as any);

    await expect(provider.repair(makeRepairRequest())).rejects.toThrow("stop_after_hydrated_planner_assertions");
    expect(mockEnsureLocalImagePath).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceLabel: "secondary-continuity-source",
    }));
    expect(mockEnsureLocalImagePath).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceLabel: "secondary-continuity-master",
    }));
    expect(plannerProvider.plan).toHaveBeenCalledTimes(1);
    expect(rendererProvider.render).not.toHaveBeenCalled();
  });

  it("throws a continuity error instead of calling sharp with an empty path", async () => {
    const provider = new VertexSpatialPlannerProvider();

    await expect(provider.plan({
      secondaryImage: {
        kind: "gcs",
        uri: "gs://bucket/secondary.jpg",
        mimeType: "image/jpeg",
        sourceLabel: "secondary-continuity-source",
      },
      masterImage: {
        kind: "gcs",
        uri: "gs://bucket/master.jpg",
        mimeType: "image/jpeg",
        sourceLabel: "secondary-continuity-master",
      },
      roomType: "bedroom",
      jobId: "job-planner-guard",
      imageId: "img-planner-guard",
      renderMode: "full_secondary_continuity",
    })).rejects.toMatchObject({
      name: "VertexSecondaryContinuityError",
      code: "planner_missing_local_image_reference",
    } satisfies Partial<VertexSecondaryContinuityError>);
  });
});