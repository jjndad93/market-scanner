# market-scanner

A local research tool for US stocks, crypto and call options. It explains evidence; it does
not predict prices, connect to a brokerage, place orders or trade automatically.

**Status: Stage 1 complete; Stage 2 P1 complete; P2 steps S1-S5 implemented (not yet run
against live data).** The offline call-option evaluator works. `scan crypto` runs the crypto
scanner on a synthetic fixture by default; `scan crypto --live` (CoinGecko Demo API) is built
and tested only with mocked responses. No live request has been made yet.

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

P1 contains the scanner's logic and report, exercised with synthetic test fixtures. The P2
live-data path is described in the next section.

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

## Crypto scan command and live data (Stage 2, P2 steps S1-S5)

```
node src/cli.ts scan crypto                    # bundled synthetic fixture; never uses the network
node src/cli.ts scan crypto --fixture <file>   # another synthetic fixture (must declare "synthetic")
node src/cli.ts scan crypto --now <ISO time>   # fixture only; default is the fixture's snapshot time
node src/cli.ts scan crypto --json             # structured result instead of the text report
node src/cli.ts scan crypto --live             # CoinGecko Demo API; explicit opt-in
node src/cli.ts scan crypto --live --max-requests 4 --history-diagnostics
                                               # live only: cap this run at 4 requests (1-160,
                                               # retries included) and print each fetched history's
                                               # point count and first 2 / last 3 timestamps (UTC,
                                               # classified) to stderr; never volume values
```

History timestamps are classified as `prior-midnight` (00:00 UTC on an earlier day; the only
points used), `prior-intraday`, `today-midnight`, `today-after-midnight`, `future` (at or after
00:00 UTC tomorrow), or `invalid`, and repeated timestamps are flagged as duplicates. Provider
ids are printed with control characters escaped (as `\uXXXX`).

**Live mode** uses the CoinGecko Demo API: one `/coins/markets` request (top 250 by market cap)
and then one `/coins/{id}/market_chart` request (91 days, no `interval` parameter, so the
documented auto-granularity returns daily points at 00:00 UTC; only the latest 30 are used) per
asset that passes every
non-history filter, so assets already excluded (stablecoins, too small, stale, ...) cost no
history request. A run makes at most 160 requests (retries included), spaced about 700 ms
apart to stay under the Demo plan's 100 calls/min. Live reports carry the attribution
"Data provided by CoinGecko (https://www.coingecko.com)", a snapshot time, per-asset update
times, and a DATA NOTES section describing what was fetched or skipped. Live values are tagged
VERIFIED DATA (meaning fetched by this tool from the named source, not independently audited)
and never TEST DATA; fixture reports are always TEST DATA.

**Failures never produce invented data.** If the markets request fails (timeout, HTTP error,
rate limit, malformed response), no report is produced. HTTP 429 is retried once after the
server's Retry-After (if given and at most 60 s). If a history request fails, that asset gets no
history and is excluded for insufficient history; if the run is rate-limited or reaches the
request limit, the remaining assets are listed in the report as not requested.

**API key.** Live mode reads the key only from the `COINGECKO_DEMO_API_KEY` environment
variable. Store it as a Windows *user* environment variable (System Properties > Environment
Variables, or `setx COINGECKO_DEMO_API_KEY <key>` in a new terminal), not in a file inside this
OneDrive-synced folder. The key is sent only in the `x-cg-demo-api-key` header, never in a URL,
and is never printed or written; errors redact it. Without the variable, `--live` stops before
making any request.

**Unresolved: what a daily history volume point means.** CoinGecko's documentation describes
the points only as "24hrs volume", with daily auto-granularity at "00:00 UTC" and "the last
completed UTC day (00:00) data" available at 00:10 UTC. It does not say whether a point is a
rolling 24h volume at that moment or a calendar-day total, or which day a 00:00 point belongs
to. The adapter keeps only points exactly at 00:00 UTC before the current UTC day (oldest
first, duplicates collapsed; conflicting duplicates, missing days and missing recent days
counted as unusable) and every live report says the meaning is not yet verified. This must be confirmed
with a separately approved live check (S7) before live results are relied on.

Not done yet: a history cache (S6) and any live request (S7), both pending approval.

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
src/scanner/              crypto scanner: types, rules, normalize, analyze, render; command (scan CLI)
src/providers/            http.ts (fetch client: timeout, budget, 429 retry); coingecko.ts (adapter)
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
- No paid APIs. API keys are read only from environment variables (Windows user environment
  variables), never from a file in this OneDrive-synced folder; the tool does not read `.env`.
- Never invents prices, Greeks, volume or IV. Missing inputs are reported as missing.
- Test and example data is always labelled as hypothetical.
