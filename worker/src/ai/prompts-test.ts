// worker/src/ai/prompts-test.ts
// Concise test prompts with embedded temperature per stage and scene.

export type TestScene = "interior" | "exterior" | "auto";
export type TestStage = "1A" | "1B" | "2";

function resolveScene(scene?: TestScene): "interior" | "exterior" {
  if (scene === "interior" || scene === "exterior") return scene;
  return "interior"; // default for safety
}

function formatTemp(t: number): string {
  return Number(t.toFixed(3)).toString();
}

export function getEmbeddedTemp(stage: TestStage, scene?: TestScene): number {
  const s = resolveScene(scene);
  if (stage === "2") {
    return s === "interior" ? 0.10 : 0.08;
  }
  if (stage === "1B") {
    // Declutter + enhance; interior/exterior supported
    return s === "interior" ? 0.35 : 0.28;
  }
  // 1A enhance-only
  return s === "interior" ? 0.30 : 0.20;
}

export function tightenPromptAndLowerTemp(prompt: string, factor = 0.8): string {
  // Reduce embedded temp by factor if a line like "Temperature: X" exists; else inject one at top with 0.1
  const lines = prompt.split(/\r?\n/);
  let foundIdx = lines.findIndex(l => /^\s*temperature\s*:/i.test(l));
  if (foundIdx !== -1) {
    const m = lines[foundIdx].match(/(:)\s*([0-9]*\.?[0-9]+)/);
    if (m) {
      const current = parseFloat(m[2]);
      const next = Math.max(0.05, current * factor);
      lines[foundIdx] = lines[foundIdx].replace(/(:)\s*([0-9]*\.?[0-9]+)/, `$1 ${formatTemp(next)}`);
    }
  } else {
    lines.unshift(`Temperature: 0.10`);
  }
  // Add an extra STRICT block to emphasize constraints
  lines.push(
    "",
    "STRICT MODE (VALIDATION FAILED):",
    "- Follow rules precisely; prioritize safety over creativity.",
    "- Do NOT alter architecture or camera; keep windows/doors fully visible.",
    "- If unsure, omit conflicting items rather than breaking rules."
  );
  return lines.join("\n");
}

// ----- Stage 2: Interior furniture staging (user-provided style) -----
function formatRoomLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = String(raw)
    .replace(/[-_]+/g, " ")
    .replace(/\b(\d+)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
  const map: Record<string, string> = {
    "living room": "living room",
    "lounge": "living room",
    "dining": "dining room",
    "dining room": "dining room",
    "bedroom": "bedroom",
    "bedroom 1": "bedroom",
    "bedroom 2": "bedroom",
    "bedroom 3": "bedroom",
    "office": "office",
    "study": "office",
    "kitchen": "kitchen",
    "bathroom": "bathroom",
    "laundry": "laundry",
    "balcony": "balcony",
    "patio": "patio",
    "deck": "deck",
    "garden": "garden",
    "garage": "garage"
  };
  const normalized = map[cleaned] || cleaned;
  return normalized;
}

export function buildTestStage2Prompt(scene: TestScene, roomType?: string): string {
  const s = resolveScene(scene);
  const t = getEmbeddedTemp("2", s);
  const roomLabel = s === "interior" ? (formatRoomLabel(roomType) || "room") : undefined;

  const interiorPrompt = [
    `Temperature: ${formatTemp(t)}`,
    `Stage this ${roomLabel} with appropriate furniture.`,
    "Keep all furniture to scale and don't cover or alter windows or their positions.",
    "Do not obstruct doors / windows or cupboards.",
    "Do not place any art if there is a window on that wall.",
    "Do not alter the architecture, colours or materials of the room.",
    "You are only allowed to add furniture.",
    "If furniture is placed in front of a window, then just cover the bottom portion of the window with the headboard, do not remove the window or change its size.",
    "You cannot add any non-movable furniture or appliances to the room.",
    "Do not invent, create or add any space or features to the room, keep the room exactly as it is in the image.",
    "Do not change walls or doors or add or remove anything from the walls or doors.",
  ];

  const exteriorPrompt = [
    `Temperature: ${formatTemp(t)}`,
    "Exterior staging: Only stage on existing hard surfaces clearly separated from grass/driveways/vehicles.",
    "Never place items on grass or same-level areas near vehicles. Never build decks or new surfaces.",
    "When uncertain if an area is suitable, skip furniture and use at most 1-3 pot plants on hard surfaces only.",
    "Do not alter structures, colors, or materials. Add staging items only.",
  ];

  const roomHint = roomLabel ? [`Room type: ${roomLabel}`] : [];
  const lines = s === "interior" ? interiorPrompt : exteriorPrompt;
  return [...roomHint, ...lines].join("\n");
}

// ----- Stage 1A: Enhance-only (concise, directive) -----
export function buildTestStage1APrompt(scene: TestScene, opts?: { replaceSky?: boolean }): string {
  const s = resolveScene(scene);
  const t = getEmbeddedTemp("1A", s);
  const lines: string[] = [
    `Temperature: ${formatTemp(t)}`,
    s === "exterior"
      ? "Enhance exterior quality. Replace gray/overcast sky with blue sky and soft white clouds. Boost grass health gently. Remove debris (bins, hoses, toys)."
      : "Enhance interior quality. Balance exposure and color, increase clarity, subtle sharpening, reduce noise.",
    "Do not change architecture, camera angle, or field-of-view.",
  ];
  if (s === "exterior" && opts?.replaceSky === false) {
    // Explicitly note no sky replacement if disabled
    lines[1] = "Enhance exterior quality. Boost clarity and color. Remove debris.";
  }
  return lines.join("\n");
}

// ----- Stage 1B: Enhance + Declutter (single-pass) -----
export function buildTestStage1BPrompt(scene: TestScene): string {
  const s = resolveScene(scene);
  const t = getEmbeddedTemp("1B", s);
  return [
    `Temperature: ${formatTemp(t)}`,
    s === "exterior"
      ? "Enhance and declutter exterior. Remove debris and temporary items completely. Preserve structures and surfaces; do not build or add new surfaces."
      : "Enhance and declutter interior. Remove obvious clutter and small decor. Preserve architecture and built-ins.",
    "Keep camera, walls, doors, and windows unchanged."
  ].join("\n");
}
