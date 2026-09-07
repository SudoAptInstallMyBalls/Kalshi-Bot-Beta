# Settlement and probability-model autopsy — 2026-09-07

The zero disagreement buckets are real in this snapshot. There is no 20/50-bps cutoff in the comparison code. The original output mislabeled disjoint ranges as cumulative ranges. The more consequential issue is comparing Binance BTCUSDT prices to a strike and settlement average from a different index. A separate missing return field disabled the intended unknown-volatility entry guard; that is now fixed.

## Evidence from the stored data

Read-only investigation of 2,048 KXBTC15M markets closing August 16 through September 7 UTC, and 31,275 Binance one-minute candles. Full results, all 204 disagreements, daily breakdowns, timestamps, and SHA-256 input fingerprints are in `data/research/settlement-autopsy.json`.

| Actual distance interval | Markets | Disagreements |
|---|---:|---:|
| 0–5 bps inclusive | 578 | 148 |
| >5–10 bps | 438 | 48 |
| >10–20 bps | 561 | 8 |
| >20–50 bps | 394 | 0 |
| >50–100 bps | 67 | 0 |
| >100 bps | 10 | 0 |

The old `buckets.find()` assigns each market to its FIRST matching bucket. Its `withinBps: 50` means (20,50], and JSON.stringify(Infinity) produces null. A genuinely cumulative <=50-bps measurement is 204 disagreements among 1,971 markets (10.35%), not zero. The maximum distance among disagreements is 12.289855 bps. Zero observed events in the farther buckets does not imply zero future probability.

A disagreement requires the strike to lie between the two compared price values (with the appropriate equality convention). Thus a small price difference changes the binary outcome mainly when price is close to strike. Larger distances can still disagree if the price difference is larger: regression fixtures deliberately create disagreements at 50, 100, and 101 bps, and the code counts all of them.

## Settlement integrity and time alignment

- All 2,048 stored official expiration values produce the recorded yes/no result using >= strike. No missing official values, unsupported market types, or raw-versus-normalized market field mismatches were found.
- Two official values contain thousands separators: `77,362.10` and `79,604.96`. The new diagnostic parses these explicitly; Number() alone would produce NaN, and `NaN >= strike` would silently become false.
- All market close timestamps exactly equal the selected candle's available_ms. All raw candle open/end/close values match the stored normalized fields. The spot series has no minute gaps or duplicate availability timestamps.
- normalizeKline correctly uses Binance's inclusive close timestamp plus 1 ms. For these minute-aligned closes, the selected price is the final trade of the minute immediately preceding close. The previously suggested arbitrary 60-second as-of staleness is not present in this snapshot. This does not make a final trade identical to a minute average.
- Shifting the comparison by -120/-60/0/+60/+120 seconds gives 308/236/204/303/362 disagreements. These are diagnostic shifts only; positive shifts use future data and must not enter replay forecasts.

The saved rules explicitly specify the rounded average of 60 CF Benchmarks BRTI observations before the deadline, compared against the corresponding opening average. This agrees with [Kalshi's crypto settlement explanation](https://help.kalshi.com/en/articles/13823838-crypto-markets). Binance BTCUSDT is a different exchange/currency reference and a last-trade observation. A Binance candle close, OHLC average, or volume-weighted price cannot reconstruct the official one-second index average.

The signed Binance-minus-official difference averages +2.2746 bps (strike denominator); median absolute difference is 2.4857 bps, p95 absolute difference 10.3036 bps, maximum absolute difference 32.8604 bps. Among all markets, 1,107 official values are outside Binance's final-minute high/low range; this includes 159 of the 204 disagreements. Assuming the stored provider data is accurate, averaging Binance trades within that same minute cannot explain away those 159 discrepancies. The raw data consistency checks are not independent verification of the external providers' historical accuracy.

Concrete largest-distance mismatch: KXBTC15M-26AUG162015-15, strike $62,832.31, Binance close $62,909.53, official settlement $62,829.29. Kalshi's No is consistent with the official value. The Binance observation is 12.29 bps above strike.

The offset changes substantially with date: mean +10.33 bps on August 16, +8.87 August 17, +7.19 August 18, versus -1.91 September 5. The directionality count is 170 above-strike/No and 34 below-strike/Yes. This supports investigating the price reference, but directionality alone cannot separate currency basis, venue differences, averaging effects, and market trends. A global offset fitted to this entire history would also leak later data into earlier forecasts.

## Model and replay findings

`probability-model.js` computes `(currentPrice - openPrice) / openPrice`, and the replay supplies Binance price for currentPrice and Kalshi's floor_strike for openPrice. Therefore an existing reference-price offset enters the model as if it were a directional move. Changing a volatility window cannot directly remove that offset. The model also forecasts a terminal spot value rather than explicitly modeling the final-minute index average.

A retrospective sensitivity check held the original 121 baseline trades and their outcomes fixed. Replacing only the model reference price with the Binance candle available at market open gave:

| Probability measurement | Settlement Brier error (lower is better) |
|---|---:|
| Existing model | 0.399403 |
| Binance opening-return proxy | 0.240178 |
| Original quoted entry ask | 0.230324 |

No correction was promoted into signal generation. The opening-return proxy uses information available at entry but assumes an opening offset remains useful later; it still does not reproduce the index or averaging window. This comparison is on trades selected by the original model, not a new strategy backtest or a held-out profitability result. It demonstrates sensitivity, not a proven edge. Results are saved in `data/research/settlement-autopsy-calibration.json`.

The baseline replay was reproduced: 121 trades, mean model probability 84.93%, settlement hit rate 45.45%, P&L -$9.765. Its drawdown latch skips 1,818 later markets, so this is not a sample evenly spanning all 2,048 markets. The existing audit trade export spans August 16–18, the period with the largest positive price offset. One market, KXBTC15M-26AUG160615-15, has no quote candles and is correctly excluded from trading replay, while it remains usable for settlement comparison. The calibration code correctly compares probabilities with settlement outcomes rather than profitable-exit labels.

The live feed estimates volatility from up to an hour of sampled quote midpoints, while spotContext in replay estimates from 15 one-minute returns. Editing the live estimation window does not change replay's sigma calculation. That is a live/research mismatch to account for in future validation; it does not explain the settlement-check zeroes.

The proposed market_blend_0 interpretation in the pasted advice also needs correction: with a valid spread, midpoint probability is no greater than the ask on either side. With positive edge/cost thresholds, the directional rule cannot enter. Zero trades or zero loss would not show that a quote-only trading strategy wins. The quote Brier comparison on a common cohort is the appropriate prediction comparison here.

## Changes and validation

- Reworked check-settlement-basis.js with a testable research module: explicit disjoint ranges, separate cumulative counts, safe official-value parsing, official result checks, raw candle validation, source/market scope checks, timestamp ages, daily offsets, timing sensitivity, and optional full JSON export.
- Returned volatilityKnown on all probability-model result paths. SignalGenerator already checks this field; it now rejects unknown volatility instead of trading the fallback estimate. Measured-volatility replay results remain reproducible.
- Added regression tests for far-distance disagreements, exact bucket boundaries, missing/future/stale data, malformed official values, equality, mixed feeds, corrupted normalization, deterministic diagnostics, and the actual unknown-volatility signal rejection.
- All 85 tests passed with `node --test test/*.test.js`; detailed output is in `data/research/settlement-autopsy-full-tests.txt`. The npm launcher on this machine points at a missing npm-cli.js, so the equivalent Node test command was used directly.

Rerun the autopsy with:

```powershell
node scripts/check-settlement-basis.js --out data/research/settlement-autopsy.json
```

Remaining research work is to validate a causal reference-price adjustment against the actual settlement target on later data, preserving the final-minute averaging semantics and reporting both full-market forecast calibration and selected-trade performance. The available one-minute Binance data cannot isolate the exact BRTI/currency/averaging contribution. This investigation does not establish a profitable strategy or constitute an exhaustive audit of order execution and the account ledger.
