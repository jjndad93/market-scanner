/**
 * Second-source checks for the crypto scan's research leads (Stage A, CoinMarketCap). Pure: no
 * network. Informational only: never changes scores, tiers, filters or eligibility.
 *
 * Matching is conservative because symbols are not unique on either provider:
 * - candidates are CMC records with the same symbol;
 * - a candidate is CONFIRMED only if its name matches the lead's name (case, spaces and
 *   punctuation ignored) or its CMC slug equals the CoinGecko id;
 * - exactly one confirmed candidate -> matched; several -> ambiguous; none -> unmatched;
 *   no same-symbol record at all -> not found. A symbol alone never matches.
 */

import type { CmcRecord } from '../providers/coinmarketcap.ts';
import type { DiscoveryEntry, DiscoveryTier } from './types.ts';

/** Agreement tolerances (heuristics): providers aggregate different markets and supply figures. */
export const CROSS_CHECK_TOLERANCE = { pricePct: 2, marketCapPct: 10, maxSnapshotGapMinutes: 30 };

/**
 * CMC tag slugs mapped to this project's category labels. The slugs are ASSUMED from CMC's site
 * vocabulary and must be confirmed on the first live response; unknown tags are shown raw only.
 */
export const CMC_TAG_CATEGORY: Record<string, 'meme' | 'stablecoin'> = { memes: 'meme', stablecoin: 'stablecoin' };

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'not_found';
export interface ValueCheck { coingecko: number | null; coinmarketcap: number | null; diffPct: number | null; agrees: boolean | null }
export interface LeadCrossCheck {
  id: string;
  symbol: string;
  name: string;
  tier: DiscoveryTier;
  match: {
    status: MatchStatus;
    /** How a match was confirmed: name, slug, or both. */
    basis: 'name' | 'slug' | 'name_and_slug' | null;
    cmc: { id: number; name: string; slug: string | null; rank: number | null } | null;
    /** Same-symbol CMC records that were not (or not uniquely) confirmed. */
    candidates: { id: number; name: string; slug: string | null }[];
  };
  price: ValueCheck;
  marketCap: ValueCheck;
  verdict: 'agrees' | 'differs' | 'partial' | 'not_compared';
  notes: string[];
  /** CMC tag slugs (provider evidence), and a category derived from a known tag, if any. */
  tags: string[];
  providerCategory: { category: 'meme' | 'stablecoin'; tag: string } | null;
  /**
   * Phase 2: plain-English warnings for the research lead, derived only from this result's own
   * verdicts and the tolerances above (no other rule). Empty when the values agree.
   */
  warnings: CrossCheckWarning[];
}

export type CrossCheckWarningCode = 'cmc_uncertain_match' | 'cmc_not_listed' | 'cmc_price_differs' | 'cmc_market_cap_differs' | 'cmc_value_missing' | 'cmc_snapshots_far_apart';
export interface CrossCheckWarning { code: CrossCheckWarningCode; text: string }

/** Wording per warning, in display order: identity first, then values, then timing. */
export const CROSS_CHECK_WARNING_TEXT: Record<Exclude<CrossCheckWarningCode, 'cmc_value_missing'>, string> = {
  cmc_uncertain_match: 'This asset could not be matched confidently on CoinMarketCap, so the sources were not compared.',
  cmc_not_listed: 'CoinMarketCap\'s top 500 does not list this asset, so the sources were not compared.',
  cmc_price_differs: 'CoinMarketCap and CoinGecko show different prices.',
  cmc_market_cap_differs: 'The reported market values differ between the two sources.',
  cmc_snapshots_far_apart: 'The source snapshots are too far apart in time for a reliable comparison.',
};
const missingText = (fields: string[]) => `The sources could not be compared because data is missing (${fields.join(' and ')}).`;

export const normalizeName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export function matchLead(lead: Pick<DiscoveryEntry, 'id' | 'symbol' | 'name'>, records: readonly CmcRecord[]): LeadCrossCheck['match'] & { record: CmcRecord | null } {
  const sameSymbol = records.filter((r) => r.symbol === lead.symbol.toUpperCase());
  const brief = (r: CmcRecord) => ({ id: r.id, name: r.name, slug: r.slug });
  if (sameSymbol.length === 0) return { status: 'not_found', basis: null, cmc: null, candidates: [], record: null };
  const confirmed = sameSymbol
    .map((r) => ({ r, byName: normalizeName(r.name) === normalizeName(lead.name) && normalizeName(lead.name) !== '', bySlug: r.slug !== null && r.slug === lead.id }))
    .filter((x) => x.byName || x.bySlug);
  if (confirmed.length === 1) {
    const { r, byName, bySlug } = confirmed[0]!;
    return {
      status: 'matched', basis: byName && bySlug ? 'name_and_slug' : byName ? 'name' : 'slug',
      cmc: { id: r.id, name: r.name, slug: r.slug, rank: r.rank }, candidates: sameSymbol.filter((x) => x !== r).map(brief), record: r,
    };
  }
  return { status: confirmed.length > 1 ? 'ambiguous' : 'unmatched', basis: null, cmc: null, candidates: (confirmed.length > 1 ? confirmed.map((x) => x.r) : sameSymbol).map(brief), record: null };
}

function compare(cg: number | null, cmc: number | null, tolerancePct: number): ValueCheck {
  if (cg === null || cmc === null || cg <= 0) return { coingecko: cg, coinmarketcap: cmc, diffPct: null, agrees: null };
  const diffPct = (cmc - cg) / cg * 100;
  return { coingecko: cg, coinmarketcap: cmc, diffPct, agrees: Math.abs(diffPct) <= tolerancePct };
}

export function crossCheckLead(lead: DiscoveryEntry, records: readonly CmcRecord[]): LeadCrossCheck {
  const m = matchLead(lead, records);
  const { record, ...match } = m;
  const notes: string[] = [];
  const none: ValueCheck = { coingecko: null, coinmarketcap: null, diffPct: null, agrees: null };
  if (!record) {
    notes.push(m.status === 'not_found'
      ? 'No coin with this symbol in CoinMarketCap\'s top 500 listing: not compared.'
      : m.status === 'ambiguous'
        ? `${m.candidates.length} CoinMarketCap coins share this symbol and name: no automatic match, not compared.`
        : `CoinMarketCap lists ${m.candidates.length} coin(s) with this symbol under a different name: not treated as the same asset, not compared.`);
    const code = m.status === 'not_found' ? 'cmc_not_listed' : 'cmc_uncertain_match';
    return {
      id: lead.id, symbol: lead.symbol, name: lead.name, tier: lead.tier, match, price: { ...none, coingecko: lead.price }, marketCap: { ...none, coingecko: lead.marketCap },
      verdict: 'not_compared', notes, tags: [], providerCategory: null, warnings: [{ code, text: CROSS_CHECK_WARNING_TEXT[code] }],
    };
  }
  const price = compare(lead.price, record.price, CROSS_CHECK_TOLERANCE.pricePct);
  const marketCap = compare(lead.marketCap, record.marketCap, CROSS_CHECK_TOLERANCE.marketCapPct);
  const checks = [price.agrees, marketCap.agrees].filter((a): a is boolean => a !== null);
  const verdict: LeadCrossCheck['verdict'] = checks.length === 0 ? 'not_compared' : checks.includes(false) ? 'differs' : checks.length === 2 ? 'agrees' : 'partial';
  if (price.agrees === null) notes.push('Price not compared: missing on one side.');
  if (marketCap.agrees === null) notes.push('Market cap not compared: missing on one side.');
  if (price.agrees === false) notes.push(`Prices differ by ${Math.abs(price.diffPct!).toFixed(1)}% (tolerance ${CROSS_CHECK_TOLERANCE.pricePct}%): check the data before relying on either.`);
  if (marketCap.agrees === false) notes.push(`Market caps differ by ${Math.abs(marketCap.diffPct!).toFixed(1)}% (tolerance ${CROSS_CHECK_TOLERANCE.marketCapPct}%; supply figures can differ between providers).`);
  let farApart = false;
  if (lead.lastUpdated && record.lastUpdated) {
    const gap = Math.abs(Date.parse(record.lastUpdated) - Date.parse(lead.lastUpdated)) / 60_000;
    farApart = gap > CROSS_CHECK_TOLERANCE.maxSnapshotGapMinutes;
    if (farApart) notes.push(`The two snapshots are ${Math.round(gap)} minutes apart; differences may reflect timing.`);
  }
  if (m.candidates.length > 0) notes.push(`${m.candidates.length} other CoinMarketCap coin(s) share the symbol ${lead.symbol}; matched by ${match.basis === 'slug' ? 'slug' : 'name'}.`);
  // The same verdicts as above, as lead warnings. Agreement creates none; a missing value is never agreement.
  const warnings: CrossCheckWarning[] = [];
  if (price.agrees === false) warnings.push({ code: 'cmc_price_differs', text: CROSS_CHECK_WARNING_TEXT.cmc_price_differs });
  if (marketCap.agrees === false) warnings.push({ code: 'cmc_market_cap_differs', text: CROSS_CHECK_WARNING_TEXT.cmc_market_cap_differs });
  const missing = [price.agrees === null ? 'price' : null, marketCap.agrees === null ? 'market cap' : null].filter((f): f is string => f !== null);
  if (missing.length > 0) warnings.push({ code: 'cmc_value_missing', text: missingText(missing) });
  if (farApart) warnings.push({ code: 'cmc_snapshots_far_apart', text: CROSS_CHECK_WARNING_TEXT.cmc_snapshots_far_apart });
  const known = record.tags.find((t) => Object.hasOwn(CMC_TAG_CATEGORY, t));
  return {
    id: lead.id, symbol: lead.symbol, name: lead.name, tier: lead.tier, match, price, marketCap, verdict, notes,
    tags: record.tags.slice(0, 12), providerCategory: known ? { category: CMC_TAG_CATEGORY[known]!, tag: known } : null, warnings,
  };
}

/** Cross-checks every research lead, in tier order. */
export function crossCheckLeads(leads: readonly DiscoveryEntry[], records: readonly CmcRecord[]) {
  const results = leads.map((l) => crossCheckLead(l, records));
  const count = (f: (r: LeadCrossCheck) => boolean) => results.filter(f).length;
  return {
    results,
    summary: {
      leads: results.length,
      matched: count((r) => r.match.status === 'matched'),
      ambiguous: count((r) => r.match.status === 'ambiguous'),
      unmatched: count((r) => r.match.status === 'unmatched'),
      notFound: count((r) => r.match.status === 'not_found'),
      agrees: count((r) => r.verdict === 'agrees'),
      differs: count((r) => r.verdict === 'differs'),
    },
  };
}
