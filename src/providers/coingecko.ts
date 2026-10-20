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

import { terminalSafe } from '../core/format.ts';
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

/**
 * Classification of one history point relative to the start of the current UTC day:
 * - prior-midnight        exactly 00:00 UTC on an earlier day (the only kind that is used)
 * - prior-intraday        an earlier day, not at 00:00 UTC (not used)
 * - today-midnight        exactly 00:00 UTC today (not used: its meaning is unverified)
 * - today-after-midnight  later than 00:00 UTC today but before tomorrow, e.g. a "now" point (not used)
 * - future                at or after 00:00 UTC tomorrow (not used)
 * - invalid               not a [timestamp, value] pair with a finite, representable timestamp
 */
export type PointClass = 'prior-midnight' | 'prior-intraday' | 'today-midnight' | 'today-after-midnight' | 'future' | 'invalid';

// Shared output-boundary escaping; re-exported for existing importers of this module.
export { terminalSafe };

const MAX_DATE_MS = 8.64e15; // largest timestamp a JavaScript Date can represent

export function classifyPoint(point: unknown, startOfToday: number): { ts: number | null; cls: PointClass } {
  if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || !Number.isFinite(point[0]) || Math.abs(point[0]) > MAX_DATE_MS) {
    return { ts: null, cls: 'invalid' };
  }
  const ts = point[0];
  if (ts >= startOfToday + DAY_MS) return { ts, cls: 'future' };
  if (ts > startOfToday) return { ts, cls: 'today-after-midnight' };
  if (ts === startOfToday) return { ts, cls: 'today-midnight' };
  return { ts, cls: ts % DAY_MS === 0 ? 'prior-midnight' : 'prior-intraday' };
}

export interface DailyVolumeStats {
  points: number;
  /** Points that were not a [finite timestamp, value] pair. */
  invalid: number;
  /** Points at 00:00 UTC on earlier days (before duplicate handling). */
  priorMidnight: number;
  /** Points on earlier days not at 00:00 UTC. */
  priorIntraday: number;
  /** A point exactly at 00:00 UTC today. */
  todayMidnight: number;
  /** Points later than 00:00 UTC today (the current UTC day is incomplete). */
  todayAfterMidnight: number;
  /** Points at or after 00:00 UTC tomorrow. */
  future: number;
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
  const stats: DailyVolumeStats = {
    points: json.total_volumes.length, invalid: 0, priorMidnight: 0, priorIntraday: 0, todayMidnight: 0, todayAfterMidnight: 0, future: 0,
    duplicates: 0, conflicts: 0, gaps: 0, missingRecent: 0,
  };
  const byDay = new Map<number, { value: unknown; conflict: boolean }>();
  for (const point of json.total_volumes) {
    const { ts, cls } = classifyPoint(point, startOfToday);
    if (cls === 'invalid') stats.invalid++;
    else if (cls === 'prior-intraday') stats.priorIntraday++;
    else if (cls === 'today-midnight') stats.todayMidnight++;
    else if (cls === 'today-after-midnight') stats.todayAfterMidnight++;
    else if (cls === 'future') stats.future++;
    if (cls !== 'prior-midnight' || ts === null) continue;
    stats.priorMidnight++;
    const value = (point as unknown[])[1];
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
  /** Collect timestamp-only diagnostics for each history request that was sent. */
  diagnostics?: boolean;
}

/** A live dataset ready for normalizeDataset, plus counts for the caller. */
export interface LiveDataset {
  dataset: { kind: 'live'; label: string; source: string; asOf: string; attribution: string; notes: string[] };
  assets: RawAsset[];
  /** Present only when diagnostics were requested; not part of the scanner input. */
  diagnostics?: HistoryDiagnostic[];
}

// Ids come from the provider: escape control characters before they reach terminal output.
const idList = (ids: string[]) => {
  const safe = ids.map(terminalSafe);
  return safe.length <= 8 ? safe.join(', ') : `${safe.slice(0, 8).join(', ')} and ${safe.length - 8} more`;
};

/** Short, credential-free description of why a request failed. */
function failureOutcome(err: HttpError): string {
  switch (err.kind) {
    case 'http': return `HTTP ${err.status}`;
    case 'invalid_json': return 'response was not valid JSON';
    case 'timeout': return 'timed out';
    case 'network': return 'network error';
    case 'rate_limited': return 'rate limited (HTTP 429)';
    case 'budget': return 'HTTP 429; retry not sent: per-run request limit reached';
  }
}
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
  const odd = { invalid: 0, priorIntraday: 0, todayMidnight: 0, todayAfterMidnight: 0, future: 0, conflicts: 0, gaps: 0, missingRecent: 0 };
  const diagnostics: HistoryDiagnostic[] | undefined = options.diagnostics ? [] : undefined;
  let stopReason: string | null = null;
  for (const id of eligible) {
    if (stopReason !== null || client.callsMade >= maxCalls) {
      stopReason ??= `the per-run limit of ${maxCalls} requests was reached`;
      notRequested.push(id);
      continue;
    }
    await sleep(minIntervalMs);
    let json: unknown;
    try {
      json = await client.getJson(`/coins/${encodeURIComponent(id)}/market_chart`, {
        // No `interval`: documented auto-granularity gives daily 00:00 UTC points above 90 days.
        vs_currency: 'usd', days: String(Math.max(HISTORY_REQUEST_DAYS, rules.historyWindowDays + 5)),
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.kind === 'budget' && !err.requestSent) {
        // Never sent, so there is nothing to diagnose.
        stopReason = `the per-run limit of ${maxCalls} requests was reached`;
        notRequested.push(id);
        continue;
      }
      // From here the request WAS sent: it is reported as attempted and failed.
      diagnostics?.push({ id, outcome: `request failed (${failureOutcome(err)})` });
      if (err.kind === 'rate_limited' || err.kind === 'budget') {
        // Stop: the provider is rate-limiting, or a 429 retry no longer fits the request limit.
        stopReason = err.kind === 'rate_limited' ? 'the provider rate-limited the run' : `the per-run limit of ${maxCalls} requests was reached`;
        failed.push(id);
      } else {
        failed.push(id);
      }
      continue;
    }
    const described = diagnostics ? describeHistory(json, fetchedAt) : null;
    try {
      const { volumes, stats } = parseDailyVolumes(json, fetchedAt);
      history.set(id, volumes);
      for (const k of Object.keys(odd) as (keyof typeof odd)[]) odd[k] += stats[k];
      diagnostics?.push({ id, outcome: 'parsed', history: described! });
    } catch (err) {
      if (!(err instanceof ProviderResponseError)) throw err;
      failed.push(id);
      diagnostics?.push({ id, outcome: 'response had no total_volumes array' });
    }
  }

  const withHistory = assets.map((a) => (isRecord(a) && typeof a.id === 'string' && history.has(a.id) ? { ...a, dailyVolumes: history.get(a.id)! } : a));
  const notes = [
    `${assets.length} assets from /coins/markets; ${client.callsMade} of ${maxCalls} allowed requests used.`,
    `Volume history fetched for ${history.size} of ${eligible.length} assets that passed the non-history filters; ${skippedByFilters} assets were already excluded by those filters and their history was not requested.`,
  ];
  if (failed.length > 0) notes.push(`History request failed for ${failed.length} asset(s) (${idList(failed)}); they are excluded for insufficient history.`);
  if (notRequested.length > 0) notes.push(`History not requested for ${notRequested.length} asset(s) (${idList(notRequested)}) because ${stopReason}; they are excluded for insufficient history.`);
  const today = odd.todayMidnight + odd.todayAfterMidnight;
  if (today + odd.priorIntraday + odd.invalid + odd.future > 0 || odd.conflicts > 0 || odd.gaps > 0 || odd.missingRecent > 0) {
    notes.push(`History points not used: ${today} from the current (incomplete) UTC day (${odd.todayMidnight} at 00:00 UTC, ${odd.todayAfterMidnight} later), ${odd.priorIntraday} earlier points not at 00:00 UTC, ${odd.future} future, ${odd.invalid} invalid; ${odd.conflicts} conflicting duplicates, ${odd.gaps} missing days and ${odd.missingRecent} missing recent days counted as unusable.`);
  }
  notes.push('The exact meaning of a daily history volume point (rolling 24h vs calendar day) is not yet verified against live data.');

  return {
    dataset: { kind: 'live', label: 'CoinGecko live snapshot', source: COINGECKO_SOURCE, asOf: fetchedAt.toISOString(), attribution: COINGECKO_ATTRIBUTION, notes },
    assets: withHistory,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export interface ShownPoint {
  /** Position in the provider's response (raw order). */
  index: number;
  /** ISO UTC time, or null when the timestamp is invalid. */
  time: string | null;
  cls: PointClass;
  /** True when an earlier point in the same response had the same timestamp. */
  duplicate: boolean;
}

/**
 * Timestamp-only summary of a /market_chart response, in the provider's raw order: the
 * number of points, the first 2 and last 3 points with their classification, and how many
 * were omitted in between. Volume values are deliberately never included.
 * Returns null when the response has no total_volumes array.
 */
export function describeHistory(json: unknown, now: Date): { points: number; shown: ShownPoint[]; omitted: number } | null {
  if (!isRecord(json) || !Array.isArray(json.total_volumes)) return null;
  const startOfToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const all = json.total_volumes as unknown[];
  const seen = new Set<number>();
  const described: ShownPoint[] = all.map((p, index) => {
    const { ts, cls } = classifyPoint(p, startOfToday);
    const duplicate = ts !== null && seen.has(ts);
    if (ts !== null) seen.add(ts);
    return { index, time: ts === null ? null : new Date(ts).toISOString(), cls, duplicate };
  });
  const shown = described.length <= 5 ? described : [...described.slice(0, 2), ...described.slice(-3)];
  return { points: all.length, shown, omitted: described.length - shown.length };
}

export interface HistoryDiagnostic {
  id: string;
  /** "parsed", "response had no total_volumes array", or "request failed (...)". */
  outcome: string;
  history?: { points: number; shown: ShownPoint[]; omitted: number };
}
