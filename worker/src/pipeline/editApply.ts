import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { siblingOutPath, writeImageDataUrl } from "../utils/images";
import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";
import { readJsonFile, writeJsonFile } from "../../../shared/src/jsonStore.js";

function isDataUrl(s: any): s is string {
  return (
    typeof s === "string" &&
    /^data:image\/(png|jpeg|jpg|webp);base64,/.test(s)
  );
}

function decodeDataUrl(dataUrl: string): Buffer {
  const [, base64] = dataUrl.split(",");
  return Buffer.from(base64, "base64");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function applyEdit(params: {
  baseImagePath: string;
  mask: unknown; // expected: data URL string (white=edit/restore region, black=preserve)
  mode: "edit" | "restore_original" | "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  restoreFromPath?: string;
  smartReinstate?: boolean;
}): Promise<string> {
  const {
    baseImagePath,
    mask,
    mode,
    instruction,
    restoreFromPath,
    smartReinstate,
  } = params;

  // 1. Validate base image path 
  if (!baseImagePath || !(await fileExists(baseImagePath))) {
    console.error("[editApply] Base image missing:", baseImagePath);
    throw new Error("Base image not found for edit");
  }

  // 2. Handle restore-only modes early
  if (mode === "restore_original" || mode === "Restore") {
    // If a specific restore source is supplied, prefer that
    if (restoreFromPath && (await fileExists(restoreFromPath))) {
      console.log("[editApply] restore_original using restoreFromPath:", restoreFromPath);
      return restoreFromPath;
    }
    console.log("[editApply] restore_original with no restoreFromPath, returning base image.");
    return baseImagePath;
  }

  // 3. Validate instruction for edit modes
  if (!instruction || !instruction.trim()) {
    console.warn("[editApply] No instruction supplied for edit mode, returning base image.");
    return baseImagePath;
  }


  // 4. Robust mask handling: accept Buffer, data URL, file path, or raw base64
  let maskBuf: Buffer | null = null;
  if (!mask) {
    console.warn("[editApply] No mask provided, returning base image.");
    return baseImagePath;
  }
  if (Buffer.isBuffer(mask)) {
    maskBuf = mask;
  } else if (typeof mask === "string") {
    if (isDataUrl(mask)) {
      maskBuf = decodeDataUrl(mask);
    } else {
      // Try as file path
      try {
        if (await fileExists(mask)) {
          maskBuf = await fs.readFile(mask);
        } else {
          // Try as raw base64
          maskBuf = Buffer.from(mask, "base64");
        }
      } catch {
        console.warn("[editApply] Mask string not data URL / path / base64; returning base.");
        return baseImagePath;
      }
    }
  } else {
    console.warn("[editApply] Mask is not a string or Buffer; returning base image.");
    return baseImagePath;
  }


  if (!maskBuf || maskBuf.length === 0) {
    console.warn("[editApply] Mask buffer empty, returning base image.");
    return baseImagePath;
  }
  // Log mask buffer length for debugging
  console.info("[editApply] mask buffer length:", maskBuf.length);

  // 5. Inspect mask with sharp – reject uniform / invalid masks
  try {
    const stats = await sharp(maskBuf).stats();
    const ch = stats.channels[0];
    if (ch.min === ch.max) {
      console.warn("[editApply] Mask is uniform (all black/white), skipping edit.");
      return baseImagePath;
    }
  } catch (err) {
    console.warn("[editApply] Mask stats failed, treating mask as invalid:", err);
    return baseImagePath;
  }

  // 6. Read base image as buffer for Gemini
  let baseBuf: Buffer;
  try {
    baseBuf = await fs.readFile(baseImagePath);
  } catch (err) {
    console.error("[editApply] Failed reading base image:", err);
    throw new Error("Failed to read base image");
  }

  const baseExt = path.extname(baseImagePath).toLowerCase();
  const baseMime =
    baseExt === ".png"
      ? "image/png"
      : baseExt === ".webp"
      ? "image/webp"
      : "image/jpeg";

  const baseB64 = baseBuf.toString("base64");
  const maskB64 = maskBuf.toString("base64");

  // 7. Build prompt based on mode
  const modeLabel =
    mode === "Add" || mode === "Remove" || mode === "Replace"
      ? mode
      : "Edit";

  const prompt = [
    "You are a professional real estate photo editor.",
    "Perform a high-quality regional edit on the masked area of this image.",
    "",
    `Edit mode: ${modeLabel}.`,
    "Masked region (white) is where you are allowed to change the image.",
    "Unmasked region (black) must remain structurally identical.",
    "",
    "Rules:",
    "- Do not change walls, ceilings, floors, windows, or doors outside the masked region.",
    "- Do not change the room layout or camera perspective.",
    "- Keep lighting, angles, and major architectural elements consistent.",
    "",
    "User instruction:",
    instruction,
  ].join("\n");

  // 8. Call Gemini with fallback wrapper
  const client = getGeminiClient();

  let resp: any;
  try {
  const { resp: geminiResp } = await runWithImageModelFallback(
    client,
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: baseMime,
                data: baseB64,
              },
            },
            {
              inlineData: {
                mimeType: "image/png",
                data: maskB64,
              },
            },
          ],
        },
      ],
    },
    "editApply.regionEdit" // context label for logging
  );

  resp = geminiResp;
  } catch (err) {
  console.error("[editApply] Gemini call failed:", err);
  console.warn("[editApply] Falling back to original image due to model failure.");
  return baseImagePath;
  }

  // 9. Extract image output from Gemini response
  try {
    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    const img = parts.find(
      (p: any) =>
        p?.inlineData?.data &&
        /image\//.test((p.inlineData?.mimeType as string) || "")
    );

    if (img?.inlineData?.data) {
      const outPath = siblingOutPath(baseImagePath, "-edit", ".webp");
      writeImageDataUrl(outPath, `data:image/webp;base64,${img.inlineData.data}`);
      console.log("[applyEdit] Edit output saved:", outPath);
      return outPath;
    }

    console.warn(
      "[editApply] No inline image data in Gemini response, returning original image."
    );
    return baseImagePath;
  } catch (err) {
    console.error("[editApply] Failed to parse Gemini response:", err);
    return baseImagePath;
  }
}
