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
};

let latestSensorReading: SensorReading | null = null;

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
  return reading;
}

function handleSensorUpdate(args: unknown): {
  stored: boolean;
  reading: SensorReading;
} {
  const reading = buildReading(args);
  latestSensorReading = reading;
  return { stored: true, reading };
}

function handleSensorStatus(): {
  has_reading: boolean;
  reading: SensorReading | null;
  age_seconds: number | null;
  recent_beep_echo: (BeepEcho & { age_seconds: number }) | null;
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
    };
  }
  const age = (Date.now() - new Date(latestSensorReading.timestamp).getTime()) / 1000;
  return {
    has_reading: true,
    reading: latestSensorReading,
    age_seconds: Math.round(age),
    recent_beep_echo: echo,
  };
}

/**
 * Flat single-level snapshot of the room's current state, for embedding in
 * other responses (e.g. /haptic so the client sees the room state at the
 * moment it queued a tap). Returns null if no sensor reading has come in
 * yet. Undefined fields are dropped by JSON.stringify, so missing sensors
 * show up as absent keys.
 */
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

  const room: Record<string, unknown> = {};
  if (r) {
    Object.assign(room, r.environment ?? {});
    if (r.motion?.state)               room.motion          = r.motion.state;
    if (r.motion?.step_count != null)  room.step_count      = r.motion.step_count;
    if (r.biometric?.heart_rate_bpm != null) room.heart_rate_bpm = r.biometric.heart_rate_bpm;
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
    // Same shape: most recent haptic event + what the MPU peak was during it.
    room.recent_haptic_echo = {
      effect_id: h.effect_id,
      peak_g: h.peak_g,
      age_seconds: Math.round((Date.now() - new Date(h.timestamp).getTime()) / 1000),
    };
  }
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
  | { type: "haptic"; effect_id: number }
  | { type: "haptic_baseline" }
  | { type: "face"; expression: string }
  | { type: "beep"; frequency: number; duration_ms: number };

const commandQueue: PendingCommand[] = [];
// Sized to hold a single full /melody burst (MAX_MELODY_NOTES notes);
// see the melody section below for the rationale.
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

function waitForCommand(timeoutMs: number): Promise<PendingCommand | null> {
  if (commandQueue.length > 0) {
    return Promise.resolve(commandQueue.shift()!);
  }
  return new Promise<PendingCommand | null>((resolve) => {
    const resolver: CommandResolver = (cmd) => {
      clearTimeout(timer);
      resolve(cmd);
    };
    commandPollers.push(resolver);
    const timer = setTimeout(() => {
      const idx = commandPollers.indexOf(resolver);
      if (idx >= 0) commandPollers.splice(idx, 1);
      resolve(null);
    }, timeoutMs);
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

async function handleCommandPoll(args: unknown): Promise<PendingCommand | null> {
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
    latestHapticEcho = {
      timestamp: new Date().toISOString(),
      effect_id: hechoEffect,
      peak_g: hechoPeak,
    };
  }

  // `wait` is seconds, clamped [1, 30]. Default 25 — shorter than the 30s
  // cloudflared tunnel timeout, long enough to amortize connect cost.
  const waitRaw = getField(args, "wait");
  let waitSec = 25;
  if (waitRaw !== undefined) {
    waitSec = asIntInRange(waitRaw, "wait", 1, 30);
  }
  return waitForCommand(waitSec * 1000);
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
  peak_g: number;       // peak |a − g| in m/s² during the sample window
};

let latestHapticEcho: HapticEcho | null = null;

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

  // Mark "now" BEFORE queueing so we can detect when the echo for THIS
  // haptic event (vs. a previous one still in latestHapticEcho) lands.
  const queuedAt = Date.now();
  queueCommand({ type: "haptic", effect_id: effectId });

  // Mirror of /beep's wait_echo: opt-in synchronous mode that blocks the
  // response until the haptic-echo for THIS event arrives back from the
  // ESP32. Cost: ~500-1500 ms added to the response, depending on long-poll
  // alignment. Default off so the existing fire-and-forget behavior is
  // unchanged.
  const wantEcho = isTruthyParam(getField(args, "wait_echo"));
  let echoWaited = false;
  if (wantEcho) {
    // 4 s budget covers: ESP32 long-poll dispatch + haptic firing
    // (~50 ms) + 200 ms motor spin-up wait + 64 ms accelerometer sample
    // + next-poll TLS handshake (~50-200 ms) + bridge update. Best case
    // ~400 ms; this leaves headroom for reconnect or backoff after a
    // recent bridge restart.
    const maxWaitMs = 4000;
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
  queueCommand({ type: "haptic_baseline" });

  const wantEcho = isTruthyParam(getField(args, "wait_echo"));
  let echoWaited = false;
  if (wantEcho) {
    const maxWaitMs = 4000;
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
  "excited",
  "sleepy",
  "goodnight",
  "relaxed",
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
    const maxWaitMs = duration_ms + 2000;
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

// ---- melody (multi-note beep batch) --------------------------------------
//
// Single GET → N beep commands queued at once. The device drains the queue
// at its ~500 ms poll cadence and plays the melody over a few seconds.
// Necessary for LLM clients with high per-fetch latency, where N sequential
// single-note /beep calls would land with multi-second gaps between notes —
// not music.
//
// Two ways to call:
//   ?song=<name>   — server-side library lookup (short URL; works for
//                    clients whose web_fetch may reject very long URLs)
//   ?notes=<csv>   — inline CSV: freqXduration,freqXduration,...
// Note tempo is set by the device's poll cadence, not by duration_ms —
// duration_ms only controls how long each tone sounds within its slot.

// Upper bound on notes per /melody call. Aligned with MAX_COMMAND_QUEUE so a
// single melody can in principle fill the queue but not exceed it; the
// largest shipped SONGS preset (twinkle_full, 42 notes) fits comfortably.
const MAX_MELODY_NOTES = 64;

type Note = { frequency: number; duration_ms: number };

const SONGS: Record<string, Note[]> = (() => {
  // Twinkle, twinkle, little star — each phrase is 7 notes (6 quarters + 1 half).
  // Pitches: C4=262 D4=294 E4=330 F4=349 G4=392 A4=440.
  const Q = 280; // quarter-note tone duration
  const H = 500; // phrase-ending half-note tone duration
  const FIN = 800; // final-note tone duration (lets it ring)
  const phrase = (pitches: number[], lastDur: number): Note[] =>
    pitches.map((f, i) => ({
      frequency: f,
      duration_ms: i === pitches.length - 1 ? lastDur : Q,
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
} {
  const songRaw = asOptionalString(getField(args, "song"));
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
        `missing \`song\` (one of: ${SONG_NAMES.join(", ")}) or \`notes\` (CSV: freqXduration,...)`,
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
      const m = /^(\d+)[xX](\d+)$/.exec(tok);
      if (!m) {
        throw new Error(
          `bad note "${tok}" — expected freqXduration (e.g. 262x300)`,
        );
      }
      const frequency = parseInt(m[1], 10);
      const duration_ms = parseInt(m[2], 10);
      if (frequency < 100 || frequency > 10000) {
        throw new Error(`frequency out of range (100-10000 Hz): ${frequency}`);
      }
      if (duration_ms < 1 || duration_ms > 5000) {
        throw new Error(`duration_ms out of range (1-5000): ${duration_ms}`);
      }
      parsed.push({ frequency, duration_ms });
    }
  }

  for (const note of parsed) {
    queueCommand({
      type: "beep",
      frequency: note.frequency,
      duration_ms: note.duration_ms,
    });
  }
  return { count: parsed.length, song: songName, notes: parsed };
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
      const cmd = await handleCommandPoll(args);
      if (cmd === null) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
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
