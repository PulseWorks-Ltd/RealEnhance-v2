import type { EditIntent } from "./intentClassifier";

export function buildIntentPrompt(intent: EditIntent, userInput: string): string {
  switch (intent) {
    case "trim_landscaping":
      return `
Transform vegetation into a neat, well-maintained lawn.

- Grass should be evenly trimmed
- Remove tall and uneven strands
- Preserve plant bases and structure
- Maintain clean edges along boundaries
- Result should look freshly manicured
`.trim();

    case "clean_surface":
      return `
Clean and refresh the surface.

- Remove dirt, stains, discoloration
- Preserve original material
- Improve uniformity
- Result should look professionally cleaned (for example pressure washed)
`.trim();

    case "repair_surface":
      return `
Repair and improve the surface.

- Fix visible damage and wear
- Even out paint or material inconsistencies
- Preserve original structure
- Do not redesign
`.trim();

    case "declutter":
      return `
Remove unwanted objects and clutter.

- Reconstruct background naturally
- Ensure area looks clean and complete
- No artifacts or gaps
`.trim();

    default:
      return `
Apply the requested edit:

${userInput}

Ensure result is clear, realistic, and consistent.
`.trim();
  }
}