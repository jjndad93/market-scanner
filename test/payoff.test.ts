import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakevenCall, callPnlAtExpiry, expiryScenarios, maxLossCall } from '../src/options/payoff.ts';

test('breakeven is strike plus premium', () => {
  assert.equal(breakevenCall(55, 2.5), 57.5);
  assert.equal(breakevenCall(100, 0), 100);
});

test('maximum loss is the full premium for the whole position', () => {
  assert.equal(maxLossCall(2.5, 100, 1), 250);
  assert.equal(maxLossCall(2.5, 100, 3), 750);
});

test('profit/loss at expiration for known stock prices', () => {
  assert.equal(callPnlAtExpiry(50, 55, 2.5, 100, 1), -250); // below strike: lose everything
  assert.equal(callPnlAtExpiry(55, 55, 2.5, 100, 1), -250); // at strike: still lose everything
  assert.equal(callPnlAtExpiry(56, 55, 2.5, 100, 1), -150); // above strike, below breakeven
  assert.equal(callPnlAtExpiry(57.5, 55, 2.5, 100, 1), 0); // breakeven
  assert.equal(callPnlAtExpiry(60, 55, 2.5, 100, 2), 500); // (5 - 2.5) x 100 x 2
});

test('the loss never exceeds the premium however far the stock falls', () => {
  for (const price of [0, 1, 20, 54.99]) assert.equal(callPnlAtExpiry(price, 55, 2.5, 100, 1), -250);
});

test('expiration scenarios are sorted and include strike and breakeven rows', () => {
  const rows = expiryScenarios(52, 55, 2.5, 100, 1);
  const prices = rows.map((r) => r.stockPrice);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const be = rows.find((r) => r.label === 'At breakeven');
  assert.ok(be);
  assert.ok(Math.abs(be.pnl) < 1e-9);
  const strike = rows.find((r) => r.label === 'At strike');
  assert.ok(strike);
  assert.equal(strike.pnl, -250);
  assert.equal(rows[0]!.pnlPct, -1); // a 20% drop loses 100%
});
