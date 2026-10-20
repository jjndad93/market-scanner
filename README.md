# market-scanner

A local research tool for US stocks, crypto and call options. It explains evidence; it does
not predict prices, connect to a brokerage, place orders or trade automatically.

**Status: Stage 1.** The offline call-option evaluator works. The morning scanner
(`scan`) is planned for Stages 2-5 and is not built yet.

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
  with the reasons. "Relatively strong" requires known, good liquidity, a fresh quote, a
  price that is not expensive compared with the stock's recent volatility, and a known
  earnings date. The rating never improves because a premium is low or because a
  calculated probability is high.
- **Key numbers**, each tagged by provenance: `YOU PROVIDED`, `CALCULATED`, `THIRD-PARTY`
  (for example broker-reported IV or delta), `ESTIMATE` (model outputs and default
  assumptions), `MISSING`. `VERIFIED DATA` is reserved for values fetched from a market-data
  source in later stages.
- **Checks**: spread, open interest and volume, quote freshness, time decay, breakeven compared with
  the implied move, delta, IV compared with historical volatility, earnings and dividends before expiration.
- **Profit/loss at expiration** (exact payoff math) and a **before-expiration what-if table**
  (model estimate across stock moves and IV changes). This shows how a call can lose value
  while the stock rises.
- **Model limitations**, including Black-Scholes' treatment of American exercise and dividends.

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
