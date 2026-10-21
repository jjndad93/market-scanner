/**
 * Stage 4: optional live market context for the option evaluator (`option --live-context`).
 *
 * One Massive daily-bars request for the contract's underlying (no retry), then:
 *   historical volatility = sample standard deviation of the last 20 daily log returns x sqrt(252)
 *   recent trend          = % change from the close 20 sessions earlier to the latest close
 * Both are CALCULATED from end-of-day bars. A pasted (YOU PROVIDED) value always stays the active
 * input; a fetched value only fills a field that was not pasted, and is otherwise shown as a
 * cross-check. Any failure leaves the inputs unchanged and says why. Nothing is invented.
 */

import { calculated, type Evidence, has } from '../core/evidence.ts';
import { pct } from '../core/format.ts';
import { daysBetweenIsoDates, nyDateString, nyWallTimeToUtc } from '../core/time.ts';
import { createHttpClient, type FetchLike } from '../providers/http.ts';
import { MASSIVE_BASE_URL, MASSIVE_KEY_ENV, MASSIVE_KEY_HEADER, fetchStockDataset } from '../providers/massive.ts';
import { normalizeStockDataset } from '../stocks/normalize.ts';
import { STOCK_RULES } from '../stocks/rules.ts';
import type { Bar } from '../stocks/types.ts';
import type { ContractInput, MarketContext } from './types.ts';

export const LIVE_CONTEXT_SESSIONS = 20;
const HV_METHOD = `sample standard deviation of the last ${LIVE_CONTEXT_SESSIONS} daily log returns x sqrt(252), from Massive end-of-day closes`;

export interface LiveContextDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  clock: () => Date;
}

export type LiveContextResult =
  | {
    status: 'ok';
    symbol: string;
    latestSession: string;
    fromSession: string;
    historicalVol: Evidence<number>;
    trend: Evidence<string>;
    /** 'active' = used by the evaluation (nothing was pasted); 'cross-check' = a pasted value was kept. */
    hvRole: 'active' | 'cross-check';
    trendRole: 'active' | 'cross-check';
    /** The pasted values that stayed active, for the side-by-side display. */
    pastedHv: number | null;
    pastedTrend: string | null;
  }
  | { status: 'unavailable'; symbol: string | null; reason: string; requestsMade: number };

/** Pure calculation from validated bars (oldest first). Returns null with a reason when it cannot. */
export function calculateLiveContext(bars: Bar[], now: Date): { hv: number; trendPct: number; latest: string; from: string } | { reason: string } {
  const window = bars.slice(-(LIVE_CONTEXT_SESSIONS + 1));
  if (window.length < LIVE_CONTEXT_SESSIONS + 1) return { reason: `only ${bars.length} usable daily bar(s); ${LIVE_CONTEXT_SESSIONS + 1} are needed for ${LIVE_CONTEXT_SESSIONS} returns` };
  const maxGap = Math.max(...window.slice(1).map((b, i) => daysBetweenIsoDates(window[i]!.date, b.date)));
  if (maxGap > STOCK_RULES.maxGapDays) return { reason: `a ${maxGap}-day gap between daily bars; sessions may be missing` };
  const latest = window[window.length - 1]!;
  const age = daysBetweenIsoDates(latest.date, nyDateString(now));
  if (age < 0 || age > STOCK_RULES.maxSessionAgeDays) return { reason: `the latest session ${latest.date} is not a recent completed session` };
  const returns = window.slice(1).map((b, i) => Math.log(b.close / window[i]!.close));
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return { hv: Math.sqrt(variance) * Math.sqrt(252), trendPct: (latest.close / window[0]!.close - 1) * 100, latest: latest.date, from: window[0]!.date };
}

const trendText = (p: number, from: string, latest: string) =>
  `${p >= 0 ? 'up' : 'down'} ${Math.abs(p).toFixed(1)}% over ${LIVE_CONTEXT_SESSIONS} sessions (${from} close to ${latest} close)`;

/**
 * Fetches and calculates live context, then returns the context to evaluate with: pasted values
 * unchanged, fetched values only in fields that were empty.
 */
export async function applyLiveContext(contract: ContractInput, context: MarketContext, deps: LiveContextDeps): Promise<{ context: MarketContext; result: LiveContextResult }> {
  const symbol = has(contract.underlying) ? contract.underlying.value.trim().toUpperCase() : null;
  const unavailable = (reason: string, requestsMade = 0) => ({ context, result: { status: 'unavailable' as const, symbol, reason, requestsMade } });
  if (symbol === null) return unavailable('no Underlying ticker in the pasted details');
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return unavailable(`"${symbol}" is not a recognizable US stock ticker`);
  const key = deps.env[MASSIVE_KEY_ENV]?.trim();
  if (!key) return unavailable(`the ${MASSIVE_KEY_ENV} environment variable is not set`);

  // One request attempt, no retry: the client refuses anything beyond it (a 429 retry included).
  const client = createHttpClient({ fetch: deps.fetch, baseUrl: MASSIVE_BASE_URL, apiKeyHeader: MASSIVE_KEY_HEADER, apiKey: `Bearer ${key}`, maxCalls: 1, sleep: async () => {} });
  let data: Awaited<ReturnType<typeof fetchStockDataset>>;
  try {
    data = await fetchStockDataset({ client, clock: deps.clock, universe: [symbol], maxCalls: 1, sleep: async () => {} });
  } catch (e) {
    return unavailable(`the request failed (${(e instanceof Error ? e.message : String(e)).split(key).join('[REDACTED]')})`, client.callsMade);
  }
  if (data.stocks[0]?.historyStatus !== undefined) {
    return unavailable(`the daily-bars request failed or was rate-limited (no retry by design)${data.firstFailure ? `: ${data.firstFailure}` : ''}`, client.callsMade);
  }
  const stock = normalizeStockDataset(data).stocks[0]!;
  const calc = calculateLiveContext(stock.bars, deps.clock());
  if ('reason' in calc) return unavailable(calc.reason, client.callsMade);

  const asOf = nyWallTimeToUtc(calc.latest, 16, 0).toISOString(); // the latest completed session's close
  const dated = `From --live-context: Massive end-of-day bars for ${symbol}, latest completed session ${calc.latest}.`;
  const historicalVol = calculated(calc.hv, HV_METHOD, asOf, dated);
  const trend = calculated(trendText(calc.trendPct, calc.from, calc.latest), `% change from the close ${LIVE_CONTEXT_SESSIONS} sessions earlier to the latest close, Massive end-of-day closes`, asOf, dated);
  const hvPasted = has(context.historicalVol);
  const trendPasted = has(context.trend);
  return {
    context: { ...context, historicalVol: hvPasted ? context.historicalVol : historicalVol, trend: trendPasted ? context.trend : trend },
    result: {
      status: 'ok', symbol, latestSession: calc.latest, fromSession: calc.from, historicalVol, trend,
      hvRole: hvPasted ? 'cross-check' : 'active', trendRole: trendPasted ? 'cross-check' : 'active',
      pastedHv: hvPasted ? context.historicalVol.value : null, pastedTrend: trendPasted ? context.trend.value : null,
    },
  };
}

/** One sentence for the report header: what live data was, or was not, used. */
export function liveContextHeader(r: LiveContextResult): string {
  if (r.status === 'unavailable') return '--live-context was requested, but no live data was used (see LIVE CONTEXT at the end).';
  const active = [r.hvRole === 'active' ? 'historical volatility' : null, r.trendRole === 'active' ? 'recent trend' : null].filter(Boolean);
  return `--live-context fetched Massive end-of-day bars for ${r.symbol} (latest completed session ${r.latestSession}); ${active.length > 0 ? `${active.join(' and ')} ${active.length > 1 ? 'are' : 'is'} CALCULATED from them because nothing was pasted` : 'your pasted values stay active and the fetched figures are only a cross-check'} (see LIVE CONTEXT at the end).`;
}

/** Text section appended after the evaluation report. */
export function renderLiveContext(r: LiveContextResult): string {
  if (r.status === 'unavailable') {
    return [
      `LIVE CONTEXT (--live-context${r.symbol ? `, ${r.symbol}` : ''}): could not be calculated - ${r.reason}.`,
      `  Requests made: ${r.requestsMade} of 1. Your pasted inputs are unchanged; nothing was filled in.`,
    ].join('\n');
  }
  const role = (active: boolean, pasted: string) => (active
    ? '    Used as the active input: nothing was pasted for this field.'
    : `    Cross-check only: your pasted value ${pasted} [YOU PROVIDED] stays the active input.`);
  return [
    `LIVE CONTEXT (--live-context): Massive end-of-day bars for ${r.symbol}, latest completed session ${r.latestSession}`,
    `  Historical volatility: ${pct(r.historicalVol.value!)} [CALCULATED] - ${r.historicalVol.source}`,
    role(r.hvRole === 'active', r.pastedHv !== null ? pct(r.pastedHv) : ''),
    `  Recent trend: ${r.trend.value} [CALCULATED]`,
    role(r.trendRole === 'active', r.pastedTrend !== null ? `"${r.pastedTrend}"` : ''),
    '  End-of-day data only; not independently audited. Requests made: 1 of 1.',
  ].join('\n');
}
