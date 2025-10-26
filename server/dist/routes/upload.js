"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadRouter = uploadRouter;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const images_1 = require("../services/images");
const users_1 = require("../services/users");
const jobs_1 = require("../services/jobs");
// configure Multer storage
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: node_path_1.default.join(process.cwd(), "server", "uploads"),
        filename(_req, file, cb) {
            // keep original name or generate unique one, whichever you were doing before
            cb(null, file.originalname);
        },
    }),
    limits: {
        fileSize: 25 * 1024 * 1024, // 25MB per image, adjust if you had a different limit
    },
});
function uploadRouter() {
    const r = (0, express_1.Router)();
    r.post("/upload", upload.array("images", 20), async (req, res) => {
        const sessUser = req.session?.user;
        if (!sessUser) {
            return res.status(401).json({ error: "not_authenticated" });
        }
        const files = req.files || [];
        // Frontend should send `options` as a JSON string with per-file options:
        // [
        //   { declutter:true, virtualStage:true, roomType:"bedroom", sceneType:"interior" },
        //   ...
        // ]
        const raw = req.body?.options;
        const optionsList = raw ? JSON.parse(raw) : [];
        if (!files.length) {
            return res.status(400).json({ error: "no_files" });
        }
        // Optional credit charge
        await (0, users_1.chargeForImages)(sessUser.id, files.length);
        const jobRefs = [];
        // Ensure subfolder by user
        const userDir = node_path_1.default.join(process.cwd(), "server", "uploads", sessUser.id);
        if (!node_fs_1.default.existsSync(userDir))
            node_fs_1.default.mkdirSync(userDir, { recursive: true });
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const opts = optionsList[i] || {
                declutter: false,
                virtualStage: false,
                roomType: "unknown",
                sceneType: "interior",
            };
            const ext = node_path_1.default.extname(f.originalname) || ".jpg";
            const finalPath = node_path_1.default.join(userDir, f.filename || f.originalname + ext);
            if (f.path)
                node_fs_1.default.renameSync(f.path, finalPath);
            const rec = (0, images_1.createImageRecord)({
                userId: sessUser.id,
                originalPath: finalPath,
                roomType: opts.roomType,
                sceneType: opts.sceneType,
            });
            (0, users_1.addImageToUser)(sessUser.id, rec.imageId);
            const { jobId } = await (0, jobs_1.enqueueEnhanceJob)({
                userId: sessUser.id,
                imageId: rec.imageId,
                options: {
                    declutter: !!opts.declutter,
                    virtualStage: !!opts.virtualStage,
                    roomType: opts.roomType,
                    sceneType: opts.sceneType,
                },
            });
            jobRefs.push({ jobId, imageId: rec.imageId });
        }
        res.json({ jobs: jobRefs });
    });
    return r;
}
