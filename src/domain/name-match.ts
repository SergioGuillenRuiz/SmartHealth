// Qué alimento principal lleva el nombre de una comida: la misma lógica para el icono (`ui/meal-icon.ts`) y para la foto (`ui/meal-photo-rules.ts`).
//
// Cada regla dice un valor (el icono o la foto), qué papel tienen sus palabras en una comida y las palabras que lo señalan (sin tildes, separadas por «|»; el plural se
// entiende solo). De todas las reglas que casan con el nombre gana lo principal que aparece antes («Tostada + Café con leche» es una tostada y «Arroz con pollo» es arroz);
// una bebida solo gana si no hay comida («Café con leche»), y un condimento si no hay nada más. Con la misma posición gana la expresión más larga («huevo frito» antes que
// «huevo») y, a igualdad, la regla que va antes.

export type Role = 'main' | 'drink' | 'side';

export interface NameRule<T> {
  value: T;
  role: Role;
  /** Palabras o expresiones que señalan este alimento, separadas por «|». */
  words: string;
}

/** Sin tildes, en minúsculas y con espacios a los lados (para casar palabras sueltas como «te» o «pan»). */
export const plainName = (text: string): string => ` ${text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()} `;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface NameMatcher<T> {
  value: T;
  role: Role;
  order: number;
  pattern: RegExp;
}

/** Las reglas listas para buscar. */
export function compileRules<T>(rules: readonly NameRule<T>[]): readonly NameMatcher<T>[] {
  return rules.flatMap(({ value, role, words }, order) =>
    [...new Set(words.split('|').map((word) => plainName(word).trim()))]
      .filter((word) => word !== '')
      .map((word) => ({
        value,
        role,
        order,
        // La palabra entera (o la expresión entera), con o sin plural en cada palabra: «caña» casa con «cañas» y «judía verde» con «judías verdes», pero «pan» no casa con «panecillo».
        pattern: new RegExp(`(?<![a-z0-9])${word.split(/\s+/).map((part) => `${escapeRegExp(part)}(?:s|es)?`).join('\\s+')}(?![a-z0-9])`),
      })),
  );
}

const ROLE_RANK: Readonly<Record<Role, number>> = { main: 0, drink: 1, side: 2 };

interface Hit<T> {
  matcher: NameMatcher<T>;
  at: number;
  length: number;
}

/** Lo principal gana a una bebida y esta a un condimento; con el mismo papel, lo que aparece antes; después, la expresión más larga y la regla que va antes. */
function beats<T>(a: Hit<T>, b: Hit<T>): boolean {
  const rank = ROLE_RANK[a.matcher.role] - ROLE_RANK[b.matcher.role];
  if (rank !== 0) return rank < 0;
  if (a.at !== b.at) return a.at < b.at;
  if (a.length !== b.length) return a.length > b.length;
  return a.matcher.order < b.matcher.order;
}

/** El valor de la regla que mejor dice qué es esta comida, o `null` si no casa ninguna. */
export function bestRule<T>(matchers: readonly NameMatcher<T>[], name: string): T | null {
  const text = plainName(name);
  let best: Hit<T> | null = null;
  for (const matcher of matchers) {
    const found = matcher.pattern.exec(text);
    if (!found) continue;
    const candidate: Hit<T> = { matcher, at: found.index, length: found[0].length };
    if (best === null || beats(candidate, best)) best = candidate;
  }
  return best === null ? null : best.matcher.value;
}
