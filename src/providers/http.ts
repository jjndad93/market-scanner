/**
 * Minimal JSON-over-HTTP client for market-data providers.
 *
 * - `fetch` is injected, so tests use mocked responses and never touch the network.
 * - Every request counts against a fixed per-run call budget (retries included).
 * - HTTP 429 is retried at most once, after the server's Retry-After (capped).
 * - The API key is sent only in a request header. It is never put in the URL, never logged,
 *   and is redacted from every error message this module produces.
 */

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpClientOptions {
  fetch: FetchLike;
  baseUrl: string;
  /** Header name that carries the key, e.g. "x-cg-demo-api-key". */
  apiKeyHeader: string;
  apiKey: string;
  /** Maximum requests (including retries) this client may make. */
  maxCalls: number;
  timeoutMs?: number;
  /** Longest Retry-After wait honored before giving up, in milliseconds. */
  maxRetryWaitMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type HttpErrorKind = 'budget' | 'timeout' | 'network' | 'http' | 'rate_limited' | 'invalid_json';

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | null;
  readonly path: string;
  constructor(kind: HttpErrorKind, path: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.path = path;
  }
}

export interface HttpClient {
  getJson(path: string, params?: Record<string, string>): Promise<unknown>;
  /** Requests made so far, including retries. */
  readonly callsMade: number;
  readonly maxCalls: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds or an HTTP date, per RFC 9110. Returns milliseconds, or null if unusable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { fetch, baseUrl, apiKeyHeader, apiKey, maxCalls } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
  const sleep = options.sleep ?? realSleep;
  if (!apiKey) throw new Error('An API key is required to create the HTTP client.');
  let callsMade = 0;

  // Defense in depth: no message from this module may contain the key.
  const redact = (text: string) => text.split(apiKey).join('[REDACTED]');
  const fail = (kind: HttpErrorKind, path: string, message: string, status: number | null = null) =>
    new HttpError(kind, path, redact(message), status);

  async function attempt(path: string, url: string) {
    if (callsMade >= maxCalls) throw fail('budget', path, `Call budget of ${maxCalls} requests reached; ${path} was not requested.`);
    callsMade++;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, { headers: { accept: 'application/json', [apiKeyHeader]: apiKey }, signal });
    } catch (err) {
      if (signal.aborted) throw fail('timeout', path, `Request to ${path} timed out after ${timeoutMs} ms.`);
      const name = err instanceof Error ? err.name : 'Error';
      throw fail('network', path, `Network error requesting ${path} (${name}).`);
    }
  }

  return {
    get callsMade() {
      return callsMade;
    },
    maxCalls,
    async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
      const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))).toString();
      const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
      let res = await attempt(path, url);
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'));
        if (wait === null || wait > maxRetryWaitMs) {
          throw fail('rate_limited', path, `Rate limited on ${path} (HTTP 429); Retry-After ${wait === null ? 'missing or invalid' : `${Math.round(wait / 1000)} s exceeds the ${Math.round(maxRetryWaitMs / 1000)} s limit`}. Not retried.`, 429);
        }
        await sleep(wait);
        res = await attempt(path, url);
        if (res.status === 429) throw fail('rate_limited', path, `Rate limited on ${path} again after one retry (HTTP 429).`, 429);
      }
      if (!res.ok) throw fail('http', path, `HTTP ${res.status} from ${path}.`, res.status);
      const body = await res.text();
      try {
        return JSON.parse(body);
      } catch {
        throw fail('invalid_json', path, `Response from ${path} was not valid JSON.`, res.status);
      }
    },
  };
}
