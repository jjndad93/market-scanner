# market-scanner

A local research tool for US stocks, crypto and call options. It explains evidence; it does
not predict prices, connect to a brokerage, place orders or trade automatically.

**Status: Stage 1 complete; Stage 2 phase P1.** The offline call-option evaluator works. The
crypto scanner's offline logic and report exist and are tested with synthetic fixtures only;
live data and the `scan` command are not built yet.

## Requirements

Node.js 22.18 or newer (runs the TypeScript files directly). No packages to install, no API
keys needed for Stage 1.

## Evaluate a call option

Copy the contract details from your broker into a text file, one per line:

```
Underlying: XMPL
Stock price: 52.40
Strike: 55
Expiration: 2026-12-18
Type: Call
Bid: 2.35
Ask: 2.45
Quote time: 2026-10-20 10:15 ET
Open interest: 6420
Volume: 1180
Earnings date: 2026-11-05
Historical volatility: 33%
```

(These values are made up for illustration and are not real quotes.)

```
node src/cli.ts option --file my-contract.txt
Get-Content my-contract.txt | node src/cli.ts option
node src/cli.ts option --template      # every field you can paste
node src/cli.ts option --file my-contract.txt --json
```

A symbol line works instead of separate fields: `XMPL Dec 18 2026 55 Call` or the OCC
symbol `XMPL261218C00055000`. Lines starting with `#` are comments. If a comment says the
data is hypothetical or test data, the report says so prominently.

Required: stock price, strike, expiration, and an option price (premium, or bid and ask).
Everything else is optional. If something is missing, the report lists it instead of guessing.

### What it reports

- **Verdict**: `RELATIVELY STRONG`, `MIXED`, `WEAK`, `TOO RISKY` or `INSUFFICIENT DATA`,
  with the reasons. "Relatively strong" requires known, good liquidity, a fresh quote, an
  entry premium consistent with the bid/ask, a known upcoming earnings date, more than a
  week to expiration, and a historical volatility to compare against (both for valuation
  and for judging the breakeven distance). The rating never improves because a premium is
  low or because a calculated probability is high.
- **Data reliability**, reported separately from the verdict. Problems with the inputs
  (stale quote, premium outside the bid/ask, broker IV disagreeing with the calculation)
  lower confidence and cap the verdict at MIXED, but never count as evidence that the
  contract itself is poor.
- **Historical volatility (HV) input checks.** HV is the independent reference for the
  breakeven and valuation checks, so the evaluator treats it as *questionable* when it is:
  explicitly 0%; below 5%; above 150%; ambiguous in units (e.g. `3` with no `%` sign, which
  could mean 3% or 300%); or inconsistent with the option's own implied volatility (IV/HV
  below 0.5). These are provisional heuristic thresholds chosen for this evaluator, not
  empirically calibrated trading rules, and genuinely unusual stocks can trip them. A
  questionable HV is still shown, but it is not counted for or against the contract: the
  breakeven and valuation checks treat it as unavailable, the IV/HV comparison is not
  reported, data reliability is reduced, and the verdict cannot be `RELATIVELY STRONG`.
  These checks catch some input errors, not all of them: a wrong HV that falls inside the
  accepted range is still used, and no rating means a contract is safe.
- **Key numbers**, each tagged by provenance: `YOU PROVIDED`, `CALCULATED`, `THIRD-PARTY`
  (for example broker-reported IV or delta), `ESTIMATE` (model outputs and default
  assumptions), `MISSING`. `VERIFIED DATA` is reserved for values fetched from a market-data
  source in later stages.
- **Checks**: spread, open interest and volume, quote freshness, entry premium vs. bid/ask, time
  decay, breakeven compared with a typical move at historical volatility, delta, IV compared with
  historical volatility, earnings and dividends before expiration.
- **Profit/loss at expiration** (exact payoff math) and a **before-expiration what-if table**
  (model estimate across stock moves and IV changes). This shows how a call can lose value
  while the stock rises.
- **Model limitations**, including Black-Scholes' treatment of American exercise and dividends.

## Crypto morning scanner (Stage 2, phase P1: offline logic only)

P1 contains the scanner's logic and report, exercised **only with synthetic test fixtures**.
It does **not** fetch market data: there is no network code, API key, data provider, cache or
`scan` command yet (those are later, separately approved phases). `node src/cli.ts scan`
still reports that the scanner is not built.

What P1 does, given a dataset of assets (price, 24h and 7-day change, 24h volume, market cap,
last-updated time, and prior daily volumes):

- **Filters**, each with an explicit reason that is kept and shown: stablecoins (known id,
  symbol or tag), *possible* stablecoins (heuristic, see below), wrapped/staked/liquid-staking/
  bridged tokens, missing data, market cap below $100M, 24h volume below $10M, and data older
  than 15 minutes (or timestamped in the future).
- **Plausibility (data quality, not market judgment)**: a 24h change beyond +/-300%, a 7-day
  change beyond +/-1000%, 24h volume above the whole market cap (turnover > 100%), or relative
  volume above 50x is treated as a probable data error. The asset is excluded with the reason
  "implausible data" and earns no points; it is not counted as weak or strong. A genuine
  extreme move would also be excluded.
- **Volume history**: only the latest 30 daily entries are used (history must be ordered
  oldest-first). The window is applied by `normalizeDataset(input, rules)`; `runScan` refuses
  rules whose window differs from the one used to normalize the data. Zero-volume days and invalid
  entries (text, null, negative, non-finite) are counted and disclosed, never dropped silently;
  zeros are not used in the median because providers often report 0 for missing data. At least
  20 valid days are required, more than 5 zero/invalid days makes the history unreliable, and
  a median baseline under $1M/day is too small to support a volume ratio.
- **Duplicates and symbol collisions**: identical duplicate records are counted once (the extra
  copy is listed as a duplicate); records that share an id but disagree are all excluded, since
  there is no basis for choosing one. Distinct ids that share a symbol are flagged under
  "DATA NOTES" and shown with their ids. Records with no usable id are excluded under a label
  derived from their content (`(no id) <hash>`), so results and the report do not depend on
  input order; identical malformed records share a label but are each counted.
- **Tags** are matched exactly after normalization (lower case; spaces and underscores become
  hyphens) against short lists in `src/scanner/rules.ts`. Negations and near-matches such as
  `non-stablecoin` or `unstaked-rewards` never match; tag spellings not on the lists are not
  recognized.
- **Stablecoin heuristic**: a known id, symbol or tag is definitive. Otherwise a price within
  2% of $1 with almost no 24h movement (and a quiet or missing 7-day change) is excluded as a
  *possible* stablecoin, labeled as a heuristic. Known limits: a genuine asset that happens to
  trade quietly near $1 is excluded (false positive) unless tagged `not-stablecoin`; a
  stablecoin missing from the lists that loses its peg and moves sharply is not caught and can
  appear as a mover (false negative). The symbol and id lists are incomplete, and the ids
  follow CoinGecko naming that must be re-verified when a real provider is added.
- **Metrics**: relative volume (24h volume / median prior daily volume) and turnover
  (24h volume / market cap), both tagged as calculated.
- **Patterns**: *movers* (|24h change| >= 8% on >= 1.5x normal volume) and a *watchlist*
  (|24h change| < 5% on >= 2x normal volume: a research lead, not a prediction).
- **Evidence score** with a published points table (unusual volume, size of move, liquidity,
  7-day trend agreement). Movers need 4/8 and watchlist entries 3/5. Ties are broken by
  relative volume, then volume, then id, so results are deterministic. At most 5 movers and
  3 watchlist entries are shown; the rest are counted, not dropped.
- **Report**: a short text report; when nothing qualifies it says "No candidates met the
  evidence threshold."

Honest labeling: P1 only accepts datasets declared `"kind": "synthetic"`, tags every value
`TEST DATA`, and prints a TEST DATA banner, so fixture numbers can never be presented as
market data. The fixture (`test/fixtures/crypto-scan.synthetic.json`) uses invented coins.

Limitations: all thresholds, plausibility limits and points are provisional heuristics, not
calibrated trading rules; scores measure the strength of observed evidence, not expected
returns; catalysts are never verified in this stage; the stablecoin and wrapped-token lists are
incomplete; and no real data has been run through the scanner yet. Known open items, left
unchanged for now:

- A missing 7-day change scores 0 for trend agreement, so a data gap can lower a candidate's
  score (and push it below the threshold). The gap is stated in the score breakdown.
- The dataset snapshot time and each asset's last-updated time are not cross-validated (for
  example, a snapshot timed after the scan time is accepted).
- The report layout needs a later review: only the first exclusion reason is shown per asset,
  below-threshold entries show only their score, and movers (scored out of 8) and watchlist
  entries (out of 5) use different scales.

## Tests

```
npm test
```

## Layout

```
src/core/evidence.ts      provenance tags shared by every feature
src/core/time.ts          New York market time, date parsing
src/options/              parse -> evaluate -> render for the option command
  blackScholes.ts         pricing, Greeks, implied-volatility solver
  payoff.ts               breakeven, max loss, expiration scenarios
  evaluate.ts             checks, verdict, explanations (thresholds in THRESHOLDS)
src/scanner/              crypto scanner (P1, offline): types, rules, normalize, analyze, render
src/cli.ts                `option` and `scan` commands
test/                     node:test suites (textbook values and hypothetical inputs)
examples/                 clearly labelled hypothetical input
```

### How the option evaluator joins the morning scanner later

`evaluateCall(contract, context)` takes a `ContractInput` (the quote) and a `MarketContext`
(rate, dividends, earnings date, historical volatility, trend). Today both are filled from
pasted text and tagged `YOU PROVIDED`. From Stage 2 on, the scanner's data providers can fill
`MarketContext` (historical volatility from daily bars, earnings from a calendar API) with
`VERIFIED DATA` evidence. The `option` command then automatically gets better context,
and the morning report and the option command share one data layer and one evidence model.

## Safety rules built into this project

- No brokerage connection, no order placement, no automated trading.
- No paid APIs. API keys (later stages) go in `.env` only, which git ignores.
- Never invents prices, Greeks, volume or IV. Missing inputs are reported as missing.
- Test and example data is always labelled as hypothetical.
