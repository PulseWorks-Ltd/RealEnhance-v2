// server/src/services/adminReviewModel.ts
// Pure helpers for the admin review page (no database or Redis), so they can
// be tested on their own.
import { extractKeyFromS3Url } from "../utils/s3.js";

// Only these folders can be opened from the review page.
const ALLOWED_PREFIXES = ["debug-attempts/", "realenhance/"];
export const REVIEW_TAGS = ["scale", "skirting", "shadow", "room changed", "blocked door", "missing furniture", "artifact", "colour", "other"];

export type Mark = { verdict: "good" | "problem"; tags: string[]; note: string; by: string; at: string };

export function parse(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Storage key for an image, from a key or a stored S3 URL; null if not allowed. */
export function reviewImageKey(input: string): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const key = /^https?:\/\//i.test(raw) ? extractKeyFromS3Url(raw) : raw.replace(/^\/+/, "");
  if (!key || key.includes("..")) return null;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p)) ? key : null;
}

/** What the list shows for one job. */
export function summariseJob(rec: any, mark: Mark | null) {
  const p = rec?.payload || {};
  const opt = p.options || {};
  const sm = rec?.stage2Masked || null;
  const stageUrls = rec?.stageUrls || {};
  const status = String(rec?.status || "unknown");
  const fellBack = Boolean(sm && sm.ok === false) || /fallback|exhausted|nothing_to_stage/i.test(String(rec?.validationNote || rec?.meta?.failureReason || ""));
  const outcome = status === "failed" ? "failed"
    : status === "complete" || status === "completed" ? (opt.virtualStage && fellBack ? "fell back" : "published")
    : status;
  return {
    jobId: String(rec?.jobId || rec?.id || ""),
    createdAt: rec?.createdAt || p.createdAt || null,
    imageName: p.imageName || p.originalName || rec?.imageId || "",
    userId: rec?.userId || p.userId || null,
    agencyId: p.agencyId || null,
    retry: p.retryType || null,
    options: {
      roomType: opt.roomType || null,
      sceneType: opt.sceneType || null,
      declutter: Boolean(opt.declutter),
      stage: Boolean(opt.virtualStage),
      style: opt.stagingStyle || null,
    },
    status,
    outcome,
    note: rec?.validationNote || rec?.errorMessage || null,
    staging: sm ? {
      ok: sm.ok,
      attempts: sm.attempts,
      reasons: sm.reasons || [],
      steps: (sm.reports || []).map((r: any) => ({ attempt: r.attempt, outcome: r.outcome || (r.error ? `error: ${r.error}` : "") })),
    } : null,
    images: {
      original: p.remoteOriginalUrl || stageUrls.original || null,
      enhanced: stageUrls["1A"] || null,
      decluttered: stageUrls["1B"] || null,
      staged: stageUrls["2"] || null,
      final: rec?.finalOutputUrl || rec?.resultUrl || null,
    },
    mark,
  };
}

