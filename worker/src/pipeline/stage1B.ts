import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";

/**
 * Stage 1B: Furniture & Clutter Removal
 * 
 * Takes the enhanced output from Stage 1A and removes ALL furniture, decor, and clutter
 * to create an empty room ready for virtual staging.
 * 
 * Pipeline: Sharp → Stage 1A (Gemini enhance) → Stage 1B (Gemini declutter) → Stage 2 (Gemini stage)
 * 
 * The output is an empty, decluttered room with preserved architecture, ready for Stage 2 staging.
 */
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType, roomType } = options;
  
  console.log(`[stage1B] 🔵 Starting furniture & clutter removal...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Options: sceneType=${sceneType}`);
  
  try {
    // Call Gemini with declutter-only prompt (Stage 1A already enhanced)
    console.log(`[stage1B] 🤖 Calling Gemini to remove furniture and clutter...`);
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
      // NZ explicit 1B prompt (preserves curtains/blinds)
      promptOverride: buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
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
      const { validateStageOutput } = await import("../validators/runValidation");
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const base = canonicalPath || stage1APath;
      const verdict = await validateStageOutput("1B", (sceneType === 'interior' ? 'interior' : 'exterior') as any, base, declutteredPath);
      if (!verdict.ok) {
        console.warn(`[stage1B] ❌ Validation failed: ${verdict.reason} ${verdict.message ? '('+verdict.message+')' : ''}`);
        console.log(`[stage1B] 🔁 Retrying Gemini with strictMode...`);
        const retryPath = await enhanceWithGemini(stage1APath, {
          skipIfNoApiKey: true,
          replaceSky,
          declutter: true,
          sceneType,
          stage: "1B",
          strictMode: true,
          // Tighten sampling on retry
          temperature: 0.20,
          topP: 0.65,
          topK: 32,
          promptOverride: buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
          floorClean: sceneType === "interior",
          hardscapeClean: sceneType === "exterior",
          declutterIntensity: (global as any).__jobDeclutterIntensity || undefined,
          ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
        });
        if (retryPath !== stage1APath) {
          const retryVerdict = await validateStageOutput("1B", (sceneType === 'interior' ? 'interior' : 'exterior') as any, base, retryPath);
          if (retryVerdict.ok) {
            console.log(`[stage1B] ✅ Retry passed validation`);
            const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
            const fs = await import("fs/promises");
            await fs.rename(retryPath, outputPath);
            console.log(`[stage1B] ✅ SUCCESS - Furniture removal complete: ${outputPath}`);
            return outputPath;
          }
          console.warn(`[stage1B] ❌ Retry still failed validation: ${retryVerdict.reason} ${retryVerdict.message ? '('+retryVerdict.message+')' : ''}`);
          console.error(`[stage1B] CRITICAL: Validation failed`);
          throw new Error(`Stage 1B validation failed: ${retryVerdict.reason}`);
        } else {
          console.warn(`[stage1B] ❌ Retry did not produce image.`);
          throw new Error('Stage 1B retry failed to generate image');
        }
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
