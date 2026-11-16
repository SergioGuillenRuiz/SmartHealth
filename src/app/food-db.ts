import dbUrl from '../data/foods/productos-es.bin?url';
import { lookupCodes, neighbourCodes } from '../domain/barcode';
import { dateOfDay, FoodDb } from '../domain/food-db';
import { ProductSearch, readableName, type ProductHit } from '../domain/food-db-search';
import type { ProductLookup } from '../domain/food-text';
import { MAX_MEAL_NAME, type FoodProduct } from '../domain/nutrition';
import { searchUserProducts, type UserProduct } from '../domain/user-products';

// Buscar un producto por su código de barras en la base del móvil: los alimentos envasados de España de Open Food Facts, recortados a lo
// que hace falta para anotar una comida (nombre, marca, calorías y nutrientes por 100 g, ración) y metidos dentro de la app al
// compilarla (ver `tools/build-food-db.ts`). La app NO usa internet: lo que no está en la base se anota a mano.

export interface FoodDbInfo {
  /** Productos que hay en la base. */
  count: number;
  /** Día (`AAAA-MM-DD`) de los datos de Open Food Facts de los que sale. */
  date: string;
}

export type LookupResult = { status: 'found'; product: FoodProduct } | { status: 'not-found'; info: FoodDbInfo } | { status: 'error'; message: string };

let shared: Promise<FoodDb> | null = null;

/**
 * La base de productos, leída del archivo de la app (unos MB) la primera vez que se necesita y reutilizada después. Si falla la lectura,
 * la próxima búsqueda lo vuelve a intentar.
 */
export function openFoodDb(url: string = dbUrl, fetchFn: typeof fetch = fetch): Promise<FoodDb> {
  const opening = (async () => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`No se pudo leer la base de productos (${response.status}).`);
    return new FoodDb(await response.arrayBuffer());
  })();
  return opening;
}

function sharedFoodDb(): Promise<FoodDb> {
  if (shared === null) {
    const opening = openFoodDb();
    shared = opening;
    opening.catch(() => {
      if (shared === opening) shared = null;
    });
  }
  return shared;
}

/** Olvida la base ya leída (las pruebas). */
export function forgetFoodDb(): void {
  shared = null;
  lookups = new WeakMap();
}

let lookups = new WeakMap<FoodDb, ProductLookup>();

/**
 * Para buscar productos por las palabras de su nombre («kinder bueno white») al calcular lo que la persona escribe: la base de la app, abierta si hace
 * falta, y su buscador, preparado una sola vez. `null` si la base no se puede leer (entonces el cálculo usa solo la tabla de alimentos).
 */
export async function productLookup(db?: FoodDb): Promise<ProductLookup | null> {
  let opened: FoodDb;
  try {
    opened = db ?? (await sharedFoodDb());
  } catch {
    return null;
  }
  let lookup = lookups.get(opened);
  if (lookup === undefined) {
    const search = new ProductSearch(opened);
    lookup = (words) => search.find(words);
    lookups.set(opened, lookup);
    whenIdle(() => search.warm());
  }
  return lookup;
}

/** Hace `run` cuando el móvil no tiene nada mejor que hacer (o enseguida, si no sabe decirlo). */
function whenIdle(run: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 3000 });
  else setTimeout(run, 100);
}

export const infoOf = (db: FoodDb): FoodDbInfo => ({ count: db.count, date: dateOfDay(db.dumpDay) });

/** Cómo se llama un producto de la base al enseñarlo: su nombre legible y, si el nombre no la lleva ya, la marca («Yogur natural · Marca»). */
function displayName(record: { name: string; brand: string }): string {
  const shown = readableName(record.name, record.brand);
  return [shown, shown === record.name ? record.brand : ''].filter((part) => part !== '').join(' · ') || 'Producto';
}

/** Busca un producto de la persona (el que enseñó con su etiqueta) por su código: así lo pide `lookupBarcode`, sin saber dónde se guarda. */
export type OwnProductFinder = (code: string) => Promise<FoodProduct | null>;

/**
 * Busca un producto por su código. Primero entre los que la persona enseñó (`own`), que mandan sobre la base, y luego en la base de la app. Se prueban también los
 * códigos que valen para el mismo producto (el de la unidad que hay dentro de una caja: ver `lookupCodes`). Un producto que no está es `not-found` (la persona
 * puede enseñarlo o anotarlo a mano). Solo es `error` si la propia base no se puede leer y no estaba entre los de la persona.
 */
export async function lookupBarcode(code: string, options: { db?: FoodDb; signal?: AbortSignal; own?: OwnProductFinder } = {}): Promise<LookupResult> {
  const codes = lookupCodes(code);
  if (options.own !== undefined) {
    for (const candidate of codes) {
      try {
        const mine = await options.own(candidate);
        if (mine !== null) return { status: 'found', product: mine };
      } catch {
        /* sin leer los productos propios: se sigue con la base */
      }
    }
  }
  let db: FoodDb;
  try {
    db = options.db ?? (await sharedFoodDb());
  } catch {
    return { status: 'error', message: 'No se pudo abrir la base de productos de la app. Anota la comida a mano.' };
  }
  if (options.signal?.aborted) return { status: 'error', message: 'Búsqueda cancelada.' };
  for (const candidate of codes) {
    const record = db.find(candidate);
    if (record === null) continue;
    return {
      status: 'found',
      product: {
        barcode: candidate,
        name: displayName(record).slice(0, MAX_MEAL_NAME),
        per100g: {
          kcal: record.kcal,
          proteinG: record.proteinG,
          carbsG: record.carbsG,
          fatG: record.fatG,
          ...(record.fiberG != null ? { fiberG: record.fiberG } : {}),
          ...(record.sugarsG != null ? { sugarsG: record.sugarsG } : {}),
          ...(record.saltG != null ? { saltG: record.saltG } : {}),
        },
        servingG: record.servingG,
      },
    };
  }
  return { status: 'not-found', info: infoOf(db) };
}

/** Un código que se parece al tecleado y sí tiene producto: para decir «¿era este?». */
export interface CodeSuggestion {
  code: string;
  name: string;
}

/**
 * Los códigos que difieren del tecleado en una sola cifra, tienen su cifra de control bien y son de un producto conocido (de la persona o de la base): lo que
 * se quiso teclear cuando el código no es válido. Vacío si ninguno lo es.
 */
export async function suggestCodes(typed: string, options: { db?: FoodDb; own?: OwnProductFinder } = {}): Promise<CodeSuggestion[]> {
  const candidates = neighbourCodes(typed);
  if (candidates.length === 0) return [];
  let db: FoodDb | null = null;
  try {
    db = options.db ?? (await sharedFoodDb());
  } catch {
    db = null;
  }
  const found: CodeSuggestion[] = [];
  for (const code of candidates) {
    let name: string | null = null;
    try {
      name = (await options.own?.(code))?.name ?? null;
    } catch {
      name = null;
    }
    if (name === null && db !== null) {
      const record = db.find(code);
      if (record !== null) name = displayName(record);
    }
    if (name !== null) found.push({ code, name: name.slice(0, MAX_MEAL_NAME) });
  }
  return found.slice(0, 3);
}

/**
 * El buscador por palabras con los productos de la persona delante: al contar con palabras lo que comió («galletas de la abuela»), sus productos mandan
 * sobre los de la base. Sin productos suyos, el mismo buscador.
 */
export function withOwnProducts(base: ProductLookup | null, own: readonly UserProduct[]): ProductLookup | null {
  if (own.length === 0) return base;
  return (words) => {
    const mine = searchUserProducts(own, words).map(
      (product): ProductHit => ({
        name: product.name,
        brand: '',
        kcal: product.per100g.kcal,
        proteinG: product.per100g.proteinG,
        carbsG: product.per100g.carbsG,
        fatG: product.per100g.fatG,
        servingG: product.servingG,
        ...(product.per100g.fiberG !== undefined ? { fiberG: product.per100g.fiberG } : {}),
        ...(product.per100g.sugarsG !== undefined ? { sugarsG: product.per100g.sugarsG } : {}),
        ...(product.per100g.saltG !== undefined ? { saltG: product.per100g.saltG } : {}),
      }),
    );
    return [...mine, ...(base?.(words) ?? [])];
  };
}
