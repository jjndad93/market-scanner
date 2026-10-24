// Market Scanner dashboard. Renders the existing scanner's JSON result plus server-built rows.
// All scanner text is inserted with textContent, never as HTML.
import { buildView, parseBudgetControls } from '/budget.js';
import { coverageFigures, coverageSentences, dashboardWording, exclusionBreakdown, leadCrossCheckWarnings, plainCheck } from '/simple-view.js';

const $ = (id) => document.getElementById(id);
const state = { status: null, running: false, lastRequest: null, last: null, news: new Map(), wtb: new Map(), cmc: null };
const MARKET = {
  crypto: { button: 'Scan Crypto', blurb: 'Movers and watchlist candidates from the CoinGecko top 250, using the existing scanner rules.', keyFlag: 'cryptoKeyConfigured', keyEnv: 'COINGECKO_DEMO_API_KEY', provider: 'CoinGecko', pace: 'about 0.7 s apart' },
  stocks: { button: 'Scan US Stocks', blurb: 'Movers and watchlist candidates from a fixed list of 20 large US stocks (end-of-day bars).', keyFlag: 'stocksKeyConfigured', keyEnv: 'POLYGON_API_KEY', provider: 'Massive', pace: 'about 12.5 s apart (free plan: 5 per minute)' },
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const usd = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};
const price = (n) => (n === null || n === undefined ? 'n/a' : `$${n.toFixed(n >= 1 ? 2 : n >= 0.01 ? 4 : 8)}`);
const money = (n) => (n === null || n === undefined ? 'n/a' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n) => (n === null || n === undefined ? 'n/a' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const signClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const when = (iso) => (iso ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date(iso).toLocaleString()) : 'n/a');
const checked = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

function updateControls() {
  const market = checked('market');
  const live = checked('mode') === 'live';
  const m = MARKET[market];
  $('scan-btn').textContent = m.button;
  $('market-blurb').textContent = m.blurb;
  const budget = $('max-requests');
  budget.disabled = !live || state.running;
  const cap = state.status?.maxRequestsCap ?? 160;
  budget.max = String(cap);
  $('budget-hint').textContent = live ? `Whole number 1-${cap}. The server enforces it; retries count toward it.` : 'Live only. Offline scans make no API requests.';
  $('live-warning').hidden = !live;
  if (live) {
    const n = Number(budget.value);
    const keyNote = state.status && !state.status[m.keyFlag] ? ` The ${m.keyEnv} environment variable is not set on the server, so a live scan will stop before any request.` : '';
    $('live-warning-text').textContent = `A live ${market} scan uses up to ${Number.isInteger(n) && n > 0 ? n : '?'} ${m.provider} request(s), ${m.pace}. You will be asked to confirm.${keyNote}`;
  }
  $('unit-limit').disabled = $('no-unit-limit').checked;
  for (const id of ['scan-btn', 'rerun-btn']) $(id).disabled = state.running;
  document.querySelectorAll('input[name="mode"], input[name="market"]').forEach((r) => { r.disabled = state.running; });
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status', { headers: { accept: 'application/json' } });
    state.status = await r.json();
    if (Number.isInteger(state.status.defaultMaxRequests)) $('max-requests').value = String(state.status.defaultMaxRequests);
  } catch {
    showError('Could not reach the local server. Is "npm run web" still running?');
  }
  updateControls();
}

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

async function scan(request) {
  if (state.running) return;
  if (request.mode === 'live') {
    const ok = window.confirm(`Run a LIVE ${request.market} scan?\n\nThis spends up to ${request.maxRequests} ${MARKET[request.market].provider} API request(s), counting retries.`);
    if (!ok) return;
    request = { ...request, confirmLive: true };
  }
  state.running = true;
  state.lastRequest = request;
  showError('');
  $('running').hidden = false;
  $('running-text').textContent = request.mode === 'live'
    ? `Scanning ${request.market} live (up to ${request.maxRequests} requests, ${MARKET[request.market].pace})…`
    : `Scanning the synthetic ${request.market} fixture (no API requests)…`;
  updateControls();
  try {
    const { market, ...body } = request;
    const r = await fetch(`/api/scan/${market === 'stocks' ? 'stocks' : 'crypto'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-market-scanner': '1', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) showError(dashboardWording(data.error) || `The scan failed (HTTP ${r.status}).`);
    else {
      state.last = data;
      state.news = new Map(); // news panels belong to one scan
      state.wtb = new Map(); // so do "where to buy" panels
      state.cmc = null; // so does a cross-check
      render();
      $('rerun-btn').hidden = false;
    }
  } catch {
    showError('Could not reach the local server. Is "npm run web" still running?');
  } finally {
    state.running = false;
    $('running').hidden = true;
    updateControls();
  }
}

function currentRequest() {
  const market = checked('market');
  if (checked('mode') === 'offline') return { market, mode: 'offline' };
  const n = Number($('max-requests').value);
  const cap = state.status?.maxRequestsCap ?? 160;
  if (!Number.isInteger(n) || n < 1 || n > cap) {
    showError(`Max API requests must be a whole number from 1 to ${cap}.`);
    return null;
  }
  return { market, mode: 'live', maxRequests: n };
}

// ---- results -----------------------------------------------------------------------------------

function stat(label, value, sub) {
  return el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), sub ? el('div', { class: 'sub' }, sub) : null);
}

const STATUS_LABEL = { qualified: 'Qualified', over_display_limit: 'Qualified (over display limit)', below_threshold: 'Below threshold', no_pattern: 'No signal pattern' };

function classificationCell(c) {
  if (!c) return el('span', { class: 'muted' }, 'US stock (fixed list)');
  const basis = { provider: 'provider data', curated_list: 'curated list', heuristic: 'heuristic', none: 'no reliable evidence' }[c.basis];
  return el('div', {},
    el('span', { class: `chip ${c.category === 'unknown' ? 'dim' : 'cat'}` }, c.label),
    el('div', { class: 'sym' }, basis),
    el('details', {}, el('summary', {}, 'Evidence'), el('ul', {}, ...(c.evidence.length ? c.evidence : ['none']).map((e) => el('li', {}, e)), c.note ? el('li', {}, `Note: ${c.note}`) : null)));
}

function riskCell(row) {
  const r = row.risk;
  const lines = [];
  if (row.market === 'crypto') {
    lines.push(`24h range: ${r.range24hPct === null ? 'n/a' : `${r.range24hPct.toFixed(1)}%`}; from 24h high: ${pct(r.fromHigh24hPct)}`);
    lines.push(`From all-time high: ${pct(r.athChangePct)}${r.athDate ? ` (ATH ${when(r.athDate)})` : ''}`);
    lines.push(`Turnover: ${r.turnoverPct === null ? 'n/a' : `${r.turnoverPct.toFixed(1)}%`} of market cap; data ${r.dataAgeMinutes === null ? 'age n/a' : `${r.dataAgeMinutes} min old`}`);
    const v = r.volumeReliability;
    lines.push(`Volume baseline: ${v.insufficient ? `not measured (${v.validDays} valid days)` : `${v.highlyVariable ? 'HIGHLY VARIABLE' : 'stable'} (Q3/Q1 ${v.iqrRatio.toFixed(1)}x)`}`);
  } else {
    lines.push(`Session ${r.sessionDate}; ${usd(r.dollarVolume)} traded`);
  }
  return el('div', { class: 'risk' },
    ...lines.map((l) => el('div', {}, l)),
    ...r.flags.map((f) => el('div', { class: 'flag' }, f)),
    el('details', {}, el('summary', {}, 'Period and limits'), el('ul', {}, el('li', {}, `Period: ${r.period}`), ...r.unavailable.map((u) => el('li', {}, `Not available: ${u}`)))));
}

function rowView({ row, afford }) {
  const fit = afford.passesBudget && afford.passesUnitPrice;
  return el('tr', {},
    el('td', { class: 'asset' }, el('div', { class: 'name' }, row.name), el('div', { class: 'sym' }, row.market === 'crypto' ? `${row.symbol} · ${row.id}` : row.symbol),
      row.why.length ? el('details', {}, el('summary', {}, 'Why'), el('ul', {}, ...row.why.map((w) => el('li', {}, w)))) : null,
      newsButton(row), wtbButton(row)),
    el('td', {}, el('span', { class: `chip ${row.signal.category === 'Mover' ? 'mover' : row.signal.category === 'Watchlist' ? 'watch' : 'dim'}` }, row.signal.category ?? STATUS_LABEL[row.signal.status]),
      row.signal.category ? el('div', { class: 'sym' }, STATUS_LABEL[row.signal.status]) : null),
    el('td', { class: 'num' }, row.signal.score === null ? '—' : `${row.signal.score}/${row.signal.maxScore}`,
      el('div', { class: 'sym' }, row.volumeMultiple === null ? '' : `${row.volumeMultiple.toFixed(2)}x volume`)),
    el('td', { class: 'num' }, price(row.unitPrice), el('div', { class: 'sym' }, `${when(row.priceAsOf)} · ${row.dataKind === 'test_data' ? 'TEST DATA' : 'VERIFIED DATA'}`)),
    el('td', { class: 'num' }, afford.maxUnits.toLocaleString(), el('div', { class: 'sym' }, `≈ ${money(afford.totalCost)} before fees`)),
    el('td', {}, el('span', { class: `chip ${fit ? 'complete' : 'partial'}` }, fit ? 'Within limits' : 'Outside limits'), afford.reason ? el('div', { class: 'sym' }, afford.reason) : null),
    el('td', { class: `num ${signClass(row.change.short.value)}` }, `${pct(row.change.short.value)} ${row.change.short.label}`,
      el('div', { class: `sym ${signClass(row.change.long.value)}` }, `${pct(row.change.long.value)} ${row.change.long.label}`)),
    el('td', {}, classificationCell(row.classification)),
    el('td', {}, riskCell(row), ...row.warnings.filter((w) => !row.risk.flags.includes(w)).map((w) => el('div', { class: 'sym' }, w))));
}

// ---- news panel ("Why it may be moving") -------------------------------------------------------
// Opened per asset by the user; nothing is fetched until then. Live news needs a confirmation and
// spends one Massive request; cached results (up to an hour) are free. Article text is untrusted:
// it is inserted as text only, and links open in a new tab without a referrer.

const ROLE = {
  possible_catalyst: (s) => [`Possible catalyst (${s} evidence)`, 'cat'],
  reported_after: () => ['Published after the move', 'dim'],
  background: () => ['Background only', 'dim'],
  unplaced: () => ['Time unknown', 'dim'],
};
const VERDICT_CLASS = { possible_catalyst: 'cat', conflicting: 'partial', unconfirmed: 'dim', no_news: 'dim', no_source: 'dim' };

function newsButton(row) {
  const open = state.news.get(row.key)?.open;
  const b = el('button', { type: 'button', class: 'linkish' }, open ? 'Hide news' : 'News & why it may be moving');
  b.addEventListener('click', () => toggleNews(row));
  return el('div', {}, b);
}

function newsLimit() {
  const n = Number($('news-limit').value);
  const max = state.status?.newsMaxLimit ?? 20;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

async function loadNews(row, { refresh = false, confirmLive = false } = {}) {
  const entry = state.news.get(row.key) ?? { open: true };
  const limit = newsLimit();
  if (limit === null) {
    state.news.set(row.key, { ...entry, open: true, loading: false, error: `News articles per asset must be a whole number from 1 to ${state.status?.newsMaxLimit ?? 20}.` });
    return render();
  }
  state.news.set(row.key, { ...entry, open: true, loading: true, error: null, needsConfirm: false });
  render();
  try {
    const r = await fetch(`/api/news/${row.market === 'stocks' ? 'stocks' : 'crypto'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-market-scanner': '1', accept: 'application/json' },
      body: JSON.stringify({ key: row.key, limit, refresh, confirmLive }),
    });
    const data = await r.json();
    const next = { open: true, loading: false, data: data.ok ? data : entry.data }; // keep an earlier result visible on failure
    if (!data.ok) {
      next.needsConfirm = Boolean(data.needsConfirm);
      next.error = data.needsConfirm ? null : data.error || `The news request failed (HTTP ${r.status}).`;
    }
    state.news.set(row.key, next);
  } catch {
    state.news.set(row.key, { ...entry, open: true, loading: false, error: 'Could not reach the local server.' });
  }
  render();
}

function toggleNews(row) {
  const entry = state.news.get(row.key);
  if (entry?.open) {
    state.news.set(row.key, { ...entry, open: false });
    return render();
  }
  if (entry?.data) {
    state.news.set(row.key, { ...entry, open: true });
    return render();
  }
  loadNews(row);
}

function confirmAndLoad(row, refresh) {
  const ok = window.confirm(`Fetch live news for ${row.symbol}?\n\nThis spends 1 Massive API request (the free plan allows 5 per minute, shared with stock scans).`);
  if (ok) loadNews(row, { refresh, confirmLive: true });
}

function movementBlock(row) {
  const r = row.risk;
  const items = [
    `Change: ${pct(row.change.short.value)} ${row.change.short.label}, ${pct(row.change.long.value)} ${row.change.long.label}`,
    row.volumeMultiple === null ? 'Volume multiple: not available' : `Volume: ${row.volumeMultiple.toFixed(2)}x the baseline median`,
  ];
  if (row.market === 'crypto') {
    items.push(r.range24hPct === null ? 'Intraday: 24h range not available from this data' : `24h range ${r.range24hPct.toFixed(1)}%; ${pct(r.fromHigh24hPct)} from the 24h high`);
    if (r.athChangePct !== null) items.push(`${pct(r.athChangePct)} from the all-time high`);
  } else {
    items.push('Intraday range: not available (end-of-day bars only)');
  }
  items.push(`Data: ${row.priceBasis}, ${when(row.priceAsOf)} [${row.dataKind === 'test_data' ? 'TEST DATA' : 'provider data'}]`);
  return el('ul', { class: 'notes' }, ...items.map((i) => el('li', {}, i)), ...r.flags.map((f) => el('li', { class: 'flag' }, f)));
}

function articleCard(x) {
  const a = x.article;
  const [label, cls] = ROLE[x.role](x.strength);
  const link = a.url && /^https?:\/\//.test(a.url)
    ? el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'View original article ↗')
    : el('span', { class: 'muted' }, 'Original link unavailable (missing or unsafe link from the provider)');
  return el('article', { class: 'news-card' },
    el('div', { class: 'news-head' }, el('span', { class: `chip ${cls}` }, label), el('span', { class: 'sym' }, `${a.publisher} · ${a.publishedUtc ? when(a.publishedUtc) : 'publication time unknown'}`)),
    el('div', { class: 'news-title' }, a.title),
    a.description ? el('p', { class: 'news-desc' }, el('b', {}, 'Summary (publisher/provider text, not verified): '), a.description) : el('p', { class: 'muted' }, 'No summary provided.'),
    el('p', { class: 'news-desc' }, el('b', {}, 'Reported fact: '), x.fact),
    el('p', { class: 'news-desc' }, el('b', {}, 'Why it may be relevant: '), x.relevance),
    a.sentiment ? el('p', { class: 'sym' }, `Provider's automated sentiment (AI-generated, not verified): ${a.sentiment}${a.sentimentReasoning ? ` (${a.sentimentReasoning})` : ''}`) : null,
    link);
}

function newsPanelRow(row) {
  const entry = state.news.get(row.key);
  if (!entry?.open) return null;
  const body = el('div', { class: 'news-panel' }, el('h4', {}, `Market movement & news: ${row.name} (${row.symbol})`), movementBlock(row));
  const d = entry.data;
  if (entry.loading) body.append(el('div', { class: 'running' }, el('span', { class: 'spinner' }), 'Loading news…'));
  if (entry.error) body.append(el('div', { class: 'error' }, entry.error));
  if (entry.needsConfirm) {
    const b = el('button', { type: 'button', class: 'secondary' }, 'Fetch live news (1 Massive request)');
    b.addEventListener('click', () => confirmAndLoad(row, false));
    body.append(el('div', { class: 'warning' }, 'Live news is fetched only when you ask.', b));
  }
  if (d) {
    const s = d.assessment;
    body.append(el('div', { class: 'verdict' },
      el('div', {}, el('b', {}, 'Why it may be moving: '), el('span', { class: `chip ${VERDICT_CLASS[s.verdict.kind]}` }, s.verdict.label)),
      el('p', {}, s.movement), el('p', {}, s.verdict.text),
      ...s.notes.map((n) => el('p', { class: 'sym' }, n))));
    if (d.dataKind === 'test_data') body.append(el('div', { class: 'banner test' }, 'TEST DATA: synthetic articles with invented publishers and example.com links. NOT real news.'));
    if (d.warning) body.append(el('div', { class: 'warning' }, d.warning));
    if (d.source === null) body.append(el('p', { class: 'empty' }, 'No news source is configured for crypto, so no articles were checked.'));
    else if (s.articles.length === 0) body.append(el('p', { class: 'empty' }, 'No relevant news found for this asset.'));
    else body.append(el('div', { class: 'news-list' }, ...s.articles.map(articleCard)));
    const dropped = [s.droppedUnrelated ? `${s.droppedUnrelated} unrelated article(s) hidden` : '', s.droppedDuplicates ? `${s.droppedDuplicates} duplicate(s) removed` : '', d.skipped ? `${d.skipped} malformed article(s) skipped` : ''].filter(Boolean);
    body.append(el('ul', { class: 'notes' },
      d.source ? el('li', {}, `Source: ${d.source}${d.attribution ? `. ${d.attribution}` : ''}`) : null,
      d.fetchedAt ? el('li', {}, `Fetched ${when(d.fetchedAt)}${d.fromCache ? ' (cached; no request made)' : ''}; requests used: ${d.requestsUsed}; up to ${d.limit} article(s).`) : null,
      dropped.length ? el('li', {}, dropped.join('; ')) : null,
      ...d.coverage.map((c) => el('li', {}, c))));
    if (d.market === 'stocks' && d.mode === 'live') {
      const b = el('button', { type: 'button', class: 'secondary' }, 'Refresh news (1 request)');
      b.addEventListener('click', () => confirmAndLoad(row, true));
      body.append(b);
    }
  }
  return el('tr', { class: 'news-row' }, el('td', { colspan: '9' }, body));
}

// ---- where to buy -------------------------------------------------------------------------------
// Opened per asset by the user. Crypto (live) spends one CoinGecko request after a confirmation;
// cached results (up to an hour) are free. Stocks never make a request. Exchange names and links
// come from the provider: inserted as text, links only when https, opened without a referrer.

const US_LABEL = { serves_us: ['Generally serves US customers', 'complete'], restricts_us: ['Generally restricts US customers', 'partial'], unknown: ['US access not checked', 'dim'] };
const TRUST_LABEL = { green: 'CoinGecko trust: green', yellow: 'CoinGecko trust: yellow', red: 'CoinGecko trust: red' };

function wtbButton(row) {
  const open = state.wtb.get(row.key)?.open;
  const b = el('button', { type: 'button', class: 'linkish' }, open ? 'Hide where to buy' : 'Where to buy');
  b.addEventListener('click', () => toggleWtb(row));
  return el('div', {}, b);
}

async function loadWtb(row, { refresh = false, confirmLive = false } = {}) {
  const entry = state.wtb.get(row.key) ?? { open: true };
  state.wtb.set(row.key, { ...entry, open: true, loading: true, error: null, needsConfirm: false });
  render();
  try {
    const r = await fetch(`/api/where-to-buy/${row.market === 'stocks' ? 'stocks' : 'crypto'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-market-scanner': '1', accept: 'application/json' },
      body: JSON.stringify({ key: row.key, refresh, confirmLive }),
    });
    const data = await r.json();
    const next = { open: true, loading: false, data: data.ok ? data : entry.data };
    if (!data.ok) {
      next.needsConfirm = Boolean(data.needsConfirm);
      next.error = data.needsConfirm ? null : data.error || `The lookup failed (HTTP ${r.status}).`;
    }
    state.wtb.set(row.key, next);
  } catch {
    state.wtb.set(row.key, { ...entry, open: true, loading: false, error: 'Could not reach the local server.' });
  }
  render();
}

function toggleWtb(row) {
  const entry = state.wtb.get(row.key);
  if (entry?.open) {
    state.wtb.set(row.key, { ...entry, open: false });
    return render();
  }
  if (entry?.data) {
    state.wtb.set(row.key, { ...entry, open: true });
    return render();
  }
  loadWtb(row);
}

function confirmWtb(row, refresh) {
  const ok = window.confirm(`Look up where ${row.symbol} trades?\n\nThis spends 1 CoinGecko API request.`);
  if (ok) loadWtb(row, { refresh, confirmLive: true });
}

function venueRow(v) {
  const [usText, usCls] = US_LABEL[v.usAccess];
  const link = v.tradeUrl && /^https:\/\//.test(v.tradeUrl) ? el('a', { href: v.tradeUrl, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Open market ↗') : el('span', { class: 'muted' }, 'no link');
  return el('tr', {},
    el('td', {}, el('div', { class: 'name' }, v.exchange), v.kind === 'cex' ? el('span', { class: `chip ${usCls}` }, usText) : null),
    el('td', {}, v.pairs.join(', ')),
    el('td', { class: 'num' }, usd(v.volumeUsd)),
    el('td', {}, v.trust ? TRUST_LABEL[v.trust] : 'n/a'),
    el('td', {}, link));
}

function venueTable(title, venues) {
  if (!venues.length) return el('div', {}, el('h5', {}, title), el('p', { class: 'empty' }, 'None found.'));
  return el('div', {}, el('h5', {}, title), el('div', { class: 'table-wrap' }, el('table', { class: 'wtb-table' },
    el('thead', {}, el('tr', {}, ...['Exchange', 'Pairs', '24h volume', 'Trust', 'Link'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...venues.map(venueRow)))));
}

function wtbPanelRow(row) {
  const entry = state.wtb.get(row.key);
  if (!entry?.open) return null;
  const body = el('div', { class: 'news-panel' }, el('h4', {}, `Where to buy: ${row.name} (${row.symbol})`));
  if (entry.loading) body.append(el('div', { class: 'running' }, el('span', { class: 'spinner' }), 'Looking up markets…'));
  if (entry.error) body.append(el('div', { class: 'error' }, entry.error));
  if (entry.needsConfirm) {
    const b = el('button', { type: 'button', class: 'secondary' }, 'Look up live markets (1 CoinGecko request)');
    b.addEventListener('click', () => confirmWtb(row, false));
    body.append(el('div', { class: 'warning' }, 'Live markets are looked up only when you ask.', b));
  }
  const d = entry.data;
  if (d) {
    if (d.dataKind === 'test_data') body.append(el('div', { class: 'banner test' }, 'TEST DATA: invented exchanges and example.com links. NOT real listings.'));
    if (d.warning) body.append(el('div', { class: 'warning' }, d.warning));
    if (d.result) {
      const w = d.result;
      body.append(venueTable('Centralized exchanges (US-friendly first, then by volume)', w.cex), venueTable('Decentralized exchanges (swap from your own wallet)', w.dex));
      if (w.contracts.length) body.append(el('p', { class: 'news-desc' }, el('b', {}, 'Contract address(es) seen on DEX markets: '), w.contracts.join(', ')));
      if (d.coingeckoPage) body.append(el('p', {}, el('a', { href: d.coingeckoPage, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Confirm the official contract on CoinGecko ↗')));
    }
    body.append(el('ul', { class: 'notes' },
      d.source ? el('li', {}, `Source: ${d.source}${d.attribution ? `. ${d.attribution}` : ''}`) : null,
      d.fetchedAt ? el('li', {}, `Fetched ${when(d.fetchedAt)}${d.fromCache ? ' (cached; no request made)' : ''}; requests used: ${d.requestsUsed}.${d.result ? ` ${d.result.totalMarkets} market(s) read, ${d.result.dropped} stale/anomalous/unusable skipped.` : ''}` ) : null,
      ...d.notes.map((n) => el('li', {}, n))));
    if (d.market === 'crypto' && d.mode === 'live') {
      const b = el('button', { type: 'button', class: 'secondary' }, 'Refresh markets (1 request)');
      b.addEventListener('click', () => confirmWtb(row, true));
      body.append(b);
    }
  }
  return el('tr', { class: 'news-row' }, el('td', { colspan: '9' }, body));
}

// ---- discovery (crypto research leads) --------------------------------------------------------
// From the scan result only: tiers by evidence strength, each with why it was surfaced and what
// limits the evidence. Informational; scores and the table below are unchanged.

const TIER = {
  highPriority: ['High-priority research candidates', 'A large price move and unusual volume against a stable baseline of its own. Not a forecast.'],
  watchlist: ['Watchlist', 'Some noteworthy activity, with weaker or incomplete evidence.'],
  insufficientData: ['Insufficient data', 'Activity in the market snapshot, but not enough reliable data to rank it.'],
};
const DISCOVERY_STATUS = { shortlisted: 'on the scanner shortlist', over_display_limit: 'qualified, beyond the display limit', below_threshold: 'not on the shortlist', not_evaluated: 'not evaluated by the scanner' };

function discoveryEntry(e) {
  // Plain English first, from the scan's own explanation (src/scanner/lead-quality.ts): the reason,
  // then every warning in priority order (or the next step when there is none). The scanner's
  // exact evidence and caveats follow, unchanged.
  // Then, only after a CoinMarketCap cross-check was run on this scan, that check's warnings for this
  // lead (looked up by the lead's unique id; the server decided them).
  const x = e.explanation;
  const second = leadCrossCheckWarnings(e, state.cmc?.data, state.last?.result?.evaluatedAt);
  return el('li', { class: 'lead' },
    el('div', {}, el('span', { class: 'name' }, e.name), ' ', el('span', { class: 'sym' }, `${e.symbol} · ${e.id} · ${DISCOVERY_STATUS[e.status]}`)),
    x ? el('p', { class: 'plain' }, x.reason) : null,
    x && x.warnings.length ? el('ul', { class: 'plain-warnings' }, ...x.warnings.map((w) => el('li', { class: 'plain-caution' }, `Caution: ${w.text}`))) : null,
    x && x.nextStep ? el('p', { class: 'plain-next' }, x.nextStep) : null,
    second.length ? el('ul', { class: 'plain-warnings' }, ...second.map((w) => el('li', { class: 'plain-caution' }, `Second source: ${w.text}`))) : null,
    el('ul', { class: 'notes' }, ...e.reasons.map((x) => el('li', {}, x))),
    e.caveats.length ? el('ul', { class: 'notes caveats' }, ...e.caveats.map((x) => el('li', { class: 'flag' }, x))) : null);
}

function discoveryView(d, coverageShown) {
  const box = el('div', { class: 'discovery' }, el('h3', {}, 'Research leads (discovery)'));
  for (const key of ['highPriority', 'watchlist', 'insufficientData']) {
    const [title, blurb] = TIER[key];
    const list = d[key];
    box.append(el('details', { class: 'section', open: '' },
      el('summary', {}, `${title} (${list.length})`),
      el('p', { class: 'muted small' }, blurb),
      list.length ? el('ul', { class: 'leads' }, ...list.map(discoveryEntry)) : el('p', { class: 'empty' }, 'None in this scan.')));
  }
  const c = d.coverage;
  const notes = c.notes.flatMap((n) => {
    if (!coverageShown) return [n];
    if (/ passed every filter and were evaluated against their own volume baseline\.$/.test(n)) return []; // the Coverage line states this count
    if (n.startsWith('Incomplete scan:')) return ['Eligible assets whose history was not obtained (see Coverage above) are listed under Insufficient data if they showed snapshot activity; the rest were not evaluated.'];
    return [n];
  });
  box.append(el('ul', { class: 'notes' },
    el('li', {}, `${c.withActivity} asset(s) showed snapshot activity; ${c.withActivityNotEvaluated} of them could not be evaluated for lack of reliable data.`),
    ...notes.map((n) => el('li', {}, n))));
  box.append(cmcView());
  return box;
}

// ---- CoinMarketCap cross-check (second source for the research leads) ----------------------------
// Runs only on click. Offline scans use TEST DATA; live scans send 1 request after you confirm.
// CMC's terms require prominent attribution with a link wherever its data is shown.

const MATCH_TEXT = {
  matched: (m) => `matched to CoinMarketCap "${m.cmc.name}" (CMC id ${m.cmc.id}${m.cmc.rank ? `, rank ${m.cmc.rank}` : ''}) by ${m.basis === 'name_and_slug' ? 'name and slug' : m.basis}`,
  ambiguous: (m) => `ambiguous: ${m.candidates.length} CoinMarketCap coins share this symbol and name (${m.candidates.map((c) => `id ${c.id}`).join(', ')}); not matched`,
  unmatched: (m) => `not matched: CoinMarketCap uses this symbol for ${m.candidates.map((c) => `"${c.name}"`).join(', ')}`,
  not_found: () => 'not found in CoinMarketCap\'s top 500',
};
const VERDICT_CHIP = { agrees: ['Agrees', 'complete'], differs: ['Differs', 'partial'], partial: ['Partly compared', 'dim'], not_compared: ['Not compared', 'dim'] };

function cmcAttribution(a, small = false) {
  const ok = a && typeof a.url === 'string' && a.url.startsWith('https://coinmarketcap.com');
  const link = el('a', { href: ok ? a.url : 'https://coinmarketcap.com/', target: '_blank', rel: 'noopener noreferrer' }, 'CoinMarketCap.com');
  return el(small ? 'span' : 'div', { class: small ? 'sym' : 'attribution' }, 'Data provided by ', link);
}

async function loadCmc(refresh = false) {
  state.cmc = { loading: true, data: state.cmc?.data ?? null, error: null };
  render();
  const send = (extra) => fetch('/api/crypto/cmc-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-market-scanner': '1', accept: 'application/json' },
    body: JSON.stringify({ refresh, ...extra }),
  }).then(async (r) => [r, await r.json()]);
  try {
    let [r, data] = await send({});
    if (r.status === 428 && data.needsConfirm) {
      if (!window.confirm(`Cross-check the research leads with CoinMarketCap?\n\n${data.error}\n\nRequests this session: ${data.cmcRequestsThisSession} of ${data.cmcSessionLimit}.`)) {
        state.cmc = { loading: false, data: state.cmc?.data ?? null, error: null };
        return render();
      }
      [r, data] = await send({ confirmLive: true });
    }
    state.cmc = data.ok ? { loading: false, data, error: null } : { loading: false, data: state.cmc?.data ?? null, error: data.error || `The cross-check failed (HTTP ${r.status}).` };
  } catch {
    state.cmc = { loading: false, data: state.cmc?.data ?? null, error: 'Could not reach the local server.' };
  }
  render();
}

const cmp = (label, v, fmt) => (v.coinmarketcap === null || v.coingecko === null
  ? `${label}: not compared`
  : `${label}: CoinGecko ${fmt(v.coingecko)} vs CoinMarketCap ${fmt(v.coinmarketcap)} (${v.diffPct > 0 ? '+' : ''}${v.diffPct.toFixed(1)}%, ${v.agrees ? 'within' : 'outside'} tolerance)`);

function cmcLead(x, attribution) {
  const [label, cls] = VERDICT_CHIP[x.verdict];
  return el('li', { class: 'lead' },
    el('div', {}, el('span', { class: 'name' }, x.name), ' ', el('span', { class: 'sym' }, `${x.symbol} · ${x.id}`), ' ', el('span', { class: `chip ${cls}` }, label)),
    el('p', { class: 'plain' }, plainCheck(x).text),
    el('div', { class: 'sym' }, MATCH_TEXT[x.match.status](x.match)),
    x.match.status === 'matched' ? el('ul', { class: 'notes' }, el('li', {}, cmp('Price', x.price, price)), el('li', {}, cmp('Market cap', x.marketCap, usd))) : null,
    x.tags.length ? el('div', { class: 'sym' }, `CoinMarketCap tags: ${x.tags.join(', ')}${x.providerCategory ? ` → ${x.providerCategory.category} (per tag "${x.providerCategory.tag}")` : ''}`) : null,
    x.notes.length ? el('ul', { class: 'notes caveats' }, ...x.notes.map((n) => el('li', { class: 'flag' }, n))) : null,
    x.match.status === 'matched' ? cmcAttribution(attribution, true) : null);
}

function cmcView() {
  const box = el('div', { class: 'cmc' }, el('h4', {}, 'Second source: CoinMarketCap'),
    el('p', { class: 'muted small' }, 'Cross-checks the research leads above (price, market cap, category tags). Runs only when you click. Offline scans use test data; a live scan sends 1 CoinMarketCap request (about 2 credits) after you confirm.'));
  const c = state.cmc;
  const b = el('button', { type: 'button', class: 'secondary' }, c?.data ? 'Run the cross-check again' : 'Cross-check leads with CoinMarketCap');
  b.disabled = Boolean(c?.loading);
  b.addEventListener('click', () => loadCmc(Boolean(c?.data && c.data.mode === 'live')));
  box.append(b);
  if (c?.loading) box.append(el('div', { class: 'running' }, el('span', { class: 'spinner' }), 'Checking…'));
  if (c?.error) box.append(el('div', { class: 'error' }, c.error));
  const d = c?.data;
  if (d) {
    box.append(cmcAttribution(d.attribution));
    if (d.dataKind === 'test_data') box.append(el('div', { class: 'banner test' }, 'TEST DATA: synthetic CoinMarketCap listings with invented coins. NOT market data.'));
    const s = d.summary;
    box.append(el('p', { class: 'kv' }, `${s.leads} lead(s): ${s.matched} matched (${s.agrees} agree, ${s.differs} differ), ${s.ambiguous} ambiguous, ${s.unmatched} not matched, ${s.notFound} not found.`));
    box.append(el('ul', { class: 'leads' }, ...d.results.map((x) => cmcLead(x, d.attribution))));
    box.append(el('ul', { class: 'notes' },
      el('li', {}, `Source: ${d.source}. Fetched ${when(d.fetchedAt)}${d.fromCache ? ' (cached in memory; no request made)' : ''}; requests used: ${d.requestsUsed}${d.creditsUsed !== null && d.creditsUsed !== undefined ? `; credits reported: ${d.creditsUsed}` : ''}${d.mode === 'live' ? `; requests this session: ${d.cmcRequestsThisSession} of ${d.cmcSessionLimit}` : ''}.`),
      ...d.notes.map((n) => el('li', {}, n))));
  }
  return box;
}

function render() {
  const data = state.last;
  if (!data) return;
  const r = data.result;
  const s = r.scan;
  const root = $('results');
  root.replaceChildren();
  root.hidden = false;
  const synthetic = r.dataset.kind === 'synthetic';
  root.append(synthetic
    ? el('div', { class: 'banner test' }, `TEST DATA — synthetic ${data.market} fixture with invented names and numbers. NOT market data.`)
    : el('div', { class: 'banner live' }, `Live data from ${r.dataset.source}. ${r.dataset.attribution ?? ''}`));
  root.append(el('div', { class: 'status-row' },
    el('span', { class: `chip ${s.status}` }, s.status === 'complete' ? 'COMPLETE' : 'PARTIAL'),
    el('span', { class: 'muted' }, s.status === 'complete' ? 'Complete for the scanned scope (not a market-wide scan).' : s.partialReasons.join('; '))));
  if (s.nextStep) root.append(el('p', { class: 'kv' }, el('b', {}, 'Next step: '), dashboardWording(s.nextStep)));

  const controls = parseBudgetControls($('total-budget').value, $('unit-limit').value, $('no-unit-limit').checked, $('preference').value);
  const view = 'error' in controls ? null : buildView(data.rows, controls);
  const cov = r.dataset.coverage;
  root.append(el('div', { class: 'grid' },
    stat('Qualified signals', String(s.qualified), s.qualifiedNames.join(', ') || 'none'),
    stat('Evaluated', String(data.rows.length), `${r.universe} scanned · ${r.excluded.length} excluded`),
    view ? stat('Within your limits', String(view.counts.withinBudget), `${view.counts.qualifiedWithinBudget} of ${view.counts.qualified} qualified`) : null,
    cov ? stat('History coverage', `${cov.historyFetched} of ${cov.historyEligible}`, `${cov.historyFromCache} from cache · ${cov.historyNotRequested} not requested`) : null,
    cov ? stat('API requests', `${cov.requestsUsed} of ${cov.requestLimit}`, 'retries included') : stat('API requests', synthetic ? '0' : 'see notes', synthetic ? 'offline fixture' : '')));
  root.append(el('p', { class: 'kv' }, el('b', {}, 'Freshness: '), s.freshness));
  // Crypto live scans: how far the history requests got, in plain English, from the scan's own figures.
  const coverage = data.market === 'crypto' ? coverageSentences(coverageFigures(r)) : [];
  if (coverage.length) root.append(el('p', { class: 'kv' }, el('b', {}, 'Coverage: '), coverage.join(' ')));
  const sectionView = (sec) => {
    const body = sec.rows.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Asset', 'Signal', 'Evidence', 'Unit price', 'Max whole units', 'Budget check', 'Change', 'Category', 'Volatility & data'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...sec.rows.flatMap((x) => [rowView(x), newsPanelRow(x.row), wtbPanelRow(x.row)].filter(Boolean)))))
      : el('p', { class: 'empty' }, s.status === 'partial' ? 'None among the assets evaluated in this partial scan.' : 'None.');
    return sec.collapsed
      ? el('details', { class: 'section' }, el('summary', {}, `${sec.title} (${sec.rows.length})`), body)
      : el('div', {}, el('h3', {}, `${sec.title} (${sec.rows.length})`), body);
  };
  // Crypto: the main budget table first ("Qualified signals within your budget and unit-price limit"),
  // then the research leads and their CoinMarketCap check, then the other budget sections.
  const crypto = data.market === 'crypto';
  if (!view) root.append(el('div', { class: 'error' }, controls.error));
  else if (crypto) root.append(sectionView(view.sections[0]));
  if (r.discovery) root.append(discoveryView(r.discovery, coverage.length > 0));
  if (view) for (const sec of crypto ? view.sections.slice(1) : view.sections) root.append(sectionView(sec));
  root.append(el('p', { class: 'muted small' }, 'Max whole units = floor(budget ÷ unit price), before fees; no fractional units assumed. Scores measure evidence strength, not expected returns. A research lead, not a recommendation.'));

  const groups = new Map();
  for (const e of r.excluded) {
    const reason = e.reasons[0];
    const g = groups.get(reason.code) ?? { count: 0, examples: [] };
    g.count++;
    if (g.examples.length < 8) g.examples.push(e.symbol);
    groups.set(reason.code, g);
  }
  root.append(el('h3', {}, `Excluded by the scanner (${r.excluded.length}; first reason shown)`));
  if (data.market === 'crypto' && r.excluded.length > 0) {
    // Three different reasons, never combined: skipped for the request limit, data problems, scope rules.
    const b = exclusionBreakdown(r.excluded);
    const skipped = coverage.length > 0 ? 'skipped when history requests stopped (see Coverage above), not rejected by any rule' : 'skipped because history requests stopped before reaching them (request or rate limit; not rejected by any rule)';
    root.append(el('p', { class: 'kv' }, `Of these: ${b.budget_skipped} ${skipped}, ` +
      `${b.data} not evaluated because of missing, stale, implausible or unreliable data or a failed request, ` +
      `and ${b.rule} outside the scanner's scope or eligibility rules.`));
  }
  root.append(groups.size > 0
    ? el('ul', { class: 'excl' }, ...[...groups].sort((x, y) => y[1].count - x[1].count).map(([code, g]) =>
      el('li', {}, el('span', { class: 'count' }, String(g.count)), data.exclusionLabels?.[code] ?? code.replaceAll('_', ' '),
        el('div', { class: 'ex' }, `${g.examples.join(', ')}${g.count > g.examples.length ? `, +${g.count - g.examples.length} more` : ''}`))))
    : el('p', { class: 'empty' }, 'None.'));
  root.append(el('h3', {}, 'What this data cannot show'));
  root.append(el('ul', { class: 'notes' }, ...data.limitations.map((n) => el('li', {}, n))));
  const notes = r.dataset.notes ?? [];
  if (notes.length > 0) {
    root.append(el('h3', {}, 'Data notes'));
    root.append(el('ul', { class: 'notes' }, ...notes.map((n) => el('li', {}, n))));
  }
}

// ---- crypto asset search ----------------------------------------------------------------------
// Separate from scans: a search never starts one. Offline searches the TEST DATA fixture. Live sends
// a request only after the page asks you (the server answers 428 until confirmed; cached answers
// need no confirmation). Results are never auto-selected: you choose by name and CoinGecko id.

const MATCH_LABEL = { symbol: 'exact symbol', name: 'exact name', id: 'exact id', partial: 'partial match' };

/** POSTs to a search route; on 428 asks the user, then resends once with confirmLive. */
async function searchPost(path, body, what) {
  const send = async (extra) => {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-market-scanner': '1', accept: 'application/json' },
      body: JSON.stringify({ ...body, ...extra }),
    });
    return [r, await r.json()];
  };
  let [r, data] = await send({});
  if (r.status === 428 && data.needsConfirm) {
    const used = Number.isInteger(data.liveRequestsThisSession) ? `\n\nLive search requests this session: ${data.liveRequestsThisSession} of ${data.sessionRequestLimit}.` : '';
    if (!window.confirm(`${what}\n\nThis sends 1 CoinGecko request (Demo plan: 100 per minute).${used}`)) return { cancelled: true };
    [r, data] = await send({ confirmLive: true });
  }
  return { r, data };
}

function setSearchBusy(text) {
  $('search-status').hidden = !text;
  if (text) $('search-status-text').textContent = text;
  $('search-btn').disabled = Boolean(text);
}

function showSearchError(text) {
  $('search-error').textContent = text || '';
  $('search-error').hidden = !text;
}

async function runSearch(refresh = false) {
  const query = $('search-q').value.trim();
  const mode = checked('mode');
  showSearchError('');
  if (query.replace(/^\$/, '').length < 2) return showSearchError('Enter at least 2 characters of a name or symbol.');
  setSearchBusy(mode === 'live' ? 'Searching CoinGecko…' : 'Searching the synthetic test coins…');
  try {
    const res = await searchPost('/api/crypto/search', { mode, query, refresh }, `Search CoinGecko for "${query}"?`);
    if (res.cancelled) return;
    if (!res.data.ok) return showSearchError(res.data.error || `The search failed (HTTP ${res.r.status}).`);
    renderSearchResults(res.data);
  } catch {
    showSearchError('Could not reach the local server. Is "npm run web" still running?');
  } finally {
    setSearchBusy('');
  }
}

function renderSearchResults(d) {
  const root = $('search-results');
  $('asset-detail').replaceChildren();
  root.replaceChildren();
  if (d.dataKind === 'test_data') root.append(el('div', { class: 'banner test' }, 'TEST DATA: invented coins from the offline search fixture. NOT market data.'));
  if (d.guidance) root.append(el('p', { class: d.results.length ? 'warning' : 'empty' }, d.guidance));
  for (const a of d.ambiguousSymbols) {
    if (!d.guidance || !d.guidance.includes(` ${a.symbol}.`)) root.append(el('p', { class: 'sym' }, `Note: the symbol ${a.symbol} is shared by ${a.ids.length} results (${a.ids.join(', ')}).`));
  }
  if (d.results.length) {
    const shared = new Set(d.ambiguousSymbols.map((a) => a.symbol));
    root.append(el('ul', { class: 'search-list' }, ...d.results.map((c) => {
      const b = el('button', { type: 'button', class: 'secondary' }, 'Show market data');
      b.addEventListener('click', () => loadAsset(c, false));
      return el('li', {},
        el('div', {}, el('span', { class: 'name' }, c.name), ' ', el('span', { class: `chip ${shared.has(c.symbol) ? 'partial' : 'dim'}` }, c.symbol),
          el('div', { class: 'sym' }, `CoinGecko id: ${c.id} · ${c.rank ? `market-cap rank ${c.rank}` : 'no market-cap rank'} · ${MATCH_LABEL[c.match]}`)),
        b);
    })));
  }
  root.append(el('p', { class: 'sym' }, `${d.results.length} shown of ${d.total} match(es). Source: ${d.source}${d.attribution ? `. ${d.attribution}` : ''}. ${d.fromCache ? 'Cached result (no request made)' : `Requests used: ${d.requestsUsed}`}${d.mode === 'live' ? `; live search requests this session: ${d.liveRequestsThisSession} of ${d.sessionRequestLimit}` : ''}.`));
  if (d.mode === 'live') {
    const b = el('button', { type: 'button', class: 'linkish' }, 'Refresh this search (1 request)');
    b.addEventListener('click', () => runSearch(true));
    root.append(b);
  }
}

async function loadAsset(coin, refresh) {
  const mode = checked('mode');
  showSearchError('');
  setSearchBusy(`Loading ${coin.name} (${coin.symbol})…`);
  try {
    const res = await searchPost('/api/crypto/asset', { mode, id: coin.id, refresh }, `Load market data for ${coin.name} (${coin.symbol}, id ${coin.id})?`);
    if (res.cancelled) return;
    if (!res.data.ok) return showSearchError(res.data.error || `The lookup failed (HTTP ${res.r.status}).`);
    renderAsset(coin, res.data);
  } catch {
    showSearchError('Could not reach the local server. Is "npm run web" still running?');
  } finally {
    setSearchBusy('');
  }
}

const evText = (e, fmt) => (e.value === null ? `not available${e.note ? ` (${e.note})` : ''}` : fmt(e.value));

function renderAsset(coin, d) {
  const root = $('asset-detail');
  root.replaceChildren();
  const a = d.asset;
  const head = el('h3', {}, `${coin.name} (${coin.symbol})`);
  const card = el('div', { class: 'asset-card' }, head, el('div', { class: 'sym' }, `CoinGecko id: ${coin.id}`));
  if (d.dataKind === 'test_data') card.append(el('div', { class: 'banner test' }, 'TEST DATA: invented values. NOT market data.'));
  if (!a) {
    card.append(el('p', { class: 'empty' }, d.message));
  } else {
    const updated = a.lastUpdated.value;
    const age = updated && d.fetchedAt ? Math.round((Date.parse(d.fetchedAt) - Date.parse(updated)) / 60000) : null;
    card.append(el('div', { class: 'grid' },
      stat('Price (USD)', evText(a.price, price), a.rank.value ? `market-cap rank ${a.rank.value}` : 'no market-cap rank'),
      stat('24h change', evText(a.change24hPct, pct), `7d: ${evText(a.change7dPct, pct)}`),
      stat('24h volume', evText(a.volume24h, usd), 'USD, aggregated across exchanges'),
      stat('Market cap', evText(a.marketCap, usd), a.high24h.value !== null && a.low24h.value !== null ? `24h range ${price(a.low24h.value)} to ${price(a.high24h.value)}` : '24h range not available')));
    card.append(el('p', { class: 'kv' }, el('b', {}, 'Updated: '), updated ? `${when(updated)}${age !== null && age >= 0 ? ` (${age} min before it was fetched)` : ''}` : 'update time not provided'));
  }
  card.append(el('p', { class: 'kv' }, el('b', {}, 'Source: '), `${d.source}${d.attribution ? `. ${d.attribution}` : ''}`));
  card.append(el('p', { class: 'kv' }, el('b', {}, 'Fetched: '), `${when(d.fetchedAt)}${d.fromCache ? ' (cached; no request made)' : `; requests used: ${d.requestsUsed}`}`));
  const s = d.inLastScan;
  card.append(el('p', { class: 'kv' }, el('b', {}, 'Scanner: '), s
    ? `evaluated in the latest ${s.mode} scan: ${s.category ?? STATUS_LABEL[s.status]}${s.score !== null ? ` (evidence ${s.score}/${s.maxScore})` : ''}. Search does not change the scan.`
    : d.scanNote));
  if (d.mode === 'live') {
    const b = el('button', { type: 'button', class: 'linkish' }, 'Refresh market data (1 request)');
    b.addEventListener('click', () => loadAsset(coin, true));
    card.append(b);
  }
  card.append(el('p', { class: 'sym' }, 'Shown for research only. A search result is not a recommendation, and this tool cannot buy anything.'));
  root.append(card);
}

document.addEventListener('DOMContentLoaded', () => {
  for (const f of ['controls', 'money']) $(f).addEventListener('submit', (e) => e.preventDefault());
  // Search runs only on an explicit submit (button or Enter), never while typing.
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  document.querySelectorAll('input[name="mode"], input[name="market"]').forEach((r) => r.addEventListener('change', updateControls));
  $('max-requests').addEventListener('input', updateControls);
  // Budget controls re-filter the last result only: no request, no rescan.
  for (const id of ['total-budget', 'unit-limit', 'no-unit-limit', 'preference']) {
    $(id).addEventListener('input', () => { updateControls(); render(); });
    $(id).addEventListener('change', () => { updateControls(); render(); });
  }
  $('scan-btn').addEventListener('click', () => {
    const req = currentRequest();
    if (req) scan(req);
  });
  $('rerun-btn').addEventListener('click', () => {
    if (state.lastRequest) {
      const { confirmLive: _c, ...again } = state.lastRequest;
      scan(again);
    }
  });
  loadStatus();
});
