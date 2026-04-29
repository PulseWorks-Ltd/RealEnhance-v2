import assert from "node:assert/strict";
import { deriveRoomState, type FurnitureAnalysis, type FurnitureItem } from "../ai/furnitureDetector";

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
  // Kitchen with counter clutter → CLUTTERED
  assert.equal(
    deriveRoomState(baseAnalysis({ roomType: "kitchen", hasCounterClutter: true, isStageReady: false })),
    "CLUTTERED",
    "Kitchen with counter clutter must be CLUTTERED"
  );

  // Anchor furniture, no clutter → ANCHOR_CLEAN
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

  // Anchor + supporting items only → ANCHOR_CLEAN
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

  // Bed + two nightstands → ANCHOR_CLEAN (not excess furniture)
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

  // Anchor + non-supporting item → CLUTTERED
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

  // No furniture, no clutter → EMPTY
  assert.equal(
    deriveRoomState(baseAnalysis({ hasFurniture: false, isStageReady: true })),
    "EMPTY",
    "No furniture and no clutter must be EMPTY"
  );

  // Surface clutter, no furniture → CLUTTERED
  assert.equal(
    deriveRoomState(baseAnalysis({ roomType: "other", hasSurfaceClutter: true, isStageReady: false })),
    "CLUTTERED",
    "Surface clutter without furniture must be CLUTTERED"
  );

  // Low confidence does not affect state — anchor still gives ANCHOR_CLEAN
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

  // Clutter overrides furniture signal → CLUTTERED
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
