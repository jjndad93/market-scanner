/**
 * Every value the tool shows carries a provenance tag, so a reader can always tell
 * verified market data from calculations, third-party figures, assumptions and gaps.
 * Nothing is ever shown without one of these tags.
 */
export type EvidenceKind =
  | 'verified_market_data' // fetched by this tool from a named market-data source (Stage 2+)
  | 'user_provided' // pasted or typed by the user; not independently verified
  | 'calculated' // derived by this tool from other evidence with a stated formula
  | 'third_party' // reported by someone else (news, broker-computed Greeks, filings)
  | 'estimate' // a model output, default assumption or interpretation
  | 'test_data' // from a synthetic fixture: invented values, never market data
  | 'missing'; // not available; `note` says why

export interface Evidence<T> {
  readonly kind: EvidenceKind;
  readonly value: T | null;
  /** Where the value came from, or the formula/method that produced it. */
  readonly source: string;
  /** ISO timestamp of the underlying data, or null when unknown. */
  readonly asOf: string | null;
  readonly note?: string;
  /** Set when the raw input could reasonably mean something else (e.g. "3" = 3% or 300%). */
  readonly ambiguity?: string;
  /**
   * Set on a `missing` value when the user DID supply text for it that could not be used (it
   * holds that text), so an invalid input is never reported as if it had not been given.
   */
  readonly suppliedButInvalid?: string;
}

export const KIND_LABEL: Record<EvidenceKind, string> = {
  verified_market_data: 'VERIFIED DATA',
  user_provided: 'YOU PROVIDED',
  calculated: 'CALCULATED',
  third_party: 'THIRD-PARTY',
  estimate: 'ESTIMATE',
  test_data: 'TEST DATA',
  missing: 'MISSING',
};

export const KIND_LEGEND: Record<EvidenceKind, string> = {
  verified_market_data: 'fetched by this tool from the named market-data source',
  user_provided: 'pasted by you; not independently verified',
  calculated: 'derived by this tool from the other values (formula shown)',
  third_party: 'a figure reported by your broker or another source',
  estimate: 'model output or default assumption; not a fact',
  test_data: 'invented value from a synthetic test fixture; not market data',
  missing: 'not available',
};

export function verified<T>(value: T, source: string, asOf: string, note?: string): Evidence<T> {
  return { kind: 'verified_market_data', value, source, asOf, note };
}

export function userProvided<T>(value: T, source: string, asOf: string | null = null, note?: string): Evidence<T> {
  return { kind: 'user_provided', value, source, asOf, note };
}

export function calculated<T>(value: T, method: string, asOf: string | null = null, note?: string): Evidence<T> {
  return { kind: 'calculated', value, source: method, asOf, note };
}

export function thirdParty<T>(value: T, source: string, asOf: string | null = null, note?: string): Evidence<T> {
  return { kind: 'third_party', value, source, asOf, note };
}

export function estimate<T>(value: T, basis: string, note?: string, asOf: string | null = null): Evidence<T> {
  return { kind: 'estimate', value, source: basis, asOf, note };
}

export function testData<T>(value: T, source: string, asOf: string | null = null, note?: string): Evidence<T> {
  return { kind: 'test_data', value, source, asOf, note };
}

export function missing<T>(reason: string): Evidence<T> {
  return { kind: 'missing', value: null, source: 'none', asOf: null, note: reason };
}

export function has<T>(e: Evidence<T>): e is Evidence<T> & { readonly value: T } {
  return e.kind !== 'missing' && e.value !== null;
}

export function withNote<T>(e: Evidence<T>, note: string): Evidence<T> {
  return { ...e, note };
}

/** The oldest known timestamp among the inputs: a calculated value is only as fresh as its stalest input. */
export function earliestAsOf(...items: Evidence<unknown>[]): string | null {
  const times = items.map((e) => e.asOf).filter((t): t is string => t !== null);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}
