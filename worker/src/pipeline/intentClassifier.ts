export type EditIntent =
  | "trim_landscaping"
  | "clean_surface"
  | "declutter"
  | "repair_surface"
  | "generic";

const STRUCTURAL_PATTERNS = [
  "remove wall",
  "add wall",
  "move wall",
  "add window",
  "remove window",
  "move door",
  "change layout",
];

export function classifyEditIntent(input: string): EditIntent {
  const text = String(input || "").toLowerCase();

  if (text.includes("grass") || text.includes("trim") || text.includes("lawn")) {
    return "trim_landscaping";
  }

  if (text.includes("clean") || text.includes("wash") || text.includes("dirty")) {
    return "clean_surface";
  }

  if (text.includes("remove") || text.includes("clutter") || text.includes("mess")) {
    return "declutter";
  }

  if (text.includes("repair") || text.includes("fix") || text.includes("paint")) {
    return "repair_surface";
  }

  return "generic";
}

export function isStructuralEdit(input: string): boolean {
  const text = String(input || "").toLowerCase();
  return STRUCTURAL_PATTERNS.some((pattern) => text.includes(pattern));
}