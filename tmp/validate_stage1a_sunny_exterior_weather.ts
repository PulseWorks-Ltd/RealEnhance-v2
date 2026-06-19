import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { runStage1A } from "../worker/src/pipeline/stage1A";

const ROOT = "/workspaces/RealEnhance-v2";
const BASE_IMAGE = path.join(ROOT, "tmp/replay_rental06/base_user_upload.jpg");
const OUT_DIR = path.join(ROOT, "analysis/stage1a_sunny_exterior_weather_validation");
const INPUT_DIR = path.join(OUT_DIR, "inputs");
const OUTPUT_DIR = path.join(OUT_DIR, "outputs");

type Rect = { left: number; top: number; width: number; height: number };
type CaseDef = {
  id: string;
  description: string;
  source: "base" | "existing";
  sourcePath?: string;
  windowRect?: Rect;
  overlay?: (meta: { width: number; height: number }) => Promise<Buffer>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function renderRainDroplets(width: number, height: number): Promise<Buffer> {
  const circles: string[] = [];
  const count = 65;
  for (let index = 0; index < count; index += 1) {
    const cx = 25 + ((index * 37) % Math.max(40, width - 30));
    const cy = 20 + ((index * 53) % Math.max(30, height - 24));
    const radius = 3 + (index % 5);
    const opacity = 0.16 + ((index % 4) * 0.04);
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(255,255,255,${opacity.toFixed(2)})" />`);
    circles.push(`<circle cx="${cx - 1}" cy="${cy - 1}" r="${Math.max(1, radius - 2)}" fill="rgba(255,255,255,0.28)" />`);
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0.02)" />
    ${circles.join("\n")}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderWaterStreaks(width: number, height: number): Promise<Buffer> {
  const paths: string[] = [];
  const streakCount = 14;
  for (let index = 0; index < streakCount; index += 1) {
    const x = 18 + ((index * 41) % Math.max(30, width - 20));
    const startY = 6 + (index % 4) * 5;
    const endY = height - 8 - (index % 5) * 7;
    const bend = (index % 3) - 1;
    const opacity = 0.15 + ((index % 3) * 0.05);
    paths.push(`<path d="M ${x} ${startY} C ${x + bend * 3} ${Math.floor(height * 0.3)}, ${x - bend * 4} ${Math.floor(height * 0.65)}, ${x + bend * 2} ${endY}" stroke="rgba(255,255,255,${opacity.toFixed(2)})" stroke-width="${2 + (index % 2)}" stroke-linecap="round" fill="none"/>`);
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0.04)" />
    ${paths.join("\n")}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderPrivacyGlass(width: number, height: number): Promise<Buffer> {
  const lines: string[] = [];
  for (let x = 0; x < width; x += 10) {
    lines.push(`<line x1="${x}" y1="0" x2="${x + 18}" y2="${height}" stroke="rgba(255,255,255,0.10)" stroke-width="6" />`);
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0.58)" />
    <rect width="100%" height="100%" fill="rgba(214,225,232,0.18)" />
    ${lines.join("\n")}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderClosedBlinds(width: number, height: number): Promise<Buffer> {
  const slats: string[] = [];
  const slatHeight = 14;
  for (let y = 0; y < height; y += slatHeight) {
    const tone = 214 - ((y / slatHeight) % 2) * 10;
    slats.push(`<rect x="0" y="${y}" width="${width}" height="${slatHeight - 2}" fill="rgb(${tone},${tone},${tone})" />`);
    slats.push(`<line x1="0" y1="${y + slatHeight - 2}" x2="${width}" y2="${y + slatHeight - 2}" stroke="rgba(110,110,110,0.35)" stroke-width="1" />`);
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(238,238,238,0.94)" />
    ${slats.join("\n")}
    <line x1="${Math.floor(width * 0.48)}" y1="0" x2="${Math.floor(width * 0.48)}" y2="${height}" stroke="rgba(120,120,120,0.55)" stroke-width="2" />
    <line x1="${Math.floor(width * 0.52)}" y1="0" x2="${Math.floor(width * 0.52)}" y2="${height}" stroke="rgba(120,120,120,0.55)" stroke-width="2" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function applyOverlay(basePath: string, outPath: string, rect: Rect, overlayBuffer: Buffer): Promise<void> {
  await sharp(basePath)
    .composite([{ input: overlayBuffer, left: rect.left, top: rect.top, blend: "over" }])
    .jpeg({ quality: 96 })
    .toFile(outPath);
}

async function copyExisting(sourcePath: string, outPath: string): Promise<void> {
  const buffer = await fs.readFile(sourcePath);
  await fs.writeFile(outPath, buffer);
}

async function main(): Promise<void> {
  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const baseMeta = await sharp(BASE_IMAGE).metadata();
  const imageWidth = baseMeta.width || 0;
  const imageHeight = baseMeta.height || 0;
  if (!imageWidth || !imageHeight) {
    throw new Error("Unable to read base image dimensions");
  }

  const slidingDoorRect: Rect = { left: 233, top: 222, width: 397, height: 335 };
  const kitchenWindowRect: Rect = { left: 807, top: 223, width: 210, height: 150 };

  const cases: CaseDef[] = [
    {
      id: "A_rain_droplets",
      description: "Synthetic rain droplets on visible sliding-door glass",
      source: "base",
      windowRect: slidingDoorRect,
      overlay: async () => renderRainDroplets(slidingDoorRect.width, slidingDoorRect.height),
    },
    {
      id: "B_water_streaking",
      description: "Synthetic water streaking on visible kitchen window glass",
      source: "base",
      windowRect: kitchenWindowRect,
      overlay: async () => renderWaterStreaks(kitchenWindowRect.width, kitchenWindowRect.height),
    },
    {
      id: "C_privacy_glass",
      description: "Synthetic privacy/frosted glass treatment on visible sliding-door glass",
      source: "base",
      windowRect: slidingDoorRect,
      overlay: async () => renderPrivacyGlass(slidingDoorRect.width, slidingDoorRect.height),
    },
    {
      id: "D_closed_blinds",
      description: "Synthetic closed blinds over visible sliding-door opening",
      source: "base",
      windowRect: slidingDoorRect,
      overlay: async () => renderClosedBlinds(slidingDoorRect.width, slidingDoorRect.height),
    },
  ];

  const summary: Array<Record<string, string>> = [];

  for (const testCase of cases) {
    const inputPath = path.join(INPUT_DIR, `${testCase.id}.jpg`);
    const sourcePath = testCase.source === "existing" ? testCase.sourcePath! : BASE_IMAGE;

    if (testCase.overlay && testCase.windowRect) {
      const overlay = await testCase.overlay({ width: imageWidth, height: imageHeight });
      await applyOverlay(sourcePath, inputPath, testCase.windowRect, overlay);
    } else {
      await copyExisting(sourcePath, inputPath);
    }

    const outputPath = await runStage1A(inputPath, {
      jobId: `stage1a-weather-${testCase.id}`,
      imageId: testCase.id,
      roomType: "living room",
      sceneType: "interior",
      replaceSky: false,
      enhanceExteriorSky: true,
      declutter: false,
      skyMode: "safe",
    });

    const targetOutput = path.join(OUTPUT_DIR, path.basename(outputPath));
    if (path.resolve(outputPath) !== path.resolve(targetOutput)) {
      await fs.copyFile(outputPath, targetOutput);
    }

    summary.push({
      caseId: testCase.id,
      description: testCase.description,
      inputPath,
      outputPath: targetOutput,
    });
  }

  const summaryPath = path.join(OUT_DIR, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`SUMMARY=${summaryPath}`);
  for (const entry of summary) {
    console.log(`${entry.caseId}: ${entry.outputPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});