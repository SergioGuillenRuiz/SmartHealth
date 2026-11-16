// El orden de las formas de anotar comida, el MISMO en todos los menús y submenús («He comido algo», añadir un ingrediente a un plato, enseñarle un producto nuevo a la app…) para
// que nadie tenga que volver a buscar cada vez dónde está cada cosa: primero lo que no pide nada (la báscula), después lo que lee (el código de barras o, al enseñar un producto, la foto
// de su tabla), después las palabras y, siempre la última, a mano.

export type WayId = 'scale' | 'scan' | 'words' | 'manual';

export const WAY_ORDER: readonly WayId[] = ['scale', 'scan', 'words', 'manual'];

/** Pone las opciones en el orden de siempre (las que faltan simplemente no salen). */
export function inWayOrder<T extends { way: WayId }>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => WAY_ORDER.indexOf(a.way) - WAY_ORDER.indexOf(b.way));
}
