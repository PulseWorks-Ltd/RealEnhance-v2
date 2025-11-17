import sharp from "sharp";

export async function checkSizeMatch(basePath: string, candidatePath: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    sharp(basePath).metadata(),
    sharp(candidatePath).metadata(),
  ]);
  return (a.width === b.width) && (a.height === b.height);
}
