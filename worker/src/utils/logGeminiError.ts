export function logGeminiError(context: string, err: any) {
  const msg = err?.message || String(err);
  const code = (err as any)?.status || (err as any)?.statusCode || (err as any)?.code;
  const details = (err as any)?.response || (err as any)?.error || undefined;
  console.warn(`[GEMINI][${context}] ${code || ''} ${msg}`);
  if (details) {
    try {
      console.warn(`[GEMINI][${context}] details:`, JSON.stringify(details, Object.getOwnPropertyNames(details)));
    } catch {
      console.warn(`[GEMINI][${context}] details:`, details);
    }
  }
}
