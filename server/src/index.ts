// server/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js";

// -------- ENV --------
const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const PUBLIC_ORIGIN =
  process.env.PUBLIC_ORIGIN || "http://localhost:3000"; // your client URL
const IS_PROD = process.env.NODE_ENV === "production";

async function main() {
  // -------- Redis + connect-redis v7 --------
  const redisClient: RedisClientType = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  const store = new RedisStore({
  client: redisClient,
  prefix: "sess:",
  });
 
  // -------- Express --------
  const app = express();
  app.set("trust proxy", 1); // behind Railway proxy

  app.use(
    cors({
      origin: PUBLIC_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sessions (SameSite=None for cross-site cookies in prod)
  app.use(
    session({
      name: "realsess",
      secret: SESSION_SECRET,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: IS_PROD ? "none" : "lax",
        secure: IS_PROD, // Railway uses HTTPS
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  // Health
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // Auth + routes
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());

  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    try {
      await redisClient.quit();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
