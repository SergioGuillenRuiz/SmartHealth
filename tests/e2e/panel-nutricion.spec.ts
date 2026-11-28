import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, test } from './fixtures';

// El panel de Nutrición modular (ronda 59): hasta dos filas de cuatro indicadores que la persona elige, quita y añade, como los gráficos de evolución.

const panel = (page: Page): Locator => activePage(page).getByRole('group', { name: 'Comida del día' });
/** «Elegir indicadores» va en la cabecera de la tarjeta (al lado del botón que la gira), no dentro del panel de los indicadores. */
const editButton = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'Elegir indicadores' });
const tiles = (page: Page): Locator => panel(page).getByRole('list', { name: 'Nutrientes del día' }).getByRole('listitem').filter({ has: page.locator('.food-ring') });
const names = async (page: Page): Promise<string[]> => (await panel(page).locator('.food-macros__name').allInnerTexts()).map((t) => t.trim());

/** Quita un indicador: la cruz pide un segundo toque (y un toque seguido no vale). */
async function removeIndicator(page: Page, name: string): Promise<void> {
  await panel(page).getByRole('button', { name: `Quitar ${name}` }).click();
  const confirm = panel(page).getByRole('button', { name: `Confirmar: quitar ${name}` });
  await expect(confirm).toBeVisible();
  await page.waitForTimeout(550);
  await confirm.click();
}

async function addIndicator(page: Page, name: string): Promise<void> {
  await panel(page).getByRole('button', { name: 'Añadir un indicador' }).click();
  await page.getByRole('dialog', { name: 'Añadir un indicador', exact: true }).getByRole('button', { name: `Añadir ${name}` }).click();
}

test.describe('panel de nutrición modular', () => {
  test.beforeEach(async ({ page }) => {
    // Sin movimiento: los bloques se menean al editar y Playwright no pulsa lo que no está quieto (el meneo en sí se comprueba aparte).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDemo(page);
    await goTab(page, 'Resumen');
  });

  test('de serie trae los cuatro de siempre (proteína, hidratos, grasas y sal) y un botón para elegirlos', async ({ page }) => {
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Sal']);
    await expect(editButton(page)).toBeVisible();
  });

  test('editar: se añaden fibra, azúcares y agua (dos filas de cuatro), se quita la sal, se aplica y queda guardado al recargar', async ({ page }) => {
    await editButton(page).click();
    await expect(panel(page).getByRole('button', { name: 'Aplicar' })).toBeVisible();
    await addIndicator(page, 'Fibra');
    await addIndicator(page, 'Azúcares');
    await addIndicator(page, 'Agua');
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Sal', 'Fibra', 'Azúcares', 'Agua']);
    // Siete indicadores: dos filas (4 + 3), y el «+» ocupa el hueco que queda.
    const tops = await tiles(page).evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(2);
    await removeIndicator(page, 'Sal');
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Fibra', 'Azúcares', 'Agua']);
    await panel(page).getByRole('button', { name: 'Aplicar' }).click();
    await expect(editButton(page)).toBeVisible();
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Fibra', 'Azúcares', 'Agua']);
    // Lo guardado sigue al recargar (se espera a que esté escrito: la recarga lo perdía a veces).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('smartring-demo');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const all = open.result.transaction('kv', 'readonly').objectStore('kv').getAll();
                all.onsuccess = () => resolve(JSON.stringify(all.result).includes('"nutritionPanel":["protein","carbs","fat","fiber","sugars","water"]'));
                all.onerror = () => resolve(false);
              };
            }),
        ),
      )
      .toBe(true);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Fibra', 'Azúcares', 'Agua']);
  });

  test('descartar deja todo como estaba; en edición un toque en la tarjeta no la gira, y ninguno es válido (sin filas)', async ({ page }) => {
    await editButton(page).click();
    await removeIndicator(page, 'Sal');
    await removeIndicator(page, 'Grasas');
    expect(await names(page)).toEqual(['Proteína', 'Hidratos']);
    await panel(page).getByText('Proteína', { exact: true }).click(); // un toque sobre la tarjeta: no la gira
    await expect(activePage(page).getByRole('region', { name: 'Nutrición', exact: true }).getByRole('group', { name: 'Comida del día' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Descartar' }).click();
    expect(await names(page)).toEqual(['Proteína', 'Hidratos', 'Grasas', 'Sal']);
    await editButton(page).click();
    for (const name of ['Proteína', 'Hidratos', 'Grasas', 'Sal']) await removeIndicator(page, name);
    await panel(page).getByRole('button', { name: 'Aplicar' }).click();
    await expect(panel(page).getByRole('list', { name: 'Nutrientes del día' })).toHaveCount(0);
    await expect(editButton(page)).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`la edición y el selector cumplen la accesibilidad (axe, tema ${scheme === 'light' ? 'claro' : 'oscuro'})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await editButton(page).click();
      await addIndicator(page, 'Fibra');
      const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
      const editing = await new AxeBuilder({ page }).withTags(tags).include('main.pager > section.page:not([inert])').analyze();
      expect(editing.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await panel(page).getByRole('button', { name: 'Añadir un indicador' }).click();
      const picker = page.getByRole('dialog', { name: 'Añadir un indicador', exact: true });
      await expect(picker).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0)).map((a) => a.finished.catch(() => undefined))));
      const open = await new AxeBuilder({ page }).withTags(tags).include('dialog[open]').analyze();
      expect(open.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });
  }
});
