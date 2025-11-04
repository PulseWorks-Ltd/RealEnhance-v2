import sharp from "sharp";
import fs from "fs";
import path from "path";

// Optional ONNX support (dynamic import; falls back to heuristics if missing)
type ORT = any;
let ort: ORT | null = null;
let sceneSession: any | null = null;

async function loadOrt(): Promise<ORT | null> {
  try {
    if (!ort) ort = await import("onnxruntime-node");
    return ort;
  } catch {
    return null;
  }
}

async function ensureSceneSession(): Promise<any | null> {
  if (sceneSession) return sceneSession;
  const modelPath = process.env.MODEL_SCENE_PATH || path.join(process.cwd(), "models", "scene_mobilenet.onnx");
  if (!fs.existsSync(modelPath)) return null;
  const o = await loadOrt();
  if (!o) return null;
  sceneSession = await o.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
  return sceneSession;
}

export type ScenePrimary = "interior" | "exterior";

export interface ScenePrimaryResult {
  label: ScenePrimary;
  confidence: number; // 0..1
  skyPct?: number;
  grassPct?: number;
  woodDeckPct?: number;
}

async function onnxClassify(buf: Buffer): Promise<ScenePrimaryResult | null> {
  const sess = await ensureSceneSession();
  const o = await loadOrt();
  if (!sess || !o) return null;
  const raw = await sharp(buf).resize(224, 224).removeAlpha().raw().toBuffer();
  const f32 = Float32Array.from(raw, (v) => v / 255);
  const input = new o.Tensor("float32", f32, [1, 224, 224, 3]); // NHWC
  const feeds: Record<string, any> = {};
  feeds[sess.inputNames[0] || "input"] = input;
  const out = await sess.run(feeds);
  const outName = sess.outputNames[0];
  const data = Array.from((out as any)[outName].data as Float32Array);
  const softmax = (v: number[]) => {
    const m = Math.max(...v);
    const e = v.map((x) => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  };
  const probs = softmax(data);
  const idx = probs.indexOf(Math.max(...probs));
  const label: ScenePrimary = idx === 1 ? "exterior" : "interior"; // assume [interior, exterior]
  return { label, confidence: probs[idx] ?? 0.5 };
}

async function heuristic(buf: Buffer): Promise<ScenePrimaryResult> {
  const W = 224;
  const img = sharp(buf).resize({ width: W, fit: "inside" }).raw().ensureAlpha();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const H = info.height;
  const stride = info.channels; // 4
  let sky = 0, grass = 0, woodDeck = 0, total = 0;

  const toHSV = (r: number, g: number, b: number) => {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s, v };
  };

  const lowerBandStart = Math.floor(H * 0.6);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * stride;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, v } = toHSV(r, g, b);
      total++;
      if (v > 0.7 && s < 0.45 && h >= 190 && h <= 240) sky++;
      if (v > 0.35 && s > 0.35 && h >= 75 && h <= 150) grass++;
      if (y >= lowerBandStart && v > 0.25 && s > 0.15) {
        const isRedBrown = (h >= 10 && h <= 30) || (h >= 330 || h <= 5);
        if (isRedBrown) woodDeck++;
      }
    }
  }
  const skyPct = sky / total;
  const grassPct = grass / total;
  const woodDeckPct = woodDeck / (total * 0.4);
  const isExterior = skyPct >= 0.15 || grassPct >= 0.12 || woodDeckPct >= 0.2;
  const label: ScenePrimary = isExterior ? "exterior" : "interior";
  const signal = Math.max(skyPct, grassPct, woodDeckPct);
  const confidence = Math.max(0.55, Math.min(0.95, signal * 2));
  return { label, confidence, skyPct: Number(skyPct.toFixed(4)), grassPct: Number(grassPct.toFixed(4)), woodDeckPct: Number(woodDeckPct.toFixed(4)) };
}

export async function detectSceneFromImage(buf: Buffer): Promise<ScenePrimaryResult> {
  const onnx = await onnxClassify(buf);
  if (onnx) return onnx;
  return heuristic(buf);
}