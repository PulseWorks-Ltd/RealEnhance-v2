import { Router, Request, Response } from "express";
import { getImageRecord } from "../services/images.js";
import { enqueueEditJob } from "../services/jobs.js";

export function editRouter() {
  const r = Router();

  r.post("/edit", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    // body:
    // {
    //   "imageId": "...",
    //   "baseVersionId": "...",
    //   "mode": "Add"|"Remove"|"Replace"|"Restore",
    //   "instruction": "Add a bed...",
    //   "mask": {...}
    // }
    const {
      imageId,
      baseVersionId,
      mode,
      instruction,
      mask
    } = req.body || {};

    const rec = getImageRecord(imageId);
    if (!rec) {
      return res.status(404).json({ error: "image_not_found" });
    }
    if (rec.ownerUserId !== sessUser.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    const baseOk = rec.history.find((v: any) => v.versionId === baseVersionId);
    if (!baseOk) {
      return res.status(400).json({ error: "invalid_base_version" });
    }

    const { jobId } = await enqueueEditJob({
      userId: sessUser.id,
      imageId,
      baseVersionId,
      mode,
      instruction,
      mask
    });

    res.json({ jobId });
  });

  return r;
}
