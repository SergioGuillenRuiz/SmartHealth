import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openDemo, openUserSection, test } from './fixtures';

// Ideas para comer mejor: una comida poco adecuada que SE REPITE (la misma, no otras) varias veces en la semana lleva un aviso discreto sobre su valoración que abre recetas del mismo tipo,
// más sanas y ajustadas al objetivo, con el paso a paso animado; se apaga en el perfil.

interface Seed {
  ago: number;
  name?: string;
  kcal?: number;
  /** Los nutrientes de un dulce de verdad (mucho azúcar, casi sin proteína ni sal) en vez de los de una pizza: desde la ronda 53 lo «saludable» se juzga por los nutrientes y no por el nombre. */
  sweet?: boolean;
}

/** Deja guardadas comidas poco adecuadas a distintas horas relativas a «ahora» de la página, directamente en el almacén de la demostración. */
async function seedMeals(page: Page, seeds: Seed[]): Promise<void> {
  await page.evaluate(async (list) => {
    const now = Date.now();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const dayKey = (ms: number): string => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const byDay = new Map<string, unknown[]>();
      list.forEach(({ ago, name, kcal, sweet }, i) => {
        // La de hoy, a los 5 minutos: con otra hora «de ahora» (p. ej. pasada la medianoche) sigue siendo de hoy.
        const tsMs = ago === 0 ? now - 5 * 60_000 : now - ago * 86_400_000;
        const key = dayKey(tsMs);
        byDay.set(key, [...(byDay.get(key) ?? []), sweet ? { id: `meal-${i}`, tsMs, name: name ?? 'Dulce', kcal: kcal ?? 620, proteinG: 6, carbsG: 80, fatG: 30, fiberG: 2, sugarsG: 38, saltG: 0.4, grams: 160, source: 'manual' } : { id: `meal-${i}`, tsMs, name: name ?? 'Pizza margarita', kcal: kcal ?? 737, proteinG: 30, carbsG: 80, fatG: 31, fiberG: 4, sugarsG: 6, saltG: 3.4, grams: 330, source: 'manual' }]);
      });
      for (const [key, meals] of byDay) store.put(meals, `meals:${key}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, seeds);
}

const seedPizzas = (page: Page, daysAgo: number[]): Promise<void> => seedMeals(page, daysAgo.map((ago) => ({ ago })));

const openPizza = async (page: Page) => {
  await page.getByRole('button', { name: /Pizza margarita/ }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Comida', exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
};

test.describe('ideas para comer mejor', () => {
  test('con la misma comida poco adecuada repetida en la semana sale un aviso que abre recetas del mismo tipo, con el paso a paso dibujado', async ({ page }) => {
    await openDemo(page);
    await seedPizzas(page, [0, 1, 2]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();

    const sheet = await openPizza(page);
    const nudge = sheet.getByRole('button', { name: /La has comido 3 veces en 7 días/ });
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('Ver recetas parecidas, más sanas');
    // El aviso va ARRIBA de la valoración.
    const order = await sheet.evaluate((root) => {
      const nudgeEl = root.querySelector('.suggest-nudge');
      const fitEl = root.querySelector('.meal-fit');
      return nudgeEl && fitEl ? Boolean(nudgeEl.compareDocumentPosition(fitEl) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    });
    expect(order).toBe(true);

    await nudge.click();
    const ideas = page.getByRole('dialog', { name: 'Ideas para comer mejor', exact: true });
    await expect(ideas).toBeVisible();
    // El análisis: qué comida es, cuántas veces se repite, qué pesa y de qué tipo de recetas se trata.
    const advice = ideas.getByRole('region', { name: 'Lo que he visto en tu comida' });
    await expect(advice).toContainText('Pizza margarita');
    await expect(advice).toContainText('3 veces en 7 días');
    await expect(advice).toContainText('Lo que más pesa');
    await expect(advice).toContainText('Recetas de pizza más sanas');
    // Recetas de pizza, cada una con su icono, calorías, tiempo y el ajuste a su objetivo (sin plato dibujado: desde la ronda 54 no hay ilustraciones).
    await expect(ideas.locator('.recipe-card')).toHaveCount(3);
    const first = ideas.locator('.recipe-card').first();
    await expect(first.locator('.recipe-card__kind svg')).toBeVisible();
    await expect(first.locator('img, .recipe-plate, .cook-scene')).toHaveCount(0);
    await expect(first).toContainText(/\d+ kcal/);
    await expect(first).toContainText(/\d+ min/);
    await expect(first.locator('.recipe-card__goal')).toContainText(/Ajustada|Ración equilibrada/);
    // La receta se despliega: ingredientes con su cantidad en una columna y su nombre en otra, y cada paso con el icono de su acción.
    const recipe = first.locator('details');
    await recipe.locator('summary').click();
    await expect(recipe.getByRole('heading', { name: 'Ingredientes (1 ración)' })).toBeVisible();
    await expect(recipe.locator('.recipe-ingredients li').first().locator('b')).toContainText(/\d+/);
    await expect(recipe.locator('.recipe-ingredients li').first().locator('span')).not.toBeEmpty();
    const steps = recipe.locator('.cook-step');
    expect(await steps.count()).toBeGreaterThanOrEqual(3);
    await expect(steps.first().locator('.cook-step__icon svg')).toBeVisible();
    await expect(steps.first().locator('.cook-step__body p')).not.toBeEmpty();
    await expect(steps.first().locator('.cook-step__body small')).toContainText(/^Paso 1 · \w+/);
    // Sin ilustraciones ni imágenes en ningún paso.
    await expect(recipe.locator('img, svg.cook-scene')).toHaveCount(0);
  });

  test('unos buñuelos repetidos: recetas de postre (nunca una ensalada) y alguna de súper con su etiqueta y sin pasos', async ({ page }) => {
    await openDemo(page);
    await seedMeals(page, [
      { ago: 0, name: 'Buñuelos de viento', kcal: 620, sweet: true },
      { ago: 1, name: 'Buñuelos de viento', kcal: 620, sweet: true },
      { ago: 2, name: 'Buñuelos de viento', kcal: 620, sweet: true },
    ]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await page.getByRole('button', { name: /Buñuelos de viento/ }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Comida', exact: true });
    await sheet.getByRole('button', { name: /La has comido 3 veces/ }).click();
    const ideas = page.getByRole('dialog', { name: 'Ideas para comer mejor', exact: true });
    await expect(ideas.getByRole('region', { name: 'Lo que he visto en tu comida' })).toContainText('Recetas de dulce más sanas');
    await expect(ideas.locator('.recipe-card')).toHaveCount(3);
    const texts = (await ideas.locator('.recipe-card').allTextContents()).join(' ');
    expect(texts).not.toMatch(/ensalada|garbanzos|revuelto|pollo a la plancha/i);

    // Alguna se compra hecha: su icono de la compra, de qué es, qué mirar en la etiqueta y la ración, sin receta ni pasos.
    const product = ideas.locator('.recipe-card--product').first();
    await expect(product).toBeVisible();
    await expect(product.locator('.recipe-card__kind svg')).toBeVisible();
    await expect(product.locator('img')).toHaveCount(0);
    await expect(product).toContainText('De súper');
    await expect(product.locator('.recipe-card__shop')).not.toBeEmpty();
    await expect(product.locator('.recipe-card__serving')).toContainText('Una ración:');
    await expect(product.locator('details')).toHaveCount(0);
    await expect(product.locator('.cook-step')).toHaveCount(0);
    // Y alguna se prepara: con su receta paso a paso.
    const cooked = ideas.locator('.recipe-card:not(.recipe-card--product)').first();
    await expect(cooked.locator('details summary')).toContainText('Ver la receta paso a paso');
  });

  test('las recetas no llevan ninguna animación (con o sin «reducir movimiento»)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openDemo(page);
    await seedPizzas(page, [0, 1, 2]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openPizza(page);
    await sheet.getByRole('button', { name: /La has comido 3 veces/ }).click();
    const ideas = page.getByRole('dialog', { name: 'Ideas para comer mejor', exact: true });
    await ideas.locator('.recipe-card').first().locator('summary').click();
    const still = await ideas.locator('.recipe-card').first().evaluate((card) => [...card.querySelectorAll('*')].every((el) => getComputedStyle(el).animationName === 'none'));
    expect(still).toBe(true);
  });

  test('tres comidas poco adecuadas DISTINTAS en la misma semana no avisan: tiene que ser la misma comida repetida', async ({ page }) => {
    await openDemo(page);
    await seedMeals(page, [
      { ago: 0, name: 'Pizza margarita' },
      { ago: 1, name: 'Hamburguesa doble con queso y bacon' },
      { ago: 2, name: 'Bolsa de patatas fritas' },
    ]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openPizza(page);
    await expect(sheet.getByRole('region', { name: 'Para tu objetivo' })).toBeVisible();
    await expect(sheet.locator('.suggest-nudge')).toHaveCount(0);
  });

  test('la misma comida escrita un poco distinta cuenta como repetida', async ({ page }) => {
    await openDemo(page);
    await seedMeals(page, [
      { ago: 0, name: 'Pizza margarita' },
      { ago: 1, name: 'una pizza margarita' },
      { ago: 3, name: '2 Pizzas margarita' },
    ]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openPizza(page);
    await expect(sheet.locator('.suggest-nudge')).toBeVisible();
  });

  test('con la misma comida solo dos veces esa semana no sale ningún aviso', async ({ page }) => {
    await openDemo(page);
    await seedPizzas(page, [0, 1]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openPizza(page);
    await expect(sheet.getByRole('region', { name: 'Para tu objetivo' })).toBeVisible();
    await expect(sheet.locator('.suggest-nudge')).toHaveCount(0);
  });

  test('se apaga en el perfil (Objetivos y medición) y vuelve al encenderla', async ({ page }) => {
    await openDemo(page);
    await seedPizzas(page, [0, 1, 2]);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();

    const goals = await openUserSection(page, 'Objetivos y medición');
    const toggle = goals.getByRole('checkbox', { name: /Ideas para comer mejor/ });
    await expect(toggle).toBeChecked(); // activada de serie
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    let sheet = await openPizza(page);
    await expect(sheet.getByRole('region', { name: 'Para tu objetivo' })).toBeVisible();
    await expect(sheet.locator('.suggest-nudge')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const again = await openUserSection(page, 'Objetivos y medición');
    await again.getByRole('checkbox', { name: /Ideas para comer mejor/ }).check();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    sheet = await openPizza(page);
    await expect(sheet.locator('.suggest-nudge')).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`el aviso y la hoja de ideas cumplen la accesibilidad (axe, tema ${scheme === 'light' ? 'claro' : 'oscuro'})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' }); // sin el latido: axe mediría colores a medio animar
      await openDemo(page);
      await seedPizzas(page, [0, 1, 2]);
      await page.goto('/?demo=keep');
      await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
      const sheet = await openPizza(page);
      await expect(sheet.locator('.suggest-nudge')).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0)).map((a) => a.finished.catch(() => undefined))));
      const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
      const detail = await new AxeBuilder({ page }).withTags(tags).include('dialog[open]').analyze();
      expect(detail.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

      await sheet.locator('.suggest-nudge').click();
      const ideas = page.getByRole('dialog', { name: 'Ideas para comer mejor', exact: true });
      await ideas.locator('.recipe-card').first().locator('summary').click();
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0)).map((a) => a.finished.catch(() => undefined))));
      const list = await new AxeBuilder({ page }).withTags(tags).include('dialog[open]').analyze();
      expect(list.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });
  }
});
