import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { FoodDb } from '../src/domain/food-db';
import { buildRecords, linesOf, normalizeCode, readableBrand } from './build-food-db';

/** El código de 13 cifras que empieza por `base12`, con su cifra de control. */
function ean13(base12: string): string {
  const sum = [...base12].reverse().reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1), 0);
  return `${base12}${(10 - (sum % 10)) % 10}`;
}

const HEADER = ['code', 'url', 'product_name', 'generic_name', 'brands', 'countries_tags', 'serving_quantity', 'energy-kj_100g', 'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g', 'extra'];

interface Row {
  code: string;
  name?: string;
  generic?: string;
  brands?: string;
  countries?: string;
  serving?: string;
  kj?: string;
  kcal?: string;
  protein?: string;
  carbs?: string;
  fat?: string;
}

const line = (row: Row): string =>
  [row.code, 'https://x', row.name ?? '', row.generic ?? '', row.brands ?? '', row.countries ?? 'en:spain', row.serving ?? '', row.kj ?? '', row.kcal ?? '', row.protein ?? '', row.carbs ?? '', row.fat ?? '', 'x'].join('\t');

const YOGURT = ean13('841000000001');
const lines = (rows: string[], header = HEADER): string[] => [header.join('\t'), ...rows];

const build = (rows: string[], countries = ['en:spain'], header = HEADER) => buildRecords(lines(rows, header), { countries });

describe('buildRecords', () => {
  it('se queda con los productos del país que tienen código, nombre y calorías creíbles', async () => {
    const { records, stats } = await build([
      line({ code: YOGURT, name: '  Yogur   natural ', brands: 'Marca A, Otra', countries: 'en:spain,en:france', serving: '125', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' }),
      line({ code: ean13('301762042200'), name: 'Nutella', brands: 'Ferrero', countries: 'en:france', kcal: '539', protein: '6.3', carbs: '57.5', fat: '30.9' }),
      line({ code: '1234567890123', name: 'Código malo', kcal: '100' }),
      line({ code: 'ABC', name: 'Código con letras', kcal: '100' }),
      line({ code: ean13('841000000002'), name: '', kcal: '100' }),
      line({ code: ean13('841000000003'), name: '', generic: 'Pan de molde', kcal: '265', protein: '9', carbs: '49', fat: '3.2' }),
      line({ code: ean13('841000000004'), name: 'Solo en kJ', kj: '255', protein: '3.5', carbs: '4.7', fat: '3.2' }),
      line({ code: ean13('841000000005'), name: 'Imposible', kcal: '950' }),
      line({ code: ean13('841000000006'), name: 'Incoherente', kcal: '0', carbs: '70' }),
      line({ code: ean13('841000000007'), name: 'Sin datos', kcal: '' }),
      line({ code: YOGURT, name: 'Repetido', kcal: '10' }),
      'corta\tmuy corta',
      '',
    ]);
    expect(records.map((r) => r.name).sort()).toEqual(['Pan de molde', 'Solo en kJ', 'Yogur natural']);
    const yogurt = records.find((r) => r.code === YOGURT);
    expect(yogurt).toMatchObject({ brand: 'Marca A', kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2, servingG: 125 });
    expect(records.find((r) => r.name === 'Solo en kJ')?.kcal).toBe(60.9); // 255 kJ / 4,184
    expect(records.find((r) => r.name === 'Pan de molde')?.servingG).toBeNull();
    expect(stats).toEqual({ rows: 12, malformed: 1, otherCountry: 1, badBarcode: 2, noName: 1, noNutrition: 3, duplicates: 1, kept: 3, withFiber: 0, withSugars: 0, withSalt: 0 });
    // Sin las columnas de fibra, azúcares y sal en el volcado, los productos quedan «sin dato» (no es un error).
    expect(yogurt).toMatchObject({ fiberG: null, sugarsG: null, saltG: null });
  });

  it('lee la fibra, los azúcares y la sal si el volcado los trae (la sal, del sodio si no hay sal) y descarta lo increíble', async () => {
    const header = [...HEADER, 'fiber_100g', 'sugars_100g', 'salt_100g', 'sodium_100g'];
    const row = (code: string, name: string, extras: [string, string, string, string]): string =>
      [line({ code, name, kcal: '300', protein: '10', carbs: '40', fat: '10' }), ...extras].join('\t');
    const { records, stats } = await build(
      [
        row(ean13('841000000011'), 'Completo', ['3.2', '5.5', '1.25', '']),
        row(ean13('841000000012'), 'Solo sodio', ['', '', '', '0.4']),
        row(ean13('841000000013'), 'Azúcares imposibles', ['2', '60', '0.1', '']),
        row(ean13('841000000014'), 'Sal imposible', ['2', '5', '80', '']),
        row(ean13('841000000015'), 'Vacío', ['', '', '', '']),
      ],
      ['en:spain'],
      header,
    );
    const by = (name: string) => records.find((r) => r.name === name);
    expect(by('Completo')).toMatchObject({ fiberG: 3.2, sugarsG: 5.5, saltG: 1.25 });
    expect(by('Solo sodio')).toMatchObject({ fiberG: null, sugarsG: null, saltG: 1 }); // 0,4 g de sodio = 1 g de sal
    expect(by('Azúcares imposibles')).toMatchObject({ fiberG: 2, sugarsG: null, saltG: 0.1 }); // más azúcares que hidratos: ese dato se descarta
    expect(by('Sal imposible')).toMatchObject({ fiberG: 2, sugarsG: 5, saltG: null });
    expect(by('Vacío')).toMatchObject({ fiberG: null, sugarsG: null, saltG: null });
    expect(stats).toMatchObject({ kept: 5, withFiber: 3, withSugars: 2, withSalt: 3 });
  });

  it('un código al que el volcado quitó el cero de delante se recupera', async () => {
    const { records } = await build([line({ code: '12345678905', name: 'Con cero perdido', kcal: '100' })]);
    expect(records.map((r) => r.code)).toEqual(['0012345678905']);
  });

  it('admite varios países y una cabecera con BOM', async () => {
    const rows = [line({ code: YOGURT, name: 'Español', kcal: '61' }), line({ code: ean13('560000000001'), name: 'Portugués', countries: 'en:portugal', kcal: '50' }), line({ code: ean13('300000000001'), name: 'Francés', countries: 'en:france', kcal: '50' })];
    const { records } = await buildRecords(['﻿' + HEADER.join('\t'), ...rows], { countries: ['en:spain', 'en:portugal'] });
    expect(records.map((r) => r.name).sort()).toEqual(['Español', 'Portugués']);
  });

  it('sin la columna de etiquetas de país usa la de nombres en inglés', async () => {
    const header = HEADER.map((name) => (name === 'countries_tags' ? 'countries_en' : name));
    const { records } = await build([line({ code: YOGURT, name: 'Sí', countries: 'Spain, France', kcal: '61' }), line({ code: ean13('300000000001'), name: 'No', countries: 'France', kcal: '61' })], ['en:spain'], header);
    expect(records.map((r) => r.name)).toEqual(['Sí']);
  });

  it('si el volcado ya no trae `brands` (ahora `brands_en` y `brands_tags`), toma la marca de la que haya', async () => {
    const header = HEADER.map((name) => (name === 'brands' ? 'brands_en' : name));
    const { records } = await build([line({ code: YOGURT, name: 'Yogur', brands: 'Marca A, Otra', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' })], ['en:spain'], header);
    expect(records[0]?.brand).toBe('Marca A');
    const tagsOnly = HEADER.map((name) => (name === 'brands' ? 'brands_tags' : name));
    const { records: tagged } = await build([line({ code: YOGURT, name: 'Yogur', brands: 'marca-a,otra', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' })], ['en:spain'], tagsOnly);
    expect(tagged[0]?.brand).toBe('Marca A');
  });

  it('las marcas que vienen como etiquetas («espana-e-hijos») se pasan a palabras; las que ya son texto se dejan', () => {
    expect(readableBrand('lidl')).toBe('Lidl');
    expect(readableBrand('espana-e-hijos')).toBe('Espana e Hijos');
    expect(readableBrand('con-r-de-monegros')).toBe('Con R de Monegros');
    expect(readableBrand('Con R de Monegros')).toBe('Con R de Monegros');
    expect(readableBrand('España e Hijos')).toBe('España e Hijos');
    expect(readableBrand('4-8')).toBe('4-8'); // sin letras no es una etiqueta de marca
    expect(readableBrand('')).toBe('');
  });

  it('sin ninguna columna de marca falla diciéndolo, y sin las de fibra, azúcares y sal solo avisa en el registro', async () => {
    await expect(build([], ['en:spain'], HEADER.filter((name) => name !== 'brands'))).rejects.toThrow(/brands/);
    const messages: string[] = [];
    const { records } = await buildRecords(lines([line({ code: YOGURT, name: 'Yogur', brands: 'Marca', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' })]), { countries: ['en:spain'], log: (m) => messages.push(m) });
    expect(records).toHaveLength(1);
    expect(records[0]?.fiberG).toBeNull();
    expect(messages.join(' ')).toMatch(/faltan columnas opcionales: fiber_100g, sugars_100g, salt_100g, sodium_100g/);
  });

  it('con una columna imprescindible de menos, falla diciendo cuál', async () => {
    const header = HEADER.filter((name) => name !== 'proteins_100g' && name !== 'carbohydrates_100g');
    await expect(build([], ['en:spain'], header)).rejects.toThrow(/proteins_100g, carbohydrates_100g/);
    await expect(buildRecords([], { countries: ['en:spain'] })).rejects.toThrow(/vacío/);
  });

  it('las raciones imposibles se ignoran y los números con coma valen', async () => {
    const { records } = await build([line({ code: YOGURT, name: 'Coma', serving: '99999', kcal: '61,5', protein: '3,5' })]);
    expect(records[0]).toMatchObject({ kcal: 61.5, proteinG: 3.5, servingG: null });
  });

  it('el resultado se guarda y se vuelve a leer', async () => {
    const { records } = await build([line({ code: YOGURT, name: 'Yogur natural', brands: 'Marca', serving: '125', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' })]);
    const { encodeFoodDb } = await import('../src/domain/food-db');
    const db = new FoodDb(encodeFoodDb(records, { dumpDay: 1 }));
    expect(db.find(YOGURT)).toMatchObject({ name: 'Yogur natural', brand: 'Marca', servingG: 125 });
  });
});

describe('normalizeCode', () => {
  it('acepta EAN-13, EAN-8 y UPC-A buenos y rechaza lo demás', () => {
    expect(normalizeCode(YOGURT)).toBe(YOGURT);
    expect(normalizeCode(' 40170725 ')).toBe('40170725');
    expect(normalizeCode('012345678905')).toBe('012345678905');
    expect(normalizeCode('1234567890123')).toBeNull();
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('84100x0000016')).toBeNull();
  });
});

describe('desde un archivo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartring-foods-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const csv = `${lines([line({ code: YOGURT, name: 'Yogur natural', brands: 'Marca', kcal: '61', protein: '3.5', carbs: '4.7', fat: '3.2' })]).join('\n')}\n`;

  it('lee un CSV suelto y uno con gzip', async () => {
    writeFileSync(join(dir, 'plano.csv'), csv);
    writeFileSync(join(dir, 'comprimido.csv.gz'), gzipSync(csv));
    for (const name of ['plano.csv', 'comprimido.csv.gz']) {
      const out: string[] = [];
      for await (const l of linesOf(join(dir, name))) out.push(l);
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('product_name');
    }
  });

  it('el programa de línea de órdenes escribe la base y su resumen (en Node, sin compilar)', () => {
    writeFileSync(join(dir, 'entrada.csv.gz'), gzipSync(csv));
    const out = join(dir, 'salida');
    execFileSync(process.execPath, ['tools/build-food-db.ts', '--source', join(dir, 'entrada.csv.gz'), '--out', out, '--min', '1', '--date', '2026-10-17'], { cwd: process.cwd(), stdio: 'pipe' });
    const db = new FoodDb(readFileSync(join(out, 'productos-es.bin')));
    expect(db.count).toBe(1);
    expect(db.find(YOGURT)?.name).toBe('Yogur natural');
    const summary = JSON.parse(readFileSync(join(out, 'productos-es.json'), 'utf8')) as { count: number; dumpDate: string; license: string; samples: Array<{ code: string }> };
    expect(summary).toMatchObject({ count: 1, dumpDate: '2026-10-17', license: 'ODbL 1.0' });
    expect(summary.samples[0]?.code).toBe(YOGURT);
  });

  it('falla con un código de salida distinto de cero si salen menos productos de los mínimos', () => {
    writeFileSync(join(dir, 'entrada2.csv'), csv);
    expect(() => execFileSync(process.execPath, ['tools/build-food-db.ts', '--source', join(dir, 'entrada2.csv'), '--out', join(dir, 'salida2'), '--min', '5'], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
  });
});
