/**
 * Curated 2030 outlooks (USD), researched by hand and only for coins the user asked for. Each entry
 * is ONE publisher's own published figures, copied from the primary source page (opened and read,
 * not a search snippet), with its date, link and stated assumptions. Entries are never averaged or
 * combined. Nothing here is fetched at runtime; it changes only when the user asks for an update.
 *
 * Research log (2026-10-27): each primary page below was opened and its figures read directly.
 * - ARK Invest's newer "Big Ideas 2026" report is reported by secondary sites to update the bitcoin
 *   outlook, but its figures could not be verified from the primary source, so it is not included.
 * - The same ARK article also shows an "experimental" active-supply model; it is not included here
 *   (ARK says it was not part of its Big Ideas 2025 targets).
 */

export type ForecastType = 'analyst_valuation_model' | 'model_scenario';
export interface Forecast {
  /** CoinGecko coin id the forecast is about. */
  coinId: string;
  publisher: string;
  authors: string;
  title: string;
  url: string;
  /** Publication date of the page (YYYY-MM-DD). */
  published: string;
  /** "Data as of" stated by the source, when given. */
  dataAsOf: string | null;
  type: ForecastType;
  currency: 'USD';
  targetYear: 2030;
  /** Only the scenarios the source itself published; none is ever filled in. */
  cases: { bear?: number; base?: number; bull?: number };
  /** The source's own key assumptions, summarised briefly. */
  assumptions: string;
  /** Up to three growth drivers the source itself names (its opinion, not a fact). */
  growthFactors: string[];
  /** True when the source publishes its figures as approximations (e.g. "~$300,000"). */
  approximate?: boolean;
}

export const FORECASTS: Forecast[] = [
  {
    coinId: 'bitcoin',
    publisher: 'ARK Invest',
    authors: 'David Puell',
    title: 'ARK’s Price Target For Bitcoin In 2030',
    url: 'https://www.ark-invest.com/articles/valuation-models/arks-bitcoin-price-target-2030',
    published: '2025-04-24',
    dataAsOf: '2024-12-31',
    type: 'analyst_valuation_model',
    currency: 'USD',
    targetYear: 2030,
    cases: { bear: 300_000, base: 710_000, bull: 1_500_000 },
    approximate: true, // ARK publishes "~$300,000, ~$710,000, and ~$1.5 million"
    assumptions: 'Bitcoin draws on six sources of capital accrual by 2030; mainly "digital gold" (bear and base) and institutional investment of 1%, 2.5% and 6.5% of a ~$200 trillion global portfolio (bear, base, bull). ARK states the targets may not be reached if these assumptions fail.',
    growthFactors: ['More institutional investment (ARK\'s largest bull-case driver)', 'Demand as "digital gold" (ARK\'s largest bear- and base-case driver)'],
  },
  {
    coinId: 'ethereum',
    publisher: 'VanEck',
    authors: 'Matthew Sigel, Patrick Bush, Denis Zinoviev',
    title: 'ETH 2030 Price Target and Optimal Portfolio Allocations',
    url: 'https://www.vaneck.com/us/en/blogs/digital-assets/matthew-sigel-eth-2030-price-target/',
    published: '2024-06-05',
    dataAsOf: '2024-05-28',
    type: 'analyst_valuation_model',
    currency: 'USD',
    targetYear: 2030,
    cases: { bear: 360, base: 22_000, bull: 154_000 },
    assumptions: 'Ethereum keeps 70% of smart-contract activity in the base case (90% bull, 15% bear); 2030 cash flow to ETH holders valued at 33x (50x bull, 20x bear). VanEck notes it holds ETH and that the scenarios are not a projection of how ETH will perform.',
    growthFactors: ['Ethereum keeping most smart-contract applications (VanEck base case: 70% share)', 'Fees earned from applications built on Ethereum'],
  },
  {
    coinId: 'solana',
    publisher: 'VanEck',
    authors: 'Patrick Bush, Matthew Sigel',
    title: 'VanEck’s Base, Bear, Bull Case: Solana Valuation by 2030',
    url: 'https://www.vaneck.com/us/en/blogs/digital-assets/matthew-sigel-vanecks-base-bear-bull-case-solana-valuation-by-2030/',
    published: '2023-10-27',
    dataAsOf: null,
    type: 'analyst_valuation_model',
    currency: 'USD',
    targetYear: 2030,
    cases: { bear: 9.81, base: 335, bull: 3211.28 },
    assumptions: 'Solana hosts the first app with 100M+ users; SOL earns about 20% of Ethereum\'s take rate and wins less than half of Ethereum\'s market share; the bull case assumes Ethereum-like dominance. VanEck notes it may hold the asset.',
    growthFactors: ['Hosting a consumer app with 100M+ users (VanEck\'s scenario)', 'Winning a larger share of blockchain activity (VanEck bull case)'],
  },
];

/** Problems that make an entry unusable (empty = valid). */
export function forecastProblems(f: Forecast, now: Date): string[] {
  const p: string[] = [];
  if (!f.coinId || !f.publisher || !f.title || !f.assumptions) p.push('missing coin, publisher, title or assumptions');
  try {
    const u = new URL(f.url);
    if (u.protocol !== 'https:') p.push('link must be https');
  } catch {
    p.push('link is not a valid URL');
  }
  const t = Date.parse(`${f.published}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.published) || Number.isNaN(t)) p.push('publication date is invalid');
  else if (t > now.getTime()) p.push('publication date is in the future');
  if (f.currency !== 'USD') p.push('currency must be USD');
  if (f.targetYear !== 2030) p.push('target year must be 2030');
  const vals = [f.cases.bear, f.cases.base, f.cases.bull].filter((v) => v !== undefined);
  if (vals.length === 0) p.push('no published figure');
  if (vals.some((v) => !(typeof v === 'number' && Number.isFinite(v) && v > 0))) p.push('figures must be positive numbers');
  const ordered = vals.every((v, i) => i === 0 || (v as number) >= (vals[i - 1] as number));
  if (!ordered) p.push('bear, base and bull must be in increasing order');
  return p;
}

/** Valid forecasts on file for one coin (invalid entries are left out, never repaired). */
export function forecastsFor(coinId: string, now: Date, list: readonly Forecast[] = FORECASTS): Forecast[] {
  return list.filter((f) => f.coinId === coinId && forecastProblems(f, now).length === 0);
}
