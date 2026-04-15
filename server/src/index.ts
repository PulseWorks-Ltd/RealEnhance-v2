// server/src/index.ts
import path from "path";
import { fileURLToPath } from "url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import session, { type SessionOptions } from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { attachGoogleAuth } from "./auth/google.js";
import { getUserById, setCreditsForEmail } from "./services/users.js";
import { authUserRouter } from "./routes/authUser.js";
import { emailAuthRouter } from "./routes/emailAuth.js";
import { registerMeRoutes } from "./routes.me.js";
import { uploadRouter } from "./routes/upload.js";
import { statusRouter, debugStatusRouter } from "./routes/status.js";
import { editRouter } from "./routes/edit.js";
import { requeueRouter } from "./routes/requeue.js";
import { retrySingleRouter } from "./routes/retrySingle.js";
import { retryRouter } from "./routes/retry.js";
import { regionEditRouter } from "./routes/region-edit.js";
import { cancelRouter } from "./routes/cancel.js";
import { groupsRouter } from "./routes/groups.js";
import { healthRouter } from "./routes/health.js";
import { undoRouter } from "./routes/undo.js";
import { visionRoomTypeRouter } from "./routes/vision-room-type.js";
import { profileRouter } from "./routes/profile.js";
import adminUsageRouter from "./routes/adminUsage.js";
import agencyRouter from "./routes/agency.js";
import { usageRouter } from "./routes/usage.js";
import { scanAndRecoverStuckJobs } from "./services/jobs.js";
import stripeRouter from "./routes/stripe.js";
import adminSubscriptionRouter from "./routes/adminSubscription.js";
import { myImagesRouter } from "./routes/myImages.js";
import billingRouter from "./routes/billing.js";
import adminAnalysisRouter from "./routes/adminAnalysis.js";
import { enhancedImagesRouter } from "./routes/enhancedImages.js";
import { imageVersionsRouter } from "./routes/imageVersions.js";
import adminResetRouter from "./routes/adminReset.js";
import adminDashboardRouter from "./routes/admin.js";
import trialRouter from "./routes/trial.js";
import batchSubmitRouter from "./routes/batch-submit.js";
import { enhanceRouter } from "./routes/enhance.js";
import fs from "fs";
import { NODE_ENV, PORT, PUBLIC_ORIGIN, SESSION_SECRET, REDIS_URL } from "./config.js";
import { ensureS3Ready } from "./utils/s3.js";
import { pool } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PROD = NODE_ENV === "production";
const PROD_SESSION_COOKIE_DOMAIN = ".realenhance.co.nz";
const PROD_ALLOWED_ORIGINS = [
  "https://realenhance.co.nz",
  "https://www.realenhance.co.nz",
];

const startupState: {
  schemaReady: boolean;
  schemaError: string | null;
} = {
  schemaReady: false,
  schemaError: null,
};

async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function ensureEnhancedImagesSchemaCompatibility(): Promise<void> {
  const requiredColumns = ["property_id", "parent_image_id", "source"] as const;

  const colRes = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'enhanced_images'
        AND column_name = ANY($1::text[])
    `,
    [requiredColumns]
  );

  const presentColumns = new Set<string>(colRes.rows.map((r: any) => String(r.column_name)));
  const missingColumns = requiredColumns.filter((col) => !presentColumns.has(col));

  const tableRes = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'properties'
      ) AS exists
    `
  );

  const propertiesTableExists = Boolean(tableRes.rows[0]?.exists);

  if (missingColumns.length > 0 || !propertiesTableExists) {
    throw new Error(
      `[startup] Schema mismatch detected. Missing migration features for enhanced image gallery. ` +
      `missingColumns=${missingColumns.join(",") || "none"} propertiesTable=${propertiesTableExists ? "present" : "missing"}. ` +
      `Apply migrations (including 008_property_folders_and_versions.sql) before starting the server.`
    );
  }
}

async function ensureSchemaCompatibilityWithRetry(): Promise<void> {
  const retryDelayMs = 10_000;
  let attempt = 0;

  while (!startupState.schemaReady) {
    attempt += 1;
    try {
      await ensureEnhancedImagesSchemaCompatibility();
      startupState.schemaReady = true;
      startupState.schemaError = null;
      console.log(`[startup] schema compatibility confirmed (attempt ${attempt})`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      startupState.schemaError = message;
      console.error(`[startup] schema compatibility check failed (attempt ${attempt})`, err);
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function initializeAsyncServices(): Promise<void> {
  console.log("[startup] beginning background service initialization");

  // S3 readiness warm-up with retries; never block or exit process.
  const maxAttempts = 5;
  const retryDelayMs = 20_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const status = await ensureS3Ready();
      if (status.ok) {
        console.log(`[S3] Ready: bucket=${status.bucket} region=${status.region}`);
        break;
      }

      console.warn(
        `[S3] Unavailable${status.bucket ? ` (bucket=${status.bucket})` : ""}: ${status.reason} (attempt ${attempt}/${maxAttempts})`
      );
    } catch (err) {
      console.warn(`[S3] readiness check failed (attempt ${attempt}/${maxAttempts})`, err);
    }

    if (attempt < maxAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  try {
    const seededA = await setCreditsForEmail("pulseworkslimited@gmail.com", 250, "PulseWorks Limited");
    console.log("[seed] ensured credits:", { a: seededA.email, credits: seededA.credits });
  } catch (e) {
    console.warn("[seed] failed to ensure credits:", e);
  }

  console.log("[startup] background initialization complete");
}

async function main() {
  const STUCK_RECOVERY_SCAN_INTERVAL_MS = Math.max(60_000, Number(process.env.STUCK_RECOVERY_SCAN_INTERVAL_MS || 5 * 60 * 1000));
  let stuckRecoveryTimer: NodeJS.Timeout | null = null;

  try {
    await runMigrations();
  } catch (err) {
    console.error("[startup] migration failed:", err);
    process.exit(1);
  }

  // ---------------- Redis ----------------
  const redisClient: RedisClientType = createRedisClient({ url: REDIS_URL || undefined });
  redisClient.on("error", (err) => console.error("[redis] error", err));
  if (REDIS_URL) {
    redisClient.connect().catch((err) => {
      console.error("[redis] initial connect failed", err);
    });
  } else {
    console.warn("[redis] REDIS_URL not set; session store will not connect.");
  }

  const store = REDIS_URL
    ? new RedisStore({ client: redisClient as any, prefix: "sess:" })
    : undefined;

  // ---------------- Express ----------------
  const app: Express = express();

  app.set("trust proxy", 1);

  const allowedOrigins = new Set<string>([
    ...PUBLIC_ORIGIN,
    ...(IS_PROD ? PROD_ALLOWED_ORIGINS : []),
  ]);

  const corsOptions: cors.CorsOptions = {
    origin(origin, callback) {
      // Allow non-browser requests (no Origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Device-Id", "X-Requested-With", "Cache-Control"],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());

  // Standard JSON parsing for all routes except Stripe webhook.
  // Stripe requires the raw request body for signature verification.
  const jsonParser = express.json({ limit: '10mb' }); // Increased for data URLs from worker
  app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api/stripe/webhook")) {
      return next();
    }
    return jsonParser(req, res, next);
  });

  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Sessions
  const sessionOptions: SessionOptions = {
    name: "realsess",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      domain: IS_PROD ? PROD_SESSION_COOKIE_DOMAIN : undefined,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  };
  app.use(session(sessionOptions));

  const sessionCookieName = sessionOptions.name || "connect.sid";
  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: sessionOptions.cookie?.sameSite,
    secure: sessionOptions.cookie?.secure === true,
    domain: sessionOptions.cookie?.domain,
    path: sessionOptions.cookie?.path,
  } as const;

  async function destroySession(req: Request) {
    if (!req.session) return;
    await new Promise<void>((resolve) => req.session!.destroy(() => resolve()));
  }

  // Global guard: block disabled users and clean up dead sessions
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) return next();

    try {
      const fullUser = await getUserById(sessUser.id);

      if (!fullUser) {
        await destroySession(req);
        res.clearCookie(sessionCookieName, sessionCookieOptions);
        return res.status(401).json({ error: "Authentication required" });
      }

      if (fullUser.isActive === false) {
        await destroySession(req);
        res.clearCookie(sessionCookieName, sessionCookieOptions);
        return res.status(403).json({ error: "USER_DISABLED", message: "Your account has been disabled. Contact your admin." });
      }

      (req as any).authUser = fullUser;
      return next();
    } catch (err) {
      console.error("[auth] session validation error", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // Liveness for orchestrators: process is up and accepting requests.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      status: "live",
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // Readiness: dependencies/schema are usable for full traffic.
  app.get("/health", async (_req, res) => {
    const dbReady = await checkDbConnection();
    const schemaReady = startupState.schemaReady;

    if (!dbReady || !schemaReady) {
      return res.status(503).json({
        ok: false,
        status: "starting",
        dbReady,
        schemaReady,
        schemaError: startupState.schemaError,
        env: process.env.NODE_ENV || "dev",
        time: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      status: "ok",
      dbReady,
      schemaReady,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // Auth + API routes
  attachGoogleAuth(app);
  app.use("/api/auth", emailAuthRouter());
  app.use("/api/auth-user", authUserRouter());
  registerMeRoutes(app);
  app.use("/api", uploadRouter());
  app.use("/api", statusRouter());
  // Optional debugging route to inspect BullMQ job state/returnvalue
  app.use("/api", debugStatusRouter());
  app.use("/api", editRouter());
  app.use("/api", requeueRouter());
  app.use("/api", retrySingleRouter());
  app.use("/api", retryRouter());
  app.use("/api", regionEditRouter);
  app.use(cancelRouter());
  app.use("/api", groupsRouter());
  app.use("/api", healthRouter());
  app.use("/api", undoRouter());
  app.use("/api/profile", profileRouter());
  // Register ML-based room type detection API
  app.use("/api", visionRoomTypeRouter);
  // Admin usage tracking endpoints
  app.use("/api/admin/usage", adminUsageRouter);
  // Admin dashboard (agencies, usage, billing overview)
  app.use("/api/admin/dashboard", adminDashboardRouter);
  // Admin subscription management (protected by API key)
  app.use("/internal/admin", adminSubscriptionRouter);
  // Agency management endpoints
  app.use("/api/agency", agencyRouter);
  // Usage summary endpoints
  app.use("/api/usage", usageRouter());
  // Stripe webhook endpoints
  app.use("/api/stripe", stripeRouter);
  // Billing endpoints (checkout, portal)
  app.use("/api/billing", billingRouter);
  // User's enhanced images gallery
  app.use("/api", myImagesRouter());
  // Previously enhanced images (quota-bound retention)
  app.use("/api/enhanced-images", enhancedImagesRouter());
  app.use("/api", imageVersionsRouter());
  // Admin analysis endpoints
  app.use("/api/admin", adminAnalysisRouter);
  // Promo trial onboarding
  app.use("/api/trial", trialRouter());
  // Enhancement preflight/resume/cancel (payment continuation flow)
  app.use("/api/enhance", enhanceRouter());
  // Batch submission with individual job queueing
  app.use("/api/batch", batchSubmitRouter);
  // One-time admin data reset (heavily guarded)
  app.use(adminResetRouter);

  // Static file serving for uploaded and data images (development-friendly)
  const filesRoot = path.join(process.cwd(), "server");
  if (fs.existsSync(filesRoot)) {
    app.use("/files", express.static(filesRoot));
  }

  // Bind host/port for local dev and production (Railway)
  const HOST = process.env.HOST || "0.0.0.0";

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[server] listening on ${HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'}, PORT=${PORT})`);
    void ensureSchemaCompatibilityWithRetry();
    void initializeAsyncServices();

    const runStuckRecovery = async () => {
      try {
        const summary = await scanAndRecoverStuckJobs();
        if (summary.recovered > 0) {
          console.warn("[STUCK_RECOVERY] recovered jobs", summary);
        }
      } catch (err) {
        console.error("[STUCK_RECOVERY] scan failed", err);
      }
    };

    void runStuckRecovery();
    stuckRecoveryTimer = setInterval(() => {
      void runStuckRecovery();
    }, STUCK_RECOVERY_SCAN_INTERVAL_MS);
    stuckRecoveryTimer.unref?.();
  });

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[server] ${signal} received, starting graceful shutdown`);
    const FORCE_EXIT_MS = 10_000;
    const forceTimer = setTimeout(() => {
      console.error(`[server] forced exit after ${FORCE_EXIT_MS}ms during shutdown`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      if (stuckRecoveryTimer) {
        clearInterval(stuckRecoveryTimer);
        stuckRecoveryTimer = null;
      }

      if (REDIS_URL) {
        await redisClient.quit();
      }

      console.log("[server] graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("[server] shutdown error:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
}

main().catch((e) => {
  console.error("[server] fatal startup error:", e);
  process.exit(1);
});
