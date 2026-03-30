import assert from "node:assert/strict";
import { resolveFurnishedGateDecision, type FurnitureAnalysis } from "../ai/furnitureDetector";

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

  console.log("[PASS] Furnished gate acceptance tests");
}

run();
