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
const REPORT_JSON = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase2.json";
const REPORT_MD = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase2.md";

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
  const walls = (baseline.wallDescriptors || []).map((wall: any) => ({
    wallIndex: wall.wallIndex,
    observedOrdinal: wall.observedOrdinal,
    primaryAnchorLabel: wall.primaryAnchorLabel || "wall_plane",
    visibility: wall.visibility,
    visibleExtent: wall.visibleExtent,
    leftCornerVisible: wall.leftCornerVisible,
    rightCornerVisible: wall.rightCornerVisible,
    leftCornerPosition: wall.leftCornerPosition,
    rightCornerPosition: wall.rightCornerPosition,
    leftCornerVisibility: wall.leftCornerVisibility,
    rightCornerVisibility: wall.rightCornerVisibility,
    leftReturnWallVisible: wall.leftReturnWallVisible,
    rightReturnWallVisible: wall.rightReturnWallVisible,
    leftReturnWallVisibility: wall.leftReturnWallVisibility,
    rightReturnWallVisibility: wall.rightReturnWallVisibility,
    leftEdgeLocation: wall.leftEdgeLocation,
    rightEdgeLocation: wall.rightEdgeLocation,
    leftFrameEdgeContinuation: wall.leftFrameEdgeContinuation,
    rightFrameEdgeContinuation: wall.rightFrameEdgeContinuation,
  }));

  const openings = (baseline.openings || []).map((opening: any) => ({
    id: opening.id,
    type: opening.type,
    wallIndex: opening.wallIndex,
    horizontalBand: opening.horizontalBand,
    verticalBand: opening.verticalBand,
    wallCoverageBand: opening.wallCoverageBand,
    paneStructure: opening.paneStructure,
    doorLeafState: opening.doorLeafState,
  }));

  return {
    observationHash: String(baseline.observationMeta?.observationHash || baseline.graphMeta?.observationHash || ""),
    graphHash: String(baseline.graphMeta?.graphHash || ""),
    anchors: walls.map((wall: any) => wall.primaryAnchorLabel),
    walls,
    openings,
  };
}

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifyDrift(observationStable: boolean, graphStable: boolean): string {
  if (observationStable && graphStable) return "none";
  if (!observationStable && graphStable) return "observation_instability_without_graph_drift";
  if (!observationStable && !graphStable) return "observation_instability";
  return "graph_builder_instability";
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

    const observationStable = n1.observationHash.length > 0 && n1.observationHash === n2.observationHash;
    const graphStable = n1.graphHash.length > 0 && n1.graphHash === n2.graphHash;
    const anchorStable = isEqual(n1.anchors, n2.anchors);
    const openingStable = isEqual(n1.openings, n2.openings);
    const cornerStable = isEqual(
      n1.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftCornerVisible: wall.leftCornerVisible,
        rightCornerVisible: wall.rightCornerVisible,
        leftCornerPosition: wall.leftCornerPosition,
        rightCornerPosition: wall.rightCornerPosition,
        leftCornerVisibility: wall.leftCornerVisibility,
        rightCornerVisibility: wall.rightCornerVisibility,
      })),
      n2.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftCornerVisible: wall.leftCornerVisible,
        rightCornerVisible: wall.rightCornerVisible,
        leftCornerPosition: wall.leftCornerPosition,
        rightCornerPosition: wall.rightCornerPosition,
        leftCornerVisibility: wall.leftCornerVisibility,
        rightCornerVisibility: wall.rightCornerVisibility,
      }))
    );

    const returnWallStable = isEqual(
      n1.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftReturnWallVisible: wall.leftReturnWallVisible,
        rightReturnWallVisible: wall.rightReturnWallVisible,
        leftReturnWallVisibility: wall.leftReturnWallVisibility,
        rightReturnWallVisibility: wall.rightReturnWallVisibility,
      })),
      n2.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftReturnWallVisible: wall.leftReturnWallVisible,
        rightReturnWallVisible: wall.rightReturnWallVisible,
        leftReturnWallVisibility: wall.leftReturnWallVisibility,
        rightReturnWallVisibility: wall.rightReturnWallVisibility,
      }))
    );

    const frameEdgeStable = isEqual(
      n1.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftEdgeLocation: wall.leftEdgeLocation,
        rightEdgeLocation: wall.rightEdgeLocation,
        leftFrameEdgeContinuation: wall.leftFrameEdgeContinuation,
        rightFrameEdgeContinuation: wall.rightFrameEdgeContinuation,
      })),
      n2.walls.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftEdgeLocation: wall.leftEdgeLocation,
        rightEdgeLocation: wall.rightEdgeLocation,
        leftFrameEdgeContinuation: wall.leftFrameEdgeContinuation,
        rightFrameEdgeContinuation: wall.rightFrameEdgeContinuation,
      }))
    );

    const driftSource = classifyDrift(observationStable, graphStable);

    jobs.push({
      label: job.label,
      jobId: job.jobId,
      baselineFile: job.baselineFile,
      stability: {
        observationStable,
        graphStable,
        anchorStable,
        openingStable,
        cornerStable,
        returnWallStable,
        frameEdgeStable,
      },
      driftSource,
      run1: n1,
      run2: n2,
    });
  }

  const overall = {
    totalImages: jobs.length,
    observationStableImages: jobs.filter((job) => job.stability.observationStable).length,
    graphStableImages: jobs.filter((job) => job.stability.graphStable).length,
    anchorStableImages: jobs.filter((job) => job.stability.anchorStable).length,
    openingStableImages: jobs.filter((job) => job.stability.openingStable).length,
    cornerStableImages: jobs.filter((job) => job.stability.cornerStable).length,
    returnWallStableImages: jobs.filter((job) => job.stability.returnWallStable).length,
    frameEdgeStableImages: jobs.filter((job) => job.stability.frameEdgeStable).length,
    observationInstabilityImages: jobs.filter((job) => job.driftSource === "observation_instability").length,
    graphBuilderInstabilityImages: jobs.filter((job) => job.driftSource === "graph_builder_instability").length,
  };

  const report = {
    title: "Baseline Determinism Phase 2 - Observation-First Graph Construction",
    generatedAt: new Date().toISOString(),
    overall,
    jobs,
  };

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(REPORT_JSON, JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push("# Baseline Determinism Phase 2 - Observation-First Graph Construction");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`- Total images: ${overall.totalImages}`);
  lines.push(`- Observation-stable images: ${overall.observationStableImages}`);
  lines.push(`- Graph-stable images: ${overall.graphStableImages}`);
  lines.push(`- Anchor-stable images: ${overall.anchorStableImages}`);
  lines.push(`- Opening-stable images: ${overall.openingStableImages}`);
  lines.push(`- Corner-stable images: ${overall.cornerStableImages}`);
  lines.push(`- Return-wall-stable images: ${overall.returnWallStableImages}`);
  lines.push(`- Frame-edge-stable images: ${overall.frameEdgeStableImages}`);
  lines.push(`- Observation instability images: ${overall.observationInstabilityImages}`);
  lines.push(`- Graph-builder instability images: ${overall.graphBuilderInstabilityImages}`);
  lines.push("");

  for (const job of jobs) {
    lines.push(`## ${job.label}`);
    lines.push(`- Observation stability: ${job.stability.observationStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Graph stability: ${job.stability.graphStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Anchor stability: ${job.stability.anchorStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Opening stability: ${job.stability.openingStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Corner stability: ${job.stability.cornerStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Return-wall stability: ${job.stability.returnWallStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Frame-edge stability: ${job.stability.frameEdgeStable ? "STABLE" : "UNSTABLE"}`);
    lines.push(`- Instability attribution: ${job.driftSource}`);
    lines.push("");
    lines.push(`Run 1 observation hash: ${job.run1.observationHash || "missing"}`);
    lines.push(`Run 2 observation hash: ${job.run2.observationHash || "missing"}`);
    lines.push(`Run 1 graph hash: ${job.run1.graphHash || "missing"}`);
    lines.push(`Run 2 graph hash: ${job.run2.graphHash || "missing"}`);
    lines.push("");
  }

  await fs.writeFile(REPORT_MD, `${lines.join("\n")}\n`);
  console.log(`Wrote ${REPORT_JSON}`);
  console.log(`Wrote ${REPORT_MD}`);
}

main().catch((error) => {
  console.error("Baseline phase 2 script failed", error);
  process.exit(1);
});
