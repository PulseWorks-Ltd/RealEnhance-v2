import dotenv from "dotenv";
dotenv.config();

export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const PORT = Number(process.env.PORT ?? 5000);

export const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";

export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN
  ? process.env.PUBLIC_ORIGIN.split(",").map(v => v.trim())
  : ["http://localhost:5173", "http://localhost:5000"];

export const CREDITS_ENABLED = process.env.CREDITS_ENABLED === "1";
