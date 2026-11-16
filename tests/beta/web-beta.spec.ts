import { expect, type Page } from '@playwright/test';
import { test } from '../e2e/fixtures';

// La app PARA BETATESTERS (versión web) abierta como la abrirá un tester en su móvil: sin `?demo=1`. Es la de siempre con el anillo y la báscula simulados y datos de ejemplo la primera vez, pero lo que se anota se queda.
const SEED_KEY = 'smartring.beta.seeded.v1';

const ready = async (page: Page): Promise<void> => {
  await expect(page.getByRole('region', { name: 'Actividad diaria' }).first()).toBeVisible();
};
const nutrition = (page: Page) => page.getByRole('region', { name: 'Nutrición', exact: true }).first();

test('arranca sin ?demo con datos de ejemplo y su propia base (no la de la demostración)', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), SEED_KEY)).toBe('1');
  const databases = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((db) => db.name));
  expect(databases).toContain('smartring');
  expect(databases).not.toContain('smartring-demo');
  // El anillo simulado queda ya vinculado y la actualización automática lo sincroniza sola (el sembrado deja una sincronización; la automática, otra). Lo que enseña «Actividad diaria»
  // depende de la hora (de madrugada el anillo de mentira todavía no ha contado pasos), por eso no se mira.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('smartring');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const count = await new Promise<number>((resolve) => {
          const request = db.transaction('syncs').objectStore('syncs').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(0);
        });
        db.close();
        return count;
      }),
    )
    .toBeGreaterThanOrEqual(2);
});

test('lo anotado se queda al volver a abrir: no se vuelve a sembrar encima', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await nutrition(page).getByRole('button', { name: /^Estás viendo la comida/ }).click();
  await nutrition(page).getByRole('button', { name: 'Un vaso' }).click();
  const list = nutrition(page).getByRole('list', { name: 'Tomas de agua del día' });
  await expect(list.getByRole('listitem')).toHaveCount(1);

  // Como cerrar la app del todo y abrirla otra vez.
  await page.reload();
  await ready(page);
  await nutrition(page).getByRole('button', { name: /^Estás viendo la comida/ }).click();
  await expect(nutrition(page).getByRole('list', { name: 'Tomas de agua del día' }).getByRole('listitem')).toHaveCount(1);
});

test('si se vacía la base («Borrar todo»), los datos de ejemplo no vuelven solos', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const rows = (): Promise<number> =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      let total = 0;
      for (const name of [...db.objectStoreNames]) {
        total += await new Promise<number>((resolve) => {
          const count = db.transaction(name).objectStore(name).count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(0);
        });
      }
      db.close();
      return total;
    });
  const seeded = await rows();
  expect(seeded).toBeGreaterThan(100);

  // Vaciar la base entera (lo que hace «Borrar todo») y volver a abrir.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const name of [...db.objectStoreNames]) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
    db.close();
  });
  await page.reload();
  await ready(page);
  // Con los datos de ejemplo de nuevo habría otra vez toda la historia; sin ellos solo queda lo que trae la sincronización con el anillo simulado.
  await expect.poll(rows).toBeLessThan(seeded / 2);
});
