// Shared helper for the "semantic reference, not bbox" grounding hypothesis
// test. Builds a natural-language item pointer (type + baseline description
// + landmark framing) instead of a bbox-coordinate pointer, reusing each
// item's own `description` field from structural baseline extraction
// (already present in the codebase — AnchorFixture.description /
// StructuralOpening.description — just never used as the grounding pointer
// before now; every prior mechanism this session pointed at items via bbox
// coordinates only).
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

export function pickLargestOpening(baseline: any, types: string[]): PickedItem | null {
  const openings = (baseline?.openings || []).filter((o: any) => types.includes(o.type));
  if (openings.length === 0) return null;
  openings.sort((a: any, b: any) => (b.area_pct || 0) - (a.area_pct || 0));
  const o = openings[0];
  return {
    id: o.id,
    type: o.type,
    description: o.description,
    wallIndex: o.wallIndex,
    horizontalBand: o.horizontalBand,
    verticalBand: o.verticalBand,
    bbox: o.bbox,
  };
}

export function pickLargestFixture(baseline: any, types: string[]): PickedItem | null {
  const fixtures = (baseline?.anchorFixtures || []).filter((f: any) => types.includes(f.type));
  if (fixtures.length === 0) return null;
  fixtures.sort((a: any, b: any) => {
    const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
    const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
    return areaB - areaA;
  });
  const f = fixtures[0];
  return {
    id: f.id,
    type: f.type,
    description: f.description,
    wallIndex: f.wallIndex,
    horizontalBand: f.horizontalBand,
    bbox: f.bbox,
  };
}
