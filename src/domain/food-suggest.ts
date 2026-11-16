import type { FoodEntry } from './food-table';

// Sugerencias mientras se escribe qué se está pesando: alimentos de la tabla, platos guardados y productos que la persona enseñó. Solo ayuda a escribir; lo que se calcula es lo que
// escribe (o elige) pasado por el mismo análisis de texto de siempre.

export interface Suggestion {
  /** Lo que se enseña y lo que se escribe al elegirlo. */
  label: string;
  kind: 'food' | 'dish' | 'product';
}

export interface SuggestSources {
  foods: readonly Pick<FoodEntry, 'name' | 'aliases' | 'ignore'>[];
  dishes: ReadonlyArray<{ name: string }>;
  products: ReadonlyArray<{ name: string }>;
}

export const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^=/, '')
    .trim();

/** 0 = no cuadra; cuanto mayor, mejor: el nombre empieza como lo escrito > una palabra empieza como lo escrito > lo contiene. */
function scoreOf(candidate: string, tokens: readonly string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (candidate.startsWith(token)) score += 3;
    else if (candidate.split(/[\s,()/-]+/).some((word) => word.startsWith(token))) score += 2;
    else if (token.length >= 3 && candidate.includes(token)) score += 1;
    else return 0;
  }
  return score;
}

/** Hasta `limit` sugerencias para lo escrito (vacío si no hay al menos dos letras). Los platos y productos de la persona van primero. */
export function suggestFoods(query: string, sources: SuggestSources, limit = 6): Suggestion[] {
  const tokens = plain(query).split(/\s+/).filter(Boolean);
  if (tokens.join('').length < 2) return [];
  const found: Array<Suggestion & { score: number; length: number }> = [];
  const seen = new Set<string>();
  // El nombre pesa mucho más que las formas de decirlo (los alias traen frases como «orejones de plátano» que no son lo que se busca al escribir «plátano»).
  const consider = (label: string, kind: Suggestion['kind'], aliases: readonly string[], bonus: number): void => {
    const key = plain(label);
    if (seen.has(key)) return;
    const byName = scoreOf(key, tokens);
    const byAlias = Math.max(0, ...aliases.map((alias) => scoreOf(plain(alias), tokens))) >= tokens.length * 2 ? 1 : 0;
    if (byName <= 0 && byAlias <= 0) return;
    seen.add(key);
    found.push({ label, kind, score: byName * 3 + byAlias + bonus, length: label.length });
  };
  for (const dish of sources.dishes) consider(dish.name, 'dish', [], 1.5);
  for (const product of sources.products) consider(product.name, 'product', [], 1);
  for (const food of sources.foods) {
    if (!food.ignore) consider(food.name, 'food', food.aliases, 0);
  }
  return found
    .sort((a, b) => b.score - a.score || a.length - b.length || a.label.localeCompare(b.label, 'es'))
    .slice(0, limit)
    .map(({ label, kind }) => ({ label, kind }));
}
