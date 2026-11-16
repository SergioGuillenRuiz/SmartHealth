import { expect, test } from './fixtures';

test('el manifiesto es válido y todos sus iconos existen', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifestUrl = new URL(href as string, page.url()).href;
  const manifest = (await (await request.get(manifestUrl)).json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  expect(manifest.name).toBe('SmartHealth');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
  for (const icon of manifest.icons) {
    const response = await request.get(new URL(icon.src, manifestUrl).href);
    expect(response.status(), icon.src).toBe(200);
  }
});

test('tras la primera visita la app abre sin conexión', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Dispositivos:/ })).toBeVisible();
  await expect(page.getByText('Vincula tu anillo para traer tus pasos, sueño y pulso.')).toBeVisible();

  // También con una query (el modo demostración).
  await page.goto('/?demo=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await context.setOffline(false);
});

test('el service worker precachea la app y no intercepta lo que no es suyo', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return { names, urls };
  });
  expect(cached.names).toHaveLength(1);
  expect(cached.names[0]).toMatch(/^smartring-[0-9a-f]{12}$/);
  expect(cached.urls.some((u) => u.endsWith('/index.html'))).toBe(true);
  expect(cached.urls.some((u) => /\/assets\/index-.*\.js$/.test(u))).toBe(true);
  expect(cached.urls.some((u) => u.endsWith('/sw.js'))).toBe(false);
});
