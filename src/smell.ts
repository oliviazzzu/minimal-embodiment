import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

interface NNLayer {
  weight: number[][];
  bias: number[];
}

interface NNModel {
  classes: string[];
  feature_names: string[];
  scaler: { mean: number[]; std: number[] };
  layers: NNLayer[];
}

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

const model: NNModel = JSON.parse(
  readFileSync(join(__dirname_esm, "..", "olfaction", "models", "nn_3class_v0.2.json"), "utf-8"),
);

export interface SmellResult {
  label: string;
  displayLabel: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function forward(features: number[]): number[] {
  let x = features.map(
    (v, i) => (v - model.scaler.mean[i]) / model.scaler.std[i],
  );
  for (let li = 0; li < model.layers.length; li++) {
    const { weight, bias } = model.layers[li];
    const out = new Array(bias.length);
    for (let j = 0; j < bias.length; j++) {
      let sum = bias[j];
      for (let k = 0; k < x.length; k++) sum += weight[j][k] * x[k];
      out[j] = sum;
    }
    if (li < model.layers.length - 1) {
      for (let j = 0; j < out.length; j++) if (out[j] < 0) out[j] = 0;
    }
    x = out;
  }
  return x;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

const UNKNOWN_THRESHOLD = 0.5;

export function classifyFeatures(features: number[]): SmellResult {
  const logits = forward(features);
  const probs = softmax(logits);
  let maxIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[maxIdx]) maxIdx = i;
  }
  const DISPLAY: Record<string, string> = {
    fresh_plant: "fresh_plant (lemon / orange / mint)",
    unknown: "unknown",
  };
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < model.classes.length; i++) {
    const key = DISPLAY[model.classes[i]] ?? model.classes[i];
    probabilities[key] = Math.round(probs[i] * 1000) / 1000;
  }
  const confident = probs[maxIdx] >= UNKNOWN_THRESHOLD;
  const label = confident ? model.classes[maxIdx] : "unknown";
  return {
    label,
    displayLabel: DISPLAY[label] ?? label,
    confidence: Math.round(probs[maxIdx] * 1000) / 1000,
    probabilities,
  };
}

interface SensorRow {
  gas_kohms: number;
  humidity_pct: number;
  temperature_c: number;
}

export class SmellBuffer {
  private rows: SensorRow[] = [];
  // One row arrives per 10 s firmware post. The training pipeline was
  // re-parameterised to the same cadence (dedup rerun, 2026-08-19):
  // 5-minute baseline reference + 10-minute exposure window.
  private static readonly BASELINE_REF = 30;
  private static readonly EXPOSURE_LEN = 60;
  private static readonly BUFFER_MAX = 90;

  push(row: SensorRow): void {
    this.rows.push(row);
    if (this.rows.length > SmellBuffer.BUFFER_MAX) {
      this.rows.shift();
    }
  }

  get ready(): boolean {
    return this.rows.length >= SmellBuffer.BUFFER_MAX;
  }

  get windowSize(): number {
    return this.rows.length;
  }

  classify(): SmellResult | null {
    if (!this.ready) return null;

    const baseline = this.rows.slice(0, SmellBuffer.BASELINE_REF);
    const exposure = this.rows.slice(SmellBuffer.BASELINE_REF);

    const g0 = mean(baseline.map((r) => r.gas_kohms));
    const h0 = mean(baseline.map((r) => r.humidity_pct));
    const t0 = mean(baseline.map((r) => r.temperature_c));

    const gasValues = exposure.map((r) => r.gas_kohms);
    const gasMin = Math.min(...gasValues);
    const gasTroughD = gasMin - g0;
    const gasMeanD = mean(gasValues) - g0;

    const gasTroughPct = g0 > 0 ? ((gasMin - g0) / g0) * 100 : 0;

    const head = gasValues.slice(0, 15);
    const gasSlope =
      head.length > 1 ? (head[head.length - 1] - head[0]) / (head.length - 1) : 0;

    const gasMean = mean(gasValues);
    const gasStd = Math.sqrt(
      mean(gasValues.map((v) => (v - gasMean) ** 2)),
    );

    const features = [
      gasTroughD,
      gasMeanD,
      Math.max(...exposure.map((r) => r.humidity_pct)) - h0,
      mean(exposure.map((r) => r.humidity_pct)) - h0,
      mean(exposure.map((r) => r.temperature_c)) - t0,
      gasTroughPct,
      gasSlope,
      gasStd,
    ];

    return classifyFeatures(features);
  }

  reset(): void {
    this.rows = [];
  }
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
