import fs from "fs";
import path from "path";
import { publishImage } from "../utils/publish";

// Create a tiny 1x1 PNG buffer (transparent)
// PNG header for a 1x1 transparent image
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7PqrkAAAAASUVORK5CYII=";

async function main() {
  const tmpDir = path.join(process.cwd(), ".tmp-test");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `test-${Date.now()}.png`);
  fs.writeFileSync(filePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  console.log("[test] Using file:", filePath);
  console.log("[test] Env summary:");
  const bucket = process.env.S3_BUCKET;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  console.log("  S3_BUCKET=", bucket ? "set" : "unset");
  console.log("  AWS_REGION=", region || "unset");
  console.log("  S3_PUBLIC_BASEURL=", process.env.S3_PUBLIC_BASEURL ? "set" : "unset");

  try {
    const res = await publishImage(filePath);
    console.log("[test] publishImage result:", { kind: res.kind, urlPreview: res.url.slice(0, 80) + (res.url.length > 80 ? "…" : "") });
    if (res.kind === "s3") {
      console.log("[test] SUCCESS: Uploaded to S3.", res.key);
    } else {
      console.log("[test] OK: Fallback data URL returned (expected if S3 not configured).");
    }
  } catch (e: any) {
    console.error("[test] publishImage failed:", e?.message || e);
    process.exitCode = 1;
  }
}

main();
