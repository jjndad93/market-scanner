import { type Evidence, estimate, missing, thirdParty, userProvided } from '../core/evidence.ts';
import { parseDateLoose, parseQuoteTime } from '../core/time.ts';
import type { ContractInput, ExerciseStyle, MarketContext, OptionType } from './types.ts';

type Key = keyof ContractInput | keyof MarketContext;

const LABELS: Record<Key, string> = {
  underlying: 'Underlying',
  optionType: 'Option type',
  exerciseStyle: 'Exercise style',
  stockPrice: 'Stock price',
  strike: 'Strike',
  expiration: 'Expiration',
  premium: 'Premium',
  bid: 'Bid',
  ask: 'Ask',
  mark: 'Mark',
  last: 'Last',
  volume: 'Volume',
  openInterest: 'Open interest',
  quantity: 'Quantity',
  multiplier: 'Multiplier',
  quoteTime: 'Quote time',
  quotedIV: 'IV',
  quotedDelta: 'Delta',
  quotedGamma: 'Gamma',
  quotedTheta: 'Theta',
  quotedVega: 'Vega',
  riskFreeRate: 'Risk-free rate',
  dividendYield: 'Dividend yield',
  dividendAmount: 'Dividend',
  exDividendDate: 'Ex-dividend date',
  earningsDate: 'Earnings date',
  historicalVol: 'Historical volatility',
  trend: 'Trend',
};

const ALIASES: Record<Key, string[]> = {
  underlying: ['underlying', 'ticker', 'symbol', 'stock', 'underlyingsymbol'],
  optionType: ['type', 'optiontype', 'callput', 'right'],
  exerciseStyle: ['style', 'exercisestyle'],
  stockPrice: ['stockprice', 'underlyingprice', 'spot', 'spotprice', 'shareprice', 'currentstockprice', 'underlyinglast'],
  strike: ['strike', 'strikeprice'],
  expiration: ['expiration', 'expiry', 'exp', 'expirationdate', 'expirydate', 'expdate'],
  premium: ['premium', 'pricepaid', 'fillprice', 'limitprice', 'optionprice', 'entryprice'],
  bid: ['bid', 'optionbid'],
  ask: ['ask', 'optionask', 'offer'],
  mark: ['mark', 'mid', 'midprice'],
  last: ['last', 'lastprice', 'optionlast', 'lasttrade'],
  volume: ['volume', 'vol', 'optionvolume', 'contractvolume'],
  openInterest: ['openinterest', 'oi'],
  quantity: ['quantity', 'qty', 'contracts', 'numberofcontracts'],
  multiplier: ['multiplier', 'sharespercontract', 'contractsize'],
  quoteTime: ['quotetime', 'asof', 'timestamp', 'quotedat', 'time', 'datatime'],
  quotedIV: ['iv', 'impliedvolatility', 'impliedvol'],
  quotedDelta: ['delta'],
  quotedGamma: ['gamma'],
  quotedTheta: ['theta'],
  quotedVega: ['vega'],
  riskFreeRate: ['riskfreerate', 'rate', 'interestrate'],
  dividendYield: ['dividendyield', 'divyield'],
  dividendAmount: ['dividend', 'dividendamount', 'dividendpershare'],
  exDividendDate: ['exdividenddate', 'exdivdate', 'exdividend', 'exdate'],
  earningsDate: ['earnings', 'earningsdate', 'nextearnings', 'nextearningsdate'],
  historicalVol: ['historicalvolatility', 'historicalvol', 'hv', 'hv30', 'realizedvolatility', 'realizedvol'],
  trend: ['trend', 'recenttrend', 'pricetrend'],
};

const normalizeKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const LOOKUP = new Map<string, Key>();
for (const [key, aliases] of Object.entries(ALIASES) as [Key, string[]][]) {
  for (const alias of aliases) LOOKUP.set(alias, key);
}

export interface ParseResult {
  contract: ContractInput;
  context: MarketContext;
  warnings: string[];
  /** Lines that were not understood, so the user can see what was ignored. */
  unrecognized: string[];
  /** True when a comment in the paste says it is hypothetical / test data. */
  markedAsTestData: boolean;
}

export function parseNumber(text: string): number | null {
  const s = text.replace(/[$,\s]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  return Number(s);
}

/**
 * Reads a percentage. "31.5%" is always 0.315. Without a % sign, values above `decimalMax`
 * are read as percentages ("31.5" -> 0.315) and smaller ones as decimals ("0.315").
 *
 * A value without a % sign whose magnitude lies in [ambiguousMin, decimalMax] (and is not 0)
 * is flagged as ambiguous, because both readings are plausible: for volatility, "3" could be
 * 3% or 300%; for a rate, "0.1" could be 10% or 0.1%.
 */
export function parsePercent(
  text: string,
  decimalMax: number,
  ambiguousMin = Number.POSITIVE_INFINITY,
): { value: number; note?: string; ambiguity?: string } | null {
  const hasSign = text.includes('%');
  const n = parseNumber(text.replace('%', ''));
  if (n === null) return null;
  if (hasSign) return { value: n / 100 };
  if (Math.abs(n) > decimalMax) return { value: n / 100, note: `"${text.trim()}" had no % sign; read as ${n}%.` };
  const asDecimal = `${(n * 100).toFixed(2)}%`;
  const ambiguous = n !== 0 && Math.abs(n) >= ambiguousMin;
  return {
    value: n,
    note: `"${text.trim()}" had no % sign; read as a decimal (${asDecimal}).`,
    ambiguity: ambiguous ? `"${text.trim()}" has no % sign and could mean ${n}% or ${asDecimal}; it was read as ${asDecimal}.` : undefined,
  };
}

interface SymbolLine {
  underlying: string;
  expiration: string;
  strike: number;
  type: OptionType;
}

/** Recognises "XMPL261218C00055000" (OCC symbol) and "XMPL Dec 18 2026 55 Call" style lines. */
export function parseSymbolLine(line: string): SymbolLine | null {
  const occ = /^(?:O:)?([A-Z.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i.exec(line.trim());
  if (occ) {
    const expiration = parseDateLoose(`20${occ[2]}-${occ[3]}-${occ[4]}`);
    if (expiration) {
      return {
        underlying: occ[1]!.toUpperCase(),
        expiration,
        strike: Number(occ[6]) / 1000,
        type: occ[5]!.toUpperCase() === 'C' ? 'call' : 'put',
      };
    }
  }
  const human = /^([A-Z.]{1,6})\s+(.+?)\s+\$?(\d+(?:\.\d+)?)\s*(calls?|puts?|c|p)$/i.exec(line.trim());
  if (human) {
    const expiration = parseDateLoose(human[2]!);
    if (expiration) {
      return {
        underlying: human[1]!.toUpperCase(),
        expiration,
        strike: Number(human[3]),
        type: human[4]!.toLowerCase().startsWith('c') ? 'call' : 'put',
      };
    }
  }
  return null;
}

const SOURCE = 'pasted by you';
/** Volatility without a % sign in [1, 3] is ambiguous ("3" = 3% or 300%). */
const VOL_AMBIGUOUS_MIN = 1;
/** A rate or yield without a % sign in (0, 0.2] is ambiguous ("0.1" = 10% or 0.1%). */
const RATE_AMBIGUOUS_MIN = 0;

export function parseContractText(text: string): ParseResult {
  const raw = new Map<Key, string>();
  const warnings: string[] = [];
  const unrecognized: string[] = [];
  let markedAsTestData = false;

  const put = (key: Key, value: string) => {
    const prev = raw.get(key);
    if (prev !== undefined && prev.toLowerCase() !== value.toLowerCase()) {
      warnings.push(`${LABELS[key]} appeared more than once ("${prev}" and "${value}"); using "${value}".`);
    }
    raw.set(key, value);
  };

  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith('//')) {
      if (/hypothetical|test data|sample data|not real/i.test(line)) markedAsTestData = true;
      continue;
    }
    const kv = /^([^:=]+?)\s*[:=]\s*(.*)$/.exec(line);
    if (kv) {
      const key = LOOKUP.get(normalizeKey(kv[1]!));
      if (key) {
        if (kv[2]!.trim() !== '') put(key, kv[2]!.trim());
        continue;
      }
    }
    const sym = parseSymbolLine(line);
    if (sym) {
      put('underlying', sym.underlying);
      put('expiration', sym.expiration);
      put('strike', String(sym.strike));
      put('optionType', sym.type);
      continue;
    }
    unrecognized.push(line);
  }

  // Quote time first: every price-like field is stamped with it.
  let quoteAsOf: string | null = null;
  const quoteRaw = raw.get('quoteTime');
  if (quoteRaw !== undefined) {
    const parsed = parseQuoteTime(quoteRaw);
    if (parsed) {
      quoteAsOf = parsed.iso;
      if (parsed.assumedEt) warnings.push(`Quote time "${quoteRaw}" had no time zone; assumed US Eastern Time.`);
    } else {
      warnings.push(`Could not read the quote time "${quoteRaw}". Use a format like "2026-10-20 09:45 ET".`);
    }
  }

  const absent = <T>(key: Key): Evidence<T> => missing(`${LABELS[key]} not provided.`);
  const unreadable = <T>(key: Key, s: string, why = ''): Evidence<T> => {
    warnings.push(`Could not use ${LABELS[key]} "${s}"${why}; treated as missing.`);
    return missing(`${LABELS[key]} "${s}" could not be read${why}.`);
  };
  const make = <T>(key: Key, value: T, asOf: string | null, party: 'user' | 'third', note?: string): Evidence<T> =>
    party === 'third'
      ? thirdParty(value, `${SOURCE} (broker-reported ${LABELS[key]})`, asOf, note)
      : userProvided(value, `${SOURCE}: ${LABELS[key]}`, asOf, note);

  const num = (key: Key, opts: { min?: number; positive?: boolean; integer?: boolean; quoted?: boolean; party?: 'user' | 'third' } = {}): Evidence<number> => {
    const s = raw.get(key);
    if (s === undefined) return absent(key);
    const n = parseNumber(s);
    if (n === null) return unreadable(key, s);
    if (opts.positive && !(n > 0)) return unreadable(key, s, ' (must be greater than zero)');
    if (opts.min !== undefined && n < opts.min) return unreadable(key, s, ` (must be at least ${opts.min})`);
    if (opts.integer && !Number.isInteger(n)) return unreadable(key, s, ' (must be a whole number)');
    return make(key, n, opts.quoted ? quoteAsOf : null, opts.party ?? 'user');
  };

  const percent = (key: Key, decimalMax: number, ambiguousMin: number, opts: { quoted?: boolean; party?: 'user' | 'third' } = {}): Evidence<number> => {
    const s = raw.get(key);
    if (s === undefined) return absent(key);
    const p = parsePercent(s, decimalMax, ambiguousMin);
    if (p === null) return unreadable(key, s);
    if (p.value < 0) return unreadable(key, s, ' (cannot be negative)');
    if (p.note) warnings.push(`${LABELS[key]}: ${p.note}`);
    const ev = make(key, p.value, opts.quoted ? quoteAsOf : null, opts.party ?? 'user', p.note);
    return p.ambiguity ? { ...ev, ambiguity: p.ambiguity } : ev;
  };

  const date = (key: Key): Evidence<string> => {
    const s = raw.get(key);
    if (s === undefined) return absent(key);
    const iso = parseDateLoose(s);
    return iso ? make(key, iso, null, 'user') : unreadable(key, s, ' (use a date like 2026-12-18)');
  };

  const typeRaw = raw.get('optionType');
  let optionType: Evidence<OptionType>;
  if (typeRaw === undefined) {
    optionType = estimate<OptionType>('call', 'assumed', 'Not stated in the paste; this evaluator assumes a call.');
  } else if (/^c(alls?)?$/i.test(typeRaw)) {
    optionType = make<OptionType>('optionType', 'call', null, 'user');
  } else if (/^p(uts?)?$/i.test(typeRaw)) {
    optionType = make<OptionType>('optionType', 'put', null, 'user');
  } else {
    optionType = unreadable('optionType', typeRaw, ' (expected Call or Put)');
  }

  const styleRaw = raw.get('exerciseStyle');
  let exerciseStyle: Evidence<ExerciseStyle>;
  if (styleRaw === undefined) {
    exerciseStyle = estimate<ExerciseStyle>('american', 'standard for US-listed equity options', 'Not stated; US-listed stock options are American-style.');
  } else if (/^am/i.test(styleRaw)) {
    exerciseStyle = make<ExerciseStyle>('exerciseStyle', 'american', null, 'user');
  } else if (/^eu/i.test(styleRaw)) {
    exerciseStyle = make<ExerciseStyle>('exerciseStyle', 'european', null, 'user');
  } else {
    exerciseStyle = unreadable('exerciseStyle', styleRaw, ' (expected American or European)');
  }

  const underlyingRaw = raw.get('underlying');
  const quantity = raw.has('quantity')
    ? num('quantity', { positive: true, integer: true })
    : estimate(1, 'default: 1 contract');
  const multiplier = raw.has('multiplier')
    ? num('multiplier', { positive: true })
    : estimate(100, 'standard US equity option multiplier', 'Adjusted contracts (after splits or mergers) can deliver a different number of shares; check your broker.');

  const contract: ContractInput = {
    underlying: underlyingRaw !== undefined ? make('underlying', underlyingRaw.toUpperCase(), null, 'user') : absent('underlying'),
    optionType,
    exerciseStyle,
    stockPrice: num('stockPrice', { positive: true, quoted: true }),
    strike: num('strike', { positive: true }),
    expiration: date('expiration'),
    premium: num('premium', { min: 0, quoted: true }),
    bid: num('bid', { min: 0, quoted: true }),
    ask: num('ask', { min: 0, quoted: true }),
    mark: num('mark', { min: 0, quoted: true }),
    last: num('last', { min: 0, quoted: true }),
    volume: num('volume', { min: 0, integer: true, quoted: true }),
    openInterest: num('openInterest', { min: 0, integer: true, quoted: true }),
    quantity,
    multiplier,
    quoteTime: quoteAsOf !== null ? make('quoteTime', quoteAsOf, quoteAsOf, 'user') : missing('Quote time not provided, so it is unknown how fresh the prices are.'),
    quotedIV: percent('quotedIV', 3, VOL_AMBIGUOUS_MIN, { quoted: true, party: 'third' }),
    quotedDelta: num('quotedDelta', { quoted: true, party: 'third' }),
    quotedGamma: num('quotedGamma', { quoted: true, party: 'third' }),
    quotedTheta: num('quotedTheta', { quoted: true, party: 'third' }),
    quotedVega: num('quotedVega', { quoted: true, party: 'third' }),
  };

  const trendRaw = raw.get('trend');
  const context: MarketContext = {
    riskFreeRate: percent('riskFreeRate', 0.2, RATE_AMBIGUOUS_MIN),
    dividendYield: percent('dividendYield', 0.2, RATE_AMBIGUOUS_MIN),
    dividendAmount: num('dividendAmount', { min: 0 }),
    exDividendDate: date('exDividendDate'),
    earningsDate: date('earningsDate'),
    historicalVol: percent('historicalVol', 3, VOL_AMBIGUOUS_MIN),
    trend: trendRaw !== undefined ? make('trend', trendRaw, null, 'user') : absent('trend'),
  };

  return { contract, context, warnings, unrecognized, markedAsTestData };
}

export const PASTE_TEMPLATE = `# Paste or type the contract details, one per line. Only the first block is required.
# Required
Underlying: XMPL
Stock price: 52.40
Strike: 55
Expiration: 2026-12-18
Type: Call
# Price: give the bid and ask if you can, plus the premium you would actually pay
Bid: 2.35
Ask: 2.45
Premium: 2.45
# Strongly recommended
Quote time: 2026-10-20 10:15 ET
Volume: 1180
Open interest: 6420
Earnings date: 2026-11-05
Historical volatility: 33%
# Optional
Quantity: 1
IV: 38.2%
Delta: 0.41
Risk-free rate: 4%
Dividend yield: 0%
Ex-dividend date: 2026-11-20
Dividend: 0.25
Trend: up 6% over 20 trading days
# A symbol line also works instead of Underlying/Strike/Expiration/Type:
# XMPL Dec 18 2026 55 Call      or      XMPL261218C00055000
# (All values above are illustrative placeholders, not real quotes.)`;
