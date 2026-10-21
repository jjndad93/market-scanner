import type { Bar, StockDatasetMeta, StockExclusion, StockSnapshot } from './types.ts';

export interface NormalizedStockDataset {
  dataset: StockDatasetMeta;
  stocks: StockSnapshot[];
  /** Records too malformed to evaluate (no usable symbol). */
  invalid: StockExclusion[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Validates a stock dataset. A "synthetic" dataset is TEST DATA; a "live" one was fetched by
 * this tool from the named provider. Nothing is invented: malformed bars are counted and
 * dropped, and a stock without usable bars stays without them.
 */
export function normalizeStockDataset(input: unknown): NormalizedStockDataset {
  if (!isRecord(input) || !isRecord(input.dataset)) throw new Error('Dataset must be an object with a "dataset" header.');
  const d = input.dataset;
  if (d.kind !== 'synthetic' && d.kind !== 'live') throw new Error(`Unknown dataset kind "${String(d.kind)}"; expected "synthetic" or "live".`);
  if (!isText(d.label) || !isText(d.source) || !isText(d.asOf) || Number.isNaN(Date.parse(d.asOf))) {
    throw new Error('Dataset header needs a label, a source and a valid ISO "asOf" timestamp.');
  }
  if (d.notes !== undefined && (!Array.isArray(d.notes) || !d.notes.every(isText))) throw new Error('Dataset "notes" must be an array of text.');
  if (!Array.isArray(input.stocks)) throw new Error('Dataset must contain a "stocks" array.');

  const dataset: StockDatasetMeta = { kind: d.kind, label: d.label, source: d.source, asOf: new Date(d.asOf).toISOString() };
  if (d.kind === 'live') {
    if (isText(d.attribution)) dataset.attribution = d.attribution;
    if (Array.isArray(d.notes)) dataset.notes = [...(d.notes as string[])];
  }

  const stocks: StockSnapshot[] = [];
  const invalid: StockExclusion[] = [];
  for (const raw of input.stocks as unknown[]) {
    if (!isRecord(raw) || !isText(raw.symbol)) {
      invalid.push({ symbol: '?', reasons: [{ code: 'invalid_record', detail: 'record lacks a usable symbol' }] });
      continue;
    }
    const symbol = raw.symbol.trim().toUpperCase();
    if (raw.historyStatus !== undefined) {
      if (d.kind !== 'live') throw new Error(`Stock "${symbol}": only a live dataset may set "historyStatus".`);
      if (raw.historyStatus !== 'not_requested' && raw.historyStatus !== 'request_failed') throw new Error(`Stock "${symbol}": unknown historyStatus.`);
    }

    // One bar per date. Identical repeats collapse; conflicting ones are all dropped and counted.
    const byDate = new Map<string, Bar | null>();
    let invalidBars = 0;
    for (const b of Array.isArray(raw.bars) ? raw.bars : []) {
      const ok = isRecord(b) && isIsoDate(b.date) && typeof b.close === 'number' && Number.isFinite(b.close) && b.close > 0
        && typeof b.volume === 'number' && Number.isFinite(b.volume) && b.volume >= 0;
      if (!ok) {
        invalidBars++;
        continue;
      }
      const bar: Bar = { date: b.date as string, close: b.close as number, volume: b.volume as number };
      const seen = byDate.get(bar.date);
      if (seen === undefined) byDate.set(bar.date, bar);
      else if (seen === null || seen.close !== bar.close || seen.volume !== bar.volume) {
        if (seen !== null) invalidBars++; // the first copy
        invalidBars++;
        byDate.set(bar.date, null);
      }
    }
    const bars = [...byDate.values()].filter((b): b is Bar => b !== null).sort((x, y) => (x.date < y.date ? -1 : 1));
    if (raw.historyStatus !== undefined && bars.length > 0) throw new Error(`Stock "${symbol}": has bars but historyStatus says they were not obtained.`);
    stocks.push({
      symbol,
      name: isText(raw.name) ? raw.name : symbol,
      bars,
      invalidBars,
      dataKind: d.kind === 'live' ? 'verified_market_data' : 'test_data',
      ...(raw.historyStatus !== undefined ? { historyStatus: raw.historyStatus as StockSnapshot['historyStatus'] } : {}),
    });
  }
  return { dataset, stocks, invalid };
}
