// One-off script: enqueue two real Stage 2 jobs (living room + bedroom) through
// the real job pipeline (Postgres/JSON job store, Redis/BullMQ, S3), for the
// feature/vertex-mask-inpainting first real test run. Not part of the feature
// diff — run with: pnpm --filter server exec tsx ../tmp/run_vertex_inpaint_real_test.ts
import path from "path";
import { setCreditsForEmail, addImageToUser } from "../server/src/services/users.js";
import { createImageRecord } from "../server/src/services/images.js";
import { enqueueEnhanceJob } from "../server/src/services/jobs.js";
import { uploadOriginalToS3 } from "../server/src/utils/s3.js";

async function submitOne(params: { label: string; localPath: string; roomType: string }) {
  const email = "vertex-inpaint-test@realenhance.local";
  const user = await setCreditsForEmail(email, 1000, "Vertex Inpaint Test");
  const userId = user.id;

  const up = await uploadOriginalToS3(params.localPath);

  const rec = createImageRecord({
    userId,
    originalPath: params.localPath,
    roomType: params.roomType,
    sceneType: "interior",
  });
  const imageId = (rec as any).imageId || (rec as any).id;
  await addImageToUser(userId, imageId);

  const { jobId } = await enqueueEnhanceJob({
    userId,
    imageId,
    remoteOriginalUrl: up.url,
    remoteOriginalKey: up.key,
    options: {
      declutter: true,
      virtualStage: true,
      roomType: params.roomType,
      sceneType: "interior",
      stagingStyle: "standard_listing",
    },
  } as any);

  console.log(JSON.stringify({ label: params.label, ok: true, userId, imageId, jobId, s3Key: up.key }, null, 2));
  return { label: params.label, jobId, imageId };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const results = [];
  results.push(
    await submitOne({
      label: "living_33_kaipuke_07",
      localPath: path.join(repoRoot, "Test Images/Living (Baseline)/33 Kaipuke - Image 07.jpg"),
      roomType: "living_room",
    })
  );
  results.push(
    await submitOne({
      label: "bedroom_12",
      localPath: path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg"),
      roomType: "bedroom",
    })
  );
  console.log("\n=== SUBMITTED ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("run_vertex_inpaint_real_test failed:", e);
  process.exit(1);
});
