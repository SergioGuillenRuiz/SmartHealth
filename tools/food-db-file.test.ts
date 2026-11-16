import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dateOfDay, FoodDb } from '../src/domain/food-db';

// La base de productos que viaja dentro de la app (la genera el CI desde el volcado de Open Food Facts y la confirma en la rama):
// su resumen en JSON y el archivo binario tienen que contar lo mismo, y no puede ser la de plantilla (vacía).
const bin = readFileSync('src/data/foods/productos-es.bin');
const summary = JSON.parse(readFileSync('src/data/foods/productos-es.json', 'utf8')) as {
  count: number;
  bytes: number;
  dumpDate: string;
  license: string;
  samples: Array<{ code: string; name: string; brand: string }>;
};

describe('la base de productos de la app', () => {
  const db = new FoodDb(bin);

  it('es la de verdad: decenas de miles de productos', () => {
    expect(db.count).toBeGreaterThan(20_000);
  });

  it('su resumen coincide con el archivo', () => {
    expect(summary.count).toBe(db.count);
    expect(summary.bytes).toBe(bin.length);
    expect(dateOfDay(db.dumpDay)).toBe(summary.dumpDate);
    expect(summary.license).toBe('ODbL 1.0');
  });

  it('encuentra los productos de muestra y lo que tiene es creíble', () => {
    expect(summary.samples.length).toBeGreaterThan(0);
    for (const sample of summary.samples) expect(db.find(sample.code)).toMatchObject({ name: sample.name, brand: sample.brand });
    for (let i = 0; i < db.count; i += Math.ceil(db.count / 500)) {
      const p = db.at(i);
      expect(p.kcal).toBeLessThanOrEqual(900);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('pesa lo que cabe en un APK sin que se note', () => {
    expect(bin.length).toBeLessThan(25 * 1024 * 1024);
  });
});
