import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";

// Stage 1A: quality enhancement (exposure/denoise/straighten) preserving structure
export async function runStage1A(originalPath: string): Promise<string> {
  let out = originalPath;
  try {
    const ai = getGeminiClient();
    const { data, mime } = toBase64(originalPath);
    const { resp } = await runWithImageModelFallback(ai as any, {
      contents: [
        { inlineData: { mimeType: mime, data } },
        { text: [
          "POLISH ONLY. Improve exposure, contrast, white balance, and sharpness.",
          "Fix perspective slightly if needed, but DO NOT alter walls/doors/windows.",
          "Remove sensor noise and compression artifacts. Maintain natural look.",
          "Return only the enhanced image.",
        ].join("\n") }
      ]
    } as any, "stage1A");

    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => p.inlineData);
    if (!img?.inlineData?.data) return originalPath; // fallback passthrough
    out = siblingOutPath(originalPath, "-1A", ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    return out;
  } catch {
    return out; // passthrough on error
  }
}
