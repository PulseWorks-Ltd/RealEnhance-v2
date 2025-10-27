import { Router, Request, Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser, chargeForImages } from "../services/users.js";
import { enqueueEnhanceJob } from "../services/jobs.js";

// --- define a local file type so TS stops yelling ---
type UploadedFile = {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  filename?: string;
  path?: string;
  buffer?: Buffer;
};

// configure Multer storage
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(process.cwd(), "server", "uploads"),
    filename(_req, file, cb) {
      // keep original name or generate unique one, whichever you were doing before
      cb(null, file.originalname);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per image, adjust if you had a different limit
  },
});

export function uploadRouter() {
  const r = Router();

  r.post("/upload", upload.array("images", 20), async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const files = (req.files as unknown as UploadedFile[]) || [];

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
    await chargeForImages(sessUser.id, files.length);

    const jobRefs: Array<{ jobId: string; imageId: string }> = [];

    // Ensure subfolder by user
    const userDir = path.join(process.cwd(), "server", "uploads", sessUser.id);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const opts = optionsList[i] || {
        declutter: false,
        virtualStage: false,
        roomType: "unknown",
        sceneType: "interior",
      };

      const ext = path.extname(f.originalname) || ".jpg";
      const finalPath = path.join(userDir, f.filename || f.originalname + ext);
      if (f.path) fs.renameSync(f.path, finalPath);

      const rec = createImageRecord({
        userId: sessUser.id,
        originalPath: finalPath,
        roomType: opts.roomType,
        sceneType: opts.sceneType,
      });

      addImageToUser(sessUser.id, rec.imageId);

      const { jobId } = await enqueueEnhanceJob({
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

