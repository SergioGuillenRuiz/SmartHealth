import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, openUserSection, test } from './fixtures';
import { ean13, mockProducts, seedUserProducts, watchOutsideRequests, YOGUR } from './products';

// «Mis productos»: un producto que no está en la base del móvil se le enseña a la app UNA vez, con lo que pone su etiqueta y su código de barras, y desde entonces se
// reconoce al escanearlo (también al contarlo con palabras). Lo que la persona enseña manda sobre la base, así que también sirve para corregir una cifra mal subida.
// Todo se guarda en el móvil (en `kv`, una clave por producto) y no se envía a ningún sitio.

const sheet = (page: Page): Locator => page.locator('dialog.sheet[open]');
const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });

/** Un código válido de producto español que no está en la base de prueba (que solo trae el yogur). */
const RARO = ean13('841000000003');
const OTRO = ean13('841000000004');
/** Un código de la balanza de la tienda (prefijo 20): lleva el peso o el precio y no identifica un producto. */
const BALANZA = ean13('200000000001');

/** Sin cámara: con la falsa de las pruebas el escáner leería solo el código y pasaría de pantalla, y aquí se teclean. */
async function withoutCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
  });
}

async function openMealSheet(page: Page): Promise<Locator> {
  await goTab(page, 'Resumen');
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  await expect(page.getByRole('dialog', { name: 'He comido algo', exact: true })).toBeVisible();
  return sheet(page);
}

/** Abre el escáner de la hoja y teclea un código. */
async function typeCode(dialog: Locator, code: string): Promise<void> {
  if (!(await dialog.getByLabel('O teclea el código').isVisible())) await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
  await dialog.getByLabel('O teclea el código').fill(code);
  await dialog.getByRole('button', { name: 'Buscar' }).click();
}

interface Label {
  name: string;
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber?: string;
  sugars?: string;
  salt?: string;
  serving?: string;
}

/** Rellena el formulario del producto (sin pulsar el botón de guardar). */
async function fillLabel(dialog: Locator, label: Label): Promise<void> {
  await dialog.getByLabel('Nombre del producto').fill(label.name);
  await dialog.getByLabel('Calorías por 100 g (kcal)').fill(label.kcal);
  await dialog.getByLabel('Proteínas (g)').fill(label.protein);
  await dialog.getByLabel('Hidratos (g)').fill(label.carbs);
  await dialog.getByLabel('Grasas (g)').fill(label.fat);
  await dialog.getByLabel('Fibra (g)').fill(label.fiber ?? '');
  await dialog.getByLabel('Azúcares (g)').fill(label.sugars ?? '');
  await dialog.getByLabel('Sal (g)', { exact: true }).fill(label.salt ?? '');
  await dialog.getByLabel('Ración (g), si la etiqueta la dice').fill(label.serving ?? '');
}

const GALLETAS: Label = { name: 'Galletas de la abuela', kcal: '480', protein: '6', carbs: '70', fat: '20', fiber: '3', sugars: '30', salt: '0,5', serving: '30' };

/** Los productos que la persona ha enseñado, leídos del almacén de la demostración (`kv`, claves `product:<código sin ceros delante>`). */
async function savedProducts(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<Array<Record<string, any>>>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound('product:', 'product;', false, true));
      request.onsuccess = () => resolve(request.result as Array<Record<string, any>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return values;
  });
}

async function savedMeals(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const days = await new Promise<Array<Array<Record<string, any>>>>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound('meals:', 'meals;', false, true));
      request.onsuccess = () => resolve(request.result as Array<Array<Record<string, any>>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return days.flat();
  });
}

test.describe('enseñarle un producto a la app', () => {
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('al no estar en la base, las salidas van en el orden de siempre (leer otro, enseñarle y, la última, a mano) y las formas de enseñarle también', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await expect(dialog).toContainText(`El producto ${RARO} no está en la base de la app`);
    const exits = await dialog.locator('button.btn').allTextContents();
    const names = exits.map((text) => text.trim()).filter((text) => /Escanear otro|Enseñarle este producto|Anotarlo a mano/.test(text));
    expect(names).toEqual(['Escanear otro', 'Enseñarle este producto', 'Anotarlo a mano']);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    const ways = await dialog.locator('.menu-row strong').allTextContents();
    expect(ways).toHaveLength(3);
    expect(ways[0]).toMatch(/foto/i);
    expect(ways[1]).toMatch(/palabras/);
    expect(ways[2]).toMatch(/a mano/);
  });

  test('un producto que no está se enseña una vez con su etiqueta, se anota y la próxima vez se reconoce solo', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    await mockProducts(page, [YOGUR]);
    let dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await expect(dialog).toContainText(`El producto ${RARO} no está en la base de la app`);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await expect(dialog).toContainText(`Código ${RARO}`);

    // Vacío no se puede guardar: pide el nombre y las calorías.
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Ponle un nombre al producto.');
    await expect(dialog.getByRole('alert')).toContainText('Faltan las calorías por 100 g');

    // Cifras que no pueden ser ciertas (10 kcal con 50 g de hidratos), un campo que no es un número y unos azúcares que pasan de los hidratos.
    await fillLabel(dialog, { name: 'Galletas', kcal: '10', protein: 'dos', carbs: '50', fat: '' });
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Las proteínas deben ser un número.');
    await expect(dialog.getByRole('alert')).toContainText('Esas cifras no cuadran');
    await fillLabel(dialog, { ...GALLETAS, sugars: '90' });
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Los azúcares son una parte de los hidratos');
    expect(await savedProducts(page), 'con errores no se guarda nada').toHaveLength(0);

    // Con la etiqueta bien copiada se guarda y pasa a anotar la cantidad, con la ración de la etiqueta puesta.
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Producto guardado' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    await expect(dialog).toContainText('Es un producto que le enseñaste tú');
    await expect(dialog).toContainText('Por 100 g: 480 kcal');
    await expect(dialog.getByLabel('Cantidad que has comido (g o ml)')).toHaveValue('30');
    await expect(dialog.getByRole('status').filter({ hasText: 'kcal' })).toContainText('144'); // 30 g × 480 kcal / 100 g
    await dialog.getByRole('button', { name: 'Anotar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Comida anotada: 144 kcal' })).toBeVisible();

    const meal = (await savedMeals(page)).find((m) => m.barcode === RARO);
    expect(meal).toMatchObject({ source: 'barcode', name: 'Galletas de la abuela', kcal: 144, grams: 30, fiberG: 0.9, saltG: 0.15 });
    const [product] = await savedProducts(page);
    expect(product).toMatchObject({ barcode: RARO, name: 'Galletas de la abuela', servingG: 30, per100g: { kcal: 480, proteinG: 6, carbsG: 70, fatG: 20, fiberG: 3, sugarsG: 30, saltG: 0.5 } });

    // La próxima vez no hay que enseñarlo: al teclear (o escanear) el código sale directamente.
    dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    await expect(dialog).not.toContainText('no está en la base de la app');
    expect(outside).toEqual([]);
  });

  test('se puede corregir lo enseñado y olvidarlo (con una confirmación)', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();

    // Corregir: el formulario viene con lo que se enseñó y guarda los cambios.
    await dialog.getByRole('button', { name: 'Corregir los datos' }).click();
    await expect(dialog.getByLabel('Nombre del producto')).toHaveValue('Galletas de la abuela');
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('480');
    await expect(dialog.getByLabel('Sal (g)', { exact: true })).toHaveValue('0,5');
    await dialog.getByLabel('Calorías por 100 g (kcal)').fill('500');
    await dialog.getByRole('button', { name: 'Guardar los cambios' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Producto corregido' })).toBeVisible();
    await expect(dialog).toContainText('Por 100 g: 500 kcal');
    const [corrected] = await savedProducts(page);
    expect(corrected?.per100g.kcal).toBe(500);
    expect(await savedProducts(page)).toHaveLength(1);

    // Olvidar pide confirmar (un segundo toque, y no instantáneo: no se confirma sin querer con un doble toque).
    await dialog.getByRole('button', { name: 'Olvidar este producto' }).click();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Olvidar este producto' })).toBeVisible();
    expect(await savedProducts(page)).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Olvidar este producto' }).click();
    const sure = dialog.getByRole('button', { name: 'Sí, olvidarlo' });
    await expect(sure).toBeEnabled();
    await sure.click();
    await expect(page.getByRole('status').filter({ hasText: 'Producto olvidado' })).toBeVisible();
    expect(await savedProducts(page)).toHaveLength(0);
    await typeCode(dialog, RARO);
    await expect(dialog).toContainText(`El producto ${RARO} no está en la base de la app`);
  });

  test('cancelar el formulario no guarda nada, y corregir un producto de la base lo sustituye por lo corregido', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Atrás' }).click(); // vuelve a elegir la forma, sin guardar nada
    await dialog.getByRole('button', { name: 'Cancelar' }).click(); // y de ahí, al escáner
    expect(await savedProducts(page)).toHaveLength(0);

    // El yogur de la base: el producto no es «de la persona» hasta que lo corrige.
    await typeCode(dialog, YOGUR.code);
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await expect(dialog).not.toContainText('Es un producto que le enseñaste tú');
    await expect(dialog.getByRole('button', { name: 'Olvidar este producto' })).toHaveCount(0);
    // «Cancelar» al corregir vuelve al producto (no al escáner) y no guarda nada.
    await dialog.getByRole('button', { name: 'Corregir los datos' }).click();
    await dialog.getByLabel('Calorías por 100 g (kcal)').fill('999');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();
    await expect(dialog).toContainText('Por 100 g: 61 kcal');
    expect(await savedProducts(page)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Corregir los datos' }).click();
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('61');
    await dialog.getByLabel('Calorías por 100 g (kcal)').fill('70');
    await dialog.getByRole('button', { name: 'Guardar los cambios' }).click();
    await expect(dialog).toContainText('Por 100 g: 70 kcal');
    await expect(dialog).toContainText('Es un producto que le enseñaste tú');
    expect(await savedProducts(page)).toHaveLength(1);
  });

  test('el código de la balanza de la tienda no ofrece enseñarlo: explica por qué', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, BALANZA);
    await expect(dialog).toContainText('Es un código de la propia tienda');
    await expect(dialog.getByRole('button', { name: 'Enseñarle este producto' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Anotarlo a mano' })).toBeVisible();
  });

  test('un código con una cifra mal tecleada propone el producto conocido que se parece (de la base o de los suyos)', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, '8410000000019'); // la cifra de control mal: el yogur es 8410000000016
    await expect(dialog.getByRole('alert')).toContainText('Ese código no es válido');
    const suggestion = dialog.getByRole('button', { name: /¿Era 8410000000016, «Yogur natural · Marca»\?/ });
    await expect(suggestion).toBeVisible();
    // Si se sigue escribiendo, lo propuesto era para el código de antes y desaparece.
    await dialog.getByLabel('O teclea el código').fill('84100000000');
    await expect(suggestion).toHaveCount(0);
    await dialog.getByLabel('O teclea el código').fill('8410000000019');
    await dialog.getByRole('button', { name: 'Buscar' }).click();
    await dialog.getByRole('button', { name: /¿Era 8410000000016, «Yogur natural · Marca»\?/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Yogur natural · Marca' })).toBeVisible();

    // Y con uno que ha enseñado la persona.
    await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
    await typeCode(dialog, OTRO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
    const wrong = `${OTRO.slice(0, 12)}${(Number(OTRO[12]) + 1) % 10}`;
    await typeCode(dialog, wrong);
    await dialog.getByRole('button', { name: new RegExp(`¿Era ${OTRO}, «Galletas de la abuela»\\?`) }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
  });

  test('lo que enseñó la persona también se reconoce al contar la comida con palabras', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    let dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, { name: 'Frumbulón Zarandín', kcal: '400', protein: '8', carbs: '75', fat: '6', serving: '40' });
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Frumbulón Zarandín' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    dialog = await openMealSheet(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('¿Qué has comido?').fill('200 g de frumbulón zarandín');
    await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
    await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toContainText('Frumbulón Zarandín');
    await expect(dialog.getByLabel('Calorías (kcal)')).toHaveValue('800'); // 200 g × 400 kcal / 100 g
    await expect(dialog).not.toContainText('No he reconocido');
  });
});

// ───────────────────────────── la pantalla «Mis productos» (menú de perfil) ─────────────────────────────

const SIETE = [
  { barcode: ean13('841000000010'), name: 'Galletas de la abuela', kcal: 480, servingG: 30 },
  { barcode: ean13('841000000011'), name: 'Crema de cacahuete', kcal: 600 },
  { barcode: ean13('841000000012'), name: 'Barrita de avena', kcal: 400, servingG: 40 },
  { barcode: ean13('841000000013'), name: 'Yogur de coco', kcal: 90 },
  { barcode: ean13('841000000014'), name: 'Pan de centeno', kcal: 250 },
  { barcode: ean13('841000000015'), name: 'Hummus casero', kcal: 230 },
  { barcode: ean13('841000000016'), name: 'Turrón blando', kcal: 510 },
];

test.describe('la pantalla «Mis productos»', () => {
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('sin productos lo dice en una línea y no ofrece añadir: el alta solo existe al escanear un código que no está', async ({ page }) => {
    const outside = watchOutsideRequests(page);
    // El menú dice cuántos hay sin abrir el apartado.
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
    await expect(menu.getByRole('button', { name: /^Mis productos/ })).toContainText('Ninguno todavía');
    await page.keyboard.press('Escape');

    const section = await openUserSection(page, 'Mis productos');
    await expect(section).toContainText('Todavía no tienes ninguno');
    await expect(section.getByLabel('Buscar en mis productos')).toHaveCount(0);
    await expect(section.getByRole('button', { name: /Añadir/ })).toHaveCount(0);
    await expect(section.getByLabel('Código de barras')).toHaveCount(0);

    // Lo enseñado al escanear sí llega aquí, y el menú lo cuenta.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    await expect(menu.getByRole('button', { name: /^Mis productos/ })).toContainText('1 producto');
    expect(outside).toEqual([]);
  });

  test('con seis o más sale el buscador, que filtra por nombre y por código', async ({ page }) => {
    await seedUserProducts(page, SIETE.slice(0, 5));
    let section = await openUserSection(page, 'Mis productos');
    await expect(section.getByRole('list', { name: 'Mis productos' }).getByRole('listitem')).toHaveCount(5);
    await expect(section.getByLabel('Buscar en mis productos')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await seedUserProducts(page, SIETE);
    section = await openUserSection(page, 'Mis productos');
    const list = section.getByRole('list', { name: 'Mis productos' });
    await expect(list.getByRole('listitem')).toHaveCount(7);
    const search = section.getByLabel('Buscar en mis productos');
    await search.fill('ABUELA');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Galletas de la abuela');
    await search.fill('turron');
    await expect(list).toContainText('Turrón blando');
    await search.fill(SIETE[3]!.barcode.slice(-4));
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Yogur de coco');
    await search.fill('zzz');
    await expect(list.getByRole('listitem')).toHaveCount(0);
    await expect(section.getByText('Ningún producto coincide con «zzz»')).toBeVisible();
    await search.fill('');
    await expect(list.getByRole('listitem')).toHaveCount(7);
  });

  test('abrir uno lo corrige y se puede olvidar (con confirmación); el cambio vale al escanear', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    await seedUserProducts(page, SIETE.slice(0, 2));
    const [first, second] = SIETE;
    const section = await openUserSection(page, 'Mis productos');
    const list = section.getByRole('list', { name: 'Mis productos' });
    // El último que se enseñó va primero.
    await expect(list.getByRole('listitem').first()).toContainText(second!.name);

    await list.getByRole('button', { name: new RegExp(`^${first!.name}`) }).click();
    await expect(section.getByLabel('Nombre del producto')).toHaveValue(first!.name);
    await expect(section.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('480');
    await expect(section.getByLabel('Código de barras')).toHaveCount(0); // el código de uno que ya existe no se toca
    await section.getByLabel('Calorías por 100 g (kcal)').fill('500');
    await section.getByLabel('Nombre del producto').fill('Galletas de la abuela (bis)');
    await section.getByRole('button', { name: 'Guardar los cambios' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Producto corregido' })).toBeVisible();
    // Vuelve a la lista, con el corregido el primero y sus cifras nuevas.
    await expect(list.getByRole('listitem').first()).toContainText('Galletas de la abuela (bis)');
    await expect(list.getByRole('listitem').first()).toContainText('500 kcal por 100 g');
    expect(await savedProducts(page)).toHaveLength(2);

    // Al escanearlo (tecleado) sale con las cifras corregidas.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const dialog = await openMealSheet(page);
    await typeCode(dialog, first!.barcode);
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela (bis)' })).toBeVisible();
    await expect(dialog).toContainText('Por 100 g: 500 kcal');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Olvidarlo: pide confirmar, y la confirmación no vale al instante.
    const again = await openUserSection(page, 'Mis productos');
    await again.getByRole('list', { name: 'Mis productos' }).getByRole('button', { name: /^Galletas de la abuela \(bis\)/ }).click();
    await again.getByRole('button', { name: 'Olvidar este producto' }).click();
    await again.getByRole('button', { name: 'No', exact: true }).click();
    expect(await savedProducts(page)).toHaveLength(2);
    await again.getByRole('button', { name: 'Olvidar este producto' }).click();
    const sure = again.getByRole('button', { name: 'Sí, olvidarlo' });
    await expect(sure).toBeEnabled();
    await sure.click();
    await expect(page.getByRole('status').filter({ hasText: 'Producto olvidado' })).toBeVisible();
    const left = again.getByRole('list', { name: 'Mis productos' });
    await expect(left.getByRole('listitem')).toHaveCount(1);
    await expect(left).not.toContainText('Galletas');
    expect((await savedProducts(page)).map((p) => p.barcode)).toEqual([second!.barcode]);
  });

  test('lo enseñado desde el escáner aparece en la lista', async ({ page }) => {
    await mockProducts(page, [YOGUR]);
    const dialog = await openMealSheet(page);
    await typeCode(dialog, RARO);
    await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
    await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
    await fillLabel(dialog, GALLETAS);
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const section = await openUserSection(page, 'Mis productos');
    await expect(section.getByRole('list', { name: 'Mis productos' })).toContainText('Galletas de la abuela');
  });
});

// ───────────────────────────── las tres formas de darle los valores ─────────────────────────────

/** Una foto de la tabla nutricional de un envase (por 100 g), dibujada: el texto es el de una etiqueta española típica. */
async function labelPhoto(page: Page, lines: readonly string[]): Promise<Buffer> {
  const base64 = await page.evaluate(async (rows) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 120 + rows.length * 62;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    context.font = '40px sans-serif';
    rows.forEach((row, index) => context.fillText(row, 40, 80 + index * 62));
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, lines);
  return Buffer.from(base64, 'base64');
}

/**
 * Una tabla nutricional de verdad, dibujada: dos columnas («por 100 g» y «por ración»), una fila por nutriente, con sus filetes entre filas y su borde (las rayas son lo que
 * hacía que el OCR se saltara filas) y, si se pide, letras claras sobre fondo oscuro.
 */
async function ruledTablePhoto(page: Page, options: { inverted?: boolean } = {}): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ inverted }) => {
    const rows: Array<[string, string, string]> = [
      ['Valor energético', '1850 kJ / 440 kcal', '555 kJ / 132 kcal'],
      ['Grasas', '18 g', '5,4 g'],
      ['de las cuales saturadas', '3,2 g', '1 g'],
      ['Hidratos de carbono', '52 g', '15,6 g'],
      ['de los cuales azúcares', '12 g', '3,6 g'],
      ['Fibra alimentaria', '4,5 g', '1,4 g'],
      ['Proteínas', '9,0 g', '2,7 g'],
      ['Sal', '1,2 g', '0,36 g'],
    ];
    const rowHeight = 62;
    const top = 150;
    const canvas = document.createElement('canvas');
    canvas.width = 1300;
    canvas.height = top + rows.length * rowHeight + 60;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const paper = inverted === true ? '#1d4d3a' : '#fbf7ea';
    const ink = inverted === true ? '#fff' : '#111';
    context.fillStyle = paper;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = ink;
    context.fillStyle = ink;
    context.lineWidth = 3;
    context.strokeRect(30, 30, canvas.width - 60, canvas.height - 60);
    context.font = 'bold 38px Arial, sans-serif';
    context.fillText('INFORMACIÓN NUTRICIONAL', 50, 90);
    context.textAlign = 'right';
    context.fillText('por 100 g', 940, 90);
    context.fillText('por ración (30 g)', 1260, 90);
    context.textAlign = 'left';
    context.font = '36px Arial, sans-serif';
    rows.forEach(([name, per100, perServing], index) => {
      const y = top + index * rowHeight;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(30, y - 44);
      context.lineTo(canvas.width - 30, y - 44);
      context.stroke();
      context.fillText(name, name.startsWith('de ') ? 80 : 50, y);
      context.textAlign = 'right';
      context.fillText(per100, 940, y);
      context.fillText(perServing, 1260, y);
      context.textAlign = 'left';
    });
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, options);
  return Buffer.from(base64, 'base64');
}

const TABLA = [
  'INFORMACIÓN NUTRICIONAL',
  'Valores medios por 100 g',
  'Valor energético 1046 kJ / 250 kcal',
  'Grasas 12 g',
  'de las cuales saturadas 3,1 g',
  'Hidratos de carbono 28 g',
  'de los cuales azúcares 9,5 g',
  'Fibra alimentaria 2,1 g',
  'Proteínas 6,0 g',
  'Sal 0,52 g',
];

/** Escanea un código que no está y pulsa «Enseñarle este producto»: queda la pantalla de las tres formas. */
async function toTeach(page: Page): Promise<Locator> {
  await mockProducts(page, [YOGUR]);
  const dialog = await openMealSheet(page);
  await typeCode(dialog, RARO);
  await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
  return dialog;
}

test.describe('darle los valores de un producto: foto, palabras o a mano', () => {
  // El motor de lectura escribe en la consola «Estimating resolution as N» cuando una foto no trae resolución y casi no tiene letras: es su registro, no un fallo de la app.
  // Tesseract cuenta por la consola lo que va haciendo («Estimating resolution», «Detected 12 diacritics»…): no son errores de la app.
  // Una sola expresión: Playwright toma `[regex, regex, …]` en `test.use` por una tupla `[valor, opciones]` y se queda con la primera.
  test.use({ allowedConsoleErrors: [/Estimating resolution as \d+|Detected \d+ diacritics|Image too small to scale|Line cannot be recognized/] });
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('hay tres formas y escribirlo a mano es la última', async ({ page }) => {
    const dialog = await toTeach(page);
    const options = dialog.getByRole('list', { name: 'Cómo darle los valores' }).getByRole('button');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText('foto');
    await expect(options.nth(1)).toContainText('palabras');
    await expect(options.nth(2)).toContainText('a mano');
  });

  test('contándolo con palabras (o dictado) se rellena el formulario para revisarlo y guardarlo', async ({ page }) => {
    const dialog = await toTeach(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await expect(dialog.getByRole('button', { name: 'Leer las cifras' })).toBeDisabled();

    // Sin ninguna cifra, no se inventa nada.
    await dialog.getByLabel('Cuéntalo con tus palabras').fill('unas galletas muy ricas');
    await dialog.getByRole('button', { name: 'Leer las cifras' }).click();
    await expect(dialog.getByRole('alert')).toContainText('No he entendido ninguna cifra');

    await dialog.getByLabel('Cuéntalo con tus palabras').fill('Galletas de la abuela, 480 calorías, 6 de proteínas, 70 de hidratos, 20 de grasas, 3 de fibra, 30 de azúcares y cero coma cinco de sal');
    await dialog.getByRole('button', { name: 'Leer las cifras' }).click();
    await expect(dialog.getByLabel('Nombre del producto')).toHaveValue('Galletas de la abuela');
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('480');
    await expect(dialog.getByLabel('Proteínas (g)')).toHaveValue('6');
    await expect(dialog.getByLabel('Hidratos (g)')).toHaveValue('70');
    await expect(dialog.getByLabel('Grasas (g)')).toHaveValue('20');
    await expect(dialog.getByLabel('Sal (g)', { exact: true })).toHaveValue('0,5');
    expect(await savedProducts(page), 'leer no guarda: la persona primero revisa').toHaveLength(0);

    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
    expect(await savedProducts(page)).toHaveLength(1);
  });

  test('de «Atrás» en la revisión se vuelve a elegir la forma', async ({ page }) => {
    const dialog = await toTeach(page);
    await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
    await dialog.getByLabel('Cuéntalo con tus palabras').fill('480 calorías');
    await dialog.getByRole('button', { name: 'Leer las cifras' }).click();
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('480');
    await dialog.getByRole('button', { name: 'Atrás' }).click();
    await expect(dialog.getByRole('list', { name: 'Cómo darle los valores' })).toBeVisible();
  });

  test('con la foto de la tabla nutricional se leen las cifras en el móvil, sin internet', async ({ page }) => {
    test.setTimeout(120_000);
    const outside = watchOutsideRequests(page);
    const dialog = await toTeach(page);
    await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
    // Sin cámara se avisa y sigue sirviendo una foto de la galería.
    await expect(dialog.getByRole('button', { name: 'Sacar foto' })).toHaveCount(0);
    await expect(dialog).toContainText('Elige una foto de la galería');
    await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'etiqueta.png', mimeType: 'image/png', buffer: await labelPhoto(page, TABLA) });

    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('250', { timeout: 90_000 });
    await expect(dialog.getByLabel('Grasas (g)')).toHaveValue('12');
    await expect(dialog.getByLabel('Hidratos (g)')).toHaveValue('28');
    await expect(dialog.getByLabel('Proteínas (g)')).toHaveValue('6');
    await expect(dialog.getByLabel('Sal (g)', { exact: true })).toHaveValue('0,52');
    await expect(dialog).toContainText('Revisa lo que ha leído la foto');
    expect(await savedProducts(page), 'leer no guarda: la persona primero revisa').toHaveLength(0);

    await dialog.getByLabel('Nombre del producto').fill('Galletas de la tienda');
    await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
    await expect(dialog.getByRole('heading', { name: 'Galletas de la tienda' })).toBeVisible();
    expect(outside, "la foto se lee en el móvil, sin salir a ningún sitio").toEqual([]);
  });

  for (const inverted of [false, true]) {
    test(`una tabla de dos columnas con sus rayas${inverted ? ' y letras claras sobre fondo oscuro' : ''}: se leen todas las cifras de la columna de 100 g`, async ({ page }) => {
      test.setTimeout(150_000);
      const dialog = await toTeach(page);
      await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
      await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'tabla.png', mimeType: 'image/png', buffer: await ruledTablePhoto(page, { inverted }) });
      await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('440', { timeout: 120_000 });
      await expect(dialog.getByLabel('Grasas (g)')).toHaveValue('18');
      await expect(dialog.getByLabel('Hidratos (g)')).toHaveValue('52');
      await expect(dialog.getByLabel('Azúcares (g)')).toHaveValue('12');
      await expect(dialog.getByLabel('Fibra (g)')).toHaveValue('4,5');
      await expect(dialog.getByLabel('Proteínas (g)')).toHaveValue('9');
      await expect(dialog.getByLabel('Sal (g)', { exact: true })).toHaveValue('1,2');
    });
  }

  test('el lector de fotos se arranca al abrir la cámara de la tabla, antes de que haya foto', async ({ page }) => {
    const languageRequests: string[] = [];
    page.on('request', (request) => request.url().endsWith('/ocr/spa-data.js') && languageRequests.push(request.url()));
    const dialog = await toTeach(page);
    expect(languageRequests, 'antes de elegir esa opción no se carga nada del lector').toHaveLength(0);
    const gzipRequests: string[] = [];
    page.on('request', (request) => request.url().endsWith('.gz') && gzipRequests.push(request.url()));
    await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
    await expect.poll(() => languageRequests.length, { message: 'al abrir la cámara de la tabla, el motor ya empieza a cargarse' }).toBe(1);
    // Leer la foto después no lo carga otra vez.
    await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'etiqueta.png', mimeType: 'image/png', buffer: await labelPhoto(page, TABLA) });
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveValue('250', { timeout: 90_000 });
    expect(languageRequests).toHaveLength(1);
    expect(gzipRequests, 'el idioma no se pide como .gz (en el APK ese archivo daba 404 y la lectura no acababa nunca)').toEqual([]);
  });

  test('una foto sin ninguna tabla no inventa cifras', async ({ page }) => {
    test.setTimeout(120_000);
    const dialog = await toTeach(page);
    await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
    await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'nada.png', mimeType: 'image/png', buffer: await labelPhoto(page, ['Paseo por el campo']) });
    await expect(dialog).toContainText('No se ha podido leer ninguna cifra', { timeout: 90_000 });
    await expect(dialog.getByLabel('Calorías por 100 g (kcal)')).toHaveCount(0);
  });
});

// Con el service worker de la app bloqueado: es el que sirve los archivos del lector desde su caché y no deja a la prueba retrasar la llegada de uno de ellos (un móvil lento).
test.describe('la espera de la lectura de una foto', () => {
  test.use({ serviceWorkers: 'block' });
  test.beforeEach(async ({ page }) => {
    await withoutCamera(page);
    await openDemo(page);
  });

  test('mientras lee enseña en qué paso va y los segundos, y si tarda deja contarlo con palabras', async ({ page }) => {
    test.setTimeout(150_000);
    // El idioma del lector no llega hasta que la prueba lo suelta (un móvil lento): la pantalla de espera tiene que decirlo, no quedarse muda.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/ocr/spa-data.js', async (route) => {
      await gate;
      await route.continue().catch(() => undefined);
    });
    const dialog = await toTeach(page);
    await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
    await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'etiqueta.png', mimeType: 'image/png', buffer: await labelPhoto(page, TABLA) });
    const bar = dialog.getByRole('progressbar', { name: 'Lectura de la foto' });
    await expect(bar).toBeVisible();
    await expect(dialog).toContainText('Despertando el lector de fotos…');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Contarlo con tus palabras' }), 'al principio no se ofrece: aún no es lento').toHaveCount(0);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const violations = (await new AxeBuilder({ page }).include('dialog.sheet[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze()).violations;
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`), `accesibilidad (${scheme})`).toEqual([]);
    }

    // Pasados 20 s sin terminar se ofrece la salida.
    await expect(dialog).toContainText('Está tardando más de lo normal', { timeout: 40_000 });
    await expect(dialog.getByText(/\d+ % · \d+ s/)).toBeAttached();
    await dialog.getByRole('button', { name: 'Contarlo con tus palabras' }).click();
    await expect(dialog.getByLabel('Cuéntalo con tus palabras')).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    release();
  });

});
