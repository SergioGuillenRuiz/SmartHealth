import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { plain, suggestFoods } from './food-suggest';

const table = parseFoodTables(FOOD_SOURCES);
const none = { dishes: [], products: [] };

describe('suggestFoods', () => {
  it('no sugiere con menos de dos letras', () => {
    expect(suggestFoods('', { foods: table, ...none })).toEqual([]);
    expect(suggestFoods('p', { foods: table, ...none })).toEqual([]);
  });

  it('encuentra alimentos de la tabla por el principio de una palabra, sin tildes ni mayúsculas', () => {
    const names = suggestFoods('PLATAN', { foods: table, ...none }).map((s) => plain(s.label));
    expect(names[0]).toBe('platano');
    // Los de nombre parecido van antes que los que solo lo mencionan en una forma de decirlos.
    const firstOther = names.findIndex((n) => !n.includes('platan'));
    expect(names.slice(0, firstOther === -1 ? names.length : firstOther).every((n) => n.includes('platan'))).toBe(true);
    expect(suggestFoods('pechuga pollo', { foods: table, ...none }).map((s) => s.label)).toContain('Pechuga de pollo');
  });

  it('los platos y los productos de la persona van antes que los de la tabla, y no se repite ninguno', () => {
    const result = suggestFoods('lentejas', { foods: table, dishes: [{ name: 'Lentejas de mi madre' }], products: [{ name: 'Lentejas Luz' }] });
    expect(result[0]).toEqual({ label: 'Lentejas de mi madre', kind: 'dish' });
    expect(result[1]).toEqual({ label: 'Lentejas Luz', kind: 'product' });
    expect(new Set(result.map((s) => plain(s.label))).size).toBe(result.length);
  });

  it('respeta el tope y no sugiere lo que la tabla solo reconoce sin sumar', () => {
    expect(suggestFoods('de', { foods: table, ...none }, 3).length).toBeLessThanOrEqual(3);
    const foods = [
      { name: 'Sal', aliases: ['sal'], ignore: true },
      { name: 'Salmón', aliases: ['salmon'], ignore: false },
    ];
    expect(suggestFoods('sal', { foods, ...none }).map((s) => s.label)).toEqual(['Salmón']);
  });

  it('con varias palabras deben cuadrar todas', () => {
    const foods = [
      { name: 'Pollo asado', aliases: [], ignore: false },
      { name: 'Pollo frito', aliases: [], ignore: false },
    ];
    expect(suggestFoods('pollo asa', { foods, ...none }).map((s) => s.label)).toEqual(['Pollo asado']);
    expect(suggestFoods('pollo xyz', { foods, ...none })).toEqual([]);
  });
});
