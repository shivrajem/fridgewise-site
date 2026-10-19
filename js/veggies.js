// Preset vegetables, categories and typical fridge shelf life (days).
// Shelf life is only the starting estimate: calc.learnedShelfLives() replaces
// it with the household's own numbers once a couple of spoil dates exist.

export const CATEGORIES = {
  'Leafy greens': 4,
  Herbs: 5,
  'Soft veg': 7,
  Crucifers: 7,
  Roots: 21,
  Pantry: 30,
  Fruit: 7,
  Other: 7,
};

export const UNITS = ['pcs', 'kg', 'g', 'bunch', 'pack'];

export const PRESETS = [
  { name: 'Spinach', emoji: '🥬', category: 'Leafy greens', unit: 'bunch' },
  { name: 'Lettuce', emoji: '🥬', category: 'Leafy greens', unit: 'pcs', days: 6 },
  { name: 'Methi', emoji: '🌿', category: 'Leafy greens', unit: 'bunch', days: 3 },
  { name: 'Coriander', emoji: '🌿', category: 'Herbs', unit: 'bunch' },
  { name: 'Mint', emoji: '🌿', category: 'Herbs', unit: 'bunch' },
  { name: 'Basil', emoji: '🌿', category: 'Herbs', unit: 'pack' },
  { name: 'Tomato', emoji: '🍅', category: 'Soft veg', unit: 'kg' },
  { name: 'Cucumber', emoji: '🥒', category: 'Soft veg', unit: 'pcs' },
  { name: 'Capsicum', emoji: '🫑', category: 'Soft veg', unit: 'pcs', days: 9 },
  { name: 'Zucchini', emoji: '🥒', category: 'Soft veg', unit: 'pcs' },
  { name: 'Brinjal', emoji: '🍆', category: 'Soft veg', unit: 'kg', days: 6 },
  { name: 'Okra', emoji: '🫛', category: 'Soft veg', unit: 'kg', days: 4 },
  { name: 'Green beans', emoji: '🫛', category: 'Soft veg', unit: 'kg', days: 6 },
  { name: 'Mushrooms', emoji: '🍄', category: 'Soft veg', unit: 'pack', days: 5 },
  { name: 'Green chilli', emoji: '🌶️', category: 'Soft veg', unit: 'g', days: 10 },
  { name: 'Corn', emoji: '🌽', category: 'Soft veg', unit: 'pcs', days: 4 },
  { name: 'Broccoli', emoji: '🥦', category: 'Crucifers', unit: 'pcs', days: 5 },
  { name: 'Cauliflower', emoji: '🥦', category: 'Crucifers', unit: 'pcs' },
  { name: 'Cabbage', emoji: '🥬', category: 'Crucifers', unit: 'pcs', days: 14 },
  { name: 'Carrot', emoji: '🥕', category: 'Roots', unit: 'kg' },
  { name: 'Beetroot', emoji: '🫜', category: 'Roots', unit: 'kg', days: 14 },
  { name: 'Radish', emoji: '🥕', category: 'Roots', unit: 'kg', days: 10 },
  { name: 'Onion', emoji: '🧅', category: 'Pantry', unit: 'kg' },
  { name: 'Potato', emoji: '🥔', category: 'Pantry', unit: 'kg' },
  { name: 'Garlic', emoji: '🧄', category: 'Pantry', unit: 'g' },
  { name: 'Ginger', emoji: '🫚', category: 'Pantry', unit: 'g', days: 21 },
  { name: 'Pumpkin', emoji: '🎃', category: 'Pantry', unit: 'kg', days: 14 },
  { name: 'Lemon', emoji: '🍋', category: 'Fruit', unit: 'pcs', days: 21 },
  { name: 'Banana', emoji: '🍌', category: 'Fruit', unit: 'pcs', days: 5 },
  { name: 'Apple', emoji: '🍎', category: 'Fruit', unit: 'kg', days: 21 },
];

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const BY_NAME = new Map(PRESETS.map((p) => [key(p.name), p]));

export function findPreset(name) {
  return BY_NAME.get(key(name)) ?? null;
}

export function emojiFor(name) {
  return findPreset(name)?.emoji ?? '🥗';
}

export function defaultShelfDays(name, category) {
  const preset = findPreset(name);
  return preset?.days ?? CATEGORIES[preset?.category ?? category] ?? 7;
}
