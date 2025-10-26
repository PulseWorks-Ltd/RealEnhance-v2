"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.galleryRouter = galleryRouter;
const express_1 = require("express");
const images_1 = require("../services/images");
function galleryRouter() {
    const r = (0, express_1.Router)();
    r.get("/gallery", (req, res) => {
        const sessUser = req.session?.user;
        if (!sessUser) {
            return res.status(401).json({ error: "not_authenticated" });
        }
        const imgs = (0, images_1.listImagesForUser)(sessUser.id);
        res.json({
            images: imgs.map(img => ({
                imageId: img.imageId,
                currentVersionId: img.currentVersionId,
                roomType: img.roomType,
                sceneType: img.sceneType,
                history: img.history.map(v => ({
                    versionId: v.versionId,
                    stageLabel: v.stageLabel,
                    filePath: v.filePath,
                    note: v.note,
                    createdAt: v.createdAt
                }))
            }))
        });
    });
    return r;
}
