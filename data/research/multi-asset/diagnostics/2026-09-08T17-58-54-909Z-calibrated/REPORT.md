# Train-only calibration experiment

PAVA isotonic fit on development rows only; validation and test labels are never used to fit it.

| Asset | Raw validation Brier | Calibrated validation Brier | Raw test Brier | Calibrated test Brier |
|---|---:|---:|---:|---:|
| BTC | 0.17662 | 0.17672 | 0.17672 | 0.17703 |
| ETH | 0.16679 | 0.16734 | 0.17135 | 0.17138 |
| SOL | 0.16832 | 0.16857 | 0.17000 | 0.17023 |
| XRP | 0.16545 | 0.16583 | 0.16834 | 0.16936 |
| DOGE | 0.16200 | 0.16332 | 0.16271 | 0.16296 |