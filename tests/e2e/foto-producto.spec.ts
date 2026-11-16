import type { Page } from '@playwright/test';
import { expect, openDemo, test } from './fixtures';

// La foto del producto: una comida anotada con su código de barras pide su foto a Open Food Facts (lo único que la app pide a internet) y, si no hay conexión o foto, sigue con la
// ilustración de siempre sin avisar de nada. En la demostración no se pregunta salvo con `?productimages=1`.

// La línea «Failed to load resource» de la prueba sin conexión es del propio navegador al cortar la petición a propósito, no un error de la app.
test.use({ allowedConsoleErrors: [/net::ERR_INTERNET_DISCONNECTED/] });

const CODE = '5449000000996';
const PHOTO = 'https://images.openfoodfacts.org/images/products/544/900/000/0996/front_es.45.200.jpg';
// Un PNG de 1 × 1 píxel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function seedScannedMeal(page: Page): Promise<void> {
  await page.evaluate(async (code) => {
    const now = Date.now();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const d = new Date(now - 5 * 60_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put([{ id: 'scan-1', tsMs: now - 5 * 60_000, name: 'Coca-Cola', kcal: 139, proteinG: 0, carbsG: 35, fatG: 0, grams: 330, source: 'barcode', barcode: code }], `meals:${key}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, CODE);
}

test('una comida con código de barras enseña la foto del producto de Open Food Facts', async ({ page }) => {
  const asked: string[] = [];
  await page.route('https://world.openfoodfacts.org/**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: { product: { image_front_small_url: PHOTO } }, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('https://images.openfoodfacts.org/**', (route) => route.fulfill({ body: PIXEL, contentType: 'image/png' }));
  await openDemo(page);
  await seedScannedMeal(page);
  await page.goto('/?demo=keep&productimages=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();

  const row = page.getByRole('button', { name: /Coca-Cola/ }).first();
  await expect(row.locator('.meal-thumb--product img')).toHaveAttribute('src', PHOTO);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(`/api/v2/product/${Number(CODE)}.json`);
  // Solo se envía el código del producto, nada de la persona.
  expect(new URL(asked[0] as string).search).toBe('?fields=image_front_small_url,image_front_url,image_small_url');
});

test('sin conexión o sin foto la miniatura sigue siendo la ilustración y no se avisa de nada', async ({ page }) => {
  await page.route('https://world.openfoodfacts.org/**', (route) => route.abort('internetdisconnected'));
  await openDemo(page);
  await seedScannedMeal(page);
  await page.goto('/?demo=keep&productimages=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();

  const row = page.getByRole('button', { name: /Coca-Cola/ }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('.meal-thumb img')).toHaveCount(1); // la ilustración de refresco, no la foto
  await expect(row.locator('.meal-thumb--product')).toHaveCount(0);
  // Ningún aviso: ni toast ni banner.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /conexi|internet|foto/i })).toHaveCount(0);
});

test('en la demostración normal no se pregunta nada a internet', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') outside.push(request.url());
  });
  await openDemo(page);
  await seedScannedMeal(page);
  await page.goto('/?demo=keep');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Coca-Cola/ }).first()).toBeVisible();
  expect(outside).toEqual([]);
});
