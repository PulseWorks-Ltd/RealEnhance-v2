import fs from "fs";
import os from "os";
import path from "path";
import { Storage } from "@google-cloud/storage";

let storageClient: Storage | null = null;

function getStorageClient(): Storage {
  if (storageClient) {
    return storageClient;
  }
  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim() || undefined;
  storageClient = new Storage(projectId ? { projectId } : undefined);
  return storageClient;
}

function resolveDownloadExtension(remoteUri: string): string {
  const gsMatch = remoteUri.match(/^gs:\/\/[^/]+\/(.+)$/i);
  const pathname = gsMatch?.[1]
    ? `/${gsMatch[1]}`
    : (() => {
        try {
          return new URL(remoteUri).pathname;
        } catch {
          return remoteUri;
        }
      })();
  const ext = (pathname.match(/\.(png|jpg|jpeg|webp)$/i) || [])[0];
  return ext ? ext.substring(ext.lastIndexOf(".")) : ".jpg";
}

function parseGcsUri(uri: string): { bucket: string; objectPath: string } {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!match?.[1] || !match?.[2]) {
    throw new Error(`invalid gs uri: ${uri}`);
  }
  return {
    bucket: match[1],
    objectPath: match[2],
  };
}

export async function downloadToTemp(url: string, hint: string = "img"): Promise<string> {
  const ext = resolveDownloadExtension(url);
  const out = path.join(os.tmpdir(), `realenhance-${hint}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  if (/^gs:\/\//i.test(url)) {
    const { bucket, objectPath } = parseGcsUri(url);
    await getStorageClient().bucket(bucket).file(objectPath).download({ destination: out });
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const ab = await res.arrayBuffer();
    fs.writeFileSync(out, Buffer.from(ab));
  }
  const stats = fs.statSync(out);
  if (stats.size <= 0) {
    throw new Error(`download failed: empty payload for ${url}`);
  }
  return out;
}
