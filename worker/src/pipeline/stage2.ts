import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";

// Stage 2: virtual staging (add furniture)
export async function runStage2(
  basePath: string,
  opts: { roomType: string }
): Promise<string> {
  let out = basePath;
  try {
    const ai = getGeminiClient();
    const { data, mime } = toBase64(basePath);
    const style = "modern, cohesive palette (gray/white/natural wood), realistic lighting, correct perspective";
    const placement = "Respect door/window clearance (≥1m). Keep traffic flow. Do not alter walls/windows/doors.";
    const roomSpecific = `Stage as a ${opts.roomType || 'living room'} with appropriate furniture.`;
    const { resp } = await runWithImageModelFallback(ai as any, {
      contents: [
        { inlineData: { mimeType: mime, data } },
        { text: [
          "VIRTUAL STAGING.",
          roomSpecific,
          style,
          placement,
          "Remove existing décor/furniture if needed to avoid mixing styles.",
          "Return only the staged image.",
        ].join("\n") }
      ]
    } as any, "stage2");
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => p.inlineData);
    if (!img?.inlineData?.data) return basePath;
    out = siblingOutPath(basePath, "-2", ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    return out;
  } catch {
    return out;
  }
}
