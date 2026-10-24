/**
 * CoinGecko asset search and single-asset market data, for the dashboard's crypto search.
 * Both endpoints are listed in the Demo API reference (official docs, checked 2026-10-22):
 *
 *   GET /search?query=…                      coins matching a name or symbol, across CoinGecko's
 *                                            whole universe (not only the scan's top 250),
 *                                            "sorted by market cap in descending order"
 *   GET /coins/markets?vs_currency=usd&ids=… the same market fields the scanner already uses
 *
 * Symbols are NOT unique on CoinGecko (unrelated tokens share them); the id is. Nothing here picks
 * an asset for the user: results are listed with their ids and the user chooses one.
 * Provider text is untrusted: it is validated, stripped of control characters and length-capped.
 */

import type { HttpClient } from './http.ts';
import { ProviderResponseError, parseMarkets } from './coingecko.ts';
import { cleanText } from './massive-news.ts';
import type { RawAsset } from '../scanner/types.ts';

export interface SearchCoin {
  /** CoinGecko's unique coin id: the only safe way to identify the asset. */
  id: string;
  name: string;
  symbol: string;
  /** Market-cap rank, or null when CoinGecko has none (often small or untracked tokens). */
  rank: number | null;
}

/** CoinGecko coin ids: lowercase letters, digits, hyphens (plus . and _ seen in a few ids). */
export const COIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** /search response -> the coins part, validated. Malformed entries are skipped and counted. */
export function parseSearchCoins(json: unknown): { coins: SearchCoin[]; skipped: number } {
  if (!isRecord(json) || !Array.isArray(json.coins)) throw new ProviderResponseError('/search did not return an object with a coins array.');
  const coins: SearchCoin[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const c of json.coins) {
    const id = isRecord(c) && typeof c.id === 'string' && COIN_ID_PATTERN.test(c.id) ? c.id : null;
    const name = isRecord(c) ? cleanText(c.name, 120) : null;
    const symbol = isRecord(c) ? cleanText(c.symbol, 30) : null;
    if (id === null || name === null || symbol === null || seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    const r = (c as Record<string, unknown>).market_cap_rank;
    coins.push({ id, name, symbol: symbol.toUpperCase(), rank: typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null });
  }
  return { coins, skipped };
}

/** One request: coins matching `query` (name or symbol). */
export async function fetchCoinSearch(client: HttpClient, query: string) {
  return parseSearchCoins(await client.getJson('/search', { query }));
}

/** One request: current market data for one coin id (same parameters as the scan, limited to that id). */
export async function fetchCoinMarket(client: HttpClient, id: string): Promise<RawAsset[]> {
  return parseMarkets(await client.getJson('/coins/markets', {
    vs_currency: 'usd', ids: id, price_change_percentage: '24h,7d', sparkline: 'false',
  }));
}
