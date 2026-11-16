import { expect, openUserSection, test } from './fixtures';
import type { Page } from '@playwright/test';

// La actualización automática: con la app a la vista, los datos del anillo se traen solos (los pasos cada minuto y el historial
// cada diez). En la demostración solo está encendida con `?auto=1`: las demás pruebas cuentan lo que hace el anillo simulado.

/** El reloj del navegador, controlable (en la ejecución con `FAKE_NOW` ya lo instala el fixture). */
async function controlClock(page: Page): Promise<void> {
  if (!process.env.FAKE_NOW) await page.clock.install({ time: new Date() });
}

/** Cuántas sincronizaciones completas hay guardadas (la demostración trae una de hace 2 h). */
const syncCount = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('syncs').objectStore('syncs').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });

/** Pone la página «oculta» o «a la vista» como lo haría Android al pasar a otra app o al apagar la pantalla. */
const setVisibility = (page: Page, state: 'hidden' | 'visible'): Promise<void> =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

async function openAuto(page: Page): Promise<void> {
  await controlClock(page);
  await page.goto('/?demo=1&auto=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
}

test('con la app abierta, el anillo se sincroniza solo, sin pulsar nada y sin avisos ni barras de progreso', async ({ page }) => {
  await openAuto(page);
  expect(await syncCount(page)).toBe(1); // la demostración parte de una sincronización de hace 2 h
  // A los pocos segundos de abrir, la automática trae el historial (la última completa es de hace horas).
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(2);

  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos', exact: true }).getByRole('region', { name: 'Anillo', exact: true });
  await expect(sheet.locator('.ring-hero')).toContainText('Última sincronización ahora mismo');
  // Fue en silencio: la hoja no enseña progreso ni informe de algo que nadie pidió, y no hay avisos.
  await expect(sheet.getByRole('list', { name: 'Resultado de la sincronización' })).toHaveCount(0);
  await expect(sheet.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /sincroniza|Se está/i })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Sincronizar ahora' })).toBeEnabled();
});

test('pasados diez minutos con la app abierta, vuelve a traer el historial por su cuenta', async ({ page }) => {
  await openAuto(page);
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(2);

  await page.clock.fastForward(11 * 60_000);
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(3);
});

test('con la app oculta no toca el anillo, y al volver a verla se pone al día enseguida', async ({ page }) => {
  await openAuto(page);
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(2);

  await setVisibility(page, 'hidden');
  await page.clock.fastForward(30 * 60_000);
  await page.waitForTimeout(2500);
  expect(await syncCount(page)).toBe(2);

  await setVisibility(page, 'visible');
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(3);
});

test('se puede apagar en «Objetivos y medición»: el ajuste se recuerda y sin él solo se sincroniza al pulsar', async ({ page }) => {
  await openAuto(page);
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(2);

  const goals = await openUserSection(page, 'Objetivos y medición');
  const toggle = goals.getByRole('checkbox', { name: /Actualizar automáticamente/ });
  await expect(toggle).toBeChecked(); // encendido de serie
  await goals.locator('label.switch', { hasText: 'Actualizar automáticamente' }).click(); // la pista del interruptor tapa a la casilla
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.clock.fastForward(30 * 60_000);
  await page.waitForTimeout(2500);
  expect(await syncCount(page)).toBe(2); // nada solo

  // El botón de siempre sigue funcionando.
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  await page.getByRole('dialog', { name: 'Dispositivos', exact: true }).getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect.poll(() => syncCount(page), { timeout: 20_000 }).toBe(3);

  // Y el ajuste sigue apagado al volver a abrir la hoja.
  await page.keyboard.press('Escape');
  const again = await openUserSection(page, 'Objetivos y medición');
  await expect(again.getByRole('checkbox', { name: /Actualizar automáticamente/ })).not.toBeChecked();
});

test('sin pedirlo con ?auto=1 la demostración no habla sola con el anillo (las demás pruebas cuentan sus sincronizaciones)', async ({ page }) => {
  await controlClock(page);
  await page.goto('/?demo=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await page.clock.fastForward(30 * 60_000);
  await page.waitForTimeout(2500);
  expect(await syncCount(page)).toBe(1);
});
