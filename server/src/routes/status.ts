import { Router, Request, Response } from "express";
import { getJob } from "../services/jobs";

export function statusRouter() {
  const r = Router();

  r.get("/status/:jobId", (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "not_found" });

    if (job.userId !== sessUser.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    res.json(job);
  });

  return r;
}
