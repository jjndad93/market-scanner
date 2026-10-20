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

/**
 * Makes untrusted (e.g. provider-supplied) text safe to print to a terminal: control characters
 * (U+0000-U+001F, U+007F-U+009F) are replaced by visible \\uXXXX escapes, so they cannot clear
 * the screen, move the cursor or start a forged line. Use only at output boundaries; keep the
 * original value for matching and requests.
 */
export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
