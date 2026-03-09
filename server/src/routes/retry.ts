import { Router, Request, Response } from "express";

export function retryRouter() {
  const r = Router();

  r.post("/retry", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    return res.status(410).json({
      error: "retry_endpoint_deprecated",
      message: "Use POST /api/batch/retry-single",
      canonicalEndpoint: "/api/batch/retry-single",
    });
  });

  return r;
}
