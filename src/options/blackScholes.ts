/**
 * Black-Scholes-Merton pricing for European options on a stock with a continuous dividend
 * yield q. See the evaluator's model-limitations notes for why this is only an
 * approximation for American-style US equity options.
 *
 * Units: S, K in dollars; T in years; r, q, sigma as annual fractions (0.30 = 30%).
 */

export interface BsParams {
  S: number;
  K: number;
  T: number;
  r: number;
  q: number;
  sigma: number;
}

export interface Greeks {
  delta: number;
  gamma: number;
  thetaPerYear: number;
  /** Per calendar day (thetaPerYear / 365). */
  thetaPerDay: number;
  /** Price change for a 1 percentage-point change in volatility. */
  vegaPerVolPoint: number;
  /** Price change for a 1 percentage-point change in the risk-free rate. */
  rhoPerRatePoint: number;
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, absolute error < 7.5e-8). */
export function normCdf(x: number): number {
  if (x < 0) return 1 - normCdf(-x);
  const t = 1 / (1 + 0.2316419 * x);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - normPdf(x) * poly;
}

function d1d2(p: BsParams): { d1: number; d2: number } {
  const volSqrtT = p.sigma * Math.sqrt(p.T);
  const d1 = (Math.log(p.S / p.K) + (p.r - p.q + (p.sigma * p.sigma) / 2) * p.T) / volSqrtT;
  return { d1, d2: d1 - volSqrtT };
}

export function bsCall(p: BsParams): number {
  if (p.T <= 0 || p.sigma <= 0) {
    const T = Math.max(p.T, 0);
    return Math.max(p.S * Math.exp(-p.q * T) - p.K * Math.exp(-p.r * T), 0);
  }
  const { d1, d2 } = d1d2(p);
  return p.S * Math.exp(-p.q * p.T) * normCdf(d1) - p.K * Math.exp(-p.r * p.T) * normCdf(d2);
}

/** Used for put-call parity checks in tests; Stage 1 evaluates calls only. */
export function bsPut(p: BsParams): number {
  if (p.T <= 0 || p.sigma <= 0) {
    const T = Math.max(p.T, 0);
    return Math.max(p.K * Math.exp(-p.r * T) - p.S * Math.exp(-p.q * T), 0);
  }
  const { d1, d2 } = d1d2(p);
  return p.K * Math.exp(-p.r * p.T) * normCdf(-d2) - p.S * Math.exp(-p.q * p.T) * normCdf(-d1);
}

export function callGreeks(p: BsParams): Greeks {
  const { d1, d2 } = d1d2(p);
  const sqrtT = Math.sqrt(p.T);
  const discQ = Math.exp(-p.q * p.T);
  const discR = Math.exp(-p.r * p.T);
  const pdf = normPdf(d1);
  const thetaPerYear =
    (-p.S * discQ * pdf * p.sigma) / (2 * sqrtT) - p.r * p.K * discR * normCdf(d2) + p.q * p.S * discQ * normCdf(d1);
  return {
    delta: discQ * normCdf(d1),
    gamma: (discQ * pdf) / (p.S * p.sigma * sqrtT),
    thetaPerYear,
    thetaPerDay: thetaPerYear / 365,
    vegaPerVolPoint: (p.S * discQ * pdf * sqrtT) / 100,
    rhoPerRatePoint: (p.K * p.T * discR * normCdf(d2)) / 100,
  };
}

export type IvResult = { ok: true; iv: number } | { ok: false; reason: string };

const IV_MIN = 0.0001;
const IV_MAX = 5; // 500%

/**
 * Solves for the volatility that makes the model call price equal `price`. Uses bisection,
 * which always converges because the call price rises monotonically with volatility.
 */
export function impliedVolCall(price: number, p: Omit<BsParams, 'sigma'>): IvResult {
  if (!(price > 0)) return { ok: false, reason: 'the option price must be greater than zero.' };
  if (!(p.T > 0)) return { ok: false, reason: 'no time remains before expiration.' };
  const upper = p.S * Math.exp(-p.q * p.T);
  if (price >= upper) return { ok: false, reason: 'the option price is at or above the stock price, which no volatility can explain. Check the quote.' };
  if (bsCall({ ...p, sigma: IV_MIN }) >= price) {
    return {
      ok: false,
      reason: 'the option price is at or below its minimum (intrinsic) value, so implied volatility is undefined. The quote may be stale or off-market.',
    };
  }
  if (bsCall({ ...p, sigma: IV_MAX }) < price) {
    return { ok: false, reason: 'the price implies volatility above 500%, beyond what this tool treats as reliable. Check the quote.' };
  }
  let lo = IV_MIN;
  let hi = IV_MAX;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (bsCall({ ...p, sigma: mid }) < price) lo = mid;
    else hi = mid;
  }
  return { ok: true, iv: (lo + hi) / 2 };
}
