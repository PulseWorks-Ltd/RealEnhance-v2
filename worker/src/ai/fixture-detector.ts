import type { GoogleGenAI } from "@google/genai";

interface FixtureCheck {
  ok: boolean;
  reason?: string;
  details?: string;
}

export async function validateFixturePreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<FixtureCheck> {
  try {
    const prompt = `Analyze these two images (original and edited) to check if any FIXED ARCHITECTURAL ELEMENTS have been modified, added, or removed.

FIXED ELEMENTS TO CHECK (must remain EXACTLY unchanged):

DOORS & OPENINGS:
- Door frames, door panels, door hardware (handles, knobs, hinges)
- Door shutters (bifold shutters, louvered shutters, plantation shutters on doors)
- French door components (glass panels, mullions, shutters)
- Sliding door tracks and panels
- Door trim and molding

WINDOWS & WINDOW TREATMENTS:
- Window frames, sills, and mullions
- Window glass (number of panes, size, configuration)
- Window shutters (interior shutters, exterior shutters, bifold shutters, louvered shutters, plantation shutters)
- Built-in blinds (between-glass blinds, integrated blinds)
- Window hardware (cranks, locks, handles)
- Window trim and molding

KITCHEN/BATHROOM FIXTURES:
- Kitchen/bathroom counters and counter surfaces
- Built-in cabinetry and cupboards (wall-mounted or floor cabinets)
- Built-in appliances (ovens, dishwashers, range hoods, sinks, faucets)
- Built-in shelving and storage units
- Kitchen islands and peninsulas
- Bathroom vanities and fixtures

ARCHITECTURAL FEATURES:
- Light fixtures (ceiling lights, recessed lighting, wall sconces, chandeliers)
- Ceiling fans and fan fixtures
- Fireplaces and mantels
- Staircases (steps, railings, banisters)
- Columns and pillars
- Built-in bookcases or entertainment centers
- Closet systems and built-in wardrobes

CHANGES THAT ARE VIOLATIONS:
❌ Door/window shutters removed, modified, or repositioned
❌ Door/window frames, glass, or hardware altered
❌ Light fixtures or ceiling fans removed or changed
❌ Fireplace, mantel, or hearth modified
❌ Counter extended, enlarged, or reshaped
❌ Counter materials or color changed
❌ Cabinets added, removed, or repositioned
❌ Walkways or gaps between fixtures closed off
❌ Built-in appliances moved or replaced
❌ Cabinet doors or drawer fronts changed
❌ Stair components altered or removed
❌ Columns or architectural details modified

CHANGES THAT ARE ALLOWED (not violations):
✅ Loose furniture added/moved (chairs, stools, tables, sofas, beds)
✅ Décor items added (plants, bowls, lamps, artwork, rugs)
✅ Surface items on counters (appliances, utensils, decorative objects)
✅ Curtains or drapes added/removed (these are movable, not built-in)
✅ Image quality, lighting, color, or exposure improvements

Compare the images and return JSON:
{
  "ok": true/false,
  "reason": "Brief explanation if ok=false, empty if ok=true",
  "details": "Specific fixture that was modified (e.g., 'door shutters removed', 'window frame altered', 'light fixture changed'), empty if ok=true"
}

CRITICAL INSTRUCTION: Carefully examine ALL fixed architectural elements listed above. Pay special attention to door/window shutters, light fixtures, and built-in components. Loose furniture and décor changes are allowed.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[FIXTURE DETECTOR] Raw AI response:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[FIXTURE DETECTOR] No JSON found in response - FAILING SAFE");
      throw new Error("Fixture detector failed to return valid JSON response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log("[FIXTURE DETECTOR] Parsed result:", parsed);

    // Validate response structure
    if (parsed.ok === undefined) {
      console.error("[FIXTURE DETECTOR] Missing 'ok' field in response - FAILING SAFE");
      throw new Error("Fixture detector response missing required 'ok' field");
    }

    return {
      ok: parsed.ok,
      reason: parsed.reason || undefined,
      details: parsed.details || undefined
    };
  } catch (error) {
    console.error("[FIXTURE DETECTOR] Error:", error);
    // Fail safe: if we can't verify fixtures are preserved, reject the edit
    throw error;
  }
}
