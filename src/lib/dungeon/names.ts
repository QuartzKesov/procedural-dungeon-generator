// names.ts — Seeded dungeon name generator ("Пепельные Склепы Вор'гула").
// Pure data, deterministic via the supplied RNG. Russian names.

import type { RNG } from './rng';

const PREFIXES = [
  'Пепельные', 'Затопленные', 'Забытые', 'Утопленные', 'Шепчущие', 'Расколотые',
  'Сокрытые', 'Кровоточащие', 'Пустые', 'Проклятые', 'Ледяные', 'Чёрные', 'Бледные',
  'Воющие', 'Зелёные', 'Ржавые', 'Сумеречные', 'Кричащие', 'Гниющие', 'Предвечерние',
];

const NOUNS = [
  'Склепы', 'Катакомбы', 'Чертоги', 'Подземелья', 'Святилище', 'Лабиринт',
  'Гробницы', 'Оссуарий', 'Мавзолей', 'Норы', 'Кладбища', 'Цистерны',
  'Кузница', 'Пещеры', 'Грот', 'Цитадель', 'Подгород', 'Усыпальницы',
];

const NAME_ROOTS = [
  'Вор', 'Кэл', 'Мор', 'Дрог', 'Зар', 'Тул', 'Врак', 'Никс', 'Бел', 'Грим',
  'Сза', 'Кар', 'Хеш', 'Велм', 'От', 'Рак', 'Зул', 'Яр', 'Дрекк', 'Ша',
];

const NAME_SUFFIXES = [
  "'гул", "'тар", "'дун", "'мор", "'кэл", 'ет', 'акс', 'ион', 'ос', 'ар',
  'ум', 'икс', 'ор', 'ан', 'ут', 'ис', 'ах', 'ен',
];

const EPITHETS = [
  'Покинутый', 'Бессмертный', 'Полый Король', 'Костяной Зовущий',
  'Пепельный Лорд', 'Утопленник', 'Бледная Вдова', 'Клятвенный',
  'Первый Еретик', 'Последний Свет', 'Червь Пожиратель',
  'Тихий Хор', 'Пасть', 'Тысяча Свечей',
];

/** Generate a seeded dungeon name like "Пепельные Склепы Вор'гула". */
export function generateDungeonName(rng: RNG): string {
  const prefix = rng.pick(PREFIXES);
  const noun = rng.pick(NOUNS);
  const roll = rng.float();
  if (roll < 0.5) {
    const root = rng.pick(NAME_ROOTS);
    const suffix = rng.pick(NAME_SUFFIXES);
    return `${prefix} ${noun} ${root}${suffix}`;
  } else if (roll < 0.65) {
    const epithet = rng.pick(EPITHETS);
    return `${prefix} ${noun} — ${epithet}`;
  } else if (roll < 0.85) {
    const root = rng.pick(NAME_ROOTS);
    const suffix = rng.pick(NAME_SUFFIXES);
    const epithet = rng.pick(EPITHETS);
    return `${prefix} ${noun} ${root}${suffix}, ${epithet}`;
  }
  return `${prefix} ${noun}`;
}
