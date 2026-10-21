import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MASSIVE_STOCKS_INFO, nextStepFor } from '../core/errors.ts';
import { createHttpClient } from '../providers/http.ts';
import { MASSIVE_BASE_URL, MASSIVE_KEY_ENV, MASSIVE_KEY_HEADER, fetchStockDataset } from '../providers/massive.ts';
import type { ScanCommandDeps } from '../scanner/command.ts';
import { parseMaxRequests, terminalSafeJson } from '../scanner/command.ts';
import { runStockScan } from './analyze.ts';
import { normalizeStockDataset } from './normalize.ts';
import { renderStockReport, summarizeStockScan } from './render.ts';
import { STOCK_UNIVERSE } from './rules.ts';

export const STOCK_SCAN_HELP = `Usage:
  node src/cli.ts scan stocks                  synthetic test fixture (default; no network)
  node src/cli.ts scan stocks --fixture <file> another synthetic fixture file (no network)
  node src/cli.ts scan stocks --live           live end-of-day bars from the Massive API

Flags:
  --fixture <file>    synthetic dataset to scan instead of the bundled one
  --live              fetch live data (explicit opt-in). Needs the ${MASSIVE_KEY_ENV}
                      environment variable; one request per ticker (${STOCK_UNIVERSE.length} tickers),
                      about 12.5 s apart (free plan: 5 calls/minute)
  --json              print the structured scan result as JSON
  --now <ISO time>    fixture mode only: evaluate as of this time (default: the fixture's snapshot time)
  --max-requests <n>  live only: request cap for this run, retries included (default ${STOCK_UNIVERSE.length})
  --help, -h          show this help (never makes a request)

Offline by default: without --live nothing is requested, even if a key is set. The free
Massive Stocks Basic plan is enough. End-of-day data only (no intraday or pre-market).
Example (live, at most 2 requests): node src/cli.ts scan stocks --live --max-requests 2`;

export const BUNDLED_STOCK_FIXTURE = new URL('../../test/fixtures/stock-scan.synthetic.json', import.meta.url);

/** Runs `scan stocks ...`. Returns the process exit code. */
export async function runStockScanCommand(args: string[], deps: ScanCommandDeps): Promise<number> {
  let values: { fixture?: string; live?: boolean; json?: boolean; now?: string; 'max-requests'?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { fixture: { type: 'string' }, live: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, now: { type: 'string' }, 'max-requests': { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
      strict: true,
    }));
  } catch (e) {
    deps.err(`${e instanceof Error ? e.message : String(e)}. Run "node src/cli.ts scan stocks --help" for the supported flags. No request was made.\n\n${STOCK_SCAN_HELP}`);
    return 1;
  }
  if ((values as { help?: boolean }).help) {
    deps.out(STOCK_SCAN_HELP);
    return 0;
  }
  if (values.live && values.fixture !== undefined) {
    deps.err('Use either --live or --fixture, not both.');
    return 1;
  }
  if (values.live && values.now !== undefined) {
    deps.err('--now is only for fixture scans; a live scan must use the current time so freshness checks are honest.');
    return 1;
  }
  if (!values.live && values['max-requests'] !== undefined) {
    deps.err('--max-requests is only for live scans (--live).');
    return 1;
  }
  let maxRequests = STOCK_UNIVERSE.length;
  if (values['max-requests'] !== undefined) {
    const parsed = parseMaxRequests(values['max-requests']);
    if (parsed === null) {
      deps.err(`--max-requests must be a whole number from 1 to 160 (got ${JSON.stringify(values['max-requests'])}). No request was made.`);
      return 1;
    }
    maxRequests = parsed;
  }

  const emit = (data: unknown, now: Date) => {
    const result = runStockScan(normalizeStockDataset(data), now);
    deps.out(values.json ? terminalSafeJson(JSON.stringify({ ...result, scan: summarizeStockScan(result) }, null, 2)) : renderStockReport(result));
    return 0;
  };

  if (values.live) {
    // The key is checked before any client exists, so a missing key can never cause a request.
    const key = deps.env[MASSIVE_KEY_ENV]?.trim();
    if (!key) {
      deps.err(`--live needs a Massive API key in the ${MASSIVE_KEY_ENV} environment variable (for example a Windows user environment variable). No request was made.`);
      return 1;
    }
    try {
      const client = createHttpClient({
        fetch: deps.fetch, baseUrl: MASSIVE_BASE_URL, apiKeyHeader: MASSIVE_KEY_HEADER, apiKey: `Bearer ${key}`, maxCalls: maxRequests, sleep: deps.sleep,
      });
      const data = await fetchStockDataset({ client, clock: deps.clock, universe: STOCK_UNIVERSE, maxCalls: maxRequests, sleep: deps.sleep });
      return emit(data, deps.clock());
    } catch (e) {
      // Errors never contain the key; redact here as well, defensively (with and without the prefix).
      const message = (e instanceof Error ? e.message : String(e)).split(key).join('[REDACTED]');
      deps.err(`Live scan failed; no report was produced. ${message}\nNext step: ${nextStepFor(e, MASSIVE_STOCKS_INFO)}`);
      return 1;
    }
  }

  const path = values.fixture ?? BUNDLED_STOCK_FIXTURE;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    deps.err(`Could not read fixture ${String(path)}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
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
