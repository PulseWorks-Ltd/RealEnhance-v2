"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = healthRouter;
const express_1 = require("express");
const config_1 = require("../config");
function healthRouter() {
    const r = (0, express_1.Router)();
    r.get("/health", (_req, res) => {
        res.json({
            ok: true,
            env: config_1.NODE_ENV,
            time: new Date().toISOString()
        });
    });
    return r;
}
