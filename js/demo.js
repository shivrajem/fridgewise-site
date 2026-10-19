// Sample data so a new user can see what the reports look like before
// logging their own groceries. Deterministic (seeded) so screenshots are stable.
import { makeItem } from './store.js';
import { addDays, daysBetween } from './calc.js';
import { defaultShelfDays, findPreset } from './veggies.js';

// name, qty, unit, price per line (EUR-ish), chance it gets wasted
const BASKET = [
  ['Spinach', 2, 'bunch', 3.0, 0.7],
  ['Coriander', 1, 'bunch', 0.6, 0.6],
  ['Tomato', 1, 'kg', 2.2, 0.25],
  ['Capsicum', 3, 'pcs', 2.4, 0.45],
  ['Broccoli', 1, 'pcs', 1.8, 0.5],
  ['Mushrooms', 1, 'pack', 2.0, 0.55],
  ['Cucumber', 3, 'pcs', 1.5, 0.35],
  ['Carrot', 1, 'kg', 1.2, 0.15],
  ['Onion', 2, 'kg', 3.2, 0.05],
  ['Potato', 2, 'kg', 2.8, 0.05],
];
const ALWAYS = new Set(['Spinach', 'Tomato', 'Onion']);
const PRICE_FACTOR = { INR: 40, JPY: 160, LKR: 250, ZAR: 18, AED: 4, SAR: 4, MYR: 4.5 };

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function priceIn(currency, base) {
  const factor = PRICE_FACTOR[currency] ?? 1;
  const p = base * factor;
  return factor >= 10 ? Math.round(p / 5) * 5 : Math.round(p * 100) / 100;
}

export function generateDemo(today, currency = 'INR', weeks = 10) {
  const rnd = mulberry32(42);
  const items = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const date = addDays(today, -(w * 7 + 1));
    const age = daysBetween(date, today);
    for (const [name, quantity, unit, base, wasteChance] of BASKET) {
      if (!ALWAYS.has(name) && rnd() < 0.2) continue;
      const it = makeItem({
        item_name: name,
        category: findPreset(name)?.category,
        quantity,
        unit,
        price: priceIn(currency, base),
        purchase_date: date,
        demo: true,
      });
      const shelf = defaultShelfDays(name);
      if (age >= 2) {
        if (rnd() < wasteChance) {
          const spoilAt = Math.max(1, shelf - 1 + Math.floor(rnd() * 4));
          const binAt = spoilAt + Math.floor(rnd() * 4);
          if (binAt <= age) {
            it.status = 'Thrown';
            it.quantity_wasted = quantity > 1 && rnd() < 0.3 ? Math.ceil(quantity / 2) : quantity;
            it.spoiled_found_date = addDays(date, spoilAt);
            it.thrown_date = addDays(date, binAt);
          } else if (spoilAt <= age) {
            it.status = 'Spoiled';
            it.spoiled_found_date = addDays(date, spoilAt);
          }
        } else {
          const usedAt = 1 + Math.floor(rnd() * Math.max(1, Math.min(shelf - 1, age - 1)));
          it.status = 'Used';
          it.used_date = addDays(date, usedAt);
        }
      }
      items.push(it);
    }
  }
  return items;
}
