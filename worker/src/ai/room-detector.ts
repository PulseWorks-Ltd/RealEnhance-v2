import sharp from "sharp";
import fs from "fs";
import path from "path";

// Optional ONNX room-type detector with heuristic fallback
type ORT = any;
let ort: ORT | null = null;
let roomSession: any | null = null;

export type RoomLabel =
  | "kitchen"
  | "bathroom"
  | "bedroom"
  | "living_room"
  | "dining"
  | "office"
  | "exterior"
  | "other";

export async function detectRoomType(buf: Buffer): Promise<{ label: RoomLabel; confidence: number }> {
  const onnx = await classifyWithOnnx(buf);
  if (onnx) return onnx;
  return heuristic(buf);
}

async function loadOrt() {
  try {
    if (!ort) ort = await import("onnxruntime-node");
    return ort;
  } catch {
    return null;
  }
}

async function ensureRoomSession(): Promise<any | null> {
  if (roomSession) return roomSession;
  const modelPath = process.env.MODEL_ROOM_PATH || path.join(process.cwd(), "models", "room_mobilenet.onnx");
  if (!fs.existsSync(modelPath)) return null;
  const o = await loadOrt();
  if (!o) return null;
  try {
    roomSession = await o.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
    return roomSession;
  } catch {
    return null;
  }
}

async function classifyWithOnnx(buf: Buffer): Promise<{ label: RoomLabel; confidence: number } | null> {
  const sess = await ensureRoomSession();
  const o = await loadOrt();
  if (!sess || !o) return null;
  const raw = await sharp(buf).resize(224, 224).removeAlpha().raw().toBuffer();
  const f32 = Float32Array.from(raw, (v) => v / 255);
  const input = new o.Tensor("float32", f32, [1, 224, 224, 3]);
  const feeds: Record<string, any> = {};
  feeds[sess.inputNames?.[0] || "input"] = input;
  const out = await sess.run(feeds);
  const outName = sess.outputNames?.[0];
  const data: number[] = Array.from((out as any)[outName].data as Float32Array);
  const m = Math.max(...data);
  const exps = data.map(x => Math.exp(x - m));
  const sum = exps.reduce((a,b)=>a+b,0);
  const probs = exps.map(x => x/sum);
  const idx = probs.indexOf(Math.max(...probs));
  const labels: RoomLabel[] = ["kitchen", "bathroom", "bedroom", "living_room", "dining", "office", "exterior", "other"];
  const label = labels[idx] ?? "other";
  return { label, confidence: probs[idx] ?? 0.5 };
}

async function heuristic(buf: Buffer): Promise<{ label: RoomLabel; confidence: number }> {
  const stats = await sharp(buf).stats();
  const sat = ((stats.channels[0]?.stdev ?? 0) + (stats.channels[1]?.stdev ?? 0) + (stats.channels[2]?.stdev ?? 0)) / 3;
  if (sat < 20) return { label: "bathroom", confidence: 0.6 };
  if (sat > 40) return { label: "living_room", confidence: 0.55 };
  return { label: "other", confidence: 0.5 };
}
