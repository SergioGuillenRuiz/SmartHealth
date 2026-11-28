import { describe, expect, it } from 'vitest';
import { FIT_MIN, fitScale } from './sheet-fit';

describe('fitScale', () => {
  it('si el contenido ya cabe, no se toca', () => {
    expect(fitScale(500, 600)).toBe(1);
    expect(fitScale(600, 600)).toBe(1);
  });

  it('si se pasa por poco, se reduce lo justo para que quepa', () => {
    expect(fitScale(660, 600)).toBeCloseTo(600 / 660, 5);
    expect(fitScale(600 / FIT_MIN, 600)).toBeCloseTo(FIT_MIN, 5);
  });

  it('si habría que reducirlo demasiado, no se toca (hay mucha información: se desliza)', () => {
    expect(fitScale(900, 600)).toBe(1);
    expect(fitScale(600 / FIT_MIN + 5, 600)).toBe(1);
  });

  it('sin alto disponible (hoja cerrada o aún sin medir) no hace nada', () => {
    expect(fitScale(500, 0)).toBe(1);
    expect(fitScale(500, -10)).toBe(1);
    expect(fitScale(Number.NaN, 600)).toBe(1);
  });
});
