import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";

// Stage 1B: declutter / depersonalize / remove small items
export async function runStage1B(
  stage1APath: string,
  opts: { sceneType: string }
): Promise<string> {
  let out = stage1APath;
  try {
    const ai = getGeminiClient();
    const { data, mime } = toBase64(stage1APath);
    const guidance = opts.sceneType === "exterior"
      ? "Tidy garden, remove cars/trash bins/signage; keep architecture intact"
      : "Depersonalize: remove wall art, family photos, counter clutter, window-sill items; keep walls/windows/doors unchanged";
    const { resp } = await runWithImageModelFallback(ai as any, {
      contents: [
        { inlineData: { mimeType: mime, data } },
        { text: [
          "DECLUTTER ONLY. Remove small objects and personal items.",
          guidance,
          "Do NOT modify fixed architectural elements. Maintain room geometry.",
          "Return only the cleaned image.",
        ].join("\n") }
      ]
    } as any, "stage1B");
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => p.inlineData);
    if (!img?.inlineData?.data) return stage1APath;
    out = siblingOutPath(stage1APath, "-1B", ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    return out;
  } catch {
    return out;
  }
}
