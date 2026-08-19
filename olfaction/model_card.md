# Model Card: Scent Classifier

## v0.2 — Neural Network (current)

### Model details

- **Type:** Fully connected neural network (PyTorch 2.8.0)
- **Architecture:** 8 → 16 → 3 → 3, Dropout 0.3 after each ReLU
- **Parameters:** 207
- **Input:** 8 baseline-relative features from BME688 gas/humidity/temperature
- **Output:** one of 3 classes — `baseline`, `fresh_plant`, `perfume`
- **File:** `models/nn_3class_v0.2.json` (7.7 KB)

### Intended use

Real-time scent classification for a single BME688 sensor on an ESP32
platform. The model runs inference in <1 ms from a JSON weight file
loaded by a TypeScript module, with no external dependencies.

### Training data

46 samples from recordings collected 29 May – 17 July 2026:
- 10 baseline (ambient air, independent recordings across two drift epochs)
- 27 fresh_plant (lemon 9, orange 9, mint 9 — merged)
- 9 perfume (Black Opium, Bluebell, Blackberry & Bay)

Features are standardised to zero mean and unit variance; the scaler is
exported with the model.

### Evaluation

Three-level group-aware cross-validation (mean ± std over 20 seeds):

| Level | Groups | Accuracy | Balanced accuracy |
|---|---|---|---|
| Leave-one-out | 46 | 93.2% ± 2.9% | 91.6% ± 3.2% |
| Leave-one-session-out | 36 | 94.2% ± 2.8% | 93.3% ± 3.4% |
| Leave-one-date-out | 9 | 92.7% ± 4.6% | 90.8% ± 6.5% |

### Limitations

- Trained on data from a single sensor, single room, single operator.
- Perfume data collected exclusively in May–June (no cross-epoch coverage).
- Terpene-class VOCs (lemon, orange, mint) are indistinguishable by a
  single MOX sensor and must be treated as one class.

### Dependencies

- Python 3.9.6
- PyTorch 2.8.0
- scikit-learn 1.6.1

---

## v0.1 — Random Forest

### Model details

- **Type:** RandomForestClassifier (scikit-learn 1.6.1)
- **Parameters:** 400 trees, class_weight="balanced", random_state=0
- **Input:** 5 signed-delta features from BME688 gas/humidity/temperature
- **Output:** one of 3 classes — `baseline`, `orange`, `perfume`
- **File:** `models/rf_orange_perfume_v0.1.joblib`

### Training data

24 samples from recordings collected 29 May – 8 June 2026:
- 12 baseline (ambient air, 3 independent sessions)
- 3 orange (fresh orange, 3 separate days)
- 9 perfume (Black Opium, Bluebell, Blackberry Bay)

### Evaluation

| Level | Accuracy | Baseline recall |
|---|---|---|
| Leave-one-out | 96% | 1.00 |
| Leave-one-session-out | 96% | 1.00 |
| Leave-one-sitting-out | 100% | 1.00 |

### Limitations

- Three classes only; no hard-negative or novelty detection.
- Small sample size (n=24).
- Single sensor, single room, single operator.
