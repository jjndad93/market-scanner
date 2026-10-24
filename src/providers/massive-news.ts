/**
 * Massive (formerly Polygon.io) ticker news: GET /v2/reference/news (official docs, checked
 * 2026-10-21: "Included in all Stocks plans", including the free Stocks Basic plan; updated
 * hourly; 2 years of history on Basic). Same key and Bearer header as the daily bars, and the same
 * free-plan limit of 5 calls per minute, shared with stock scans.
 *
 * Every field is untrusted third-party text: it is validated, stripped of control characters and
 * length-capped here, and the dashboard inserts it as text only. Links must be http(s).
 * The provider's `insights` sentiment is automated (AI-generated) and is kept only as a labelled
 * hint for detecting disagreement, never as a fact about the article.
 */

import type { NewsArticle } from '../news/assess.ts';
import type { HttpClient } from './http.ts';
import { MassiveResponseError } from './massive.ts';

export const MASSIVE_NEWS_PATH = '/v2/reference/news';
export const MASSIVE_NEWS_SOURCE = 'Massive ticker news /v2/reference/news (provider updates hourly)';
/** Clock skew tolerated before a publication time counts as "in the future" (invalid). */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Untrusted text -> single-line plain text without control characters, capped. Null when empty. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Only absolute http(s) links without embedded credentials; anything else (javascript:, data:, …) is dropped. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function publishedTime(v: unknown, now: Date): { iso: string | null; note: string | null } {
  if (v === undefined || v === null || v === '') return { iso: null, note: 'no publication time given' };
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) return { iso: null, note: 'publication time is not a valid timestamp' };
  const t = Date.parse(v);
  if (t > now.getTime() + FUTURE_TOLERANCE_MS) return { iso: null, note: 'publication time is in the future' };
  return { iso: new Date(t).toISOString(), note: null };
}

/**
 * Massive news response -> validated articles for `symbol`. Articles without a title or an id are
 * skipped and counted. The sentiment kept is the provider's insight for this ticker only.
 */
export function parseMassiveNews(json: unknown, symbol: string, now: Date): { articles: NewsArticle[]; skipped: number } {
  if (!isRecord(json) || (json.results !== undefined && !Array.isArray(json.results))) throw new MassiveResponseError('news response is not an object with a results array.');
  const articles: NewsArticle[] = [];
  let skipped = 0;
  for (const r of (json.results as unknown[] | undefined) ?? []) {
    if (!isRecord(r)) {
      skipped++;
      continue;
    }
    const id = cleanText(r.id, 200);
    const title = cleanText(r.title, 300);
    if (id === null || title === null) {
      skipped++;
      continue;
    }
    const tickers = Array.isArray(r.tickers) ? r.tickers.filter((t): t is string => typeof t === 'string' && /^[A-Z0-9.\-]{1,12}$/.test(t)).slice(0, 50) : [];
    const insight = Array.isArray(r.insights) ? r.insights.find((i) => isRecord(i) && i.ticker === symbol) as Record<string, unknown> | undefined : undefined;
    const s = insight?.sentiment;
    const time = publishedTime(r.published_utc, now);
    articles.push({
      id, title,
      publisher: (isRecord(r.publisher) ? cleanText(r.publisher.name, 100) : null) ?? 'Unknown publisher',
      publishedUtc: time.iso, publishedNote: time.note,
      url: safeLink(r.article_url),
      description: cleanText(r.description, 600),
      tickers,
      sentiment: s === 'positive' || s === 'negative' || s === 'neutral' ? s : null,
      sentimentReasoning: insight ? cleanText(insight.sentiment_reasoning, 400) : null,
    });
  }
  return { articles, skipped };
}

/** One request: the newest `limit` articles tagged with `symbol`, published on or after `since`. */
export async function fetchMassiveNews(client: HttpClient, symbol: string, limit: number, since: Date, now: Date) {
  const json = await client.getJson(MASSIVE_NEWS_PATH, {
    ticker: symbol, order: 'desc', sort: 'published_utc', limit: String(limit), 'published_utc.gte': since.toISOString().slice(0, 10),
  });
  return parseMassiveNews(json, symbol, now);
}
