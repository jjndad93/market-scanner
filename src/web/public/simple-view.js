// Plain-English wording shown in place in the original dashboard layout: one sentence per CoinMarketCap
// cross-check result, and the crypto scan's coverage explained from the figures the scan returned.
// Shared by the browser and the Node tests. Pure: it only rewords and counts what the scan and the
// cross-check already produced; it never computes a score, a price or a new signal.
// (Research-lead explanations are produced by the scan itself: src/scanner/lead-quality.ts.)

// ---- CoinMarketCap warnings on a research lead --------------------------------------------------------
// Only a lookup: the server's cross-check already decided each warning (src/scanner/cross-check.ts).
// A result belongs to a lead only by the lead's unique CoinGecko id, and only when the cross-check was
// run on the scan being shown. No result (cross-check not run, or another scan) means no warning and no
// claim either way.

export function leadCrossCheckWarnings(entry, cmcData, scanEvaluatedAt) {
  if (!entry || !cmcData || !Array.isArray(cmcData.results)) return [];
  if (!scanEvaluatedAt || cmcData.scanEvaluatedAt !== scanEvaluatedAt) return [];
  const matches = cmcData.results.filter((x) => x.id === entry.id);
  if (matches.length !== 1) return []; // never guess between several results for one id
  return Array.isArray(matches[0].warnings) ? matches[0].warnings : [];
}

// ---- dashboard wording for CLI instructions ---------------------------------------------------------
// The scan's messages are shared with the CLI and name its --max-requests flag. On the dashboard the
// same limit is the "Max API requests" field, so the instruction is reworded where it is shown.

export function dashboardWording(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/a larger --max-requests/g, 'a larger "Max API requests" value')
    .replace(/a smaller --max-requests/g, 'a smaller "Max API requests" value')
    .replace(/--max-requests/g, 'the "Max API requests" field');
}

// ---- crypto scan coverage ------------------------------------------------------------------------------
// Three different reasons an asset in the snapshot was not evaluated; they are never combined:
// - budget_skipped: passed every filter that does not need history, but history requests stopped
//   (request limit or rate limit) before reaching it. Not rejected by any rule.
// - data: missing, stale, implausible or invalid data, history too short or unreliable, or a failed
//   history request.
// - rule: outside the scanner's scope or eligibility rules (stablecoins, wrapped or staked tokens, size
//   or volume minimums, duplicates). An asset with a rule reason counts here even if its data is also poor.

const RULE_CODES = new Set(['stablecoin', 'possible_stablecoin', 'wrapped_or_staked', 'below_market_cap', 'below_volume', 'duplicate_record', 'duplicate_conflict']);

/** The category of one excluded asset, from all of its reasons. */
export function exclusionGroup(reasons) {
  const codes = (reasons ?? []).map((r) => r.code);
  if (codes.includes('history_not_requested')) return 'budget_skipped';
  if (codes.some((c) => RULE_CODES.has(c))) return 'rule';
  return 'data';
}

/** Counts of excluded assets per category. */
export function exclusionBreakdown(excluded) {
  const counts = { budget_skipped: 0, data: 0, rule: 0 };
  for (const e of excluded ?? []) counts[exclusionGroup(e.reasons)]++;
  return counts;
}

/**
 * The coverage figures of a live crypto scan, from what the scan returned, or null when the scan has
 * no history coverage (offline fixture). `additionalHistoryRequests` is one request per eligible asset
 * whose history was not requested: CoinGecko returns one asset's history per request, and assets whose
 * history was already obtained (fetched or cached) are not counted again.
 */
export function coverageFigures(result) {
  const cov = result?.dataset?.coverage;
  if (!cov) return null;
  return {
    snapshot: result.universe,
    passedNonHistoryFilters: cov.historyEligible,
    historiesObtained: cov.historyFetched,
    fromCache: cov.historyFromCache,
    evaluated: result.passedFilters,
    // History obtained, but the asset still failed a check (too short or unreliable history, or data
    // that went stale before evaluation). The result does not say which assets' history was fetched,
    // so the reason is not split here; the excluded list shows each asset's reasons.
    obtainedNotEvaluated: Math.max(0, cov.historyFetched - result.passedFilters),
    notRequested: cov.historyNotRequested,
    requestFailed: cov.historyRequestFailed,
    additionalHistoryRequests: cov.historyNotRequested,
    stopReason: cov.stopReason,
    complete: cov.complete,
  };
}

const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

/** Plain-English coverage sentences for the dashboard, from coverageFigures(). */
export function coverageSentences(f) {
  if (!f) return [];
  const out = [
    `${n(f.snapshot, 'asset was', 'assets were')} in the market snapshot; ${f.passedNonHistoryFilters} passed the filters that do not need trading history.`,
    `${n(f.evaluated, 'was', 'were')} evaluated against ${f.evaluated === 1 ? 'its' : 'their'} own trading history${f.fromCache > 0 ? ` (${n(f.fromCache, 'history was', 'histories were')} reused from today's cache, with no request)` : ''}.`,
  ];
  if (f.obtainedNotEvaluated > 0) out.push(`${n(f.obtainedNotEvaluated, 'other asset', 'other assets')} had ${f.obtainedNotEvaluated === 1 ? 'its' : 'their'} history obtained but could not be evaluated (history too short or unreliable, or another data problem; see the excluded list).`);
  if (f.requestFailed > 0) out.push(`${n(f.requestFailed, 'history request', 'history requests')} failed, so ${f.requestFailed === 1 ? 'that asset was' : 'those assets were'} not evaluated.`);
  if (f.notRequested > 0) {
    out.push(`${n(f.notRequested, 'eligible asset was', 'eligible assets were')} not evaluated because history requests stopped before reaching ${f.notRequested === 1 ? 'it' : 'them'}${f.stopReason ? ` (${f.stopReason})` : ''}: skipped, not rejected by the scanner's rules.`);
    out.push(`Based on this scan's snapshot, evaluating ${f.notRequested === 1 ? 'it' : 'them'} would take about ${n(f.additionalHistoryRequests, 'more history request', 'more history requests')} (one per asset), plus one for the market list; a later snapshot may list different assets.`);
    out.push('A rerun on the same UTC day reuses the histories already fetched today, so it can evaluate more assets without repeating those requests. Histories from earlier UTC days are never reused.');
  } else if (f.requestFailed === 0) {
    out.push('Every eligible asset\'s history was obtained.');
  }
  return out;
}

// "Matched" means the same asset was identified on both sides. Whether the VALUES agree is a separate
// question; a value missing on either side "could not be compared", never agreement or disagreement.

const compared = (x) => [x.price, x.marketCap].filter((v) => v.agrees !== null);
const disagrees = (x) => x.match.status === 'matched' && compared(x).some((v) => v.agrees === false);
const FIELD = { price: 'price', marketCap: 'market cap' };

/** One plain sentence for one comparison result. */
export function plainCheck(x) {
  const m = x.match.status;
  if (m === 'ambiguous') return { text: 'This asset could not be matched confidently: several CoinMarketCap coins share its name and symbol.' };
  if (m === 'unmatched') return { text: `This asset could not be matched confidently: on CoinMarketCap the symbol ${x.symbol} belongs to a differently named coin.` };
  if (m === 'not_found') return { text: 'Not in CoinMarketCap\'s top 500, so it was not compared.' };
  const missing = ['price', 'marketCap'].filter((k) => x[k].agrees === null).map((k) => FIELD[k]);
  if (disagrees(x)) {
    const parts = ['price', 'marketCap'].filter((k) => x[k].agrees === false).map((k) => `${FIELD[k]} differs by ${Math.abs(x[k].diffPct).toFixed(1)}%`);
    const extra = missing.length ? ` The ${missing[0]} could not be compared (missing on one side).` : '';
    return { text: `The two data sources disagree: ${parts.join(', ')}.${extra}` };
  }
  if (missing.length === 2) return { text: 'Same asset found, but price and market cap could not be compared (missing on one side).' };
  if (missing.length === 1) {
    const ok = ['price', 'marketCap'].find((k) => x[k].agrees === true);
    return { text: `Same asset; the ${FIELD[ok]} agrees, but the ${missing[0]} could not be compared (missing on one side).` };
  }
  return { text: 'Same asset; both sources show a similar price and market cap.' };
}

// ---- crypto project profile ("About this crypto") ------------------------------------------------------
// Pure formatting of what /coins/{id} returned and the existing asset view already shows. Context
// signals are evidence to look into, never a verdict: each says what it does NOT imply.

const big = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0));

/** "660M circulating of 1B max (66%)", or what is known. */
export function supplyText(p) {
  if (!p || p.circulatingSupply === null) return 'Not available';
  if (p.maxSupply === null) return `${big(p.circulatingSupply)} circulating; no maximum supply is listed`;
  return `${big(p.circulatingSupply)} circulating of ${big(p.maxSupply)} max (${Math.round(p.circulatingSupply / p.maxSupply * 100)}%)`;
}

/** Thresholds for showing a context signal (presentation heuristics, not risk scores). */
export const CONTEXT_RULES = { unissuedSharePct: 20, rankAbove: 250, belowAthPct: 80, turnoverBelowPct: 1 };

/** Evidence-based context lines (main risks to check), from the profile and the asset view. */
export function profileContext(p, asset) {
  const out = [];
  if (!p) return out;
  if (p.maxSupply !== null && p.circulatingSupply !== null && p.maxSupply > 0) {
    const unissued = (1 - p.circulatingSupply / p.maxSupply) * 100;
    if (unissued >= CONTEXT_RULES.unissuedSharePct) out.push(`${Math.round(unissued)}% of the maximum supply is not yet circulating. New supply can add selling pressure; check the release schedule.`);
  }
  if ((p.categories ?? []).some((c) => /\bmeme\b/i.test(c))) out.push('CoinGecko lists it as a meme coin. Such tokens are usually driven by attention rather than revenue.');
  const vol = asset?.volume24h?.value ?? null;
  const cap = asset?.marketCap?.value ?? null;
  if (vol !== null && cap !== null && cap > 0 && vol / cap * 100 < CONTEXT_RULES.turnoverBelowPct) {
    out.push(`Daily trading is about ${(vol / cap * 100).toFixed(1)}% of its market cap, so large orders may move the price.`);
  }
  if (p.marketCapRank !== null && p.marketCapRank > CONTEXT_RULES.rankAbove) out.push(`Ranked #${p.marketCapRank} by market cap. Smaller assets often trade less and swing more; rank alone says nothing about quality.`);
  if (p.athChangePct !== null && p.athChangePct <= -CONTEXT_RULES.belowAthPct) out.push(`${Math.round(Math.abs(p.athChangePct))}% below its all-time high. This shows past volatility; it does not mean it will or will not recover.`);
  return out.slice(0, 3);
}

// ---- 2030 outlook ----------------------------------------------------------------------------------------
// Curated, sourced entries only (src/web/forecasts.ts). Each source is shown on its own; nothing is
// averaged. The implied change uses one stated reference price (the current CoinGecko USD price).

export const DATED_AFTER_MONTHS = 18;
const CASES = ['bear', 'base', 'bull'];

export function impliedChangePct(target, reference) {
  if (!(typeof target === 'number' && target > 0) || !(typeof reference === 'number' && Number.isFinite(reference) && reference > 0)) return null;
  return (target - reference) / reference * 100;
}

/** Everything the 2030 outlook block shows, computed from the entries and a reference price. */
export function outlookView(forecasts, referencePrice, referenceAsOf, now) {
  const list = Array.isArray(forecasts) ? forecasts : [];
  if (list.length === 0) return { status: 'none', message: 'No credible, comparable 2030 forecast is on file for this asset.', entries: [], disagreement: null, reference: null };
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const entries = list.map((f) => {
    const ageMonths = Math.floor((nowMs - Date.parse(`${f.published}T00:00:00Z`)) / (30.44 * 86_400_000));
    return {
      ...f,
      ageMonths,
      dated: ageMonths > DATED_AFTER_MONTHS,
      figures: CASES.filter((k) => typeof f.cases?.[k] === 'number').map((k) => ({ case: k, value: f.cases[k], impliedPct: impliedChangePct(f.cases[k], referencePrice) })),
    };
  });
  const bases = entries.map((e) => e.cases?.base).filter((v) => typeof v === 'number');
  const disagreement = bases.length > 1 && Math.max(...bases) / Math.min(...bases) > 2
    ? `Sources disagree widely: base cases range from $${Math.min(...bases).toLocaleString()} to $${Math.max(...bases).toLocaleString()}.`
    : null;
  const reference = typeof referencePrice === 'number' && referencePrice > 0 ? { price: referencePrice, asOf: referenceAsOf ?? null } : null;
  return { status: list.length === 1 ? 'one' : 'several', message: list.length === 1 ? 'One source\'s estimate, not a consensus.' : `${list.length} separate sources; not averaged.`, entries, disagreement, reference };
}
