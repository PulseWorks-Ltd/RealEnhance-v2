// server/src/routes/adminReview.ts
// Site-admin review of processed images (Nov 2026): every job's upload,
// outputs and staging work images in one place, with quick "good / problem"
// marks. Images are opened through /image, which checks the admin session and
// redirects to a link that works for 5 minutes — no image links in the logs.

import { Router, type Request, type Response } from "express";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { getUserById } from "../services/users.js";
import { ADMIN_REVIEW_INDEX_KEY } from "../services/jobs.js";
import { createPresignedGetUrl } from "../utils/s3.js";
import { REVIEW_TAGS, parse, reviewImageKey, summariseJob, type Mark } from "../services/adminReviewModel.js";
import { requireAuth, requireSiteAdmin } from "./admin.js";

const router = Router();
const MARKS_KEY = "admin:review:marks";

const LINK_SECONDS = 600;
/** A 10-minute link for an image the page may open, or null. */
async function link(input: string | null | undefined): Promise<string | null> {
  const key = reviewImageKey(String(input || ""));
  if (!key) return null;
  try { return await createPresignedGetUrl(key, LINK_SECONDS); } catch { return null; }
}
async function linkImages(images: Record<string, string | null>) {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(images)) out[k] = await link(v);
  return out;
}

/* ── List: newest first ─────────────────────────────── */
router.get("/jobs", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const client = getRedis();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const filter = String(req.query.filter || "all");
    const agency = String(req.query.agency || "").trim();
    const marks: Record<string, string> = (await client.hGetAll(MARKS_KEY)) || {};
    // Read a wider window when filtering, so a page still fills up.
    const window = filter === "all" && !agency ? limit : Math.min(1000, limit * 10);
    const out: any[] = [];
    let cursor = offset, scanned = 0;
    while (out.length < limit && scanned < 2000) {
      const ids: string[] = await client.zRange(ADMIN_REVIEW_INDEX_KEY, cursor, cursor + window - 1, { REV: true } as any);
      if (!ids.length) break;
      const recs = await client.mGet(ids.map((id) => `jobs:${id}`));
      for (let i = 0; i < ids.length && out.length < limit; i++) {
        cursor++; scanned++;
        const rec = parse(recs[i]);
        if (!rec) continue;
        const job = summariseJob(rec, parse(marks[ids[i]]));
        if (agency && job.agencyId !== agency) continue;
        if (filter === "published" && job.outcome !== "published") continue;
        if (filter === "fell back" && job.outcome !== "fell back") continue;
        if (filter === "failed" && job.outcome !== "failed") continue;
        if (filter === "problem" && job.mark?.verdict !== "problem") continue;
        if (filter === "good" && job.mark?.verdict !== "good") continue;
        if (filter === "unmarked" && job.mark) continue;
        out.push(job);
      }
      if (ids.length < window) break;
    }
    // Who uploaded (email), looked up once per user.
    const emails = new Map<string, string>();
    for (const j of out) {
      if (j.userId && !emails.has(j.userId)) {
        const u = await getUserById(j.userId).catch(() => null);
        emails.set(j.userId, (u as any)?.email || "");
      }
      (j as any).userEmail = j.userId ? emails.get(j.userId) || "" : "";
      (j as any).images = await linkImages(j.images);
    }
    res.json({ jobs: out, nextOffset: cursor, total: await client.zCard(ADMIN_REVIEW_INDEX_KEY), tags: REVIEW_TAGS });
  } catch (err: any) {
    console.error("[admin-review] list failed:", err?.message || err);
    res.status(500).json({ error: "Could not load jobs" });
  }
});

/* ── One job, with every staging attempt ────────────── */
router.get("/jobs/:jobId", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const client = getRedis();
    const jobId = String(req.params.jobId);
    const rec = parse(await client.get(`jobs:${jobId}`));
    if (!rec) return res.status(404).json({ error: "Job not found" });
    const job: any = summariseJob(rec, parse(await client.hGet(MARKS_KEY, jobId)));
    const sm = rec.stage2Masked || {};
    const files: Record<string, string[]> = sm.debugFiles || {};
    job.attempts = (sm.reports || []).map((r: any) => {
      const names = files[`attempt${r.attempt}`] || [];
      return {
        attempt: r.attempt,
        outcome: r.outcome || (r.error ? `error: ${r.error}` : ""),
        report: r,
        images: names.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)),
        texts: names.filter((n) => /\.(txt|json)$/i.test(n)),
      };
    });
    const prefix = sm.debugPrefix || `debug-attempts/${jobId}/masked`;
    for (const a of job.attempts) {
      a.images = await Promise.all(a.images.map(async (n: string) => ({ name: n, url: await link(`${prefix}/attempt${a.attempt}/${n}`) })));
      a.texts = await Promise.all(a.texts.map(async (n: string) => ({ name: n, url: await link(`${prefix}/attempt${a.attempt}/${n}`) })));
    }
    job.images = await linkImages(job.images);
    if (job.userId) job.userEmail = ((await getUserById(job.userId).catch(() => null)) as any)?.email || "";
    res.json({ job });
  } catch (err: any) {
    console.error("[admin-review] detail failed:", err?.message || err);
    res.status(500).json({ error: "Could not load job" });
  }
});

/* ── Open an image (or a saved prompt/plan) ─────────── */
router.get("/image", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  const key = reviewImageKey(String(req.query.key || req.query.url || ""));
  if (!key) return res.status(400).json({ error: "Not an image this page can open" });
  try {
    const url = await createPresignedGetUrl(key, 300);
    res.setHeader("Cache-Control", "private, max-age=240");
    res.redirect(302, url);
  } catch (err: any) {
    console.error("[admin-review] image link failed:", err?.message || err);
    res.status(500).json({ error: "Could not open image" });
  }
});

/* ── Mark a job good / problem ──────────────────────── */
router.post("/jobs/:jobId/mark", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const client = getRedis();
    const jobId = String(req.params.jobId);
    const verdict = req.body?.verdict;
    if (verdict === null || verdict === "clear") {
      await client.hDel(MARKS_KEY, jobId);
      return res.json({ ok: true, mark: null });
    }
    if (verdict !== "good" && verdict !== "problem") return res.status(400).json({ error: "verdict must be good or problem" });
    const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map(String).filter((t: string) => REVIEW_TAGS.includes(t));
    const mark: Mark = {
      verdict,
      tags: verdict === "problem" ? tags : [],
      note: String(req.body?.note || "").slice(0, 500),
      by: String((req as any).user?.email || ""),
      at: new Date().toISOString(),
    };
    await client.hSet(MARKS_KEY, jobId, JSON.stringify(mark));
    res.json({ ok: true, mark });
  } catch (err: any) {
    console.error("[admin-review] mark failed:", err?.message || err);
    res.status(500).json({ error: "Could not save mark" });
  }
});

export default router;
