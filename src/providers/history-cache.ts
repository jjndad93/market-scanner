/**
 * S6: local cache of CoinGecko /market_chart volume histories, so later runs on the same UTC day
 * do not spend requests re-fetching them.
 *
 * Freshness: the scanner uses only points from completed UTC days (before today's 00:00 UTC), so
 * a history fetched earlier today holds the same completed days as one fetched now. An entry is
 * therefore reused only during the UTC day it was fetched, and only if it was fetched at least
 * HISTORY_CACHE_PUBLISH_MARGIN_MS after 00:00 UTC (CoinGecko publishes the last completed day
 * shortly after midnight; an entry fetched before that may lack it). Anything else is a miss and
 * the history is requested again. Only successfully parsed responses are stored; failures never are.
 *
 * Entries are plain JSON files, one per asset, named by a hash of the asset id (provider ids are
 * untrusted and must not become paths). A corrupt, mismatched or unreadable entry is a miss.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY_MS } from '../core/time.ts';

export const HISTORY_CACHE_VERSION = 1;
/** Entries fetched less than this long after 00:00 UTC are never reused. */
export const HISTORY_CACHE_PUBLISH_MARGIN_MS = 15 * 60_000;

export interface HistoryCacheEntry {
  /** When the history was fetched (ISO UTC). */
  fetchedAt: string;
  /** The provider's total_volumes array, unchanged. */
  totalVolumes: unknown[];
}

export interface HistoryCache {
  /** A fresh entry for this asset and request, or null (missing, stale, corrupt or mismatched). */
  get(id: string, days: number, now: Date): HistoryCacheEntry | null;
  /** Stores a successfully parsed history. Returns false if it could not be written. */
  set(id: string, days: number, fetchedAt: Date, totalVolumes: unknown[]): boolean;
}

/** True when an entry fetched at `fetchedAt` may be reused at `now` (see the freshness rule above). */
export function isFreshHistory(fetchedAt: Date, now: Date): boolean {
  const t = fetchedAt.getTime();
  const startOfToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return Number.isFinite(t) && t >= startOfToday + HISTORY_CACHE_PUBLISH_MARGIN_MS && t <= now.getTime();
}

/**
 * Where the cache lives: the user's local (not roaming, not OneDrive-synced) cache directory.
 * Returns null when none is known, which disables the cache.
 */
export function historyCacheDir(env: Record<string, string | undefined>): string | null {
  const base = env.LOCALAPPDATA ?? env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, '.cache') : undefined);
  return base ? join(base, 'market-scanner', 'coingecko-history') : null;
}

const fileName = (id: string) => `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createFileHistoryCache(dir: string): HistoryCache {
  return {
    get(id, days, now) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, fileName(id)), 'utf8'));
      } catch {
        return null; // missing or unreadable
      }
      if (!isRecord(raw) || raw.version !== HISTORY_CACHE_VERSION || raw.id !== id || raw.days !== days) return null;
      if (typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.totalVolumes)) return null;
      if (!isFreshHistory(new Date(raw.fetchedAt), now)) return null;
      return { fetchedAt: raw.fetchedAt, totalVolumes: raw.totalVolumes };
    },
    set(id, days, fetchedAt, totalVolumes) {
      const file = join(dir, fileName(id));
      const body = JSON.stringify({ version: HISTORY_CACHE_VERSION, id, days, fetchedAt: fetchedAt.toISOString(), totalVolumes });
      try {
        mkdirSync(dir, { recursive: true });
        // Write then rename, so a crash never leaves a half-written entry under the real name.
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, body);
        renameSync(tmp, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
