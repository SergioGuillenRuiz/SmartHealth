import { addDays, daysBetween, type DayKey } from './dates';
import type { MealEntry } from './nutrition';

// Cuándo una comida «se repite»: la MISMA comida (el mismo producto, o el mismo plato dicho con las mismas palabras) tres o más veces en una semana. Es lo que decide si se avisa con las
// ideas para comer mejor: no basta con que haya varias comidas poco adecuadas, tiene que ser esa misma una y otra vez.

/** Cuántas veces se tiene que repetir una comida poco adecuada, y en cuántos días seguidos, para ofrecer ideas con ella. */
export const REPEATS_FOR_SUGGESTIONS = 3;
export const REPEAT_WINDOW_DAYS = 7;

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'y', 'e', 'en', 'al', 'a', 'para', 'por', 'mi', 'mis', 'otro', 'otra', 'otros', 'otras', 'mas', 'sin']);
const UNITS = new Set(['x', 'g', 'gr', 'gramo', 'gramos', 'kg', 'ml', 'cl', 'l', 'kcal', 'ud', 'uds', 'unidad', 'unidades', 'racion', 'raciones']);

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Una palabra sin plural ni terminación vocálica final, para que «macarrones» y «macarrón», o «tomates» y «tomate», sean la misma. */
const stem = (word: string): string => (word.length >= 4 ? word.replace(/s$/, '').replace(/e$/, '') : word);

/** Las palabras que dicen QUÉ es una comida: sin cantidades, medidas ni palabras de relleno, y sin plurales. */
export function nameTokens(name: string): Set<string> {
  const tokens = plain(name)
    .split(/[^a-z0-9ñ]+/)
    .filter((word) => word !== '' && !/^\d/.test(word) && !STOPWORDS.has(word) && !UNITS.has(word))
    .map(stem);
  return new Set(tokens);
}

/** Dos comidas son la misma si son el mismo producto (mismo código de barras) o, sin código, si se llaman casi igual (la mitad o más de sus palabras clave coinciden). */
export function sameMeal(a: Pick<MealEntry, 'name' | 'barcode'>, b: Pick<MealEntry, 'name' | 'barcode'>): boolean {
  if (a.barcode !== undefined && b.barcode !== undefined) return a.barcode.replace(/^0+/, '') === b.barcode.replace(/^0+/, '');
  const x = nameTokens(a.name);
  const y = nameTokens(b.name);
  if (x.size === 0 || y.size === 0) return plain(a.name).trim() === plain(b.name).trim() && plain(a.name).trim() !== '';
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared) >= 0.5;
}

/**
 * Cuántas veces se ha comido esa comida en la mejor semana que incluye `day`: de las `days` (los días en que se comió, uno por vez) cuenta las que caben en 7 días seguidos que
 * contengan `day`, y se queda con la ventana que más reúne. Así la tercera vez avisa, y también la primera y la segunda cuando ya se sabe que se repetirá.
 */
export function repeatsAround(day: DayKey, days: readonly DayKey[]): number {
  let best = 0;
  for (let back = 0; back < REPEAT_WINDOW_DAYS; back++) {
    const start = addDays(day, -back);
    let count = 0;
    for (const other of days) {
      const offset = daysBetween(start, other);
      if (offset >= 0 && offset < REPEAT_WINDOW_DAYS) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}
