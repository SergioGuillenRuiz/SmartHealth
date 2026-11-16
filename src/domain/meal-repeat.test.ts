import { describe, expect, it } from 'vitest';
import { nameTokens, repeatsAround, sameMeal } from './meal-repeat';

describe('sameMeal: la misma comida, no una parecida', () => {
  it.each([
    ['Sobre de pasta instantánea', 'sobre de pasta instantanea', true],
    ['Sobre de pasta instantánea', '2 sobres de pasta instantánea', true], // la cantidad no cambia de qué comida se trata
    ['Macarrones con tomate', 'macarrón con tomate', true],
    ['Pizza margarita', 'una pizza margarita', true],
    ['Big Mac', 'big mac 1', true],
    ['Sobre de pasta instantánea', 'Pasta instantánea', true],
    ['Pizza margarita', 'Pizza barbacoa', false],
    ['Hamburguesa de pollo', 'Hamburguesa de ternera', false],
    ['Ensalada de pollo', 'Pollo asado', false],
    ['Croissant', 'Donut', false],
  ])('%s ≈ %s → %s', (a, b, expected) => {
    expect(sameMeal({ name: a }, { name: b })).toBe(expected);
    expect(sameMeal({ name: b }, { name: a })).toBe(expected);
  });

  it('con código de barras manda el código (aunque el nombre cambie) y solo el código (aunque el nombre sea igual)', () => {
    expect(sameMeal({ name: 'Maruchan pollo', barcode: '0841234567894' }, { name: 'Fideos instantáneos', barcode: '841234567894' })).toBe(true);
    expect(sameMeal({ name: 'Maruchan pollo', barcode: '8412345678941' }, { name: 'Maruchan pollo', barcode: '8412345678958' })).toBe(false);
    // Una comida con código y otra sin él se comparan por el nombre.
    expect(sameMeal({ name: 'Maruchan pollo', barcode: '8412345678941' }, { name: 'maruchan de pollo' })).toBe(true);
  });

  it('sin palabras que comparar (solo números o medidas) solo es la misma si está escrita igual', () => {
    expect(nameTokens('2 x 100 g').size).toBe(0);
    expect(sameMeal({ name: '500 kcal' }, { name: '500 kcal' })).toBe(true);
    expect(sameMeal({ name: '500 kcal' }, { name: '600 kcal' })).toBe(false);
    expect(sameMeal({ name: '' }, { name: '' })).toBe(false);
  });
});

describe('repeatsAround: la mejor semana que incluye el día', () => {
  it('cuenta las veces dentro de 7 días seguidos que contienen el día', () => {
    expect(repeatsAround('2026-10-10', ['2026-10-10'])).toBe(1);
    expect(repeatsAround('2026-10-10', ['2026-10-08', '2026-10-10', '2026-10-12'])).toBe(3);
    // 7 días justos caben (del 4 al 10); 8 no.
    expect(repeatsAround('2026-10-10', ['2026-10-04', '2026-10-07', '2026-10-10'])).toBe(3);
    expect(repeatsAround('2026-10-10', ['2026-10-03', '2026-10-07', '2026-10-10'])).toBe(2);
  });

  it('la primera de tres también lo sabe: la semana puede seguir después del día', () => {
    const days = ['2026-10-10', '2026-10-12', '2026-10-14'];
    expect(repeatsAround('2026-10-10', days)).toBe(3);
    expect(repeatsAround('2026-10-14', days)).toBe(3);
  });

  it('una comida de hace un mes no suma con la de ahora, y varias veces el mismo día cuentan cada una', () => {
    expect(repeatsAround('2026-10-10', ['2026-09-01', '2026-09-05', '2026-10-10'])).toBe(1);
    expect(repeatsAround('2026-10-10', ['2026-10-10', '2026-10-10', '2026-10-10'])).toBe(3);
    expect(repeatsAround('2026-10-10', [])).toBe(0);
  });
});
