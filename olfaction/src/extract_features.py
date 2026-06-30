#!/usr/bin/env python3
"""
Feature extraction for scent classification from BME688 gas-sensor recordings.

Each recording alternates baseline (clean air) and exposure (odour source
near the sensor) segments. For each exposure, five signed-delta features are
computed relative to the preceding baseline's mean, cancelling sensor drift
and day-to-day offsets by construction.

Two key design decisions:
  1. Fixed window: only the first WINDOW rows (≈ 13 min) of each exposure
     are used, so every sample is measured over the same duration.
  2. Session-aware grouping: each continuous recording is one session;
     baseline files with >2 min gaps are split into separate sessions.
     This enables group-aware cross-validation that avoids leaking
     within-recording similarity.

Note: raw sensor recordings are not included in this repository.
The output of this script (data/features.csv) is provided directly.
This script is included for methodological transparency.
"""
import glob
import os
from datetime import datetime

import pandas as pd

DATA_DIR = os.environ.get("SMELL_DATA_DIR", ".")
OUT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOW = 156      # rows = 13 min @ 5 s/row; <= shortest exposure (179 rows)
GAP_SEC = 120     # time gap > 2 min in a baseline file = new session

PERFUMES = {"black_opium", "bluebell", "blackberry_bay"}
NON_SCENT = {"baseline", "air_out"}
EXCLUDE = ("coffee", "watermelon", "messy")


def coarse(s):
    return "perfume" if s in PERFUMES else s


def feats(base_df, expo_df):
    """Five signed-delta features over a fixed window."""
    g0 = base_df.gas_kohms.mean()
    h0 = base_df.humidity_pct.mean()
    t0 = base_df.temperature_c.mean()
    w = expo_df.iloc[:WINDOW]
    return {
        "gas_trough_d": w.gas_kohms.min() - g0,
        "gas_mean_d":   w.gas_kohms.mean() - g0,
        "humid_peak_d": w.humidity_pct.max() - h0,
        "humid_mean_d": w.humidity_pct.mean() - h0,
        "temp_d":       w.temperature_c.mean() - t0,
    }


def runs(labels):
    out, s = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[s]:
            out.append((labels[s], s, i))
            s = i
    return out


def time_split(df):
    """Split a recording at time gaps > GAP_SEC into separate sessions."""
    ts = [datetime.fromisoformat(x) for x in df.timestamp_iso]
    cuts = ([0] +
            [i for i in range(1, len(ts))
             if (ts[i] - ts[i - 1]).total_seconds() > GAP_SEC] +
            [len(df)])
    return [df.iloc[cuts[k]:cuts[k + 1]] for k in range(len(cuts) - 1)]


rows = []
for path in sorted(glob.glob(os.path.join(DATA_DIR, "smell_*.csv"))):
    fn = os.path.basename(path)
    if any(x in fn for x in EXCLUDE):
        continue
    df = pd.read_csv(path)
    date = fn.replace("smell_", "").split("_")[-1].replace(".csv", "")
    rl = runs(df.label.tolist())
    scents = sorted({l for l, _, _ in rl} - NON_SCENT)

    # Baseline-only files: may contain multiple sessions (split by time gap)
    if not scents:
        parts = time_split(df)
        tags = ["aft", "eve", "s3", "s4", "s5"]
        for si, part in enumerate(parts):
            sess = f"baseline_{date}" + (f"_{tags[si]}" if len(parts) > 1 else "")
            W, REF, n = 30, 10, 0
            for s in range(0, len(part) - W + 1, W):
                if n >= 4:
                    break
                ch = part.iloc[s:s + W]
                rows.append({"source_file": fn, "session": sess, "scent": "baseline",
                             "label": "baseline", **feats(ch.iloc[:REF], ch.iloc[REF:])})
                n += 1
        continue

    # Scent files: each baseline→scent cycle = one trial = one session
    ti = 0
    for k in range(len(rl) - 1):
        l, a, b = rl[k]
        l2, a2, b2 = rl[k + 1]
        if l == "baseline" and l2 not in NON_SCENT:
            sess = f"{l2}_{date}_t{ti}"
            rows.append({"source_file": fn, "session": sess, "scent": l2,
                         "label": coarse(l2), **feats(df.iloc[a:b], df.iloc[a2:b2])})
            ti += 1


feat = pd.DataFrame(rows)
os.makedirs(os.path.join(OUT_DIR, "data"), exist_ok=True)
feat.to_csv(os.path.join(OUT_DIR, "data", "features.csv"), index=False)

print(f"{len(feat)} samples, window = {WINDOW} rows (13 min)")
print("\nSamples per class:")
print(feat.label.value_counts().to_string())
print("\nSamples per session:")
print(feat.groupby(["label", "session"]).size().to_string())
