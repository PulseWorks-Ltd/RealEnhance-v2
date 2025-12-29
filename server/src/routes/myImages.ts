// server/src/routes/myImages.ts
// User's enhanced images gallery

import { Router, Request, Response } from "express";
import { listImagesForUser } from "../services/images.js";

export function myImagesRouter() {
  const r = Router();

  /**
   * GET /api/my-images
   * Get all enhanced images for the authenticated user
   */
  r.get("/my-images", (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;

    if (!sessUser) {
      return res.status(401).json({
        error: "not_authenticated",
        message: "Please log in to view your images"
      });
    }

    try {
      const imgs = listImagesForUser(sessUser.id);

      res.json({
        images: imgs.map((img: any) => ({
          id: img.imageId,
          imageId: img.imageId,
          createdAt: img.createdAt || new Date().toISOString(),
          prompt: img.prompt || "",
          status: img.status || "completed",
          url: img.outputUrl || img.filePath || null,
          currentVersionId: img.currentVersionId,
          roomType: img.roomType,
          sceneType: img.sceneType,
          history: img.history?.map((v: any) => ({
            versionId: v.versionId,
            stageLabel: v.stageLabel,
            filePath: v.filePath,
            note: v.note,
            createdAt: v.createdAt
          })) || []
        }))
      });
    } catch (error) {
      console.error("[MY_IMAGES] Error fetching images:", error);
      res.status(500).json({
        error: "Failed to fetch images",
        message: "An error occurred while loading your images"
      });
    }
  });

  return r;
}
