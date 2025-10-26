"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.editRouter = editRouter;
const express_1 = require("express");
const images_1 = require("../services/images");
const jobs_1 = require("../services/jobs");
function editRouter() {
    const r = (0, express_1.Router)();
    r.post("/edit", async (req, res) => {
        const sessUser = req.session?.user;
        if (!sessUser) {
            return res.status(401).json({ error: "not_authenticated" });
        }
        // body:
        // {
        //   "imageId": "...",
        //   "baseVersionId": "...",
        //   "mode": "Add"|"Remove"|"Replace"|"Restore",
        //   "instruction": "Add a bed...",
        //   "mask": {...}
        // }
        const { imageId, baseVersionId, mode, instruction, mask } = req.body || {};
        const rec = (0, images_1.getImageRecord)(imageId);
        if (!rec) {
            return res.status(404).json({ error: "image_not_found" });
        }
        if (rec.ownerUserId !== sessUser.id) {
            return res.status(403).json({ error: "forbidden" });
        }
        const baseOk = rec.history.find(v => v.versionId === baseVersionId);
        if (!baseOk) {
            return res.status(400).json({ error: "invalid_base_version" });
        }
        const { jobId } = await (0, jobs_1.enqueueEditJob)({
            userId: sessUser.id,
            imageId,
            baseVersionId,
            mode,
            instruction,
            mask
        });
        res.json({ jobId });
    });
    return r;
}
