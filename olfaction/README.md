# Olfactory Classification Prototype

Scent classification from BME688 gas-sensor signals on the
[minimal self-perceiving embodiment](../) platform.

A RandomForest classifier distinguishes three scent classes — **baseline**
(ambient air), **orange**, and **perfume** — from five signed-delta
features (gas resistance, humidity, temperature) computed relative to
each recording's own baseline. Multi-level group-aware cross-validation
(sample → session → sitting) yields **96–100% accuracy** with no
detectable session-level leakage.

## Quick start

```bash
# Install dependencies
pip install scikit-learn==1.6.1 pandas==2.3.3 numpy==2.0.2

# Train and evaluate
python src/train.py

# Strictest evaluation (leave-one-sitting-out)
python src/evaluate.py

# Run validation checks
python checks/check_data_leakage.py
python checks/check_session_split.py
```

## Structure

```
olfaction/
  README.md               ← you are here
  model_card.md            ML model card (intended use, limitations)
  data/
    features.csv           24-sample feature table (signed-delta)
    README.md              column definitions, collection protocol
  models/
    rf_orange_perfume_v0.1.joblib   trained RandomForest model
  src/
    extract_features.py    feature extraction from raw recordings
    train.py               training + two-level cross-validation
    evaluate.py            strictest evaluation (leave-one-sitting-out)
  results/
    validation_summary.md  full results table + robustness analysis
    feature_scatter.png    2D feature space visualisation
  checks/
    check_data_leakage.py  LOO vs LOGO recall comparison
    check_session_split.py confidence + noise-robustness checks
```

## Key design decisions

1. **Deltas, not absolutes.** Features are changes relative to each
   recording's own baseline, cancelling sensor drift by construction.
2. **Fixed 13-minute window.** Every sample is measured over the same
   duration, eliminating comparison bias from unequal recording lengths.
3. **Three-level group-aware evaluation.** Sample-level CV is
   insufficient for small sensor datasets — recordings share
   environmental noise that inflates accuracy. Session-level and
   sitting-level grouping expose this; stable accuracy across all three
   levels indicates genuine odour discrimination.

## Limitations and next steps

This prototype demonstrates feasibility on 24 samples from a single
sensor in one room. Extensions include:

- Hard-negative classes (non-target odours that test discriminative
  precision)
- Novelty detection (abstaining on unfamiliar scents)
- Cross-environment and cross-sensor generalisation
- Real-time classification on the ESP32

## Citation

This work is part of the minimal embodiment project:

> Zhu, O. (2026). *A Minimal Self-Perceiving Embodiment for Large
> Language Models.* Zenodo. DOI:
> [10.5281/zenodo.19903098](https://doi.org/10.5281/zenodo.19903098)
