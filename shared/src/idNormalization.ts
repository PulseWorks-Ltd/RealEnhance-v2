const RAW_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIXED_UUID_PATTERN = /^([a-z][a-z0-9-]*)_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export type DbUuidNormalizationKind =
  | "empty"
  | "raw_uuid"
  | "prefixed_public_id"
  | "invalid";

export interface DbUuidNormalizationResult {
  original: string | null;
  normalized: string | null;
  kind: DbUuidNormalizationKind;
  prefix: string | null;
}

export function isRawUuid(value: string | null | undefined): boolean {
  return RAW_UUID_PATTERN.test(String(value || "").trim());
}

export function normalizeDbUuid(
  value: string | null | undefined,
  options?: { allowedPrefixes?: string[] }
): DbUuidNormalizationResult {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return {
      original: null,
      normalized: null,
      kind: "empty",
      prefix: null,
    };
  }

  if (RAW_UUID_PATTERN.test(trimmed)) {
    return {
      original: trimmed,
      normalized: trimmed,
      kind: "raw_uuid",
      prefix: null,
    };
  }

  const prefixedMatch = trimmed.match(PREFIXED_UUID_PATTERN);
  if (prefixedMatch) {
    const prefix = String(prefixedMatch[1] || "").toLowerCase();
    const normalizedUuid = String(prefixedMatch[2] || "").toLowerCase();
    const allowedPrefixes = Array.isArray(options?.allowedPrefixes)
      ? options!.allowedPrefixes.map((entry) => String(entry || "").toLowerCase())
      : [];

    if (allowedPrefixes.includes(prefix)) {
      return {
        original: trimmed,
        normalized: normalizedUuid,
        kind: "prefixed_public_id",
        prefix,
      };
    }
  }

  return {
    original: trimmed,
    normalized: null,
    kind: "invalid",
    prefix: prefixedMatch ? String(prefixedMatch[1] || "").toLowerCase() : null,
  };
}