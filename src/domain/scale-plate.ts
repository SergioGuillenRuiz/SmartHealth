// Pesar un plato ingrediente a ingrediente sobre la misma báscula: tras añadir uno, la báscula sigue marcando el total (a menos que se pulse TARA o se retire lo pesado). Esta
// función dice cuánto pesa el ingrediente nuevo: lo que marca la báscula menos lo ya pesado, entendiendo que si el peso BAJA de lo ya pesado es que se ha quitado algo o se ha
// tarado, y se empieza de cero.

/** Cuánto tiene que bajar el peso respecto a lo ya pesado para entender que se quitó algo o se taró (el baile de la báscula es de 1 g). */
export const TARE_DROP_G = 5;

export interface NetWeight {
  /** Lo ya pesado que sigue en la báscula (se actualiza si se quitó algo). */
  baselineG: number;
  /** Lo que pesa lo nuevo (g). */
  netG: number;
}

export function netWeight(readingG: number, baselineG: number): NetWeight {
  if (readingG < baselineG - TARE_DROP_G) return { baselineG: 0, netG: Math.max(0, readingG) };
  return { baselineG, netG: Math.max(0, readingG - baselineG) };
}
