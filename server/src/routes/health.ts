import { Router, Request, Response } from "express";
import { NODE_ENV } from "../config.js";

export function healthRouter() {
  const r = Router();
  r.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      env: NODE_ENV,
      time: new Date().toISOString()
    });
  });
  return r;
}
