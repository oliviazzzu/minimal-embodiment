# Data

## features.csv

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
