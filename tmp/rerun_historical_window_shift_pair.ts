import fs from "fs";
import path from "path";
import https from "https";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";

type Name = "opening" | "fixture" | "floor" | "envelope";

type SpecialistLifecycle = {
  name: Name;
  status: "completed" | "retry_succeeded" | "retry_failed";
  retryCount: number;
  startTime: number;
  completionTime: number;
  durationMs: number;
  available: boolean;
  error?: string;
};

type SpecialistSummary = {
  expectedSpecialistCount: number;
  settledCount: number;
  completedCount: number;
  failedCount: number;
  allSpecialistsSettled: boolean;
  allSpecialistsCompleted: boolean;
  namesOfMissingSpecialists: Name[];
  lifecycles: SpecialistLifecycle[];
};

const BASELINE_URL = "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1781130882124-realenhance-job_b9a952c0-e6fa-42f7-9e67-649dd66f37e0-1781130880340-ne2bbtmgex.jpg";
const CANDIDATE_URL = "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1781131162178-realenhance-job_ccfc5e12-399c-479c-adf7-a2aa5db2d421-stage1A-1781131115860-q4zv3728wmc-2-stage2-only-delivery.jpg";

function download(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    const request = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(outPath);
        return resolve(download(res.headers.location!, outPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`download_failed status=${res.statusCode} url=${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });
    request.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

function collectAdvisorySignals(result: any): string[] {
  if (!result || typeof result !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(result.advisorySignals)) {
    for (const s of result.advisorySignals) {
      if (typeof s === "string" && s.trim()) out.push(s.trim());
    }
  }
  if (typeof result.issueType === "string" && result.issueType.trim() && result.issueType !== "none") {
    out.push(result.issueType.trim());
  }
  return [...new Set(out)];
}

async function orchestrate(maxRetries = 1) {
  const context = {
    jobId: "rerun-job_ccfc5e12",
    imageId: "1781131162178-stage2-only-delivery",
    attempt: 1,
  };
  const runners: Record<Name, () => Promise<any>> = {
    opening: () => runOpeningValidator(paths.baseline, paths.candidate, context),
    fixture: () => runFixtureValidator(paths.baseline, paths.candidate, context),
    floor: () => runFloorIntegrityValidator(paths.baseline, paths.candidate, context),
    envelope: () => runEnvelopeValidator(paths.baseline, paths.candidate, context),
  };

  const names: Name[] = ["opening", "fixture", "floor", "envelope"];
  const settled = await Promise.allSettled(
    names.map(async (name) => {
      const start = Date.now();
      let retryCount = 0;
      try {
        const value = await runners[name]();
        const end = Date.now();
        const lifecycle: SpecialistLifecycle = {
          name,
          status: "completed",
          retryCount,
          startTime: start,
          completionTime: end,
          durationMs: Math.max(0, end - start),
          available: true,
        };
        return { name, value, lifecycle };
      } catch (firstErr: any) {
        while (retryCount < maxRetries) {
          retryCount += 1;
          try {
            const value = await runners[name]();
            const end = Date.now();
            const lifecycle: SpecialistLifecycle = {
              name,
              status: "retry_succeeded",
              retryCount,
              startTime: start,
              completionTime: end,
              durationMs: Math.max(0, end - start),
              available: true,
            };
            return { name, value, lifecycle };
          } catch {
            // continue
          }
        }
        const end = Date.now();
        const lifecycle: SpecialistLifecycle = {
          name,
          status: "retry_failed",
          retryCount,
          startTime: start,
          completionTime: end,
          durationMs: Math.max(0, end - start),
          available: false,
          error: String(firstErr?.message || firstErr || "unknown_error"),
        };
        return { name, value: undefined, lifecycle };
      }
    })
  );

  const results: Partial<Record<Name, any>> = {};
  const lifecycles: SpecialistLifecycle[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      lifecycles.push(s.value.lifecycle);
      if (s.value.value !== undefined) results[s.value.name] = s.value.value;
    } else {
      const name = names[i];
      lifecycles.push({
        name,
        status: "retry_failed",
        retryCount: maxRetries,
        startTime: Date.now(),
        completionTime: Date.now(),
        durationMs: 0,
        available: false,
        error: String(s.reason || "unhandled_rejection"),
      });
    }
  }

  const completedCount = lifecycles.filter((x) => x.available).length;
  const summary: SpecialistSummary = {
    expectedSpecialistCount: names.length,
    settledCount: lifecycles.length,
    completedCount,
    failedCount: lifecycles.length - completedCount,
    allSpecialistsSettled: lifecycles.length === names.length,
    allSpecialistsCompleted: completedCount === names.length,
    namesOfMissingSpecialists: lifecycles.filter((x) => !x.available).map((x) => x.name),
    lifecycles,
  };

  const signals = names.flatMap((name) => collectAdvisorySignals(results[name]));
  return { results, summary, specialistAdvisorySignals: [...new Set(signals)] };
}

const root = process.cwd();
const workDir = path.join(root, "tmp", "historical-window-shift-rerun");
const paths = {
  baseline: path.join(workDir, "baseline.jpg"),
  candidate: path.join(workDir, "candidate.jpg"),
};

async function main() {
  fs.mkdirSync(workDir, { recursive: true });
  await download(BASELINE_URL, paths.baseline);
  await download(CANDIDATE_URL, paths.candidate);

  const runStarted = Date.now();
  const specialist = await orchestrate(1);

  const evidenceGate = {
    allSpecialistsSettled: specialist.summary.allSpecialistsSettled,
    allSpecialistsCompleted: specialist.summary.allSpecialistsCompleted,
    specialistCount: specialist.summary.expectedSpecialistCount,
    specialistResultsPresent: specialist.summary.completedCount,
    specialistSignalsCount: specialist.specialistAdvisorySignals.length,
  };

  const unified = await runUnifiedValidation({
    originalPath: paths.baseline,
    enhancedPath: paths.candidate,
    stage: "2",
    sceneType: "interior",
    roomType: "living",
    mode: "enforce",
    jobId: `rerun-job_ccfc5e12-${Date.now()}`,
    imageId: "1781131162178-stage2-only-delivery",
    stagingStyle: "standard_listing",
    stage1APath: paths.baseline,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
    specialistAdvisorySignals: specialist.specialistAdvisorySignals,
  } as any);

  const out = {
    runMeta: {
      startedAt: runStarted,
      completedAt: Date.now(),
      elapsedMs: Date.now() - runStarted,
      baselineUrl: BASELINE_URL,
      candidateUrl: CANDIDATE_URL,
    },
    specialist,
    evidenceGate,
    unified: {
      passed: unified?.passed ?? null,
      hardFail: unified?.hardFail ?? null,
      blockSource: (unified as any)?.blockSource ?? null,
      score: unified?.score ?? null,
      derivedWarnings: unified?.derivedWarnings ?? null,
      sourceSpecialistSignals: specialist.specialistAdvisorySignals,
      issueType: unified?.issueType ?? null,
      issueTier: unified?.issueTier ?? null,
      reasons: unified?.reasons ?? [],
      warnings: unified?.warnings ?? [],
    },
  };

  const outPath = path.join(workDir, `rerun_result_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`REPORT=${outPath}`);
  console.log(JSON.stringify({
    evidenceGate,
    unified: out.unified,
    specialistLifecycle: specialist.summary.lifecycles,
  }, null, 2));
}

main().catch((err) => {
  console.error("RERUN_FAILED", err?.message || String(err));
  process.exit(1);
});
