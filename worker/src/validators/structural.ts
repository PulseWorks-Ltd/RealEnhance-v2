export async function validateStructure(
  originalPath: string,
  finalPath: string
): Promise<{ ok: boolean; notes?: string[] }> {
  // TODO: ensure no structural changes to property
  return { ok: true };
}
