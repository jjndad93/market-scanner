/**
 * Local web dashboard (crypto and US stocks, with per-asset news panels; see news.ts). Start with `npm run web`, then open http://127.0.0.1:4173.
 *
 * Safety design:
 * - Binds to 127.0.0.1 only. Requests whose Host is not this loopback address are refused
 *   (blocks DNS-rebinding), and scan requests need a custom header plus JSON, so a page on another
 *   site cannot trigger a scan (the browser's CORS preflight fails; no CORS headers are sent).
 * - Scans run IN-PROCESS through the existing `runScanCommand` with a fixed argument array: no
 *   shell, no subprocess, no browser-supplied strings in arguments. Every existing rule applies
 *   unchanged: key check before any request, request limit (retries included), cache, auth stops.
 * - The browser's request budget is validated server-side (whole number 1..cap); live mode needs an
 *   explicit confirmation flag. One scan at a time. API keys stay on the server and are redacted
 *   from anything returned. Only a fixed list of static files is served.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { type ScanCommandDeps, runScanCommand } from '../scanner/command.ts';
import { EXCLUSION_LABEL } from '../scanner/render.ts';
import { EXCLUSION_LABEL as STOCK_EXCLUSION_LABEL } from '../stocks/render.ts';
import { LIMITATIONS, cryptoRows, stockRows } from './rows.ts';
import { DEFAULT_MAX_CALLS } from '../providers/coingecko.ts';
import { createCmcCheckService, validateCmcBody } from './cmc-check.ts';
import { createCryptoSearchService, validateSearchBody } from './crypto-search.ts';
import { type LastScan, NEWS_DEFAULT_LIMIT, NEWS_MAX_LIMIT, createNewsService, validateNewsRequest } from './news.ts';
import { createWhereToBuyService, validateWtbRequest } from './where-to-buy.ts';

export const WEB_HOST = '127.0.0.1';
export const WEB_DEFAULT_PORT = 4173;
/** Default budget suggested to the browser. */
export const WEB_DEFAULT_MAX_REQUESTS = 5;
const MAX_BODY_BYTES = 1024;
const SECRET_ENVS = ['COINGECKO_DEMO_API_KEY', 'POLYGON_API_KEY', 'COINMARKETCAP_API_KEY'];

/** The only files served. Requests for anything else get 404: no paths from the URL reach the disk. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/budget.js': { file: 'budget.js', type: 'text/javascript; charset=utf-8' },
  '/simple-view.js': { file: 'simple-view.js', type: 'text/javascript; charset=utf-8' },
};
const PUBLIC_DIR = new URL('./public/', import.meta.url);

export type ScanDeps = Omit<ScanCommandDeps, 'out' | 'err'>;
export interface WebResponse { status: number; headers: Record<string, string>; body: string }
export interface WebRequest { method: string; url: string; headers: Record<string, string | undefined>; body: string }

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const json = (status: number, data: unknown): WebResponse => ({
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(data),
});

/** Removes any configured key value from text the server returns (defence in depth). */
export function redactSecrets(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const name of SECRET_ENVS) {
    const v = env[name]?.trim();
    if (v) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

export type Market = 'crypto' | 'stocks';
/** The only scan routes; the market comes from this fixed map, never from the request body. */
const SCAN_ROUTES: Record<string, Market> = { '/api/scan/crypto': 'crypto', '/api/scan/stocks': 'stocks' };
/** News for one row of the last scan, fetched only when the user opens its panel. */
const NEWS_ROUTES: Record<string, Market> = { '/api/news/crypto': 'crypto', '/api/news/stocks': 'stocks' };
/** "Where to buy" for one row of the last scan, fetched only when the user opens its panel. */
const WTB_ROUTES: Record<string, Market> = { '/api/where-to-buy/crypto': 'crypto', '/api/where-to-buy/stocks': 'stocks' };
/** Crypto asset search (any CoinGecko coin) and one-asset lookup; separate from scans. */
const SEARCH_ROUTES: Record<string, 'search' | 'asset'> = { '/api/crypto/search': 'search', '/api/crypto/asset': 'asset' };
/** CoinMarketCap cross-check of the last crypto scan's research leads (user-triggered). */
const CMC_ROUTE = '/api/crypto/cmc-check';

/** One scan at a time (any market), through the existing command with a fixed argument array. */
export function createScanService(deps: ScanDeps, maxRequestsCap: number, newsOpts: { fixture?: URL; minIntervalMs?: number } = {}, searchOpts: { fixture?: URL; minIntervalMs?: number; sessionLimit?: number } = {}, cmcOpts: { fixture?: URL; sessionLimit?: number } = {}, wtbOpts: { fixture?: URL; minIntervalMs?: number } = {}) {
  let running = false;
  /** The last successful scan per market: the only source of assets and moves for news requests. */
  const last: Partial<Record<Market, LastScan>> = {};
  const news = createNewsService(deps, { ...newsOpts, getLast: (m) => last[m], scanRunning: () => running });
  const search = createCryptoSearchService(deps, { ...searchOpts, getLastCrypto: () => last.crypto, scanRunning: () => running });
  const cmc = createCmcCheckService(deps, { ...cmcOpts, getLastCrypto: () => last.crypto, scanRunning: () => running });
  const wtb = createWhereToBuyService(deps, { ...wtbOpts, getLast: (m) => last[m], scanRunning: () => running });
  return {
    news,
    wtb,
    search,
    cmc,
    get running() {
      return running;
    },
    maxRequestsCap,
    async run(market: Market, mode: 'offline' | 'live', maxRequests: number): Promise<WebResponse> {
      if (running) return json(409, { ok: false, error: 'A scan is already running. Wait for it to finish, then try again.' });
      if (news.busy) return json(409, { ok: false, error: 'A news request is running. Wait for it to finish, then try again.' });
      if (search.busy) return json(409, { ok: false, error: 'A crypto search request is running. Wait for it to finish, then try again.' });
      if (cmc.busy) return json(409, { ok: false, error: 'A CoinMarketCap cross-check is running. Wait for it to finish, then try again.' });
      if (wtb.busy) return json(409, { ok: false, error: 'A "where to buy" lookup is running. Wait for it to finish, then try again.' });
      running = true;
      const out: string[] = [];
      const err: string[] = [];
      const startedAt = deps.clock().toISOString();
      try {
        // Fixed arguments only; the market is from SCAN_ROUTES and the budget a validated integer.
        // Live stock scans look across all US stocks (market-wide gainers under $50), not only the fixed list.
        const args = mode === 'live' ? [market, '--json', '--live', ...(market === 'stocks' ? ['--movers'] : []), '--max-requests', String(maxRequests)] : [market, '--json'];
        const exitCode = await runScanCommand(args, { ...deps, out: (t) => out.push(t), err: (t) => err.push(t) });
        const stdout = redactSecrets(out.join('\n'), deps.env);
        const stderr = redactSecrets(err.join('\n'), deps.env);
        if (exitCode !== 0) return json(exitCode === 1 ? 422 : 500, { ok: false, market, mode, error: stderr || 'The scan failed without a message.', startedAt });
        const result = JSON.parse(stdout);
        // Rows for the budget view, built from the result only; the report's own exclusion labels.
        const rows = market === 'crypto' ? cryptoRows(result, new Date(result.evaluatedAt)) : stockRows(result);
        last[market] = { mode, rows, evaluatedAt: result.evaluatedAt, ...(market === 'crypto' ? { discovery: result.discovery } : {}) };
        return json(200, {
          ok: true, market, mode, maxRequests: mode === 'live' ? maxRequests : null, startedAt, result,
          rows,
          exclusionLabels: market === 'crypto' ? EXCLUSION_LABEL : STOCK_EXCLUSION_LABEL,
          limitations: LIMITATIONS[market],
        });
      } catch (e) {
        return json(500, { ok: false, market, mode, error: redactSecrets(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, deps.env), startedAt });
      } finally {
        running = false;
      }
    },
  };
}
export type ScanService = ReturnType<typeof createScanService>;

/** Parses and validates the browser's scan request; returns an error message or the validated values. */
export function validateScanRequest(body: string, cap: number): { mode: 'offline' | 'live'; maxRequests: number } | { error: string } {
  if (body.length > MAX_BODY_BYTES) return { error: 'Request body too large.' };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Request body must be JSON.' };
  }
  if (typeof data !== 'object' || data === null) return { error: 'Request body must be a JSON object.' };
  const d = data as Record<string, unknown>;
  if (d.mode !== 'offline' && d.mode !== 'live') return { error: 'mode must be "offline" or "live".' };
  if (d.mode === 'offline') return { mode: 'offline', maxRequests: 0 };
  if (d.confirmLive !== true) return { error: 'Live mode spends API requests and must be confirmed (confirmLive: true).' };
  if (typeof d.maxRequests !== 'number' || !Number.isInteger(d.maxRequests) || d.maxRequests < 1 || d.maxRequests > cap) {
    return { error: `maxRequests must be a whole number from 1 to ${cap}.` };
  }
  return { mode: 'live', maxRequests: d.maxRequests };
}

/** Routes one request. Pure apart from the scan service and the static files, so it is testable without sockets. */
export async function handleRequest(req: WebRequest, service: ScanService, env: Record<string, string | undefined>, port: number): Promise<WebResponse> {
  // DNS-rebinding guard: only this loopback host:port is accepted.
  const allowedHosts = new Set([`${WEB_HOST}:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) return json(403, { ok: false, error: 'Forbidden host.' });
  const path = req.url.split('?')[0]!;

  if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, path)) {
    const { file, type } = STATIC_FILES[path]!;
    return { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' }, body: readFileSync(new URL(file, PUBLIC_DIR), 'utf8') };
  }
  if (req.method === 'GET' && path === '/api/status') {
    return json(200, {
      ok: true, running: service.running, maxRequestsCap: service.maxRequestsCap, defaultMaxRequests: WEB_DEFAULT_MAX_REQUESTS,
      // Presence only: the value never leaves the server.
      cryptoKeyConfigured: Boolean(env.COINGECKO_DEMO_API_KEY?.trim()),
      stocksKeyConfigured: Boolean(env.POLYGON_API_KEY?.trim()),
      newsDefaultLimit: NEWS_DEFAULT_LIMIT, newsMaxLimit: NEWS_MAX_LIMIT,
      cmcKeyConfigured: Boolean(env.COINMARKETCAP_API_KEY?.trim()),
    });
  }
  if (Object.hasOwn(SCAN_ROUTES, path) || Object.hasOwn(NEWS_ROUTES, path) || Object.hasOwn(WTB_ROUTES, path) || Object.hasOwn(SEARCH_ROUTES, path) || path === CMC_ROUTE) {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'Use POST.' });
    // Cross-site protection: a custom header and a JSON content type force a CORS preflight, which
    // this server never approves; a present Origin must be this server.
    if (req.headers['x-market-scanner'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(403, { ok: false, error: 'Missing required request headers.' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !new Set([`http://${WEB_HOST}:${port}`, `http://localhost:${port}`]).has(origin)) return json(403, { ok: false, error: 'Forbidden origin.' });
    if (path === CMC_ROUTE) {
      const c = validateCmcBody(req.body);
      if ('error' in c) return json(400, { ok: false, error: c.error });
      try {
        const r = await service.cmc.check(c);
        return { ...json(r.status, r.data), body: redactSecrets(JSON.stringify(r.data), env) };
      } catch (e) {
        return json(500, { ok: false, error: redactSecrets(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, env) });
      }
    }
    if (Object.hasOwn(SEARCH_ROUTES, path)) {
      const kind = SEARCH_ROUTES[path]!;
      const s = validateSearchBody(req.body, kind);
      if ('error' in s) return json(400, { ok: false, error: s.error });
      try {
        const r = kind === 'search' ? await service.search.search(s.mode, s.value, s.refresh, s.confirmLive) : await service.search.asset(s.mode, s.value, s.refresh, s.confirmLive);
        return { ...json(r.status, r.data), body: redactSecrets(JSON.stringify(r.data), env) };
      } catch (e) {
        return json(500, { ok: false, error: redactSecrets(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, env) });
      }
    }
    if (Object.hasOwn(WTB_ROUTES, path)) {
      const w = validateWtbRequest(req.body);
      if ('error' in w) return json(400, { ok: false, error: w.error });
      try {
        const r = await service.wtb.get(WTB_ROUTES[path]!, w);
        return { ...json(r.status, r.data), body: redactSecrets(JSON.stringify(r.data), env) };
      } catch (e) {
        return json(500, { ok: false, error: redactSecrets(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, env) });
      }
    }
    if (Object.hasOwn(NEWS_ROUTES, path)) {
      const n = validateNewsRequest(req.body);
      if ('error' in n) return json(400, { ok: false, error: n.error });
      try {
        const r = await service.news.get(NEWS_ROUTES[path]!, n);
        return { ...json(r.status, r.data), body: redactSecrets(JSON.stringify(r.data), env) };
      } catch (e) {
        return json(500, { ok: false, error: redactSecrets(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, env) });
      }
    }
    const v = validateScanRequest(req.body, service.maxRequestsCap);
    if ('error' in v) return json(400, { ok: false, error: v.error });
    return service.run(SCAN_ROUTES[path]!, v.mode, v.maxRequests);
  }
  return json(404, { ok: false, error: 'Not found.' });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startWebServer(opts: { port: number; deps: ScanDeps; maxRequestsCap?: number }): Server {
  const service = createScanService(opts.deps, opts.maxRequestsCap ?? DEFAULT_MAX_CALLS);
  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readBody(req) : '';
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
      const r = await handleRequest({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body }, service, opts.deps.env, opts.port);
      res.writeHead(r.status, r.headers).end(r.body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Bad request.' }));
    }
  });
  server.listen(opts.port, WEB_HOST);
  return server;
}

/** `node src/web/server.ts [--port N]` */
export function parsePort(argv: string[]): number | null {
  const i = argv.indexOf('--port');
  if (i === -1) return WEB_DEFAULT_PORT;
  const v = argv[i + 1] ?? '';
  return /^\d{4,5}$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535 ? Number(v) : null;
}

// Start only when run directly (`node src/web/server.ts`), never when imported (e.g. by tests).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parsePort(process.argv.slice(2));
  if (port === null) {
    console.error('--port must be a whole number from 1024 to 65535.');
    process.exitCode = 1;
  } else {
    const server = startWebServer({ port, deps: { env: process.env, fetch: (url, init) => globalThis.fetch(url, init), clock: () => new Date() } });
    // Announce the URL only once the server is really listening; explain a busy port instead of crashing.
    server.on('listening', () => {
      console.log(`Market Scanner dashboard: http://${WEB_HOST}:${port}  (local only; press Ctrl+C to stop)`);
      console.log('Offline scans use the synthetic fixture. Live scans run only when you choose Live and confirm in the page.');
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      console.error(e.code === 'EADDRINUSE'
        ? `Port ${port} is already in use (is another Market Scanner dashboard already running?). Open http://${WEB_HOST}:${port} if it is, or start this one on another port: npm run web -- --port ${port + 1}`
        : `The dashboard could not start: ${e.message}`);
      process.exitCode = 1;
    });
  }
}
