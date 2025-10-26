export async function validateRealism(
  finalPath: string
): Promise<{ ok: boolean; notes?: string[] }> {
  // TODO: ensure furniture scale / lighting looks realistic
  return { ok: true };
}
