# Quantitative audit — September 6, 2026

**The available evidence does not show a profitable strategy. The leading weaknesses are probability calibration, execution sensitivity, regime concentration, and insufficient independent outcomes. Increasing position size would not address them.**

This is a diagnostic audit. No trading settings, live model, orders, funds, or running demo state were changed. The new offline audit command is `node scripts/audit-strategy.js`. It freezes diagnostic choices in a manifest and saves numerical results and a segmented trade CSV under `data/research/audits/`. The report used here is [report.json](../data/research/audits/2026-09-06T14-00-53-901Z/report.json).

## Data actually available

The history database is 26.88 GB (decimal); all project data totals approximately 26.91 GB. It contains **39,834,295 public trades, 22,500 minute candles, 1,500 settled markets, and zero recorded order-book stream events**. BTC reference data contains 22,920 minute candles. Market coverage is August 21, 2026 08:00 UTC through September 6, 2026 03:00 UTC: approximately 15.8 days, with 15 complete UTC days for daily statistics.

The current replay consumes minute candles, not the 39.8 million individual trade rows. It produces 91 filled, closed simulated outcomes. Public exchange trades are not independent strategy training labels. Repeated replay runs must never be pooled as new independent outcomes.

## Performance with costs

Each $100 scenario uses fees, bid/ask quotes, delayed execution and slippage. Different scenarios can accept different trades; these are separate portfolio simulations, not paired cost adjustments or statistical confidence intervals.

| Scenario | Filled trades | Net P&L | Profit factor | Maximum realized drawdown | Annualized daily Sharpe |
|---|---:|---:|---:|---:|---:|
| Normal: next-minute close | 91 | -$15.53 | 0.529 | 16.64% | -11.00 |
| Adverse: next-minute adverse price extremes | 36 | -$23.45 | 0.032 | 23.45% | -11.76 |
| Stress: adverse, 1.5x fee rate, 2-cent slippage allowance | 51 | -$33.92 | 0.022 | 33.92% | -13.23 |
| Normal, $30 starting account | 47 | -$2.49 | 0.619 | 10.91% | -6.42 |

**All fail the requested profit-factor 1.3 and Sharpe 1.0 screens.** These screens are heuristics, not proofs of future profitability. Sharpe uses simple UTC daily realized-equity returns, includes flat days, excludes partial boundary days, assumes zero risk-free rate, and annualizes by sqrt(365). With only 15 full daily observations and possible serial dependence, its magnitude is extremely unstable. It is not a reliable annual forecast. Drawdown omits intratrade mark-to-market losses and can understate actual risk. The $30 result shows whole-contract sizing changes the trade set; results do not scale linearly with bankroll.

## Ranked weaknesses and minimal changes

### 1. The model's quoted edge is not validated by outcomes

On the 91 filled normal-scenario signals, mean predicted probability of the chosen side winning at settlement is **72.31%**, versus **39.56% actually settling on that side**. Model settlement Brier score is **0.329**, worse than the selected-side entry-ask benchmark's **0.260** and the constant-50% benchmark's **0.250**. Lower Brier is better. The ask benchmark includes spread; it is not an unbiased market probability. This is a selected filled-trade sample, not an evaluation of every forecast the bot generated.

The base model predicts settlement direction, while the ML label is profitable exit outcome. Those are different targets. The exit policy sold every simulated position before settlement, so a correct settlement forecast is not automatically a profitable scalp.

**Minimal changes:** log every pre-trade probability, timestamp, quote, reference source and eventual settlement result, including rejected/unfilled candidates. Evaluate settlement calibration separately from exit P&L. Verify Binance spot versus Kalshi settlement-index basis and strike alignment before tuning a probability multiplier. If calibration is fit, fit it only on earlier resolved markets and validate it forward. Do not invert or recalibrate probabilities against this whole dataset and claim discovery of an edge. Keep ML-based upsizing disabled until independently validated.

### 2. Execution assumptions materially determine losses

Normal replay charges **$4.91 entry fees + $4.08 exit fees**, plus **$2.65 explicitly modeled exit slippage** across 91 trades. Spread and entry-price changes are embedded in transaction prices and must not be deducted a second time. The diagnostic round-trip estimate at signal time averages **5.85 cents per contract**, including spread, cent-rounded entry/exit fees at the planned size, and one cent of exit slippage. The model's claimed settlement probability edge averages **17.91 cents**. It exceeds modeled friction on paper, yet net realized expectancy is **-$0.171 per trade**: inaccurate probabilities/exit behavior remain central problems, not just fee omission.

Fees use the configured quadratic 0.07 rate, rounded per simulated order. This is a declared assumption, not a reconstruction of each historical series multiplier, partial-fill rounding, or rebate. See [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding).

Execution is delayed to the following minute end. That is a 60-second simulation delay, not a measured live latency model. No historic queue position, depth, partial fills, or exact 30-second live cancellation behavior is reconstructed. Aggregate volume participation is not proof an order could fill. Entry limits permit one cent of slippage in normal replay; the live order uses its submitted quote without that allowance. The stress run's two-cent setting also widens entry tolerance, explaining its higher fill count; it is not solely a cost increase on identical trades. Historical/live reference feeds and trend warmup also differ.

**Minimal changes:** record decision, request, acknowledgment, first/final fill, cancel request and cancel confirmation timestamps with executable bid/ask depth. Use the existing collector to capture snapshots/deltas and gap markers. Replay the actual 30-second entry timeout and empirical latency distribution before interpreting replay P&L as live performance. Keep conservative scenario results visible. Compare expected P&L under the actual exit policy against both entry and exit costs; entry-fee-only edge filtering is insufficient.

### 3. The strategy is concentrated in low-volatility conditions

Regimes are assigned at market OPEN using only available reference data. Volatility is trailing minute-return standard deviation scaled to 15 minutes, matching the replay context. Low/medium/high cutoffs are 0.001653 and 0.002339, fitted on the earliest 500 markets and then frozen. Trend/range uses the existing trailing EMA/ROC classification; NEUTRAL is a range proxy, not an independently validated regime definition.

| Volatility / trend | Available markets | Filled trades | Normal net P&L | Profit factor |
|---|---:|---:|---:|---:|
| Low / bullish | 331 | 40 | -$4.39 | 0.670 |
| Low / bearish | 284 | 22 | -$5.13 | 0.432 |
| Low / neutral | 193 | 21 | -$4.34 | 0.485 |
| Medium / bullish | 155 | 7 | -$1.71 | 0.223 |
| High / bearish | 128 | 1 | +$0.04 | Undefined: no losses |
| Other four combinations | 409 | 0 | No trades | Not estimable |

**83/91 trades (91.2%) are low volatility**, versus 808/1,500 available markets (53.9%). All materially populated cells lose. The sole positive cell consists of one four-cent winner and becomes a 52-cent loser under adverse execution. Treat that as inadequate evidence, not a profitable niche.

Low measured volatility produces more extreme direction probabilities for a given spot/strike distance, which can help explain this concentration. This is an inference from the model equation and observed selection, not an identified causal effect.

**Minimal changes:** freeze these regime definitions; report sample counts and cost-inclusive results per regime on future data. Do not enable just the sole winning cell. Either establish an edge in the intended low-volatility scope or collect sufficient high/medium-volatility outcomes before claiming general robustness.

### 4. There are too many adjustable choices for the effective sample size

The audit counted **33 distinct configuration controls** in signal, sizing, exit and trend code, and **55 unique controls** across those files plus risk, execution and ML configuration. Full names are in report.json. These are configuration controls, not 55 fitted statistical coefficients: some are operational, shared, inactive in replay, or not exposed through server environment parsing. Hardcoded choices such as volatility windows/floors, 100 ML stumps and 0.1 learning rate add researcher discretion beyond that count. `MIN_EDGE` controls the absent Polymarket branch; replay also fixes ROC lookback rather than honoring every live trend setting.

There are **27 ML features**, three constant in this directional replay: `is_directional`, `is_poly_arb`, `is_dual_side`. A 70/15/15 split leaves only **63 training, 14 validation, 14 test labels** before any further segmentation. Many features are dependent: move and its magnitude/direction, probability and edge, YES/NO spreads, and recent P&L/balance. Effective independent information is smaller than the raw feature/sample counts imply. Exact effective sample size cannot be credibly estimated from this short, clustered sequence.

The 300-outcome training gate is a software floor, not evidence that a 100-stump model is adequately trained. Prior eight-candidate comparison selected no passing candidate. Old code comments calling defaults “backtest-optimized” do not establish successful out-of-sample validation. Repeatedly optimizing the same data creates selection risk; see [Bailey et al., probability of backtest overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

**Minimal changes:** freeze strategy parameters, retain the trial registry, drop constant features when fitting a research model, and compare a small regularized baseline with the current model on identical chronological folds. Do not lower the training floor or pool repeated runs. A new model family is another trial and needs untouched forward evaluation.

### 5. Risk is larger than a 0.5–1% equity budget, and the drawdown stop is incomplete

In the $100 normal replay, fee-inclusive capital at risk averages **1.59% of current realized equity**, reaches **4.68%**, and exceeds 1% in **74/91 trades**. For the recent $30 demo example, a 56-cent contract plus two-cent estimated fee risks approximately **1.93%** if it expires worthless. A $3 minimum would start at 10% of that account. The 40% price stop is an execution instruction, not a guaranteed maximum loss.

An independent `TradingSafety` module exists. Defaults halve sizing after more than 10% session realized loss and pause for 15 minutes after more than 20%. It is **not a hard maximum-drawdown kill switch**: cooldown expires; the reference is session starting balance rather than high-water equity; unrealized loss is omitted; state resets with the process. The replay does not execute this complete live safety module. There are separate authentication/execution/persistence halts, but those do not close this drawdown gap.

**Minimal changes:** add a persistent high-water equity and latched loss limit to the independent safety module, with explicit review/reset and stale-price handling. Gate new entries using cash plus marked-to-market positions and separate deposits/transfers from performance. Add an optional fee-inclusive worst-case contract-cost cap of 0.5–1% equity; skip trades when even one whole contract exceeds it. Do not round up or assume the stop guarantees that risk. The chosen cap is a policy choice, not universally optimal.

### 6. Recent losses do not establish alpha decay; the evidence is negative throughout

| Chronological third: 500 markets each | Trades | Net P&L | P&L/trade | Profit factor |
|---|---:|---:|---:|---:|
| Oldest | 8 | -$1.57 | -$0.196 | 0.426 |
| Middle | 17 | -$2.65 | -$0.156 | 0.651 |
| Newest | 66 | -$11.31 | -$0.171 | 0.500 |

The newest third carries 72.5% of trades and 72.8% of total net losses. Loss per trade is not monotonically deteriorating. **There is no demonstrated positive earlier edge to call “decaying.”** Changes in trade frequency, regimes and random variation remain plausible explanations.

Illustrative feature/win-label correlations (oldest → middle → newest): absolute spot move **+0.61 → +0.01 → -0.06**; volatility **+0.63 → +0.06 → -0.14**; trend strength **+0.38 → -0.09 → -0.03**. These are unstable associations, with just eight oldest observations, overlapping predictors and 27 examined features. They are not statistically established feature decay and should not trigger feature removal on their own. Full correlations, including nulls for constant features, are saved.

A cherry-picked August 25–27 window earns $2.73 across ten trades while the complete sample loses $15.53. That illustrates how a favorable window could mislead. Restricting to take-profit exits is also outcome selection: 52 scalp exits net +$13.63 while 39 stop exits net -$29.16. Removing losing exits after observing them is not a valid strategy test.

**Minimal changes:** maintain fixed rolling calibration and net-expectancy reports with counts and uncertainty. Re-evaluate candidates only on subsequently observed data. Alert on sustained deterioration across independent blocks, not one small bucket or a raw cumulative-loss increase.

### 7. BTC exposure is measurable, but alpha is not demonstrated

Regressing normal daily realized account returns on aligned BTC spot returns gives **correlation +0.245 and beta +0.231**. Adverse execution changes these to **-0.032 and -0.045**; the $30 normal run gives approximately **+0.007 and +0.005**. Each estimate uses just 15 complete days. No fee-free buy-and-hold portfolio backtest is presented: underlying returns are a factor series, not claimed investable benchmark P&L.

There is no strong evidence here that the bot is simply a long-BTC wrapper, but low correlation does not establish alpha. Binary payoff curvature, short holding intervals, sizing and low-volatility selection create exposures a single linear beta cannot summarize. All positions share the same underlying; different contract tickers are not asset diversification.

**Minimal changes:** log marked-to-market account equity and signed contract exposure at fixed intervals; estimate return beta and volatility sensitivity on several months of data, including flat periods, before interpreting risk-adjusted alpha. Retain portfolio-wide BTC exposure caps.

## Walk-forward results and next protocol

I ran anchored fixed-policy checks: first 600 markets as earlier history, test the next 300; expand earlier history to 900, test the next 300; expand to 1,200, test the final 300. Test blocks do not overlap, and each starts with $100. These are retrospective forward-block tests of the unchanged policy, **not ML retraining or fresh unseen validation**.

| Earlier markets / available labels | Test trades | Normal P&L | Normal PF | Adverse P&L |
|---|---:|---:|---:|---:|
| 600 / 13 | 8 | -$1.97 | 0.484 | -$4.71 |
| 900 / 21 | 31 | -$5.50 | 0.481 | -$4.88 |
| 1,200 / 52 | 39 | -$7.96 | 0.505 | -$13.92 |

**Every test block fails.** There are insufficient prior labels for the current 300-outcome ML gate in any fold.

For subsequent research, predeclare anchored training, an inner chronological validation block for any choice, then an untouched outer test block. Purge training labels unresolved at the next block boundary and keep all samples from each ticker together. Freeze preprocessing, calibration and regime thresholds using training only. Advance by calendar time, not favorable trade counts; report inadequate-sample folds instead of hiding them. Preserve every candidate trial and only combine disjoint outer-test outcomes. New data after the inspected snapshot is needed for credible forward evidence.

More **calendar breadth** is the main data need: several months spanning materially different conditions. At the current 6.1% fill-label yield, 300 labels would take roughly 4,950 markets, but the 8/17/66 distribution shows this extrapolation is unstable. Even 300 labels leave only about 45 validation and 45 test outcomes before regime splits. More raw prints from the same markets will not fix that.

More **execution density** is useful where it is currently missing: order-book snapshots/deltas, queue/fill timestamps, and the actual spot/index feed used at decision time. Existing trade rows can help estimate trade arrival and observed prices, but cannot reconstruct unseen resting bids, canceled quotes or queue positions. Keep that analysis separate from market-direction training sample counts.
