import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { ageDemoSync, expect, goTab, goToDayWithWorkouts, openDemo, openPanel, openUserSection, test, type TabName } from './fixtures';
import { ean13, mockProducts, seedUserProducts, YOGUR } from './products';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Ejecuta axe sobre las zonas indicadas y devuelve un resumen legible de las violaciones (vacío = todo bien). */
async function violations(page: Page, include: string[]): Promise<string[]> {
  // Con la hoja entrando a medias (aparece deslizándose y con la opacidad subiendo) sus colores se mezclan con los de detrás y
  // axe mide contrastes que nadie verá: se espera a que terminen las animaciones (las infinitas, como un latido, no terminan).
  // Dos fotogramas antes de mirar: algo que acaba de aparecer (un aviso, una hoja) empieza su animación en el siguiente, y sin esta espera no se contaba y axe medía el contraste a medio entrar.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? 0))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  for (const selector of include) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations.map((v) => {
    const nodes = v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} → ${(n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? n.failureSummary ?? ''}`.replace(/\s+/g, ' '));
    return `[${v.impact}] ${v.id}: ${v.help}\n    ${nodes.join('\n    ')}`;
  });
}

const SHELL = ['header.topbar', 'nav.nav'];
const ACTIVE_PAGE = 'main.pager > section.page:not([inert])';
const TABS: TabName[] = ['Resumen', 'Deportes', 'Salud'];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accesibilidad (${scheme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    for (const tab of TABS) {
      test(`pestaña ${tab}`, async ({ page }) => {
        await openDemo(page);
        await goTab(page, tab);
        // Deja que terminen de cargar los gráficos de la pestaña.
        await page.waitForLoadState('networkidle');
        expect(await violations(page, [...SHELL, ACTIVE_PAGE])).toEqual([]);
      });
    }

    test('báscula de cocina: el asistente paso a paso, pesar con vista previa y plato, y su apartado del perfil', async ({ page }) => {
      await openDemo(page);
      const weigh = (grams: number): Promise<void> => page.evaluate((g) => (window as unknown as { __smartringScale: { setWeight(g: number): void } }).__smartringScale.setWeight(g), grams);
      await page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
      const dialog = page.locator('dialog.sheet[open]');
      await expect(dialog).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'menú con «Pesar con la báscula»').toEqual([]);
      await dialog.getByRole('button', { name: /Pesar con la báscula/ }).click();
      expect(await violations(page, ['dialog[open]']), 'asistente: inicio').toEqual([]);
      await dialog.getByRole('button', { name: 'Buscar la báscula' }).click();
      await expect(dialog.getByRole('heading', { name: 'Elige tu báscula' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'asistente: dispositivos').toEqual([]);
      await dialog.getByRole('button', { name: /RENPHO-SCALE/ }).click();
      await expect(dialog.getByRole('heading', { name: 'Quita todo de la báscula' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'asistente: báscula vacía').toEqual([]);
      await dialog.getByRole('button', { name: 'Ya marca 0' }).click();
      await page.waitForTimeout(300);
      await weigh(355);
      await page.waitForTimeout(1_300);
      expect(await violations(page, ['dialog[open]']), 'asistente: escribir lo que marca').toEqual([]);
      await dialog.getByLabel('Lo que marca (g)').fill('355');
      await dialog.getByRole('button', { name: 'Aprender' }).click();
      await expect(dialog.getByRole('heading', { name: 'Comprueba que se lee bien' })).toBeVisible();
      await weigh(480);
      await expect(dialog.getByRole('group', { name: 'Peso de la báscula' })).toContainText('Quieta');
      expect(await violations(page, ['dialog[open]']), 'asistente: comprobar en vivo').toEqual([]);
      await dialog.getByRole('button', { name: 'Sí, coincide' }).click();
      await expect(dialog.getByRole('heading', { name: /Báscula lista/ })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'asistente: lista').toEqual([]);
      await dialog.getByRole('button', { name: 'Listo' }).click();

      // Pesar: con lo que se escribe, la vista previa y un plato a medias con el formulario.
      await weigh(0);
      await dialog.getByLabel('¿Qué es?').fill('pech');
      await expect(dialog.getByRole('list', { name: 'Sugerencias' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'pesar: sugerencias').toEqual([]);
      await dialog.getByLabel('¿Qué es?').fill('pechuga de pollo');
      await weigh(250);
      await expect(dialog.getByRole('group', { name: 'Lo que saldría' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'pesar: vista previa').toEqual([]);
      await dialog.getByRole('button', { name: 'Añadir', exact: true }).click();
      await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'pesar: plato en construcción').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // La báscula se gestiona en el menú de dispositivos (no en el de perfil), dentro de su tarjeta.
      await page.getByRole('button', { name: /^Dispositivos:/ }).click();
      const devices = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
      await expect(devices.getByRole('heading', { name: 'Báscula de cocina' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'Dispositivos con la báscula').toEqual([]);
    });

    test('el perfil social (menú, editar con foto) y los datos y copias de seguridad', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: 'Mi perfil' }).click();
      const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
      // Se espera a que la hoja esté pintada: si no, axe puede medir los contrastes con la hoja entrando a medias (su opacidad aún no es 1) y ver colores que nadie verá.
      await expect(menu).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'menú de perfil sin nombre de usuario').toEqual([]);
      await menu.getByRole('button', { name: /Elige tu nombre de usuario/ }).click();
      const editor = page.getByRole('dialog', { name: 'Perfil y datos', exact: true });
      await editor.getByLabel('Nombre de usuario').fill('ana');
      await editor.getByLabel('Estado').fill('de camino');
      await editor.getByLabel('Elegir una foto de la galería').setInputFiles('public/icons/icon-192.png');
      await expect(editor.locator('.avatar img')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'editar perfil con foto').toEqual([]);
      await editor.getByLabel('Nombre de usuario').fill('a');
      expect(await violations(page, ['dialog[open]']), 'editar perfil con un nombre que no vale').toEqual([]);
      await editor.getByLabel('Nombre de usuario').fill('ana');
      await editor.getByRole('button', { name: 'Guardar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Perfil guardado' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(editor).toBeHidden();
      expect(await violations(page, ['dialog[open]']), 'menú de perfil con foto y nombre').toEqual([]);
      await menu.getByRole('button', { name: /^Datos y copias de seguridad/ }).click();
      const backups = page.getByRole('dialog', { name: 'Datos y copias de seguridad', exact: true });
      await expect(backups.getByRole('button', { name: 'Exportar copia' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'datos y copias de seguridad').toEqual([]);
    });

    test('Salud con el gráfico en edición (bloques, cruz armada y «+») y su selector gráfico', async ({ page }) => {
      await openDemo(page);
      await goTab(page, 'Salud');
      await page.waitForLoadState('networkidle');
      const hero = page.locator(ACTIVE_PAGE).getByRole('region', { name: 'Evolución', exact: true });
      await hero.getByRole('button', { name: 'Elegir qué datos ver' }).click();
      const blocks = hero.getByRole('list', { name: 'Gráficos que se ven, en este orden' });
      await expect(blocks).toBeVisible();
      expect(await violations(page, [...SHELL, ACTIVE_PAGE]), 'en edición').toEqual([]);
      // El meneo continuo de los bloques impide pulsarlos con Playwright (no los ve estables): con «reducir movimiento» se están quietos.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      // Con la cruz de un bloque ya preparada para confirmar («Quitar»).
      await blocks.getByRole('button', { name: 'Quitar Agua al día', exact: true }).click();
      await expect(blocks.getByRole('button', { name: 'Confirmar: quitar Agua al día' })).toBeVisible();
      expect(await violations(page, [...SHELL, ACTIVE_PAGE]), 'con una cruz preparada').toEqual([]);
      // El selector gráfico.
      await hero.getByRole('button', { name: 'Añadir un gráfico' }).click();
      await expect(page.getByRole('dialog', { name: 'Añadir un gráfico', exact: true })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'selector').toEqual([]);
    });

    test('pestaña Resumen en un día con entrenos', async ({ page }) => {
      await openDemo(page);
      await goToDayWithWorkouts(page);
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [...SHELL, ACTIVE_PAGE])).toEqual([]);
    });

    test('hoja del anillo', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: /^Dispositivos:/ }).click();
      await expect(page.getByRole('dialog', { name: 'Dispositivos' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('menú de perfil y sus apartados: datos, objetivos, copias y borrado', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: 'Mi perfil' }).click();
      await expect(page.getByRole('dialog', { name: 'Mi perfil', exact: true })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');

      const goals = await openUserSection(page, 'Objetivos y medición');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(goals).toBeHidden();
      await page.keyboard.press('Escape');

      const data = await openUserSection(page, 'Mis datos');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await data.getByRole('button', { name: 'Actualizar' }).click();
      await expect(page.getByRole('dialog', { name: 'Actualizar mis datos' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');

      await data.getByRole('button', { name: 'Calibrar zancada' }).click();
      await expect(page.getByRole('dialog', { name: /zancada/i })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      const backup = await openUserSection(page, 'Datos y copias de seguridad');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await backup.getByRole('button', { name: 'Borrar todo' }).click();
      await expect(page.getByRole('dialog', { name: '¿Borrar todos los datos?' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('diagnóstico del anillo: con todo en orden y con avisos graves', async ({ page }) => {
      await openDemo(page);
      const open = async (): Promise<void> => {
        const backup = await openUserSection(page, 'Datos y copias de seguridad');
        await backup.getByRole('button', { name: 'Diagnóstico del anillo' }).click();
        await expect(page.getByRole('dialog', { name: 'Diagnóstico del anillo' })).toBeVisible();
        await page.waitForLoadState('networkidle');
      };
      await open();
      await expect(page.getByRole('region', { name: 'Estado del anillo' })).toContainText('Todo en orden');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);

      await ageDemoSync(page, { hoursAgo: 4 * 24 + 3, batteryPercent: 8 });
      await open();
      await expect(page.getByRole('region', { name: 'Estado del anillo' })).toContainText('Necesita atención');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);

      await ageDemoSync(page, { hoursAgo: 30, batteryPercent: 15 });
      await open();
      await expect(page.getByRole('region', { name: 'Estado del anillo' })).toContainText('Hay algo que revisar');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('alimentación: la hoja de «He comido algo» en cada paso, el objetivo de salud y la barra de comida de un día con datos', async ({ page }) => {
      // Sin cámara: el escáner se ve en su aviso (con la falsa leería solo el código y pasaría de pantalla).
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
      });
      await openDemo(page);
      await page.getByRole('button', { name: 'Día anterior' }).click();
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [ACTIVE_PAGE]), 'resumen con la barra de comida').toEqual([]);
      // La otra cara de la tarjeta (la hidratación) también cumple.
      await page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: /^Estás viendo la comida/ }).click();
      await expect(page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: /^Estás viendo la hidratación/ })).toBeVisible();
      await page.waitForTimeout(400); // el giro dura 0,3 s: axe mira los colores ya sin girar
      expect(await violations(page, [ACTIVE_PAGE]), 'resumen con la cara de hidratación de un día pasado').toEqual([]);
      await page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: /^Estás viendo la hidratación/ }).click();

      // Hoy, con la tarjeta de nutrición vacía y su botón (en un día pasado no lo lleva).
      await page.getByRole('button', { name: 'Día siguiente' }).click();
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [ACTIVE_PAGE]), 'resumen de hoy, sin nada anotado').toEqual([]);
      await page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
      const dialog = page.locator('dialog.sheet[open]');
      await expect(dialog.getByRole('button', { name: /Escanear un código de barras/ })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'menú').toEqual([]);

      await dialog.getByRole('button', { name: /Añadir las calorías a mano/ }).click();
      await dialog.getByRole('button', { name: 'Anotar' }).click(); // con el aviso de error a la vista
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'a mano, con error').toEqual([]);

      await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
      await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
      await expect(dialog.getByLabel('O teclea el código')).toBeVisible();
      await dialog.getByLabel('O teclea el código').fill('123');
      await dialog.getByRole('button', { name: 'Buscar' }).click();
      await expect(dialog.getByRole('alert').first()).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'código de barras').toEqual([]);

      // Un producto encontrado (en una base de productos de prueba).
      await mockProducts(page, [YOGUR]);
      await dialog.getByLabel('O teclea el código').fill('8410000000016');
      await dialog.getByRole('button', { name: 'Buscar' }).click();
      await expect(dialog.getByRole('heading', { name: /Yogur natural/ })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'producto encontrado').toEqual([]);

      // Y uno que no está.
      await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
      await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
      await dialog.getByLabel('O teclea el código').fill(ean13('841000000002'));
      await dialog.getByRole('button', { name: 'Buscar' }).click();
      await expect(dialog).toContainText('no está en la base de la app');
      expect(await violations(page, ['dialog[open]']), 'producto que no está').toEqual([]);

      // Enseñarle ese producto (el formulario, vacío y con los avisos de error) y el producto ya enseñado, con sus botones de corregir y olvidar.
      await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
      // Las tres formas de darle los valores: la lista, el cuadro de palabras (con su aviso) y la foto de la tabla.
      await expect(dialog.getByRole('list', { name: 'Cómo darle los valores' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'elegir cómo darle los valores').toEqual([]);
      await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
      await dialog.getByLabel('Cuéntalo con tus palabras').fill('unas galletas');
      await dialog.getByRole('button', { name: 'Leer las cifras' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'contar los valores con palabras').toEqual([]);
      await dialog.getByRole('button', { name: 'Atrás' }).click();
      await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
      await expect(dialog.getByRole('button', { name: 'Elegir una foto de la galería' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'foto de la tabla nutricional').toEqual([]);
      await dialog.getByRole('button', { name: 'Atrás' }).click();
      await dialog.getByRole('button', { name: /Escribirlo a mano/ }).click();
      await expect(dialog.getByLabel('Nombre del producto')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'enseñar un producto').toEqual([]);
      await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'enseñar un producto, con errores').toEqual([]);
      await dialog.getByLabel('Nombre del producto').fill('Galletas de la abuela');
      await dialog.getByLabel('Calorías por 100 g (kcal)').fill('480');
      await dialog.getByLabel('Proteínas (g)').fill('6');
      await dialog.getByLabel('Hidratos (g)').fill('70');
      await dialog.getByLabel('Grasas (g)').fill('20');
      await dialog.getByRole('button', { name: 'Guardar y usar' }).click();
      await expect(dialog.getByRole('heading', { name: 'Galletas de la abuela' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Olvidar este producto' }).click(); // con la confirmación a la vista
      await expect(dialog.getByRole('button', { name: 'Sí, olvidarlo' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'producto enseñado').toEqual([]);

      await dialog.getByRole('button', { name: 'Elegir otra forma' }).click();
      await dialog.getByRole('button', { name: /Contarlo con tus palabras/ }).click();
      await expect(dialog.getByLabel('¿Qué has comido?')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'escribir con palabras').toEqual([]);

      // Lo calculado, para revisar (con un trozo que no entiende), y el aviso de que no hay comida en el texto.
      await dialog.getByLabel('¿Qué has comido?').fill('un kebab de ternera con cebolla y salsa blanca, dos huevos revueltos y zarandajo');
      await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
      await expect(dialog.getByRole('list', { name: 'Lo que se ha calculado' })).toBeVisible();
      await expect(dialog).toContainText('No he reconocido «zarandajo»');
      expect(await violations(page, ['dialog[open]']), 'revisar lo calculado (tarjetas con piezas)').toEqual([]);
      // Con una papelera ya preparada para confirmar («Quitar»).
      await dialog.getByRole('button', { name: 'Quitar Cebolla', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Confirmar: quitar Cebolla' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'papelera preparada').toEqual([]);
      await dialog.getByRole('button', { name: 'Volver a escribirlo' }).click();
      await dialog.getByLabel('¿Qué has comido?').fill('el cielo es azul');
      await dialog.getByRole('button', { name: 'Calcular calorías' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'sin comida en el texto').toEqual([]);
    });

    test('alimentación: el objetivo de salud en «Objetivos y medición»', async ({ page }) => {
      await openDemo(page);
      const goals = await openUserSection(page, 'Objetivos y medición');
      await expect(goals.getByRole('radiogroup', { name: 'Objetivo de salud' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('mis productos: la lista con buscador, el alta con errores, uno abierto con la confirmación de olvidarlo y la lista vacía', async ({ page }) => {
      await openDemo(page);
      // Vacía.
      let section = await openUserSection(page, 'Mis productos');
      await expect(section).toContainText('Todavía no tienes ninguno');
      expect(await violations(page, ['dialog[open]']), 'lista vacía').toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await seedUserProducts(
        page,
        ['Galletas de la abuela', 'Crema de cacahuete', 'Barrita de avena', 'Yogur de coco', 'Pan de centeno', 'Hummus casero', 'Turrón blando'].map((name, i) => ({ barcode: ean13(`84100000001${i}`), name, kcal: 100 + 60 * i })),
      );
      section = await openUserSection(page, 'Mis productos');
      await expect(section.getByLabel('Buscar en mis productos')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'lista con buscador').toEqual([]);
      await section.getByLabel('Buscar en mis productos').fill('zzz');
      await expect(section.getByText('Ningún producto coincide')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'sin coincidencias').toEqual([]);
      await section.getByLabel('Buscar en mis productos').fill('');

      await expect(section.getByRole('button', { name: 'Añadir un producto' })).toHaveCount(0); // el alta solo existe al escanear

      await section.getByRole('list', { name: 'Mis productos' }).getByRole('button', { name: /^Galletas de la abuela/ }).click();
      await section.getByRole('button', { name: 'Olvidar este producto' }).click(); // con la confirmación a la vista
      await expect(section.getByRole('button', { name: 'Sí, olvidarlo' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'producto abierto').toEqual([]);
    });

    test('peso objetivo: en «Objetivos y medición» (sin él, con él y con el aviso de que el objetivo de salud no cuadra) y en el gráfico de Salud', async ({ page }) => {
      await openDemo(page);
      const goals = await openUserSection(page, 'Objetivos y medición');
      expect(await violations(page, ['dialog[open]']), 'sin peso objetivo').toEqual([]);
      await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
      await expect(goals.getByRole('group', { name: 'Peso objetivo', exact: true })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'con peso objetivo').toEqual([]);
      await goals.getByRole('radio', { name: /Mantener peso/ }).click();
      await expect(goals.getByText(/no te lleva a bajar esos kilos/)).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'con el aviso de que no cuadra').toEqual([]);
      await page.keyboard.press('Escape'); // vuelve al menú
      await page.keyboard.press('Escape');
      await goTab(page, 'Salud');
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [...SHELL, ACTIVE_PAGE]), 'el gráfico de Salud con el peso objetivo').toEqual([]);
    });

    test('hojas de detalle del Resumen: sueño y pulso', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: 'Día anterior' }).click();
      for (const panel of ['Sueño', 'Ritmo cardiaco'] as const) {
        await openPanel(page, panel);
        await page.waitForLoadState('networkidle');
        expect(await violations(page, ['dialog[open]']), panel).toEqual([]);
        await page.keyboard.press('Escape');
      }
    });

    test('hidratación: la cara de hoy con tomas y la hoja de «Otra cantidad»', async ({ page }) => {
      await openDemo(page);
      const card = page.locator(ACTIVE_PAGE).getByRole('region', { name: 'Nutrición', exact: true });
      await card.getByRole('button', { name: /^Estás viendo la comida/ }).click();
      await card.getByRole('button', { name: 'Un vaso' }).click();
      await expect(card.getByRole('list', { name: 'Tomas de agua del día' })).toBeVisible();
      await page.waitForTimeout(400);
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [ACTIVE_PAGE]), 'cara de hidratación con una toma').toEqual([]);
      await card.getByRole('button', { name: 'Otra cantidad' }).click();
      await expect(page.getByRole('dialog', { name: 'Anotar agua' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'hoja de «Otra cantidad»').toEqual([]);
      await page.getByRole('dialog', { name: 'Anotar agua' }).getByLabel('Cantidad (ml)').fill('abc');
      await page.getByRole('dialog', { name: 'Anotar agua' }).getByRole('button', { name: 'Anotar' }).click();
      await expect(page.getByRole('dialog', { name: 'Anotar agua' }).getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'hoja de «Otra cantidad» con un aviso').toEqual([]);
    });

    test('lista de comidas de la tarjeta Nutrición y hoja de detalles de una comida', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: 'Día anterior' }).click();
      const card = page.locator(ACTIVE_PAGE).getByRole('region', { name: 'Nutrición', exact: true });
      await expect(card.getByRole('list', { name: 'Comidas del día' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [ACTIVE_PAGE])).toEqual([]);
      await card.getByRole('list', { name: 'Comidas del día' }).getByRole('listitem').first().locator('.food-meals__main').click();
      await expect(page.getByRole('dialog', { name: 'Comida', exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('hoja del sueño: con un tramo elegido en el gráfico (la lectura y la línea del cursor)', async ({ page }) => {
      await openDemo(page);
      await page.getByRole('button', { name: 'Día anterior' }).click();
      const sheet = await openPanel(page, 'Sueño');
      const chart = sheet.getByRole('img', { name: /^Fases del sueño/ });
      // Las fases van tras el análisis, más abajo en la hoja: se ponen a la vista antes de enfocarlas.
      await chart.scrollIntoViewIfNeeded();
      await expect(chart).toBeInViewport();
      await chart.focus();
      await page.keyboard.press('ArrowRight');
      await expect(sheet.locator('.tip')).toContainText(/\d\d:\d\d – \d\d:\d\d/);
      await page.waitForLoadState('networkidle');
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
    });

    test('Salud: el gráfico conjunto con el cursor leyendo un día, en cada periodo', async ({ page }) => {
      await openDemo(page);
      await goTab(page, 'Salud');
      const hero = page.locator(ACTIVE_PAGE).getByRole('region', { name: 'Evolución', exact: true });
      const bar = page.locator(ACTIVE_PAGE).getByRole('group', { name: 'Periodo de todos los gráficos' });
      for (const period of ['7 días', '30 días', '90 días', '1 año', 'Todo']) {
        await bar.getByRole('button', { name: period, exact: true }).click();
        await expect(bar.getByRole('button', { name: period, exact: true })).toHaveAttribute('aria-pressed', 'true');
        // Con los datos del periodo ya puestos y sin el velo de «recargando» (a medio opacar, los colores medirían otro contraste).
        await expect(hero.locator('figure.chart.is-stale')).toHaveCount(0);
        await expect(page.locator(ACTIVE_PAGE).locator('figure.chart.is-stale')).toHaveCount(0);
        const chart = hero.getByRole('img', { name: /^Evolución entre el/ });
        await chart.focus();
        await page.keyboard.press('ArrowLeft');
        await expect(hero.getByRole('status')).toBeVisible();
        expect(await violations(page, [ACTIVE_PAGE]), period).toEqual([]);
      }
    });

    test('Deportes: el historial filtrado (con datos y vacío) y su navegación de periodos', async ({ page }) => {
      await openDemo(page);
      await goTab(page, 'Deportes');
      const card = page.locator(`${ACTIVE_PAGE}`).getByRole('region', { name: 'Entrenamientos' });
      for (const period of ['Día', 'Semana', 'Mes']) {
        await card.getByRole('button', { name: period, exact: true }).click();
        await page.waitForLoadState('networkidle');
        expect(await violations(page, [ACTIVE_PAGE]), period).toEqual([]);
      }
      await card.getByRole('button', { name: 'Periodo anterior' }).click();
      await page.waitForLoadState('networkidle');
      expect(await violations(page, [ACTIVE_PAGE])).toEqual([]);
    });

    test('platos guardados: la barra con platos, el constructor con su foto y ingredientes, anotar con los gramos de cada ingrediente y los avisos', async ({ page }) => {
      await openDemo(page);
      // Platos ya guardados (uno con foto de verdad y uno sin ella) y la barra de «He comido algo» con ellos.
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 120;
        canvas.height = 90;
        const context = canvas.getContext('2d');
        if (context) {
          context.fillStyle = '#d98a3d';
          context.fillRect(0, 0, 120, 90);
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
          const ingredients = [{ name: 'Lentejas', kcal: 600, proteinG: 40, carbsG: 100, fatG: 4, grams: 400 }, { name: 'Chorizo', kcal: 300, grams: 100 }];
          tx.objectStore('kv').put({ id: 'a', name: 'Lentejas de la abuela', createdMs: now, updatedMs: now, ingredients, photo }, 'dish:a');
          tx.objectStore('kv').put({ id: 'b', name: 'Bocadillo', createdMs: now - 1000, updatedMs: now - 1000, ingredients: [{ name: 'Pan', kcal: 200 }] }, 'dish:b');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await page.getByRole('region', { name: 'Nutrición', exact: true }).getByRole('button', { name: 'He comido algo' }).click();
      const dialog = page.locator('dialog.sheet[open]');
      await expect(dialog.getByRole('list', { name: 'Platos guardados' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'menú con la barra de platos').toEqual([]);

      await dialog.getByRole('list', { name: 'Platos guardados' }).getByRole('button', { name: /Lentejas de la abuela/ }).click();
      await expect(dialog.getByLabel('Lentejas', { exact: true })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'anotar con los gramos de cada ingrediente').toEqual([]);
      await dialog.getByLabel('Lentejas', { exact: true }).fill('');
      expect(await violations(page, ['dialog[open]']), 'anotar, con el aviso').toEqual([]);

      await dialog.getByRole('button', { name: 'Editar plato' }).click();
      await expect(dialog.getByRole('img', { name: 'Foto del plato' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'constructor con foto e ingredientes').toEqual([]);
      await dialog.getByLabel('Nombre del plato').fill('');
      await dialog.getByRole('button', { name: 'Guardar plato' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'constructor con el aviso').toEqual([]);
      await dialog.getByRole('button', { name: 'Hacer una foto' }).or(dialog.getByRole('button', { name: 'Repetir foto' })).click();
      await expect(dialog.getByRole('group', { name: 'Cámara para la foto del plato' })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'constructor con la cámara abierta').toEqual([]);
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
      await expect(dialog.getByRole('button', { name: /Escanear un código de barras/ })).toBeVisible();
      expect(await violations(page, ['dialog[open]']), 'elegir cómo añadir un ingrediente').toEqual([]);
    });

    test('hojas de entrenamiento: nuevo, manual y en curso', async ({ page }) => {
      await openDemo(page);
      await goTab(page, 'Deportes');
      await page.locator('.sports-grid').getByRole('button', { name: 'Correr' }).click();
      await expect(page.getByRole('dialog', { name: 'Nuevo entrenamiento' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Añadir' }).click();
      await expect(page.getByRole('dialog', { name: 'Añadir entrenamiento' })).toBeVisible();
      expect(await violations(page, ['dialog[open]'])).toEqual([]);
      await page.keyboard.press('Escape');

      await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
      await page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByRole('button', { name: 'Iniciar' }).click();
      const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
      await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
      expect(await violations(page, ['dialog.live[open]'])).toEqual([]);
    });
  });
}
