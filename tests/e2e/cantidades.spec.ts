import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, test } from './fixtures';

// Cambiar los gramos de lo ya anotado, alimento a alimento, desde los detalles de la comida (ronda 49): lo contado con palabras guarda lo que lleva y cada alimento enseña sus gramos.

const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });
const sheet = (page: Page, name: string): Locator => page.getByRole('dialog', { name, exact: true });

/** Las comidas guardadas en la demostración (van agrupadas por día en `kv`, bajo `meals:AAAA-MM-DD`). */
async function savedMeals(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const days = await new Promise<Array<Array<Record<string, unknown>>>>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound('meals:', 'meals;', false, true));
      request.onsuccess = () => resolve(request.result as Array<Array<Record<string, unknown>>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return days.flat();
  });
}

async function logByWords(page: Page, text: string): Promise<void> {
  await goTab(page, 'Resumen');
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  const dialog = page.locator('dialog.sheet[open]');
  await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
  await dialog.getByLabel('¿Qué has comido?').fill(text);
  await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
  await dialog.getByRole('button', { name: 'Anotar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Comida anotada' })).toBeVisible();
}

test.describe('cambiar los gramos de lo ya anotado', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('lo contado con palabras guarda cada alimento con sus gramos y se cambian uno a uno desde los detalles, con la comida rehecha', async ({ page }) => {
    await logByWords(page, '200 g de arroz blanco y 150 g de pollo a la plancha');
    const saved = (await savedMeals(page)).find((m) => String(m.name).includes('+'));
    expect(saved, 'la comida se guardó').toBeTruthy();
    const items = saved?.items as Array<{ name: string; grams?: number; kcal: number }>;
    expect(items.length, 'un alimento por cada cosa dicha').toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.grams !== undefined)).toBe(true);
    const kcalBefore = Number(saved?.kcal);

    // La comida recién anotada, por su nombre: la lista va por hora y la «primera» solo es esta si la prueba corre de madrugada.
    await nutrition(page).locator('.food-meals__main', { hasText: String(saved?.name) }).first().click();
    const detail = sheet(page, 'Comida');
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Cambiar cantidades' }).click();
    const fields = detail.getByRole('textbox', { name: /^Cantidad de / });
    await expect(fields).toHaveCount(items.length);

    // El segundo alimento a doble cantidad: sus calorías se doblan, las del otro no cambian y el total se ve al momento.
    const second = items[1] as { name: string; grams: number; kcal: number };
    await fields.nth(1).fill(String(second.grams * 2).replace('.', ','));
    await expect(detail.locator('.meal-amounts__total')).toContainText(`${kcalBefore + second.kcal}`.replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
    await detail.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Cantidades cambiadas' })).toBeVisible();

    // Los detalles enseñan las calorías nuevas y lo guardado lleva los gramos nuevos.
    await expect(detail.locator('.meal-detail__kcal strong')).toHaveText(`${kcalBefore + second.kcal}`.replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
    const after = (await savedMeals(page)).find((m) => m.id === saved?.id);
    expect(after).toMatchObject({ id: saved?.id, source: saved?.source, tsMs: saved?.tsMs, kcal: kcalBefore + second.kcal });
    expect((after?.items as Array<{ grams: number }>)[1]?.grams).toBe(second.grams * 2);
  });

  test('una comida anotada a mano con solo las calorías dice que no tiene gramos que cambiar', async ({ page }) => {
    await goTab(page, 'Resumen');
    await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
    const dialog = page.locator('dialog.sheet[open]');
    await dialog.getByRole('button', { name: /Anotar a mano|calorías a mano|A mano/i }).first().click();
    await dialog.getByLabel('Qué has comido (opcional)').fill('Tarta de la abuela');
    await dialog.getByLabel('Calorías (kcal)').fill('350');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 350 kcal' })).toBeVisible();
    await nutrition(page).locator('.food-meals__main', { hasText: 'Tarta de la abuela' }).first().click();
    const detail = sheet(page, 'Comida');
    await expect(detail).toContainText('Esta comida no tiene gramos guardados');
    await expect(detail.getByRole('button', { name: 'Cambiar cantidades' })).toHaveCount(0);
  });
});
