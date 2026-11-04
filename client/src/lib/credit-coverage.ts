// How far a number of credits goes through a batch, photo by photo in batch
// order (each photo's own quote: 1 credit, or 2 for a staged room when that
// switch is on). Used by the "not enough credits" pop-up.
export function photosCoveredBy(perPhotoCredits: number[], credits: number): { count: number; credits: number } {
  let left = Math.max(0, Number(credits) || 0);
  let count = 0;
  let used = 0;
  for (const raw of perPhotoCredits) {
    const c = Math.max(1, Number(raw) || 1);
    if (c > left) break;
    left -= c;
    used += c;
    count += 1;
  }
  return { count, credits: used };
}

export function creditCoverageFor(perPhotoCredits: number[], available: number, packCredits: number) {
  const now = photosCoveredBy(perPhotoCredits, available);
  return {
    total: perPhotoCredits.length,
    nowCount: now.count,
    nowCredits: now.credits,
    withPackCount: photosCoveredBy(perPhotoCredits, Math.max(0, available) + packCredits).count,
  };
}
