// server/src/index.ts
import dotenv from "dotenv";
dotenv.config();

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
import { statusRouter } from "./routes/status.js";
import { editRouter } from "./routes/edit.js";
import { requeueRouter } from "./routes/requeue.js";
import { cancelRouter } from "./routes/cancel.js";

const PORT = Number(process.env.PORT || 8080);
const IS_PROD = process.env.NODE_ENV === "production";
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "http://localhost:3000")
  .split(",")
  .map(s => s.trim());

const REDIS_URL =
  process.env.REDIS_URL ||
  (IS_PROD ? "" : "redis://localhost:6379"); // dev default

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";

async function main() {
  // ---------------- Redis ----------------
  const redisClient: RedisClientType = createRedisClient({ url: REDIS_URL || undefined });
  redisClient.on("error", (err) => console.error("[redis] error", err));
  if (REDIS_URL) {
    await redisClient.connect();
    console.log("[redis] connected");
  } else {
    console.warn("[redis] REDIS_URL not set; session store will not connect.");
  }

  const store = REDIS_URL
    ? new RedisStore({ client: redisClient as any, prefix: "sess:" })
    : undefined;

  // ---------------- Express ----------------
  const app: Express = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: PUBLIC_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    })
  );
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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
  app.use("/api", editRouter());
  app.use("/api", requeueRouter());
  app.use(cancelRouter());

  // One-time admin seeding to guarantee partner accounts have 10k credits
  try {
    const seededA = setCreditsForEmail("pulseworkslimited@gmail.com", 10000, "PulseWorks Limited");
    const seededB = setCreditsForEmail("propertybrokershaun@gmail.com", 10000, "Shaun (Property Brokers)");
    console.log("[seed] ensured credits:", { a: seededA.email, credits: seededA.credits }, { b: seededB.email, credits: seededB.credits });
  } catch (e) {
    console.warn("[seed] failed to ensure credits:", e);
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on ${PORT}`);
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
