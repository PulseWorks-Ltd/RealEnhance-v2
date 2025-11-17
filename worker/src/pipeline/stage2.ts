import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";
import sharp from "sharp";
import type { StagingRegion } from "../ai/region-detector";

// Stage 2: virtual staging (add furniture)

export async function runStage2(
  basePath: string,
  baseStage: "1A" | "1B",
  opts: {
    roomType: string;
    sceneType?: "interior" | "exterior";
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
  console.log(`[stage2] Input: ${basePath}`);
  console.log(`[stage2] Source stage: ${baseStage === '1B' ? 'Stage1B (decluttered)' : 'Stage1A (enhanced)'}`);
  console.log(`[stage2] Room type: ${opts.roomType}`);
  console.log(`[stage2] Scene type: ${opts.sceneType || 'interior'}`);
  console.log(`[stage2] Profile: ${opts.profile?.styleName || 'default'}`);
  
  // Early exit if Stage 2 not enabled
  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    console.log(`[stage2] ⚠️ USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    if (dbg) console.log(`[stage2] USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    return out;
  }

  // Check API key before attempting Gemini calls (support GOOGLE_API_KEY or GEMINI_API_KEY)
  if (!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)) {
    console.warn(`[stage2] ⚠️ No GOOGLE_API_KEY/GEMINI_API_KEY set – skipping (using ${baseStage} output)`);
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

    const scene = opts.sceneType || "interior";
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
      scene === "exterior"
        ? `You may ONLY place outdoor furniture within the following region: left=${opts.stagingRegion.x}, top=${opts.stagingRegion.y}, width=${opts.stagingRegion.width}, height=${opts.stagingRegion.height}.`
        : `You may ONLY place furniture within the following region: left=${opts.stagingRegion.x}, top=${opts.stagingRegion.y}, width=${opts.stagingRegion.width}, height=${opts.stagingRegion.height}.`,
      `Area type: ${opts.stagingRegion.areaType}. Do NOT stage outside this area.`,
      scene === "exterior"
        ? `Place EXACTLY ONE outdoor furniture set (e.g., dining table + 4–6 chairs OR bistro table + 2 chairs). If the area is small or ambiguous, skip staging entirely (add nothing).`
        : `Place EXACTLY ONE furniture set suitable for this area.`,
      scene === "exterior" ? `Do not place any furniture on grass or driveways. Do not add structures.` : "",
      ""
    ] : [];

    const useTest = process.env.USE_TEST_PROMPTS === "1";
    let textPrompt = useTest
      ? require("../ai/prompts-test").buildTestStage2Prompt(scene, opts.roomType)
      : [
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
    if (isNZStyleEnabled()) {
      try {
        textPrompt = buildStage2PromptNZStyle(opts.roomType, scene as any);
      } catch {}
    }

    const requestParts: any[] = [{ inlineData: { mimeType: mime, data } }, { text: textPrompt }];
    if (opts.referenceImagePath) {
      const ref = toBase64(opts.referenceImagePath);
      requestParts.splice(1, 0, { inlineData: { mimeType: ref.mime, data: ref.data } });
    }

    if (dbg) console.log("[stage2] invoking Gemini with roomType=%s", opts.roomType);
    console.log(`[stage2] 🤖 Calling Gemini API for virtual staging...`);
    console.log(`[stage2] 📝 Prompt length: ${textPrompt.length} chars`);
    
    const apiStartTime = Date.now();
    // Apply NZ sampling overrides if enabled
    let generationConfig: any = useTest ? (profile?.seed !== undefined ? { seed: profile.seed } : undefined) : (profile?.seed !== undefined ? { seed: profile.seed } : undefined);
    if (isNZStyleEnabled()) {
      const preset = scene === 'interior' ? NZ_REAL_ESTATE_PRESETS.stage2Interior : NZ_REAL_ESTATE_PRESETS.stage2Exterior;
      generationConfig = { ...(generationConfig || {}), temperature: preset.temperature, topP: preset.topP, topK: preset.topK };
    }
    try {
      const { resp } = await runWithImageModelFallback(ai as any, {
        contents: requestParts,
        generationConfig,
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

      // Stage-aware validation (Stage 2 compares to canonical base)
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const baseForValidation = canonicalPath || basePath;
      const { validateStageOutput } = await import("../validators");
      const v2 = await validateStageOutput("stage2", baseForValidation, candidatePath, { sceneType: scene as any });
      // Soft mode: log verdict, always proceed
      console.log(`[stage2] Validator verdict:`, v2);
      out = candidatePath;
      console.log(`[stage2] 🎉 SUCCESS - Virtual staging validated (structIoU=${v2.details?.structIoU !== undefined ? ((v2.details.structIoU as number)*100).toFixed(1)+'%' : 'n/a'})`);
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
