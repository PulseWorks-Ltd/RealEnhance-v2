"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusRouter = statusRouter;
const express_1 = require("express");
const jobs_1 = require("../services/jobs");
function statusRouter() {
    const r = (0, express_1.Router)();
    r.get("/status/:jobId", (req, res) => {
        const sessUser = req.session?.user;
        if (!sessUser) {
            return res.status(401).json({ error: "not_authenticated" });
        }
        const job = (0, jobs_1.getJob)(req.params.jobId);
        if (!job)
            return res.status(404).json({ error: "not_found" });
        if (job.userId !== sessUser.id) {
            return res.status(403).json({ error: "forbidden" });
        }
        res.json(job);
    });
    return r;
}
