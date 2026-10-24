/**
 * News and market-movement explanations for the dashboard. Pure functions: no network, no clock.
 *
 * What this module will and will not claim:
 * - A "confirmed fact" is only what the provider reports about an article: its publisher,
 *   headline, publication time, tagged tickers and description. This tool does not read the
 *   article itself, so it never states what the article proves.
 * - The strongest link it ever draws is a "possible catalyst": an article tagged with the asset,
 *   focused on it, and published BEFORE or DURING the observed move. That is a timing-and-topic
 *   connection, never confirmed causation.
 * - An article published AFTER the move was observed is never treated as its cause; an article
 *   without a usable publication time cannot be placed in time and is never a catalyst.
 * - With no qualifying article, the verdict says the reason for the move is unknown.
 */

export type Direction = 'rising' | 'falling' | 'flat';

/** The observed move an explanation is for. Times are ISO; the window is when the move happened. */
export interface MoveContext {
  market: 'crypto' | 'stocks';
  symbol: string;
  name: string;
  /** Short-period % change (crypto 24h, stocks 1 session), or null when unknown. */
  changePct: number | null;
  direction: Direction;
  /** Large enough to meet the scanner's mover threshold. */
  significant: boolean;
  /** Extreme-volatility flags from the risk measures (may be empty). */
  volatile: boolean;
  /** Start and end of the observed move (crypto: rolling 24h to the last update; stocks: previous close to latest close). */
  windowStart: string;
  windowEnd: string;
  windowLabel: string;
  /** How far before the window an article still counts as "shortly before" (ms). */
  leadMs: number;
}

/** One article as returned by a news provider, after validation (untrusted text, length-capped). */
export interface NewsArticle {
  id: string;
  title: string;
  publisher: string;
  /** ISO time, or null when missing or invalid. */
  publishedUtc: string | null;
  /** Why publishedUtc is null, when it is. */
  publishedNote: string | null;
  /** http(s) link to the original article, or null when the provider's link was unusable. */
  url: string | null;
  /** The provider's or publisher's description, or null. Not written by this tool. */
  description: string | null;
  /** Tickers the PROVIDER tagged the article with. */
  tickers: string[];
  /** Provider's automated (AI-generated) sentiment for the asset, when supplied. */
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  sentimentReasoning: string | null;
}

export type Timing = 'during' | 'shortly_before' | 'after' | 'stale' | 'unknown_time';
export type Focus = 'headline' | 'sole_ticker' | 'mentioned';
export type Role = 'possible_catalyst' | 'reported_after' | 'background' | 'unplaced';

export interface ArticleAssessment {
  article: NewsArticle;
  timing: Timing;
  focus: Focus;
  role: Role;
  /** Evidence strength for a link to the move. Never "strong": timing and topic cannot prove cause. */
  strength: 'moderate' | 'weak' | 'none';
  /** What the provider reports (fact), and why the article may or may not be relevant (reasoning). */
  fact: string;
  relevance: string;
}

export type VerdictKind = 'possible_catalyst' | 'conflicting' | 'unconfirmed' | 'no_news' | 'no_source';
export interface Verdict {
  kind: VerdictKind;
  label: string;
  text: string;
}

export interface NewsAssessment {
  movement: string;
  verdict: Verdict;
  /** Only articles tagged with this asset, newest first. Unrelated articles are dropped, never shown. */
  articles: ArticleAssessment[];
  /** Articles the provider returned that were not tagged with this asset (dropped). */
  droppedUnrelated: number;
  /** Duplicate articles removed (same id or link). */
  droppedDuplicates: number;
  notes: string[];
}

export const VERDICT_LABEL: Record<VerdictKind, string> = {
  possible_catalyst: 'Possible catalyst',
  conflicting: 'Conflicting reports',
  unconfirmed: 'Unconfirmed',
  no_news: 'Unconfirmed: no relevant news found',
  no_source: 'Unconfirmed: no news source',
};

/** News older than this before the window is "stale" context. */
export const STALE_NOTE_DAYS = 7;
const HOUR = 3_600_000;

const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const COMPANY_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings|group|sa|nv|ag)\.?$/i;

/** The asset's name without a trailing company suffix ("Apple Inc." -> "Apple"). */
export function coreName(name: string): string {
  let n = name.trim().replace(/[.,]+$/, '');
  for (let i = 0; i < 2; i++) n = n.replace(COMPANY_SUFFIX, '').trim().replace(/[.,]+$/, '');
  return n;
}

/** Does the headline name the asset (its ticker as a whole word, or its core name)? */
export function headlineMentions(title: string, symbol: string, name: string): boolean {
  const sym = new RegExp(`(^|[^A-Za-z0-9])\\$?${symbol.replace(ESCAPE, '\\$&')}([^A-Za-z0-9]|$)`);
  if (symbol.length >= 2 && sym.test(title)) return true;
  const core = coreName(name);
  return core.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${core.replace(ESCAPE, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(title);
}

export function timingOf(publishedUtc: string | null, ctx: MoveContext): Timing {
  if (publishedUtc === null) return 'unknown_time';
  const t = Date.parse(publishedUtc);
  const start = Date.parse(ctx.windowStart);
  const end = Date.parse(ctx.windowEnd);
  if (t > end) return 'after';
  if (t >= start) return 'during';
  if (t >= start - ctx.leadMs) return 'shortly_before';
  return 'stale';
}

export function describeMovement(ctx: MoveContext): string {
  if (ctx.changePct === null) return `No ${ctx.windowLabel} price change is available for ${ctx.symbol}.`;
  const dir = ctx.direction === 'flat' ? 'roughly flat' : ctx.direction;
  const size = ctx.significant ? 'a large move by the scanner\'s mover threshold' : 'below the scanner\'s mover threshold';
  return `${ctx.symbol} is ${dir} (${fmtPct(ctx.changePct)} over ${ctx.windowLabel}; ${size})${ctx.volatile ? ', with extreme-volatility warnings' : ''}.`;
}

function assessArticle(a: NewsArticle, ctx: MoveContext): ArticleAssessment {
  const timing = timingOf(a.publishedUtc, ctx);
  const focus: Focus = headlineMentions(a.title, ctx.symbol, ctx.name) ? 'headline' : a.tickers.length === 1 ? 'sole_ticker' : 'mentioned';
  const when = a.publishedUtc ?? 'an unknown time';
  const fact = `${a.publisher} published "${a.title}" at ${when}; the provider tagged it with ${a.tickers.length === 1 ? a.tickers[0] : `${a.tickers.length} tickers including ${ctx.symbol}`}.`;
  const focusText = focus === 'headline' ? 'The headline names this asset'
    : focus === 'sole_ticker' ? 'It is tagged with this asset only, though the headline does not name it'
      : `It is tagged with ${a.tickers.length} tickers and the headline does not name this asset, so it may only mention it in passing`;
  let role: Role;
  let strength: ArticleAssessment['strength'] = 'none';
  let relevance: string;
  switch (timing) {
    case 'unknown_time':
      role = 'unplaced';
      relevance = `${focusText}. Its publication time is missing or invalid${a.publishedNote ? ` (${a.publishedNote})` : ''}, so it cannot be placed before or after the move and is not treated as a catalyst.`;
      break;
    case 'after':
      role = 'reported_after';
      relevance = `${focusText}. It was published after the move was observed (window ended ${ctx.windowEnd}), so it may describe the move but is not evidence of its cause.`;
      break;
    case 'stale':
      role = 'background';
      relevance = `${focusText}. It was published well before the move (more than ${Math.round(ctx.leadMs / HOUR)} hours before the window began), so it is background only.`;
      break;
    default: {
      const placed = timing === 'during' ? `published during the move window (${ctx.windowLabel})` : `published shortly before the move window (within ${Math.round(ctx.leadMs / HOUR)} hours)`;
      if (focus === 'mentioned') {
        role = 'background';
        relevance = `${focusText}. Although it was ${placed}, a passing mention is not enough to connect it to the move.`;
      } else {
        role = 'possible_catalyst';
        strength = focus === 'headline' && timing === 'during' ? 'moderate' : 'weak';
        relevance = `${focusText}, and it was ${placed}. That timing makes it a possible catalyst, not a confirmed cause: the tool has not read the article and other factors may explain the move.`;
      }
    }
  }
  return { article: a, timing, focus, role, strength, fact, relevance };
}

/**
 * Assesses the provider's articles for one asset. Only articles tagged with the asset are kept;
 * duplicates are removed; nothing is invented when evidence is missing.
 */
export function assessNews(ctx: MoveContext, articles: readonly NewsArticle[] | null, now: Date): NewsAssessment {
  const movement = describeMovement(ctx);
  const notes: string[] = [];
  if (articles === null) {
    return {
      movement, articles: [], droppedUnrelated: 0, droppedDuplicates: 0, notes,
      verdict: { kind: 'no_source', label: VERDICT_LABEL.no_source, text: 'No news source is configured for this market, so no articles were checked. The reason for the move is unknown.' },
    };
  }
  const seen = new Set<string>();
  let droppedUnrelated = 0;
  let droppedDuplicates = 0;
  const kept: ArticleAssessment[] = [];
  // Among duplicates keep the EARLIEST published copy (the original report, not a later re-post);
  // copies without a usable time come last.
  const byTime = (a: NewsArticle) => (a.publishedUtc === null ? Infinity : Date.parse(a.publishedUtc));
  for (const a of [...articles].sort((x, y) => byTime(x) - byTime(y))) {
    if (!a.tickers.includes(ctx.symbol)) {
      droppedUnrelated++;
      continue;
    }
    const keys = [`id:${a.id}`, ...(a.url ? [`url:${a.url}`] : [])];
    if (keys.some((k) => seen.has(k))) {
      droppedDuplicates++;
      continue;
    }
    for (const k of keys) seen.add(k);
    kept.push(assessArticle(a, ctx));
  }
  kept.sort((x, y) => (Date.parse(y.article.publishedUtc ?? '') || 0) - (Date.parse(x.article.publishedUtc ?? '') || 0));

  const dated = kept.map((x) => x.article.publishedUtc).filter((t): t is string => t !== null);
  if (dated.length > 0) {
    const newestDays = (now.getTime() - Math.max(...dated.map(Date.parse))) / (24 * HOUR);
    if (newestDays > STALE_NOTE_DAYS) notes.push(`The newest related article is ${Math.floor(newestDays)} days old; the news may be stale.`);
  }
  if (kept.length > 0 && dated.length < kept.length) notes.push(`${kept.length - dated.length} article(s) have no usable publication time.`);

  const catalysts = kept.filter((x) => x.role === 'possible_catalyst');
  let verdict: Verdict;
  if (kept.length === 0) {
    verdict = { kind: 'no_news', label: VERDICT_LABEL.no_news, text: 'No relevant news found for this asset in the provider\'s results. The reason for the move is unknown.' };
  } else if (catalysts.length === 0) {
    verdict = {
      kind: 'unconfirmed', label: VERDICT_LABEL.unconfirmed,
      text: 'Related articles exist, but none is both focused on this asset and published before or during the move. No credible evidence connects the move to a specific event; the reason is unknown.',
    };
  } else {
    // Conflict: catalysts disagree with each other, or every one that has a sentiment points against the move.
    // Sentiment is the provider's automated (AI-generated) label, used only to detect disagreement.
    const s = catalysts.map((x) => x.article.sentiment).filter((v): v is 'positive' | 'negative' => v === 'positive' || v === 'negative');
    const mixed = s.includes('positive') && s.includes('negative');
    const against = s.length > 0 && ctx.direction !== 'flat' && s.every((v) => v === (ctx.direction === 'rising' ? 'negative' : 'positive'));
    if (mixed || against) {
      verdict = {
        kind: 'conflicting', label: VERDICT_LABEL.conflicting,
        text: mixed
          ? 'The articles published around the move point in different directions (by the provider\'s automated sentiment). The evidence is insufficient to say why the asset moved.'
          : `The articles published around the move read as ${s[0]} (by the provider's automated sentiment) while the asset is ${ctx.direction}. The evidence is insufficient to say why it moved.`,
      };
    } else {
      verdict = {
        kind: 'possible_catalyst', label: VERDICT_LABEL.possible_catalyst,
        text: `${catalysts.length} article(s) focused on this asset were published before or during the move. They are possible catalysts only: timing and topic do not confirm the cause, and the tool has not read the articles.`,
      };
    }
  }
  if (!ctx.significant && ctx.changePct !== null) notes.push('The move is below the scanner\'s mover threshold; there may be no specific event to explain.');
  return { movement, verdict, articles: kept, droppedUnrelated, droppedDuplicates, notes };
}
