// server/scripts/test-analysis.ts
// Test script for Auto Failure Analysis feature

import { runAnalysisForJob, getConfig } from "../src/services/analysisOrchestrator.js";
import { getLatestAnalysisForJob } from "@realenhance/shared/analysis/storage.js";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, "../.env") });

async function testAnalysis() {
  console.log("🧪 Testing Auto Failure Analysis Feature\n");

  // Check configuration
  console.log("1️⃣  Checking configuration...");
  const config = getConfig();
  console.log("   Config:", JSON.stringify(config, null, 2));

  if (!config.configured) {
    console.error("❌ Gemini API not configured!");
    console.error("   Add GEMINI_API_KEY to server/.env");
    console.error("   Get your key from: https://aistudio.google.com/apikey");
    process.exit(1);
  }

  if (!config.enabled) {
    console.error("❌ Analysis feature is disabled!");
    console.error("   Set ANALYSIS_ENABLED=true in server/.env");
    process.exit(1);
  }

  console.log("✅ Configuration OK\n");

  // Get job ID from command line
  const jobId = process.argv[2];

  if (!jobId) {
    console.log("📝 Usage: npx tsx server/scripts/test-analysis.ts <jobId>\n");
    console.log("Example: npx tsx server/scripts/test-analysis.ts job_123abc\n");
    console.log("To find a failed job:");
    console.log('   cat server/data/jobs.json | grep -B 5 "FAILED" | grep jobId\n');
    process.exit(1);
  }

  console.log(`2️⃣  Running analysis for job: ${jobId}\n`);

  try {
    // Check for existing analysis
    const existing = getLatestAnalysisForJob(jobId);
    if (existing) {
      console.log("ℹ️  Found existing analysis:");
      console.log(`   ID: ${existing.id}`);
      console.log(`   Status: ${existing.status}`);
      console.log(`   Trigger: ${existing.trigger}`);
      console.log(`   Created: ${existing.createdAt}`);
      console.log();
    }

    // Run analysis
    console.log("🤖 Calling Gemini API...");
    const startTime = Date.now();

    const analysis = await runAnalysisForJob(jobId, "MANUAL");

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Analysis completed in ${duration}s\n`);

    // Display results
    console.log("📊 Analysis Results:\n");
    console.log(`   ID: ${analysis.id}`);
    console.log(`   Status: ${analysis.status}`);
    console.log(`   Model: ${analysis.model}`);
    console.log(`   Prompt Version: ${analysis.promptVersion}`);

    if (analysis.status === "COMPLETE" && analysis.output) {
      console.log("\n" + "=".repeat(60));
      console.log("PRIMARY ISSUE:");
      console.log("=".repeat(60));
      console.log(analysis.output.primary_issue);

      console.log("\n" + "=".repeat(60));
      console.log("ASSESSMENT:");
      console.log("=".repeat(60));
      console.log(`Classification: ${analysis.output.assessment.classification}`);
      console.log(`Confidence: ${analysis.output.assessment.confidence}`);
      console.log(`Notes: ${analysis.output.assessment.notes}`);

      if (analysis.output.supporting_evidence.length > 0) {
        console.log("\n" + "=".repeat(60));
        console.log("SUPPORTING EVIDENCE:");
        console.log("=".repeat(60));
        analysis.output.supporting_evidence.forEach((evidence, i) => {
          console.log(`${i + 1}. ${evidence}`);
        });
      }

      console.log("\n" + "=".repeat(60));
      console.log("RECOMMENDED ACTIONS:");
      console.log("=".repeat(60));

      if (analysis.output.recommended_actions.prompt_changes.length > 0) {
        console.log("\nPrompt Changes:");
        analysis.output.recommended_actions.prompt_changes.forEach((action, i) => {
          console.log(`  ${i + 1}. ${action}`);
        });
      }

      if (analysis.output.recommended_actions.validator_adjustments.length > 0) {
        console.log("\nValidator Adjustments:");
        analysis.output.recommended_actions.validator_adjustments.forEach((action, i) => {
          console.log(`  ${i + 1}. ${action}`);
        });
      }

      if (analysis.output.recommended_actions.pipeline_logic_changes.length > 0) {
        console.log("\nPipeline Logic Changes:");
        analysis.output.recommended_actions.pipeline_logic_changes.forEach((action, i) => {
          console.log(`  ${i + 1}. ${action}`);
        });
      }

      if (analysis.output.recommended_actions.model_changes.length > 0) {
        console.log("\nModel Changes:");
        analysis.output.recommended_actions.model_changes.forEach((action, i) => {
          console.log(`  ${i + 1}. ${action}`);
        });
      }

      if (analysis.output.do_not_recommend.length > 0) {
        console.log("\n" + "=".repeat(60));
        console.log("DO NOT RECOMMEND:");
        console.log("=".repeat(60));
        analysis.output.do_not_recommend.forEach((action, i) => {
          console.log(`${i + 1}. ${action}`);
        });
      }

      console.log("\n" + "=".repeat(60));
    } else if (analysis.status === "FAILED") {
      console.log("\n❌ Analysis failed:");
      console.log(`   Error: ${analysis.error}`);
    }

    console.log("\n✅ Test completed successfully!");
    console.log(`\nView full analysis in: server/data/job_analysis.json`);
    console.log(`Analysis ID: ${analysis.id}\n`);
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

testAnalysis().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
