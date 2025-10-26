import express, { Request, Response } from "express";
import session from "express-session";
import RedisStoreFactory from "connect-redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import { createClient as createRedisClient } from "redis";
import dotenv from "dotenv";

import { attachGoogleAuth } from "./auth/google";
import { authUserRouter } from "./routes/authUser"; // <-- named import ✅

dotenv.config();

/**
 * ENV + config
 */
const PORT = process.env.PORT || "8080";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";

async function main() {
  /**
   * Redis client for session store
   */
  const redisClient = createRedisClient({
    url: REDIS_URL,
  });
  await redisClient.connect();

  const RedisStore = RedisStoreFactory(session);

  /**
   * Express app
   */
  const app = express();

  // security / middleware
  app.use(
    cors({
      origin: PUBLIC_ORIGIN,
      credentials: true,
    })
  );
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // sessions
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
      store: new RedisStore({
        client: redisClient as any,
        prefix: "sess:",
      }),
    })
  );

  /**
   * Routes
   */

  // healthcheck for Railway
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // google auth / logout endpoints
  attachGoogleAuth(app);

  // authenticated user info, credits, history, etc.
  app.use("/api/auth-user", authUserRouter()); // <-- call the factory ✅

  /**
   * Serve built client (adjust path if your client build output differs)
   */
  const clientBuildDir = path.join(__dirname, "..", "..", "client", "dist");
  app.use(express.static(clientBuildDir));

  // Single Page App fallback
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(clientBuildDir, "index.html"));
  });

  /**
   * Start server
   */
  app.listen(Number(PORT), () => {
    console.log(`[server] listening on ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
