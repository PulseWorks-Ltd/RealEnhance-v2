// server/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import session, { type SessionOptions } from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js";
import { registerMeRoutes } from "./routes.me.js";
import { uploadRouter } from "./routes/upload.js"; // optional if you have upload.ts

import type { RequestHandler } from "express";

// -------- ENV --------
const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";
const IS_PROD = process.env.NODE_ENV === "production";

async function main() {
  // -------- Redis --------
  const redisClient: RedisClientType = createRedisClient({ url: REDIS_URL });
  redisClient.on("error", (err) => console.error("[redis] error", err));
  await redisClient.connect();

  const store = new RedisStore({
    client: redisClient,
    prefix: "sess:",
  });

  // -------- Express --------
  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: PUBLIC_ORIGIN.split(",").map((o) => o.trim()),
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
  app.use("/api", uploadRouter());

  // -------- Sessions --------
  const sessionOptions: SessionOptions = {
    name: "realsess",
    secret: SESSION_SECRET,
    store, // ✅ 'store' exists in this scope
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: IS_PROD ? "none" : "lax",
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  };
  
  app.use(session(sessionOptions) as unknown as RequestHandler);

  // -------- Routes --------
  app.get("/health", (_req, res) => {
    res.json({ ok: true, env: process.env.NODE_ENV || "dev", time: new Date().toISOString() });
  });

  attachGoogleAuth(app);
  app.use("/api/auth-user", typeof authUserRouter === "function" ? authUserRouter() : authUserRouter);
  registerMeRoutes(app);
  app.use("/api", uploadRouter()); // optional

  // -------- Start --------
  app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));

  process.on("SIGTERM", async () => {
    await redisClient.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
