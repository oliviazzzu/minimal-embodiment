# Model Card: Scent Classifier v0.1

## Model details

- **Type:** RandomForestClassifier (scikit-learn 1.6.1)
- **Parameters:** 400 trees, class_weight="balanced", random_state=0
- **Input:** 5 signed-delta features from BME688 gas/humidity/temperature
- **Output:** one of 3 classes — `baseline`, `orange`, `perfume`
- **File:** `models/rf_orange_perfume_v0.1.joblib`

## Intended use

Proof-of-concept scent classification for a single BME688 sensor in a
controlled indoor environment. Designed to demonstrate feasibility and
establish a reliable small-sample evaluation methodology, not for
production deployment.

## Training data

24 samples from recordings collected 29 May – 8 June 2026:
- 12 baseline (ambient air, 3 independent sessions)
- 3 orange (fresh orange, 3 separate days)
- 9 perfume (Black Opium, Bluebell, Blackberry Bay)

See `data/README.md` for feature definitions.

## Evaluation

Three-level group-aware cross-validation:

| Level | Accuracy | Baseline recall |
|---|---|---|
| Leave-one-out | 96% | 1.00 |
| Leave-one-session-out | 96% | 1.00 |
| Leave-one-sitting-out | 100% | 1.00 |

Stable accuracy across grouping levels indicates no session-level leakage.
See `results/validation_summary.md` for full results.

## Limitations

- Trained on data from a single sensor, single room, single operator.
- Three classes only; no hard-negative or novelty detection.
- Small sample size (n=24) — results indicate class separability, not
  proven cross-environment generalisation.

## How to load

```python
import joblib
rf = joblib.load("models/rf_orange_perfume_v0.1.joblib")
# Feature order: ['gas_trough_d', 'gas_mean_d', 'humid_peak_d', 'humid_mean_d', 'temp_d']
```

## Dependencies

- Python 3.9.6
- scikit-learn 1.6.1
- numpy 2.0.2
- pandas 2.3.3
