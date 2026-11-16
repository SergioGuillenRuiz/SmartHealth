import { describe, expect, it } from 'vitest';
import { creditField, mealDay, MAX_DAY_SHIFT, movedDay, validCreditDay } from './day-credit';

const at = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
const key = (day: number): string => `2026-07-${String(day).padStart(2, '0')}`;

describe('a qué día cuenta una comida', () => {
  it('por omisión, al día en que se comió; con `day`, al que se pasó', () => {
    expect(mealDay({ tsMs: at(9, 1, 30) })).toBe(key(9));
    expect(mealDay({ tsMs: at(9, 1, 30), day: key(8) })).toBe(key(8));
  });

  it('`validCreditDay` solo admite un día válido, distinto del real y a no más de MAX_DAY_SHIFT', () => {
    expect(validCreditDay(key(9), key(8))).toBe(key(8));
    expect(validCreditDay(key(9), key(9 + MAX_DAY_SHIFT))).toBe(key(9 + MAX_DAY_SHIFT));
    expect(validCreditDay(key(9), key(9))).toBeUndefined();
    expect(validCreditDay(key(9), key(9 + MAX_DAY_SHIFT + 1))).toBeUndefined();
    expect(validCreditDay(key(9), '2026-02-30')).toBeUndefined();
    expect(validCreditDay(key(9), 'ayer')).toBeUndefined();
    expect(validCreditDay(key(9), 8)).toBeUndefined();
    expect(validCreditDay(key(9), undefined)).toBeUndefined();
  });

  it('`movedDay` da el día de al lado, pero nunca uno futuro ni uno muy apartado del real', () => {
    expect(movedDay(key(9), key(9), -1, key(20))).toBe(key(8));
    expect(movedDay(key(9), key(8), 1, key(20))).toBe(key(9));
    expect(movedDay(key(9), key(9), 1, key(20))).toBe(key(10));
    // No se pasa a mañana.
    expect(movedDay(key(20), key(20), 1, key(20))).toBeNull();
    // Ni a más de MAX_DAY_SHIFT días del real, hacia atrás o hacia delante.
    expect(movedDay(key(9), key(9 - MAX_DAY_SHIFT), -1, key(20))).toBeNull();
    expect(movedDay(key(9), key(9 + MAX_DAY_SHIFT), 1, key(20))).toBeNull();
    expect(movedDay(key(9), key(9 - MAX_DAY_SHIFT + 1), -1, key(20))).toBe(key(9 - MAX_DAY_SHIFT));
  });

  it('`creditField` no guarda nada si cuenta para su propio día', () => {
    expect(creditField(key(9), key(9))).toEqual({});
    expect(creditField(key(9), key(8))).toEqual({ day: key(8) });
  });
});
