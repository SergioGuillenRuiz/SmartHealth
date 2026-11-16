import { ageDemoSync, expect, openDemo, openUserSection, test } from './fixtures';

/** El diagnóstico del anillo (menú de perfil → Datos y copias de seguridad): cómo está de un vistazo y qué conviene hacer. */
const openDiagnosis = async (page: import('@playwright/test').Page) => {
  const backup = await openUserSection(page, 'Datos y copias de seguridad');
  await backup.getByRole('button', { name: 'Diagnóstico del anillo' }).click();
  const sheet = page.getByRole('dialog', { name: 'Diagnóstico del anillo' });
  await expect(sheet).toBeVisible();
  return sheet;
};

const verdict = (sheet: import('@playwright/test').Locator) => sheet.getByRole('region', { name: 'Estado del anillo' });

test('con el anillo al día dice que todo está en orden y da lo esencial, sin textos de ayuda', async ({ page }) => {
  await openDemo(page);
  const sheet = await openDiagnosis(page);

  await expect(verdict(sheet)).toContainText('Todo en orden');
  await expect(verdict(sheet).getByRole('listitem')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: /Ir a sincronizar|Ir a vincular/ })).toHaveCount(0);

  // El anillo, su batería, su firmware, cuándo se sincronizó y cada cuánto mide.
  const fact = (label: string) => sheet.locator('.data-grid > div').filter({ has: page.locator('dt', { hasText: label }) });
  await expect(fact('Anillo')).toContainText('R99');
  await expect(fact('Batería')).toContainText(/\d+\s*%/);
  await expect(fact('Firmware')).toContainText(/\d/);
  await expect(fact('Última sincronización')).toContainText(/hace [12] h/); // la demostración la trae de hace 2 h (y el reloj de la pantalla puede ir unos segundos por detrás)
  await expect(fact('Medición automática')).toContainText('Pulso y oxígeno cada 60 min');

  // Lo último que ha llegado de cada tipo: la demostración tiene de todo.
  await expect(sheet.getByRole('heading', { name: 'Último dato guardado' })).toBeVisible();
  for (const label of ['Pulso', 'Oxígeno', 'Actividad', 'Sueño']) await expect(fact(label)).toContainText(/ahora mismo|hace|ayer/);
  await expect(sheet.locator('.field__hint, .card__lead')).toHaveCount(0);
  await expect(sheet.getByRole('table')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('el intervalo de medición automática que se elige en los objetivos es el que enseña el diagnóstico', async ({ page }) => {
  await openDemo(page);
  const goals = await openUserSection(page, 'Objetivos y medición');
  await goals.getByRole('button', { name: '2 h' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const sheet = await openDiagnosis(page);
  await expect(sheet).toContainText('Pulso y oxígeno cada 2 h');
});

test('con días sin sincronizar y poca batería lo dice, lo grave primero, y lleva a sincronizar; al sincronizar se pone al día', async ({ page }) => {
  await openDemo(page);
  await ageDemoSync(page, { hoursAgo: 4 * 24 + 3, batteryPercent: 8 });
  const sheet = await openDiagnosis(page);

  await expect(verdict(sheet)).toContainText('Necesita atención');
  const findings = verdict(sheet).getByRole('listitem');
  await expect(findings).toHaveCount(2);
  await expect(findings.nth(0)).toContainText(/La última sincronización fue hace \d+ días: el anillo solo guarda unos días de datos\./);
  await expect(findings.nth(1)).toContainText(/Batería muy baja: 8\s*%/);

  // El botón no sincroniza por su cuenta: abre la hoja del anillo, donde se hace.
  await sheet.getByRole('button', { name: 'Ir a sincronizar' }).click();
  const ring = page.getByRole('dialog', { name: 'Dispositivos', exact: true });
  await expect(ring).toBeVisible();
  await ring.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(ring.getByRole('list', { name: 'Resultado de la sincronización' })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(ring).toBeHidden();

  // El diagnóstico seguía abierto debajo y ya refleja la sincronización nueva.
  await expect(sheet).toBeVisible();
  await expect(verdict(sheet)).toContainText('Todo en orden');
  await expect(sheet.locator('.data-grid > div').filter({ has: page.locator('dt', { hasText: 'Última sincronización' }) })).toContainText(/ahora mismo|hace \d+ min/);
});

test('un solo aviso grave: la batería muy baja se cuenta pero sincronizar no la arregla, así que no ofrece el botón', async ({ page }) => {
  await openDemo(page);
  await ageDemoSync(page, { hoursAgo: 1, batteryPercent: 7 });
  const sheet = await openDiagnosis(page);
  await expect(verdict(sheet)).toContainText('Necesita atención');
  await expect(verdict(sheet).getByRole('listitem')).toHaveText([/Batería muy baja: 7\s*%.*Ponlo a cargar\./]);
  await expect(sheet.getByRole('button', { name: /Ir a sincronizar/ })).toHaveCount(0);
});

test('sin anillo vinculado solo ofrece vincularlo', async ({ page }) => {
  await page.goto('/');
  const sheet = await openDiagnosis(page);
  await expect(verdict(sheet)).toContainText('Sin anillo vinculado');
  await expect(sheet.locator('.data-grid').first()).not.toContainText('Firmware'); // sin anillo no hay ficha del anillo
  await sheet.getByRole('button', { name: 'Ir a vincular el anillo' }).click();
  await expect(page.getByRole('dialog', { name: 'Dispositivos', exact: true })).toBeVisible();
});
