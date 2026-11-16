import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, openUserSection, stepDayBack, test } from './fixtures';
import { ACEITE, mockProducts, watchOutsideRequests, YOGUR } from './products';

// Alimentación: anotar lo que se come (a mano, con el código de barras o con palabras), verlo en el Resumen y en la evolución de Salud, y
// elegir el objetivo de salud que decide las metas. La app no usa internet: los productos salen de la base que lleva (aquí sustituida por
// una de prueba) y lo escrito con palabras, de su tabla de alimentos. Varias pruebas vigilan que no se pida nada a ningún sitio de fuera.

const evolution = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Evolución', exact: true });
const sheet = (page: Page, name: string): Locator => page.getByRole('dialog', { name, exact: true });
const foodPanel = (page: Page): Locator => activePage(page).getByRole('group', { name: 'Comida del día' });

/** Las comidas que guarda la demostración, leídas del almacén (van agrupadas por día en `kv`, bajo claves `meals:AAAA-MM-DD`). */
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

/**
 * Quita la cámara de la página (antes de que cargue): con ella la cámara falsa de las pruebas ve siempre el mismo código y el escáner lo lee solo,
 * lo que estorbaría a las pruebas que teclean el código.
 */
async function withoutCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
  });
}

const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });

/** Abre la hoja de «He comido algo» desde la tarjeta Nutrición del Resumen (de hoy). */
/** Quita un alimento calculado con su papelera: el primer toque la prepara y el segundo, que no vale al instante, lo quita. */
async function removeFood(page: Page, scope: Locator, name: string): Promise<void> {
  await scope.getByRole('button', { name: `Quitar ${name}`, exact: true }).click();
  const confirm = scope.getByRole('button', { name: `Confirmar: quitar ${name}`, exact: true });
  await expect(confirm).toBeVisible();
  await page.waitForTimeout(600); // un doble toque no confirma
  await confirm.click();
}

async function openMealSheet(page: Page): Promise<Locator> {
  await goTab(page, 'Resumen');
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  await expect(sheet(page, 'He comido algo')).toBeVisible();
  // El nombre de la hoja sigue al paso en que está («Anotar calorías», «Código de barras»…): se la sigue por estar abierta.
  return page.locator('dialog.sheet[open]');
}

test.describe('anotar una comida', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('el botón «He comido algo» está en la tarjeta Nutrición del Resumen (solo hoy) y ya no en Salud', async ({ page }) => {
    await expect(nutrition(page).getByRole('button', { name: 'He comido algo' })).toBeVisible();
    // Lo que se anota cuenta para hoy: en un día pasado la tarjeta enseña lo comido, sin botón.
    await stepDayBack(page);
    await expect(nutrition(page)).toBeVisible();
    await expect(nutrition(page).getByRole('button', { name: 'He comido algo' })).toHaveCount(0);
    await goTab(page, 'Salud');
    await expect(evolution(page)).toBeVisible();
    await expect(activePage(page).getByRole('button', { name: 'He comido algo' })).toHaveCount(0);
    await expect(evolution(page).getByRole('button', { name: 'Actualizar peso' })).toBeVisible();
  });

  test('pregunta de qué forma se quiere anotar: código de barras, calorías a mano o lenguaje natural', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await expect(dialog.getByRole('button', { name: /Escanear un código de barras/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Añadir las calorías a mano/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Contarlo con tus palabras/ })).toBeVisible();
  });

  test('a mano: calorías (y nutrientes si se quiere) se guardan y se ven en el Resumen de hoy', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Qué has comido (opcional)').fill('Bocadillo de tortilla');
    await dialog.getByLabel('Calorías (kcal)').fill('650');
    await dialog.getByLabel('Proteínas (g)').fill('24,5');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 650 kcal' })).toBeVisible();
    await expect(dialog).toBeHidden();

    const meals = (await savedMeals(page)).filter((m) => m.name === 'Bocadillo de tortilla');
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({ kcal: 650, proteinG: 24.5, source: 'manual' });
    expect(meals[0]).not.toHaveProperty('carbsG'); // lo que no se rellena no se guarda como un cero

    await goTab(page, 'Resumen');
    const kcal = foodPanel(page).getByRole('meter', { name: 'Calorías comidas' });
    await expect(kcal).toHaveAttribute('aria-valuenow', /^\d+$/);
    expect(Number(await kcal.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  });

  test('a mano también se anotan la fibra, los azúcares y la sal: se guardan, la sal suma en su anillo (un máximo de 5 g) y unos azúcares de más se avisan', async ({ page }) => {
    // Los cuatro anillos del día: proteína, hidratos, grasas y sal (esta, un máximo y no una meta).
    const rings = foodPanel(page).getByRole('list', { name: 'Nutrientes del día' }).getByRole('meter');
    await expect(rings).toHaveCount(4);
    await expect(rings.nth(3)).toHaveAccessibleName('Sal (máximo al día)');
    await expect(rings.nth(3)).toHaveAttribute('aria-valuemax', '5');
    const salt = async (): Promise<number> => Number((await foodPanel(page).getByRole('list', { name: 'Nutrientes del día' }).locator('.food-macros__value').nth(3).innerText()).replace(',', '.'));
    const before = await salt();
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Qué has comido (opcional)').fill('Jamón con pan');
    await dialog.getByLabel('Calorías (kcal)').fill('420');
    await dialog.getByLabel('Hidratos (g)').fill('40');
    await dialog.getByLabel('Azúcares (g)').fill('45');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Los azúcares no pueden ser más que los hidratos');
    await dialog.getByLabel('Azúcares (g)').fill('4,5');
    await dialog.getByLabel('Fibra (g)').fill('3');
    await dialog.getByLabel('Sal (g)').fill('1,5');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    const meal = (await savedMeals(page)).find((m) => m.name === 'Jamón con pan');
    expect(meal).toMatchObject({ kcal: 420, carbsG: 40, fiberG: 3, sugarsG: 4.5, saltG: 1.5, source: 'manual' });
    await expect.poll(salt).toBeCloseTo(Math.round((before + 1.5) * 10) / 10, 1);
  });

  test('con las calorías vacías se calculan con los nutrientes; sin nada, se avisa', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Indica las calorías');
    await dialog.getByLabel('Calorías (kcal)').fill('dos pizzas');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Las calorías deben ser un número');
    await dialog.getByLabel('Calorías (kcal)').fill('');
    await dialog.getByLabel('Proteínas (g)').fill('30');
    await dialog.getByLabel('Hidratos (g)').fill('50');
    await dialog.getByLabel('Grasas (g)').fill('10');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 410 kcal' })).toBeVisible();
  });

  test('lo anotado hoy sale en la lista de la tarjeta y se puede borrar desde ahí (el segundo toque confirma); la hoja ya no repite la lista', async ({ page }) => {
    let dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Qué has comido (opcional)').fill('Error de dedo');
    await dialog.getByLabel('Calorías (kcal)').fill('9000');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();

    const list = nutrition(page).getByRole('list', { name: 'Comidas del día' });
    await expect(list).toContainText('Error de dedo');
    // La hoja de «He comido algo» solo pregunta cómo anotar: no lleva la lista de lo de hoy.
    dialog = await openMealSheet(page);
    await expect(dialog.getByRole('region', { name: 'Anotado hoy' })).toHaveCount(0);
    await expect(dialog).not.toContainText('Error de dedo');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await list.getByRole('button', { name: 'Borrar Error de dedo' }).click();
    const confirm = list.getByRole('button', { name: 'Confirmar: borrar Error de dedo' });
    await expect(confirm).toBeVisible();
    expect((await savedMeals(page)).some((m) => m.name === 'Error de dedo'), 'un toque no borra').toBe(true);
    await page.waitForTimeout(800); // un doble toque no confirma: hay que esperar un momento
    await confirm.click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida borrada' })).toBeVisible();
    await expect.poll(async () => (await savedMeals(page)).some((m) => m.name === 'Error de dedo')).toBe(false);
    await expect(nutrition(page).getByText('Error de dedo')).toHaveCount(0); // si era la única comida, desaparece también la lista
  });

  test('el escáner lee el código que ve la cámara y busca el producto sin teclear nada ni salir a internet', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    const products = await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible({ timeout: 30_000 });
    expect(await products.requests()).toBe(1);
    expect(outside).toEqual([]);
  });

  test('sin permiso de cámara se avisa y se puede teclear el código', async ({ page, context }) => {
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denegado', 'NotAllowedError'));
    });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await expect(dialog).toContainText('No hay permiso para usar la cámara');
    await expect(dialog.getByLabel('O teclea el código')).toBeVisible();
  });
});

test.describe('código de barras tecleado', () => {
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('código de barras tecleado: busca el producto, calcula la cantidad y lo anota', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    const products = await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await dialog.getByLabel('O teclea el código').fill('8410000000019'); // dígito de control mal
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Ese código no es válido');
    // No se busca como producto (no sale ninguno), aunque la base de la app se lee para proponer «¿era este?» con el código que difiere en una cifra.
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /¿Era 8410000000016/ })).toBeVisible();
    expect(await products.requests(), 'la base se lee una sola vez').toBeLessThanOrEqual(1);

    await dialog.getByLabel('O teclea el código').fill('8410000000016');
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await expect(dialog).toContainText('0,12 g de sal'); // lo que dice la etiqueta, por 100 g
    // La ración de la etiqueta (125 g) viene puesta: 61 kcal por 100 g → 76.
    await expect(dialog.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('125');
    await expect(dialog.getByRole('status').filter({ hasText: 'kcal' })).toContainText('76');
    await dialog.getByLabel('Cantidad que has comido (g o ml)').fill('250');
    await expect(dialog.getByRole('status').filter({ hasText: 'kcal' })).toContainText('153');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 153 kcal' })).toBeVisible();
    const meal = (await savedMeals(page)).find((m) => m.barcode === '8410000000016');
    expect(meal).toMatchObject({ source: 'barcode', kcal: 153, grams: 250, name: 'Yogur natural · Marca' });
    // Y con lo de su etiqueta: fibra, azúcares y sal a la cantidad comida (250 g: 0 g de fibra, 11,8 g de azúcares y 0,3 g de sal).
    expect(meal).toMatchObject({ fiberG: 0, sugarsG: 11.8, saltG: 0.3 });
    expect(outside).toEqual([]);
  });

  test('una cantidad que haría pasar de lo que admite una comida no se deja anotar (ni entraría en una copia de seguridad)', async ({ page }) => {
    // Un aceite: 900 kcal por 100 g. Con 2000 g salen 18.000 kcal.
    await mockProducts(page, [ACEITE]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await dialog.getByLabel('O teclea el código').fill(ACEITE.code);
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await dialog.getByLabel('Cantidad que has comido (g o ml)').fill('2000');
    await expect(dialog.getByRole('status').filter({ hasText: 'salen más de' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Anotar' })).toBeDisabled();
    await dialog.getByLabel('Cantidad que has comido (g o ml)').fill('20');
    await expect(dialog.getByRole('button', { name: 'Anotar' })).toBeEnabled();
  });
});

test.describe('la cámara del escáner', () => {
  test('se apaga al cerrar la hoja, y también al ocultarse la app (y se reabre al volver)', async ({ page }) => {
    // Una cámara que no ve ningún código (un lienzo en blanco) y que anota cada pista que entrega, para ver si se paran.
    await page.addInitScript(() => {
      const streams: MediaStream[] = [];
      (window as unknown as { __streams: MediaStream[] }).__streams = streams;
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d');
        if (context) {
          context.fillStyle = '#888';
          context.fillRect(0, 0, 320, 240);
        }
        const stream = canvas.captureStream(5);
        streams.push(stream);
        return stream;
      };
    });
    await openDemo(page);
    const live = (): Promise<number> => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
    const opened = (): Promise<number> => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);

    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await expect.poll(live).toBe(1);

    // Con la app oculta la cámara se suelta; al volver, se reabre.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(live).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(live).toBe(1);
    expect(await opened()).toBe(2);

    // Al cerrar la hoja se apaga del todo.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect.poll(live).toBe(0);
  });

  test('al elegir otra forma de anotar, la cámara se apaga', async ({ page }) => {
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
    await expect(dialog.getByRole('button', { name: /Añadir las calorías a mano/ })).toBeVisible();
    // La cámara falsa de las pruebas se enciende al abrir el escáner; fuera de él ningún vídeo la está usando.
    await expect(page.locator('video')).toHaveCount(0);
  });
});

test.describe('lo comido sin datos del anillo ese día', () => {
  test('un día sin pasos pero con comidas anotadas sigue enseñando la comida en el Resumen', async ({ page }) => {
    await openDemo(page);
    // Un día de hace años (sin datos del anillo) con una comida anotada, escrita en el almacén como lo hace la app.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ts = new Date(2024, 2, 5, 9, 0).getTime();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put([{ id: 'antigua', tsMs: ts, name: 'Desayuno', kcal: 420, proteinG: 15, carbsG: 50, fatG: 12, source: 'manual' }], 'meals:2024-03-05');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await page.locator('.daynav input[type="date"]').fill('2024-03-05');
    await expect(activePage(page).locator('[data-day="2024-03-05"]')).toHaveCount(1);
    const kcal = foodPanel(page).getByRole('meter', { name: 'Calorías comidas' });
    await expect(kcal).toHaveAttribute('aria-valuenow', '420');
    // Y otro día igual de antiguo, sin comidas, sigue con su aviso de falta de datos.
    await page.locator('.daynav input[type="date"]').fill('2024-03-06');
    await expect(activePage(page).locator('[data-day="2024-03-06"]')).toHaveCount(1);
    await expect(activePage(page).getByText('Sin datos de actividad')).toBeVisible();
  });
});

test.describe('el producto no está o la base no se puede leer', () => {
  // Un 500 del archivo de la base es un error de carga que el navegador anota en la consola: aquí se provoca a propósito.
  test.use({ allowedConsoleErrors: [/Failed to load resource/] });

  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('un producto que no está en la base de la app se puede anotar a mano', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await dialog.getByLabel('O teclea el código').fill(ACEITE.code);
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await expect(dialog).toContainText(`El producto ${ACEITE.code} no está en la base de la app`);
    await dialog.getByRole('button', { name: 'Anotarlo a mano' }).click();
    await expect(dialog.getByLabel('Calorías (kcal)')).toBeVisible();
  });

  test('si la base no se puede abrir, lo dice y deja reintentar', async ({ page }) => {
    await mockProducts(page, [YOGUR], 500);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await dialog.getByLabel('O teclea el código').fill('8410000000016');
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('No se pudo abrir la base de productos de la app');

    await mockProducts(page, [YOGUR]);
    await dialog.getByRole('button', { name: 'Reintentar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
  });
});

test.describe('anotar con lenguaje natural', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('calcula lo escrito con la tabla de alimentos, deja revisar y anota; sin internet ni clave', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await expect(dialog.getByLabel('Clave de Anthropic')).toHaveCount(0); // ya no hay IA ni clave que pedir
    await dialog.getByLabel('¿Qué has comido?').fill('dos huevos revueltos con una tostada y un café con leche');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();

    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list).toContainText('Huevos revueltos ×2');
    await expect(list).toContainText('Tostada');
    await expect(list).toContainText('Café con leche');
    await expect(list.locator(':scope > li')).toHaveCount(3); // los alimentos; algunos (el café con leche) llevan además sus piezas
    // Las cifras vienen sumadas y se pueden corregir antes de anotar.
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('415');
    await expect(dialog.getByLabel('Qué has comido (opcional)')).toHaveValue('Huevos revueltos ×2 + Tostada + Café con leche');
    await dialog.getByLabel('Calorías (kcal)').fill('400');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 400 kcal' })).toBeVisible();
    expect((await savedMeals(page)).find((m) => m.name === 'Huevos revueltos ×2 + Tostada + Café con leche')).toMatchObject({ source: 'text', kcal: 400 });
    expect(outside).toEqual([]);
  });

  test('sin cantidad supone una ración y lo dice; lo que no entiende, lo avisa sin sumarlo', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('arroz con zarandajo');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toContainText('Arroz cocido');
    await expect(dialog).toContainText('Sin la cantidad, supuse una ración habitual de: Arroz cocido (200 g).');
    await expect(dialog).toContainText('No he reconocido «zarandajo»: no está sumado');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('260');
    await dialog.getByRole('button', { name: 'Volver a escribirlo' }).click();
    await expect(dialog.getByLabel('¿Qué has comido?')).toHaveValue('arroz con zarandajo');
  });

  test('si no reconoce nada, lo dice en vez de anotar algo', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('un zarandajo con frumbulón');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dialog.getByRole('alert')).toContainText('No he reconocido ningún alimento');
    await expect(dialog.getByRole('button', { name: 'Anotar' })).toHaveCount(0);
    await dialog.getByLabel('¿Qué has comido?').fill('');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Escribe qué has comido');
  });

  test('un plato con ingredientes: «kebab de ternera con cebolla y salsa blanca» lleva lo que se dice y enseña sus piezas', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('un kebab de ternera con cebolla y salsa blanca');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    const dishes = list.locator(':scope > li'); // los platos; sus piezas van en una lista dentro de cada uno
    await expect(dishes).toHaveCount(1);
    await expect(dishes).toContainText('Kebab de ternera con cebolla y salsa blanca');
    await expect(list.getByLabel('Cantidad de Kebab de ternera con cebolla y salsa blanca (g)')).toHaveValue('282');
    const parts = list.getByRole('list', { name: /^Lo que lleva/ });
    await expect(parts).toContainText('Pan de kebab');
    await expect(parts.getByLabel('Cantidad de Pan de kebab (g)')).toHaveValue('100');
    await expect(parts.getByLabel('Cantidad de Carne de kebab (g)')).toHaveValue('120');
    await expect(parts.getByLabel('Cantidad de Cebolla (g)')).toHaveValue('22');
    await expect(parts.getByLabel('Cantidad de Salsa blanca (g)')).toHaveValue('40');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('646');
    await expect(dialog.getByLabel('Qué has comido (opcional)')).toHaveValue('Kebab de ternera con cebolla y salsa blanca');
    // Sin cebolla ni lechuga, y con otro kebab: dos platos, cada uno con lo suyo.
    await dialog.getByRole('button', { name: 'Volver a escribirlo' }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('un kebab de pollo sin cebolla y otro de ternera con todo menos tomate');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dishes).toHaveCount(2);
    await expect(dishes.nth(0)).toContainText('Kebab de pollo sin cebolla');
    await expect(dishes.nth(1)).toContainText('Kebab de ternera sin tomate');
  });

  test('lo que la tabla no conoce se busca en la base de productos de la app, y se avisa', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    await mockProducts(page, [{ code: '8410000000016', name: 'Yogur Flurbo', brand: 'Marca', kcal: 90, proteinG: 4, carbsG: 14, fatG: 2, servingG: 125 }]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('un yogur flurbo');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list).toContainText('Yogur Flurbo (Marca)');
    await expect(dialog).toContainText('«yogur flurbo» lo busqué en la base de productos de la app: Yogur Flurbo (Marca), 90 kcal por 100 g.');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('113');
    expect(outside).toEqual([]);
  });

  test('las cantidades se leen: gramos, vasos, cucharadas y fracciones', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('200 g de arroz, medio litro de leche y dos cucharadas de aceite');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.getByLabel('Cantidad de Arroz cocido (g)')).toHaveValue('200');
    await expect(list.getByLabel('Cantidad de Leche semidesnatada (ml)')).toHaveValue('500');
    await expect(list.getByLabel('Cantidad de Aceite (ml)')).toHaveValue('30');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('745'); // 260 + 237 + 248
  });
});

test.describe('corregir lo que calculó el texto sin reescribirlo', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  async function calculate(page: Page, text: string): Promise<Locator> {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill(text);
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toBeVisible();
    return dialog;
  }

  test('los gramos de un alimento se cambian en su campo y las calorías se recalculan solas; lo anotado es lo corregido', async ({ page }) => {
    const dialog = await calculate(page, '200 g de arroz');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('260');
    await dialog.getByLabel('Cantidad de Arroz cocido (g)').fill('100');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('130');
    await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toContainText('130 kcal');
    await dialog.getByLabel('Cantidad de Arroz cocido (g)').fill('300,5');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('391');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 391 kcal' })).toBeVisible();
    expect((await savedMeals(page)).find((m) => m.name === 'Arroz cocido')).toMatchObject({ source: 'text', kcal: 391 });
  });

  test('una cantidad que no vale se marca y deja lo de antes; al salir del campo vuelve la anterior', async ({ page }) => {
    const dialog = await calculate(page, '200 g de arroz');
    const amount = dialog.getByLabel('Cantidad de Arroz cocido (g)');
    await amount.fill('0');
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('260');
    await amount.fill('');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('260');
    await amount.blur();
    await expect(amount).toHaveValue('200');
    await expect(amount).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('en un plato compuesto se cambia una pieza o se quita («sin cebolla»), y el plato suma lo que lleva', async ({ page }) => {
    const dialog = await calculate(page, 'un kebab de ternera con cebolla y salsa blanca');
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    const parts = list.getByRole('list', { name: /^Lo que lleva/ });
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('646');
    const before = Number(await dialog.getByLabel('Calorías (kcal)').inputValue());

    // Media ración de carne: menos calorías; el plato baja a la suma de sus piezas.
    await parts.getByLabel('Cantidad de Carne de kebab (g)').fill('60');
    await expect.poll(async () => Number(await dialog.getByLabel('Calorías (kcal)').inputValue())).toBeLessThan(before);
    await expect(list.getByLabel('Cantidad de Kebab de ternera con cebolla y salsa blanca (g)')).toHaveValue('222'); // 100 + 60 + 22 + 40

    // Sin cebolla: la pieza se va y el foco queda en la lista.
    await removeFood(page, parts, 'Cebolla');
    await expect(parts).not.toContainText('Cebolla');
    await expect(list.getByLabel('Cantidad de Kebab de ternera con cebolla y salsa blanca (g)')).toHaveValue('200');
    await expect(list).toBeFocused();
  });

  test('se quita un alimento de los calculados y se añade otro escribiéndolo, sin tocar el resto', async ({ page }) => {
    const dialog = await calculate(page, 'dos huevos revueltos con una tostada y un café con leche');
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(3);
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('415');

    await removeFood(page, list, 'Café con leche');
    await expect(list.locator(':scope > li')).toHaveCount(2);
    await expect(list).not.toContainText('Café con leche');
    await expect.poll(async () => Number(await dialog.getByLabel('Calorías (kcal)').inputValue())).toBeLessThan(415);

    await dialog.getByLabel('Añadir otro alimento').fill('20 g de queso');
    await dialog.getByRole('button', { name: 'Añadir', exact: true }).click();
    await expect(list.locator(':scope > li')).toHaveCount(3);
    await expect(list).toContainText(/queso/i);
    await expect(dialog.getByLabel('Añadir otro alimento')).toHaveValue('');

    // Lo que no se entiende no se suma y lo dice.
    await dialog.getByLabel('Añadir otro alimento').fill('zarandajo');
    await dialog.getByRole('button', { name: 'Añadir', exact: true }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'No he reconocido' })).toBeVisible();
    await expect(list.locator(':scope > li')).toHaveCount(3);
  });

  test('la revisión son tarjetas limpias: gramos y unidad en un solo campo, una papelera por fila y ninguna cruz suelta', async ({ page }) => {
    const dialog = await calculate(page, 'un kebab de ternera con cebolla y salsa blanca y dos huevos revueltos');
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li.rv-card')).toHaveCount(2);
    // Cada fila (alimentos y piezas) tiene su campo de gramos con la unidad dentro y su papelera; nada más que pueda parecer un botón de cerrar.
    const rows = list.locator('.rv-row');
    const count = await rows.count();
    expect(count).toBe(6); // 2 alimentos y las 4 piezas del kebab
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i).locator('.rv-amount .rv-amount__unit')).toHaveText(/^(g|ml)$/);
      await expect(rows.nth(i).locator('button')).toHaveCount(1);
      await expect(rows.nth(i).getByRole('button')).toHaveAccessibleName(/^Quitar /);
    }
    await expect(list.locator('svg.lucide-x')).toHaveCount(0);
    // Los alimentos con imagen llevan su miniatura; las piezas, no.
    await expect(list.locator(':scope > li > .rv-row .meal-thumb')).toHaveCount(2);
    await expect(list.locator('.rv-parts .meal-thumb')).toHaveCount(0);
  });

  test('un toque suelto en la papelera solo la prepara: no quita nada hasta el segundo, y tocar otra cosa la deja como estaba', async ({ page }) => {
    const dialog = await calculate(page, 'dos huevos revueltos con una tostada');
    const list = dialog.getByRole('list', { name: 'Lo que se ha calculado' });
    const before = await list.locator(':scope > li').count();
    const trash = list.getByRole('button', { name: /^Quitar Tostada/ });
    await trash.click();
    const confirm = list.getByRole('button', { name: /^Confirmar: quitar Tostada/ });
    await expect(confirm).toBeVisible();
    await confirm.click(); // enseguida: un doble toque no vale
    await expect(list.locator(':scope > li')).toHaveCount(before);
    // Tocar otra cosa la deja como estaba.
    await dialog.getByLabel('Añadir otro alimento').click();
    await expect(list.getByRole('button', { name: /^Quitar Tostada/ })).toBeVisible();
    await expect(list.locator(':scope > li')).toHaveCount(before);
  });

  test('si se quita todo no queda nada que anotar, y se puede añadir de nuevo', async ({ page }) => {
    const dialog = await calculate(page, '200 g de arroz');
    await removeFood(page, dialog, 'Arroz cocido');
    await expect(dialog).toContainText('No queda ningún alimento');
    await expect(dialog.getByRole('button', { name: 'Anotar' })).toHaveCount(0);
    await dialog.getByLabel('Añadir otro alimento').fill('un yogur');
    await dialog.getByRole('button', { name: 'Añadir', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Anotar' })).toBeVisible();
  });

  test('también al añadir un ingrediente a un plato: se corrige antes de añadirlo y lo añadido lleva lo corregido', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Arroz de prueba');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('200 g de arroz');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await dialog.getByLabel('Cantidad de Arroz cocido (g)').fill('150');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('195');
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    await expect(dialog.getByRole('list', { name: 'Ingredientes del plato' })).toContainText('150 g');
  });
});

test.describe('lo comido en el Resumen y en la evolución', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('en su propia tarjeta «Nutrición», bajo la de actividad, hay las calorías con una barra horizontal y tres nutrientes frente a su meta', async ({ page }) => {
    await stepDayBack(page); // ayer: la demostración tiene comidas anotadas
    const card = nutrition(page);
    await expect(card).toBeVisible();
    const food = foodPanel(page);
    await expect(card.getByRole('group', { name: 'Comida del día' })).toBeVisible();
    const kcal = food.getByRole('meter', { name: 'Calorías comidas' });
    const value = Number(await kcal.getAttribute('aria-valuenow'));
    const target = Number(await kcal.getAttribute('aria-valuemax'));
    expect(value).toBeGreaterThan(1000);
    expect(target).toBeGreaterThan(1200);
    await expect(kcal).toHaveAttribute('aria-valuetext', /^[\d.]+ de [\d.]+ kcal/);
    for (const name of ['Proteína', 'Hidratos', 'Grasas']) {
      await expect(food.getByRole('meter', { name })).toBeVisible();
    }
    // Las calorías van en un anillo grande (cuadrado) y los tres nutrientes en anillos más pequeños, en una fila: no hay barras.
    const ring = await kcal.boundingBox();
    expect(ring && Math.abs(ring.width - ring.height) < 2 && ring.width >= 120, 'el anillo de calorías es grande y redondo').toBe(true);
    const small = await Promise.all(['Proteína', 'Hidratos', 'Grasas'].map((name) => food.getByRole('meter', { name }).boundingBox()));
    expect(small.every((b) => b !== null && b.width < (ring?.width ?? 0)), 'los de los nutrientes son más pequeños').toBe(true);
    expect(Math.max(...small.map((b) => b?.y ?? 0)) - Math.min(...small.map((b) => b?.y ?? 0)), 'los nutrientes comparten fila').toBeLessThan(2);
    const activity = activePage(page).getByRole('region', { name: 'Actividad diaria' });
    await expect(activity.getByRole('group', { name: 'Comida del día' })).toHaveCount(0);
    const above = await activity.boundingBox();
    const below = await card.boundingBox();
    expect(above && below && below.y >= above.y + above.height - 1, 'la nutrición queda debajo de la actividad').toBe(true);
    // Y no es un recuadro enano.
    expect(below?.height ?? 0, 'la tarjeta de nutrición se lee bien').toBeGreaterThan(300);
  });

  test('la tarjeta se distingue de la de actividad: es blanca como las de pulso y sueño, sin el degradado de color', async ({ page }) => {
    await stepDayBack(page);
    const paint = (locator: Locator): Promise<{ image: string; color: string }> =>
      locator.evaluate((el) => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).backgroundColor }));
    const activity = await paint(activePage(page).getByRole('region', { name: 'Actividad diaria' }));
    const food = await paint(nutrition(page));
    const heart = await paint(activePage(page).getByRole('region', { name: 'Ritmo cardiaco' }));
    expect(activity.image).toContain('linear-gradient');
    expect(food.image, 'sin degradado').toBe('none');
    expect(food.color, 'el fondo de las demás tarjetas').toBe(heart.color);
  });

  test('abajo lista lo comido a lo largo del día con su hora y sin calorías (van en los detalles de cada comida, que suman lo que enseña el anillo)', async ({ page }) => {
    await stepDayBack(page);
    const list = nutrition(page).getByRole('list', { name: 'Comidas del día' });
    const rows = list.getByRole('listitem');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    for (const row of await rows.all()) {
      await expect(row).toContainText(/\d\d:\d\d/);
      await expect(row, 'en la fila ya no van las calorías').not.toContainText(/kcal/);
    }
    // En orden del día (la hora crece).
    const texts = await rows.allInnerTexts();
    const times = texts.map((t) => (t.match(/\d\d:\d\d/) ?? [''])[0]);
    expect([...times].sort()).toEqual(times);
    // Y las calorías de cada comida, en su hoja de detalles, suman lo mismo que el anillo.
    let sum = 0;
    for (let i = 0; i < count; i++) {
      await rows.nth(i).getByRole('button').first().click();
      const detail = sheet(page, 'Comida');
      await expect(detail).toBeVisible();
      sum += Number((await detail.locator('.meal-detail__kcal strong').innerText()).replace('.', ''));
      await page.keyboard.press('Escape');
      await expect(detail).toBeHidden();
    }
    const kcal = Number(await foodPanel(page).getByRole('meter', { name: 'Calorías comidas' }).getAttribute('aria-valuenow'));
    expect(Math.abs(sum - kcal)).toBeLessThanOrEqual(count);
  });

  test('lo que se anota sale en la lista de la tarjeta al momento', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Qué has comido (opcional)').fill('Tortilla de patatas');
    await dialog.getByLabel('Calorías (kcal)').fill('480');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    const row = nutrition(page).getByRole('list', { name: 'Comidas del día' }).getByRole('listitem').filter({ hasText: 'Tortilla de patatas' });
    await expect(row).toBeVisible();
    await row.getByRole('button').first().click();
    await expect(sheet(page, 'Comida')).toContainText('480');
    await page.keyboard.press('Escape');
    // Con la demostración ya llevan lo comido del día entero (si la hora es tarde, 480 kcal más pasan de la meta): vale «quedan» o «pasas».
    await expect(nutrition(page)).toContainText(/Te (quedan|pasas)/);
  });

  test('la tarjeta tiene dos caras, la comida y la hidratación, y se da la vuelta al pulsarla (el ejercicio no mueve nada de ella)', async ({ page }) => {
    await stepDayBack(page); // ayer: un día completo
    const card = nutrition(page);
    const onFood = card.getByRole('button', { name: /^Estás viendo la comida/ });
    await expect(onFood).toBeVisible();
    await expect(onFood, 'el botón de girar es solo un símbolo, sin texto').toHaveText('');
    await expect(onFood.locator('svg')).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Nutrición' })).toBeVisible();
    const target = async (): Promise<number> => Number(await foodPanel(page).getByRole('meter', { name: 'Calorías comidas' }).getAttribute('aria-valuemax'));
    const goal = await target();

    // El botón de la cabecera la gira (teclado y lectores de pantalla)…
    await onFood.click();
    const onWater = card.getByRole('button', { name: /^Estás viendo la hidratación/ });
    await expect(onWater).toBeVisible();
    await expect(onWater).toHaveText('');
    await expect(card.getByRole('heading', { name: 'Hidratación' })).toBeVisible();
    await expect(card.getByRole('group', { name: 'Hidratación del día' })).toBeVisible();
    await expect(card.getByRole('meter', { name: 'Agua bebida' })).toBeVisible();

    // …y tocar la tarjeta (el anillo, por ejemplo) la gira de vuelta, con la misma meta de calorías: no hay otra «con ejercicio».
    await card.getByRole('meter', { name: 'Agua bebida' }).click();
    await expect(card.getByRole('button', { name: /^Estás viendo la comida/ })).toBeVisible();
    expect(await target()).toBe(goal);
    // En ninguna de las dos caras sale nada del ejercicio.
    await expect(card).not.toContainText(/ejercicio/i);
    await card.getByRole('button', { name: /^Estás viendo la comida/ }).click();
    await expect(card).not.toContainText(/ejercicio/i);
  });

  test('un toque en «He comido algo» no gira la tarjeta', async ({ page }) => {
    const card = nutrition(page);
    await expect(card.getByRole('button', { name: /^Estás viendo la comida/ })).toBeVisible();
    await card.getByRole('button', { name: 'He comido algo' }).click();
    await expect(sheet(page, 'He comido algo')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.getByRole('button', { name: /^Estás viendo la comida/ })).toBeVisible();
  });

  test('cabe sin desbordar ni en 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await stepDayBack(page);
    const card = nutrition(page);
    const box = await card.boundingBox();
    const food = await foodPanel(page).boundingBox();
    expect(box && food && food.x + food.width <= box.x + box.width + 1, 'el panel de comida cabe en la tarjeta').toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test('un día sin comidas anotadas lo dice en vez de inventarse una comida', async ({ page }) => {
    // La demostración se salta un día de cada nueve: se retrocede hasta dar con él.
    for (let i = 0; i < 12; i++) {
      await stepDayBack(page);
      if ((await nutrition(page).innerText()).includes('No anotaste nada este día')) break;
    }
    await expect(nutrition(page)).toContainText('No anotaste nada este día');
    await expect(nutrition(page).getByRole('list', { name: 'Comidas del día' })).toHaveCount(0);
  });

  test('el gráfico de Salud muestra las calorías como barras con su objetivo, en lugar del pulso en reposo', async ({ page }) => {
    await goTab(page, 'Salud');
    const chart = evolution(page).getByRole('img', { name: /^Evolución entre el/ });
    // Los títulos de las bandas van dentro del dibujo o, si el gráfico se desliza, en la capa quieta que hay junto a él: se buscan en todo el panel.
    await expect(evolution(page).getByText('Calorías al día · anotado', { exact: true })).toBeVisible();
    await expect(evolution(page).getByText(/Pulso en reposo/)).toHaveCount(0);
    await expect(chart).toHaveAccessibleName(/calorías comidas, media de [\d.]+ al día frente a [\d.]+ propuestas/);
  });
});

test.describe('la lista de comidas: detalles, imagen y pasar de día', () => {
  /** Anota una comida a mano con sus tres nutrientes (hoy, con la hora de ahora). */
  async function addMeal(page: Page, name: string, kcal: string, extra: { proteinG?: string; carbsG?: string; fatG?: string; fiberG?: string; sugarsG?: string; saltG?: string } = {}): Promise<void> {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Qué has comido (opcional)').fill(name);
    await dialog.getByLabel('Calorías (kcal)').fill(kcal);
    await dialog.getByLabel('Proteínas (g)').fill(extra.proteinG ?? '30');
    await dialog.getByLabel('Hidratos (g)').fill(extra.carbsG ?? '50');
    await dialog.getByLabel('Grasas (g)').fill(extra.fatG ?? '10');
    if (extra.fiberG !== undefined) await dialog.getByLabel('Fibra (g)').fill(extra.fiberG);
    if (extra.sugarsG !== undefined) await dialog.getByLabel('Azúcares (g)').fill(extra.sugarsG);
    if (extra.saltG !== undefined) await dialog.getByLabel('Sal (g)').fill(extra.saltG);
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    await expect(rowOf(page, name)).toBeVisible(); // la tarjeta ya lleva la comida nueva
  }
  const rowOf = (page: Page, name: string): Locator => nutrition(page).getByRole('list', { name: 'Comidas del día' }).getByRole('listitem').filter({ hasText: name });
  // Lo comido que escribe el anillo (el `aria-valuenow` del medidor se recorta a la meta: con un día pasado de la meta no serviría).
  const ringKcal = async (page: Page): Promise<number> => Number((await foodPanel(page).locator('.food-top__value').innerText()).replace(/\./g, ''));
  /** Pasa una comida de día con los dos toques que hacen falta: el primero agranda el botón y el segundo confirma (tras esperar a que un doble toque ya no valga). */
  async function shift(row: Locator, name: string, direction: 'antes' | 'después'): Promise<void> {
    await row.getByRole('button', { name: new RegExp(`^Pasar «${name}» un día ${direction}`) }).click();
    const armed = row.getByRole('button', { name: new RegExp(`^Confirmar: pasar «${name}» un día ${direction}`) });
    await expect(armed).toBeVisible();
    await row.page().waitForTimeout(500);
    await armed.click();
  }

  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('cada comida lleva la imagen de lo que es (empaquetada en la app, sin pedirla a ningún sitio) y su nombre en letra más pequeña', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    await addMeal(page, 'Hamburguesa con queso', '650');
    const row = rowOf(page, 'Hamburguesa con queso');
    const image = row.locator('img');
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), 'la imagen carga').toBe(true);
    // Es del propio origen (o incrustada): no sale a internet.
    const source = await image.getAttribute('src');
    expect(source, 'la imagen es de la propia app').toMatch(/^(data:|\.?\/?assets\/|\/assets\/|http:\/\/127\.0\.0\.1:\d+\/assets\/)/);
    expect(outside).toEqual([]);
    const sizes = await row.evaluate((el) => ({
      name: parseFloat(getComputedStyle(el.querySelector('strong') as Element).fontSize),
      kcal: el.textContent?.includes('kcal') ?? false,
    }));
    expect(sizes.name).toBeLessThan(15.5);
    expect(sizes.kcal, 'sin calorías en la fila').toBe(false);
  });

  test('pulsar una comida (menos sus botones) abre los detalles sin dar la vuelta a la tarjeta; sus botones no abren nada', async ({ page }) => {
    await addMeal(page, 'Tortilla de patatas', '480');
    const row = rowOf(page, 'Tortilla de patatas');
    const face = nutrition(page).getByRole('button', { name: /^Estás viendo la comida/ });
    await expect(face).toBeVisible();

    // En el hueco de la fila (el nombre, la hora): detalles, y la tarjeta se queda como estaba.
    await row.locator('.food-meals__main').click();
    const detail = sheet(page, 'Comida');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Tortilla de patatas');
    await expect(detail.locator('.meal-detail__kcal strong')).toHaveText('480');
    for (const [label, grams] of [['Proteína', '30 g'], ['Hidratos', '50 g'], ['Grasas', '10 g']] as const) {
      await expect(detail.locator('.meal-detail__macros div').filter({ hasText: label })).toContainText(grams);
    }
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(face, 'abrir los detalles no gira la tarjeta').toBeVisible();

    // Los botones de al lado no abren los detalles ni giran la tarjeta.
    await row.getByRole('button', { name: /^Pasar «Tortilla de patatas» un día antes/ }).click();
    await expect(detail).toBeHidden();
    await expect(face).toBeVisible();
    await row.getByRole('button', { name: 'Borrar Tortilla de patatas' }).click();
    await expect(detail).toBeHidden();
    await expect(face).toBeVisible();
  });

  test('los detalles no llevan el número del código de barras ni botones de pasar de día, y sí más del contenido nutricional y una nota según el objetivo', async ({ page }) => {
    await stepDayBack(page);
    const first = nutrition(page).getByRole('list', { name: 'Comidas del día' }).getByRole('listitem').first();
    await first.locator('.food-meals__main').click();
    const detail = sheet(page, 'Comida');
    await expect(detail).toBeVisible();
    // Sobra el código y el desplazar (esos botones ya están en la lista).
    await expect(detail).not.toContainText(/\b\d{8,14}\b/);
    await expect(detail.getByRole('button', { name: /un día (antes|después)/ })).toHaveCount(0);
    // Falta (y ahora está) el reparto de calorías, lo que pesa en el día y la nota para el objetivo.
    await expect(detail.locator('.meal-detail__kcal')).toContainText(/% de tu meta del día/);
    // Los cuatro indicadores: proteína, hidratos, grasas y sal, con lo que pesan en la comida y en el día (los tres macros suman el 100 % de sus calorías).
    const indicators = detail.locator('.meal-detail__macros > div');
    await expect(indicators).toHaveCount(4);
    await expect(indicators.locator('dt')).toHaveText(['Proteína', 'Hidratos', 'Grasas', 'Sal']);
    await expect(detail.locator('.meal-detail__macros')).toContainText(/% de sus calorías/);
    await expect(detail.locator('.meal-detail__macros')).toContainText(/% de tu meta/);
    await expect(indicators.nth(3)).toContainText(/% del máximo diario/);
    const energy = (await indicators.locator('dd.meal-detail__sub').allInnerTexts())
      .map((text) => /^(\d+)\s*% de sus calorías/.exec(text.replace(/\u00a0/g, ' '))?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(energy).toHaveLength(3);
    expect(energy.reduce((a, b) => a + b, 0), 'los tres porcentajes de energía suman el 100 %').toBeGreaterThanOrEqual(99);
    expect(energy.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(101);
    // Debajo de los indicadores no hay más texto (la valoración ya lo dice), y la valoración no lleva la nota de «orientación» ni repite el porcentaje de calorías del día.
    await expect(detail).not.toContainText(/Por 100 g|Densidad energética|Proteína por 100 kcal|Cómo se anotó|Calorías sin nutriente|orientación/i);
    const fit = detail.getByRole('region', { name: 'Para tu objetivo' });
    await expect(fit).toBeVisible();
    await expect(fit).toContainText(/Tu objetivo: Perder peso/); // la demostración busca perder peso
    await expect(fit.getByRole('heading')).toContainText(/(Muy buena|Buena|Normal|Poco adecuada) para perder peso/);
    await expect(fit).not.toContainText(/de tus calorías del día/);
    // Los cinco criterios de la valoración, siempre en este orden, cada uno con su palabra (y la marca dicha para quien no ve el color).
    const rows = fit.locator('.fit-row');
    await expect(rows).toHaveCount(5);
    await expect(rows.locator('.fit-row__label')).toHaveText(['Densidad calórica', 'Densidad proteica', 'Sal y azúcar', 'Saciedad', 'Saludable']);
    for (const row of await rows.all()) {
      await expect(row.locator('.fit-row__value')).not.toBeEmpty();
      await expect(row.locator('.fit-row__mark .sr-only')).toHaveText(/^(Bien|Regular|Mal|Sin datos): $/);
    }
  });

  test('los detalles dicen la cantidad junto a las calorías y avisan cuando hay mucha sal', async ({ page }) => {
    await addMeal(page, 'Bocadillo de jamón', '520', { proteinG: '24', carbsG: '60', fatG: '18', fiberG: '4', sugarsG: '5', saltG: '3.2' });
    await rowOf(page, 'Bocadillo de jamón').locator('.food-meals__main').click();
    const detail = sheet(page, 'Comida');
    const excess = detail.getByRole('region', { name: 'Para tu objetivo' }).locator('.fit-row', { hasText: 'Sal y azúcar' });
    await expect(excess.locator('.fit-row__value')).toHaveText('Muchísima sal');
    await expect(excess).toContainText(/sal 3,2\s*g · azúcares 5\s*g/);
    await expect(excess.locator('.fit-row__mark .sr-only')).toHaveText('Mal: ');
    await expect(detail.locator('.meal-detail__macros > div').nth(3)).toContainText(/3,2\s*g/);
    await expect(detail.locator('.meal-detail__macros > div').nth(3)).toContainText(/64\s*% del máximo diario/);
    // La comida anotada a mano no sabe su cantidad: el título solo lleva las calorías y lo que es del día.
    await expect(detail.locator('.meal-detail__kcal')).not.toContainText(/\d\s*g\b/);
    // Los azúcares y la fibra van también como nota al pie de los indicadores.
    await expect(detail.locator('.meal-detail__note')).toHaveText(/Azúcares: 5\s*g \(incluidos en los hidratos\) · Fibra: 4\s*g/);
  });

  test('un triangulito de aviso que late (sin texto) aparece encima de cada anillo que se pasa, y de ninguno más', async ({ page }) => {
    const warns = foodPanel(page).locator('.food-ring__warn');
    // Mucha sal y muchas calorías de golpe: se pasan el anillo de calorías y el de la sal (el máximo de 5 g).
    await addMeal(page, 'Banquete', '3500', { proteinG: '5', carbsG: '5', fatG: '1', saltG: '8' });
    await expect(foodPanel(page).getByRole('meter', { name: 'Calorías comidas' }).locator('.food-ring__warn')).toHaveCount(1);
    await expect(foodPanel(page).getByRole('meter', { name: 'Sal (máximo al día)' }).locator('.food-ring__warn')).toHaveCount(1);
    // El aviso sale en TODOS los anillos que el medidor dice que se pasan, y en ninguno más (lo que traiga ya el día de la demostración depende de la hora).
    const meters = foodPanel(page).getByRole('meter');
    for (let i = 0; i < (await meters.count()); i++) {
      const meter = meters.nth(i);
      const over = /por encima/.test((await meter.getAttribute('aria-valuetext')) ?? '');
      await expect(meter.locator('.food-ring__warn'), (await meter.getAttribute('aria-label')) ?? '').toHaveCount(over ? 1 : 0);
    }
    // Sin texto: no se ve ninguna palabra dentro del aviso y los lectores de pantalla lo ignoran (el medidor ya dice «por encima…»).
    const first = warns.first();
    await expect(first).toHaveAttribute('aria-hidden', 'true');
    expect(((await first.textContent()) ?? '').trim()).toBe('');
    await expect(foodPanel(page).getByRole('meter', { name: 'Sal (máximo al día)' })).toHaveAttribute('aria-valuetext', /por encima del máximo/);
    // Late de verdad (animación) y queda quieto con «reducir movimiento».
    expect(await first.locator('svg').evaluate((el) => getComputedStyle(el).animationName)).toBe('food-warn');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await first.locator('svg').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    // Borrar la comida lo quita.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const list = nutrition(page).getByRole('list', { name: 'Comidas del día' });
    await list.getByRole('button', { name: 'Borrar Banquete' }).click();
    const confirm = list.getByRole('button', { name: 'Confirmar: borrar Banquete' });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(800); // un doble toque no confirma
    await confirm.click();
    await expect(list.getByText('Banquete')).toHaveCount(0);
    // Sin el banquete, cada anillo vuelve a lo que dice su medidor (lo que ya traiga el día de la demostración depende de la hora a la que se pase la prueba).
    const metersAfter = foodPanel(page).getByRole('meter');
    for (let i = 0; i < (await metersAfter.count()); i++) {
      const meter = metersAfter.nth(i);
      const over = /por encima/.test((await meter.getAttribute('aria-valuetext')) ?? '');
      await expect(meter.locator('.food-ring__warn'), (await meter.getAttribute('aria-label')) ?? '').toHaveCount(over ? 1 : 0);
    }
  });

  test('la nota cambia con el objetivo de salud: el mismo plato no encaja igual para todos', async ({ page }) => {
    await addMeal(page, 'Pechuga a la plancha', '330', { proteinG: '62', carbsG: '0', fatG: '7' });
    await rowOf(page, 'Pechuga a la plancha').locator('.food-meals__main').click();
    const fit = sheet(page, 'Comida').getByRole('region', { name: 'Para tu objetivo' });
    await expect(fit.getByRole('heading')).toContainText(/Muy buena para perder peso/);
    await expect(fit.locator('.fit-row', { hasText: 'Densidad proteica' })).toContainText(/Alta/);
    await expect(fit.locator('.fit-row', { hasText: 'Densidad proteica' })).toContainText(/62\s*g · 18,8\s*g por 100 kcal/);
    await page.keyboard.press('Escape');
    // Con otro objetivo, otra nota.
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('radio', { name: /Ganar peso/ }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await rowOf(page, 'Pechuga a la plancha').locator('.food-meals__main').click();
    await expect(fit.getByRole('heading')).toContainText(/para ganar peso/);
    await expect(fit).toContainText(/Tu objetivo: Ganar peso/);
    await expect(fit).not.toContainText(/Muchísima proteína/);
  });

  test('pasar una comida un día antes hace falta un segundo toque: el primero agranda el botón y no mueve nada', async ({ page }) => {
    await addMeal(page, 'Cena tardía', '700');
    const todayKcal = await ringKcal(page);
    const row = rowOf(page, 'Cena tardía');
    const button = row.getByRole('button', { name: /^Pasar «Cena tardía» un día antes/ });
    const widthOf = (locator: typeof button): Promise<number> => locator.evaluate((el) => el.getBoundingClientRect().width);
    const normal = await widthOf(button);

    await button.click();
    const armed = row.getByRole('button', { name: /^Confirmar: pasar «Cena tardía» un día antes/ });
    await expect(armed).toBeVisible();
    await expect.poll(() => widthOf(armed), 'el botón se agranda para que se note').toBeGreaterThan(normal * 1.2);
    // Nada se ha movido: la comida sigue en hoy y no hay aviso de haberla pasado.
    await expect(rowOf(page, 'Cena tardía')).toHaveCount(1);
    expect(await ringKcal(page)).toBe(todayKcal);
    await expect(page.getByRole('status').filter({ hasText: 'cuenta ahora para' })).toHaveCount(0);
  });

  test('un doble toque sin querer no pasa la comida; tocar otra cosa o esperar deja el botón como estaba', async ({ page }) => {
    await addMeal(page, 'Cena tardía', '700');
    const row = rowOf(page, 'Cena tardía');
    // Un doble toque seguido (el segundo llega antes de que valga como confirmación).
    // Los dos toques salen dentro de la página con un solo fotograma de por medio: con `dblclick()` de Playwright el hueco entre los dos dependía de lo cargada que estuviera la máquina
    // y, pasados 400 ms, el segundo ya era una confirmación de verdad (la prueba fallaba una de cada diez).
    await row.getByRole('button', { name: /^Pasar «Cena tardía» un día antes/ }).evaluate(async (el) => {
      (el as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      (el as HTMLButtonElement).click();
    });
    await expect(rowOf(page, 'Cena tardía')).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'cuenta ahora para' })).toHaveCount(0);
    // Tocar el nombre de la comida (se abre su hoja y el botón pierde el foco) lo desarma.
    await row.locator('.food-meals__main').click();
    // La hoja tiene que estar del todo abierta antes de Escape y del todo cerrada antes de seguir (con la máquina cargada, un Escape antes de tiempo la dejaba abierta tapando el botón).
    await expect(page.getByRole('dialog', { name: 'Comida', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Comida', exact: true })).toBeHidden();
    await expect(row.getByRole('button', { name: /^Confirmar: pasar/ })).toHaveCount(0);
    // Armado y sin más toques, vuelve solo.
    await row.getByRole('button', { name: /^Pasar «Cena tardía» un día antes/ }).click();
    await expect(row.getByRole('button', { name: /^Confirmar: pasar/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Confirmar: pasar/ })).toHaveCount(0, { timeout: 8_000 });
    await expect(rowOf(page, 'Cena tardía')).toHaveCount(1);
  });

  test('con el segundo toque, la comida sale de hoy y se suma al día de ayer; allí el botón de la derecha la devuelve', async ({ page }) => {
    await addMeal(page, 'Cena tardía', '700');
    const todayKcal = await ringKcal(page);
    const row = rowOf(page, 'Cena tardía');
    // Hoy no se puede pasar a mañana.
    await expect(row.getByRole('button', { name: /^Pasar «Cena tardía» un día después/ })).toHaveAttribute('aria-disabled', 'true');
    await shift(row, 'Cena tardía', 'antes');
    await expect(page.getByRole('status').filter({ hasText: '«Cena tardía» cuenta ahora para ayer' })).toBeVisible();
    await expect(rowOf(page, 'Cena tardía')).toHaveCount(0);
    await expect.poll(() => ringKcal(page)).toBe(todayKcal - 700);
    // Se guarda la hora de verdad y el día al que cuenta.
    const saved = (await savedMeals(page)).find((m) => m.name === 'Cena tardía');
    expect(saved?.day, 'cuenta para ayer').toBeTruthy();
    expect(typeof saved?.tsMs).toBe('number');

    // Ayer: está en su lista, con el día en que se comió de verdad, y suma en su anillo.
    await stepDayBack(page);
    const yesterday = rowOf(page, 'Cena tardía');
    await expect(yesterday).toBeVisible();
    await expect(yesterday.locator('small')).toContainText(/\d\d:\d\d · \d+ \w+/);
    const before = await ringKcal(page);
    await shift(yesterday, 'Cena tardía', 'después');
    await expect(page.getByRole('status').filter({ hasText: '«Cena tardía» cuenta ahora para hoy' })).toBeVisible();
    await expect(rowOf(page, 'Cena tardía')).toHaveCount(0);
    await expect.poll(() => ringKcal(page)).toBe(before - 700);
    const back = (await savedMeals(page)).find((m) => m.name === 'Cena tardía');
    expect(back?.day, 'de nuevo sin día aparte').toBeUndefined();
  });

  test('los entrenos ya no se pasan de día: su hoja de detalles no lleva botones de día', async ({ page }) => {
    await goTab(page, 'Deportes');
    await activePage(page).getByRole('region', { name: 'Entrenamientos' }).getByRole('button', { name: 'Todos', exact: true }).click();
    await activePage(page).locator('ul.wk-list > li').first().getByRole('button').click();
    const detail = page.getByRole('dialog', { name: 'Entrenamiento', exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', { name: /un día (antes|después)/ })).toHaveCount(0);
    await expect(detail).not.toContainText(/Cuenta para/);
  });
});

test.describe('hidratación: la otra cara de la tarjeta', () => {
  const card = (page: Page): Locator => nutrition(page);
  const ring = (page: Page): Locator => card(page).getByRole('meter', { name: 'Agua bebida' });
  const ml = async (page: Page): Promise<number> => Number((await card(page).locator('.food-top__value').innerText()).replace(/\./g, ''));
  const goalMl = async (page: Page): Promise<number> => Number(await ring(page).getAttribute('aria-valuemax'));
  const LEVELS = /Bien hidratado|Algo por debajo|Hidratación baja|Más agua de la necesaria|Sin agua anotada/;

  test.beforeEach(async ({ page }) => {
    await openDemo(page);
    await card(page).getByRole('button', { name: /^Estás viendo la comida/ }).click();
    await expect(ring(page)).toBeVisible();
  });

  test('hoy empieza sin nada: el anillo a cero frente a una meta calculada con tus datos, un nivel y dos formas de anotar', async ({ page }) => {
    expect(await ml(page)).toBe(0);
    const goal = await goalMl(page);
    expect(goal % 50, 'la meta va de 50 en 50').toBe(0);
    expect(goal).toBeGreaterThanOrEqual(1200);
    expect(goal).toBeLessThanOrEqual(3000);
    await expect(card(page).locator('.food-top__unit')).toContainText(`de ${goal.toLocaleString('es-ES', { useGrouping: false })} ml`);
    await expect(card(page).locator('.water-level')).toHaveText('Sin agua anotada');
    await expect(card(page).getByRole('button', { name: 'Un vaso' })).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Otra cantidad' })).toBeVisible();
    // El agua es una gota que se llena (no un anillo) y lo esperado a esta hora va junto al nivel; no hay anillos de «Vasos» ni de «Nivel».
    await expect(card(page).locator('.water-drop svg')).toBeVisible();
    await expect(card(page).locator('.food-ring')).toHaveCount(0);
    await expect(card(page).locator('.water-status')).toContainText(/Esperado\s+[\d.]+\s*ml/);
    await expect(card(page).locator('.water-status .water-level')).toHaveText(LEVELS);
    await expect(card(page).getByRole('meter', { name: 'Vasos' })).toHaveCount(0);
    await expect(card(page).getByRole('meter', { name: 'Nivel de hidratación' })).toHaveCount(0);
    await expect(card(page)).toContainText('no mide tu hidratación real');
  });

  test('«Un vaso» suma 250 ml, sale en la lista con su hora y el nivel se actualiza', async ({ page }) => {
    await card(page).getByRole('button', { name: 'Un vaso' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Un vaso anotado: 250 ml' })).toBeVisible();
    await expect.poll(() => ml(page)).toBe(250);
    const list = card(page).getByRole('list', { name: 'Tomas de agua del día' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('250 ml');
    await expect(list).toContainText(/\d\d:\d\d/);
    await expect(card(page).locator('.water-level')).toHaveText(LEVELS);
    await expect(card(page).locator('.water-level')).not.toHaveText('Sin agua anotada');
    await card(page).getByRole('button', { name: 'Un vaso' }).click();
    await expect.poll(() => ml(page)).toBe(500);
    await expect(ring(page)).toHaveAttribute('aria-valuenow', '500');
    // No gira la tarjeta.
    await expect(ring(page)).toBeVisible();
  });

  test('«Otra cantidad» abre una hoja: se escribe lo bebido (300, 33 cl, 0,5 l…), se rechaza lo imposible y las cantidades habituales rellenan el campo', async ({ page }) => {
    await card(page).getByRole('button', { name: 'Otra cantidad' }).click();
    const sheetEl = sheet(page, 'Anotar agua');
    await expect(sheetEl).toBeVisible();
    const input = sheetEl.getByLabel('Cantidad (ml)');
    await sheetEl.getByRole('button', { name: 'Anotar' }).click();
    await expect(sheetEl.getByRole('alert')).toContainText('Escribe la cantidad');
    await input.fill('mucha');
    await sheetEl.getByRole('button', { name: 'Anotar' }).click();
    await expect(sheetEl.getByRole('alert')).toContainText('Escribe la cantidad');
    await input.fill('5000');
    await sheetEl.getByRole('button', { name: 'Anotar' }).click();
    await expect(sheetEl.getByRole('alert')).toContainText('entre 10 y 2000 ml');
    await sheetEl.getByRole('button', { name: '330 ml' }).click();
    await expect(input).toHaveValue('330');
    await input.fill('0,5 l');
    await sheetEl.getByRole('button', { name: 'Anotar' }).click();
    await expect(sheetEl).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Agua anotada: 500 ml' })).toBeVisible();
    await expect.poll(() => ml(page)).toBe(500);
    await expect(card(page).getByRole('list', { name: 'Tomas de agua del día' })).toContainText('500 ml');
  });

  test('una toma se borra con dos toques (el segundo confirma) y el anillo baja', async ({ page }) => {
    await card(page).getByRole('button', { name: 'Un vaso' }).click();
    await expect.poll(() => ml(page)).toBe(250);
    const list = card(page).getByRole('list', { name: 'Tomas de agua del día' });
    await list.getByRole('button', { name: /^Borrar 250 ml/ }).click();
    const confirm = list.getByRole('button', { name: /^Confirmar: borrar 250 ml/ });
    await expect(confirm).toBeVisible();
    expect(await ml(page), 'un toque no borra').toBe(250);
    await page.waitForTimeout(800); // un doble toque no confirma: hay que esperar un momento
    await confirm.click();
    await expect(page.getByRole('status').filter({ hasText: 'Toma borrada' })).toBeVisible();
    await expect.poll(() => ml(page)).toBe(0);
    await expect(card(page).getByRole('list', { name: 'Tomas de agua del día' })).toHaveCount(0);
  });

  test('un día pasado enseña lo bebido y su nivel, sin botones de anotar', async ({ page }) => {
    await card(page).getByRole('button', { name: /^Estás viendo la hidratación/ }).click(); // a la comida, para volver con el día cambiado
    await stepDayBack(page);
    await card(page).getByRole('button', { name: /^Estás viendo la comida/ }).click();
    await expect(ring(page)).toBeVisible();
    expect(await ml(page), 'la demostración lleva agua de los días pasados').toBeGreaterThan(500);
    await expect(card(page).locator('.water-level')).toHaveText(LEVELS);
    await expect(card(page).getByRole('button', { name: 'Un vaso' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Otra cantidad' })).toHaveCount(0);
    await expect(card(page).getByRole('list', { name: 'Tomas de agua del día' })).toBeVisible();
  });

  test('la meta de agua sale de tus datos: cambiar el peso la mueve', async ({ page }) => {
    const before = await goalMl(page);
    const section = await openUserSection(page, 'Mis datos');
    await section.getByRole('button', { name: 'Actualizar' }).click();
    const form = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    await form.getByLabel('Peso (kg)').fill('120');
    await form.getByRole('button', { name: 'Guardar' }).click();
    await expect(form).toBeHidden();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect.poll(() => goalMl(page)).toBeGreaterThan(before);
  });

  test('cabe sin desbordar en 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await card(page).getByRole('button', { name: 'Un vaso' }).click();
    await expect.poll(() => ml(page)).toBe(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});

test.describe('objetivo de salud', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('en «Objetivos y medición» hay varias opciones y la elegida cambia las metas de calorías y proteína', async ({ page }) => {
    await stepDayBack(page);
    const target = async (): Promise<number> => Number(await foodPanel(page).getByRole('meter', { name: 'Calorías comidas' }).getAttribute('aria-valuemax'));
    const protein = async (): Promise<number> => Number(await foodPanel(page).getByRole('meter', { name: 'Proteína' }).getAttribute('aria-valuemax'));
    const losing = await target();

    const goals = await openUserSection(page, 'Objetivos y medición');
    const group = goals.getByRole('radiogroup', { name: 'Objetivo de salud' });
    const options = await group.getByRole('radio').allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(4);
    for (const name of ['Perder peso', 'Mantener peso', 'Ganar masa muscular']) {
      await expect(group.getByRole('radio', { name: new RegExp(name) })).toBeVisible();
    }
    await expect(group.getByRole('radio', { name: /Perder peso/ })).toHaveAttribute('aria-checked', 'true'); // la demostración baja de peso
    await group.getByRole('radio', { name: /Ganar masa muscular/ }).click();
    await expect(group.getByRole('radio', { name: /Ganar masa muscular/ })).toHaveAttribute('aria-checked', 'true');
    await expect(goals).toContainText('Para ti, hoy: unas');
    await page.keyboard.press('Escape'); // vuelve al menú
    await expect(sheet(page, 'Mi perfil')).toContainText('Ganar masa muscular');
    await page.keyboard.press('Escape');

    await expect.poll(target).toBeGreaterThan(losing * 1.3); // de −20 % a +10 %
    expect(await protein()).toBeGreaterThan(100);
  });

  test('el objetivo se recuerda al volver a abrir la app', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('radio', { name: /Mantener peso/ }).click();
    await expect(goals.getByRole('radio', { name: /Mantener peso/ })).toHaveAttribute('aria-checked', 'true');
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const again = await openUserSection(page, 'Objetivos y medición');
    await expect(again.getByRole('radio', { name: /Mantener peso/ })).toHaveAttribute('aria-checked', 'true');
  });
});

test('la política de contenido solo deja conectar a Open Food Facts (la foto de los productos) y a Overpass (el mapa de la zona)', async ({ page }) => {
  await openDemo(page);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  // Open Food Facts (foto del producto) y Overpass con su servidor de respaldo (el mapa de la zona al navegar): los dos usos de internet.
  expect(policy).toContain("connect-src 'self' https://world.openfoodfacts.org https://overpass-api.de https://overpass.kumi.systems;");
  expect(policy).toContain("img-src 'self' data: https://images.openfoodfacts.org https://static.openfoodfacts.org;");
  expect(policy).toContain("default-src 'none'");
  expect(policy).not.toContain("'unsafe-eval'"); // solo 'wasm-unsafe-eval': compilar WebAssembly, no eval()
});

test.describe('el mismo orden de formas de anotar en todos los menús', () => {
  const ORDER = [/Pesar con la báscula/, /Escanear un código de barras/, /Contarlo con tus palabras/, /Añadir las calorías a mano/];
  const titles = (dialog: Locator): Promise<string[]> => dialog.locator('.menu-row strong').allTextContents();

  test('en «He comido algo» y al añadir un ingrediente a un plato: báscula, código de barras, palabras y, la última, a mano', async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    const dialog = await openMealSheet(page);
    const main = await titles(dialog);
    expect(main).toHaveLength(4);
    ORDER.forEach((expected, i) => expect(main[i]).toMatch(expected));
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Plato de prueba');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    const ingredient = await titles(dialog);
    expect(ingredient).toEqual(main);
  });
});
