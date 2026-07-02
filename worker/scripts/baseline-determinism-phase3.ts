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
const REPORT_JSON = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase3.json";
const REPORT_MD = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase3.md";

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
  const inventory = baseline?.observationMeta?.inventory || {
    openings: [],
    permanentFixtures: [],
    architecturalFeatures: [],
  };
  const validation = baseline?.observationMeta?.validation || {
    unknownReferences: [],
    duplicateReferences: [],
    unusedInventory: [],
    inconsistencies: [],
    rejectedAnchors: [],
    chosenAnchors: [],
  };

  const canonicalGraph = (baseline.wallDescriptors || []).map((wall: any) => ({
    wallIndex: wall.wallIndex,
    canonicalWallId: wall.canonicalWallId || "",
    primaryAnchorLabel: wall.primaryAnchorLabel || "wall_plane",
  }));

  return {
    inventory,
    inventoryHash: String(baseline?.observationMeta?.inventoryHash || ""),
    observationHash: String(baseline?.observationMeta?.observationHash || baseline?.graphMeta?.observationHash || ""),
    graphHash: String(baseline?.graphMeta?.graphHash || ""),
    identityHash: String(baseline?.observationMeta?.canonicalIdentityHash || ""),
    baselineConfidence: Number(baseline?.observationMeta?.baselineConfidence ?? baseline?.graphMeta?.baselineConfidence ?? 0),
    validation,
    canonicalGraph,
    openings: (baseline.openings || []).map((opening: any) => ({
      id: opening.id,
      type: opening.type,
      wallIndex: opening.wallIndex,
      horizontalBand: opening.horizontalBand,
      verticalBand: opening.verticalBand,
      wallCoverageBand: opening.wallCoverageBand,
    })),
  };
}

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function confidenceStable(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.001;
}

function classifyAttribution(stability: {
  inventoryStable: boolean;
  observationStable: boolean;
  graphStable: boolean;
  identityStable: boolean;
  confidenceStable: boolean;
}): string[] {
  const causes: string[] = [];
  if (!stability.observationStable) causes.push("observation_drift");
  if (!stability.inventoryStable) causes.push("inventory_drift");
  if (stability.observationStable && !stability.graphStable) causes.push("graph_builder_drift");
  if (!stability.identityStable) causes.push("identity_drift");
  if (!stability.confidenceStable) causes.push("confidence_drift");
  if (causes.length === 0) causes.push("stable");
  return causes;
}

async function main() {
  const jobs: any[] = [];

  for (const job of TEST_JOBS) {
    const baselinePath = await resolveBaselinePath(job);

    const run1 = await extractStructuralBaseline(baselinePath, {
      jobId: job.jobId,
      imageId: job.imageId,
      attempt: 1,
      disableCache: true,
      baselineMode: "single_pass_observation",
    });

    const run2 = await extractStructuralBaseline(baselinePath, {
      jobId: job.jobId,
      imageId: job.imageId,
      attempt: 2,
      disableCache: true,
      baselineMode: "single_pass_observation",
    });

    const n1 = normalizeRunView(run1);
    const n2 = normalizeRunView(run2);

    const stability = {
      inventoryStable: n1.inventoryHash.length > 0 && n1.inventoryHash === n2.inventoryHash,
      observationStable: n1.observationHash.length > 0 && n1.observationHash === n2.observationHash,
      graphStable: n1.graphHash.length > 0 && n1.graphHash === n2.graphHash,
      identityStable: n1.identityHash.length > 0 && n1.identityHash === n2.identityHash,
      confidenceStable: confidenceStable(n1.baselineConfidence, n2.baselineConfidence),
      openingStable: isEqual(n1.openings, n2.openings),
    };

    const attribution = classifyAttribution(stability);

    jobs.push({
      label: job.label,
      jobId: job.jobId,
      baselineFile: job.baselineFile,
      stability,
      attribution,
      diagnostics: {
        inventory: {
          run1: n1.inventory,
          run2: n2.inventory,
        },
        observationValidation: {
          run1: n1.validation,
          run2: n2.validation,
        },
        canonicalGraph: {
          run1: {
            wallIdentities: n1.canonicalGraph,
            chosenAnchors: n1.validation.chosenAnchors,
            rejectedAnchors: n1.validation.rejectedAnchors,
            baselineConfidence: n1.baselineConfidence,
          },
          run2: {
            wallIdentities: n2.canonicalGraph,
            chosenAnchors: n2.validation.chosenAnchors,
            rejectedAnchors: n2.validation.rejectedAnchors,
            baselineConfidence: n2.baselineConfidence,
          },
        },
      },
      hashes: {
        inventoryHashRun1: n1.inventoryHash,
        inventoryHashRun2: n2.inventoryHash,
        observationHashRun1: n1.observationHash,
        observationHashRun2: n2.observationHash,
        graphHashRun1: n1.graphHash,
        graphHashRun2: n2.graphHash,
        identityHashRun1: n1.identityHash,
        identityHashRun2: n2.identityHash,
      },
    });
  }

  const overall = {
    totalImages: jobs.length,
    inventoryStableImages: jobs.filter((job) => job.stability.inventoryStable).length,
    observationStableImages: jobs.filter((job) => job.stability.observationStable).length,
    graphStableImages: jobs.filter((job) => job.stability.graphStable).length,
    identityStableImages: jobs.filter((job) => job.stability.identityStable).length,
    confidenceStableImages: jobs.filter((job) => job.stability.confidenceStable).length,
    openingStableImages: jobs.filter((job) => job.stability.openingStable).length,
    inventoryDriftImages: jobs.filter((job) => job.attribution.includes("inventory_drift")).length,
    observationDriftImages: jobs.filter((job) => job.attribution.includes("observation_drift")).length,
    graphBuilderDriftImages: jobs.filter((job) => job.attribution.includes("graph_builder_drift")).length,
    identityDriftImages: jobs.filter((job) => job.attribution.includes("identity_drift")).length,
    confidenceDriftImages: jobs.filter((job) => job.attribution.includes("confidence_drift")).length,
  };

  const report = {
    title: "Baseline Determinism Phase 3 - Observation-First Canonical Graph",
    generatedAt: new Date().toISOString(),
    overall,
    jobs,
  };

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(REPORT_JSON, JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push("# Baseline Determinism Phase 3 - Observation-First Canonical Graph");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`- Total images: ${overall.totalImages}`);
  lines.push(`- Inventory-stable images: ${overall.inventoryStableImages}`);
  lines.push(`- Observation-stable images: ${overall.observationStableImages}`);
  lines.push(`- Canonical-graph-stable images: ${overall.graphStableImages}`);
  lines.push(`- Identity-stable images: ${overall.identityStableImages}`);
  lines.push(`- Confidence-stable images: ${overall.confidenceStableImages}`);
  lines.push(`- Opening-stable images: ${overall.openingStableImages}`);
  lines.push(`- Inventory drift images: ${overall.inventoryDriftImages}`);
  lines.push(`- Observation drift images: ${overall.observationDriftImages}`);
  lines.push(`- Graph-builder drift images: ${overall.graphBuilderDriftImages}`);
  lines.push(`- Identity drift images: ${overall.identityDriftImages}`);
  lines.push(`- Confidence drift images: ${overall.confidenceDriftImages}`);
  lines.push("");

  for (const job of jobs) {
    lines.push(`## ${job.label}`);
    lines.push(`- Inventory stability: ${job.stability.inventoryStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Observation stability: ${job.stability.observationStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Canonical graph stability: ${job.stability.graphStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Identity stability: ${job.stability.identityStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Confidence stability: ${job.stability.confidenceStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Opening stability: ${job.stability.openingStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Stability attribution: ${job.attribution.join(", ")}`);
    lines.push("");

    lines.push("### Inventory");
    lines.push(`- Run 1 openings: ${(job.diagnostics.inventory.run1.openings || []).join(", ") || "none"}`);
    lines.push(`- Run 1 fixtures: ${(job.diagnostics.inventory.run1.permanentFixtures || []).join(", ") || "none"}`);
    lines.push(`- Run 1 architectural features: ${(job.diagnostics.inventory.run1.architecturalFeatures || []).join(", ") || "none"}`);
    lines.push(`- Run 2 openings: ${(job.diagnostics.inventory.run2.openings || []).join(", ") || "none"}`);
    lines.push(`- Run 2 fixtures: ${(job.diagnostics.inventory.run2.permanentFixtures || []).join(", ") || "none"}`);
    lines.push(`- Run 2 architectural features: ${(job.diagnostics.inventory.run2.architecturalFeatures || []).join(", ") || "none"}`);
    lines.push("");

    lines.push("### Observation Validation");
    lines.push(`- Run 1 unknown references: ${(job.diagnostics.observationValidation.run1.unknownReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 1 duplicate references: ${(job.diagnostics.observationValidation.run1.duplicateReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 1 unused inventory: ${(job.diagnostics.observationValidation.run1.unusedInventory || []).join(", ") || "none"}`);
    lines.push(`- Run 1 inconsistencies: ${(job.diagnostics.observationValidation.run1.inconsistencies || []).join(", ") || "none"}`);
    lines.push(`- Run 2 unknown references: ${(job.diagnostics.observationValidation.run2.unknownReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 2 duplicate references: ${(job.diagnostics.observationValidation.run2.duplicateReferences || []).join(", ") || "none"}`);
    lines.push(`- Run 2 unused inventory: ${(job.diagnostics.observationValidation.run2.unusedInventory || []).join(", ") || "none"}`);
    lines.push(`- Run 2 inconsistencies: ${(job.diagnostics.observationValidation.run2.inconsistencies || []).join(", ") || "none"}`);
    lines.push("");

    lines.push("### Canonical Graph");
    lines.push(`- Run 1 wall identities: ${JSON.stringify(job.diagnostics.canonicalGraph.run1.wallIdentities)}`);
    lines.push(`- Run 2 wall identities: ${JSON.stringify(job.diagnostics.canonicalGraph.run2.wallIdentities)}`);
    lines.push(`- Run 1 chosen anchors: ${(job.diagnostics.canonicalGraph.run1.chosenAnchors || []).join(", ") || "none"}`);
    lines.push(`- Run 1 rejected anchors: ${(job.diagnostics.canonicalGraph.run1.rejectedAnchors || []).join(", ") || "none"}`);
    lines.push(`- Run 2 chosen anchors: ${(job.diagnostics.canonicalGraph.run2.chosenAnchors || []).join(", ") || "none"}`);
    lines.push(`- Run 2 rejected anchors: ${(job.diagnostics.canonicalGraph.run2.rejectedAnchors || []).join(", ") || "none"}`);
    lines.push(`- Run 1 baseline confidence: ${job.diagnostics.canonicalGraph.run1.baselineConfidence}`);
    lines.push(`- Run 2 baseline confidence: ${job.diagnostics.canonicalGraph.run2.baselineConfidence}`);
    lines.push("");
  }

  await fs.writeFile(REPORT_MD, `${lines.join("\n")}\n`);
  console.log(`Wrote ${REPORT_JSON}`);
  console.log(`Wrote ${REPORT_MD}`);
}

main().catch((error) => {
  console.error("Baseline phase 3 script failed", error);
  process.exit(1);
});
