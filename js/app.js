import { PRESETS, CATEGORIES, UNITS, findPreset, emojiFor } from './veggies.js';
import * as calc from './calc.js';
import * as store from './store.js';
import { generateDemo } from './demo.js';
import * as native from './native.js';

const APP_VERSION = '1.0.0';
const TITLES = { fridge: 'Your fridge', add: 'Add groceries', stats: 'Waste report', list: 'Shopping list', more: 'Settings' };
const LIST_WEEKS = 8;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => calc.toISODate(new Date());

const state = {
  db: null, // loaded in init(): native storage is async
  tab: 'fridge',
  fridgeView: 'open',
  period: 'month',
  draft: null,
  filter: '',
  tripDate: today(),
  installEvent: null,
  pendingDelete: null,
};

// ---------- formatting ----------
// Currencies where prices are normally whole numbers (₹40, not ₹40.00).
const WHOLE_CURRENCIES = new Set(['INR', 'JPY', 'LKR']);

function money(n) {
  const v = Number(n) || 0;
  const digits = WHOLE_CURRENCIES.has(state.db.settings.currency) || Math.abs(v) >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: state.db.settings.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  } catch {
    return `${state.db.settings.currency} ${v.toFixed(digits)}`;
  }
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const fmtQty = (q) => String(Number((Number(q) || 0).toFixed(2)));
const fmtDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const fmtMonth = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const options = (list, selected) =>
  list.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
const pairs = (list) => list.map((v) => [v, v]);

// ---------- persistence ----------
function save() {
  if (!store.saveDB(state.db)) toast('Could not save. Storage is full or blocked, so export a backup from Settings.');
  queueReminders();
}

let reminderTimer;
function queueReminders() {
  if (!native.isNative) return;
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(() => {
    const { reminders, reminderHour } = state.db.settings;
    native.scheduleReminders(reminders ? calc.reminderPlan(state.db.items, today()) : [], reminderHour);
  }, 500);
}
const findItem = (id) => state.db.items.find((i) => i.id === id);

// ---------- toast ----------
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').onclick = () => {
      el.hidden = true;
      action.fn();
    };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 3000);
}

// ---------- shared fragments ----------
function segmented(key, opts, current) {
  return `<div class="seg" role="group">${opts
    .map(
      ([v, label]) =>
        `<button type="button" data-action="seg" data-key="${key}" data-value="${v}" aria-pressed="${v === current}">${label}</button>`,
    )
    .join('')}</div>`;
}

function emptyState(icon, title, text, href, cta) {
  return `<div class="empty"><div class="big" aria-hidden="true">${icon}</div><h2>${title}</h2><p class="muted">${text}</p>
    ${href ? `<a class="btn primary" href="${href}">${cta}</a>` : ''}</div>`;
}

function itemFields(it, { withDate = false } = {}) {
  const units = UNITS.includes(it.unit) ? UNITS : [...UNITS, it.unit];
  return `
    <label class="full">Item <input name="item_name" value="${esc(it.item_name)}" maxlength="60" required autocomplete="off"></label>
    <div class="grid2">
      <label>Quantity <input name="quantity" type="number" min="0" step="any" inputmode="decimal" value="${esc(it.quantity)}" required></label>
      <label>Unit <select name="unit">${options(pairs(units), it.unit)}</select></label>
      <label>Price paid (total) <input name="price" type="number" min="0" step="any" inputmode="decimal" value="${it.price === '' || it.price == null ? '' : esc(it.price)}" placeholder="0"></label>
      <label>Type <select name="category">${options(pairs(Object.keys(CATEGORIES)), it.category)}</select></label>
      ${withDate ? `<label>Bought on <input type="date" name="purchase_date" value="${esc(it.purchase_date)}" max="${today()}" required></label>` : ''}
    </div>`;
}

function readItemFields(form) {
  const f = form.elements;
  return {
    item_name: f.item_name.value.trim(),
    quantity: Number(f.quantity.value),
    unit: f.unit.value,
    price: f.price.value === '' ? 0 : Number(f.price.value),
    category: f.category.value,
    purchase_date: f.purchase_date?.value,
  };
}

function validateItem(v) {
  if (!v.item_name) return 'Give the item a name.';
  if (!(v.quantity > 0)) return 'Quantity must be more than 0.';
  if (!Number.isFinite(v.price) || v.price < 0) return 'Price can’t be negative.';
  if (v.purchase_date !== undefined && (!v.purchase_date || v.purchase_date > today())) return 'Pick a purchase date that isn’t in the future.';
  return null;
}

function showError(form, msg) {
  const el = form.querySelector('.form-error');
  if (el) el.textContent = msg;
  else toast(msg);
}

// ---------- Fridge ----------
const urgency = (f) => (f.level === 'spoiled' ? 1e6 : f.age / f.days);

function fridgeEntries() {
  const items = state.db.items;
  const learned = calc.learnedShelfLives(items);
  const t = today();
  return items
    .filter(calc.isOpen)
    .map((it) => ({ it, f: calc.freshness(it, t, calc.shelfDays(it, learned)) }))
    .sort((a, b) => urgency(b.f) - urgency(a.f) || a.it.item_name.localeCompare(b.it.item_name));
}

function pill(f) {
  switch (f.level) {
    case 'spoiled': return '<span class="pill bad">⚠ Spoiled</span>';
    case 'overdue': return '<span class="pill bad">! Check it</span>';
    case 'soon': return `<span class="pill warn">⏳ ${f.left <= 1 ? 'Use today' : 'Use soon'}</span>`;
    default: return '<span class="pill good">✓ Fresh</span>';
  }
}

function itemCard({ it, f }) {
  const when = f.level === 'spoiled'
    ? `spoiled ${fmtDate(it.spoiled_found_date)}`
    : `day ${f.age} of ~${f.days}`;
  return `<article class="card item lvl-${f.level}">
    <button type="button" class="item-main" data-action="edit" data-id="${it.id}">
      <span class="emoji" aria-hidden="true">${emojiFor(it.item_name)}</span>
      <span class="item-text"><strong>${esc(it.item_name)}</strong>
        <span class="sub">${fmtQty(it.quantity)} ${esc(it.unit)} · bought ${fmtDate(it.purchase_date)} · ${when}</span></span>
      ${pill(f)}
    </button>
    <div class="item-actions">
      <button type="button" data-action="used" data-id="${it.id}">✅ Used</button>
      ${f.level === 'spoiled' ? '' : `<button type="button" data-action="spoiled" data-id="${it.id}">⚠️ Spoiled</button>`}
      <button type="button" data-action="thrown" data-id="${it.id}">🗑️ Thrown</button>
    </div>
  </article>`;
}

function viewFridge() {
  const seg = segmented('fridgeView', [['open', 'In the fridge'], ['history', 'History']], state.fridgeView);
  if (state.fridgeView === 'history') return seg + viewHistory();
  const entries = fridgeEntries();
  if (!entries.length) {
    return seg + emptyState('🧊', 'Your fridge is empty',
      'Log what you buy and FridgeWise reminds you to cook it before it spoils.', '#add', 'Add groceries');
  }
  const urgent = entries.filter((e) => e.f.level !== 'fresh');
  const names = urgent.slice(0, 3).map((e) => e.it.item_name).join(', ') + (urgent.length > 3 ? '…' : '');
  const banner = urgent.length
    ? `<div class="banner warn">⏳ <strong>Cook these first:</strong> ${esc(names)}</div>`
    : '<div class="banner good">✓ Everything is fresh. Nice!</div>';
  return `${seg}${banner}<div class="stack">${entries.map(itemCard).join('')}</div>`;
}

function viewHistory() {
  const done = state.db.items
    .filter((i) => !calc.isOpen(i))
    .sort((a, b) => calc.lastDate(b).localeCompare(calc.lastDate(a)));
  if (!done.length) return emptyState('📜', 'No history yet', 'Items show up here once you mark them used or thrown.');
  return `<div class="stack">${done.map(historyRow).join('')}</div>`;
}

function historyRow(it) {
  const thrown = it.status === 'Thrown';
  const detail = thrown
    ? `${fmtQty(it.quantity_wasted)} of ${fmtQty(it.quantity)} ${esc(it.unit)} binned ${fmtDate(it.thrown_date)} · ${money(calc.moneyWasted(it))} lost`
    : `${fmtQty(it.quantity)} ${esc(it.unit)} used${it.used_date ? ` ${fmtDate(it.used_date)}` : ''}`;
  return `<button type="button" class="card row" data-action="edit" data-id="${it.id}">
    <span class="emoji" aria-hidden="true">${emojiFor(it.item_name)}</span>
    <span class="item-text"><strong>${esc(it.item_name)}</strong><span class="sub">Bought ${fmtDate(it.purchase_date)} · ${detail}</span></span>
    ${thrown ? '<span class="pill bad">🗑 Thrown</span>' : '<span class="pill good">✓ Used</span>'}
  </button>`;
}

function setOutcome(id, mutate, msg) {
  const it = findItem(id);
  if (!it) return;
  const before = { ...it };
  mutate(it);
  save();
  render();
  toast(msg, { label: 'Undo', fn: () => { Object.assign(it, before); save(); render(); } });
}

// ---------- dialogs ----------
const sheet = () => $('#sheet');

function openSheet(html) {
  const d = sheet();
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.querySelector('[autofocus]')?.focus();
}

function closeSheet() {
  const d = sheet();
  if (d.open) d.close();
  state.pendingDelete = null;
}

function openThrow(id) {
  const it = findItem(id);
  if (!it) return;
  const q = it.quantity;
  const half = calc.roundToStep(q / 2, calc.unitStep(it.unit)) || q;
  openSheet(`<form class="sheet-body" data-form="throw" data-id="${it.id}">
    <h2>${emojiFor(it.item_name)} Bin the ${esc(it.item_name.toLowerCase())}?</h2>
    <label>How much went in the bin?
      <span class="qty-row"><input name="qty" type="number" min="0" max="${q}" step="any" inputmode="decimal" value="${q}" autofocus> <span>of ${fmtQty(q)} ${esc(it.unit)}</span></span>
    </label>
    <div class="chips tight">
      <button type="button" class="chip" data-action="set-qty" data-v="${q}">All of it</button>
      ${half < q ? `<button type="button" class="chip" data-action="set-qty" data-v="${half}">About half</button>` : ''}
    </div>
    <div class="grid2">
      ${it.spoiled_found_date ? '' : `<label>Found spoiled on <input type="date" name="spoiled" value="${today()}" min="${it.purchase_date}" max="${today()}"></label>`}
      <label>Thrown on <input type="date" name="date" value="${today()}" min="${it.purchase_date}" max="${today()}" required></label>
    </div>
    <p class="hint">Money wasted: <strong data-preview>${money(it.price)}</strong></p>
    <p class="form-error" role="alert"></p>
    <div class="dialog-actions">
      <button type="button" data-action="close">Cancel</button>
      <button type="submit" class="primary danger-fill">Bin it</button>
    </div>
  </form>`);
}

function updateThrowPreview(form) {
  const it = findItem(form.dataset.id);
  if (!it) return;
  const qty = Number(form.elements.qty.value) || 0;
  form.querySelector('[data-preview]').textContent = money(calc.moneyWasted({ ...it, quantity_wasted: qty }));
}

function openEdit(id) {
  const it = findItem(id);
  if (!it) return;
  state.pendingDelete = null;
  openSheet(`<form class="sheet-body" data-form="edit" data-id="${it.id}">
    <h2>${emojiFor(it.item_name)} Edit item</h2>
    ${itemFields(it, { withDate: true })}
    <fieldset>
      <legend>What happened to it</legend>
      <div class="grid2">
        <label>Status <select name="status">${options(pairs(store.STATUSES), it.status)}</select></label>
        <label>Amount thrown <input name="quantity_wasted" type="number" min="0" step="any" inputmode="decimal" value="${it.quantity_wasted || 0}"></label>
        <label>Found spoiled on <input type="date" name="spoiled_found_date" value="${it.spoiled_found_date ?? ''}" max="${today()}"></label>
        <label>Thrown on <input type="date" name="thrown_date" value="${it.thrown_date ?? ''}" max="${today()}"></label>
        <label>Used on <input type="date" name="used_date" value="${it.used_date ?? ''}" max="${today()}"></label>
      </div>
    </fieldset>
    <p class="form-error" role="alert"></p>
    <div class="dialog-actions">
      <button type="button" class="ghost danger" data-action="delete-item" data-id="${it.id}">Delete</button>
      <span class="spacer"></span>
      <button type="button" data-action="close">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>
  </form>`);
}

/** Keeps status, dates and wasted amount consistent with each other. */
function normalizeOutcome(v) {
  const t = today();
  const out = { ...v };
  switch (v.status) {
    case 'Fresh':
      Object.assign(out, { quantity_wasted: 0, spoiled_found_date: null, thrown_date: null, used_date: null });
      break;
    case 'Used':
      Object.assign(out, { quantity_wasted: 0, spoiled_found_date: null, thrown_date: null, used_date: v.used_date || t });
      break;
    case 'Spoiled':
      Object.assign(out, { quantity_wasted: 0, thrown_date: null, used_date: null, spoiled_found_date: v.spoiled_found_date || t });
      break;
    case 'Thrown': {
      const thrown = v.thrown_date || t;
      Object.assign(out, {
        quantity_wasted: v.quantity_wasted > 0 ? Math.min(v.quantity_wasted, v.quantity) : v.quantity,
        thrown_date: thrown,
        spoiled_found_date: v.spoiled_found_date || thrown,
        used_date: null,
      });
      break;
    }
  }
  return out;
}

function validateOutcome(v) {
  const dates = [v.spoiled_found_date, v.thrown_date, v.used_date].filter(Boolean);
  if (dates.some((d) => d < v.purchase_date)) return 'Dates can’t be before the purchase date.';
  if (dates.some((d) => d > today())) return 'Dates can’t be in the future.';
  if (v.spoiled_found_date && v.thrown_date && v.spoiled_found_date > v.thrown_date) return 'It can’t be thrown before it was found spoiled.';
  if (v.quantity_wasted > v.quantity) return 'Amount thrown can’t be more than the quantity bought.';
  return null;
}

// ---------- Add ----------
function chipsHtml() {
  const q = calc.norm(state.filter);
  const seen = new Set();
  const names = [];
  for (const n of [...calc.frequentNames(state.db.items).map((f) => f.name), ...PRESETS.map((p) => p.name)]) {
    const k = calc.norm(n);
    if (!seen.has(k)) { seen.add(k); names.push(n); }
  }
  const shown = names.filter((n) => !q || calc.norm(n).includes(q)).slice(0, 40);
  let html = shown
    .map((n) => `<button type="button" class="chip" data-action="pick" data-name="${esc(n)}"><span aria-hidden="true">${emojiFor(n)}</span> ${esc(n)}</button>`)
    .join('');
  if (q && !shown.some((n) => calc.norm(n) === q)) {
    html = `<button type="button" class="chip add" data-action="custom">＋ Add “${esc(state.filter.trim())}”</button>${html}`;
  }
  return html;
}

function startDraft(name) {
  name = String(name ?? '').trim().slice(0, 60);
  if (!name) return;
  const preset = findPreset(name);
  const last = calc.lastPurchase(state.db.items, name);
  state.draft = {
    item_name: last?.item_name ?? preset?.name ?? name,
    category: last?.category ?? preset?.category ?? 'Other',
    unit: last?.unit ?? preset?.unit ?? 'pcs',
    quantity: last?.quantity ?? 1,
    price: last?.price || '',
    last,
  };
  render();
  const qty = $('#view [name=quantity]');
  qty?.focus();
  qty?.select();
}

function viewAdd() {
  const t = today();
  const trip = state.db.items.filter((i) => i.purchase_date === state.tripDate);
  const d = state.draft;
  const body = d
    ? `<form class="card pad add-form" data-form="add">
        <h2 class="h3"><span aria-hidden="true">${emojiFor(d.item_name)}</span> Adding to your fridge</h2>
        ${itemFields(d)}
        ${d.last ? `<p class="hint">Last time: ${fmtQty(d.last.quantity)} ${esc(d.last.unit)}${d.last.price ? ` for ${money(d.last.price)}` : ''} on ${fmtDate(d.last.purchase_date)}</p>` : ''}
        <p class="form-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" data-action="cancel-draft">Cancel</button>
          <button type="submit" class="primary">Add to fridge</button>
        </div>
      </form>`
    : `<section class="picker">
        <input type="search" class="search" data-bind="filter" placeholder="Search or type a new item…" value="${esc(state.filter)}" aria-label="Search vegetables" autocomplete="off" enterkeyhint="go">
        <div id="chips" class="chips">${chipsHtml()}</div>
      </section>`;
  const total = trip.reduce((s, i) => s + i.price, 0);
  const tripHtml = trip.length
    ? `<section class="card pad">
        <h2 class="h3">On this trip</h2>
        <p class="muted small">${plural(trip.length, 'item')}${total ? ` · ${money(total)}` : ''}</p>
        <ul class="mini-list">${trip
          .map((i) => `<li><button type="button" class="linkish" data-action="edit" data-id="${i.id}"><span aria-hidden="true">${emojiFor(i.item_name)}</span> ${esc(i.item_name)} <span class="muted">· ${fmtQty(i.quantity)} ${esc(i.unit)}${i.price ? ` · ${money(i.price)}` : ''}</span></button></li>`)
          .join('')}</ul>
      </section>`
    : '';
  return `<section class="card pad">
      <label class="inline">🗓️ Shopping date <input type="date" data-bind="tripDate" value="${state.tripDate}" max="${t}"></label>
    </section>
    ${body}
    ${tripHtml}`;
}

// ---------- Stats ----------
function periodRange(period, t) {
  if (period === 'month') return { from: calc.monthStart(t), label: 'this month' };
  if (period === '3m') return { from: calc.monthStart(t, -2), label: 'in the last 3 months' };
  return { from: null, label: 'all time' };
}

function tile(label, value, note) {
  return `<div class="card tile"><div class="k">${label}</div><div class="v">${value}</div>${note ? `<div class="n">${note}</div>` : ''}</div>`;
}

const fmtDays = (d) => (d == null ? '–' : `${Number(d.toFixed(1))} d`);

function viewStats() {
  const t = today();
  const all = state.db.items;
  const seg = segmented('period', [['month', 'This month'], ['3m', '3 months'], ['all', 'All time']], state.period);
  if (!all.length) {
    return seg + emptyState('📊', 'No data yet',
      'Add your groceries and mark what gets used or thrown. Your waste report builds itself.', '#add', 'Add groceries');
  }
  const { from, label } = periodRange(state.period, t);
  const items = all.filter((i) => calc.inRange(i, from, t));
  const s = calc.summarize(items);
  const byMoney = all.some((i) => i.price > 0);
  const heroVal = byMoney ? s.moneyPct : s.qtyPct;
  const open = items.filter(calc.isOpen).length;

  let delta = '';
  if (state.period === 'month' && s.count) {
    const prevFrom = calc.monthStart(t, -1);
    const prev = calc.summarize(all.filter((i) => calc.inRange(i, prevFrom, calc.addDays(calc.monthStart(t), -1))));
    if (prev.count) {
      const d = Math.round((heroVal - (byMoney ? prev.moneyPct : prev.qtyPct)) * 100);
      delta = d === 0
        ? '<span class="delta neutral">Same as last month</span>'
        : d < 0
          ? `<span class="delta good">▼ ${-d} pts vs last month 🎉</span>`
          : `<span class="delta bad">▲ ${d} pts vs last month</span>`;
    }
  }

  const hero = s.count
    ? `<p class="eyebrow">Wasted ${label}</p>
       <p class="hero-num">${pct(heroVal)}</p>
       <p class="hero-sub">${byMoney ? `<strong>${money(s.wasted)}</strong> binned of ${money(s.spent)} spent` : 'of what you bought (add prices to see money)'}</p>
       ${delta}`
    : `<p class="eyebrow">Wasted ${label}</p><p class="hero-num">–</p><p class="hero-sub">No purchases logged ${label}.</p>`;

  const perYear = byMoney ? calc.yearlyProjection(all, t) : null;
  const trend = calc.monthlyTrend(all, t, 6);
  const trendRows = trend
    .map((m) => `<tr><td>${fmtMonth(m.month)}</td><td>${m.count ? pct(byMoney ? m.moneyPct : m.qtyPct) : '–'}</td><td>${byMoney ? money(m.wasted) : m.wastedLines}</td></tr>`)
    .join('');

  return `${seg}
    <section class="card pad hero">${hero}</section>
    <div class="tiles">
      ${tile('Wasted by quantity', pct(s.qtyPct), 'average share of each purchase')}
      ${tile('Items thrown', `${s.wastedLines} <small>of ${s.count}</small>`, open ? `${open} still in the fridge` : '')}
      ${tile('Until spoiled', fmtDays(s.avgDaysToSpoil), 'average days after buying')}
      ${tile('Spoiled → bin', fmtDays(s.avgBinDelay), 'days before it was thrown')}
    </div>
    ${perYear ? `<div class="banner bad">At the current rate, about <strong>${money(Math.round(perYear))}</strong> a year goes in the bin.</div>` : ''}
    <section class="card pad">
      <h2 class="h3">Waste by month</h2>
      <p class="muted small">${byMoney ? 'Share of money spent that was binned' : 'Share of what was bought that was binned'}</p>
      <div class="chart" id="trend-chart" data-money="${byMoney}"></div>
      <details><summary>Show as table</summary>
        <table><thead><tr><th>Month</th><th>Wasted</th><th>${byMoney ? 'Money' : 'Items'}</th></tr></thead><tbody>${trendRows}</tbody></table>
      </details>
    </section>
    <section class="card pad">
      <h2 class="h3">Most wasted ${label}</h2>
      ${topHtml(items, byMoney)}
    </section>`;
}

function topHtml(items, byMoney) {
  const top = calc.topWasted(items, 5);
  if (!top.length) return '<p class="muted">Nothing thrown away. 🎉</p>';
  const val = (r) => (byMoney ? r.money : r.times);
  const max = Math.max(...top.map(val));
  return `<ul class="hbars">${top
    .map((r) => {
      const w = max ? (val(r) / max) * 100 : 0;
      const tip = `${r.name}: thrown ${r.times}×${byMoney ? `, ${money(r.money)} lost` : ''}`;
      return `<li data-tip="${esc(tip)}" tabindex="0">
        <span class="hb-label"><span aria-hidden="true">${emojiFor(r.name)}</span> ${esc(r.name)}</span>
        <span class="hb-track"><span class="hb-bar" style="width:${w.toFixed(1)}%"></span></span>
        <span class="hb-val">${byMoney ? money(r.money) : `${r.times}×`}</span>
      </li>`;
    })
    .join('')}</ul>`;
}

function niceMax(v) {
  return [0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1].find((c) => c >= v - 1e-9) ?? 1;
}

function drawTrend() {
  const el = $('#trend-chart');
  if (!el) return;
  const byMoney = el.dataset.money === 'true';
  const rows = calc.monthlyTrend(state.db.items, today(), 6).map((m) => {
    const value = m.count ? (byMoney ? m.moneyPct : m.qtyPct) : null;
    const tip = m.count
      ? `${fmtMonth(m.month)}: ${pct(value)} wasted${byMoney ? ` (${money(m.wasted)} of ${money(m.spent)})` : ''}`
      : `${fmtMonth(m.month)}: nothing logged`;
    return { label: fmtMonth(m.month), value, tip };
  });
  const W = Math.max(260, Math.floor(el.clientWidth));
  const H = 180, pl = 38, pr = 6, pt = 18, pb = 24;
  const maxV = niceMax(Math.max(0.1, ...rows.map((r) => r.value ?? 0)));
  const ih = H - pt - pb, iw = W - pl - pr;
  const band = iw / rows.length, bw = Math.min(24, band * 0.6);
  const base = pt + ih;
  const y = (v) => pt + ih - (v / maxV) * ih;
  const grid = [0, maxV / 2, maxV]
    .map((v) => `<line class="${v ? 'grid' : 'axis'}" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${pct(v)}</text>`)
    .join('');
  const lastIdx = rows.length - 1;
  const bars = rows
    .map((r, i) => {
      const cx = pl + band * i + band / 2;
      let mark = '';
      if (r.value > 0) {
        const top = y(r.value), x = cx - bw / 2, rr = Math.min(4, base - top, bw / 2);
        mark = `<path class="bar" d="M${x},${base} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${base} Z"/>`;
        if (i === lastIdx) mark += `<text class="val" x="${cx}" y="${top - 6}" text-anchor="middle">${pct(r.value)}</text>`;
      }
      return `${mark}<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text>
        <rect class="hit" x="${pl + band * i}" y="${pt}" width="${band}" height="${ih}" data-tip="${esc(r.tip)}" tabindex="0"/>`;
    })
    .join('');
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Waste percentage for the last 6 months">${grid}${bars}</svg>`;
}

// ---------- Shopping list ----------
const listKey = (name) => `k:${calc.norm(name)}`;

function listRows() {
  const L = state.db.list;
  return calc.shoppingSuggestions(state.db.items, today(), LIST_WEEKS).map((r) => {
    const ov = L.overrides[listKey(r.name)] ?? {};
    return { ...r, qty: ov.qty ?? r.suggestedNet, on: ov.on ?? r.suggestedNet > 0 };
  });
}

function listRow(r) {
  const notes = [`usually ${fmtQty(r.avgQty)} ${r.unit}`];
  if (!r.hasOutcomes) notes.push('no results yet');
  else if (r.wasteRate > 0) notes.push(`${pct(r.wasteRate)} binned`);
  else notes.push('all eaten 👍');
  if (r.inFridge) notes.push(`${fmtQty(r.inFridge)} ${r.unit} still in fridge`);
  if (r.savePerTrip >= 0.01) notes.push(`saves ~${money(r.savePerTrip)}`);
  const k = esc(listKey(r.name));
  return `<li class="list-row${r.on ? '' : ' off'}">
    <label class="check"><input type="checkbox" data-change="list-toggle" data-key="${k}"${r.on ? ' checked' : ''}>
      <span><span aria-hidden="true">${emojiFor(r.name)}</span> <strong>${esc(r.name)}</strong></span></label>
    <div class="stepper">
      <button type="button" data-action="list-step" data-key="${k}" data-d="-1" aria-label="Less ${esc(r.name)}">−</button>
      <span>${fmtQty(r.qty)} ${esc(r.unit)}</span>
      <button type="button" data-action="list-step" data-key="${k}" data-d="1" aria-label="More ${esc(r.name)}">+</button>
    </div>
    <p class="sub">${notes.join(' · ')}</p>
  </li>`;
}

function viewList() {
  const rows = listRows();
  const manual = state.db.list.manual;
  const buy = rows.filter((r) => r.suggestedNet > 0);
  const skip = rows.filter((r) => r.suggestedNet === 0);
  const save = rows.reduce((s, r) => s + r.savePerTrip, 0);
  const manualHtml = manual
    .map((m, i) => `<li class="list-row${m.on ? '' : ' off'}">
      <label class="check"><input type="checkbox" data-change="manual-toggle" data-i="${i}"${m.on ? ' checked' : ''}>
        <span><span aria-hidden="true">${emojiFor(m.name)}</span> <strong>${esc(m.name)}</strong></span></label>
      <button type="button" class="icon-btn" data-action="manual-remove" data-i="${i}" aria-label="Remove ${esc(m.name)}">✕</button>
    </li>`)
    .join('');
  const intro = rows.length
    ? `<p class="muted intro">Based on what you bought in the last ${LIST_WEEKS} weeks, minus what got binned and what’s still in the fridge.</p>`
    : '<p class="muted intro">Your list fills in automatically once you’ve logged a few shopping trips. You can add items by hand in the meantime.</p>';
  return `${intro}
    ${save >= 1 ? `<div class="banner good">Buying these amounts saves about <strong>${money(Math.round(save))}</strong> per trip.</div>` : ''}
    <section class="card">
      <ul class="list">${buy.map(listRow).join('')}${manualHtml}</ul>
      <form class="manual-add" data-form="manual">
        <input name="name" placeholder="Add something else…" maxlength="60" aria-label="Add item to list" autocomplete="off">
        <button type="submit" class="primary">Add</button>
      </form>
    </section>
    ${skip.length ? `<section class="card"><h2 class="h3 pad-x">Skip this time</h2><ul class="list">${skip.map(listRow).join('')}</ul></section>` : ''}
    <div class="actions-row">
      <button type="button" class="primary" data-action="list-share">📤 Share list</button>
      <button type="button" data-action="list-copy">Copy</button>
      <button type="button" class="ghost" data-action="list-reset">Reset</button>
    </div>`;
}

function listText() {
  const lines = [
    ...listRows().filter((r) => r.on && r.qty > 0).map((r) => `• ${r.name} - ${fmtQty(r.qty)} ${r.unit}`),
    ...state.db.list.manual.filter((m) => m.on).map((m) => `• ${m.name}`),
  ];
  return lines.length ? `🛒 Shopping list\n${lines.join('\n')}\n\nMade with FridgeWise` : '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------- Settings ----------
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function viewMore() {
  const st = state.db.settings;
  const n = state.db.items.length;
  const hasDemo = state.db.items.some((i) => i.demo);
  let install = '';
  if (native.isNative) {
    const hours = [7, 8, 9, 12, 17, 18, 19, 20].map((h) => [String(h), new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })]);
    install = `<section class="card pad"><h2 class="h3">Reminders</h2>
      <p class="muted small">A notification on the day vegetables need cooking, so they don’t end up in the bin.</p>
      <div class="grid2">
        <label>Reminders <select data-setting="reminders">${options([['true', 'On'], ['false', 'Off']], String(st.reminders))}</select></label>
        <label>Time <select data-setting="reminderHour"${st.reminders ? '' : ' disabled'}>${options(hours, String(st.reminderHour))}</select></label>
      </div></section>`;
  } else if (state.installEvent) {
    install = `<section class="card pad"><h2 class="h3">Install the app</h2>
      <p class="muted small">Adds FridgeWise to your home screen. It works offline.</p>
      <button type="button" class="primary" data-action="install">📲 Install FridgeWise</button></section>`;
  } else if (isIOS() && !isStandalone()) {
    install = `<section class="card pad"><h2 class="h3">Install the app</h2>
      <p class="muted small">In Safari, tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.</p></section>`;
  }
  return `<section class="card pad">
      <h2 class="h3">Preferences</h2>
      <div class="grid2">
        <label>Currency <select data-setting="currency">${options(store.CURRENCIES, st.currency)}</select></label>
        <label>Theme <select data-setting="theme">${options([['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']], st.theme)}</select></label>
      </div>
    </section>
    ${install}
    <section class="card pad">
      <h2 class="h3">Your data</h2>
      <p class="muted small">${plural(n, 'item')} saved on this device only.${store.isPersistent() ? '' : ' <strong class="bad-text">Storage is blocked in this browser, so data will be lost when you close it.</strong>'}</p>
      <div class="btn-grid">
        <button type="button" data-action="export-csv">⬇️ Export spreadsheet (CSV)</button>
        <button type="button" data-action="export-json">💾 Save a backup</button>
        <button type="button" data-action="restore">♻️ Restore a backup</button>
        <input type="file" id="restore-file" accept="application/json,.json" hidden>
        ${hasDemo
          ? '<button type="button" data-action="demo-remove">🧹 Remove sample data</button>'
          : '<button type="button" data-action="demo-add">🧪 Try it with sample data</button>'}
        <button type="button" class="danger" data-action="wipe">🗑️ Delete all data</button>
      </div>
    </section>
    <section class="card pad about">
      <h2 class="h3">About</h2>
      <p class="small">FridgeWise ${APP_VERSION} works offline and needs no account. Nothing is tracked, and your data stays on this phone unless you export it.</p>
      <p class="muted small">Shelf-life estimates start from typical fridge times and adjust to your own fridge once you’ve logged a couple of spoiled items.</p>
    </section>`;
}

async function download(filename, text, type) {
  if (native.isNative) {
    try {
      await native.shareFile(filename, text);
    } catch {
      toast('Couldn’t create the file.');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme() {
  const t = state.db.settings.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- actions ----------
const ACTIONS = {
  seg: (el) => { state[el.dataset.key] = el.dataset.value; render(); },
  used: (el) => setOutcome(el.dataset.id, (it) => {
    Object.assign(it, { status: 'Used', used_date: today(), quantity_wasted: 0, spoiled_found_date: null, thrown_date: null });
  }, 'Marked as used 👍'),
  spoiled: (el) => setOutcome(el.dataset.id, (it) => {
    Object.assign(it, { status: 'Spoiled', spoiled_found_date: today() });
  }, 'Marked as spoiled. Bin it when you throw it out.'),
  thrown: (el) => openThrow(el.dataset.id),
  edit: (el) => openEdit(el.dataset.id),
  close: () => closeSheet(),
  'set-qty': (el) => {
    const f = el.closest('form');
    f.elements.qty.value = el.dataset.v;
    updateThrowPreview(f);
  },
  'delete-item': (el) => {
    const id = el.dataset.id;
    if (state.pendingDelete !== id) {
      state.pendingDelete = id;
      el.textContent = 'Tap again to delete';
      return;
    }
    const idx = state.db.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const [removed] = state.db.items.splice(idx, 1);
    save();
    closeSheet();
    render();
    toast(`Deleted ${removed.item_name}`, { label: 'Undo', fn: () => { state.db.items.splice(idx, 0, removed); save(); render(); } });
  },
  pick: (el) => startDraft(el.dataset.name),
  custom: () => startDraft(state.filter),
  'cancel-draft': () => { state.draft = null; render(); },
  'list-step': (el) => {
    const row = listRows().find((r) => listKey(r.name) === el.dataset.key);
    if (!row) return;
    const step = calc.unitStep(row.unit);
    const qty = Math.max(0, calc.roundToStep(row.qty + step * Number(el.dataset.d), step));
    state.db.list.overrides[el.dataset.key] = { ...state.db.list.overrides[el.dataset.key], qty, on: qty > 0 };
    save();
    render();
  },
  'manual-remove': (el) => { state.db.list.manual.splice(Number(el.dataset.i), 1); save(); render(); },
  'list-share': async () => {
    const text = listText();
    if (!text) return toast('Your list is empty.');
    if (await native.shareText('Shopping list', text)) return;
    if (navigator.share) {
      try { await navigator.share({ title: 'Shopping list', text }); } catch { /* user cancelled */ }
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  },
  'list-copy': async () => {
    const text = listText();
    if (!text) return toast('Your list is empty.');
    toast((await copyText(text)) ? 'List copied' : 'Couldn’t copy. Try Share instead.');
  },
  'list-reset': () => {
    const before = structuredClone(state.db.list);
    state.db.list = { overrides: {}, manual: [] };
    save();
    render();
    toast('List reset to suggestions', { label: 'Undo', fn: () => { state.db.list = before; save(); render(); } });
  },
  install: async () => {
    const ev = state.installEvent;
    if (!ev) return;
    ev.prompt();
    await ev.userChoice.catch(() => null);
    state.installEvent = null;
    render();
  },
  'export-csv': () => {
    if (!state.db.items.length) return toast('Nothing to export yet.');
    download(`fridgewise-${today()}.csv`, store.toCSV(state.db.items), 'text/csv;charset=utf-8');
  },
  'export-json': () => download(`fridgewise-backup-${today()}.json`, store.toBackup(state.db), 'application/json'),
  restore: () => $('#restore-file')?.click(),
  'demo-add': () => {
    state.db.items.push(...generateDemo(today(), state.db.settings.currency));
    save();
    toast('Sample data added. Remove it any time in Settings.');
    location.hash = '#stats';
  },
  'demo-remove': () => {
    state.db.items = state.db.items.filter((i) => !i.demo);
    save();
    render();
    toast('Sample data removed');
  },
  wipe: () => openSheet(`<div class="sheet-body">
      <h2>Delete everything?</h2>
      <p>This removes all ${plural(state.db.items.length, 'item')} and your shopping list from this device. You can’t undo it, so save a backup first if you might want the data later.</p>
      <div class="dialog-actions">
        <button type="button" data-action="close" autofocus>Cancel</button>
        <button type="button" class="primary danger-fill" data-action="wipe-confirm">Delete all</button>
      </div></div>`),
  'wipe-confirm': () => {
    const { settings } = state.db;
    state.db = { ...store.emptyDB(), settings };
    save();
    closeSheet();
    render();
    toast('All data deleted');
  },
};

const FORMS = {
  add(form) {
    const v = readItemFields(form);
    delete v.purchase_date;
    const err = validateItem(v);
    if (err) return showError(form, err);
    const it = store.makeItem({ ...v, purchase_date: state.tripDate });
    state.db.items.push(it);
    save();
    state.draft = null;
    state.filter = '';
    render();
    navigator.storage?.persist?.().catch(() => {});
    if (native.isNative && state.db.settings.reminders) native.notificationsAllowed(true).then(queueReminders);
    toast(`Added ${it.item_name}`, {
      label: 'Undo',
      fn: () => { state.db.items = state.db.items.filter((i) => i.id !== it.id); save(); render(); },
    });
  },
  edit(form) {
    const it = findItem(form.dataset.id);
    if (!it) return closeSheet();
    const f = form.elements;
    const base = readItemFields(form);
    const err = validateItem(base);
    if (err) return showError(form, err);
    const v = normalizeOutcome({
      ...base,
      status: f.status.value,
      quantity_wasted: Number(f.quantity_wasted.value) || 0,
      spoiled_found_date: f.spoiled_found_date.value || null,
      thrown_date: f.thrown_date.value || null,
      used_date: f.used_date.value || null,
    });
    const err2 = validateOutcome(v);
    if (err2) return showError(form, err2);
    Object.assign(it, v);
    save();
    closeSheet();
    render();
    toast('Saved');
  },
  throw(form) {
    const it = findItem(form.dataset.id);
    if (!it) return closeSheet();
    const f = form.elements;
    const qty = Number(f.qty.value);
    const date = f.date.value || today();
    const spoiled = f.spoiled?.value || it.spoiled_found_date || date;
    if (!(qty >= 0) || qty > it.quantity) return showError(form, `Enter an amount between 0 and ${fmtQty(it.quantity)}.`);
    if (date < it.purchase_date || date > today()) return showError(form, 'Pick a date between the purchase date and today.');
    if (spoiled > date) return showError(form, 'It can’t be thrown before it was found spoiled.');
    closeSheet();
    if (qty === 0) {
      return setOutcome(it.id, (x) => Object.assign(x, { status: 'Used', used_date: date, quantity_wasted: 0, spoiled_found_date: null }), 'Nothing binned, so it’s marked as used 👍');
    }
    setOutcome(it.id, (x) => Object.assign(x, {
      status: 'Thrown',
      quantity_wasted: qty,
      thrown_date: date,
      spoiled_found_date: spoiled < x.purchase_date ? x.purchase_date : spoiled,
      used_date: null,
    }), `Binned: ${money(calc.moneyWasted({ ...it, quantity_wasted: qty }))} wasted`);
  },
  manual(form) {
    const name = form.elements.name.value.trim().slice(0, 60);
    if (!name) return;
    state.db.list.manual.push({ name, on: true });
    save();
    render();
    $('#view [data-form=manual] input')?.focus();
  },
};

// ---------- tooltip ----------
const tipEl = () => $('#tooltip');
function placeTip(x, y) {
  const tip = tipEl();
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
  tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
}
function showTip(el, x, y) {
  const tip = tipEl();
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  placeTip(x, y);
}
const hideTip = () => { tipEl().hidden = true; };

// ---------- render & wiring ----------
const VIEWS = { fridge: viewFridge, add: viewAdd, stats: viewStats, list: viewList, more: viewMore };

function render() {
  const tab = state.tab;
  document.title = `${TITLES[tab]} · FridgeWise`;
  $('#title').textContent = TITLES[tab];
  const urgent = fridgeEntries().filter((e) => e.f.level !== 'fresh').length;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const badge = $('#fridge-badge');
  badge.textContent = urgent || '';
  badge.hidden = !urgent;
  hideTip();
  $('#view').innerHTML = VIEWS[tab]();
  if (tab === 'stats') drawTrend();
  try {
    if (urgent) navigator.setAppBadge?.(urgent)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* unsupported */ }
}

function tabFromHash() {
  const t = location.hash.slice(1);
  return Object.hasOwn(VIEWS, t) ? t : 'fridge';
}

async function init() {
  state.db = store.loadDB(await native.getStored(store.KEY));
  if (native.isNative) {
    store.setMirror(native.setStored);
    native.onReminderTap(() => { location.hash = '#fridge'; });
    document.documentElement.classList.add('native', `native-${native.platform}`);
  }
  applyTheme();
  state.tab = tabFromHash();
  render();

  window.addEventListener('hashchange', () => {
    state.tab = tabFromHash();
    closeSheet();
    render();
    window.scrollTo(0, 0);
    $('#view').focus({ preventScroll: true });
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el, e);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    FORMS[form.dataset.form]?.(form);
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.bind === 'filter') {
      state.filter = el.value;
      $('#chips').innerHTML = chipsHtml();
    }
    if (el.form?.dataset.form === 'throw' && el.name === 'qty') updateThrowPreview(el.form);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset?.bind === 'filter') {
      e.preventDefault();
      $('#chips .chip')?.click();
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.bind === 'tripDate') {
      state.tripDate = el.value && el.value <= today() ? el.value : today();
      render();
    } else if (el.dataset.setting) {
      const key = el.dataset.setting;
      state.db.settings[key] = key === 'reminders' ? el.value === 'true' : key === 'reminderHour' ? Number(el.value) : el.value;
      if (key === 'reminders' && state.db.settings.reminders && !(await native.notificationsAllowed(true))) {
        toast('Notifications are off for FridgeWise. Turn them on in your phone’s Settings.');
      }
      save();
      applyTheme();
      render();
    } else if (el.dataset.change === 'list-toggle') {
      const k = el.dataset.key;
      state.db.list.overrides[k] = { ...state.db.list.overrides[k], on: el.checked };
      save();
      render();
    } else if (el.dataset.change === 'manual-toggle') {
      const m = state.db.list.manual[Number(el.dataset.i)];
      if (m) m.on = el.checked;
      save();
      render();
    } else if (el.id === 'restore-file' && el.files?.[0]) {
      try {
        const backup = store.parseBackup(await el.files[0].text());
        const merged = store.mergeItems(state.db.items, backup.items);
        state.db.items = merged.items;
        save();
        render();
        toast(`Restored: ${merged.added} new, ${merged.updated} updated`);
      } catch (err) {
        toast(err.message);
      }
      el.value = '';
    }
  });

  const d = sheet();
  d.addEventListener('click', (e) => { if (e.target === d) closeSheet(); });
  d.addEventListener('close', () => { state.pendingDelete = null; });

  // Tooltips: hover on desktop, tap on touch, focus for keyboard.
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', (e) => {
    if (!tipEl().hidden && e.target.closest?.('[data-tip]')) placeTip(e.clientX, e.clientY);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'touch' && e.target.closest?.('[data-tip]')) hideTip();
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('[data-tip]')) hideTip(); });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', (e) => { if (e.target.closest?.('[data-tip]')) hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.tab === 'stats' && drawTrend(), 150);
  });

  // Freshness depends on today's date, so refresh when the app comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!sheet().open && !state.draft) render();
    queueReminders();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    if (state.tab === 'more') render();
  });
  window.addEventListener('appinstalled', () => { state.installEvent = null; });

  queueReminders();

  // The native app ships its files inside the package, so it needs no service worker.
  if (!native.isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('FridgeWise was updated', { label: 'Reload', fn: () => location.reload() });
      hadController = true;
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
