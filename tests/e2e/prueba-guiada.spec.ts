import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { activePage, expect, openDemo, test } from './fixtures';

// La prueba guiada (temporal) con el anillo simulado: en la demostración las esperas se reducen a una fracción.
// Está oculta de la interfaz: solo aparece con el interruptor `?prueba=1`, que es como la abren estas pruebas.

const openDemoWithTest = async (page: Page) => {
  await page.goto('/?demo=1&prueba=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
};

test('la prueba guiada no se ve en la interfaz normal, ni siquiera en la demostración', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole('region', { name: 'Prueba guiada del anillo' })).toHaveCount(0);
  await expect(page.getByText('Empezar la prueba')).toHaveCount(0);
});

const openSheet = async (page: Page) => {
  await activePage(page).getByRole('region', { name: 'Prueba guiada del anillo' }).getByRole('button', { name: 'Empezar la prueba' }).click();
  const sheet = page.getByRole('dialog', { name: 'Prueba guiada del anillo' });
  await expect(sheet).toContainText('Antes de empezar');
  await expect(sheet).toContainText('Versión de la app:'); // para saber qué compilación se está probando
  return sheet;
};

test('recorre todos los pasos pidiendo los gestos, descarga el informe y deja el anillo libre', async ({ page }) => {
  await openDemoWithTest(page);
  const sheet = await openSheet(page);
  const download = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Empezar la prueba' }).click();

  // Los pasos que exigen moverse esperan a que la persona pulse «Estoy listo».
  await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible({ timeout: 40_000 });
  await sheet.getByRole('button', { name: 'Estoy listo' }).click();
  await expect(sheet.getByRole('heading', { name: 'Entreno: prepárate' })).toBeVisible({ timeout: 40_000 });
  await sheet.getByRole('button', { name: 'Estoy listo' }).click();

  await expect(sheet.getByRole('heading', { name: 'Prueba terminada' })).toBeVisible({ timeout: 60_000 });
  await expect(sheet.getByText(/Informe guardado en/)).toContainText('SmartHealth-prueba-');
  await expect(sheet.getByRole('button', { name: 'Copiar resumen' })).toBeVisible();

  // Los nueve pasos con su resultado.
  const steps = sheet.getByRole('list', { name: 'Pasos de la prueba' }).getByRole('listitem');
  await expect(steps).toHaveCount(9);
  await expect(steps.nth(3)).toContainText('Sincronizar');
  await expect(steps.nth(3)).toContainText('Bien');

  // El fichero descargado es el informe completo.
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^SmartHealth-prueba-\d{8}-\d{4}\.txt$/);
  const text = await readFile(await file.path(), 'utf8');
  expect(text).toContain('SmartHealth · informe de la prueba guiada');
  expect(text).toContain('MODO DEMOSTRACIÓN');
  expect(text).toContain('RESUMEN');
  expect(text).toContain('===== TRAZA «sync»');
  expect(text).toContain('Prueba completa');

  // Terminada la prueba el anillo vuelve a estar disponible para todo lo demás.
  await sheet.getByRole('button', { name: 'Hecho' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Dispositivos' }).getByRole('button', { name: /Sincronizar ahora/ })).toBeEnabled();
});

test('cancelar a mitad suelta el anillo y descarga lo hecho hasta entonces', async ({ page }) => {
  await openDemoWithTest(page);
  const sheet = await openSheet(page);
  const download = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Empezar la prueba' }).click();
  await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible({ timeout: 40_000 });

  // Mientras corre no se cierra con Esc ni con el fondo: se sale cancelando, con confirmación.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancelar la prueba' }).click();
  await expect(sheet.getByText('Si cancelas, se guarda lo hecho hasta ahora')).toBeVisible();
  await sheet.getByRole('button', { name: 'Seguir con la prueba' }).click();
  await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancelar la prueba' }).click();
  await sheet.getByRole('button', { name: 'Sí, cancelar' }).click();

  await expect(sheet.getByRole('heading', { name: 'Prueba cancelada' })).toBeVisible({ timeout: 20_000 });
  const text = await readFile(await (await download).path(), 'utf8');
  expect(text).toContain('Prueba CANCELADA');
  expect(text).toContain('La persona cancela la prueba');

  // El resultado se puede volver a ver desde la tarjeta hasta que se cierra.
  await sheet.getByRole('button', { name: 'Hecho' }).click();
  await expect(activePage(page).getByRole('button', { name: 'Empezar la prueba' })).toBeVisible();
});

test('saltar un paso lo deja como saltado y la prueba sigue', async ({ page }) => {
  await openDemoWithTest(page);
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Empezar la prueba' }).click();
  await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible({ timeout: 40_000 });
  // Saltar pide una segunda pulsación (un roce con el móvil en la mano no debe tirar el paso).
  await sheet.getByRole('button', { name: 'Saltar este paso' }).click();
  await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Pulsa otra vez para saltar' }).click();
  await expect(sheet.getByRole('heading', { name: 'Entreno: prepárate' })).toBeVisible({ timeout: 40_000 });
  await expect(sheet.getByRole('list', { name: 'Pasos de la prueba' }).getByRole('listitem').nth(4)).toContainText('Saltado');
  await sheet.getByRole('button', { name: 'Saltar este paso' }).click();
  await sheet.getByRole('button', { name: 'Pulsa otra vez para saltar' }).click();
  await expect(sheet.getByRole('heading', { name: 'Prueba terminada' })).toBeVisible({ timeout: 60_000 });
  await expect(sheet.getByText('2 saltados')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accesibilidad de la hoja (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openDemoWithTest(page);
    const results = async (): Promise<string[]> => {
      const found = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('dialog[open]').analyze();
      return found.violations.map((v) => `[${v.impact}] ${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    };

    const sheet = await openSheet(page);
    expect(await results()).toEqual([]); // antes de empezar

    await sheet.getByRole('button', { name: 'Empezar la prueba' }).click();
    await expect(sheet.getByRole('heading', { name: 'Pasos: prepárate' })).toBeVisible({ timeout: 40_000 });
    expect(await results()).toEqual([]); // esperando a «Estoy listo»
    await sheet.getByRole('button', { name: 'Estoy listo' }).click();
    await expect(sheet.getByRole('heading', { name: 'Entreno: prepárate' })).toBeVisible({ timeout: 40_000 });
    await sheet.getByRole('button', { name: 'Estoy listo' }).click();

    await expect(sheet.getByRole('heading', { name: 'Prueba terminada' })).toBeVisible({ timeout: 60_000 });
    expect(await results()).toEqual([]); // resultado
  });
}
