import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expirationCloseUtc, yearsBetween } from '../src/core/time.ts';
import { bsCall } from '../src/options/blackScholes.ts';
import { evaluateCall } from '../src/options/evaluate.ts';
import { parseContractText } from '../src/options/parse.ts';

// All inputs here are hypothetical test data for a fictional ticker.
const NOW = new Date('2026-10-20T14:20:00Z'); // 10:20 ET
const evaluate = (text: string) => {
  const parsed = parseContractText(text);
  return evaluateCall(parsed.contract, parsed.context, { now: NOW });
};

/** A liquid, fairly priced at-the-money call quoted at 30% volatility. */
function liquidAtmCall(extra = '', omit: string[] = []): string {
  const T = yearsBetween(NOW, expirationCloseUtc('2026-12-18'));
  const price = bsCall({ S: 100, K: 100, T, r: 0.04, q: 0, sigma: 0.3 });
  const lines: Record<string, string> = {
    underlying: 'Underlying: TEST',
    stock: 'Stock price: 100',
    strike: 'Strike: 100',
    exp: 'Expiration: 2026-12-18',
    type: 'Type: Call',
    bid: `Bid: ${(price - 0.05).toFixed(2)}`,
    ask: `Ask: ${(price + 0.05).toFixed(2)}`,
    volume: 'Volume: 800',
    oi: 'Open interest: 5000',
    time: 'Quote time: 2026-10-20 10:15 ET',
    earnings: 'Earnings date: 2027-01-25',
    hv: 'Historical volatility: 30%',
    rate: 'Risk-free rate: 4%',
    div: 'Dividend yield: 0%',
  };
  return [...Object.entries(lines).filter(([k]) => !omit.includes(k)).map(([, v]) => v), extra].join('\n');
}

test('a liquid, fairly priced contract with complete data can rate RELATIVELY_STRONG, with the loss caveat', () => {
  const ev = evaluate(liquidAtmCall());
  assert.equal(ev.verdict, 'RELATIVELY_STRONG', ev.verdictReasons.join('; '));
  assert.match(ev.verdictSummary, /can still lose the entire premium/);
  assert.match(ev.verdictSummary, /not a prediction/);
});

test('without historical volatility the price cannot be judged, so the rating is capped at MIXED', () => {
  const ev = evaluate(liquidAtmCall('', ['hv']));
  assert.equal(ev.verdict, 'MIXED');
  assert.match(ev.valuation, /Cannot assess whether the option is overpriced or underpriced/);
  assert.ok(ev.missingHelpful.some((m) => m.includes('Historical volatility')));
});

test('without a bid and ask the spread is unknown and the rating cannot be strong', () => {
  const ev = evaluate(liquidAtmCall('Premium: 5.10', ['bid', 'ask']));
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
  assert.equal(ev.checks.find((c) => c.id === 'spread')!.status, 'unknown');
});

test('missing stock price gives INSUFFICIENT_DATA and names exactly what is needed', () => {
  const ev = evaluate(liquidAtmCall('', ['stock']));
  assert.equal(ev.verdict, 'INSUFFICIENT_DATA');
  assert.ok(ev.missingRequired.some((m) => m.includes('stock price')));
  const iv = ev.metrics.find((m) => m.label.startsWith('Implied volatility (calculated)'))!;
  assert.equal(iv.evidence.kind, 'missing');
  assert.equal(ev.metrics.some((m) => m.group === 'Greeks'), false, 'no Greeks without inputs');
});

test('missing option price gives INSUFFICIENT_DATA', () => {
  const ev = evaluate(liquidAtmCall('', ['bid', 'ask']));
  assert.equal(ev.verdict, 'INSUFFICIENT_DATA');
  assert.ok(ev.missingRequired.some((m) => m.startsWith('Option price')));
});

test('puts and expired contracts are refused rather than guessed', () => {
  assert.equal(evaluate(liquidAtmCall('Type: Put', ['type'])).verdict, 'INSUFFICIENT_DATA');
  const expired = evaluate(liquidAtmCall('Expiration: 2026-10-16', ['exp']));
  assert.equal(expired.verdict, 'INSUFFICIENT_DATA');
  assert.ok(expired.verdictReasons.some((r) => r.includes('expired')));
});

test('a cheap, far out-of-the-money, nearly expired call is TOO_RISKY despite its low premium', () => {
  const ev = evaluate(`Underlying: TEST
Stock price: 100
Strike: 130
Expiration: 2026-10-23
Bid: 0.04
Ask: 0.06
Volume: 5000
Open interest: 20000
Quote time: 2026-10-20 10:15 ET
Earnings date: 2027-01-25
Historical volatility: 30%`);
  assert.equal(ev.verdict, 'TOO_RISKY', ev.verdictReasons.join('; '));
  assert.equal(ev.checks.find((c) => c.id === 'delta')!.status, 'fail');
  assert.equal(ev.checks.find((c) => c.id === 'time')!.status, 'fail');
});

test('a deep in-the-money call with a high model probability is not rated strong when liquidity is poor', () => {
  const ev = evaluate(`Underlying: TEST
Stock price: 100
Strike: 60
Expiration: 2026-12-18
Bid: 38
Ask: 44
Volume: 0
Open interest: 3
Quote time: 2026-10-20 10:15 ET
Earnings date: 2027-01-25
Historical volatility: 30%
Risk-free rate: 4%
Dividend yield: 0%`);
  const pItm = ev.metrics.find((m) => m.label === 'Model chance of finishing in the money')!.evidence.value as number;
  assert.ok(pItm > 0.9, `expected a high model probability, got ${pItm}`);
  assert.equal(ev.verdict, 'WEAK', ev.verdictReasons.join('; '));
  assert.equal(ev.checks.find((c) => c.id === 'spread')!.status, 'fail');
  assert.equal(ev.checks.find((c) => c.id === 'liquidity')!.status, 'fail');
});

test('a deep in-the-money quote warns that IV and Greeks are poorly determined', () => {
  const T = yearsBetween(NOW, expirationCloseUtc('2026-12-18'));
  // Quoted at 20% vol, but after rounding to cents the same mid price also fits ~25% vol.
  const price = bsCall({ S: 100, K: 75, T, r: 0.04, q: 0, sigma: 0.2 });
  const ev = evaluate(`Stock price: 100\nStrike: 75\nExpiration: 2026-12-18\nBid: ${(price - 0.05).toFixed(2)}\nAsk: ${(price + 0.05).toFixed(2)}`);
  assert.notEqual(ev.verdict, 'INSUFFICIENT_DATA');
  assert.ok(ev.warnings.some((w) => w.includes('poorly determined')), ev.warnings.join(' | '));
});

test('earnings before expiration are flagged as an IV-crush risk', () => {
  const ev = evaluate(liquidAtmCall('Earnings date: 2026-11-05', ['earnings']));
  const check = ev.checks.find((c) => c.id === 'earnings')!;
  assert.equal(check.status, 'caution');
  assert.match(check.detail, /IV crush/);
});

test('an old quote is flagged as possibly stale', () => {
  const ev = evaluate(liquidAtmCall('Quote time: 2026-10-19 15:59 ET', ['time']));
  assert.equal(ev.checks.find((c) => c.id === 'freshness')!.status, 'caution');
});

test('values are tagged honestly: nothing is presented as verified market data in offline mode', () => {
  const ev = evaluate(liquidAtmCall());
  assert.equal(ev.metrics.some((m) => m.evidence.kind === 'verified_market_data'), false);
  const kindOf = (label: string) => ev.metrics.find((m) => m.label === label)!.evidence.kind;
  assert.equal(kindOf('Stock price'), 'user_provided');
  assert.equal(kindOf('Breakeven at expiration'), 'calculated');
  assert.equal(kindOf('Implied volatility (calculated)'), 'calculated');
  assert.equal(kindOf('Delta'), 'calculated');
  assert.equal(kindOf('Model chance of finishing above breakeven'), 'estimate');
});

test('assumed rate and dividend are labelled as assumptions and disclosed', () => {
  const ev = evaluate(liquidAtmCall('', ['rate', 'div']));
  const rate = ev.metrics.find((m) => m.label === 'Risk-free rate')!;
  assert.equal(rate.evidence.kind, 'estimate');
  assert.ok(ev.warnings.some((w) => w.includes('assumed 4.0%')));
  assert.ok(ev.warnings.some((w) => w.includes('assumed 0%')));
});

test('the calculated IV reproduces the volatility used to build the quote', () => {
  const ev = evaluate(liquidAtmCall());
  const iv = ev.metrics.find((m) => m.label === 'Implied volatility (calculated)')!.evidence.value as number;
  // Bid/ask were rounded to cents, so allow a small tolerance around 30%.
  assert.ok(Math.abs(iv - 0.3) < 0.002, `IV ${iv}`);
});

test('scenarios: maximum loss equals the cost, and the breakeven row shows zero P/L', () => {
  const ev = evaluate(liquidAtmCall('Premium: 5.00'));
  const maxLoss = ev.metrics.find((m) => m.label === 'Maximum loss')!.evidence.value;
  assert.equal(maxLoss, 500);
  const be = ev.expiryScenarios.find((s) => s.label === 'At breakeven')!;
  assert.equal(be.stockPrice, 105);
  assert.ok(Math.abs(be.pnl) < 1e-9);
  assert.ok(ev.expiryScenarios.every((s) => s.pnl >= -500));
});

test('the what-if table shows a loss when the stock is flat (time decay)', () => {
  const ev = evaluate(liquidAtmCall());
  const w = ev.whatIf!;
  const flat = w.pnl[w.stockMoves.indexOf(0)]![w.ivChangePoints.indexOf(0)]!;
  assert.ok(flat < 0, `flat-stock P/L should be negative, got ${flat}`);
  // Lower IV is always worse for the holder, all else equal.
  for (const row of w.pnl) for (let j = 1; j < row.length; j++) assert.ok(row[j]! > row[j - 1]!);
});
