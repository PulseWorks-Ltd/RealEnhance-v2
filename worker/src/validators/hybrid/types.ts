// worker/src/validators/hybrid/types.ts
// Shared types for the hybrid validation provider interface.

export type ValidationType =
  | "FURNITURE_REMOVED"
  | "STRUCTURAL_CONSISTENCY"
  | "STAGING_OBJECTS_PRESENT";

export interface ValidationRequest {
  originalB64: string;
  editedB64: string;
  mimeType?: string; // default "image/webp"
  validationType?: ValidationType;
}

export interface ValidationVerdict {
  pass: boolean;
  confidence: number; // 0.0–1.0
  reasons: string[]; // short bullets, can be empty
  provider: "stability" | "gemini";
  raw?: any; // optional debug info, behind VALIDATION_DEBUG flag
  latencyMs: number;
}

export interface ValidationProvider {
  name: "stability" | "gemini";
  validate(req: ValidationRequest): Promise<ValidationVerdict>;
}
