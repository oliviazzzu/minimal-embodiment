#!/usr/bin/env python3
"""
Train a RandomForest scent classifier and evaluate with two levels of
group-aware cross-validation:

  1. Leave-one-out (sample-level baseline — may leak within-session similarity)
  2. Leave-one-session-out (honest — no recording shared between train/test)

Prints confusion matrices, per-class recall, and feature importances.
"""
import os
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import LeaveOneOut, LeaveOneGroupOut, cross_val_predict
from sklearn.metrics import accuracy_score, confusion_matrix

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
feat = pd.read_csv(os.path.join(DATA, "features.csv"))
F = ["gas_trough_d", "gas_mean_d", "humid_peak_d", "humid_mean_d", "temp_d"]
X = feat[F].values
y = feat["label"].values
groups = feat["session"].values
classes = ["baseline", "orange", "perfume"]

rf = RandomForestClassifier(n_estimators=400, class_weight="balanced", random_state=0)


def show(title, yp):
    acc = accuracy_score(y, yp)
    cm = confusion_matrix(y, yp, labels=classes)
    print(f"\n{title}: {(y == yp).sum()}/{len(y)} = {acc:.0%}")
    print("              " + "".join(f"{c:>10}" for c in classes) + "   recall")
    for i, c in enumerate(classes):
        rec = cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0
        print(f"  {c:>10}  " + "".join(f"{cm[i, j]:>10}" for j in range(len(classes))) + f"    {rec:.2f}")


print(f"{len(feat)} samples | {len(set(groups))} sessions | classes {dict(pd.Series(y).value_counts())}")
show("Leave-one-out (sample-level, for comparison only)",
     cross_val_predict(rf, X, y, cv=LeaveOneOut()))
show("Leave-one-session-out (group-aware, honest)",
     cross_val_predict(rf, X, y, cv=LeaveOneGroupOut(), groups=groups))

rf.fit(X, y)
print("\nFeature importances (full-data fit):")
for n, v in sorted(zip(F, rf.feature_importances_), key=lambda t: -t[1]):
    print(f"  {n:14} {v:.3f}")
