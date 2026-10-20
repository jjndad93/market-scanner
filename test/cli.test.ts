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

test('scan command is not built yet and says so without fetching anything', () => {
  const r = run('scan');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /not built yet/);
});
