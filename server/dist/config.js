"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CREDITS_ENABLED = exports.PUBLIC_ORIGIN = exports.GOOGLE_CALLBACK_URL = exports.GOOGLE_CLIENT_SECRET = exports.GOOGLE_CLIENT_ID = exports.REDIS_URL = exports.SESSION_SECRET = exports.PORT = exports.NODE_ENV = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.NODE_ENV = process.env.NODE_ENV ?? "development";
exports.PORT = Number(process.env.PORT ?? 5000);
exports.SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
exports.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
exports.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
exports.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
exports.GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";
exports.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN
    ? process.env.PUBLIC_ORIGIN.split(",").map(v => v.trim())
    : ["http://localhost:5173", "http://localhost:5000"];
exports.CREDITS_ENABLED = process.env.CREDITS_ENABLED === "1";
