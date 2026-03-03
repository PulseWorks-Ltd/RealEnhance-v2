import type { StructuralBaseline } from "../validators/openingPreservationValidator";

export function buildStructuralConstraintBlock(
  baseline: StructuralBaseline,
  mode: "soft" | "hard"
): string {
  if (!baseline?.openings?.length) return "";

  const header =
    mode === "soft"
      ? "Preserve all existing architectural openings."
      : "The following architectural openings are IMMUTABLE and must remain structurally intact:";

  const openingLines = baseline.openings.map((o) => {
    return `- ${o.id}: ${o.type} on ${o.wallPosition}, ${o.relativeHorizontalPosition}`;
  });

  const rulesSoft = `
Do not remove, seal, relocate, resize, or infill any windows, doors, closets, or archways.
Maintain structural continuity and original wall openings.
Design around these elements.`;

  const rulesHard = `
You MUST:
- Preserve exact wall placement of these openings.
- Preserve frame boundaries and cavity depth.
- Not convert any opening into flat wall.
- Not relocate any opening to another wall.
- Not alter structural envelope geometry.

Camera framing may vary, but physical structure must remain intact.`;

  return `
================ STRUCTURAL PRESERVATION CONSTRAINTS ================
${header}

${openingLines.join("\n")}

${mode === "soft" ? rulesSoft : rulesHard}
=====================================================================
`;
}