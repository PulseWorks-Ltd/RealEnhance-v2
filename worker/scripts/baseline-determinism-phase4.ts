import * as fs from "fs/promises";
import * as path from "path";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });

type TestJob = {
  label: string;
  jobId: string;
  imageId: string;
  baselineFile: string;
  baselineUrl?: string;
};

const TEST_JOBS: TestJob[] = [
  {
    label: "job_c11a8e7c",
    jobId: "job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023",
    imageId: "img_aced9a07-fccd-4e24-b0ee-139d5bbcde1d",
    baselineFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9.jpg",
  },
  {
    label: "job_bb029607",
    jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
    imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
    baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
  },
  {
    label: "job_4a87f43b",
    jobId: "job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10",
    imageId: "img_a4f41fe0-ecc8-4bef-9a9b-0715d4e3963c",
    baselineFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or.jpg",
  },
  {
    label: "job_dfbe98aa",
    jobId: "job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1",
    imageId: "img_0c2e8e0d-2e87-4ae2-8b31-9c8c5e8c6f4a",
    baselineFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap.jpg",
  },
  {
    label: "job_81e485e7",
    jobId: "job_81e485e7-e3ce-4283-9f5e-e4f931d784bc",
    imageId: "img_228b053c-a06a-4f01-a3bf-123b2deaf8eb",
    baselineFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2.jpg",
  },
  {
    label: "job_4ceef035",
    jobId: "job_4ceef035-b334-489c-bf91-3591fa703257",
    imageId: "img_13682e51-d7fd-4900-9edc-1cffc8c4cd99",
    baselineFile: "job_4ceef035-stage1A.jpg",
    baselineUrl:
      "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782706114147-realenhance-job_4ceef035-b334-489c-bf91-3591fa703257-1782706084255-xp9qm6xmlj-canonical-1A-1a-delivery.jpg",
  },
];

const TEST_IMAGE_DIR = "/workspaces/RealEnhance-v2/Test Images/Envelope Test Images";
const REPORT_JSON = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase4.json";
const REPORT_MD = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase4.md";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadIfMissing(url: string | undefined, destinationPath: string): Promise<void> {
  if (!url) return;
  if (await fileExists(destinationPath)) return;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download benchmark artifact: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, bytes);
}

async function resolveBaselinePath(job: TestJob): Promise<string> {
  const baselinePath = path.join(TEST_IMAGE_DIR, job.baselineFile);
  if (await fileExists(baselinePath)) return baselinePath;
  await downloadIfMissing(job.baselineUrl, baselinePath);
  await fs.access(baselinePath);
  return baselinePath;
}

function normalizeRunView(baseline: any) {
  const validation = baseline?.observationMeta?.validation || {
    unknownReferences: [],
    duplicateReferences: [],
    unusedInventory: [],
    inconsistencies: [],
    rejectedAnchors: [],
    chosenAnchors: [],
    reconciliationActions: [],
    reconciliationReasons: [],
  };

  return {
    inventoryHash: String(baseline?.observationMeta?.inventoryHash || ""),
    observationHash: String(baseline?.observationMeta?.observationHash || ""),
    graphHash: String(baseline?.graphMeta?.graphHash || ""),
    identityHash: String(baseline?.observationMeta?.canonicalIdentityHash || ""),
    baselineStatus: String(baseline?.graphMeta?.baselineStatus || baseline?.observationMeta?.baselineStatus || "UNKNOWN"),
    baselineConfidence: Number(baseline?.graphMeta?.baselineConfidence ?? baseline?.observationMeta?.baselineConfidence ?? 0),
    validation,
    canonicalGraph: (baseline?.wallDescriptors || []).map((wall: any) => ({
      wallIndex: wall.wallIndex,
      canonicalWallId: wall.canonicalWallId,
      primaryAnchorLabel: wall.primaryAnchorLabel,
    })),
  };
}

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function confidenceStable(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.001;
}

async function main() {
  const jobs: any[] = [];

  for (const job of TEST_JOBS) {
    const baselinePath = await resolveBaselinePath(job);

    const run1 = await extractStructuralBaseline(baselinePath, {
      jobId: `${job.jobId}:phase4:run1`,
      imageId: job.imageId,
      attempt: 1,
      disableCache: true,
      baselineMode: "single_pass_observation",
    });

    const run2 = await extractStructuralBaseline(baselinePath, {
      jobId: `${job.jobId}:phase4:run2`,
      imageId: job.imageId,
      attempt: 1,
      disableCache: true,
      baselineMode: "single_pass_observation",
    });

    const n1 = normalizeRunView(run1);
    const n2 = normalizeRunView(run2);

    const stability = {
      inventoryStable: n1.inventoryHash.length > 0 && n1.inventoryHash === n2.inventoryHash,
      observationStable: n1.observationHash.length > 0 && n1.observationHash === n2.observationHash,
      canonicalGraphStable: n1.graphHash.length > 0 && n1.graphHash === n2.graphHash,
      identityStable: n1.identityHash.length > 0 && n1.identityHash === n2.identityHash,
      confidenceStable: confidenceStable(n1.baselineConfidence, n2.baselineConfidence),
      statusStable: n1.baselineStatus === n2.baselineStatus,
    };

    jobs.push({
      label: job.label,
      jobId: job.jobId,
      baselineFile: job.baselineFile,
      stability,
      run1: n1,
      run2: n2,
    });
  }

  const overall = {
    totalImages: jobs.length,
    inventoryStableImages: jobs.filter((job) => job.stability.inventoryStable).length,
    observationStableImages: jobs.filter((job) => job.stability.observationStable).length,
    canonicalGraphStableImages: jobs.filter((job) => job.stability.canonicalGraphStable).length,
    identityStableImages: jobs.filter((job) => job.stability.identityStable).length,
    confidenceStableImages: jobs.filter((job) => job.stability.confidenceStable).length,
    statusStableImages: jobs.filter((job) => job.stability.statusStable).length,
    matchedImages: jobs.filter((job) => job.run1.baselineStatus === "MATCHED" || job.run2.baselineStatus === "MATCHED").length,
    reconciledImages: jobs.filter((job) => job.run1.baselineStatus === "RECONCILED" || job.run2.baselineStatus === "RECONCILED").length,
    irreconcilableImages: jobs.filter((job) => job.run1.baselineStatus === "IRRECONCILABLE" || job.run2.baselineStatus === "IRRECONCILABLE").length,
  };

  const report = {
    title: "Baseline Determinism Phase 4 - Canonical Graph Reconciliation and Confidence",
    generatedAt: new Date().toISOString(),
    overall,
    jobs,
  };

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(REPORT_JSON, JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push("# Baseline Determinism Phase 4 - Canonical Graph Reconciliation and Confidence");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`- Total images: ${overall.totalImages}`);
  lines.push(`- Inventory-stable images: ${overall.inventoryStableImages}`);
  lines.push(`- Observation-stable images: ${overall.observationStableImages}`);
  lines.push(`- Canonical-graph-stable images: ${overall.canonicalGraphStableImages}`);
  lines.push(`- Identity-stable images: ${overall.identityStableImages}`);
  lines.push(`- Confidence-stable images: ${overall.confidenceStableImages}`);
  lines.push(`- Final-status-stable images: ${overall.statusStableImages}`);
  lines.push(`- MATCHED images: ${overall.matchedImages}`);
  lines.push(`- RECONCILED images: ${overall.reconciledImages}`);
  lines.push(`- IRRECONCILABLE images: ${overall.irreconcilableImages}`);
  lines.push("");

  for (const job of jobs) {
    lines.push(`## ${job.label}`);
    lines.push(`- Inventory stability: ${job.stability.inventoryStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Observation stability: ${job.stability.observationStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Canonical graph stability: ${job.stability.canonicalGraphStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Identity stability: ${job.stability.identityStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Confidence stability: ${job.stability.confidenceStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Final baseline status stability: ${job.stability.statusStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Run 1 status: ${job.run1.baselineStatus}`);
    lines.push(`- Run 2 status: ${job.run2.baselineStatus}`);
    lines.push("");

    lines.push("### Validation Failures");
    lines.push(`- Run 1 unknown references: ${(job.run1.validation.unknownReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 1 duplicate references: ${(job.run1.validation.duplicateReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 1 inconsistencies: ${(job.run1.validation.inconsistencies || []).join(", ") || "none"}`);
    lines.push(`- Run 2 unknown references: ${(job.run2.validation.unknownReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 2 duplicate references: ${(job.run2.validation.duplicateReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 2 inconsistencies: ${(job.run2.validation.inconsistencies || []).join(", ") || "none"}`);
    lines.push("");

    lines.push("### Reconciliation Actions");
    lines.push(`- Run 1 actions: ${(job.run1.validation.reconciliationActions || []).join(", ") || "none"}`);
    lines.push(`- Run 1 reasons: ${(job.run1.validation.reconciliationReasons || []).join(", ") || "none"}`);
    lines.push(`- Run 2 actions: ${(job.run2.validation.reconciliationActions || []).join(", ") || "none"}`);
    lines.push(`- Run 2 reasons: ${(job.run2.validation.reconciliationReasons || []).join(", ") || "none"}`);
    lines.push("");

    lines.push("### Canonical Graph");
    lines.push(`- Run 1 graph: ${JSON.stringify(job.run1.canonicalGraph)}`);
    lines.push(`- Run 2 graph: ${JSON.stringify(job.run2.canonicalGraph)}`);
    lines.push(`- Run 1 confidence: ${job.run1.baselineConfidence}`);
    lines.push(`- Run 2 confidence: ${job.run2.baselineConfidence}`);
    lines.push("");
  }

  await fs.writeFile(REPORT_MD, `${lines.join("\n")}\n`);
  console.log(`Wrote ${REPORT_JSON}`);
  console.log(`Wrote ${REPORT_MD}`);
}

main().catch((error) => {
  console.error("Baseline phase 4 script failed", error);
  process.exit(1);
});
