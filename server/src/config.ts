import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const envPath = path.resolve(serverRoot, ".env");
dotenv.config({ path: envPath });

export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const PORT = Number(process.env.PORT ?? 5000);

export const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
// Prefer private/internal Redis URL when available
export const REDIS_URL =
  process.env.REDIS_PRIVATE_URL ||
  process.env.REDIS_URL ||
  "redis://localhost:6379";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";

// Default free credits granted on first user/org creation
export const INITIAL_FREE_CREDITS = Number.isFinite(Number(process.env.INITIAL_FREE_CREDITS))
  ? Number(process.env.INITIAL_FREE_CREDITS)
  : 50;

export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN
  ? process.env.PUBLIC_ORIGIN.split(",").map(v => v.trim())
  : ["http://localhost:5173", "http://localhost:5000"];

export const CREDITS_ENABLED = process.env.CREDITS_ENABLED === "1";

// Launch trial gate (minimal deterministic rule)
export const LAUNCH_TRIAL_MAX_AGENCIES = 20;
export const LAUNCH_TRIAL_CREDITS = 75;
export const LAUNCH_TRIAL_DAYS = 30;
