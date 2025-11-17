// Per-class comparison helpers for structural validation
import { SemanticMask, SegmentationResult, SemanticClass } from "./semanticSegmenter";

export function compareWalls(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Find large wall regions (>10% of image)
  // For each, ensure matching region in candidate with IoU >= 0.7
  // If a large wall disappears or new large wall appears → fail
  // Stub: always pass
  return { pass: true };
}

export function compareWindows(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Count windows, aggregate area, allow ±1 window or <30% area change
  // Stub: always pass
  return { pass: true };
}

export function compareDoors(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Count doors, aggregate area, allow ±1 door or <30% area change
  // Stub: always pass
  return { pass: true };
}

export function compareFloorMaterial(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Classify main floor material, fail if changed
  // Stub: always pass
  return { pass: true };
}

export function compareGrassConcrete(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Ensure yard grass vs hard-surface proportions don’t flip by >30%
  // Stub: always pass
  return { pass: true };
}

export function compareDrivewayPresence(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Detect driveway region, fail if added/removed
  // Stub: always pass
  return { pass: true };
}

export function compareVehicles(base: SegmentationResult, candidate: SegmentationResult): { pass: boolean; code?: string; details?: any } {
  // Detect cars in driveway/yard, fail on add/remove
  // Stub: always pass
  return { pass: true };
}
