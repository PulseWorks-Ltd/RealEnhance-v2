export function shouldGateOpeningsDelta(delta: number, minDelta: number): boolean {
  const normalized = Math.max(0, Math.floor(delta));
  return normalized >= Math.max(1, minDelta);
}