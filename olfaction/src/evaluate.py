#!/usr/bin/env python3
"""
Strictest evaluation: leave-one-sitting-out cross-validation.

A "sitting" groups consecutive trials from the same recording session
(e.g. three perfume sprays in a row). This ensures the test fold shares
no experimental sitting with the training set — the most conservative
grouping level.

Three-level convergence (LOO → session → sitting) with stable accuracy
indicates no session-level leakage.
"""
import os
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict
from sklearn.metrics import accuracy_score, confusion_matrix

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
feat = pd.read_csv(os.path.join(DATA, "features.csv"))
F = ["gas_trough_d", "gas_mean_d", "humid_peak_d", "humid_mean_d", "temp_d"]
X = feat[F].values
y = feat["label"].values
# Sitting = session without trial index: consecutive sprays from the same
# recording are bundled into one group
feat["sitting"] = feat["session"].str.replace(r"_t\d+$", "", regex=True)
sit = feat["sitting"].values
classes = ["baseline", "orange", "perfume"]
rf = RandomForestClassifier(n_estimators=400, class_weight="balanced", random_state=0)

print(f"Sitting groups ({len(set(sit))} total):")
print(feat.groupby(["label", "sitting"]).size().to_string())

yp = cross_val_predict(rf, X, y, cv=LeaveOneGroupOut(), groups=sit)
acc = accuracy_score(y, yp)
cm = confusion_matrix(y, yp, labels=classes)
print(f"\nLeave-one-sitting-out (strictest): {(y == yp).sum()}/{len(y)} = {acc:.0%}")
print("              " + "".join(f"{c:>10}" for c in classes) + "   recall")
for i, c in enumerate(classes):
    rec = cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0
    print(f"  {c:>10}  " + "".join(f"{cm[i, j]:>10}" for j in range(len(classes))) + f"    {rec:.2f}")
