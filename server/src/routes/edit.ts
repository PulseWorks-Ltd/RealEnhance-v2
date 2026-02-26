import { Router, Request, Response } from "express";
import { getImageRecord } from "../services/images.js";
import { enqueueEditJob } from "../services/jobs.js";
import { getJobMetadata, saveJobMetadata } from "@realenhance/shared/imageStore";

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
      mask,
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

    // Edit contract: two free edits per image across all edit endpoints.
    const editCounterJobId = `edit_counter:${imageId}`;
    const parentMeta = await getJobMetadata(editCounterJobId);
    const currentEditCount = Math.max(0, Number(parentMeta?.editCount || 0));
    if (currentEditCount >= 2) {
      return res.status(429).json({
        error: "edit_limit_reached",
        code: "EDIT_LIMIT_REACHED",
        editCount: currentEditCount,
        message: "You have reached the maximum allowed free edits for this image. Please submit a new enhancement.",
      });
    }

    const baseMeta = parentMeta && parentMeta.jobId
      ? parentMeta
      : {
          jobId: editCounterJobId,
          userId: sessUser.id,
          imageId,
          createdAt: new Date().toISOString(),
        };

    await saveJobMetadata({
      ...baseMeta,
      editCount: currentEditCount + 1,
      lastEditAt: new Date().toISOString(),
    } as any);

    const enqueueParams = {
      userId: sessUser.id,
      imageId,
      baseVersionId,
      mode,
      instruction,
      mask
    };
    const { jobId } = await enqueueEditJob(enqueueParams);

    // Persist minimal job metadata for retry
    const meta: any = {
      jobId,
      userId: sessUser.id,
      operation: "edit",
      imageId,
      instruction,
      mask: (enqueueParams.mask as any) ?? null,
      options: {
        baseVersionId,
        mode,
      },
      createdAt: new Date().toISOString(),
    };
    await saveJobMetadata(meta);

    res.json({ jobId });
  });

  return r;
}
