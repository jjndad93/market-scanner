import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: root, encoding: 'utf8' });

test('option command evaluates the hypothetical example end to end', () => {
  const r = run('option', '--file', 'examples/hypothetical-contract.txt', '--now', '2026-10-20T14:20:00Z');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /VERDICT: /);
  assert.match(r.stdout, /MARKED AS HYPOTHETICAL \/ TEST DATA/);
  assert.match(r.stdout, /No live market data was fetched/);
  assert.match(r.stdout, /MODEL LIMITATIONS/);
});

test('option command can emit JSON for later integration', () => {
  const r = run('option', '--file', 'examples/hypothetical-contract.txt', '--now', '2026-10-20T14:20:00Z', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(['RELATIVELY_STRONG', 'MIXED', 'WEAK', 'TOO_RISKY', 'INSUFFICIENT_DATA'].includes(out.evaluation.verdict));
});

// P2 S5: the old "scan is not built yet" stub (exit 2) was replaced deliberately by `scan crypto`.
const { COINGECKO_DEMO_API_KEY: _omit, ...envWithoutKey } = process.env;
const runNoKey = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: root, encoding: 'utf8', env: envWithoutKey });

test('scan without a market prints usage and fails', () => {
  const r = runNoKey('scan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Choose a market to scan/);
  assert.match(r.stderr, /scan crypto --live/);
});

test('scan crypto defaults to the bundled synthetic fixture and is labeled TEST DATA', () => {
  const r = runNoKey('scan', 'crypto');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /!! TEST DATA - synthetic fixture/);
  assert.match(r.stdout, /No live data was fetched\./);
});

test('scan crypto --live without the key fails before any request', () => {
  const r = runNoKey('scan', 'crypto', '--live');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /COINGECKO_DEMO_API_KEY/);
  assert.match(r.stderr, /No request was made/);
  assert.equal(r.stdout, '');
});
