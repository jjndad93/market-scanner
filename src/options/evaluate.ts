import { type Evidence, calculated, earliestAsOf, estimate, has, missing, withNote } from '../core/evidence.ts';
import { money, pct, signedMoney, signedPct } from '../core/format.ts';
import { addDaysIso, daysBetweenIsoDates, expirationCloseUtc, formatNy, nyDateString, yearsBetween } from '../core/time.ts';
import { bsCall, callGreeks, impliedVolCall, normCdf } from './blackScholes.ts';
import { type ExpiryScenario, breakevenCall, expiryScenarios } from './payoff.ts';
import type { ContractInput, MarketContext } from './types.ts';

/** Used only when no rate is supplied; always labelled as an assumption. */
export const DEFAULT_RISK_FREE_RATE = 0.04;

/** Every threshold the checks use, in one place so they are easy to review and tune. */
export const THRESHOLDS = {
  spreadPass: 0.05, // spread <= 5% of mid
  spreadFail: 0.1, // spread > 10% of mid
  openInterestPass: 500,
  openInterestFail: 100,
  quoteFreshMinutes: 15,
  shortDte: 7,
  cautionDte: 21,
  thetaShareOfValuePerDay: 0.03,
  // Breakeven distance in units of a 1-standard-deviation move at HISTORICAL volatility.
  // (Never the option's own IV: an overpriced option would make its own breakeven look easy.)
  breakevenSdPass: 0.75,
  breakevenSdFail: 1.5,
  deltaCaution: 0.25,
  deltaFail: 0.1,
  // IV / historical volatility. Evidence of expensiveness relative to recent movement, not proof:
  // IV is legitimately higher before known events such as earnings.
  ivHvExpensive: 1.2, // caution
  ivHvVeryExpensive: 1.5, // caution that also blocks RELATIVELY_STRONG
  ivHvSevere: 2.0, // fail (WEAK)
  ivHvCheap: 0.8,
  // Historical volatility above this is possible for very volatile stocks, but is treated as a
  // data-reliability issue: it is shown, never rejected, and never counted as evidence either way.
  hvPlausibleMax: 1.5,
  // Historical volatility below this (or exactly 0) is treated the same way. Judgment, not a
  // market statistic: annualized realized volatility this low is unusual for an individual stock.
  hvPlausibleMin: 0.05,
  // If IV is less than half of HV, the two disagree so much that an input error (wrong unit, wrong
  // field, stale window) should be ruled out before HV is used; HV is then not counted. A judgment
  // threshold, not a market fact: IV can legitimately sit below realized volatility, e.g. after a
  // shock inside the HV window. Crossing it only withholds HV as evidence; it never rejects it.
  // High IV/HV is deliberately NOT treated this way: it is unfavorable price evidence (see ivHv*).
  ivHvInconsistentLow: 0.5,
  ivCrossCheck: 0.05, // 5 vol points
  // An entered premium outside [bid - tol, ask + tol] conflicts with the quote,
  // where tol = max(entryToleranceAbs, entryToleranceRel x mid).
  entryToleranceAbs: 0.01,
  entryToleranceRel: 0.01,
} as const;

export type Verdict = 'RELATIVELY_STRONG' | 'MIXED' | 'WEAK' | 'TOO_RISKY' | 'INSUFFICIENT_DATA';
export type CheckStatus = 'pass' | 'caution' | 'fail' | 'unknown';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  /** One-line result used in the verdict reasons. */
  summary: string;
  detail: string;
  /** What a failure of this check means for the verdict. */
  failMeans: 'too_risky' | 'weak';
  /**
   * 'contract' checks judge the contract itself. 'data' checks judge the reliability of the
   * inputs: they lower confidence and cap the verdict at MIXED, but never count as evidence
   * that the contract is poor.
   */
  category: 'contract' | 'data';
  /** A caution or failure of this check rules out RELATIVELY_STRONG on its own. */
  blocksStrong?: boolean;
}

type CheckInput = Omit<Check, 'category'>;

/** Checks about input reliability rather than contract quality. */
const DATA_CHECKS = new Set(['freshness', 'iv_crosscheck', 'entry']);

export type MetricFormat = 'text' | 'price' | 'money' | 'pct' | 'signedPct' | 'greek' | 'int' | 'days';

export interface MetricLine {
  group: string;
  label: string;
  evidence: Evidence<number> | Evidence<string>;
  format: MetricFormat;
}

export interface WhatIfTable {
  atDate: string;
  daysElapsed: number;
  stockMoves: number[];
  ivChangePoints: number[];
  /** cells[stockMoveIndex][ivChangeIndex] = position P/L */
  pnl: number[][];
}

export interface Evaluation {
  label: string;
  evaluatedAt: string;
  verdict: Verdict;
  verdictSummary: string;
  verdictReasons: string[];
  /** Confidence in the inputs, kept separate from the contract verdict. */
  dataReliability: { level: 'normal' | 'reduced'; reasons: string[] };
  /** Overpriced / underpriced / in line / cannot assess. */
  valuation: string;
  missingRequired: string[];
  missingHelpful: string[];
  metrics: MetricLine[];
  checks: Check[];
  expiryScenarios: ExpiryScenario[];
  whatIf: WhatIfTable | null;
  explanations: string[];
  modelLimitations: string[];
  warnings: string[];
}

export interface EvaluateOptions {
  /** Valuation time; defaults to the current time. Fixed in tests for reproducible results. */
  now?: Date;
}

export const MODEL_LIMITATIONS: readonly string[] = [
  'Black-Scholes assumes European exercise (only at expiration). US-listed stock options are American-style and can be exercised at any time. For a call on a stock that pays no dividend before expiration, exercising early is never better than selling the option, so the European value is a reasonable approximation.',
  'Dividends break that equivalence. Just before an ex-dividend date, exercising a deep in-the-money call can be worth more than holding it (when the dividend exceeds the remaining time value). Black-Scholes cannot capture that early-exercise value, so for such calls it can undervalue the contract and misstate the implied volatility and Greeks.',
  'Dividends are modelled as a continuous yield, while real dividends are discrete cash payments on specific dates, so values around an ex-dividend date are approximate. If no dividend yield is given, 0% is assumed, which overstates the call value and understates the solved IV for a dividend-paying stock.',
  'Volatility is assumed constant over the life of the option. Real implied volatility changes daily, differs by strike (skew) and by expiration, and typically rises before earnings and falls afterwards.',
  'Stock returns are assumed to follow a lognormal distribution with no sudden gaps. Real stocks gap on news and earnings more often than the model expects, so extreme outcomes are under-represented.',
  'Probabilities are risk-neutral estimates implied by the option price. They are not forecasts of what will actually happen.',
  'Greeks are instantaneous sensitivities. They change as the stock price, time and volatility change.',
  'Everything depends on the inputs. A stale or off-market quote produces wrong IV and Greeks, and the mid price is not guaranteed to be tradable.',
];

const STATUS_RANK: Record<CheckStatus, number> = { unknown: 0, pass: 1, caution: 2, fail: 3 };
const worse = (a: CheckStatus, b: CheckStatus): CheckStatus => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a);

/** Checks whose result must be known before a contract can be rated relatively strong. */
const MUST_BE_KNOWN = ['spread', 'liquidity', 'freshness', 'valuation', 'earnings', 'breakeven'];

function humanAge(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} hours`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

interface Model {
  S: number;
  K: number;
  T: number;
  r: number;
  q: number;
  iv: number;
  cost: number;
}

/**
 * Evaluates a long call from the evidence available. It never predicts direction: it
 * describes cost, risk, pricing and data quality, and refuses to rate what it cannot measure.
 *
 * Design rule: no check rewards a low premium or a high calculated probability. Cheap
 * far-out-of-the-money calls are cheap because they usually expire worthless, and a high
 * probability of finishing in the money comes with a high premium.
 */
export function evaluateCall(contract: ContractInput, context: MarketContext, options: EvaluateOptions = {}): Evaluation {
  const now = options.now ?? new Date();
  const today = nyDateString(now);
  const warnings: string[] = [];
  const missingRequired: string[] = [];
  const missingHelpful: string[] = [];
  const blockers: string[] = [];
  const metrics: MetricLine[] = [];
  const checks: Check[] = [];
  const addCheck = (c: CheckInput) => {
    checks.push({ ...c, category: DATA_CHECKS.has(c.id) ? 'data' : 'contract' });
  };
  // Data-reliability issues, keyed by underlying cause so one problem is counted once even if
  // it produces several messages. They lower confidence and cap the verdict at MIXED only.
  const dataIssues = new Map<string, string>();
  const flagData = (cause: string, message: string) => {
    if (!dataIssues.has(cause)) dataIssues.set(cause, message);
  };
  const explanations: string[] = [];
  const metric = (group: string, label: string, evidence: Evidence<number> | Evidence<string>, format: MetricFormat) => {
    metrics.push({ group, label, evidence, format });
  };

  const symbol = contract.underlying.value ?? 'the stock';
  const S = contract.stockPrice.value;
  const K = contract.strike.value;
  const expiration = contract.expiration.value;
  const qty = contract.quantity.value ?? 1;
  const mult = contract.multiplier.value ?? 100;
  const units = mult * qty; // shares controlled by the position
  const quoteAsOf = contract.quoteTime.value;

  // ---- Required inputs ------------------------------------------------------------------
  if (contract.optionType.value === 'put') blockers.push('This contract is a put. The Stage 1 evaluator only handles calls.');
  if (contract.optionType.kind === 'estimate') warnings.push('Option type was not stated, so it was assumed to be a CALL.');
  if (S === null) missingRequired.push('Underlying stock price (e.g. "Stock price: 123.45")');
  if (K === null) missingRequired.push('Strike price (e.g. "Strike: 130")');
  if (expiration === null) missingRequired.push('Expiration date (e.g. "Expiration: 2026-12-18")');

  const bid = contract.bid.value;
  const ask = contract.ask.value;
  let mid: number | null = null;
  if (bid !== null && ask !== null) {
    if (bid > ask) {
      warnings.push(`Bid (${money(bid)}) is above ask (${money(ask)}). The quote looks wrong, so the mid price and spread were not used.`);
      flagData('quote:inverted', `Quote: the bid (${money(bid)}) is above the ask (${money(ask)}), so the quote is unreliable.`);
    } else if (ask > 0) {
      mid = (bid + ask) / 2;
    } else {
      // bid <= ask <= 0 means both are $0: there is no valid offer to buy at.
      flagData('quote:no_offer', `Quote: the bid and ask are both ${money(ask)}, so there is no valid offer and the quote is unreliable.`);
    }
  }

  let cost: Evidence<number>;
  if (has(contract.premium)) cost = withNote(contract.premium, 'The premium you entered.');
  else if (has(contract.ask)) cost = withNote(contract.ask, 'No premium given; using the ask, the price you would likely pay with a market order.');
  else if (has(contract.mark)) cost = withNote(contract.mark, 'No premium or ask given; using the mark/mid. Your actual fill may be higher.');
  else if (has(contract.last)) cost = withNote(contract.last, 'Only a last-trade price was given. It may be stale and may not be what you would pay now.');
  else {
    cost = missing('No premium, ask, mark or last price was provided.');
    missingRequired.push('Option price: the premium you would pay, or the bid and ask');
  }
  if (cost.value === 0) blockers.push('The option price is zero, which cannot be evaluated. Check the quote.');
  const costPerShare = cost.value;
  const totalCost = costPerShare !== null ? costPerShare * units : null;

  // ---- Time -----------------------------------------------------------------------------
  let T: number | null = null;
  let dte: number | null = null;
  if (expiration !== null) {
    const close = expirationCloseUtc(expiration);
    dte = daysBetweenIsoDates(today, expiration);
    if (close.getTime() <= now.getTime()) blockers.push(`This contract expired (${expiration}, 4:00 PM ET) before the evaluation time (${formatNy(now)}).`);
    else T = yearsBetween(now, close);
  }

  // ---- Model inputs ---------------------------------------------------------------------
  const rE: Evidence<number> = has(context.riskFreeRate)
    ? context.riskFreeRate
    : estimate(DEFAULT_RISK_FREE_RATE, 'default assumption, not market data', 'Paste "Risk-free rate: x%" (for example the current 3-month Treasury bill yield) to replace it. Results are only mildly sensitive to this.');
  const qE: Evidence<number> = has(context.dividendYield)
    ? context.dividendYield
    : estimate(0, 'default assumption, not market data', 'Assumes no dividends before expiration.');
  if (!has(context.riskFreeRate)) warnings.push(`No risk-free rate given; assumed ${pct(DEFAULT_RISK_FREE_RATE)}. This is an assumption, not market data.`);
  if (!has(context.dividendYield)) warnings.push('No dividend yield given; assumed 0%. For a dividend-paying stock the calculated IV and Greeks will be slightly off.');
  const r = rE.value ?? DEFAULT_RISK_FREE_RATE;
  const q = qE.value ?? 0;

  // Inputs whose unit is ambiguous ("0.1" = 10% or 0.1%).
  for (const [label, ev] of [['Risk-free rate', context.riskFreeRate], ['Dividend yield', context.dividendYield], ['Broker IV', contract.quotedIV]] as const) {
    if (ev.ambiguity) flagData(`input:${label}`, `${label}: ${ev.ambiguity}`);
  }

  const priceForModel: Evidence<number> =
    mid !== null ? calculated(mid, 'mid price = (bid + ask) / 2', earliestAsOf(contract.bid, contract.ask)) : cost;

  let model: Model | null = null;
  let ivE: Evidence<number> = missing('Needs the stock price, strike, expiration and an option price.');
  if (blockers.length === 0 && S !== null && K !== null && T !== null && priceForModel.value !== null && costPerShare !== null) {
    const solved = impliedVolCall(priceForModel.value, { S, K, T, r, q });
    if (solved.ok) {
      model = { S, K, T, r, q, iv: solved.iv, cost: costPerShare };
      ivE = calculated(solved.iv, `Black-Scholes-Merton IV solved from the ${mid !== null ? 'mid price' : 'option price'}`, priceForModel.asOf);
    } else {
      let reason = solved.reason;
      if (solved.code === 'below_minimum' && S > K) {
        // Deep in the money, this may reflect the model's assumptions rather than a bad quote.
        reason += ` For an in-the-money call, another possible cause is a dividend the model does not know about${qE.kind === 'estimate' ? ' (no dividend yield was entered, so 0% was assumed)' : ''}. On a dividend-paying stock, an American-style call can be worth exercising early, so it can trade close to stock minus strike, below the European model's minimum. Black-Scholes cannot represent that. Rounding in the quote can also cause it.`;
      }
      ivE = missing(`Could not be calculated: ${reason}`);
      blockers.push(`Implied volatility could not be calculated: ${reason}`);
    }
  }
  const modelAsOf = earliestAsOf(contract.stockPrice, priceForModel);

  // Historical volatility is the independent reference for two checks, so a questionable value
  // must not be counted as evidence in either direction: ambiguous unit, zero, implausibly low or
  // high, or far below the option's own IV. It is shown, never rejected, and reduces reliability.
  const hvInput = context.historicalVol.value;
  const hvConcerns: string[] = [];
  if (context.historicalVol.ambiguity) hvConcerns.push(context.historicalVol.ambiguity);
  if (hvInput === 0) {
    hvConcerns.push('0.0% is not a valid historical volatility (a traded stock always moves somewhat).');
  } else if (hvInput !== null && hvInput < THRESHOLDS.hvPlausibleMin) {
    hvConcerns.push(`${pct(hvInput)} is below the ${pct(THRESHOLDS.hvPlausibleMin)} plausibility threshold; check the input.`);
  } else if (hvInput !== null && hvInput > THRESHOLDS.hvPlausibleMax) {
    hvConcerns.push(`${pct(hvInput)} is above the ${pct(THRESHOLDS.hvPlausibleMax)} plausibility threshold. That is possible for a very volatile stock, but check the input.`);
  }
  if (model !== null && hvInput !== null && hvInput > 0 && model.iv / hvInput < THRESHOLDS.ivHvInconsistentLow) {
    hvConcerns.push(`The option's implied volatility (${pct(model.iv)}) is only ${(model.iv / hvInput).toFixed(2)}x this historical volatility (${pct(hvInput)}), an IV/HV mismatch below the ${THRESHOLDS.ivHvInconsistentLow} consistency threshold. That can happen legitimately, but rule out an input error first.`);
  }
  const hvQuestionable = hvConcerns.length > 0;
  if (hvQuestionable) {
    flagData('input:historicalVol', `Historical volatility: ${hvConcerns.join(' ')} It is not used as evidence in the breakeven or valuation checks.`);
  }

  // ---- Contract -------------------------------------------------------------------------
  metric('Contract', 'Underlying', contract.underlying, 'text');
  metric('Contract', 'Option type', contract.optionType, 'text');
  metric('Contract', 'Exercise style', contract.exerciseStyle, 'text');
  metric('Contract', 'Stock price', contract.stockPrice, 'price');
  metric('Contract', 'Strike', contract.strike, 'price');
  metric('Contract', 'Expiration', contract.expiration, 'text');
  if (dte !== null && expiration !== null) metric('Contract', 'Days to expiration', calculated(dte, `calendar days from ${today} to ${expiration}`), 'days');
  if (S !== null && K !== null) {
    const note = K > S ? 'Strike is above the stock price: out of the money.' : K < S ? 'Strike is below the stock price: in the money.' : 'At the money.';
    metric('Contract', 'Strike distance from stock', calculated((K - S) / S, '(strike - stock) / stock', contract.stockPrice.asOf, note), 'signedPct');
  }
  metric('Contract', 'Contracts', contract.quantity, 'int');
  metric('Contract', 'Shares per contract', contract.multiplier, 'int');
  metric('Contract', 'Quote time', quoteAsOf !== null ? { ...contract.quoteTime, value: formatNy(new Date(quoteAsOf)) } : contract.quoteTime, 'text');

  // ---- Cost & liquidity -----------------------------------------------------------------
  metric('Cost & liquidity', 'Premium per share used', cost, 'price');
  if (totalCost !== null) metric('Cost & liquidity', 'Total cost', calculated(totalCost, `premium x ${mult} shares x ${qty} contract(s)`, cost.asOf), 'money');
  metric('Cost & liquidity', 'Bid', contract.bid, 'price');
  metric('Cost & liquidity', 'Ask', contract.ask, 'price');
  if (has(contract.mark)) metric('Cost & liquidity', 'Mark', contract.mark, 'price');
  if (has(contract.last)) metric('Cost & liquidity', 'Last trade', contract.last, 'price');

  if (mid !== null && bid !== null && ask !== null) {
    const spread = ask - bid;
    const spreadPct = spread / mid;
    const quoteTimes = earliestAsOf(contract.bid, contract.ask);
    metric('Cost & liquidity', 'Mid price', calculated(mid, '(bid + ask) / 2', quoteTimes), 'price');
    metric('Cost & liquidity', 'Bid-ask spread', calculated(spread, 'ask - bid', quoteTimes), 'price');
    metric('Cost & liquidity', 'Spread as % of mid', calculated(spreadPct, '(ask - bid) / mid', quoteTimes), 'pct');
    const status: CheckStatus = spreadPct <= THRESHOLDS.spreadPass ? 'pass' : spreadPct <= THRESHOLDS.spreadFail ? 'caution' : 'fail';
    addCheck({
      id: 'spread',
      title: 'Bid-ask spread',
      status,
      failMeans: 'weak',
      summary: `spread is ${pct(spreadPct)} of the mid price${status === 'pass' ? ' (tight)' : status === 'caution' ? ' (moderate)' : ' (wide)'}`,
      detail: `The spread is ${money(spread)} (${pct(spreadPct)} of the mid). Buying at the ask and later selling at the bid would cost about ${money(spread * units)} on this position before the stock moves at all.`,
    });
  } else if (bid !== null && ask !== null) {
    // Both were entered but cannot form a valid quote: say so, rather than asking for them again.
    const problem = bid > ask ? `quote is inverted (bid ${money(bid)} above ask ${money(ask)})` : `ask is ${money(ask)}, so there is no valid offer`;
    addCheck({ id: 'spread', title: 'Bid-ask spread', status: 'unknown', failMeans: 'weak', summary: `invalid quote: ${problem}`, detail: `The bid and ask you entered do not form a valid quote (${problem}), so the cost of getting in and out of this contract cannot be judged. Refresh the quote from your broker.` });
  } else {
    addCheck({ id: 'spread', title: 'Bid-ask spread', status: 'unknown', failMeans: 'weak', summary: 'bid and ask not both provided', detail: 'Without both the bid and the ask, the cost of getting in and out of this contract cannot be judged.' });
    missingHelpful.push('Bid and ask (to measure the spread, your real cost of trading)');
  }

  metric('Cost & liquidity', 'Volume (today)', contract.volume, 'int');
  metric('Cost & liquidity', 'Open interest', contract.openInterest, 'int');
  const oi = contract.openInterest.value;
  const vol = contract.volume.value;
  if (oi === null && vol === null) {
    addCheck({ id: 'liquidity', title: 'Open interest & volume', status: 'unknown', failMeans: 'weak', summary: 'not provided', detail: 'Open interest and volume were not provided, so it is unknown how actively this contract trades.' });
    missingHelpful.push('Open interest and volume (to judge how easily you could exit)');
  } else {
    let status: CheckStatus;
    const notes: string[] = [];
    if (oi === null) {
      status = 'unknown';
      notes.push('Open interest was not provided.');
    } else if (oi >= THRESHOLDS.openInterestPass) {
      status = 'pass';
      notes.push(`Open interest of ${oi.toLocaleString('en-US')} contracts suggests an active market.`);
    } else if (oi >= THRESHOLDS.openInterestFail) {
      status = 'caution';
      notes.push(`Open interest of ${oi.toLocaleString('en-US')} is modest; exits may need patience or a price concession.`);
    } else {
      status = 'fail';
      notes.push(`Open interest of ${oi.toLocaleString('en-US')} is very low; you may struggle to sell at a fair price.`);
    }
    if (vol === 0) {
      status = worse(status, 'caution');
      notes.push('No contracts have traded today, so the quote may not reflect a real trade.');
    } else if (vol !== null) {
      notes.push(`${vol.toLocaleString('en-US')} contracts traded today.`);
    }
    addCheck({ id: 'liquidity', title: 'Open interest & volume', status, failMeans: 'weak', summary: oi === null ? 'open interest unknown' : `open interest ${oi.toLocaleString('en-US')}, volume ${vol === null ? 'unknown' : vol.toLocaleString('en-US')}`, detail: notes.join(' ') });
  }

  if (quoteAsOf !== null) {
    const ageMinutes = (now.getTime() - Date.parse(quoteAsOf)) / 60_000;
    if (ageMinutes < -5) {
      addCheck({ id: 'freshness', title: 'Quote freshness', status: 'caution', failMeans: 'weak', summary: 'quote time is in the future', detail: `The quote time (${formatNy(new Date(quoteAsOf))}) is later than the evaluation time. Check the timestamp.` });
    } else if (ageMinutes <= THRESHOLDS.quoteFreshMinutes) {
      addCheck({ id: 'freshness', title: 'Quote freshness', status: 'pass', failMeans: 'weak', summary: `quote is ${humanAge(Math.max(ageMinutes, 0))} old`, detail: `Quote taken ${formatNy(new Date(quoteAsOf))}, ${humanAge(Math.max(ageMinutes, 0))} before this evaluation.` });
    } else {
      addCheck({ id: 'freshness', title: 'Quote freshness', status: 'caution', failMeans: 'weak', summary: `quote is ${humanAge(ageMinutes)} old`, detail: `Quote taken ${formatNy(new Date(quoteAsOf))}, ${humanAge(ageMinutes)} before this evaluation. Prices may have moved; refresh the quote before acting.` });
    }
  } else {
    addCheck({ id: 'freshness', title: 'Quote freshness', status: 'unknown', failMeans: 'weak', summary: 'quote time not provided', detail: 'Without a quote time it is unknown whether these prices are current.' });
    missingHelpful.push('Quote time (e.g. "Quote time: 2026-10-20 09:45 ET")');
  }

  // Entry premium vs. the quote. Breakeven and P/L use the premium you entered, while IV and
  // Greeks use the market mid, so a conflict between them must be resolved before relying on either.
  if (has(contract.premium) && mid !== null && bid !== null && ask !== null) {
    const p = contract.premium.value;
    const tol = Math.max(THRESHOLDS.entryToleranceAbs, THRESHOLDS.entryToleranceRel * mid);
    const consequence = 'Breakeven, maximum loss and profit/loss use the premium you entered, while implied volatility and the Greeks use the market mid price. Refresh the quote or correct the premium before relying on this assessment.';
    if (p > ask + tol) {
      warnings.push(`The premium you entered (${money(p)}) is above the ask (${money(ask)}).`);
      addCheck({ id: 'entry', title: 'Entry price vs. quote', status: 'caution', failMeans: 'weak', blocksStrong: true, summary: `entered premium ${money(p)} is above the ask ${money(ask)}`, detail: `The premium you entered (${money(p)}) is ${money(p - ask)} above the ask (${money(ask)}), more than the ${money(tol)} tolerance. Paying above the ask means overpaying for the contract. ${consequence}` });
    } else if (p < bid - tol) {
      warnings.push(`The premium you entered (${money(p)}) is below the bid (${money(bid)}).`);
      addCheck({ id: 'entry', title: 'Entry price vs. quote', status: 'caution', failMeans: 'weak', blocksStrong: true, summary: `entered premium ${money(p)} is below the bid ${money(bid)}`, detail: `The premium you entered (${money(p)}) is ${money(bid - p)} below the bid (${money(bid)}), more than the ${money(tol)} tolerance. A buy order at that price is unlikely to fill unless the market moves. ${consequence}` });
    } else {
      addCheck({ id: 'entry', title: 'Entry price vs. quote', status: 'pass', failMeans: 'weak', summary: 'entered premium is consistent with the bid/ask', detail: `The premium you entered (${money(p)}) is within the quoted bid/ask range (${money(bid)} - ${money(ask)}, tolerance ${money(tol)}).` });
    }
  }

  // ---- Breakeven & payoff ---------------------------------------------------------------
  let breakeven: number | null = null;
  if (K !== null && costPerShare !== null && totalCost !== null) {
    breakeven = breakevenCall(K, costPerShare);
    metric('Breakeven & payoff', 'Breakeven at expiration', calculated(breakeven, 'strike + premium', cost.asOf), 'price');
    if (S !== null) metric('Breakeven & payoff', 'Stock move needed to break even', calculated((breakeven - S) / S, '(breakeven - stock) / stock', modelAsOf), 'signedPct');
    metric('Breakeven & payoff', 'Maximum loss', calculated(totalCost, 'the full premium paid', cost.asOf, `Lost entirely if ${symbol} is at or below ${money(K)} at expiration.`), 'money');
    metric('Breakeven & payoff', 'Maximum gain', calculated('Unlimited in theory', 'a long call keeps gaining as the stock rises'), 'text');
    if (S !== null) {
      const intrinsic = Math.max(S - K, 0);
      metric('Breakeven & payoff', 'Intrinsic value per share', calculated(intrinsic, 'max(stock - strike, 0)', modelAsOf), 'price');
      metric('Breakeven & payoff', 'Time value per share', calculated(costPerShare - intrinsic, 'premium - intrinsic value', modelAsOf, 'The part of the premium that decays to zero by expiration.'), 'price');
      if (costPerShare < intrinsic - 0.005) {
        warnings.push(`The premium (${money(costPerShare)}) is below the intrinsic value (${money(intrinsic)}), which should not happen in a normal market. The quote is probably stale or wrong.`);
        flagData('input:premium_below_intrinsic', `Premium: ${money(costPerShare)} is below the intrinsic value of ${money(intrinsic)}, so the price is probably stale or wrong.`);
      }
    }
  }

  // ---- Volatility, Greeks, probabilities ------------------------------------------------
  metric('Volatility & value', 'Implied volatility (calculated)', ivE, 'pct');
  if (has(contract.quotedIV)) metric('Volatility & value', 'Implied volatility (broker-reported)', contract.quotedIV, 'pct');
  metric('Volatility & value', 'Historical volatility', context.historicalVol, 'pct');

  let valuation = 'Cannot assess: implied volatility could not be calculated from the inputs.';
  let greeks: ReturnType<typeof callGreeks> | null = null;
  let thetaShare: number | null = null;

  if (model !== null && breakeven !== null && dte !== null) {
    const { S: s, K: k, T: t, iv } = model;
    greeks = callGreeks({ S: s, K: k, T: t, r, q, sigma: iv });
    const modelValue = bsCall({ S: s, K: k, T: t, r, q, sigma: iv });
    thetaShare = -greeks.thetaPerDay / modelValue;
    const method = 'Black-Scholes-Merton with the calculated IV';
    // When a 1-point IV change moves the price by less than half a cent, the quote barely
    // constrains IV (typical deep in the money): rounding alone can shift it a lot.
    if (greeks.vegaPerVolPoint < 0.005) {
      warnings.push('This option is almost entirely intrinsic value, so its price barely depends on volatility. The calculated implied volatility, and the Greeks and probabilities built on it, are poorly determined. Small rounding in the quote can change them substantially.');
      flagData('model:iv_poorly_determined', 'Implied volatility: poorly determined, because the price barely depends on volatility (almost all intrinsic value). IV-based numbers may shift substantially with small quote changes.');
    }

    const sdMove = s * iv * Math.sqrt(t);
    const d2At = (x: number) => (Math.log(s / x) + (r - q - (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
    const pAboveBreakeven = normCdf(d2At(breakeven));
    const pItm = normCdf(d2At(k));
    metric('Volatility & value', 'Implied 1-standard-deviation move by expiration', estimate(sdMove, 'stock x IV x sqrt(time)', `About +/-${pct(sdMove / s)}. Roughly 2 out of 3 outcomes fall inside this range if the model's assumptions hold.`, modelAsOf), 'price');
    metric('Volatility & value', 'Model chance of finishing above breakeven', estimate(pAboveBreakeven, 'risk-neutral lognormal model', 'Implied by the option price; not a forecast. A high value is not, by itself, a reason to buy.', modelAsOf), 'pct');
    metric('Volatility & value', 'Model chance of finishing in the money', estimate(pItm, 'risk-neutral lognormal model', 'Finishing in the money is not the same as making a profit.', modelAsOf), 'pct');
    const hv = context.historicalVol.value;
    // Shown only when HV is usable; a ratio built on questionable HV would look like trustworthy evidence.
    if (hv !== null && hv > 0 && !hvQuestionable) metric('Volatility & value', 'IV / historical volatility', calculated(iv / hv, 'calculated IV / historical volatility', modelAsOf), 'greek');

    metric('Greeks', 'Delta', calculated(greeks.delta, method, modelAsOf, `Option price changes about ${money(greeks.delta)} per share for each $1 move in the stock.`), 'greek');
    metric('Greeks', 'Gamma', calculated(greeks.gamma, method, modelAsOf, 'How much delta changes for each $1 move in the stock.'), 'greek');
    metric('Greeks', 'Theta per day (position)', calculated(greeks.thetaPerDay * units, method, modelAsOf, `Value lost per calendar day if nothing else changes (${pct(thetaShare)} of the option value).`), 'money');
    metric('Greeks', 'Vega per 1 IV point (position)', calculated(greeks.vegaPerVolPoint * units, method, modelAsOf, 'Value change if implied volatility moves 1 percentage point.'), 'money');
    metric('Greeks', 'Rho per 1% rate (position)', calculated(greeks.rhoPerRatePoint * units, method, modelAsOf), 'money');
    if (has(contract.quotedDelta)) metric('Greeks', 'Delta (broker-reported)', contract.quotedDelta, 'greek');
    if (has(contract.quotedGamma)) metric('Greeks', 'Gamma (broker-reported)', contract.quotedGamma, 'greek');
    if (has(contract.quotedTheta)) metric('Greeks', 'Theta (broker-reported, as pasted)', contract.quotedTheta, 'greek');
    if (has(contract.quotedVega)) metric('Greeks', 'Vega (broker-reported, as pasted)', contract.quotedVega, 'greek');

    // Time remaining & decay. Short-dated contracts are cautioned and cannot rate strong; whether
    // one is TOO_RISKY is decided by the breakeven and delta checks, not by in/out of the money alone.
    let blocksStrong = false;
    {
      let status: CheckStatus = 'pass';
      const notes = [`${dte} calendar day(s) to expiration.`];
      if (dte <= THRESHOLDS.shortDte) {
        status = 'caution';
        blocksStrong = true;
        const needed = (breakeven - s) / s;
        notes.push(
          `A week or less left: time decay is at its fastest and there is little time to recover from an adverse move.`,
          needed > 0
            ? `The stock must rise ${pct(needed)} to reach breakeven (${money(breakeven)}) within ${dte} day(s).`
            : `The stock is already above breakeven (${money(breakeven)}); the position mainly needs it to stay there.`,
          `Delta is ${greeks.delta.toFixed(2)}. Delta is a price sensitivity; it is sometimes used as a rough proxy for the chance of finishing in the money, but it is not a real-world probability.`,
        );
      } else if (dte <= THRESHOLDS.cautionDte) {
        status = 'caution';
        notes.push('Three weeks or less left: time decay accelerates in the final weeks.');
      }
      if (thetaShare > THRESHOLDS.thetaShareOfValuePerDay) {
        status = worse(status, 'caution');
        notes.push(`Time decay is about ${pct(thetaShare)} of the option's value per day.`);
      } else {
        notes.push(`Time decay is about ${pct(thetaShare)} of the option's value per day right now.`);
      }
      addCheck({ id: 'time', title: 'Time remaining & decay', status, failMeans: 'too_risky', blocksStrong, summary: `${dte} days left, decay ~${pct(thetaShare)} of value per day`, detail: notes.join(' ') });
    }

    // Breakeven versus a typical move. Historical volatility is the independent reference. The
    // option's own IV can only add a conservative warning: measured against itself an overpriced
    // option looks easy, so a favorable IV-based result is never counted as evidence.
    {
      const needed = breakeven - s;
      const ratioStatus = (ratio: number): CheckStatus =>
        ratio <= THRESHOLDS.breakevenSdPass ? 'pass' : ratio <= THRESHOLDS.breakevenSdFail ? 'caution' : 'fail';
      if (needed <= 0) {
        addCheck({ id: 'breakeven', title: 'Breakeven vs. typical move', status: 'pass', failMeans: 'too_risky', summary: 'stock is already above breakeven', detail: `Breakeven is ${money(breakeven)}, already below the current price of ${money(s)}.` });
      } else {
        const impliedRatio = needed / sdMove;
        const impliedWarning: CheckStatus = ratioStatus(impliedRatio) === 'pass' ? 'unknown' : ratioStatus(impliedRatio);
        const parts = [`Breakeven is ${money(breakeven)}, ${signedPct(needed / s)} from the current price.`];
        let hvStatus: CheckStatus = 'unknown';
        let hvRatio: number | null = null;
        if (hv !== null && hv > 0 && !hvQuestionable) {
          const hvMove = s * hv * Math.sqrt(t);
          hvRatio = needed / hvMove;
          hvStatus = ratioStatus(hvRatio);
          parts.push(`At the stock's historical volatility (${pct(hv)}), a typical (1 standard deviation) move by expiration is about +/-${money(hvMove)} (${pct(hvMove / s)}), so reaching breakeven takes ${hvRatio.toFixed(2)}x that move. If returns behaved like the model assumes, an upward move larger than 1.5 standard deviations would happen in only about 7% of outcomes.`);
        } else {
          parts.push(hv !== null
            ? `The independent comparison with historical volatility is unavailable because the historical volatility input (${pct(hv)}) is questionable (see Data reliability).`
            : 'The independent comparison with historical volatility is unavailable because historical volatility was not provided.');
        }
        parts.push(impliedWarning === 'unknown'
          ? `For comparison only (not counted as evidence): the option's own implied volatility suggests a 1-SD move of +/-${money(sdMove)}, of which breakeven needs ${impliedRatio.toFixed(2)}x.`
          : `Even measured against the option's own implied volatility (1-SD move +/-${money(sdMove)}), breakeven needs ${impliedRatio.toFixed(2)}x that move. This is counted as a conservative warning only; the option's own IV is never counted as a reason to pass this check.`);
        const status = worse(hvStatus, impliedWarning);
        const summary = hvRatio !== null && status === hvStatus
          ? `breakeven needs ${hvRatio.toFixed(2)}x a 1-SD move at historical volatility`
          : impliedWarning !== 'unknown'
            ? `breakeven needs ${impliedRatio.toFixed(2)}x even the option's own implied 1-SD move${hvRatio === null ? ' (no independent reference)' : ''}`
            : `no independent volatility reference (historical volatility ${hv !== null ? 'questionable' : 'not provided'})`;
        addCheck({ id: 'breakeven', title: 'Breakeven vs. typical move', status, failMeans: 'too_risky', summary, detail: parts.join(' ') });
      }
    }

    // Delta: how lottery-like the contract is.
    {
      const d = greeks.delta;
      const status: CheckStatus = d < THRESHOLDS.deltaFail ? 'fail' : d < THRESHOLDS.deltaCaution ? 'caution' : 'pass';
      addCheck({
        id: 'delta',
        title: 'Distance out of the money (delta)',
        status,
        failMeans: 'too_risky',
        summary: `delta ${d.toFixed(2)}`,
        detail: status === 'pass'
          ? `Delta of ${d.toFixed(2)}: the option responds meaningfully to moves in the stock.`
          : `Delta of ${d.toFixed(2)}: the option is far out of the money and behaves like a lottery ticket. Delta is a price sensitivity, not a real-world probability, but a value this low is consistent with the model expecting it to expire worthless in most outcomes. Its low price reflects that; cheapness is not an advantage.`,
      });
    }

    // Implied vs realized volatility: the only overpriced/underpriced gauge available offline.
    if (hv !== null && hvQuestionable) {
      valuation = `Cannot assess reliably: the historical volatility input (${pct(hv)}) is questionable (see Data reliability), so it is not counted either way, and no IV/HV ratio is reported.`;
      addCheck({ id: 'valuation', title: 'Price vs. recent volatility', status: 'unknown', failMeans: 'weak', summary: 'historical volatility input is questionable', detail: valuation });
    } else if (hv !== null && hv > 0) {
      const ratio = iv / hv;
      let status: CheckStatus;
      let blocks = false;
      if (ratio >= THRESHOLDS.ivHvSevere) {
        status = 'fail';
        valuation = `Appears MUCH MORE EXPENSIVE than recent movement justifies: implied volatility (${pct(iv)}) is ${ratio.toFixed(2)}x the stock's recent realized volatility (${pct(hv)}). This is strong evidence of a high price relative to recent movement, though not proof: a known upcoming event can justify elevated IV. Check the quote and look for a reason before relying on this contract.`;
      } else if (ratio >= THRESHOLDS.ivHvVeryExpensive) {
        status = 'caution';
        blocks = true;
        valuation = `Appears EXPENSIVE: implied volatility (${pct(iv)}) is ${ratio.toFixed(2)}x the stock's recent realized volatility (${pct(hv)}).`;
      } else if (ratio >= THRESHOLDS.ivHvExpensive) {
        status = 'caution';
        valuation = `Appears SOMEWHAT EXPENSIVE: implied volatility (${pct(iv)}) is ${ratio.toFixed(2)}x recent realized volatility (${pct(hv)}).`;
      } else if (ratio < THRESHOLDS.ivHvCheap) {
        status = 'pass';
        valuation = `Appears INEXPENSIVE relative to recent movement: implied volatility (${pct(iv)}) is ${ratio.toFixed(2)}x recent realized volatility (${pct(hv)}). Cheap is not the same as good.`;
      } else {
        status = 'pass';
        valuation = `Roughly IN LINE: implied volatility (${pct(iv)}) is ${ratio.toFixed(2)}x recent realized volatility (${pct(hv)}).`;
      }
      valuation += ' This is a rough gauge, not a fair-value calculation; IV is normally higher ahead of known events such as earnings.';
      addCheck({ id: 'valuation', title: 'Price vs. recent volatility', status, failMeans: 'weak', blocksStrong: blocks, summary: `IV/HV ${ratio.toFixed(2)}`, detail: valuation });
    } else {
      valuation = 'Cannot assess whether the option is overpriced or underpriced: no historical (realized) volatility was provided to compare against.';
      addCheck({ id: 'valuation', title: 'Price vs. recent volatility', status: 'unknown', failMeans: 'weak', summary: 'historical volatility not provided', detail: valuation });
      missingHelpful.push('Historical volatility of the stock (e.g. "Historical volatility: 30%", the 20- or 30-day realized volatility) to judge whether the option is expensive');
    }

    // Broker IV cross-check: large differences point to stale or inconsistent inputs.
    const quotedIv = contract.quotedIV.value;
    if (quotedIv !== null) {
      const diff = iv - quotedIv;
      const status: CheckStatus = Math.abs(diff) > THRESHOLDS.ivCrossCheck ? 'caution' : 'pass';
      addCheck({
        id: 'iv_crosscheck',
        title: 'Cross-check with broker IV',
        status,
        failMeans: 'weak',
        summary: `calculated ${pct(iv)} vs broker ${pct(quotedIv)}`,
        detail: status === 'pass'
          ? `The calculated IV (${pct(iv)}) is consistent with the broker-reported IV (${pct(quotedIv)}).`
          : `The calculated IV (${pct(iv)}) differs from the broker-reported IV (${pct(quotedIv)}) by ${Math.abs(diff * 100).toFixed(1)} points. Possible causes: stale stock or option prices, a dividend not included here, or a different model. Treat the IV-based numbers with extra caution.`,
      });
    }
  }

  // ---- Catalysts & context --------------------------------------------------------------
  metric('Catalysts & context', 'Next earnings date', context.earningsDate, 'text');
  const earnings = context.earningsDate.value;
  if (earnings !== null && expiration !== null && earnings < today) {
    // A date that has passed says nothing about the NEXT announcement.
    addCheck({ id: 'earnings', title: 'Earnings before expiration', status: 'unknown', failMeans: 'weak', summary: `earnings date given (${earnings}) has already passed; next date unknown`, detail: `The earnings date you gave (${earnings}) is in the past, so it cannot show whether the next announcement falls before expiration (${expiration}).` });
    missingHelpful.push(`Next earnings date: the date you gave (${earnings}) has already passed`);
  } else if (earnings !== null && expiration !== null) {
    if (earnings <= expiration) {
      addCheck({
        id: 'earnings',
        title: 'Earnings before expiration',
        status: 'caution',
        failMeans: 'weak',
        summary: `earnings ${earnings}, before expiration`,
        detail: `Earnings are expected on ${earnings}, before expiration. Implied volatility often rises into earnings and drops sharply right after ("IV crush"), which can cut the option's value even if the stock moves your way. The stock can also gap sharply in either direction.`,
      });
    } else {
      addCheck({ id: 'earnings', title: 'Earnings before expiration', status: 'pass', failMeans: 'weak', summary: `no earnings before expiration (next: ${earnings})`, detail: `The next earnings date you gave (${earnings}) is not between now and expiration.` });
    }
  } else {
    addCheck({ id: 'earnings', title: 'Earnings before expiration', status: 'unknown', failMeans: 'weak', summary: 'earnings date not provided', detail: 'Without the next earnings date it is unknown whether an earnings announcement (and the volatility drop that often follows) falls before expiration.' });
    missingHelpful.push('Next earnings date (e.g. "Earnings date: 2026-11-05")');
  }

  const exDiv = context.exDividendDate.value;
  const divAmount = context.dividendAmount.value;
  if (has(context.exDividendDate)) metric('Catalysts & context', 'Ex-dividend date', context.exDividendDate, 'text');
  if (has(context.dividendAmount)) metric('Catalysts & context', 'Dividend per share', context.dividendAmount, 'price');
  if (exDiv !== null && expiration !== null && exDiv >= today && exDiv <= expiration) {
    const timeValue = S !== null && K !== null && costPerShare !== null ? costPerShare - Math.max(S - K, 0) : null;
    const earlyExercise = divAmount !== null && timeValue !== null && S !== null && K !== null && S > K && divAmount >= timeValue;
    addCheck({
      id: 'dividend',
      title: 'Dividend before expiration',
      status: 'caution',
      failMeans: 'weak',
      summary: earlyExercise ? 'early exercise may be optimal before the ex-dividend date' : `ex-dividend ${exDiv}, before expiration`,
      detail: earlyExercise
        ? `The dividend (${money(divAmount!)}) exceeds this call's remaining time value (${money(timeValue!)}). Holders of in-the-money calls may exercise early to collect it, and Black-Scholes does not capture this early-exercise value, so the model numbers are less reliable here.`
        : `The ex-dividend date (${exDiv}) falls before expiration. The stock usually drops by about the dividend on that date, which lowers call value.${qE.kind === 'estimate' ? ' No dividend yield was provided, so the model ignores this.' : ''}`,
    });
  } else if (exDiv === null) {
    missingHelpful.push('Ex-dividend date and amount, if the stock pays a dividend');
  }

  metric('Catalysts & context', 'Recent trend', context.trend, 'text');
  if (!has(context.trend)) missingHelpful.push('Recent trend of the stock (the scanner will supply this in a later stage; for now paste e.g. "Trend: up 6% over 20 trading days")');

  metric('Model inputs', 'Risk-free rate', rE, 'pct');
  metric('Model inputs', 'Dividend yield', qE, 'pct');

  // ---- Scenarios ------------------------------------------------------------------------
  const scenarios = S !== null && K !== null && costPerShare !== null && costPerShare > 0 && blockers.length === 0
    ? expiryScenarios(S, K, costPerShare, mult, qty)
    : [];

  let whatIf: WhatIfTable | null = null;
  if (model !== null && dte !== null && dte >= 4 && totalCost !== null) {
    const daysElapsed = Math.floor(dte / 2);
    const later = model.T - daysElapsed / 365;
    const stockMoves = [-0.05, 0, 0.05, 0.1];
    const ivChangePoints = [-10, -5, 0, 5];
    const pnl = stockMoves.map((m) =>
      ivChangePoints.map((d) => {
        const sigma = Math.max(model!.iv + d / 100, 0.01);
        return bsCall({ S: model!.S * (1 + m), K: model!.K, T: later, r, q, sigma }) * units - totalCost;
      }),
    );
    whatIf = { atDate: addDaysIso(today, daysElapsed), daysElapsed, stockMoves, ivChangePoints, pnl };
  }

  // ---- Plain-English explanations -------------------------------------------------------
  if (totalCost !== null && K !== null) {
    explanations.push(`Most you can lose: the full ${money(totalCost)} you pay. That happens if ${symbol} is at or below ${money(K)} at expiration. The potential gain is unlimited in theory, but only the part of the move above ${breakeven !== null ? money(breakeven) : 'breakeven'} is profit.`);
  }
  if (greeks !== null && thetaShare !== null) {
    explanations.push(`Time decay (theta): if nothing else changed, the position would lose about ${money(-greeks.thetaPerDay * units)} per day now (${pct(thetaShare)} of its value), and the daily loss grows as expiration approaches.`);
    explanations.push(`Volatility (vega): each 1-point change in implied volatility moves the position value by about ${money(greeks.vegaPerVolPoint * units)}. A 10-point drop, which is common right after earnings, would remove about ${money(10 * greeks.vegaPerVolPoint * units)} even if the stock did not move.`);
  }
  if (whatIf !== null) {
    explanations.push('Why a call can lose money even when the stock rises: the premium is intrinsic value (how far the stock is above the strike) plus time value. Time value shrinks every day and also shrinks when implied volatility falls. If the stock rises less than those losses, the option loses value.');
    let example: string | null = null;
    for (let i = whatIf.stockMoves.length - 1; i >= 0 && example === null; i--) {
      const move = whatIf.stockMoves[i]!;
      if (move <= 0) continue;
      for (const j of [2, 1, 0]) {
        const loss = whatIf.pnl[i]![j]!;
        const ivChange = whatIf.ivChangePoints[j]!;
        if (loss < 0 && S !== null) {
          example = `Example from the model: if ${symbol} rises ${pct(move)} to about ${money(S * (1 + move))} by ${whatIf.atDate} and implied volatility ${ivChange === 0 ? 'stays the same' : `falls ${-ivChange} points`}, the position would show about ${signedMoney(loss)}. ${whatIf.daysElapsed} days of time decay${ivChange < 0 ? ' plus the lower volatility' : ''} outweigh the gain from the stock move.`;
          break;
        }
      }
    }
    const flat = whatIf.pnl[whatIf.stockMoves.indexOf(0)]![whatIf.ivChangePoints.indexOf(0)]!;
    explanations.push(example ?? `In this table no stock rise of 5% or more led to a loss, but if ${symbol} is unchanged on ${whatIf.atDate}, time decay alone would change the position by about ${signedMoney(flat)}.`);
  }
  explanations.push('This rating never improves because a premium is low or because a calculated probability is high. Cheap far-out-of-the-money calls are cheap because they usually expire worthless, and a high chance of finishing in the money comes with a high premium.');

  // ---- Verdict --------------------------------------------------------------------------
  let verdict: Verdict;
  let verdictSummary: string;
  const verdictReasons: string[] = [];
  // Only contract checks count as evidence about the contract (WEAK / TOO_RISKY). Data checks
  // lower reliability and cap the verdict at MIXED, but never make a contract look worse.
  const contractChecks = checks.filter((c) => c.category === 'contract');
  const fails = contractChecks.filter((c) => c.status === 'fail');
  const riskFails = fails.filter((c) => c.failMeans === 'too_risky');
  const cautions = contractChecks.filter((c) => c.status === 'caution');
  const unknownKey = checks.filter((c) => MUST_BE_KNOWN.includes(c.id) && c.status === 'unknown');
  for (const c of checks) {
    if (c.category === 'data' && c.status !== 'pass') flagData(`check:${c.id}`, `${c.title}: ${c.summary}`);
  }
  const strongBlocked = checks.filter((c) => c.blocksStrong && (c.status === 'caution' || c.status === 'fail'));
  const dataReliability: Evaluation['dataReliability'] = {
    level: dataIssues.size > 0 ? 'reduced' : 'normal',
    reasons: [...dataIssues.values()],
  };

  if (missingRequired.length > 0 || blockers.length > 0 || model === null) {
    verdict = 'INSUFFICIENT_DATA';
    verdictSummary = 'Cannot assess this contract reliably from the information provided.';
    verdictReasons.push(...blockers, ...missingRequired.map((m) => `Missing: ${m}`));
  } else if (riskFails.length > 0) {
    verdict = 'TOO_RISKY';
    verdictSummary = 'Too risky: the evidence (breakeven far beyond a typical move, or a very low delta) indicates a low chance of recovering the premium under the model\'s assumptions. That is not a certainty, but the evidence weighs heavily against it.';
    verdictReasons.push(...fails.map((c) => `${c.title}: ${c.summary}`));
  } else if (fails.length > 0 || cautions.length >= 3) {
    verdict = 'WEAK';
    verdictSummary = 'Weak: several problems with cost, liquidity, timing or pricing outweigh the positives.';
    verdictReasons.push(...fails.map((c) => `${c.title}: ${c.summary}`), ...cautions.map((c) => `${c.title}: ${c.summary}`));
  } else if (cautions.length <= 1 && unknownKey.length === 0 && dataIssues.size === 0 && strongBlocked.length === 0) {
    verdict = 'RELATIVELY_STRONG';
    verdictSummary = 'Relatively strong on the evidence available: liquidity, pricing and timing checks passed. This is not a prediction that the stock will rise, and you can still lose the entire premium.';
    verdictReasons.push(...checks.filter((c) => c.status === 'pass').map((c) => `${c.title}: ${c.summary}`), ...cautions.map((c) => `Caution - ${c.title}: ${c.summary}`));
  } else {
    verdict = 'MIXED';
    // Name what actually held the rating back, most severe first, instead of a generic phrase.
    const severity = (c: Check) => (c.failMeans === 'too_risky' ? 0 : c.blocksStrong ? 1 : 2);
    const titles = (list: Check[]) => list.map((c) => c.title.toLowerCase()).join(', ');
    const held: string[] = [];
    if (cautions.length > 0) held.push(`cautions on ${titles([...cautions].sort((a, b) => severity(a) - severity(b)))}`);
    const unknownOnly = unknownKey.filter((c) => c.category === 'contract');
    if (unknownOnly.length > 0) held.push(`missing evidence for ${titles(unknownOnly)}`);
    if (dataIssues.size > 0) held.push(`reduced data reliability (${dataIssues.size} issue${dataIssues.size === 1 ? '' : 's'})`);
    verdictSummary = `Mixed: not rated higher because of ${held.join('; ') || 'incomplete evidence'}. No check found a problem severe enough for WEAK or TOO RISKY, which is not a positive signal by itself.`;
    const seen = new Set<string>();
    const add = (prefix: string, c: Check) => {
      if (!seen.has(c.id)) verdictReasons.push(`${prefix} - ${c.title}: ${c.summary}`);
      seen.add(c.id);
    };
    for (const c of cautions) add('Caution', c);
    for (const c of unknownOnly) add('Unknown', c);
    for (const message of dataIssues.values()) verdictReasons.push(`Data reliability - ${message}`);
  }

  const label = `${contract.underlying.value ?? '(no ticker)'} ${K !== null ? money(K) : '(no strike)'} ${(contract.optionType.value ?? 'call').toUpperCase()}, expires ${expiration ?? '(no date)'}`;

  return {
    label,
    evaluatedAt: formatNy(now),
    verdict,
    verdictSummary,
    verdictReasons,
    dataReliability,
    valuation,
    missingRequired,
    missingHelpful,
    metrics,
    checks,
    expiryScenarios: scenarios,
    whatIf,
    explanations,
    modelLimitations: [...MODEL_LIMITATIONS],
    warnings,
  };
}
