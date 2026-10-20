/** Plain-ASCII formatting so output renders correctly in any Windows console. */

export function money(n: number, digits = 2): string {
  const sign = n < 0 ? '-' : '';
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${sign}$${body}`;
}

export function signedMoney(n: number, digits = 2): string {
  const rounded = Number(n.toFixed(digits));
  return rounded > 0 ? `+${money(n, digits)}` : money(rounded === 0 ? 0 : n, digits);
}

/** Formats a fraction (0.123) as a percentage ("12.3%"). */
export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function signedPct(fraction: number, digits = 1): string {
  const text = (fraction * 100).toFixed(digits);
  return Number(text) > 0 ? `+${text}%` : `${Number(text) === 0 ? (0).toFixed(digits) : text}%`;
}
