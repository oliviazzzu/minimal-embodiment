#!/usr/bin/env python3
"""Feature extraction v0.2 -- baseline-relative features from raw sensor logs.

Extracts 8 features per sample from a 10-minute (60-row) window,
computed relative to the last 5 minutes (30 rows) of each baseline.
Outputs features_v0.2.csv.
"""
import glob
import os
from datetime import datetime

import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
WINDOW = 60        # rows = 10 min @ 10 s/row
BASELINE_REF = 30  # last 30 rows (5 min) of baseline as reference
GAP_SEC = 120      # >2 min gap in baseline files = new segment

PERFUMES = {"black_opium", "bluebell", "blackberry_bay"}
TERPENES = {"lemon", "orange", "mint"}
NON_SCENT = {"baseline", "air_out"}
EXCLUDE = ("coffee", "messy")


def coarse(s):
    if s in PERFUMES:
        return "perfume"
    if s in TERPENES:
        return "fresh_plant"
    return s


def feats(base_df, expo_df):
    """Compute baseline-relative and temporal features."""
    base = base_df.tail(BASELINE_REF) if len(base_df) > BASELINE_REF else base_df
    g0 = base.gas_kohms.mean()
    h0 = base.humidity_pct.mean()
    t0 = base.temperature_c.mean()
    w = expo_df.iloc[:WINDOW]
    g = w.gas_kohms.to_numpy()
    h = w.humidity_pct.to_numpy()

    gas_peak_d = float(g.max()) - g0
    gas_range_d = float(g.max() - g.min())
    head = g[:15] if len(g) >= 15 else g
    gas_slope = float((head[-1] - head[0]) / max(len(head) - 1, 1))

    tail = g[-15:] if len(g) >= 15 else g[-5:]
    gas_recovery = (tail.mean() - g.min()) / max(abs(g.min() - g0), 0.1)
    gas_trough_pct = (float(g.min()) - g0) / g0 * 100 if g0 > 0 else 0.0

    import pandas as _pd
    gas_skew = float(_pd.Series(g).skew())
    h_tail = h[-15:] if len(h) >= 15 else h[-5:]
    humid_recovery = (h_tail.mean() - h.max()) / max(abs(h.max() - h0), 0.1)
    humid_std = float(np.std(h - h0))
    mid = len(g) // 2
    gas_late_slope = float(np.polyfit(range(len(g[mid:])), g[mid:], 1)[0]) if len(g[mid:]) > 2 else 0.0

    gas_std = float(np.std(g))
    time_to_trough = int(np.argmin(g))

    return {
        "gas_trough_d": float(g.min()) - g0,
        "gas_mean_d":   float(g.mean()) - g0,
        "humid_peak_d": w.humidity_pct.max() - h0,
        "humid_mean_d": w.humidity_pct.mean() - h0,
        "temp_d":       w.temperature_c.mean() - t0,
        "gas_peak_d":   gas_peak_d,
        "gas_range_d":  gas_range_d,
        "gas_slope":    gas_slope,
        "gas_recovery": gas_recovery,
        "gas_trough_pct": gas_trough_pct,
        "gas_skew":     gas_skew,
        "humid_recovery": humid_recovery,
        "humid_std":    humid_std,
        "gas_late_slope": gas_late_slope,
        "gas_std":      gas_std,
        "time_to_trough": time_to_trough,
    }


def runs(labels):
    out, s = [], 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[s]:
            out.append((labels[s], s, i))
            s = i
    return out


def time_split(df):
    ts = [datetime.fromisoformat(x) for x in df.timestamp_iso]
    cuts = [0] + [i for i in range(1, len(ts)) if (ts[i] - ts[i - 1]).total_seconds() > GAP_SEC] + [len(df)]
    return [df.iloc[cuts[k]:cuts[k + 1]] for k in range(len(cuts) - 1)]


def stem(fn):
    """smell_lemon_2026-07-01_2.csv -> lemon_2026-07-01_2"""
    return fn[len("smell_"):].rsplit(".csv", 1)[0]


rows = []
for path in sorted(glob.glob(os.path.join(DATA, "smell_*.csv"))):
    fn = os.path.basename(path)
    if any(x in fn for x in EXCLUDE):
        continue
    df = pd.read_csv(path)
    rl = runs(df.label.tolist())
    scents = sorted({l for l, _, _ in rl} - NON_SCENT)

    # Baseline-only files: may contain multiple segments (split by time gap)
    if not scents:
        parts = time_split(df)
        tags = ["aft", "eve", "s3", "s4", "s5"]
        for si, part in enumerate(parts):
            sess = f"baseline_{stem(fn).split('_')[-1]}" + (f"_{tags[si]}" if len(parts) > 1 else "")
            W = BASELINE_REF + WINDOW  # 30 + 60 = 90 rows per sample
            n = 0
            for s in range(0, len(part) - W + 1, W):
                if n >= 4:
                    break
                ch = part.iloc[s:s + W]
                rows.append({"source_file": fn, "session": sess, "scent": "baseline",
                             "label": "baseline", **feats(ch.iloc[:BASELINE_REF], ch.iloc[BASELINE_REF:])})
                n += 1
        continue

    # Scent files: each baseline -> scent cycle = one trial
    ti = 0
    for k in range(len(rl) - 1):
        l, a, b = rl[k]
        l2, a2, b2 = rl[k + 1]
        if l == "baseline" and l2 not in NON_SCENT:
            sess = f"{stem(fn)}_t{ti}"
            rows.append({"source_file": fn, "session": sess, "scent": l2,
                         "label": coarse(l2), **feats(df.iloc[a:b], df.iloc[a2:b2])})
            ti += 1


feat = pd.DataFrame(rows)
os.makedirs(OUT, exist_ok=True)
feat.to_csv(os.path.join(OUT, "features_v0.2.csv"), index=False)

print(f"{len(feat)} samples, window = {WINDOW} rows ({WINDOW*10//60} min), baseline ref = {BASELINE_REF} rows ({BASELINE_REF*10//60} min)")
print("\nSamples per class:")
print(feat.label.value_counts().to_string())
print("\nSamples per session:")
print(feat.groupby(["label", "session"]).size().to_string())
