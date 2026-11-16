import { devices, expect } from '@playwright/test';
import { test } from '../e2e/fixtures';

// Lo que reparte el servidor de la beta web (`beta-web/`) y cómo lo recibe un móvil: instalable (service worker y manifiesto), con todos sus archivos y sin desbordar en un iPhone.
// Se lanza contra la carpeta del ZIP ya arrancada: `BETA_URL=http://127.0.0.1:8123 npm run e2e:beta`.

test('el service worker se registra y todo lo que precachea se sirve con éxito (también el .wasm del lector)', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Actividad diaria' }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null)).toBe('activated');

  const script = await (await request.get('/sw.js')).text();
  const listed = /const PRECACHE = (\[.*?\]);/s.exec(script)?.[1];
  expect(listed, 'sw.js lleva la lista de archivos').toBeTruthy();
  const files = JSON.parse(listed as string) as string[];
  expect(files.length).toBeGreaterThan(50);
  const missing: string[] = [];
  for (const file of files) {
    const response = await request.get(new URL(file, page.url()).toString());
    if (response.status() !== 200) missing.push(`${file} → ${response.status()}`);
  }
  expect(missing).toEqual([]);

  const wasm = files.find((file) => file.endsWith('.wasm'));
  if (wasm) expect((await request.get(new URL(wasm, page.url()).toString())).headers()['content-type']).toBe('application/wasm');
  const ocr = await request.get('/ocr/worker.min.js');
  expect(ocr.status()).toBe(200);
  expect(ocr.headers()['content-type']).toContain('javascript');
});

test('es instalable: manifiesto con nombre, iconos y modo de app', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await request.get(new URL(href as string, page.url()).toString())).json();
  expect(manifest.name).toBeTruthy();
  expect(manifest.display).toMatch(/standalone|fullscreen/);
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons as Array<{ src: string }>) expect((await request.get(new URL(icon.src, new URL(href as string, page.url())).toString())).status()).toBe(200);
});

test('en un iPhone se abre sin errores y sin desbordar en horizontal', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES', timezoneId: 'Europe/Madrid', baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Actividad diaria' }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  await context.close();
});
