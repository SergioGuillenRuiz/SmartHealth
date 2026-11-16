// Lo que decide qué se dibuja de una serie con huecos en el gráfico conjunto (puro, para poder probarlo).

/** Del primer al último valor presente (`null` con menos de dos): cuánto cambió una medida a lo largo del periodo. */
export function changeOf(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  const first = present[0];
  const last = present[present.length - 1];
  return present.length >= 2 && first !== undefined && last !== undefined ? last - first : null;
}
