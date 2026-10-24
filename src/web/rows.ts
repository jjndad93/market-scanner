/**
 * Dashboard rows: one row per asset the scanner EVALUATED (passed every filter), in the scanner's
 * own order: qualified candidates by rank, then over-display-limit, below-threshold, and assets
 * that matched no pattern. Built only from the scan result; no value is invented. Budget filtering
 * happens afterwards (public/budget.js) and never changes this order or any score.
 */

import { has } from '../core/evidence.ts';
import { nyWallTimeToUtc } from '../core/time.ts';
import type { Direction, MoveContext } from '../news/assess.ts';
import { RISK_FLAGS } from '../scanner/insights.ts';
import { SCAN_RULES } from '../scanner/rules.ts';
import { STOCK_RULES } from '../stocks/rules.ts';
import { type Classification, type CryptoRisk, classifyCrypto, cryptoRisk } from '../scanner/insights.ts';
import type { Candidate, ScanResult } from '../scanner/types.ts';
import type { StockCandidate, StockMetrics, StockScanResult, StockSnapshot } from '../stocks/types.ts';

export interface StockRisk {
  period: string;
  change1dPct: number;
  change5dPct: number | null;
  sessionDate: string;
  dollarVolume: number;
  flags: string[];
  unavailable: string[];
}

export interface DashboardRow {
  key: string;
  market: 'crypto' | 'stocks';
  name: string;
  symbol: string;
  id: string;
  /** USD per unit, or null when the source gave none. */
  unitPrice: number | null;
  /** When that price applies (provider update time, or the session close). */
  priceAsOf: string | null;
  priceBasis: string;
  dataKind: 'test_data' | 'verified_market_data';
  signal: { status: 'qualified' | 'over_display_limit' | 'below_threshold' | 'no_pattern'; category: 'Mover' | 'Watchlist' | null; score: number | null; maxScore: number | null; order: number };
  volumeMultiple: number | null;
  volumeUsd: number | null;
  change: { short: { label: string; value: number | null }; long: { label: string; value: number | null } };
  classification: Classification | null;
  risk: CryptoRisk | StockRisk;
  /** Scanner risk notes and data warnings, for display. */
  warnings: string[];
  /** The score breakdown ("why"), empty for assets that matched no pattern. */
  why: string[];
  /** The observed move, for the news panel ("Why it may be moving"); null without a usable time. */
  move: MoveContext | null;
}

const HOUR = 3_600_000;
/** Below this absolute short-period change the asset is described as roughly flat. */
export const FLAT_PCT = { crypto: 1, stocks: 0.5 };
const direction = (pct: number | null, flat: number): Direction => (pct === null || Math.abs(pct) < flat ? 'flat' : pct > 0 ? 'rising' : 'falling');

function cryptoMove(a: Candidate['asset'], risk: CryptoRisk): MoveContext | null {
  if (!has(a.lastUpdated)) return null;
  const end = Date.parse(a.lastUpdated.value);
  const pct = risk.change24hPct;
  return {
    market: 'crypto', symbol: a.symbol, name: a.name, changePct: pct, direction: direction(pct, FLAT_PCT.crypto),
    significant: pct !== null && Math.abs(pct) >= SCAN_RULES.moverMinAbsMovePct,
    volatile: (risk.range24hPct ?? 0) >= RISK_FLAGS.extremeRange24hPct || (risk.fromHigh24hPct ?? 0) <= -RISK_FLAGS.dropFromHigh24hPct,
    windowStart: new Date(end - 24 * HOUR).toISOString(), windowEnd: new Date(end).toISOString(),
    windowLabel: "the rolling 24 hours to the provider's last update", leadMs: 24 * HOUR,
  };
}

/** Close-to-close window of the latest session (16:00 ET on each date); the bars are end of day. */
function stockMove(s: StockSnapshot, m: StockMetrics): MoveContext | null {
  const prev = s.bars.filter((b) => b.date < m.lastDate).at(-1)?.date;
  if (prev === undefined) return null;
  return {
    market: 'stocks', symbol: s.symbol, name: s.name, changePct: m.change1dPct, direction: direction(m.change1dPct, FLAT_PCT.stocks),
    significant: Math.abs(m.change1dPct) >= STOCK_RULES.moverMinAbsMovePct,
    volatile: false, // no intraday range in end-of-day bars
    windowStart: nyWallTimeToUtc(prev, 16, 0).toISOString(), windowEnd: nyWallTimeToUtc(m.lastDate, 16, 0).toISOString(),
    windowLabel: `the latest session (close ${prev} to close ${m.lastDate}, 4 pm ET)`, leadMs: 72 * HOUR,
  };
}

const kindLabel = (k: string) => (k === 'mover' ? 'Mover' : 'Watchlist');

export function cryptoRows(r: ScanResult, now: Date): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const add = (c: Candidate | null, a: Candidate['asset'], status: DashboardRow['signal']['status']) => {
    const risk = cryptoRisk(a, now, c?.volumeReliability);
    rows.push({
      key: `crypto:${a.id}`, market: 'crypto', name: a.name, symbol: a.symbol, id: a.id,
      unitPrice: has(a.price) ? a.price.value : null,
      priceAsOf: has(a.lastUpdated) ? a.lastUpdated.value : null,
      priceBasis: 'provider price at its last update (not a live exchange quote)',
      dataKind: a.price.kind === 'test_data' ? 'test_data' : 'verified_market_data',
      signal: { status, category: c ? kindLabel(c.kind) : null, score: c?.score ?? null, maxScore: c?.maxScore ?? null, order: rows.length },
      volumeMultiple: c?.metrics.relativeVolume.value ?? null,
      volumeUsd: has(a.volume24h) ? a.volume24h.value : null,
      change: { short: { label: '24h', value: risk.change24hPct }, long: { label: '7d', value: risk.change7dPct } },
      classification: classifyCrypto(a),
      risk,
      warnings: [...(c?.risks ?? []), ...risk.flags],
      why: c ? c.breakdown.map((p) => `${p.rule} ${p.points}/${p.max}: ${p.detail}`) : [],
      move: cryptoMove(a, risk),
    });
  };
  for (const c of r.movers) add(c, c.asset, 'qualified');
  for (const c of r.watchlist) add(c, c.asset, 'qualified');
  for (const c of [...r.moversOverLimit, ...r.watchlistOverLimit]) add(c, c.asset, 'over_display_limit');
  for (const c of r.belowThreshold) add(c, c.asset, 'below_threshold');
  for (const a of r.noPattern ?? []) add(null, a, 'no_pattern');
  return rows;
}

function stockRisk(m: StockMetrics): StockRisk {
  return {
    period: 'latest completed session (end of day) and the 5 sessions before it',
    change1dPct: m.change1dPct, change5dPct: m.change5dPct, sessionDate: m.lastDate, dollarVolume: m.dollarVolume,
    flags: [],
    unavailable: [
      'intraday high-to-low range and drawdown from the session high: the scanner keeps only daily closes (the provider bars include high and low, not parsed yet)',
      'bid/ask spread: not in end-of-day bars',
    ],
  };
}

export function stockRows(r: StockScanResult): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const add = (c: StockCandidate | null, s: StockSnapshot, m: StockMetrics, status: DashboardRow['signal']['status']) => {
    rows.push({
      key: `stocks:${s.symbol}`, market: 'stocks', name: s.name, symbol: s.symbol, id: s.symbol,
      unitPrice: m.close,
      priceAsOf: m.lastDate,
      priceBasis: `latest completed session close on ${m.lastDate} (end of day, not a live quote)`,
      dataKind: s.dataKind === 'test_data' ? 'test_data' : 'verified_market_data',
      signal: { status, category: c ? kindLabel(c.kind) : null, score: c?.score ?? null, maxScore: c?.maxScore ?? null, order: rows.length },
      volumeMultiple: m.relativeVolume,
      volumeUsd: m.dollarVolume,
      change: { short: { label: '1d', value: m.change1dPct }, long: { label: '5d', value: m.change5dPct } },
      classification: null,
      risk: stockRisk(m),
      warnings: c?.risks ?? [],
      why: c ? c.breakdown.map((p) => `${p.rule} ${p.points}/${p.max}: ${p.detail}`) : [],
      move: stockMove(s, m),
    });
  };
  for (const c of [...r.movers, ...r.watchlist]) add(c, c.stock, c.metrics, 'qualified');
  for (const c of r.overLimit) add(c, c.stock, c.metrics, 'over_display_limit');
  for (const c of r.belowThreshold) add(c, c.stock, c.metrics, 'below_threshold');
  for (const n of r.noPattern ?? []) add(null, n.stock, n.metrics, 'no_pattern');
  return rows;
}

/** What the current data cannot show, per market (displayed with every result). */
export const LIMITATIONS = {
  crypto: [
    "The scan itself assigns no meme-coin or project/utility categories: the CoinGecko market list has no category field. The optional CoinMarketCap cross-check shows CMC's own tags for matched research leads, as provider evidence only.",
    'Volatility uses CoinGecko\'s rolling 24h high and low, 7-day change and all-time high. There is no intraday price series and no bid/ask spread.',
  ],
  stocks: [
    'Prices are the latest end-of-day close, not a live quote. Intraday range is not shown yet (the bars\' high and low are not parsed).',
    'No asset-category classification for stocks; all are from the fixed list of large US stocks.',
  ],
};
