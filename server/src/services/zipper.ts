import JSZip from "jszip";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";

type ZipFileInput = {
  filename: string;
  dataUrl?: string | null;
  buffer?: Buffer | Uint8Array | ArrayBuffer | null;
  contentType?: string | null;
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

function sanitizeFilename(input?: string | null): string {
  const raw = String(input || "image").trim() || "image";
  return raw.replace(/[^\w.\-]+/g, "_");
}

function inferExtension(contentType?: string | null, dataUrl?: string | null): string {
  const normalizedType = String(contentType || "").trim().toLowerCase();
  if (normalizedType && MIME_EXTENSION_MAP[normalizedType]) {
    return MIME_EXTENSION_MAP[normalizedType];
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(String(dataUrl || ""));
  if (match && MIME_EXTENSION_MAP[match[1].toLowerCase()]) {
    return MIME_EXTENSION_MAP[match[1].toLowerCase()];
  }

  return "";
}

function ensureFilenameExtension(filename: string, contentType?: string | null, dataUrl?: string | null): string {
  const inferredExtension = inferExtension(contentType, dataUrl);
  const existingExtensionMatch = filename.match(/(\.[a-z0-9]+)$/i);

  if (existingExtensionMatch) {
    if (!inferredExtension) return filename;
    return filename.replace(/(\.[a-z0-9]+)$/i, inferredExtension);
  }

  return `${filename}${inferredExtension || ".png"}`;
}

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

export async function makeZip(opts: {
  userId: string;
  files: ZipFileInput[];
}): Promise<{ path: string; buffer: Buffer; addedCount: number; skippedCount: number }> {
  const { userId, files } = opts;
  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  let addedCount = 0;
  let skippedCount = 0;

  for (const f of files) {
    let fileBuffer: Buffer | null = null;
    if (f?.dataUrl?.startsWith("data:image/")) {
      const base64 = f.dataUrl.split(",")[1];
      if (base64) {
        fileBuffer = Buffer.from(base64, "base64");
      }
    } else if (f?.buffer) {
      fileBuffer = toBuffer(f.buffer);
    }

    if (!fileBuffer?.length) {
      skippedCount += 1;
      continue;
    }

    const sanitizedBase = ensureFilenameExtension(sanitizeFilename(f.filename), f.contentType, f.dataUrl);
    const duplicateCount = usedNames.get(sanitizedBase) || 0;
    usedNames.set(sanitizedBase, duplicateCount + 1);
    const finalName = duplicateCount === 0
      ? sanitizedBase
      : sanitizedBase.replace(/(\.[a-z0-9]+)$/i, `_${duplicateCount + 1}$1`);
    zip.file(finalName, fileBuffer);
    addedCount += 1;
  }

  const buffer = await zip.generateAsync({ 
    type: "nodebuffer", 
    compression: "DEFLATE", 
    compressionOptions: { level: 6 } 
  });

  // For now, store in temp directory (in production, use cloud storage)
  const tempDir = path.join(process.cwd(), "temp", "zips");
  await fs.mkdir(tempDir, { recursive: true });
  
  const filename = `batch-${uuidv4()}.zip`;
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, buffer);

  return { path: filePath, buffer, addedCount, skippedCount };
}