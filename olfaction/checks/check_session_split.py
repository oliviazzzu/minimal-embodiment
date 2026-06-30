#!/usr/bin/env python3
"""
Confidence and noise-robustness checks for the scent classifier.

1. Prediction confidence: LOO predict_proba — mean, median, min, and any
   low-confidence (<0.6) samples.
2. Gaussian noise injection: scale noise to each feature's std at 5%, 10%,
   20% levels, repeat 20 runs per level, report mean/std/min/max accuracy.
3. Group-aware leave-one-session-out for reference.

Stable accuracy under noise and high mean confidence indicate robust
decision boundaries, not overfitting to a small dataset.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import LeaveOneOut, LeaveOneGroupOut

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
FEATS = ["gas_trough_d", "gas_mean_d", "humid_peak_d", "humid_mean_d", "temp_d"]
df = pd.read_csv(os.path.join(DATA, "features.csv"))
X = df[FEATS].values
y = df["label"].values
groups = df["session"].values


def make():
    return RandomForestClassifier(n_estimators=400, class_weight="balanced", random_state=0)


print(f"Dataset: {len(df)} samples, {len(set(groups))} sessions, "
      f"classes={dict(pd.Series(y).value_counts())}")

# (a) Prediction confidence via sample-level LOO
ptrue = []
low = []
nc = 0
for tr, te in LeaveOneOut().split(X):
    m = make()
    m.fit(X[tr], y[tr])
    proba = m.predict_proba(X[te])[0]
    cls = list(m.classes_)
    pred = cls[int(np.argmax(proba))]
    true = y[te][0]
    pt = float(proba[cls.index(true)])
    ptrue.append(pt)
    nc += int(pred == true)
    if pt < 0.6:
        low.append((str(df.iloc[te[0]]["scent"]), round(pt, 3)))

ptrue = np.array(ptrue)
print(f"\n[confidence] LOO accuracy {nc}/{len(df)} = {nc / len(df) * 100:.1f}%")
print(f"  P(true): mean={ptrue.mean():.3f} median={np.median(ptrue):.3f} min={ptrue.min():.3f}")
print(f"  low-confidence (<0.6): {low if low else 'none'}")

# (b) Gaussian noise robustness
def loo_acc(Xin):
    n = 0
    for tr, te in LeaveOneOut().split(Xin):
        m = make()
        m.fit(Xin[tr], y[tr])
        n += int(m.predict(Xin[te])[0] == y[te][0])
    return n / len(Xin)


fstd = X.std(axis=0, ddof=0)
master = np.random.default_rng(12345)
print("\n[noise robustness] mean over 20 reps/level")
for lv in [0.05, 0.10, 0.20]:
    accs = np.array([
        loo_acc(X + np.random.default_rng(
            master.integers(0, 2**31 - 1)
        ).normal(0, 1, X.shape) * (fstd * lv))
        for _ in range(20)
    ])
    print(f"  {lv * 100:4.0f}%: mean={accs.mean() * 100:5.1f}% "
          f"std={accs.std() * 100:4.1f}% "
          f"min={accs.min() * 100:.0f}% max={accs.max() * 100:.0f}%")
print(f"    0%: {loo_acc(X) * 100:.1f}% (clean)")

# (c) Group-aware reference
nc = 0
tot = 0
for tr, te in LeaveOneGroupOut().split(X, y, groups):
    m = make()
    m.fit(X[tr], y[tr])
    pr = m.predict(X[te])
    nc += int((pr == y[te]).sum())
    tot += len(te)
print(f"\n[group-aware] leave-one-session-out: {nc}/{tot} = {nc / tot * 100:.1f}%")
