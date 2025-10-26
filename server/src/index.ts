import express from "express";
import path from "node:path";
import fs from "node:fs";
import morgan from "morgan";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import { createClient } from "redis";
const connectRedis = require("connect-redis");
const RedisStore = connectRedis(session);

import { initAuth } from "./auth/google";
import { registerAuthUserRoutes } from "./routes.auth-user";

const {
  NODE_ENV = "production",
  PORT = "8080",
  PUBLIC_ORIGIN = "",
  REDIS_URL,
  SESSION_SECRET,
} = process.env;

const app = express();
app.set("trust proxy", 1);

// ---------------- Middleware ----------------
app.use(morgan("dev"));
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "https://js.stripe.com", "'unsafe-inline'"],
      },
    },
  })
);
app.use(
  cors({
    origin: PUBLIC_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    credentials: true,
  })
);
app.use(cookieParser());

// ---------------- Redis & Session ----------------
const redisClient = createClient({ url: REDIS_URL });
redisClient.on("error", (err) => console.error("[redis] error", err));
redisClient.connect().then(() => console.log("[redis] connected"));

app.use(
  session({
    name: "realsess",
    store: new RedisStore({
      client: redisClient,
      prefix: "realsess:",
    }),
    secret: SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      httpOnly: true,
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// ---------------- Auth Routes ----------------
initAuth(app);
registerAuthUserRoutes(app);

// ---------------- Health Check ----------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() });
});

// ---------------- Static Frontend ----------------
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  const indexFile = path.join(clientDist, "index.html");
  if (fs.existsSync(indexFile)) res.sendFile(indexFile);
  else res.status(500).send("Frontend build missing");
});

// ---------------- Start Server ----------------
app.listen(Number(PORT), () => {
  console.log(`[RealEnhance] listening on port ${PORT}`);
});
