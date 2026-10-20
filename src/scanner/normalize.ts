import { createHash } from 'node:crypto';
import { type Evidence, missing, testData } from '../core/evidence.ts';
import { normalizeTag, SCAN_RULES, type ScanRules } from './rules.ts';
import type { AssetSnapshot, DatasetMeta, Exclusion, RawAsset } from './types.ts';

export interface NormalizedDataset {
  dataset: DatasetMeta;
  assets: AssetSnapshot[];
  /** Records too malformed to evaluate (no usable id/symbol/name). */
  invalid: Exclusion[];
  /** The history window applied; runScan refuses rules with a different window. */
  historyWindowDays: number;
}

/** JSON with sorted object keys, so equal content always serializes identically. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

/**
 * A label for a record without a usable id, derived from its content rather than its position,
 * so it does not change when the input is reordered. Identical records get the same label.
 */
function contentLabel(raw: unknown): string {
  return `(no id) ${createHash('sha256').update(canonical(raw)).digest('hex').slice(0, 8)}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Validates and normalizes a dataset. Stage 2 P1 accepts ONLY datasets declared
 * `"kind": "synthetic"`, and tags every value TEST DATA, so fixture numbers can never be
 * presented as live market data.
 */
export function normalizeDataset(input: unknown, rules: ScanRules = SCAN_RULES): NormalizedDataset {
  if (!isRecord(input) || !isRecord(input.dataset)) throw new Error('Dataset must be an object with a "dataset" header.');
  const d = input.dataset;
  if (d.kind !== 'synthetic') {
    throw new Error(`Only synthetic test datasets are supported in this stage (got kind "${String(d.kind)}"). Live data is not implemented.`);
  }
  if (!isText(d.label) || !isText(d.source) || !isText(d.asOf) || Number.isNaN(Date.parse(d.asOf))) {
    throw new Error('Dataset header needs a label, a source and a valid ISO "asOf" timestamp.');
  }
  if (!Array.isArray(input.assets)) throw new Error('Dataset must contain an "assets" array.');

  const dataset: DatasetMeta = { kind: 'synthetic', label: d.label, source: d.source, asOf: new Date(d.asOf).toISOString() };
  const assets: AssetSnapshot[] = [];
  const invalid: Exclusion[] = [];

  input.assets.forEach((raw: unknown) => {
    if (!isRecord(raw) || !isText(raw.id) || !isText(raw.symbol) || !isText(raw.name)) {
      const r = isRecord(raw) ? raw : {};
      invalid.push({
        id: isText(r.id) ? r.id : contentLabel(raw),
        symbol: isText(r.symbol) ? r.symbol.toUpperCase() : '?',
        name: isText(r.name) ? r.name : '(unnamed)',
        reasons: [{ code: 'invalid_record', detail: 'record lacks a usable id, symbol or name' }],
      });
      return;
    }
    assets.push(normalizeAsset(raw as unknown as RawAsset, dataset, rules.historyWindowDays));
  });

  return { dataset, assets, invalid, historyWindowDays: rules.historyWindowDays };
}

function normalizeAsset(raw: RawAsset, dataset: DatasetMeta, historyWindowDays: number): AssetSnapshot {
  const lastUpdatedIso = isText(raw.lastUpdated) && !Number.isNaN(Date.parse(raw.lastUpdated)) ? new Date(raw.lastUpdated).toISOString() : null;
  const asOf = lastUpdatedIso ?? null;
  const source = `${dataset.source} (synthetic fixture)`;

  const num = (value: unknown, label: string, valid: (n: number) => boolean, rule: string): Evidence<number> => {
    if (value === undefined || value === null) return missing(`${label} not provided`);
    if (typeof value !== 'number' || !Number.isFinite(value) || !valid(value)) return missing(`${label} is invalid (${String(value)}; ${rule})`);
    return testData(value, source, asOf);
  };

  // Use only the most recent window; count zero and invalid entries instead of dropping them.
  const supplied: unknown[] = Array.isArray(raw.dailyVolumes) ? raw.dailyVolumes : [];
  // Input is oldest-first, so the most recent window is the tail.
  const window = supplied.slice(-historyWindowDays);
  const dailyVolumes: number[] = [];
  let zeroDays = 0;
  let invalidEntries = 0;
  for (const v of window) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalidEntries++;
    else if (v === 0) zeroDays++;
    else dailyVolumes.push(v);
  }

  return {
    id: raw.id,
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isText).map(normalizeTag) : [],
    price: num(raw.price, 'price', (n) => n > 0, 'must be > 0'),
    change24hPct: num(raw.change24hPct, '24h change', (n) => n > -100, 'must be > -100%'),
    change7dPct: num(raw.change7dPct, '7d change', (n) => n > -100, 'must be > -100%'),
    volume24h: num(raw.volume24h, '24h volume', (n) => n >= 0, 'must be >= 0'),
    marketCap: num(raw.marketCap, 'market cap', (n) => n > 0, 'must be > 0'),
    lastUpdated: lastUpdatedIso !== null ? testData(lastUpdatedIso, source, lastUpdatedIso) : missing(isText(raw.lastUpdated) ? `last-updated time "${raw.lastUpdated}" is invalid` : 'last-updated time not provided'),
    dailyVolumes,
    history: { supplied: supplied.length, windowDays: window.length, zeroDays, invalidEntries },
  };
}
