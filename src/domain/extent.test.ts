import { describe, expect, it } from 'vitest';
import { maxOf, minOf } from './extent';

describe('minOf / maxOf', () => {
  it('dan lo mismo que Math.min / Math.max', () => {
    for (const values of [[3, 1, 2], [-5, 0, 5], [7], [2, 2, 2], [0.5, -0.25]]) {
      expect(minOf(values)).toBe(Math.min(...values));
      expect(maxOf(values)).toBe(Math.max(...values));
    }
  });

  it('con la lista vacía se comportan como Math.min() y Math.max()', () => {
    expect(minOf([])).toBe(Infinity);
    expect(maxOf([])).toBe(-Infinity);
  });

  it('un NaN lo contagia, igual que en Math.min / Math.max', () => {
    expect(minOf([1, NaN, 2])).toBeNaN();
    expect(maxOf([1, NaN, 2])).toBeNaN();
  });

  it('aguantan una lista enorme, donde `Math.min(...lista)` lanza RangeError', () => {
    const big = Array.from({ length: 600_000 }, (_, i) => (i * 7919) % 1000);
    expect(() => Math.min(...big)).toThrow(RangeError);
    expect(minOf(big)).toBe(0);
    expect(maxOf(big)).toBe(999);
  });
});
