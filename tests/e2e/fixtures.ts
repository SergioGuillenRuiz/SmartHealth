import { expect, test as base, type Locator, type Page } from '@playwright/test';

/**
 * Cualquier error de consola o excepción no capturada hace fallar la prueba: un 404 de un icono también.
 *
 * Con `FAKE_NOW=2027-01-01T00:20:00+01:00 npm run e2e` toda la suite corre con el reloj del navegador en esa fecha (el tiempo sigue
 * corriendo): sirve para cazar pruebas que dependen del día en que se ejecutan (principio de mes, de semana o de año, medianoche,
 * los días del cambio de hora). Sin la variable, no hace nada.
 */
export const test = base.extend<{ consoleErrors: string[]; allowedConsoleErrors: RegExp[] }>({
  /** Errores de consola que una prueba PROVOCA a propósito (p. ej. la respuesta 404 de un servidor simulado): no la hacen fallar. */
  allowedConsoleErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowedConsoleErrors }, use) => {
      if (process.env.FAKE_NOW) await page.clock.install({ time: new Date(process.env.FAKE_NOW) });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(`excepción: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`consola: ${message.text()}`);
      });
      await use(errors);
      expect(
        errors.filter((error) => !allowedConsoleErrors.some((allowed) => allowed.test(error))),
        'la app no debe dejar errores en la consola',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export type TabName = 'Resumen' | 'Deportes' | 'Salud';

export const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Secciones' });

/** La página (pestaña) activa. Las demás están `inert`, pero Playwright aún las ve al buscar por rol. */
export const activePage = (page: Page): Locator => page.locator('main.pager > section.page:not([inert])');

/** Abre la app en modo demostración (datos de ejemplo y anillo simulado) y espera al resumen. */
export async function openDemo(page: Page): Promise<void> {
  await page.goto('/?demo=1');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
}

export async function goTab(page: Page, name: TabName): Promise<void> {
  await nav(page).getByRole('button', { name }).click();
  await expect(nav(page).getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
}

/**
 * Retrocede un día y espera a que el Resumen enseñe los datos de ESE día: mientras cargan, la pantalla conserva los del
 * anterior (para no parpadear), y leerlos entonces daría cifras de otro día.
 */
export async function stepDayBack(page: Page): Promise<string> {
  const picker = page.locator('.daynav input[type="date"]');
  const before = await picker.inputValue();
  await page.getByRole('button', { name: 'Día anterior' }).click();
  await expect(picker).not.toHaveValue(before);
  const day = await picker.inputValue();
  await expect(activePage(page).locator(`[data-day="${day}"]`)).toHaveCount(1);
  return day;
}

/** Retrocede de día en día hasta uno con entrenamientos (la demostración los reparte cada pocos días) y devuelve su desglose. */
export async function goToDayWithWorkouts(page: Page): Promise<Locator> {
  const parts = page.getByRole('list', { name: 'Actividades del día' });
  for (let i = 0; i < 20 && (await parts.count()) === 0; i++) await stepDayBack(page);
  await expect(parts).toBeVisible();
  return parts;
}

/** Abre el detalle de un panel del Resumen con el botón de su esquina (la forma de teclado y de lector de pantalla). */
export async function openPanel(page: Page, panel: 'Sueño' | 'Ritmo cardiaco'): Promise<Locator> {
  const button: Record<typeof panel, string> = {
    Sueño: 'Ver el detalle del sueño',
    'Ritmo cardiaco': 'Ver el detalle del ritmo cardiaco',
  };
  await activePage(page).getByRole('button', { name: button[panel] }).click();
  const sheet = page.getByRole('dialog', { name: panel, exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

export type UserSection = 'Mis datos' | 'Objetivos y medición' | 'Mis productos' | 'Datos y copias de seguridad';

/**
 * Abre el menú de perfil (el botón de arriba a la izquierda) y uno de sus apartados; devuelve la hoja del apartado. Los datos personales («Mis datos») ya no son una fila aparte:
 * van en la hoja «Perfil y datos», que se abre con la tarjeta del perfil (foto, nombre y datos) de arriba del menú.
 */
export async function openUserSection(page: Page, name: UserSection): Promise<Locator> {
  await page.getByRole('button', { name: 'Mi perfil' }).click();
  const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
  if (name === 'Mis datos') {
    await menu.locator('.profile-card').click();
    const sheet = page.getByRole('dialog', { name: 'Perfil y datos', exact: true });
    await expect(sheet).toBeVisible();
    return sheet;
  }
  await menu.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  const section = page.getByRole('dialog', { name, exact: true });
  await expect(section).toBeVisible();
  return section;
}

export interface SavedProfileEntry {
  date: string;
  weightKg: number;
}

/** Las entradas de perfil que tiene guardadas la demostración (de la más antigua a la más reciente), leídas del almacén. */
export async function savedProfile(page: Page): Promise<SavedProfileEntry[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ date: string; weightKg: number }>>((resolve, reject) => {
      const request = db.transaction('profile').objectStore('profile').getAll();
      request.onsuccess = () => resolve(request.result as Array<{ date: string; weightKg: number }>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.map(({ date, weightKg }) => ({ date, weightKg })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  });
}

/**
 * Pone la sincronización que trae la demostración como hecha hace `hoursAgo` horas (contadas desde ahora, no desde cuando estaba) y
 * con esa batería, y reabre la app conservando los datos: el anillo queda como el de alguien que lleva días sin sincronizar y con
 * poca batería.
 */
export async function ageDemoSync(page: Page, { hoursAgo, batteryPercent }: { hoursAgo: number; batteryPercent: number }): Promise<void> {
  await page.evaluate(
    async ({ hoursAgo, batteryPercent }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('syncs', 'readwrite');
        const syncs = tx.objectStore('syncs');
        const rows = syncs.getAll();
        rows.onsuccess = () => {
          for (const row of rows.result as Array<{ tsMs: number }>) {
            syncs.delete(row.tsMs);
            syncs.put({ ...row, tsMs: Date.now() - hoursAgo * 3_600_000, batteryPercent });
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { hoursAgo, batteryPercent },
  );
  await page.goto('/?demo=keep');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
}

