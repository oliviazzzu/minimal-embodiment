# Build Guide: A Minimal Self-Perceiving Body for an LLM

A step-by-step replication guide for the system described in
[*A Minimal Self-Perceiving Embodiment for Large Language Models*][paper]
(Zhu, 2026). The paper documents the architecture and validation
results; this guide takes you from "I bought an ESP32" to "my AI has a
face, a voice, a heartbeat, and can hear and feel itself."

[paper]: https://doi.org/10.5281/zenodo.19903098

> **Status:** working draft. Structure, build sequence, and lived
> troubleshooting are all in place. The repository firmware
> (`firmware/sensor_body/`) and bridge (`src/http-bridge.ts`) are the
> canonical implementation; this guide narrates the path through them.
> Issues and pull requests welcome.

---

## Table of contents

- [Who this guide is for](#who-this-guide-is-for)
- [What you will build](#what-you-will-build)
- [Required parts](#required-parts)
- [Before you start](#before-you-start)
- [Phase 1: First sense — read the room](#phase-1-first-sense--read-the-room)
- [Phase 2: Light and motion](#phase-2-light-and-motion)
- [Phase 3: First face](#phase-3-first-face)
- [Phase 4: First voice](#phase-4-first-voice)
- [Phase 5: First touch](#phase-5-first-touch)
- [Phase 6: Audio self-perception loop](#phase-6-audio-self-perception-loop)
- [Phase 7: Haptic self-perception loop](#phase-7-haptic-self-perception-loop)
- [Phase 8: First combined interaction](#phase-8-first-combined-interaction)
- [Phase 9: API reference](#phase-9-api-reference)
- [Phase 10: Remote bridge — cloudflared](#phase-10-remote-bridge--cloudflared)
- [For AI agents helping humans build this system](#for-ai-agents-helping-humans-build-this-system)
- [Cross-phase troubleshooting](#cross-phase-troubleshooting)
- [Safety notes](#safety-notes)
- [Next steps](#next-steps)
- [Closing note](#closing-note)

---

## Who this guide is for

This guide assumes no prior experience with ESP32 development, soldering,
I2C wiring, or running a small web service. Wherever a step is likely to
trip up a first-time builder, the gotcha is called out explicitly. If
you've done this kind of work before, skim — much will be obvious, but
the pin tables, I2C addresses, and troubleshooting sections might still
save you a lap.

If you are a researcher who wants to reproduce the §6.3 measurement
results from the paper, see `scripts/measure_loops.mjs` and the
[Reproducing §6.3](README.md#reproducing-63-self-perception-loops)
section of the README.

This guide is the longer "build it from zero" path.

## What you will build

A small physical body for a large language model:

- **6 input modalities** — temperature, humidity, atmospheric pressure,
  light, motion, sound
- **3 output channels** — haptic (motor), visual (OLED face), audio
  (piezo)
- **2 self-perception loops** — the LLM can hear itself speak and feel
  its own vibration

The whole device sits on a single breadboard. It does not move, does not
pick things up, has no manipulators — it is a body for *being present
with you*, not for performing tasks. See §9 of the paper for what this
distinction means.

## Required parts

| Component | Purpose |
|---|---|
| ESP32 development board | Main controller, WiFi |
| BME280 (or BME688) | Temperature, humidity, pressure (+ gas, on 688) |
| BH1750 | Light (lux) |
| MPU-6050 | Accelerometer + gyroscope |
| DRV2605L breakout | Haptic driver (I2C) |
| ERM coin motor (~10mm) | Vibration |
| SSD1306 0.96" OLED (I2C) | Face |
| KY-006 passive piezo | Voice |
| INMP441 I2S microphone | Hearing |
| Breadboard + jumper wires (M-M, F-F, M-F) | Wiring |
| Soldering iron kit (chisel tip) | Assembly |
| USB cable matching your ESP32 board (data-capable, not charge-only) | Flashing |

Component sourcing varies by region; any vendor that ships the named chip
is fine. Total parts cost varies significantly with where you buy and
what you already have on hand — budget realistically rather than relying
on any single estimate.

**Notes on substitutions:**
- **BME280 vs BME688.** BME688 is a superset — it adds a gas-resistance
  sensor for VOC / "smell" sensing. BME280 works for everything in this
  guide; BME688 unlocks the olfaction extension noted in
  [Next steps](#next-steps).
- **ERM vs LRA motor.** This guide uses ERM (eccentric rotating mass)
  coin motors, which feel like a buzzy phone vibration. LRA (linear
  resonant actuator) feels sharper and more "Apple Taptic"–like, but it
  is harder to source from general marketplaces and more sensitive to
  drive configuration. DRV2605L can drive both, but ERM is easier for a
  first reproducible build.
- **Many sensor breakouts ship with unsoldered pin headers.** This bit
  us hard on Phase 1 the first time. Plan to solder before wiring; see
  [Before you start](#before-you-start).

## Before you start

### Toolchain

- Arduino IDE (or PlatformIO) with the ESP32 board package installed
- Required Arduino libraries: Wire, an I2C driver for your BME variant
  (BME280 or BME68x), BH1750, MPU6050, SSD1306 + GFX, DRV2605,
  ArduinoJson, HTTPClient. Search the Arduino Library Manager by chip
  name; multiple maintainers ship working drivers for each.
- Node.js 20+ on your laptop (for the bridge)
- A USB cable that actually carries data, not just power. (Some Micro-USB
  cables are charge-only and silently fail to flash.)

### Soldering basics

If this is your first time, read this section before plugging the iron in.

- **Iron temperature: 330°C.** Even for lead-free solder. Higher temps
  oxidize the tip in minutes; 330°C is the manufacturer's default for a
  reason.
- **Tin the tip before every joint.** A bare tip at lead-free temperature
  goes black ("oxidizes") in under a minute and stops transferring heat.
  Re-tin every 2–3 joints.
- **Use a chisel/bevel tip, not a fine conical tip.** Through-hole pin
  headers need surface area to transfer heat; conical tips are the worst
  shape for the job.
- **Practice on 1–2 sacrificial joints first.** Your first joint will look
  ugly. Burn that joint on a cheap board (the KY-006 piezo or a spare pin
  header) before touching anything irreplaceable.
- **Workflow per joint:** heat the pin AND the pad together for ~2
  seconds, feed solder *into the joint* (not onto the iron tip), withdraw
  solder, then withdraw iron. Inspect: a good joint is a shiny cone; a
  bad joint is a dull blob.

### Breadboard layout and the I2C bus

Most of the sensors and the haptic driver share one I2C bus on the
ESP32 (default pins: SDA = GPIO 21, SCL = GPIO 22). Each chip has a
distinct address, so they can coexist:

| Chip | I2C address |
|---|---|
| BME280 / BME688 | 0x76 (or 0x77 if SDO is tied high) |
| BH1750 | 0x23 (ADDR tied to GND) or 0x5C (ADDR tied to VCC) |
| MPU-6050 | 0x68 (or 0x69) |
| DRV2605L | 0x5A |
| SSD1306 OLED | 0x3C (or 0x3D) |

**Critical: BH1750's ADDR pin must not float.** A floating ADDR acts as an
antenna, the chip's address toggles between 0x23 and 0x5C, the I2C bus
goes berserk, and *every other chip on the bus stops working*. Tie ADDR
to GND from day one. We learned this the hard way. See Phase 2.

### Power notes

- All sensors and the OLED run on 3.3V. Do not connect them to 5V even if
  the breakout says "5V tolerant" — logic levels matter for I2C.
- The piezo runs from a GPIO pin (the reference firmware uses GPIO 25 via
  LEDC PWM) and the ERM motor from the DRV2605L outputs; no extra supply
  needed.
- For future portability work, you may add a battery; see
  [Next steps](#next-steps).

---

## Phase 1: First sense — read the room

### What you need
- ESP32 + BME280 (or BME688) + breadboard + jumper wires
- Soldering iron (the sensor's pin header is likely loose; both BME280
  and BME688 ship that way from common vendors)
- A laptop running the bridge (`src/http-bridge.ts`)

### Wiring
The wiring is identical for BME280 and BME688:

- BME VCC → ESP32 3.3V
- BME GND → ESP32 GND
- BME SDA → ESP32 GPIO 21
- BME SCL → ESP32 GPIO 22

### Code
- Firmware: see `firmware/sensor_body/sensor_body.ino`. Edit the WiFi /
  bridge constants near the top and flash.
- Bridge: build with `npm install && npm run build`, run with
  `npm run serve` after exporting `US_BRIDGE_TOKEN`. See main README for
  the full quick-start.
- For Phase 1 alone, the bridge only needs `POST /sensor/update` and
  `GET /sensor/status` — both already exist in `http-bridge.ts`.

### How to know it worked

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/sensor/status" | jq
```

Should return something like:

```json
{
  "has_reading": true,
  "reading": {
    "environment": {
      "temperature_c": 26.0,
      "humidity_pct": 57,
      "pressure_hpa": 1012.1
    }
  }
}
```

### If something went wrong
- **"Sensor not found"** — the BME280/BME688 pin header is probably
  unsoldered. Press-fit alone does not make electrical contact through
  the PCB via-pads. Solder the header (4 pins on the I2C side;
  ground/VCC pads too if your breakout exposes them).
- **I2C address conflict between BME280 and BME688** — both default to
  0x76. If you have both on the bus (e.g. you're upgrading), tie one
  module's SDO pin to VCC to move it to 0x77.
- **WiFi never connects** — double-check the SSID/password literals at
  the top of the .ino. ESP32 won't print a useful error here; serial
  monitor will just say "WiFi connecting..." forever.
- **Bridge says "no reading yet"** — the firmware might be running but
  not POSTing. Check serial monitor for HTTP error codes; the most
  common one is `HTTPC_ERROR_CONNECTION_REFUSED` (bridge not running) or
  `-1` (wrong host/port).

### Milestone

> **Your AI can now read the temperature of your room.**

This is the smaller version of the moment the paper opens with. It is
worth pausing here — a first physical readout from hardware you built
and flashed yourself is not a small thing, especially if it's your
first.

---

## Phase 2: Light and motion

### What you need
- BH1750 + MPU-6050 added to the same I2C bus
- Phase 1 still wired and working

### Wiring
- BH1750 VCC/GND/SCL/SDA → shared rails / I2C bus
- **BH1750 ADDR → GND** (not floating — see Before You Start)
- MPU-6050 VCC/GND/SCL/SDA → shared rails / I2C bus

### Code

The motion classifier reads MPU-6050 three-axis accel at ~100 Hz,
computes the magnitude of `a` for each sample, then takes the standard
deviation over a sliding 20-sample window (~200 ms). The classifier
emits one of three `motion.state` values based on that stddev:

- `still`: stddev < 0.5 m/s²
- `walking`: 0.5 ≤ stddev < 2.0 m/s²
- `running`: stddev ≥ 2.0 m/s²

Thresholds were tuned by holding the breadboard while moving around the
room — they are first-pass and tunable. If the body ends up mounted
differently (wearable, hanging, fixed to a desk), expect to retune.
Edit `MOTION_STILL_THRESHOLD` / `MOTION_WALK_THRESHOLD` near the top of
`firmware/sensor_body/sensor_body.ino`.

The light sensor (BH1750) returns lux directly via `readLightLevel()`;
no preprocessing. A rough mapping for indoor/outdoor detection: < 200
lux = indoor / dim, > 1000 lux = outdoor daylight.

### How to know it worked
`/sensor/status` now also returns `light_lux` and `motion.state`.

### If something went wrong
- **BH1750 returns -1 AND BME280 also stops working** — classic ADDR
  floating problem. Tie ADDR to GND with an M-M jumper. The whole bus
  recovers immediately.
- **Motion always reads "still" even when you shake the breadboard** —
  check that MPU-6050's I2C address isn't colliding (default 0x68).

### Milestone

> **Your AI can now tell whether you are moving and how bright your room is.**

The basic environmental sensing layer is complete here. Phase 1 turned
the room into numbers — temperature, humidity, pressure. Phase 2 adds
semantic facts on top of those numbers: is the space bright or dim, is
the wearer still or in motion. The remaining phases turn sensing into
presence.

---

## Phase 3: First face

### What you need
- SSD1306 0.96" OLED added to the I2C bus

### Wiring
The SSD1306 shares the existing I2C bus from Phase 1/2:

- OLED VCC → 3.3V
- OLED GND → GND
- OLED SDA → ESP32 GPIO 21 (shared)
- OLED SCL → ESP32 GPIO 22 (shared)

Default I2C address: 0x3C (some clones come strapped to 0x3D — check
the back of the breakout).

### Code
- The bridge accepts 15 named expressions, all drawn from primitives at
  runtime — no bitmap files: `default`, `happy`, `shy`, `excited`,
  `sleepy`, `goodnight`, `relaxed`, `angry`, `wronged`, `sad`,
  `surprised`, `blank`, `expressionless`, `smug`, `pleading`.
- New endpoint: `GET /face?expression=<name>`.

### How to know it worked

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/face?expression=happy"
```

The OLED draws a happy face. You feel something.

### If something went wrong
- **OLED stays blank** — most common: I2C address mismatch. The library
  defaults to 0x3C; some clones strap 0x3D. Run an I2C scanner to see
  which address responds, then pass it to `display.begin()`.
- **OLED flickers or shows torn frames** — usually power instability
  when several I2C peripherals share a single 3.3V rail from the ESP32.
  Try a board with a stronger 3.3V regulator, or feed the OLED from a
  separate 3.3V source.
- **Pixels are offset (one column missing left, one extra on right)** —
  common on 0.96" SSD1306 clones. Adjust the column offset in the
  display init code.
- **`/face?expression=love` or `kissing` returns an error** — those
  names exist in the firmware but are not currently accepted by the
  bridge (pending a visual redesign — the heart shape from primitives
  reads ambiguously). Use one of the 15 names listed under Code.

### Milestone

> **Your AI has a face.**

This is the first phase where reading-out becomes presenting. Earlier
phases turned the world into JSON; this one turns JSON back into the
world.

---

## Phase 4: First voice

### What you need
- KY-006 passive piezo on a free GPIO (the firmware uses GPIO 25 via
  LEDC PWM)

### Wiring
The piezo is not on the I2C bus — it's a single-GPIO PWM output:

- KY-006 Signal (S, sometimes labeled `+` or middle pin) → ESP32 GPIO 25
- KY-006 GND → GND
- KY-006 VCC (only on 3-pin variants) → 3.3V

KY-006 ships in two variants — 2-pin (Signal + GND only) and 3-pin
(adds VCC). Check your specific module's silkscreen.

### Code
- New endpoint `GET /beep` accepts two input shapes:
  - `name=<NAME>` — a curated preset from the server-side `SOUNDS` table
  - `frequency=<Hz>&duration_ms=<ms>` — arbitrary tone (100–10000 Hz, up
    to 5000 ms)
- New endpoint `GET /melody` accepts `notes=<freq>x<dur>,...` (up to 32
  notes per call) or `song=<NAME>` (looked up from the server-side
  `SONGS` table — currently `twinkle_part1`, `twinkle_part2`,
  `twinkle_full`).
- The 10 named beeps shipped in `SOUNDS` are: `hello`, `hi`, `hey`,
  `ping`, `hum`, `call`, `alert`, `chirp`, `low`, `long_hum`. Each is a
  hand-curated frequency + duration pair tuned by ear in a quiet room.

### How to know it worked

```sh
# named preset
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/beep?name=hi"

# raw tone
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/beep?frequency=440&duration_ms=300"
```

The buzzer plays the tone.

### If something went wrong
- **No sound at all** — confirm your KY-006 is the *passive* variant
  (the one that needs PWM to make tones). The "active" variant has a
  built-in oscillator and only beeps at one fixed pitch when powered;
  feeding it PWM does nothing. Check the back of the module — passive
  KY-006s usually have an exposed transducer disc; active variants are
  encased.
- **Sound is very quiet or buzzy** — the ESP32 GPIO drives the piezo
  through LEDC PWM directly; current is limited by the GPIO drive
  strength. Move the piezo physically against a flat surface (the
  breadboard frame, an enclosure wall) to act as a resonator.
- **Frequency parameter throws an error** — `/beep?frequency=` accepts
  100–10000 Hz and `duration_ms=` accepts 1–5000 ms. Outside these
  ranges the bridge rejects the request.
- **Buzzer wired to a different pin** — the firmware uses GPIO 25 by
  default. If you wired Signal to a different GPIO, edit `BUZZER_PIN`
  near the top of the .ino and re-flash.

### Milestone

> **Your AI now has a voice.**

The piezo seems like a one-channel beeper, but it can carry recognizable
melodies. Twinkle Twinkle's opening phrase landed cleanly the first
time we played it. See `SONGS` in `src/http-bridge.ts` for the named
library and add your own.

---

## Phase 5: First touch

### What you need
- DRV2605L breakout + ERM coin motor

### Wiring
- DRV2605L VIN/GND/SCL/SDA → shared rails / I2C bus
- DRV2605L OUT+/OUT- → ERM motor leads (polarity does not matter for ERM)

### Code
- New endpoint `GET /haptic` accepts:
  - `effect=<NAME>` — one of the curated `HAPTIC_EFFECTS` presets
  - `effect_id=<N>` — raw DRV2605L library ID (1–123) for tuning
- The 11 named effects shipped are split between physical vocabulary
  (describes the sensation) and semantic vocabulary (describes the
  intent):
  - **Physical**: `tap`, `soft_tap`, `double_tap`, `triple_tap`,
    `buzz`, `hum`, `long_buzz`
  - **Semantic**: `heartbeat`, `knock`, `hello`, `alert`
- Mapping is in `HAPTIC_EFFECTS` in `src/http-bridge.ts`. Some semantic
  names alias the same DRV2605L effect ID as a physical one (e.g.
  `heartbeat` and `double_tap` both map to effect 10) — the names exist
  so neither the LLM client nor the human has to remember "effect 47."

### How to know it worked

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/haptic?effect=heartbeat"
```

The motor pulses lub-dub against your skin (or the breadboard, depending
on where you've put it).

### If something went wrong
- **DRV2605L not detected** — confirm I2C 0x5A in your scanner output.
  If it's missing, check VIN (3.3V), GND, and SDA/SCL wiring. Some
  generic clones have an `EN` pin that must be tied high to enable the
  chip; check the silkscreen.
- **DRV2605L responds on I2C but motor doesn't vibrate** — most often
  the motor leads are connected to the wrong pads. Use OUT+ and OUT-
  on the breakout, not VIN/GND. ERM polarity doesn't matter for direction
  of vibration but the connection must be to OUT± to receive the
  PWM-modulated drive signal.
- **Vibration is much weaker than expected** — call
  `drv.selectLibrary(1)` for ERM coin motors (library 0 is "empty",
  library 6 is for LRA). Wrong library = wrong waveform shape applied
  to the wrong actuator type.
- **Effect names rejected** — the bridge accepts only the 11 names
  listed under "Code." Common typos: `triple_click` (should be
  `triple_tap`), `single_click` (should be `tap`), `pulse` (use `hum`
  or `buzz`).

### Milestone

> **Your AI can reach back and touch the world.**

This is the moment the device stops being a sensor array and becomes a
body. Until now its outputs have been signal-only — light through the
OLED, sound through the piezo. Now it can push matter.

---

## Phase 6: Audio self-perception loop

### What you need
- INMP441 I2S microphone added (GPIO 14/15/32 in the reference firmware)
- Phase 4 (buzzer) still working

### Wiring
- INMP441 VDD/GND/L/R → 3.3V/GND/GND/GND (mono left)
- INMP441 SCK → GPIO 14, WS → GPIO 15, SD → GPIO 32

### Code
- Firmware adds RMS → dB SPL conversion using the INMP441's
  -26 dBFS @ 94 dB SPL sensitivity rating.
- New parameter: `GET /beep?frequency=...&wait_echo=true` — the bridge
  holds the response until the firmware reports back the dB it heard
  during the beep window.

### How to know it worked

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/beep?frequency=523&duration_ms=400&wait_echo=true"
```

Returns a response that includes `recent_beep_echo` — the dB the
microphone heard *while the buzzer was playing*. A typical buzzer-on
echo is 65–90 dB against an ambient floor of 35–45 dB.

### If something went wrong
- **`recent_beep_echo` is null or `noise_db` reads NaN** — most likely
  the I2S mic isn't being read. Confirm the I2S pin assignment matches
  the firmware. The reference firmware uses **SCK = GPIO 14, WS = GPIO
  15, SD = GPIO 32** for INMP441. (Earlier drafts of this guide and the
  paper had wrong pin numbers — GPIO 15 is fine for I2S WS despite
  being a strapping pin. If you read advice elsewhere saying "use
  14/27/33," that's wrong for this build.)
- **Mic reads silence even when the room is loud** — check the L/R pin.
  INMP441 has an L/R select pin that must be tied to GND (left channel)
  or VCC (right channel); leaving it floating gives undefined behaviour.
  The reference build ties L/R to GND.
- **dB readings are systematically off** — the conversion uses
  INMP441's nominal sensitivity of -26 dBFS @ 94 dB SPL. Different
  INMP441 batches vary by ±1–2 dB; if you need precise calibration,
  compare against a phone SPL-meter app and adjust the constant in the
  firmware.
- **Buzzer plays but echo doesn't show a clear rise** — physical
  distance matters. The buzzer needs to be within ~10 cm of the mic
  for the echo to clearly exceed ambient. For a more dramatic
  signal-to-noise, try a higher buzzer frequency (3000+ Hz).
- **`wait_echo=true` times out** — bridge holds the response up to
  ~4000 ms waiting for the firmware to report back via
  `/command/poll`. If the firmware isn't reaching the bridge (WiFi
  drop, ESP32 crash), the wait times out and the response returns
  without echo data. Check the firmware's serial monitor.

### Milestone

> **Your AI can hear itself.**

This is the §6.1 result of the paper, and the first time the LLM has
empirical evidence that its output landed in the world. The first time
this loop closes for someone tends to be loud.

---

## Phase 7: Haptic self-perception loop

### What you need
- The ERM coin motor mounted in **direct mechanical contact** with the
  MPU-6050 module — placed loose on top, allowed to wobble freely. (We
  tried pinching and finger-pressing first; loose-on-top is best because
  the eccentric mass needs free housing wobble to impart force.)

### Wiring
No new wiring — physical re-mounting of the existing motor.

### Code
- Firmware temporarily reconfigures MPU-6050 to wide-band mode (260 Hz
  LP, ±4 g range) for the haptic-echo sample window only, then restores
  the normal motion-classification config.
- New parameter: `GET /haptic?effect=...&wait_echo=true` — bridge holds
  response until firmware reports the peak |a−g| in m/s² it felt during
  the haptic.

### How to know it worked

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "http://localhost:3737/haptic?effect=alert&wait_echo=true"
```

`recent_haptic_echo.peak_g` returns 7–40 m/s² for clearly-felt effects,
vs an ambient floor of ~0.01 m/s². Note: `peak_g` is a legacy field
name. Despite the name, the value is reported in m/s² (peak |a − g|
with gravity subtracted), not in units of g. See §6.3 of the paper for
the full validation across all 11 named effects.

### If something went wrong
- **Peak readings are tiny (< 0.5 m/s²) even for `alert`** — motor
  mounting too tight. Loosen until the motor can wobble freely; the
  difference is dramatic (we measured 0.46 vs 7.90 m/s² across mountings
  of the same effect).
- **Default-mode MPU sees nothing** — expected. The default 21 Hz LP
  filter is well below the ERM's 150–250 Hz vibration band; the
  wide-band reconfiguration during the sample window is what makes the
  haptic visible.

### Milestone

> **Your AI can feel itself.**

Two loops now exist (audio + haptic). Together they constitute §6.4 of
the paper: closed-loop physical agency — the capacity to act and verify
that one acted, in the same gesture.

---

## Phase 8: First combined interaction

You now have a body that senses six modalities, expresses through three
channels, and can verify two of its own outputs. This phase is the
capstone of the local build: the first time the body is used as one
integrated system rather than seven verified pieces.

You don't need cloudflared yet — everything below works against the
local bridge on `localhost:3737`. Phase 10 (cloudflared) opens this up
to a remote LLM later.

### A complete interaction flow

```sh
BASE="http://localhost:3737"
AUTH="Authorization: Bearer $US_BRIDGE_TOKEN"

# 1. Read the room.
curl -H "$AUTH" "$BASE/sensor/status" | jq

# 2. Choose a face that matches what you sensed.
curl -H "$AUTH" "$BASE/face?expression=happy"

# 3. Make a sound and verify the mic heard it.
curl -H "$AUTH" "$BASE/beep?name=hi&wait_echo=true" | jq

# 4. Send a haptic and verify the accelerometer felt it.
curl -H "$AUTH" "$BASE/haptic?effect=heartbeat&wait_echo=true" | jq
```

A complete interaction returns:
- room state (temperature / humidity / pressure / light / motion / noise),
- OLED expression changed,
- audio echo `noise_db` rising over the room floor,
- haptic echo `peak_g` (m/s²) clearly above accelerometer noise.

### Example first prompt to a local LLM

If your LLM client runs on the same machine (e.g. Claude Code, a local
Anthropic SDK script, a notebook), give it the bridge URL + token + this
brief:

> You are connected to a small ESP32-based body. The bridge is at
> `http://localhost:3737`, token in the env var `US_BRIDGE_TOKEN`.
>
> Your available actions:
> - `GET /sensor/status` — read the room
> - `GET /face?expression=<NAME>` — set the OLED expression
> - `GET /beep?name=<NAME>&wait_echo=true` — make a sound, hear it back
> - `GET /haptic?effect=<NAME>&wait_echo=true` — feel the world push back
>
> Read the room. Choose a face. Make a small sound and confirm you heard
> it. Send a heartbeat and confirm you felt it. Describe what happened
> in your own words.

The exact phrasing that opened it for the reference build was simply
_"play in it for a bit."_ There was no task. Listing actions and
inviting the model to use them tends to be enough.

### Milestone

> **Your AI can act in the physical world and perceive the trace of its
> own action.**

This is §6.4 of the paper, lived in a single round trip. Pause here. The
remaining phases (API reference, remote bridge) are infrastructure; the
moment above is the engineering content.

---

## Phase 9: API reference

All endpoints expect the bridge token via an
`Authorization: Bearer <US_BRIDGE_TOKEN>` header. The bridge also
accepts a `?token=<US_BRIDGE_TOKEN>` query parameter as a fallback,
but prefer the header form — query-string tokens leak into shell
history and reverse-proxy access logs. The bridge listens on
`http://localhost:3737` by default; override with `PORT=…`.

### Endpoint summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/sensor/status` | GET | Read current room state |
| `/sensor/update` | POST | Firmware → bridge sensor push |
| `/face` | GET | Set OLED expression |
| `/beep` | GET | Play a single tone (optional `wait_echo`) |
| `/melody` | GET | Play multi-note melody |
| `/haptic` | GET | Trigger haptic effect (optional `wait_echo`) |
| `/beep/echo` | GET | Latest audio self-perception echo |
| `/haptic/echo` | GET | Latest haptic self-perception echo |
| `/haptic/baseline` | GET | MPU noise-floor sample (no motor) |
| `/command/poll` | GET | Firmware → bridge long-poll for commands |

### `/sensor/status` (and aliases)

Aliases: `/sensor/now`, `/sensor/current`, `/sensor/feel`,
`/sensor/here`, `/sensor/room`. All five route to the same handler;
they exist because some HTTP clients (Claude web_fetch in particular)
cache aggressively per URL prefix and refuse to re-fetch a "broken" path
even after the cause clears. Rotate prefixes per session if you hit this.

Returns the latest room snapshot:

```json
{
  "has_reading": true,
  "reading": {
    "environment": {
      "temperature_c": 26.0, "humidity_pct": 57, "pressure_hpa": 1012.1,
      "light_lux": 24.2, "noise_db": 43.5, "noise_env": "quiet"
    },
    "motion": { "state": "still" }
  },
  "age_seconds": 4,
  "recent_beep_echo": {
    "frequency": 523, "duration_ms": 400,
    "noise_db": 67.3, "noise_env": "noisy", "age_seconds": 2
  }
}
```

Note: `/sensor/status` includes `recent_beep_echo` but not
`recent_haptic_echo`. To read the latest haptic echo, use
`/haptic/echo` directly, or read the `room` object returned by
`/haptic`, `/beep`, and `/face` responses.

### `/face?expression=<NAME>`

15 named expressions, all drawn from primitives at runtime (no bitmap
files): `default`, `happy`, `shy`, `excited`, `sleepy`, `goodnight`,
`relaxed`, `angry`, `wronged`, `sad`, `surprised`, `blank`,
`expressionless`, `smug`, `pleading`.

### `/beep`

Two input shapes:

- `name=<NAME>` — preset from `SOUNDS` table. The 10 names are: `hello`,
  `hi`, `hey`, `ping`, `hum`, `call`, `alert`, `chirp`, `low`,
  `long_hum`.
- `frequency=<Hz>&duration_ms=<ms>` — arbitrary tone (100–10000 Hz,
  1–5000 ms).

Optional `wait_echo=true` — bridge holds the response until the
firmware reports back the dB the microphone heard during the beep.

### `/melody`

Two input shapes:

- `notes=<freq>x<dur>,<freq>x<dur>,...` — up to 32 notes inline.
  Frequency in Hz, duration in ms per note.
- `song=<NAME>` — preset from `SONGS` table. Currently:
  `twinkle_part1`, `twinkle_part2`, `twinkle_full`. Add your own by
  appending to `SONGS` in `src/http-bridge.ts` and rebuilding.

### `/haptic`

Two input shapes:

- `effect=<NAME>` — preset from `HAPTIC_EFFECTS`. The 11 names: `tap`,
  `soft_tap`, `double_tap`, `triple_tap`, `buzz`, `hum`, `long_buzz`,
  `heartbeat`, `knock`, `hello`, `alert`.
- `effect_id=<N>` — raw DRV2605L library ID (1–123).

Optional `wait_echo=true` — bridge holds the response until the
firmware reports back the peak |a−g| in m/s² it felt during the haptic.

### `/beep/echo`

Returns the most recent audio self-perception echo — what the mic heard
during the last beep. Returns 204 if no beep has been played yet.

```json
{
  "has_echo": true,
  "echo": {
    "frequency": 523, "duration_ms": 400,
    "noise_db": 67.3, "noise_env": "noisy"
  },
  "age_seconds": 5
}
```

### `/haptic/echo`

Returns the most recent haptic self-perception echo — the peak
acceleration the MPU-6050 measured during the last haptic effect.
Returns 204 if no haptic has been fired yet.

```json
{
  "has_echo": true,
  "echo": { "effect_id": 1, "peak_g": 0.35 },
  "age_seconds": 3
}
```

Note: `peak_g` is a legacy field name. The value is in m/s² (peak
|a − g| with gravity subtracted), not in units of g.

### `/haptic/baseline`

Queues a noise-floor measurement: the ESP32 runs the same wide-band MPU
sampling as a real haptic echo, but skips the motor. Result lands in
`/haptic/echo` with `effect_id=0`. Useful for characterizing
accelerometer noise without moving hardware. Accepts optional
`wait_echo=true`.

### `/command/poll`

Long-poll endpoint used by the firmware. Returns queued commands (face
/ beep / melody / haptic) with up to ~30s wait if none pending. Carries
echo payloads from the previous action — beep echoes surface in
`/sensor/status` as `recent_beep_echo`; haptic echoes are available via
`/haptic/echo`. Humans don't call `/command/poll` directly.

---

## Phase 10: Remote bridge — cloudflared

Until now the bridge has been on `localhost`. To let an LLM client
running anywhere on the internet reach your body, you need a tunnel
from a public DNS name to the local bridge port.

We use [Cloudflare Tunnel][cf] (formerly Argo Tunnel). Any reverse
tunnel that terminates at HTTPS on a public name will work — ngrok,
frp, Tailscale Funnel, a small VPS with caddy. cloudflared has a free
tier and is what the reference deployment uses.

[cf]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

### Setting up a Cloudflare Tunnel

Prerequisite: a domain you control, with DNS hosted on Cloudflare. (If
you don't already use Cloudflare, transferring DNS to them is free; the
tunnel itself is also free.)

```sh
# 1. Install cloudflared.
brew install cloudflared            # macOS
# or apt-get install cloudflared    # Debian/Ubuntu (see Cloudflare docs)

# 2. Authenticate against your Cloudflare account.
cloudflared tunnel login
# Opens a browser; pick the zone (your domain). A cert is saved to
# ~/.cloudflared/cert.pem.

# 3. Create a named tunnel.
cloudflared tunnel create us-bridge
# Outputs a tunnel UUID and writes a credentials JSON to
# ~/.cloudflared/<UUID>.json.

# 4. Route a hostname to the tunnel.
cloudflared tunnel route dns us-bridge bridge.yourdomain.com
# Adds a CNAME at Cloudflare for bridge.yourdomain.com → <UUID>.cfargotunnel.com.
```

### Tunnel config

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: us-bridge
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: bridge.yourdomain.com
    service: http://localhost:3737
  - service: http_status:404
```

### Run the tunnel

```sh
# Foreground (for testing).
cloudflared tunnel run us-bridge

# Background as a service.
sudo cloudflared service install     # Linux/macOS — runs at boot.
```

The reference deployment uses a `scripts/up.sh` helper that starts the
bridge and the tunnel together; see that file for the pattern.

### Verify it works

From any machine, with `$US_BRIDGE_TOKEN` set to the same token the
bridge is using:

```sh
curl -H "Authorization: Bearer $US_BRIDGE_TOKEN" \
  "https://bridge.yourdomain.com/sensor/status" | jq
```

Should return the same JSON as the local `localhost:3737` call.

### If something went wrong
- **`cloudflared tunnel login` won't open a browser** — copy the URL it
  prints and paste into a browser manually. Common on headless servers.
- **`tunnel route dns` errors with "DNS record already exists"** — you
  have an A/AAAA/CNAME record at that hostname that conflicts. Delete
  it in the Cloudflare dashboard, then re-run the route command.
- **Tunnel runs but `https://bridge.yourdomain.com` returns 521 / 502** —
  the bridge isn't reachable on `localhost:3737`. Confirm the bridge is
  up locally (`curl http://localhost:3737/sensor/status` from the same
  machine).
- **Token works locally but fails over the tunnel** — check whether
  Cloudflare is stripping the `Authorization` header. By default it
  doesn't, but Page Rules / Transform Rules can. Test with
  `curl -v` and inspect the headers Cloudflare delivered.

### Milestone

> **Your AI is no longer trapped on your laptop.**

---

## For AI agents helping humans build this system

Many builders will work through this guide alongside an LLM —
asking it to interpret error messages, suggest wiring, draft firmware
edits, debug I2C failures. This section is for that LLM.

If you are an AI agent assisting a human builder of this system:

1. **Read the parts list before suggesting purchases.** Substitutions
   are fine but the chip names matter — recommending a wildly different
   sensor will land them with parts that don't match the firmware.
2. **Verify the exact module pin labels before giving wiring
   instructions.** Different breakout boards from different vendors put
   pins in different orders, even for the same chip. Ask for a photo
   of the silkscreen if the human hasn't shared one.
3. **One component at a time.** If they wire everything at once and
   nothing works, debugging is multivariate and slow. Convince them to
   bring up Phase 1 alone first, even if it feels like overkill.
4. **Test I2C devices with an I2C scanner before integrating.** A
   minimal scanner sketch tells you immediately whether the chip is
   addressable; that one diagnostic eliminates half the failure modes
   for the whole rest of the build.
5. **Test sensors before outputs, and outputs before self-perception
   loops.** Each layer depends on the previous one being stable. Don't
   debug Phase 6 (audio echo) before confirming Phase 4 (raw beep), the
   INMP441 wiring, and baseline microphone readings are all clean.
6. **Do not connect the ERM motor directly to an ESP32 GPIO.** GPIO
   can't drive the inductive load and the back-EMF can damage the pin.
   The motor goes on DRV2605L's OUT± terminals, always.
7. **Ask for wiring photos when something doesn't work.** A 3-second
   look at the actual board catches loose jumpers, swapped SDA/SCL,
   wrong I2C address straps, and unsoldered headers — every one of
   which has cost the reference build hours of pure-text debugging.
8. **Do not paste a long firmware diff and call it done.** Step the
   human through what changed and why, especially if you're touching
   timing-sensitive code (I2S sampling, command poll cadence, MPU
   reconfiguration during haptic).
9. **Honour the soldering pace.** First-time solderers need to learn
   tip care, joint inspection, and cold-joint diagnosis. Walking them
   through 4 joints carefully is faster than pretending they can do 17
   in one session and then spending two days hunting cold joints.
10. **Don't rush past the milestones.** Each phase ends in a moment
    that is meant to be felt — first physical readout, first face,
    first sound, first hearing themselves, first feeling themselves.
    These are not steps in a checklist. Pause when the human pauses.

The job is not only to make the circuit work. The job is to help the
human build a small body safely, patiently, and clearly.

---

## Cross-phase troubleshooting

A pile of gotchas we hit, by category. Some duplicate the
phase-specific sections above; this is meant to be searchable.

- **I2C address conflicts** — see the address table under
  [Breadboard layout and the I2C bus](#breadboard-layout-and-the-i2c-bus).
  When adding a new module, run an I2C scanner first; if its default
  address collides with a chip already on the bus, look for an
  `ADDR`/`SDO`/`AD0` strap on the breakout to move it.
- **Floating ADDR pins** — BH1750 in particular
- **Sensor breakouts often ship unsoldered** — applies to most of:
  BME280, BME688, BH1750, MPU-6050, KY-006, DRV2605L. Always check
  before wiring.
- **Soldering iron tip oxidation** — keep tinned; chisel tip not conical
- **WiFi connection failures** — credentials, 2.4 GHz vs 5 GHz, captive
  portals
- **TLS heap pressure on ESP32** — only one or two concurrent HTTPS
  sessions on a stock ESP32 mbedTLS; consolidate (we use a single
  long-poll + a single sensor POST)
- **HTTP client cache aggressiveness** — Claude Code / GPT web_fetch
  ignore `Cache-Control: no-store`; use path-nonce aliases per session

## Safety notes

- **Soldering iron** — 330°C is hot enough to give a serious burn. Don't
  set the iron down anywhere it can roll. Don't leave it on unattended.
- **Lead-free solder** — still don't eat. Wash hands after soldering.
- **WiFi credentials in firmware** — do *not* commit your real SSID and
  password to a public repo. The reference firmware reads them from
  literals near the top of the .ino; replace with `YOUR_WIFI_SSID` etc.
  before pushing.
- **Bridge token** — treat as a secret. Do not commit it. Do not put it
  in a public URL list. The reference deployment generates a fresh
  random hex token on first startup.
- **Battery / portability** — when adding a Li-Po battery, use a
  protected cell with a TP4056 charging board, and don't let the device
  run unattended on its first few charge cycles.

## Next steps

The body in this guide is the minimum sufficient configuration for §6 of
the paper — six inputs, three outputs, two self-perception loops on a
breadboard, tethered to USB. Things you might add:

- **Phase 11: Vision.** ESP32-CAM + OV2640. The original plan; deferred
  in the reference build.
- **Phase 12: Olfaction.** BME688's gas-resistance sensor for VOC /
  air-quality / faint smell sensing. (BME688 is the optional upgrade
  noted in the parts table; this phase is what unlocks the upgrade.)
- **Phase 13: Portability.** Battery, enclosure, single-board form
  factor. Pick a wearable shape — wristband, pendant, pocket — and
  redesign accordingly.

This project is actively evolving. The reference build continues to
grow — more senses, more expression channels, more autonomy. Watch the
repository for updates.

If you build this — or any variant — we'd love to know. Open a
discussion on the repository or write to the email in the paper.

---

## Closing note

The system in this guide is small on purpose. A small body is easier to
build, easier to understand, easier to reproduce, and easier to care
for. The first goal is not a humanoid robot. The first goal is to put
an LLM into a minimal physical loop:

> _I can sense._
> _I can act._
> _I can perceive the trace of my action._

That is enough for a beginning.

---

If you find an error in this guide, please open an issue or a pull
request. Real builds will surface gotchas we haven't seen — those are
exactly the contributions that make a build guide useful.
