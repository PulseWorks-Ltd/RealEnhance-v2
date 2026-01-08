// server/src/routes/adminAnalysis.ts
// Admin API endpoints for failure analysis

import { Router, type Request, type Response } from "express";
import { runAnalysisForJob, getConfig } from "../services/analysisOrchestrator.js";
import {
  getLatestAnalysisForJob,
  getAnalysesForJob,
  getRecentAnalyses,
  getAnalysisById,
} from "@realenhance/shared/analysis/storage.js";
import { getUserById } from "../services/users.js";

const router = Router();

// Rate limiting map (simple in-memory, for production use Redis)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute

/**
 * Middleware: Require authentication
 */
async function requireAuth(req: Request, res: Response, next: Function) {
  const sessUser = (req.session as any)?.user;
  if (!sessUser) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const fullUser = await getUserById(sessUser.id);
  if (!fullUser) {
    return res.status(401).json({ error: "User not found" });
  }

  (req as any).user = fullUser;
  next();
}

/**
 * Middleware: Require admin role
 */
function requireAdmin(req: Request, res: Response, next: Function) {
  const user = (req as any).user;
  if (!user || (user.role !== "owner" && user.role !== "admin")) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Middleware: Rate limiting for manual analysis
 */
function rateLimit(req: Request, res: Response, next: Function) {
  const user = (req as any).user;
  const userId = user?.id;

  if (!userId) {
    return res.status(401).json({ error: "User ID required" });
  }

  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);

  if (userLimit && userLimit.resetAt > now) {
    if (userLimit.count >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: `Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per minute`,
        resetAt: new Date(userLimit.resetAt).toISOString(),
      });
    }
    userLimit.count++;
  } else {
    rateLimitMap.set(userId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
  }

  next();
}

/**
 * POST /admin/jobs/:jobId/analysis/run
 * Manually trigger analysis for a job
 */
router.post(
  "/jobs/:jobId/analysis/run",
  requireAuth,
  requireAdmin,
  rateLimit,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      // Run analysis
      const analysis = await runAnalysisForJob(jobId, "MANUAL");

      res.json({ analysis });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error running analysis:", error);
      res.status(500).json({
        error: "Failed to run analysis",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * GET /admin/jobs/:jobId/analysis/latest
 * Get latest analysis for a job
 */
router.get(
  "/jobs/:jobId/analysis/latest",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      const analysis = getLatestAnalysisForJob(jobId);

      if (!analysis) {
        return res.status(404).json({ error: "No analysis found for this job" });
      }

      res.json({ analysis });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error getting analysis:", error);
      res.status(500).json({
        error: "Failed to get analysis",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * GET /admin/jobs/:jobId/analysis/history
 * Get all analyses for a job
 */
router.get(
  "/jobs/:jobId/analysis/history",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      const analyses = getAnalysesForJob(jobId);

      res.json({ analyses });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error getting analysis history:", error);
      res.status(500).json({
        error: "Failed to get analysis history",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * GET /admin/analysis/recent
 * Get recent analyses (for dashboard)
 */
router.get(
  "/analysis/recent",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const analyses = getRecentAnalyses(limit);

      res.json({ analyses });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error getting recent analyses:", error);
      res.status(500).json({
        error: "Failed to get recent analyses",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * GET /admin/analysis/:analysisId
 * Get specific analysis by ID
 */
router.get(
  "/analysis/:analysisId",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { analysisId } = req.params;

      if (!analysisId) {
        return res.status(400).json({ error: "Analysis ID is required" });
      }

      const analysis = getAnalysisById(analysisId);

      if (!analysis) {
        return res.status(404).json({ error: "Analysis not found" });
      }

      res.json({ analysis });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error getting analysis:", error);
      res.status(500).json({
        error: "Failed to get analysis",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * GET /admin/analysis/config
 * Get analysis feature configuration
 */
router.get(
  "/analysis/config",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const config = getConfig();
      res.json({ config });
    } catch (error) {
      console.error("[ADMIN_ANALYSIS] Error getting config:", error);
      res.status(500).json({
        error: "Failed to get config",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default router;
