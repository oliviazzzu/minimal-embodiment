/*
 * sensor_body — ESP32 + BME280/BME688 + BH1750 + MPU-6050 + DRV2605L
 *               + SSD1306 OLED + KY-006 + INMP441
 *
 * Microcontroller firmware for the minimal self-perceiving embodiment
 * described in the accompanying paper. Reads four sensor modalities and
 * drives three output channels; reports self-perception observations
 * (mic-during-buzzer, MPU-during-haptic) back to the bridge service.
 *
 * Sensor inputs:
 *   BME280 or BME688 — temperature, humidity, pressure (+ raw gas
 *                  resistance on BME688, useful as an air-quality / VOC
 *                  proxy) (I2C)
 *   BH1750       — illuminance (I2C)
 *   MPU-6050     — 3-axis accel / 3-axis gyro (I2C); ESP32-side preprocessing
 *                  collapses raw accel into a motion state (still / walking /
 *                  running) so the bridge gets a semantic reading, not a
 *                  firehose of raw numbers.
 *   INMP441      — 24-bit PCM acoustic (I2S); RMS → dB SPL classification.
 *
 * Output channels:
 *   DRV2605L + ERM coin motor — haptic, via /haptic endpoint (long-poll).
 *   SSD1306 128x64 OLED       — face expressions, via /face endpoint.
 *   KY-006 passive piezo      — buzzer tones, via /beep endpoint (PWM/LEDC).
 * The three output channels share a single long-poll task
 * (commandPollTask) on /command/poll, rather than one task per channel.
 * The reason — ESP32 mbedTLS handshake-heap exhaustion under three
 * concurrent TLS sessions plus a transient sensor-POST session — is the
 * engineering case study in §5.4 of the paper.
 *
 * The microphone runs on a dedicated I2S bus rather than the shared I2C
 * bus, because I2S is a streaming audio protocol, not a request/response
 * one — its timing and electrical characteristics are incompatible.
 *
 * HARDWARE
 *   ESP32 DevKit C V4         — main controller
 *   GY-BME280 or GY-BME688    — I2C, address 0x76 (temp / humidity / pressure;
 *                                BME688 also reports gas resistance)
 *   GY-302 BH1750             — I2C, address 0x23 (light, ADDR floating)
 *   GY-521 MPU-6050           — I2C, address 0x68 (motion, AD0 floating)
 *   DRV2605L + ERM coin motor — I2C, address 0x5A (haptic OUTPUT)
 *   SSD1306 OLED 0.96" 128×64 — I2C, address 0x3C (face OUTPUT)
 *   KY-006 passive piezo      — GPIO 25 (sound OUTPUT, not on I2C bus)
 *   INMP441 I2S MEMS mic      — I2S0 on GPIO 14/15/32 (sound INPUT, separate bus)
 *
 * WIRING (all I2C devices share one bus; buzzer is on its own GPIO)
 *   ESP32 3V3          -> + rail on breadboard
 *   ESP32 GND          -> − rail on breadboard
 *   ESP32 GPIO 22      -> SCL bus column
 *   ESP32 GPIO 21      -> SDA bus column
 *   ESP32 GPIO 25      -> KY-006 S pin (signal, PWM)
 *   ESP32 GPIO 14      -> INMP441 SCK (I2S bit clock)
 *   ESP32 GPIO 15      -> INMP441 WS  (I2S word select / left-right clock)
 *   ESP32 GPIO 32      -> INMP441 SD  (I2S data, mic → ESP32)
 *   each I2C device VCC -> + rail
 *   each I2C device GND -> − rail
 *   each I2C device SCL -> SCL bus column
 *   each I2C device SDA -> SDA bus column
 *   KY-006 GND          -> − rail
 *   KY-006 middle pin   -> unconnected (or 3V3 if marked +)
 *   INMP441 VDD         -> + rail
 *   INMP441 GND         -> − rail
 *   INMP441 L/R         -> − rail (tied to GND → mic acts as left channel)
 *
 * LIBRARIES TO INSTALL (Arduino IDE -> Library Manager)
 *   - "Adafruit BME280 Library"     (if using BME280)
 *   - "Adafruit BME680 Library"     (if using BME688 — same driver works for 688)
 *   - "Adafruit Unified Sensor"     (pulled in by either BME driver)
 *   - "BH1750" by Christopher Laws
 *   - "Adafruit MPU6050"            (pulls in Adafruit BusIO)
 *   - "Adafruit DRV2605 Library"
 *   - "Adafruit SSD1306"
 *   - "Adafruit GFX Library"        (pulled in with SSD1306)
 *   (The piezo buzzer uses only the built-in LEDC API — no library needed.)
 *
 * RESILIENCE NOTE
 *   Every device is initialized optionally — if any is missing or
 *   unplugged, the firmware keeps running and just omits that capability.
 *   A blocking `while(true)` on a failed init would prevent Wi-Fi and the
 *   POST loop from ever starting, so initialization failures must never
 *   block the main loop.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_BME680.h>   // BME688 uses the BME680 driver
#include <BH1750.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_DRV2605.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <driver/i2s_std.h>
#include <math.h>

// ---- CONFIGURATION (fill these in before flashing) -----------------------

const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BRIDGE_TOKEN  = "YOUR_BRIDGE_TOKEN";   // must match US_BRIDGE_TOKEN on the bridge
const char* BRIDGE_HOST   = "your-tunnel-host.example.com";

// How often to read and post (milliseconds)
const unsigned long POST_INTERVAL_MS = 10000;  // 10 seconds

// Motion state thresholds — derived from the STANDARD DEVIATION of |accel|
// across 20 samples taken back-to-back (~200ms window).
//   stillness in m/s²  — low noise = sensor basically not moving
// These are first-pass values; retune for your deployment context (desk vs.
// hand-held vs. pocket vs. mounted).
const float MOTION_STILL_MAX_STDDEV   = 0.5f;  // below this → "still"
const float MOTION_WALKING_MAX_STDDEV = 2.0f;  // below this → "walking", else "running"

// ---- GLOBALS -------------------------------------------------------------

Adafruit_BME280 bme;
Adafruit_BME680 bme688;
bool useBME688 = false;          // set to true at boot if BME688 is detected
BH1750          lightMeter;
Adafruit_MPU6050 mpu;
Adafruit_DRV2605 drv;

// SSD1306 OLED (128x64) on shared I2C bus, address 0x3C
#define OLED_WIDTH  128
#define OLED_HEIGHT 64
Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);  // -1 = no reset pin

// KY-006 passive piezo buzzer.
// Uses the ESP32's LEDC PWM peripheral via the Arduino-ESP32 3.x API, which
// takes the pin directly (no explicit channel number — the library manages
// channel allocation internally).
#define BUZZER_PIN 25

// FSR 402 force-sensitive resistor — analog touch input.
// Voltage divider: 3.3V → FSR → GPIO 36 → 10kΩ → GND.
// ADC reads 0 (no pressure) to ~4095 (hard press).
#define FSR_PIN             36
#define FSR_TOUCH_THRESHOLD 100   // above this ADC value → touched

// NTC 10K thermistor (MF52D) — skin temperature.
// Voltage divider: 3.3V → 10kΩ → GPIO 39 → thermistor → GND.
// At 25°C thermistor = 10kΩ, ADC ≈ 2048. Hand warmth → ADC drops.
#define THERM_PIN           39
#define THERM_R_FIXED       10000.0f
#define THERM_R0            10000.0f  // resistance at 25°C
#define THERM_T0            298.15f   // 25°C in Kelvin
#define THERM_B             3950.0f   // B-parameter for MF52D 10K

// INMP441 I2S MEMS microphone.
// Uses the modern arduino-esp32 3.x I2S driver (driver/i2s_std.h). I2S0 is
// dedicated to mic; pins are independent of the I2C bus the other sensors
// share. Sample rate 16 kHz is plenty for noise-level tracking (we don't
// care about high frequencies for "is the room loud or quiet"). Each read
// pulls MIC_READ_SAMPLES samples (~64 ms of audio at 16 kHz), which is
// enough for stable RMS without making the 10s POST loop noticeably slower.
#define MIC_PIN_SCK            14
#define MIC_PIN_WS             15
#define MIC_PIN_SD             32
#define MIC_SAMPLE_RATE        16000
#define MIC_DMA_BUF_COUNT      4
#define MIC_DMA_BUF_LEN        256        // samples per DMA buffer
#define MIC_READ_SAMPLES       1024       // samples per RMS window (~64 ms)
#define MIC_24BIT_FULL_SCALE   8388608.0  // 2^23, the 0 dBFS reference for INMP441's 24-bit output
// Noise classification thresholds in dB SPL.
// Calibration is approximate — INMP441 sensitivity is -26 dBFS at 94 dB SPL,
// so 0 dBFS ≡ 120 dB SPL. First-pass numbers from common acoustics
// references; refine for your deployment environment.
#define NOISE_QUIET_MAX        45.0f      // < 45 dB → quiet (library, late-night room)
#define NOISE_MODERATE_MAX     60.0f      // 45-60 → moderate (normal room)
#define NOISE_NOISY_MAX        75.0f      // 60-75 → noisy (loud conversation, busy)
                                          // > 75 → loud

// Face expressions — rendered live from drawing primitives (not bitmap
// tables), so each expression is cheap to iterate and tweak. The set below
// is curated; extend by adding a new enum entry plus matching cases in
// drawFace() and parseFaceExpression().
enum FaceExpression {
  FACE_DEFAULT = 0,       // neutral — two dots + straight mouth
  FACE_HAPPY,             // upside-down-U eyes + big smile
  FACE_SHY,               // small ^^ eyes + blush + small smile
  FACE_LOVE,              // ♡ᵔ ᵕ ᵔ♡ — soft arc eyes + smile + outline hearts at cheeks
  FACE_EXCITED,           // 😆 — >< eyes + big D-shaped laughing mouth
  FACE_SLEEPY,            // closed curved eyes (◡ ◡) + tiny mouth dot
  FACE_GOODNIGHT,         // 😴 — sleepy face + Zzz drifting up-right
  FACE_RELAXED,           // 😌 — gently closed eyes + small content smile
  FACE_KISSING,           // 😚 — closed ^^ eyes + "3" pursed-lip mouth
  FACE_ANGRY,             // slanted \ / eyes + frown
  FACE_WRONGED,           // 😢 — V-shape closed eyes + teardrop + frown
  FACE_SAD,               // ☹️ — default round eyes + downturned mouth
  FACE_SURPRISED,         // 😮 — default round eyes + big O mouth
  FACE_BLANK,             // 😶 — round eyes, NO mouth — "blank stare"
  FACE_EXPRESSIONLESS,    // 😑 — short flat eyes + long flat mouth
  FACE_SMUG,              // 😏 — level eyes + flat mouth with right corner up
  FACE_PLEADING,          // 🥺 — oversized round eyes + trembling mouth
  FACE_COUNT              // sentinel — keep last
};
FaceExpression currentFace = FACE_DEFAULT;

bool bmeOk = false;
bool bhOk  = false;
bool mpuOk = false;
bool drvOk = false;
bool oledOk = false;
bool buzzerOk = false;
bool micOk = false;
bool fsrOk = false;
bool thermOk = false;

// Handle for the I2S RX channel (INMP441). Held globally so
// readMicNoiseDb() can pull samples from anywhere; opened once in setup.
i2s_chan_handle_t i2sRxChan = NULL;

unsigned long lastPostMs  = 0;
unsigned long postCounter = 0;  // monotonic counter for path nonces

// ---- SETUP ---------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("[boot] sensor_body (phase 2) starting up");

  Wire.begin();  // SDA=21, SCL=22 on ESP32 DevKit (default)

  // --- Initialize BME688 or BME280 (optional) ---
  // Try BME688 first (superset — adds raw gas-resistance sensing,
  // useful as an air-quality / VOC proxy). If not found, fall back to
  // BME280. Both share I2C address 0x76 by default, so only one can be
  // present at a time. Either sensor works for everything the paper
  // describes; BME688 additionally unlocks the gas reading.
  if (bme688.begin(0x76) || bme688.begin(0x77)) {
    bmeOk = true;
    useBME688 = true;
    // Standard gas-resistance sensing profile: 320°C heater for 150 ms.
    bme688.setTemperatureOversampling(BME680_OS_8X);
    bme688.setHumidityOversampling(BME680_OS_2X);
    bme688.setPressureOversampling(BME680_OS_4X);
    bme688.setIIRFilterSize(BME680_FILTER_SIZE_3);
    bme688.setGasHeater(320, 150);
    Serial.println("[bme688] ok — gas sensing enabled");
  } else if (bme.begin(0x76) || bme.begin(0x77)) {
    bmeOk = true;
    useBME688 = false;
    Serial.println("[bme280] ok");
  } else {
    Serial.println("[bme] not found — continuing without temperature/humidity/pressure");
  }

  // --- Initialize BH1750 (optional) ---
  // `begin()` on this library returns bool. Default mode CONTINUOUS_HIGH_RES_MODE
  // measures every ~120ms at 1 lux resolution. Good enough for "indoor dim /
  // indoor bright / outdoor daylight" granularity.
  if (lightMeter.begin()) {
    bhOk = true;
    Serial.println("[bh1750] ok");
  } else {
    Serial.println("[bh1750] not found — continuing without light reading");
  }

  // --- Initialize MPU-6050 (optional) ---
  if (mpu.begin(0x68)) {
    mpuOk = true;
    // Tighten range + filter for quiet-room sensing. ±2g covers normal human
    // motion with the finest resolution; 21Hz low-pass kills high-freq noise.
    mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
    mpu.setGyroRange(MPU6050_RANGE_250_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("[mpu6050] ok");
  } else {
    Serial.println("[mpu6050] not found — continuing without motion state");
  }

  // --- Initialize DRV2605L (optional) — first output channel ---
  //
  // The DRV2605L drives the ERM coin motor — a tap, a heartbeat, a buzz.
  // The actual command path is a FreeRTOS long-poll task started at the end
  // of setup() (see commandPollTask). This block just initializes the chip
  // and fires one boot buzz for hardware verification.
  if (drv.begin()) {
    drvOk = true;
    drv.selectLibrary(1);               // 1 = ERM library A (default effects for ERM coin motors)
    drv.setMode(DRV2605_MODE_INTTRIG);  // internal trigger: fire on drv.go()
    Serial.println("[drv2605] ok");

    // Boot buzz — effect 1 = "Strong Click 100%". ~15ms, unmistakable tick.
    fireHaptic(1);
    Serial.println("[drv2605] boot buzz sent — if you felt it, hardware path is good");
  } else {
    Serial.println("[drv2605] not found — continuing without haptic output");
  }

  // --- Initialize SSD1306 OLED (optional) — face expressions ---
  //
  // 128x64 monochrome screen, second output channel after the haptic motor.
  // Haptic is a tick (duration, no information); the OLED carries a face
  // (information — expression, state, text).
  if (oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledOk = true;
    Serial.println("[oled] ok");
    drawFace(FACE_DEFAULT);
    Serial.println("[oled] boot face drawn (FACE_DEFAULT)");
  } else {
    Serial.println("[oled] not found — continuing without screen");
  }

  // --- Initialize KY-006 piezo buzzer — sound output ---
  //
  // No I2C probe to tell us whether it's really there — it's just a PWM
  // pin. We attach LEDC unconditionally and mark buzzerOk true; if the
  // hardware isn't wired, the user just hears no sound.
  // ledcAttach(pin, freq, resolution) is the arduino-esp32 3.x API —
  // replaces the older ledcSetup + ledcAttachPin pair.
  if (ledcAttach(BUZZER_PIN, 2000, 8)) {
    ledcWriteTone(BUZZER_PIN, 0);   // silence until we're told otherwise
    buzzerOk = true;
    Serial.println("[buzzer] LEDC attached to GPIO 25");

    // Boot beep — 2 kHz for 80ms. Short and distinctive; serves the same
    // role as the DRV2605 boot tick: "I'm alive, hardware path is good."
    ledcWriteTone(BUZZER_PIN, 2000);
    delay(80);
    ledcWriteTone(BUZZER_PIN, 0);
    Serial.println("[buzzer] boot beep sent — if you heard a short chirp, KY-006 is wired");
  } else {
    Serial.println("[buzzer] ledcAttach failed — continuing without sound");
  }

  // --- Initialize INMP441 microphone (optional) — sound input ---
  //
  // I2S is a streaming protocol with no "device probe" round-trip — there's
  // no equivalent of begin() returning false on missing hardware. The driver
  // install always succeeds as long as the GPIOs are valid; if the mic isn't
  // physically there, you just read zeros (or noise floor). We mark micOk
  // true on driver-install success and trust the caller to check the actual
  // dB readings if they want hardware verification.
  {
    i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    esp_err_t e1 = i2s_new_channel(&chanCfg, NULL, &i2sRxChan);

    i2s_std_config_t stdCfg = {
      .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(MIC_SAMPLE_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                      I2S_SLOT_MODE_MONO),
      .gpio_cfg = {
        .mclk = I2S_GPIO_UNUSED,                    // INMP441 doesn't need MCLK
        .bclk = (gpio_num_t)MIC_PIN_SCK,
        .ws   = (gpio_num_t)MIC_PIN_WS,
        .dout = I2S_GPIO_UNUSED,                    // we're RX-only
        .din  = (gpio_num_t)MIC_PIN_SD,
        .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
      },
    };
    esp_err_t e2 = (e1 == ESP_OK) ? i2s_channel_init_std_mode(i2sRxChan, &stdCfg) : ESP_FAIL;
    esp_err_t e3 = (e2 == ESP_OK) ? i2s_channel_enable(i2sRxChan) : ESP_FAIL;

    if (e1 == ESP_OK && e2 == ESP_OK && e3 == ESP_OK) {
      micOk = true;
      Serial.println("[inmp441] ok — I2S0 RX channel enabled on GPIO 14/15/32");
    } else {
      Serial.printf("[inmp441] init failed (new=%d, std=%d, enable=%d) — continuing without mic\n",
                    e1, e2, e3);
    }
  }

  // --- Initialize FSR 402 ---
  // analogRead() always returns a value; just log the baseline (should be
  // near 0 with no pressure) and mark ready.
  {
    int baseline = analogRead(FSR_PIN);
    fsrOk = true;
    Serial.printf("[fsr] GPIO %d baseline = %d (threshold = %d)\n",
                  FSR_PIN, baseline, FSR_TOUCH_THRESHOLD);
  }

  // --- Initialize NTC thermistor ---
  {
    int baseline = analogRead(THERM_PIN);
    if (baseline > 0 && baseline < 4095) {
      float r = THERM_R_FIXED * baseline / (4095.0f - baseline);
      float tK = 1.0f / (1.0f/THERM_T0 + (1.0f/THERM_B) * logf(r/THERM_R0));
      thermOk = true;
      Serial.printf("[therm] GPIO %d baseline ADC = %d (R=%.0f ohm, T=%.1f°C)\n",
                    THERM_PIN, baseline, r, tK - 273.15f);
    } else {
      thermOk = false;
      Serial.printf("[therm] GPIO %d invalid baseline ADC = %d — thermistor offline?\n",
                    THERM_PIN, baseline);
    }
  }

  // --- Connect to WiFi ---
  Serial.print("[wifi] connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - wifiStart > 30000) {
      Serial.println("\n[wifi] timeout — will keep trying in loop()");
      break;
    }
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\n[wifi] connected, IP=");
    Serial.println(WiFi.localIP());
  }

  // --- Start unified command long-poll task ---
  // One task handles haptic + face + beep by type-tagged JSON from the
  // bridge. See commandPollTask comment block for why this is one task and
  // not three (TLS-handshake heap budget).
  //
  // Only spin up if we have at least one output channel that could actually
  // fire (drv / oled / buzzer). Pinned to core 1 where Arduino's loop() lives
  // so the network stack doesn't cross cores per packet.
  if (drvOk || oledOk || buzzerOk) {
    xTaskCreatePinnedToCore(
      commandPollTask,   // task function
      "cmd_poll",        // task name (for debugging / freeRTOS tools)
      8192,              // stack size in bytes (HTTPClient + mbedTLS needs room)
      NULL,              // param passed to task function
      1,                 // priority (0=idle, 24=max; 1 is polite)
      NULL,              // task handle (we don't need to kill it later)
      1                  // pin to core 1
    );
    Serial.println("[cmd-poll] started on core 1");
  }
}

// ---- MOTION STATE HELPER -------------------------------------------------
//
// Sample the MPU-6050 `N` times back-to-back and classify the motion by the
// standard deviation of acceleration magnitude. Pure magnitude alone is
// deceptive (a device held perfectly still at any tilt still measures 1g);
// stddev over a short window captures how much the reading is WOBBLING,
// which tracks "movement" directly.
//
// Returns one of "still" / "walking" / "running" — the exact enum strings
// the bridge accepts (see SensorReading.motion.state in src/http-bridge.ts).

const char* sampleMotionState(float& outStddev) {
  const int N = 20;
  float sumMag = 0.0f, sumMag2 = 0.0f;
  for (int i = 0; i < N; i++) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    float ax = a.acceleration.x;
    float ay = a.acceleration.y;
    float az = a.acceleration.z;
    float mag = sqrtf(ax * ax + ay * ay + az * az);  // m/s²
    sumMag  += mag;
    sumMag2 += mag * mag;
    delay(10);  // 20 samples * 10ms = ~200ms window
  }
  float mean = sumMag / N;
  float variance = (sumMag2 / N) - (mean * mean);
  if (variance < 0.0f) variance = 0.0f;  // numeric guard
  outStddev = sqrtf(variance);

  if (outStddev < MOTION_STILL_MAX_STDDEV)   return "still";
  if (outStddev < MOTION_WALKING_MAX_STDDEV) return "walking";
  return "running";
}

// ---- NOISE LEVEL HELPER -------------------------------------------------
//
// Read MIC_READ_SAMPLES samples from the I2S DMA buffer, compute the RMS of
// the AC component (DC-blocked), and convert to dB SPL using the INMP441
// datasheet sensitivity rating: -26 dBFS at 94 dB SPL.
//
// Same shape as sampleMotionState: a continuous signal collapsed to ONE
// number for the bridge, plus an enum classification ("quiet"/"moderate"/
// "noisy"/"loud") for situational awareness without numeric tuning.
//
// Returns NAN on read failure or no data; caller should !isnan-check.

float readMicNoiseDb() {
  if (!micOk) return NAN;
  static int32_t samples[MIC_READ_SAMPLES];
  size_t bytesRead = 0;
  esp_err_t r = i2s_channel_read(i2sRxChan, samples, sizeof(samples),
                                 &bytesRead, pdMS_TO_TICKS(200));
  if (r != ESP_OK) return NAN;
  int n = bytesRead / sizeof(int32_t);
  if (n == 0) return NAN;

  // INMP441 outputs 24-bit two's complement, left-aligned in a 32-bit slot.
  // Right-shift by 8 sign-extends to a normal 24-bit signed integer.
  // Compute mean (DC bias) and sum-of-squares in one pass; subtract DC so
  // any constant offset doesn't inflate the RMS reading.
  double sum = 0.0, sumSq = 0.0;
  for (int i = 0; i < n; i++) {
    int32_t s = samples[i] >> 8;
    sum   += (double)s;
    sumSq += (double)s * (double)s;
  }
  double mean = sum / n;
  double variance = (sumSq / n) - (mean * mean);
  if (variance < 0.0) variance = 0.0;        // numeric guard
  double rms = sqrt(variance);
  if (rms < 1.0) rms = 1.0;                  // avoid log(0)

  // dBFS = 20*log10(rms / fullScale); dBSPL = dBFS + 120 (since the INMP441
  // sensitivity puts -26 dBFS at 94 dB SPL, i.e. 0 dBFS ≡ 120 dB SPL).
  double dbFs  = 20.0 * log10(rms / MIC_24BIT_FULL_SCALE);
  double dbSpl = dbFs + 120.0;
  return (float)dbSpl;
}

// Classify continuous dB SPL into one of the four buckets the bridge accepts.
// (See `noise_env` in SensorReading on the bridge side.)
const char* classifyNoise(float db) {
  if (isnan(db))                  return nullptr;
  if (db < NOISE_QUIET_MAX)       return "quiet";
  if (db < NOISE_MODERATE_MAX)    return "moderate";
  if (db < NOISE_NOISY_MAX)       return "noisy";
  return "loud";
}

// ---- HAPTIC OUTPUT HELPER -----------------------------------------------
//
// Small helper that actually commands the DRV2605L. Called by
// commandPollTask when it receives a {"type":"haptic"} command from the
// bridge. Boot buzz in setup() also calls through here.
//
// Thread safety: MPU-6050 reads in loop() and DRV2605L writes here both go
// through the Wire driver, which in ESP32 Arduino 2.x serializes access
// internally. So no explicit mutex needed.

void fireHaptic(int effectId) {
  if (!drvOk) return;
  if (effectId < 1 || effectId > 123) return;  // DRV2605 library range
  drv.setWaveform(0, effectId);
  drv.setWaveform(1, 0);   // end of sequence marker
  drv.go();
}

// Haptic echo via MPU during haptic firing.
//
// The default MPU configuration in setup() (21 Hz low-pass filter, 100 Hz
// sampling) is tuned for human-scale motion classification (still / walking /
// running). ERM coin motors vibrate at ~150-250 Hz, which is invisible to
// that configuration: the LP filter attenuates the band, and 100 Hz sampling
// is below Nyquist for the vibration frequency. To detect haptic output via
// the accelerometer, we briefly switch the MPU into a wide-band, fast-sample
// mode for the duration of one ~64 ms window, then switch back.
//
// We expose peak |a − g| in m/s² rather than RMS — for a brief vibration
// burst the peak is more diagnostic than the RMS, and it is the value that
// most closely answers "did the chip see the motor go off?"

struct HapticEcho {
  bool   valid;
  int    effect_id;
  float  peak_g;     // peak |a − g| in m/s² during the sample window
};
volatile HapticEcho lastHapticEcho = { false, 0, 0.0f };

float hapticEchoSample() {
  if (!mpuOk) return NAN;

  // Switch to wide-band, wide-range config for haptic detection.
  mpu.setFilterBandwidth(MPU6050_BAND_260_HZ);
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  delay(5);  // let the LP filter settle to new cutoff

  // Sample as fast as Wire allows; 64 reads × ~1 ms each ≈ 64 ms window.
  const int N = 64;
  const float G = 9.80665f;
  float maxDev = 0.0f;
  for (int i = 0; i < N; i++) {
    sensors_event_t a, g, t;
    mpu.getEvent(&a, &g, &t);
    float ax = a.acceleration.x;
    float ay = a.acceleration.y;
    float az = a.acceleration.z;
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    float dev = fabsf(mag - G);
    if (dev > maxDev) maxDev = dev;
    delay(1);
  }

  // Restore the human-motion-detection config used by sampleMotionState().
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  mpu.setAccelerometerRange(MPU6050_RANGE_2_G);

  return maxDev;
}

// ---- FACE RENDERING -----------------------------------------------------
//
// Each face is drawn from primitives (circles, arcs, lines, text) rather
// than a bitmap — costs a few more CPU cycles but every expression is
// hand-tunable as code and the whole library fits in the .ino without a
// separate .h of byte arrays.
//
// Layout convention (128x64 screen):
//   - Eyes at y≈24, centered horizontally around x=64 with ~48px separation
//     (left eye center x=40, right eye center x=88)
//   - Mouth at y≈48, centered x=64
//   - Decorations (Zzz, exclamation, etc.) in the corners

// Draw a parametric outline heart ♡ centered at (cx, cy) with given size.
// Uses the classic parametric equations: x = 16sin³t, y = 13cos−5cos2t−2cos3t−cos4t.
// Renders as connected line segments — works at any scale on the SSD1306.
void drawHeartOutline(int cx, int cy, int size) {
  const int steps = 60;
  float scale = size * 0.035f;
  int prevX = -1, prevY = -1;
  for (int i = 0; i <= steps; i++) {
    float t = (float)i / steps * 2.0f * PI;
    float sinT = sin(t);
    int x = cx + (int)(scale * 16.0f * sinT * sinT * sinT);
    int y = cy - (int)(scale * (13*cos(t) - 5*cos(2*t) - 2*cos(3*t) - cos(4*t)));
    if (prevX >= 0) {
      oled.drawLine(prevX, prevY, x, y, SSD1306_WHITE);
    }
    prevX = x;
    prevY = y;
  }
}

void drawFace(FaceExpression face) {
  if (!oledOk) return;
  currentFace = face;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);

  switch (face) {
    case FACE_DEFAULT:
      // Two solid-dot eyes and a gentle smile. "Here, happy to see you."
      oled.fillCircle(40, 24, 4, SSD1306_WHITE);
      oled.fillCircle(88, 24, 4, SSD1306_WHITE);
      oled.drawCircleHelper(64, 42, 10, 0xC, SSD1306_WHITE);
      break;

    case FACE_HAPPY:
      // Upside-down-U eyes (^ ^) + wide smile. Simple and uncluttered.
      oled.drawCircleHelper(40, 26, 7, 0x3, SSD1306_WHITE);
      oled.drawCircleHelper(88, 26, 7, 0x3, SSD1306_WHITE);
      oled.drawCircleHelper(64, 42, 12, 0xC, SSD1306_WHITE);
      break;

    case FACE_SHY:
      // Small ^^ closed eyes + generous blush + tiny smile. "Bashful."
      oled.drawCircleHelper(40, 26, 5, 0x3, SSD1306_WHITE);
      oled.drawCircleHelper(88, 26, 5, 0x3, SSD1306_WHITE);
      oled.fillCircle(22, 32, 6, SSD1306_WHITE);
      oled.fillCircle(106, 32, 6, SSD1306_WHITE);
      oled.drawCircleHelper(64, 42, 5, 0xC, SSD1306_WHITE);
      break;

    case FACE_LOVE:
      // ♡ᵔ ᵕ ᵔ♡ — soft arc eyes + gentle smile + outline hearts at cheeks
      // ᵔ eyes (top arcs, ◠ shape)
      oled.drawCircleHelper(44, 22, 6, 0x3, SSD1306_WHITE);
      oled.drawCircleHelper(84, 22, 6, 0x3, SSD1306_WHITE);
      // ᵕ smile (bottom arc, ◡ shape)
      oled.drawCircleHelper(64, 40, 7, 0xC, SSD1306_WHITE);
      // ♡♡ outline hearts at blush position
      drawHeartOutline(18, 32, 14);
      drawHeartOutline(110, 32, 14);
      break;

    case FACE_EXCITED:
      // 😆 — >< eyes (laughing so hard the eyes squeeze into cross/chevron
      // shapes) + a BIG D-shaped laughing mouth.
      // Left eye: > pointing right (two lines meeting at the right)
      oled.drawLine(32, 20, 44, 24, SSD1306_WHITE);
      oled.drawLine(32, 28, 44, 24, SSD1306_WHITE);
      // Right eye: < pointing left
      oled.drawLine(96, 20, 84, 24, SSD1306_WHITE);
      oled.drawLine(96, 28, 84, 24, SSD1306_WHITE);
      // Big D-mouth: wider top line + deeper bottom arc
      oled.drawLine(48, 40, 80, 40, SSD1306_WHITE);
      oled.drawCircleHelper(64, 40, 16, 0xC, SSD1306_WHITE);
      break;

    case FACE_SLEEPY:
      // Closed u-shape eyes + single dot mouth. "Tired but content."
      oled.drawCircleHelper(40, 28, 6, 0xC, SSD1306_WHITE);
      oled.drawCircleHelper(88, 28, 6, 0xC, SSD1306_WHITE);
      oled.fillCircle(64, 48, 1, SSD1306_WHITE);
      break;

    case FACE_RELAXED:
      // 😌 — gently closed ◡ ◡ eyes + subtle content smile. "Unwound, at ease."
      oled.drawCircleHelper(40, 26, 5, 0xC, SSD1306_WHITE);
      oled.drawCircleHelper(88, 26, 5, 0xC, SSD1306_WHITE);
      oled.drawCircleHelper(64, 44, 7, 0xC, SSD1306_WHITE);  // small smile
      break;

    case FACE_KISSING:
      // 😚 — closed ^^ eyes + pursed-lip "3" mouth. A literal "3" character
      // (size-2 text) makes the pursed-lip shape with almost no code.
      oled.drawCircleHelper(40, 26, 5, 0x3, SSD1306_WHITE);
      oled.drawCircleHelper(88, 26, 5, 0x3, SSD1306_WHITE);
      oled.setTextSize(2);
      oled.setCursor(58, 40);
      oled.print("3");
      oled.setTextSize(1);
      break;

    case FACE_GOODNIGHT: {
      // Sleepy face + 😴-style Zzz. Big Z is hand-drawn 9×9 (slightly
      // smaller than before, still clearly bigger than the size-1 z's).
      oled.drawCircleHelper(40, 28, 6, 0xC, SSD1306_WHITE);
      oled.drawCircleHelper(88, 28, 6, 0xC, SSD1306_WHITE);
      oled.fillCircle(64, 48, 1, SSD1306_WHITE);
      int zx = 102, zy = 11;
      oled.drawLine(zx,     zy,     zx + 8, zy,     SSD1306_WHITE);
      oled.drawLine(zx + 8, zy,     zx,     zy + 8, SSD1306_WHITE);
      oled.drawLine(zx,     zy + 8, zx + 8, zy + 8, SSD1306_WHITE);
      oled.setTextSize(1);
      oled.setCursor(114, 4);
      oled.print("z");
      oled.setCursor(120, 0);
      oled.print("z");
      break;
    }

    case FACE_ANGRY:
      // \  / angry slanted eyes + ⌢ frown.
      oled.drawLine(32, 20, 48, 28, SSD1306_WHITE);
      oled.drawLine(80, 28, 96, 20, SSD1306_WHITE);
      oled.drawCircleHelper(64, 52, 8, 0x3, SSD1306_WHITE);
      break;

    case FACE_WRONGED:
      // 😢 — V-shape closed crying eyes (squeezed shut) + big teardrop
      // coming off the left eye + small flat frown. The V eyes are the
      // whole "eyes clenched from crying" signal.
      // Left eye — \/ (two lines forming a V with point at bottom)
      oled.drawLine(32, 22, 40, 28, SSD1306_WHITE);
      oled.drawLine(40, 28, 48, 22, SSD1306_WHITE);
      // Right eye — same V
      oled.drawLine(80, 22, 88, 28, SSD1306_WHITE);
      oled.drawLine(88, 28, 96, 22, SSD1306_WHITE);
      // Big teardrop off the left eye: triangle tip + round belly
      oled.fillTriangle(38, 30, 42, 30, 40, 34, SSD1306_WHITE);
      oled.fillCircle(40, 38, 3, SSD1306_WHITE);
      // Small downturned mouth
      oled.drawCircleHelper(64, 52, 6, 0x3, SSD1306_WHITE);
      break;

    case FACE_SAD:
      // ☹️ — default round eyes + clear downturned frown.
      oled.fillCircle(40, 24, 4, SSD1306_WHITE);
      oled.fillCircle(88, 24, 4, SSD1306_WHITE);
      oled.drawCircleHelper(64, 52, 10, 0x3, SSD1306_WHITE);  // ⌢ frown
      break;

    case FACE_SURPRISED:
      // 😮 — default round filled eyes + open O mouth. Radius 8 (16px
      // diameter) feels more like a real "oh!" — r=9 was slightly too
      // mouthy, r=7 would be too timid.
      oled.fillCircle(40, 24, 4, SSD1306_WHITE);
      oled.fillCircle(88, 24, 4, SSD1306_WHITE);
      oled.drawCircle(64, 44, 8, SSD1306_WHITE);
      break;

    case FACE_BLANK:
      // 😶 — default round eyes + NO mouth. A blank stare: eyes present,
      // face present, but nothing to say. The absence is the expression.
      oled.fillCircle(40, 24, 4, SSD1306_WHITE);
      oled.fillCircle(88, 24, 4, SSD1306_WHITE);
      // (deliberately no mouth)
      break;

    case FACE_EXPRESSIONLESS:
      // 😑 — SHORT flat line eyes positioned closer together (eyes distance
      // 38 instead of 48) + LONG flat mouth. "Done. Over it."
      oled.drawLine(40, 24, 50, 24, SSD1306_WHITE);  // short left eye
      oled.drawLine(78, 24, 88, 24, SSD1306_WHITE);  // short right eye
      oled.drawLine(47, 48, 81, 48, SSD1306_WHITE);  // long flat mouth
      break;

    case FACE_SMUG:
      // 😏 — both eyes narrow slits at the SAME height (no asymmetry in
      // eyes; the asymmetry is all in the mouth). Mouth is mostly flat
      // with just the right corner flicked UP. Cleaner than the previous
      // curve-based attempt, which looked like a zigzag.
      oled.drawLine(32, 24, 48, 24, SSD1306_WHITE);
      oled.drawLine(80, 24, 96, 24, SSD1306_WHITE);
      // Flat mouth with right corner raised
      oled.drawLine(50, 48, 72, 48, SSD1306_WHITE);
      oled.drawLine(72, 48, 78, 42, SSD1306_WHITE);
      break;

    case FACE_PLEADING:
      // 🥺 — oversized round eyes (r=6, 50% bigger than default r=4) +
      // small zig-zag trembling mouth. Big eyes are the whole pleading
      // signal; the wobble underneath seals it.
      oled.fillCircle(40, 26, 6, SSD1306_WHITE);
      oled.fillCircle(88, 26, 6, SSD1306_WHITE);
      // Tiny trembling zig-zag mouth
      oled.drawLine(56, 48, 60, 50, SSD1306_WHITE);
      oled.drawLine(60, 50, 64, 48, SSD1306_WHITE);
      oled.drawLine(64, 48, 68, 50, SSD1306_WHITE);
      oled.drawLine(68, 50, 72, 48, SSD1306_WHITE);
      break;

    case FACE_COUNT:
      break;  // unreachable — enum sentinel
  }

  oled.display();
}

// Parse a name like "happy" / "default" into its FaceExpression value.
// Returns -1 on unknown, so the caller can reject without firing a face.
// Kept in sync with the bridge's FACE_EXPRESSIONS set.
int parseFaceExpression(const char* name) {
  if (strcmp(name, "default")        == 0) return FACE_DEFAULT;
  if (strcmp(name, "happy")          == 0) return FACE_HAPPY;
  if (strcmp(name, "shy")            == 0) return FACE_SHY;
  if (strcmp(name, "love")           == 0) return FACE_LOVE;
  if (strcmp(name, "excited")        == 0) return FACE_EXCITED;
  if (strcmp(name, "sleepy")         == 0) return FACE_SLEEPY;
  if (strcmp(name, "goodnight")      == 0) return FACE_GOODNIGHT;
  if (strcmp(name, "relaxed")        == 0) return FACE_RELAXED;
  if (strcmp(name, "kissing")        == 0) return FACE_KISSING;
  if (strcmp(name, "angry")          == 0) return FACE_ANGRY;
  if (strcmp(name, "wronged")        == 0) return FACE_WRONGED;
  if (strcmp(name, "sad")            == 0) return FACE_SAD;
  if (strcmp(name, "surprised")      == 0) return FACE_SURPRISED;
  if (strcmp(name, "blank")          == 0) return FACE_BLANK;
  if (strcmp(name, "expressionless") == 0) return FACE_EXPRESSIONLESS;
  if (strcmp(name, "smug")           == 0) return FACE_SMUG;
  if (strcmp(name, "pleading")       == 0) return FACE_PLEADING;
  return -1;
}

// ---- UNIFIED COMMAND LONG-POLL TASK -------------------------------------
//
// One task handles all three output channels — haptic + face + beep — by
// polling a single /command/poll endpoint that returns a tagged-union JSON
// body. The motivation for consolidating into one task instead of three is
// the engineering case study in §5.4 of the paper: separate long-poll
// tasks each held an HTTPS + mbedTLS context, and concurrent handshake
// state for three persistent + one transient sensor-POST session exhausted
// the ESP32's available heap.
//
// Wire format from bridge (tagged union):
//   {"type":"haptic","effect_id":N}
//   {"type":"face","expression":"happy"}
//   {"type":"beep","frequency":N,"duration_ms":M}
//   204 (empty body) on timeout — re-poll

void beepAt(int frequency, int durationMs) {
  if (!buzzerOk) return;
  if (frequency < 100 || frequency > 10000) return;
  if (durationMs <= 0 || durationMs > 5000) return;
  ledcWriteTone(BUZZER_PIN, frequency);
  vTaskDelay(pdMS_TO_TICKS(durationMs));
  ledcWriteTone(BUZZER_PIN, 0);   // silence
}

// Beep + listen. Used by commandPollTask to capture the audio-loop
// self-perception observation: drain stale audio, play tone for full
// duration, read DMA buffer. At read time the buffer contains the last
// ~64 ms of the beep window (DMA fills continuously while we sleep).
// Returns the dB SPL the mic heard, or NAN if the mic isn't initialized.
// Beep length unchanged.
//
// Echo result is stashed in `lastEcho` and reported up on the next
// /command/poll request as query-string params.

struct BeepEcho {
  bool   valid;
  int    frequency;
  int    duration_ms;
  float  noise_db;
};
volatile BeepEcho lastEcho = { false, 0, 0, NAN };

static void drainMicDma() {
  if (!micOk) return;
  static int32_t drain[256];
  size_t bytesRead;
  // Zero timeout — consume only what's already buffered, don't block.
  while (i2s_channel_read(i2sRxChan, drain, sizeof(drain),
                          &bytesRead, 0) == ESP_OK && bytesRead > 0) {
    // discard
  }
}

float beepAtAndListen(int frequency, int durationMs) {
  if (!buzzerOk) return NAN;
  if (frequency < 100 || frequency > 10000) return NAN;
  if (durationMs <= 0 || durationMs > 5000) return NAN;

  drainMicDma();
  ledcWriteTone(BUZZER_PIN, frequency);
  vTaskDelay(pdMS_TO_TICKS(durationMs));
  ledcWriteTone(BUZZER_PIN, 0);

  // After the tone ends, the DMA queue holds the last ~64 ms of the beep.
  // Read it and compute dB SPL.
  return micOk ? readMicNoiseDb() : NAN;
}

// Extract a quoted string value for a JSON key name from a flat body.
// Returns empty string if not found or malformed. Zero allocation beyond
// the Arduino String that substring() produces.
static String extractJsonString(const String& body, const char* key) {
  String needle = "\"";
  needle += key;
  needle += "\"";
  int idx = body.indexOf(needle);
  if (idx < 0) return String();
  int colon = body.indexOf(':', idx);
  if (colon < 0) return String();
  int firstQ = body.indexOf('"', colon);
  int lastQ  = body.indexOf('"', firstQ + 1);
  if (firstQ < 0 || lastQ <= firstQ) return String();
  return body.substring(firstQ + 1, lastQ);
}

// Extract a numeric value for a JSON key name from a flat body.
// Returns -1 on "not found" — caller should sanity-check the range.
static int extractJsonInt(const String& body, const char* key) {
  String needle = "\"";
  needle += key;
  needle += "\"";
  int idx = body.indexOf(needle);
  if (idx < 0) return -1;
  int colon = body.indexOf(':', idx);
  if (colon < 0) return -1;
  return atoi(body.c_str() + colon + 1);
}

void commandPollTask(void* param) {
  (void)param;
  Serial.println("[cmd-poll] task started");

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    String url = "https://";
    url += BRIDGE_HOST;
    url += "/command/poll?token=";
    url += BRIDGE_TOKEN;
    url += "&wait=25";
    // Piggyback any pending beep-echo onto this request, so the bridge
    // learns what the mic heard during the most recent beep. We send it
    // on the very next poll after the beep, then clear the slot.
    if (lastEcho.valid) {
      url += "&echo_freq=";        url += lastEcho.frequency;
      url += "&echo_duration_ms="; url += lastEcho.duration_ms;
      url += "&echo_noise_db=";    url += String(lastEcho.noise_db, 1);
      lastEcho.valid = false;
    }
    if (lastHapticEcho.valid) {
      url += "&hecho_effect=";     url += lastHapticEcho.effect_id;
      url += "&hecho_peak=";       url += String(lastHapticEcho.peak_g, 3);
      lastHapticEcho.valid = false;
    }

    HTTPClient http;
    http.setTimeout(30000);  // slightly > server's wait so we don't abort early
    http.begin(url);
    int code = http.GET();

    if (code == 200) {
      String body = http.getString();
      String type = extractJsonString(body, "type");

      if (type == "haptic") {
        int effectId = extractJsonInt(body, "effect_id");
        if (effectId > 0) {
          fireHaptic(effectId);
          // Sample MPU during the haptic to confirm it physically
          // registered. Wait 200 ms for the motor to spin up, then take a
          // 64 ms wide-band peak read. Total ~270 ms inside the ~1 s
          // effect window for the longer ERM patterns.
          vTaskDelay(pdMS_TO_TICKS(200));
          float peakG = hapticEchoSample();
          if (!isnan(peakG)) {
            lastHapticEcho.effect_id = effectId;
            lastHapticEcho.peak_g    = peakG;
            lastHapticEcho.valid     = true;
            Serial.printf("[cmd] haptic effect %d, MPU peak |a-g|=%.3f m/s^2\n",
                          effectId, peakG);
          } else {
            Serial.printf("[cmd] haptic effect %d (no MPU echo: MPU offline)\n",
                          effectId);
          }
        }
      } else if (type == "haptic_baseline") {
        // Noise-floor measurement: identical timing and sampling to a real
        // haptic echo, but the motor is NOT fired. Lets us measure the
        // accelerometer noise floor of the haptic-echo path under exactly
        // the same wide-band reconfiguration the real measurements use.
        // effect_id=0 in the echo denotes a baseline reading.
        vTaskDelay(pdMS_TO_TICKS(200));
        float peakG = hapticEchoSample();
        if (!isnan(peakG)) {
          lastHapticEcho.effect_id = 0;
          lastHapticEcho.peak_g    = peakG;
          lastHapticEcho.valid     = true;
          Serial.printf("[cmd] haptic baseline, MPU peak |a-g|=%.3f m/s^2\n",
                        peakG);
        } else {
          Serial.println("[cmd] haptic baseline (no MPU echo: MPU offline)");
        }
      } else if (type == "face") {
        String name = extractJsonString(body, "expression");
        if (name.length() > 0) {
          int parsed = parseFaceExpression(name.c_str());
          if (parsed >= 0) {
            drawFace((FaceExpression)parsed);
            Serial.printf("[cmd] face \"%s\"\n", name.c_str());
          } else {
            Serial.printf("[cmd] unknown face \"%s\"\n", name.c_str());
          }
        }
      } else if (type == "beep") {
        int freq = extractJsonInt(body, "frequency");
        int dur  = extractJsonInt(body, "duration_ms");
        if (freq > 0 && dur > 0) {
          Serial.printf("[cmd] beep %d Hz for %d ms\n", freq, dur);
          float echoDb = beepAtAndListen(freq, dur);
          if (!isnan(echoDb)) {
            // Stash for the next /command/poll request to ferry up to bridge.
            // Single-slot — if a second beep fires before the next poll round,
            // its echo overwrites the previous (latest wins, same as commands).
            lastEcho.frequency   = freq;
            lastEcho.duration_ms = dur;
            lastEcho.noise_db    = echoDb;
            lastEcho.valid       = true;
            Serial.printf("[cmd] beep echo: mic heard %.1f dB during the tone\n", echoDb);
          }
        }
      } else {
        Serial.printf("[cmd] unknown type \"%s\"\n", type.c_str());
      }
    } else if (code == 204) {
      // Long-poll timeout, no command pending. Normal, just re-poll.
    } else {
      Serial.printf("[cmd-poll] HTTP %d (%s), backing off\n",
                    code, http.errorToString(code).c_str());
      http.end();
      vTaskDelay(pdMS_TO_TICKS(3000));
      continue;
    }
    http.end();
    // Small yield between polls to avoid a 100% busy loop if the server
    // ever returns instantly on every request.
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ---- LOOP ----------------------------------------------------------------

void loop() {
  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] reconnecting...");
    WiFi.reconnect();
    delay(2000);
    return;
  }

  // Wait until the next scheduled post
  unsigned long now = millis();
  if (now - lastPostMs < POST_INTERVAL_MS) {
    delay(200);
    return;
  }
  lastPostMs = now;

  // --- Read sensors (each optional) ---
  float tempC       = NAN;
  float humPct      = NAN;
  float presHpa     = NAN;
  float gasResKOhms = NAN;  // BME688 only — gas resistance in kΩ
  if (bmeOk) {
    if (useBME688) {
      if (bme688.performReading()) {
        tempC       = bme688.temperature;
        humPct      = bme688.humidity;
        presHpa     = bme688.pressure / 100.0f;
        gasResKOhms = bme688.gas_resistance / 1000.0f;  // Ω -> kΩ
      }
    } else {
      tempC   = bme.readTemperature();
      humPct  = bme.readHumidity();
      presHpa = bme.readPressure() / 100.0f;  // Pa -> hPa
    }
  }

  float lightLux = NAN;
  if (bhOk) {
    lightLux = lightMeter.readLightLevel();
  }

  const char* motionState = nullptr;
  float motionStddev = 0.0f;
  if (mpuOk) {
    motionState = sampleMotionState(motionStddev);
  }

  float noiseDb = NAN;
  const char* noiseEnv = nullptr;
  if (micOk) {
    noiseDb  = readMicNoiseDb();
    noiseEnv = classifyNoise(noiseDb);
  }

  int fsrRaw = 0;
  bool touchDetected = false;
  if (fsrOk) {
    fsrRaw = analogRead(FSR_PIN);
    touchDetected = (fsrRaw > FSR_TOUCH_THRESHOLD);
  }

  int thermRaw = 0;
  float skinTempC = NAN;
  if (thermOk) {
    thermRaw = analogRead(THERM_PIN);
    if (thermRaw > 0 && thermRaw < 4095) {
      float r = THERM_R_FIXED * thermRaw / (4095.0f - thermRaw);
      float tK = 1.0f / (1.0f/THERM_T0 + (1.0f/THERM_B) * logf(r/THERM_R0));
      skinTempC = tK - 273.15f;
    }
  }

  // --- Log to serial (include stddev for tuning) ---
  Serial.printf(
    "[sensor] T=%.1fC H=%.0f%% P=%.0fhPa L=%.0flux N=%.0fdB(%s) motion=%s (stddev=%.2f)",
    tempC, humPct, presHpa, lightLux,
    noiseDb,
    noiseEnv ? noiseEnv : "?",
    motionState ? motionState : "unknown",
    motionStddev
  );
  if (useBME688 && !isnan(gasResKOhms)) {
    Serial.printf(" gas=%.1fkOhm", gasResKOhms);
  }
  if (fsrOk) {
    Serial.printf(" fsr=%d(%s)", fsrRaw, touchDetected ? "TOUCH" : "no");
  }
  if (thermOk && !isnan(skinTempC)) {
    Serial.printf(" skin=%.1fC", skinTempC);
  }
  Serial.println();

  // Nothing at all to post? Skip — don't generate empty requests.
  if (!bmeOk && !bhOk && !mpuOk && !micOk && !fsrOk && !thermOk) {
    Serial.println("[sensor] no sensors initialized, skipping post");
    return;
  }

  // --- Build the URL ---
  //
  // Flat query-string form — the bridge's buildReading() folds these into
  // nested environment/motion/biometric shape server-side.
  //
  // Path ends in `postCounter` — /sensor/update1, /sensor/update2, ... — so
  // every request is a unique URL (defeats upstream proxy dedup).
  postCounter++;

  String url = "https://";
  url += BRIDGE_HOST;
  url += "/sensor/update";
  url += postCounter;
  url += "?token=";
  url += BRIDGE_TOKEN;

  if (bmeOk && !isnan(tempC))   { url += "&temperature_c="; url += String(tempC, 2); }
  if (bmeOk && !isnan(humPct))  { url += "&humidity_pct=";  url += String(humPct, 1); }
  if (bmeOk && !isnan(presHpa)) { url += "&pressure_hpa=";  url += String(presHpa, 1); }
  if (useBME688 && !isnan(gasResKOhms)) {
    url += "&gas_resistance_kohms="; url += String(gasResKOhms, 1);
  }
  if (bhOk  && !isnan(lightLux)){ url += "&light_lux=";     url += String(lightLux, 1); }
  if (motionState)              { url += "&state=";         url += motionState; }
  if (micOk && !isnan(noiseDb)) { url += "&noise_db=";      url += String(noiseDb, 1); }
  if (noiseEnv)                 { url += "&noise_env=";     url += noiseEnv; }
  if (fsrOk)                    { url += "&fsr_raw=";        url += fsrRaw;
                                  url += "&touch_detected="; url += (touchDetected ? "true" : "false"); }
  if (thermOk && !isnan(skinTempC)) { url += "&skin_temp_c="; url += String(skinTempC, 1); }

  // --- Post ---
  HTTPClient http;
  http.setTimeout(5000);
  http.begin(url);
  int code = http.GET();
  if (code > 0) {
    String body = http.getString();
    Serial.printf("[post] %d %s\n", code, body.c_str());
  } else {
    Serial.printf("[post] ERROR: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}
