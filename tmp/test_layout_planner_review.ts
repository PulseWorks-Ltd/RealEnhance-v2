// Layout-planner-only dry run (no Stage 2 generation) — for user review
// before deciding whether to proceed to generation. Forces anchorPlannerEnabled
// + structural baseline extraction exactly as worker.ts's real call does,
// but bypasses the resolvedPromptMode gate (living_dining/kitchen_dining
// are in stage2.ts's refreshOnlyRoomTypes set, which forces "refresh" mode
// unconditionally in real production — meaning the deterministic planner
// is never actually "eligible" there today; this test forces it on anyway
// to see what it WOULD produce).
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import fs from "node:fs";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { planStage2Layout, formatStage2LayoutPlanForPrompt } from "../worker/src/pipeline/layoutPlanner";

const OUT_DIR = path.resolve(__dirname, "../Test Images/Grok Skill Prompt Test");

type TestCase = { name: string; imagePath: string; roomType: string };

const CASES: TestCase[] = [
  { name: "Kitchen01_livingDining", imagePath: path.resolve(__dirname, "../Test Images/Kitchen/Kitchen 01.jpg"), roomType: "living_dining" },
  { name: "Kitchen06_kitchenDining", imagePath: path.resolve(__dirname, "../Test Images/Validator Testing Images/job_24a3b64f_Kitchen_06_UPLOAD.jpg"), roomType: "kitchen_dining" },
];

async function runCase(tc: TestCase, index: number) {
  console.log(`\n[${tc.name}] Extracting structural baseline (roomType=${tc.roomType})...`);
  const jobId = `test_layout_planner_${index}`;
  const imageId = `img_${tc.name}`;
  const baseline = await extractStructuralBaseline(tc.imagePath, { jobId, imageId });
  console.log(`[${tc.name}] Baseline: ${baseline.openings.length} openings, ${(baseline.anchorFixtures || []).length} fixtures`);

  console.log(`[${tc.name}] Running deterministic layout planner (anchorPlannerEnabled=true)...`);
  const plan = await planStage2Layout(tc.imagePath, {
    jobId,
    roomType: tc.roomType,
    stagingStyle: "standard_listing",
    anchorPlannerEnabled: true,
    structuralBaseline: baseline,
    useGeminiFallback: true,
  });

  if (!plan) {
    console.log(`[${tc.name}] Layout planner returned null.`);
    return { name: tc.name, ok: false };
  }

  console.log(`\n=== ${tc.name}: STRUCTURED PLAN ===`);
  console.log(JSON.stringify(plan, null, 2));

  const formatted = formatStage2LayoutPlanForPrompt(plan);
  console.log(`\n=== ${tc.name}: FORMATTED FOR PROMPT ===`);
  console.log(formatted);

  fs.writeFileSync(path.join(OUT_DIR, `${tc.name}-layoutplan.json`), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `${tc.name}-layoutplan-formatted.txt`), formatted);

  return { name: tc.name, ok: true, plan };
}

async function main() {
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    results.push(await runCase(CASES[i], i));
  }
  console.log("\n=== DONE ===");
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok })), null, 2));
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err, err?.stack);
  process.exit(1);
});
