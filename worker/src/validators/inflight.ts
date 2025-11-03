// server/locks/inflight.ts
const inflight = new Set<string>();

export const acquire = (key: string): boolean => {
  if (inflight.has(key)) {
    return false;
  }
  inflight.add(key);
  return true;
};

export const release = (key: string): void => {
  inflight.delete(key);
};