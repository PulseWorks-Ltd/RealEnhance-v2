import { Router, Request, Response } from "express";
import { readJsonFile } from "../services/jsonStore.js";
import { enqueueEnhanceJob, getJob } from "../services/jobs.js";

type ImagesState = Record<string, any>;

export function requeueRouter() {
  const r = Router();

  // Lightweight helper to find an image by base filename for the current user
  function findImageByFilename(userId: string, filename: string) {
    const images = readJsonFile<ImagesState>("images.json", {});
    const values = Object.values(images) as any[];
    return values.find((img) => {
      if (!img) return false;
      if (img.ownerUserId !== userId) return false;
      const orig = img.originalPath || img?.versions?.original;
      if (typeof orig !== "string") return false;
      return orig.endsWith(`/${filename}`) || orig.endsWith(`\\${filename}`) || orig.split(/[\\/]/).pop() === filename;
    });
  }

  // POST /api/requeue/by-filename { filename, sceneType?, roomType?, declutter?, virtualStage? }
  r.post("/requeue/by-filename", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const { filename, sceneType, roomType, declutter, virtualStage } = (req.body || {}) as any;
    if (!filename || typeof filename !== "string") {
      return res.status(400).json({ error: "missing_filename" });
    }

    const img = findImageByFilename(sessUser.id, filename);
    if (!img) return res.status(404).json({ error: "image_not_found" });

    const prevOptions = (img?.meta as any) || {};
    const options = {
      declutter: parseStrictBool(typeof declutter !== 'undefined' ? declutter : prevOptions.declutter),
      virtualStage: parseStrictBool(typeof virtualStage !== 'undefined' ? virtualStage : prevOptions.virtualStage),
      roomType: (roomType as string) || prevOptions.roomType || "unknown",
      sceneType: (sceneType as string) || prevOptions.sceneType || "auto",
      publicMode: (prevOptions.publicMode || "standard") as "tidy" | "standard" | "stage-ready", // ✅ Inherit from previous job
    };

    const imageId = (img.imageId || img.id) as string | undefined;
    if (!imageId) return res.status(500).json({ error: "image_id_missing" });

    const { jobId } = await enqueueEnhanceJob({
      userId: sessUser.id,
      imageId,
      options,
    });

    return res.json({ ok: true, jobId });
  });

  // POST /api/requeue/:jobId { sceneType?, roomType?, declutter?, virtualStage? }
  r.post("/requeue/:jobId", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const prev = await getJob(req.params.jobId);
    if (!prev) return res.status(404).json({ error: "not_found" });
    if (prev.userId !== sessUser.id) return res.status(403).json({ error: "forbidden" });
    if (prev.type !== "enhance") return res.status(400).json({ error: "only_enhance_supported" });

    const { sceneType, roomType, declutter, virtualStage } = (req.body || {}) as any;
    const prevOpts = (prev as any)?.payload?.options || {};
    const options = {
      declutter: parseStrictBool(typeof declutter !== 'undefined' ? declutter : prevOpts.declutter),
      virtualStage: parseStrictBool(typeof virtualStage !== 'undefined' ? virtualStage : prevOpts.virtualStage),
      roomType: (roomType as string) || prevOpts.roomType || "unknown",
      sceneType: (sceneType as string) || prevOpts.sceneType || "auto",
      publicMode: (prevOpts.publicMode || "standard") as "tidy" | "standard" | "stage-ready", // ✅ Inherit from previous job
    };

    const prevImageId = (prev as any).imageId as string | undefined;
    if (!prevImageId) return res.status(500).json({ error: "image_id_missing" });

    const { jobId } = await enqueueEnhanceJob({
      userId: prev.userId,
      imageId: prevImageId,
      options,
    });

    return res.json({ ok: true, jobId });
  });

  return r;
}

function parseStrictBool(v: any, defaultValue = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (["true","1","yes","y","on"].includes(s)) return true;
    if (["false","0","no","n","off",""] .includes(s)) return false;
  }
  return defaultValue;
}
