// Small, purpose-built mask geometry helpers for the single-image
// mask-inpainting experiment. Ported from generic (non-continuity-coupled)
// pieces of feature/vertex-secondary-inpainting-continuity's maskCompiler.ts
// per VERTEX_INPAINTING_INVESTIGATION.md §4/§9 — deliberately NOT the full
// mask compiler (no master/secondary geometry, no projected furniture, no
// placement plans, no continuity anchors).

export function binarizeGrayscale(grayscaleRaw: Buffer, threshold = 128): Buffer {
  const out = Buffer.alloc(grayscaleRaw.length);
  for (let i = 0; i < grayscaleRaw.length; i += 1) {
    out[i] = (grayscaleRaw[i] ?? 0) >= threshold ? 255 : 0;
  }
  return out;
}

export function isBinaryMask(buffer: Buffer): boolean {
  for (const value of buffer) {
    if (value !== 0 && value !== 255) {
      return false;
    }
  }
  return true;
}

export function countWhitePixels(buffer: Buffer): number {
  let count = 0;
  for (const value of buffer) {
    if (value > 0) count += 1;
  }
  return count;
}

export function findMaskBoundingBox(
  buffer: Buffer,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (buffer[index] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// 4-connected flood fill, ported as-is (pure geometry, no continuity coupling).
export function countConnectedComponents(mask: Buffer, width: number): number {
  const visited = new Uint8Array(mask.length);
  let componentCount = 0;
  const offsets = [-1, 1, -width, width];

  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) === 0 || visited[index] === 1) continue;
    componentCount += 1;
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= mask.length || visited[next] === 1 || (mask[next] ?? 0) === 0) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return componentCount;
}

export function removeTinyConnectedComponents(mask: Buffer, width: number, minArea: number): Buffer {
  const filtered = Buffer.from(mask);
  const visited = new Uint8Array(mask.length);
  const offsets = [-1, 1, -width, width];

  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) === 0 || visited[index] === 1) continue;

    const component: number[] = [];
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= mask.length || visited[next] === 1 || (mask[next] ?? 0) === 0) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (component.length < minArea) {
      for (const pixelIndex of component) {
        filtered[pixelIndex] = 0;
      }
    }
  }
  return filtered;
}

// Removes isolated single-pixel/near-isolated specks without ever growing the
// mask (strict shrink-only invariant), ported from tinySemanticCleanup.
export function removeIsolatedSpecks(mask: Buffer, width: number, height: number): Buffer {
  const cleaned = Buffer.from(mask);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const active = (mask[index] ?? 0) > 0;
      if (!active) continue;
      let activeNeighborCount = 0;
      for (const [dx, dy] of neighbors) {
        const nIndex = (y + dy) * width + (x + dx);
        if ((mask[nIndex] ?? 0) > 0) activeNeighborCount += 1;
      }
      if (activeNeighborCount <= 1) {
        cleaned[index] = 0;
      }
    }
  }
  return cleaned;
}
