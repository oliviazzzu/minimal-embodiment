#!/usr/bin/env node
/**
 * Bridge service for the minimal self-perceiving embodiment described in
 * the accompanying paper. A single Node.js process with no external runtime
 * dependencies. Implements the nine endpoints listed in Table 2 of the
 * paper.
 *
 * Auth: a bearer token, supplied either via `Authorization: Bearer <token>`
 * or `?token=<token>`. The query-string form is for LLM clients whose
 * tool-calling APIs do not support custom request headers. The token is
 * read from `US_BRIDGE_TOKEN` if set; otherwise a random 24-byte token is
 * generated at startup and printed to the console.
 *
 * Every write endpoint accepts both a POST (JSON body) and a GET (query
 * string) form — some LLM clients can only issue GET requests. The two
 * forms are semantically identical.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { SmellBuffer, SmellResult } from "./smell.js";

// Paths the bridge handles as API endpoints. Any other path returns 404.
const API_PATHS: ReadonlySet<string> = new Set([
  "/status",
  // Sensor body (input channel): the microcontroller pushes readings here.
  "/sensor/update",
  "/sensor/status",
  // Cache-bypass aliases of /sensor/status. Some browser-based LLM clients
  // cache by URL and ignore Cache-Control: no-store, so we give out
  // brand-new paths they have never seen — each alias resolves to the same
  // `handleSensorStatus()` body as /sensor/status.
  "/sensor/now",
  "/sensor/current",
  "/sensor/feel",
  "/sensor/here",
  "/sensor/room",
  // Output channels: an LLM client queues a command via /haptic, /face, or
  // /beep; the microcontroller consumes from the unified queue via
  // /command/poll. (See the PendingCommand section for why these three
  // share a single endpoint rather than each having their own.)
  "/haptic",
  "/face",
  "/beep",
  // Multi-note batch — single fetch queues N beep commands so a remote
  // LLM client (which may have multi-second latency per HTTP request) can
  // play a recognizable melody instead of N notes spread across a minute
  // of dead air.
  "/melody",
  "/command/poll",
  // The microcontroller reports back what the mic heard while the buzzer
  // was playing, piggybacked on the next /command/poll request. /beep/echo
  // returns the latest such snapshot (or 204 if there is none yet).
  "/beep/echo",
  // Same idea for haptic — the microcontroller reports back the MPU's peak
  // |a − g| during the haptic vibration, piggybacked on the next poll.
  "/haptic/echo",
  // Noise-floor measurement: same wide-band MPU sample as /haptic, but
  // WITHOUT firing the motor. Used to characterize the accelerometer noise
  // floor of the haptic-echo measurement system. Echo path is the existing
  // lastHapticEcho slot, with effect_id=0 denoting a baseline reading.
  "/haptic/baseline",
]);

// ---- sensor body state ---------------------------------------------------
//
// The microcontroller POSTs sensor readings to /sensor/update every few
// seconds. We hold only the latest reading in memory — no persistence, no
// history. `/sensor/status` returns it (auth required — environment
// readings are not public).

type SensorReading = {
  timestamp: string;
  environment?: {
    temperature_c?: number;
    humidity_pct?: number;
    pressure_hpa?: number;
    light_lux?: number;
    noise_db?: number;
    noise_env?: "quiet" | "moderate" | "noisy" | "loud";
    gas_resistance_kohms?: number; // BME688 only
  };
  motion?: {
    state?: "still" | "walking" | "running" | "unknown";
    step_count?: number;
  };
  biometric?: {
    heart_rate_bpm?: number;
    source?: string;
  };
  touch?: {
    fsr_raw?: number;     // FSR 402 peak ADC value within the post window
    detected?: boolean;   // fsr_raw above the firmware touch threshold
    skin_temp_c?: number; // NTC thermistor skin-contact temperature
  };
};

let latestSensorReading: SensorReading | null = null;

// ---------------------------------------------------------------------------
// Most recent touch. The firmware ships its latest completed touch on the
// next sensor post as &touch_event=<ms_since_ended>~<duration_ms>~<peak> —
// single slot, latest wins, same shape as the beep/haptic echoes. Served in
// /sensor/status and room snapshots as `recent_touch`; gone on restart.
// ---------------------------------------------------------------------------

type TouchEvent = {
  timestamp: string;    // estimated release moment (reconstructed on arrival)
  duration_ms: number;
  peak: number;         // max FSR ADC value (0-4095) during the touch
};

let lastTouch: TouchEvent | null = null;

function recordTouchEvent(tok: string): void {
  const m = /^(\d+)~(\d+)~(\d+)$/.exec(tok.trim());
  if (!m) return;
  lastTouch = {
    timestamp: new Date(Date.now() - parseInt(m[1], 10)).toISOString(),
    duration_ms: parseInt(m[2], 10),
    peak: parseInt(m[3], 10),
  };
}

function recentTouch(): {
  duration_ms: number;
  peak: number;
  age_seconds: number;
} | null {
  if (!lastTouch) return null;
  return {
    duration_ms: lastTouch.duration_ms,
    peak: lastTouch.peak,
    age_seconds: Math.round(
      (Date.now() - new Date(lastTouch.timestamp).getTime()) / 1000,
    ),
  };
}

// ---------------------------------------------------------------------------
// Olfactory classification — experimental prototype, off by default.
// Start the bridge with ENABLE_SMELL=1 (and a BME688 wired) to turn it on:
// each sensor post then contributes one row (gas, humidity, temperature)
// to a sliding window, and once the window is full the classifier in
// smell.ts runs on every update. The result rides in /sensor/status and
// room snapshots as `smell`; it is gone on restart and rebuilds as the
// window refills. Off, the field is absent entirely.
//
// Why opt-in: the bundled model was trained on controlled near-sensor
// exposures from a single BME688 — cross-device generalisation is
// unvalidated. See olfaction/model_card.md before relying on its labels.
// ---------------------------------------------------------------------------

const SMELL_ENABLED = process.env.ENABLE_SMELL === "1";
const smellBuffer = new SmellBuffer();

function currentSmell():
  | (SmellResult & { window_size: number })
  | { status: "collecting"; window_size: number } {
  return smellBuffer.ready
    ? { ...smellBuffer.classify()!, window_size: smellBuffer.windowSize }
    : { status: "collecting", window_size: smellBuffer.windowSize };
}

// Default 3737. Override with PORT=xxxx if needed.
const PORT = Number(process.env.PORT ?? 3737);
const AUTH_TOKEN = process.env.US_BRIDGE_TOKEN ?? randomBytes(24).toString("hex");

// ---- tiny helpers --------------------------------------------------------

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[bridge]", ...args);
}

// Walk common error shapes and fall back to a human-readable placeholder —
// never return an empty string, because an empty error body is more
// confusing than "unknown error (something-something)".
function formatError(err: unknown): string {
  const picked = pickErrorString(err);
  if (picked && picked.length > 0) return picked;
  // Last resort: describe the shape so the operator at least sees *something*.
  if (err === null) return "unknown error (null)";
  if (err === undefined) return "unknown error (undefined)";
  if (typeof err === "object") {
    const ctor = (err as object).constructor?.name ?? "object";
    return `unknown error (${ctor})`;
  }
  return `unknown error (${typeof err})`;
}

function pickErrorString(err: unknown): string | null {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "ErrorMessage", "reason"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    try {
      const json = JSON.stringify(obj);
      if (json && json !== "{}") return json;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Guard against runaway payloads — we only ever expect tiny JSON.
    if (total > 64 * 1024) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function getField(body: unknown, name: string): unknown {
  if (body && typeof body === "object") {
    return (body as Record<string, unknown>)[name];
  }
  return undefined;
}

function asNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${name} must be a number`);
  }
  return v;
}

function asIntInRange(
  v: unknown,
  name: string,
  min: number,
  max: number,
): number {
  const n = asNumber(v, name);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

function asPercent(v: unknown, name: string): number {
  const n = asNumber(v, name);
  if (n < 0 || n > 100) {
    throw new Error(`${name} must be in [0, 100]`);
  }
  return n;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function checkAuth(req: IncomingMessage, query: URLSearchParams): boolean {
  // Prefer the Authorization header (more standard, not logged).
  const header = req.headers["authorization"];
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && constantTimeEqual(match[1], AUTH_TOKEN)) return true;
  }
  // Fall back to ?token= query parameter, for clients that cannot set
  // custom request headers (e.g. some browser-based LLM tool-calling APIs).
  const qtoken = query.get("token");
  if (qtoken && constantTimeEqual(qtoken, AUTH_TOKEN)) return true;
  return false;
}

/**
 * Convert query-string values into the shapes `handleX` expects. String
 * fields stay as strings; values that look like numbers get parsed to
 * numbers so `asNumber`/`asPercent`/`asIntInRange` don't reject them.
 */
function queryToArgs(query: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of query) {
    if (k === "token") continue; // auth-only, not a payload field
    if (v === "") {
      out[k] = v;
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Strip the token from a URL so it doesn't land in the access log. */
function sanitizeUrlForLog(url: string): string {
  const qIndex = url.indexOf("?");
  if (qIndex < 0) return url;
  const base = url.slice(0, qIndex);
  const qs = new URLSearchParams(url.slice(qIndex + 1));
  if (qs.has("token")) qs.set("token", "<redacted>");
  const rebuilt = qs.toString();
  return rebuilt ? `${base}?${rebuilt}` : base;
}

// ---- route handlers ------------------------------------------------------

function handleStatus(): { ok: true; listening: true } {
  return { ok: true, listening: true };
}

// ---- sensor body handlers ------------------------------------------------
//
// The ESP32 builds a reading and pushes it here. We accept two shapes:
//   - Nested JSON (matches the architecture doc exactly) via POST body, OR
//   - Flat query-string keys via GET/POST args — these get folded into the
//     nested structure. The flat form keeps the Arduino code trivial:
//     a URL-encoded GET is ~10 lines of HTTPClient, no JSON library needed.
//
// All fields are optional. A microcontroller equipped with only a subset
// of the sensors should not have to synthesize zeros for the categories
// it cannot measure.

const NOISE_ENVS = ["quiet", "moderate", "noisy", "loud"] as const;
const MOTION_STATES = ["still", "walking", "running", "unknown"] as const;

function asOptionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : String(v);
}

function asOptionalEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | undefined {
  const s = asOptionalString(v);
  if (s === undefined) return undefined;
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/**
 * Build a SensorReading from either shape (flat or nested). Unknown fields
 * are ignored silently — we'd rather accept a partial reading than drop it.
 */
function buildReading(args: unknown): SensorReading {
  const a = (args ?? {}) as Record<string, unknown>;
  const envIn = (a.environment ?? {}) as Record<string, unknown>;
  const motIn = (a.motion ?? {}) as Record<string, unknown>;
  const bioIn = (a.biometric ?? {}) as Record<string, unknown>;

  // Pick from nested first, then fall back to flat key on the top-level args.
  const pick = (
    nested: Record<string, unknown>,
    key: string,
  ): unknown => (nested[key] !== undefined ? nested[key] : a[key]);

  const environment = {
    temperature_c: asOptionalNumber(pick(envIn, "temperature_c")),
    humidity_pct: asOptionalNumber(pick(envIn, "humidity_pct")),
    pressure_hpa: asOptionalNumber(pick(envIn, "pressure_hpa")),
    light_lux: asOptionalNumber(pick(envIn, "light_lux")),
    noise_db: asOptionalNumber(pick(envIn, "noise_db")),
    noise_env: asOptionalEnum(pick(envIn, "noise_env"), NOISE_ENVS),
    gas_resistance_kohms: asOptionalNumber(pick(envIn, "gas_resistance_kohms")),
  };

  const motion = {
    state: asOptionalEnum(pick(motIn, "state"), MOTION_STATES),
    step_count: asOptionalNumber(pick(motIn, "step_count")),
  };

  const biometric = {
    heart_rate_bpm: asOptionalNumber(pick(bioIn, "heart_rate_bpm")),
    source: asOptionalString(pick(bioIn, "source")),
  };

  // Only include categories that have at least one populated field.
  const reading: SensorReading = {
    timestamp: new Date().toISOString(),
  };
  if (Object.values(environment).some((v) => v !== undefined)) {
    reading.environment = environment;
  }
  if (Object.values(motion).some((v) => v !== undefined)) {
    reading.motion = motion;
  }
  if (Object.values(biometric).some((v) => v !== undefined)) {
    reading.biometric = biometric;
  }

  const fsrRaw = asOptionalNumber(a["fsr_raw"]);
  const skinTempC = asOptionalNumber(a["skin_temp_c"]);
  const touchDetectedRaw = a["touch_detected"];
  const touchDetected =
    touchDetectedRaw === true || touchDetectedRaw === "true"
      ? true
      : touchDetectedRaw === false || touchDetectedRaw === "false"
        ? false
        : undefined;
  if (fsrRaw !== undefined || touchDetected !== undefined || skinTempC !== undefined) {
    reading.touch = {
      ...(fsrRaw !== undefined && { fsr_raw: fsrRaw }),
      ...(touchDetected !== undefined && { detected: touchDetected }),
      ...(skinTempC !== undefined && { skin_temp_c: skinTempC }),
    };
  }
  return reading;
}

function handleSensorUpdate(args: unknown): {
  stored: boolean;
  reading: SensorReading;
  smell?: ReturnType<typeof currentSmell>;
} {
  const reading = buildReading(args);
  latestSensorReading = reading;
  const touchEventTok = asOptionalString(getField(args, "touch_event"));
  if (touchEventTok) recordTouchEvent(touchEventTok);
  const env = reading.environment;
  if (
    SMELL_ENABLED &&
    env?.gas_resistance_kohms != null &&
    env?.humidity_pct != null &&
    env?.temperature_c != null
  ) {
    smellBuffer.push({
      gas_kohms: env.gas_resistance_kohms,
      humidity_pct: env.humidity_pct,
      temperature_c: env.temperature_c,
    });
  }
  return {
    stored: true,
    reading,
    ...(SMELL_ENABLED && { smell: currentSmell() }),
  };
}

function handleSensorStatus(): {
  has_reading: boolean;
  reading: SensorReading | null;
  age_seconds: number | null;
  recent_beep_echo: (BeepEcho & { age_seconds: number }) | null;
  recent_touch: ReturnType<typeof recentTouch>;
  smell?: ReturnType<typeof currentSmell>;
  instance: string;
} {
  // Bundle the most recent beep echo too — same idea as currentRoom():
  // every "where am I" query sees both the input side (sensor reading) and
  // the output side (last tone played + what the mic heard of it).
  const echo = latestBeepEcho
    ? {
        ...latestBeepEcho,
        age_seconds: Math.round(
          (Date.now() - new Date(latestBeepEcho.timestamp).getTime()) / 1000,
        ),
      }
    : null;

  if (!latestSensorReading) {
    return {
      has_reading: false,
      reading: null,
      age_seconds: null,
      recent_beep_echo: echo,
      recent_touch: recentTouch(),
      ...(SMELL_ENABLED && { smell: currentSmell() }),
      instance: `${INSTANCE_ID}@${BOOT_TIME}`,
    };
  }
  const age = (Date.now() - new Date(latestSensorReading.timestamp).getTime()) / 1000;
  return {
    has_reading: true,
    reading: latestSensorReading,
    age_seconds: Math.round(age),
    recent_beep_echo: echo,
    recent_touch: recentTouch(),
    ...(SMELL_ENABLED && { smell: currentSmell() }),
    instance: `${INSTANCE_ID}@${BOOT_TIME}`,
  };
}

/**
 * Flat single-level snapshot of the room's current state, for embedding in
 * other responses (e.g. /haptic so the client sees the room state at the
 * moment it queued a tap). Returns null if no sensor reading has come in
 * yet. Undefined fields are dropped by JSON.stringify, so missing sensors
 * show up as absent keys.
 */
// Process identity, stamped into every room snapshot and /sensor/status
// response. If a stale bridge process is left serving traffic alongside a
// new one, each accumulates its own sensor history and endpoints can
// disagree about the recent past ("parallel universes"). Comparing the
// `instance` field across two responses settles it in one request:
// different values → find and kill the stale process; same value → suspect
// a cache or proxy layer in front of the bridge instead.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
const BOOT_TIME = new Date().toISOString();

function currentRoom(): object | null {
  // Build the room snapshot from whatever we have: the latest sensor reading
  // (input side of the channel — environment + motion + biometric) AND the
  // most recent self-perception echoes (output side — what the mic heard
  // during the last tone, and what the MPU felt during the last haptic). Any
  // of these may be missing; we return null only if all three are.
  const r = latestSensorReading;
  const e = latestBeepEcho;
  const h = latestHapticEcho;
  if (!r && !e && !h) return null;

  const room: Record<string, unknown> = { instance: `${INSTANCE_ID}@${BOOT_TIME}` };
  if (r) {
    Object.assign(room, r.environment ?? {});
    if (r.motion?.state)               room.motion          = r.motion.state;
    if (r.motion?.step_count != null)  room.step_count      = r.motion.step_count;
    if (r.biometric?.heart_rate_bpm != null) room.heart_rate_bpm = r.biometric.heart_rate_bpm;
    if (r.touch?.fsr_raw != null)      room.fsr_raw        = r.touch.fsr_raw;
    if (r.touch?.detected != null)     room.touch_detected = r.touch.detected;
    if (r.touch?.skin_temp_c != null)  room.skin_temp_c    = r.touch.skin_temp_c;
    room.age_seconds = Math.round((Date.now() - new Date(r.timestamp).getTime()) / 1000);
  }
  if (e) {
    // `age_seconds` here is independent of the sensor reading age above —
    // it tells you how long ago the most recent beep landed at the mic.
    room.recent_beep_echo = {
      frequency: e.frequency,
      duration_ms: e.duration_ms,
      noise_db: e.noise_db,
      noise_env: e.noise_env,
      age_seconds: Math.round((Date.now() - new Date(e.timestamp).getTime()) / 1000),
    };
  }
  if (h) {
    // The room snapshot carries the PERCEPT, not the lab notebook:
    // "I felt it (felt), this clearly (snr), this hard (peak_g)."
    // Full instrument statistics (rms, floor windows) stay on
    // /haptic/echo — same collapse-at-the-edge principle as the
    // firmware's still/walking and quiet/loud summaries.
    room.recent_haptic_echo = {
      ...(h.effect !== undefined
        ? { effect: h.effect }
        : { effect_id: h.effect_id }),
      peak_g: h.peak_g,
      ...(h.snr !== undefined && { snr: h.snr }),
      ...(h.felt !== undefined && { felt: h.felt }),
      age_seconds: Math.round((Date.now() - new Date(h.timestamp).getTime()) / 1000),
    };
  }
  const t = recentTouch();
  if (t) room.recent_touch = t;
  // Current smell — included once the sliding window is full, so an output
  // confirmation carries the room's scent alongside its sound and touch.
  if (SMELL_ENABLED && smellBuffer.ready) room.smell = currentSmell();
  return room;
}

// ---- unified output command queue ---------------------------------------
//
// All three output channels (haptic / face / beep) share ONE FIFO queue
// and ONE long-poll endpoint (/command/poll). This is a fix for an ESP32
// heap exhaustion bug: previously we had three independent long-poll tasks
// on the ESP32, each holding an HTTPS + TLS context, plus a fourth socket
// for the sensor POST. Four concurrent TLS sessions didn't fit — the POST
// always failed with HTTPC_ERROR_CONNECTION_REFUSED because mbedTLS
// couldn't allocate a new handshake buffer.
//
// Consolidating to ONE long-poll (plus the sensor POST) keeps us at two
// simultaneous TLS sessions, well inside budget.
//
// Queue semantics: FIFO with a small cap (8). If the client queues faster
// than the microcontroller can drain, the oldest commands get dropped —
// losing the middle of a rapid-fire sequence is less bad than stalling.
type PendingCommand =
  // `echo: 1` marks a measured fire: the firmware routes it through the
  // loop()-context choreography (floor window → fire → signal window)
  // and reports the full echo statistics back. Plain taps omit it and
  // fire instantly in the poll task with zero measurement overhead.
  | { type: "haptic"; effect_id: number; echo?: number }
  | { type: "haptic_baseline" }
  | { type: "face"; expression: string }
  | { type: "beep"; frequency: number; duration_ms: number }
  // A whole song in ONE command. `notes` is CSV "freqXdurXgap,..." — the
  // firmware plays the sequence locally with its own delays, so note
  // spacing never depends on poll round-trip time. freq 0 = rest.
  | { type: "melody"; notes: string };

const commandQueue: PendingCommand[] = [];
// A melody travels as a single command, so the queue only needs room
// for a burst of discrete commands; 64 is generous headroom.
const MAX_COMMAND_QUEUE = 64;

type CommandResolver = (cmd: PendingCommand | null) => void;
const commandPollers: CommandResolver[] = [];

function queueCommand(cmd: PendingCommand): void {
  commandQueue.push(cmd);
  while (commandQueue.length > MAX_COMMAND_QUEUE) commandQueue.shift();
  while (commandQueue.length > 0 && commandPollers.length > 0) {
    const resolver = commandPollers.shift()!;
    const next = commandQueue.shift()!;
    resolver(next);
  }
}

function waitForCommand(
  timeoutMs: number,
  res: ServerResponse,
): Promise<PendingCommand | null> {
  // A half-open poll connection (the microcontroller dropped off WiFi
  // without a FIN) must never take a command with it: don't dequeue for
  // a socket that is already dead, and deregister the poller the moment
  // the socket dies. Otherwise a queued command is silently lost into
  // the dead connection for up to the long-poll timeout.
  if (res.destroyed) return Promise.resolve(null);
  if (commandQueue.length > 0) {
    return Promise.resolve(commandQueue.shift()!);
  }
  return new Promise<PendingCommand | null>((resolve) => {
    const resolver: CommandResolver = (cmd) => {
      cleanup();
      resolve(cmd);
    };
    const onClose = () => {
      const idx = commandPollers.indexOf(resolver);
      if (idx >= 0) {
        commandPollers.splice(idx, 1);
        log("command/poll client gone; poller deregistered");
      }
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener("close", onClose);
    };
    commandPollers.push(resolver);
    const timer = setTimeout(onClose, timeoutMs);
    res.on("close", onClose);
  });
}

// ---- beep echo (audio-loop self-perception) -----------------------------
//
// When the microcontroller receives a beep command, it plays the tone AND
// samples the mic during the same window, then ferries the measured dB up
// on its next /command/poll request as `echo_freq` / `echo_duration_ms` /
// `echo_noise_db` query params. We stash that snapshot in `latestBeepEcho`;
// clients read it via /beep/echo. This is the smallest version of "the
// device hears its own output" — proof that the buzzer actually made it
// past the air gap.

type BeepEcho = {
  timestamp: string;
  frequency: number;
  duration_ms: number;
  noise_db: number;
  noise_env: "quiet" | "moderate" | "noisy" | "loud";
};

let latestBeepEcho: BeepEcho | null = null;

// Same thresholds as the ESP32-side classifier — duplicated here because the
// ESP32 only sends raw dB on the echo, not the env label.
function classifyDbToEnv(db: number): BeepEcho["noise_env"] {
  if (db < 45) return "quiet";
  if (db < 60) return "moderate";
  if (db < 75) return "noisy";
  return "loud";
}

async function handleCommandPoll(
  args: unknown,
  res: ServerResponse,
): Promise<PendingCommand | null> {
  // Side effect first: if this poll request carries echo data from a beep
  // the ESP32 just played, stash it before doing the actual long-poll.
  const echoFreq = asOptionalNumber(getField(args, "echo_freq"));
  const echoDur = asOptionalNumber(getField(args, "echo_duration_ms"));
  const echoDb = asOptionalNumber(getField(args, "echo_noise_db"));
  if (echoFreq !== undefined && echoDur !== undefined && echoDb !== undefined) {
    latestBeepEcho = {
      timestamp: new Date().toISOString(),
      frequency: echoFreq,
      duration_ms: echoDur,
      noise_db: echoDb,
      noise_env: classifyDbToEnv(echoDb),
    };
  }

  // Haptic-echo side channel — same idea, second modality.
  const hechoEffect = asOptionalNumber(getField(args, "hecho_effect"));
  const hechoPeak = asOptionalNumber(getField(args, "hecho_peak"));
  if (hechoEffect !== undefined && hechoPeak !== undefined) {
    const echo: HapticEcho = {
      timestamp: new Date().toISOString(),
      effect_id: hechoEffect,
      peak_g: hechoPeak,
    };
    if (pendingMeasuredFire && pendingMeasuredFire.effect_id === hechoEffect) {
      echo.effect = pendingMeasuredFire.name;
      pendingMeasuredFire = null;
    }
    // Extended statistics, when the firmware sends them. The verdict
    // compares each window against the echo's OWN pre-fire floor: RMS
    // catches sustained vibration (noise averages down by √N, signal
    // doesn't), peak catches ~10 ms click transients that RMS would
    // dilute. 3× is far outside both statistics' sampling variation.
    const rms = asOptionalNumber(getField(args, "hecho_rms"));
    const floorPeak = asOptionalNumber(getField(args, "hecho_floor_peak"));
    const floorRms = asOptionalNumber(getField(args, "hecho_floor_rms"));
    if (rms !== undefined && floorPeak !== undefined && floorRms !== undefined) {
      echo.rms = rms;
      echo.floor_peak = floorPeak;
      echo.floor_rms = floorRms;
      if (floorRms > 0) {
        echo.snr = Math.round((rms / floorRms) * 100) / 100;
      }
      echo.felt =
        (floorRms > 0 && rms > 3 * floorRms) ||
        (floorPeak > 0 && hechoPeak > 3 * floorPeak);
    }
    latestHapticEcho = echo;
  }

  // `wait` is seconds, clamped [1, 30]. Default 25 — shorter than the 30s
  // cloudflared tunnel timeout, long enough to amortize connect cost.
  const waitRaw = getField(args, "wait");
  let waitSec = 25;
  if (waitRaw !== undefined) {
    waitSec = asIntInRange(waitRaw, "wait", 1, 30);
  }
  return waitForCommand(waitSec * 1000, res);
}

function handleBeepEcho(): {
  has_echo: boolean;
  echo: BeepEcho | null;
  age_seconds: number | null;
} {
  if (!latestBeepEcho) {
    return { has_echo: false, echo: null, age_seconds: null };
  }
  const age = (Date.now() - new Date(latestBeepEcho.timestamp).getTime()) / 1000;
  return {
    has_echo: true,
    echo: latestBeepEcho,
    age_seconds: Math.round(age),
  };
}

// ---- haptic echo (haptic-loop self-perception) --------------------------
//
// Second instance of the input-output coupling pattern from §6 of the paper:
// the ESP32 fires a haptic effect, the MPU-6050 (in a temporary wide-band,
// fast-sample mode) measures the peak |a − g| during the vibration window,
// and that peak is ferried up on the next /command/poll request as
// `hecho_effect` / `hecho_peak`. Stashed here for the room snapshot and
// available directly via /haptic/echo.

type HapticEcho = {
  timestamp: string;
  effect_id: number;
  effect?: string;      // semantic name of the measured fire, when known
  peak_g: number;       // peak AC deviation in m/s², signal window
  // Extended statistics. Absent when the firmware reports only the peak.
  rms?: number;         // RMS AC deviation, signal window
  floor_peak?: number;  // same statistics, pre-fire control window
  floor_rms?: number;
  snr?: number;         // rms / floor_rms — how far above its own floor
  felt?: boolean;       // verdict: did the MPU actually register it?
};

let latestHapticEcho: HapticEcho | null = null;

// The firmware's echo carries only the numeric effect id, but ids are
// shared between semantic aliases (heartbeat and double_tap are both 10)
// — and "I felt heartbeat" is a different percept from "I felt
// double_tap" even when the motor waveform is identical. Remember the
// name of the most recent measured fire and attach it to the echo ONLY
// when the id matches — better an unnamed echo than a mislabeled one.
// Raw effect_id fires have no name and report the number instead.
let pendingMeasuredFire: { effect_id: number; name: string } | null = null;

function handleHapticEcho(): {
  has_echo: boolean;
  echo: HapticEcho | null;
  age_seconds: number | null;
} {
  if (!latestHapticEcho) {
    return { has_echo: false, echo: null, age_seconds: null };
  }
  const age = (Date.now() - new Date(latestHapticEcho.timestamp).getTime()) / 1000;
  return {
    has_echo: true,
    echo: latestHapticEcho,
    age_seconds: Math.round(age),
  };
}

// ---- haptic output -------------------------------------------------------
//
// The microcontroller carries a DRV2605L + ERM coin motor. This is the
// first output path on the sensor body: the LLM client calls /haptic with
// a named effect; the microcontroller is camped on /command/poll waiting
// for it; latency is dominated by the network round-trip.
//
// Naming: the DRV2605L ships with a library of 123 effects. Most of them
// are either redundant variations (different intensities) or feel identical
// on a small ERM coin motor. We expose a curated subset by semantic name so
// the LLM client does not have to remember "effect 47". The numeric escape
// `effect_id=N` is still accepted for tuning/experimentation.

// ERM-library effect IDs (selectLibrary(1) on DRV2605). Hand-picked from the
// datasheet's 123-effect table for what actually feels distinct on a 10mm
// coin motor — not a mechanical mapping.
const HAPTIC_EFFECTS: Record<string, number> = {
  // Physical vocabulary — describes the sensation
  tap:         1,   // Strong Click 100% — sharp single tick, ~15ms
  soft_tap:    7,   // Soft Bump 100% — gentler, rounder
  double_tap:  10,  // Double Click 100% — "tap-tap"
  triple_tap:  14,  // Triple Click 100% — "tap-tap-tap"
  buzz:        47,  // Buzz 1 100% — ~1s sustained
  hum:         52,  // Pulsing Strong 1 100% — rhythmic
  long_buzz:   49,  // Buzz 3 100% — longer sustained

  // Semantic vocabulary — describes the intent (may alias physical effects)
  heartbeat:   10,  // "thump-thump" = double click on a coin motor
  knock:       14,  // "knock-knock-knock"
  hello:       24,  // Sharp Tick 1 100% — a quick "hi"
  alert:       58,  // Transition Click 1 100% — attention-getting
};

const HAPTIC_NAMES = Object.keys(HAPTIC_EFFECTS);

async function handleHaptic(args: unknown): Promise<{
  effect: string | null;
  effect_id: number;
  queued: true;
  echo_waited: boolean;
  room: object | null;
}> {
  // Accept either `effect=<name>` (preferred, semantic) or
  // `effect_id=<1-123>` (numeric escape for tuning).
  const name = asOptionalString(getField(args, "effect"));
  const idArg = getField(args, "effect_id");

  let effectId: number;
  let resolvedName: string | null = null;

  if (name !== undefined) {
    if (!(name in HAPTIC_EFFECTS)) {
      throw new Error(
        `effect must be one of: ${HAPTIC_NAMES.join(", ")}`,
      );
    }
    effectId = HAPTIC_EFFECTS[name];
    resolvedName = name;
  } else if (idArg !== undefined) {
    effectId = asIntInRange(idArg, "effect_id", 1, 123);
  } else {
    throw new Error(
      `missing \`effect\` (one of: ${HAPTIC_NAMES.join(", ")}) or \`effect_id\` (1-123)`,
    );
  }

  // Mirror of /beep's wait_echo: opt-in synchronous mode that blocks the
  // response until the haptic-echo for THIS event arrives back from the
  // microcontroller. wait_echo also selects the measured-fire path
  // (echo: 1) — plain taps skip measurement entirely and fire with the
  // lowest possible latency.
  const wantEcho = isTruthyParam(getField(args, "wait_echo"));

  // Mark "now" BEFORE queueing so we can detect when the echo for THIS
  // haptic event (vs. a previous one still in latestHapticEcho) lands.
  const queuedAt = Date.now();
  if (wantEcho) {
    pendingMeasuredFire = {
      effect_id: effectId,
      name: resolvedName ?? String(effectId),
    };
  }
  queueCommand({
    type: "haptic",
    effect_id: effectId,
    ...(wantEcho ? { echo: 1 } : {}),
  });

  let echoWaited = false;
  if (wantEcho) {
    // 8 s budget: worst case has the firmware's main loop inside its
    // 10 s sensor post when the fire arrives, plus the ~700 ms
    // measurement, plus the echo riding the NEXT poll's TLS handshake.
    const maxWaitMs = 8000;
    const checkIntervalMs = 100;
    const deadline = queuedAt + maxWaitMs;
    while (Date.now() < deadline) {
      if (
        latestHapticEcho &&
        new Date(latestHapticEcho.timestamp).getTime() > queuedAt
      ) {
        echoWaited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, checkIntervalMs));
    }
  }

  return {
    effect: resolvedName,
    effect_id: effectId,
    queued: true,
    echo_waited: echoWaited,
    room: currentRoom(),
  };
}

// Noise-floor measurement: queue a `haptic_baseline` command. ESP32 runs the
// same wide-band MPU sampling block as a real haptic echo, but skips the
// motor firing. Result lands in latestHapticEcho with effect_id=0. Useful for
// characterizing the accelerometer noise floor of the haptic-loop measurement
// without re-flashing or moving hardware.
async function handleHapticBaseline(args: unknown): Promise<{
  baseline: true;
  queued: true;
  echo_waited: boolean;
  room: object | null;
}> {
  const queuedAt = Date.now();
  pendingMeasuredFire = { effect_id: 0, name: "baseline" };
  queueCommand({ type: "haptic_baseline" });

  const wantEcho = isTruthyParam(getField(args, "wait_echo"));
  let echoWaited = false;
  if (wantEcho) {
    // Same 8 s budget as /haptic — see the comment there.
    const maxWaitMs = 8000;
    const checkIntervalMs = 100;
    const deadline = queuedAt + maxWaitMs;
    while (Date.now() < deadline) {
      if (
        latestHapticEcho &&
        new Date(latestHapticEcho.timestamp).getTime() > queuedAt
      ) {
        echoWaited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, checkIntervalMs));
    }
  }

  return {
    baseline: true,
    queued: true,
    echo_waited: echoWaited,
    room: currentRoom(),
  };
}

// ---- face output ---------------------------------------------------------
//
// Same architecture as haptic: the client posts to /face, the command goes
// into the unified queue, the microcontroller consumes it via
// /command/poll. Payload is a string name (e.g. "happy") rather than a
// numeric ID; the firmware parses the string into its FaceExpression enum.
// Keeping the wire format as a name (not an int) decouples the bridge from
// whatever enum ordering the firmware happens to use.
//
// Each name in this set must have a matching case in the firmware's
// drawFace() + parseFaceExpression().
const FACE_EXPRESSIONS: ReadonlySet<string> = new Set([
  "default",
  "happy",
  "shy",
  "love",
  "excited",
  "sleepy",
  "goodnight",
  "relaxed",
  "kissing",
  "angry",
  "wronged",
  "sad",
  "surprised",
  "blank",
  "expressionless",
  "smug",
  "pleading",
]);

const FACE_NAMES = Array.from(FACE_EXPRESSIONS);

function handleFace(args: unknown): {
  expression: string;
  queued: true;
  room: object | null;
} {
  const name = asOptionalString(getField(args, "expression"));
  if (name === undefined) {
    throw new Error(
      `missing \`expression\` (one of: ${FACE_NAMES.join(", ")})`,
    );
  }
  if (!FACE_EXPRESSIONS.has(name)) {
    throw new Error(
      `expression must be one of: ${FACE_NAMES.join(", ")}`,
    );
  }
  queueCommand({ type: "face", expression: name });
  // Same convenience as /haptic — caller sees what room they just addressed.
  return { expression: name, queued: true, room: currentRoom() };
}

// ---- buzzer output -------------------------------------------------------
//
// Same long-poll architecture as haptic/face. Payload is a frequency (Hz)
// and a duration (ms). Passive piezo on the ESP32 side (KY-006) driven by
// PWM — any frequency 100-10000 Hz will make SOME sound, but the piezo
// resonates loudest in the 1.5-2.5 kHz range.
//
// Two input shapes accepted:
//   - name=<name>                           → looks up SOUNDS palette
//   - frequency=<Hz>&duration_ms=<ms>       → arbitrary tone (for experimentation)
//
// The named palette was hand-tuned on the KY-006: frequency for character
// (high = chirpy, low = grave), duration for weight. Promoted to code so
// the LLM client does not have to remember freq/duration pairs.
const SOUNDS: Record<string, { frequency: number; duration_ms: number }> = {
  hello:    { frequency: 2000, duration_ms: 150 },  // bright short greeting
  hi:       { frequency: 3000, duration_ms: 100 },  // higher, shorter — casual
  hey:      { frequency: 1500, duration_ms: 300 },  // lower, longer — getting attention
  ping:     { frequency: 4000, duration_ms: 80  },  // sharp notification
  hum:      { frequency: 500,  duration_ms: 400 },  // low sustained presence
  call:     { frequency: 2000, duration_ms: 600 },  // longer hello — "come here"
  alert:    { frequency: 3500, duration_ms: 200 },  // urgent, piercing
  chirp:    { frequency: 2500, duration_ms: 100 },  // cute short peep
  low:      { frequency: 800,  duration_ms: 250 },  // grave, considered
  long_hum: { frequency: 1500, duration_ms: 800 },  // sustained thinking sound
};

const SOUND_NAMES = Object.keys(SOUNDS);

async function handleBeep(args: unknown): Promise<{
  name: string | null;
  frequency: number;
  duration_ms: number;
  queued: true;
  echo_waited: boolean;
  room: object | null;
}> {
  const nameRaw = asOptionalString(getField(args, "name"));
  const freqRaw = getField(args, "frequency");
  const durRaw = getField(args, "duration_ms");

  let frequency: number;
  let duration_ms: number;
  let resolvedName: string | null = null;

  if (nameRaw !== undefined) {
    if (!(nameRaw in SOUNDS)) {
      throw new Error(
        `name must be one of: ${SOUND_NAMES.join(", ")}`,
      );
    }
    const preset = SOUNDS[nameRaw];
    frequency = preset.frequency;
    duration_ms = preset.duration_ms;
    resolvedName = nameRaw;
  } else if (freqRaw !== undefined && durRaw !== undefined) {
    // Raw form, unchanged. Frequency in Hz (100-10000 audible), duration in
    // ms capped at 5 s (longer feels annoying and isn't something we want
    // to expose cheaply).
    frequency = asIntInRange(freqRaw, "frequency", 100, 10000);
    duration_ms = asIntInRange(durRaw, "duration_ms", 1, 5000);
  } else {
    throw new Error(
      `missing \`name\` (one of: ${SOUND_NAMES.join(", ")}) or \`frequency\`+\`duration_ms\``,
    );
  }

  // Mark "now" BEFORE queueing so we can detect when the echo for THIS beep
  // (vs. a previous one that's still in latestBeepEcho) lands.
  const queuedAt = Date.now();
  queueCommand({ type: "beep", frequency, duration_ms });

  // Opt-in: wait for the echo of THIS beep before responding, so a single
  // request returns "the sound was played, here is what the mic heard, here
  // is the room." Cost: response is delayed by the beep duration plus the
  // microcontroller→bridge round-trip (~1-1.5s for short beeps, up to ~6s
  // for the 5-second max). Default off so old fire-and-forget behavior is
  // unchanged.
  const wantEcho = isTruthyParam(getField(args, "wait_echo"));
  let echoWaited = false;
  if (wantEcho) {
    // Tone length + 6 s slack: the beep echo rides the NEXT poll, whose
    // TLS handshake can collide with the firmware's 10 s sensor post —
    // same race as the haptic echo budget, same margin.
    const maxWaitMs = duration_ms + 6000;
    const checkIntervalMs = 100;
    const deadline = queuedAt + maxWaitMs;
    while (Date.now() < deadline) {
      if (
        latestBeepEcho &&
        new Date(latestBeepEcho.timestamp).getTime() > queuedAt
      ) {
        echoWaited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, checkIntervalMs));
    }
  }

  return {
    name: resolvedName,
    frequency,
    duration_ms,
    queued: true,
    echo_waited: echoWaited,
    room: currentRoom(),
  };
}

// ---- melody (whole song as one command) ----------------------------------
//
// Single GET → ONE melody command queued. The device receives the entire
// score and plays it locally: tone duration AND the silence after each note
// are both firmware-side delays, so the tempo belongs to the device, not
// the network. (Queueing N beep commands and letting the poll cadence set
// the tempo breaks down as soon as poll round-trips slow — over a TLS
// tunnel each note waits a full reconnect, and a song shreds into stutter.)
//
// Two ways to call:
//   ?song=<name>   — server-side library lookup (short URL; works for
//                    clients whose web_fetch may reject very long URLs)
//   ?notes=<csv>   — inline CSV: freqXdur or freqXdurXgap per token
//   &gap_ms=<n>    — default silence after each note when a token doesn't
//                    carry its own Xgap (default DEFAULT_NOTE_GAP_MS).
//                    freq 0 = rest.
//
// The gap is a first-class musical parameter: without it a whole-song
// command plays legato and melodies blur together.

// Upper bound on notes per /melody call; the largest shipped SONGS preset
// (twinkle_full, 42 notes) fits comfortably.
const MAX_MELODY_NOTES = 64;
// Default silence after each note when the caller doesn't specify one.
// Deliberately unhurried — piezo tones need far more breathing room than
// musical intuition suggests; 520ms is the ear-calibrated value. Fast
// passages should say so explicitly (per-note Xgap or a small gap_ms).
const DEFAULT_NOTE_GAP_MS = 520;

type Note = { frequency: number; duration_ms: number; gap_ms?: number };

const SONGS: Record<string, Note[]> = (() => {
  // Twinkle, twinkle, little star — each phrase is 7 notes (6 quarters + 1 half).
  // Pitches: C4=262 D4=294 E4=330 F4=349 G4=392 A4=440.
  const Q = 280; // quarter-note tone duration
  const H = 500; // phrase-ending half-note tone duration
  const FIN = 800; // final-note tone duration (lets it ring)
  const QGAP = 360; // silence after a quarter note — a rocking lullaby pace
  const PHRASE_GAP = 680; // breath after a phrase-ending half note
  const phrase = (pitches: number[], lastDur: number): Note[] =>
    pitches.map((f, i) => ({
      frequency: f,
      duration_ms: i === pitches.length - 1 ? lastDur : Q,
      gap_ms: i === pitches.length - 1 ? PHRASE_GAP : QGAP,
    }));
  const p1 = phrase([262, 262, 392, 392, 440, 440, 392], H); // twinkle, twinkle, little star
  const p2 = phrase([349, 349, 330, 330, 294, 294, 262], H); // how I wonder what you are
  const p3 = phrase([392, 392, 349, 349, 330, 330, 294], H); // up above the world so high
  const p4 = phrase([392, 392, 349, 349, 330, 330, 294], H); // like a diamond in the sky
  const p5 = phrase([262, 262, 392, 392, 440, 440, 392], H); // twinkle, twinkle, little star
  const p6 = phrase([349, 349, 330, 330, 294, 294, 262], FIN); // how I wonder what you are
  return {
    twinkle_part1: [...p1, ...p2, ...p3], // 21 notes — first half
    twinkle_part2: [...p4, ...p5, ...p6], // 21 notes — second half
    twinkle_full: [...p1, ...p2, ...p3, ...p4, ...p5, ...p6], // 42 notes — whole song
  };
})();
const SONG_NAMES = Object.keys(SONGS);

function handleMelody(args: unknown): {
  count: number;
  song: string | null;
  notes: Note[];
  total_ms: number;
} {
  const songRaw = asOptionalString(getField(args, "song"));
  const gapRaw = getField(args, "gap_ms");
  const defaultGap =
    gapRaw === undefined || gapRaw === null || gapRaw === ""
      ? DEFAULT_NOTE_GAP_MS
      : Number(gapRaw);
  if (!Number.isFinite(defaultGap) || defaultGap < 0 || defaultGap > 3000) {
    throw new Error(`gap_ms out of range (0-3000): ${String(gapRaw)}`);
  }
  let parsed: Note[];
  let songName: string | null = null;

  if (songRaw !== undefined) {
    if (!(songRaw in SONGS)) {
      throw new Error(`song must be one of: ${SONG_NAMES.join(", ")}`);
    }
    parsed = SONGS[songRaw];
    songName = songRaw;
  } else {
    const notesRaw = getField(args, "notes");
    if (typeof notesRaw !== "string" || notesRaw.length === 0) {
      throw new Error(
        `missing \`song\` (one of: ${SONG_NAMES.join(", ")}) or \`notes\` (CSV: freqXdur or freqXdurXgap,...)`,
      );
    }
    const tokens = notesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      throw new Error("`notes` is empty");
    }
    if (tokens.length > MAX_MELODY_NOTES) {
      throw new Error(`too many notes (max ${MAX_MELODY_NOTES})`);
    }
    parsed = [];
    for (const tok of tokens) {
      const m = /^(\d+)[xX](\d+)(?:[xX](\d+))?$/.exec(tok);
      if (!m) {
        throw new Error(
          `bad note "${tok}" — expected freqXdur or freqXdurXgap (e.g. 262x300 or 262x300x150)`,
        );
      }
      const frequency = parseInt(m[1], 10);
      const duration_ms = parseInt(m[2], 10);
      const gap_ms = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
      // frequency 0 is a rest — silence for duration_ms.
      if (frequency !== 0 && (frequency < 100 || frequency > 10000)) {
        throw new Error(
          `frequency out of range (0 for rest, or 100-10000 Hz): ${frequency}`,
        );
      }
      if (duration_ms < 1 || duration_ms > 5000) {
        throw new Error(`duration_ms out of range (1-5000): ${duration_ms}`);
      }
      if (gap_ms !== undefined && gap_ms > 3000) {
        throw new Error(`per-note gap out of range (0-3000): ${gap_ms}`);
      }
      parsed.push(
        gap_ms === undefined
          ? { frequency, duration_ms }
          : { frequency, duration_ms, gap_ms },
      );
    }
  }

  // ONE command carries the whole score; the firmware owns the tempo from
  // here. Gaps are baked into every token so the firmware never needs a
  // default of its own.
  const csv = parsed
    .map(
      (n) => `${n.frequency}x${n.duration_ms}x${n.gap_ms ?? defaultGap}`,
    )
    .join(",");
  queueCommand({ type: "melody", notes: csv });

  const total_ms = parsed.reduce(
    (sum, n) => sum + n.duration_ms + (n.gap_ms ?? defaultGap),
    0,
  );
  return { count: parsed.length, song: songName, notes: parsed, total_ms };
}

// "true" / "1" / "yes" → true; everything else → false. Same coercion the
// rest of the bridge uses for boolean-shaped query string params.
function isTruthyParam(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

// ---- request dispatch ----------------------------------------------------

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const qIndex = url.indexOf("?");
  const rawPath = qIndex < 0 ? url : url.slice(0, qIndex);
  const query = new URLSearchParams(qIndex < 0 ? "" : url.slice(qIndex + 1));
  // Strip trailing digits from the path so /sensor/now1, /haptic2, /beep3
  // etc. all route to the same handler. This defeats client-side URL caches
  // that treat identical URLs as "already fetched" and return stale data.
  const path = rawPath.replace(/\d+$/, "");

  // GET /status is the only API endpoint that doesn't need auth — it's safe
  // to probe, and it lets you sanity-check the bridge from a browser.
  if (method === "GET" && path === "/status") {
    sendJson(res, 200, handleStatus());
    return;
  }

  if (method === "GET" && !API_PATHS.has(path)) {
    sendError(res, 404, `no route for GET ${path}`);
    return;
  }

  if (!checkAuth(req, query)) {
    sendError(res, 401, "missing or invalid bearer token");
    return;
  }

  // Figure out the payload. POST takes JSON; GET takes query params. Every
  // write endpoint accepts both forms, picked by method.
  let args: unknown;
  if (method === "POST") {
    args = await readJsonBody(req);
  } else if (method === "GET") {
    args = queryToArgs(query);
  } else {
    sendError(res, 405, `method ${method} not allowed on ${path}`);
    return;
  }

  switch (path) {
    case "/sensor/update": {
      const result = handleSensorUpdate(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/sensor/status":
    case "/sensor/now":
    case "/sensor/current":
    case "/sensor/feel":
    case "/sensor/here":
    case "/sensor/room": {
      const result = handleSensorStatus();
      sendJson(res, 200, result);
      return;
    }
    case "/haptic": {
      const result = await handleHaptic(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/haptic/baseline": {
      const result = await handleHapticBaseline(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/face": {
      const result = handleFace(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/beep": {
      const result = await handleBeep(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/melody": {
      const result = handleMelody(args);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case "/command/poll": {
      // Unified long-poll for all output channels. ESP32 parses the `type`
      // field and dispatches to fireHaptic / drawFace / beepAt. Timeout
      // returns 204 so the client re-polls without parsing an empty body.
      const cmd = await handleCommandPoll(args, res);
      if (cmd === null) {
        if (!res.destroyed) {
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
        }
        return;
      }
      if (res.destroyed) {
        // Socket died in the gap between dequeue and write. Put the
        // command back at the FRONT so the next live poll gets it in
        // FIFO order.
        commandQueue.unshift(cmd);
        log("command/poll client gone post-dequeue; command re-queued");
        return;
      }
      sendJson(res, 200, cmd);
      return;
    }
    case "/beep/echo": {
      // What the mic heard during the most recent beep. 204 if no beep
      // has been played yet (or the microcontroller hasn't reported back).
      const result = handleBeepEcho();
      if (!result.has_echo) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, 200, result);
      return;
    }
    case "/haptic/echo": {
      // What the MPU measured during the most recent haptic event. 204 if
      // no haptic has been fired yet (or the microcontroller hasn't
      // reported back).
      const result = handleHapticEcho();
      if (!result.has_echo) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, 200, result);
      return;
    }
    default:
      sendError(res, 404, `no route for ${method} ${path}`);
  }
}

const server = createServer((req, res) => {
  const started = Date.now();
  const logUrl = sanitizeUrlForLog(req.url ?? "/");
  dispatch(req, res)
    .catch((err: unknown) => {
      const msg = formatError(err);
      // Bad input → 400. Everything else → 500.
      const status = /must be|invalid|too large|out of range/i.test(msg)
        ? 400
        : 500;
      if (!res.headersSent) {
        sendError(res, status, msg);
      } else {
        res.end();
      }
      log(`${req.method} ${logUrl} -> ${status} (${msg})`);
    })
    .finally(() => {
      if (res.statusCode && res.statusCode < 400) {
        log(
          `${req.method} ${logUrl} -> ${res.statusCode} (${Date.now() - started}ms)`,
        );
      }
    });
});

function shutdown(reason: string): void {
  log(`shutting down: ${reason}`);
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, () => {
  log("=".repeat(60));
  log(`bridge listening on http://localhost:${PORT}`);
  log("");
  log("Auth token (clients need this):");
  log(`  ${AUTH_TOKEN}`);
  log("");
  log(
    SMELL_ENABLED
      ? "Smell classifier: ENABLED (experimental — see olfaction/model_card.md)"
      : "Smell classifier: off (start with ENABLE_SMELL=1 to enable)",
  );
  log("");
  log("Endpoints (POST with JSON body, or GET with query params):");
  log("  GET /status            no auth needed");
  log("  POST /sensor/update    microcontroller pushes reading");
  log("  GET /sensor/status     return latest reading (aliases: /sensor/now|feel|here|room|current)");
  log(`  GET /haptic            queue effect (name: ${HAPTIC_NAMES.join("|")}, or effect_id=1-123)`);
  log("                         add &wait_echo=true to block until the MPU feels it back");
  log(`  GET /face              queue OLED expression (name: ${FACE_NAMES.join("|")})`);
  log(`  GET /beep              queue buzzer tone (name: ${SOUND_NAMES.join("|")}, or frequency=100-10000 Hz + duration_ms=1-5000)`);
  log("                         add &wait_echo=true to block until the mic hears it back");
  log(`  GET /melody            queue multi-note batch (song=${SONG_NAMES.join("|")}, or notes=freqXduration,... up to ${MAX_MELODY_NOTES})`);
  log("  GET /beep/echo         most recent audio-loop self-perception observation");
  log("  GET /haptic/echo       most recent haptic-loop self-perception observation");
  log("  GET /haptic/baseline   wide-band MPU sample without firing the motor (noise-floor measurement)");
  log("  GET /command/poll      microcontroller long-polls for queued command (wait: 1-30s, default 25)");
  log("");
  log("Auth: send  Authorization: Bearer <token>  OR  ?token=<token>");
  log("=".repeat(60));
});
