// Local, on-device persistence (localStorage) plus import/export.
// Field names match the plan's spreadsheet columns so CSV exports line up.
import { CATEGORIES, UNITS } from './veggies.js';
import { moneyWasted, daysBetween } from './calc.js';

export const KEY = 'fridgewise.v1';
export const STATUSES = ['Fresh', 'Spoiled', 'Thrown', 'Used'];
export const THEMES = ['system', 'light', 'dark'];

export const CURRENCIES = [
  ['INR', 'Indian rupee (₹)'],
  ['EUR', 'Euro (€)'],
  ['USD', 'US dollar ($)'],
  ['GBP', 'British pound (£)'],
  ['AED', 'UAE dirham'],
  ['SAR', 'Saudi riyal'],
  ['SGD', 'Singapore dollar'],
  ['MYR', 'Malaysian ringgit'],
  ['LKR', 'Sri Lankan rupee'],
  ['AUD', 'Australian dollar'],
  ['NZD', 'New Zealand dollar'],
  ['CAD', 'Canadian dollar'],
  ['CHF', 'Swiss franc'],
  ['JPY', 'Japanese yen (¥)'],
  ['ZAR', 'South African rand'],
];

const EURO_REGIONS = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const REGION_CURRENCY = {
  IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', SA: 'SAR', SG: 'SGD', MY: 'MYR', LK: 'LKR',
  AU: 'AUD', NZ: 'NZD', CA: 'CAD', CH: 'CHF', JP: 'JPY', ZA: 'ZAR',
};

export function defaultCurrency(lang = globalThis.navigator?.language ?? '') {
  const region = String(lang).split('-')[1]?.toUpperCase();
  if (EURO_REGIONS.includes(region)) return 'EUR';
  return REGION_CURRENCY[region] ?? 'USD';
}

let persistent = true;
let mirror = null;
export const isPersistent = () => persistent || Boolean(mirror);

/** Also write every save to a durable native store (see native.js). */
export function setMirror(fn) {
  mirror = fn;
}

export function emptyDB(lang) {
  return {
    version: 1,
    items: [],
    settings: { currency: defaultCurrency(lang), theme: 'system', reminders: true, reminderHour: 18 },
    list: { overrides: {}, manual: [] },
  };
}

export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v) => (typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const nonNeg = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** Coerces untrusted input (storage, backups) into a valid item, or null. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item_name = String(raw.item_name ?? '').trim().slice(0, 60);
  const purchase_date = dateOrNull(raw.purchase_date);
  if (!item_name || !purchase_date) return null;
  const quantity = nonNeg(raw.quantity, 1) || 1;
  const item = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : newId(),
    item_name,
    category: Object.hasOwn(CATEGORIES, raw.category) ? raw.category : 'Other',
    quantity,
    unit: UNITS.includes(raw.unit) ? raw.unit : 'pcs',
    price: nonNeg(raw.price, 0),
    purchase_date,
    spoiled_found_date: dateOrNull(raw.spoiled_found_date),
    thrown_date: dateOrNull(raw.thrown_date),
    used_date: dateOrNull(raw.used_date),
    quantity_wasted: Math.min(nonNeg(raw.quantity_wasted, 0), quantity),
    status: STATUSES.includes(raw.status) ? raw.status : 'Fresh',
    added_by: typeof raw.added_by === 'string' ? raw.added_by.slice(0, 40) : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at.slice(0, 40) : new Date().toISOString(),
  };
  if (raw.demo === true) item.demo = true;
  return item;
}

export function makeItem(fields) {
  return normalizeItem({
    status: 'Fresh',
    quantity_wasted: 0,
    ...fields,
    id: newId(),
    created_at: new Date().toISOString(),
  });
}

export function coerceDB(obj, lang) {
  const db = emptyDB(lang);
  if (!obj || typeof obj !== 'object') return db;
  if (Array.isArray(obj.items)) db.items = obj.items.map(normalizeItem).filter(Boolean);
  const s = obj.settings ?? {};
  if (typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency)) db.settings.currency = s.currency;
  if (THEMES.includes(s.theme)) db.settings.theme = s.theme;
  if (typeof s.reminders === 'boolean') db.settings.reminders = s.reminders;
  if (Number.isInteger(s.reminderHour) && s.reminderHour >= 0 && s.reminderHour <= 23) db.settings.reminderHour = s.reminderHour;
  const l = obj.list ?? {};
  if (l.overrides && typeof l.overrides === 'object' && !Array.isArray(l.overrides)) {
    for (const [k, v] of Object.entries(l.overrides)) {
      if (!k.startsWith('k:') || !v || typeof v !== 'object') continue;
      const o = {};
      if (typeof v.on === 'boolean') o.on = v.on;
      if (Number.isFinite(v.qty) && v.qty >= 0) o.qty = v.qty;
      db.list.overrides[k] = o;
    }
  }
  if (Array.isArray(l.manual)) {
    db.list.manual = l.manual
      .filter((m) => m && typeof m.name === 'string' && m.name.trim())
      .map((m) => ({ name: m.name.trim().slice(0, 60), on: m.on !== false }));
  }
  return db;
}

/** `nativeRaw` (from the native store) wins over WebView localStorage when present. */
export function loadDB(nativeRaw = null) {
  let raw = nativeRaw;
  try {
    raw ??= localStorage.getItem(KEY);
  } catch {
    persistent = false;
  }
  if (!raw) return emptyDB();
  try {
    return coerceDB(JSON.parse(raw));
  } catch {
    // Keep the unreadable copy so it can be recovered instead of silently overwritten.
    try { localStorage.setItem(`${KEY}.corrupt-${Date.now()}`, raw); } catch { /* ignore */ }
    return emptyDB();
  }
}

export function saveDB(db) {
  const json = JSON.stringify(db);
  mirror?.(KEY, json);
  try {
    localStorage.setItem(KEY, json);
    persistent = true;
    return true;
  } catch {
    persistent = false;
    return Boolean(mirror);
  }
}

// ---------- import / export ----------
export function toBackup(db) {
  return JSON.stringify({ app: 'fridgewise', exported_at: new Date().toISOString(), ...db }, null, 2);
}

export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('That file is not a FridgeWise backup.');
  }
  if (!obj || obj.app !== 'fridgewise' || !Array.isArray(obj.items)) {
    throw new Error('That file is not a FridgeWise backup.');
  }
  return coerceDB(obj);
}

export function mergeItems(existing, incoming) {
  const map = new Map(existing.map((i) => [i.id, i]));
  let added = 0;
  let updated = 0;
  for (const it of incoming) {
    if (map.has(it.id)) updated++;
    else added++;
    map.set(it.id, it);
  }
  return { items: [...map.values()], added, updated };
}

const CSV_COLUMNS = [
  'item_name', 'category', 'quantity', 'unit', 'price', 'purchase_date', 'spoiled_found_date',
  'thrown_date', 'used_date', 'quantity_wasted', 'status', 'money_wasted', 'days_to_spoil',
];

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Stop spreadsheet apps from executing user-typed text as a formula.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(items) {
  const rows = [...items]
    .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))
    .map((it) => {
      const row = {
        ...it,
        money_wasted: moneyWasted(it).toFixed(2),
        days_to_spoil: daysBetween(it.purchase_date, it.spoiled_found_date),
      };
      return CSV_COLUMNS.map((c) => csvCell(row[c])).join(',');
    });
  return `﻿${CSV_COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}
