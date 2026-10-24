/**
 * Dashboard "Cross-check with CoinMarketCap" (Stage A). Runs only when the user asks, after a crypto
 * scan, and never changes the scan.
 *
 * - Offline scan -> a TEST DATA fixture, zero requests. Live scan -> exactly ONE CMC listings
 *   request (top 500 by CMC rank: 2 credits by the documented rule), only after an explicit
 *   confirmation from the page, through the existing HTTP client with a 1-call budget.
 * - The key is read only from the COINMARKETCAP_API_KEY environment variable, on the server; it is
 *   sent in a header, never logged, and redacted from anything returned.
 * - Plan-access, key, payment and credit-limit errors stop all further CMC requests for this server
 *   session (no retries that spend credits); a per-minute limit pauses them for 60 s.
 * - Storage: the parsed subset needed for display is kept IN MEMORY ONLY for CMC_CACHE_TTL_MS
 *   (the terms allow temporary storage needed to show the data); nothing is written to disk.
 * - Every response carries the required attribution ("Data provided by CoinMarketCap.com" + link).
 */

import { readFileSync } from 'node:fs';
import { type FetchLike, createHttpClient } from '../providers/http.ts';
import { CMC_ATTRIBUTION, CMC_BASE_URL, CMC_KEY_ENV, CMC_KEY_HEADER, CMC_LISTINGS_LIMIT, CMC_SOURCE, type CmcRecord, classifyCmcFailure, fetchCmcListings, parseCmcListings } from '../providers/coinmarketcap.ts';
import { CROSS_CHECK_TOLERANCE, crossCheckLeads } from '../scanner/cross-check.ts';
import type { Discovery } from '../scanner/types.ts';

export const CMC_CACHE_TTL_MS = 10 * 60_000;
export const CMC_SESSION_REQUEST_LIMIT = 20;
/** CMC's documented credit cost of one top-500 listings call (1 credit per 250 coins). */
export const CMC_EXPECTED_CREDITS = Math.ceil(CMC_LISTINGS_LIMIT / 250);
export const BUNDLED_CMC_FIXTURE = new URL('../../test/fixtures/cmc-listings.synthetic.json', import.meta.url);

export interface CmcDeps { env: Record<string, string | undefined>; fetch: FetchLike; clock: () => Date; sleep?: (ms: number) => Promise<void> }
export interface CmcLastCrypto { mode: 'offline' | 'live'; evaluatedAt: string; discovery?: Discovery }
export interface Reply { status: number; data: Record<string, unknown> }

export const CMC_NOTES = [
  'Second source only: the scan, its scores, tiers and filters are unchanged.',
  `Matching is conservative: same symbol AND the same name (or CMC slug = CoinGecko id). Symbols alone are never matched; ambiguous or differently named coins are not compared.`,
  `Agreement tolerances: price within ${CROSS_CHECK_TOLERANCE.pricePct}%, market cap within ${CROSS_CHECK_TOLERANCE.marketCapPct}% (providers aggregate different markets and supply figures). 24h volume is not compared: CMC reports "adjusted" volume, a different method.`,
  'Tags are CoinMarketCap\'s own classification (provider evidence, not proof of legitimacy or safety). Only the top 500 by CMC rank is checked.',
];

export function validateCmcBody(body: string): { refresh: boolean; confirmLive: boolean } | { error: string } {
  if (body.length > 1024) return { error: 'Request body too large.' };
  try {
    const d = JSON.parse(body);
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return { error: 'Request body must be a JSON object.' };
    return { refresh: d.refresh === true, confirmLive: d.confirmLive === true };
  } catch {
    return { error: 'Request body must be JSON.' };
  }
}

export function createCmcCheckService(deps: CmcDeps, opts: { getLastCrypto: () => CmcLastCrypto | undefined; scanRunning: () => boolean; fixture?: URL; sessionLimit?: number }) {
  let cache: { at: number; records: CmcRecord[]; skipped: number; creditCount: number | null } | null = null;
  let busy = false;
  let used = 0;
  let stoppedReason: string | null = null;
  let pausedUntil = 0;
  const limit = opts.sessionLimit ?? CMC_SESSION_REQUEST_LIMIT;
  const reply = (status: number, data: Record<string, unknown>): Reply => ({ status, data: { ok: status === 200, attribution: CMC_ATTRIBUTION, ...data } });
  const session = () => ({ cmcRequestsThisSession: used, cmcSessionLimit: limit });

  function result(last: CmcLastCrypto, records: CmcRecord[], extra: Record<string, unknown>): Reply {
    const d = last.discovery;
    const leads = d ? [...d.highPriority, ...d.watchlist, ...d.insufficientData] : [];
    const checked = crossCheckLeads(leads, records);
    return reply(200, { scanMode: last.mode, scanEvaluatedAt: last.evaluatedAt, ...checked, notes: CMC_NOTES, ...session(), ...extra });
  }

  return {
    get busy() {
      return busy;
    },
    /** Why CMC requests are stopped for this session, or null. */
    get stoppedReason() {
      return stoppedReason;
    },
    async check(req: { refresh: boolean; confirmLive: boolean }): Promise<Reply> {
      const last = opts.getLastCrypto();
      if (!last) return reply(409, { error: 'Run a crypto scan first; the cross-check covers its research leads.' });
      if (!last.discovery) return reply(409, { error: 'The last crypto scan has no research leads to check.' });

      if (last.mode === 'offline') {
        const f = parseCmcListings(JSON.parse(readFileSync(opts.fixture ?? BUNDLED_CMC_FIXTURE, 'utf8')));
        return result(last, f.records, { mode: 'offline', dataKind: 'test_data', source: 'Synthetic CoinMarketCap listings fixture (TEST DATA)', fetchedAt: last.evaluatedAt, fromCache: false, requestsUsed: 0, creditsUsed: 0, skipped: f.skipped });
      }

      const now = deps.clock().getTime();
      const live = { mode: 'live', dataKind: 'verified_market_data', source: CMC_SOURCE };
      if (cache && now - cache.at >= CMC_CACHE_TTL_MS) cache = null; // expired: dropped, not kept
      if (cache && !req.refresh) {
        return result(last, cache.records, { ...live, fetchedAt: new Date(cache.at).toISOString(), fromCache: true, requestsUsed: 0, creditsUsed: 0, skipped: cache.skipped });
      }
      if (stoppedReason) return reply(403, { error: `CoinMarketCap requests are stopped for this session: ${stoppedReason} Restart the dashboard after fixing the cause.`, stopped: true, ...session() });
      if (now < pausedUntil) return reply(429, { error: `CoinMarketCap's per-minute limit was reached; wait ${Math.ceil((pausedUntil - now) / 1000)} s.`, ...session() });
      if (!req.confirmLive) {
        return reply(428, { error: `This sends 1 CoinMarketCap request (top ${CMC_LISTINGS_LIMIT} listings, about ${CMC_EXPECTED_CREDITS} credits of the free plan's 15,000 per month). Confirm to continue.`, needsConfirm: true, ...session() });
      }
      const key = deps.env[CMC_KEY_ENV]?.trim();
      if (!key) return reply(422, { error: `${CMC_KEY_ENV} is not set on the server, so no request was made. Set it as a Windows user environment variable and restart the dashboard; offline mode still works.` });
      if (opts.scanRunning()) return reply(409, { error: 'A scan is running; the cross-check waits until it finishes.' });
      if (busy) return reply(409, { error: 'A CoinMarketCap request is already running.' });
      if (used >= limit) return reply(429, { error: `This dashboard session has used its ${limit} CoinMarketCap requests. Restart the dashboard to reset the limit.`, ...session() });

      busy = true;
      const client = createHttpClient({ fetch: deps.fetch, baseUrl: CMC_BASE_URL, apiKeyHeader: CMC_KEY_HEADER, apiKey: key, maxCalls: 1, sleep: deps.sleep, maxRetryWaitMs: 0 });
      let got: Awaited<ReturnType<typeof fetchCmcListings>> | null = null;
      let failure: unknown = null;
      try {
        got = await fetchCmcListings(client);
      } catch (e) {
        failure = e;
      } finally {
        used += client.callsMade; // counted before any reply is built
        busy = false;
      }
      if (got) {
        cache = { at: now, records: got.records, skipped: got.skipped, creditCount: got.creditCount };
        return result(last, got.records, { ...live, fetchedAt: new Date(now).toISOString(), fromCache: false, requestsUsed: client.callsMade, creditsUsed: got.creditCount, skipped: got.skipped });
      }
      const f = classifyCmcFailure(failure);
      if (f.stop === 'session') stoppedReason = f.message;
      if (f.stop === 'minute') pausedUntil = now + 60_000;
      return reply(f.stop === 'session' ? 403 : 502, { error: f.message.split(key).join('[REDACTED]'), stopped: f.stop === 'session', requestsUsed: client.callsMade, ...session() });
    },
  };
}
export type CmcCheckService = ReturnType<typeof createCmcCheckService>;
