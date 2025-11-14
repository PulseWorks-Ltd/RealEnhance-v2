import { Router, type Request, type Response } from "express";
import { getImageRecord, undoLastEdit } from "../services/images.js";

export function undoRouter() {
  const r = Router();

  // POST /api/edit/undo { imageId }
  r.post("/edit/undo", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ ok: false, error: "not_authenticated" });

    const { imageId } = (req.body || {}) as any;
    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ ok: false, error: "missing_image_id" });
    }

    const rec = getImageRecord(imageId);
    if (!rec) return res.status(404).json({ ok: false, error: "image_not_found" });
    if ((rec as any).ownerUserId !== sessUser.id) return res.status(403).json({ ok: false, error: "forbidden" });

    const updated = undoLastEdit(imageId);
    const current = updated?.history?.find(v => v.versionId === updated?.currentVersionId);
    const url = (current as any)?.publicUrl || undefined;
    return res.json({ ok: true, imageId, versionId: updated?.currentVersionId, imageUrl: url });
  });

  return r;
}
