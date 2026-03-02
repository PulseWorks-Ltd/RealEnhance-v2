export type StructuralInvariantViolationType =
  | "opening_removed"
  | "opening_infilled"
  | "opening_relocated"
  | "door_removed"
  | "window_removed"
  | "closet_removed"
  | "other";

export type StructuralInvariantDecision = {
  fail: boolean;
  confidence: number;
  reason: string;
  openingViolationDetected: boolean;
  violationType: StructuralInvariantViolationType;
};

export function evaluateStructuralInvariantDecision(parsed: any): StructuralInvariantDecision {
  const openingsBefore = Number(parsed.openings_before || 0);
  const openingsAfter = Number(parsed.openings_after || 0);
  const removedCount = Number(parsed.removed_openings_count || 0);
  const relocationDetected = parsed.relocation_detected === true;
  const locationMismatchDetected = parsed.location_mismatch_detected === true;
  const wallPlaneReplaced = parsed.wall_plane_replacement_detected === true;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? parsed.confidence
      : 0;

  const countDecrease = openingsAfter < openingsBefore;
  const reasonText = String(parsed.reason || "").toLowerCase();
  const rawViolationType = typeof parsed.violationType === "string"
    ? parsed.violationType.toLowerCase()
    : "";
  const negationPatterns = [
    "no openings were",
    "no opening was",
    "no structural openings were",
    "none were removed",
    "none were relocated",
    "none were infilled",
    "no evidence of removal",
    "not removed",
    "does not become continuous",
    "remain unchanged",
    "structurally unchanged",
  ];
  const hasNegation = negationPatterns.some((pattern) => reasonText.includes(pattern));
  const shouldUseReasonKeywords = !hasNegation;
  const removedLocations = Array.isArray(parsed.removed_opening_locations)
    ? parsed.removed_opening_locations.map((value: any) => String(value || "").toLowerCase()).join(" ")
    : "";

  const structuredOpeningRemovedSignal =
    rawViolationType === "opening_removed" ||
    rawViolationType === "door_removed" ||
    rawViolationType === "window_removed" ||
    rawViolationType === "closet_removed";
  const structuredOpeningInfilledSignal = rawViolationType === "opening_infilled";
  const structuredOpeningRelocatedSignal = rawViolationType === "opening_relocated";

  const openingRemovedSignal =
    structuredOpeningRemovedSignal ||
    removedCount > 0 ||
    countDecrease ||
    (shouldUseReasonKeywords && reasonText.includes("opening removed")) ||
    (shouldUseReasonKeywords && reasonText.includes("removed opening")) ||
    (shouldUseReasonKeywords && reasonText.includes("window removed")) ||
    (shouldUseReasonKeywords && reasonText.includes("door removed")) ||
    (shouldUseReasonKeywords && reasonText.includes("closet") && reasonText.includes("removed")) ||
    (removedLocations.includes("window") && removedLocations.includes("removed")) ||
    (removedLocations.includes("door") && removedLocations.includes("removed")) ||
    (removedLocations.includes("closet") && removedLocations.includes("removed"));

  const openingInfilledSignal =
    structuredOpeningInfilledSignal ||
    wallPlaneReplaced ||
    (shouldUseReasonKeywords && reasonText.includes("infill")) ||
    (shouldUseReasonKeywords && reasonText.includes("infilled")) ||
    (shouldUseReasonKeywords && reasonText.includes("continuous wall")) ||
    (shouldUseReasonKeywords && reasonText.includes("wall plane"));

  const openingRelocatedSignal =
    structuredOpeningRelocatedSignal ||
    relocationDetected ||
    locationMismatchDetected ||
    (shouldUseReasonKeywords && reasonText.includes("relocat")) ||
    (shouldUseReasonKeywords && reasonText.includes("mismatch"));

  const openingViolationDetected =
    openingRemovedSignal ||
    openingInfilledSignal ||
    openingRelocatedSignal;

  const violationType = (() => {
    if (rawViolationType === "opening_relocated") return "opening_relocated" as const;
    if (rawViolationType === "opening_infilled") return "opening_infilled" as const;
    if (rawViolationType === "window_removed") return "window_removed" as const;
    if (rawViolationType === "door_removed") return "door_removed" as const;
    if (rawViolationType === "closet_removed") return "closet_removed" as const;
    if (rawViolationType === "opening_removed") return "opening_removed" as const;
    if (openingRelocatedSignal) return "opening_relocated" as const;
    if (openingInfilledSignal) return "opening_infilled" as const;
    if (shouldUseReasonKeywords && reasonText.includes("window removed")) return "window_removed" as const;
    if (shouldUseReasonKeywords && reasonText.includes("door removed")) return "door_removed" as const;
    if (
      (shouldUseReasonKeywords && reasonText.includes("closet") && reasonText.includes("removed")) ||
      removedLocations.includes("closet")
    ) {
      return "closet_removed" as const;
    }
    if (openingRemovedSignal) return "opening_removed" as const;
    return "other" as const;
  })();

  const explicitRemoval =
    removedCount > 0 &&
    wallPlaneReplaced &&
    confidence >= 0.9;

  const relocationRemoval =
    (relocationDetected || locationMismatchDetected) && confidence >= 0.9;

  const fail = openingViolationDetected || explicitRemoval || relocationRemoval;

  return {
    fail,
    confidence,
    reason: String(parsed.reason ?? ""),
    openingViolationDetected,
    violationType,
  };
}
