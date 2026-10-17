/**
 * Side-by-side test of the two layout planners, without running the app.
 *
 *   OLD  anchor-locked planner (structural baseline x2, wall visibility,
 *        zoning, fridge check...) -> its staging prompt
 *   NEW  room brief: ONE call -> plain-language room + layout -> prompt
 *
 * For each photo it saves both prompts, the room brief JSON, and how many AI
 * calls / tokens / seconds each planner used. Generating the staged images
 * is OFF by default (cost); add --stage to also stage the photo once with
 * each prompt (2 image generations per photo).
 *
 * Usage (from worker/):
 *   npx tsx src/scripts/room-brief-compare.ts
 *   npx tsx src/scripts/room-brief-compare.ts --stage
 *   npx tsx src/scripts/room-brief-compare.ts --new-only "Kitchen 01=kitchen_living_dining"
 *   npx tsx src/scripts/room-brief-compare.ts --model gemini-3.8-flash "path/to/photo.jpg=bedroom"
 *
 * Photos: "<file or name in Test Images/Kitchen>=<roomType>". Default:
 * Kitchen 01 (kitchen_living_dining) and Kitchen 12 (living_dining, as it
 * was uploaded in the 2026-10-12 run).
 *
 * Gemini key: read from worker/.env (GEMINI_API_KEY) or the environment.
 * Output: Test Images/Room Brief Compare/<timestamp>/
 */
import fs from "fs";
import path from "path";

function loadDotEnvIfPresent(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnvIfPresent(path.resolve(__dirname, "../../.env"));

const REPO = path.resolve(__dirname, "../../..");
const TEST_IMAGES = path.join(REPO, "Test Images");

type Call = { host: string; model: string; inputTokens: number; outputTokens: number; thinkingTokens: number; latencyMs: number };
let meter: Call[] | null = null;

// Count every AI call made through fetch (the Gemini SDK, REST calls and
// Grok all use it) while a planner runs.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  const started = Date.now();
  const res = await realFetch(input, init);
  if (meter && /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.x\.ai/.test(url)) {
    const model = (url.match(/models\/([^:/?]+)/) || [])[1] || (/x\.ai/.test(url) ? "grok" : "?");
    const call: Call = { host: new URL(url).host, model, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, latencyMs: Date.now() - started };
    meter.push(call);
    try {
      const body: any = await res.clone().json();
      const um = body?.usageMetadata || body?.usage || {};
      call.inputTokens = Number(um.promptTokenCount ?? um.prompt_tokens ?? um.input_tokens ?? 0);
      call.outputTokens = Number(um.candidatesTokenCount ?? um.completion_tokens ?? um.output_tokens ?? 0);
      call.thinkingTokens = Number(um.thoughtsTokenCount ?? 0);
      if (!/x\.ai/.test(url)) call.model = body?.modelVersion || call.model;
    } catch {}
    call.latencyMs = Date.now() - started;
  }
  return res;
}) as any;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { stage: false, newOnly: false, model: undefined as string | undefined, photos: [] as Array<{ file: string; roomType: string }> };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stage") opts.stage = true;
    else if (a === "--new-only") opts.newOnly = true;
    else if (a === "--model") opts.model = args[++i];
    else {
      const [f, rt] = a.split("=");
      opts.photos.push({ file: f, roomType: rt || "kitchen_living_dining" });
    }
  }
  if (!opts.photos.length) {
    opts.photos.push({ file: "Kitchen 01", roomType: "kitchen_living_dining" }, { file: "Kitchen 12", roomType: "living_dining" });
  }
  return opts;
}

function resolvePhoto(file: string): string {
  const candidates = [file, path.join(TEST_IMAGES, file), path.join(TEST_IMAGES, "Kitchen", `${file}.jpg`), path.join(TEST_IMAGES, `${file}.jpg`)];
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  throw new Error(`photo not found: ${file}`);
}

function summarise(calls: Call[]) {
  const sum = (k: keyof Call) => calls.reduce((s, c) => s + (Number(c[k]) || 0), 0);
  const byModel: Record<string, number> = {};
  for (const c of calls) byModel[c.model] = (byModel[c.model] || 0) + 1;
  return { calls: calls.length, byModel, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), thinkingTokens: sum("thinkingTokens") };
}

async function main() {
  const opts = parseArgs();
  if (!(process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY)) {
    console.error("No Gemini key: set GEMINI_API_KEY in worker/.env or the environment.");
    process.exit(1);
  }
  // Loaded after the env so module-level settings see worker/.env.
  const { buildAnchorLockedStage2Prompt } = require("../pipeline/anchorLockedStaging");
  const { buildRoomBrief, buildStage2PromptFromRoomBrief, ROOM_BRIEF_MODEL } = require("../pipeline/roomBrief");
  const { callGeminiImage, imagePart } = require("../pipeline/stage2Masked/core");
  const { closestGeminiAspectRatio } = require("../ai/gemini");
  const sharp = require("sharp");

  const outRoot = path.join(TEST_IMAGES, "Room Brief Compare", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outRoot, { recursive: true });
  const report: any[] = [];

  for (const photo of opts.photos) {
    const imagePath = resolvePhoto(photo.file);
    const name = path.basename(imagePath).replace(/\.[^.]+$/, "");
    const dir = path.join(outRoot, name.replace(/[^A-Za-z0-9_-]+/g, "_"));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(imagePath, path.join(dir, `0_input${path.extname(imagePath)}`));
    const row: any = { photo: name, roomType: photo.roomType };
    console.log(`\n=== ${name} (${photo.roomType}) ===`);

    let oldPrompt: string | null = null;
    if (!opts.newOnly) {
      meter = [];
      const t0 = Date.now();
      try {
        const res = await buildAnchorLockedStage2Prompt({ imagePath, roomType: photo.roomType, jobId: `cmp_${name}`, imageId: `cmp_${name}` });
        oldPrompt = res.prompt;
        row.old = { ok: !!res.prompt, fallbackReason: res.fallbackReason || null, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...summarise(meter), diagnostics: res.diagnostics };
        if (res.prompt) fs.writeFileSync(path.join(dir, "old_prompt.txt"), res.prompt);
      } catch (e: any) {
        row.old = { ok: false, error: String(e?.message || e).slice(0, 300), seconds: +((Date.now() - t0) / 1000).toFixed(1), ...summarise(meter) };
      }
      meter = null;
      console.log("OLD:", JSON.stringify({ ok: row.old.ok, calls: row.old.calls, byModel: row.old.byModel, seconds: row.old.seconds, fallback: row.old.fallbackReason }));
    }

    meter = [];
    const t1 = Date.now();
    let newPrompt: string | null = null;
    try {
      const res = await buildRoomBrief({ imagePath, roomType: photo.roomType, model: opts.model });
      if (res.brief) fs.writeFileSync(path.join(dir, "new_room_brief.json"), JSON.stringify(res.brief, null, 2));
      if (res.ok) {
        const built: string = buildStage2PromptFromRoomBrief(res.brief, { roomType: photo.roomType });
        newPrompt = built;
        fs.writeFileSync(path.join(dir, "new_prompt.txt"), built);
      }
      row.new = { ok: res.ok, model: opts.model || ROOM_BRIEF_MODEL, issues: res.issues, seconds: +((Date.now() - t1) / 1000).toFixed(1), ...summarise(meter), usageFromSdk: res.usage };
    } catch (e: any) {
      row.new = { ok: false, error: String(e?.message || e).slice(0, 300), seconds: +((Date.now() - t1) / 1000).toFixed(1), ...summarise(meter) };
    }
    meter = null;
    console.log("NEW:", JSON.stringify({ ok: row.new.ok, calls: row.new.calls, byModel: row.new.byModel, seconds: row.new.seconds, issues: row.new.issues }));

    if (opts.stage) {
      const meta = await sharp(imagePath).metadata();
      const aspectRatio = closestGeminiAspectRatio(meta.width || 4, meta.height || 3);
      const input = fs.readFileSync(imagePath);
      for (const [label, prompt] of [["old", oldPrompt], ["new", newPrompt]] as const) {
        if (!prompt) continue;
        try {
          const res = await callGeminiImage({
            model: process.env.STAGE_MODEL || "gemini-3.1-flash-image",
            parts: [{ text: prompt }, imagePart(input, "image/jpeg")],
            imageSize: "2K",
            aspectRatio,
          });
          fs.writeFileSync(path.join(dir, `${label}_staged.webp`), res.image);
          console.log(`staged with ${label} prompt`);
        } catch (e: any) {
          console.log(`staging with ${label} prompt failed: ${String(e?.message || e).slice(0, 200)}`);
        }
      }
    }
    report.push(row);
    fs.writeFileSync(path.join(outRoot, "results.json"), JSON.stringify(report, null, 2));
  }

  // Readable summary.
  const lines = [
    `# Room brief vs anchor-locked planner`,
    ``,
    `| Photo | Planner | OK | AI calls (by model) | Input tok | Output tok | Thinking tok | Seconds | Notes |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of report) {
    for (const k of ["old", "new"] as const) {
      const x = r[k];
      if (!x) continue;
      const models = Object.entries(x.byModel || {}).map(([m, n]) => `${m}×${n}`).join(", ");
      const notes = k === "old" ? (x.fallbackReason || x.error || "") : ((x.issues || []).join("; ") || x.error || "");
      lines.push(`| ${r.photo} | ${k === "old" ? "old (anchor-locked)" : "new (room brief)"} | ${x.ok ? "yes" : "no"} | ${x.calls ?? "?"} (${models}) | ${x.inputTokens ?? "?"} | ${x.outputTokens ?? "?"} | ${x.thinkingTokens ?? "?"} | ${x.seconds} | ${notes} |`);
    }
  }
  fs.writeFileSync(path.join(outRoot, "summary.md"), lines.join("\n") + "\n");
  console.log(`\nSaved to ${outRoot}`);
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
