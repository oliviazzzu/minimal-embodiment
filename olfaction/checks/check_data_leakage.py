#!/usr/bin/env python3
"""
Verify that group-aware evaluation catches single-source leakage.

This check demonstrates why sample-level cross-validation is insufficient
for small sensor datasets: when all samples of a class come from a single
recording, LOO inflates accuracy because within-recording samples share
environmental noise characteristics.

The v1 dataset has 3 independent baseline sessions, so session-level
grouping no longer causes baseline recall to collapse. This script
confirms that by comparing LOO vs LOGO recall side by side.
"""
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import LeaveOneOut, LeaveOneGroupOut
from sklearn.metrics import accuracy_score, recall_score

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
FEATURES = ["gas_trough_d", "gas_mean_d", "humid_peak_d", "humid_mean_d", "temp_d"]

df = pd.read_csv(os.path.join(DATA, "features.csv"))
X = df[FEATURES].values
y = df["label"].values
groups = df["session"].values
classes = sorted(np.unique(y))


def fresh_model():
    return RandomForestClassifier(n_estimators=400, class_weight="balanced", random_state=0)


# Data structure
print("=" * 60)
print("DATA STRUCTURE")
print("=" * 60)
print(f"Total samples: {len(df)}")
for c in classes:
    sub = df[df.label == c]
    print(f"  {c:10s}: {len(sub)} samples across {sub.session.nunique()} sessions")

# Leave-one-out (sample-level)
loo_pred = np.empty(len(y), dtype=object)
for tr, te in LeaveOneOut().split(X):
    m = fresh_model().fit(X[tr], y[tr])
    loo_pred[te[0]] = m.predict(X[te])[0]

# Leave-one-session-out (group-level)
logo_pred = np.empty(len(y), dtype=object)
for tr, te in LeaveOneGroupOut().split(X, y, groups):
    m = fresh_model().fit(X[tr], y[tr])
    logo_pred[te] = m.predict(X[te])

# Side-by-side comparison
print(f"\n{'':10s} {'LOO':>8s} {'LOGO':>8s}")
for c in classes:
    mask = y == c
    loo_r = (loo_pred[mask] == c).mean()
    logo_r = (logo_pred[mask] == c).mean()
    print(f"  {c:10s} {loo_r:8.3f} {logo_r:8.3f}")

loo_acc = accuracy_score(y, loo_pred)
logo_acc = accuracy_score(y, logo_pred)
print(f"\n  {'overall':10s} {loo_acc:8.3f} {logo_acc:8.3f}")
print("\nIf LOGO recall matches LOO recall for all classes,")
print("there is no detectable session-level leakage.")
