import { activePage, expect, goTab, openDemo, openUserSection, savedProfile, test } from './fixtures';

test('los avisos se ven por ENCIMA de las hojas abiertas (antes quedaban tapados)', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dispositivos' });
  await sheet.getByRole('button', { name: /Sincronizar ahora|Vincular y sincronizar/ }).click();
  await expect(sheet.getByRole('list', { name: 'Resultado de la sincronización' })).toBeVisible({ timeout: 20_000 });

  // Olvidar el anillo avisa de lo que ha pasado. Con la hoja abierta se ve —y se anuncia— el aviso de la propia hoja; el de la app queda oculto.
  await sheet.getByRole('button', { name: 'Olvidar anillo' }).click();
  const confirm = sheet.getByRole('button', { name: 'Confirmar: olvidar anillo' });
  await expect(confirm).toBeEnabled(); // un doble toque no lo confirma: se arma al instante siguiente
  await confirm.click();
  const toast = page.locator('dialog[open] .toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText('Anillo olvidado. Tus datos guardados siguen aquí.');
  const onTop = await toast.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && el.contains(top);
  });
  expect(onTop, 'el aviso debe ser lo más alto en pantalla, no estar bajo la hoja').toBe(true);
});

test('si la app se cierra durante un entreno, se recupera para revisarlo y guardarlo', async ({ page }) => {
  await openDemo(page);
  // Lo que dejaría el controlador del entreno: un borrador en el almacén (30 s antes del cierre, como mucho).
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const draft = { id: 'w-recuperado', sport: 'walk', startMs: now - 40 * 60_000, endMs: now - 5 * 60_000, pausedMs: 0, source: 'live', steps: 3000 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(draft, 'workoutDraft');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.goto('/?demo=keep');
  const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('La app se cerró durante este entrenamiento');
  await expect(review).toContainText('Caminar');
  await review.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();

  // Ya está guardado y el borrador se borró: al volver a abrir la app no reaparece.
  await page.goto('/?demo=keep');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Entrenamiento terminado' })).toBeHidden();
  await goTab(page, 'Deportes');
  await expect(activePage(page).locator('ul.wk-list > li').first()).toContainText('Caminar');
});

test('dar de alta una entrada con la fecha de otra ya guardada avisa antes de pisarla, y sin confirmar no se toca nada', async ({ page }) => {
  await openDemo(page);
  const card = await openUserSection(page, 'Mis datos');
  const before = await savedProfile(page);
  const oldest = before[0];
  if (!oldest) throw new Error('la demostración trae un historial de perfil');

  // «Actualizar» abre una entrada NUEVA con los datos de hoy; se le pone la fecha de la más antigua.
  await card.getByRole('button', { name: 'Actualizar' }).click();
  const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
  await sheet.getByLabel('Vigente desde').fill(oldest.date);
  await sheet.getByLabel('Peso (kg)').fill('99');
  await sheet.getByRole('button', { name: 'Guardar' }).click();

  await expect(sheet.getByText(/Ya tienes una entrada del/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Sustituir y guardar' })).toBeVisible();

  // Sin confirmar, no se toca nada.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await savedProfile(page)).toEqual(before);
});

test('confirmar el aviso sustituye la entrada de esa fecha, sin añadir otra', async ({ page }) => {
  await openDemo(page);
  const card = await openUserSection(page, 'Mis datos');
  const before = await savedProfile(page);
  const oldest = before[0];
  if (!oldest) throw new Error('la demostración trae un historial de perfil');

  await card.getByRole('button', { name: 'Actualizar' }).click();
  const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
  await sheet.getByLabel('Vigente desde').fill(oldest.date);
  await sheet.getByLabel('Peso (kg)').fill('99');
  await sheet.getByRole('button', { name: 'Guardar' }).click();
  const replace = sheet.getByRole('button', { name: 'Sustituir y guardar' });
  await expect(replace).toBeEnabled();
  await replace.click();

  await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();
  await expect(sheet).toBeHidden();
  const after = await savedProfile(page);
  expect(after).toHaveLength(before.length);
  expect(after[0]).toMatchObject({ date: oldest.date, weightKg: 99 });
});
