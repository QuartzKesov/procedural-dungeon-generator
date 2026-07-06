// names.ts — Seeded dungeon name generator ("The Ashen Vaults of Vor'gul").
// Pure data, deterministic via the supplied RNG.

import type { RNG } from './rng';

const PREFIXES = [
  'Ashen', 'Sunken', 'Forgotten', 'Drowned', 'Whispering', 'Shattered',
  'Veiled', 'Bleeding', 'Hollow', 'Cursed', 'Frozen', 'Black', 'Pale',
  'Howling', 'Verdant', 'Rusted', 'Twilit', 'Screaming', 'Moldering', 'Dusk',
];

const NOUNS = [
  'Vaults', 'Crypts', 'Halls', 'Catacombs', 'Sanctum', 'Labyrinth',
  'Sepulcher', 'Catafalque', 'Ossuary', 'Mausoleum', 'Warren', 'Shrines',
  'Cisterns', 'Foundry', 'Caverns', 'Grotto', 'Citadel', 'Undercity',
];

const NAME_ROOTS = [
  'Vor', 'Kael', 'Mor', 'Drog', 'Zar', 'Thul', 'Vrak', 'Nyx', 'Bel', 'Grim',
  'Sza', 'Kar', 'Hesh', 'Velm', 'Oth', 'Rak', 'Xul', 'Yar', 'Drekk', 'Sha',
];

const NAME_SUFFIXES = [
  "'gul", "'thar", "'duun", "'moor", "'kael", 'eth', 'ax', 'ion', 'os', 'ar',
  'um', 'ix', 'or', 'ane', 'uth', 'is', 'ach', 'en',
];

const EPITHETS = [
  'the Forsaken', 'the Undying', 'the Hollow King', 'the Bonecaller',
  'the Ashen Lord', 'the Drowned', 'the Pale Widow', 'the Chainsworn',
  'the First Heretic', 'the Last Light', 'the Wormthatdevours',
  'the Silent Choir', 'the Maw', 'the Thousand Candles',
];

/** Generate a seeded dungeon name like "The Ashen Vaults of Vor'gul". */
export function generateDungeonName(rng: RNG): string {
  const prefix = rng.pick(PREFIXES);
  const noun = rng.pick(NOUNS);
  // ~35% of names get an eponym, ~15% get an epithet instead.
  const roll = rng.float();
  if (roll < 0.5) {
    const root = rng.pick(NAME_ROOTS);
    const suffix = rng.pick(NAME_SUFFIXES);
    return `The ${prefix} ${noun} of ${root}${suffix}`;
  } else if (roll < 0.65) {
    const epithet = rng.pick(EPITHETS);
    return `The ${prefix} ${noun} of ${epithet}`;
  } else if (roll < 0.85) {
    const root = rng.pick(NAME_ROOTS);
    const suffix = rng.pick(NAME_SUFFIXES);
    const epithet = rng.pick(EPITHETS);
    return `The ${prefix} ${noun} of ${root}${suffix}, ${epithet}`;
  }
  return `The ${prefix} ${noun}`;
}
