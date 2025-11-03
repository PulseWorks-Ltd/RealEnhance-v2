import JSZip from "jszip";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";

export async function makeZip(opts: {
  userId: string;
  files: Array<{ filename: string; dataUrl: string }>;
}): Promise<{ path: string; buffer: Buffer }> {
  const { userId, files } = opts;
  const zip = new JSZip();

  for (const f of files) {
    if (!f?.dataUrl?.startsWith("data:image/")) continue;
    const base64 = f.dataUrl.split(",")[1];
    const safeName = (f.filename || "image.png").replace(/[^\w.\-]+/g, "_");
    const finalName = safeName.endsWith(".png") ? safeName : `${safeName}.png`;
    zip.file(finalName, Buffer.from(base64, "base64"));
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

  return { path: filePath, buffer };
}