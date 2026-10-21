import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MASSIVE_STOCKS_INFO, nextStepFor } from '../src/core/errors.ts';
import { applyLiveContext } from '../src/options/live-context.ts';
import { parseContractText } from '../src/options/parse.ts';
import { type FetchLike, HttpError } from '../src/providers/http.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';

// Network guard for this process; spawned CLI processes load test/helpers/no-network.mjs.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const root = fileURLToPath(new URL('..', import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL('./helpers/no-network.mjs', import.meta.url))).href;
const { POLYGON_API_KEY: _a, COINGECKO_DEMO_API_KEY: _b, NODE_OPTIONS: _c, ...cleanEnv } = process.env;
/** Runs the real CLI with no API keys and every network path blocked. */
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', guard, 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8', env: cleanEnv });
const KEY = 'TEST-USABILITY-KEY-not-real-555';

test('main help lists every command, its offline default, live flags, key names and the options-plan limit', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  for (const s of ['scan crypto', 'scan stocks', 'scan options', 'option ', 'COINGECKO_DEMO_API_KEY', 'POLYGON_API_KEY', '--json', '--max-requests', '--symbols', '--live-context', 'free Options Basic plan does NOT', 'offline by default']) {
    assert.ok(r.stdout.includes(s), `main help mentions ${s}`);
  }
  assert.ok(r.stdout.split('\n').every((l) => l.length <= 100));
  assert.equal(cli([]).status, 0);
  assert.equal(cli(['help']).status, 0);
});

test('command help: every market and the option command answer --help (exit 0) and help <command> routes there', () => {
  for (const [args, expect] of [
    [['scan', '--help'], /Markets:\n {2}crypto/], [['scan', 'crypto', '--help'], /scan crypto --live/], [['scan', 'stocks', '-h'], /scan stocks --live/],
    [['scan', 'options', '--help'], /Options Basic plan does not/], [['option', '--help'], /--live-context/], [['help', 'option'], /--template/],
    [['help', 'scan', 'stocks'], /scan stocks --fixture/],
  ] as [string[], RegExp][]) {
    const r = cli(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, expect, args.join(' '));
  }
});

test('README quick start: every runnable line works offline as documented; LIVE lines stop before any request without a key', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const block = /## Quick start \(Windows PowerShell\)[\s\S]*?```powershell\n([\s\S]*?)```/.exec(readme)![1]!;
  const lines = block.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l.startsWith('node src/cli.ts'));
  assert.ok(lines.length >= 10, `found ${lines.length} runnable lines`);
  for (const line of lines) {
    assert.doesNotMatch(line, /<|>/, `no placeholders in runnable line: ${line}`);
    const r = cli(line.split(/\s+/).slice(2));
    assert.doesNotMatch(r.stderr, /NETWORK BLOCKED IN TEST/, line);
    if (/--live(\s|$)/.test(line)) { // exactly --live, not --live-context
      assert.equal(r.status, 1, line);
      assert.match(r.stderr, /No request was made/, line);
    } else if (/--live-context/.test(line)) {
      assert.equal(r.status, 0, line);
      assert.match(r.stdout, /POLYGON_API_KEY environment variable is not set\.\n {2}Requests made: 0 of 1/, line);
    } else {
      assert.equal(r.status, 0, `${line}\n${r.stderr}`);
    }
  }
  assert.doesNotMatch(readme, /setx [A-Z_]+ /, 'no key-in-command-line advice');
});

test('argument and file errors say what happened and what to do next, without a stack trace', () => {
  const checks: [string[], RegExp][] = [
    [['frobnicate'], /Unknown command "frobnicate"\. Use "scan" or "option"\./],
    [['option', '--bogus'], /Unknown option '--bogus'\. Run "node src\/cli\.ts option --help" for the supported flags\. No request was made\./],
    [['scan', 'crypto', '--bogus'], /Run "node src\/cli\.ts scan crypto --help"/],
    [['scan', 'options', '--nope'], /Run "node src\/cli\.ts scan options --help"/],
    [['scan', 'stocks', '--max-requests', '3'], /only for live scans/],
    [['option', '--file', 'no-such-file.txt'], /Could not read the contract file "no-such-file\.txt": the file does not exist\. Check the path .* option --template/],
    [['option', '--file', 'examples'], /that path is a folder, not a file/],
    [['option', '--live-context', '--now', '2026-10-20T14:20:00Z'], /--now cannot be combined with --live-context.*No request was made/],
  ];
  for (const [args, expect] of checks) {
    const r = cli(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, expect, args.join(' '));
    assert.doesNotMatch(r.stderr, /\n\s+at .*\(.*:\d+:\d+\)/, `no stack trace: ${args.join(' ')}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cli-usability-'));
  try {
    writeFileSync(join(dir, 'empty.txt'), '  \n');
    const empty = cli(['option', '--file', join(dir, 'empty.txt')]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No contract details received: the input was empty\./);
    writeFileSync(join(dir, 'bad.txt'), 'Underlying: XMPL\nStock price: 52.40\nStrike: abc\nExpiration: 2026-12-18\nPremium: 2.45\n');
    const bad = cli(['option', '--file', join(dir, 'bad.txt'), '--now', '2026-10-20T14:20:00Z']);
    assert.equal(bad.status, 0); // an assessment is still produced, saying what to fix
    assert.match(bad.stdout, /Invalid: Strike "abc" could not be read\. Correct it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deps(fetch: FetchLike, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: ScanCommandDeps = { env, fetch, clock: () => new Date('2026-10-21T13:30:00Z'), out: (t) => out.push(t), err: (t) => err.push(t), sleep: async () => {} };
  return { d, out, err };
}
const countingFetch = () => {
  let n = 0;
  const fn: FetchLike = async () => { n++; throw new Error('must not be called'); };
  return { fn, count: () => n };
};
const answer = (status: number, headers: Record<string, string> = {}, body: unknown = { error: 'x' }): FetchLike => async () => ({
  ok: status < 300, status, headers: { get: (h: string) => headers[h.toLowerCase()] ?? null }, text: async () => JSON.stringify(body),
});

test('help and validation never make a request, even with a key set', async () => {
  for (const args of [['--help'], ['crypto', '--help'], ['stocks', '--help'], ['options', '--help'], ['crypto', '--bogus'], ['stocks', '--live', '--max-requests', '0'], ['options', '--symbols', 'AAPL']]) {
    const f = countingFetch();
    const t = deps(f.fn, { COINGECKO_DEMO_API_KEY: KEY, POLYGON_API_KEY: KEY });
    await runScanCommand(args, t.d);
    assert.equal(f.count(), 0, args.join(' '));
  }
});

test('provider failures give a specific next step; plan and key problems say retrying will not help; the key is never shown', async () => {
  const cases: [number, Record<string, string>, RegExp][] = [
    [401, {}, /Next step: CoinGecko rejected the API key \(HTTP 401\): check that COINGECKO_DEMO_API_KEY holds a valid CoinGecko key.*Retrying with the same key will not help\./],
    [403, {}, /Next step: CoinGecko refused access \(HTTP 403\).*Retrying will not help; the plan or key must change\./],
    [429, {}, /Next step: CoinGecko is rate-limiting requests \(HTTP 429\)\. Wait a few minutes/],
    [503, {}, /Next step: CoinGecko reported a server error \(HTTP 503\); this is usually temporary/],
  ];
  for (const [status, headers, expect] of cases) {
    const t = deps(answer(status, headers), { COINGECKO_DEMO_API_KEY: KEY });
    assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2'], t.d), 1, String(status));
    assert.match(t.err.join('\n'), expect, String(status));
    assert.ok(![...t.err, ...t.out].some((s) => s.includes(KEY)), `no key in output (${status})`);
  }
  // Stocks: per-ticker failures are reported in the report with the first failure's next step.
  const s = deps(answer(401), { POLYGON_API_KEY: KEY });
  assert.equal(await runScanCommand(['stocks', '--live', '--max-requests', '1'], s.d), 0);
  const report = s.out.join('\n').replace(/\s+/g, ' ');
  assert.match(report, /First failure: HTTP 401 from \/v2\/aggs\/ticker\/AAPL\/range\/1\/day\/\S+\. Next step: Massive rejected the API key \(HTTP 401\): check that POLYGON_API_KEY/);
  assert.ok(!s.out.join('').includes(KEY));
  // Live context: the reason carries the same next step.
  const parsed = parseContractText(readFileSync(new URL('../examples/hypothetical-contract.txt', import.meta.url), 'utf8'));
  const live = await applyLiveContext(parsed.contract, parsed.context, { env: { POLYGON_API_KEY: KEY }, fetch: answer(403), clock: () => new Date('2026-10-21T13:30:00Z') });
  assert.equal(live.result.status, 'unavailable');
  if (live.result.status === 'unavailable') assert.match(live.result.reason, /HTTP 403 .*Massive refused access \(HTTP 403\): your Massive plan may not include stock daily bars/);
});

test('next steps for budget, timeout, network, bad JSON and unexpected errors', () => {
  const step = (kind: 'budget' | 'timeout' | 'network' | 'invalid_json' | 'http', status: number | null = null) => nextStepFor(new HttpError(kind, '/x', 'm', status), MASSIVE_STOCKS_INFO);
  assert.match(step('budget'), /request limit was reached \(retries count toward it\)\. Re-run with a larger --max-requests/);
  assert.match(step('timeout'), /timed out\. Check your internet connection/);
  assert.match(step('network'), /Could not reach Massive/);
  assert.match(step('invalid_json'), /not valid JSON; this is usually temporary/);
  assert.match(step('http', 404), /returned HTTP 404\. Check the command and symbols/);
  assert.match(nextStepFor(new Error('boom'), MASSIVE_STOCKS_INFO), /without --live to check the tool offline/);
});

test('empty provider responses are explained, not shown as a short history or a silent zero', async () => {
  const stocks = deps(answer(200, {}, { status: 'OK', resultsCount: 0 }), { POLYGON_API_KEY: KEY });
  assert.equal(await runScanCommand(['stocks', '--live', '--max-requests', '1'], stocks.d), 0);
  assert.match(stocks.out.join('\n').replace(/\s+/g, ' '), /AAPL: too little history - the provider returned no daily bars \(check the ticker symbol/);
  const options = deps(answer(200, {}, { status: 'OK', results: [] }), { POLYGON_API_KEY: KEY });
  assert.equal(await runScanCommand(['options', '--live', '--symbols', 'ZZZZ', '--max-requests', '1'], options.d), 0);
  assert.match(options.out.join('\n').replace(/\s+/g, ' '), /The provider returned no contracts for ZZZZ in the requested expiration window: check the symbol/);
});
