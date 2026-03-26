import { Router, Request, Response } from "express";

export function editRouter() {
  const r = Router();

  r.post("/edit", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    return res.status(410).json({
      error: "legacy_edit_route_removed",
      code: "LEGACY_EDIT_ROUTE_REMOVED",
      message: "The legacy /api/edit endpoint has been retired. Use /api/region-edit so edit jobs enter the enforced stage-lineage pipeline.",
    });
  });

  return r;
}
