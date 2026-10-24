// Budget and unit-price filters for the dashboard. Shared by the browser and the Node tests.
// Explicit filters only: they never change a score, a ranking, or the scanner's order.
// Whole units only (no fractional shares or coins are assumed), before fees. Nothing here
// suggests an asset can be bought through this tool, or that a low unit price means good value.

/**
 * Largest whole number of units with units x price <= budget, robust to binary rounding
 * (for example 0.3 / 0.1 is 2.9999999999999996 in floating point, but 3 units of $0.10 fit $0.30).
 */
export function maxWholeUnits(budget, unitPrice) {
  if (!(budget > 0) || !(unitPrice > 0) || !Number.isFinite(budget) || !Number.isFinite(unitPrice)) return 0;
  let n = Math.floor(budget / unitPrice);
  const eps = budget * 1e-12;
  if ((n + 1) * unitPrice <= budget + eps) n += 1;
  while (n > 0 && n * unitPrice > budget + eps) n -= 1;
  return n;
}

/**
 * The budget check for one asset.
 * @param {number|null} unitPrice USD per unit, or null when unknown
 * @param {number} budget total budget in USD (> 0)
 * @param {number|null} maxUnitPrice unit-price limit in USD, or null for no limit
 */
export function affordability(unitPrice, budget, maxUnitPrice) {
  if (unitPrice === null || !(unitPrice > 0)) {
    return { maxUnits: 0, totalCost: null, passesBudget: false, passesUnitPrice: false, reason: 'unit price not available' };
  }
  const maxUnits = maxWholeUnits(budget, unitPrice);
  const passesBudget = maxUnits >= 1;
  const passesUnitPrice = maxUnitPrice === null || unitPrice <= maxUnitPrice;
  const reasons = [];
  if (!passesBudget) reasons.push('one whole unit costs more than the budget');
  if (!passesUnitPrice) reasons.push('unit price is above the limit');
  return { maxUnits, totalCost: maxUnits * unitPrice, passesBudget, passesUnitPrice, reason: reasons.join('; ') || null };
}

/** Validates the dashboard's budget controls; returns { error } or the parsed values. */
export function parseBudgetControls(budgetText, unitLimitText, noUnitLimit, preference) {
  const budget = Number(budgetText);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1e12) return { error: 'Total budget must be a positive amount in USD.' };
  let maxUnitPrice = null;
  if (!noUnitLimit) {
    maxUnitPrice = Number(unitLimitText);
    if (!Number.isFinite(maxUnitPrice) || maxUnitPrice <= 0) return { error: 'Maximum unit price must be a positive amount in USD, or choose "No unit-price limit".' };
  }
  if (!['affordable', 'signals', 'both'].includes(preference)) return { error: 'Choose a scan preference.' };
  return { budget, maxUnitPrice, preference };
}

/**
 * Sections to display for a preference. Rows keep the scanner's order (never sorted by price).
 * - signals:    qualified signals within budget; qualified signals outside it
 * - affordable: every evaluated asset within budget (signal status shown on each)
 * - both:       qualified within budget; other evaluated assets within budget; qualified outside
 */
export function buildView(rows, { budget, maxUnitPrice, preference }) {
  const withA = rows.map((row) => ({ row, afford: affordability(row.unitPrice, budget, maxUnitPrice) }));
  const fits = (x) => x.afford.passesBudget && x.afford.passesUnitPrice;
  const qualified = (x) => x.row.signal.status === 'qualified' || x.row.signal.status === 'over_display_limit';
  const sections = [];
  if (preference === 'affordable') {
    sections.push({ title: 'Evaluated assets within your budget and unit-price limit', rows: withA.filter(fits) });
  } else {
    sections.push({ title: 'Qualified signals within your budget and unit-price limit', rows: withA.filter((x) => qualified(x) && fits(x)) });
    if (preference === 'both') sections.push({ title: 'Other evaluated assets within your budget (no qualifying signal)', rows: withA.filter((x) => !qualified(x) && fits(x)) });
    sections.push({ title: 'Qualified signals outside your budget or unit-price limit', rows: withA.filter((x) => qualified(x) && !fits(x)), collapsed: true });
  }
  return {
    sections,
    counts: { evaluated: rows.length, withinBudget: withA.filter(fits).length, qualified: withA.filter(qualified).length, qualifiedWithinBudget: withA.filter((x) => qualified(x) && fits(x)).length },
  };
}
