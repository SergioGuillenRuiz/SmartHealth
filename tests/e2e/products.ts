import type { Page } from '@playwright/test';
import { dayOfDate, encodeFoodDb, type ProductRecord } from '../../src/domain/food-db';

/** El código de 13 cifras que empieza por `base12`, con su cifra de control. */
export function ean13(base12: string): string {
  const sum = [...base12].reverse().reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1), 0);
  return `${base12}${(10 - (sum % 10)) % 10}`;
}

/** El producto que ve la cámara falsa de las pruebas (su código está dibujado en el vídeo; ver `camera.ts`). */
export const YOGUR: ProductRecord = { code: '8410000000016', name: 'Yogur natural', brand: 'Marca', kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2, servingG: 125, fiberG: 0, sugarsG: 4.7, saltG: 0.12 };
/** Un aceite: 900 kcal por 100 g, para probar una cantidad que se pasa de lo que admite una comida. */
export const ACEITE: ProductRecord = { code: ean13('841000000002'), name: 'Aceite', brand: '', kcal: 900, proteinG: 0, carbsG: 0, fatG: 100, servingG: null };

/**
 * Cambia la base de productos que lleva la app por una de prueba y cuenta cuántas veces se pide el archivo. La app no usa internet:
 * esta es la única petición que hace una búsqueda de producto, y es a su propio servidor. Se sustituye `fetch` en la página (no con
 * `page.route`): el service worker de la web tiene precacheada la base verdadera y la serviría sin pasar por Playwright.
 */
export async function mockProducts(page: Page, records: ProductRecord[], failWith?: number): Promise<{ requests: () => Promise<number> }> {
  const b64 = Buffer.from(encodeFoodDb(records, { dumpDay: dayOfDate('2026-10-16') })).toString('base64');
  await page.evaluate(
    ({ b64: data, failWith: status }) => {
      const w = window as unknown as { __productRequests?: number; __realFetch?: typeof fetch };
      w.__productRequests = 0;
      w.__realFetch ??= window.fetch.bind(window);
      const real = w.__realFetch;
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!/\/productos-es[^/]*\.bin(\?|$)/.test(url)) return real(input, init);
        w.__productRequests = (w.__productRequests ?? 0) + 1;
        if (status !== undefined) return new Response('no disponible', { status });
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      };
    },
    { b64, failWith },
  );
  return { requests: () => page.evaluate(() => (window as unknown as { __productRequests?: number }).__productRequests ?? 0) };
}

/**
 * Anota toda petición a un sitio que no sea la propia app (las pruebas se hacen contra `127.0.0.1`): la app no debe hablar con nadie.
 * Devuelve la lista, que se comprueba al final de la prueba.
 */
export function watchOutsideRequests(page: Page): string[] {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') outside.push(request.url());
  });
  return outside;
}

/** Un producto de los que enseña la persona, tal como lo guarda la app (`kv`, clave `product:<código sin ceros delante>`). */
export interface SeedProduct {
  barcode: string;
  name: string;
  kcal: number;
  servingG?: number;
}

/**
 * Deja guardados productos «enseñados» directamente en el almacén de la demostración (sin pasar por el formulario): las pruebas de la pantalla «Mis productos»
 * necesitan una lista con varios. La pantalla los lee del almacén al abrirse, así que no hace falta recargar.
 */
export async function seedUserProducts(page: Page, products: SeedProduct[]): Promise<void> {
  await page.evaluate(async (items) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      items.forEach((item, i) => {
        const when = Date.UTC(2026, 9, 1 + i);
        tx.objectStore('kv').put(
          { barcode: item.barcode, name: item.name, per100g: { kcal: item.kcal, proteinG: 5, carbsG: item.kcal / 8, fatG: 5 }, servingG: item.servingG ?? null, createdMs: when, updatedMs: when },
          `product:${Number(item.barcode)}`,
        );
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, products);
}
