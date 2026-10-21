/**
 * Massive (formerly Polygon.io) options-chain adapter for `scan options --live` (Stage 6).
 *
 * Endpoint (official docs, checked 2026-10-21): GET /v3/snapshot/options/{underlyingAsset}
 * with expiration_date.gte/.lte and limit (max 250). Per contract it returns `details`
 * (contract_type, exercise_style, expiration_date, strike_price, ticker), `last_quote` (bid, ask,
 * last_updated), `last_trade` (price, sip_timestamp), `day` (volume), `open_interest`,
 * `implied_volatility`, `greeks` and `underlying_asset` (price, ticker). Timestamps are
 * nanoseconds since the epoch.
 *
 * PLAN LIMITATION: the snapshot is "Included in select Options plans" (Options Starter and up).
 * The free Options Basic plan excludes Snapshot, quotes (bid/ask), Greeks/IV and open interest.
 * On a plan without access the request fails (HTTP 401/403) and the run stops; nothing is filled
 * in. Whether a Starter/Developer snapshot carries a delayed bid/ask is not verified here.
 *
 * Values are passed through unchanged; validation happens in the scan. Missing stays missing.
 */

import { terminalSafe } from '../core/format.ts';
import { addDaysIso, nyDateString } from '../core/time.ts';
import { type HttpClient, HttpError } from './http.ts';

export const MASSIVE_OPTIONS_SOURCE = 'Massive options chain snapshot /v3/snapshot/options/{underlying} (formerly Polygon.io)';
export const MASSIVE_OPTIONS_ATTRIBUTION = 'Options data provided by Massive (https://massive.com), formerly Polygon.io';
/** Contracts per request (the endpoint's maximum). There is no pagination yet. */
export const OPTION_CHAIN_LIMIT = 250;
/** Expirations requested: from this many days ahead ... */
export const OPTION_MIN_DAYS_AHEAD = 7;
/** ... to this many days ahead. */
export const OPTION_MAX_DAYS_AHEAD = 60;
/** Spacing between requests; paid options plans have no per-minute cap, so this is courtesy only. */
export const OPTION_MIN_INTERVAL_MS = 1_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One contract as returned by the provider; every field may be missing or malformed. */
export interface RawOptionContract {
  ticker: unknown;
  underlying: unknown;
  underlyingPrice: unknown;
  type: unknown;
  exerciseStyle: unknown;
  strike: unknown;
  expiration: unknown;
  bid: unknown;
  ask: unknown;
  /** Quote time, ms since epoch (converted from nanoseconds), or null. */
  quoteTimeMs: number | null;
  last: unknown;
  lastTimeMs: number | null;
  volume: unknown;
  openInterest: unknown;
  iv: unknown;
  delta: unknown;
  gamma: unknown;
  theta: unknown;
  vega: unknown;
}

/** Nanosecond provider timestamps -> ms; anything that is not a positive finite number -> null. */
export function nanosToMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v / 1e6) : null;
}

export class OptionChainResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionChainResponseError';
  }
}

/** Snapshot response -> raw contracts (unchanged values). `truncated` when more pages exist. */
export function parseOptionChain(json: unknown, requestedUnderlying: string): { contracts: RawOptionContract[]; truncated: boolean } {
  if (!isRecord(json) || (json.results !== undefined && !Array.isArray(json.results))) {
    throw new OptionChainResponseError('option-chain response is not an object with a results array.');
  }
  const contracts = ((json.results as unknown[] | undefined) ?? []).map((r): RawOptionContract => {
    const o = isRecord(r) ? r : {};
    const d = isRecord(o.details) ? o.details : {};
    const q = isRecord(o.last_quote) ? o.last_quote : {};
    const t = isRecord(o.last_trade) ? o.last_trade : {};
    const day = isRecord(o.day) ? o.day : {};
    const g = isRecord(o.greeks) ? o.greeks : {};
    const u = isRecord(o.underlying_asset) ? o.underlying_asset : {};
    return {
      ticker: d.ticker, underlying: u.ticker ?? requestedUnderlying, underlyingPrice: u.price,
      type: d.contract_type, exerciseStyle: d.exercise_style, strike: d.strike_price, expiration: d.expiration_date,
      bid: q.bid, ask: q.ask, quoteTimeMs: nanosToMs(q.last_updated),
      last: t.price, lastTimeMs: nanosToMs(t.sip_timestamp),
      volume: day.volume, openInterest: o.open_interest, iv: o.implied_volatility,
      delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega,
    };
  });
  return { contracts, truncated: typeof json.next_url === 'string' && json.next_url !== '' };
}

export interface OptionChainFetchOptions {
  client: HttpClient;
  clock: () => Date;
  underlyings: readonly string[];
  maxCalls: number;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const list = (s: string[]) => (s.length <= 8 ? s : [...s.slice(0, 8), `and ${s.length - 8} more`]).map(terminalSafe).join(', ');

/**
 * One chain request per underlying, within the request limit (retries included, enforced by the
 * client). An authorization failure (401/403) or a rate limit stops the run: every later request
 * would fail the same way.
 */
export async function fetchOptionChains(o: OptionChainFetchOptions) {
  const now = o.clock();
  const today = nyDateString(now);
  const params = {
    'expiration_date.gte': addDaysIso(today, OPTION_MIN_DAYS_AHEAD), 'expiration_date.lte': addDaysIso(today, OPTION_MAX_DAYS_AHEAD), limit: String(OPTION_CHAIN_LIMIT),
  };
  const chains: { underlying: string; response?: unknown; status?: 'request_failed' | 'not_requested' }[] = [];
  const failed: string[] = [];
  const notRequested: string[] = [];
  let stopReason: string | null = null;
  let first = true;
  for (const underlying of o.underlyings) {
    if (stopReason !== null || o.client.callsMade >= o.maxCalls) {
      stopReason ??= `the per-run limit of ${o.maxCalls} requests was reached`;
      notRequested.push(underlying);
      chains.push({ underlying, status: 'not_requested' });
      continue;
    }
    if (!first) await sleep(o.minIntervalMs ?? OPTION_MIN_INTERVAL_MS, o.sleep);
    first = false;
    try {
      chains.push({ underlying, response: await o.client.getJson(`/v3/snapshot/options/${encodeURIComponent(underlying)}`, params) });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.kind === 'budget' && !err.requestSent) {
        stopReason = `the per-run limit of ${o.maxCalls} requests was reached`;
        notRequested.push(underlying);
        chains.push({ underlying, status: 'not_requested' });
        continue;
      }
      failed.push(underlying);
      chains.push({ underlying, status: 'request_failed' });
      if (err.status === 401 || err.status === 403) {
        stopReason = `the provider refused access (HTTP ${err.status}): the option-chain snapshot needs a Massive options plan that includes Snapshot (Options Starter or higher; the free Options Basic plan excludes it)`;
      } else if (err.kind === 'rate_limited' || err.kind === 'budget') {
        stopReason = err.kind === 'rate_limited' ? 'the provider rate-limited the run' : `the per-run limit of ${o.maxCalls} requests was reached`;
      }
    }
  }
  const notes = [`${o.underlyings.length} underlying(s) requested; ${o.client.callsMade} of ${o.maxCalls} allowed requests used.`];
  if (failed.length > 0) notes.push(`Option-chain request failed for ${failed.length} underlying(s) (${list(failed)})${stopReason?.startsWith('the provider refused') ? `: ${stopReason}` : ''}.`);
  if (notRequested.length > 0) notes.push(`Option chains not requested for ${notRequested.length} underlying(s) (${list(notRequested)}) because ${stopReason}.`);
  return {
    dataset: { kind: 'live' as const, label: 'Massive option-chain snapshot', source: MASSIVE_OPTIONS_SOURCE, asOf: now.toISOString(), attribution: MASSIVE_OPTIONS_ATTRIBUTION, notes },
    chains,
  };
}

const sleep = (ms: number, s?: (ms: number) => Promise<void>) => (s ?? realSleep)(ms);
