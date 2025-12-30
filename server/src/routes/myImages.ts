// server/src/routes/myImages.ts
// Agency's enhanced images gallery

import { Router, Request, Response } from "express";
import { listImagesForAgency } from "../services/images.js";
import { getUserById } from "../services/users.js";

export function myImagesRouter() {
  const r = Router();

  /**
   * GET /api/my-images
   * Get all enhanced images for the authenticated user's agency
   */
  r.get("/my-images", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;

    if (!sessUser) {
      return res.status(401).json({
        error: "not_authenticated",
        message: "Please log in to view your images"
      });
    }

    try {
      // Get user's agency
      const user = await getUserById(sessUser.id);
      if (!user?.agencyId) {
        // User not in agency - return empty array
        return res.json({ images: [] });
      }

      // Get all images for the agency
      const imgs = listImagesForAgency(user.agencyId);

      res.json({
        images: imgs.map((img: any) => ({
          id: img.imageId,
          imageId: img.imageId,
          createdAt: img.createdAt || new Date().toISOString(),
          prompt: img.prompt || "",
          status: img.status || "completed",
          url: img.outputUrl || img.filePath || null,
          currentVersionId: img.currentVersionId,
          roomType: img.meta?.roomType || img.roomType,
          sceneType: img.meta?.sceneType || img.sceneType,
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
