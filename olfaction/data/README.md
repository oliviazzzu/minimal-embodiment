# Data

## features_v0.2.csv (current)

46 samples extracted from BME688 gas-sensor recordings collected between
29 May and 17 July 2026. Each row is one exposure trial (or one baseline
window), represented by baseline-relative features computed over a
10-minute (60-row) exposure window, with the preceding 5 minutes
(30 rows) as the baseline reference.

### Columns

| Column | Type | Description |
|---|---|---|
| `source_file` | metadata | Original recording filename |
| `session` | metadata | Recording session identifier (for group-aware CV) |
| `scent` | metadata | Specific scent source (e.g. `black_opium`, `lemon`) |
| `label` | metadata | Coarse class label: `baseline`, `fresh_plant`, or `perfume` |
| `gas_trough_d` | **model feature** | min gas resistance − baseline mean |
| `gas_mean_d` | **model feature** | mean gas resistance − baseline mean |
| `humid_peak_d` | **model feature** | max humidity − baseline mean |
| `humid_mean_d` | **model feature** | mean humidity − baseline mean |
| `temp_d` | **model feature** | mean temperature − baseline mean |
| `gas_trough_pct` | **model feature** | gas trough as % of baseline mean |
| `gas_slope` | **model feature** | slope over first 15 rows of exposure |
| `gas_std` | **model feature** | standard deviation of gas resistance |
| `gas_peak_d` | shipped, unused | max gas resistance − baseline mean |
| `gas_range_d` | shipped, unused | gas max − gas min |
| `gas_recovery` | shipped, unused | recovery ratio toward baseline |
| `gas_skew` | shipped, unused | skewness of gas resistance |
| `humid_recovery` | shipped, unused | humidity recovery ratio |
| `humid_std` | shipped, unused | std of humidity delta |
| `gas_late_slope` | shipped, unused | slope over second half of window |
| `time_to_trough` | shipped, unused | row index of gas minimum |

The 8 features marked **model feature** are the ones used by the v0.2
neural network. The remaining columns were explored during feature
selection but did not improve evaluation metrics and are not used by the
deployed model.

### Class distribution

| Class | Samples | Sources |
|---|---|---|
| baseline | 10 | Independent ambient-air recordings across two drift epochs |
| fresh_plant | 27 | Lemon (9), orange (9), mint (9) — merged (see README) |
| perfume | 9 | 3 fragrances (Black Opium, Bluebell, Blackberry & Bay) |

### Design notes

- **Deltas, not absolutes.** Every feature is a change relative to the
  same recording's own baseline, cancelling slow sensor drift and
  per-day environmental offsets by construction.
- **Fixed 10-minute window.** All exposure features are computed over
  60 rows (10 min at 10 s/row) after odour onset.
- **Raw recordings are not included.** The feature table is provided
  directly; see `src/extract_features_v0.2.py` for the extraction logic.

---

## features.csv (v0.1)

24 samples extracted from BME688 gas-sensor recordings collected between
29 May and 8 June 2026. Each row is one exposure trial (or one baseline
window), represented by five signed-delta features computed relative to
the preceding baseline segment within the same recording.

### Columns

| Column | Description |
|---|---|
| `source_file` | Original recording filename |
| `session` | Recording session identifier (for group-aware CV) |
| `scent` | Specific scent source (e.g. `black_opium`, `orange`) |
| `label` | Coarse class label: `baseline`, `orange`, or `perfume` |
| `gas_trough_d` | min gas resistance in window − baseline mean |
| `gas_mean_d` | mean gas resistance in window − baseline mean |
| `humid_peak_d` | max humidity in window − baseline mean |
| `humid_mean_d` | mean humidity in window − baseline mean |
| `temp_d` | mean temperature in window − baseline mean |

### Class distribution

| Class | Samples | Sources |
|---|---|---|
| baseline | 12 | 3 independent recording sessions |
| orange | 3 | fresh orange, 3 separate days |
| perfume | 9 | 3 fragrances (Black Opium, Bluebell, Blackberry Bay) |

### Design notes

- **Deltas, not absolutes.** Every feature is a change relative to the
  same recording's own baseline, cancelling slow sensor drift and
  per-day environmental offsets by construction.
- **Fixed 13-minute window.** All exposure features are computed over
  the first 156 rows (≈ 13 min) after odour onset, ensuring equal
  measurement duration across samples.
- **Raw recordings are not included.** The feature table is provided
  directly; see `src/extract_features.py` for the extraction logic.
