/**
 * Stage 8: user-facing explanations for live-request failures: what happened, and the next
 * practical step. Messages never include key values (the HTTP client already redacts them).
 */

import { HttpError } from '../providers/http.ts';

export interface ProviderInfo {
  /** Provider name as shown to the user, e.g. "CoinGecko" or "Massive". */
  name: string;
  /** Environment variable that holds the key (its NAME only). */
  keyEnv: string;
  /** Extra hint for HTTP 403, e.g. which plan includes the endpoint. */
  forbiddenHint?: string;
}

/** One sentence: the next practical step for a failed live request. */
export function nextStepFor(err: unknown, p: ProviderInfo): string {
  if (!(err instanceof HttpError)) return 'Run the same command without --live to check the tool offline, then try the live run again later.';
  if (err.status === 401) return `${p.name} rejected the API key (HTTP 401): check that ${p.keyEnv} holds a valid ${p.name} key, then restart your terminal so it picks up the change. Retrying with the same key will not help.`;
  if (err.status === 403) return `${p.name} refused access (HTTP 403)${p.forbiddenHint ? `: ${p.forbiddenHint}` : ': your plan may not include this data'}. Retrying will not help; the plan or key must change.`;
  switch (err.kind) {
    case 'rate_limited': return `${p.name} is rate-limiting requests (HTTP 429). Wait a few minutes, then run again, ideally with a smaller --max-requests.`;
    case 'budget': return 'The per-run request limit was reached (retries count toward it). Re-run with a larger --max-requests if you intend to use more requests.';
    case 'timeout': return `The request to ${p.name} timed out. Check your internet connection and try again later.`;
    case 'network': return `Could not reach ${p.name}. Check your internet connection (and any proxy or firewall), then try again.`;
    case 'invalid_json': return `${p.name} sent a response that was not valid JSON; this is usually temporary. Try again later.`;
    case 'http': return err.status !== null && err.status >= 500
      ? `${p.name} reported a server error (HTTP ${err.status}); this is usually temporary. Try again later.`
      : `${p.name} returned HTTP ${err.status}. Check the command and symbols, then try again.`;
  }
}

export const COINGECKO_INFO: ProviderInfo = { name: 'CoinGecko', keyEnv: 'COINGECKO_DEMO_API_KEY', forbiddenHint: 'the Demo key may not include this endpoint' };
export const MASSIVE_STOCKS_INFO: ProviderInfo = { name: 'Massive', keyEnv: 'POLYGON_API_KEY', forbiddenHint: 'your Massive plan may not include stock daily bars (the free Stocks Basic plan does)' };
export const MASSIVE_OPTIONS_INFO: ProviderInfo = {
  name: 'Massive', keyEnv: 'POLYGON_API_KEY',
  forbiddenHint: 'the option-chain snapshot needs a Massive options plan that includes Snapshot (Options Starter or higher; the free Options Basic plan excludes it)',
};
