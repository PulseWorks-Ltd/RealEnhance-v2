import sharp from "sharp";

export function normalizeMaskBase64(input: string): Buffer {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("mask_decode_failed: empty_mask_input");
  }

  const cleaned = input.startsWith("data:image/")
    ? input.split(",")[1] || ""
    : input;

  const decoded = Buffer.from(cleaned, "base64");
  if (!decoded || decoded.length === 0) {
    throw new Error("mask_decode_failed: empty_decoded_mask");
  }

  return decoded;
}

export async function normalizeMaskBufferToPng(maskBuffer: Buffer): Promise<Buffer> {
  if (!maskBuffer || maskBuffer.length === 0) {
    throw new Error("mask_decode_failed: zero_length_mask");
  }

  try {
    return await sharp(maskBuffer, { failOn: "error" })
      .removeAlpha()
      .grayscale()
      .png()
      .toBuffer();
  } catch (error: any) {
    throw new Error(`mask_decode_failed: ${error?.message || String(error)}`);
  }
}
