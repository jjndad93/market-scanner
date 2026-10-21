/**
 * Stage 6: automatic options discovery. Validates provider contracts, filters out unsuitable
 * ones with recorded reasons, evaluates eligible CALLS with the existing option evaluator
 * (unchanged formulas and thresholds), and ranks those with sufficient data.
 *
 * Provenance: provider quotes and contract terms are VERIFIED DATA (fetched by this tool from the
 * named source; TEST DATA for fixtures); provider IV and Greeks are THIRD-PARTY (the provider's
 * own model); everything the evaluator derives is CALCULATED; absent fields stay MISSING.
 */

import { type Evidence, missing, testData, thirdParty, verified } from '../core/evidence.ts';
import { daysBetweenIsoDates, nyDateString } from '../core/time.ts';
import { THRESHOLDS, evaluateCall, type Evaluation, type Verdict } from '../options/evaluate.ts';
import { parseContractText } from '../options/parse.ts';
import type { ContractInput } from '../options/types.ts';
import { parseOptionChain, type RawOptionContract } from '../providers/massive-options.ts';

/** Discovery filters. Spread, open interest and days-to-expiration reuse the evaluator's thresholds. */
export const OPTION_SCAN_RULES = {
  maxSpreadOfMid: THRESHOLDS.spreadFail, // exclude spreads wider than 10% of mid
  minOpenInterest: THRESHOLDS.openInterestFail, // exclude OI below 100, when OI is supplied
  minDaysToExpiration: THRESHOLDS.shortDte, // exclude fewer than 7 days to expiration
  maxQuoteAgeDays: 4, // exclude quotes older than this (covers a 3-day weekend), or in the future
  maxRanked: 10, // candidates shown in the ranked list
};

export type OptionExclusionCode =
  | 'incomplete' | 'expired' | 'too_short' | 'missing_quote' | 'crossed_market' | 'no_offer' | 'wide_spread' | 'stale_quote' | 'low_open_interest';

export interface OptionContract {
  ticker: string;
  underlying: string;
  underlyingPrice: number;
  type: 'call' | 'put';
  exerciseStyle: 'american' | 'european' | null;
  strike: number;
  expiration: string;
  daysToExpiration: number;
  bid: number | null;
  ask: number | null;
  quoteTime: string | null;
  last: number | null;
  lastTime: string | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** (ask - bid) / mid, when both are valid. */
  spreadOfMid: number | null;
}

export interface OptionScanDataset {
  dataset: { kind: 'synthetic' | 'live'; label: string; source: string; asOf: string; attribution?: string; notes?: string[] };
  chains: { underlying: string; response?: unknown; status?: 'request_failed' | 'not_requested' }[];
}

export interface RankedCandidate {
  rank: number;
  contract: OptionContract;
  verdict: Verdict;
  verdictSummary: string;
  reasons: string[];
  dataReliability: Evaluation['dataReliability'];
  valuation: string;
}

export interface OptionScanResult {
  dataset: OptionScanDataset['dataset'];
  evaluatedAt: string;
  underlyings: { scanned: number; failed: string[]; notRequested: string[]; truncated: string[]; /** Stage 8, present only when non-empty: chains with no contracts. */ empty?: string[] };
  counts: { retrieved: number; excluded: number; eligible: number; evaluated: number; ranked: number; insufficient: number; putsNotEvaluated: number };
  ranked: RankedCandidate[];
  /** Ranked candidates beyond the display limit. */
  moreRanked: number;
  /** Evaluated, but the evaluator could not assess them (INSUFFICIENT DATA): not ranked. */
  insufficient: { ticker: string; reasons: string[] }[];
  putsNotEvaluated: string[];
  /** Exclusions grouped by first reason, with counts and examples. */
  exclusions: { code: OptionExclusionCode; count: number; examples: string[]; /** First-reason detail for each example (Stage 7, additive). */ details: string[] }[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// An impossible date such as 2026-13-01 is invalid, not a crash: check the parse before toISOString.
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Validates one raw contract; returns the contract, or the first reason it cannot be used. */
export function validateContract(r: RawOptionContract, now: Date, rules = OPTION_SCAN_RULES): { contract: OptionContract | null; reasons: { code: OptionExclusionCode; detail: string }[] } {
  const strike = num(r.strike);
  const price = num(r.underlyingPrice);
  const type = r.type === 'call' || r.type === 'put' ? r.type : null;
  const ticker = typeof r.ticker === 'string' && r.ticker !== '' ? r.ticker : null;
  const underlying = typeof r.underlying === 'string' && r.underlying !== '' ? r.underlying : null;
  // A field the provider omitted is "missing"; one it sent in an unusable form is "invalid".
  const absent = (v: unknown) => v === undefined || v === null || v === '';
  const problems: [string, unknown, boolean][] = [
    ['contract ticker', r.ticker, ticker !== null], ['underlying', r.underlying, underlying !== null], ['call/put type', r.type, type !== null],
    ['strike', r.strike, strike !== null && strike > 0], ['expiration', r.expiration, isIsoDate(r.expiration)], ['underlying price', r.underlyingPrice, price !== null && price > 0],
  ];
  const missingParts = problems.filter(([, v, ok]) => !ok && absent(v)).map(([n]) => n);
  const invalidParts = problems.filter(([, v, ok]) => !ok && !absent(v)).map(([n, v]) => `${n} (${JSON.stringify(v)})`);
  if (missingParts.length + invalidParts.length > 0) {
    const detail = [missingParts.length > 0 && `missing: ${missingParts.join(', ')}`, invalidParts.length > 0 && `invalid: ${invalidParts.join(', ')}`].filter(Boolean).join('; ');
    return { contract: null, reasons: [{ code: 'incomplete', detail }] };
  }

  const today = nyDateString(now);
  const expiration = r.expiration as string;
  const dte = daysBetweenIsoDates(today, expiration);
  const bid = num(r.bid);
  const ask = num(r.ask);
  const validBid = bid !== null && bid >= 0 ? bid : null;
  const validAsk = ask !== null && ask >= 0 ? ask : null;
  const spreadOfMid = validBid !== null && validAsk !== null && validAsk > 0 && validBid <= validAsk ? (validAsk - validBid) / ((validAsk + validBid) / 2) : null;
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const nonNeg = (v: unknown) => { const n = num(v); return n !== null && n >= 0 ? n : null; };
  const contract: OptionContract = {
    ticker: ticker!, underlying: underlying!, underlyingPrice: price!, type: type!,
    exerciseStyle: r.exerciseStyle === 'american' || r.exerciseStyle === 'european' ? r.exerciseStyle : null,
    strike: strike!, expiration, daysToExpiration: dte,
    bid: validBid, ask: validAsk, quoteTime: iso(r.quoteTimeMs), last: nonNeg(r.last), lastTime: iso(r.lastTimeMs),
    volume: nonNeg(r.volume), openInterest: nonNeg(r.openInterest), iv: nonNeg(r.iv),
    delta: num(r.delta), gamma: num(r.gamma), theta: num(r.theta), vega: num(r.vega), spreadOfMid,
  };

  const reasons: { code: OptionExclusionCode; detail: string }[] = [];
  if (dte < 0) reasons.push({ code: 'expired', detail: `expired on ${expiration}` });
  else if (dte < rules.minDaysToExpiration) reasons.push({ code: 'too_short', detail: `${dte} day(s) to expiration (minimum ${rules.minDaysToExpiration})` });
  if (validBid === null || validAsk === null) reasons.push({ code: 'missing_quote', detail: `no valid ${validBid === null && validAsk === null ? 'bid or ask' : validBid === null ? 'bid' : 'ask'} from the provider` });
  else if (validBid > validAsk) reasons.push({ code: 'crossed_market', detail: `bid ${validBid} is above ask ${validAsk}` });
  else if (validAsk === 0) reasons.push({ code: 'no_offer', detail: 'ask is 0: no offer to buy at' });
  else if (spreadOfMid! > rules.maxSpreadOfMid) reasons.push({ code: 'wide_spread', detail: `spread is ${(spreadOfMid! * 100).toFixed(1)}% of mid (limit ${rules.maxSpreadOfMid * 100}%)` });
  if (validBid !== null && validAsk !== null) {
    if (r.quoteTimeMs === null) reasons.push({ code: 'stale_quote', detail: 'quote time not supplied' });
    else {
      const ageDays = (now.getTime() - r.quoteTimeMs) / 86_400_000;
      if (ageDays > rules.maxQuoteAgeDays) reasons.push({ code: 'stale_quote', detail: `quote is ${ageDays.toFixed(1)} days old (limit ${rules.maxQuoteAgeDays})` });
      else if (ageDays < -5 / 1440) reasons.push({ code: 'stale_quote', detail: 'quote time is in the future; unreliable' });
    }
  }
  if (contract.openInterest !== null && contract.openInterest < rules.minOpenInterest) reasons.push({ code: 'low_open_interest', detail: `open interest ${contract.openInterest} (minimum ${rules.minOpenInterest})` });
  return { contract, reasons };
}

/** Evaluator input for one contract, with honest provenance; absent fields stay MISSING. */
export function toEvaluatorInput(c: OptionContract, kind: 'synthetic' | 'live', source: string): ContractInput {
  const base = parseContractText('').contract; // the evaluator's own defaults (contract size, quantity)
  const tag = <T>(value: T | null, label: string, asOf: string | null): Evidence<T> => {
    if (value === null) return missing<T>(`${label} not supplied by the provider.`);
    return kind === 'live' ? (asOf !== null ? verified(value, `${source}: ${label}`, asOf) : { kind: 'verified_market_data', value, source: `${source}: ${label}`, asOf: null }) : testData(value, `${source}: ${label}`, asOf);
  };
  const model = <T>(value: T | null, label: string): Evidence<T> => (value === null
    ? missing<T>(`${label} not supplied by the provider.`)
    : kind === 'live' ? thirdParty(value, `${source} (provider-reported ${label})`, c.quoteTime) : testData(value, `${source} (provider-reported ${label})`, c.quoteTime));
  return {
    ...base,
    underlying: tag(c.underlying, 'underlying', c.quoteTime),
    optionType: tag(c.type, 'contract type', null),
    exerciseStyle: c.exerciseStyle !== null ? tag(c.exerciseStyle, 'exercise style', null) : base.exerciseStyle,
    stockPrice: tag(c.underlyingPrice, 'underlying price', c.quoteTime),
    strike: tag(c.strike, 'strike', null),
    expiration: tag(c.expiration, 'expiration', null),
    premium: missing('No premium is assumed; the ask is the price you would likely pay.'),
    bid: tag(c.bid, 'bid', c.quoteTime),
    ask: tag(c.ask, 'ask', c.quoteTime),
    last: tag(c.last, 'last trade', c.lastTime),
    volume: tag(c.volume, 'volume (latest session)', c.quoteTime),
    openInterest: tag(c.openInterest, 'open interest', c.quoteTime),
    quoteTime: tag(c.quoteTime, 'quote time', c.quoteTime),
    quotedIV: model(c.iv, 'implied volatility'),
    quotedDelta: model(c.delta, 'delta'),
    quotedGamma: model(c.gamma, 'gamma'),
    quotedTheta: model(c.theta, 'theta'),
    quotedVega: model(c.vega, 'vega'),
  };
}

const VERDICT_ORDER: Record<Verdict, number> = { RELATIVELY_STRONG: 0, MIXED: 1, WEAK: 2, TOO_RISKY: 3, INSUFFICIENT_DATA: 4 };

/** Rule-based order (not a profit forecast): verdict, then normal data reliability, tighter spread, higher OI, ticker. */
const byRule = (x: RankedCandidate, y: RankedCandidate) =>
  (VERDICT_ORDER[x.verdict] - VERDICT_ORDER[y.verdict])
  || ((x.dataReliability.level === 'normal' ? 0 : 1) - (y.dataReliability.level === 'normal' ? 0 : 1))
  || ((x.contract.spreadOfMid ?? 1) - (y.contract.spreadOfMid ?? 1))
  || ((y.contract.openInterest ?? -1) - (x.contract.openInterest ?? -1))
  || (x.contract.ticker < y.contract.ticker ? -1 : x.contract.ticker > y.contract.ticker ? 1 : 0);

export function runOptionScan(data: OptionScanDataset, now: Date, rules = OPTION_SCAN_RULES): OptionScanResult {
  const exclusions = new Map<OptionExclusionCode, { count: number; examples: string[]; details: string[] }>();
  const exclude = (label: string, code: OptionExclusionCode, detail: string) => {
    const e = exclusions.get(code) ?? { count: 0, examples: [], details: [] };
    e.count++;
    if (e.examples.length < 3) {
      e.examples.push(label);
      e.details.push(detail);
    }
    exclusions.set(code, e);
  };
  const failed: string[] = [];
  const notRequested: string[] = [];
  const truncated: string[] = [];
  const empty: string[] = [];
  let retrieved = 0;
  const eligibleCalls: OptionContract[] = [];
  const putsNotEvaluated: string[] = [];
  for (const chain of data.chains) {
    if (chain.status === 'request_failed') { failed.push(chain.underlying); continue; }
    if (chain.status === 'not_requested') { notRequested.push(chain.underlying); continue; }
    let parsed: ReturnType<typeof parseOptionChain>;
    try {
      parsed = parseOptionChain(chain.response, chain.underlying);
    } catch {
      failed.push(chain.underlying);
      continue;
    }
    if (parsed.truncated) truncated.push(chain.underlying);
    if (parsed.contracts.length === 0) empty.push(chain.underlying);
    for (const raw of parsed.contracts) {
      retrieved++;
      const { contract, reasons } = validateContract(raw, now, rules);
      const label = contract?.ticker ?? (typeof raw.ticker === 'string' ? raw.ticker : `(unlabeled ${chain.underlying} contract)`);
      if (reasons.length > 0 || contract === null) { exclude(label, reasons[0]!.code, reasons[0]!.detail); continue; }
      if (contract.type === 'put') putsNotEvaluated.push(contract.ticker);
      else eligibleCalls.push(contract);
    }
  }

  const context = parseContractText('').context; // nothing pasted: the evaluator lists what is missing
  const evaluated: RankedCandidate[] = eligibleCalls.map((c) => {
    const ev = evaluateCall(toEvaluatorInput(c, data.dataset.kind, data.dataset.source), context, { now });
    return { rank: 0, contract: c, verdict: ev.verdict, verdictSummary: ev.verdictSummary, reasons: ev.verdictReasons, dataReliability: ev.dataReliability, valuation: ev.valuation };
  });
  const sufficient = evaluated.filter((e) => e.verdict !== 'INSUFFICIENT_DATA').sort(byRule);
  sufficient.forEach((e, i) => { e.rank = i + 1; });
  const insufficient = evaluated.filter((e) => e.verdict === 'INSUFFICIENT_DATA');
  const excludedCount = [...exclusions.values()].reduce((a, e) => a + e.count, 0);
  return {
    dataset: data.dataset,
    evaluatedAt: now.toISOString(),
    underlyings: { scanned: data.chains.length - failed.length - notRequested.length, failed, notRequested, truncated, ...(empty.length > 0 ? { empty } : {}) },
    counts: {
      retrieved, excluded: excludedCount, eligible: eligibleCalls.length + putsNotEvaluated.length, evaluated: evaluated.length,
      ranked: sufficient.length, insufficient: insufficient.length, putsNotEvaluated: putsNotEvaluated.length,
    },
    ranked: sufficient.slice(0, rules.maxRanked),
    moreRanked: Math.max(0, sufficient.length - rules.maxRanked),
    insufficient: insufficient.map((e) => ({ ticker: e.contract.ticker, reasons: e.reasons })),
    putsNotEvaluated,
    exclusions: [...exclusions].map(([code, e]) => ({ code, ...e })).sort((x, y) => y.count - x.count || (x.code < y.code ? -1 : 1)),
  };
}
