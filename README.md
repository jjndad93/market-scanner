# market-scanner

A local research tool for US stocks, crypto and call options. It explains evidence; it does
not predict prices, connect to a brokerage, place orders or trade automatically.

**Status: Stages 1-8 complete.** Every command runs offline on synthetic fixtures by default.

- **Option evaluator:** works offline, with opt-in live context via `--live-context`.
- **Crypto scan (`scan crypto --live`, CoinGecko):** run against live data in small capped
  smoke tests.
- **Stock scan (`scan stocks --live`, Massive end-of-day):** run in one capped smoke test.
- **Options discovery (`scan options --live`):** built and tested offline only. It needs a paid
  Massive options plan.

## Requirements

Node.js 22.18 or newer (runs the TypeScript files directly). No packages to install. No API
keys are needed for anything offline.

## Quick start (Windows PowerShell)

Every line below runs unchanged except the first, where `<path-to>` is a placeholder for
wherever this folder is on your computer. Nothing here uses the network unless the line says
**live**.

```powershell
cd "<path-to>\market-scanner"      # placeholder: replace <path-to> with your folder
npm test                                                   # offline test suite
node src/cli.ts --help                                     # every command, flag and key name
node src/cli.ts scan crypto                                # crypto scan, synthetic fixture
node src/cli.ts scan stocks                                # US stock scan, synthetic fixture
node src/cli.ts scan stocks --json                         # same, as structured JSON
node src/cli.ts option --file examples/hypothetical-contract.txt   # evaluate a contract file
node src/cli.ts option --template                          # the fields a contract file can hold
node src/cli.ts scan options                               # options discovery, synthetic fixture
node src/cli.ts scan crypto --live --max-requests 4        # LIVE: at most 4 CoinGecko requests
node src/cli.ts scan stocks --live --max-requests 2        # LIVE: at most 2 Massive requests
node src/cli.ts option --file examples/hypothetical-contract.txt --live-context   # LIVE: 1 request
node src/cli.ts scan options --live --symbols AAPL --max-requests 1   # LIVE: paid options plan only
```

### Web dashboard (crypto and US stocks)

```powershell
npm run web                     # then open http://127.0.0.1:4173 in your browser; Ctrl+C stops it
npm run web -- --port 4174      # another port, if 4173 is busy
```

**Using it.** Choose the market (**Cryptocurrency** or **US stocks**) and **Offline** (the
synthetic fixture; no API requests) or **Live** (CoinGecko or Massive), then click **Scan**. The page shows:

- COMPLETE or PARTIAL status, the next step, and the counts
- history coverage and the API requests used (crypto)
- freshness
- every asset the scanner evaluated, in the scanner's own order (qualified first, by rank)
- for each: signal and evidence score, volume multiple, short and long change, unit price with
  its time and basis, and risk measures
- the reasons behind each score ("Why")
- exclusions, grouped by first reason, what the data cannot show, and the data notes

**Budget filters.** These are three separate controls:

- **Total budget (USD)**
- **Maximum unit price** (or "No unit-price limit")
- **Show:** affordable assets, stronger signals, or both

Changing them re-filters the last result in the browser. They make no API request.

For each asset the page shows:

- the maximum whole units, `floor(budget ÷ unit price)`
- the approximate cost, before fees
- whether it passes the budget check and the unit-price check, with the reason if not

Whole units only: fractional shares or coins are not assumed. The filters never change a score or
the order, and are never sorted by price. Qualified signals outside your limits stay listed in a
collapsed section. A low unit price is not a sign of value. Nothing here means an asset can be
bought through this tool, which has no brokerage connection.

**Crypto category (label only).** Each evaluated coin gets one label:

- Established
- Stablecoin
- Wrapped/staked
- Unknown

Each label shows its basis and every piece of evidence found:

| Basis | Evidence |
|---|---|
| **Curated list** (decides first) | The project's existing stablecoin and wrapped/staked ids, symbols and tags |
| **Heuristic** | The existing pegged-price pattern, or a CoinGecko market-cap rank of 20 or better ("established" means large, not legitimate or safe) |
| **None** | Contradictory evidence at the deciding level, or no evidence at all, gives **Unknown** |

A name such as "Wrapped …" is recorded but never used on its own.

**Meme coin** and **Other project/utility** are never assigned: CoinGecko's market list has no
category field. The smallest way to add meme coins:

1. Verify the meme category id once with `/coins/categories/list`.
2. Add one opt-in `/coins/markets?category=<id>` request per scan.

The labels do not change the existing stablecoin and wrapped/staked exclusion filters.

**Crypto volatility** comes from the same market-list response, so it costs no extra request.
The period is CoinGecko's rolling 24 hours at the coin's last update.

| Measure | Formula or source | Flagged when |
|---|---|---|
| 24h range | `(high_24h − low_24h) / low_24h × 100` | ≥ 30% |
| Drop from the 24h high | `(price − high_24h) / high_24h × 100` | ≤ −20% |
| Drawdown from the all-time high | Provider figure, with the ATH date | ≤ −90% |
| Turnover | 24h volume as a % of market cap | — |
| Volume-baseline variability | Q3/Q1 of the baseline volumes | Highly variable |
| Data age | Minutes since the coin's last update | — |

The flag thresholds are informational heuristics.

If the price lies outside the provider's own 24h low–high (snapshots taken at different times), the
range is not computed and the reason is shown. Not available: an intraday price series, the bid/ask
spread, and, for stocks, the intraday range (the end-of-day bars carry a high and low, but they are
not parsed yet).

**Re-run** repeats the last scan. Synthetic results carry a TEST DATA banner.

**Market movement & news.** Each evaluated asset has a **News & why it may be moving** button.
Nothing is fetched until you click it. The panel opens under the asset's row, without leaving the
results, and shows:

- **The move:**
  - the short and long change and the volume multiple
  - the intraday measures the data supports (crypto: 24h range and drop from the 24h high;
    stocks: none, because the bars are end of day)
  - the data's time and source
- **Why it may be moving:** one of these verdicts:

  | Verdict | When |
  |---|---|
  | Possible catalyst | An article tagged with the asset, focused on it (named in the headline, or the only ticker), and published **before or during** the move |
  | Conflicting reports | The articles around the move disagree, or all point against it, by the provider's automated sentiment |
  | Unconfirmed | Related articles exist, but none qualifies |
  | No relevant news found | No article is tagged with the asset |

  Every verdict other than "Possible catalyst" says the reason is unknown. Even "Possible
  catalyst" is a timing-and-topic link, never confirmed causation.

  The move window is:
  - **stocks:** the latest session, previous close to latest close (4 pm ET)
  - **crypto:** the rolling 24 hours to the last update
- **Article cards:** each card shows:
  - the headline, publisher and publication time
  - the publisher's or provider's description (not verified, and not written by this tool)
  - what the provider reports (the reported fact)
  - why the article may or may not be relevant
  - an evidence label: possible catalyst (moderate or weak), published after the move,
    background only, or time unknown
  - a **View original article** link, which opens in a new tab without a referrer

  An article published **after** the move is labelled as such and is never treated as its cause.
  One with no valid publication time is never a catalyst. Articles not tagged with the asset are
  dropped, never shown. Among duplicates the earliest copy is kept.

**Stock news source.** [Massive ticker news](https://massive.com/docs/rest/stocks/news)
(`/v2/reference/news`). Its docs list it in every Stocks plan, including the free Basic plan,
updated hourly. It uses the existing `POLYGON_API_KEY`; no new key is needed.

- **Offline scans** use a synthetic news fixture (`test/fixtures/stock-news.synthetic.json`,
  labelled TEST DATA, example.com links) and make **no requests**.
- **After a live stock scan,** opening a panel asks for confirmation, then sends **exactly one**
  request (newest articles for that ticker from the last 60 days).
- **Caching:** the result is kept in memory for 60 minutes. Re-opening the panel within that time
  costs nothing. **Refresh news** bypasses the cache and asks again.
- **Articles per asset:** set in the page, 1 to 20 (default 5).
- **Request spacing:** live news requests are at least 12.5 s apart, to stay under the free plan's
  5 calls per minute, which stock scans share.
- **Never in parallel:** news and scans never run at the same time.
- **Errors:** 401, 403, 429, timeouts, server errors and malformed responses become short messages,
  with the key never included. A failed refresh keeps showing the earlier result, marked as such.
- **Untrusted content:** article fields are treated as untrusted data. Control characters are
  removed, fields are length-capped and inserted as text only, and only plain http(s) links are
  kept.

**Crypto news: not available.** No crypto news source is configured:

- CoinGecko's `/news` endpoint needs a paid plan (Analyst or higher).
- The other documented crypto news APIs (CryptoPanic, CoinDesk Data) need a new key and a paid
  plan.

Adding one needs approval. Until then a crypto panel shows the move and says the reason is unknown.

**News limitations.**

- The tool reads only headlines and descriptions, never full articles, so it cannot confirm what
  an article says beyond them.
- Matching relies on the provider's ticker tags.
- Sentiment is the provider's AI-generated label.
- Coverage is whatever Massive aggregates. It is updated hourly, so very recent news may be
  missing.

**Plain-English explanations.** Each research lead and each CoinMarketCap cross-check result starts
with plain English, followed by the scanner's exact evidence, unchanged:

- each lead gets one sentence on why it appeared, such as "Trading activity is unusually high (about
  3.5× its usual level), but the price has barely moved.", then every warning that applies, in a
  fixed priority order, or a next step when there is none:
  1. data quality (stale, missing, implausible, not checked against its own history, an unsteady
     baseline)
  2. volatility (the existing flags: far below its 24-hour high, a 24-hour swing of 30% or more,
     90% or more below its all-time high, an extreme trading spike)
  3. weaker evidence
- these come from the scan itself (`src/scanner/lead-quality.ts`): `scan crypto --json` includes
  them as `explanation` on each research lead, and the dashboard shows the same text. The CLI text
  report is unchanged.
- each cross-check result gets one sentence, such as "The two data sources disagree: price differs
  by 5.2%."

The layout is otherwise unchanged. These are research priorities, not buy or sell recommendations.

**Research leads (crypto discovery).** Crypto results open with a **Research leads** section.
It surfaces assets beyond the shortlist of up to 5 movers and 3 watchlist entries, using only data
the scan already has. Every lead says why it was surfaced (its evidence, with values) and what
limits that evidence.

| Tier | Meaning |
|---|---|
| **High priority** | A qualified **mover**: a large 24h move **and** unusual volume against its own 30-day baseline. The baseline must be measured and stable (Q3/Q1 below 4×), with no extreme spike (10× or more). Several signals agree. |
| **Watchlist** | Noteworthy, but weaker or incomplete evidence. One of: a qualified volume-only candidate; a mover with a variable or unmeasured baseline or an extreme spike; a pattern below the evidence threshold; or an evaluated asset with a large 24h or 7-day move but normal volume for itself. |
| **Insufficient data** | The snapshot shows activity, but the asset could not be evaluated responsibly: history not requested (request limit) or failed, too few or unreliable baseline days, stale or missing data, or values beyond the plausibility limits. |

Activity signals come from the market snapshot alone:

- a 24h move of at least 8% (the mover threshold)
- 24h volume of at least 15% of market cap
- a 7-day move of at least 20%

They are never scored. Tiers never change scores, ranks or display limits.

Leads that are not listed:

- assets excluded by scope rules (stablecoins, wrapped or staked tokens, size or volume minimums);
  these are counted in the notes
- high turnover alone, when the asset's volume is normal for itself

**Smarter use of the request limit (live).** Histories used to be requested in market-cap order,
so a small `--max-requests` evaluated only the largest coins. Now assets showing snapshot activity
are requested first, then the rest in market-cap order. The number of requests, the limit, the
cache and the retry rules are unchanged, and the live notes say how many were prioritized. With
enough requests the same histories are fetched as before.

**Coverage.** The scan covers two `/coins/markets` pages: CoinGecko's top 500 by market cap (`MARKET_PAGES` in `src/providers/coingecko.ts`). If page 2 fails or the request limit is reached, the scan continues with page 1 and says so in its notes.
Coins outside it are not scanned; use **Find a crypto asset** to look one up. Incomplete scans
(request limit, failures) are reported in the leads' notes.

The CLI text report is unchanged; `--json` output gains a `discovery` key.

**Second source: CoinMarketCap (Stage A).** Under the research leads, **Cross-check leads with
CoinMarketCap** compares each lead with CoinMarketCap (CMC). It runs only when you click it and
never changes the scan, its scores, tiers or filters. It follows the last crypto scan's mode:

- **Offline** uses a synthetic listings fixture (`test/fixtures/cmc-listings.synthetic.json`,
  TEST DATA) and makes no requests.
- **Live** sends **one** request, `/v3/cryptocurrency/listings/latest`, for the top 500 coins by
  CMC rank with `cmc_rank` and `tags` (about 2 credits), after you confirm.

For each lead the panel shows:

- **Matching**, which is conservative because symbols are not unique on either provider. A lead is
  matched only when a CMC coin has the same symbol **and** the same name (case and punctuation
  ignored), or a CMC slug equal to the CoinGecko id. A symbol alone never matches. Otherwise the
  lead is labelled:
  - **ambiguous:** several CMC coins share the symbol and name
  - **not matched:** the symbol is used under a different name
  - **not found:** not in CMC's top 500
- **Price and market cap:** compared within 2% and 10%, with timing gaps over 30 minutes noted.
  24h volume is not compared, because CMC reports "adjusted" volume, a different method.
- **CMC's tags**, as provider evidence. A `memes` or `stablecoin` tag also gives a category label.
- **On the research lead itself:** once you have run the cross-check, each lead also shows that
  check's warnings, labelled "Second source:". They are:
  - different prices
  - different market values
  - could not be matched confidently
  - not listed in CMC's top 500
  - data missing, so the values could not be compared
  - snapshots too far apart in time

  The server decides each warning from the same verdicts and tolerances. The page finds a lead's
  result by its unique CoinGecko id, never by symbol, and only for the scan on screen. Values that
  agree add no warning. Before a cross-check, or after a new scan, leads say nothing about a second
  source.
  These tag names are assumed from CMC's site and must be confirmed on the first live response.

Requirements and how this tool meets them (from CMC's official docs and Commercial API Terms,
read 2026-10-22):

- **Key handling:** the key is read **only** from the `COINMARKETCAP_API_KEY` environment
  variable, on the server.
  - Set it once as a Windows user environment variable (Start > "Edit environment variables for
    your account"), then restart the terminal and the dashboard. Never put it in a file in this
    folder.
  - It is sent only in the `X-CMC_PRO_API_KEY` header. It is never put in a URL or logged, and it
    is redacted from every response and error.
  - The page sees only "key configured: yes/no".
- **Plan limits (free Basic):** 15,000 credits a month, 50 requests a minute, 1 key.
  - Listings cost 1 credit per 250 coins returned, so this check costs about 2 credits.
  - The panel shows the credit count CMC reports. Each dashboard session allows at most 20
    cross-check requests, one at a time, never during a scan.
- **Stopping:** some errors stop all CMC requests until the dashboard restarts, so no further
  credits are spent:
  - a rejected key (401)
  - payment (402)
  - a plan or access problem (403, including error 1006, "plan does not include this endpoint")
  - a daily or monthly credit limit (429, errors 1009 and 1010)
  - any other 429 without an error code

  The per-minute limit (errors 1008 and 1011) pauses requests for 60 s. Timeouts and server errors
  are reported without stopping. Nothing is retried.
- **Attribution:** "Data provided by CoinMarketCap.com", with a link to coinmarketcap.com. It is
  shown prominently above the cross-check results and on every matched lead.
- **Temporary storage:** the terms allow storing content only temporarily, as needed to show it.
  - The parsed listing subset is kept **in memory only**, for 10 minutes.
  - It is dropped when it expires or the dashboard stops, and nothing is written to disk.
  - **Run the cross-check again** asks before sending a new request.
- **Licence:** the free plan's licence covers one product used by end users for personal,
  non-commercial purposes. It forbids redistributing the data on its own.

Not in Stage A:

- historical-volume baselines from CMC
- any CMC use in the CLI
- CMC trending or gainers endpoints (whether the free plan includes them is not documented)

**Find a crypto asset.** The search box under the scan panel finds any coin CoinGecko lists, by
name or symbol, including coins the scanner did not select. Searching is separate from scans:
it never starts one and never changes scan results or the budget filters.

- **When it runs:** only when you press **Search** or Enter, never while you type.
- **Offline / Live:** it follows the page's **Data** choice.
  - **Offline** searches a small fixture of invented coins (`test/fixtures/crypto-search.synthetic.json`,
    labelled TEST DATA) and makes no requests.
  - **Live** asks before each request, then sends exactly one:
    - a search uses CoinGecko `/search`, which covers all listed coins, sorted by market cap
    - a lookup uses `/coins/markets?ids=<id>`, the same market fields and validation as the scan
- **Results:** each shows the name, symbol, CoinGecko id, market-cap rank and how it matched.
  Exact symbol, name or id matches come first, then the rest in market-cap order; at most 25 are
  shown.
- **Ambiguous symbols:** symbols are not unique on CoinGecko. When several coins share a symbol,
  all are listed and flagged, and none is chosen for you. You pick one by name and id, and the
  lookup uses that unique id.
- **The selected coin:** shows its price, 24h and 7d change, 24h volume, market cap, 24h range
  and rank, plus when CoinGecko last updated it, the source and when it was fetched.
  - Values the provider does not supply are shown as not available.
  - A coin with no market data says so.
  - It also says whether the latest scan evaluated the coin (and how), or that it was not among
    the evaluated assets.
- **Request protections (live):**
  - the key stays on the server
  - each request uses the existing client with a 1-request budget, and a rate limit fails at once
    instead of waiting to retry
  - searches are cached for 15 minutes and lookups for 5; **Refresh** asks again
  - live requests are at least 2 s apart (the Demo plan allows 30 a minute)
  - one request runs at a time, and never during a scan (scans also wait for it)
  - each dashboard session allows at most 100 live search requests
  - errors (no key, 401, 403, 429, timeouts, outages, malformed responses) become short messages,
    with the key never included
- **Limitations:**
  - CoinGecko decides what `/search` returns and how it orders it.
  - Coins without a market-cap rank or market data can still appear in results.
  - Search covers crypto only.

**Safety.**

- **Live scans need you:** they run only when you pick Live and confirm the browser prompt.
- **Request limit:** set it in the page (default 5). The server checks it (a whole number from
  1 to 160), and the existing request client enforces it, retries included.
- **Same engine as the CLI:** scans run inside the server through the same command code as the
  CLI, with a fixed argument list and no shell. So the key check, cache, authentication stops
  and partial-scan reporting are identical.
- **Local only:** the server listens on 127.0.0.1 only. It refuses other Host headers, and it
  accepts scan requests only from its own page.
- **One scan at a time.**
- **Keys stay on the server:** only "key configured: yes/no" reaches the browser, and nothing
  runs on a schedule.
- **Limits:** no stop button. A running live scan is bounded by the
  request limit and the 15-second per-request timeout.

### Daily workflow (Windows PowerShell)

A routine for each morning. Steps 1-4 are offline and free; only step 5 spends API requests,
and only if you run it.

```powershell
npm test                                                   # 1. confirm the tool works (offline)
node src/cli.ts scan crypto                                # 2. crypto scan (offline fixture)
node src/cli.ts scan stocks                                # 2. US stock scan (offline fixture)
node src/cli.ts option --file examples/hypothetical-contract.txt   # 3. evaluate a contract
node src/cli.ts scan options                               # 4. options discovery (offline fixture)
node src/cli.ts scan stocks --live --max-requests 20       # 5. LIVE: up to 20 Massive requests
node src/cli.ts scan crypto --live --max-requests 40       # 5. LIVE: up to 40 CoinGecko requests
```

To see your own contract in step 3, put its details in a text file and pass that file's path
in place of `examples/hypothetical-contract.txt`.

**Reading the result.** Start with the **SCAN SUMMARY** at the end of each report:

- **Freshness** says what the data is:
  - synthetic test data (invented timestamps)
  - fresh provider data, with its fetch time; nothing is described as real-time
  - histories reused from today's cache
  - how many items were excluded as stale
- **Status** is `COMPLETE` for the scanned scope, or `PARTIAL` with the reason, such as the
  request limit, a rate limit, or a rejected key.
- **Next step** appears only when something limited the scan, and says what to do. For
  example, raise `--max-requests`, wait out a rate limit, or check the key or plan; a
  rejected key won't be fixed by retrying.
- **Qualified** names the candidates worth a closer look. **Not qualified** shows why the
  rest were left out.

Each candidate entry in the report shows its own evidence ("Why"), risks and data time. None
of it is a prediction or a recommendation.

**Saving JSON for later.** Save outside this OneDrive-synced folder. Use `Out-File -Encoding
utf8`, because PowerShell 5.1's `>` writes UTF-16, which many tools can't read:

```powershell
New-Item -ItemType Directory -Force "$HOME\market-scans" | Out-Null
node src/cli.ts scan stocks --json | Out-File -Encoding utf8 "$HOME\market-scans\stocks-$(Get-Date -Format yyyy-MM-dd).json"
Get-Content "$HOME\market-scans\stocks-$(Get-Date -Format yyyy-MM-dd).json" -Raw | ConvertFrom-Json | Select-Object -ExpandProperty scan
```

The saved file holds the full result, with the same summary under `scan`: `status`,
`freshness`, `qualifiedNames`, `nextStep` and the counts. Add `--live` to the `node` line only
when you mean to spend requests.

**Your own contract:** copy the output of `option --template` into a text file and replace the
example values with your broker's figures. Then run
`node src/cli.ts option --file my-contract.txt`, where `my-contract.txt` is your file's name.
Never put an API key in that file.

**Live data:** only the lines marked LIVE use the network.

- **Keys:** set them once as Windows *user* environment variables (Start > "Edit environment
  variables for your account" > New): `COINGECKO_DEMO_API_KEY` for crypto, and `POLYGON_API_KEY`
  for stocks, options and `--live-context`.
- **Restart the terminal** after setting a key so it's picked up.
- **Keep keys out of the command line:** don't type a key into a command, which can save it in
  your history.
- **Request limits:** `--max-requests` caps each live run, retries included.
- **Missing key:** a live command stops before making any request and tells you which variable
  to set.
- **Errors:** when a live request fails, the message says what happened and what to do next.
  For example, a key the provider rejected (HTTP 401) or a plan without access (HTTP 403)
  can't be fixed by retrying.

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
- **Volume baseline reliability (Stage 11, informational only):** for each candidate, the
  scanner measures how spread out its baseline's daily volumes are, as the interquartile ratio
  Q3 / Q1. In plain terms, that's how many-fold the middle half of the days spans.
  - **When it shows:** a ratio of 4 or more adds a "Volume baseline: HIGHLY VARIABLE" line to
    that candidate. On real data, large coins measured 1.4-2.5.
  - **Why this measure:** it ignores the lowest and highest quarter of days, so one tiny or huge
    day can't set it off (max/min can).
  - **Too few days:** with fewer than 20 valid days the line says the variability wasn't
    measured.
  - **What it changes:** no score, threshold, filter or ranking. It only says that a volume
    multiple from such a baseline is less conclusive. It doesn't imply manipulation or bad
    data.
  - **JSON:** each candidate gains `volumeReliability`.
- **Missing history days** (live): each coin with missing daily observations is named in DATA
  NOTES. The note says whether the days fall inside its 30-day baseline window, where they're
  counted as unusable, or before it, where they weren't used and didn't affect the baseline.
  This is separate from stale data, which concerns how old the current price and volume are.
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

**Live mode** uses the CoinGecko Demo API: two `/coins/markets` requests (top 500 by market cap)
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
server's Retry-After (if given and at most 60 s). A rejected key (HTTP 401) or refused access
(HTTP 403) on a history request is never retried. It stops all further requests at once, because
every later request would be rejected too. Histories fetched or cached before that point are
kept, the rest are reported as not requested, and the scan is marked PARTIAL. Each asset that passes the non-history filters
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
variable. Store it as a Windows *user* environment variable (Start > "Edit environment
variables for your account"), not in a file inside this OneDrive-synced folder. Avoid typing
the key into a terminal command, because it can stay in your shell history. The key is sent only in the `x-cg-demo-api-key` header, never in a URL,
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
4 minutes. The 429 handling and request limit are the same as the crypto scan's, and so is the
authentication stop: a 401 or 403 ends the run with no retry and no further requests. A ticker
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

## Scan summaries (Stage 7)

Every scan report (`scan crypto`, `scan stocks`, `scan options`) ends with a **SCAN SUMMARY**:

- what was scanned
- the data (synthetic fixture, live, or live with cache reuse) and whether the run was offline
- how many candidates qualified
- why the rest didn't: excluded, by first reason, plus the other outcomes such as "scored below
  the evidence threshold", "insufficient data" or "puts not evaluated"
- whether the scan was **COMPLETE** for its scope or **PARTIAL**, and why

All counts come from the scan result itself, and they always add up to the number scanned.
A complete scan is still described as "not a market-wide scan".

`--json` output gains the same information as an additive `scan` object (`scanType`,
`scannedAt`, `mode`, `data`, `source`, `scope`, `status`, `partialReasons`, `counts`,
`qualified`, `notQualified`). Every existing field keeps its name and meaning.

Other changes:

- The stock report shows each excluded ticker's first reason in detail. Tickers that were
  never evaluated stay grouped.
- The options report shows each exclusion example with its specific reason, and an
  "incomplete record" now says which fields were **missing** and which were **invalid**.
- Both reports have a one-line legend saying which values are provider-supplied and which are
  calculated.
- An impossible date from a provider, such as month 13, is now counted as invalid instead of
  stopping the scan.

## US options discovery (Stage 6)

```
node src/cli.ts scan options                    # bundled synthetic fixture; never uses the network
node src/cli.ts scan options --json             # structured result
node src/cli.ts scan options --live --symbols AAPL,MSFT --max-requests 2   # needs a paid options plan
```

**Provider limitation.** Live discovery uses Massive's option-chain snapshot
(`/v3/snapshot/options/{underlying}`): bid/ask, last trade, volume, open interest, IV and
Greeks per contract. According to Massive's pricing page (checked 2026-10-21), the **free
Options Basic plan does not include** Snapshot, quotes (bid/ask), Greeks/IV or open interest.
Snapshot starts at Options Starter, and the page lists bid/ask quotes only on Options
Advanced. Whether a Starter snapshot carries a delayed bid/ask hasn't been verified. On a plan
without access, the first request fails (HTTP 401/403) and the run stops. The report then says
exactly which capability is missing, and nothing is filled in. **The live path has not been run
against live data.**

**What it does.**

1. **Requests:** one request per underlying. The default list is the stock scanner's 20
   tickers, or use `--symbols`. Expirations requested are 7-60 days out, with up to 250
   contracts per underlying. There's no pagination yet, and the report says when a page
   was cut off.
2. **Validation:** each contract is checked, with missing fields kept missing.
3. **Exclusions,** each with a recorded reason:
   - incomplete records, expired contracts, and those under 7 days to expiration
   - missing, crossed, zero-offer or stale (over 4 days, undated, or future-dated) quotes
   - spreads wider than 10% of mid
   - open interest under 100, when it's supplied

   The spread, open-interest and expiration limits are the option evaluator's own thresholds.
4. **Evaluation:** eligible **calls** go through the existing evaluator, unchanged. Provider
   quotes are tagged `VERIFIED DATA` and provider IV and Greeks `THIRD-PARTY`. Missing fields
   stay `MISSING`, and no premium or context is invented. Eligible **puts** are listed as not
   evaluated, because the evaluator handles calls only.
5. **Ranking:** contracts are ordered by evaluator verdict, then data reliability, tighter
   spread and higher open interest. This is a rule-based order, not a forecast, and
   `INSUFFICIENT DATA` contracts are listed separately, not ranked.

Without pasted context (historical volatility, earnings and dividend dates), the evaluator
keeps verdicts cautious and says what's missing. No contract is called safe or profitable.

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
src/scanner/              crypto scanner: types, rules, normalize, analyze, render; command (scan CLI);
                          insights.ts (dashboard category labels and volatility measures)
src/web/                  local dashboard: server.ts, rows.ts (dashboard rows), news.ts (news
                          panel service), public/ (page, app.js, budget.js shared with the tests)
src/news/assess.ts        news-to-move assessment ("why it may be moving"); no network
src/providers/massive-news.ts  Massive ticker-news adapter (validation, cleaning)
src/providers/coingecko-search.ts  CoinGecko /search and single-coin /coins/markets adapter
src/web/crypto-search.ts  dashboard crypto search service (offline fixture, live guards, caches)
src/providers/coinmarketcap.ts  CoinMarketCap listings adapter (validation, error codes, stop rules)
src/scanner/cross-check.ts  conservative CoinGecko-to-CMC matching and value comparison (no network)
src/web/cmc-check.ts      dashboard CMC cross-check service (offline fixture, confirmation, memory-only cache)
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

## Where to buy (dashboard)

Each row in the dashboard has a **Where to buy** button next to **News**.

- **Crypto, live scan:** one CoinGecko request (`/coins/{id}/tickers`, uses `COINGECKO_DEMO_API_KEY`), asked for with a confirmation and cached for an hour. Exchanges are grouped and sorted with US-friendly ones first, then by 24h volume. Decentralized exchanges are listed separately, with the contract address they trade, plus a link to confirm it on CoinGecko. Markets CoinGecko flags as stale or anomalous are skipped.
- **Crypto, offline scan:** an invented fixture (`test/fixtures/crypto-tickers.synthetic.json`), labeled TEST DATA. No requests.
- **Stocks:** no request. Every stock in the scan list is a large NYSE/Nasdaq listing that any US broker can buy.
- The "US access" label comes from a fixed list in `src/web/where-to-buy.ts` (`US_ACCESS`), not from the provider. Edit it when an exchange changes its policy.

The default maximum unit price on the dashboard is now $50.

## Market-wide stock movers (`--movers`)

`node src/cli.ts scan stocks --live --movers` (and every live stock scan in the dashboard) no longer looks only at the fixed list of 20 large stocks. It reads Massive's **Daily Market Summary** (`/v2/aggs/grouped/locale/us/market/stocks/{date}`, included in the free Stocks Basic plan), which returns every US stock's end-of-day bar in one request:

1. Two requests (three around a holiday) fetch the two latest sessions, starting from yesterday in New York, because Basic makes a session available after midnight ET. Weekends are skipped without a request.
2. Stocks priced **$5-$50** with at least **$20M** traded in the latest session, and with a plain 1-5 letter ticker (no OTC, warrants or units), are ranked by their close-to-close change.
3. The **15 biggest gainers** get the usual per-ticker history and scoring (20-session volume baseline, mover and watchlist rules).

The limits are in `MARKET_MOVERS` in `src/providers/massive.ts`. A run uses about 17 requests at the free plan's pace (12.5 s apart), so 3-4 minutes. If two sessions cannot be found, the scan falls back to the fixed list and says so in its notes.

## Dashboard conveniences

- **Remembered settings:** Max API requests, budget, unit-price limit, Show and Direction are remembered in this browser.
- **Morning auto-scan** (Settings): when ticked, a live crypto scan runs when the dashboard opens, at most once every 30 minutes. `install-morning-scan.cmd` opens the dashboard every day at a time you choose (Windows Task Scheduler); `remove-morning-scan.cmd` undoes it.
- **Save to Snapshot Log** (each row) and **Send these to Snapshot Log** (top 10 of the main table) open the Asset Snapshot Log on claude.ai with the numbers in the link's #fragment, which browsers never send to a server. Nothing is saved until you click Save there. Its pages also open in the Claude phone app, so this is how scan results reach your phone without exposing this computer to the network.
