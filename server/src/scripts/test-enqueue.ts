import fs from "fs";
import path from "path";
import { setCreditsForEmail, addImageToUser } from "../services/users.js";
import { createImageRecord } from "../services/images.js";
import { enqueueEnhanceJob } from "../services/jobs.js";

async function main() {
  const email = process.env.TEST_EMAIL || "test@example.com";
  const name = process.env.TEST_NAME || "Test User";
  const declutter = process.env.TEST_DECLUTTER === "1";
  const virtualStage = process.env.TEST_VSTAGE === "1";
  const roomType = process.env.TEST_ROOMTYPE || "living_room";
  const sceneType = process.env.TEST_SCENE || "auto";

  const user = setCreditsForEmail(email, 1000, name);
  const userId = user.id;

  const uploadsDir = path.join(process.cwd(), "server", "uploads", userId);
  fs.mkdirSync(uploadsDir, { recursive: true });
  const imgPath = path.join(uploadsDir, "test.png");

  // 1x1 PNG buffer
  const png1x1 = Buffer.from(
    "89504E470D0A1A0A0000000D4948445200000001000000010802000000907724A90000000A49444154789C6360000002000100FFFF03000006000557BF2A0000000049454E44AE426082",
    "hex"
  );
  fs.writeFileSync(imgPath, png1x1);

  const rec = createImageRecord({ userId, originalPath: imgPath, roomType, sceneType });
  const imageId = (rec as any).imageId || (rec as any).id;
  addImageToUser(userId, imageId);

  const { jobId } = await enqueueEnhanceJob({
    userId,
    imageId,
    options: {
      declutter,
      virtualStage,
      roomType,
      sceneType,
      publicMode: "standard" // ✅ Default mode for test script
    }
  });

  console.log(JSON.stringify({ ok: true, userId, imageId, jobId }, null, 2));
}

main().catch((e) => {
  console.error("test-enqueue failed:", e);
  process.exit(1);
});
