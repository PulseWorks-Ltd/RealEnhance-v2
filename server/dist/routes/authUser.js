"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authUserRouter = authUserRouter;
const express_1 = require("express");
const users_1 = require("../services/users");
const images_1 = require("../services/images");
function authUserRouter() {
    const r = (0, express_1.Router)();
    r.get("/auth/user", (req, res) => {
        const sessUser = req.session?.user;
        if (!sessUser)
            return res.json({});
        const full = (0, users_1.getUserById)(sessUser.id);
        if (!full)
            return res.json({});
        const imgs = (0, images_1.listImagesForUser)(full.id);
        res.json({
            id: full.id,
            name: full.name,
            email: full.email,
            credits: full.credits,
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
