import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";

/**
 * Stage 1B: Declutter (combined with enhancement)
 * 
 * When declutter is requested, this stage calls Gemini with a combined
 * enhance+declutter prompt in ONE API call (saving cost vs separate calls).
 * 
 * IMPORTANT: The input should be the Sharp pre-processed image (1A output when declutter=true).
 * Stage1A skips Gemini enhancement when declutter=true, so this stage does BOTH
 * enhancement AND decluttering in a single Gemini call.
 * 
 * The output is both enhanced AND decluttered, ready for optional staging.
 */
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType } = options;
  
  console.log(`[stage1B] 🔵 Starting combined Gemini enhance+declutter...`);
  console.log(`[stage1B] Input (Stage1A): ${stage1APath}`);
  console.log(`[stage1B] Options: replaceSky=${replaceSky}, sceneType=${sceneType}`);
  
  try {
    // Call Gemini with combined enhance+declutter prompt
    // This saves one API call compared to separate enhance → declutter
    console.log(`[stage1B] 🤖 Calling Gemini with COMBINED enhance+declutter prompt...`);
    const declutteredPath = await enhanceWithGemini(stage1APath, {
      skipIfNoApiKey: true,
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B",
    });
    
    console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, rename to Stage1B output
    if (declutteredPath !== stage1APath) {
      const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
      const fs = await import("fs/promises");
      console.log(`[stage1B] 💾 Renaming Gemini output to Stage1B: ${declutteredPath} → ${outputPath}`);
      await fs.rename(declutteredPath, outputPath);
      console.log(`[stage1B] ✅ SUCCESS - Combined enhance+declutter complete: ${outputPath}`);
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
