# market-scanner

A local research tool for US stocks, crypto and call options. It explains evidence; it does
not predict prices, connect to a brokerage, place orders or trade automatically.

**Status: Stage 1 and Stage 2 complete; Stage 3 (US stocks) started.** The offline call-option
evaluator works. `scan crypto` runs on a synthetic fixture by default, and `scan crypto --live`
(CoinGecko Demo API) has been run against live data in small capped smoke tests, with a
same-day history cache (S6) and a verified meaning for daily volume points (S7). `scan stocks`
(Stage 3) works on a synthetic fixture and is tested with mocked responses only; its live path
(Massive, formerly Polygon.io) has not been run against live data yet.

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
node src/cli.ts option --file my-contract.txt --live-context   # opt-in: 1 Massive request
```

A symbol line works instead of separate fields: `XMPL Dec 18 2026 55 Call` or the OCC
symbol `XMPL261218C00055000`. Lines starting with `#` are comments. If a comment says the
data is hypothetical or test data, the report says so prominently.

Required: stock price, strike, expiration, and an option price (premium, or bid and ask).
Everything else is optional. If something is missing, the report lists it instead of guessing.
A required value you *supplied* but that can't be used, such as `Strike: abc`, an impossible
date or a negative price, is reported as **invalid**, not missing. It shows the text you gave
and why it was rejected, under "MISSING OR INVALID INFORMATION". Missing and invalid values
both block the verdict (`INSUFFICIENT DATA`), and neither is ever treated as zero.

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
  assumptions), `MISSING`. With `--live-context`, historical volatility and trend values
  derived from fetched end-of-day bars are `CALCULATED`, with a note giving the latest
  completed session date. The report header then says what live data was used, instead of
  "No live market data was fetched".
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
incomplete; and real data has been run through the scanner only in one capped smoke test. Known open items, left
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
server's Retry-After (if given and at most 60 s). Each asset that passes the non-history filters
ends in exactly one of three history outcomes, and only the first is evaluated:

- **fetched**: history was obtained and parsed. It can still be excluded as "too little
  history" or "unreliable volume history" if it fails those rules.
- **history request failed**: the request was sent but failed, or the response had no usable
  volume data. The asset is excluded with that reason, not as "too little history".
- **history not requested**: the run stopped requesting history (request limit reached or
  rate-limited). The asset is excluded with that reason and was not evaluated.

Live reports show a "History coverage" line (fetched / failed / not requested out of the
eligible assets). When anything failed or was not requested it says PARTIAL SCAN, and the
conclusion ("No candidates ...", or the candidate lists) is stated as covering only the assets
whose history was fetched. `--json` carries the same figures in `dataset.coverage`
(`historyEligible`, `historyFetched`, `historyRequestFailed`, `historyNotRequested`, `complete`,
`stopReason` - null when nothing was left unrequested - `requestsUsed`, `requestLimit`). A
partial scan still exits with code 0; check `complete` to detect one.

**API key.** Live mode reads the key only from the `COINGECKO_DEMO_API_KEY` environment
variable. Store it as a Windows *user* environment variable (System Properties > Environment
Variables, or `setx COINGECKO_DEMO_API_KEY <key>` in a new terminal), not in a file inside this
OneDrive-synced folder. The key is sent only in the `x-cg-demo-api-key` header, never in a URL,
and is never printed or written; errors redact it. Without the variable, `--live` stops before
making any request.

**What a daily history volume point means (S7).** A `/market_chart` volume point at time T is
the rolling 24h volume ending at T, so a 00:00 UTC daily point covers the previous UTC day.
CoinGecko's documentation only calls the points "24hrs volume"; this was established by one
approved live check (S7, 3 requests, Bitcoin, 2026-10-21): the 91-day daily series and the 2-day
hourly series agreed exactly at both midnights (daily/hourly ratio 1.0000 at yesterday and today
00:00 UTC), the hourly series showed no reset at midnight (after/before ratios 0.969 and 0.981),
and the latest chart point matched `/coins/markets` `total_volume` (ratio 0.993), so the current
24h volume and the history are measured the same way. The responses also end with an extra
"now" point. This supports the interpretation for these endpoints; it does not establish data
quality for every coin or the predictive value of any signal. The adapter keeps only points
exactly at 00:00 UTC before the current UTC day (oldest first, duplicates collapsed; conflicting
duplicates, missing days and missing recent days counted as unusable). Today's 00:00 point
(yesterday's total) is conservatively not used, so the 30-day baseline ends one day earlier.

**History cache (S6).** Successfully parsed `/market_chart` volume histories are stored in a local
cache outside this OneDrive-synced folder (`%LOCALAPPDATA%\market-scanner\coingecko-history` on
Windows; `$XDG_CACHE_HOME` or `~/.cache` elsewhere; no cache if none is known), one JSON file per
asset named by a hash of its id. A cached history is reused only during the UTC day it was fetched,
and only if it was fetched at least 15 minutes after 00:00 UTC; otherwise it is requested again.
Since the scanner uses only completed UTC days, a same-day entry holds the same days as a new
request. Failed requests and malformed responses are never cached, and a corrupt or mismatched
entry is ignored. Reused histories cost no request, so later runs on the same day cover more
assets within `--max-requests`; the report's coverage line, a DATA NOTES line and
`dataset.coverage.historyFromCache` say how many were reused. Delete the folder to clear it.

## US stock scan (Stage 3)

```
node src/cli.ts scan stocks                    # bundled synthetic fixture; never uses the network
node src/cli.ts scan stocks --fixture <file>   # another synthetic fixture (must declare "synthetic")
node src/cli.ts scan stocks --json             # structured result instead of the text report
node src/cli.ts scan stocks --live             # Massive end-of-day bars; explicit opt-in
node src/cli.ts scan stocks --live --max-requests 2   # capped smoke test (retries included)
```

**What it scans.** A fixed initial universe of 20 large, liquid US stocks
(`src/stocks/rules.ts`). That's a small, defined list, not a market-wide scan and not a
recommendation list; there is no universe discovery yet. For each ticker, the latest
completed session is compared with the 20 sessions before it:

- **Mover:** |1-day change| >= 4% on volume >= 1.5x the median.
- **Watchlist:** |1-day change| < 2% on volume >= 2x the median.

Evidence is scored as a rule tally, the same way the crypto scanner does it (unusual volume,
size of move, dollar volume traded, 5-day trend). It's not a probability. Exclusions:

- fewer than 15 usable baseline sessions
- a gap of more than 5 calendar days between bars
- a latest session more than 4 days old
- a close under $5
- a median under $20M traded per session
- relative volume above 50x (treated as a data error)
- duplicate symbols

Malformed or conflicting bars are counted and named in DATA NOTES, never used. All thresholds
are provisional heuristics.

**End-of-day data only.** The free plan gives end-of-day bars, so a morning scan describes the
previous completed session. It sees no pre-market or intraday moves. A bar for the current
session is ignored until 20:00 ET. Catalysts are not verified.

**Provider: Massive (formerly Polygon.io), free "Stocks Basic" plan.** From the official
documentation, checked 2026-10-21:

- 5 API calls per minute
- end-of-day data, 2 years of history, all US stock tickers
- individual, non-professional use only

The scanner makes one request per ticker to
`/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}?adjusted=true` (split-adjusted daily bars,
45 calendar days). Requests are spaced 12.5 s apart, so a full run of 20 tickers takes about
4 minutes. The 429 handling and request limit are the same as the crypto scan's. A ticker
whose request fails, or that is never requested because of the limit or a rate limit, is
excluded as "not evaluated", and the report is marked PARTIAL SCAN.

**API key.** Create a free key at massive.com yourself; the tool never creates accounts. Store
it as a Windows *user* environment variable named `POLYGON_API_KEY`, the name reserved in
`.env.example`. Use System Properties > Environment Variables, not a file in this
OneDrive-synced folder. Restart the terminal or app so it's picked up. The key is sent only
in the `Authorization: Bearer` header, never in a URL, and is never printed. Without it,
`--live` stops before making any request.

**First live smoke test (only after it's approved).** Run exactly
`node src/cli.ts scan stocks --live --max-requests 2`: at most 2 requests, retries included,
for the first 2 tickers. Check the following:

- the report shows the `Attribution:` line and `[VERIFIED DATA]` tags, and no TEST DATA
- the DATA NOTES say "2 of 2 allowed requests used"
- the other 18 tickers are listed as not requested, with the Universe line marked PARTIAL SCAN
- the latest session date is the last completed trading day
- the key appears nowhere in the output

Don't rerun it automatically or raise the limit without a separate decision.

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
src/stocks/               US-stock scanner: types, rules (incl. universe), normalize, analyze, render, command
src/providers/            http.ts (fetch client: timeout, budget, 429 retry); coingecko.ts, massive.ts
                          (adapters); history-cache.ts (S6 crypto history cache)
src/cli.ts                `option` and `scan` commands
test/                     node:test suites (textbook values and hypothetical inputs)
examples/                 clearly labelled hypothetical input
```

### Live market context for the option evaluator (Stage 4, opt-in)

`evaluateCall(contract, context)` takes a `ContractInput` (the quote) and a `MarketContext`
(rate, dividends, earnings date, historical volatility, trend). By default both are filled
only from pasted text and tagged `YOU PROVIDED`, and the `option` command never uses the
network.

`--live-context` makes **one** request to Massive (the same provider and `POLYGON_API_KEY` as
`scan stocks`) for the contract's `Underlying` ticker. It never retries. From the end-of-day
bars it calculates two values, both tagged `CALCULATED` with the latest completed session
date:

- **Historical volatility:** the sample standard deviation of the last 20 daily log returns,
  x sqrt(252).
- **Recent trend:** the % change from the close 20 sessions earlier to the latest close.

**Pasted values always stay the active input.** A fetched value only fills a field you left
empty. Otherwise it's shown below the report as a cross-check, next to your value. It never
replaces it. Without a key, or after a failed or rate-limited request or with too little,
gapped or stale history, the inputs stay unchanged and the report says why. `--live-context`
can't be combined with `--now`, and `--json` adds a `liveContext` object. Earnings and
dividend dates are not fetched. This path has not been run against live data yet.

## Safety rules built into this project

- No brokerage connection, no order placement, no automated trading.
- No paid APIs. API keys are read only from environment variables (Windows user environment
  variables), never from a file in this OneDrive-synced folder; the tool does not read `.env`.
- Never invents prices, Greeks, volume or IV. Missing inputs are reported as missing.
- Test and example data is always labelled as hypothetical.
