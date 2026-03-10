import fs from "fs";
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";

type ValidatorStatus = "pass" | "fail";

type ValidatorResult = {
	status: ValidatorStatus;
	reason: string;
	confidence: number;
};

type BatchRow = {
	image: string;
	baseline: string;
	staged: string;
	pairFound: boolean;
	baselineExtraction?: {
		ok: boolean;
		wallCount?: number;
		openingCount?: number;
		error?: string;
	};
	validators?: {
		envelope: ValidatorResult;
		fixture: ValidatorResult;
		flooring: ValidatorResult;
		opening: ValidatorResult;
	};
};

function parseDotEnv(filePath: string): Record<string, string> {
	const out: Record<string, string> = {};
	const raw = fs.readFileSync(filePath, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

function toValidatorResult(input: any): ValidatorResult {
	const status: ValidatorStatus = input?.status === "fail" ? "fail" : "pass";
	const reason = typeof input?.reason === "string" ? input.reason : status === "pass" ? "ok" : "unknown";
	const confidence = Number.isFinite(input?.confidence) ? Number(input.confidence) : 0.5;
	return { status, reason, confidence };
}

async function runBatch(baselineDir: string, stagedDir: string): Promise<BatchRow[]> {
	const rows: BatchRow[] = [];
	const baselineFiles = fs
		.readdirSync(baselineDir)
		.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
		.sort((a, b) => a.localeCompare(b));

	for (const baselineFile of baselineFiles) {
		const imageName = path.basename(baselineFile, path.extname(baselineFile));
		const stagedFile = `${imageName} (Enhanced).webp`;
		const baselinePath = path.join(baselineDir, baselineFile);
		const stagedPath = path.join(stagedDir, stagedFile);
		const pairFound = fs.existsSync(stagedPath);

		const row: BatchRow = {
			image: imageName,
			baseline: baselineFile,
			staged: stagedFile,
			pairFound,
		};

		if (!pairFound) {
			rows.push(row);
			continue;
		}

		let baselineExtraction: any = null;
		try {
			baselineExtraction = await extractStructuralBaseline(baselinePath);
			row.baselineExtraction = {
				ok: true,
				wallCount: Number(baselineExtraction?.wallCount || 0),
				openingCount: Array.isArray(baselineExtraction?.openings) ? baselineExtraction.openings.length : 0,
			};
		} catch (err: any) {
			row.baselineExtraction = {
				ok: false,
				error: err?.message || String(err),
			};
		}

		const [envelope, fixture, flooring, opening] = await Promise.all([
			runEnvelopeValidator(baselinePath, stagedPath).catch((err: any) => ({ status: "fail", reason: err?.message || String(err), confidence: 0 })),
			runFixtureValidator(baselinePath, stagedPath).catch((err: any) => ({ status: "fail", reason: err?.message || String(err), confidence: 0 })),
			runFloorIntegrityValidator(baselinePath, stagedPath).catch((err: any) => ({ status: "fail", reason: err?.message || String(err), confidence: 0 })),
			runOpeningValidator(baselinePath, stagedPath, baselineExtraction).catch((err: any) => ({ status: "fail", reason: err?.message || String(err), confidence: 0 })),
		]);

		row.validators = {
			envelope: toValidatorResult(envelope),
			fixture: toValidatorResult(fixture),
			flooring: toValidatorResult(flooring),
			opening: toValidatorResult(opening),
		};

		rows.push(row);
		console.log(`[batch] ${path.basename(stagedDir)} :: ${imageName} complete`);
	}

	return rows;
}

async function main() {
	const root = path.resolve(__dirname, "..");
	const envPath = path.join(root, "server", ".env");
	if (!fs.existsSync(envPath)) {
		throw new Error(`Missing env file: ${envPath}`);
	}

	const env = parseDotEnv(envPath);
	if (!process.env.GEMINI_API_KEY && env.GEMINI_API_KEY) {
		process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
	}
	if (!process.env.GEMINI_API_KEY) {
		throw new Error("GEMINI_API_KEY not found in process env or server/.env");
	}

	// Keep the existing default behavior but ensure Pro escalation path is configured.
	process.env.GEMINI_VALIDATOR_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
	process.env.GEMINI_VALIDATOR_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
	process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE = process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || "0.7";

	const baselineDir = path.join(root, "Test Images", "Bedroom (Baseline)");
	const stagedDir = path.join(root, "Test Images", "Bedroom (Staged)");
	const staged2Dir = path.join(root, "Test Images", "Bedroom (Staged 2)");
	const outDir = path.join(root, "tmp");

	const timestamp = Date.now();
	console.log(`[batch] starting rerun ts=${timestamp}`);
	console.log(`[batch] Gemini primary=${process.env.GEMINI_VALIDATOR_MODEL_PRIMARY} escalation=${process.env.GEMINI_VALIDATOR_MODEL_ESCALATION}`);

	const stagedResults = await runBatch(baselineDir, stagedDir);
	const staged2Results = await runBatch(baselineDir, staged2Dir);

	const stagedOut = path.join(outDir, `bedroom_stage2_gemini_4validator_results.rerun.${timestamp}.json`);
	const staged2Out = path.join(outDir, `bedroom_staged2_gemini_4validator_results.rerun.${timestamp}.json`);
	fs.writeFileSync(stagedOut, JSON.stringify(stagedResults, null, 2));
	fs.writeFileSync(staged2Out, JSON.stringify(staged2Results, null, 2));

	// Also overwrite canonical outputs for convenience.
	fs.writeFileSync(path.join(outDir, "bedroom_stage2_gemini_4validator_results.json"), JSON.stringify(stagedResults, null, 2));
	fs.writeFileSync(path.join(outDir, "bedroom_staged2_gemini_4validator_results.json"), JSON.stringify(staged2Results, null, 2));

	console.log(`[batch] wrote ${stagedOut}`);
	console.log(`[batch] wrote ${staged2Out}`);
}

main().catch((err) => {
	console.error("[batch] fatal", err);
	process.exit(1);
});
