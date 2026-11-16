import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, test } from './fixtures';
import { mockProducts, YOGUR } from './products';

// Platos guardados dentro de «He comido algo»: una barra deslizable arriba con los platos (con su foto), un + para guardar uno nuevo, el constructor (nombre, foto, ingredientes
// por las tres vías de siempre y raciones) y el paso de anotar raciones. Todo en el móvil: la foto sale de la cámara y va dentro del plato.

const sheet = (page: Page): Locator => page.locator('dialog.sheet[open]');
const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });

async function openMealSheet(page: Page): Promise<Locator> {
  await goTab(page, 'Resumen');
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  await expect(page.getByRole('dialog', { name: 'He comido algo', exact: true })).toBeVisible();
  return sheet(page);
}

/** Lo que hay guardado en `kv` bajo un prefijo (platos y comidas), leído del almacén de la demostración. */
async function stored(page: Page, prefix: 'dish:' | 'meals:'): Promise<Array<Record<string, any>>> {
  return page.evaluate(async (from) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound(from, from.slice(0, -1) + String.fromCharCode(from.charCodeAt(from.length - 1) + 1), false, true));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return from === 'meals:' ? (values as Array<Array<Record<string, any>>>).flat() : (values as Array<Record<string, any>>);
  }, prefix);
}

interface SeedDish {
  id: string;
  name: string;
  servings?: number;
  photo?: boolean;
  /** Que se anotó hace un momento (con el reloj de la página, que en algunas pasadas es otro). */
  usedNow?: boolean;
  ingredients?: Array<Record<string, unknown>>;
}

/** Deja platos ya guardados en el almacén (con una foto de verdad, hecha en la página, si se pide). Hay que abrir la hoja DESPUÉS: la barra se lee al abrirla. */
async function seedDishes(page: Page, dishes: SeedDish[]): Promise<void> {
  await page.evaluate(async (list) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 90;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#d98a3d';
      context.fillRect(0, 0, 120, 90);
      context.fillStyle = '#fff';
      context.fillRect(30, 20, 60, 50);
    }
    const photo = canvas.toDataURL('image/jpeg', 0.7);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      for (const dish of list) {
        tx.objectStore('kv').put(
          {
            id: dish.id,
            name: dish.name,
            createdMs: now - 86_400_000,
            updatedMs: now - 86_400_000,
            ...(dish.usedNow ? { lastUsedMs: now } : {}),
            // Con `servings`, guardado como lo hacía la versión con raciones (los ingredientes sumaban para esas raciones): la app lo lee como una ración.
            ...(dish.servings !== undefined ? { servings: dish.servings } : {}),
            ingredients: dish.ingredients ?? [
              { name: 'Lentejas', kcal: 600, proteinG: 40, carbsG: 100, fatG: 4, grams: 400 },
              { name: 'Chorizo', kcal: 300, proteinG: 15, carbsG: 2, fatG: 26, saltG: 2, grams: 100 },
            ],
            ...(dish.photo ? { photo } : {}),
          },
          `dish:${dish.id}`,
        );
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, dishes);
}

/** Quita la cámara de la página (antes de que cargue): sin ella el escáner no lee solo el código de la cámara falsa. */
async function withoutCamera(page: Page, error = 'NotFoundError'): Promise<void> {
  await page.addInitScript((name) => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', name));
  }, error);
}

test.describe('platos guardados: la barra de «He comido algo»', () => {
  test('arriba de todo hay «Mis platos»: sin ninguno guardado lo dice, y debajo el botón + centrado y las tres formas de anotar', async ({ page }) => {
    await openDemo(page);
    const dialog = await openMealSheet(page);
    const section = dialog.getByRole('region', { name: 'Mis platos' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('Guarda aquí lo que preparas a menudo');
    await expect(dialog.getByRole('list', { name: 'Platos guardados' })).toHaveCount(0);
    const add = dialog.getByRole('button', { name: 'Guardar un plato nuevo' });
    await expect(add).toBeVisible();
    // Va el primero en la hoja, con el + debajo de la barra y centrado, y las tres formas de siempre debajo.
    const box = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
      const found = await locator.boundingBox();
      expect(found).not.toBeNull();
      return found!;
    };
    const sectionBox = await box(section);
    const addBox = await box(add);
    const firstOption = await box(dialog.getByRole('button', { name: /Escanear un código de barras/ }));
    expect(addBox.y, 'el + va dentro de la sección de platos').toBeGreaterThanOrEqual(sectionBox.y);
    expect(addBox.y + addBox.height, 'y acaba antes de las otras formas').toBeLessThanOrEqual(firstOption.y);
    expect(Math.abs(addBox.x + addBox.width / 2 - (sectionBox.x + sectionBox.width / 2)), 'centrado').toBeLessThan(4);
  });

  test('los platos guardados salen en una barra que se desliza, con su foto y las calorías del plato, el último anotado primero', async ({ page }) => {
    await openDemo(page);
    const longName = 'Lentejas de la abuela con chorizo y verduras de temporada';
    await seedDishes(page, [
      { id: 'a', name: 'Arroz', photo: true, servings: 3 },
      { id: 'b', name: 'Bocadillo', servings: 3 },
      { id: 'c', name: longName, photo: true, usedNow: true, servings: 3 },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, name: `Extra ${i}`, servings: 3 })),
    ]);
    const dialog = await openMealSheet(page);
    const rail = dialog.getByRole('list', { name: 'Platos guardados' });
    await expect(rail).toBeVisible();
    const cards = rail.getByRole('button');
    await expect(cards).toHaveCount(9);
    // El que se anotó la última vez va primero, y cada tarjeta dice las calorías del plato (de antes, con 3 raciones: 900 kcal entre 3 = 300).
    await expect(cards.first()).toContainText('Lentejas de la abuela');
    await expect(cards.first()).toContainText('300');
    await expect(cards.first().locator('img.dish-photo')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    // Las que no tienen foto llevan la imagen de lo que parecen por el nombre.
    await expect(rail.getByRole('button', { name: /Bocadillo/ }).locator('img.dish-photo')).toHaveCount(0);
    await expect(rail.getByRole('button', { name: /Bocadillo/ }).locator('img')).toHaveCount(1);
    // Se desliza de lado: hay más tarjetas que ancho y el nombre largo no ensancha la tarjeta.
    const metrics = await rail.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(metrics.overflowX).toBe('auto');
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    const widths = await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(new Set(widths).size, 'todas las tarjetas miden lo mismo').toBe(1);
    // La hoja no se desborda por el lado (solo la barra se desliza).
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
});

test.describe('guardar un plato nuevo', () => {
  test('con ingredientes a mano, con palabras y con el código de barras, y una foto: se guarda (sin raciones) y sale en la barra con su foto', async ({ page }) => {
    await openDemo(page);
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo plato', exact: true })).toBeVisible();
    await dialog.getByLabel('Nombre del plato').fill('Desayuno de siempre');

    // Ingrediente a mano.
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await expect(dialog.getByRole('button', { name: /Escanear un código de barras/ })).toBeVisible();
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Ingrediente (opcional)').fill('Pan');
    await dialog.getByLabel('Calorías (kcal)').fill('160');
    await dialog.getByLabel('Hidratos (g)').fill('30');
    // Un ingrediente lleva su cantidad (sobre ella se calcula lo que sale al comer otra): sin ella no se añade.
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    await expect(dialog.getByRole('alert')).toContainText('La cantidad tiene que estar entre 1 y 10.000 g');
    await dialog.getByLabel('Cantidad (g o ml)').fill('50 g');
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    const ingredients = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    await expect(ingredients.getByRole('listitem')).toHaveCount(1);
    await expect(ingredients).toContainText('Pan');

    // Ingrediente con palabras.
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('dos huevos');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    await expect(ingredients.getByRole('listitem')).toHaveCount(2);

    // Ingrediente con el código de barras (la cámara falsa de las pruebas ve el del yogur y lo lee sola).
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    await expect(ingredients.getByRole('listitem')).toHaveCount(3);
    await expect(ingredients).toContainText('Yogur natural');
    await expect(ingredients).toContainText('125 g');

    // La foto, con la cámara.
    await dialog.getByRole('button', { name: 'Hacer una foto' }).click();
    const video = dialog.locator('video.scan__video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth), { message: 'la cámara da imagen' }).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: 'Sacar foto' }).click();
    const preview = dialog.getByRole('img', { name: 'Foto del plato' });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await expect(video).toHaveCount(0); // la cámara se apaga al sacar la foto

    // Ya no hay raciones: solo el total de la receta.
    await expect(dialog.getByLabel('Raciones que salen')).toHaveCount(0);
    await expect(dialog.locator('p.meal__total')).toContainText('Total');
    await expect(dialog.locator('p.meal__total')).not.toContainText('ración');
    await dialog.getByRole('button', { name: 'Guardar plato' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Plato guardado' })).toBeVisible();

    // Vuelve a la barra, donde ya está el plato con su foto.
    const rail = dialog.getByRole('list', { name: 'Platos guardados' });
    await expect(rail.getByRole('button', { name: /Desayuno de siempre/ })).toBeVisible();
    await expect(rail.getByRole('button', { name: /Desayuno de siempre/ }).locator('img.dish-photo')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);

    const [saved] = await stored(page, 'dish:');
    expect(saved).toMatchObject({ name: 'Desayuno de siempre' });
    expect(saved).not.toHaveProperty('servings');
    expect(saved?.ingredients).toHaveLength(3);
    expect(saved?.ingredients[0]).toMatchObject({ name: 'Pan', kcal: 160, carbsG: 30, grams: 50 });
    expect(saved?.ingredients[2]).toMatchObject({ barcode: '8410000000016', grams: 125 });
    expect(saved?.photo).toMatch(/^data:image\/jpeg;base64,/);
    expect(String(saved?.photo).length, 'la foto es pequeña').toBeLessThan(120_000);
    // Guardar un plato no anota ninguna comida.
    expect((await stored(page, 'meals:')).filter((m) => m.source === 'dish')).toHaveLength(0);
  });

  test('lo contado con palabras entra como un ingrediente POR ALIMENTO y al comer el plato se cambian los gramos de cada uno (ronda 46)', async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Arroz con pollo');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('200 g de arroz blanco cocido y 150 g de pechuga de pollo');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    // Dos alimentos: se avisa de que entran por separado.
    await expect(dialog.getByRole('status').filter({ hasText: 'ingredientes por separado' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    const ingredients = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    await expect(ingredients.getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Guardar plato' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Plato guardado' })).toBeVisible();

    const [saved] = await stored(page, 'dish:');
    expect(saved?.ingredients).toHaveLength(2);
    expect(saved?.ingredients[0]).toMatchObject({ grams: 200 });
    expect(saved?.ingredients[1]).toMatchObject({ grams: 150 });

    // Al comerlo: un campo de gramos por ingrediente; se cambia solo el del arroz.
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Arroz con pollo/ }).click();
    const rows = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    await expect(rows.getByRole('textbox')).toHaveCount(2);
    const rice = rows.getByRole('textbox').first();
    const chicken = rows.getByRole('textbox').nth(1);
    await expect(rice).toHaveValue('200');
    await expect(chicken).toHaveValue('150');
    await rice.fill('100');
    await expect(chicken).toHaveValue('150');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada' })).toBeVisible();
    const meal = (await stored(page, 'meals:')).find((m) => m.source === 'dish' && m.name === 'Arroz con pollo');
    expect(meal).toMatchObject({ grams: 250 });
  });

  test('si en el formulario se cambia el nombre o las cifras, lo contado con palabras entra como UN solo ingrediente', async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Guiso');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('200 g de arroz blanco cocido y 150 g de pechuga de pollo');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await dialog.getByLabel('Ingrediente (opcional)').fill('Mi mezcla');
    await dialog.getByLabel('Cantidad (g o ml)').fill('350');
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    const ingredients = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    await expect(ingredients.getByRole('listitem')).toHaveCount(1);
    await expect(ingredients).toContainText('Mi mezcla');
  });

  test('sin permiso de cámara avisa y el plato se guarda igual, sin foto', async ({ page }) => {
    await withoutCamera(page, 'NotAllowedError');
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Tostada');
    await dialog.getByRole('button', { name: 'Hacer una foto' }).click();
    await expect(dialog).toContainText('No hay permiso para usar la cámara');
    await expect(dialog).toContainText('sin foto');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
    await dialog.getByLabel('Calorías (kcal)').fill('180');
    await dialog.getByLabel('Cantidad (g o ml)').fill('60');
    await dialog.getByRole('button', { name: 'Añadir al plato' }).click();
    await dialog.getByRole('button', { name: 'Guardar plato' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Plato guardado' })).toBeVisible();
    const [saved] = await stored(page, 'dish:');
    expect(saved).toMatchObject({ name: 'Tostada' });
    expect(saved).not.toHaveProperty('photo');
    expect(saved?.ingredients[0]).toMatchObject({ name: 'Ingrediente', kcal: 180, grams: 60 });
    // La tarjeta lleva la imagen por el nombre, no una foto.
    await expect(dialog.getByRole('button', { name: /Tostada/ }).locator('img.dish-photo')).toHaveCount(0);
  });

  test('lo que falta se avisa al guardar: nombre e ingredientes', async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await dialog.getByRole('button', { name: 'Guardar plato' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('Ponle un nombre al plato');
    await expect(alert).toContainText('al menos un ingrediente');
    expect(await stored(page, 'dish:')).toHaveLength(0);
  });

  test('un plato a medias no se pierde por un toque de más: la hoja no se cierra y «volver» pide confirmar', async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeVisible(); // aún sin nada escrito: se puede cerrar
    await dialog.getByLabel('Nombre del plato').fill('Mi guiso');
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog.getByLabel('Nombre del plato')).toHaveValue('Mi guiso');
    // Añadir un ingrediente y volver al plato conserva lo escrito.
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await dialog.getByRole('button', { name: 'Volver al plato' }).click();
    await expect(dialog.getByLabel('Nombre del plato')).toHaveValue('Mi guiso');
    // Salir pide un segundo toque.
    await dialog.getByRole('button', { name: 'Volver a mis platos' }).click();
    await expect(dialog.getByRole('button', { name: 'Toca otra vez para descartar los cambios' })).toBeVisible();
    await expect(dialog.getByLabel('Nombre del plato')).toHaveValue('Mi guiso');
    await dialog.getByRole('button', { name: 'Toca otra vez para descartar los cambios' }).click();
    await expect(dialog.getByRole('region', { name: 'Mis platos' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeVisible();
    expect(await stored(page, 'dish:')).toHaveLength(0);
  });
});

test.describe('platos de antes de la ronda 46: lo calculado con palabras venía juntado en un solo ingrediente', () => {
  test('al abrir la hoja se reparte en sus alimentos, cada uno con sus gramos, y queda guardado así', async ({ page }) => {
    test.setTimeout(90_000); // el reparto lee la tabla y la base de productos: con la máquina muy cargada pasa de los 45 s de siempre
    await withoutCamera(page);
    await openDemo(page);
    // Como lo guardaba la versión anterior: UN ingrediente con los nombres unidos, los gramos sumados (150 + 11 + 180) y las cifras de todos juntos.
    await seedDishes(page, [
      {
        id: 'pollo-arroz',
        name: 'Pollo con arroz',
        ingredients: [{ name: 'Pollo (crudo) + Aceite de oliva + Arroz cocido', kcal: 513, proteinG: 34.3, carbsG: 50.4, fatG: 17.9, fiberG: 0.7, sugarsG: 0.2, saltG: 0.7, grams: 341 }],
      },
    ]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Pollo con arroz/ }).click();
    const rows = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    // El reparto se calcula tras abrir (hay que leer la tabla y la base de productos): se espera a que salgan los tres.
    await expect(rows.getByRole('listitem')).toHaveCount(3, { timeout: 60_000 });
    await expect(rows).not.toContainText(' + ');
    for (const [name, grams] of [['Pollo (crudo)', 150], ['Aceite de oliva', 11], ['Arroz cocido', 180]] as const) {
      const value = Number((await dialog.getByLabel(name, { exact: true }).inputValue()).replace(',', '.'));
      expect(Math.abs(value - grams), `${name}: ${value} g`).toBeLessThanOrEqual(Math.max(6, grams * 0.1));
    }
    // Las calorías de todo el plato siguen siendo las que se guardaron.
    await expect(dialog.locator('p.meal__total')).toContainText('513');
    // Y se cambia cada uno por separado.
    await dialog.getByLabel('Arroz cocido', { exact: true }).fill('0');
    await expect(dialog.locator('p.meal__total')).not.toContainText('513');
    // Quedó guardado así (no solo en pantalla).
    const [saved] = (await stored(page, 'dish:')).filter((d) => d.id === 'pollo-arroz');
    expect(saved?.ingredients.map((i: { name: string }) => i.name)).toEqual(['Pollo (crudo)', 'Aceite de oliva', 'Arroz cocido']);
    expect(saved?.ingredients.reduce((sum: number, i: { kcal: number }) => sum + i.kcal, 0)).toBe(513);
  });
});

test.describe('anotar un plato guardado', () => {
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
    await seedDishes(page, [
      { id: 'lentejas', name: 'Lentejas', photo: true },
      { id: 'otro', name: 'Otro plato', ingredients: [{ name: 'Café', kcal: 5 }] },
    ]);
  });

  test('un toque en el plato enseña cada ingrediente con sus gramos de la receta, y se anota con sus nutrientes', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas/ }).click();
    await expect(page.getByRole('dialog', { name: 'Anotar un plato', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Lentejas' })).toBeVisible();
    const rows = dialog.getByRole('list', { name: 'Ingredientes del plato' });
    await expect(rows.getByRole('listitem')).toHaveCount(2);
    await expect(rows).toContainText('Chorizo');
    // Ya no hay raciones: un campo de gramos por ingrediente, con los de la receta puestos.
    await expect(dialog.getByLabel('Raciones que has comido')).toHaveCount(0);
    await expect(dialog.getByLabel('Lentejas', { exact: true })).toHaveValue('400');
    await expect(dialog.getByLabel('Chorizo', { exact: true })).toHaveValue('100');
    await expect(dialog.locator('p.meal__total')).toContainText('900');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 900 kcal' })).toBeVisible();
    await expect(dialog).toBeHidden();

    const meal = (await stored(page, 'meals:')).find((m) => m.source === 'dish');
    expect(meal).toMatchObject({ name: 'Lentejas', kcal: 900, source: 'dish', grams: 500, dishId: 'lentejas' });
    expect(meal?.proteinG).toBeCloseTo(55, 1);
    expect(meal?.saltG).toBeCloseTo(2, 2);
    expect(meal).not.toHaveProperty('fiberG'); // ningún ingrediente la traía: sin dato, no cero
    // Y sale en la lista de la tarjeta del Resumen, con LA FOTO DEL PLATO como miniatura (máxima prioridad, antes que cualquier ilustración).
    const row = nutrition(page).locator('.food-meals__open', { hasText: 'Lentejas' });
    await expect(row).toBeVisible();
    await expect(row.locator('.meal-thumb--dish img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  });

  test('un plato sin foto sale en la lista con su ilustración de siempre, no con una foto', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Otro plato/ }).click();
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    const row = nutrition(page).locator('.food-meals__open', { hasText: 'Otro plato' });
    await expect(row).toBeVisible();
    await expect(row.locator('.meal-thumb')).toHaveCount(1);
    await expect(row.locator('.meal-thumb--dish')).toHaveCount(0);
  });

  test('la foto del plato también sale en la hoja de detalles de esa comida', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas/ }).click();
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    await nutrition(page).locator('.food-meals__open', { hasText: 'Lentejas' }).click();
    const detail = page.getByRole('dialog', { name: 'Comida', exact: true });
    await expect(detail.locator('.meal-thumb--dish img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  });

  test('los gramos de cada ingrediente se cambian por separado y la comida sale en proporción (a 0 g no entra)', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas/ }).click();
    const total = dialog.locator('p.meal__total');
    // Mitad de lentejas: 300 kcal las lentejas + 300 el chorizo.
    await dialog.getByLabel('Lentejas', { exact: true }).fill('200');
    await expect(total).toContainText('600');
    // Cada fila dice lo que aporta.
    await expect(dialog.getByRole('list', { name: 'Ingredientes del plato' }).getByRole('listitem').first()).toContainText('300 kcal');
    // Sin chorizo hoy.
    await dialog.getByLabel('Chorizo', { exact: true }).fill('0');
    await expect(total).toContainText('300');
    // Con comas y la unidad escrita también.
    await dialog.getByLabel('Chorizo', { exact: true }).fill('50,5 g');
    await expect(total).toContainText('452'); // 300 + 50,5 % de los 300 kcal del chorizo = 451,5
    await dialog.getByLabel('Chorizo', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    const meal = (await stored(page, 'meals:')).find((m) => m.source === 'dish');
    expect(meal).toMatchObject({ name: 'Lentejas', kcal: 300, grams: 200 });
    expect(meal?.proteinG).toBeCloseTo(20, 1);
    expect(meal?.fatG).toBeCloseTo(2, 1);
  });

  test('un plato guardado con raciones (la versión anterior) sale como una ración: cada ingrediente entre las raciones', async ({ page }) => {
    await seedDishes(page, [{ id: 'viejo', name: 'Olla de cocido', servings: 3 }]);
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Olla de cocido/ }).click();
    await expect(dialog.getByLabel('Lentejas', { exact: true })).toHaveValue('133,3');
    await expect(dialog.getByLabel('Chorizo', { exact: true })).toHaveValue('33,3');
    await expect(dialog.locator('p.meal__total')).toContainText('300');
  });

  test('un ingrediente sin cantidad (de antes) entra tal cual y no pide gramos; el plato se anota y pasa a ser el primero de la barra', async ({ page }) => {
    let dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Otro plato/ }).click();
    await expect(dialog.getByRole('list', { name: 'Ingredientes del plato' }).getByRole('textbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(dialog).toBeHidden();
    const meal = (await stored(page, 'meals:')).find((m) => m.source === 'dish');
    expect(meal).toMatchObject({ name: 'Otro plato', kcal: 5 });
    dialog = await openMealSheet(page);
    await expect(dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button').first()).toContainText('Otro plato');
  });

  test('una cantidad vacía, pasada o con todo a cero no se deja anotar, y dice por qué', async ({ page }) => {
    const dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas/ }).click();
    const anotar = dialog.getByRole('button', { name: 'Anotar' });
    const total = dialog.locator('p.meal__total');
    await dialog.getByLabel('Lentejas', { exact: true }).fill('');
    await expect(anotar).toBeDisabled();
    await expect(total).toContainText('Indica los gramos de Lentejas');
    await dialog.getByLabel('Lentejas', { exact: true }).fill('mucho');
    await expect(anotar).toBeDisabled();
    await dialog.getByLabel('Lentejas', { exact: true }).fill('20000');
    await expect(anotar).toBeDisabled();
    await expect(total).toContainText('como mucho');
    await dialog.getByLabel('Lentejas', { exact: true }).fill('0');
    await dialog.getByLabel('Chorizo', { exact: true }).fill('0');
    await expect(anotar).toBeDisabled();
    await expect(total).toContainText('algún ingrediente');
    // Cifras que no caben en una comida (más de 10.000 kcal).
    await dialog.getByLabel('Lentejas', { exact: true }).fill('9000');
    await dialog.getByLabel('Chorizo', { exact: true }).fill('9000');
    await expect(anotar).toBeDisabled();
    await expect(total).toContainText('baja alguna');
    await dialog.getByLabel('Lentejas', { exact: true }).fill('400');
    await dialog.getByLabel('Chorizo', { exact: true }).fill('100');
    await expect(anotar).toBeEnabled();
  });

  test('editar un plato cambia sus ingredientes y su nombre; borrarlo pide un segundo toque', async ({ page }) => {
    let dialog = await openMealSheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas/ }).click();
    await dialog.getByRole('button', { name: 'Editar plato' }).click();
    await expect(dialog.getByLabel('Nombre del plato')).toHaveValue('Lentejas');
    await expect(dialog.getByLabel('Raciones que salen')).toHaveCount(0);
    await expect(dialog.getByRole('img', { name: 'Foto del plato' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Quitar Chorizo' }).click();
    await dialog.getByLabel('Nombre del plato').fill('Lentejas veganas');
    await dialog.getByRole('button', { name: 'Quitar foto' }).click();
    await dialog.getByRole('button', { name: 'Guardar plato' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Plato actualizado' })).toBeVisible();
    let saved = (await stored(page, 'dish:')).find((d) => d.id === 'lentejas');
    expect(saved).toMatchObject({ name: 'Lentejas veganas' });
    expect(saved).not.toHaveProperty('servings');
    expect(saved?.ingredients).toHaveLength(1);
    expect(saved).not.toHaveProperty('photo');

    // Borrar: el primer toque solo avisa.
    dialog = sheet(page);
    await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas veganas/ }).click();
    await dialog.getByRole('button', { name: 'Editar plato' }).click();
    await dialog.getByRole('button', { name: 'Borrar plato' }).click();
    await expect(dialog.getByRole('button', { name: 'Toca otra vez para borrarlo' })).toBeVisible();
    expect((await stored(page, 'dish:')).map((d) => d.id).sort()).toEqual(['lentejas', 'otro']);
    await dialog.getByRole('button', { name: 'Toca otra vez para borrarlo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Plato borrado' })).toBeVisible();
    saved = (await stored(page, 'dish:')).find((d) => d.id === 'lentejas');
    expect(saved).toBeUndefined();
    await expect(dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button')).toHaveCount(1);
  });
});
