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
  try {
    const ai = getGeminiClient();
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

    const { resp } = await runWithImageModelFallback(ai as any, {
      contents: requestParts,
      generationConfig: profile?.seed !== undefined ? { seed: profile.seed } : undefined,
    } as any, "stage2");
    const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    const img = responseParts.find(p => p.inlineData);
    if (!img?.inlineData?.data) return basePath;
    out = siblingOutPath(basePath, "-2", ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    return out;
  } catch {
    return out;
  }
}
