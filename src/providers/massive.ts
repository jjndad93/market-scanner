/**
 * Massive (formerly Polygon.io) Stocks API adapter, free "Stocks Basic" plan (official docs,
 * checked 2026-10-21): 5 API calls/minute, end-of-day data, 2 years of history, all US stock
 * tickers, individual non-professional use. Auth: "Authorization: Bearer <key>" (the key never
 * goes in a URL). Base URL https://api.massive.com.
 *
 * One request per ticker: GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}?adjusted=true
 * returns split-adjusted daily bars; `t` is "the Unix millisecond timestamp for the start of
 * the aggregate window", so a bar's session date is the New York date of `t`. A bar for the
 * current New York date is dropped until 20:00 ET (the end of extended hours), so an
 * incomplete session is never used.
 */

import { terminalSafe } from '../core/format.ts';
import { addDaysIso, nyDateString, nyWallTimeToUtc } from '../core/time.ts';
import type { RawBar, RawStock } from '../stocks/types.ts';
import { MASSIVE_STOCKS_INFO, authStopReason, nextStepFor } from '../core/errors.ts';
import { type HttpClient, HttpError } from './http.ts';

/** What went wrong with one request, without the key (the HTTP client redacts it). */
const describeFailure = (e: HttpError | MassiveResponseError) =>
  (e instanceof HttpError ? e.message : `the response could not be used (${e.message})`).replace(/\.?$/, '.');

export const MASSIVE_BASE_URL = 'https://api.massive.com';
/** The variable name already reserved in .env.example (the provider was renamed from Polygon.io). */
export const MASSIVE_KEY_ENV = 'POLYGON_API_KEY';
export const MASSIVE_KEY_HEADER = 'authorization';
export const MASSIVE_SOURCE = 'Massive Stocks API (formerly Polygon.io), daily bars /v2/aggs/ticker/{ticker}/range/1/day (split-adjusted, end of day)';
export const MASSIVE_ATTRIBUTION = 'Market data provided by Massive (https://massive.com), formerly Polygon.io';
/** 12.5 s apart = 4.8 calls/minute, under the free plan's 5 calls/minute. */
export const MASSIVE_MIN_INTERVAL_MS = 12_500;
/** Calendar days of bars requested: enough for 21+ sessions across holidays. */
export const MASSIVE_HISTORY_CALENDAR_DAYS = 45;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class MassiveResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MassiveResponseError';
  }
}

/**
 * Daily-bars response -> RawBar[] (values passed through for the normalizer to validate).
 * A missing `results` array with status OK means no bars (e.g. an unknown ticker).
 */
export function parseDailyBars(json: unknown, now: Date): { bars: RawBar[]; droppedCurrentSession: number } {
  if (!isRecord(json) || (json.results !== undefined && !Array.isArray(json.results))) throw new MassiveResponseError('daily-bars response is not an object with a results array.');
  const today = nyDateString(now);
  const sessionComplete = now.getTime() >= nyWallTimeToUtc(today, 20, 0).getTime();
  const bars: RawBar[] = [];
  let droppedCurrentSession = 0;
  for (const r of (json.results as unknown[] | undefined) ?? []) {
    const t = isRecord(r) && typeof r.t === 'number' && Number.isFinite(r.t) ? r.t : null;
    const date = t !== null ? nyDateString(new Date(t)) : null;
    if (date === today && !sessionComplete) {
      droppedCurrentSession++;
      continue;
    }
    bars.push({ date, close: isRecord(r) ? r.c : undefined, volume: isRecord(r) ? r.v : undefined });
  }
  return { bars, droppedCurrentSession };
}

export interface StockFetchOptions {
  client: HttpClient;
  clock: () => Date;
  universe: readonly string[];
  maxCalls: number;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How the universe was chosen, for the notes (default: the fixed initial universe). */
  universeLabel?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const list = (s: string[]) => (s.length <= 8 ? s : [...s.slice(0, 8), `and ${s.length - 8} more`]).map(terminalSafe).join(', ');

/** Fetches daily bars for each ticker, within the request limit; failures are reported, never filled in. */
export async function fetchStockDataset(o: StockFetchOptions) {
  const now = o.clock();
  const sleep = o.sleep ?? realSleep;
  const to = nyDateString(now);
  const from = addDaysIso(to, -MASSIVE_HISTORY_CALENDAR_DAYS);
  const stocks: RawStock[] = [];
  const failed: string[] = [];
  const notRequested: string[] = [];
  let dropped = 0;
  let stopReason: string | null = null;
  /** The first failed request, for an actionable note (messages never contain the key). */
  let firstFailure: HttpError | MassiveResponseError | null = null;
  let first = true;
  for (const symbol of o.universe) {
    if (stopReason !== null || o.client.callsMade >= o.maxCalls) {
      stopReason ??= `the per-run limit of ${o.maxCalls} requests was reached`;
      notRequested.push(symbol);
      stocks.push({ symbol, historyStatus: 'not_requested' });
      continue;
    }
    if (!first) await sleep(o.minIntervalMs ?? MASSIVE_MIN_INTERVAL_MS);
    first = false;
    try {
      const json = await o.client.getJson(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: '120' });
      const { bars, droppedCurrentSession } = parseDailyBars(json, now);
      dropped += droppedCurrentSession;
      stocks.push({ symbol, bars });
    } catch (err) {
      if (err instanceof HttpError && err.kind === 'budget' && !err.requestSent) {
        stopReason = `the per-run limit of ${o.maxCalls} requests was reached`;
        notRequested.push(symbol);
        stocks.push({ symbol, historyStatus: 'not_requested' });
        continue;
      }
      if (!(err instanceof HttpError) && !(err instanceof MassiveResponseError)) throw err;
      firstFailure ??= err;
      // Stage 9: a rejected key (401) or refused access (403) would repeat for every ticker; stop now.
      const authStop = authStopReason(err, MASSIVE_STOCKS_INFO);
      if (authStop !== null) stopReason = authStop;
      else if (err instanceof HttpError && (err.kind === 'rate_limited' || err.kind === 'budget')) stopReason = err.kind === 'rate_limited' ? 'the provider rate-limited the run' : `the per-run limit of ${o.maxCalls} requests was reached`;
      failed.push(symbol);
      stocks.push({ symbol, historyStatus: 'request_failed' });
    }
  }
  const notes = [`${o.universe.length} tickers in ${o.universeLabel ?? 'the fixed initial universe'}; ${o.client.callsMade} of ${o.maxCalls} allowed requests used.`];
  if (failed.length > 0) notes.push(`Daily-bars request failed for ${failed.length} ticker(s) (${list(failed)}); they were not evaluated.`);
  if (firstFailure !== null) notes.push(`First failure: ${describeFailure(firstFailure)} Next step: ${nextStepFor(firstFailure, MASSIVE_STOCKS_INFO)}`);
  if (notRequested.length > 0) notes.push(`Daily bars not requested for ${notRequested.length} ticker(s) (${list(notRequested)}) because ${stopReason}; they were not evaluated.`);
  if (dropped > 0) notes.push(`${dropped} bar(s) from the current, still-open session were not used.`);
  notes.push('Bars are end-of-day and split-adjusted; volume is shares traded per session as reported by the provider.');
  return {
    dataset: { kind: 'live' as const, label: 'Massive end-of-day snapshot', source: MASSIVE_SOURCE, asOf: now.toISOString(), attribution: MASSIVE_ATTRIBUTION, notes },
    stocks,
    /** Additive (Stage 8): the first failure's explanation, or null. */
    firstFailure: firstFailure === null ? null : `${describeFailure(firstFailure)} ${nextStepFor(firstFailure, MASSIVE_STOCKS_INFO)}`,
  };
}

// ---- market-wide movers (Daily Market Summary) -------------------------------------------------
// GET /v2/aggs/grouped/locale/us/market/stocks/{date} returns one end-of-day bar for EVERY US stock
// in one request ("Included in all Stocks plans", official docs checked 2026-10-24). On the free
// Basic plan a session is available after midnight ET, so the scan starts from yesterday (New York).
// Two sessions give each stock's 1-day change; the biggest gainers that pass the price and dollar-
// volume limits become this run's universe and get the usual per-ticker history and scoring.

export const MARKET_MOVERS = {
  minPrice: 5, // USD: the scanner's own minimum price
  maxPrice: 50, // USD
  minDollarVolume: 20_000_000, // USD traded in the latest session (the scanner's liquidity floor)
  count: 15, // gainers passed on for full evaluation
  lookbackDays: 8, // calendar days searched for two trading sessions (weekends and holidays)
};
export const MOVERS_SOURCE = 'Massive Daily Market Summary /v2/aggs/grouped/locale/us/market/stocks/{date} (all US stocks, end of day)';
/** Plain US tickers only (no warrants, units, rights or preferred classes with suffixes). */
const PLAIN_TICKER = /^[A-Z]{1,5}$/;

export function parseGroupedDaily(json: unknown): Map<string, { close: number; volume: number }> {
  if (!isRecord(json) || (json.results !== undefined && !Array.isArray(json.results))) throw new MassiveResponseError('market-summary response is not an object with a results array.');
  const out = new Map<string, { close: number; volume: number }>();
  for (const r of (json.results as unknown[] | undefined) ?? []) {
    if (!isRecord(r) || typeof r.T !== 'string' || r.otc === true) continue;
    const close = r.c, volume = r.v;
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0 || typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) continue;
    out.set(r.T, { close, volume });
  }
  return out;
}

export interface MoversResult { tickers: string[]; sessions: string[]; notes: string[]; requestsUsed: number }

/** Finds the latest two sessions and returns the biggest 1-day gainers within the limits. Never invents data. */
export async function fetchMarketMovers(o: { client: HttpClient; clock: () => Date; maxCalls: number; minIntervalMs?: number; sleep?: (ms: number) => Promise<void>; limits?: Partial<typeof MARKET_MOVERS> }): Promise<MoversResult> {
  const L = { ...MARKET_MOVERS, ...o.limits };
  const sleep = o.sleep ?? realSleep;
  const start = o.client.callsMade;
  const sessions: { date: string; bars: Map<string, { close: number; volume: number }> }[] = [];
  let date = addDaysIso(nyDateString(o.clock()), -1);
  for (let i = 0; i < L.lookbackDays && sessions.length < 2; i++, date = addDaysIso(date, -1)) {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekend: no session, no request
    if (o.client.callsMade >= o.maxCalls) break;
    if (o.client.callsMade > start) await sleep(o.minIntervalMs ?? MASSIVE_MIN_INTERVAL_MS);
    const bars = parseGroupedDaily(await o.client.getJson(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, { adjusted: 'true' }));
    if (bars.size > 0) sessions.push({ date, bars }); // an empty day is a market holiday
  }
  const requestsUsed = o.client.callsMade - start;
  if (sessions.length < 2) {
    return { tickers: [], sessions: sessions.map((x) => x.date), requestsUsed, notes: [`Market-wide movers: two recent trading sessions were not found within ${requestsUsed} request(s), so the fixed list was used instead.`] };
  }
  const [latest, prev] = sessions as [typeof sessions[0], typeof sessions[0]];
  const ranked: { t: string; chg: number }[] = [];
  let inRange = 0;
  for (const [t, b] of latest.bars) {
    if (!PLAIN_TICKER.test(t)) continue;
    const p = prev.bars.get(t);
    if (!p || b.close < L.minPrice || b.close > L.maxPrice || b.close * b.volume < L.minDollarVolume) continue;
    inRange++;
    ranked.push({ t, chg: (b.close / p.close - 1) * 100 });
  }
  ranked.sort((a, b) => b.chg - a.chg);
  const top = ranked.filter((r) => r.chg > 0).slice(0, L.count);
  return {
    tickers: top.map((r) => r.t),
    sessions: [latest.date, prev.date],
    requestsUsed,
    notes: [
      `Market-wide movers: ${latest.bars.size.toLocaleString('en-US')} US stocks on ${latest.date} (vs ${prev.date}); ${inRange.toLocaleString('en-US')} were priced $${L.minPrice}-$${L.maxPrice} with at least $${(L.minDollarVolume / 1e6).toFixed(0)}M traded; the ${top.length} biggest gainers were evaluated (${requestsUsed} request(s) for the market summary).`,
      'Gainers are picked by the previous session\'s close-to-close change only; the evaluation below adds the 20-session volume baseline and the usual scoring.',
    ],
  };
}
