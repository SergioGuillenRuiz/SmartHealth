/**
 * El menor y el mayor de una lista SIN pasarla como argumentos: `Math.min(...lista)` revienta la pila (`RangeError`) con unos
 * 120 000 elementos, y una copia de seguridad (o una transferencia del anillo) con tantas lecturas en un día no debe poder dejar
 * ese día sin cargar. Igual que `Math.min()` / `Math.max()`: con la lista vacía dan `Infinity` / `-Infinity`, y un `NaN` da `NaN`.
 */
export function minOf(values: readonly number[]): number {
  let min = Infinity;
  for (const value of values) min = Math.min(min, value);
  return min;
}

export function maxOf(values: readonly number[]): number {
  let max = -Infinity;
  for (const value of values) max = Math.max(max, value);
  return max;
}
