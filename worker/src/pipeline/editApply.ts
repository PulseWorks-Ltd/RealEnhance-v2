export async function applyEdit(params: {
  baseImagePath: string;
  mask: unknown;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  restoreFromPath?: string;
}): Promise<string> {
  // TODO:
  // - If mode === "Restore": take pixels from restoreFromPath for masked region.
  // - Else: inpaint / modify region per instruction.
  // Return new file path for edited image.
  return params.baseImagePath;
}
