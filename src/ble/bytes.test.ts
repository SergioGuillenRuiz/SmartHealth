import { describe, expect, it } from 'vitest';
import { concat, concatAll } from './bytes';

describe('concat / concatAll', () => {
  it('unen los trozos en orden', () => {
    expect([...concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))]).toEqual([1, 2, 3]);
    expect([...concatAll([new Uint8Array([9]), new Uint8Array([8, 7])])]).toEqual([9, 8, 7]);
    expect(concatAll([])).toHaveLength(0);
  });

  it('concatAll admite cientos de miles de trozos (pasados como argumentos con `...` la pila se desborda)', () => {
    const chunks = Array.from({ length: 300_000 }, (_, i) => new Uint8Array([i & 0xff]));
    const out = concatAll(chunks);
    expect(out).toHaveLength(300_000);
    expect(out[300]).toBe(300 & 0xff);
  });
});
