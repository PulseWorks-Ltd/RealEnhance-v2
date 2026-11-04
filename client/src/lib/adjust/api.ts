// Photo Adjust: calls to the server (/api/enhanced-images/adjust/*).

import { api } from "@/lib/api";
import { sanitizeAdjustParams, type AdjustParams } from "./params";

export interface AdjustSourceRef {
  /** The image URL currently shown to the user. */
  sourceUrl: string;
  /** enhanced_images id, when the caller knows it. */
  sourceImageId?: string | null;
  /** The job that produced the image (needed for outputs without a gallery row). */
  sourceJobId?: string | null;
}

export interface AdjustSourceInfo {
  /** The gallery row the new version will hang off (null for intermediate outputs). */
  parentImageId: string | null;
  /** True when the opened image is itself an Adjust version: we load its clean parent instead. */
  reopenedFromParent: boolean;
  /** Stored values to restore the sliders with (when re-opening an Adjust version). */
  adjustments: AdjustParams | null;
}

export interface AdjustSaveResult {
  imageId: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  parentImageId: string | null;
  adjustments: AdjustParams;
}

function query(ref: AdjustSourceRef): string {
  const q = new URLSearchParams();
  q.set("url", ref.sourceUrl);
  if (ref.sourceImageId) q.set("imageId", ref.sourceImageId);
  if (ref.sourceJobId) q.set("jobId", ref.sourceJobId);
  return q.toString();
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return String(body?.message || body?.error || fallback);
  } catch {
    return fallback;
  }
}

export async function fetchAdjustSource(ref: AdjustSourceRef, signal?: AbortSignal): Promise<{ info: AdjustSourceInfo; blob: Blob }> {
  const infoRes = await fetch(api(`/api/enhanced-images/adjust/source?${query(ref)}`), { credentials: "include", signal });
  if (!infoRes.ok) throw new Error(await errorMessage(infoRes, "This photo can't be adjusted."));
  const body = await infoRes.json();
  const info: AdjustSourceInfo = {
    parentImageId: body?.parentImageId ?? null,
    reopenedFromParent: !!body?.reopenedFromParent,
    adjustments: body?.adjustments ? sanitizeAdjustParams(body.adjustments) : null,
  };
  const imgRes = await fetch(api(`/api/enhanced-images/adjust/source/image?${query(ref)}`), { credentials: "include", signal });
  if (!imgRes.ok) throw new Error(await errorMessage(imgRes, "Couldn't load the photo."));
  return { info, blob: await imgRes.blob() };
}

export async function saveAdjustedImage(ref: AdjustSourceRef, png: Blob, params: AdjustParams): Promise<AdjustSaveResult> {
  const form = new FormData();
  form.append("image", png, "adjusted.png");
  form.append("sourceUrl", ref.sourceUrl);
  if (ref.sourceImageId) form.append("sourceImageId", ref.sourceImageId);
  if (ref.sourceJobId) form.append("sourceJobId", ref.sourceJobId);
  form.append("adjustments", JSON.stringify(params));
  const res = await fetch(api("/api/enhanced-images/adjust"), { method: "POST", body: form, credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, "Couldn't save the adjusted photo."));
  const body = await res.json();
  return {
    imageId: String(body.imageId),
    imageUrl: String(body.imageUrl),
    thumbnailUrl: body.thumbnailUrl ? String(body.thumbnailUrl) : null,
    parentImageId: body.parentImageId ? String(body.parentImageId) : null,
    adjustments: sanitizeAdjustParams(body.adjustments),
  };
}
