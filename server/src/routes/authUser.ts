import { Router, Request, Response } from "express";
import { getUserById } from "../services/users.js";
import { listImagesForUser } from "../services/images.js";

export function authUserRouter() {
  const r = Router();

  // Primary route expected by client: GET /api/auth-user
  r.get("/", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "Unauthorized" });

    const full = await getUserById(sessUser.id);
    if (!full) return res.status(401).json({ error: "Unauthorized" });

    const imgs = listImagesForUser(full.id);

    res.json({
      id: full.id,
      name: full.name,
      email: full.email,
      credits: full.credits,
      agencyId: full.agencyId,
      role: full.role,
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

  // Backwards-compat alias: GET /api/auth-user/auth/user
  r.get("/auth/user", (req: Request, res: Response) => {
    (r as any).handle({ ...req, url: "/" }, res);
  });

  return r;
}
