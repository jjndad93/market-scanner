import type { Evidence } from '../core/evidence.ts';

export type OptionType = 'call' | 'put';
export type ExerciseStyle = 'american' | 'european';

/**
 * One option contract as described by its quote. In Stage 1 every field comes from text
 * the user pastes; a later live-data provider can fill the same shape with
 * `verified_market_data` evidence without changing the evaluator.
 */
export interface ContractInput {
  underlying: Evidence<string>;
  optionType: Evidence<OptionType>;
  exerciseStyle: Evidence<ExerciseStyle>;
  stockPrice: Evidence<number>;
  strike: Evidence<number>;
  /** YYYY-MM-DD */
  expiration: Evidence<string>;
  /** Price per share you paid or intend to pay. */
  premium: Evidence<number>;
  bid: Evidence<number>;
  ask: Evidence<number>;
  mark: Evidence<number>;
  last: Evidence<number>;
  volume: Evidence<number>;
  openInterest: Evidence<number>;
  quantity: Evidence<number>;
  multiplier: Evidence<number>;
  /** ISO timestamp of the quote. */
  quoteTime: Evidence<string>;
  quotedIV: Evidence<number>;
  quotedDelta: Evidence<number>;
  quotedGamma: Evidence<number>;
  quotedTheta: Evidence<number>;
  quotedVega: Evidence<number>;
}

/**
 * Facts about the underlying stock that are not part of the option quote. In Stage 1 they
 * come from the paste. Once the morning scanner exists, its data providers will fill this
 * (historical volatility from daily bars, earnings dates, trend), which is how the option
 * command and the morning report share one data layer.
 */
export interface MarketContext {
  riskFreeRate: Evidence<number>;
  dividendYield: Evidence<number>;
  dividendAmount: Evidence<number>;
  exDividendDate: Evidence<string>;
  earningsDate: Evidence<string>;
  /** Annualized realized volatility of the stock (e.g. 30-day), as a fraction. */
  historicalVol: Evidence<number>;
  /** Free-text description of the recent trend, e.g. "up 6% over 20 trading days". */
  trend: Evidence<string>;
}
