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
      declutter: typeof declutter === "boolean" ? declutter : !!prevOptions.declutter,
      virtualStage: typeof virtualStage === "boolean" ? virtualStage : !!prevOptions.virtualStage,
      roomType: (roomType as string) || prevOptions.roomType || "unknown",
      sceneType: (sceneType as string) || prevOptions.sceneType || "auto",
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

    const prev = getJob(req.params.jobId);
    if (!prev) return res.status(404).json({ error: "not_found" });
    if (prev.userId !== sessUser.id) return res.status(403).json({ error: "forbidden" });
    if (prev.type !== "enhance") return res.status(400).json({ error: "only_enhance_supported" });

    const { sceneType, roomType, declutter, virtualStage } = (req.body || {}) as any;
    const prevOpts = (prev as any)?.payload?.options || {};
    const options = {
      declutter: typeof declutter === "boolean" ? declutter : !!prevOpts.declutter,
      virtualStage: typeof virtualStage === "boolean" ? virtualStage : !!prevOpts.virtualStage,
      roomType: (roomType as string) || prevOpts.roomType || "unknown",
      sceneType: (sceneType as string) || prevOpts.sceneType || "auto",
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
