// Pure calculations: no DOM, no storage. Everything here is unit-tested.
// Dates are ISO "YYYY-MM-DD" strings in the user's local calendar.
import { defaultShelfDays } from './veggies.js';

const DAY_MS = 86_400_000;

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- dates ----------
export function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const utc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  return Math.round((utc(toISO) - utc(fromISO)) / DAY_MS);
}

export function addDays(iso, n) {
  return new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the month `offset` months away from the month containing `iso`. */
export function monthStart(iso, offset = 0) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10);
}

// ---------- single item ----------
export const isOpen = (it) => it.status === 'Fresh' || it.status === 'Spoiled';
export const isWasted = (it) => (Number(it.quantity_wasted) || 0) > 0;

export function wastedFraction(it) {
  const q = Number(it.quantity) || 0;
  if (q <= 0) return 0;
  return Math.min(Math.max(Number(it.quantity_wasted) || 0, 0), q) / q;
}

export const moneyWasted = (it) => (Number(it.price) || 0) * wastedFraction(it);

export const lastDate = (it) => it.thrown_date || it.used_date || it.spoiled_found_date || it.purchase_date;

export const inRange = (it, from, to) =>
  (!from || it.purchase_date >= from) && (!to || it.purchase_date <= to);

// ---------- totals ----------
/**
 * Waste by money   = Σ money wasted / Σ money spent
 * Waste by quantity = average share of each purchase that was binned
 *   (unit-free, so 1 kg tomatoes and 3 cucumbers can be combined).
 * Items still in the fridge count as bought; their outcome is not known yet.
 */
export function summarize(items) {
  const count = items.length;
  const spent = sum(items.map((i) => i.price));
  const wasted = sum(items.map(moneyWasted));
  const spoilDays = items
    .map((i) => daysBetween(i.purchase_date, i.spoiled_found_date))
    .filter((n) => n != null && n >= 0);
  const binDelays = items
    .map((i) => daysBetween(i.spoiled_found_date, i.thrown_date))
    .filter((n) => n != null && n >= 0);
  return {
    count,
    spent,
    wasted,
    wastedLines: items.filter(isWasted).length,
    moneyPct: spent > 0 ? wasted / spent : 0,
    qtyPct: count ? sum(items.map(wastedFraction)) / count : 0,
    avgDaysToSpoil: mean(spoilDays),
    avgBinDelay: mean(binDelays),
  };
}

export function monthlyTrend(items, today, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = monthStart(today, -i).slice(0, 7);
    out.push({ month, ...summarize(items.filter((it) => it.purchase_date.startsWith(month))) });
  }
  return out;
}

export function topWasted(items, limit = 5) {
  const groups = new Map();
  for (const it of items) {
    if (!isWasted(it)) continue;
    const k = norm(it.item_name);
    const g = groups.get(k) ?? { name: it.item_name, money: 0, times: 0 };
    g.money += moneyWasted(it);
    g.times += 1;
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.money - a.money || b.times - a.times || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Money binned per year at the pace of the last 90 days (null if nothing wasted). */
export function yearlyProjection(items, today) {
  const recent = items.filter((i) => inRange(i, addDays(today, -90), today));
  const wasted = sum(recent.map(moneyWasted));
  if (!wasted) return null;
  const earliest = recent.reduce((m, i) => (i.purchase_date < m ? i.purchase_date : m), today);
  const span = Math.max(30, daysBetween(earliest, today) + 1);
  return (wasted / span) * 365;
}

// ---------- freshness ----------
/** Median observed days-to-spoil per item name, once there are at least 2 samples. */
export function learnedShelfLives(items) {
  const samples = new Map();
  for (const it of items) {
    const d = daysBetween(it.purchase_date, it.spoiled_found_date);
    if (d == null || d < 0) continue;
    const k = norm(it.item_name);
    samples.set(k, [...(samples.get(k) ?? []), d]);
  }
  const out = new Map();
  for (const [k, xs] of samples) if (xs.length >= 2) out.set(k, Math.max(1, Math.round(median(xs))));
  return out;
}

export function shelfDays(it, learned = new Map()) {
  return learned.get(norm(it.item_name)) ?? defaultShelfDays(it.item_name, it.category);
}

/** fresh < 60% of shelf life ≤ soon < 100% ≤ overdue; Spoiled status wins. */
export function freshness(it, today, days) {
  const age = Math.max(0, daysBetween(it.purchase_date, today));
  const base = { age, days, left: days - age };
  if (it.status === 'Spoiled') return { ...base, level: 'spoiled' };
  const r = age / days;
  return { ...base, level: r >= 1 ? 'overdue' : r >= 0.6 ? 'soon' : 'fresh' };
}

/**
 * Reminder days for the next `days` days: each fresh item is announced on the
 * day it turns "use soon" (60% of shelf life), or today if that day has passed.
 */
export function reminderPlan(items, today, days = 14) {
  const learned = learnedShelfLives(items);
  const byDate = new Map();
  for (const it of items) {
    if (it.status !== 'Fresh') continue;
    let due = addDays(it.purchase_date, Math.ceil(shelfDays(it, learned) * 0.6));
    if (due < today) due = today;
    if (daysBetween(today, due) >= days) continue;
    const names = byDate.get(due) ?? [];
    if (!names.includes(it.item_name)) names.push(it.item_name);
    byDate.set(due, names);
  }
  return [...byDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, names]) => ({ date, names }));
}

// ---------- shopping list ----------
export function unitStep(unit) {
  if (unit === 'kg') return 0.25;
  if (unit === 'g') return 50;
  return 1;
}

export function roundToStep(x, step) {
  return Number((Math.round(x / step) * step).toFixed(2));
}

export function frequentNames(items) {
  const counts = new Map();
  for (const it of items) {
    const k = norm(it.item_name);
    const c = counts.get(k) ?? { name: it.item_name, count: 0 };
    c.count += 1;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function lastPurchase(items, name) {
  const k = norm(name);
  let best = null;
  for (const it of items) {
    if (norm(it.item_name) !== k) continue;
    if (!best || it.purchase_date > best.purchase_date ||
        (it.purchase_date === best.purchase_date && (it.created_at ?? '') > (best.created_at ?? ''))) best = it;
  }
  return best;
}

/**
 * Suggested qty = typical qty bought × (1 − waste rate), rounded to a sensible step,
 * then minus what is still fresh in the fridge. Waste rate only counts finished
 * purchases (Used/Thrown) in the most recent unit.
 */
export function shoppingSuggestions(items, today, weeks = 8) {
  const from = addDays(today, -weeks * 7);
  const groups = new Map();
  const fresh = new Map(); // `${name}|${unit}` -> qty still fresh
  for (const it of items) {
    const k = norm(it.item_name);
    if (it.status === 'Fresh') fresh.set(`${k}|${it.unit}`, (fresh.get(`${k}|${it.unit}`) ?? 0) + it.quantity);
    if (it.purchase_date < from || it.purchase_date > today) continue;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }

  const out = [];
  for (const [key, lines] of groups) {
    lines.sort((a, b) => a.purchase_date.localeCompare(b.purchase_date));
    const latest = lines[lines.length - 1];
    const unit = latest.unit;
    const same = lines.filter((l) => l.unit === unit);
    const avgQty = mean(same.map((l) => l.quantity));
    const resolved = same.filter((l) => l.status === 'Used' || l.status === 'Thrown');
    const resolvedQty = sum(resolved.map((l) => l.quantity));
    const wasteRate = resolvedQty ? sum(resolved.map((l) => wastedFraction(l) * l.quantity)) / resolvedQty : 0;
    const step = unitStep(unit);
    let suggested = roundToStep(avgQty * (1 - wasteRate), step);
    if (suggested <= 0 && wasteRate < 1) suggested = step;
    const inFridge = fresh.get(`${key}|${unit}`) ?? 0;
    const suggestedNet = Math.max(0, roundToStep(suggested - inFridge, step));
    const qtyBought = sum(same.map((l) => l.quantity));
    const unitPrice = qtyBought ? sum(same.map((l) => l.price)) / qtyBought : 0;
    out.push({
      key,
      name: latest.item_name,
      category: latest.category,
      unit,
      avgQty,
      wasteRate,
      suggested,
      suggestedNet,
      inFridge,
      savePerTrip: Math.max(0, avgQty - suggested) * unitPrice,
      trips: same.length,
      hasOutcomes: resolved.length > 0,
    });
  }
  return out.sort(
    (a, b) => (b.suggestedNet > 0) - (a.suggestedNet > 0) || b.trips - a.trips || a.name.localeCompare(b.name),
  );
}
