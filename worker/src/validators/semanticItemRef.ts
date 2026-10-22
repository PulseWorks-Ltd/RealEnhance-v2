// Shared item pointer used by windowArtworkCheck.ts and
// vanishedLandmarkCheck.ts: a natural-language description (type + baseline
// description + landmark framing) instead of a bbox-coordinate pointer,
// reusing each item's own `description` field from structural baseline
// extraction (StructuralOpening.description / AnchorFixture.description).
// Ported from tmp/semanticItemRef.ts — only the pure reference-builder is
// needed in production; the tmp/ file's pickLargestOpening/pickLargestFixture
// were single-item test-harness helpers with no production caller (both new
// checks operate on every item in a domain, not a single picked one).
export type PickedItem = {
  id: string;
  type: string;
  description?: string;
  wallIndex?: number | string;
  horizontalBand?: string;
  verticalBand?: string;
  bbox: [number, number, number, number];
};

function humanize(s: string | undefined): string {
  return String(s || "").replace(/_/g, " ").trim();
}

export function buildSemanticReference(item: PickedItem): string {
  const parts: string[] = [`a ${humanize(item.type)}`];
  if (item.description) parts.push(`described in the baseline photo as: "${item.description}"`);
  const landmark: string[] = [];
  if (item.horizontalBand) landmark.push(`in the ${humanize(item.horizontalBand)} of the wall`);
  if (item.verticalBand) landmark.push(`${humanize(item.verticalBand)} vertically`);
  if (item.wallIndex !== undefined && item.wallIndex !== null) landmark.push(`on wall ${item.wallIndex}`);
  if (landmark.length) parts.push(`located ${landmark.join(", ")}`);
  return parts.join(", ") + ".";
}
