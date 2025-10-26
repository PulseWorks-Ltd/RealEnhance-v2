"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSessionMiddleware = buildSessionMiddleware;
const express_session_1 = __importDefault(require("express-session"));
const redis_1 = require("redis");
const connect_redis_1 = __importDefault(require("connect-redis"));
const config_1 = require("./config");
const RedisStore = (0, connect_redis_1.default)(express_session_1.default);
async function buildSessionMiddleware() {
    const redisClient = (0, redis_1.createClient)({ url: config_1.REDIS_URL });
    await redisClient.connect();
    const store = new RedisStore({
        client: redisClient,
        prefix: "realsess:"
    });
    const middleware = (0, express_session_1.default)({
        store,
        name: "realsess",
        secret: config_1.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: config_1.NODE_ENV === "production",
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    });
    return { middleware, redisClient };
}
