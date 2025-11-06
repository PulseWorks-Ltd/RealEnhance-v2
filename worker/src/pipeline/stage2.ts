import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";

// Stage 2: virtual staging (add furniture)

export async function runStage2(
  basePath: string,
  opts: { roomType: string; profile?: StagingProfile; angleHint?: "primary" | "secondary" | "other"; referenceImagePath?: string }
): Promise<string> {
  let out = basePath;
  const dbg = process.env.STAGE2_DEBUG === "1";
  
  // Early exit if Stage 2 not enabled
  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    if (dbg) console.log("[stage2] USE_GEMINI_STAGE2!=1 → skipping (using Stage 1 output)");
    return out;
  }

  // Check API key before attempting Gemini calls
  if (!process.env.GOOGLE_API_KEY) {
    console.warn("[stage2] No GOOGLE_API_KEY set – skipping (using Stage 1 output)");
    return out;
  }

  if (dbg) console.log(`[stage2] starting with roomType=${opts.roomType}, base=${basePath}`);

  try {
    // Initialize Gemini client
    let ai: any = null;
    try {
      ai = getGeminiClient();
      if (!ai) throw new Error("getGeminiClient returned null/undefined");
    } catch (e: any) {
      console.error("[stage2] Failed to initialize Gemini:", e?.message || String(e));
      if (dbg) console.log("[stage2] → using Stage 1 output instead");
      return out;
    }

    const { data, mime } = toBase64(basePath);
    const profile = opts.profile;
    const baseStyle = profile?.styleName
      ? `Style: ${profile.styleName}${profile.palette?.length ? ` | Palette: ${profile.palette.join(", ")}` : ""}`
      : "modern, cohesive palette (gray/white/natural wood), realistic lighting, correct perspective";
    const placement = "Respect door/window clearance (≥1m). Keep traffic flow. Do not alter walls/windows/doors.";
    const roomSpecific = `Stage as a ${opts.roomType || 'living room'} with appropriate furniture.`;
    const consistency = profile
      ? "Use the same furniture family, finish and overall vibe as the profile. Maintain consistency across angles."
      : "Maintain realistic, consistent staging across angles.";
    const angleInstruction = opts.angleHint === "secondary"
      ? "This photo is another angle of the same room. If a sofa is present in the hero angle, show the back of the same sofa facing a TV wall when appropriate."
      : "";

    const textPrompt = [
      "VIRTUAL STAGING.",
      roomSpecific,
      baseStyle,
      placement,
      consistency,
      angleInstruction,
      profile?.prompt?.trim() ? `Profile prompt: ${profile.prompt.trim()}` : "",
      profile?.negativePrompt?.trim() ? `Negative prompt: ${profile.negativePrompt.trim()}` : "",
      "Remove existing décor/furniture if needed to avoid mixing styles.",
      "Return only the staged image.",
    ].filter(Boolean).join("\n");

    const requestParts: any[] = [{ inlineData: { mimeType: mime, data } }, { text: textPrompt }];
    if (opts.referenceImagePath) {
      const ref = toBase64(opts.referenceImagePath);
      requestParts.splice(1, 0, { inlineData: { mimeType: ref.mime, data: ref.data } });
    }

    if (dbg) console.log("[stage2] invoking Gemini with roomType=%s", opts.roomType);
    try {
      const { resp } = await runWithImageModelFallback(ai as any, {
        contents: requestParts,
        generationConfig: profile?.seed !== undefined ? { seed: profile.seed } : undefined,
      } as any, "stage2");
      const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      const img = responseParts.find(p => p.inlineData);
      if (!img?.inlineData?.data) {
        if (dbg) console.log("[stage2] no image in response → using Stage 1 output");
        return out;
      }
      out = siblingOutPath(basePath, "-2", ".webp");
      writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
      if (dbg) console.log("[stage2] success → %s", out);
      return out;
    } catch (e: any) {
      console.error("[stage2] Gemini API error:", e?.message || String(e));
      if (dbg) console.log("[stage2] → using Stage 1 output instead");
      return out;
    }
  } catch (e: any) {
    console.error("[stage2] Unexpected error:", e?.message || String(e));
    return out;
  }
}
