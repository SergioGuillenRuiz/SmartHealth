import { expect, openDemo, openPanel, test } from './fixtures';

test('«Medir ahora» mide con el anillo, guarda la lectura y suelta la conexión', async ({ page }) => {
  await openDemo(page);
  // El pulso se mide desde su hoja de detalle (la tarjeta del Resumen solo enseña lo básico).
  await (await openPanel(page, 'Ritmo cardiaco')).getByRole('button', { name: 'Medir ahora' }).click();

  const sheet = page.getByRole('dialog', { name: 'Medir el pulso' });
  await expect(sheet).toContainText('unos 35 segundos');
  await sheet.getByRole('button', { name: 'Empezar medida' }).click();

  await expect(sheet.getByText('Lectura guardada en tu historial de hoy.')).toBeVisible({ timeout: 20_000 });
  await expect(sheet.locator('.measure__value--done')).toContainText(/\d{2,3}\s*lpm/);
  // Se puede repetir y, al cerrar, la sesión ya no existe: el botón vuelve a estar disponible.
  await expect(sheet.getByRole('button', { name: 'Medir otra vez' })).toBeEnabled();
});

test('cerrar la hoja a mitad de la medida la cancela, suelta el anillo y se puede volver a medir', async ({ page }) => {
  await openDemo(page);
  const heart = await openPanel(page, 'Ritmo cardiaco');
  const open = (): Promise<void> => heart.getByRole('button', { name: 'Medir ahora' }).click();
  await open();
  const sheet = page.getByRole('dialog', { name: 'Medir el pulso' });
  await sheet.getByRole('button', { name: 'Empezar medida' }).click();
  await expect(sheet.getByRole('button', { name: 'Cancelar medida' })).toBeVisible();

  await page.keyboard.press('Escape'); // Esc o «atrás» a mitad de la medida
  await expect(sheet).toBeHidden();

  // La hoja no se queda a medias: se reabre y, soltado el anillo, vuelve a ofrecer la medida.
  await open();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Empezar medida' })).toBeEnabled({ timeout: 10_000 });
  await sheet.getByRole('button', { name: 'Empezar medida' }).click();
  await expect(sheet.getByText('Lectura guardada en tu historial de hoy.')).toBeVisible({ timeout: 20_000 });
});
