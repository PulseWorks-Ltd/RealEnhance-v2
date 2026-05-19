import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import type { CompiledMaskResult } from "../types";

type OverlayColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

export type ContinuityDebugArtifacts = {
  occupancyOverlayPath: string;
  exclusionOverlayPath: string;
  finalMaskOverlayPath: string;
  renderBoundaryPreviewPath: string;
  insertionRegionPreviewPath: string;
};

function maskToOverlay(mask: Buffer, width: number, height: number, color: OverlayColor): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const alpha = mask[index] > 0 ? color.alpha : 0;
    const offset = index * 4;
    rgba[offset] = color.red;
    rgba[offset + 1] = color.green;
    rgba[offset + 2] = color.blue;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

function buildBoundaryMask(mask: Buffer, width: number, height: number): Buffer {
  const boundary = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) {
        continue;
      }
      const neighbors = [
        x > 0 ? mask[index - 1] : 0,
        x < width - 1 ? mask[index + 1] : 0,
        y > 0 ? mask[index - width] : 0,
        y < height - 1 ? mask[index + width] : 0,
      ];
      if (neighbors.some((value) => value === 0)) {
        boundary[index] = 255;
      }
    }
  }
  return boundary;
}

async function writeComposite(baseImagePath: string, overlays: Buffer[], width: number, height: number, outputPath: string): Promise<void> {
  const composite = overlays.map((overlay) => ({
    input: overlay,
    raw: { width, height, channels: 4 as const },
    blend: "over" as const,
  }));
  await sharp(baseImagePath).composite(composite).png().toFile(outputPath);
}

export async function generateContinuityDebugArtifacts(params: {
  sourceImagePath: string;
  artifactDir: string;
  masks: CompiledMaskResult;
}): Promise<ContinuityDebugArtifacts> {
  await fs.mkdir(params.artifactDir, { recursive: true });

  const occupancyRaw = await sharp(params.masks.occupancyMaskBuffer).raw().toBuffer();
  const exclusionRaw = await sharp(params.masks.exclusionMaskBuffer).raw().toBuffer();
  const finalRaw = await sharp(params.masks.finalMaskBuffer).raw().toBuffer();
  const width = params.masks.width;
  const height = params.masks.height;

  const occupancyOverlayPath = path.join(params.artifactDir, "occupancy-overlay.png");
  const exclusionOverlayPath = path.join(params.artifactDir, "exclusion-overlay.png");
  const finalMaskOverlayPath = path.join(params.artifactDir, "final-mask-overlay.png");
  const renderBoundaryPreviewPath = path.join(params.artifactDir, "render-boundary-preview.png");
  const insertionRegionPreviewPath = path.join(params.artifactDir, "insertion-region-preview.png");

  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(occupancyRaw, width, height, { red: 255, green: 136, blue: 64, alpha: 110 })],
    width,
    height,
    occupancyOverlayPath,
  );
  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(exclusionRaw, width, height, { red: 64, green: 156, blue: 255, alpha: 96 })],
    width,
    height,
    exclusionOverlayPath,
  );
  await writeComposite(
    params.sourceImagePath,
    [maskToOverlay(finalRaw, width, height, { red: 72, green: 210, blue: 118, alpha: 108 })],
    width,
    height,
    finalMaskOverlayPath,
  );

  const renderBoundaryOverlay = Buffer.alloc(width * height * 4);
  const boundaryMask = buildBoundaryMask(finalRaw, width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (finalRaw[index] > 0) {
      renderBoundaryOverlay[offset] = 72;
      renderBoundaryOverlay[offset + 1] = 210;
      renderBoundaryOverlay[offset + 2] = 118;
      renderBoundaryOverlay[offset + 3] = 104;
    } else {
      renderBoundaryOverlay[offset] = 0;
      renderBoundaryOverlay[offset + 1] = 0;
      renderBoundaryOverlay[offset + 2] = 0;
      renderBoundaryOverlay[offset + 3] = 78;
    }
    if (boundaryMask[index] > 0) {
      renderBoundaryOverlay[offset] = 255;
      renderBoundaryOverlay[offset + 1] = 84;
      renderBoundaryOverlay[offset + 2] = 84;
      renderBoundaryOverlay[offset + 3] = 220;
    }
  }
  await writeComposite(
    params.sourceImagePath,
    [renderBoundaryOverlay],
    width,
    height,
    renderBoundaryPreviewPath,
  );

  const bounds = params.masks.insertionBounds;
  if (bounds) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="rgba(72,210,118,0.16)" stroke="rgba(255,84,84,0.92)" stroke-width="3" />
      </svg>
    `;
    await sharp(params.sourceImagePath)
      .composite([{ input: Buffer.from(svg), blend: "over" }])
      .png()
      .toFile(insertionRegionPreviewPath);
  } else {
    await sharp(params.sourceImagePath).png().toFile(insertionRegionPreviewPath);
  }

  return {
    occupancyOverlayPath,
    exclusionOverlayPath,
    finalMaskOverlayPath,
    renderBoundaryPreviewPath,
    insertionRegionPreviewPath,
  };
}