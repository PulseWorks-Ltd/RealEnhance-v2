import { Router, Request, Response } from "express";
import { getUserById } from "../services/users.js";
import { listImagesForUser } from "../services/images.js";

export function authUserRouter() {
  const r = Router();

  r.get("/auth/user", (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.json({});

    const full = getUserById(sessUser.id);
    if (!full) return res.json({});

    const imgs = listImagesForUser(full.id);

    res.json({
      id: full.id,
      name: full.name,
      email: full.email,
      credits: full.credits,
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
