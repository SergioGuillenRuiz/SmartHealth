import { expect, openDemo, test } from './fixtures';

test('sincronizar con el anillo simulado trae datos y termina sin dejar la conexión abierta', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  await expect(sheet).toBeVisible();

  await sheet.getByRole('button', { name: /Sincronizar ahora|Vincular y sincronizar/ }).click();
  await expect(sheet.getByRole('list', { name: 'Resultado de la sincronización' })).toBeVisible({ timeout: 20_000 });

  // Tras sincronizar el botón vuelve a estar disponible (no queda una sesión colgada)…
  await expect(sheet.getByRole('button', { name: /Sincronizar ahora/ })).toBeEnabled();
  // …y la barra superior lo refleja.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Dispositivos: Anillo sincronizado' })).toBeVisible();
});

test('una segunda sincronización no duplica lo ya guardado', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  const sync = sheet.getByRole('button', { name: /Sincronizar ahora|Vincular y sincronizar/ });

  await sync.click();
  const report = sheet.getByRole('list', { name: 'Resultado de la sincronización' });
  await expect(report).toBeVisible({ timeout: 20_000 });

  await sync.click();
  await expect(report).toBeVisible({ timeout: 20_000 });
  await expect(sheet.getByText('Ya estaba todo al día')).toBeVisible();
});

test('la tarjeta del anillo es solo la cabecera del anillo y sus botones, sin textos de ayuda', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  // El menú de dispositivos lleva una tarjeta por dispositivo: aquí se mira la del anillo.
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' }).getByRole('region', { name: 'Anillo', exact: true });

  // Arriba, lo que importa del anillo: cómo se llama, cuándo se sincronizó y la batería.
  await expect(sheet.locator('.ring-hero__name')).toHaveText(/\S/);
  await expect(sheet.locator('.ring-hero')).toContainText('Última sincronización');
  await expect(sheet.locator('.ring-hero')).toContainText('batería');

  // Debajo, los botones.
  for (const name of ['Sincronizar ahora', 'Elegir otro anillo', 'Olvidar anillo', 'Mostrar todos los dispositivos Bluetooth']) {
    await expect(sheet.getByRole('button', { name })).toBeVisible();
  }

  // Y nada más: ni consejos ni párrafos explicativos.
  for (const text of ['Para que conecte a la primera', '¿No aparece tu anillo en la lista?', 'Cierra la app Smart Health', 'suele llamarse']) {
    await expect(sheet.getByText(text)).toHaveCount(0);
  }
  await expect(sheet.getByRole('listitem')).toHaveCount(0);
  await expect(sheet.locator('p:not(.sr-only)')).toHaveCount(0);
  // Su interruptor de «lo tengo» va arriba, con una línea que lo explica.
  await expect(sheet.getByRole('checkbox', { name: /Tengo el anillo/ })).toBeChecked();
});

test('tras sincronizar el resultado cabe en una línea (y otra si ya estaba todo al día), sin recuentos por tipo', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  const report = sheet.getByRole('list', { name: 'Resultado de la sincronización' });

  await sheet.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(report).toBeVisible({ timeout: 20_000 });
  await expect(report.getByRole('listitem')).toHaveCount(1);
  await expect(report).toContainText(/Sincronizado en \d+ s/);
  for (const text of ['tramos de actividad', 'lecturas de pulso', 'lecturas de oxígeno', 'noches de sueño']) {
    await expect(report).not.toContainText(text);
  }

  await sheet.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(report.getByText('Ya estaba todo al día')).toBeVisible({ timeout: 20_000 });
  await expect(report.getByRole('listitem')).toHaveCount(2);
});

test('si el anillo no aparece en la lista, se puede buscar entre todos los dispositivos', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  await sheet.getByRole('button', { name: 'Mostrar todos los dispositivos Bluetooth' }).click();
  await expect(sheet.getByRole('list', { name: 'Resultado de la sincronización' })).toBeVisible({ timeout: 20_000 });
});

test('la hoja del anillo recuerda la última sincronización al reabrir la app', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  await sheet.getByRole('button', { name: /Sincronizar ahora|Vincular y sincronizar/ }).click();
  await expect(sheet.getByRole('list', { name: 'Resultado de la sincronización' })).toBeVisible({ timeout: 20_000 });

  // Reabrir la app conservando los datos de la demostración.
  await page.goto('/?demo=keep');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const reopened = page.getByRole('dialog', { name: 'Dispositivos' }).getByRole('region', { name: 'Anillo', exact: true });
  // La cabecera dice cuándo fue la última sincronización y con qué batería estaba el anillo.
  await expect(reopened.locator('.ring-hero')).toContainText('Última sincronización');
  await expect(reopened.locator('.ring-hero')).toContainText(/batería \d+\s*%/);
});
