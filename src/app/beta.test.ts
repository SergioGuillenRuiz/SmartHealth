import { describe, expect, it } from 'vitest';
import { BETA_SEED_KEY, isBeta, markBetaSeeded, shouldSeedBeta } from './beta';

const storeWith = (entries: number) => ({ getProfileHistory: async () => Array.from({ length: entries }, () => ({}) as never) });
const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
};

describe('versión para betatesters', () => {
  it('en las pruebas y en la compilación normal no es beta', () => {
    expect(isBeta()).toBe(false);
  });

  it('siembra los datos de ejemplo la primera vez: sin marca y sin perfil', async () => {
    expect(await shouldSeedBeta(storeWith(0), memory())).toBe(true);
  });

  it('no los vuelve a sembrar si ya se sembraron, aunque la base esté vacía («Borrar todo» no los trae de vuelta)', async () => {
    expect(await shouldSeedBeta(storeWith(0), memory({ [BETA_SEED_KEY]: '1' }))).toBe(false);
  });

  it('no pisa una base con perfil (alguien la usó) aunque falte la marca', async () => {
    expect(await shouldSeedBeta(storeWith(3), memory())).toBe(false);
    expect(await shouldSeedBeta(storeWith(1), null)).toBe(false);
  });

  it('sin almacenamiento del navegador decide solo por la base', async () => {
    expect(await shouldSeedBeta(storeWith(0), null)).toBe(true);
    const broken = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };
    expect(await shouldSeedBeta(storeWith(0), broken)).toBe(true);
    expect(() => markBetaSeeded(broken)).not.toThrow();
  });

  it('apunta la marca', () => {
    const m = memory();
    markBetaSeeded(m);
    expect(m.data.get(BETA_SEED_KEY)).toBe('1');
  });
});
