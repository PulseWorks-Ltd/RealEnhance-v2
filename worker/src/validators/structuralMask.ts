import sharp from "sharp";

export interface StructuralMask {
  width: number;
  height: number;
  data: Uint8Array; // 1 for structural pixel, 0 otherwise
}

interface EdgeMaps {
  width: number;
  height: number;
  mag: Uint8Array; // gradient magnitude (0-255 approx scaled)
  edge: Uint8Array; // binary edge map
}

function sobelEdge(data: Uint8Array, width: number, height: number, threshold: number): EdgeMaps {
  const mag = new Uint8Array(data.length);
  const edge = new Uint8Array(data.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (
        data[i - width - 1] + 2 * data[i - 1] + data[i + width - 1] -
        data[i - width + 1] - 2 * data[i + 1] - data[i + width + 1]
      );
      const gy = (
        data[i - width - 1] + 2 * data[i - width] + data[i - width + 1] -
        data[i + width - 1] - 2 * data[i + width] - data[i + width + 1]
      );
      const g = Math.sqrt(gx * gx + gy * gy);
      const gm = Math.min(255, Math.round(g));
      mag[i] = gm;
      if (gm > threshold) edge[i] = 1;
    }
  }
  return { width, height, mag, edge };
}

function buildStructuralMask(edge: Uint8Array, width: number, height: number): StructuralMask {
  const out = new Uint8Array(edge.length);

  // Heuristic: mark pixels that are part of long horizontal or vertical runs
  const MIN_RUN = Math.max(20, Math.floor(width * 0.02));

  // Horizontal runs
  for (let y = 1; y < height - 1; y++) {
    let runStart = -1;
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (edge[i]) {
        if (runStart === -1) runStart = x;
      } else if (runStart !== -1) {
        const runLen = x - runStart;
        if (runLen >= MIN_RUN) {
          for (let rx = runStart; rx < x; rx++) out[y * width + rx] = 1;
        }
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      const runLen = width - runStart - 1;
      if (runLen >= MIN_RUN) {
        for (let rx = runStart; rx < width - 1; rx++) out[y * width + rx] = 1;
      }
    }
  }

  // Vertical runs
  for (let x = 1; x < width - 1; x++) {
    let runStart = -1;
    for (let y = 1; y < height - 1; y++) {
      const i = y * width + x;
      if (edge[i]) {
        if (runStart === -1) runStart = y;
      } else if (runStart !== -1) {
        const runLen = y - runStart;
        if (runLen >= MIN_RUN) {
          for (let ry = runStart; ry < y; ry++) out[ry * width + x] = 1;
        }
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      const runLen = height - runStart - 1;
      if (runLen >= MIN_RUN) {
        for (let ry = runStart; ry < height - 1; ry++) out[ry * width + x] = 1;
      }
    }
  }

  // Mild dilation to strengthen continuity
  const dilated = new Uint8Array(out.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (out[(y + dy) * width + (x + dx)]) { on = 1; break; }
        }
        if (on) break;
      }
      if (on) dilated[y * width + x] = 1;
    }
  }
  return { width, height, data: dilated };
}

export async function computeStructuralEdgeMask(imagePath: string): Promise<StructuralMask> {
  const preBlur = Number(process.env.STAGE2_STRUCT_PREBLUR || 0.6);
  const edgeThr = Number(process.env.STAGE2_STRUCT_EDGE_THRESHOLD || 38);
  const raw = await sharp(imagePath).greyscale().blur(preBlur).raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const { width, height } = raw.info;
  const maps = sobelEdge(buf, width, height, edgeThr);
  return buildStructuralMask(maps.edge, width, height);
}
