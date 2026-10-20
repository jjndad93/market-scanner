/**
 * CoinGecko Demo API adapter (P2). Converts provider responses into the scanner's RawAsset
 * input. It never invents values: malformed fields are passed through unchanged so the
 * normalizer reports them as invalid, and missing history stays missing.
 *
 * Endpoints (official Demo docs, checked 2026-10-20):
 *   GET /coins/markets            current price, market cap, total_volume, % changes, last_updated
 *   GET /coins/{id}/market_chart  total_volumes as [UNIX ms, value] ("24hrs volume")
 * Auth: header "x-cg-demo-api-key". Attribution is required.
 *
 * History request: the docs document 00:00 UTC alignment only for auto-granularity ("Auto-
 * granularity when `interval` is not specified ... Above 90 days | daily (00:00 UTC)"); they
 * say nothing about alignment for an explicit interval=daily. So history is requested with
 * days > 90 and no interval parameter (checked 2026-10-20). The scanner still uses only the
 * most recent 30 days.
 *
 * UNRESOLVED (to verify in the approved S7 live check): whether a daily point is a rolling 24h
 * volume at that timestamp or a calendar-day total (and which day a 00:00 point belongs to),
 * and whether the series ends with an extra intraday point. The docs do not say. The parser
 * therefore keeps only points exactly at 00:00 UTC before the start of the current UTC day,
 * and reports the rest.
 */

import { DAY_MS } from '../core/time.ts';
import { computeMetrics, exclusionReasons } from '../scanner/analyze.ts';
import { normalizeDataset } from '../scanner/normalize.ts';
import { SCAN_RULES, type ScanRules } from '../scanner/rules.ts';
import type { RawAsset } from '../scanner/types.ts';
import { type HttpClient, HttpError } from './http.ts';

export const COINGECKO_DEMO_BASE_URL = 'https://api.coingecko.com/api/v3';
export const COINGECKO_KEY_HEADER = 'x-cg-demo-api-key';
export const COINGECKO_KEY_ENV = 'COINGECKO_DEMO_API_KEY';
export const COINGECKO_SOURCE = 'CoinGecko Demo API (/coins/markets, /coins/{id}/market_chart)';
export const COINGECKO_ATTRIBUTION = 'Data provided by CoinGecko (https://www.coingecko.com)';
/** Per-run request cap (markets + history, retries included). */
export const DEFAULT_MAX_CALLS = 160;
/** Spacing between requests: about 85/min, under the Demo plan's 100 calls/min. */
export const DEFAULT_MIN_INTERVAL_MS = 700;
/**
 * Days of history requested. Must be above 90 so that auto-granularity returns documented
 * daily (00:00 UTC) points, and within the Demo plan's 365-day history limit.
 */
export const HISTORY_REQUEST_DAYS = 91;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

/**
 * /coins/markets -> RawAsset[]. Fields are mapped one-to-one and passed through unchanged;
 * the normalizer decides what is valid. Non-object entries are passed through so they are
 * counted as invalid records rather than silently dropped.
 */
export function parseMarkets(json: unknown): RawAsset[] {
  if (!Array.isArray(json)) throw new ProviderResponseError('/coins/markets did not return an array.');
  return json.map((item: unknown) => {
    if (!isRecord(item)) return item as RawAsset;
    return {
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      price: item.current_price,
      change24hPct: item.price_change_percentage_24h,
      change7dPct: item.price_change_percentage_7d_in_currency,
      volume24h: item.total_volume,
      marketCap: item.market_cap,
      lastUpdated: item.last_updated,
      dailyVolumes: null,
      tags: [],
    } as RawAsset;
  });
}

export interface DailyVolumeStats {
  points: number;
  /** Points that were not a [finite timestamp, value] pair. */
  malformed: number;
  /** Points not exactly at 00:00 UTC (e.g. a trailing "now" point). */
  notAtMidnight: number;
  /** Points at or after the start of the current UTC day (that day is incomplete). */
  currentDay: number;
  /** Same timestamp repeated with the same value (collapsed). */
  duplicates: number;
  /** Same timestamp repeated with different values (kept as one invalid entry). */
  conflicts: number;
  /** Missing days inside the series (kept as invalid entries, so they count as unusable). */
  gaps: number;
  /** Missing days after the last point, up to and including yesterday (also kept as invalid). */
  missingRecent: number;
}

/**
 * /coins/{id}/market_chart -> oldest-first daily volumes for completed UTC days. Values are
 * passed through unchanged (the normalizer validates them). Missing days and conflicting
 * duplicates become null entries, which the scanner counts as unusable history.
 */
export function parseDailyVolumes(json: unknown, now: Date): { volumes: unknown[]; stats: DailyVolumeStats } {
  if (!isRecord(json) || !Array.isArray(json.total_volumes)) {
    throw new ProviderResponseError('/market_chart response has no total_volumes array.');
  }
  const startOfToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const stats: DailyVolumeStats = { points: json.total_volumes.length, malformed: 0, notAtMidnight: 0, currentDay: 0, duplicates: 0, conflicts: 0, gaps: 0, missingRecent: 0 };
  const byDay = new Map<number, { value: unknown; conflict: boolean }>();
  for (const point of json.total_volumes) {
    if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || !Number.isFinite(point[0])) {
      stats.malformed++;
      continue;
    }
    const [ts, value] = point as [number, unknown];
    if (ts >= startOfToday) {
      stats.currentDay++;
      continue;
    }
    if (ts % DAY_MS !== 0) {
      stats.notAtMidnight++;
      continue;
    }
    const seen = byDay.get(ts);
    if (seen === undefined) {
      byDay.set(ts, { value, conflict: false });
    } else if (Object.is(seen.value, value)) {
      stats.duplicates++;
    } else {
      stats.conflicts++;
      seen.conflict = true;
    }
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const volumes: unknown[] = [];
  for (let i = 0; i < days.length; i++) {
    if (i > 0) {
      const missingDays = Math.round((days[i]! - days[i - 1]!) / DAY_MS) - 1;
      for (let g = 0; g < missingDays; g++) volumes.push(null);
      stats.gaps += missingDays;
    }
    const entry = byDay.get(days[i]!)!;
    volumes.push(entry.conflict ? null : entry.value);
  }
  // The series should run up to yesterday (00:00 UTC). Days missing at the end are recorded as
  // unusable entries; otherwise a history that stopped weeks ago would look like a current one.
  if (days.length > 0) {
    const yesterday = startOfToday - DAY_MS;
    stats.missingRecent = Math.max(0, Math.round((yesterday - days[days.length - 1]!) / DAY_MS));
    for (let g = 0; g < stats.missingRecent; g++) volumes.push(null);
  }
  return { volumes, stats };
}

export interface LiveFetchOptions {
  client: HttpClient;
  /** Current time; injected for tests. */
  clock: () => Date;
  rules?: ScanRules;
  /** Requests (including the markets call) this run may make; the client enforces it too. */
  maxCalls?: number;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A live dataset ready for normalizeDataset, plus counts for the caller. */
export interface LiveDataset {
  dataset: { kind: 'live'; label: string; source: string; asOf: string; attribution: string; notes: string[] };
  assets: RawAsset[];
}

const idList = (ids: string[]) => (ids.length <= 8 ? ids.join(', ') : `${ids.slice(0, 8).join(', ')} and ${ids.length - 8} more`);
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches the current market snapshot, then daily-volume history only for assets that pass
 * every filter not based on history (to save requests). The markets call must succeed;
 * history failures leave that asset without history (so it is excluded, with a note).
 */
export async function fetchLiveDataset(options: LiveFetchOptions): Promise<LiveDataset> {
  const { client, clock } = options;
  const rules = options.rules ?? SCAN_RULES;
  const maxCalls = Math.min(options.maxCalls ?? DEFAULT_MAX_CALLS, client.maxCalls);
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;

  const markets = await client.getJson('/coins/markets', {
    vs_currency: 'usd', order: 'market_cap_desc', per_page: '250', page: '1', price_change_percentage: '24h,7d', sparkline: 'false',
  });
  const assets = parseMarkets(markets);
  const fetchedAt = clock();

  // Pre-filter with the scanner's own rules, ignoring the history-based reasons.
  const historyCodes = new Set(['insufficient_history', 'unreliable_history']);
  const probe = normalizeDataset({ dataset: { kind: 'live', label: 'pre-filter', source: COINGECKO_SOURCE, asOf: fetchedAt.toISOString(), attribution: COINGECKO_ATTRIBUTION }, assets }, rules);
  const eligible: string[] = [];
  for (const a of probe.assets) {
    if (eligible.includes(a.id)) continue;
    const reasons = exclusionReasons(a, computeMetrics(a, fetchedAt), rules).filter((r) => !historyCodes.has(r.code));
    if (reasons.length === 0) eligible.push(a.id);
  }
  const skippedByFilters = new Set(probe.assets.map((a) => a.id)).size - eligible.length;

  const history = new Map<string, unknown[]>();
  const failed: string[] = [];
  const notRequested: string[] = [];
  const odd = { notAtMidnight: 0, currentDay: 0, malformed: 0, conflicts: 0, gaps: 0, missingRecent: 0 };
  let stopReason: string | null = null;
  for (const id of eligible) {
    if (stopReason !== null || client.callsMade >= maxCalls) {
      stopReason ??= `the per-run limit of ${maxCalls} requests was reached`;
      notRequested.push(id);
      continue;
    }
    await sleep(minIntervalMs);
    try {
      const json = await client.getJson(`/coins/${encodeURIComponent(id)}/market_chart`, {
        // No `interval`: documented auto-granularity gives daily 00:00 UTC points above 90 days.
        vs_currency: 'usd', days: String(Math.max(HISTORY_REQUEST_DAYS, rules.historyWindowDays + 5)),
      });
      const { volumes, stats } = parseDailyVolumes(json, fetchedAt);
      history.set(id, volumes);
      for (const k of Object.keys(odd) as (keyof typeof odd)[]) odd[k] += stats[k];
    } catch (err) {
      if (err instanceof HttpError && (err.kind === 'rate_limited' || err.kind === 'budget')) {
        stopReason = err.kind === 'rate_limited' ? 'the provider rate-limited the run' : `the per-run limit of ${maxCalls} requests was reached`;
        notRequested.push(id);
      } else if (err instanceof HttpError || err instanceof ProviderResponseError) {
        failed.push(id);
      } else {
        throw err;
      }
    }
  }

  const withHistory = assets.map((a) => (isRecord(a) && typeof a.id === 'string' && history.has(a.id) ? { ...a, dailyVolumes: history.get(a.id)! } : a));
  const notes = [
    `${assets.length} assets from /coins/markets; ${client.callsMade} of ${maxCalls} allowed requests used.`,
    `Volume history fetched for ${history.size} of ${eligible.length} assets that passed the non-history filters; ${skippedByFilters} assets were already excluded by those filters and their history was not requested.`,
  ];
  if (failed.length > 0) notes.push(`History request failed for ${failed.length} asset(s) (${idList(failed)}); they are excluded for insufficient history.`);
  if (notRequested.length > 0) notes.push(`History not requested for ${notRequested.length} asset(s) (${idList(notRequested)}) because ${stopReason}; they are excluded for insufficient history.`);
  const dropped = odd.notAtMidnight + odd.currentDay + odd.malformed;
  if (dropped > 0 || odd.conflicts > 0 || odd.gaps > 0 || odd.missingRecent > 0) {
    notes.push(`History points not used: ${odd.currentDay} from the current (incomplete) UTC day, ${odd.notAtMidnight} not at 00:00 UTC, ${odd.malformed} malformed; ${odd.conflicts} conflicting duplicates, ${odd.gaps} missing days and ${odd.missingRecent} missing recent days counted as unusable.`);
  }
  notes.push('The exact meaning of a daily history volume point (rolling 24h vs calendar day) is not yet verified against live data.');

  return {
    dataset: { kind: 'live', label: 'CoinGecko live snapshot', source: COINGECKO_SOURCE, asOf: fetchedAt.toISOString(), attribution: COINGECKO_ATTRIBUTION, notes },
    assets: withHistory,
  };
}
