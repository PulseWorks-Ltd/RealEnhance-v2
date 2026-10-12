// Test harness for Stage 2 "stage, trace, paste back". The shared logic lives
// in pipeline/stage2Masked/core.ts (also used by the app); this script adds
// test-only modes, offline replays (FROM_RUN, PAIR_MODE) and comparison sheets.
//
// Per image:
//   1. Stage: the normal Stage 2 generation (runStage2GenerationAttempt) at 2K,
//      one attempt, no validators. Or reuse an existing staged result.
//   2. Trace: Gemini is shown the empty photo and its staged version (same
//      camera position) and returns a black/white mask of the furniture it
//      added. Ported from feature/vertex-secondary-inpainting-continuity's
//      "original extractor" — the approach that produced clean bed/rug
//      outlines there: two passes run side by side (primary furniture, then
//      secondary pieces/decor), temperature 0, merged, tiny specks removed.
//   3. Layered merge, starting from the original photo:
//      - floor furniture (and anything sitting on it): staged pixels, thin edge;
//      - wall art (own trace pass): kept only on plain wall with the wall
//        around it unchanged, otherwise dropped;
//      - shadows around/below furniture: only the staged DARKENING is applied
//        to the original, and only where it looks like a real shadow;
//      - everything else stays original, so window removals, filled openings
//        and added light fittings cannot survive. The staged image's overall
//        brightness/colour is matched to the original first.
//   Framing check: paste-back only works if Gemini kept the room's shape. If
//   it reframed or reshaped the room, the photo is flagged for re-staging.
//
// Gemini settings (GEMINI_API_KEY etc.) are read from worker/.env automatically.
//
// Run from the worker folder:
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   REUSE_STAGED=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts   (reuse Test Images/Stage2_2K_Comparison)
//   ONLY=Bedroom12 npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   PAIR_MODE=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts "baseline.jpg:bedroom|failed_staged.jpg"
//     (no staging: traces the furniture in the failed image and pastes it onto the baseline)
//   MERGE_MODE=all  compares original-first, hybrid and surface side by side (or: surface, hybrid, staged_first, both)
//   MERGE_MODE=both  (or staged_first) also builds the staged-first result: start from the staged image, revert room changes
//   DEBUG_LAYERS_DIR=/some/folder  saves the merge's decision maps (solid, core, zone, take, factor) there
//   FROM_RUN=2026-10-11T05-08-04-943Z npx tsx src/scripts/stage2-mask-pasteback-test.ts   (rebuild from saved traces, free)
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "C:/photos/lounge.jpg:living_room"
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "photo.jpg:bedroom|old_failed_attempt.webp"
//     (anything after "|" is an earlier failed result, shown first in the comparison sheet)
//
// Output: Test Images/Stage2_MaskPasteback/<run timestamp>/

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { generateContentViaRest } from "../ai/geminiRestClient";

// The worker package does not depend on `dotenv`. Load worker/.env with the
// same minimal parser as measure-stage1a-pregen.ts so GEMINI_API_KEY (and the
// rest of the worker's Gemini settings) are picked up. Values already set in
// the shell win over the file.
function loadDotEnvIfPresent(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent(path.resolve(__dirname, "../../.env"));

const ROOT = path.resolve(__dirname, "../../..");
const T = path.join(ROOT, "Test Images");
// OUT_DIR (optional): results folder, relative to Test Images. A timestamped
// subfolder is always created inside it.
const OUT = path.join(
  process.env.OUT_DIR ? path.resolve(T, process.env.OUT_DIR) : path.join(T, "Stage2_MaskPasteback"),
  new Date().toISOString().replace(/[:.]/g, "-")
);
const PREVIOUS_STAGED_DIR = path.join(T, "Stage2_2K_Comparison");

// Same set as stage2-2k-compare.ts so results can be compared side by side.
const DEFAULT_IMAGES: Array<{ name: string; file: string; roomType: string }> = [
  { name: "Living07", file: "Living (Baseline)/Living 07.jpg", roomType: "living_room" },
  { name: "Living10", file: "Living (Baseline)/Living 10.jpg", roomType: "living_room" },
  { name: "Diningroom01", file: "Living (Baseline)/Diningroom 01.webp", roomType: "dining_room" },
  { name: "Validator_2327860184", file: "Validator Testing Images/2327860184.jpg", roomType: "living_room" },
  { name: "Bedroom14", file: "Validator Testing Images/Bedroom 14.jpg", roomType: "bedroom" },
  { name: "Bedroom12", file: "Validator Testing Images/job_59ac76ce_Bedroom_12_UPLOAD.jpg", roomType: "bedroom" },
];

const STAGE_MODEL = process.env.STAGE_MODEL || "gemini-3.1-flash-image";
const STAGING_STYLE = process.env.STAGING_STYLE || "nz_standard";
const REUSE_STAGED = process.env.REUSE_STAGED === "1";
// PAIR_MODE=1: no staging call. The image after "|" in each argument (an
// already-generated, typically failed, staged result) is used as the staged
// image; only its furniture is traced and pasted onto the baseline. This shows
// whether paste-back would have prevented that failure.
const PAIR_MODE = process.env.PAIR_MODE === "1";
// Rebuild from an earlier run's saved staged image and raw traces — no Gemini
// calls, no cost. Folder name under Test Images/Stage2_MaskPasteback, or a full path.
const FROM_RUN = process.env.FROM_RUN
  ? path.resolve(path.join(T, "Stage2_MaskPasteback"), process.env.FROM_RUN)
  : null;
// MERGE_MODE:
//   original_first (default) — start from the original photo, add furniture,
//     art and shadows from the staged image.
//   staged_first — start from the staged image (natural shadows/lighting) and
//     revert to the original anywhere the room itself changed.
//   both — original-first and staged-first side by side.
//   hybrid — original-first for the room, but Gemini's own pixels (natural
//     shadows/contact shading) around the furniture wherever only shading
//     differs there.
//   surface — decide by whole surfaces using a structure map (one extra
//     Gemini call on the empty room): the whole FLOOR (with rugs, shadows,
//     contact shading) plus furniture/kept art come from the staged image;
//     walls, ceiling, openings and fixtures come entirely from the original.
//     Cuts follow the room's own lines (snapped to the skirting edge).
//   all — original-first, hybrid and surface side by side.
//   harmonise — three phases: (1) furniture traced TIGHTLY (no shadows) and
//     pasted onto the original = a structurally safe image with no shadows;
//     (2) Gemini is asked only to add shadows / blend the lighting of that
//     image; (3) Gemini's result is NEVER published directly — it is only used
//     as a donor for soft darkening near the furniture and for the furniture's
//     lighting. Walls, windows, doors and fixtures always stay the original's.
const MERGE_MODE = (process.env.MERGE_MODE || "original_first").toLowerCase();
const HARMONISE = MERGE_MODE === "harmonise";

// The Stage 2 model is read once when the Stage 2 code first loads, so these
// must be set before anything imports ../ai/gemini or ../pipeline/stage2.
process.env.USE_GEMINI_STAGE2 = "1";
process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = STAGE_MODEL;
process.env.REALENHANCE_STAGE2_IMAGE_SIZE = process.env.REALENHANCE_STAGE2_IMAGE_SIZE || "2K";

// Shared code (also used by the app). Loaded with require AFTER worker/.env
// is read above, so its settings see those values — an import would be
// hoisted and run first.
type DoorOpening = import("../pipeline/stage2Masked/core").DoorOpening;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  APPLIANCE_PASS,
  ART_MAX_BUSY_PATCH,
  ART_MAX_EDGE_PCT,
  ART_MAX_RING_DIFF,
  ART_MAX_WALL_STD,
  BLEND_MAX_REPAIR_PCT,
  CHANGED_TILE_DIFF,
  CHANGE_THRESHOLD,
  CORE_ERODE_PCT,
  DOOR_APPROACH_CHANGED,
  DOOR_CHECK,
  DOOR_CHECK_MODELS,
  DOOR_CHECK_MODEL_SET,
  DOOR_MIN_CLEAR,
  FEATHER_PX,
  HARMONISE_IMAGE_SIZE,
  HARMONISE_MODEL,
  HARM_MAX_SHADOW,
  HARM_ZONE_DOWN_PCT,
  HARM_ZONE_GROW_PCT,
  MAX_RESTAGES,
  OUTPUT_PRICE_PER_M,
  REFRAMED_MEDIAN_DIFF,
  SOLID_GROW_PCT,
  STRUCTURE_LABELS,
  STRUCTURE_PALETTE,
  TRACE_APPLIANCES,
  TRACE_ARTWORK,
  TRACE_IMAGE_SIZE,
  TRACE_MODEL,
  TRACE_PASSES,
  TRACE_REFLECTIONS,
  ZONE_DOWN_PCT,
  ZONE_GROW_PCT,
  approxOutputCost,
  askDoorAccess,
  binarizeTraceResponse,
  buildAppliancePrompt,
  buildApplianceSpacePrompt,
  buildDoorAccessPrompt,
  buildHarmonisePrompt,
  buildMirrorPrompt,
  buildReflectionPrompt,
  buildStructurePrompt,
  buildTracePrompt,
  callGeminiImage,
  callJsonModel,
  checkBlend,
  checkFraming,
  checkStructureRetained,
  classifyStructure,
  compositeHarmonise,
  compositeLayers,
  compositeStagedFirst,
  compositeSurface,
  contactSheet,
  dilate,
  doorwayAppearsBlocked,
  erode,
  evaluateDoorAccess,
  evaluateReflections,
  evaluateWallArt,
  fillChangedGaps,
  fillEnclosedHoles,
  fillFurnitureColumns,
  findDoors,
  growDown,
  imagePart,
  invert,
  labelComponents,
  layersOverlay,
  maskOverlay,
  maskToPng,
  measureOutsideDrift,
  mimeFor,
  ratioOf,
  refineArtRegion,
  removeSmallComponents,
  removeSunPatches,
  snapFloorTop,
  structureOverlay,
  tracePassesFor,
  undoneOverlay,
} = require("../pipeline/stage2Masked/core") as typeof import("../pipeline/stage2Masked/core");

// ── Main ─────────────────────────────────────────────────────────────────────

function resolveImages() {
  const args = process.argv.slice(2);
  if (args.length === 0) return DEFAULT_IMAGES.map((img) => ({ ...img, file: path.join(T, img.file) }));
  // "path/to/photo.jpg:room_type" (room type defaults to living_room).
  // "path/to/photo.jpg:room_type|path/to/old_failed_attempt.webp" — room type
  // defaults to living_room; the old attempt is optional.
  return args.map((arg) => {
    const [photoPart, previousPart] = arg.split("|");
    const match = photoPart.match(/^(.*?)(?::([a-z_]+))?$/);
    const file = path.resolve(match?.[1] || photoPart);
    const previousFile = previousPart ? path.resolve(previousPart.trim()) : undefined;
    return { name: path.parse(file).name.replace(/[^A-Za-z0-9_-]+/g, "_"), file, roomType: match?.[2] || "living_room", previousFile };
  });
}

async function stageImage(
  img: { name: string; file: string; roomType: string; previousFile?: string },
  dir: string,
  correctionHints: string[] = [],
  attempt = 1
): Promise<{ staged: Buffer; source: string }> {
  if (PAIR_MODE) {
    if (!img.previousFile || !fs.existsSync(img.previousFile)) {
      throw new Error(`PAIR_MODE: no staged image given after "|" (or file missing): ${img.previousFile || "none"}`);
    }
    return { staged: fs.readFileSync(img.previousFile), source: `pair image ${path.basename(img.previousFile)} (no staging call)` };
  }
  if (FROM_RUN) {
    const previous = path.join(FROM_RUN, img.name, "2_staged_raw.webp");
    if (!fs.existsSync(previous)) throw new Error(`FROM_RUN: no staged image at ${previous}`);
    return { staged: fs.readFileSync(previous), source: `from run ${path.basename(FROM_RUN)}` };
  }
  if (REUSE_STAGED && attempt === 1) {
    const previous = path.join(PREVIOUS_STAGED_DIR, `${img.name}__${STAGE_MODEL}.webp`);
    if (fs.existsSync(previous)) return { staged: fs.readFileSync(previous), source: `reused ${path.relative(T, previous)}` };
    console.warn(`[${img.name}] no previous staged result at ${previous} — staging now`);
  }
  const { runStage2GenerationAttempt } = await import("../pipeline/stage2");
  const input = path.join(dir, `stage2_input${path.extname(img.file)}`);
  fs.copyFileSync(img.file, input);
  const outputPath = path.join(dir, "2_staged_raw.webp");
  await runStage2GenerationAttempt(input, {
    roomType: img.roomType, sceneType: "interior", promptMode: "full", sourceStage: "1A",
    stagingStyle: STAGING_STYLE, jobId: `pasteback_${img.name}`, imageId: img.name, outputPath, attempt,
    retryCorrectionHints: correctionHints.length ? correctionHints : null,
  });
  // STAGE2_PROMPT_VARIANT=grok/grok_skill (from worker/.env) sends staging to
  // Grok's image-edit API instead of Gemini, exactly as in production.
  const variant = String(process.env.STAGE2_PROMPT_VARIANT || "").trim();
  const stagedWith = variant === "grok" || variant === "grok_skill" ? `grok (${process.env.GROK_IMAGE_MODEL || "grok-imagine-image-quality"})` : STAGE_MODEL;
  return { staged: fs.readFileSync(outputPath), source: `staged now (${stagedWith}${variant ? `, STAGE2_PROMPT_VARIANT=${variant}` : ""}${attempt > 1 ? `, attempt ${attempt}` : ""})` };
}

async function runOne(
  img: { name: string; file: string; roomType: string; previousFile?: string },
  // Re-stage attempts (door blocked) get their own folder and compare sheet;
  // the doors found on the first attempt are reused.
  opts: { attempt: number; hints: string[]; doors?: DoorOpening[] | null } = { attempt: 1, hints: [] }
) {
  const t0 = Date.now();
  const runName = opts.attempt > 1 ? `${img.name}_attempt${opts.attempt}` : img.name;
  const dir = path.join(OUT, runName);
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(img.file);
  const meta = await sharp(original).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  const { closestGeminiAspectRatio } = await import("../ai/gemini");
  const aspectRatio = closestGeminiAspectRatio(w, h);
  fs.writeFileSync(path.join(dir, `1_original${path.extname(img.file)}`), original);
  const row: any = { image: runName, roomType: img.roomType, input: `${w}x${h}`, aspectRatio, ...(opts.attempt > 1 ? { attempt: opts.attempt, restageHints: opts.hints } : {}) };
  let staged: Buffer | null = null, traced: Buffer | null = null, undone: Buffer | null = null, final: Buffer | null = null;
  let stagedFirstFinal: Buffer | null = null, stagedFirstReverted: Buffer | null = null, hybridFinal: Buffer | null = null;
  let surfaceFinal: Buffer | null = null, structureView: Buffer | null = null;
  let safeFinal: Buffer | null = null, harmRaw: Buffer | null = null, harmFinal: Buffer | null = null;
  let checkedBlend: Buffer | null = null, checkedBlendView: Buffer | null = null;

  try {
    console.log(`[${img.name}] 1/3 stage`);
    // Doors of the real room, looked up while staging runs (the app gets these
    // free from its structural baseline). Used by the final door check.
    const doorsPromise: Promise<DoorOpening[] | null> =
      !DOOR_CHECK
        ? Promise.resolve(null)
        : opts.doors !== undefined
        ? Promise.resolve(opts.doors)
        : FROM_RUN
        ? Promise.resolve(fs.existsSync(path.join(FROM_RUN, img.name, "0_doors.json")) ? JSON.parse(fs.readFileSync(path.join(FROM_RUN, img.name, "0_doors.json"), "utf8")) : null)
        : findDoors(img.file, img.roomType, img.name).catch((e) => {
            console.warn(`[${img.name}] door lookup failed — skipping the door check: ${String(e?.message || e).slice(0, 200)}`);
            return null;
          });
    const stageRes = await stageImage(img, dir, opts.hints, opts.attempt);
    const doors = (await doorsPromise)?.filter((d) => d.type === "door" || d.type === "walkthrough") ?? null;
    if (doors) fs.writeFileSync(path.join(dir, "0_doors.json"), JSON.stringify(doors, null, 2));
    staged = stageRes.staged;
    row.staging = stageRes.source;
    if (!fs.existsSync(path.join(dir, "2_staged_raw.webp"))) fs.writeFileSync(path.join(dir, "2_staged_raw.webp"), staged);
    const stagedMeta = await sharp(staged).metadata();
    const stagedMime = stagedMeta.format === "jpeg" ? "image/jpeg" : stagedMeta.format === "png" ? "image/png" : "image/webp";
    row.stagedSize = `${stagedMeta.width}x${stagedMeta.height}`;

    console.log(`[${img.name}] 2/3 trace (${FROM_RUN ? "saved traces, no Gemini call" : `${TRACE_MODEL}, ${TRACE_IMAGE_SIZE}, ${tracePassesFor(img.roomType).length} passes`})`);
    // Structure map of the EMPTY room (surface merge only), in parallel with tracing.
    const wantSurface = MERGE_MODE === "surface" || MERGE_MODE === "all";
    const structurePromise: Promise<Buffer | null> = !wantSurface
      ? Promise.resolve(null)
      : FROM_RUN
      ? Promise.resolve(
          fs.existsSync(path.join(FROM_RUN, img.name, "3_structure_raw.png")) ? fs.readFileSync(path.join(FROM_RUN, img.name, "3_structure_raw.png")) : null
        )
      : callGeminiImage({
          model: TRACE_MODEL,
          parts: [{ text: buildStructurePrompt(img.roomType) }, imagePart(original, mimeFor(img.file))],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        })
          .then((res) => {
            row.structureCostUsd = approxOutputCost(res.usage);
            return res.image;
          })
          .catch((e) => {
            console.warn(`[${img.name}] structure map call failed: ${String(e?.message || e).slice(0, 200)}`);
            row.structureError = String(e?.message || e).slice(0, 300);
            return null;
          });
    const passes = await Promise.all(
      tracePassesFor(img.roomType).map(async (pass) => {
        if (FROM_RUN) {
          const savedPath = path.join(FROM_RUN, img.name, `3_trace_${pass.label}_raw.png`);
          if (!fs.existsSync(savedPath)) {
            console.warn(`[${img.name}] FROM_RUN: no saved "${pass.label}" trace — treating it as empty`);
            return { label: pass.label, kind: pass.kind, mask: new Uint8Array(w * h), inverted: false, cost: 0 };
          }
          const saved = fs.readFileSync(savedPath);
          fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), saved);
          return { label: pass.label, kind: pass.kind, ...(await binarizeTraceResponse(saved, w, h)), cost: 0 };
        }
        const res = await callGeminiImage({
          model: TRACE_MODEL,
          parts: [
            { text: buildTracePrompt(img.roomType, pass.targets, pass.kind, HARMONISE) },
            { text: "STAGED_IMAGE" }, imagePart(staged!, stagedMime),
            { text: "EMPTY_IMAGE" }, imagePart(original, mimeFor(img.file)),
          ],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        });
        fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), res.image);
        const bin = await binarizeTraceResponse(res.image, w, h);
        return { label: pass.label, kind: pass.kind, ...bin, cost: approxOutputCost(res.usage) };
      })
    );
    row.traceCostUsd = Number(passes.reduce((sum, p) => sum + (p.cost || 0), 0).toFixed(4));
    row.tracePasses = passes.map((p) => ({ pass: p.label, coveragePct: +(ratioOf(p.mask) * 100).toFixed(1), coloursFlipped: p.inverted }));

    // Floor furniture: merge the floor passes (OR), drop tiny specks only (thin
    // parts like lamp stems and chair legs must survive), then fill holes.
    const minSpeck = Math.max(24, Math.round(w * h * 0.0002));
    // The wall-art pass is the authority on wall items: Gemini sometimes also
    // marks art in the furniture passes, which would let it skip the wall-art
    // safety checks, so anything the art pass marks is taken out of the floor
    // layer first.
    let artAll = new Uint8Array(w * h);
    for (const p of passes) if (p.kind === "wall_art") for (let i = 0; i < artAll.length; i++) artAll[i] |= p.mask[i];
    artAll = removeSmallComponents(artAll, w, h, minSpeck);
    let floor = new Uint8Array(w * h);
    for (const p of passes) if (p.kind === "floor") for (let i = 0; i < floor.length; i++) floor[i] |= p.mask[i] & (artAll[i] ^ 1);
    floor = removeSmallComponents(floor, w, h, minSpeck);
    // Reflections: their own pass is the authority too (so a "reflection" can't
    // skip its checks by also being marked as furniture), except pieces that
    // turn out to be the furniture itself.
    let reflAll = new Uint8Array(w * h);
    for (const p of passes) if (p.kind === "reflection") for (let i = 0; i < reflAll.length; i++) reflAll[i] |= p.mask[i];
    reflAll = removeSmallComponents(reflAll, w, h, minSpeck);
    // Mirrors in the empty room — only looked up when a reflection was found.
    let mirrorMask: Uint8Array | null = null;
    if (labelComponents(reflAll, w, h).some((p) => p.pixels.length >= Math.max(64, Math.round(w * h * 0.0005)))) {
      const savedMirrors = FROM_RUN ? path.join(FROM_RUN, img.name, "3_trace_mirrors_raw.png") : null;
      let mirrorRaw: Buffer | null = null;
      if (savedMirrors) {
        mirrorRaw = fs.existsSync(savedMirrors) ? fs.readFileSync(savedMirrors) : null;
        if (!mirrorRaw) console.warn(`[${img.name}] FROM_RUN: no saved mirrors trace — reflections will be dropped`);
      } else {
        mirrorRaw = await callGeminiImage({
          model: TRACE_MODEL,
          parts: [{ text: buildMirrorPrompt(img.roomType) }, imagePart(original, mimeFor(img.file))],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        })
          .then((res) => {
            row.mirrorTraceCostUsd = approxOutputCost(res.usage);
            return res.image;
          })
          .catch((e) => {
            console.warn(`[${img.name}] mirror trace failed: ${String(e?.message || e).slice(0, 200)} — reflections will be dropped`);
            return null;
          });
      }
      if (mirrorRaw) {
        fs.writeFileSync(path.join(dir, "3_trace_mirrors_raw.png"), mirrorRaw);
        mirrorMask = (await binarizeTraceResponse(mirrorRaw, w, h)).mask;
        row.mirrorPctOfImage = +(ratioOf(mirrorMask) * 100).toFixed(1);
      }
    }
    const refl = await evaluateReflections(original, staged, reflAll, floor, w, h, mirrorMask ?? new Uint8Array(w * h));
    row.reflections = refl.report;
    for (const piece of refl.report) {
      console.log(`[${img.name}] reflection ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
    }
    for (let i = 0; i < floor.length; i++) if (refl.keep[i] || refl.dropped[i]) floor[i] = 0;

    // Appliances (kitchens): their pass is the authority; each is kept only
    // inside an empty appliance space of the real room, then treated exactly
    // like furniture (shadows, edges, lighting).
    let appAll = new Uint8Array(w * h);
    for (const p of passes) if (p.kind === "appliance") for (let i = 0; i < appAll.length; i++) appAll[i] |= p.mask[i];
    appAll = removeSmallComponents(appAll, w, h, minSpeck);
    if (labelComponents(appAll, w, h).some((p) => p.pixels.length >= Math.max(64, Math.round(w * h * 0.0005)))) {
      const savedSpaces = FROM_RUN ? path.join(FROM_RUN, img.name, "3_trace_appliance_spaces_raw.png") : null;
      let spaceRaw: Buffer | null = null;
      if (savedSpaces) {
        spaceRaw = fs.existsSync(savedSpaces) ? fs.readFileSync(savedSpaces) : null;
      } else {
        spaceRaw = await callGeminiImage({
          model: TRACE_MODEL,
          parts: [{ text: buildApplianceSpacePrompt(img.roomType) }, imagePart(original, mimeFor(img.file))],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        })
          .then((res) => {
            row.applianceSpaceTraceCostUsd = approxOutputCost(res.usage);
            return res.image;
          })
          .catch((e) => {
            console.warn(`[${img.name}] appliance-space trace failed: ${String(e?.message || e).slice(0, 200)} — appliances will be dropped`);
            return null;
          });
      }
      let spaceMask = new Uint8Array(w * h);
      if (spaceRaw) {
        fs.writeFileSync(path.join(dir, "3_trace_appliance_spaces_raw.png"), spaceRaw);
        spaceMask = (await binarizeTraceResponse(spaceRaw, w, h)).mask;
        row.applianceSpacePctOfImage = +(ratioOf(spaceMask) * 100).toFixed(1);
      }
      const appl = await evaluateReflections(original, staged, appAll, floor, w, h, spaceMask, { what: "appliance", space: "an empty appliance space", maxAreaPct: 15 });
      row.appliances = appl.report;
      for (const piece of appl.report) console.log(`[${img.name}] appliance ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
      for (let i = 0; i < floor.length; i++) {
        if (appl.dropped[i]) floor[i] = 0;
        if (appl.keep[i]) floor[i] = 1;
      }
    }
    const tracedRatio = ratioOf(floor);
    // Harmonise keeps the tight outline (only small enclosed holes filled), so
    // no floor or shadow from the staged image comes along with the furniture.
    // Gaps inside a traced piece (a coffee table Gemini drew black on top of a
    // white rug) are filled too, but only where the staged image really
    // differs from the original — bare floor showing between chair legs stays.
    const tightFloor = HARMONISE ? await fillChangedGaps(floor, original, staged, w, h) : null;
    if (tightFloor) row.possiblyMissedByTrace = (tightFloor as any).possiblyMissedByTrace;
    floor = fillFurnitureColumns(floor, w, h);
    const furnitureRatio = ratioOf(floor);
    fs.writeFileSync(path.join(dir, "3_mask_traced.png"), await maskToPng(floor, w, h));
    if (furnitureRatio < 0.01) throw new Error(`tracing found almost no furniture (${(furnitureRatio * 100).toFixed(2)}% of image)`);

    // Wall art: its own layer, kept piece by piece only where it is safe.
    const art = await evaluateWallArt(original, staged, artAll, floor, w, h);
    row.wallArt = art.report;
    for (const piece of art.report) {
      console.log(`[${img.name}] wall art ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
    }

    // Solid layer = furniture + kept art, with a thin margin. Shadow zone =
    // around and below floor furniture, outside the solid layer.
    const artOnly = await refineArtRegion(original, staged, art.keep, w, h);
    // Kept reflections are carried over exactly like kept art: refined to where
    // the staged image actually differs, taken per pixel, no shadow zone.
    const reflRegion = await refineArtRegion(original, staged, refl.keep, w, h);
    const artRegion = new Uint8Array(w * h);
    for (let i = 0; i < artRegion.length; i++) artRegion[i] = artOnly[i] | reflRegion[i];
    let solid = new Uint8Array(w * h);
    for (let i = 0; i < solid.length; i++) solid[i] = floor[i] | artRegion[i];
    solid = dilate(solid, w, h, Math.max(1, Math.round((w * SOLID_GROW_PCT) / 100)));
    let zone = dilate(floor, w, h, Math.round((w * ZONE_GROW_PCT) / 100));
    zone = growDown(zone, w, h, Math.round((h * ZONE_DOWN_PCT) / 100));
    for (let i = 0; i < zone.length; i++) if (solid[i]) zone[i] = 0;
    row.maskPct = {
      traced: +(tracedRatio * 100).toFixed(1),
      furniture: +(furnitureRatio * 100).toFixed(1),
      wallArtKept: +(ratioOf(art.keep) * 100).toFixed(1),
      wallArtDropped: +(ratioOf(art.dropped) * 100).toFixed(1),
      reflectionsKept: +(ratioOf(reflRegion) * 100).toFixed(1),
      reflectionsDropped: +(ratioOf(refl.dropped) * 100).toFixed(1),
      solid: +(ratioOf(solid) * 100).toFixed(1),
      shadowZone: +(ratioOf(zone) * 100).toFixed(1),
    };
    // Core = furniture shrunk inwards; wall art has no core (decided per pixel).
    const core = erode(floor, w, h, Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100)));
    for (let i = 0; i < core.length; i++) core[i] |= artRegion[i];
    const solidPng = await maskToPng(solid, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_final.png"), solidPng);
    fs.writeFileSync(path.join(dir, "3_mask_shadow_zone.png"), await maskToPng(zone, w, h));
    const droppedAll = new Uint8Array(w * h);
    for (let i = 0; i < droppedAll.length; i++) droppedAll[i] = art.dropped[i] | refl.dropped[i];
    traced = await layersOverlay(staged, floor, artOnly, droppedAll, w, h, reflRegion);
    fs.writeFileSync(path.join(dir, "3_mask_overlay.jpg"), traced);

    // Room-change measurements ignore furniture and ALL traced art (kept or
    // dropped), so they reflect the room itself.
    const measureMask = new Uint8Array(w * h);
    for (let i = 0; i < measureMask.length; i++) measureMask[i] = solid[i] | artAll[i] | reflAll[i];
    row.stagedChangesOutsideMask = await measureOutsideDrift(original, staged, measureMask, w, h);
    row.framingCheck = await checkFraming(original, staged, measureMask, w, h);
    if (row.framingCheck.framingChanged) {
      console.warn(`[${img.name}] Gemini reshaped/reframed the room (typical wall/ceiling patch differs by ${row.framingCheck.medianDiff}) — paste-back can't fix this; this photo would need re-staging`);
    }
    undone = await undoneOverlay(original, staged, solid, w, h);
    fs.writeFileSync(path.join(dir, "4_changes_removed_by_pasteback.jpg"), undone);

    console.log(`[${img.name}] 3/3 layered merge`);
    const zonePng = await maskToPng(zone, w, h);
    const pasted = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h);
    final = pasted.buffer;
    fs.writeFileSync(path.join(dir, "5_final_pasteback.webp"), final);
    row.finalSize = `${pasted.width}x${pasted.height}`;
    row.colourGains = pasted.colourGains;
    row.shadowPctOfZone = pasted.shadowPctOfZone;
    row.edgeBandStagedPct = pasted.edgeBandStagedPct;
    if (wantSurface) {
      const structureRaw = await structurePromise;
      if (!structureRaw) {
        console.warn(`[${img.name}] no structure map available — skipping the surface merge`);
      } else {
        fs.writeFileSync(path.join(dir, "3_structure_raw.png"), structureRaw);
        const labels = await classifyStructure(structureRaw, w, h);
        let floorSurface = new Uint8Array(w * h);
        for (let i = 0; i < labels.length; i++) floorSurface[i] = labels[i] === STRUCTURE_LABELS.floor ? 1 : 0;
        const rClose = Math.max(1, Math.round(w * 0.003));
        floorSurface = erode(dilate(floorSurface, w, h, rClose), w, h, rClose);
        floorSurface = removeSmallComponents(floorSurface, w, h, Math.round(w * h * 0.002));
        const snap = await snapFloorTop(floorSurface, original, w, h);
        floorSurface = snap.floor;
        for (let i = 0; i < labels.length; i++) {
          if (labels[i] === STRUCTURE_LABELS.floor && !floorSurface[i]) labels[i] = STRUCTURE_LABELS.wall;
          else if (floorSurface[i]) labels[i] = STRUCTURE_LABELS.floor;
        }
        structureView = await structureOverlay(original, labels, w, h);
        fs.writeFileSync(path.join(dir, "3_structure_overlay.jpg"), structureView);
        const counts = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < labels.length; i++) counts[labels[i]]++;
        const pct = (n: number) => Number(((n / labels.length) * 100).toFixed(1));
        const sf = await compositeSurface(original, staged, floorSurface, solid, w, h);
        surfaceFinal = sf.buffer;
        fs.writeFileSync(path.join(dir, "8_final_surface.webp"), sf.buffer);
        row.surface = {
          structurePct: { floor: pct(counts[1]), wall: pct(counts[2]), ceiling: pct(counts[3]), opening: pct(counts[4]), fixture: pct(counts[5]), unknown: pct(counts[0]) },
          floorEdgeSnappedColumnsPct: Number(((snap.snappedColumns / w) * 100).toFixed(1)),
          colourGains: sf.colourGains,
          floorCheck: sf.floorCheck,
        };
        if (sf.floorCheck.floorChanged) {
          console.warn(`[${img.name}] Gemini changed the floor itself (colour diff ${sf.floorCheck.colourDiff}, chroma diff ${sf.floorCheck.chromaDiff}) — this photo would need re-staging`);
        }
      }
    }
    if (HARMONISE && tightFloor) {
      console.log(`[${img.name}] harmonise: safe composite -> Gemini blend -> borrow shadows/lighting only`);
      // Phase 1: original room + tightly traced furniture + kept art, no shadows.
      let tSolid = new Uint8Array(w * h);
      for (let i = 0; i < tSolid.length; i++) tSolid[i] = tightFloor[i] | artRegion[i];
      tSolid = dilate(tSolid, w, h, Math.max(1, Math.round((w * SOLID_GROW_PCT) / 100)));
      const tCore = erode(tightFloor, w, h, Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100)));
      for (let i = 0; i < tCore.length; i++) tCore[i] |= artRegion[i];
      const tSolidPng = await maskToPng(tSolid, w, h);
      const tCorePng = await maskToPng(tCore, w, h);
      fs.writeFileSync(path.join(dir, "3_mask_tight.png"), tSolidPng);
      const safeRes = await compositeLayers(original, staged, tSolidPng, tCorePng, await maskToPng(new Uint8Array(w * h), w, h), w, h, false, true);
      const edgeMattePctOfBand = safeRes.edgeMattePctOfBand;
      safeFinal = safeRes.buffer;
      fs.writeFileSync(path.join(dir, "9_safe_composite.webp"), safeFinal);

      // Phase 2: Gemini adds shadows / blends lighting on the safe image.
      if (FROM_RUN) {
        const saved = path.join(FROM_RUN, img.name, "9_harmonise_raw.png");
        harmRaw = fs.existsSync(saved) ? fs.readFileSync(saved) : null;
        if (!harmRaw) console.warn(`[${img.name}] FROM_RUN: no saved 9_harmonise_raw.png — using the safe composite as the final`);
      } else {
        harmRaw = await callGeminiImage({
          model: HARMONISE_MODEL,
          parts: [{ text: buildHarmonisePrompt(img.roomType) }, imagePart(safeFinal, "image/webp")],
          imageSize: HARMONISE_IMAGE_SIZE,
          aspectRatio,
        })
          .then((res) => {
            row.harmoniseCostUsd = approxOutputCost(res.usage);
            return res.image;
          })
          .catch((e) => {
            console.warn(`[${img.name}] harmonise call failed: ${String(e?.message || e).slice(0, 200)}`);
            row.harmoniseError = String(e?.message || e).slice(0, 300);
            return null;
          });
      }
      if (harmRaw) fs.writeFileSync(path.join(dir, "9_harmonise_raw.png"), harmRaw);

      // Phase 3: borrow only shadows (near furniture) and furniture lighting.
      let hZone = dilate(tightFloor, w, h, Math.round((w * HARM_ZONE_GROW_PCT) / 100));
      hZone = growDown(hZone, w, h, Math.round((h * HARM_ZONE_DOWN_PCT) / 100));
      for (let i = 0; i < hZone.length; i++) if (tSolid[i]) hZone[i] = 0;
      const affected = new Uint8Array(w * h);
      for (let i = 0; i < affected.length; i++) affected[i] = tSolid[i] | hZone[i];
      fs.writeFileSync(path.join(dir, "3_mask_harmonise_shadow_zone.png"), await maskToPng(hZone, w, h));
      row.harmonise = { tightFurniturePct: +(ratioOf(tightFloor) * 100).toFixed(1), shadowZonePct: +(ratioOf(hZone) * 100).toFixed(1), edgeMattePctOfBand };
      let blendUsable = !!harmRaw;
      if (harmRaw) {
        // Did Gemini keep the room's framing in its blend? If not, its shadows
        // won't line up, so none of it is used.
        const framing = await checkFraming(safeFinal, harmRaw, affected, w, h);
        row.harmonise.blendFraming = framing;
        // How much Gemini changed the rest of the room in its blend (ignored either way).
        row.harmonise.blendChangesElsewhere = await measureOutsideDrift(safeFinal, harmRaw, affected, w, h);
        if (framing.framingChanged) {
          blendUsable = false;
          console.warn(`[${img.name}] Gemini's blend reframed the room (median ${framing.medianDiff}) — using the safe composite without shadows`);
        }
      }
      let sunPatchMask: Uint8Array | null = null;
      if (blendUsable) {
        const hZonePng = await maskToPng(hZone, w, h);
        // The safe composite's own furniture alpha (exactly which pixels are
        // staged furniture) protects the furniture from floor shadow/sun steps.
        const furnPng = safeRes.furnitureAlphaPng;
        fs.writeFileSync(path.join(dir, "9_furniture_alpha.png"), furnPng);
        const sun = await removeSunPatches(safeFinal, harmRaw!, tSolidPng, furnPng, hZonePng);
        row.harmonise.sunPatchPctOfImage = sun.regionPctOfImage;
        if (sun.regionMask) {
          fs.writeFileSync(path.join(dir, "9_sun_patch_region.png"), sun.regionMask);
          const m = await sharp(sun.regionMask).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer();
          sunPatchMask = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) sunPatchMask[i] = m[i] > 0 ? 1 : 0;
        }
        const hm = await compositeHarmonise(sun.buffer, harmRaw!, tSolidPng, furnPng, hZonePng);
        harmFinal = hm.buffer;
        Object.assign(row.harmonise, {
          blendUsed: true,
          colourGains: hm.colourGains,
          shadowPctOfZone: hm.shadowPctOfZone,
          strongestShadowPct: hm.strongestShadowPct,
          furnitureDiffVsBlend: hm.furnitureDiffVsBlend,
          furnitureLightingUsed: hm.furnitureLightingUsed,
          furnitureLightingChangedPctOfImage: hm.furnitureLightingChangedPctOfImage,
        });
      } else {
        harmFinal = safeFinal;
        row.harmonise.blendUsed = false;
      }
      fs.writeFileSync(path.join(dir, "10_final_harmonise.webp"), harmFinal);
      // Structure check: outside the furniture and its shadow zone (plus the
      // soft fade at its edge) the final must be the original photo — only
      // resize/compression noise allowed.
      // Sun patches softened next to the furniture are lighting, not structure.
      if (sunPatchMask) for (let i = 0; i < affected.length; i++) affected[i] |= sunPatchMask[i];
      const structure = await checkStructureRetained(original, harmFinal, dilate(affected, w, h, Math.round(w * 0.03)), w, h);
      row.harmonise.structureCheck = structure;
      if (!row.harmonise.structureCheck.retained) console.warn(`[${img.name}] harmonise structure check FAILED: ${JSON.stringify(structure)}`);

      // Checked blend: Gemini's blend as the final, patch-checked and repaired.
      if (blendUsable && harmRaw) {
        const zoneAll = new Uint8Array(w * h);
        for (let i = 0; i < zoneAll.length; i++) zoneAll[i] = hZone[i] | (sunPatchMask ? sunPatchMask[i] : 0);
        // Checked against (and repaired from) the app-built final: same room
        // structure as the safe composite, but with sun patches already
        // softened and shadows in, so repairs near furniture match.
        const cb = await checkBlend(harmFinal, harmRaw, tSolid, zoneAll, w, h);
        checkedBlendView = cb.repairedView;
        fs.writeFileSync(path.join(dir, "11_checked_blend_repairs.jpg"), cb.repairedView);
        row.checkedBlend = {
          patchesChecked: cb.patchesChecked,
          patchesRepaired: cb.patchesRepaired,
          repairPct: cb.repairPct,
          reasons: cb.reasons,
          furnitureRestyledAndRepaired: cb.furnitureChanged,
          usedAppBuiltInstead: cb.tooMuchChanged,
        };
        if (cb.tooMuchChanged) {
          console.warn(`[${img.name}] checked blend: ${cb.repairPct}% of patches changed (limit ${BLEND_MAX_REPAIR_PCT}%) — using the app-built final instead`);
          checkedBlend = harmFinal;
        } else {
          checkedBlend = cb.buffer;
        }
        fs.writeFileSync(path.join(dir, "11_final_checked_blend.webp"), checkedBlend);
      }
    }
    if (MERGE_MODE === "hybrid" || MERGE_MODE === "all") {
      const hy = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h, true);
      hybridFinal = hy.buffer;
      fs.writeFileSync(path.join(dir, "7_final_hybrid.webp"), hy.buffer);
      row.hybrid = { stagedAroundFurniturePctOfImage: hy.hybridStagedPctOfImage };
    }
    if (MERGE_MODE === "staged_first" || MERGE_MODE === "both") {
      const sf = await compositeStagedFirst(original, staged, solidPng, w, h);
      stagedFirstFinal = sf.buffer;
      stagedFirstReverted = sf.revertedView;
      fs.writeFileSync(path.join(dir, "6_final_staged_first.webp"), sf.buffer);
      fs.writeFileSync(path.join(dir, "6_staged_first_reverted.jpg"), sf.revertedView);
      row.stagedFirst = { revertedPctOfImage: sf.revertedPct };
    }
    // Final check: can people still walk through the real doorways?
    const finalImage = checkedBlend || harmFinal || final;
    row.doorAccess = { doorsFound: doors ? doors.length : "lookup failed", doors: doors ?? [] };
    if (DOOR_CHECK && doors && doors.length > 0 && finalImage) {
      const pre = await doorwayAppearsBlocked(original, finalImage, doors);
      const flagged = pre.filter((d) => d.appearsBlocked);
      row.doorAccess.codeCheck = Object.fromEntries(pre.map((d) => [d.id, { openingCoveredPct: d.openingCoveredPct, longestClearPct: d.longestClearPct }]));
      if (flagged.length === 0) {
        row.doorAccess.result = "clear (code check, no AI call)";
      } else if (FROM_RUN) {
        row.doorAccess.result = "appears blocked (AI check skipped in FROM_RUN)";
      } else {
        console.log(`[${runName}] doorway may be blocked (${flagged.map((d) => `${d.id}: clear stretch only ${d.longestClearPct}% of its width`).join(", ")}) — asking the AI to review the final image`);
        const ai = await askDoorAccess(img.file, finalImage, flagged, img.roomType, dir, runName);
        row.doorAccess.ai = ai;
        row.doorAccess.blocked = ai.blocked;
        row.doorAccess.restageHints = ai.restageHints;
        row.doorAccess.result = ai.blocked ? "BLOCKED (AI)" : "clear (AI)";
        if (ai.blocked) console.warn(`[${runName}] DOORWAY BLOCKED in the final image: ${ai.items.filter((o: any) => o.accessBlocked === "yes").map((o: any) => `${o.description} — ${o.blockingFurniture}`).join(" | ")}`);
      }
    }
    // A big average change across the untouched room usually means Gemini
    // re-lit or slightly reframed the photo, which can leave visible seams.
    if (row.stagedChangesOutsideMask.meanAbsoluteDelta > 8) {
      row.checkSeams = true;
      console.warn(`[${img.name}] Gemini changed the rest of the room a lot (avg ${row.stagedChangesOutsideMask.meanAbsoluteDelta}) — check panel 5 for seams`);
    }
    row.ok = true;
  } catch (e: any) {
    row.ok = false;
    row.error = String(e?.message || e).slice(0, 400);
  }

  let previous: Buffer | null = null;
  if (img.previousFile && !PAIR_MODE) {
    if (fs.existsSync(img.previousFile)) {
      previous = fs.readFileSync(img.previousFile);
      fs.writeFileSync(path.join(dir, `0_old_failed_attempt${path.extname(img.previousFile)}`), previous);
      row.oldFailedAttempt = path.relative(ROOT, img.previousFile);
    } else {
      console.warn(`[${img.name}] old attempt not found: ${img.previousFile}`);
    }
  }
  const reshaped = row.framingCheck?.framingChanged ? " - RESHAPED, re-stage" : "";
  const panels =
    HARMONISE
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Safe composite (no shadows)", image: safeFinal },
          { label: "4. Gemini blend (raw, unchecked)", image: harmRaw },
          { label: "5. App-built final" + reshaped + (row.harmonise && !row.harmonise.blendUsed ? " - NO SHADOWS" : ""), image: harmFinal },
          { label: `6. Checked blend: repaired patches (red)${row.checkedBlend ? ` ${row.checkedBlend.repairPct}%` : ""}`, image: checkedBlendView },
          { label: "7. Checked blend final" + reshaped + (row.checkedBlend?.usedAppBuiltInstead ? " - TOO MANY CHANGES, used 5" : "") + (row.doorAccess?.blocked ? " - DOOR BLOCKED" : ""), image: checkedBlend },
        ]
      : MERGE_MODE === "all"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Structure: floor/wall/ceiling/opening/fixture", image: structureView },
          { label: "4. Original-first" + reshaped, image: final },
          { label: "5. Hybrid" + reshaped, image: hybridFinal },
          { label: "6. Surface" + reshaped + (row.surface?.floorCheck?.floorChanged ? " - FLOOR CHANGED" : ""), image: surfaceFinal },
        ]
      : MERGE_MODE === "surface"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Structure: floor/wall/ceiling/opening/fixture", image: structureView },
          { label: "4. Furniture red / art kept blue / dropped orange", image: traced },
          { label: "5. Surface result" + reshaped + (row.surface?.floorCheck?.floorChanged ? " - FLOOR CHANGED" : ""), image: surfaceFinal },
        ]
      : MERGE_MODE === "hybrid"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          { label: "4. Hybrid result" + reshaped, image: hybridFinal },
        ]
      : MERGE_MODE === "both"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          { label: "4. Original-first result" + reshaped, image: final },
          { label: "5. Staged-first: reverted areas (red)", image: stagedFirstReverted },
          { label: "6. Staged-first result" + reshaped, image: stagedFirstFinal },
        ]
      : [
          ...(previous ? [{ label: "0. Old failed attempt", image: previous }] : []),
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          ...(MERGE_MODE === "staged_first"
            ? [
                { label: "4. Staged-first: reverted areas (red)", image: stagedFirstReverted },
                { label: "5. Staged-first result" + reshaped, image: stagedFirstFinal },
              ]
            : [
                { label: "4. Room changes removed (red)", image: undone },
                { label: row.framingCheck?.framingChanged ? "5. Final - ROOM RESHAPED, re-stage" : "5. Final (pasted back)", image: final },
              ]),
        ];
  const sheet = await contactSheet(panels, w, h);
  fs.writeFileSync(path.join(OUT, `${runName}__compare.jpg`), sheet);
  row.seconds = (Date.now() - t0) / 1000;
  console.log("RESULT", JSON.stringify(row));
  return row;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.ONLY;
  const rows: any[] = [];
  for (const img of resolveImages()) {
    if (only && !img.name.includes(only)) continue;
    if (!fs.existsSync(img.file)) {
      console.warn(`Skipping ${img.name}: file not found (${img.file})`);
      continue;
    }
    // A photo needs re-staging when the final image has a blocked doorway or
    // Gemini reshaped the room. One re-stage (MAX_RESTAGES) for any reason; if
    // the re-staged result also fails, the photo fails and the app delivers
    // its last good output — the Stage 2 input (Stage 1A, or 1B if decluttered).
    let opts: { attempt: number; hints: string[]; doors?: DoorOpening[] | null } = { attempt: 1, hints: [] };
    for (;;) {
      const row = await runOne(img, opts);
      rows.push(row);
      const reasons = [
        ...(row.doorAccess?.blocked ? ["doorway blocked"] : []),
        ...(row.framingCheck?.framingChanged ? ["room reshaped"] : []),
        ...(row.ok === false ? ["processing error"] : []),
      ];
      if (reasons.length === 0) {
        row.outcome = "publish";
        break;
      }
      if (PAIR_MODE || FROM_RUN) {
        row.outcome = `needs re-stage (${reasons.join(", ")}) — not possible in pair/offline mode`;
        console.warn(`[${row.image}] ${row.outcome}`);
        break;
      }
      if (opts.attempt > MAX_RESTAGES) {
        row.outcome = `FAILED after re-stage (${reasons.join(", ")}) — the app delivers its last good output (the Stage 2 input)`;
        const dir = path.join(OUT, row.image);
        if (fs.existsSync(dir)) fs.copyFileSync(img.file, path.join(dir, `13_fallback_output${path.extname(img.file)}`));
        console.warn(`[${row.image}] ${row.outcome}`);
        break;
      }
      row.outcome = `re-stage (${reasons.join(", ")})`;
      console.warn(`[${row.image}] re-staging (attempt ${opts.attempt + 1}): ${reasons.join(", ")}`);
      opts = { attempt: opts.attempt + 1, hints: row.doorAccess?.blocked ? row.doorAccess.restageHints || [] : [], doors: row.doorAccess?.doors ?? null };
    }
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`\nDone. ${rows.filter((r) => r.ok).length}/${rows.length} succeeded.`);
  console.log(`Open the *__compare.jpg files in: ${OUT}`);
}

if (require.main === module) {
  // Exit explicitly: the worker modules this loads (Stage 2, Gemini helpers)
  // keep background connections/timers open, so Node would otherwise never
  // exit after the results are written.
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { fillChangedGaps, buildAppliancePrompt, buildApplianceSpacePrompt, doorwayAppearsBlocked, evaluateDoorAccess, buildDoorAccessPrompt, buildMirrorPrompt, evaluateReflections, buildReflectionPrompt, checkBlend, removeSunPatches, checkStructureRetained, fillEnclosedHoles, compositeHarmonise, buildHarmonisePrompt, classifyStructure, snapFloorTop, compositeSurface, structureOverlay, STRUCTURE_LABELS, compositeStagedFirst, refineArtRegion, evaluateWallArt, compositeLayers, layersOverlay, labelComponents, fillFurnitureColumns, checkFraming, binarizeTraceResponse, measureOutsideDrift, maskToPng, maskOverlay, undoneOverlay, contactSheet, removeSmallComponents, dilate, growDown, ratioOf };
