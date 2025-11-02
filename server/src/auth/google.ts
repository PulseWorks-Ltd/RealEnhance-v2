// server/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express, { type RequestHandler } from "express";
import session, { type SessionOptions } from "express-session";
import connectRedis from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { attachGoogleAuth } from "server/src/auth/google.js";
import { authUserRouter } from "./routes/authUser.js";
import { registerMeRoutes } from "./routes.me.js";
import { uploadRouter } from "./routes/upload.js";

const PORT = Number(process.env.PORT || 8080);
const IS_PROD = process.env.NODE_ENV === "production";
const REDIS_URL = process.env.REDIS_URL || (IS_PROD ? "" : "redis://localhost:6379");
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";

/** Entrypoint */
async function main() {
  // ---------------------- Redis ----------------------
  if (IS_PROD && !REDIS_URL) {
    throw new Error("REDIS_URL must be set in production");
  }

  const redisClient: RedisClientType = createRedisClient({
    url: REDIS_URL,
    socket: {
      tls: REDIS_URL.startsWith("rediss://"),
      reconnectStrategy: (retries) => Math.min(retries * 1000, 15_000),
    },
  });

  redisClient.on("error", (err) => console.error("[redis] error:", err));
  redisClient.on("reconnecting", () => console.warn("[redis] reconnecting…"));

  await redisClient.connect();
  console.log("[redis] connected");

  const RedisStore = connectRedis(session);
  const store = new RedisStore({ client: redisClient as any, prefix: "sess:" });

  // ---------------------- Express ----------------------
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

  // ---------------------- Session ----------------------
  const sessionOptions: SessionOptions = {
    name: "realsess",
    secret: SESSION_SECRET,
    store,
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

  // ---------------------- Routes ----------------------
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  attachGoogleAuth(app);
  app.use("/api/auth-user", typeof authUserRouter === "function" ? authUserRouter() : authUserRouter);
  registerMeRoutes(app);
  app.use("/api", uploadRouter());

  // ---------------------- Start ----------------------
  app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("[server] shutting down gracefully…");
    try {
      await redisClient.quit();
    } catch (err) {
      console.error("[redis] quit error:", err);
    } finally {
      process.exit(0);
    }
  });
}

// Start the server
main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
