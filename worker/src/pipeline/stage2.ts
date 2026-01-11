import { getGeminiClient } from "../ai/gemini";
import { runWithPrimaryThenFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { runOpenCVStructuralValidator } from "../validators/index";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";
import { getStagingStyleDirective } from "../ai/stagingStyles";
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
    stagingStyle?: string;
    // Optional callback to surface strict retry status to job updater
    onStrictRetry?: (info: { reasons: string[] }) => void;
  }
): Promise<string> {
  let out = basePath;
  const dbg = process.env.STAGE2_DEBUG === "1";
  const validatorNotes: any[] = [];
  let retryCount = 0;
  let needsRetry = false;
  let lastValidatorResults: any = {};
  let tempMultiplier = 1.0;
  let strictPrompt = false;
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

  // Run OpenCV validator after Stage 1B (before staging)
  try {
    const imageBuffer = await sharp(basePath).toBuffer();
    const result1B = await runOpenCVStructuralValidator(imageBuffer, { strict: !!process.env.STRICT_STRUCTURE_VALIDATION });
    validatorNotes.push({ stage: '1B', validator: 'OpenCV', result: result1B });
    lastValidatorResults['1B'] = result1B;
    if (!result1B.ok) needsRetry = true;
  } catch (e) {
    validatorNotes.push({ stage: '1B', validator: 'OpenCV', error: String(e) });
    lastValidatorResults['1B'] = { ok: false, error: String(e) };
    needsRetry = true;
  }

  // Check API key before attempting Gemini calls
  if (!process.env.REALENHANCE_API_KEY) {
    console.warn(`[stage2] ⚠️ No REALENHANCE_API_KEY set – skipping (using ${baseStage} output)`);
    return out;
  }

  if (dbg) console.log(`[stage2] starting with roomType=${opts.roomType}, base=${basePath}`);

  // Only allow a single retry if validators fail
  for (let attempt = 0; attempt < 2; attempt++) {
    needsRetry = false;
    let inputForStage2 = out;
    if (opts.stagingRegion) {
      try {
        const meta = await sharp(out).metadata();
        const W = meta.width || 0;
        const H = meta.height || 0;
        const r = opts.stagingRegion;
        const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, W - 1)));
        const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, H - 1)));
        const w = Math.max(1, Math.min(Math.floor(r.width), W - x));
        const h = Math.max(1, Math.min(Math.floor(r.height), H - y));
        const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } } }).toBuffer();
        const regionPatch = await sharp(out).extract({ left: x, top: y, width: w, height: h }).toBuffer();
        const guided = await sharp(out)
          .composite([
            { input: overlay, left: 0, top: 0 },
            { input: regionPatch, left: x, top: y }
          ])
          .toFormat("png")
          .toBuffer();
        const guidedPath = siblingOutPath(out, "-staging-guide", ".png");
        await sharp(guided).toFile(guidedPath);
        inputForStage2 = guidedPath;
        if (dbg) console.log(`[stage2] Built guided input for staging region: ${guidedPath}`);
      } catch (e) {
        console.warn("[stage2] Failed to build guided staging input; proceeding with original base image", e);
      }
    }

    // Build prompt and call Gemini
    const scene = opts.sceneType || "interior";
    const { data, mime } = toBase64(inputForStage2);
    const profile = opts.profile;
    const useTest = process.env.USE_TEST_PROMPTS === "1";
    // Log incoming staging style from options (before prompt assembly)
    const stagingStyleRaw: any = (opts as any)?.stagingStyle;
    console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
    const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === "string"
      ? stagingStyleRaw.trim()
      : "none";

    let textPrompt = useTest
      ? require("../ai/prompts-test").buildTestStage2Prompt(scene, opts.roomType)
      : buildStage2PromptNZStyle(opts.roomType, scene, { stagingStyle: stagingStyleNorm });
    // Build a high-priority staging style directive (system-like block)
    const styleDirective = stagingStyleNorm !== "none" ? getStagingStyleDirective(stagingStyleNorm) : "";
    if (useTest) {
      textPrompt = require("../ai/prompts-test").buildTestStage2Prompt(scene, opts.roomType);
    }
    // On retry, make prompt stricter
    if (attempt === 1) {
      textPrompt += "\n\nSTRICT VALIDATION: Please ensure the output strictly matches the requested room type and scene, and correct any structural issues.";
      tempMultiplier = 0.8;
      strictPrompt = true;
    }
    const requestParts: any[] = [];
    // Always include the primary input image first
    requestParts.push({ inlineData: { mimeType: mime, data } });
    // Optional reference image (kept immediately after the primary image)
    if (opts.referenceImagePath) {
      const ref = toBase64(opts.referenceImagePath);
      requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
    }
    // Insert the style directive as a separate text part before the main prompt
    if (styleDirective) {
      requestParts.push({ text: styleDirective });
    }
    // Finally, add the main prompt
    requestParts.push({ text: textPrompt });
    if (dbg) {
      const combinedPrompt = styleDirective + "\n\n" + textPrompt;
      const preview = combinedPrompt.slice(0, 1000);
      console.log(`[stage2] [PROMPT_ASSEMBLED] stagingStyle=${stagingStyleNorm} len=${combinedPrompt.length}\n${preview}${combinedPrompt.length > 1000 ? '\n...[truncated]' : ''}`);
      console.info("[stage2][PROMPT_ASSEMBLED]", {
        stagingStyle: stagingStyleNorm,
        len: combinedPrompt.length,
        preview: combinedPrompt.slice(0, 400),
      });
    }
    if (dbg) console.log("[stage2] invoking Gemini with roomType=%s", opts.roomType);
    console.log(`[stage2] 🤖 Calling Gemini API for virtual staging... (attempt ${attempt + 1}${strictPrompt ? ' [STRICT]' : ''})`);
    try {
      let ai: any = null;
      ai = getGeminiClient();
      if (!ai) throw new Error("getGeminiClient returned null/undefined");
      const apiStartTime = Date.now();
      let generationConfig: any = useTest ? (profile?.seed !== undefined ? { seed: profile.seed } : undefined) : (profile?.seed !== undefined ? { seed: profile.seed } : undefined);
      if (isNZStyleEnabled()) {
        const preset = scene === 'interior' ? NZ_REAL_ESTATE_PRESETS.stage2Interior : NZ_REAL_ESTATE_PRESETS.stage2Exterior;
        let temperature = preset.temperature;
        if (attempt === 1) temperature = Math.max(0.01, temperature * 0.8);
        generationConfig = { ...(generationConfig || {}), temperature, topP: preset.topP, topK: preset.topK };
      }
      // ✅ Stage 2 uses Gemini 3 → fallback to 2.5 on failure
      const { resp, modelUsed } = await runWithPrimaryThenFallback({
        stageLabel: "2",
        ai: ai as any,
        baseRequest: {
          contents: requestParts,
          generationConfig,
        } as any,
        context: "stage2",
      });
      const apiElapsed = Date.now() - apiStartTime;
      console.log(`[stage2] ✅ Gemini API responded in ${apiElapsed} ms (model=${modelUsed})`);
      const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      console.log(`[stage2] 📊 Response parts: ${responseParts.length}`);
      const img = responseParts.find(p => p.inlineData);
      if (!img?.inlineData?.data) {
        validatorNotes.push({ stage: '2', validator: 'Gemini', error: 'No image data in Gemini response' });
        if (dbg) console.log("[stage2] no image in response → using previous output");
        break;
      }
      const candidatePath = siblingOutPath(out, `-2-retry${attempt + 1}`, ".webp");
      writeImageDataUrl(candidatePath, `data:image/webp;base64,${img.inlineData.data}`);
      out = candidatePath;
      console.log(`[stage2] 💾 Saved staged image to: ${candidatePath}`);

      // Run validators after Stage 2
      let validatorFailed = false;
      // OpenCV validator
      try {
        const stagedBuffer = await sharp(out).toBuffer();
        const result2 = await runOpenCVStructuralValidator(stagedBuffer, { strict: !!process.env.STRICT_STRUCTURE_VALIDATION });
        validatorNotes.push({ stage: '2', validator: 'OpenCV', result: result2 });
        lastValidatorResults['2'] = result2;
        if (!result2.ok) validatorFailed = true;
      } catch (e) {
        validatorNotes.push({ stage: '2', validator: 'OpenCV', error: String(e) });
        lastValidatorResults['2'] = { ok: false, error: String(e) };
        validatorFailed = true;
      }
      // Gemini-based validators (DISCONNECTED)
      // const validationResult = await validateStage2Structural(...);
      // if (!validationResult.ok) { validatorFailed = true; }

      if (validatorFailed && attempt === 0) {
        needsRetry = true;
        retryCount++;
        console.log(`[stage2] Validator requested retry (single retry)`);
        continue;
      } else {
        break;
      }
    } catch (e: any) {
      validatorNotes.push({ stage: '2', validator: 'Gemini', error: String(e) });
      lastValidatorResults['2'] = { ok: false, error: String(e) };
      console.error("[stage2] ❌ Gemini API error:", e?.message || String(e));
      break;
    }
  }
  // After retry, always return the last output and notes
  return out;
}
