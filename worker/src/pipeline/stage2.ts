import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import sharp from "sharp";
import type { StagingRegion } from "../ai/region-detector";

// Stage 2: virtual staging (add furniture)

export async function runStage2(
  basePath: string,
  opts: {
    roomType: string;
    profile?: StagingProfile;
    angleHint?: "primary" | "secondary" | "other";
    referenceImagePath?: string;
    stagingRegion?: StagingRegion | null;
    // Optional callback to surface strict retry status to job updater
    onStrictRetry?: (info: { reasons: string[] }) => void;
  }
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

  // Check API key before attempting Gemini calls (support GOOGLE_API_KEY or GEMINI_API_KEY)
  if (!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)) {
    console.warn("[stage2] ⚠️ No GOOGLE_API_KEY/GEMINI_API_KEY set – skipping (using Stage1B output)");
    console.warn("[stage2] No GOOGLE_API_KEY/GEMINI_API_KEY set – skipping (using Stage 1 output)");
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

    // If a stagingRegion is provided, build a "guided" input that darkens outside the region
    let inputForStage2 = basePath;
    if (opts.stagingRegion) {
      try {
        const meta = await sharp(basePath).metadata();
        const W = meta.width || 0;
        const H = meta.height || 0;
        const r = opts.stagingRegion;
        const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, W - 1)));
        const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, H - 1)));
        const w = Math.max(1, Math.min(Math.floor(r.width), W - x));
        const h = Math.max(1, Math.min(Math.floor(r.height), H - y));

        // Build a full-frame semi-transparent black overlay to darken entire frame
        const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } } }).toBuffer();
        // Extract original region to restore brightness inside the staging rect
        const regionPatch = await sharp(basePath).extract({ left: x, top: y, width: w, height: h }).toBuffer();

        const guided = await sharp(basePath)
          .composite([
            { input: overlay, left: 0, top: 0 },
            { input: regionPatch, left: x, top: y }
          ])
          .toFormat("png")
          .toBuffer();

        const guidedPath = siblingOutPath(basePath, "-staging-guide", ".png");
        await sharp(guided).toFile(guidedPath);
        inputForStage2 = guidedPath;
        if (dbg) console.log(`[stage2] Built guided input for staging region: ${guidedPath}`);
      } catch (e) {
        console.warn("[stage2] Failed to build guided staging input; proceeding with original base image", e);
      }
    }

    const { data, mime } = toBase64(inputForStage2);
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

    const regionRules = opts.stagingRegion ? [
      "[STAGING REGION]",
      `You may ONLY place outdoor furniture within the following region: left=${opts.stagingRegion.x}, top=${opts.stagingRegion.y}, width=${opts.stagingRegion.width}, height=${opts.stagingRegion.height}.`,
      `Area type: ${opts.stagingRegion.areaType}. Do NOT stage outside this area.`,
      `Place EXACTLY ONE furniture set suitable for this area (e.g., dining table + 4–6 chairs OR side table + 2 chairs) and up to 3 small pot plants on hard surfaces only.`,
      `Do not place any furniture on grass or driveways. Do not add structures.`,
      ""
    ] : [];

    const textPrompt = [
      "VIRTUAL STAGING.",
      roomSpecific,
      baseStyle,
      placement,
      consistency,
      angleInstruction,
      ...regionRules,
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
      
      const candidatePath = siblingOutPath(basePath, "-2", ".webp");
      writeImageDataUrl(candidatePath, `data:image/webp;base64,${img.inlineData.data}`);
      console.log(`[stage2] 💾 Saved staged image to: ${candidatePath}`);

      // Validate staged result vs base
      const verdict = await validateStage(
        { stage: "1B", path: basePath },
        { stage: "2", path: candidatePath },
        { sceneType: "interior", roomType: opts.roomType }
      );
      if (!verdict.ok) {
        console.warn(`[stage2] ❌ Validation failed (score=${verdict.score.toFixed(2)}). Attempting strict retry...`);
        try {
          // Notify upstream (worker) to update job meta/message for UI toast
          opts.onStrictRetry?.({ reasons: verdict.reasons || [] });
        } catch {}

        // Strict retry: reinforce architectural constraints and reduce sampling randomness
        const strictText = textPrompt + `\n\nSTRICT MODE (VALIDATION FAILED):\n` +
          [
            "• DO NOT alter architecture: no new walls, openings, or partitions.",
            "• DO NOT block doors/windows; maintain egress and ventilation.",
            "• LOCK camera viewpoint/perspective; match vanishing points and horizon.",
            "• Furniture must sit on existing floor plane with realistic scale and contact shadows.",
            "• Preserve all window counts and sizes; keep frames/positions unchanged.",
          ].join("\n");

        const strictParts: any[] = [{ inlineData: { mimeType: mime, data } }, { text: strictText }];
        if (opts.referenceImagePath) {
          const ref = toBase64(opts.referenceImagePath);
          strictParts.splice(1, 0, { inlineData: { mimeType: ref.mime, data: ref.data } });
        }

        try {
          const { resp: strictResp } = await runWithImageModelFallback(ai as any, {
            contents: strictParts,
            generationConfig: { ...(profile?.seed !== undefined ? { seed: profile.seed } : {}), temperature: 0.35, topP: 0.8, topK: 40 }
          } as any, "stage2");

          const strictPartsResp: any[] = (strictResp as any).candidates?.[0]?.content?.parts || [];
          const strictImg = strictPartsResp.find(p => p.inlineData);
          if (strictImg?.inlineData?.data) {
            const retryPath = siblingOutPath(basePath, "-2r", ".webp");
            writeImageDataUrl(retryPath, `data:image/webp;base64,${strictImg.inlineData.data}`);
            console.log(`[stage2] 💾 Saved strict retry image to: ${retryPath}`);

            const retryVerdict = await validateStage(
              { stage: "1B", path: basePath },
              { stage: "2", path: retryPath },
              { sceneType: "interior", roomType: opts.roomType }
            );
            if (retryVerdict.ok) {
              console.log(`[stage2] ✅ Strict retry passed validation (score=${retryVerdict.score.toFixed(2)})`);
              return retryPath;
            }
            console.warn(`[stage2] ❌ Strict retry failed validation (score=${retryVerdict.score.toFixed(2)}): ${retryVerdict.reasons.join('; ')}`);
            console.error(`[stage2] CRITICAL: Validation failed - ${retryVerdict.reasons.join('; ')}`);
            throw new Error(`Stage 2 validation failed: ${retryVerdict.reasons.join('; ')}`);
          } else {
            console.warn("[stage2] ❌ Strict retry produced no image.");
            throw new Error('Stage 2 strict retry failed to generate image');
          }
        } catch (e: any) {
          console.error("[stage2] Strict retry error:", e?.message || String(e));
          throw e;
        }

        if (dbg) console.log("[stage2] validation failed → throwing error");
        throw new Error(`Stage 2 validation failed (score=${verdict.score.toFixed(2)}): ${verdict.reasons.join('; ')}`);
      }

      out = candidatePath;
      console.log(`[stage2] 🎉 SUCCESS - Virtual staging validated (score=${verdict.score.toFixed(2)}): ${out}`);
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
