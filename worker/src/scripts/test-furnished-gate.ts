import assert from "node:assert/strict";
import { resolveFurnishedGateDecision, type FurnitureAnalysis, type FurnitureItem } from "../ai/furnitureDetector";

const INTERIOR_SKIP_STAGE1B_MAX_EXCESS_FURNITURE = 1;

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

function deriveInteriorRoutingState(analysis: FurnitureAnalysis) {
  const gateDecision = resolveFurnishedGateDecision({
    analysis,
    localEmpty: false,
    roomType: analysis.roomType,
    userSelectedDeclutter: false,
  });
  const detectedAnchors = Array.isArray(analysis.detectedAnchors) ? analysis.detectedAnchors : [];
  const anchorCount = detectedAnchors.length;
  const furnitureItems = analysis.furnitureItems;
  let totalFurniture: number | null = null;
  if (Array.isArray(furnitureItems)) {
    totalFurniture = furnitureItems.length;
  }
  let excessFurnitureCount: number | null = null;
  if (totalFurniture !== null) {
    excessFurnitureCount = Math.max(0, totalFurniture - anchorCount);
  }
  const anchorDetected = analysis.hasFurniture === true;
  const hasClutter = analysis.hasMovableSeating || analysis.hasCounterClutter || analysis.hasSurfaceClutter || analysis.hasLoosePortableItems;
  const skipStage1B = gateDecision.decision === "furnished_refresh"
    && anchorDetected
    && !hasClutter
    && (excessFurnitureCount === null || excessFurnitureCount <= INTERIOR_SKIP_STAGE1B_MAX_EXCESS_FURNITURE);

  return {
    gateDecision: gateDecision.decision,
    totalFurniture,
    excessFurnitureCount,
    skipStage1B,
  };
}

function run() {
  const kitchenCluttered = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      roomType: "kitchen",
      hasMovableSeating: true,
      hasCounterClutter: true,
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "kitchen",
  });
  assert.equal(kitchenCluttered.decision, "needs_declutter_light", "Kitchen with stools+counter clutter must route to light declutter");

  const emptyFromLocalPrefilter = resolveFurnishedGateDecision({
    analysis: baseAnalysis({ isStageReady: false, hasCounterClutter: true }),
    localEmpty: true,
    roomType: "kitchen",
  });
  assert.equal(emptyFromLocalPrefilter.decision, "empty_full_stage", "Local-empty prefilter must keep full-stage route");

  const anchoredFurnished = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["sofa"],
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "living_room",
  });
  assert.equal(anchoredFurnished.decision, "furnished_refresh", "Anchor furniture must route to refresh");

  const livingRoomTvOnly = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["tv"],
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "living_room",
  });
  assert.equal(livingRoomTvOnly.decision, "furnished_refresh", "Living room TV-only anchor must route to refresh");

  const bedroomTvOnly = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      hasFurniture: true,
      detectedAnchors: ["tv"],
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "bedroom",
  });
  assert.notEqual(bedroomTvOnly.decision, "furnished_refresh", "Non-living TV-only anchor must not route to refresh");

  const detectorNull = resolveFurnishedGateDecision({
    analysis: null,
    localEmpty: false,
    roomType: "kitchen",
  });
  assert.equal(detectorNull.decision, "needs_declutter_light", "Null detector result must fail-safe to light declutter");

  const lowConfidence = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      confidence: 0.2,
      roomType: "kitchen",
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "kitchen",
  });
  assert.equal(lowConfidence.decision, "needs_declutter_light", "Low confidence must fail-safe to light declutter");

  const cleanKitchenNoAnchors = resolveFurnishedGateDecision({
    analysis: baseAnalysis({ roomType: "kitchen", isStageReady: true }),
    localEmpty: false,
    roomType: "kitchen",
  });
  assert.equal(cleanKitchenNoAnchors.decision, "empty_full_stage", "Clean kitchen without anchors should route to full stage");

  const clutterNoAnchorsNonKitchen = resolveFurnishedGateDecision({
    analysis: baseAnalysis({
      roomType: "other",
      hasSurfaceClutter: true,
      isStageReady: false,
    }),
    localEmpty: false,
    roomType: "other",
  });
  assert.equal(clutterNoAnchorsNonKitchen.decision, "needs_declutter_light", "Clutter-only scene should not skip declutter");

  const populatedInventoryRouting = deriveInteriorRoutingState(baseAnalysis({
    roomType: "living_room",
    hasFurniture: true,
    detectedAnchors: ["sofa"],
    isStageReady: false,
    furnitureItems: [
      baseFurnitureItem({ type: "sofa", label: "sofa", isAnchor: true }),
      baseFurnitureItem({ type: "chair", label: "accent chair" }),
      baseFurnitureItem({ type: "table", label: "coffee table" }),
    ],
  }));
  assert.equal(populatedInventoryRouting.gateDecision, "furnished_refresh", "Populated inventory should stay on furnished refresh path");
  assert.equal(populatedInventoryRouting.totalFurniture, 3, "Populated inventory should preserve furniture count");
  assert.equal(populatedInventoryRouting.excessFurnitureCount, 2, "Populated inventory should compute excess furniture");
  assert.equal(populatedInventoryRouting.skipStage1B, false, "Populated excess inventory should force Stage 1B");

  const emptyInventoryRouting = deriveInteriorRoutingState(baseAnalysis({
    roomType: "living_room",
    hasFurniture: true,
    detectedAnchors: ["sofa"],
    isStageReady: false,
    furnitureItems: [],
  }));
  assert.equal(emptyInventoryRouting.totalFurniture, 0, "Empty inventory should remain distinguishable from missing inventory");
  assert.equal(emptyInventoryRouting.excessFurnitureCount, 0, "Empty inventory should compute zero excess furniture");
  assert.equal(emptyInventoryRouting.skipStage1B, true, "Explicitly empty inventory should preserve skip behavior");

  const missingInventoryRouting = deriveInteriorRoutingState(baseAnalysis({
    roomType: "living_room",
    hasFurniture: true,
    detectedAnchors: ["sofa"],
    isStageReady: false,
    furnitureItems: undefined,
  }));
  assert.equal(missingInventoryRouting.totalFurniture, null, "Missing inventory should stay missing");
  assert.equal(missingInventoryRouting.excessFurnitureCount, null, "Missing inventory should not be coerced to zero");
  assert.equal(missingInventoryRouting.skipStage1B, true, "Missing inventory should fall back to legacy skip behavior without assuming zero");

  console.log("[PASS] Furnished gate acceptance tests");
}

run();
