import { regionEditRouter } from "./routes/region-edit";

// Register region-edit route at /api/region-edit
app.use("/api/region-edit", regionEditRouter());
import { visionRoomTypeRouter } from "./routes/vision-room-type.js";
// server/src/index.ts
import express, { type Express } from "express";
import session, { type SessionOptions } from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { attachGoogleAuth } from "./auth/google.js";
import { setCreditsForEmail } from "./services/users.js";
import { authUserRouter } from "./routes/authUser.js";
import { registerMeRoutes } from "./routes.me.js";
import { uploadRouter } from "./routes/upload.js";
import { statusRouter, debugStatusRouter } from "./routes/status.js";
import { editRouter } from "./routes/edit.js";
import { requeueRouter } from "./routes/requeue.js";
import { retrySingleRouter } from "./routes/retrySingle.js";
import { regionEditRouter } from "./routes/region-edit.js";
import { cancelRouter } from "./routes/cancel.js";
import { groupsRouter } from "./routes/groups.js";
import { healthRouter } from "./routes/health.js";
import { undoRouter } from "./routes/undo.js";
import path from "path";
import fs from "fs";
import { NODE_ENV, PORT, PUBLIC_ORIGIN, SESSION_SECRET, REDIS_URL } from "./config.js";
import { requireS3OrExit } from "./utils/s3.js";

const IS_PROD = NODE_ENV === "production";

async function main() {
  // ---------------- Redis ----------------
  const redisClient: RedisClientType = createRedisClient({ url: REDIS_URL || undefined });
  redisClient.on("error", (err) => console.error("[redis] error", err));
  if (REDIS_URL) {
    await redisClient.connect();
  } else {
    console.warn("[redis] REDIS_URL not set; session store will not connect.");
  }

  const store = REDIS_URL
    ? new RedisStore({ client: redisClient as any, prefix: "sess:" })
    : undefined;

  // ---------------- Express ----------------
  const app: Express = express();

  // Hard-fail S3 early if required (production) to avoid silent local fallback
  await requireS3OrExit();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: PUBLIC_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "X-Requested-With"]
    })
  );
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' })); // Increased for data URLs from worker
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
      sameSite: IS_PROD ? "none" : "lax",
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  };
  app.use(session(sessionOptions));

  // Health
  app.get("/health", (_req, res) => {
    res.json({ ok: true, env: process.env.NODE_ENV || "dev", time: new Date().toISOString() });
  });

  // Auth + API routes
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());
  registerMeRoutes(app);
  app.use("/api", uploadRouter());
  app.use("/api", statusRouter());
  // Optional debugging route to inspect BullMQ job state/returnvalue
  app.use("/api", debugStatusRouter());
  app.use("/api", editRouter());
  app.use("/api", requeueRouter());
  app.use("/api", retrySingleRouter());
  app.use("/api", regionEditRouter);
  app.use(cancelRouter());
  app.use("/api", groupsRouter());
  app.use("/api", healthRouter());
  app.use("/api", undoRouter());
  // Register ML-based room type detection API
  app.use("/api", visionRoomTypeRouter);

  // Static file serving for uploaded and data images (development-friendly)
  const filesRoot = path.join(process.cwd(), "server");
  if (fs.existsSync(filesRoot)) {
    app.use("/files", express.static(filesRoot));
  }

  // One-time admin seeding to guarantee partner accounts have 10k credits
  try {
    const seededA = setCreditsForEmail("pulseworkslimited@gmail.com", 10000, "PulseWorks Limited");
    const seededB = setCreditsForEmail("propertybrokershaun@gmail.com", 10000, "Shaun (Property Brokers)");
    console.log("[seed] ensured credits:", { a: seededA.email, credits: seededA.credits }, { b: seededB.email, credits: seededB.credits });
  } catch (e) {
    console.warn("[seed] failed to ensure credits:", e);
  }

  // Bind host/port for local dev and production (Railway)
  const PORT = Number(process.env.PORT || 5000);
  const HOST = 
    process.env.HOST ||
    (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

  app.listen(PORT, HOST, () => {
    console.log(`[server] listening on ${HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'}, PORT=${PORT})`);
  });

  process.on("SIGTERM", async () => {
    try {
      if (REDIS_URL) await redisClient.quit();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((e) => {
  console.error("[server] fatal startup error:", e);
  process.exit(1);
});
