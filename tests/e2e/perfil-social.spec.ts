import type { Locator, Page } from '@playwright/test';
import { expect, openDemo, test } from './fixtures';

// El perfil de cara a los demás (base de una futura mini-red social): foto, nombre de usuario con su etiqueta única y un estado. Vive en el móvil y viaja en la copia de seguridad.

const menu = (page: Page): Locator => page.getByRole('dialog', { name: 'Mi perfil', exact: true });
const editor = (page: Page): Locator => page.getByRole('dialog', { name: 'Perfil y datos', exact: true });

async function openEditor(page: Page): Promise<Locator> {
  // Tras guardar, el menú de perfil sigue abierto debajo (se vuelve a él): solo se abre si no lo está.
  if (!(await menu(page).isVisible())) await page.getByRole('button', { name: 'Mi perfil' }).click();
  await menu(page).getByRole('button', { name: /^(Elige tu nombre de usuario|@)/ }).click();
  await expect(editor(page)).toBeVisible();
  return editor(page);
}

test.describe('perfil social', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('al principio pide elegir un nombre; se edita y se ve en el menú con su etiqueta única', async ({ page }) => {
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    await expect(menu(page).getByRole('button', { name: /Elige tu nombre de usuario/ })).toBeVisible();
    await menu(page).getByRole('button', { name: /Elige tu nombre de usuario/ }).click();
    const dialog = editor(page);
    await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled(); // sin cambios no hay nada que guardar

    // Un nombre que no vale se explica y no deja guardar.
    await dialog.getByLabel('Nombre de usuario').fill('a');
    await expect(dialog).toContainText('Pon al menos 3 caracteres.');
    await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    await dialog.getByLabel('Nombre de usuario').fill('admin');
    await expect(dialog).toContainText('reservado');

    // Uno que vale: se normaliza (sin tildes ni mayúsculas) y enseña el identificador completo.
    await dialog.getByLabel('Nombre de usuario').fill('Ana María');
    await expect(dialog).toContainText(/Tu identificador: @ana_maria#[0-9A-Z]{4}\./);
    await dialog.getByLabel('Estado').fill('  A por la media   maratón ');
    await expect(dialog).toContainText('27 / 80'); // lo que se ha escrito, con sus espacios: se recogen al guardar
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Perfil guardado' })).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await page.keyboard.press('Escape'); // guardar deja la hoja abierta (los datos personales siguen debajo): se cierra aquí
    await expect(editor(page)).toBeHidden();
    const card = menu(page).getByRole('button', { name: /@ana_maria/ });
    await expect(card).toContainText('A por la media maratón');
  });

  test('el perfil (foto, nombre y estado) y los datos personales van juntos, en una sola hoja que se abre con la tarjeta de arriba del menú', async ({ page }) => {
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    const card = menu(page).locator('.profile-card');
    // La tarjeta enseña, debajo del nombre, los datos personales; y ya no hay una fila «Mis datos» aparte.
    await expect(card).toContainText(/\d+ cm · [\d,]+ kg · \d+ años/);
    await expect(menu(page).getByRole('button', { name: /^Mis datos/ })).toHaveCount(0);
    await card.click();
    const dialog = editor(page);
    await expect(dialog.getByLabel('Nombre de usuario')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Datos personales' })).toBeVisible();
    await expect(dialog.getByText('Altura', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Actualizar' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Calibrar zancada' })).toBeVisible();
  });

  test('lo guardado sigue al recargar y la identidad (la etiqueta) no cambia', async ({ page }) => {
    let dialog = await openEditor(page);
    await dialog.getByLabel('Nombre de usuario').fill('luis.g');
    const hint = (await dialog.locator('#social-username-hint').textContent()) ?? '';
    const tag = /#([0-9A-Z]{4})/.exec(hint)?.[1];
    expect(tag).toBeTruthy();
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await page.keyboard.press('Escape'); // guardar deja la hoja abierta (los datos personales siguen debajo): se cierra aquí
    await expect(editor(page)).toBeHidden();
    // Lo guardado se escribe en IndexedDB sin esperar: se espera a que esté escrito antes de recargar (si no, la recarga a veces lo pierde: carrera de la prueba, no de la app).
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('smartring-demo');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const all = open.result.transaction('kv', 'readonly').objectStore('kv').getAll();
                all.onsuccess = () => resolve(JSON.stringify(all.result).includes('luis.g'));
                all.onerror = () => resolve(false);
              };
            }),
        ),
      )
      .toBe(true);
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    dialog = await openEditor(page);
    await expect(dialog.getByLabel('Nombre de usuario')).toHaveValue('luis.g');
    await expect(dialog.locator('#social-username-hint')).toContainText(`#${tag}`);
  });

  test('la foto se sube, sale en el menú y en el botón de arriba, y se puede quitar', async ({ page }) => {
    const dialog = await openEditor(page);
    await expect(dialog.getByRole('button', { name: 'Quitar foto' })).toHaveCount(0);
    await dialog.getByLabel('Elegir una foto de la galería').setInputFiles('public/icons/icon-192.png');
    await expect(dialog.getByRole('button', { name: 'Quitar foto' })).toBeVisible();
    await expect(dialog.locator('.avatar img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    // El JPEG guardado es pequeño y cuadrado.
    const size = await dialog.locator('.avatar img').evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(size).toEqual({ w: 256, h: 256 });
    await dialog.getByLabel('Nombre de usuario').fill('ana');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await page.keyboard.press('Escape'); // guardar deja la hoja abierta (los datos personales siguen debajo): se cierra aquí
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('.topbtn--user .avatar img')).toBeVisible();
    await expect(menu(page).locator('.profile-card .avatar img')).toBeVisible();
    const again = await openEditor(page);
    await again.getByRole('button', { name: 'Quitar foto' }).click();
    await again.getByRole('button', { name: 'Guardar' }).click();
    await page.keyboard.press('Escape'); // guardar deja la hoja abierta (los datos personales siguen debajo): se cierra aquí
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('.topbtn--user .avatar img')).toHaveCount(0);
  });

  test('un archivo que no es una imagen se rechaza con una frase y no cambia nada', async ({ page }) => {
    const dialog = await openEditor(page);
    await dialog.getByLabel('Elegir una foto de la galería').setInputFiles({ name: 'nota.txt', mimeType: 'text/plain', buffer: Buffer.from('esto no es una foto') });
    await expect(dialog.getByRole('alert')).toContainText('No se pudo leer esa imagen');
    await expect(dialog.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  test('el perfil queda guardado en el almacén con su identificador único de 26 caracteres (el mismo que viaja en la copia de seguridad)', async ({ page }) => {
    const dialog = await openEditor(page);
    await dialog.getByLabel('Nombre de usuario').fill('ana');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await page.keyboard.press('Escape'); // guardar deja la hoja abierta (los datos personales siguen debajo): se cierra aquí
    await expect(editor(page)).toBeHidden();
    const exported = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise<{ uid: string; username: string }>((resolve, reject) => {
        const request = db.transaction('kv').objectStore('kv').get('social');
        request.onsuccess = () => resolve(request.result as { uid: string; username: string });
        request.onerror = () => reject(request.error);
      });
      db.close();
      return value;
    });
    expect(exported.username).toBe('ana');
    expect(exported.uid).toHaveLength(26);
  });
});
