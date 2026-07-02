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
const REPORT_JSON = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase1.json";
const REPORT_MD = "/workspaces/RealEnhance-v2/worker/reports/baseline-determinism-phase1.md";

function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort(), 2);
}

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

function normalizeBaselineView(baseline: any) {
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

  const wallDescriptors = (baseline.wallDescriptors || []).map((wall: any) => ({
    wallIndex: wall.wallIndex,
    visibility: wall.visibility,
    visibleExtent: wall.visibleExtent,
    architecturalCertainty: wall.architecturalCertainty,
    leftEdgeLocation: wall.leftEdgeLocation,
    rightEdgeLocation: wall.rightEdgeLocation,
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
  }));

  const primaryAnchors = (baseline.wallDescriptors || []).map((wall: any) => {
    const normalized = String(wall.primaryAnchorLabel || "").trim();
    if (normalized) return normalized;
    const fromDesc = String(wall.description || "");
    return fromDesc.split(";")[0] || "unknown";
  });

  return {
    openingCount: openings.length,
    wallCount: wallDescriptors.length,
    primaryAnchors,
    openings,
    wallDescriptors,
    graphHash: baseline.graphMeta?.graphHash || "",
  };
}

function diffArray(a: any[], b: any[]): string[] {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left === right ? [] : ["changed"];
}

function diffValue(a: any, b: any): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

async function main() {
  const perJob: any[] = [];

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

    const n1 = normalizeBaselineView(run1);
    const n2 = normalizeBaselineView(run2);

    const identityDifferent = diffValue(n1.primaryAnchors, n2.primaryAnchors);
    const geometryDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, visibility: wall.visibility, visibleExtent: wall.visibleExtent })),
      n2.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, visibility: wall.visibility, visibleExtent: wall.visibleExtent }))
    );
    const orderingDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => wall.wallIndex),
      n2.wallDescriptors.map((wall: any) => wall.wallIndex)
    );
    const confidenceDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, architecturalCertainty: wall.architecturalCertainty })),
      n2.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, architecturalCertainty: wall.architecturalCertainty }))
    );

    const cornersDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftCornerVisible: wall.leftCornerVisible,
        rightCornerVisible: wall.rightCornerVisible,
        leftCornerPosition: wall.leftCornerPosition,
        rightCornerPosition: wall.rightCornerPosition,
        leftCornerVisibility: wall.leftCornerVisibility,
        rightCornerVisibility: wall.rightCornerVisibility,
      })),
      n2.wallDescriptors.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftCornerVisible: wall.leftCornerVisible,
        rightCornerVisible: wall.rightCornerVisible,
        leftCornerPosition: wall.leftCornerPosition,
        rightCornerPosition: wall.rightCornerPosition,
        leftCornerVisibility: wall.leftCornerVisibility,
        rightCornerVisibility: wall.rightCornerVisibility,
      }))
    );

    const frameEdgeDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, leftEdgeLocation: wall.leftEdgeLocation, rightEdgeLocation: wall.rightEdgeLocation })),
      n2.wallDescriptors.map((wall: any) => ({ wallIndex: wall.wallIndex, leftEdgeLocation: wall.leftEdgeLocation, rightEdgeLocation: wall.rightEdgeLocation }))
    );

    const returnWallsDifferent = diffValue(
      n1.wallDescriptors.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftReturnWallVisible: wall.leftReturnWallVisible,
        rightReturnWallVisible: wall.rightReturnWallVisible,
        leftReturnWallVisibility: wall.leftReturnWallVisibility,
        rightReturnWallVisibility: wall.rightReturnWallVisibility,
      })),
      n2.wallDescriptors.map((wall: any) => ({
        wallIndex: wall.wallIndex,
        leftReturnWallVisible: wall.leftReturnWallVisible,
        rightReturnWallVisible: wall.rightReturnWallVisible,
        leftReturnWallVisibility: wall.leftReturnWallVisibility,
        rightReturnWallVisibility: wall.rightReturnWallVisibility,
      }))
    );

    const openingsDifferent = diffValue(n1.openings, n2.openings);
    const wallCountDifferent = n1.wallCount !== n2.wallCount;

    const differenceCount = [
      identityDifferent,
      geometryDifferent,
      orderingDifferent,
      confidenceDifferent,
      cornersDifferent,
      frameEdgeDifferent,
      returnWallsDifferent,
      openingsDifferent,
      wallCountDifferent,
    ].filter(Boolean).length;

    const stabilityScore = Math.max(0, Math.round(((9 - differenceCount) / 9) * 100));

    perJob.push({
      label: job.label,
      jobId: job.jobId,
      baselineFile: job.baselineFile,
      run1: n1,
      run2: n2,
      differences: {
        identityDifferent,
        geometryDifferent,
        orderingDifferent,
        confidenceDifferent,
        cornersDifferent,
        frameEdgeDifferent,
        returnWallsDifferent,
        openingsDifferent,
        wallCountDifferent,
      },
      stabilityScore,
    });
  }

  const overall = {
    totalImages: perJob.length,
    averageStability: Number((perJob.reduce((sum, item) => sum + item.stabilityScore, 0) / Math.max(1, perJob.length)).toFixed(1)),
    fullyStableImages: perJob.filter((item) => item.stabilityScore === 100).length,
    unstableImages: perJob.filter((item) => item.stabilityScore < 100).length,
  };

  const report = {
    title: "Baseline Determinism Phase 1",
    generatedAt: new Date().toISOString(),
    overall,
    jobs: perJob,
  };

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(REPORT_JSON, JSON.stringify(report, null, 2));

  const mdLines: string[] = [];
  mdLines.push("# Baseline Determinism Phase 1");
  mdLines.push("");
  mdLines.push(`Generated: ${report.generatedAt}`);
  mdLines.push("");
  mdLines.push(`- Total images: ${overall.totalImages}`);
  mdLines.push(`- Average stability: ${overall.averageStability}%`);
  mdLines.push(`- Fully stable images: ${overall.fullyStableImages}`);
  mdLines.push(`- Unstable images: ${overall.unstableImages}`);
  mdLines.push("");

  for (const job of perJob) {
    mdLines.push(`## ${job.label}`);
    mdLines.push(`- Stability score: ${job.stabilityScore}%`);
    mdLines.push(`- Identity differences: ${job.differences.identityDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Geometry differences: ${job.differences.geometryDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Ordering differences: ${job.differences.orderingDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Confidence differences: ${job.differences.confidenceDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Corner differences: ${job.differences.cornersDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Frame-edge differences: ${job.differences.frameEdgeDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Return-wall differences: ${job.differences.returnWallsDifferent ? "YES" : "NO"}`);
    mdLines.push(`- Opening differences: ${job.differences.openingsDifferent ? "YES" : "NO"}`);
    mdLines.push("");
    mdLines.push("Run 1 primary anchors:");
    mdLines.push(`- ${job.run1.primaryAnchors.join(", ") || "none"}`);
    mdLines.push("Run 2 primary anchors:");
    mdLines.push(`- ${job.run2.primaryAnchors.join(", ") || "none"}`);
    mdLines.push("");
  }

  await fs.writeFile(REPORT_MD, mdLines.join("\n"));

  console.log(JSON.stringify({ reportJson: REPORT_JSON, reportMd: REPORT_MD, overall }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
