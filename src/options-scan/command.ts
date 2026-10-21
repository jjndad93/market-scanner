import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MASSIVE_OPTIONS_INFO, nextStepFor } from '../core/errors.ts';
import { createHttpClient } from '../providers/http.ts';
import { MASSIVE_BASE_URL, MASSIVE_KEY_ENV, MASSIVE_KEY_HEADER } from '../providers/massive.ts';
import { fetchOptionChains } from '../providers/massive-options.ts';
import type { ScanCommandDeps } from '../scanner/command.ts';
import { parseMaxRequests, terminalSafeJson } from '../scanner/command.ts';
import { STOCK_UNIVERSE } from '../stocks/rules.ts';
import { renderOptionScanReport, summarizeOptionScan } from './render.ts';
import { type OptionScanDataset, runOptionScan } from './scan.ts';

export const OPTION_SCAN_HELP = `Usage:
  node src/cli.ts scan options                  synthetic test fixture (default; no network)
  node src/cli.ts scan options --fixture <file> another synthetic fixture file (no network)
  node src/cli.ts scan options --live           live option chains from the Massive API

Flags:
  --fixture <file>    synthetic dataset to scan instead of the bundled one
  --live              fetch live data (explicit opt-in). Needs ${MASSIVE_KEY_ENV} AND a Massive options
                      plan that includes the option-chain Snapshot (Options Starter or higher; the free
                      Options Basic plan does not). One request per underlying.
  --symbols <list>    live only: comma-separated underlyings (default: the stock scanner's ${STOCK_UNIVERSE.length} tickers)
  --max-requests <n>  live only: request cap for this run, retries included (default: one per underlying)
  --json              print the structured result as JSON
  --now <ISO time>    fixture mode only: evaluate as of this time (default: the fixture's snapshot time)
  --help, -h          show this help (never makes a request)

Offline by default: without --live nothing is requested, even if a key is set. On a plan
without Snapshot access the first live request is refused (HTTP 401/403) and the run stops;
retrying will not help until the plan changes.
Example (live, 1 request): node src/cli.ts scan options --live --symbols AAPL --max-requests 1`;

export const BUNDLED_OPTION_FIXTURE = new URL('../../test/fixtures/options-scan.synthetic.json', import.meta.url);

/** Runs `scan options ...`. Returns the process exit code. */
export async function runOptionScanCommand(args: string[], deps: ScanCommandDeps): Promise<number> {
  let values: { fixture?: string; live?: boolean; json?: boolean; now?: string; 'max-requests'?: string; symbols?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        fixture: { type: 'string' }, live: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, now: { type: 'string' },
        'max-requests': { type: 'string' }, symbols: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    deps.err(`${e instanceof Error ? e.message : String(e)}. Run "node src/cli.ts scan options --help" for the supported flags. No request was made.\n\n${OPTION_SCAN_HELP}`);
    return 1;
  }
  if ((values as { help?: boolean }).help) {
    deps.out(OPTION_SCAN_HELP);
    return 0;
  }
  if (values.live && values.fixture !== undefined) { deps.err('Use either --live or --fixture, not both.'); return 1; }
  if (values.live && values.now !== undefined) { deps.err('--now is only for fixture scans; a live scan must use the current time so freshness checks are honest.'); return 1; }
  if (!values.live && (values['max-requests'] !== undefined || values.symbols !== undefined)) { deps.err('--max-requests and --symbols are only for live scans (--live).'); return 1; }

  let symbols: string[] = [...STOCK_UNIVERSE];
  if (values.symbols !== undefined) {
    symbols = [...new Set(values.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0 || !symbols.every((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s))) {
      deps.err(`--symbols must be a comma-separated list of US stock tickers (got ${JSON.stringify(values.symbols)}). No request was made.`);
      return 1;
    }
  }
  let maxRequests = symbols.length;
  if (values['max-requests'] !== undefined) {
    const parsed = parseMaxRequests(values['max-requests']);
    if (parsed === null) { deps.err(`--max-requests must be a whole number from 1 to 160 (got ${JSON.stringify(values['max-requests'])}). No request was made.`); return 1; }
    maxRequests = parsed;
  }

  const emit = (data: OptionScanDataset, now: Date) => {
    const result = runOptionScan(data, now);
    deps.out(values.json ? terminalSafeJson(JSON.stringify({ ...result, scan: summarizeOptionScan(result) }, null, 2)) : renderOptionScanReport(result));
    return 0;
  };

  if (values.live) {
    // The key is checked before any client exists, so a missing key can never cause a request.
    const key = deps.env[MASSIVE_KEY_ENV]?.trim();
    if (!key) {
      deps.err(`--live needs a Massive API key in the ${MASSIVE_KEY_ENV} environment variable, on a plan that includes the options Snapshot. No request was made.`);
      return 1;
    }
    try {
      const client = createHttpClient({ fetch: deps.fetch, baseUrl: MASSIVE_BASE_URL, apiKeyHeader: MASSIVE_KEY_HEADER, apiKey: `Bearer ${key}`, maxCalls: maxRequests, sleep: deps.sleep });
      const data = await fetchOptionChains({ client, clock: deps.clock, underlyings: symbols, maxCalls: maxRequests, sleep: deps.sleep });
      return emit(data, deps.clock());
    } catch (e) {
      deps.err(`Live scan failed; no report was produced. ${(e instanceof Error ? e.message : String(e)).split(key).join('[REDACTED]')}\nNext step: ${nextStepFor(e, MASSIVE_OPTIONS_INFO)}`);
      return 1;
    }
  }

  let data: OptionScanDataset;
  try {
    data = JSON.parse(readFileSync(values.fixture ?? BUNDLED_OPTION_FIXTURE, 'utf8'));
  } catch (e) {
    deps.err(`Could not read fixture ${String(values.fixture ?? BUNDLED_OPTION_FIXTURE)}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (data?.dataset?.kind !== 'synthetic' || !Array.isArray(data.chains)) {
    deps.err(`Fixture files must declare "kind": "synthetic" and contain a "chains" array (got ${JSON.stringify(data?.dataset?.kind)}).`);
    return 1;
  }
  const now = new Date(values.now ?? String(data.dataset.asOf));
  if (Number.isNaN(now.getTime())) { deps.err(values.now !== undefined ? `--now "${values.now}" is not a valid date/time.` : 'The fixture has no valid "asOf" time.'); return 1; }
  return emit(data, now);
}
