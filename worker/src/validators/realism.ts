import { getValidatorMode, isValidatorEnabled } from "./validatorMode";

export async function validateRealism(
  finalPath: string
): Promise<{ ok: boolean; notes?: string[]; disabled?: boolean }> {
  // Check if realism validator is enabled
  const mode = getValidatorMode("realism");

  if (!isValidatorEnabled("realism")) {
    console.log("[realism-validator] Realism validator disabled (mode=off)");
    return {
      ok: true,
      notes: ["Realism validator disabled - skipping Gemini check"],
      disabled: true,
    };
  }

  // IMPORTANT: Gemini-based validators must remain disabled for now
  // This is a safety measure to prevent Gemini API calls during log-only testing
  console.warn("[realism-validator] Gemini-based realism validator is DISABLED by design");
  console.warn("[realism-validator] This validator will be re-enabled after log-only testing phase");
  return {
    ok: true,
    notes: ["Gemini-based realism validator temporarily disabled"],
    disabled: true,
  };

  /* DISABLED CODE - Will be re-enabled after log-only testing
  // Use Gemini to check realism: furniture scale, lighting, floating objects
  const { buildRealismPrompt } = await import('./realism-prompt.js');
  const { getGeminiClient } = await import('../ai/gemini.js');
  const prompt = buildRealismPrompt();
  const ai = getGeminiClient();
  const { toBase64 } = await import('../utils/images.js');
  const { data, mime } = toBase64(finalPath);
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      { inlineData: { mimeType: mime, data } },
      { text: prompt }
    ]
  });
  const parts = resp.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => p.text);
    if (!textPart || !textPart.text) {
      throw new Error(
        "[realism] No text content returned from Gemini realism validator"
      );
    }
  if (!textPart) return { ok: true, notes: ["No AI response"] };
  let result: any = {};
  try {
    result = JSON.parse(textPart.text.trim());
  } catch {
    return { ok: true, notes: ["Failed to parse AI realism response"] };
  }
  const ok = !!result.furnitureScaleOk && !!result.lightingOk && !result.floatingObjects;
  const notes = [
    result.scaleDescription,
    result.lightingDescription,
    result.floatingDescription,
    ...(Array.isArray(result.notes) ? result.notes : [])
  ].filter(Boolean);
  return { ok, notes };
  */
}
