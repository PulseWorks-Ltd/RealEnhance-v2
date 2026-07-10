import Pica from "pica";

export const MAX_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2500;
export const OUTPUT_IMAGE_TYPE = "image/jpeg";
export const OUTPUT_IMAGE_QUALITY = 0.82;

const pica = new Pica();
const IMAGE_TRACE = import.meta.env.VITE_IMAGE_TRACE === "1";

async function sha256Hex(input: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const ab = await input.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", ab);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

async function readBitmapMetaFromBlob(input: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bmp = await createImageBitmap(input);
    const meta = { width: bmp.width || null, height: bmp.height || null };
    if (typeof bmp.close === "function") bmp.close();
    return meta;
  } catch {
    return { width: null, height: null };
  }
}

async function logClientImageTrace(label: string, input: Blob, extras: Record<string, unknown> = {}): Promise<void> {
  if (!IMAGE_TRACE) return;
  const [sha256, meta] = await Promise.all([sha256Hex(input), readBitmapMetaFromBlob(input)]);
  console.log("[IMAGE_TRACE]", {
    label,
    bytes: input.size,
    sha256,
    width: meta.width,
    height: meta.height,
    ...extras,
  });
}

function buildOutputFilename(inputName: string): string {
  const stripped = inputName.replace(/\.[^.]+$/, "");
  return `${stripped || "upload"}.jpg`;
}

async function createOrientedBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    return await createImageBitmap(file);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Compression failed"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

export async function processImage(file: File): Promise<File> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error(`${file.name} exceeds the 25MB upload limit.`);
  }

  await logClientImageTrace("client.upload.input", file, {
    fileName: file.name,
    fileType: file.type,
    lastModified: file.lastModified,
  });

  const bitmap = await createOrientedBitmap(file);
  const scale = Math.min(
    MAX_IMAGE_DIMENSION / bitmap.width,
    MAX_IMAGE_DIMENSION / bitmap.height,
    1,
  );

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = bitmap.width;
  sourceCanvas.height = bitmap.height;
  const sourceCtx = sourceCanvas.getContext("2d", { alpha: false });
  if (!sourceCtx) {
    throw new Error("Failed to initialize source canvas");
  }
  sourceCtx.drawImage(bitmap, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    // Resize from a concrete canvas source to avoid browser/ImageBitmap tiling artifacts.
    await pica.resize(sourceCanvas, canvas, {
      alpha: false,
      unsharpAmount: 80,
      unsharpRadius: 0.6,
      unsharpThreshold: 2,
    });

    const blob = await canvasToBlob(canvas, OUTPUT_IMAGE_TYPE, OUTPUT_IMAGE_QUALITY);

    await logClientImageTrace("client.upload.output", blob, {
      sourceFileName: file.name,
      outputType: OUTPUT_IMAGE_TYPE,
      outputQuality: OUTPUT_IMAGE_QUALITY,
      targetWidth: width,
      targetHeight: height,
    });

    return new File([blob], buildOutputFilename(file.name), {
      type: OUTPUT_IMAGE_TYPE,
      lastModified: file.lastModified,
    });
  } finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
    canvas.width = 0;
    canvas.height = 0;
  }
}