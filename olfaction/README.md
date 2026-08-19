# Olfactory Classification Prototype

Scent classification from BME688 gas-sensor signals on the
[minimal self-perceiving embodiment](../) platform.

## Enabling the classifier on the bridge

The classifier ships as an opt-in experimental prototype. Start the
bridge with `ENABLE_SMELL=1` (and a BME688 wired) to run it; the result
appears in `/sensor/status` and room snapshots as a `smell` block. It
was trained on controlled near-sensor exposures from a single sensor —
see the [model card](model_card.md) for its limits.

## v0.2 — Neural Network (current)

A compact neural network (8→16→3→3, 207 parameters) classifies three
scent classes — **baseline** (ambient air), **fresh_plant**
(lemon/orange/mint merged), and **perfume** — from eight
baseline-relative features. Lemon, orange, and mint all release
terpene-class VOCs that produce overlapping responses on a single MOX
element; normalising by baseline R₀ confirmed they are
indistinguishable, so they are merged into one class.

Three-level group-aware cross-validation (sample → session → date)
yields **92–94% accuracy** across all levels, including leave-one-date-out
which crosses a sensor-drift epoch. Results are mean ± std over 20 random
seeds.

| Level | Groups | Accuracy | Balanced accuracy |
|---|---|---|---|
| Leave-one-out | 46 | 93.2% ± 2.9% | 91.6% ± 3.2% |
| Leave-one-session-out | 36 | 94.2% ± 2.8% | 93.3% ± 3.4% |
| Leave-one-date-out | 9 | 92.7% ± 4.6% | 90.8% ± 6.5% |

```bash
# Install dependencies
pip install torch scikit-learn pandas numpy

# Evaluate (reproduces the table above)
python src/evaluate_v0.2.py

# Export model to JSON
python src/export_nn.py
```

## v0.1 — Random Forest

The initial classifier: a RandomForest distinguishing **baseline**,
**orange**, and **perfume** from five signed-delta features (24 samples).
Multi-level group-aware cross-validation (sample → session → sitting)
yielded **96–100% accuracy**. See the `v1.0-paper` git tag for the
corresponding code snapshot.

```bash
pip install scikit-learn==1.6.1 pandas numpy
python src/train.py
python src/evaluate.py
```

## Structure

```
olfaction/
  README.md               ← you are here
  model_card.md            ML model card (v0.1 + v0.2)

  data/
    features.csv           24-sample feature table (v0.1, RF)
    features_v0.2.csv      46-sample feature table (v0.2, NN)
    README.md              column definitions, collection protocol

  models/
    rf_orange_perfume_v0.1.joblib   trained RF model (v0.1)
    nn_3class_v0.2.json             trained NN model (v0.2, 7.7 KB)

  src/
    extract_features.py    feature extraction (v0.1)
    train.py               RF training + two-level CV (v0.1)
    evaluate.py            RF leave-one-sitting-out (v0.1)
    extract_features_v0.2.py  feature extraction (v0.2, 10-min window)
    evaluate_v0.2.py            NN three-level CV (v0.2)
    export_nn.py              NN export to JSON (v0.2)

  results/
    validation_summary.md  v0.1 results table
    feature_scatter.png    v0.1 2D feature space visualisation

  checks/
    check_data_leakage.py  v0.1 LOO vs LOGO recall comparison
    check_session_split.py v0.1 confidence + noise-robustness checks
```

## Key changes from v0.1 to v0.2

1. **Neural network replaces Random Forest** for real-time deployment
   (<1 ms inference from a 7.7 KB JSON file, no dependencies).
2. **Three terpene classes merged.** Lemon, orange, and mint are
   indistinguishable on a single MOX element — all release terpene-class
   VOCs and overlap completely in feature space.
3. **Train/serve alignment.** Training and deployment now use the same
   10-minute feature extraction window.
4. **Date-level evaluation.** A new leave-one-date-out level exposes
   class-date confounding that sub-date groupings cannot detect.
5. **Drift diagnosis.** Alcohol appeared 100% separable from perfume on
   absolute features, but only 56% (chance level) on drift-normalised
   features — both produce the same reducing reaction on a single MOX
   element.

## Citation

This work is part of the minimal embodiment project:

> Zhu, O. (2026). *A Minimal Self-Perceiving Embodiment for Large
> Language Models.* Zenodo. DOI:
> [10.5281/zenodo.19903098](https://doi.org/10.5281/zenodo.19903098)
