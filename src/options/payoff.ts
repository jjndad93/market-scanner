/** Payoff math for a long call held to expiration. Prices are per share; P/L is for the whole position. */

export function breakevenCall(strike: number, premiumPerShare: number): number {
  return strike + premiumPerShare;
}

/** A long call can never lose more than what was paid for it. */
export function maxLossCall(premiumPerShare: number, multiplier: number, quantity: number): number {
  return premiumPerShare * multiplier * quantity;
}

export function callValueAtExpiry(stockPrice: number, strike: number): number {
  return Math.max(stockPrice - strike, 0);
}

export function callPnlAtExpiry(stockPrice: number, strike: number, premiumPerShare: number, multiplier: number, quantity: number): number {
  return (callValueAtExpiry(stockPrice, strike) - premiumPerShare) * multiplier * quantity;
}

export interface ExpiryScenario {
  label: string;
  stockPrice: number;
  /** Stock move from today's price, as a fraction. */
  move: number;
  /** Position value at expiration. */
  value: number;
  pnl: number;
  /** P/L as a fraction of the amount paid. */
  pnlPct: number;
}

export const DEFAULT_SCENARIO_MOVES = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2];

export function expiryScenarios(
  stockPrice: number,
  strike: number,
  premiumPerShare: number,
  multiplier: number,
  quantity: number,
  moves: number[] = DEFAULT_SCENARIO_MOVES,
): ExpiryScenario[] {
  const cost = maxLossCall(premiumPerShare, multiplier, quantity);
  const points: { label: string; price: number }[] = moves.map((m) => ({
    label: m === 0 ? 'Unchanged' : `Stock ${m > 0 ? '+' : ''}${(m * 100).toFixed(0)}%`,
    price: stockPrice * (1 + m),
  }));
  points.push({ label: 'At strike', price: strike });
  points.push({ label: 'At breakeven', price: breakevenCall(strike, premiumPerShare) });

  const rows: ExpiryScenario[] = [];
  for (const p of points.sort((a, b) => a.price - b.price)) {
    // Drop a generic % row that lands on (almost) the same price as a strike/breakeven row.
    const dup = rows.find((r) => Math.abs(r.stockPrice - p.price) < stockPrice * 0.002);
    if (dup) {
      if (p.label.startsWith('At ')) dup.label = p.label;
      continue;
    }
    const value = callValueAtExpiry(p.price, strike) * multiplier * quantity;
    rows.push({ label: p.label, stockPrice: p.price, move: p.price / stockPrice - 1, value, pnl: value - cost, pnlPct: (value - cost) / cost });
  }
  return rows;
}
