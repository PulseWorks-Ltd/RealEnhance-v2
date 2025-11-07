import fs from "fs";
import os from "os";
import path from "path";

export async function downloadToTemp(url: string, hint: string = "img"): Promise<string> {
  const ext = (() => {
    try {
      const u = new URL(url);
      const m = (u.pathname.match(/\.(png|jpg|jpeg|webp)$/i) || [])[0];
      return m ? m.substring(m.lastIndexOf(".")) : ".jpg";
    } catch { return ".jpg"; }
  })();
  const out = path.join(os.tmpdir(), `realenhance-${hint}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(out, Buffer.from(ab));
  return out;
}
