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
import { type HttpClient, HttpError } from './http.ts';

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
      if (err instanceof HttpError && (err.kind === 'rate_limited' || err.kind === 'budget')) stopReason = err.kind === 'rate_limited' ? 'the provider rate-limited the run' : `the per-run limit of ${o.maxCalls} requests was reached`;
      failed.push(symbol);
      stocks.push({ symbol, historyStatus: 'request_failed' });
    }
  }
  const notes = [`${o.universe.length} tickers in the fixed initial universe; ${o.client.callsMade} of ${o.maxCalls} allowed requests used.`];
  if (failed.length > 0) notes.push(`Daily-bars request failed for ${failed.length} ticker(s) (${list(failed)}); they were not evaluated.`);
  if (notRequested.length > 0) notes.push(`Daily bars not requested for ${notRequested.length} ticker(s) (${list(notRequested)}) because ${stopReason}; they were not evaluated.`);
  if (dropped > 0) notes.push(`${dropped} bar(s) from the current, still-open session were not used.`);
  notes.push('Bars are end-of-day and split-adjusted; volume is shares traded per session as reported by the provider.');
  return {
    dataset: { kind: 'live' as const, label: 'Massive end-of-day snapshot', source: MASSIVE_SOURCE, asOf: now.toISOString(), attribution: MASSIVE_ATTRIBUTION, notes },
    stocks,
  };
}
