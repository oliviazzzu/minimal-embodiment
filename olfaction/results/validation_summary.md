# Validation Summary

## Three-level group-aware cross-validation

| Evaluation scheme | Accuracy | Baseline recall | Orange recall | Perfume recall |
|---|---|---|---|---|
| Leave-one-out (sample-level) | 96% | 1.00 | 1.00 | 0.89 |
| Leave-one-session-out | 96% | 1.00 | 1.00 | 0.89 |
| Leave-one-sitting-out (strictest) | 100% | 1.00 | 1.00 | 1.00 |

Accuracy converges at 96–100% with no drop as grouping becomes stricter,
indicating no detectable session-level leakage.

The single misclassification under schemes 1 and 2 is a Blackberry Bay
perfume sample (gas_trough_d ≈ −35.2) predicted as baseline — correctly
classified under the strictest grouping.

## Feature importances (full-data fit)

| Feature | Importance |
|---|---|
| humid_peak_d | 0.334 |
| gas_trough_d | 0.212 |
| humid_mean_d | 0.204 |
| gas_mean_d | 0.179 |
| temp_d | 0.071 |

Humidity peak dominates because it separates the high-moisture orange
from the dry perfumes; temperature contributes least, as expected for
delta features in a temperature-stable room.

## Robustness

Gaussian noise scaled to each feature's standard deviation was injected
and leave-one-out repeated (20 runs per level):

| Noise level | Mean accuracy | Std | Range |
|---|---|---|---|
| 0% (clean) | 95.8% | — | — |
| 5% | 96–97% | ~1% | 96–97% |
| 10% | 96–97% | ~1% | 96–97% |
| 20% | 96–97% | ~1% | 96–97% |

Mean predicted-class confidence: 0.91 (median 0.98).

## Caveats

- n = 24, one room, one sensor. Near-perfect accuracy here means "these
  three classes are separable and survive group-aware cross-validation,"
  not "proven to generalise to new sensors or environments."
- The 96% vs 100% fluctuation across grouping levels is small-sample
  noise from one borderline perfume sample, not evidence that stricter
  grouping improves accuracy.
