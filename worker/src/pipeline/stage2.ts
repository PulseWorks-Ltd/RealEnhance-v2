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
  
  console.log(`[stage2] 🔵 Starting virtual staging...`);
  console.log(`[stage2] Input (Stage1B): ${basePath}`);
  console.log(`[stage2] Room type: ${opts.roomType}`);
  console.log(`[stage2] Profile: ${opts.profile?.styleName || 'default'}`);
  
  // Early exit if Stage 2 not enabled
  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    console.log("[stage2] ⚠️ USE_GEMINI_STAGE2!=1 → skipping (using Stage1B output)");
    if (dbg) console.log("[stage2] USE_GEMINI_STAGE2!=1 → skipping (using Stage 1 output)");
    return out;
  }

  // Check API key before attempting Gemini calls
  if (!process.env.GOOGLE_API_KEY) {
    console.warn("[stage2] ⚠️ No GOOGLE_API_KEY set – skipping (using Stage1B output)");
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
    console.log(`[stage2] 🤖 Calling Gemini API for virtual staging...`);
    console.log(`[stage2] 📝 Prompt length: ${textPrompt.length} chars`);
    
    const apiStartTime = Date.now();
    try {
      const { resp } = await runWithImageModelFallback(ai as any, {
        contents: requestParts,
        generationConfig: profile?.seed !== undefined ? { seed: profile.seed } : undefined,
      } as any, "stage2");
      
      const apiElapsed = Date.now() - apiStartTime;
      console.log(`[stage2] ✅ Gemini API responded in ${apiElapsed} ms`);
      
      const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      console.log(`[stage2] 📊 Response parts: ${responseParts.length}`);
      
      const img = responseParts.find(p => p.inlineData);
      if (!img?.inlineData?.data) {
        console.error("[stage2] ❌ ERROR: No image data in Gemini response!");
        console.error("[stage2] Response parts:", JSON.stringify(responseParts, null, 2));
        if (dbg) console.log("[stage2] no image in response → using Stage 1 output");
        return out;
      }
      console.log(`[stage2] ✓ Found staged image in response`);
      
      out = siblingOutPath(basePath, "-2", ".webp");
      writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
      console.log(`[stage2] 💾 Saved staged image to: ${out}`);
      console.log(`[stage2] 🎉 SUCCESS - Virtual staging complete: ${out}`);
      if (dbg) console.log("[stage2] success → %s", out);
      return out;
    } catch (e: any) {
      console.error("[stage2] ❌ Gemini API error:", e?.message || String(e));
      console.error("[stage2] Error details:", JSON.stringify(e, null, 2));
      if (dbg) console.log("[stage2] → using Stage 1 output instead");
      return out;
    }
  } catch (e: any) {
    console.error("[stage2] Unexpected error:", e?.message || String(e));
    return out;
  }
}
