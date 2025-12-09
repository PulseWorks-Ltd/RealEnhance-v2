import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";

/**
 * Stage 1B: Furniture & Clutter Removal
 * 
 * Takes the enhanced output from Stage 1A and removes furniture/clutter based on mode:
 * - "light": Removes clutter/mess only, keeps all main furniture
 * - "stage-ready": Removes ALL furniture and clutter to create empty room
 * 
 * Pipeline: Sharp → Stage 1A (Gemini enhance) → Stage 1B (Gemini declutter) → Stage 2 (Gemini stage)
 * 
 * The output is either a tidied room (light) or empty room (stage-ready), ready for Stage 2 staging.
 */
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
    declutterMode?: "light" | "stage-ready";
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType, roomType, declutterMode = "stage-ready" } = options;
  
  console.log(`[stage1B] 🔵 Starting furniture & clutter removal...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Options: sceneType=${sceneType}, mode=${declutterMode}`);
  
  try {
    // Select prompt based on declutter mode
    const promptOverride = declutterMode === "light"
      ? buildLightDeclutterPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any)
      : buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any);
    
    // Debug logging for mode resolution
    console.log("[stage1B] Declutter mode resolved:", {
      declutter: true,
      declutterMode: declutterMode,
      promptUsed: declutterMode === "light" ? "light" : "stage-ready"
    });
    
    console.log(`[stage1B] 🤖 Calling Gemini in ${declutterMode} mode...`);
    // Call Gemini with declutter-only prompt (Stage 1A already enhanced)
    const declutteredPath = await enhanceWithGemini(stage1APath, {
      skipIfNoApiKey: true,
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B",
      // Low-temp for deterministic, aggressive removal
      temperature: 0.30,
      topP: 0.70,
      topK: 32,
      // NZ explicit 1B prompt (mode-specific)
      promptOverride,
      // When decluttering, allow interior floor cleanup and exterior hardscape cleanup
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: (global as any).__jobDeclutterIntensity || undefined,
      ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
    });
    
    console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, validate against canonical base (not 1A)
    if (declutteredPath !== stage1APath) {
      const { validateStageOutput } = await import("../validators/index.js");
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const base = canonicalPath || stage1APath;
      const verdict1 = await validateStageOutput("stage1B", base, declutteredPath, { sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any, roomType });
      // Soft mode: log verdict, always proceed
      console.log(`[stage1B] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      const jobId = (global as any).__jobId || "default";
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const maskPath = await loadOrComputeStructuralMask(jobId, base);
      const masks = { structuralMask: maskPath };
      const verdict2 = await validateStage1BStructural(base, declutteredPath, masks);
      console.log(`[stage1B] Structural validator verdict:`, verdict2);
      if (!verdict2.ok) {
        console.warn(`[stage1B] HARD FAIL: ${verdict2.reason}`);
      }
      const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
      const fs = await import("fs/promises");
      console.log(`[stage1B] 💾 Renaming Gemini output to Stage1B: ${declutteredPath} → ${outputPath}`);
      await fs.rename(declutteredPath, outputPath);
      console.log(`[stage1B] ✅ SUCCESS - Furniture removal complete: ${outputPath}`);
      return outputPath;
    }
    
    // Fallback: If Gemini unavailable, use Sharp-based gentle cleanup
    console.log(`[stage1B] ⚠️ Gemini unavailable or skipped, using Sharp fallback`);
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    console.log(`[stage1B] ℹ️ Sharp fallback complete: ${out}`);
    return out;
    
  } catch (error) {
    console.error(`[stage1B] Error during declutter:`, error);
    // Fallback to Sharp on error
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    return out;
  }
}
