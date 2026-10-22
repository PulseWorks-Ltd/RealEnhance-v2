// The furniture pre-check must reach the same declutter decision as the main
// pipeline's furnished gate, per room type, because the quoted credits and
// the routing both come from it.
jest.mock("@realenhance/shared/redisClient.js", () => ({ getRedis: () => ({}) }));

import { resolveFurnishedGateDecision } from "../src/ai/furnitureDetector";
import { decideRequiresDeclutter, normalizePrecheckRoomType, PRECHECK_ROOM_TYPES } from "../src/precheck/furniturePrecheck";

const base = {
  status: "success" as const,
  hasFurniture: false,
  detectedAnchors: [] as string[],
  detectedItems: [] as any[],
  confidence: 0.9,
  hasMovableSeating: false,
  hasCounterClutter: false,
  hasSurfaceClutter: false,
  hasLoosePortableItems: false,
  isStageReady: false,
  roomType: "bedroom" as const,
  furnitureItems: [] as any[],
  layoutDescription: "",
  replacementOpportunity: "none" as const,
  suggestions: [] as string[],
};

const furnishedBedroom = {
  ...base,
  hasFurniture: true,
  detectedAnchors: ["bed"],
  furnitureItems: [{ type: "bed", confidence: 0.95 }],
};

describe("furniture pre-check decision", () => {
  it("empty by the local prefilter -> no declutter", () => {
    expect(decideRequiresDeclutter(true, null, "bedroom")).toBe(false);
  });

  it("detector failed -> unknown (null)", () => {
    expect(decideRequiresDeclutter(false, { status: "failed", failureCode: "timeout" }, "bedroom")).toBeNull();
  });

  it("matches the main pipeline's furnished gate for every room type", () => {
    for (const analysis of [base, furnishedBedroom]) {
      for (const rt of PRECHECK_ROOM_TYPES) {
        const gate = resolveFurnishedGateDecision({ analysis: analysis as any, localEmpty: false, roomType: rt });
        expect(decideRequiresDeclutter(false, analysis, rt)).toBe(gate.requiresStage1B === true);
      }
    }
  });

  it("a cluttered bedroom needs declutter; a tidy furnished or empty one does not", () => {
    const clutteredBedroom = {
      ...furnishedBedroom,
      hasSurfaceClutter: true,
      detectedItems: [
        { type: "clothes_pile", confidence: 0.9 },
        { type: "boxes", confidence: 0.9 },
        { type: "laundry_basket", confidence: 0.9 },
      ],
    };
    expect(decideRequiresDeclutter(false, clutteredBedroom, "bedroom")).toBe(true);
    // Tidy furnished room: staged as is (refresh), no declutter.
    expect(decideRequiresDeclutter(false, furnishedBedroom, "bedroom")).toBe(false);
    expect(decideRequiresDeclutter(false, base, "bedroom")).toBe(false);
  });

  // Real detector outputs from the 2026-10-12 Railway run.
  it("Bedroom 12: empty room with unlisted clutter flags is NOT sent to declutter", () => {
    const bedroom12 = { ...base, hasSurfaceClutter: true, hasLoosePortableItems: true, detectedItems: [] };
    expect(decideRequiresDeclutter(false, bedroom12, "bedroom")).toBe(false);
  });

  it("Bedroom 2: furnished room with an unlisted surface-clutter flag is not decluttered", () => {
    const bedroom2 = {
      ...base,
      hasFurniture: true,
      detectedAnchors: ["bed", "chair", "large_freestanding_cabinet"],
      hasSurfaceClutter: true,
    };
    expect(decideRequiresDeclutter(false, bedroom2, "bedroom")).toBe(false);
  });

  it("cables, two vases and a bit of litter are minor: no declutter", () => {
    const minor = {
      ...base,
      hasSurfaceClutter: true,
      detectedItems: [
        { type: "cable", confidence: 0.9 },
        { type: "vase", confidence: 0.9 },
        { type: "vase", confidence: 0.8 },
        { type: "litter", confidence: 0.7 },
      ],
    };
    expect(decideRequiresDeclutter(false, minor, "living_room")).toBe(false);
  });

  it("real clutter (boxes, bags, clothes) still goes to declutter", () => {
    const messy = {
      ...base,
      hasLoosePortableItems: true,
      detectedItems: [
        { type: "box", confidence: 0.9 },
        { type: "bag", confidence: 0.9 },
        { type: "clothes_pile", confidence: 0.85 },
      ],
    };
    expect(decideRequiresDeclutter(false, messy, "bedroom")).toBe(true);
  });

  it("normalises room types like the pipeline", () => {
    expect(normalizePrecheckRoomType("Bathroom-1")).toBe("bathroom_1");
    expect(normalizePrecheckRoomType("multiple_living")).toBe("kitchen_living_dining");
  });
});
