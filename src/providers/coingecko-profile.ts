/**
 * CoinGecko project profile for one coin: GET /coins/{id} (listed in the Demo API reference; checked
 * 2026-10-27). One request, made only when the user asks for a coin's profile in the dashboard.
 * Tickers, community and developer data are switched off to keep the response small.
 *
 * Every text field is untrusted provider/project text: it is stripped of HTML and control characters
 * and length-capped. The description is the project's own text as listed by CoinGecko; it is shown as
 * "project-provided", never as a verified fact.
 */

import { ProviderResponseError } from './coingecko.ts';
import type { HttpClient } from './http.ts';
import { cleanText, safeLink } from './massive-news.ts';

export interface CoinProfile {
  id: string;
  name: string | null;
  symbol: string | null;
  /** First one or two sentences of CoinGecko's English description (project-provided), or null. */
  descriptionExcerpt: string | null;
  /** YYYY-MM-DD as listed by CoinGecko, or null when missing, malformed or in the future. */
  genesisDate: string | null;
  categories: string[];
  homepage: string | null;
  whitepaper: string | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  /** % change from the all-time high in USD (CoinGecko), or null. */
  athChangePct: number | null;
  marketCapRank: number | null;
  /** When CoinGecko last updated this coin, or null. */
  lastUpdated: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** HTML-free first one or two sentences of a description, at most `max` characters. */
export function descriptionExcerpt(raw: unknown, max = 320): string | null {
  if (typeof raw !== 'string') return null;
  const text = cleanText(raw.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), 4000);
  if (!text) return null;
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [text];
  let out = '';
  for (const s of sentences.slice(0, 2)) {
    const next = (out ? `${out} ` : '') + s.trim();
    if (next.length > max) break;
    out = next;
  }
  if (!out) out = `${text.slice(0, max - 1).trimEnd()}…`;
  return out;
}

function genesis(v: unknown, now: Date): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v || t > now.getTime()) return null;
  return v;
}

/** /coins/{id} response -> validated profile. The id must match the coin that was asked for. */
export function parseCoinProfile(json: unknown, id: string, now: Date): CoinProfile {
  if (!isRecord(json)) throw new ProviderResponseError('/coins/{id} did not return an object.');
  if (json.id !== id) throw new ProviderResponseError('/coins/{id} returned a different coin than the one requested.');
  const desc = isRecord(json.description) ? json.description.en : null;
  const links = isRecord(json.links) ? json.links : {};
  const md = isRecord(json.market_data) ? json.market_data : {};
  const ath = isRecord(md.ath_change_percentage) ? md.ath_change_percentage.usd : null;
  const rank = json.market_cap_rank;
  const updated = typeof json.last_updated === 'string' && !Number.isNaN(Date.parse(json.last_updated)) ? new Date(json.last_updated).toISOString() : null;
  return {
    id,
    name: cleanText(json.name, 120),
    symbol: cleanText(json.symbol, 30)?.toUpperCase() ?? null,
    descriptionExcerpt: descriptionExcerpt(desc),
    genesisDate: genesis(json.genesis_date, now),
    categories: Array.isArray(json.categories) ? [...new Set(json.categories.map((c) => cleanText(c, 60)).filter((c): c is string => c !== null))].slice(0, 6) : [],
    homepage: Array.isArray(links.homepage) ? (links.homepage.map(safeLink).find((u) => u !== null) ?? null) : null,
    whitepaper: safeLink(links.whitepaper),
    circulatingSupply: positive(md.circulating_supply),
    totalSupply: positive(md.total_supply),
    maxSupply: positive(md.max_supply),
    athChangePct: typeof ath === 'number' && Number.isFinite(ath) && ath > -100 && ath <= 1 ? ath : null,
    marketCapRank: typeof rank === 'number' && Number.isInteger(rank) && rank >= 1 ? rank : null,
    lastUpdated: updated,
  };
}

/** One request: the profile of one coin (no tickers, community or developer data). */
export async function fetchCoinProfile(client: HttpClient, id: string, now: Date): Promise<CoinProfile> {
  const json = await client.getJson(`/coins/${encodeURIComponent(id)}`, {
    localization: 'false', tickers: 'false', market_data: 'true', community_data: 'false', developer_data: 'false', sparkline: 'false',
  });
  return parseCoinProfile(json, id, now);
}
