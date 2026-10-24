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
