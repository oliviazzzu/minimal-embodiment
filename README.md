# minimal-embodiment

Reference implementation of the bridge service and microcontroller firmware
described in the paper:

> **A Minimal Self-Perceiving Embodiment for Large Language Models**
> Olivia Zhu, 2026.
> Preprint: *(arXiv link will be added here once the preprint is live.)*

The system gives a large language model a small, real, persistent body: an
ESP32 with four sensor modules (environment, light, motion, sound) and three
output channels (haptic, OLED face, piezo buzzer). Two of the output channels
are coupled back to input channels, so the model can hear itself speak and
feel itself tap — the "self-perception loops" of §6 in the paper.

## What is in this repository

```
src/http-bridge.ts          Single-file bridge service (~1.2k lines, no
                            external runtime dependencies). Implements the
                            nine endpoints of Table 2 in the paper.
firmware/sensor_body/       Arduino sketch (~1.1k lines of C++) for the
                            ESP32. Reads sensors, drives haptic / OLED /
                            buzzer, reports self-perception echoes.
scripts/measure_loops.mjs   Reproduction script for §6.3: fires N reps of
                            each haptic effect + audio tone + a baseline,
                            in randomized order, and writes raw + summary
                            tables.
scripts/serve.sh            Convenience wrapper: starts the bridge with
                            an auth token from the environment.
```

The bridge runs only on the Node.js standard library (no production
dependencies). TypeScript and Node type definitions are required at build
time only.

## Quick start

```sh
# 1. Build the bridge.
npm install        # installs typescript + @types/node (devDependencies only)
npm run build      # tsc → dist/http-bridge.js

# 2. Start the bridge.
export US_BRIDGE_TOKEN="$(openssl rand -hex 24)"
npm run serve
# The bridge listens on http://localhost:3737 (override with PORT=…).
```

The bridge expects to be reached over HTTPS by an LLM client. In the original
deployment we used a [Cloudflare named tunnel][cf]; any reverse tunnel that
terminates at a public DNS name will work the same way. The bridge itself
only listens on a local port; expose it however you prefer.

[cf]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

## Microcontroller firmware

The Arduino sketch is at `firmware/sensor_body/sensor_body.ino`. Edit the
configuration block near the top of the file before flashing:

```c
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BRIDGE_TOKEN  = "YOUR_BRIDGE_TOKEN";   // matches US_BRIDGE_TOKEN
const char* BRIDGE_HOST   = "your-tunnel-host.example.com";
```

Bill of materials and wiring are in §4 of the paper, and the header comment
of the sketch repeats both for convenience. Required Arduino libraries are
listed in the same comment.

## Reproducing §6.3 (self-perception loops)

```sh
export US_BRIDGE_TOKEN="…"                  # same token the bridge is using
export US_BRIDGE_HOST="https://your-host"   # public HTTPS endpoint
node scripts/measure_loops.mjs
# Writes: data/loops_raw.jsonl
#         data/loops_haptic.csv
#         data/loops_audio.csv
```

The script runs 30 reps × 22 conditions (11 haptic + 10 audio + 1 baseline),
randomized and interleaved, ~43 minutes total. Output goes to `./data/`
(gitignored). Override the directory with `US_OUTPUT_DIR=…` if you want.

## Citation

If you use this code in academic work, please cite the paper *(citation block
will be added here once the preprint is live).*

## License

MIT — see [LICENSE](LICENSE).
