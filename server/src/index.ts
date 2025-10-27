import express, { Request, Response } from "express";
import session from "express-session";
import RedisStoreFactory from "connect-redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createClient as createRedisClient } from "redis";
import dotenv from "dotenv";

import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js"; // named import ✅

dotenv.config();

/**
 * Path helpers for serving client files
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientBuildDir = path.resolve(__dirname, "./static");
const allowedOrigins = [
  "http://localhost:5173", // local dev: Vite
  "https://client-production-3021.up.railway.app", // your deployed frontend
];

/**
 * ENV + config
 */
const PORT = process.env.PORT || "8080";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";

async function main() {
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  const RedisStore = RedisStoreFactory(session);
  const app = express();

  app.set("trust proxy", 1);

  app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
  );
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // Google Auth + user routes
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());

  // ✅ Serve React frontend
  app.use(express.static(clientBuildDir));
  app.get("*", (_req: Request, res: Response) => {
  res.sendFile(path.join(clientBuildDir, "index.html"));
  });

  app.listen(Number(PORT), () => {
    console.log(`[server] listening on ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
