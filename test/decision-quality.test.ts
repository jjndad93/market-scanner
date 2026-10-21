import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nyWallTimeToUtc } from '../src/core/time.ts';
import { evaluateCall } from '../src/options/evaluate.ts';
import { applyLiveContext, liveContextHeader } from '../src/options/live-context.ts';
import { parseContractText } from '../src/options/parse.ts';
import { renderEvaluation } from '../src/options/render.ts';
import type { FetchLike } from '../src/providers/http.ts';

// Network guard: Stage 5 is offline; live context below uses an injected mock fetch only.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// HYPOTHETICAL inputs (the bundled XMPL example and edits of it); not real quotes.
const EXAMPLE = readFileSync(new URL('../examples/hypothetical-contract.txt', import.meta.url), 'utf8');
const NOW = new Date('2026-10-20T14:20:00Z');
const evaluate = (text: string) => {
  const parsed = parseContractText(text);
  return { parsed, ev: evaluateCall(parsed.contract, parsed.context, { now: NOW }) };
};
const report = (text: string, liveContext?: string) => {
  const { parsed, ev } = evaluate(text);
  return renderEvaluation(ev, { inputDescription: 'test input', parseWarnings: parsed.warnings, unrecognized: parsed.unrecognized, markedAsTestData: parsed.markedAsTestData, ...(liveContext ? { liveContext } : {}) });
};
const replaceLine = (label: string, line: string) => EXAMPLE.replace(new RegExp(`^${label}:.*$`, 'm'), line);
const dropLine = (label: string) => EXAMPLE.replace(new RegExp(`^${label}:.*$\\n?`, 'm'), '');

test('complete valid input: unchanged verdict path, no invalid list, offline header points to the opt-in', () => {
  const { ev } = evaluate(EXAMPLE);
  assert.equal(ev.verdict, 'MIXED');
  assert.deepEqual(ev.missingRequired, []);
  assert.equal('invalidRequired' in ev, false); // the JSON for valid input gains no new key
  const text = report(EXAMPLE);
  assert.match(text.replace(/\s+/g, ' '), /No live market data was fetched \(live context is opt-in with --live-context\), and nothing was independently verified\./);
  assert.doesNotMatch(text, /MISSING OR INVALID|Invalid:|later stage/);
  assert.match(text.replace(/\s+/g, ' '), /Recent trend of the stock \(paste e\.g\. "Trend: up 6% over 20 trading days", or use --live-context/);
});

test('missing required inputs are reported as missing, and block the assessment', () => {
  const { ev } = evaluate(dropLine('Strike'));
  assert.equal(ev.verdict, 'INSUFFICIENT_DATA');
  assert.deepEqual(ev.missingRequired, ['Strike price (e.g. "Strike: 130")']);
  assert.equal(ev.invalidRequired, undefined);
  assert.ok(ev.verdictReasons.includes('Missing: Strike price (e.g. "Strike: 130")'));
  const text = report(dropLine('Strike'));
  assert.match(text, /^MISSING INFORMATION$/m);
  assert.match(text, /Required before this contract can be assessed:\n {4}- Strike price/);
});

test('invalid inputs are reported as invalid with what was supplied and why, never as missing or zero', () => {
  const text = [replaceLine('Strike', 'Strike: abc'), ''].join('')
    .replace(/^Expiration:.*$/m, 'Expiration: 2026-13-45')
    .replace(/^Premium:.*$\n/m, '')
    .replace(/^Ask:.*$/m, 'Ask: -2.45');
  const { ev } = evaluate(text);
  assert.equal(ev.verdict, 'INSUFFICIENT_DATA');
  assert.deepEqual(ev.missingRequired, []); // nothing was absent: everything was supplied
  assert.deepEqual(ev.invalidRequired, [
    'Strike "abc" could not be read. Correct it (e.g. "Strike: 130").',
    'Expiration "2026-13-45" could not be read (use a date like 2026-12-18). Correct it (e.g. "Expiration: 2026-12-18").',
    'Option price: Ask "-2.45" could not be read (must be at least 0). Correct it, or give the premium you would pay (e.g. "Premium: 2.45").',
  ]);
  assert.ok(ev.verdictReasons.every((r) => !r.startsWith('Missing:')));
  assert.equal(ev.verdictReasons.filter((r) => r.startsWith('Invalid:')).length, 3);
  // The invalid values are shown as missing evidence, never as a number such as 0.
  const strike = ev.metrics.find((m) => m.label === 'Strike')!;
  assert.deepEqual([strike.evidence.kind, strike.evidence.value], ['missing', null]);
  const out = report(text);
  assert.match(out, /^MISSING OR INVALID INFORMATION$/m);
  assert.match(out, /Supplied but could not be used \(correct these; they are not treated as zero\):/);
  assert.doesNotMatch(out, /Missing: Strike|Missing: Expiration/);
  assert.ok(out.split('\n').every((l) => l.length <= 100));
});

test('an invalid value alongside a valid price source does not block: the valid premium is used', () => {
  const { ev } = evaluate(replaceLine('Ask', 'Ask: n/a'));
  assert.equal(ev.invalidRequired, undefined);
  assert.notEqual(ev.verdict, 'INSUFFICIENT_DATA');
});

// SYNTHETIC end-of-day bars for the mock provider.
function liveFetch(): FetchLike {
  const dates: string[] = [];
  for (let t = Date.parse('2026-10-19T00:00:00Z'); dates.length < 30; t -= 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) dates.unshift(new Date(t).toISOString().slice(0, 10));
  }
  const body = { status: 'OK', results: dates.map((d, i) => ({ t: nyWallTimeToUtc(d, 0, 0).getTime(), c: 50 * (i % 2 ? 1.02 : 1), v: 1e6 })) };
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
}

test('supplied vs calculated: pasted values stay YOU PROVIDED; filled values are CALCULATED with their session date', async () => {
  const deps = { env: { POLYGON_API_KEY: 'TEST-POLYGON-KEY-not-real-789' }, fetch: liveFetch(), clock: () => new Date('2026-10-20T14:20:00Z') };
  // Historical volatility pasted, trend not: one of each.
  const parsed = parseContractText(EXAMPLE);
  const { context, result } = await applyLiveContext(parsed.contract, parsed.context, deps);
  const ev = evaluateCall(parsed.contract, context, { now: NOW });
  const hv = ev.metrics.find((m) => m.label === 'Historical volatility')!;
  const trend = ev.metrics.find((m) => m.label === 'Recent trend')!;
  assert.equal(hv.evidence.kind, 'user_provided');
  assert.equal(trend.evidence.kind, 'calculated');
  const header = liveContextHeader(result);
  assert.equal(header, '--live-context fetched Massive end-of-day bars for XMPL (latest completed session 2026-10-19); recent trend is CALCULATED from them because nothing was pasted (see LIVE CONTEXT at the end).');
  const out = renderEvaluation(ev, { inputDescription: 'test input', parseWarnings: parsed.warnings, unrecognized: parsed.unrecognized, markedAsTestData: parsed.markedAsTestData, liveContext: header });
  const flat = out.replace(/\s+/g, ' ');
  assert.match(flat, /except as stated here: --live-context fetched Massive end-of-day bars for XMPL \(latest completed session 2026-10-19\)/);
  assert.doesNotMatch(out, /No live market data was fetched/);
  assert.match(out, /Historical volatility\.+ 33\.0% +\[YOU PROVIDED\]/);
  assert.match(out, /Recent trend\.+ up .* \[CALCULATED\]/);
  assert.match(flat, /From --live-context: Massive end-of-day bars for XMPL, latest completed session 2026-10-19\./);
  // Nothing pasted for either: both calculated. A failed live request leaves an honest header.
  const bare = parseContractText(EXAMPLE.replace(/^Historical volatility:.*$\n?/m, ''));
  const both = await applyLiveContext(bare.contract, bare.context, deps);
  assert.match(liveContextHeader(both.result), /historical volatility and recent trend are CALCULATED from them/);
  const failed = await applyLiveContext(bare.contract, bare.context, { ...deps, env: {} });
  assert.equal(liveContextHeader(failed.result), '--live-context was requested, but no live data was used (see LIVE CONTEXT at the end).');
});
