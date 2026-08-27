// ── Supabase ──────────────────────────────────────────────────
const SUPABASE_URL = 'https://qwqnklrfcakfozfjhbcd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3cW5rbHJmY2FrZm96ZmpoYmNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0OTc5NTgsImV4cCI6MjEwMzA3Mzk1OH0.ihHAuzN95cLFJhd4LImug-usJyW9sI3_1hv6-Ve4e4U';

// Lightweight REST helpers (no SDK needed)
async function sbSelect(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error((await res.json()).message || `Supabase error ${res.status}`);
  return res.json();
}

async function sbInsert(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).message || `Supabase error ${res.status}`);
  return res.json();
}

async function sbDelete(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error((await res.json()).message || `Supabase error ${res.status}`);
}

// ── Pricing ───────────────────────────────────────────────────

// Cache: oracle_id → menor preço USD entre todas as printings
const priceCache = {};
// Cache da taxa de câmbio USD→BRL (atualiza uma vez por sessão)
let usdToBrl = null;

/** Busca a taxa de câmbio USD→BRL. Retorna null em caso de falha. */
async function getUsdToBrl() {
  if (usdToBrl !== null) return usdToBrl;
  try {
    const res  = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
    const data = await res.json();
    usdToBrl   = parseFloat(data.USDBRL.bid);
    return usdToBrl;
  } catch {
    return null;
  }
}

/**
 * Retorna o menor preço USD entre todas as printings do card.
 * Usa oracle_id para agrupar; cacheado por oracle_id.
 */
async function getCheapestUsd(card) {
  const cacheKey = card.oracle_id || card.id;
  if (priceCache[cacheKey] !== undefined) return priceCache[cacheKey];

  try {
    const query = card.oracle_id
      ? `oracle_id:${card.oracle_id}`
      : `!"${card.name}"`;

    const url = `https://api.scryfall.com/cards/search`
      + `?q=${encodeURIComponent(query)}`
      + `&unique=prints`
      + `&order=usd`
      + `&dir=asc`;

    let cheapest = null;
    let nextUrl  = url;

    while (nextUrl) {
      const res  = await fetch(nextUrl);
      if (!res.ok) break;
      const data = await res.json();

      for (const c of (data.data || [])) {
        const p = parseFloat(c.prices?.usd);
        if (!isNaN(p) && p > 0) {
          if (cheapest === null || p < cheapest) cheapest = p;
        }
      }

      // Ordena asc por preço — primeiro válido já é o menor; para após 1ª página
      nextUrl = cheapest !== null ? null : (data.next_page || null);
    }

    priceCache[cacheKey] = cheapest;
    return cheapest;
  } catch {
    priceCache[cacheKey] = null;
    return null;
  }
}

/** Exibe o preço no card detail panel e armazena no card para uso no save. */
async function displayCardPrice(card) {
  const el = document.getElementById('detailPrice');
  el.textContent = '…';
  el.className   = 'detail-price price-loading';

  const [usd, rate] = await Promise.all([getCheapestUsd(card), getUsdToBrl()]);

  if (usd === null) {
    el.textContent   = 'Sem preço';
    el.className     = 'detail-price price-unavailable';
    card._cheapestBrl = null;
    return;
  }

  const brl = rate ? usd * rate : null;
  card._cheapestUsd = usd;
  card._cheapestBrl = brl;

  el.textContent = brl
    ? `R$ ${brl.toFixed(2).replace('.', ',')} (U$ ${usd.toFixed(2)})`
    : `U$ ${usd.toFixed(2)}`;
  el.className = 'detail-price';

  updateDeckTotalValue();
}

/** Recalcula e exibe o valor total do deck em BRL */
function updateDeckTotalValue() {
  const row    = document.getElementById('deckValueRow');
  const total  = document.getElementById('deckTotalValue');
  let   sum    = 0;
  let   hasAny = false;

  Object.values(deck).forEach(entry => {
    const brl = entry.card._cheapestBrl;
    if (brl != null) { sum += brl * entry.qty; hasAny = true; }
  });

  if (!hasAny) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  total.textContent = `R$ ${sum.toFixed(2).replace('.', ',')}`;
}

// ── State ────────────────────────────────────────────────────
const deck = {};
let selectedCard = null;
let commander    = null;

// Pagination state
let currentPage     = null; // next page URL from Scryfall
let allCards        = [];   // cards loaded so far
let totalCards      = 0;

const COLOR_META = {
  W: { name: 'White',     symbol: '☀',  css: '#f9faf4', bg: '#b8860b' },
  U: { name: 'Blue',      symbol: '💧', css: '#aad3f3', bg: '#1a3a5c' },
  B: { name: 'Black',     symbol: '💀', css: '#c0bdb8', bg: '#2a2a2a' },
  R: { name: 'Red',       symbol: '🔥', css: '#f9a860', bg: '#6b1a0a' },
  G: { name: 'Green',     symbol: '🌲', css: '#9ed09e', bg: '#1a4a1a' },
  C: { name: 'Colorless', symbol: '◇', css: '#ccc',    bg: '#444'    },
};

// ── DOM refs ─────────────────────────────────────────────────
const searchInput       = document.getElementById('searchInput');
const searchBtn         = document.getElementById('searchBtn');
const advToggleBtn      = document.getElementById('advToggleBtn');
const advPanel          = document.getElementById('advPanel');
const advClearBtn       = document.getElementById('advClearBtn');
const queryPreview      = document.getElementById('queryPreview');
const resultsContainer  = document.getElementById('resultsContainer');
const resultsMeta       = document.getElementById('resultsMeta');
const resultsList       = document.getElementById('resultsList');
const loadMoreRow       = document.getElementById('loadMoreRow');
const loadMoreBtn       = document.getElementById('loadMoreBtn');
const cardDetail        = document.getElementById('cardDetail');
const colorWarning      = document.getElementById('colorWarning');
const addToDeckBtn      = document.getElementById('addToDeckBtn');
const qtyInput          = document.getElementById('qtyInput');
const deckCategories    = document.getElementById('deckCategories');
const deckCount         = document.getElementById('deckCount');
const exportBtn         = document.getElementById('exportBtn');
const clearBtn          = document.getElementById('clearBtn');
const exportModal       = document.getElementById('exportModal');
const exportText        = document.getElementById('exportText');
const copyBtn           = document.getElementById('copyBtn');
const closeModalBtn     = document.getElementById('closeModalBtn');
const commanderModal    = document.getElementById('commanderModal');
const cmdModalImg       = document.getElementById('cmdModalImg');
const cmdModalTitle     = document.getElementById('cmdModalTitle');
const cmdModalYes       = document.getElementById('cmdModalYes');
const cmdModalNo        = document.getElementById('cmdModalNo');
const hoverTooltip      = document.getElementById('hoverTooltip');
const tooltipImg        = document.getElementById('tooltipImg');
const commanderInput    = document.getElementById('commanderInput');
const commanderBtn      = document.getElementById('commanderBtn');
const commanderDisplay  = document.getElementById('commanderDisplay');
const commanderThumb    = document.getElementById('commanderThumb');
const commanderNameEl   = document.getElementById('commanderName');
const commanderColorsEl = document.getElementById('commanderColors');
const clearCommanderBtn = document.getElementById('clearCommanderBtn');
const landCount         = document.getElementById('landCount');
const landBar           = document.getElementById('landBar');
const landTip           = document.getElementById('landTip');
const togglePreviewBtn  = document.getElementById('togglePreviewBtn');

// ── Advanced Search — Query Builder ──────────────────────────

/** Toggle the advanced panel */
advToggleBtn.addEventListener('click', () => {
  advPanel.classList.toggle('hidden');
  advToggleBtn.textContent = advPanel.classList.contains('hidden') ? '⚙ Filters' : '⚙ Hide';
  if (!advPanel.classList.contains('hidden')) updateQueryPreview();
});

/** Clear all filter inputs */
advClearBtn.addEventListener('click', () => {
  advPanel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
  advPanel.querySelectorAll('input[type=text], input[type=number]').forEach(i => i.value = '');
  advPanel.querySelectorAll('select').forEach(s => {
    // Reset to first option except legalFormat stays at commander, identityMode stays at within
    if (s.id === 'legalFormat') s.value = 'commander';
    else if (s.id === 'identityMode') s.value = 'within';
    else s.selectedIndex = 0;
  });
  updateQueryPreview();
});

/** Live-update the query preview whenever anything changes */
advPanel.addEventListener('change',  updateQueryPreview);
advPanel.addEventListener('input',   updateQueryPreview);

/** Build a Scryfall query string from the current filter state */
function buildAdvancedQuery() {
  const parts = [];

  // Name from the main search bar
  const name = searchInput.value.trim();
  if (name) parts.push(name);

  // Colors
  const colorChecks = [...advPanel.querySelectorAll('input[data-color]:checked')].map(cb => cb.dataset.color);
  if (colorChecks.length > 0) {
    const colorMode = document.getElementById('colorMode').value;
    const colorStr  = colorChecks.join('').toLowerCase();
    if (colorMode === 'exactly')   parts.push(`c:${colorStr}`);
    else if (colorMode === 'including') parts.push(`c>=${colorStr}`);
    else if (colorMode === 'atmost')    parts.push(`c<=${colorStr}`);
  }

  // Color identity
  const idChecks = [...advPanel.querySelectorAll('input[data-identity]:checked')].map(cb => cb.dataset.identity);
  if (idChecks.length > 0) {
    const idMode = document.getElementById('identityMode').value;
    const idStr  = idChecks.join('').toLowerCase();
    if (idMode === 'exactly')    parts.push(`id:${idStr}`);
    else if (idMode === 'within')    parts.push(`id<=${idStr}`);
    else if (idMode === 'including') parts.push(`id>=${idStr}`);
  }

  // Types (checked)
  const typeChecks = [...advPanel.querySelectorAll('input[data-type]:checked')].map(cb => cb.dataset.type);
  typeChecks.forEach(t => parts.push(`t:${t.toLowerCase()}`));

  // Subtype / extra type text
  const typeExtra = document.getElementById('typeExtra').value.trim();
  if (typeExtra) parts.push(`t:${typeExtra.toLowerCase()}`);

  // Rarity (OR-joined)
  const rarities = [...advPanel.querySelectorAll('input[data-rarity]:checked')].map(cb => cb.dataset.rarity);
  if (rarities.length === 1) {
    parts.push(`r:${rarities[0]}`);
  } else if (rarities.length > 1) {
    parts.push('(' + rarities.map(r => `r:${r}`).join(' OR ') + ')');
  }

  // CMC
  const cmcOp  = document.getElementById('cmcOp').value;
  const cmcVal = document.getElementById('cmcVal').value.trim();
  if (cmcOp && cmcVal !== '') parts.push(`cmc${cmcOp}${cmcVal}`);

  // Power
  const powOp  = document.getElementById('powOp').value;
  const powVal = document.getElementById('powVal').value.trim();
  if (powOp && powVal !== '') parts.push(`pow${powOp}${powVal}`);

  // Toughness
  const touOp  = document.getElementById('touOp').value;
  const touVal = document.getElementById('touVal').value.trim();
  if (touOp && touVal !== '') parts.push(`tou${touOp}${touVal}`);

  // Oracle text
  const oracle = document.getElementById('oracleText').value.trim();
  if (oracle) {
    const quoted = oracle.includes(' ') ? `"${oracle}"` : oracle;
    parts.push(`o:${quoted}`);
  }

  // Keywords (each becomes a keyword: filter)
  const kwChecks = [...advPanel.querySelectorAll('input[data-kw]:checked')].map(cb => cb.dataset.kw);
  kwChecks.forEach(kw => {
    const kwSlug = kw.toLowerCase().replace(/\s+/g, '-');
    parts.push(`keyword:${kwSlug}`);
  });

  // Format legality
  const fmt = document.getElementById('legalFormat').value;
  if (fmt) parts.push(`legal:${fmt}`);

  // Set code
  const setCode = document.getElementById('setCode').value.trim();
  if (setCode) parts.push(`set:${setCode.toLowerCase()}`);

  // Fallback: if nothing, search everything (won't be empty)
  return parts.length > 0 ? parts.join(' ') : '*';
}

function updateQueryPreview() {
  queryPreview.textContent = buildAdvancedQuery();
}

// ── Scryfall API ──────────────────────────────────────────────

/**
 * Fetch first page of results. Returns { cards, nextPage, total }.
 */
async function fetchSearch(query, sortOrder = 'name', sortDir = 'auto') {
  const url = `https://api.scryfall.com/cards/search`
    + `?q=${encodeURIComponent(query)}`
    + `&unique=cards`
    + `&order=${encodeURIComponent(sortOrder)}`
    + `&dir=${encodeURIComponent(sortDir)}`;
  const res = await fetch(url);
  if (res.status === 404) return { cards: [], nextPage: null, total: 0 };
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.details || `Scryfall error ${res.status}`);
  }
  const data = await res.json();
  return {
    cards:    data.data    || [],
    nextPage: data.next_page || null,
    total:    data.total_cards || 0,
  };
}

/** Fetch a specific next_page URL (Scryfall pagination). */
async function fetchNextPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load more results');
  const data = await res.json();
  return {
    cards:    data.data    || [],
    nextPage: data.next_page || null,
  };
}

async function fetchCardByName(name) {
  const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error('Card not found');
  return res.json();
}

function getImageUri(card, size = 'normal', faceIndex = 0) {
  if (card.image_uris) return card.image_uris[size] || card.image_uris.normal;
  if (card.card_faces && card.card_faces[faceIndex]?.image_uris)
    return card.card_faces[faceIndex].image_uris[size] || card.card_faces[faceIndex].image_uris.normal;
  return null;
}

/** Returns true if a card has a flippable back face with its own image */
function isDFC(card) {
  return !!(card.card_faces && card.card_faces.length >= 2 && card.card_faces[1].image_uris);
}

function getOracleText(card) {
  if (card.oracle_text) return card.oracle_text;
  if (card.card_faces)  return card.card_faces.map(f => `[${f.name}]\n${f.oracle_text || ''}`).join('\n\n');
  return '—';
}

function getManaCost(card) {
  if (card.mana_cost)  return card.mana_cost;
  if (card.card_faces) return card.card_faces[0].mana_cost || '—';
  return '—';
}

function getPT(card) {
  if (card.power   !== undefined) return `${card.power} / ${card.toughness}`;
  if (card.loyalty !== undefined) return `Loyalty: ${card.loyalty}`;
  return null;
}

function getColorIdentity(card) { return card.color_identity || []; }

// ── Search ────────────────────────────────────────────────────

async function performSearch() {
  const query     = buildAdvancedQuery();
  const sortOrder = document.getElementById('sortOrder').value;
  const sortDir   = document.getElementById('sortDir').value;

  resultsList.innerHTML = '<span class="spinner"></span> Searching…';
  resultsContainer.classList.remove('hidden');
  loadMoreRow.classList.add('hidden');
  closeDetailPanel();
  selectedCard = null;
  allCards     = [];
  currentPage  = null;
  resultsMeta.textContent = '';

  try {
    const result = await fetchSearch(query, sortOrder, sortDir);

    if (result.cards.length === 0) {
      resultsList.innerHTML = '<p style="color:var(--muted);padding:8px;">No cards found for that search.</p>';
      return;
    }

    allCards    = result.cards;
    currentPage = result.nextPage;
    totalCards  = result.total;

    renderResults(allCards, true);
    resultsMeta.textContent = `${totalCards.toLocaleString()} result${totalCards !== 1 ? 's' : ''}`;

    if (currentPage) {
      loadMoreRow.classList.remove('hidden');
    }
  } catch (err) {
    resultsList.innerHTML = `<p style="color:var(--accent);padding:8px;">⚠ ${err.message}</p>`;
  }
}

searchBtn.addEventListener('click', performSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') performSearch(); });

loadMoreBtn.addEventListener('click', async () => {
  if (!currentPage) return;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Loading…';
  try {
    const result = await fetchNextPage(currentPage);
    allCards    = allCards.concat(result.cards);
    currentPage = result.nextPage;
    renderResults(result.cards, false);
    if (!currentPage) loadMoreRow.classList.add('hidden');
  } catch (err) {
    showToast('Error loading more: ' + err.message);
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more results';
  }
});

/** Render a batch of cards into the results grid.
 *  @param {boolean} replace - true to clear before rendering */
function renderResults(cards, replace) {
  if (replace) resultsList.innerHTML = '';

  cards.forEach(card => {
    const tile = document.createElement('div');
    tile.className = 'result-item';

    const legal    = isColorLegal(card);
    const dfc      = isDFC(card);
    if (!legal) tile.classList.add('out-of-color');

    const imgFront = getImageUri(card, 'normal', 0);
    const imgBack  = dfc ? getImageUri(card, 'normal', 1) : null;
    const imgFull  = getImageUri(card, 'large', 0);

    // Track which face is currently shown on this tile
    let showingFront = true;
    const img = document.createElement('img');
    img.src     = imgFront || '';
    img.alt     = card.name;
    img.loading = 'lazy';

    const wrap = document.createElement('div');
    wrap.className = 'result-img-wrap';
    wrap.appendChild(img);

    if (!legal) {
      const badge = document.createElement('span');
      badge.className = 'result-illegal-overlay';
      badge.title     = 'Outside commander color identity';
      badge.textContent = '⚠';
      wrap.appendChild(badge);
    }

    if (dfc) {
      const flipBtn = document.createElement('button');
      flipBtn.className   = 'result-flip-btn';
      flipBtn.title       = 'Flip card';
      flipBtn.textContent = '⟳';
      flipBtn.addEventListener('click', e => {
        e.stopPropagation(); // don't open detail panel
        showingFront = !showingFront;
        img.src = showingFront ? imgFront : imgBack;
        flipBtn.classList.toggle('flipped', !showingFront);
      });
      wrap.appendChild(flipBtn);
    }

    const hoverInfo = document.createElement('div');
    hoverInfo.className = 'result-hover-info';
    hoverInfo.innerHTML = `
      <span class="result-name">${card.name}</span>
      <span class="result-meta">${card.set_name} · <span class="rarity-${card.rarity}">${capitalize(card.rarity)}</span></span>
      ${card.cmc !== undefined ? `<span class="result-meta">${card.cmc} MV · ${card.type_line || ''}</span>` : `<span class="result-meta">${card.type_line || ''}</span>`}
    `;
    wrap.appendChild(hoverInfo);
    tile.appendChild(wrap);

    tile.addEventListener('click', () => showCardDetail(card));

    if (imgFull) {
      tile.addEventListener('mouseenter', e => showTooltip(imgFull, e));
      tile.addEventListener('mousemove',  e => moveTooltip(e));
      tile.addEventListener('mouseleave', hideTooltip);
    }

    resultsList.appendChild(tile);
  });
}

// ── Commander ─────────────────────────────────────────────────
commanderBtn.addEventListener('click', setCommander);
commanderInput.addEventListener('keydown', e => { if (e.key === 'Enter') setCommander(); });
clearCommanderBtn.addEventListener('click', clearCommander);

async function setCommander() {
  const name = commanderInput.value.trim();
  if (!name) return;
  commanderBtn.disabled = true;
  commanderBtn.textContent = 'Loading…';
  try {
    const card = await fetchCardByName(name);
    applyCommanderCard(card);
    commanderInput.value = '';
    renderDeck();
  } catch (err) {
    showToast('Commander not found: ' + err.message);
  } finally {
    commanderBtn.disabled = false;
    commanderBtn.textContent = 'Set Commander';
  }
}

function clearCommander() {
  commander = null;
  commanderDisplay.classList.add('hidden');
  resetColorTheme();
  renderDeck();
}

function makePip(colorCode) {
  const meta = COLOR_META[colorCode] || COLOR_META['C'];
  const pip  = document.createElement('span');
  pip.className = 'color-pip';
  pip.title     = meta.name;
  pip.textContent = meta.symbol;
  pip.style.setProperty('--pip-bg',    meta.bg);
  pip.style.setProperty('--pip-color', meta.css);
  return pip;
}

function isColorLegal(card) {
  if (!commander) return true;
  const cmdColors  = new Set(getColorIdentity(commander));
  const cardColors = getColorIdentity(card);
  if (cardColors.length === 0) return true;
  return cardColors.every(c => cmdColors.has(c));
}

function applyCommanderCard(card) {
  commander = card;
  const thumb  = getImageUri(card, 'small');
  commanderThumb.src      = thumb || '';
  commanderNameEl.textContent = card.name;
  commanderColorsEl.innerHTML = '';
  const colors = getColorIdentity(card);
  if (colors.length === 0) commanderColorsEl.appendChild(makePip('C'));
  else colors.forEach(c => commanderColorsEl.appendChild(makePip(c)));
  commanderDisplay.classList.remove('hidden');
  applyColorTheme(colors);
  showToast(`Commander set: ${card.name}`);
}

// ── Color Themes ──────────────────────────────────────────────
const COLOR_THEMES = {
  W:    { accent: '#d4af37', accent2: '#f9f4e8' },
  U:    { accent: '#3a7bd5', accent2: '#aad3f3' },
  B:    { accent: '#7b4fa6', accent2: '#c0bdb8' },
  R:    { accent: '#e94560', accent2: '#f5a623' },
  G:    { accent: '#2d8a4e', accent2: '#9ed09e' },
  WU:   { accent: '#3a7bd5', accent2: '#d4af37' },
  WB:   { accent: '#7b4fa6', accent2: '#d4af37' },
  WR:   { accent: '#e94560', accent2: '#d4af37' },
  WG:   { accent: '#2d8a4e', accent2: '#f9f4e8' },
  UB:   { accent: '#5a3abf', accent2: '#aad3f3' },
  UR:   { accent: '#cc4400', accent2: '#aad3f3' },
  UG:   { accent: '#1a8a6e', accent2: '#aad3f3' },
  BR:   { accent: '#8b1a1a', accent2: '#c0bdb8' },
  BG:   { accent: '#2d5a1a', accent2: '#c0bdb8' },
  RG:   { accent: '#bf6a00', accent2: '#f9a860' },
  WUB:  { accent: '#5a3abf', accent2: '#d4af37' },
  WUR:  { accent: '#cc4400', accent2: '#aad3f3' },
  WUG:  { accent: '#1a8a6e', accent2: '#d4af37' },
  WBR:  { accent: '#8b1a1a', accent2: '#d4af37' },
  WBG:  { accent: '#2d5a1a', accent2: '#d4af37' },
  WRG:  { accent: '#bf6a00', accent2: '#f9f4e8' },
  UBR:  { accent: '#8b1a1a', accent2: '#aad3f3' },
  UBG:  { accent: '#2d5a1a', accent2: '#aad3f3' },
  URG:  { accent: '#bf6a00', accent2: '#aad3f3' },
  BRG:  { accent: '#bf6a00', accent2: '#c0bdb8' },
  WUBR: { accent: '#cc4400', accent2: '#d4af37' },
  WUBG: { accent: '#2d8a4e', accent2: '#d4af37' },
  WURG: { accent: '#bf6a00', accent2: '#aad3f3' },
  WBRG: { accent: '#bf6a00', accent2: '#d4af37' },
  UBRG: { accent: '#bf6a00', accent2: '#c0bdb8' },
  WUBRG:{ accent: '#a07820', accent2: '#f9f4e8' },
};

function applyColorTheme(colors) {
  const key   = [...colors].sort().join('');
  const theme = COLOR_THEMES[key] || COLOR_THEMES[colors[0]] || null;
  if (!theme) return;
  document.documentElement.style.setProperty('--accent',  theme.accent);
  document.documentElement.style.setProperty('--accent2', theme.accent2);
}

function resetColorTheme() {
  document.documentElement.style.setProperty('--accent',  '#e94560');
  document.documentElement.style.setProperty('--accent2', '#f5a623');
}

// ── Toggle Card Preview Panel ─────────────────────────────────
let previewVisible = false; // controla se o painel está expandido

function openDetailPanel() {
  cardDetail.classList.add('is-open');
  togglePreviewBtn.classList.add('panel-open');
  togglePreviewBtn.classList.add('panel-visible');
  togglePreviewBtn.title = 'Minimizar preview';
  previewVisible = true;
}

function closeDetailPanel() {
  cardDetail.classList.remove('is-open');
  togglePreviewBtn.classList.remove('panel-open');
  // panel-visible mantém o botão na borda esquerda como aba
  togglePreviewBtn.title = 'Abrir preview';
  previewVisible = false;
}

togglePreviewBtn.addEventListener('click', () => {
  if (previewVisible) closeDetailPanel();
  else                openDetailPanel();
});

// Clicar fora do painel minimiza
document.addEventListener('click', e => {
  if (!previewVisible) return;
  if (cardDetail.contains(e.target))       return; // clique dentro do painel
  if (togglePreviewBtn.contains(e.target)) return; // clique no botão toggle
  if (e.target.closest('.result-item'))    return; // clique num card tile (showCardDetail cuida disso)
  if (e.target.closest('.modal'))          return; // clique em modal
  closeDetailPanel();
});

// Em touch, swipe down no card detail fecha o painel
(function setupSwipeClose() {
  let startY = 0;
  cardDetail.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, { passive: true });
  cardDetail.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 60) closeDetailPanel(); // swipe down de 60px fecha
  }, { passive: true });
})();


let detailFaceIndex = 0; // 0 = front, 1 = back

function showCardDetail(card) {
  selectedCard    = card;
  detailFaceIndex = 0;
  renderDetailFace(card, 0);

  // Show / hide flip button
  const flipBtn = document.getElementById('detailFlipBtn');
  if (isDFC(card)) {
    flipBtn.classList.remove('hidden');
    flipBtn.textContent = '⟳ Flip';
  } else {
    flipBtn.classList.add('hidden');
  }

  // Color identity warning
  if (!isColorLegal(card)) {
    colorWarning.textContent = `⚠ Color identity (${getColorIdentity(card).join('')}) is outside your commander's colors (${getColorIdentity(commander).join('')}).`;
    colorWarning.classList.remove('hidden');
  } else {
    colorWarning.classList.add('hidden');
  }

  qtyInput.value = 1;

  // Busca e exibe o preço (assíncrono, não bloqueia a abertura do painel)
  displayCardPrice(card);

  // Reveal toggle button and show the panel
  togglePreviewBtn.classList.add('panel-visible');
  openDetailPanel();

  // Restart slide-in animation (não mais necessário com transition CSS)
  const cd = document.getElementById('cardDetail');
  cd.style.animation = 'none';
  void cd.offsetWidth;
  cd.style.animation = '';
}

/** Render one face of a card into the detail panel */
function renderDetailFace(card, faceIndex) {
  const imgSrc = getImageUri(card, 'large', faceIndex);
  document.getElementById('detailImage').src = imgSrc || '';

  // For DFC, use per-face data where available
  const face = card.card_faces ? card.card_faces[faceIndex] : null;

  document.getElementById('detailName').textContent   = face ? `${face.name} (${faceIndex === 0 ? 'Front' : 'Back'})` : card.name;
  document.getElementById('detailMana').textContent   = face?.mana_cost || card.mana_cost || '—';
  document.getElementById('detailType').textContent   = face?.type_line || card.type_line || '—';
  document.getElementById('detailSet').textContent    = card.set_name  || '—';
  document.getElementById('detailRarity').textContent = capitalize(card.rarity || '—');
  document.getElementById('detailOracle').textContent = face?.oracle_text || card.oracle_text || '—';

  const pipsEl = document.getElementById('detailColorPips');
  pipsEl.innerHTML = '';
  getColorIdentity(card).forEach(c => pipsEl.appendChild(makePip(c)));

  const ptLine = document.getElementById('detailPTLine');
  const pt = face?.power !== undefined
    ? `${face.power} / ${face.toughness}`
    : (card.power !== undefined ? `${card.power} / ${card.toughness}` : null);
  const loyalty = face?.loyalty || card.loyalty;

  if (pt) {
    document.getElementById('detailPT').textContent = pt;
    ptLine.classList.remove('hidden');
  } else if (loyalty) {
    document.getElementById('detailPT').textContent = `Loyalty: ${loyalty}`;
    ptLine.classList.remove('hidden');
  } else {
    ptLine.classList.add('hidden');
  }
}

// Flip button in detail panel
document.getElementById('detailFlipBtn').addEventListener('click', () => {
  if (!selectedCard || !isDFC(selectedCard)) return;
  detailFaceIndex = detailFaceIndex === 0 ? 1 : 0;
  renderDetailFace(selectedCard, detailFaceIndex);

  const flipBtn = document.getElementById('detailFlipBtn');
  flipBtn.textContent = detailFaceIndex === 0 ? '⟳ Flip' : '⟳ Front';
  flipBtn.classList.toggle('flipped', detailFaceIndex === 1);
});

// ── Printings ─────────────────────────────────────────────────
const printingsBtn    = document.getElementById('printingsBtn');
const printingsModal  = document.getElementById('printingsModal');
const printingsTitle  = document.getElementById('printingsTitle');
const printingsCount  = document.getElementById('printingsCount');
const printingsGrid   = document.getElementById('printingsGrid');
const closePrintingsBtn = document.getElementById('closePrintingsBtn');

printingsBtn.addEventListener('click', async () => {
  if (!selectedCard) return;
  await openPrintingsModal(selectedCard);
});

const filteredPrintingsBtn = document.getElementById('filteredPrintingsBtn');
filteredPrintingsBtn.addEventListener('click', async () => {
  if (!selectedCard) return;
  await openPrintingsModal(selectedCard, buildFilterOnlyQuery(selectedCard));
});

closePrintingsBtn.addEventListener('click', () => printingsModal.classList.add('hidden'));
printingsModal.addEventListener('click', e => { if (e.target === printingsModal) printingsModal.classList.add('hidden'); });

/**
 * Monta a query Scryfall com os filtros ativos do painel avançado,
 * fixando o nome exato do card. Ignora o campo de texto da busca principal.
 * Usa unique=prints para mostrar edições distintas.
 */
function buildFilterOnlyQuery(card) {
  const parts = [`!"${card.name}"`];

  // Rarity
  const rarities = [...advPanel.querySelectorAll('input[data-rarity]:checked')].map(cb => cb.dataset.rarity);
  if (rarities.length === 1)       parts.push(`r:${rarities[0]}`);
  else if (rarities.length > 1)    parts.push('(' + rarities.map(r => `r:${r}`).join(' OR ') + ')');

  // Set code
  const setCode = document.getElementById('setCode').value.trim();
  if (setCode) parts.push(`set:${setCode.toLowerCase()}`);

  // Format legality
  const fmt = document.getElementById('legalFormat').value;
  if (fmt) parts.push(`legal:${fmt}`);

  // Language (se o campo existir no painel — não existe ainda, placeholder)
  // CMC filter also useful for land variants etc.
  const cmcOp  = document.getElementById('cmcOp').value;
  const cmcVal = document.getElementById('cmcVal').value.trim();
  if (cmcOp && cmcVal !== '') parts.push(`cmc${cmcOp}${cmcVal}`);

  return parts.join(' ');
}

async function openPrintingsModal(card, customQuery = null) {
  const isFiltered = customQuery !== null;
  printingsTitle.textContent = isFiltered
    ? `Filtered Prints — ${card.name}`
    : `All Printings — ${card.name}`;
  printingsCount.textContent = '';
  printingsGrid.innerHTML    = '<span class="spinner"></span> Loading…';
  printingsModal.classList.remove('hidden');

  try {
    const query = customQuery ?? `!"${card.name}"`;
    const url   = `https://api.scryfall.com/cards/search`
      + `?q=${encodeURIComponent(query)}`
      + `&unique=prints`
      + `&order=released`
      + `&dir=desc`;

    let allPrints = [];
    let nextUrl   = url;

    while (nextUrl) {
      const res  = await fetch(nextUrl);
      // 404 = nenhum resultado com os filtros — não é erro crítico
      if (res.status === 404) break;
      if (!res.ok) throw new Error('Failed to load printings');
      const data = await res.json();
      allPrints  = allPrints.concat(data.data || []);
      nextUrl    = data.next_page || null;
    }

    if (allPrints.length === 0) {
      printingsCount.textContent = '';
      printingsGrid.innerHTML    = `<p style="color:var(--muted);padding:1rem;">
        ${isFiltered ? 'Nenhuma edição encontrada com os filtros ativos.' : 'No printings found.'}
      </p>`;
      return;
    }

    printingsCount.textContent = `${allPrints.length} printing${allPrints.length !== 1 ? 's' : ''}${isFiltered ? ' (filtered)' : ''}`;
    printingsGrid.innerHTML    = '';

    allPrints.forEach(print => {
      const imgSrc   = getImageUri(print, 'normal');
      const imgLarge = getImageUri(print, 'large');
      if (!imgSrc) return;

      const tile = document.createElement('div');
      tile.className = 'print-tile';
      tile.innerHTML = `
        <img src="${imgSrc}" alt="${print.set_name}" loading="lazy" />
        <div class="print-tile-info">
          <span class="print-set-name">${print.set_name}</span>
          <span class="print-set-meta">
            <span class="print-set-code">${print.set.toUpperCase()}</span>
            <span class="rarity-${print.rarity}">${capitalize(print.rarity)}</span>
            ${print.collector_number ? `<span class="print-num">#${print.collector_number}</span>` : ''}
          </span>
          ${print.lang && print.lang !== 'en' ? `<span class="print-lang">${print.lang.toUpperCase()}</span>` : ''}
        </div>
      `;

      tile.addEventListener('click', () => {
        if (imgLarge) document.getElementById('detailImage').src = imgLarge;
        tile.classList.toggle('print-selected');
        printingsModal.classList.add('hidden');
        showToast(`Showing ${print.set_name} art`);
      });

      tile.addEventListener('mouseenter', e => showTooltip(imgSrc, e));
      tile.addEventListener('mousemove',  e => moveTooltip(e));
      tile.addEventListener('mouseleave', hideTooltip);

      printingsGrid.appendChild(tile);
    });
  } catch (err) {
    printingsGrid.innerHTML = `<p style="color:var(--accent);padding:1rem;">⚠ ${err.message}</p>`;
  }
}


function isCreature(card) { return (card.type_line || '').includes('Creature'); }

let pendingAdd = null;

addToDeckBtn.addEventListener('click', () => {
  if (!selectedCard) return;
  const qty         = parseInt(qtyInput.value, 10) || 1;
  const deckIsEmpty = Object.keys(deck).length === 0;

  if (deckIsEmpty && !commander && isCreature(selectedCard)) {
    pendingAdd            = { card: selectedCard, qty };
    cmdModalImg.src       = getImageUri(selectedCard, 'normal') || '';
    cmdModalTitle.textContent = selectedCard.name;
    commanderModal.classList.remove('hidden');
    return;
  }
  commitAdd(selectedCard, qty);
});

function commitAdd(card, qty) {
  const id = card.id;
  if (deck[id]) deck[id].qty += qty;
  else          deck[id] = { card, qty };
  renderDeck();
  updateDeckTotalValue();
  showToast(`${qty}× ${card.name} added`);
}

cmdModalYes.addEventListener('click', () => {
  commanderModal.classList.add('hidden');
  if (!pendingAdd) return;
  applyCommanderCard(pendingAdd.card);
  commitAdd(pendingAdd.card, pendingAdd.qty);
  pendingAdd = null;
});

cmdModalNo.addEventListener('click', () => {
  commanderModal.classList.add('hidden');
  if (!pendingAdd) return;
  commitAdd(pendingAdd.card, pendingAdd.qty);
  pendingAdd = null;
});

// ── Deck Rendering ────────────────────────────────────────────
const CATEGORY_ORDER = ['Planeswalker','Creature','Instant','Sorcery','Enchantment','Artifact','Land','Other'];
const LAND_TARGET    = 33;

function getCategory(card) {
  const type = card.type_line || '';
  for (const cat of CATEGORY_ORDER) { if (type.includes(cat)) return cat; }
  return 'Other';
}

function renderDeck() {
  const groups = {};
  CATEGORY_ORDER.forEach(c => { groups[c] = []; });
  Object.values(deck).forEach(e => groups[getCategory(e.card)].push(e));

  deckCategories.innerHTML = '';
  let total = 0, landTotal = 0;

  // ── Seção Commander ──────────────────────────────────────────
  const commanders = Array.isArray(commander)
    ? commander                          // futuro: array de commanders
    : (commander ? [commander] : []);

  if (commanders.length > 0) {
    const cmdSection = document.createElement('div');
    cmdSection.className = 'deck-category';
    cmdSection.innerHTML = `<h3>Commander <span style="color:var(--accent2)">(${commanders.length})</span></h3>`;

    commanders.forEach(cmdCard => {
      const row    = document.createElement('div');
      row.className = 'deck-entry';
      const tipSrc = getImageUri(cmdCard, 'normal');
      const price  = formatPrice(cmdCard._cheapestBrl);
      const mana   = renderManaCost(getManaCost(cmdCard));

      row.innerHTML = `
        <span class="deck-entry-qty">1x</span>
        <span class="deck-entry-name" title="${cmdCard.name}">⚔️ ${cmdCard.name}</span>
        <span class="deck-entry-mana">${mana}</span>
        <div class="deck-entry-right">
          ${price ? `<span class="deck-entry-price">${price}</span>` : ''}
        </div>
      `;

      if (tipSrc) {
        row.addEventListener('mouseenter', e => showTooltip(tipSrc, e));
        row.addEventListener('mousemove',  e => moveTooltip(e));
        row.addEventListener('mouseleave', hideTooltip);
      }

      cmdSection.appendChild(row);
    });

    // Botão para adicionar partner ou background
    const addPartnerBtn = document.createElement('button');
    addPartnerBtn.className   = 'btn-add-partner btn-secondary';
    addPartnerBtn.textContent = '+ Partner / Background';
    addPartnerBtn.title       = 'Adicionar partner ou background como segundo comandante';
    addPartnerBtn.addEventListener('click', () => openPartnerSearch());
    cmdSection.appendChild(addPartnerBtn);

    deckCategories.appendChild(cmdSection);
  }

  // ── Categorias normais — exclui commander/partners ──────────
  // Coleta os IDs de todos os commanders para filtrar da lista
  const commanderIds = new Set(
    (Array.isArray(commander) ? commander : (commander ? [commander] : []))
      .map(c => c.id)
  );

  CATEGORY_ORDER.forEach(cat => {
    const entries = groups[cat].filter(e => !commanderIds.has(e.card.id));
    if (!entries.length) return;
    entries.sort((a, b) => a.card.name.localeCompare(b.card.name));
    const catTotal = entries.reduce((s, e) => s + e.qty, 0);
    total += catTotal;
    if (cat === 'Land') landTotal = catTotal;

    const section = document.createElement('div');
    section.className = 'deck-category';
    section.innerHTML = `<h3>${cat} <span style="color:var(--accent2)">(${catTotal})</span></h3>`;

    entries.forEach(entry => {
      const row    = document.createElement('div');
      row.className = 'deck-entry';
      const legal  = isColorLegal(entry.card);
      if (!legal) row.classList.add('out-of-color');
      const tipSrc = getImageUri(entry.card, 'normal');
      const price  = formatPrice(entry.card._cheapestBrl);
      const mana   = renderManaCost(getManaCost(entry.card));

      row.innerHTML = `
        <span class="deck-entry-qty">${entry.qty}x</span>
        <span class="deck-entry-name" title="${entry.card.name}">${entry.card.name}${!legal ? ' ⚠' : ''}</span>
        <span class="deck-entry-mana">${mana}</span>
        <div class="deck-entry-right">
          ${price ? `<span class="deck-entry-price">${price}</span>` : ''}
          <div class="deck-entry-actions">
            <button class="inc-btn"    title="Add one">+</button>
            <button class="dec-btn"    title="Remove one">−</button>
            <button class="remove-btn" title="Remove all">✕</button>
          </div>
        </div>
      `;

      if (tipSrc) {
        row.addEventListener('mouseenter', e => showTooltip(tipSrc, e));
        row.addEventListener('mousemove',  e => moveTooltip(e));
        row.addEventListener('mouseleave', hideTooltip);
      }

      row.querySelector('.inc-btn').addEventListener('click',    () => { deck[entry.card.id].qty++; renderDeck(); updateDeckTotalValue(); });
      row.querySelector('.dec-btn').addEventListener('click',    () => { deck[entry.card.id].qty--; if (deck[entry.card.id].qty <= 0) delete deck[entry.card.id]; renderDeck(); updateDeckTotalValue(); });
      row.querySelector('.remove-btn').addEventListener('click', () => { delete deck[entry.card.id]; renderDeck(); updateDeckTotalValue(); });

      section.appendChild(row);
    });
    deckCategories.appendChild(section);
  });

  deckCount.textContent = `${total} / 99`;
  landCount.textContent = `${landTotal} / ${LAND_TARGET}`;
  const pct  = Math.min((landTotal / LAND_TARGET) * 100, 100);
  landBar.style.width = pct + '%';
  const diff = LAND_TARGET - landTotal;
  if      (landTotal === 0) { landTip.textContent = `Add ${LAND_TARGET} lands for a balanced Commander deck.`; landBar.className = 'land-bar'; }
  else if (diff > 0)        { landTip.textContent = `Add ${diff} more land${diff !== 1 ? 's' : ''} to reach the recommended 33.`; landBar.className = 'land-bar under'; }
  else if (diff === 0)      { landTip.textContent = '✓ Perfect — 33 lands!'; landBar.className = 'land-bar perfect'; }
  else                      { landTip.textContent = `${Math.abs(diff)} land${Math.abs(diff) !== 1 ? 's' : ''} over the recommended 33.`; landBar.className = 'land-bar over'; }
}

// ── Export ────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const lines = [];

  if (commander) lines.push(`1 ${commander.name}`);

  Object.values(deck)
    .sort((a, b) => a.card.name.localeCompare(b.card.name))
    .forEach(e => lines.push(`${e.qty} ${e.card.name}`));

  exportText.value = lines.join('\n').trim();
  exportModal.classList.remove('hidden');
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(exportText.value).then(() => showToast('Copied to clipboard'));
});

closeModalBtn.addEventListener('click', () => exportModal.classList.add('hidden'));
exportModal.addEventListener('click',  e => { if (e.target === exportModal) exportModal.classList.add('hidden'); });

// ── Clear Deck ────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (!Object.keys(deck).length && !commander) return;
  if (confirm('Limpar o deck atual?')) {
    clearDeckState();
    showToast('Deck limpo');
  }
});

// ── Hover Tooltip ─────────────────────────────────────────────
function showTooltip(imgSrc, e) {
  tooltipImg.src = imgSrc;
  hoverTooltip.classList.remove('hidden');
  moveTooltip(e);
}

function moveTooltip(e) {
  const pad = 16, tipW = 240, tipH = 336;
  const vw  = window.innerWidth,  vh = window.innerHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tipW > vw - pad) x = e.clientX - tipW - pad;
  if (y + tipH > vh - pad) y = e.clientY - tipH - pad;
  hoverTooltip.style.left = x + 'px';
  hoverTooltip.style.top  = y + 'px';
}

function hideTooltip() { hoverTooltip.classList.add('hidden'); }

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ── Utilities ──────────────────────────────────────────────────
function capitalize(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }

// ── DB — DOM refs ─────────────────────────────────────────────
const saveDbBtn          = document.getElementById('saveDbBtn');
const loadDbBtn          = document.getElementById('loadDbBtn');

const saveDeckModal      = document.getElementById('saveDeckModal');
const saveUserName       = document.getElementById('saveUserName');
const saveDeckName       = document.getElementById('saveDeckName');
const saveDeckConfirmBtn = document.getElementById('saveDeckConfirmBtn');
const saveDeckCancelBtn  = document.getElementById('saveDeckCancelBtn');

const loadDeckModal      = document.getElementById('loadDeckModal');
const closeLoadDeckBtn   = document.getElementById('closeLoadDeckBtn');
const loadUserFilter     = document.getElementById('loadUserFilter');
const deckListContainer  = document.getElementById('deckListContainer');

const discardModal       = document.getElementById('discardModal');
const discardSaveBtn     = document.getElementById('discardSaveBtn');
const discardDiscardBtn  = document.getElementById('discardDiscardBtn');
const discardCancelBtn   = document.getElementById('discardCancelBtn');

// ── DB — State ────────────────────────────────────────────────
let currentDeckId   = null; // id do deck aberto (null = novo)
let pendingLoadDeck = null; // deck a carregar após confirmar descarte

// ── DB — Save ─────────────────────────────────────────────────

/** Abre o modal de salvar, pré-preenchendo se já tem nome */
saveDbBtn.addEventListener('click', () => {
  if (Object.keys(deck).length === 0 && !commander) {
    showToast('Deck vazio — adicione cartas antes de salvar.');
    return;
  }
  saveDeckModal.classList.remove('hidden');
});

saveDeckCancelBtn.addEventListener('click', () => saveDeckModal.classList.add('hidden'));
saveDeckModal.addEventListener('click', e => { if (e.target === saveDeckModal) saveDeckModal.classList.add('hidden'); });

saveDeckConfirmBtn.addEventListener('click', async () => {
  const userName = saveUserName.value.trim();
  const deckName = saveDeckName.value.trim();

  if (!userName) { saveUserName.focus(); showToast('Informe seu nome.'); return; }
  if (!deckName) { saveDeckName.focus(); showToast('Informe o nome do deck.'); return; }

  saveDeckConfirmBtn.disabled = true;
  saveDeckConfirmBtn.textContent = 'Salvando…';

  try {
    await persistDeck(userName, deckName);
    saveDeckModal.classList.add('hidden');
    showToast(`Deck "${deckName}" salvo!`);
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message);
  } finally {
    saveDeckConfirmBtn.disabled = false;
    saveDeckConfirmBtn.textContent = 'Salvar';
  }
});

/**
 * Persiste o deck atual no Supabase.
 * Se currentDeckId existir, deleta as cartas antigas e reinsere.
 */
async function persistDeck(userName, deckName) {
  // Monta JSON do(s) commander(s) — array para suportar partners futuramente
  // Salva apenas os campos necessários para exibição e recarga
  const commanderJson = commander ? [minifyCard(commander)] : [];

  if (currentDeckId) {
    // Atualiza: remove cartas antigas e reinsere
    await sbDelete('deck_list', `?deck_id=eq.${currentDeckId}`);
  } else {
    // Cria registro na tabela deck
    const rows = await sbInsert('deck', [{
      user_name:  userName,
      deck_name:  deckName,
      commander:  commanderJson,
    }]);
    currentDeckId = rows[0].id;
  }

  // Insere cartas
  const cardRows = Object.values(deck).map(entry => ({
    deck_id:     currentDeckId,
    card_name:   entry.card.name,
    card_type:   entry.card.type_line  || null,
    card_rarity: entry.card.rarity     || null,
    card_print:  getScryfallCardUrl(entry.card),
    card_value:  entry.card._cheapestBrl ?? null,
    quantity:    entry.qty,
  }));

  if (cardRows.length > 0) {
    await sbInsert('deck_list', cardRows);
  }
}

/** Monta a URL canônica do card no Scryfall */
function getScryfallCardUrl(card) {
  if (card.set && card.collector_number) {
    const name = card.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return `https://scryfall.com/card/${card.set}/${card.collector_number}/${name}`;
  }
  return card.scryfall_uri || null;
}

// ── DB — Load ─────────────────────────────────────────────────

loadDbBtn.addEventListener('click', () => {
  const hasCards = Object.keys(deck).length > 0 || commander;
  if (hasCards) {
    discardModal.classList.remove('hidden');
    pendingLoadDeck = 'open-modal'; // sinaliza: depois de decidir, abre o modal
  } else {
    openLoadModal();
  }
});

closeLoadDeckBtn.addEventListener('click', () => loadDeckModal.classList.add('hidden'));
loadDeckModal.addEventListener('click', e => { if (e.target === loadDeckModal) loadDeckModal.classList.add('hidden'); });

loadUserFilter.addEventListener('input', () => {
  const q = loadUserFilter.value.trim().toLowerCase();
  document.querySelectorAll('.deck-list-item').forEach(el => {
    const meta = el.querySelector('.deck-list-meta')?.textContent.toLowerCase() || '';
    const name = el.querySelector('.deck-list-name')?.textContent.toLowerCase() || '';
    el.style.display = (name.includes(q) || meta.includes(q)) ? '' : 'none';
  });
});

// Handlers do modal de descarte
discardSaveBtn.addEventListener('click', async () => {
  discardModal.classList.add('hidden');
  // Abre modal de salvar; depois que salvar, abre o de carregar
  saveDeckModal.classList.remove('hidden');
  // Quando salvar for confirmado, o fluxo natural já vai continuar
  // Aqui apenas marcamos que ao fechar o save modal devemos abrir o load
  saveDeckModal.dataset.afterSave = 'load';
});

discardDiscardBtn.addEventListener('click', () => {
  discardModal.classList.add('hidden');
  clearDeckState();
  openLoadModal();
});

discardCancelBtn.addEventListener('click', () => {
  discardModal.classList.add('hidden');
  pendingLoadDeck = null;
});

// Sobrescreve o confirm de save para checar afterSave
saveDeckConfirmBtn.addEventListener('click', async () => {}, { once: false });
// (já registrado acima; o dataset.afterSave é verificado na versão anterior — ajustamos inline)

// Patch: após salvar com sucesso no fluxo de afterSave, abre o load modal
const _origSaveConfirm = saveDeckConfirmBtn.onclick;
saveDeckModal.addEventListener('hidden-custom', () => {
  if (saveDeckModal.dataset.afterSave === 'load') {
    delete saveDeckModal.dataset.afterSave;
    clearDeckState();
    openLoadModal();
  }
});

// Ajuste no botão de salvar para emitir evento custom após fechar
saveDeckConfirmBtn.addEventListener('click', async function handler() {
  if (saveDeckModal.dataset.afterSave === 'load') {
    // Aguarda o fluxo principal salvar (já registrado) e então abre load
    // Usamos MutationObserver para detectar quando o modal some
    const obs = new MutationObserver(() => {
      if (saveDeckModal.classList.contains('hidden')) {
        obs.disconnect();
        if (saveDeckModal.dataset.afterSave === 'load') {
          delete saveDeckModal.dataset.afterSave;
          clearDeckState();
          openLoadModal();
        }
      }
    });
    obs.observe(saveDeckModal, { attributes: true, attributeFilter: ['class'] });
  }
});

async function openLoadModal() {
  loadDeckModal.classList.remove('hidden');
  loadUserFilter.value = '';
  deckListContainer.innerHTML = '<span class="spinner"></span> Carregando…';

  try {
    // Traz os decks com as quantities para somar no frontend
    const decks = await sbSelect('deck', '?select=id,deck_name,user_name,commander,created_at,deck_list(quantity)&order=created_at.desc');
    renderDeckList(decks);
  } catch (err) {
    deckListContainer.innerHTML = `<p class="db-empty">⚠ ${err.message}</p>`;
  }
}

function renderDeckList(decks) {
  deckListContainer.innerHTML = '';

  if (!decks.length) {
    deckListContainer.innerHTML = '<p class="db-empty">Nenhum deck salvo ainda.</p>';
    return;
  }

  decks.forEach(d => {
    // Pega thumbnail do commander (primeiro do array, se existir)
    const cmdArr  = Array.isArray(d.commander) ? d.commander : [];
    const cmdCard = cmdArr[0] || null;
    const thumb   = cmdCard ? getImageUri(cmdCard, 'small') : null;
    const date    = new Date(d.created_at).toLocaleDateString('pt-BR');
    // PostgREST retorna deck_list como array de {quantity: N} — soma para obter total real
    const cardCount = Array.isArray(d.deck_list)
      ? d.deck_list.reduce((sum, row) => sum + (row.quantity || 1), 0)
      : '?';

    const item = document.createElement('div');
    item.className = 'deck-list-item';
    item.innerHTML = `
      <img class="deck-list-thumb" src="${thumb || ''}" alt="" onerror="this.style.display='none'" />
      <div class="deck-list-info">
        <span class="deck-list-name">${escHtml(d.deck_name)}</span>
        <span class="deck-list-meta">por ${escHtml(d.user_name)} · ${date}${cmdCard ? ' · ' + escHtml(cmdCard.name) : ''}</span>
        <span class="deck-list-count">${cardCount} carta${cardCount !== 1 ? 's' : ''}</span>
      </div>
      <button class="deck-list-delete btn-ghost" title="Deletar deck">🗑</button>
    `;

    // Clique na linha — carrega o deck
    item.addEventListener('click', e => {
      if (e.target.closest('.deck-list-delete')) return;
      loadDeckModal.classList.add('hidden');
      loadDeckFromRecord(d);
    });

    // Deletar
    item.querySelector('.deck-list-delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Deletar "${d.deck_name}"?`)) return;
      try {
        await sbDelete('deck_list', `?deck_id=eq.${d.id}`);
        await sbDelete('deck',      `?id=eq.${d.id}`);
        item.remove();
        if (!deckListContainer.children.length)
          deckListContainer.innerHTML = '<p class="db-empty">Nenhum deck salvo ainda.</p>';
        showToast(`"${d.deck_name}" deletado.`);
      } catch (err) {
        showToast('Erro ao deletar: ' + err.message);
      }
    });

    deckListContainer.appendChild(item);
  });
}

async function loadDeckFromRecord(deckRecord) {
  try {
    const rows = await sbSelect('deck_list', `?deck_id=eq.${deckRecord.id}`);

    clearDeckState();
    currentDeckId = deckRecord.id;

    // Restaura commander(s)
    const cmdArr = Array.isArray(deckRecord.commander) ? deckRecord.commander : [];
    if (cmdArr[0]) applyCommanderCard(cmdArr[0]);

    // Busca todos os cards de uma vez via Scryfall Collection API (até 75 por chamada)
    const qtyMap = {}; // card_name → qty (para remontar depois)
    rows.forEach(r => { qtyMap[r.card_name] = r.quantity || 1; });

    const names   = rows.map(r => ({ name: r.card_name }));
    const fetched = await fetchCardCollection(names);

    fetched.forEach(card => {
      // Recupera o card_value já salvo no banco para esse card
      const savedRow = rows.find(r => r.card_name === card.name);
      if (savedRow?.card_value != null) card._cheapestBrl = savedRow.card_value;
      deck[card.id] = { card, qty: qtyMap[card.name] || 1 };
    });

    renderDeck();
    updateDeckTotalValue();
    showToast(`Deck "${deckRecord.deck_name}" carregado!`);

    // Pré-preenche campos de save com os dados do deck carregado
    saveUserName.value = deckRecord.user_name || '';
    saveDeckName.value = deckRecord.deck_name || '';
  } catch (err) {
    showToast('Erro ao carregar deck: ' + err.message);
  }
}

/**
 * Busca uma lista de cards pelo nome usando a Scryfall Collection API.
 * Aceita até 75 por chamada; pagina automaticamente se necessário.
 * @param {{ name: string }[]} identifiers
 * @returns {Promise<object[]>} array de card objects
 */
async function fetchCardCollection(identifiers) {
  const results = [];
  const CHUNK   = 75;

  for (let i = 0; i < identifiers.length; i += CHUNK) {
    const chunk = identifiers.slice(i, i + CHUNK);
    const res   = await fetch('https://api.scryfall.com/cards/collection', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ identifiers: chunk }),
    });
    if (!res.ok) throw new Error('Falha ao buscar cartas na API do Scryfall');
    const data = await res.json();
    results.push(...(data.data || []));
    // Pequena pausa entre chunks para respeitar rate-limit
    if (i + CHUNK < identifiers.length) await new Promise(r => setTimeout(r, 100));
  }

  return results;
}

/** Limpa o estado em memória sem tocar no Supabase */
function clearDeckState() {
  Object.keys(deck).forEach(k => delete deck[k]);
  commander     = null;
  currentDeckId = null;
  commanderDisplay.classList.add('hidden');
  resetColorTheme();
  renderDeck();
  updateDeckTotalValue();
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Formata um valor BRL para exibição curta (ex: R$12,50) */
function formatPrice(brl) {
  if (brl == null) return null;
  return `R$${brl.toFixed(2).replace('.', ',')}`;
}

/**
 * Converte uma string de custo de mana Scryfall (ex: "{2}{G}{W}")
 * em HTML de símbolos coloridos.
 */
function renderManaCost(manaCost) {
  if (!manaCost) return '';
  const tokens = [...manaCost.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  return tokens.map(sym => {
    const s = sym.toUpperCase();
    if      (/^\d+$/.test(s))          return `<span class="mana-sym mana-N">${s}</span>`;
    else if (s === 'X')                return `<span class="mana-sym mana-X">X</span>`;
    else if (['W','U','B','R','G','C'].includes(s))
                                       return `<span class="mana-sym mana-${s}">${s}</span>`;
    else if (s.includes('/')) {
      // Híbrido: usa a primeira cor
      const first = s.split('/')[0];
      const cls   = ['W','U','B','R','G','C'].includes(first) ? `mana-${first}` : 'mana-N';
      return `<span class="mana-sym ${cls}" title="{${sym}}">${first}</span>`;
    }
    return `<span class="mana-sym mana-N">${sym}</span>`;
  }).join('');
}

// ── Partner / Background ──────────────────────────────────────
const partnerModal     = document.getElementById('partnerModal');
const partnerInput     = document.getElementById('partnerInput');
const partnerSearchBtn = document.getElementById('partnerSearchBtn');
const partnerCancelBtn = document.getElementById('partnerCancelBtn');
const partnerResult    = document.getElementById('partnerResult');

let pendingPartnerCard = null;

function openPartnerSearch() {
  partnerInput.value      = '';
  partnerResult.innerHTML = '';
  partnerResult.classList.add('hidden');
  pendingPartnerCard = null;
  partnerModal.classList.remove('hidden');
  partnerInput.focus();
}

partnerCancelBtn.addEventListener('click', () => partnerModal.classList.add('hidden'));
partnerModal.addEventListener('click', e => { if (e.target === partnerModal) partnerModal.classList.add('hidden'); });
partnerInput.addEventListener('keydown', e => { if (e.key === 'Enter') doPartnerSearch(); });
partnerSearchBtn.addEventListener('click', doPartnerSearch);

async function doPartnerSearch() {
  const name = partnerInput.value.trim();
  if (!name) return;

  partnerSearchBtn.disabled    = true;
  partnerSearchBtn.textContent = '…';
  partnerResult.classList.add('hidden');
  pendingPartnerCard = null;

  try {
    const card   = await fetchCardByName(name);
    const type   = card.type_line || '';
    const oracle = (card.oracle_text || '') +
      (card.card_faces ? card.card_faces.map(f => f.oracle_text || '').join(' ') : '');

    const isPartner     = /\bpartner\b/i.test(oracle) && type.includes('Creature');
    const isBackground  = type.includes('Enchantment') && type.includes('Background');
    const isPartnerWith = /partner with/i.test(oracle);

    const thumb = getImageUri(card, 'small');
    let warningHtml = '';

    if (!isPartner && !isBackground) {
      warningHtml = `<div class="partner-warning">⚠ Este card não tem a habilidade Partner nem é um Background. Deseja adicionar mesmo assim?</div>`;
    } else if (isPartnerWith) {
      const match = oracle.match(/partner with ([^\(]+)/i);
      const pair  = match ? match[1].trim() : '';
      warningHtml = `<div class="partner-warning">ℹ "Partner with ${escHtml(pair)}" — este card só pode parear com esse commander específico.</div>`;
    }

    partnerResult.innerHTML = `
      <div class="partner-card-preview">
        <img src="${thumb || ''}" alt="${escHtml(card.name)}" />
        <div class="partner-card-info">
          <div class="partner-card-name">${escHtml(card.name)}</div>
          <div class="partner-card-type">${escHtml(type)}</div>
        </div>
      </div>
      ${warningHtml}
      <div class="modal-actions" style="justify-content:center">
        <button id="partnerConfirmBtn">⚔️ Adicionar como Commander</button>
      </div>
    `;
    partnerResult.classList.remove('hidden');
    pendingPartnerCard = card;

    document.getElementById('partnerConfirmBtn').addEventListener('click', () => {
      if (!pendingPartnerCard) return;
      applyCommanderCard(pendingPartnerCard);
      partnerModal.classList.add('hidden');
      renderDeck();
    });

  } catch (err) {
    partnerResult.innerHTML = `<div class="partner-warning">⚠ Card não encontrado: ${escHtml(err.message)}</div>`;
    partnerResult.classList.remove('hidden');
  } finally {
    partnerSearchBtn.disabled    = false;
    partnerSearchBtn.textContent = 'Buscar';
  }
}

function minifyCard(card) {
  const base = {
    id:               card.id,
    oracle_id:        card.oracle_id,
    name:             card.name,
    type_line:        card.type_line,
    mana_cost:        card.mana_cost,
    color_identity:   card.color_identity,
    colors:           card.colors,
    rarity:           card.rarity,
    set:              card.set,
    set_name:         card.set_name,
    collector_number: card.collector_number,
    scryfall_uri:     card.scryfall_uri,
  };

  // Imagens: card normal ou faces (DFC)
  if (card.image_uris) {
    base.image_uris = {
      small:  card.image_uris.small,
      normal: card.image_uris.normal,
      large:  card.image_uris.large,
    };
  } else if (card.card_faces) {
    base.card_faces = card.card_faces.map(f => ({
      name:       f.name,
      type_line:  f.type_line,
      mana_cost:  f.mana_cost,
      oracle_text: f.oracle_text,
      power:      f.power,
      toughness:  f.toughness,
      loyalty:    f.loyalty,
      image_uris: f.image_uris ? {
        small:  f.image_uris.small,
        normal: f.image_uris.normal,
        large:  f.image_uris.large,
      } : undefined,
    }));
  }

  return base;
}

// ── Busca pontual de preços ───────────────────────────────────
const refreshPricesBtn = document.getElementById('refreshPricesBtn');

refreshPricesBtn.addEventListener('click', async () => {
  if (Object.keys(deck).length === 0) return;
  refreshPricesBtn.classList.add('spinning');
  refreshPricesBtn.disabled = true;
  await fetchDeckPrices();
  refreshPricesBtn.classList.remove('spinning');
  refreshPricesBtn.disabled = false;
});

/**
 * Busca o menor preço BRL de cada card do deck em paralelo
 * e atualiza o total assim que todos chegarem.
 */
async function fetchDeckPrices() {
  const rate    = await getUsdToBrl();
  const entries = Object.values(deck);

  await Promise.all(entries.map(async entry => {
    const usd = await getCheapestUsd(entry.card);
    if (usd !== null) {
      entry.card._cheapestUsd = usd;
      entry.card._cheapestBrl = rate ? usd * rate : null;
    } else {
      entry.card._cheapestBrl = null;
    }
  }));

  updateDeckTotalValue();
}
