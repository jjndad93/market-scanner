import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bsCall, bsPut, callGreeks, impliedVolCall, normCdf } from '../src/options/blackScholes.ts';
// All parameter sets below are textbook or synthetic test values, not market data.

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`);

test('normal CDF matches standard table values', () => {
  close(normCdf(0), 0.5, 1e-7, 'N(0)');
  close(normCdf(1), 0.8413447, 1e-6, 'N(1)');
  close(normCdf(-1), 0.1586553, 1e-6, 'N(-1)');
  close(normCdf(1.96), 0.9750021, 1e-6, 'N(1.96)');
  close(normCdf(-2.5), 0.0062097, 1e-6, 'N(-2.5)');
});

test('call price matches Hull textbook example (S=42, K=40, r=10%, vol=20%, T=0.5 -> 4.76)', () => {
  close(bsCall({ S: 42, K: 40, T: 0.5, r: 0.1, q: 0, sigma: 0.2 }), 4.7594, 1e-3, 'call price');
});

test('Greeks match Hull textbook example (S=49, K=50, r=5%, vol=20%, T=20 weeks)', () => {
  const p = { S: 49, K: 50, T: 20 / 52, r: 0.05, q: 0, sigma: 0.2 };
  close(bsCall(p), 2.4, 0.01, 'price');
  const g = callGreeks(p);
  close(g.delta, 0.522, 1e-3, 'delta');
  close(g.gamma, 0.066, 1e-3, 'gamma');
  close(g.thetaPerYear, -4.31, 0.01, 'theta per year');
  close(g.thetaPerDay, -4.31 / 365, 1e-4, 'theta per day');
  close(g.vegaPerVolPoint, 0.121, 1e-3, 'vega per vol point');
  close(g.rhoPerRatePoint, 0.0891, 1e-3, 'rho per rate point');
});

test('Greeks agree with finite differences of the price', () => {
  const p = { S: 103, K: 110, T: 0.3, r: 0.04, q: 0.015, sigma: 0.37 };
  const g = callGreeks(p);
  const h = 0.01;
  const deltaFd = (bsCall({ ...p, S: p.S + h }) - bsCall({ ...p, S: p.S - h })) / (2 * h);
  const gammaFd = (bsCall({ ...p, S: p.S + h }) - 2 * bsCall(p) + bsCall({ ...p, S: p.S - h })) / (h * h);
  const vegaFd = (bsCall({ ...p, sigma: p.sigma + 0.0001 }) - bsCall({ ...p, sigma: p.sigma - 0.0001 })) / 0.0002 / 100;
  const thetaFd = -(bsCall({ ...p, T: p.T + 1e-5 }) - bsCall({ ...p, T: p.T - 1e-5 })) / 2e-5;
  close(g.delta, deltaFd, 1e-5, 'delta');
  close(g.gamma, gammaFd, 1e-4, 'gamma');
  close(g.vegaPerVolPoint, vegaFd, 1e-5, 'vega');
  close(g.thetaPerYear, thetaFd, 1e-3, 'theta');
});

test('put-call parity holds with a dividend yield', () => {
  const p = { S: 100, K: 95, T: 0.75, r: 0.045, q: 0.02, sigma: 0.28 };
  const lhs = bsCall(p) - bsPut(p);
  const rhs = p.S * Math.exp(-p.q * p.T) - p.K * Math.exp(-p.r * p.T);
  close(lhs, rhs, 1e-6, 'C - P');
});

test('a dividend yield lowers the call value', () => {
  const base = { S: 100, K: 100, T: 1, r: 0.04, sigma: 0.25 };
  assert.ok(bsCall({ ...base, q: 0.03 }) < bsCall({ ...base, q: 0 }));
});

test('at expiration the call is worth its intrinsic value', () => {
  assert.equal(bsCall({ S: 110, K: 100, T: 0, r: 0.04, q: 0, sigma: 0.3 }), 10);
  assert.equal(bsCall({ S: 90, K: 100, T: 0, r: 0.04, q: 0, sigma: 0.3 }), 0);
});

test('implied volatility recovers the volatility used to price the option', () => {
  for (const sigma of [0.08, 0.25, 0.6, 1.4]) {
    for (const K of [70, 100, 140]) {
      const p = { S: 100, K, T: 0.4, r: 0.04, q: 0.01 };
      const price = bsCall({ ...p, sigma });
      if (price < 1e-4) continue; // too small to carry information
      const res = impliedVolCall(price, p);
      assert.ok(res.ok, `solver failed for sigma=${sigma}, K=${K}`);
      // The solved IV must always reproduce the price...
      close(bsCall({ ...p, sigma: res.iv }), price, 1e-7, `price round-trip for sigma=${sigma}, K=${K}`);
      // ...and must match sigma wherever the price is sensitive to volatility. (Deep in the money at
      // very low vol, the price is almost pure intrinsic value and IV is not identifiable; the
      // evaluator warns about that case.)
      if (callGreeks({ ...p, sigma }).vegaPerVolPoint > 0.01) close(res.iv, sigma, 1e-6, `IV for sigma=${sigma}, K=${K}`);
    }
  }
});

test('implied volatility is refused for prices no volatility can explain', () => {
  const p = { S: 100, K: 80, T: 0.5, r: 0.04, q: 0 };
  const belowIntrinsic = impliedVolCall(19, p); // minimum value is about 21.6
  assert.equal(belowIntrinsic.ok, false);
  const aboveStock = impliedVolCall(101, p);
  assert.equal(aboveStock.ok, false);
  assert.equal(impliedVolCall(0, p).ok, false);
  assert.equal(impliedVolCall(5, { ...p, T: 0 }).ok, false);
});

test('a call can lose value even though the stock rises (time decay + lower IV)', () => {
  const before = bsCall({ S: 100, K: 105, T: 30 / 365, r: 0.04, q: 0, sigma: 0.5 });
  // 20 days later the stock is up 3%, but implied volatility fell from 50% to 35%.
  const after = bsCall({ S: 103, K: 105, T: 10 / 365, r: 0.04, q: 0, sigma: 0.35 });
  assert.ok(after < before, `expected a loss: before ${before.toFixed(2)}, after ${after.toFixed(2)}`);
});
