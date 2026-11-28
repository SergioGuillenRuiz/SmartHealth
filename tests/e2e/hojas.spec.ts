import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, test } from './fixtures';

// El aspecto común de las hojas (ronda 53, `styles/sheets-v2.css`) y la valoración de la comida con su fondo propio: que la versión esté puesta, que los bloques tengan las mismas esquinas
// y que lo nuevo no se lleve por delante el código de colores de las filas de la valoración.

const sheet = (page: Page, name: string): Locator => page.getByRole('dialog', { name, exact: true });
const radius = (locator: Locator): Promise<string> => locator.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);

/** Anota una comida con palabras para tener una en la lista de hoy (con otra fecha de la demostración, a las 00:20, no hay ninguna de hoy). */
async function logMeal(page: Page, text: string): Promise<void> {
  await goTab(page, 'Resumen');
  await activePage(page).getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
  const dialog = page.locator('dialog.sheet[open]');
  await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
  await dialog.getByLabel('¿Qué has comido?').fill(text);
  await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
  await dialog.getByRole('button', { name: 'Anotar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Comida anotada' })).toBeVisible();
}

test.describe('hojas con un mismo aspecto', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('la versión 2 del aspecto está puesta en el documento', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-sheets', '2');
  });

  test('la valoración de una comida: bloque plano de 22 px con su medidor de tres tramos (sin dibujos de fondo), y cada criterio es una fila plana que conserva su marca (bien, regular, mal) y su palabra', async ({ page }) => {
    await logMeal(page, 'una barrita de proteínas y un yogur natural');
    await activePage(page).locator('.food-meals__main').first().click();
    const detail = sheet(page, 'Comida');
    const fit = detail.locator('.meal-fit');
    await expect(fit).toBeVisible();
    expect(await radius(fit)).toBe('22px');
    // El medidor es decorativo (el nivel ya va en el título): tres tramos y oculto a los lectores de pantalla; ni imágenes ni marcas de fondo.
    const meter = fit.locator('.meal-fit__meter');
    await expect(meter).toHaveAttribute('aria-hidden', 'true');
    await expect(meter.locator('i')).toHaveCount(3);
    await expect(fit.locator('img, .meal-fit__mark')).toHaveCount(0);
    expect(await fit.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    // El código de colores de siempre: cada fila lleva su nota (is-good / is-ok / is-bad / is-unknown), su marca y su palabra.
    const rows = fit.locator('.fit-row');
    expect(await rows.count()).toBe(5);
    for (let i = 0; i < 5; i++) {
      const row = rows.nth(i);
      await expect(row).toHaveClass(/is-(good|ok|bad|unknown)/);
      await expect(row.locator('.fit-row__mark')).toHaveCount(1);
      await expect(row.locator('.fit-row__value')).toHaveCount(1);
      // Sin tarjeta blanca por criterio dentro del bloque: filas planas separadas por una raya.
      expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('el menú de perfil y la hoja de «He comido algo» agrupan sus filas en un bloque de 22 px y los rótulos de sección van en mayúsculas pequeñas', async ({ page }) => {
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    const profile = sheet(page, 'Mi perfil');
    await expect(profile.locator('ul.menu')).toBeVisible();
    expect(await radius(profile.locator('ul.menu'))).toBe('22px');
    expect(await radius(profile.locator('.profile-card'))).toBe('22px');
    await page.keyboard.press('Escape');
    await expect(profile).toBeHidden();

    await activePage(page).getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
    const eat = page.locator('dialog.sheet[open]');
    expect(await radius(eat.locator('ul.menu'))).toBe('22px');
    expect(await eat.locator('.meal__other').evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
  });

  test('los dispositivos: tarjetas de 24 px y, con el anillo en uso, el interruptor en la cabecera de su tarjeta (encima del estado)', async ({ page }) => {
    await page.getByRole('button', { name: /^Dispositivos:/ }).click();
    const devices = sheet(page, 'Dispositivos');
    const first = devices.locator('.device').first();
    await expect(first).toBeVisible();
    expect(await radius(first)).toBe('24px');
    const title = await first.locator('.device__title').boundingBox();
    const toggle = await first.locator('.switch').first().boundingBox();
    const hero = await first.locator('.ring-hero').boundingBox();
    if (!title || !toggle || !hero) throw new Error('faltan las cajas de la cabecera de dispositivos');
    expect(toggle.y + toggle.height).toBeLessThanOrEqual(hero.y); // la cabecera va encima del estado del anillo
    expect(toggle.x).toBeGreaterThan(title.x + title.width); // y el interruptor, a la derecha del título
  });
});
