// The "Adjust | AI Edit" switch shared by the Adjust workspace and the
// AI Edit (RegionEditor) screen inside the single Edit modal.

import { SlidersHorizontal, Wand2 } from "lucide-react";

export type EditMode = "adjust" | "ai";

export function EditModeSwitch({ active, onSelect }: { active: EditMode; onSelect: (mode: EditMode) => void }) {
  const tab = (mode: EditMode, label: string, Icon: typeof Wand2) => {
    const selected = active === mode;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => !selected && onSelect(mode)}
        data-testid={`edit-mode-${mode}`}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
          selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5" role="tablist" aria-label="Edit mode">
      {tab("adjust", "Adjust", SlidersHorizontal)}
      {tab("ai", "AI Edit", Wand2)}
    </div>
  );
}
