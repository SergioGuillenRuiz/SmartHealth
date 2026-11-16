import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, test } from './fixtures';

// El menú de dispositivos (arriba a la derecha): el anillo y la báscula, cada uno con su interruptor de «lo tengo». Sin anillo, las tarjetas y gráficas de pulso, sueño y oxígeno no salen,
// los deportes no salen salvo andar (medido con el móvil) y no se borra ningún dato; sin báscula, «Pesar con la báscula» no sale. Lo que depende de un dispositivo que no se tiene NO aparece
// (ni en gris ni a rayas ni como «no disponible»): con el interruptor encendido, todo vuelve.

const open = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
};

const toggle = async (page: Page, name: RegExp, on: boolean): Promise<void> => {
  const sheet = await open(page);
  const box = sheet.getByRole('checkbox', { name });
  if (on) await box.check();
  else await box.uncheck();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Dispositivos', exact: true })).toHaveCount(0);
};

test.describe('menú de dispositivos', () => {
  test('el botón de arriba es el de dispositivos y la hoja trae el anillo y la báscula, cada uno con su interruptor', async ({ page }) => {
    await openDemo(page);
    const sheet = await open(page);
    await expect(sheet.getByRole('heading', { name: 'Anillo' })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Báscula de cocina' })).toBeVisible();
    await expect(sheet.getByRole('checkbox', { name: /Tengo el anillo/ })).toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: /Tengo la báscula/ })).toBeChecked();
    // Lo que había para el anillo sigue ahí…
    await expect(sheet.getByRole('button', { name: /Sincronizar ahora|Vincular y sincronizar/ })).toBeVisible();
    // La báscula se empareja y se gestiona aquí mismo, dentro de su tarjeta (sin emparejar, el asistente de conectarla).
    await expect(sheet.getByRole('heading', { name: 'Conectar la báscula' })).toBeVisible();
  });

  test('sin anillo: las tarjetas de pulso y sueño (Resumen) y las gráficas de sueño, pulso y oxígeno (Salud) no salen, y al encenderlo vuelven con sus datos', async ({ page }) => {
    await openDemo(page);
    const summary = activePage(page);
    await expect(summary.getByRole('region', { name: 'Sueño', exact: true })).toBeVisible();
    await expect(summary.getByRole('region', { name: 'Ritmo cardiaco', exact: true })).toBeVisible();

    await toggle(page, /Tengo el anillo/, false);
    for (const name of ['Ritmo cardiaco', 'Sueño']) await expect(summary.getByRole('region', { name, exact: true })).toHaveCount(0);
    await expect(summary).not.toContainText('No disponible sin anillo'); // ni una tarjeta que lo diga
    // El botón de arriba lo dice.
    await expect(page.getByRole('button', { name: 'Dispositivos: sin anillo' })).toBeVisible();

    await goTab(page, 'Salud');
    const health = activePage(page);
    await expect(health.getByRole('region', { name: 'Evolución', exact: true })).toBeVisible(); // lo que no es del anillo sigue
    for (const name of ['Sueño', 'Pulso', 'Oxígeno en sangre']) await expect(health.getByRole('region', { name, exact: true })).toHaveCount(0);
    await expect(health).not.toContainText('No disponible sin anillo');

    // Apagarlo no borró nada: al encenderlo vuelve todo.
    await toggle(page, /Tengo el anillo/, true);
    await expect(health.getByRole('region', { name: 'Sueño', exact: true })).toBeVisible();
    await goTab(page, 'Resumen');
    await expect(summary.getByRole('region', { name: 'Ritmo cardiaco', exact: true })).toBeVisible();
  });

  test('sin anillo, Deportes deja solo andar (el resto no sale) y explica por qué', async ({ page }) => {
    await openDemo(page);
    await toggle(page, /Tengo el anillo/, false);
    await goTab(page, 'Deportes');
    const grid = page.locator('.sports-grid');
    await expect(grid.getByRole('button')).toHaveCount(1);
    await expect(grid.getByRole('button', { name: 'Caminar' })).toBeEnabled();
    for (const name of ['Correr', 'Yoga', 'Ciclismo']) await expect(grid.getByRole('button', { name })).toHaveCount(0);
    await expect(page.locator('.is-locked')).toHaveCount(0); // nada en gris a rayas
    // El aviso es corto y va a la derecha de la única actividad (no debajo).
    const note = page.locator('.hero-card').filter({ hasText: 'Elige una actividad' }).locator('.locked-note');
    await expect(note).toContainText('El resto de deportes, el pulso y las kcal precisas necesitan anillo');
    const [walk, noteBox] = await Promise.all([grid.getByRole('button', { name: 'Caminar' }).boundingBox(), note.boundingBox()]);
    expect(noteBox!.x).toBeGreaterThan(walk!.x + walk!.width - 1);
    expect(Math.abs(noteBox!.y + noteBox!.height / 2 - (walk!.y + walk!.height / 2))).toBeLessThan(60);
    // Lo de siempre del anillo no se ofrece.
    await expect(activePage(page).getByText('Vincula tu anillo')).toHaveCount(0);
    // Con el anillo otra vez, todo vuelve a poder elegirse.
    await toggle(page, /Tengo el anillo/, true);
    await expect(grid.getByRole('button', { name: 'Correr' })).toBeEnabled();
    await expect(grid.getByRole('button', { name: 'Yoga' })).toBeVisible();
  });

  test('sin anillo se puede andar: una versión simple del entreno, medida con el móvil (sin pulso ni anillo), que se revisa y se guarda', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 40.4168, longitude: -3.7038, accuracy: 5 });
    await openDemo(page);
    await toggle(page, /Tengo el anillo/, false);
    await goTab(page, 'Deportes');
    await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
    const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
    await expect(ready).toContainText('GPS del móvil');
    await expect(ready).toContainText('Sin pulso ni pasos');
    await expect(ready).not.toContainText('Se conectará con'); // no hay anillo al que conectarse
    await ready.getByRole('button', { name: 'Iniciar' }).click();

    const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
    await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
    await expect(live.getByText('Calorías ≈')).toBeVisible();
    await expect(live.getByText('Pulso medio')).toHaveCount(0);
    await expect(live.getByText('Se perdió la conexión con el anillo')).toHaveCount(0);

    await live.getByRole('button', { name: 'Terminar' }).click();
    await live.getByRole('button', { name: 'Terminar y revisar' }).click();
    const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
    await expect(review).toContainText('Caminar');
    await review.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
  });

  test('sin báscula, «Pesar con la báscula» no sale; con ella, sí', async ({ page }) => {
    await openDemo(page);
    const nutrition = activePage(page).getByRole('region', { name: 'Nutrición', exact: true });
    await nutrition.getByRole('button', { name: 'He comido algo' }).click();
    const meal = page.locator('dialog.sheet[open]');
    const row = meal.getByRole('button', { name: /Pesar con la báscula/ });
    await expect(row).toBeEnabled();
    await page.keyboard.press('Escape');

    await toggle(page, /Tengo la báscula/, false);
    await nutrition.getByRole('button', { name: 'He comido algo' }).click();
    const menu = page.locator('dialog.sheet[open]');
    await expect(menu.getByRole('button', { name: /Escanear un código de barras/ })).toBeVisible(); // el resto de formas de anotar sigue
    await expect(menu.getByRole('button', { name: /Pesar con la báscula/ })).toHaveCount(0);
    await expect(menu.locator('.is-locked')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await toggle(page, /Tengo la báscula/, true);
    await nutrition.getByRole('button', { name: 'He comido algo' }).click();
    await expect(page.locator('dialog.sheet[open]').getByRole('button', { name: /Pesar con la báscula/ })).toBeEnabled();
  });

  test('la elección persiste al recargar y los dos interruptores son independientes', async ({ page }) => {
    await openDemo(page);
    await toggle(page, /Tengo la báscula/, false);
    // El ajuste se guarda en IndexedDB sin esperar: se espera a que esté escrito antes de recargar (si no, la recarga a veces lo pierde: carrera de la prueba, no de la app).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('smartring-demo');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const all = open.result.transaction('kv', 'readonly').objectStore('kv').getAll();
                all.onsuccess = () => resolve(JSON.stringify(all.result).includes('"hasScale":false'));
                all.onerror = () => resolve(false);
              };
            }),
        ),
      )
      .toBe(true);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const sheet = await open(page);
    await expect(sheet.getByRole('checkbox', { name: /Tengo la báscula/ })).not.toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: /Tengo el anillo/ })).toBeChecked();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`el menú y lo que sale sin anillo cumplen la accesibilidad (axe, tema ${scheme === 'light' ? 'claro' : 'oscuro'})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openDemo(page);
      const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
      const sheet = await open(page);
      await expect(sheet).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0)).map((a) => a.finished.catch(() => undefined))));
      const menu = await new AxeBuilder({ page }).withTags(tags).include('dialog[open]').analyze();
      expect(menu.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

      await sheet.getByRole('checkbox', { name: /Tengo el anillo/ }).uncheck();
      await sheet.getByRole('checkbox', { name: /Tengo la báscula/ }).uncheck();
      const off = await new AxeBuilder({ page }).withTags(tags).include('dialog[open]').analyze();
      expect(off.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await page.keyboard.press('Escape');

      for (const tab of ['Resumen', 'Deportes', 'Salud'] as const) {
        await goTab(page, tab);
        // (La regla de «un encabezado de nivel 1» es de la estructura de las pestañas, que ya estaba así: aquí se mira lo que sale sin anillo.)
        const result = await new AxeBuilder({ page }).withTags(tags).disableRules(['page-has-heading-one']).exclude('.nav').analyze();
        expect(result.violations.map((v) => `${tab}: ${v.id}: ${v.help}`)).toEqual([]);
      }
    });
  }
});
