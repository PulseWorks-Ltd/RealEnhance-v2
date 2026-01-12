// server/src/routes/myImages.ts
// Legacy endpoint → redirect to enhanced images history

import { Router, Request, Response } from "express";

export function myImagesRouter() {
  const r = Router();

  /**
   * GET /api/my-images
   * Legacy entry point. Redirects permanently to /api/enhanced-images.
   */
  r.get("/my-images", (req: Request, res: Response) => {
    const qs = new URLSearchParams(req.query as Record<string, string | string[]>);
    const target = `/api/enhanced-images${qs.toString() ? `?${qs.toString()}` : ""}`;

    // Permanent redirect so old bookmarks continue to work silently
    return res.redirect(308, target);
  });

  return r;
}
