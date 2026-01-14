import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { pool, withTransaction } from "../db/index.js";
import { purgeS3Prefix } from "../utils/s3.js";
import { getRedis } from "@realenhance/shared/redisClient.js";

const router = Router();

const REQUIRED_CONFIRM = "RESET_PROD_DATA";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TABLES_TO_TRUNCATE = [
  "enhanced_images",
  "enhancement_attempts",
  "job_reservations",
  "agency_month_usage",
  "agency_accounts",
  "addon_purchases",
];

class ResetError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getDataDir(): string {
  const cwd = process.cwd();
  const repoRoot = path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
  return process.env.DATA_DIR || path.resolve(repoRoot, "server", "data");
}

async function logAudit(params: {
  status: string;
  purgeS3: boolean;
  requesterIp: string | undefined;
  details?: Record<string, any>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit(action, requester_ip, purge_s3, status, details) VALUES ($1,$2,$3,$4,$5)`,
      [
        "reset",
        params.requesterIp,
        params.purgeS3,
        params.status,
        JSON.stringify(params.details || {}),
      ]
    );
  } catch (err) {
    console.warn("[admin_reset] failed to write audit log", err);
  }
}

async function purgeDataDir(): Promise<void> {
  const dataDir = getDataDir();
  try {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await fs.promises.mkdir(dataDir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to purge data dir ${dataDir}: ${err}`);
  }
}

async function flushRedis(): Promise<void> {
  try {
    const redis: any = getRedis();
    if (typeof redis.flushDb === "function") {
      await redis.flushDb();
      return;
    }
    if (typeof redis.flushAll === "function") {
      await redis.flushAll();
      return;
    }
    if (typeof redis.keys === "function" && typeof redis.del === "function") {
      const keys = await redis.keys("*");
      if (Array.isArray(keys) && keys.length > 0) {
        await redis.del(...(keys as any));
      }
      return;
    }
  } catch (err) {
    console.warn("[admin_reset] Redis flush helper failed", err);
    throw new Error("Failed to flush Redis");
  }
}

function getRequesterIp(req: Request): string | undefined {
  const fwd = (req.headers["x-forwarded-for"] as string) || "";
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip;
}

router.post("/admin/reset", async (req: Request, res: Response) => {
  const requesterIp = getRequesterIp(req);
  const body = req.body || {};
  const purgeS3 = Boolean(body.purgeS3);

  const envEnabled = String(process.env.ALLOW_ADMIN_RESET || "").toLowerCase() === "true";
  if (!envEnabled) {
    await logAudit({ status: "disabled", purgeS3, requesterIp, details: { reason: "ALLOW_ADMIN_RESET not true" } });
    return res.status(403).json({ error: "Admin reset is disabled" });
  }

  const expectedToken = process.env.ADMIN_RESET_TOKEN;
  if (!expectedToken) {
    await logAudit({ status: "misconfigured", purgeS3, requesterIp, details: { reason: "ADMIN_RESET_TOKEN missing" } });
    return res.status(500).json({ error: "Admin reset token not configured" });
  }

  const headerToken = req.header("x-admin-reset-token");
  if (!headerToken || headerToken !== expectedToken) {
    await logAudit({ status: "forbidden", purgeS3, requesterIp, details: { reason: "token mismatch" } });
    return res.status(403).json({ error: "Forbidden" });
  }

  if (body.confirm !== REQUIRED_CONFIRM) {
    await logAudit({ status: "invalid_confirm", purgeS3, requesterIp, details: { confirm: body.confirm } });
    return res.status(400).json({ error: "Invalid confirm token" });
  }

  if (typeof body.purgeS3 !== "boolean") {
    await logAudit({ status: "invalid_body", purgeS3, requesterIp, details: { reason: "purgeS3 must be boolean" } });
    return res.status(400).json({ error: "purgeS3 must be boolean" });
  }

  let tablesTruncated: string[] = [];
  let auditId: number | null = null;
  let deletedObjectCount = 0;
  let s3Purged = false;

  try {
    const now = new Date();

    await withTransaction(async (client) => {
      const metaRes = await client.query("SELECT value FROM admin_meta WHERE key = $1 FOR UPDATE", ["last_reset_at"]);
      const lastResetIso = metaRes.rows?.[0]?.value?.last_reset_at || metaRes.rows?.[0]?.value?.iso;
      if (lastResetIso) {
        const since = now.getTime() - new Date(String(lastResetIso)).getTime();
        if (since < ONE_DAY_MS) {
          throw new ResetError("Reset already performed within the last 24 hours", 429);
        }
      }

      const auditRes = await client.query(
        `INSERT INTO admin_audit(action, requester_ip, purge_s3, status, details) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          "reset",
          requesterIp,
          purgeS3,
          "started",
          JSON.stringify({ requestedAt: now.toISOString() }),
        ]
      );
      auditId = auditRes.rows?.[0]?.id ?? null;

      await client.query(
        `TRUNCATE ${TABLES_TO_TRUNCATE.join(", ")} RESTART IDENTITY CASCADE`
      );
      tablesTruncated = [...TABLES_TO_TRUNCATE];

      await client.query(
        `INSERT INTO admin_meta(key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`
        ,
        ["last_reset_at", JSON.stringify({ last_reset_at: now.toISOString() })]
      );

      if (auditId) {
        await client.query(
          `UPDATE admin_audit SET status=$1, details=$2 WHERE id=$3`,
          ["db_truncated", JSON.stringify({ tablesTruncated }), auditId]
        );
      }
    });

    await purgeDataDir();
    await flushRedis();

    if (purgeS3) {
      const prefix = (process.env.S3_RESET_PREFIX || "realenhance/").trim();
      const s3Result = await purgeS3Prefix(prefix);
      deletedObjectCount = s3Result.deleted;
      s3Purged = true;
    }

    if (auditId) {
      await pool.query(
        `UPDATE admin_audit SET status=$1, details=$2 WHERE id=$3`,
        [
          "completed",
          JSON.stringify({ tablesTruncated, s3Purged, deletedObjectCount }),
          auditId,
        ]
      );
    }

    return res.json({ ok: true, tablesTruncated, s3Purged, deletedObjectCount });
  } catch (err: any) {
    if (auditId) {
      try {
        await pool.query(
          `UPDATE admin_audit SET status=$1, details=$2 WHERE id=$3`,
          [
            "failed",
            JSON.stringify({ error: err?.message || String(err) }),
            auditId,
          ]
        );
      } catch (auditErr) {
        console.warn("[admin_reset] failed to update audit after error", auditErr);
      }
    }

    if (err instanceof ResetError) {
      if (!auditId) {
        await logAudit({
          status: err.statusCode === 429 ? "rate_limited" : "failed",
          purgeS3,
          requesterIp,
          details: { error: err.message },
        });
      }
      return res.status(err.statusCode).json({ error: err.message });
    }

    console.error("[admin_reset] unexpected error", err);
    return res.status(500).json({ error: "Failed to reset data" });
  }
});

export default router;
