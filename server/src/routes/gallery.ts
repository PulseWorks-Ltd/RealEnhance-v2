import { Router, Request, Response } from "express";
import { listImagesForUser } from "../services/images.js";

export function galleryRouter() {
  const r = Router();

  r.get("/gallery", (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const imgs = listImagesForUser(sessUser.id);

    res.json({
      images: imgs.map((img: any) => ({
        imageId: img.imageId,
        currentVersionId: img.currentVersionId,
        roomType: img.roomType,
        sceneType: img.sceneType,
        history: img.history.map((v: any) => ({
          versionId: v.versionId,
          stageLabel: v.stageLabel,
          filePath: v.filePath,
          note: v.note,
          createdAt: v.createdAt
        }))
      }))
    });
  });

  return r;
}
