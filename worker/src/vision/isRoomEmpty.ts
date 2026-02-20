import sharp from "sharp";

type ComponentBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
};

function sobelMagnitude(gray: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const idx = (x: number, y: number) => y * width + x;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        -gray[idx(x - 1, y - 1)] + gray[idx(x + 1, y - 1)] +
        -2 * gray[idx(x - 1, y)] + 2 * gray[idx(x + 1, y)] +
        -gray[idx(x - 1, y + 1)] + gray[idx(x + 1, y + 1)];

      const gy =
        -gray[idx(x - 1, y - 1)] - 2 * gray[idx(x, y - 1)] - gray[idx(x + 1, y - 1)] +
        gray[idx(x - 1, y + 1)] + 2 * gray[idx(x, y + 1)] + gray[idx(x + 1, y + 1)];

      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      out[idx(x, y)] = mag;
    }
  }

  return out;
}

function thresholdBinary(input: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    out[index] = input[index] >= threshold ? 1 : 0;
  }
  return out;
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const idx = (x: number, y: number) => y * width + x;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let on = 0;
      for (let oy = -1; oy <= 1 && !on; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (mask[idx(x + ox, y + oy)]) {
            on = 1;
            break;
          }
        }
      }
      out[idx(x, y)] = on;
    }
  }
  return out;
}

function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const idx = (x: number, y: number) => y * width + x;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let on = 1;
      for (let oy = -1; oy <= 1 && on; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!mask[idx(x + ox, y + oy)]) {
            on = 0;
            break;
          }
        }
      }
      out[idx(x, y)] = on;
    }
  }
  return out;
}

function close(mask: Uint8Array, width: number, height: number): Uint8Array {
  return erode(dilate(mask, width, height), width, height);
}

function collectConnectedComponents(mask: Uint8Array, width: number, height: number): ComponentBounds[] {
  const visited = new Uint8Array(mask.length);
  const components: ComponentBounds[] = [];
  const idx = (x: number, y: number) => y * width + x;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y);
      if (!mask[start] || visited[start]) continue;

      const stack: Array<[number, number]> = [[x, y]];
      visited[start] = 1;

      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let area = 0;

      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        area += 1;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = cx + ox;
            const ny = cy + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const n = idx(nx, ny);
            if (!mask[n] || visited[n]) continue;
            visited[n] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      components.push({ minX, minY, maxX, maxY, area });
    }
  }

  return components;
}

export async function isRoomEmpty(imageBuffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(imageBuffer)
    .grayscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const frameArea = width * height;
  const bottomGate = Math.floor(height * 0.6);
  const minArea = frameArea * 0.03;
  const minHeight = height * 0.08;

  const edgeMag = sobelMagnitude(data, width, height);
  const edgeMask = thresholdBinary(edgeMag, 38);
  const closed = close(edgeMask, width, height);
  const components = collectConnectedComponents(closed, width, height);

  let groundedCount = 0;
  for (const component of components) {
    const bboxHeight = component.maxY - component.minY + 1;
    const bottom = component.maxY;

    if (component.area <= minArea) continue;
    if (bboxHeight <= minHeight) continue;
    if (bottom < bottomGate) continue;

    groundedCount += 1;
  }

  return groundedCount === 0;
}
