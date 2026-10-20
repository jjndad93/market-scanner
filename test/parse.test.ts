import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContractText, parsePercent, parseSymbolLine } from '../src/options/parse.ts';
import { parseDateLoose, parseQuoteTime } from '../src/core/time.ts';

const SAMPLE = `# hypothetical test data
Underlying: xmpl
Stock price: $1,052.40
Strike: 1,100
Expiration: 12/18/2026
Type: Call
Bid: 2.35
Ask: 2.45
IV: 38.2%
Delta: 0.41
Open interest: 6,420
Quote time: 2026-10-20 10:15 ET
Historical volatility: 33
Dividend yield: 0.5
something unexpected here`;

test('reads key/value pastes, cleans numbers and tags the source of each value', () => {
  const r = parseContractText(SAMPLE);
  assert.equal(r.contract.underlying.value, 'XMPL');
  assert.equal(r.contract.stockPrice.value, 1052.4);
  assert.equal(r.contract.strike.value, 1100);
  assert.equal(r.contract.expiration.value, '2026-12-18');
  assert.equal(r.contract.optionType.value, 'call');
  assert.equal(r.contract.openInterest.value, 6420);
  assert.equal(r.contract.stockPrice.kind, 'user_provided');
  // Broker-computed figures are third-party, not facts this tool verified.
  assert.equal(r.contract.quotedIV.kind, 'third_party');
  assert.ok(Math.abs(r.contract.quotedIV.value! - 0.382) < 1e-12);
  assert.equal(r.contract.quotedDelta.kind, 'third_party');
  // Quote-based values carry the quote timestamp (10:15 EDT = 14:15 UTC).
  assert.equal(r.contract.bid.asOf, '2026-10-20T14:15:00.000Z');
  assert.equal(r.context.historicalVol.value, 0.33);
  assert.equal(r.context.dividendYield.value, 0.005);
  assert.equal(r.markedAsTestData, true);
  assert.deepEqual(r.unrecognized, ['something unexpected here']);
});

test('fields that were not pasted are explicitly missing, not guessed', () => {
  const r = parseContractText('Strike: 50');
  assert.equal(r.contract.stockPrice.kind, 'missing');
  assert.equal(r.contract.stockPrice.value, null);
  assert.equal(r.contract.bid.kind, 'missing');
  assert.equal(r.contract.quoteTime.kind, 'missing');
  assert.equal(r.context.earningsDate.kind, 'missing');
  // Conventions are filled in only as labelled assumptions.
  assert.equal(r.contract.multiplier.kind, 'estimate');
  assert.equal(r.contract.optionType.kind, 'estimate');
});

test('unreadable values become missing with a warning', () => {
  const r = parseContractText('Stock price: abc\nStrike: -5\nExpiration: 2026-02-30');
  assert.equal(r.contract.stockPrice.kind, 'missing');
  assert.equal(r.contract.strike.kind, 'missing');
  assert.equal(r.contract.expiration.kind, 'missing');
  assert.equal(r.warnings.length, 3);
});

test('reads OCC option symbols and broker-style symbol lines', () => {
  assert.deepEqual(parseSymbolLine('XMPL261218C00055000'), { underlying: 'XMPL', expiration: '2026-12-18', strike: 55, type: 'call' });
  assert.deepEqual(parseSymbolLine('O:XMPL261218P00012500'), { underlying: 'XMPL', expiration: '2026-12-18', strike: 12.5, type: 'put' });
  assert.deepEqual(parseSymbolLine('XMPL Dec 18 2026 55 Call'), { underlying: 'XMPL', expiration: '2026-12-18', strike: 55, type: 'call' });
  assert.deepEqual(parseSymbolLine('XMPL 12/18/2026 $57.5 C'), { underlying: 'XMPL', expiration: '2026-12-18', strike: 57.5, type: 'call' });
  assert.equal(parseSymbolLine('this is just a sentence'), null);
  const r = parseContractText('XMPL Dec 18 2026 55 Call\nStock price: 52');
  assert.equal(r.contract.strike.value, 55);
  assert.equal(r.contract.optionType.kind, 'user_provided');
});

test('percentages with and without a % sign', () => {
  const near = (text: string, max: number, expected: number) =>
    assert.ok(Math.abs(parsePercent(text, max)!.value - expected) < 1e-12, `${text} -> ${expected}`);
  near('31.5%', 3, 0.315);
  near('31.5', 3, 0.315);
  near('0.315', 3, 0.315);
  near('4.1', 0.2, 0.041);
  near('0.041', 0.2, 0.041);
  assert.equal(parsePercent('n/a', 3), null);
});

test('dates and quote times', () => {
  assert.equal(parseDateLoose('2026-12-18'), '2026-12-18');
  assert.equal(parseDateLoose('12/18/26'), '2026-12-18');
  assert.equal(parseDateLoose('December 18th, 2026'), '2026-12-18');
  assert.equal(parseDateLoose('18 Dec 2026'), '2026-12-18');
  assert.equal(parseDateLoose('2026-02-30'), null);
  // EDT (UTC-4) in October, EST (UTC-5) in December.
  assert.equal(parseQuoteTime('2026-10-20 09:45 ET')!.iso, '2026-10-20T13:45:00.000Z');
  assert.equal(parseQuoteTime('2026-12-01 3:30 pm ET')!.iso, '2026-12-01T20:30:00.000Z');
  assert.equal(parseQuoteTime('2026-10-20 09:45')!.assumedEt, true);
  assert.equal(parseQuoteTime('2026-10-20T13:45:00Z')!.iso, '2026-10-20T13:45:00.000Z');
  assert.equal(parseQuoteTime('yesterday'), null);
});
