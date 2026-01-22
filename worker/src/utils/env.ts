export function getEnvBoolean(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return defaultValue;
}
