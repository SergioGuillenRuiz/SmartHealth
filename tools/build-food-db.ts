// Genera la base de productos del móvil (`src/data/foods/productos-es.bin`) a partir del volcado público de Open Food Facts.
//
//   node tools/build-food-db.ts [--source <url | archivo .csv[.gz]>] [--out <carpeta>] [--countries en:spain,en:portugal] [--min <n>]
//
// Se ejecuta en el CI (el trabajo «Generar la base de productos» de `.github/workflows/android.yml`), que sí tiene internet: la app,
// no. Lee el CSV (separado por tabuladores, ~1 GB comprimido) línea a línea sin guardarlo, se queda con los productos de los países
// pedidos que tengan código de barras válido, nombre y calorías creíbles, y escribe la base binaria (ver `src/domain/food-db.ts`) más
// un resumen en JSON. Los datos son de Open Food Facts (ODbL 1.0, https://world.openfoodfacts.org): ver docs/atribuciones.md.

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { cleanText, dateOfDay, dayOfDate, encodeFoodDb, FOOD_DB_VERSION, MAX_BRAND_CHARS, MAX_NAME_CHARS, type ProductRecord } from '../src/domain/food-db.ts';
import { asNumber, isBarcode, per100gFromLabel } from '../src/domain/food-label.ts';

export const DEFAULT_SOURCE = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
export const DEFAULT_COUNTRIES = ['en:spain'] as const;

export interface BuildOptions {
  /** Etiquetas de país de Open Food Facts (`en:spain`). Un producto entra si está en alguno. */
  countries: readonly string[];
  /** Aviso de avance cada tantas líneas (0 = nunca). */
  progressEvery?: number;
  log?: (message: string) => void;
}

export interface BuildStats {
  /** Productos que traen fibra, azúcares y sal (de los que se quedan). */
  withFiber?: number;
  withSugars?: number;
  withSalt?: number;
  rows: number;
  malformed: number;
  otherCountry: number;
  badBarcode: number;
  noName: number;
  noNutrition: number;
  duplicates: number;
  kept: number;
}

/**
 * Una copia propia de un texto. Los trozos de `line.split('\t')` son «rebanadas» de la línea entera (hasta varios KB): si se guardaran
 * tal cual, cada producto mantendría viva su línea completa y con cientos de miles de productos se agotaría la memoria.
 */
const detach = (text: string): string => Buffer.from(text, 'utf8').toString('utf8');

const REQUIRED = ['code', 'product_name', 'serving_quantity', 'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g'] as const;
/** La marca: el volcado de Open Food Facts la traía en `brands` y ahora trae `brands_en` (texto) y `brands_tags` (etiquetas); se usa la primera que haya. */
const BRAND_COLUMNS = ['brands', 'brands_en', 'brands_tags'] as const;
/** Columnas que se usan si están (si el volcado no las trae, los productos quedan sin ese dato; no es un error). */
const OPTIONAL = ['fiber_100g', 'sugars_100g', 'salt_100g', 'sodium_100g'] as const;

const BRAND_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'and', 'of', 'the']);

/**
 * Las columnas de marca nuevas del volcado traen etiquetas («espana-e-hijos», «lidl»), sin mayúsculas ni tildes: se pasan a palabras
 * («Espana e Hijos», «Lidl»). Un texto que ya viene escrito con mayúsculas, espacios o tildes se deja tal cual.
 */
export function readableBrand(raw: string): string {
  if (!/^[a-z0-9-]+$/.test(raw) || !/[a-z]/.test(raw)) return raw;
  return raw
    .split('-')
    .filter((word) => word !== '')
    .map((word, at) => (at > 0 && BRAND_CONNECTORS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/** `en:spain` → «spain», para comparar con la columna de países en inglés si no hay etiquetas. */
const countryName = (tag: string): string => tag.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ').toLowerCase();

/** Un código de barras bueno (con ceros delante si el volcado se los quitó), o `null`. */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim();
  if (!/^\d+$/.test(code)) return null;
  if (isBarcode(code)) return code;
  if (code.length < 13) {
    const padded = code.padStart(13, '0');
    if (isBarcode(padded)) return padded;
  }
  return null;
}

/**
 * Convierte las líneas del CSV (la primera es la cabecera) en los productos que entran en la base. Lanza si falta alguna columna
 * imprescindible: el formato del volcado es de Open Food Facts y si cambia, es mejor un error claro que una base vacía.
 */
export async function buildRecords(lines: AsyncIterable<string> | Iterable<string>, options: BuildOptions): Promise<{ records: ProductRecord[]; stats: BuildStats }> {
  const log = options.log ?? (() => undefined);
  const wanted = new Set(options.countries.map((tag) => tag.toLowerCase()));
  const wantedNames = new Set(options.countries.map(countryName));
  const stats: BuildStats = { rows: 0, malformed: 0, otherCountry: 0, badBarcode: 0, noName: 0, noNutrition: 0, duplicates: 0, kept: 0 };
  const byCode = new Map<string, ProductRecord>();

  let index: Record<string, number> | null = null;
  let width = 0;
  let countriesColumn: { at: number; kind: 'tags' | 'names' } | null = null;
  let brand: string = BRAND_COLUMNS[0];
  let isHeader = true;

  for await (const rawLine of lines) {
    if (isHeader) {
      isHeader = false;
      const header = rawLine.replace(/^﻿/, '').split('\t');
      index = Object.fromEntries(header.map((name, at) => [name, at]));
      const brandColumn = BRAND_COLUMNS.find((name) => index![name] !== undefined);
      const missing: string[] = REQUIRED.filter((name) => index![name] === undefined);
      if (brandColumn === undefined) missing.push(BRAND_COLUMNS[0]);
      if (missing.length > 0) throw new Error(`Al volcado le faltan columnas: ${missing.join(', ')}. Cabecera (${header.length} columnas): ${header.slice(0, 40).join(', ')}…`);
      brand = brandColumn!;
      const absent = OPTIONAL.filter((name) => index![name] === undefined);
      // Si el volcado cambia de nombres, el registro del CI dice qué columnas de nutrientes trae en su lugar.
      if (absent.length > 0) log(`Al volcado le faltan columnas opcionales: ${absent.join(', ')}. Parecidas: ${header.filter((name) => /fib|sugar|salt|sodium/i.test(name)).join(', ') || 'ninguna'}.`);
      const tags = index.countries_tags;
      const names = index.countries_en ?? index.countries;
      if (tags !== undefined) countriesColumn = { at: tags, kind: 'tags' };
      else if (names !== undefined) countriesColumn = { at: names, kind: 'names' };
      else throw new Error('Al volcado le falta la columna de países (countries_tags).');
      width =
        Math.max(...REQUIRED.map((name) => index![name]!), index[brand]!, ...OPTIONAL.map((name) => index![name] ?? 0), countriesColumn.at, index.generic_name ?? 0, index['energy-kj_100g'] ?? 0, index.energy_100g ?? 0) + 1;
      continue;
    }
    if (rawLine === '') continue;
    stats.rows++;
    if (options.progressEvery && stats.rows % options.progressEvery === 0) log(`  ${stats.rows.toLocaleString('en-US')} líneas · ${byCode.size.toLocaleString('en-US')} productos`);
    const cols = rawLine.split('\t');
    if (cols.length < width) {
      stats.malformed++;
      continue;
    }
    const idx = index!;
    const cell = (name: string): string => (idx[name] === undefined ? '' : (cols[idx[name]!] ?? ''));

    const countriesCell = (cols[countriesColumn!.at] ?? '').toLowerCase();
    const inCountry =
      countriesColumn!.kind === 'tags'
        ? countriesCell.split(',').some((tag) => wanted.has(tag.trim()))
        : countriesCell.split(',').some((name) => wantedNames.has(name.trim()));
    if (!inCountry) {
      stats.otherCountry++;
      continue;
    }

    const code = normalizeCode(cell('code'));
    if (code === null) {
      stats.badBarcode++;
      continue;
    }
    const name = cleanText(cell('product_name') || cell('generic_name'), MAX_NAME_CHARS);
    if (name === '') {
      stats.noName++;
      continue;
    }
    const per100g = per100gFromLabel({
      kcal: cell('energy-kcal_100g'),
      kj: cell('energy-kj_100g') || cell('energy_100g'),
      protein: cell('proteins_100g'),
      carbs: cell('carbohydrates_100g'),
      fat: cell('fat_100g'),
      fiber: cell('fiber_100g'),
      sugars: cell('sugars_100g'),
      salt: cell('salt_100g'),
      sodium: cell('sodium_100g'),
    });
    if (per100g === null) {
      stats.noNutrition++;
      continue;
    }
    if (byCode.has(code)) {
      stats.duplicates++;
      continue;
    }
    const serving = asNumber(cell('serving_quantity'));
    byCode.set(detach(code), {
      code: detach(code),
      name: detach(name),
      brand: detach(cleanText(readableBrand((cell(brand).split(',')[0] ?? '').trim()), MAX_BRAND_CHARS)),
      kcal: per100g.kcal,
      proteinG: per100g.proteinG,
      carbsG: per100g.carbsG,
      fatG: per100g.fatG,
      fiberG: per100g.fiberG ?? null,
      sugarsG: per100g.sugarsG ?? null,
      saltG: per100g.saltG ?? null,
      servingG: serving !== null && serving > 0 && serving <= 2000 ? Math.round(serving) : null,
    });
  }
  if (isHeader) throw new Error('El volcado está vacío.');
  stats.kept = byCode.size;
  const kept = [...byCode.values()];
  stats.withFiber = kept.filter((record) => record.fiberG !== null).length;
  stats.withSugars = kept.filter((record) => record.sugarsG !== null).length;
  stats.withSalt = kept.filter((record) => record.saltG !== null).length;
  return { records: [...byCode.values()], stats };
}

/** Las líneas de un origen (URL o archivo; con o sin gzip), una a una. */
export async function* linesOf(source: string): AsyncGenerator<string> {
  let input: Readable;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`No se pudo descargar ${source}: ${response.status}`);
    input = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
  } else {
    input = createReadStream(source);
  }
  // ¿gzip? Se mira la firma del archivo (1f 8b) en vez de fiarse del nombre: algunos servidores descomprimen por el camino.
  const chunks = input[Symbol.asyncIterator]();
  const first = await chunks.next();
  if (first.done) throw new Error('El origen está vacío.');
  const firstChunk = first.value as Buffer;
  const gzip = firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
  const rest = Readable.from(
    (async function* () {
      yield firstChunk;
      while (true) {
        const next = await chunks.next();
        if (next.done) return;
        yield next.value as Buffer;
      }
    })(),
  );
  const text = gzip ? rest.pipe(createGunzip()) : rest;
  rest.on('error', (error) => text.destroy(error));
  for await (const line of createInterface({ input: text, crlfDelay: Infinity })) yield line;
}

interface CliArgs {
  source: string;
  out: string;
  countries: string[];
  min: number;
  name: string;
  date?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { source: DEFAULT_SOURCE, out: 'src/data/foods', countries: [...DEFAULT_COUNTRIES], min: 1000, name: 'productos-es' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Falta el valor de ${flag}`);
    i++;
    if (flag === '--source') args.source = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--countries') args.countries = value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
    else if (flag === '--min') args.min = Number(value);
    else if (flag === '--name') args.name = value;
    else if (flag === '--date') args.date = value;
    else throw new Error(`Opción desconocida: ${flag}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (message: string): void => console.error(message);
  log(`Leyendo ${args.source} (países: ${args.countries.join(', ')})…`);
  const started = Date.now();
  const { records, stats } = await buildRecords(linesOf(args.source), { countries: args.countries, progressEvery: 500_000, log });
  log(`Hecho en ${Math.round((Date.now() - started) / 1000)} s: ${JSON.stringify(stats)}`);
  if (stats.malformed > stats.rows * 0.05) throw new Error(`Demasiadas líneas mal formadas (${stats.malformed} de ${stats.rows}): ¿ha cambiado el formato del volcado?`);
  if (records.length < args.min) throw new Error(`Solo ${records.length} productos (se esperaban al menos ${args.min}): ¿ha cambiado el formato del volcado?`);

  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const bytes = encodeFoodDb(records, { dumpDay: dayOfDate(date) });
  await mkdir(args.out, { recursive: true });
  await writeFile(`${args.out}/${args.name}.bin`, bytes);
  const samples = records.filter((r) => r.brand !== '').slice(0, 5).map((r) => ({ code: r.code, name: r.name, brand: r.brand }));
  const summary = {
    format: FOOD_DB_VERSION,
    source: 'Open Food Facts',
    license: 'ODbL 1.0',
    url: args.source,
    countries: args.countries,
    dumpDate: dateOfDay(dayOfDate(date)),
    builtAt: new Date().toISOString(),
    count: records.length,
    bytes: bytes.length,
    samples,
    stats,
  };
  await writeFile(`${args.out}/${args.name}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  log(`Escritos ${args.out}/${args.name}.bin (${(bytes.length / 1e6).toFixed(1)} MB, ${records.length.toLocaleString('en-US')} productos) y ${args.name}.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
