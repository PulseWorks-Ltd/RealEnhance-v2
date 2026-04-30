import Pica from "pica";

export const MAX_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2500;
export const OUTPUT_IMAGE_TYPE = "image/jpeg";
export const OUTPUT_IMAGE_QUALITY = 0.82;

const pica = new Pica();

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

  const bitmap = await createOrientedBitmap(file);
  const scale = Math.min(
    MAX_IMAGE_DIMENSION / bitmap.width,
    MAX_IMAGE_DIMENSION / bitmap.height,
    1,
  );

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    await pica.resize(bitmap, canvas, {
      alpha: false,
      unsharpAmount: 80,
      unsharpRadius: 0.6,
      unsharpThreshold: 2,
    });

    const blob = await canvasToBlob(canvas, OUTPUT_IMAGE_TYPE, OUTPUT_IMAGE_QUALITY);

    return new File([blob], buildOutputFilename(file.name), {
      type: OUTPUT_IMAGE_TYPE,
      lastModified: file.lastModified,
    });
  } finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}