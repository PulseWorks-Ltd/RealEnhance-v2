import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";

type BasicAnswers = {
  subject: "People" | "Property" | "Product" | "Vehicle" | "Food" | "Artwork" | "Other" | "Not sure";
  background: "Keep" | "Clean/Studio" | "Blur" | "Remove" | "Replace" | "Not sure";
  aspect: "Original" | "Square" | "4:5" | "16:9" | "3:2" | "Not sure";
};

type AdvancedAnswers = Partial<{
  colorTone: "Neutral" | "Warm" | "Cool" | "High-contrast" | "Not sure";
  sharpness: "Natural" | "Crisp" | "Soft" | "Not sure";
  outputSize: "Web-small" | "Web-large" | "Print" | "Not sure";
  notes: string;
}>;

export default function SmartIntake({
  onPromptReady,
  context,
  detectedRoomType = undefined,
}: {
  onPromptReady: (prompt: string) => void;
  context?: Record<string, any>;
  detectedRoomType?: string;
}) {
  // 1) Minimal, required
  const [goal, setGoal] = useState(() => localStorage.getItem("pmp_goal") || "");
  const [showSpecificDetail, setShowSpecificDetail] = useState(() => {
    const stored = localStorage.getItem("pmp_goal") || "";
    return stored.trim().length > 0;
  });

  // 2) Three quick selectors with "Not sure"
  const [basic, setBasic] = useState<BasicAnswers>(() => {
    try {
      return JSON.parse(localStorage.getItem("pmp_basic") || "") as BasicAnswers;
    } catch { /* noop */ }
    return { subject: "Not sure", background: "Not sure", aspect: "Not sure" };
  });

  // 3) Optional advanced
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adv, setAdv] = useState<AdvancedAnswers>(() => {
    try { return JSON.parse(localStorage.getItem("pmp_adv") || "{}"); } catch { return {}; }
  });

  // persist
  useEffect(() => { const id=setTimeout(()=>localStorage.setItem("pmp_goal", goal), 200); return ()=>clearTimeout(id); }, [goal]);
  useEffect(() => { const id=setTimeout(()=>localStorage.setItem("pmp_basic", JSON.stringify(basic)), 200); return ()=>clearTimeout(id); }, [basic]);
  useEffect(() => { const id=setTimeout(()=>localStorage.setItem("pmp_adv", JSON.stringify(adv)), 200); return ()=>clearTimeout(id); }, [adv]);

  // Room type override state
  const [roomTypeOverride, setRoomTypeOverride] = useState<string>(detectedRoomType || "auto");

  // Compose locally (fast) so user sees what will be sent
  const composed = useMemo(() => {
    const lines: string[] = [];
    const t = (v: string) => (v && v !== "Not sure" ? v : null);

    lines.push("You are a professional photo editor. Make realistic edits without plastic skin or uncanny artifacts.");
    if (goal.trim()) lines.push(`User goal: ${goal.trim()}`);

    const subject = t(basic.subject);
    const bg = t(basic.background);
    const aspect = t(basic.aspect);

    if (subject) lines.push(`Primary subject: ${subject}.`);
    if (bg) lines.push(`Background: ${bg}.`);
    if (aspect && aspect !== "Original") lines.push(`Preferred aspect ratio: ${aspect}.`);

    const colorTone = t(adv.colorTone || "");
    const sharpness = t(adv.sharpness || "");
    const outputSize = t(adv.outputSize || "");
    if (colorTone) lines.push(`Color tone: ${colorTone}.`);
    if (sharpness) lines.push(`Sharpness: ${sharpness}.`);
    if (outputSize) lines.push(`Output size: ${outputSize}.`);
    if ((adv.notes || "").trim()) lines.push(`Notes: ${adv.notes!.trim()}`);

    // Room type
    if (roomTypeOverride && roomTypeOverride !== "auto") {
      lines.push(`Room type: ${roomTypeOverride}.`);
    } else if (detectedRoomType && detectedRoomType !== "auto") {
      lines.push(`Room type: ${detectedRoomType}.`);
    }

    // Contextual hints from preset/category if provided
    if (context?.presetKey) lines.push(`Preset: ${context.presetKey}.`);
    if (context?.imageCategory) lines.push(`Image category: ${context.imageCategory}.`);

    // Safety & quality floor
    lines.push("Preserve identity/structure. Avoid adding text overlays. Ensure natural colors and lighting.");

    return lines.join("\n");
  }, [goal, basic, adv, context, roomTypeOverride, detectedRoomType]);

  return (
    <section className="space-y-3">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={showSpecificDetail}
            onChange={(e) => {
              setShowSpecificDetail(e.target.checked);
              if (!e.target.checked) {
                setGoal("");
              }
            }}
            className="w-4 h-4"
            data-testid="checkbox-add-detail"
          />
          Add specific detail
        </label>
        
        {showSpecificDetail && (
          <div className="space-y-1">
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="E.g., remove the timber handrail blocking the scaffold view"
              rows={3}
              data-testid="input-goal"
            />
            <p className="text-xs text-muted-foreground">One sentence is enough. You can be brief.</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Room Type</label>
          <Select
            value={roomTypeOverride}
            onValueChange={setRoomTypeOverride}
          >
            <SelectTrigger data-testid="select-room-type"><SelectValue placeholder={detectedRoomType || "Auto Detect"} /></SelectTrigger>
            <SelectContent className="bg-black border-gray-700" side="bottom" align="start" sideOffset={8} avoidCollisions={false}>
              <SelectItem value="auto">Auto Detect{detectedRoomType ? ` (${detectedRoomType})` : ""}</SelectItem>
              <SelectItem value="bedroom-1">Bedroom 1</SelectItem>
              <SelectItem value="bedroom-2">Bedroom 2</SelectItem>
              <SelectItem value="bedroom-3">Bedroom 3</SelectItem>
              <SelectItem value="bedroom-4">Bedroom 4</SelectItem>
              <SelectItem value="kitchen">Kitchen</SelectItem>
              <SelectItem value="living-room">Living Room</SelectItem>
              <SelectItem value="multiple-living-areas">Multiple Living Areas</SelectItem>
              <SelectItem value="dining-room">Dining Room</SelectItem>
              <SelectItem value="study">Study</SelectItem>
              <SelectItem value="office">Office</SelectItem>
              <SelectItem value="bathroom-1">Bathroom 1</SelectItem>
              <SelectItem value="bathroom-2">Bathroom 2</SelectItem>
              <SelectItem value="laundry">Laundry</SelectItem>
              <SelectItem value="garage">Garage</SelectItem>
              <SelectItem value="basement">Basement</SelectItem>
              <SelectItem value="attic">Attic</SelectItem>
              <SelectItem value="hallway">Hallway</SelectItem>
              <SelectItem value="staircase">Staircase</SelectItem>
              <SelectItem value="entryway">Entryway</SelectItem>
              <SelectItem value="closet">Closet</SelectItem>
              <SelectItem value="pantry">Pantry</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Auto-detected: <span className="font-semibold">{detectedRoomType || "Unknown"}</span>. You can override if needed.</p>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Subject</label>
          <Select
            value={basic.subject}
            onValueChange={(v) => setBasic((b) => ({ ...b, subject: v as any }))}
          >
            <SelectTrigger data-testid="select-subject"><SelectValue placeholder="Not sure" /></SelectTrigger>
            <SelectContent className="bg-black border-gray-700">
              {["People","Property","Product","Vehicle","Food","Artwork","Other","Not sure"].map(o=>(
                <SelectItem key={o} value={o as any}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Background</label>
          <Select
            value={basic.background}
            onValueChange={(v) => setBasic((b) => ({ ...b, background: v as any }))}
          >
            <SelectTrigger data-testid="select-background"><SelectValue placeholder="Not sure" /></SelectTrigger>
            <SelectContent className="bg-black border-gray-700">
              {["Keep","Clean/Studio","Blur","Remove","Replace","Not sure"].map(o=>(
                <SelectItem key={o} value={o as any}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Aspect</label>
          <Select
            value={basic.aspect}
            onValueChange={(v) => setBasic((b) => ({ ...b, aspect: v as any }))}
          >
            <SelectTrigger data-testid="select-aspect"><SelectValue placeholder="Original" /></SelectTrigger>
            <SelectContent className="bg-black border-gray-700">
              {["Original","Square","4:5","16:9","3:2","Not sure"].map(o=>(
                <SelectItem key={o} value={o as any}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <button
        type="button"
        className="flex items-center gap-2 text-sm text-primary"
        onClick={() => setShowAdvanced(s => !s)}
        data-testid="button-toggle-advanced"
      >
        {showAdvanced ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
        {showAdvanced ? "Hide advanced settings" : "Advanced settings (optional)"}
      </button>

      {showAdvanced && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Color tone</label>
            <Select value={adv.colorTone || "Not sure"} onValueChange={(v)=>setAdv(a=>({...a, colorTone: v as any}))}>
              <SelectTrigger data-testid="select-color-tone"><SelectValue placeholder="Not sure" /></SelectTrigger>
              <SelectContent className="bg-black border-gray-700">
                {["Neutral","Warm","Cool","High-contrast","Not sure"].map(o=>(
                  <SelectItem key={o} value={o as any}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Sharpness</label>
            <Select value={adv.sharpness || "Not sure"} onValueChange={(v)=>setAdv(a=>({...a, sharpness: v as any}))}>
              <SelectTrigger data-testid="select-sharpness"><SelectValue placeholder="Not sure" /></SelectTrigger>
              <SelectContent className="bg-black border-gray-700">
                {["Natural","Crisp","Soft","Not sure"].map(o=>(
                  <SelectItem key={o} value={o as any}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Output size</label>
            <Select value={adv.outputSize || "Not sure"} onValueChange={(v)=>setAdv(a=>({...a, outputSize: v as any}))}>
              <SelectTrigger data-testid="select-output-size"><SelectValue placeholder="Not sure" /></SelectTrigger>
              <SelectContent className="bg-black border-gray-700">
                {["Web-small","Web-large","Print","Not sure"].map(o=>(
                  <SelectItem key={o} value={o as any}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Textarea
              value={adv.notes || ""}
              onChange={(e)=>setAdv(a=>({...a, notes: e.target.value}))}
              placeholder="Any extra specifics? (optional)"
              rows={2}
              data-testid="input-notes"
            />
          </div>
        </div>
      )}

      {/* Compose now button (no extra questions) */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles size={14}/> We'll assume sensible defaults for "Not sure".
        </span>
        <Button type="button" onClick={() => onPromptReady(composed)} data-testid="button-use-settings">Use these settings</Button>
      </div>
    </section>
  );
}