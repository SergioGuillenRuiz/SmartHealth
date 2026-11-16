import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { activePage, expect, openDemo, test } from './fixtures';

// Corregir a mano las horas de una noche estimada (ronda 58). La demostración trae noches del anillo: se borra la de esta mañana y la app la estima; luego se corrige.

/** Borra de la base de la demostración las sesiones de sueño que acaban en las últimas 20 horas y recarga conservando lo demás. */
async function dropLastNight(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('smartring-demo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['sleep', 'syncs'], 'readwrite');
          const store = tx.objectStore('sleep');
          // Una sincronización de ahora que pidió el sueño y volvió vacío: sin ella la app no estima (el anillo aún podría darlo).
          tx.objectStore('syncs').put({ tsMs: Date.now() - 60_000, ringName: 'R99', firmware: null, batteryPercent: null, durationMs: 1, interrupted: false, outcomes: [{ type: 'sleep', status: 'empty', bytes: 0, ms: 5 }], added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 }, dropped: {}, liveSteps: null });
          const all = store.getAll();
          all.onsuccess = () => {
            const now = Date.now();
            for (const s of all.result as Array<{ startMs: number; endMs: number }>) if (s.endMs > now - 20 * 3_600_000) store.delete(s.startMs);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.goto('/?demo=keep');
}

test.describe('corregir las horas de una noche estimada', () => {
  test('el detalle del sueño ofrece corregirlas; se guardan como una noche normal marcada como puesta por la persona y la estimación no vuelve', async ({ page }) => {
    await openDemo(page);
    await dropLastNight(page);
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    // Con la hora de la demostración pasada de las 00:00 (la otra pasada de pruebas), hoy aún no tiene noche: la de esta mañana es la de ayer.
    const sleepButton = activePage(page).getByRole('button', { name: 'Ver el detalle del sueño' });
    if ((await sleepButton.count()) === 0) await page.getByRole('button', { name: 'Día anterior' }).click();
    await sleepButton.click();
    const sheet = page.getByRole('dialog', { name: 'Sueño', exact: true });
    await expect(sheet.getByText('la app la ha estimado')).toBeVisible();
    await sheet.getByRole('button', { name: 'Corregir las horas' }).click();
    await expect(sheet.getByLabel('Me acosté a las')).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0)).map((a) => a.finished.catch(() => undefined))));
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('dialog[open]').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await sheet.getByLabel('Me acosté a las').fill('23:15');
    await sheet.getByLabel('Me levanté a las').fill('09:40');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Hora de dormir corregida' })).toBeVisible();
    await expect(sheet.getByText('Las horas de esta noche las pusiste tú')).toBeVisible();
    await expect(sheet.getByText('la app la ha estimado')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Corregir las horas' }).click();
    await expect(sheet.getByLabel('Me acosté a las')).toHaveValue('23:15');
    await expect(sheet.getByLabel('Me levanté a las')).toHaveValue('09:40');
  });
});
