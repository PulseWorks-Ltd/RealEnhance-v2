import fs from "fs";
import path from "path";

export function toBase64(filePath: string): { data: string; mime: string } {
  const buf = fs.readFileSync(filePath);
  // crude mime guess by extension
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: buf.toString("base64"), mime };
}

export function writeImageDataUrl(outPath: string, dataUrl: string) {
  const m = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!m) throw new Error("invalid data URL from model");
  const b64 = m[2];
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(outPath, buf);
}

export function siblingOutPath(srcPath: string, suffix: string, ext: string = ".webp"): string {
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath, path.extname(srcPath));
  return path.join(dir, `${base}${suffix}${ext}`);
}
