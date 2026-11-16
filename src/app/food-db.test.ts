import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDigit } from '../domain/barcode';
import { encodeFoodDb, FoodDb, type ProductRecord } from '../domain/food-db';
import { estimateMealFromText } from './food-text';
import type { FoodProduct } from '../domain/nutrition';
import { forgetFoodDb, infoOf, lookupBarcode, openFoodDb, productLookup, suggestCodes, withOwnProducts } from './food-db';
import type { UserProduct } from '../domain/user-products';

const yogurt: ProductRecord = { code: '8410000000016', name: 'Yogur natural', brand: 'Marca', kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2, servingG: 125 };
const water: ProductRecord = { code: '8410000000023', name: 'Agua', brand: '', kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, servingG: null };
const bytes = (): Uint8Array => encodeFoodDb([yogurt, water], { dumpDay: 20_742 }); // 2026-10-16
const db = (): FoodDb => new FoodDb(bytes());

const respond = (body: Uint8Array | null, status = 200): Response => new Response(body ? (body.buffer as ArrayBuffer) : null, { status });

beforeEach(() => forgetFoodDb());
afterEach(() => vi.unstubAllGlobals());

describe('lookupBarcode', () => {
  it('encuentra un producto con su nombre, marca, cifras por 100 g y ración', async () => {
    const result = await lookupBarcode('8410000000016', { db: db() });
    expect(result).toEqual({
      status: 'found',
      product: { barcode: '8410000000016', name: 'Yogur natural · Marca', per100g: { kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2 }, servingG: 125 },
    });
  });

  it('un producto sin marca ni ración se queda con su nombre', async () => {
    const result = await lookupBarcode('8410000000023', { db: db() });
    expect(result).toMatchObject({ status: 'found', product: { name: 'Agua', servingG: null, per100g: { kcal: 0 } } });
  });

  it('un producto que no está dice cuántos hay y de cuándo es la base', async () => {
    expect(await lookupBarcode('8410000000030', { db: db() })).toEqual({ status: 'not-found', info: { count: 2, date: '2026-10-16' } });
  });

  it('un UPC-A se encuentra aunque la base lo tenga como EAN-13 con un cero delante', async () => {
    const upc: ProductRecord = { ...yogurt, code: '0012345678905' };
    const result = await lookupBarcode('012345678905', { db: new FoodDb(encodeFoodDb([upc], { dumpDay: 1 })) });
    expect(result.status).toBe('found');
  });

  it('una búsqueda cancelada mientras se abre la base no devuelve nada', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        return respond(bytes());
      }),
    );
    expect(await lookupBarcode('8410000000016', { signal: controller.signal })).toEqual({ status: 'error', message: 'Búsqueda cancelada.' });
  });

  it('lee la base del archivo de la app una sola vez y la reutiliza', async () => {
    const fetchMock = vi.fn(async () => respond(bytes()));
    vi.stubGlobal('fetch', fetchMock);
    expect((await lookupBarcode('8410000000016')).status).toBe('found');
    expect((await lookupBarcode('8410000000023')).status).toBe('found');
    expect((await lookupBarcode('8410000000030')).status).toBe('not-found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si el archivo no se puede leer, lo dice y la próxima búsqueda lo vuelve a intentar', async () => {
    let healthy = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (healthy ? respond(bytes()) : respond(null, 500))),
    );
    const failed = await lookupBarcode('8410000000016');
    expect(failed).toEqual({ status: 'error', message: expect.stringContaining('base de productos') });
    healthy = true;
    expect((await lookupBarcode('8410000000016')).status).toBe('found');
  });

  it('un archivo dañado también es un error y no se queda guardado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(new TextEncoder().encode('esto no es una base de productos de ninguna manera'))));
    expect((await lookupBarcode('8410000000016')).status).toBe('error');
  });
});

describe('productLookup', () => {
  it('busca por las palabras del nombre en la base dada, y la reutiliza', async () => {
    const database = db();
    const lookup = await productLookup(database);
    expect(lookup).not.toBeNull();
    expect(lookup!(['yogur', 'natural'])[0]).toMatchObject({ name: 'Yogur natural', brand: 'Marca', kcal: 61, servingG: 125 });
    expect(lookup!(['yogur', 'marca'])).toHaveLength(1);
    expect(lookup!(['pizza'])).toEqual([]);
    expect(await productLookup(database)).toBe(lookup);
  });

  it('lee el archivo de la app una sola vez para buscar productos', async () => {
    const fetchMock = vi.fn(async () => respond(bytes()));
    vi.stubGlobal('fetch', fetchMock);
    const first = await productLookup();
    const second = await productLookup();
    expect(first).toBe(second);
    expect(first!(['agua'])).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si la base no se puede leer, no hay buscador (se usa solo la tabla de alimentos) y la próxima vez se vuelve a intentar', async () => {
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn(async () => (healthy ? respond(bytes()) : respond(null, 500))));
    expect(await productLookup()).toBeNull();
    healthy = true;
    expect(await productLookup()).not.toBeNull();
  });
});

describe('openFoodDb', () => {
  it('rechaza una respuesta que no es correcta', async () => {
    await expect(openFoodDb('/x.bin', vi.fn(async () => respond(null, 404)))).rejects.toThrow(/404/);
    await expect(openFoodDb('/x.bin', vi.fn(async () => Promise.reject(new TypeError('red'))))).rejects.toThrow();
  });

  it('abre la base que recibe', async () => {
    const opened = await openFoodDb('/x.bin', vi.fn(async () => respond(bytes())));
    expect(opened.count).toBe(2);
    expect(infoOf(opened)).toEqual({ count: 2, date: '2026-10-16' });
  });
});

// ───────────────────────────── los productos que la persona enseñó ─────────────────────────────

const mine: FoodProduct = { barcode: '8410000000030', name: 'Galletas de la abuela', per100g: { kcal: 480, proteinG: 6, carbsG: 70, fatG: 20 }, servingG: 30, own: true };
/** El buscador de productos propios tal como lo da el almacén: por el código sin ceros delante. */
const ownFinder = (...products: FoodProduct[]) => async (code: string): Promise<FoodProduct | null> => products.find((p) => Number(p.barcode) === Number(code)) ?? null;

describe('lookupBarcode con productos de la persona', () => {
  it('un producto que enseñó la persona sale aunque no esté en la base', async () => {
    expect(await lookupBarcode('8410000000030', { db: db(), own: ownFinder(mine) })).toEqual({ status: 'found', product: mine });
  });

  it('manda sobre el de la base con el mismo código (así se corrige una cifra mal subida)', async () => {
    const corrected: FoodProduct = { barcode: '8410000000016', name: 'Yogur natural (corregido)', per100g: { kcal: 70, proteinG: 4, carbsG: 5, fatG: 3.5 }, servingG: 125, own: true };
    expect(await lookupBarcode('8410000000016', { db: db(), own: ownFinder(corrected) })).toEqual({ status: 'found', product: corrected });
  });

  it('un fallo al leer los productos de la persona no impide buscar en la base', async () => {
    const broken = async (): Promise<FoodProduct | null> => {
      throw new Error('almacén roto');
    };
    expect((await lookupBarcode('8410000000016', { db: db(), own: broken })).status).toBe('found');
  });

  it('sin la base pero con un producto propio, se encuentra igual; sin ninguno de los dos, es un error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(null, 500)));
    expect((await lookupBarcode('8410000000030', { own: ownFinder(mine) })).status).toBe('found');
    expect((await lookupBarcode('8410000000047', { own: ownFinder(mine) })).status).toBe('error');
  });

  it('la caja de 12 (GTIN-14) se encuentra como el producto que lleva dentro', async () => {
    const inner = '841000000001'; // el yogur: 8410000000016
    const box = `1${inner}${checkDigit(`1${inner}`)}`;
    expect(box).toHaveLength(14);
    const result = await lookupBarcode(box, { db: db() });
    expect(result).toMatchObject({ status: 'found', product: { barcode: '8410000000016', name: 'Yogur natural · Marca' } });
    // Y el de la persona, si lo enseñó con el código de la caja o con el de la unidad.
    expect(await lookupBarcode(box, { db: db(), own: ownFinder({ ...mine, barcode: '8410000000016' }) })).toMatchObject({ status: 'found', product: { name: 'Galletas de la abuela' } });
  });
});

describe('suggestCodes: «¿era este?» cuando el código tecleado tiene una cifra mal', () => {
  it('propone el producto conocido a una cifra de distancia (la de control mal tecleada)', async () => {
    expect(await suggestCodes('8410000000019', { db: db() })).toEqual([{ code: '8410000000016', name: 'Yogur natural · Marca' }]); // el mismo nombre con que saldrá el producto
  });

  it('también entre los productos de la persona', async () => {
    expect(await suggestCodes('8410000000037', { db: db(), own: ownFinder(mine) })).toEqual([{ code: '8410000000030', name: 'Galletas de la abuela' }]);
  });

  it('un código que ya es válido, o ninguno parecido conocido, no propone nada', async () => {
    expect(await suggestCodes('8410000000016', { db: db() })).toEqual([]);
    expect(await suggestCodes('8410000000099', { db: db() })).toEqual([]);
    expect(await suggestCodes('123', { db: db() })).toEqual([]);
  });
});

describe('withOwnProducts: contar con palabras lo que comió, con sus productos delante', () => {
  const galletas: UserProduct = { barcode: '8410000000030', name: 'Frumbulón Zarandín de la abuela', per100g: { kcal: 400, proteinG: 8, carbsG: 75, fatG: 6 }, servingG: 40, createdMs: 1, updatedMs: 2 };

  it('sin productos suyos es el mismo buscador', () => {
    const base = (): never[] => [];
    expect(withOwnProducts(base, [])).toBe(base);
    expect(withOwnProducts(null, [])).toBeNull();
  });

  it('un producto suyo se encuentra por las palabras de su nombre, aunque no haya base', () => {
    const lookup = withOwnProducts(null, [galletas]);
    expect(lookup?.(['frumbulón', 'zarandín'])[0]).toMatchObject({ name: 'Frumbulón Zarandín de la abuela', kcal: 400, servingG: 40 });
    expect(lookup?.(['otra', 'cosa'])).toEqual([]);
  });

  it('el analizador de texto lo usa: lo que la tabla no conoce sale con las cifras de su etiqueta', () => {
    const without = estimateMealFromText('200 g de frumbulón zarandín');
    expect(without.status === 'ok' ? without.analysis.items.length : 0).toBe(0);
    const result = estimateMealFromText('200 g de frumbulón zarandín', withOwnProducts(null, [galletas]) ?? undefined);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.analysis.unknown).toEqual([]);
      expect(result.analysis.items[0]).toMatchObject({ kcal: 800 }); // 200 g × 400 kcal / 100 g
    }
  });
});
