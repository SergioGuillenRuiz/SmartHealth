import type { Locator, Page } from '@playwright/test';
import { activePage, expect, openDemo, test } from './fixtures';
import { ean13, mockProducts, YOGUR } from './products';

// La báscula de cocina (RENPHO Smart Nutrition Scale 1): conectarla aprendiendo su protocolo, pesar la comida en «He comido algo», montar un plato ingrediente a ingrediente con la
// tara, tomar el peso en los campos de gramos y gestionarla desde el menú de perfil. Todo contra una báscula simulada que se controla desde la página (`window.__smartringScale`).

type Sim = { setWeight(g: number): void; setAwake(awake: boolean): void; isAwake(): boolean; connectedCount(): number; watcherCount(): number };
declare global {
  interface Window {
    __smartringScale?: Sim;
  }
}

const dialog = (page: Page): Locator => page.locator('dialog.sheet[open]');
const weigh = (page: Page, grams: number): Promise<void> => page.evaluate((g) => window.__smartringScale?.setWeight(g), grams);
const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });

async function openMeal(page: Page): Promise<Locator> {
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page);
}

async function savedKv(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get(wanted);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }, key);
}

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

/** El emparejado entero como lo haría una persona: buscar, elegir, vaciar, pesar y escribir lo que marca, y comprobar con otro peso. */
async function pairScale(page: Page, options: { first?: number; second?: number } = {}): Promise<void> {
  const { first = 355, second = 480 } = options;
  const sheet = await openMeal(page);
  await sheet.getByRole('button', { name: /Pesar con la báscula/ }).click();
  await sheet.getByRole('button', { name: 'Buscar la báscula' }).click();
  await expect(sheet.getByRole('heading', { name: 'Elige tu báscula' })).toBeVisible();
  await sheet.getByRole('button', { name: /RENPHO-SCALE/ }).click();
  await expect(sheet.getByRole('heading', { name: 'Quita todo de la báscula' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Ya marca 0' }).click();
  await page.waitForTimeout(300); // la persona tarda en poner algo
  await weigh(page, first);
  await page.waitForTimeout(1_300); // y en que se quede quieta
  await sheet.getByLabel('Lo que marca (g)').fill(String(first));
  await sheet.getByRole('button', { name: 'Aprender' }).click();
  await expect(sheet.getByRole('heading', { name: 'Comprueba que se lee bien' })).toBeVisible();
  await weigh(page, second);
  await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Quieta');
  await sheet.getByRole('button', { name: 'Sí, coincide' }).click();
  await expect(sheet.getByRole('heading', { name: /Báscula lista/ })).toBeVisible();
  await sheet.getByRole('button', { name: 'Listo' }).click();
}

const liveNumber = (page: Page): Locator => dialog(page).getByRole('group', { name: 'Peso de la báscula' }).locator('.sc-live__number strong');

test.describe('emparejar la báscula', () => {
  test('sin báscula emparejada, «Pesar con la báscula» va el primero y dice que se conecta una vez', async ({ page }) => {
    await openDemo(page);
    const sheet = await openMeal(page);
    const first = sheet.locator('ul.menu').first().locator('li').first();
    await expect(first).toContainText('Pesar con la báscula');
    await expect(first).toContainText('Conéctala una vez');
  });

  test('el asistente la busca, la ordena la primera (se llama RENPHO), aprende dónde va el peso y la deja guardada', async ({ page }) => {
    await openDemo(page);
    const sheet = await openMeal(page);
    await sheet.getByRole('button', { name: /Pesar con la báscula/ }).click();
    await sheet.getByRole('button', { name: 'Buscar la báscula' }).click();
    const devices = sheet.getByRole('list', { name: 'Dispositivos encontrados' }).locator('li');
    await expect(devices).toHaveCount(3);
    await expect(devices.first()).toContainText('RENPHO-SCALE');
    await expect(devices.first()).toContainText('muy cerca');
    await expect(devices.last()).toContainText('Dispositivo sin nombre');
    await devices.first().getByRole('button').click();
    await expect(sheet.getByRole('heading', { name: 'Quita todo de la báscula' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Ya marca 0' }).click();

    // Sin escribir nada coherente no aprende: lo dice y se puede probar otra vez.
    await weigh(page, 355);
    await page.waitForTimeout(1_300);
    await sheet.getByLabel('Lo que marca (g)').fill('777');
    await sheet.getByRole('button', { name: 'Aprender' }).click();
    await expect(sheet.getByRole('alert').or(sheet.getByText(/No encuentro el peso/))).toBeVisible();
    await sheet.getByLabel('Lo que marca (g)').fill('355');
    await sheet.getByRole('button', { name: 'Aprender' }).click();
    await expect(sheet.getByRole('heading', { name: 'Comprueba que se lee bien' })).toBeVisible();
    // «Sí, coincide» espera a ver otro peso.
    const yes = sheet.getByRole('button', { name: 'Sí, coincide' });
    await weigh(page, 480);
    await expect(yes).toBeEnabled();
    await yes.click();
    await expect(sheet.getByRole('heading', { name: /Báscula lista/ })).toBeVisible();
    const saved = (await savedKv(page, 'scale')) as { id: string; name: string; decoder: { source: string; width: number; divisor: number } };
    expect(saved).toMatchObject({ id: 'SIM-SCALE-01', name: 'RENPHO-SCALE', decoder: { source: 'n:ffe0/ffe1', width: 2, divisor: 1 } });
  });

  for (const format of ['be16', 'le10', 'ascii', 'advert'] as const) {
    test(`aprende una báscula que manda el peso en formato «${format}» y luego lo lee solo`, async ({ page }) => {
      await page.goto(`/?demo=1&scale=${format}`);
      await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
      await pairScale(page);
      await weigh(page, 250);
      await expect(liveNumber(page)).toHaveText('250');
      await weigh(page, 1_250);
      await expect(liveNumber(page)).toHaveText('1250');
    });
  }

  test('cerrada la app y vuelta a abrir, la báscula sigue emparejada y se conecta sola al abrir la hoja', async ({ page }) => {
    await openDemo(page);
    await pairScale(page);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openMeal(page);
    await expect(sheet.locator('ul.menu').first().locator('li').first()).not.toContainText('Conéctala una vez');
    await sheet.getByRole('button', { name: /Pesar con la báscula/ }).click();
    await weigh(page, 90);
    await expect(liveNumber(page)).toHaveText('90');
  });
});

test.describe('pesar la comida', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?demo=1&scalepaired=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  });

  async function openWeigh(page: Page): Promise<Locator> {
    const sheet = await openMeal(page);
    await sheet.getByRole('button', { name: /Pesar con la báscula/ }).click();
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toBeVisible();
    return sheet;
  }

  test('di qué es y los gramos los pone la báscula: sale lo que sería y se anota con los gramos pesados', async ({ page }) => {
    const sheet = await openWeigh(page);
    await expect(sheet).toContainText('Pon la comida en la báscula');
    await sheet.getByLabel('¿Qué es?').fill('pechuga de pollo');
    await expect(sheet).toContainText('Pon «pechuga de pollo» en la báscula');
    await weigh(page, 250);
    await expect(sheet).toContainText('Esperando a que la báscula se quede quieta');
    const preview = sheet.getByRole('group', { name: 'Lo que saldría' });
    await expect(preview).toContainText('Pechuga de pollo');
    await expect(preview).toContainText(/250\s*g · 413 kcal/);
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();
    // Con un solo ingrediente, el formulario de debajo trae lo calculado y se anota.
    await expect(sheet.getByLabel('Calorías (kcal)')).toHaveValue('413');
    await sheet.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 413 kcal' })).toBeVisible();
    const meal = (await savedMeals(page)).find((m) => m.name === 'Pechuga de pollo');
    expect(meal).toMatchObject({ source: 'scale', kcal: 413, grams: 250 });
  });

  test('un plato ingrediente a ingrediente sobre la misma báscula: resta lo ya pesado y entiende la tara', async ({ page }) => {
    const sheet = await openWeigh(page);
    await sheet.getByLabel('¿Qué es?').fill('pechuga de pollo');
    await weigh(page, 250);
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();

    // El arroz se pone encima sin quitar el pollo: la báscula marca 400 y el arroz son 150.
    await sheet.getByLabel('¿Qué más vas a añadir?').fill('arroz');
    await weigh(page, 400);
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Sin contar los 250');
    await expect(liveNumber(page)).toHaveText('150');
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toContainText(/150\s*g/);
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();

    // Se quita todo (o se pulsa TARA) y se pesa otra cosa: se empieza de cero.
    await weigh(page, 0);
    await sheet.getByLabel('¿Qué más vas a añadir?').fill('manzana');
    await weigh(page, 120);
    await expect(liveNumber(page)).toHaveText('120');
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toContainText(/120\s*g/);
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();

    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(3);
    await expect(list.getByLabel('Cantidad de Pechuga de pollo (g)')).toHaveValue('250');
    await expect(list.getByLabel('Cantidad de Arroz cocido (g)')).toHaveValue('150');
    // El plato entero se anota con lo que pesó: 250 + 150 + 120 g.
    await sheet.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Comida anotada: \d+ kcal/ })).toBeVisible();
    const meal = (await savedMeals(page)).find((m) => String(m.name).includes('Pechuga de pollo'));
    expect(meal).toMatchObject({ source: 'scale', grams: 520 });
  });

  // El fallo de «escanear desde el pesaje»: el producto se anotaba en el diario y la hoja se cerraba, en vez de sumarse al plato que se pesa y seguir pesando.
  async function scanFromWeigh(page: Page, code: string): Promise<Locator> {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
    });
    await mockProducts(page, [YOGUR]);
    const sheet = await openWeigh(page);
    await sheet.getByLabel('¿Qué es?').fill('pechuga de pollo');
    await weigh(page, 250);
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();
    await sheet.getByRole('button', { name: 'Escanear el código de barras' }).click();
    await expect(sheet.getByLabel('O teclea el código')).toBeVisible();
    await sheet.getByLabel('O teclea el código').fill(code);
    await sheet.getByRole('button', { name: 'Buscar' }).click();
    return sheet;
  }
  /** La demo trae comidas de ejemplo: «no se ha anotado nada» es que el recuento no cambió. */
  const mealCount = async (page: Page): Promise<number> => (await savedMeals(page)).length;

  test('un producto escaneado desde el pesaje es un ingrediente más del plato: no se anota ni se cierra la hoja', async ({ page }) => {
    const sheet = await scanFromWeigh(page, '8410000000016');
    const before = await mealCount(page);
    await expect(sheet.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Anotar', exact: true })).toHaveCount(0);
    // El yogur se pone encima del pollo: la báscula marca 330 y el yogur son 80 (se resta lo ya pesado).
    await weigh(page, 330);
    await expect(sheet.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('80');
    await sheet.getByRole('button', { name: 'Añadir al plato' }).click();

    // De vuelta en el pesaje, con los dos ingredientes en el mismo plato, la hoja abierta y NADA anotado todavía.
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toBeVisible();
    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(2);
    await expect(list.getByLabel('Cantidad de Pechuga de pollo (g)')).toHaveValue('250');
    await expect(list.getByLabel('Cantidad de Yogur natural · Marca (g)')).toHaveValue('80');
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada' })).toHaveCount(0);
    expect(await mealCount(page)).toBe(before);
    // Lo escaneado ya estaba encima de la báscula: el siguiente ingrediente se mide sobre los 330 g.
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Sin contar los 330');

    // Se sigue pesando: otro ingrediente más, y el plato entero se anota de una vez.
    await sheet.getByLabel('¿Qué más vas a añadir?').fill('arroz');
    await weigh(page, 480);
    await expect(liveNumber(page)).toHaveText('150');
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();
    await expect(list.locator(':scope > li')).toHaveCount(3);
    await sheet.getByRole('button', { name: 'Anotar', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /Comida anotada: \d+ kcal/ })).toBeVisible();
    // El plato entero (pollo + yogur + arroz) es UNA sola comida.
    expect(await mealCount(page)).toBe(before + 1);
    expect((await savedMeals(page)).find((m) => m.source === 'scale')).toMatchObject({ source: 'scale', grams: 480 });
  });

  test('si los gramos del producto escaneado se escriben a mano, no estaba en la báscula y no cambia lo ya pesado', async ({ page }) => {
    const sheet = await scanFromWeigh(page, '8410000000016');
    const before = await mealCount(page);
    await expect(sheet.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await sheet.getByLabel('Cantidad que has comido (g o ml)').fill('90');
    await weigh(page, 255); // da igual lo que marque: los gramos los puso la persona
    await page.waitForTimeout(1_000);
    await expect(sheet.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('90');
    await sheet.getByRole('button', { name: 'Añadir al plato' }).click();
    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.getByLabel('Cantidad de Yogur natural · Marca (g)')).toHaveValue('90');
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Sin contar los 250');
    expect(await mealCount(page)).toBe(before);
  });

  test('«Volver a pesar» desde el código de barras conserva el plato', async ({ page }) => {
    const sheet = await scanFromWeigh(page, '8410000000016');
    await expect(sheet.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Volver a pesar' }).click();
    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(1);
    await expect(list.getByLabel('Cantidad de Pechuga de pollo (g)')).toHaveValue('250');
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Sin contar los 250');
  });

  test('un código que no está en la base y se anota a mano desde el pesaje también se suma al plato', async ({ page }) => {
    const sheet = await scanFromWeigh(page, ean13('841000000004'));
    const before = await mealCount(page);
    await sheet.getByRole('button', { name: 'Anotarlo a mano' }).click();
    await expect(sheet.getByLabel('Cantidad (g o ml)')).toBeVisible();
    await sheet.getByLabel('Ingrediente (opcional)').fill('Salsa');
    await sheet.getByLabel('Calorías (kcal)').fill('60');
    await sheet.getByLabel('Cantidad (g o ml)').fill('30');
    await sheet.getByRole('button', { name: 'Añadir al plato' }).click();
    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(2);
    await expect(list.getByLabel('Cantidad de Salsa (g)')).toHaveValue('30');
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada' })).toHaveCount(0);
    expect(await mealCount(page)).toBe(before);
    // Lo escrito a mano no estaba en la báscula.
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Sin contar los 250');
  });

  test('pesando un ingrediente de un plato guardado, lo escaneado se suma al ingrediente y se sigue pesando', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
    });
    await mockProducts(page, [YOGUR]);
    const sheet = await openMeal(page);
    const before = await mealCount(page);
    await sheet.getByRole('button', { name: 'Guardar un plato nuevo' }).click();
    await sheet.getByLabel('Nombre del plato').fill('Merienda');
    await sheet.getByRole('button', { name: 'Añadir ingrediente' }).click();
    await sheet.getByRole('button', { name: /Pesar con la báscula/ }).click();
    await sheet.getByLabel('¿Qué ingrediente es?').fill('arroz');
    await weigh(page, 150);
    await sheet.getByRole('button', { name: 'Añadir', exact: true }).click();
    await sheet.getByRole('button', { name: 'Escanear el código de barras' }).click();
    await sheet.getByLabel('O teclea el código').fill('8410000000016');
    await sheet.getByRole('button', { name: 'Buscar' }).click();
    await expect(sheet.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Añadir al plato' }).click();
    // Sigue en el pesaje del ingrediente (no ha saltado al plato guardado) con las dos cosas dentro.
    const list = sheet.getByRole('list', { name: 'Lo que se ha calculado' });
    await expect(list.locator(':scope > li')).toHaveCount(2);
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toBeVisible();
    // «Añadir al plato» del formulario de debajo lo lleva al constructor: desde la ronda 46 cada cosa pesada o escaneada entra como su propio ingrediente (con sus gramos), no sumada en uno.
    await sheet.getByRole('button', { name: 'Añadir al plato' }).click();
    const ingredients = sheet.getByRole('list', { name: 'Ingredientes del plato' }).getByRole('listitem');
    await expect(ingredients).toHaveCount(2);
    await expect(ingredients.nth(0)).toContainText(/arroz/i);
    await expect(ingredients.nth(1)).toContainText(/yogur/i);
    expect(await mealCount(page)).toBe(before);
  });

  test('mientras el peso sube no se calcula nada: espera a que se quede quieta', async ({ page }) => {
    const sheet = await openWeigh(page);
    await sheet.getByLabel('¿Qué es?').fill('manzana');
    await weigh(page, 80);
    await page.waitForTimeout(250);
    await weigh(page, 140);
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Pesando');
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toHaveCount(0);
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toContainText(/140\s*g/, { timeout: 5_000 });
  });

  test('sugiere alimentos al escribir y lo que no reconoce lo dice', async ({ page }) => {
    const sheet = await openWeigh(page);
    await sheet.getByLabel('¿Qué es?').fill('platan');
    const suggestions = sheet.getByRole('list', { name: 'Sugerencias' });
    await expect(suggestions.locator('li').first()).toContainText('Plátano');
    await suggestions.getByRole('button', { name: /^Plátano/ }).first().click();
    await expect(sheet.getByLabel('¿Qué es?')).toHaveValue('Plátano');
    await weigh(page, 118);
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toContainText('Plátano');

    await sheet.getByLabel('¿Qué es?').fill('zzzqqq');
    await expect(sheet.getByText(/No he reconocido ningún alimento \(«zzzqqq»\)/)).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Lo que saldría' })).toHaveCount(0);
  });

  test('si la báscula se duerme lo dice y, al despertar, vuelve sola', async ({ page }) => {
    const sheet = await openWeigh(page);
    await weigh(page, 60);
    await expect(liveNumber(page)).toHaveText('60');
    await page.evaluate(() => window.__smartringScale?.setAwake(false));
    await expect(sheet.getByRole('group', { name: 'Peso de la báscula' })).toContainText(/Enciende la báscula|se ha dormido/);
    await expect(liveNumber(page)).toHaveText('—');
    await page.evaluate(() => window.__smartringScale?.setAwake(true));
    await expect(sheet.locator('.sc-status')).toContainText('Conectada', { timeout: 10_000 });
    await weigh(page, 75);
    await expect(liveNumber(page)).toHaveText('75');
  });

  test('al cerrar la hoja la báscula se suelta pasado un rato', async ({ page }) => {
    const sheet = await openWeigh(page);
    await expect.poll(() => page.evaluate(() => window.__smartringScale?.connectedCount())).toBe(1);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__smartringScale?.connectedCount()), { timeout: 30_000 }).toBe(0);
  });
});

test.describe('la báscula en los campos de gramos', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?demo=1&scalepaired=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  });

  test('al contar con palabras, el botón de la báscula pone sus gramos en un alimento calculado', async ({ page }) => {
    const sheet = await openMeal(page);
    await sheet.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await sheet.getByLabel('¿Qué has comido?').fill('200 g de arroz');
    await sheet.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(sheet.getByLabel('Calorías (kcal)')).toHaveValue('260');
    // Sin nada en la báscula no hay botón; con algo encima y quieto, lo hay.
    const take = sheet.getByRole('button', { name: /Tomar .* de la báscula para Arroz cocido/ });
    await expect(take).toHaveCount(0);
    await weigh(page, 100);
    await expect(take).toBeEnabled();
    await take.click();
    await expect(sheet.getByLabel('Cantidad de Arroz cocido (g)')).toHaveValue('100');
    await expect(sheet.getByLabel('Calorías (kcal)')).toHaveValue('130');
  });

  test('en un producto de código de barras los gramos se ponen solos con lo que hay en la báscula', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
    });
    await mockProducts(page, [YOGUR]);
    const sheet = await openMeal(page);
    await sheet.getByRole('button', { name: /Escanear un código de barras/ }).click();
    await sheet.getByLabel('O teclea el código').fill('8410000000016');
    await sheet.getByRole('button', { name: 'Buscar' }).click();
    await expect(sheet.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await expect(sheet.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('125'); // la ración de la etiqueta
    await weigh(page, 200);
    await expect(sheet.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('200');
    await expect(sheet.getByRole('status').filter({ hasText: 'kcal' })).toContainText('122');
    // Lo que se escribe a mano manda sobre la báscula.
    await sheet.getByLabel('Cantidad que has comido (g o ml)').fill('90');
    await weigh(page, 210);
    await page.waitForTimeout(1_000);
    await expect(sheet.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('90');
  });
});

test.describe('báscula de cocina en el menú de dispositivos', () => {
  test('abrir Dispositivos NO conecta ni escucha la báscula (estorbaba a la sincronización del anillo) y sincronizar a mano la deja en paz', async ({ page }) => {
    await page.goto('/?demo=1&scalepaired=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await page.getByRole('button', { name: /^Dispositivos:/ }).click();
    const section = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
    await expect(section).toContainText('RENPHO-SCALE');
    await expect(section).toContainText('Se conecta al pesar.');
    await expect(section.getByRole('group', { name: 'Peso de la báscula' })).toHaveCount(0);
    // Con la hoja abierta y pasado un buen rato, la báscula ni está conectada ni se escuchan sus anuncios.
    await page.waitForTimeout(2_500);
    expect(await page.evaluate(() => [window.__smartringScale?.connectedCount(), window.__smartringScale?.watcherCount()])).toEqual([0, 0]);
    // Sincronizar el anillo a mano desde esa misma hoja termina y la báscula sigue sin tocarse.
    await section.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect(section.getByRole('list', { name: 'Resultado de la sincronización' })).toContainText('Sincronizado', { timeout: 30_000 });
    expect(await page.evaluate(() => [window.__smartringScale?.connectedCount(), window.__smartringScale?.watcherCount()])).toEqual([0, 0]);
  });

  test('la báscula conectada al pesar se suelta cuando el anillo se reserva (sincronizar a mano) y no vuelve a escuchar mientras tanto', async ({ page }) => {
    await page.goto('/?demo=1&scalepaired=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await openMeal(page);
    await expect(sheet.getByRole('button', { name: 'Pesar con la báscula' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__smartringScale?.connectedCount())).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // Dentro del margen de después de cerrar «He comido algo» la báscula sigue conectada; al reservarse el anillo se suelta en el acto.
    await page.getByRole('button', { name: /^Dispositivos:/ }).click();
    const devices = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
    await devices.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect.poll(() => page.evaluate(() => window.__smartringScale?.connectedCount()), { timeout: 5_000 }).toBe(0);
    await expect(devices.getByRole('list', { name: 'Resultado de la sincronización' })).toContainText('Sincronizado', { timeout: 30_000 });
  });

  test('vive en Dispositivos (no en el perfil), guarda el informe y se olvida con un segundo toque', async ({ page }) => {
    await page.goto('/?demo=1&scalepaired=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    // El menú de perfil ya no lleva la báscula.
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
    await expect(menu.getByRole('button', { name: 'Mis productos' })).toBeVisible();
    await expect(menu.getByRole('button', { name: /^Báscula de cocina/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Se conecta al pesar («He comido algo») y, dentro del margen de después, su peso y su informe están en Dispositivos.
    await openMeal(page);
    await expect.poll(() => page.evaluate(() => window.__smartringScale?.connectedCount())).toBe(1);
    await weigh(page, 333);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Dispositivos:/ }).click();
    const section = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
    await expect(section).toContainText('RENPHO-SCALE');
    await expect(section.locator('.sc-live__number strong')).toHaveText('333');

    const download = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Guardar el informe de la báscula' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^smarthealth-bascula-\d{4}-\d{2}-\d{2}\.txt$/);
    const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
    expect(text).toContain('INFORME DE LA BÁSCULA');
    expect(text).toContain('RENPHO-SCALE · SIM-SCALE-01');
    expect(text).toContain('# n:ffe0/ffe1 · 7 bytes');

    await section.getByRole('button', { name: 'Olvidar la báscula' }).click();
    const sure = section.getByRole('button', { name: 'Sí, olvidarla' });
    await expect(sure).toBeDisabled(); // un doble toque no vale
    await expect(sure).toBeEnabled();
    await sure.click();
    await expect(section.getByRole('heading', { name: 'Conectar la báscula' })).toBeVisible();
    expect(await savedKv(page, 'scale')).toBeUndefined();
  });
});
