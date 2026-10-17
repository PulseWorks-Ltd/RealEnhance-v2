import { runStage1A } from "../pipeline/stage1A";
(async () => {
  const out = await runStage1A(process.env.IN_PATH as string, {
    sceneType: "exterior", jobId: "local_repro_" + (process.env.RUN || "0"), imageId: "local_repro_img", roomType: "unknown",
  });
  console.log("RESULT_PATH", out);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
