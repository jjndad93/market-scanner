import { type EvidenceKind, KIND_LABEL, KIND_LEGEND } from '../core/evidence.ts';
import { money, pct, signedMoney, signedPct } from '../core/format.ts';
import type { CheckStatus, Evaluation, MetricLine, Verdict } from './evaluate.ts';

export interface RenderContext {
  /** Where the input came from, e.g. "file examples/x.txt". */
  inputDescription: string;
  parseWarnings: string[];
  unrecognized: string[];
  markedAsTestData: boolean;
}

const WIDTH = 100;

const VERDICT_LABEL: Record<Verdict, string> = {
  RELATIVELY_STRONG: 'RELATIVELY STRONG (on the available evidence)',
  MIXED: 'MIXED',
  WEAK: 'WEAK',
  TOO_RISKY: 'TOO RISKY',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA - cannot assess reliably',
};

const STATUS_TAG: Record<CheckStatus, string> = {
  pass: '[PASS]   ',
  caution: '[CAUTION]',
  fail: '[FAIL]   ',
  unknown: '[UNKNOWN]',
};

function wrap(text: string, indent: string, firstIndent = indent): string[] {
  const lines: string[] = [];
  let current = firstIndent;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const base = lines.length === 0 ? firstIndent : indent;
    if (current.length + word.length + 1 > WIDTH && current.trim() !== '') {
      lines.push(current);
      current = indent + word;
    } else {
      current = current === base ? base + word : `${current} ${word}`;
    }
  }
  if (current.trim() !== '') lines.push(current);
  return lines;
}

function formatValue(m: MetricLine): string {
  const v = m.evidence.value;
  if (v === null) return '-';
  if (typeof v === 'string') return v;
  switch (m.format) {
    case 'price':
      return money(v, Math.abs(v) < 0.1 && v !== 0 ? 3 : 2);
    case 'money':
      return money(v);
    case 'pct':
      return pct(v);
    case 'signedPct':
      return signedPct(v);
    case 'greek':
      return v.toFixed(3);
    case 'int':
      return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    case 'days':
      return `${v} days`;
    default:
      return String(v);
  }
}

function table(headers: string[], rows: string[][], indent = '  '): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => indent + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('   ');
  return [fmt(headers), indent + widths.map((w) => '-'.repeat(w)).join('   '), ...rows.map(fmt)];
}

export function renderEvaluation(ev: Evaluation, ctx: RenderContext): string {
  const out: string[] = [];
  const rule = '='.repeat(WIDTH);
  const section = (title: string) => out.push('', title, '-'.repeat(title.length));

  out.push(rule, `OPTION EVALUATION: ${ev.label}`, `Evaluated: ${ev.evaluatedAt}`);
  out.push(...wrap(`Input: ${ctx.inputDescription}. Every number below comes from that input or is calculated from it. No live market data was fetched (Stage 1 is offline), and nothing was independently verified.`, '', ''));
  if (ctx.markedAsTestData) out.push('', '!! THIS INPUT IS MARKED AS HYPOTHETICAL / TEST DATA. These are not real market quotes. !!');
  out.push(rule);

  section(`VERDICT: ${VERDICT_LABEL[ev.verdict]}`);
  out.push(...wrap(ev.verdictSummary, '  ', '  '));
  if (ev.verdictReasons.length > 0) {
    out.push('  Why:');
    for (const r of ev.verdictReasons) out.push(...wrap(r, '      ', '    - '));
  }
  out.push('', ...wrap(`Price check: ${ev.valuation}`, '  ', '  '));

  if (ev.missingRequired.length > 0 || ev.missingHelpful.length > 0) {
    section('MISSING INFORMATION');
    if (ev.missingRequired.length > 0) {
      out.push('  Required before this contract can be assessed:');
      for (const m of ev.missingRequired) out.push(...wrap(m, '      ', '    - '));
    }
    if (ev.missingHelpful.length > 0) {
      out.push('  Would make the assessment more complete:');
      for (const m of ev.missingHelpful) out.push(...wrap(m, '      ', '    - '));
    }
  }

  section('KEY NUMBERS');
  const used = new Set<EvidenceKind>(ev.metrics.map((m) => m.evidence.kind));
  out.push('  Tags:');
  for (const kind of Object.keys(KIND_LABEL) as EvidenceKind[]) {
    if (used.has(kind)) out.push(`    ${KIND_LABEL[kind].padEnd(13)} = ${KIND_LEGEND[kind]}`);
  }
  let group = '';
  for (const m of ev.metrics) {
    if (m.group !== group) {
      group = m.group;
      out.push('', `  ${group}`);
    }
    out.push(`    ${m.label.padEnd(48, '.')} ${formatValue(m).padEnd(20)} [${KIND_LABEL[m.evidence.kind]}]`);
    const details: string[] = [];
    if (m.evidence.kind === 'calculated' || m.evidence.kind === 'estimate') details.push(`basis: ${m.evidence.source}`);
    if (m.evidence.note) details.push(m.evidence.note);
    if (details.length > 0 && !(m.evidence.kind === 'missing' && m.evidence.note?.endsWith('not provided.'))) {
      out.push(...wrap(details.join('. ').replace(/\.\./g, '.'), '        ', '        '));
    }
  }

  section('CHECKS');
  for (const c of ev.checks) {
    out.push(`  ${STATUS_TAG[c.status]} ${c.title}`);
    out.push(...wrap(c.detail, '              ', '              '));
  }

  if (ev.expiryScenarios.length > 0) {
    section('AT EXPIRATION (whole position, per the payoff formula - no model needed)');
    out.push(...table(
      ['Scenario', 'Stock price', 'Move', 'Position value', 'Profit/loss', 'P/L %'],
      ev.expiryScenarios.map((s) => [s.label, money(s.stockPrice), signedPct(s.move), money(s.value), signedMoney(s.pnl), signedPct(s.pnlPct, 0)]),
    ));
  }

  if (ev.whatIf) {
    const w = ev.whatIf;
    section(`BEFORE EXPIRATION: model profit/loss on ${w.atDate} (${w.daysElapsed} days from now) [ESTIMATE]`);
    out.push(...wrap('Rows: stock move from today. Columns: change in implied volatility, in percentage points. Values are Black-Scholes estimates at mid-market prices; selling at the bid would realize less.', '  ', '  '), '');
    out.push(...table(
      ['Stock move', ...w.ivChangePoints.map((d) => (d === 0 ? 'IV unchanged' : `IV ${d > 0 ? '+' : ''}${d} pts`))],
      w.stockMoves.map((m, i) => [signedPct(m, 0), ...w.pnl[i]!.map((p) => signedMoney(p))]),
    ));
  }

  section('WHAT THIS MEANS');
  for (const e of ev.explanations) out.push(...wrap(e, '    ', '  - '));

  const allWarnings = [...ctx.parseWarnings, ...ev.warnings];
  if (allWarnings.length > 0 || ctx.unrecognized.length > 0) {
    section('DATA NOTES');
    for (const w of allWarnings) out.push(...wrap(w, '    ', '  - '));
    for (const u of ctx.unrecognized) out.push(...wrap(`Ignored a line that was not understood: "${u}"`, '    ', '  - '));
  }

  section('MODEL LIMITATIONS (Black-Scholes-Merton)');
  for (const l of ev.modelLimitations) out.push(...wrap(l, '    ', '  - '));

  out.push('', rule);
  out.push(...wrap('Research aid only, not financial advice. No outcome is certain. This tool does not connect to a brokerage or place orders.', '', ''));
  out.push(rule);
  return out.join('\n');
}
