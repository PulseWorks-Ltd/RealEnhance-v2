import assert from "node:assert/strict";
import assert from "node:assert/strict";
import {
  deriveRoomState,
  resolveFurnishedGateDecision,
  type FurnitureAnalysis,
  type FurnitureItem,
} from "../ai/furnitureDetector";

function baseAnalysis(overrides: Partial<FurnitureAnalysis> = {}): FurnitureAnalysis {
  return {
    hasFurniture: false,
    detectedAnchors: [],
    confidence: 0.95,
    hasMovableSeating: false,
    hasCounterClutter: false,
    hasSurfaceClutter: false,
    hasLoosePortableItems: false,
    isStageReady: true,
    roomType: "other",
    furnitureItems: [],
    layoutDescription: "",
    replacementOpportunity: "none",
    suggestions: [],
    ...overrides,
  };
}

function baseFurnitureItem(overrides: Partial<FurnitureItem> = {}): FurnitureItem {
  return {
    type: "other",
    label: "item",
    isAnchor: false,
    confidence: 0.9,
    ...overrides,
  };
}

function run() {
  assert.equal(
    deriveRoomState(baseAnalysis({ roomType: "kitchen", hasCounterClutter: true, isStageReady: false })),
    "CLUTTERED",
    "Kitchen with counter clutter must be CLUTTERED"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["sofa"],
      isStageReady: false,
      furnitureItems: [baseFurnitureItem({ type: "sofa", label: "sofa", isAnchor: true })],
    })),
    "ANCHOR_CLEAN",
    "Anchor without clutter must be ANCHOR_CLEAN"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["sofa"],
      isStageReady: false,
      furnitureItems: [
        baseFurnitureItem({ type: "sofa", label: "sofa", isAnchor: true }),
        baseFurnitureItem({ type: "table", label: "coffee table", isAnchor: false }),
        baseFurnitureItem({ type: "chair", label: "accent chair", isAnchor: false }),
      ],
    })),
    "ANCHOR_CLEAN",
    "Sofa + coffee table + accent chair must be ANCHOR_CLEAN (all supporting)"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["bed"],
      isStageReady: false,
      furnitureItems: [
        baseFurnitureItem({ type: "bed", label: "bed", isAnchor: true }),
        baseFurnitureItem({ type: "nightstand", label: "nightstand", isAnchor: false }),
        baseFurnitureItem({ type: "nightstand", label: "nightstand", isAnchor: false }),
      ],
    })),
    "ANCHOR_CLEAN",
    "Bed + two nightstands must be ANCHOR_CLEAN (nightstands are supporting)"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["bed"],
      isStageReady: false,
      furnitureItems: [
        baseFurnitureItem({ type: "bed", label: "bed", isAnchor: true }),
        baseFurnitureItem({ type: "sofa", label: "sofa in bedroom", isAnchor: false }),
      ],
    })),
    "CLUTTERED",
    "Bed + sofa (non-supporting for bed) must be CLUTTERED"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({ hasFurniture: false, isStageReady: true })),
    "EMPTY",
    "No furniture and no clutter must be EMPTY"
  );

  const counterClutterGate = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      roomType: "kitchen",
      hasCounterClutter: true,
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "kitchen",
    userSelectedDeclutter: false,
  });
  assert.equal(counterClutterGate.roomState, "FURNISHED_CLUTTERED", "Counter clutter must resolve to FURNISHED_CLUTTERED");
  assert.equal(counterClutterGate.requiresStage1B, true, "Counter clutter must trigger Stage 1B even when the user did not explicitly request declutter");

  const minorPortableClutterGate = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      hasFurniture: false,
      hasLoosePortableItems: true,
      detectedItems: [
        { type: "bag", confidence: 0.91 },
        { type: "box", confidence: 0.88 },
      ],
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "other",
  });
  assert.equal(minorPortableClutterGate.roomState, "FURNISHED_CLUTTERED", "Minor portable clutter should be treated as cluttered, not refresh-safe");
  assert.equal(minorPortableClutterGate.requiresStage1B, true, "Minor portable clutter should require Stage 1B");

  const tidyGate = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["sofa"],
      furnitureItems: [baseFurnitureItem({ type: "sofa", label: "sofa", isAnchor: true })],
    }),
    localEmpty: false,
    roomType: "living_room",
  });
  assert.equal(tidyGate.roomState, "FURNISHED_TIDY", "Anchor-only rooms should resolve to FURNISHED_TIDY");
  assert.equal(tidyGate.directRefreshEligible, true, "Tidy furnished rooms should be direct-refresh eligible");
  assert.equal(tidyGate.requiresStage1B, false, "Tidy furnished rooms should not require Stage 1B");
  assert.equal(tidyGate.stage2ModeCandidate, "REFRESH", "Tidy furnished rooms should route Stage 2 as refresh");

  const emptyGate = resolveFurnishedGateDecision({
    analysis: baseAnalysis({ hasFurniture: false, isStageReady: true }),
    localEmpty: true,
    roomType: "other",
  });
  assert.equal(emptyGate.roomState, "EMPTY", "Local empty prefilter should resolve to EMPTY");
  assert.equal(emptyGate.stage2ModeCandidate, "FROM_EMPTY", "Empty rooms should route Stage 2 from empty");
  assert.equal(emptyGate.requiresStage1B, false, "Empty rooms should not require Stage 1B");

  assert.equal(
    deriveRoomState(baseAnalysis({ roomType: "other", hasSurfaceClutter: true, isStageReady: false })),
    "CLUTTERED",
    "Surface clutter without furniture must be CLUTTERED"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["desk"],
      confidence: 0.2,
      furnitureItems: [baseFurnitureItem({ type: "desk", label: "desk", isAnchor: true })],
    })),
    "ANCHOR_CLEAN",
    "Low confidence must NOT affect room state — anchor present means ANCHOR_CLEAN"
  );

  assert.equal(
    deriveRoomState(baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["sofa"],
      hasSurfaceClutter: true,
      furnitureItems: [baseFurnitureItem({ type: "sofa", label: "sofa", isAnchor: true })],
    })),
    "CLUTTERED",
    "Anchor with surface clutter must be CLUTTERED"
  );

  console.log("[PASS] Room state acceptance tests");
}

run();
  console.log("[PASS] Room state acceptance tests");
