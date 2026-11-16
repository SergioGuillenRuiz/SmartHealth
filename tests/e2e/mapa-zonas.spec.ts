import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { FIXTURE_CENTER, overpassCityDetail, overpassCityLight } from '../../src/domain/nav/overpass.test-support';
import { goTab, expect, test } from './fixtures';

// El mapa por zonas (ronda 39): la app no lleva ningún mapa; baja de Overpass el de donde está la persona, lo guarda en el móvil, lo reutiliza y, si sale de la zona, baja el nuevo. Aquí Overpass
// es un servidor de mentira (`page.route`) que contesta con una ciudad pequeña; lo que se prueba es todo lo de la app: esperar al GPS, bajar, enseñar el avance, guardar, reutilizar sin
// internet, reintentar, probar el servidor de respaldo y cambiar de zona. Con datos reales de OpenStreetMap solo se puede probar en el móvil.

// Los servidores de mentira que se caen o se saturan a propósito dejan su aviso de red en la consola del navegador.
test.use({ serviceWorkers: 'block', allowedConsoleErrors: [/Failed to load resource/] });

const HOSTS = ['https://overpass-api.de/**', 'https://overpass.kumi.systems/**'] as const;
const CENTER = { latitude: FIXTURE_CENTER.lat, longitude: FIXTURE_CENTER.lon };
const FAR_EAST = { latitude: FIXTURE_CENTER.lat, longitude: FIXTURE_CENTER.lon + 0.4 };

interface Server {
  /** Las bajadas del mapa que se esperan (calles de la zona). */
  calls: string[];
  /** Las del detalle (edificios y comercios del centro), que desde la ronda 46 se piden aparte y después, sin que nadie espere. */
  detailCalls: string[];
}

/** Overpass de mentira: cada host contesta con lo que diga `answer` (por defecto, la ciudad de prueba centrada en lo que se pidió). */
async function fakeOverpass(page: Page, answer: (host: 'primary' | 'backup', n: number) => 'ok' | 'busy' | 'down' | number = () => 'ok', delayMs = 0): Promise<Server> {
  const server: Server = { calls: [], detailCalls: [] };
  let n = 0;
  for (const [index, host] of HOSTS.entries()) {
    await page.route(host, async (route) => {
      n++;
      const body = route.request().postData() ?? '';
      // La consulta del detalle lleva su propio tiempo máximo (120 s; la de las calles, 180 s).
      const detail = /timeout:120/.test(decodeURIComponent(body.replace(/\+/g, ' ')));
      (detail ? server.detailCalls : server.calls).push(index === 0 ? 'primary' : 'backup');
      if (delayMs > 0 && !detail) await new Promise((r) => setTimeout(r, delayMs));
      const bbox = /bbox:([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)/.exec(decodeURIComponent(body.replace(/\+/g, ' ')));
      const center = bbox ? { lat: (Number(bbox[1]) + Number(bbox[3])) / 2, lon: (Number(bbox[2]) + Number(bbox[4])) / 2 } : FIXTURE_CENTER;
      const verdict = answer(index === 0 ? 'primary' : 'backup', n);
      const headers = { 'access-control-allow-origin': '*' };
      if (verdict === 'ok') return route.fulfill({ json: detail ? overpassCityDetail({ center }) : overpassCityLight({ center }), headers });
      if (verdict === 'busy') return route.fulfill({ status: 429, body: 'busy', headers });
      if (verdict === 'down') return route.abort('connectionrefused');
      return route.fulfill({ status: verdict, body: 'x', headers });
    });
  }
  return server;
}

/** Empieza a caminar con la navegación guiada: se abre sola, así que el mapa empieza a buscarse en cuanto el entreno está en marcha. `offline`: sin red desde antes de empezar. */
async function startWalk(page: Page, context: BrowserContext, position = CENTER, offline = false): Promise<Locator> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ ...position, accuracy: 5 });
  await page.goto('/?demo=1&mapdl=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await goTab(page, 'Deportes');
  await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
  const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
  await ready.getByLabel('Navegación guiada').setChecked(true);
  if (offline) await context.setOffline(true);
  await ready.getByRole('button', { name: 'Iniciar' }).click();
  const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
  await expect(live.getByText('En marcha')).toBeVisible({ timeout: 20_000 });
  return live;
}

/** La navegación vive en la pestaña del mapa (la segunda). */
const guide = (live: Locator): Locator => live.locator('.live__pane').nth(1);
/** La navegación guiada se abre sola al empezar; esto solo la vuelve a abrir si se cerró. */
const openGuide = async (live: Locator): Promise<void> => {
  const open = guide(live).getByRole('button', { name: /A dónde vamos/ });
  if (await open.isVisible()) await open.click();
};

/** Las zonas guardadas en el móvil (lo que hay en la base de los mapas). */
const storedZones = (page: Page): Promise<Array<{ id: string; name: string; bytes: number; detailMs?: number }>> =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('smartring-maps');
        open.onerror = () => reject(open.error);
        open.onupgradeneeded = () => {
          open.transaction?.abort();
          resolve([]);
        };
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('meta', 'readonly').objectStore('meta').getAll();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );

test.describe('el mapa por zonas', () => {
  test('la primera vez baja el mapa de tu zona (enseñando que baja), lo guarda y deja buscar y ver la ruta', async ({ page, context }) => {
    const server = await fakeOverpass(page, () => 'ok', 700);
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live)).toContainText('Bajando el mapa de tu zona');
    await expect(guide(live)).toContainText('Por eso tarda: es la primera vez en esta zona');
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    expect(server.calls).toEqual(['primary']);
    const zones = await storedZones(page);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.name).toBe('Barrio Centro');
    expect(zones[0]!.bytes).toBeGreaterThan(5_000);
    // El detalle (edificios y comercios) llega después y se funde con lo guardado (la zona queda marcada con la hora en que lo recibió) sin que se vuelvan a pedir las calles.
    await expect.poll(async () => (await storedZones(page))[0]?.detailMs ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await storedZones(page))[0]!.bytes).toBeGreaterThan(zones[0]!.bytes - 1);
    expect(server.calls).toEqual(['primary']);
    expect(server.detailCalls).toEqual(['primary']);

    await guide(live).getByLabel('Destino').fill('parque ciud');
    await guide(live).getByRole('button', { name: /Parque de la Ciudadela/ }).click();
    await expect(guide(live).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Mapa con la ruta hasta el destino' })).toBeVisible();
    await expect(guide(live)).toContainText(/\d+ min/);
  });

  test('la siguiente vez se abre de lo guardado, sin internet y sin volver a bajar nada', async ({ page, context }) => {
    const server = await fakeOverpass(page);
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    expect(server.calls).toHaveLength(1);
    await guide(live).getByRole('button', { name: 'Cerrar la navegación' }).click();
    await expect(guide(live).getByRole('button', { name: /A dónde vamos/ })).toBeVisible();
    // Ahora Overpass «se cae» y el móvil se queda sin red: lo guardado sirve.
    await page.unroute(HOSTS[0]);
    await page.unroute(HOSTS[1]);
    await context.setOffline(true);
    await openGuide(live);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 10_000 });
    await expect(guide(live)).not.toContainText('Bajando');
    await context.setOffline(false);
    expect(server.calls).toHaveLength(1);
    expect(await storedZones(page)).toHaveLength(1);
  });

  test('lo guardado sigue ahí al reabrir la app', async ({ page, context }) => {
    const server = await fakeOverpass(page);
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    expect(await storedZones(page)).toHaveLength(1);
    expect(server.calls).toHaveLength(1);
  });

  test('sin internet y sin mapa guardado lo dice y deja reintentar', async ({ page, context }) => {
    let up = false;
    const server = await fakeOverpass(page, () => (up ? 'ok' : 'down'));
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live)).toContainText('No se pudo bajar el mapa de esta zona');
    expect(server.calls).toEqual(['primary', 'backup']);
    await expect(guide(live).getByRole('button', { name: 'Reintentar' })).toBeVisible();
    up = true;
    await guide(live).getByRole('button', { name: 'Reintentar' }).click();
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    expect(await storedZones(page)).toHaveLength(1);
  });

  test('con el móvil sin conexión el aviso dice que hace falta internet una vez', async ({ page, context }) => {
    await fakeOverpass(page);
    const live = await startWalk(page, context, CENTER, true);
    await expect(guide(live)).toContainText('hace falta internet una vez');
    await context.setOffline(false);
    await guide(live).getByRole('button', { name: 'Reintentar' }).click();
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
  });

  test('si el primer servidor está saturado usa el de respaldo', async ({ page, context }) => {
    const server = await fakeOverpass(page, (host) => (host === 'primary' ? 'busy' : 'ok'));
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    expect(server.calls).toEqual(['primary', 'backup']);
  });

  test('si sales de la zona mientras eliges destino baja el mapa de la nueva y guarda las dos', async ({ page, context }) => {
    const server = await fakeOverpass(page);
    const live = await startWalk(page, context);
    await openGuide(live);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
    expect(server.calls).toHaveLength(1);
    await context.setGeolocation({ ...FAR_EAST, accuracy: 5 });
    await expect.poll(() => server.calls.length, { timeout: 30_000 }).toBe(2);
    await expect.poll(async () => (await storedZones(page)).length, { timeout: 20_000 }).toBe(2);
    await expect(guide(live).getByLabel('Destino')).toBeVisible();
    await expect(guide(live)).not.toContainText('Bajando la nueva');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`accesibilidad (${scheme}): bajando el mapa y con el aviso de que no hay conexión`, async ({ page, context }) => {
      await page.emulateMedia({ colorScheme: scheme });
      let up = false;
      await fakeOverpass(page, () => (up ? 'ok' : 'down'), 600);
      const live = await startWalk(page, context);
      const axe = async (): Promise<string[]> => {
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('dialog.live .live__pane--map').analyze();
        return results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      };
      await openGuide(live);
      await expect(guide(live)).toContainText('Bajando el mapa de tu zona');
      expect(await axe()).toEqual([]);
      await expect(guide(live).getByRole('button', { name: 'Reintentar' })).toBeVisible({ timeout: 20_000 });
      expect(await axe()).toEqual([]);
      up = true;
      await guide(live).getByRole('button', { name: 'Reintentar' }).click();
      await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 20_000 });
      expect(await axe()).toEqual([]);
    });
  }
});
