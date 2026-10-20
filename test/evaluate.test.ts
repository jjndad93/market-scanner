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
  // Since the M3 fix, "too risky" comes from evidence (breakeven ~10x a typical move at
  // historical volatility, delta < 0.10), not from being out of the money with <= 7 days left.
  assert.equal(ev.checks.find((c) => c.id === 'breakeven')!.status, 'fail');
  assert.equal(ev.checks.find((c) => c.id === 'time')!.status, 'caution');
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

// ---- Regression tests for the 2026-10-20 audit findings (H1-H3, M1-M4) --------------------
// All inputs are hypothetical. `fields` builds a liquid, complete paste; '' removes a field.

function quoteAt(sigma: number, opts: { S?: number; K?: number; expiration?: string; halfSpread?: number } = {}) {
  const { S = 100, K = 100, expiration = '2026-12-18', halfSpread = 0.05 } = opts;
  const price = bsCall({ S, K, T: yearsBetween(NOW, expirationCloseUtc(expiration)), r: 0.04, q: 0, sigma });
  return { Bid: (price - halfSpread).toFixed(2), Ask: (price + halfSpread).toFixed(2) };
}

function fields(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    Underlying: 'TEST', 'Stock price': '100', Strike: '100', Expiration: '2026-12-18', Type: 'Call',
    ...quoteAt(0.3), Volume: '800', 'Open interest': '5000', 'Quote time': '2026-10-20 10:15 ET',
    'Earnings date': '2027-01-25', 'Historical volatility': '30%', 'Risk-free rate': '4%', 'Dividend yield': '0%',
  };
  return Object.entries({ ...base, ...overrides }).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
}
const check = (ev: ReturnType<typeof evaluate>, id: string) => ev.checks.find((c) => c.id === id);

test('H1: breakeven is judged against historical volatility, not the option\'s own IV', () => {
  // Grossly overpriced: fair value at 30% vol is about $5; this quote implies ~193% IV.
  const ev = evaluate(fields({ Bid: '30', Ask: '31' }));
  assert.equal(check(ev, 'breakeven')!.status, 'fail', check(ev, 'breakeven')!.summary);
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
});

test('H1: without historical volatility the breakeven check is unavailable, not passed', () => {
  const ev = evaluate(fields({ 'Historical volatility': '' }));
  assert.equal(check(ev, 'breakeven')!.status, 'unknown');
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
});

test('H1: a fairly priced contract still passes the breakeven check using historical volatility', () => {
  const ev = evaluate(fields());
  assert.equal(check(ev, 'breakeven')!.status, 'pass');
  assert.match(check(ev, 'breakeven')!.summary, /historical/);
});

test('H2: a severe IV premium over historical volatility fails the valuation check', () => {
  const ev = evaluate(fields({ Bid: '30', Ask: '31' })); // IV/HV ~6.4
  assert.equal(check(ev, 'valuation')!.status, 'fail');
  assert.ok(['WEAK', 'TOO_RISKY'].includes(ev.verdict), ev.verdict);
});

test('H2: IV/HV of about 1.6 blocks RELATIVELY_STRONG even when every other check passes', () => {
  const ev = evaluate(fields(quoteAt(0.48)));
  assert.equal(check(ev, 'valuation')!.status, 'caution');
  assert.equal(ev.verdict, 'MIXED', ev.verdictReasons.join('; '));
  assert.ok(ev.verdictReasons.some((r) => r.includes('Price vs. recent volatility')));
});

test('H3: an entry premium far above the ask is flagged and blocks a strong verdict', () => {
  const ev = evaluate(fields({ Premium: '9.00' }));
  assert.equal(check(ev, 'entry')!.status, 'caution');
  assert.ok(ev.warnings.some((w) => /above the ask/.test(w)), ev.warnings.join(' | '));
  assert.equal(ev.verdict, 'MIXED');
});

test('H3: an entry premium below the bid is flagged as an unlikely fill', () => {
  const ev = evaluate(fields({ Premium: '1.00' }));
  assert.equal(check(ev, 'entry')!.status, 'caution');
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
});

test('H3: an entry premium at the ask, or within the small tolerance, is accepted', () => {
  const { Ask } = quoteAt(0.3);
  assert.equal(check(evaluate(fields({ Premium: Ask })), 'entry')!.status, 'pass');
  assert.equal(evaluate(fields({ Premium: Ask })).verdict, 'RELATIVELY_STRONG');
  const withinTolerance = (Number(Ask) + 0.03).toFixed(2); // tolerance is max($0.01, 1% of mid ~ $0.05)
  assert.equal(check(evaluate(fields({ Premium: withinTolerance })), 'entry')!.status, 'pass');
});

test('M1: a past earnings date is treated as unknown, not as "no earnings before expiration"', () => {
  const ev = evaluate(fields({ 'Earnings date': '2026-07-28' }));
  assert.equal(check(ev, 'earnings')!.status, 'unknown');
  assert.equal(ev.verdict, 'MIXED');
  assert.ok(ev.missingHelpful.some((m) => /already passed/.test(m)), ev.missingHelpful.join(' | '));
});

test('M2: a stale quote lowers data reliability and caps the verdict, without counting as a contract weakness', () => {
  const stale = evaluate(fields({ 'Quote time': '2026-10-19 16:00 ET' }));
  assert.equal(check(stale, 'freshness')!.status, 'caution');
  assert.equal(stale.verdict, 'MIXED');
  assert.equal(stale.dataReliability.level, 'reduced');
  assert.equal(evaluate(fields()).dataReliability.level, 'normal');
});

test('M2: stale quote + two contract cautions is MIXED, not WEAK', () => {
  // IV/HV ~1.25 (caution) + earnings before expiration (caution) + 18-hour-old quote (data issue).
  const ev = evaluate(fields({ ...quoteAt(0.375), 'Earnings date': '2026-11-05', 'Quote time': '2026-10-19 16:00 ET' }));
  assert.equal(ev.verdict, 'MIXED', ev.verdictReasons.join('; '));
});

test('M3: a near-the-money call with 3 days left is cautioned, not automatically TOO_RISKY', () => {
  const ev = evaluate(fields({ 'Stock price': '99.90', Expiration: '2026-10-23', ...quoteAt(0.3, { S: 99.9, expiration: '2026-10-23', halfSpread: 0.02 }) }));
  const time = check(ev, 'time')!;
  assert.equal(time.status, 'caution');
  assert.match(time.detail, /not a real-world probability/);
  assert.notEqual(ev.verdict, 'TOO_RISKY');
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG', 'a 3-day option should not be rated strong');
});

test('M4: a deep in-the-money quote below the model minimum explains the likely dividend/American-exercise cause', () => {
  const ev = evaluate(fields({ Strike: '60', Bid: '40.05', Ask: '40.25', 'Dividend yield': '' }));
  assert.equal(ev.verdict, 'INSUFFICIENT_DATA');
  assert.ok(ev.verdictReasons.some((r) => /dividend/i.test(r)), ev.verdictReasons.join(' | '));
});

// ---- Regression tests for the adversarial review (R1-R5). All inputs are hypothetical. ------

/** A 1-year call 50% out of the money, quoted at 30% IV, without historical volatility. */
function farOtmLeaps(extra: Record<string, string> = {}): string {
  const price = bsCall({ S: 100, K: 150, T: yearsBetween(NOW, expirationCloseUtc('2027-10-15')), r: 0.04, q: 0, sigma: 0.3 });
  return fields({ Strike: '150', Expiration: '2027-10-15', Bid: (price - 0.02).toFixed(2), Ask: (price + 0.02).toFixed(2), 'Historical volatility': '', ...extra });
}
const OVERPRICED = { Bid: '30', Ask: '31' }; // fair value at 30% vol is about $5; implies ~193% IV

test('R1: without historical volatility, an unfavorable IV-based breakeven still warns (1-year call 50% OTM)', () => {
  const ev = evaluate(farOtmLeaps());
  const be = check(ev, 'breakeven')!;
  assert.equal(be.status, 'fail', be.summary);
  assert.match(be.detail, /independent comparison .*unavailable/i);
  assert.equal(ev.verdict, 'TOO_RISKY');
});

test('R1: the option\'s own IV never passes the breakeven check on its own', () => {
  // Fair at-the-money call: the IV-based ratio is favorable, but that is not independent evidence.
  assert.equal(check(evaluate(fields({ 'Historical volatility': '' })), 'breakeven')!.status, 'unknown');
});

test('R1/R4: a MIXED verdict with an unfavorable breakeven does not claim "no serious red flags"', () => {
  // 59-day call 15% OTM at 30% IV, no historical volatility: IV-based breakeven is a caution.
  const price = bsCall({ S: 100, K: 115, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.3 });
  const ev = evaluate(fields({ Strike: '115', Bid: (price - 0.02).toFixed(2), Ask: (price + 0.02).toFixed(2), 'Historical volatility': '' }));
  assert.equal(check(ev, 'breakeven')!.status, 'caution');
  assert.equal(ev.verdict, 'MIXED');
  assert.doesNotMatch(ev.verdictSummary, /no serious red flags/i);
  assert.match(ev.verdictSummary, /breakeven/i);
});

test('R2: "Historical volatility: 3" (ambiguous: 3% or 300%) cannot make an overpriced contract look strong', () => {
  const ev = evaluate(fields({ ...OVERPRICED, 'Historical volatility': '3' }));
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
  assert.notEqual(check(ev, 'breakeven')!.status, 'pass');
  assert.notEqual(check(ev, 'valuation')!.status, 'pass');
  assert.equal(ev.dataReliability.level, 'reduced');
  // One underlying issue (the HV input) is reported once, even though it is both ambiguous and implausible.
  assert.equal(ev.dataReliability.reasons.filter((r) => /historical volatility/i.test(r)).length, 1, ev.dataReliability.reasons.join(' | '));
});

test('R2: a 190% historical volatility is kept but cannot support a strong verdict for an overpriced contract', () => {
  const ev = evaluate(fields({ ...OVERPRICED, 'Historical volatility': '190%' }));
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
  assert.notEqual(check(ev, 'breakeven')!.status, 'pass');
  assert.notEqual(check(ev, 'valuation')!.status, 'pass');
  assert.equal(ev.dataReliability.level, 'reduced');
  const hv = ev.metrics.find((m) => m.label === 'Historical volatility')!;
  assert.equal(hv.evidence.value, 1.9, 'high volatility is flagged, not rejected');
});

test('R2: questionable historical volatility is a data issue, not evidence that the contract is poor', () => {
  // Fairly priced for a genuinely volatile stock (IV 160%, HV 160%): capped at MIXED, never WEAK/TOO_RISKY because of HV.
  const ev = evaluate(fields({ ...quoteAt(1.6), 'Historical volatility': '160%' }));
  assert.equal(ev.verdict, 'MIXED', ev.verdictReasons.join('; '));
  assert.equal(ev.dataReliability.level, 'reduced');
});

test('R2: unambiguous historical volatility inputs do not raise data issues', () => {
  for (const hv of ['30%', '30', '0.3']) {
    const ev = evaluate(fields({ 'Historical volatility': hv }));
    assert.equal(ev.dataReliability.level, 'normal', `${hv}: ${ev.dataReliability.reasons.join(' | ')}`);
    assert.equal(ev.verdict, 'RELATIVELY_STRONG', hv);
  }
});

test('R3: input problems lower data reliability consistently', () => {
  const cases: Record<string, string> = {
    'bid above ask': fields({ Bid: '5.20', Ask: '5.00', Premium: '5.10' }),
    'premium below intrinsic': fields({ Strike: '90', Bid: '', Ask: '', Premium: '9.50' }),
    'ambiguous percentage': fields({ 'Dividend yield': '0.1' }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const ev = evaluate(text);
    assert.equal(ev.dataReliability.level, 'reduced', name);
    assert.notEqual(ev.verdict, 'RELATIVELY_STRONG', name);
  }
  // Poorly determined IV (deep in the money; the quote barely constrains IV).
  const T = yearsBetween(NOW, expirationCloseUtc('2026-12-18'));
  const price = bsCall({ S: 100, K: 75, T, r: 0.04, q: 0, sigma: 0.2 });
  const deep = evaluate(fields({ Strike: '75', Bid: (price - 0.05).toFixed(2), Ask: (price + 0.05).toFixed(2) }));
  assert.equal(deep.dataReliability.level, 'reduced');
  assert.ok(deep.dataReliability.reasons.some((r) => /poorly determined/i.test(r)), deep.dataReliability.reasons.join(' | '));
});

test('R4: the MIXED summary names the actual caution instead of a generic phrase', () => {
  const ev = evaluate(fields(quoteAt(0.48))); // IV/HV ~1.6
  assert.equal(ev.verdict, 'MIXED');
  assert.doesNotMatch(ev.verdictSummary, /no serious red flags/i);
  assert.match(ev.verdictSummary, /price vs\. recent volatility/i);
});

test('R5: the deep in-the-money IV message does not make unsupported frequency claims', () => {
  const ev = evaluate(fields({ Strike: '60', Bid: '40.05', Ask: '40.25', 'Dividend yield': '' }));
  const reason = ev.verdictReasons.join(' ');
  assert.match(reason, /another possible cause/i);
  assert.doesNotMatch(reason, /more common|usually/i);
});

// ---- Follow-up: HV consistency, low/zero HV, inverted quotes (all inputs hypothetical) -------

const hvCheckStatuses = (ev: ReturnType<typeof evaluate>) => [check(ev, 'breakeven')!.status, check(ev, 'valuation')!.status];

test('HV-1: IV 30% with HV 150% (IV/HV 0.2) does not count HV and cannot rate strong', () => {
  const ev = evaluate(fields({ 'Historical volatility': '150%' })); // 150% is not above the 150% ceiling
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
  assert.deepEqual(hvCheckStatuses(ev), ['unknown', 'unknown']);
  assert.equal(ev.dataReliability.level, 'reduced');
  assert.ok(ev.dataReliability.reasons.some((r) => /IV\/HV|mismatch/i.test(r)), ev.dataReliability.reasons.join(' | '));
});

test('HV-1 boundary: IV/HV just below 0.5 makes HV questionable; just above 0.5 it still counts', () => {
  const below = evaluate(fields({ 'Historical volatility': '62%' })); // IV ~30% -> IV/HV ~0.48
  assert.deepEqual(hvCheckStatuses(below), ['unknown', 'unknown']);
  assert.equal(below.dataReliability.level, 'reduced');
  const above = evaluate(fields({ 'Historical volatility': '58%' })); // IV/HV ~0.52
  assert.equal(above.dataReliability.level, 'normal', above.dataReliability.reasons.join(' | '));
  assert.equal(check(above, 'valuation')!.status, 'pass');
});

test('HV-1: a high IV/HV ratio remains evidence about price, not a data issue', () => {
  const ev = evaluate(fields({ ...OVERPRICED })); // IV ~193%, HV 30%
  assert.equal(check(ev, 'valuation')!.status, 'fail');
  assert.equal(ev.dataReliability.level, 'normal');
});

test('HV-2: an implausibly low HV (2%) is not counted for or against the contract', () => {
  const ev = evaluate(fields({ 'Historical volatility': '2%' }));
  assert.notEqual(ev.verdict, 'TOO_RISKY');
  assert.notEqual(ev.verdict, 'RELATIVELY_STRONG');
  assert.deepEqual(hvCheckStatuses(ev), ['unknown', 'unknown']);
  assert.equal(ev.dataReliability.level, 'reduced');
});

test('HV-2 boundary: HV below 5% is questionable, 5% is accepted', () => {
  const lowVolQuote = quoteAt(0.06); // a genuinely low-volatility option, IV ~6%
  const below = evaluate(fields({ ...lowVolQuote, 'Historical volatility': '4.9%' }));
  assert.deepEqual(hvCheckStatuses(below), ['unknown', 'unknown']);
  assert.equal(below.dataReliability.level, 'reduced');
  const at = evaluate(fields({ ...lowVolQuote, 'Historical volatility': '5%' }));
  assert.notEqual(check(at, 'valuation')!.status, 'unknown');
  assert.equal(at.dataReliability.level, 'normal', at.dataReliability.reasons.join(' | '));
});

test('HV-4: an explicit 0% HV is invalid, not treated as omitted', () => {
  const ev = evaluate(fields({ 'Historical volatility': '0%' }));
  assert.equal(ev.dataReliability.level, 'reduced');
  assert.ok(ev.dataReliability.reasons.some((r) => /0\.0%/.test(r)), ev.dataReliability.reasons.join(' | '));
  for (const id of ['breakeven', 'valuation']) assert.doesNotMatch(check(ev, id)!.summary, /not provided/, id);
  assert.ok(!ev.missingHelpful.some((m) => /^Historical volatility/.test(m)), 'should not ask for HV as if it were missing');
});

test('HV-4: the IV/HV ratio is shown only when HV is usable', () => {
  const ratioShown = (hv: string) => evaluate(fields({ 'Historical volatility': hv })).metrics.some((m) => m.label === 'IV / historical volatility');
  assert.equal(ratioShown('30%'), true);
  for (const hv of ['3', '150%', '190%', '2%', '0%']) assert.equal(ratioShown(hv), false, hv);
});

test('Q-3: an inverted quote is reported as invalid, not as a missing bid/ask', () => {
  const ev = evaluate(fields({ Bid: '5.20', Ask: '5.00', Premium: '5.10' }));
  const spread = check(ev, 'spread')!;
  assert.match(spread.summary, /inverted/i);
  assert.doesNotMatch(spread.summary + spread.detail, /not both provided|without both/i);
  assert.ok(!ev.missingHelpful.some((m) => /^Bid and ask/.test(m)), ev.missingHelpful.join(' | '));
  assert.equal(ev.dataReliability.level, 'reduced');
});

test('Q-4: a $0/$0 quote with a premium keeps the invalid-offer message and lowers reliability once', () => {
  const ev = evaluate(fields({ Bid: '0', Ask: '0', Premium: '5.10' }));
  const spread = check(ev, 'spread')!;
  assert.equal(spread.status, 'unknown');
  assert.match(spread.summary, /ask is \$0\.00, so there is no valid offer/);
  assert.ok(!ev.missingHelpful.some((m) => /^Bid and ask/.test(m)), ev.missingHelpful.join(' | '));
  assert.equal(ev.dataReliability.level, 'reduced');
  assert.equal(ev.dataReliability.reasons.filter((r) => /quote/i.test(r)).length, 1, ev.dataReliability.reasons.join(' | '));
  assert.equal(ev.verdict, 'MIXED');
});

test('Q-4: related quote cases are not misclassified', () => {
  // A zero bid with a positive ask is a valid (if wide) quote, typical of cheap out-of-the-money
  // calls: not a data issue. The ask is set so the mid matches the 30% IV used elsewhere.
  const otmPrice = bsCall({ S: 100, K: 115, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.3 });
  const zeroBid = evaluate(fields({ Strike: '115', Bid: '0', Ask: (2 * otmPrice).toFixed(2) }));
  assert.notEqual(check(zeroBid, 'spread')!.status, 'unknown');
  assert.equal(zeroBid.dataReliability.level, 'normal', zeroBid.dataReliability.reasons.join(' | '));
  // A genuinely missing bid is missing evidence, not invalid data.
  const noBid = evaluate(fields({ Bid: '' }));
  assert.match(check(noBid, 'spread')!.summary, /not both provided/);
  assert.equal(noBid.dataReliability.level, 'normal', noBid.dataReliability.reasons.join(' | '));
  // A normal quote stays clean.
  assert.equal(evaluate(fields()).dataReliability.level, 'normal');
});

// ---- "IV poorly determined" explanation must match the actual cause (hypothetical inputs) --------

const ivPoorlyDetermined = (ev: ReturnType<typeof evaluate>) => [...ev.warnings, ...ev.dataReliability.reasons].filter((m) => /poorly determined/i.test(m));

test('IV-PD: deep in the money, the explanation cites intrinsic value and the flag is kept', () => {
  const price = bsCall({ S: 100, K: 75, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.2 });
  const ev = evaluate(fields({ Strike: '75', Bid: (price - 0.05).toFixed(2), Ask: (price + 0.05).toFixed(2) }));
  const msgs = ivPoorlyDetermined(ev);
  assert.equal(msgs.length, 2, 'one warning and one data-reliability reason');
  for (const m of msgs) assert.match(m, /intrinsic value/i);
  assert.equal(ev.dataReliability.level, 'reduced');
});

test('IV-PD: far out of the money, the explanation does not claim intrinsic value and the flag is kept', () => {
  // 59-day call 40% out of the money, mid set to its 30%-vol model price.
  const price = bsCall({ S: 100, K: 140, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.3 });
  const ev = evaluate(fields({ Strike: '140', Bid: '0', Ask: (2 * price).toFixed(2), 'Historical volatility': '' }));
  const msgs = ivPoorlyDetermined(ev);
  assert.equal(msgs.length, 2, `flag must still fire: ${[...ev.warnings, ...ev.dataReliability.reasons].join(' | ')}`);
  for (const m of msgs) {
    assert.doesNotMatch(m, /almost (entirely|all) intrinsic/i);
    assert.match(m, /out of the money/i);
    assert.match(m, /no intrinsic value/i);
  }
  assert.equal(ev.dataReliability.level, 'reduced');
});

// ---- Precise intrinsic-share and sub-cent wording in the "poorly determined" explanation ----------
// Hypothetical inputs. Each test asserts the generated messages (warning + reliability reason).

/** Both poorly-determined messages; asserts the flag fired and reduced reliability. */
function pdMessages(ev: ReturnType<typeof evaluate>): string[] {
  const msgs = ivPoorlyDetermined(ev);
  assert.equal(msgs.length, 2, `flag must fire once as a warning and once as a reliability reason: ${[...ev.warnings, ...ev.dataReliability.reasons].join(' | ')}`);
  assert.equal(ev.dataReliability.level, 'reduced');
  return msgs;
}

test('IV-PD wording: deep ITM with ~98% intrinsic value is reported as about 98%', () => {
  const price = bsCall({ S: 100, K: 75, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.2 });
  for (const m of pdMessages(evaluate(fields({ Strike: '75', Bid: (price - 0.05).toFixed(2), Ask: (price + 0.05).toFixed(2) })))) {
    assert.match(m, /about 98% of its value is intrinsic value/);
  }
});

test('IV-PD wording: an intrinsic share of 99.5%-100% is "more than 99%", never "about 100%"', () => {
  // 3-day call $10 in the money, mid $10.04: intrinsic share ~99.6%.
  for (const m of pdMessages(evaluate(fields({ Strike: '90', Expiration: '2026-10-23', Bid: '10.02', Ask: '10.06' })))) {
    assert.match(m, /more than 99% of its value is intrinsic value/);
    assert.doesNotMatch(m, /about 100%/);
  }
});

test('IV-PD wording: a model value below intrinsic value is stated explicitly, with no percentage', () => {
  // With a 6% dividend yield the European model can value a deep ITM call below stock minus strike.
  const price = bsCall({ S: 100, K: 60, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0.06, sigma: 0.2 });
  const ev = evaluate(fields({ Strike: '60', Bid: (price - 0.01).toFixed(2), Ask: (price + 0.01).toFixed(2), 'Dividend yield': '6%' }));
  for (const m of pdMessages(ev)) {
    // Distinguishes the model value (matched to the quote) from intrinsic value, with no percentage.
    assert.match(m, /model value \(\$\d+\.\d{2}, matched to the quoted price\) is below its intrinsic value \(\$40\.00\)/);
    assert.doesNotMatch(m, /% of its value is intrinsic value/);
    // Names the model mechanism without presenting dividends as the only real-world explanation.
    assert.match(m, /only because a dividend yield was entered/);
    assert.match(m, /quote may also be stale or off-market/);
  }
});

test('IV-PD wording: a far OTM option worth under one cent is not described as "about $0.01"', () => {
  // Bid $0 / ask $0.01: mid (and model value) $0.005.
  for (const m of pdMessages(evaluate(fields({ Strike: '140', Bid: '0', Ask: '0.01', 'Historical volatility': '' })))) {
    assert.match(m, /worth less than \$0\.01 per share/);
    assert.doesNotMatch(m, /about \$0\.01|under \$0\.01/);
    assert.match(m, /no intrinsic value/);
  }
});

test('IV-PD wording: a far OTM option worth at least one cent keeps a normal currency amount', () => {
  // Same input as the far-OTM test above (mid = 30%-vol model price, about $0.015), where the
  // flag is known to fire. A $0.02 mid would not do: its higher IV lifts vega above the threshold.
  const price = bsCall({ S: 100, K: 140, T: yearsBetween(NOW, expirationCloseUtc('2026-12-18')), r: 0.04, q: 0, sigma: 0.3 });
  assert.ok(price >= 0.01, `fixture must be worth at least one cent, got ${price}`);
  for (const m of pdMessages(evaluate(fields({ Strike: '140', Bid: '0', Ask: (2 * price).toFixed(2), 'Historical volatility': '' })))) {
    assert.match(m, /worth only about \$0\.0[1-9] per share/);
    assert.doesNotMatch(m, /less than \$0\.01/);
  }
});

test('the what-if table shows a loss when the stock is flat (time decay)', () => {
  const ev = evaluate(liquidAtmCall());
  const w = ev.whatIf!;
  const flat = w.pnl[w.stockMoves.indexOf(0)]![w.ivChangePoints.indexOf(0)]!;
  assert.ok(flat < 0, `flat-stock P/L should be negative, got ${flat}`);
  // Lower IV is always worse for the holder, all else equal.
  for (const row of w.pnl) for (let j = 1; j < row.length; j++) assert.ok(row[j]! > row[j - 1]!);
});
