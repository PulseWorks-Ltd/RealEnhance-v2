"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const config_1 = require("./config");
const sessionStore_1 = require("./sessionStore");
// routes
const authUser_1 = require("./routes/authUser");
const upload_1 = require("./routes/upload");
const status_1 = require("./routes/status");
const gallery_1 = require("./routes/gallery");
const edit_1 = require("./routes/edit");
const health_1 = require("./routes/health");
// google auth (stubbed)
const google_1 = require("./auth/google");
async function main() {
    const app = (0, express_1.default)();
    app.set("trust proxy", 1);
    // logging
    app.use((0, morgan_1.default)(config_1.NODE_ENV === "production" ? "combined" : "dev"));
    // security headers
    app.use((0, helmet_1.default)({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                "default-src": ["'self'"],
                "script-src": [
                    "'self'",
                    "https://accounts.google.com"
                ],
                "style-src": ["'self'", "'unsafe-inline'"],
                "img-src": ["'self'", "data:", "blob:"],
                "connect-src": [
                    "'self'",
                    ...config_1.PUBLIC_ORIGIN,
                    "https://accounts.google.com",
                    "https://www.googleapis.com"
                ],
                "frame-src": [
                    "'self'",
                    "https://accounts.google.com"
                ]
            }
        },
        crossOriginEmbedderPolicy: false
    }));
    // cors
    const corsOptions = {
        origin(origin, cb) {
            // you probably had something like:
            // allow localhost + your prod domain
            const allowed = [
                "http://localhost:5173",
                "http://localhost:3000",
                "https://your-production-domain.com"
            ];
            if (!origin || allowed.includes(origin)) {
                cb(null, true);
            }
            else {
                cb(new Error("Not allowed by CORS"));
            }
        },
        credentials: true
    };
    app.use((0, cookie_parser_1.default)());
    app.use(express_1.default.json({ limit: "25mb" }));
    app.use(express_1.default.urlencoded({ extended: true }));
    // session (redis-backed)
    const { middleware: sessionMw } = await (0, sessionStore_1.buildSessionMiddleware)();
    app.use(sessionMw);
    // attach Google OAuth routes
    (0, google_1.attachGoogleAuth)(app);
    // API routes
    app.use("/api", (0, authUser_1.authUserRouter)());
    app.use("/api", (0, upload_1.uploadRouter)());
    app.use("/api", (0, status_1.statusRouter)());
    app.use("/api", (0, gallery_1.galleryRouter)());
    app.use("/api", (0, edit_1.editRouter)());
    app.use("/api", (0, health_1.healthRouter)());
    // static frontend
    const clientDistDir = node_path_1.default.join(process.cwd(), "client", "dist", "public");
    if (node_fs_1.default.existsSync(clientDistDir)) {
        app.use(express_1.default.static(clientDistDir, { index: false }));
    }
    else {
        console.warn("[static] client/dist/public not found. Did you run `pnpm --filter client build`?");
    }
    // SPA fallback
    app.get("*", (req, res, next) => {
        if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
            return next();
        }
        const indexHtmlPath = node_path_1.default.join(clientDistDir, "index.html");
        if (node_fs_1.default.existsSync(indexHtmlPath)) {
            return res.sendFile(indexHtmlPath);
        }
        return res
            .status(500)
            .send("Frontend build not found. Did you run client build?");
    });
    // error handler
    app.use((err, _req, res, _next) => {
        console.error("[server error]", err);
        res.status(500).json({
            ok: false,
            error: err?.message ?? "Internal Server Error"
        });
    });
    app.listen(config_1.PORT, () => {
        console.log(`[RealEnhance] listening on ${config_1.PORT}`);
    });
}
main().catch(err => {
    console.error("Fatal boot error:", err);
    process.exit(1);
});
