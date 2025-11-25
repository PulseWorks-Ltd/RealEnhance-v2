import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile } from "../services/jsonStore.js";
import { enqueueEditJob } from "../services/jobs.js";

type ImagesState = Record<string, any>;

const uploadRoot = path.join(process.cwd(), "server", "uploads");

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(uploadRoot, { recursive: true });
      cb(null, uploadRoot);
    } catch (e) {
      cb(e as Error, uploadRoot);
    }
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

function parseRetryInfo(url: string) {
  const noQuery = url.split("?")[0];
  const filename = noQuery.split("/").pop() || "";
  // retryN at the end of the filename before extension
  const retryMatch = filename.match(/-retry(\d+)(?=\.[^.]+$)/);
  const retry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
  const baseKey = filename.replace(/-retry\d+(?=\.[^.]+$)/, "");
  return { noQuery, filename, baseKey, retry };
}

function findByPublicUrl(userId: string, url: string) {
  const images = readJsonFile<ImagesState>("images.json", {});
  const target = parseRetryInfo(url);

  let exactOwnerMatch: { record: any; versionId: string } | null = null;
  let exactAnyMatch: { record: any; versionId: string } | null = null;

  type Candidate = { record: any; versionId: string; retry: number; owner: string };

  const familyCandidates: Candidate[] = [];

  for (const rec of Object.values(images) as any[]) {
    if (!rec) continue;

    const owner = rec.ownerUserId;
    for (const v of rec.history || []) {
      const pubUrl = String((v as any).publicUrl || "");
      if (!pubUrl) continue;

      const info = parseRetryInfo(pubUrl);

      // 1) Exact URL match (no query)
      if (info.noQuery === target.noQuery) {
        const candidate = { record: rec, versionId: v.versionId };
        if (owner === userId) {
          exactOwnerMatch = candidate;
          break;
        }
        if (!exactAnyMatch) {
          exactAnyMatch = candidate;
        }
      }

      // 2) Collect same-family candidates for possible fallback later
      if (info.baseKey === target.baseKey) {
        familyCandidates.push({
          record: rec,
          versionId: v.versionId,
          retry: info.retry,
          owner,
        });
      }
    }

    if (exactOwnerMatch) break;
  }

  // Prefer exact URL + owner match
  if (exactOwnerMatch) return exactOwnerMatch;
  // Then exact URL, any owner
  if (exactAnyMatch) return exactAnyMatch;

  // 3) Fallback: same baseKey family
  if (familyCandidates.length > 0) {
    // Prefer same owner, highest retry number (most recent)
    const sameOwner = familyCandidates.filter((c) => c.owner === userId);
    const pool = sameOwner.length > 0 ? sameOwner : familyCandidates;

    const best = pool.reduce((best, cur) =>
      !best || cur.retry > best.retry ? cur : best,
      null as Candidate | null
    );

    if (best) {
      console.warn("[region-edit] Using family fallback match", {
        userId,
        targetUrl: url,
        baseKey: target.baseKey,
        chosenRetry: best.retry,
        owner: best.owner,
      });
      return { record: best.record, versionId: best.versionId };
    }
  }

  console.warn("[region-edit] No image record found for user", {
    userId,
    url,
    baseKey: target.baseKey,
  });
  return null;
}

export const regionEditRouter = Router();

// ✅ accept ANY file fields (no more "Unexpected field")
const uploadMw: RequestHandler = upload.any();

regionEditRouter.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
  console.log("[region-edit] POST hit");
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ success: false, error: "not_authenticated" });
    }

    // req.files is now an array from upload.any()
    const filesArray = (req.files as Express.Multer.File[]) || [];

    // Try the most likely fieldnames used by the client
    const maskFile =
      filesArray.find((f) => f.fieldname === "regionMask") || // 👈 NEW
      filesArray.find((f) => f.fieldname === "mask") ||
      filesArray.find((f) => f.fieldname === "file") ||
      filesArray.find((f) => f.fieldname === "image") ||
      filesArray[0] || // last-ditch fallback
      null;

    if (!maskFile) {
      console.warn(
        "[region-edit] No mask file found in upload. fields=",
        filesArray.map((f) => f.fieldname)
      );
      return res.status(400).json({ success: false, error: "missing_mask_file" });
    }

    const body = (req.body || {}) as any;

    const imageUrl = body.imageUrl as string | undefined;
    const mode = body.mode as "edit" | "restore_original" | undefined;
    const goal = typeof body.goal === "string" ? body.goal : "";
    const sceneType = body.sceneType;
    const roomType = body.roomType;
    const allowStaging = body.allowStaging === "true" || body.allowStaging === true;
    const stagingStyle = body.stagingStyle;

    if (!imageUrl) {
      return res.status(400).json({ success: false, error: "missing_imageUrl" });
    }
    if (!mode) {
      return res.status(400).json({ success: false, error: "missing_mode" });
    }
    if (!["edit", "restore_original"].includes(mode)) {
      return res.status(400).json({ success: false, error: "invalid_mode" });
    }
    if (mode === "edit" && !goal) {
      return res.status(400).json({ success: false, error: "instructions_required" });
    }

    const found = findByPublicUrl(sessUser.id, imageUrl);
    if (!found) {
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    const instruction =
      mode === "edit" ? goal : "Restore original pixels for the masked region.";

    let workerMode: "Add" | "Remove" | "Replace" | "Restore" = "Restore";
    if (mode === "edit") workerMode = "Replace";

    const jobPayload = {
      userId: sessUser.id,
      imageId: record.imageId || record.id,
      baseVersionId,
      mode: workerMode,
      instruction,
      mask: maskFile.path,
      allowStaging,
      stagingStyle,
      sceneType,
      roomType,
    };

    const { jobId } = await enqueueEditJob(jobPayload);
    return res.status(200).json({ success: true, jobId });
  } catch (err: any) {
    console.error("[region-edit] error", err);
    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }
});
