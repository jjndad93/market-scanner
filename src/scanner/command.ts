import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  COINGECKO_DEMO_BASE_URL,
  COINGECKO_KEY_ENV,
  COINGECKO_KEY_HEADER,
  DEFAULT_MAX_CALLS,
  type HistoryDiagnostic,
  type ShownPoint,
  fetchLiveDataset,
  terminalSafe,
} from '../providers/coingecko.ts';
import { type FetchLike, createHttpClient } from '../providers/http.ts';
import { runScan } from './analyze.ts';
import { normalizeDataset } from './normalize.ts';
import { renderScanReport } from './render.ts';

export const SCAN_HELP = `Usage:
  node src/cli.ts scan crypto                  synthetic test fixture (default; no network)
  node src/cli.ts scan crypto --fixture <file> another synthetic fixture file (no network)
  node src/cli.ts scan crypto --live           live data from the CoinGecko Demo API

Flags:
  --fixture <file>  synthetic dataset to scan instead of the bundled one
  --live            fetch live data (explicit opt-in). Needs the ${COINGECKO_KEY_ENV}
                    environment variable; makes at most ${DEFAULT_MAX_CALLS} requests.
  --json            print the structured scan result as JSON
  --now <ISO time>  fixture mode only: evaluate as of this time (default: the fixture's
                    snapshot time). Live scans always use the current time.
  --max-requests <n>      live only: request cap for this run, 1-${DEFAULT_MAX_CALLS}
                          (default ${DEFAULT_MAX_CALLS}); retries count against it
  --history-diagnostics   live only: print each fetched history's point count and first
                          2 / last 3 timestamps (UTC, classified) to stderr; no volume values`;

/** Parses --max-requests strictly: a whole number from 1 to the default cap, no signs or spaces. */
export function parseMaxRequests(text: string): number | null {
  if (!/^[1-9]\d{0,2}$/.test(text)) return null;
  const n = Number(text);
  return n <= DEFAULT_MAX_CALLS ? n : null;
}

/**
 * JSON.stringify escapes U+0000-U+001F but leaves DEL and C1 controls (U+007F-U+009F) raw, which
 * some terminals act on. Those characters can only occur inside JSON strings, so replacing each
 * with its \u00XX escape keeps the JSON valid and parses back to exactly the same values.
 */
export function terminalSafeJson(json: string): string {
  return json.replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Timestamp-only diagnostics text: ids, outcomes, counts and classified UTC times. */
export function renderHistoryDiagnostics(diagnostics: HistoryDiagnostic[]): string {
  const lines = ['HISTORY DIAGNOSTICS (timestamps only; no volume values)'];
  if (diagnostics.length === 0) lines.push('  (no history requests were sent)');
  for (const d of diagnostics) {
    if (!d.history) {
      lines.push(`  ${terminalSafe(d.id)}: ${d.outcome}`);
      continue;
    }
    const fmt = (p: ShownPoint) => `${p.time ?? 'invalid timestamp'} ${p.cls}${p.duplicate ? ' (duplicate)' : ''}`;
    const h = d.history;
    const first = h.shown.slice(0, Math.min(2, h.shown.length));
    const last = h.shown.slice(first.length);
    // Provider ids are untrusted: escape control characters so they cannot clear or forge lines.
    const parts = [`  ${terminalSafe(d.id)}: ${d.outcome}; ${h.points} points`];
    if (h.omitted === 0) parts.push(`all: ${h.shown.map(fmt).join(', ') || '(none)'}`);
    else parts.push(`first: ${first.map(fmt).join(', ')}`, `... ${h.omitted} more ...`, `last: ${last.map(fmt).join(', ')}`);
    lines.push(parts.join('; '));
  }
  return lines.join('\n');
}

export const BUNDLED_FIXTURE = new URL('../../test/fixtures/crypto-scan.synthetic.json', import.meta.url);

export interface ScanCommandDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  clock: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `scan <market> ...`. Returns the process exit code. */
export async function runScanCommand(args: string[], deps: ScanCommandDeps): Promise<number> {
  const [market, ...rest] = args;
  if (market !== 'crypto') {
    deps.err(market === undefined ? 'Choose a market to scan.\n' : `Unknown market "${market}". Only "crypto" is available.\n`);
    deps.err(SCAN_HELP);
    return 1;
  }

  let values: { fixture?: string; live?: boolean; json?: boolean; now?: string; 'max-requests'?: string; 'history-diagnostics'?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        fixture: { type: 'string' }, live: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, now: { type: 'string' },
        'max-requests': { type: 'string' }, 'history-diagnostics': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    deps.err(`${e instanceof Error ? e.message : String(e)}\n\n${SCAN_HELP}`);
    return 1;
  }
  if (values.live && values.fixture !== undefined) {
    deps.err('Use either --live or --fixture, not both.');
    return 1;
  }
  if (values.live && values.now !== undefined) {
    deps.err('--now is only for fixture scans; a live scan must use the current time so freshness checks are honest.');
    return 1;
  }
  if (!values.live && (values['max-requests'] !== undefined || values['history-diagnostics'])) {
    deps.err('--max-requests and --history-diagnostics are only for live scans (--live).');
    return 1;
  }
  let maxRequests = DEFAULT_MAX_CALLS;
  if (values['max-requests'] !== undefined) {
    const parsed = parseMaxRequests(values['max-requests']);
    if (parsed === null) {
      deps.err(`--max-requests must be a whole number from 1 to ${DEFAULT_MAX_CALLS} (got ${JSON.stringify(values['max-requests'])}). No request was made.`);
      return 1;
    }
    maxRequests = parsed;
  }

  const emit = (data: unknown, now: Date) => {
    const result = runScan(normalizeDataset(data), now);
    deps.out(values.json ? terminalSafeJson(JSON.stringify(result, null, 2)) : renderScanReport(result));
    return 0;
  };

  if (values.live) {
    // The key is checked before any client exists, so a missing key can never cause a request.
    const apiKey = deps.env[COINGECKO_KEY_ENV]?.trim();
    if (!apiKey) {
      deps.err(`--live needs a CoinGecko Demo API key in the ${COINGECKO_KEY_ENV} environment variable (for example a Windows user environment variable). No request was made.`);
      return 1;
    }
    try {
      const client = createHttpClient({
        fetch: deps.fetch, baseUrl: COINGECKO_DEMO_BASE_URL, apiKeyHeader: COINGECKO_KEY_HEADER, apiKey, maxCalls: maxRequests, sleep: deps.sleep,
      });
      const { diagnostics, ...data } = await fetchLiveDataset({
        client, clock: deps.clock, sleep: deps.sleep, maxCalls: maxRequests, diagnostics: values['history-diagnostics'],
      });
      // Diagnostics go to stderr so that --json output on stdout stays parseable.
      if (diagnostics) deps.err(renderHistoryDiagnostics(diagnostics));
      return emit(data, deps.clock());
    } catch (e) {
      // Errors from the provider modules never contain the key; redact here as well, defensively.
      const message = (e instanceof Error ? e.message : String(e)).split(apiKey).join('[REDACTED]');
      deps.err(`Live scan failed; no report was produced. ${message}`);
      return 1;
    }
  }

  const path = values.fixture ?? BUNDLED_FIXTURE;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    deps.err(`Could not read fixture ${String(path)}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // A fixture file must be synthetic, so a file can never be presented as live market data.
  const kind = (data as { dataset?: { kind?: unknown } } | null)?.dataset?.kind;
  if (kind !== 'synthetic') {
    deps.err(`Fixture files must declare "kind": "synthetic" (got ${JSON.stringify(kind)}).`);
    return 1;
  }
  const asOf = (data as { dataset: { asOf?: unknown } }).dataset.asOf;
  const now = values.now !== undefined ? new Date(values.now) : new Date(String(asOf));
  if (Number.isNaN(now.getTime())) {
    deps.err(values.now !== undefined ? `--now "${values.now}" is not a valid date/time.` : 'The fixture has no valid "asOf" time.');
    return 1;
  }
  try {
    return emit(data, now);
  } catch (e) {
    deps.err(`Invalid fixture: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
