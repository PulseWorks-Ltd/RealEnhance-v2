// realism-prompt.ts

export function buildRealismPrompt(): string {
  return `You are an expert in interior design and photo realism. Analyze the provided image and answer ONLY in valid JSON with these fields:

{
  "furnitureScaleOk": true|false,
  "scaleDescription": "string",
  "lightingOk": true|false,
  "lightingDescription": "string",
  "floatingObjects": true|false,
  "floatingDescription": "string",
  "notes": ["string", ...]
}

Check for:
- Furniture scale: Is any furniture oversized or undersized for the room? (e.g., tiny chairs, giant sofas)
- Lighting: Is the lighting consistent and realistic? Are there unnatural shadows, glowing, or floating objects?
- Floating objects: Are any items not properly grounded (e.g., floating above the floor)?
- Add any other realism notes.

Return ONLY valid JSON.`;
}
