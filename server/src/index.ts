import express from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import dotenv from "dotenv";

import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js";

dotenv.config();

/* -------------------------------------------------------------------------- */
/*                               Path + Constants                             */
/* -------------------------------------------------------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientBuildDir = path.resolve(__dirname, "../../client/dist");

const PORT = process.env.PORT || "8080";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";

/* -------------------------------------------------------------------------- */
/*                                Main Startup                                */
/* -------------------------------------------------------------------------- */
async function main() {
  /* --------------------------- Redis + Store Setup --------------------------- */
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  // connect-redis v7 -> class, not a function
  const store = new RedisStore({
    client: redisClient,
    prefix: "sess:",
  });

  /* ------------------------------- Express App ------------------------------- */
  const app = express();
  app.set("trust proxy", 1); // important for secure cookies behind Railway proxy

  // Core middleware
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

  /* --------------------------- Session Middleware --------------------------- */
  app.use(
    session({
      store,
      secret: SESSION_SECRET,
      name: "realsess",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  /* ----------------------------- Health Endpoint ----------------------------- */
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  /* ------------------------- Auth + API Endpoints ---------------------------- */
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());

  /* --------------------------- Static File Serving --------------------------- */
  app.use(express.static(clientBuildDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientBuildDir, "index.html"));
  });

  /* ------------------------------- Start Server ------------------------------ */
  app.listen(Number(PORT), () => {
    console.log(`[server] listening on port ${PORT}`);
  });

  /* ------------------------------ Graceful Exit ------------------------------ */
  process.on("SIGTERM", async () => {
    console.log("Shutting down server...");
    await redisClient.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
