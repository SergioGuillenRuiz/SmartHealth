import type { Page } from '@playwright/test';
import { activePage, expect, openDemo, stepDayBack, test } from './fixtures';

// Mantener pulsado o hacer doble toque sobre una gráfica, un botón o una cifra no debe seleccionar texto ni sacar el menú de copiar: el único
// texto seleccionable es el de los campos donde se escribe.

const selected = (page: Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? '');

test.describe('selección de texto', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
    await stepDayBack(page);
  });

  test('el texto de la app no se puede seleccionar (ni con doble clic) ni abre el menú contextual', async ({ page }) => {
    const resumen = activePage(page);
    const userSelect = (selector: string): Promise<string> => page.locator(selector).first().evaluate((el) => getComputedStyle(el).userSelect);
    for (const selector of ['body', '.hero-ring__value', '.card__title', '.nav button', '.topbar', '.tile__value']) {
      expect(await userSelect(selector), `user-select de ${selector}`).toBe('none');
    }

    // Un doble clic sobre una cifra seleccionaría la palabra si se pudiera.
    await resumen.locator('.hero-ring__value').dblclick();
    expect(await selected(page)).toBe('');
    await resumen.locator('.card__title').first().dblclick({ delay: 80 });
    expect(await selected(page)).toBe('');

    // Y el menú contextual (lo que sale al mantener pulsado) se cancela sobre cualquier cosa que no sea un campo.
    const cancelled = await resumen.locator('.hero-ring__value').evaluate((el) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(cancelled).toBe(true);
  });

  test('en un campo de texto sí se puede escribir y seleccionar', async ({ page }) => {
    await page.getByRole('button', { name: 'Día siguiente' }).click(); // la tarjeta de nutrición solo lleva el botón en el día de hoy
    await activePage(page).getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
    const dialog = page.locator('dialog.sheet[open]');
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    const field = dialog.getByLabel('Qué has comido (opcional)');
    await field.fill('pan con tomate');
    expect(await field.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
    await field.dblclick();
    const word = await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
    expect(word.trim().length).toBeGreaterThan(0);
    const cancelled = await field.evaluate((el) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(cancelled, 'en un campo el menú de copiar y pegar sigue funcionando').toBe(false);
  });
});
