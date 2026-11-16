import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, openDemo, openUserSection, savedProfile, test } from './fixtures';

// El peso objetivo complementa al objetivo de salud en «Objetivos y medición»: el objetivo de salud es CÓMO come (perder, definir, mantener,
// ganar músculo o peso) y el peso objetivo, hasta dónde. Se comprueba que se puede fijar, cambiar y quitar; que avisa (y ofrece el cambio con un toque)
// cuando el objetivo de salud no lleva hasta ese peso; que el foco no se pierde al cambiar la pantalla; que se recuerda; y que sale en el menú de perfil
// y en el gráfico de peso de Salud (también en un móvil estrecho, sin pisar el título de la banda).

const evolution = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Evolución', exact: true });
const jointChart = (page: Page): Locator => evolution(page).getByRole('img', { name: /^Evolución entre el/ });
/** El gráfico conjunto entero: su dibujo y, si se desliza, la capa fija con los títulos y las referencias de cada banda. */
const jointPlot = (page: Page): Locator => evolution(page).locator('.plot').filter({ has: page.getByRole('img', { name: /^Evolución entre el/ }) });
const targetStepper = (goals: Locator): Locator => goals.getByRole('group', { name: 'Peso objetivo', exact: true });
const goalsRow = (page: Page): Locator => page.getByRole('dialog', { name: 'Mi perfil', exact: true }).getByRole('button', { name: /^Objetivos y medición/ });

/** El último peso de la demostración (el actual) y con él el que propone la app al fijar un peso objetivo al perder peso: 5 kg menos, redondeado. */
async function currentAndStart(page: Page): Promise<{ current: number; start: number }> {
  const entries = await savedProfile(page);
  const current = entries[entries.length - 1]?.weightKg ?? 0;
  return { current, start: Math.round(current - 5) };
}

const kg = (n: number): string => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n)} kg`;

test.describe('peso objetivo', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('sin peso objetivo hay un botón para fijarlo; fijarlo parte de un peso cercano y dice cuánto falta y cuánto tardaría', async ({ page }) => {
    const { current, start } = await currentAndStart(page);
    const goals = await openUserSection(page, 'Objetivos y medición');
    await expect(goals.getByRole('radiogroup', { name: 'Objetivo de salud' })).toBeVisible(); // el objetivo de salud sigue ahí: van juntos
    await expect(targetStepper(goals)).toHaveCount(0);
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();

    const stepper = targetStepper(goals);
    await expect(stepper.getByRole('status')).toHaveText(kg(start));
    // La demostración está en «Perder peso» y baja de peso: el peso objetivo cuadra con el objetivo de salud.
    await expect(goals).toContainText(new RegExp(`Te falta[n]? [\\d,]+\\skg para llegar a ${start}\\skg \\(tu último peso anotado: ${kg(current).replace(/\s/g, '\\s')}\\)`));
    await expect(goals).toContainText(/Comiendo lo que se te propone bajarías unos [\d,]+\skg a la semana: llegarías en unas \d+ semanas \(hacia [a-zé]+( de \d{4})?\)/);
    await expect(goals.getByRole('button', { name: /^Cambiar el objetivo de salud a/ })).toHaveCount(0);

    // Con los botones se sube y se baja de medio en medio.
    await goals.getByRole('button', { name: 'Bajar peso objetivo' }).click();
    await expect(stepper.getByRole('status')).toHaveText(kg(start - 0.5));
    await goals.getByRole('button', { name: 'Subir peso objetivo' }).click();
    await goals.getByRole('button', { name: 'Subir peso objetivo' }).click();
    await expect(stepper.getByRole('status')).toHaveText(kg(start + 0.5));
  });

  test('si el objetivo de salud no lleva a ese peso lo avisa y ofrece cambiarlo con un toque', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    await expect(goals).toContainText('Comiendo lo que se te propone bajarías');

    await goals.getByRole('radio', { name: /Mantener peso/ }).click();
    await expect(goals).toContainText('«Mantener peso» no te lleva a bajar esos kilos');
    await expect(goals).not.toContainText('Comiendo lo que se te propone'); // sin calorías que bajen no se promete una fecha por ellas
    await goals.getByRole('button', { name: 'Cambiar el objetivo de salud a «Perder peso»' }).click();
    await expect(goals.getByRole('radio', { name: /Perder peso/ })).toHaveAttribute('aria-checked', 'true');
    await expect(goals).not.toContainText('no te lleva a bajar esos kilos');
    await expect(goals).toContainText('Comiendo lo que se te propone bajarías');

    // Un peso por encima del actual con «Perder peso» choca al otro lado y se ofrece «Ganar peso».
    for (let i = 0; i < 14; i++) await goals.getByRole('button', { name: 'Subir peso objetivo' }).click(); // +7 kg: por encima del peso de hoy
    await expect(goals).toContainText('no te lleva a subir esos kilos');
    await goals.getByRole('button', { name: 'Cambiar el objetivo de salud a «Ganar peso»' }).click();
    await expect(goals.getByRole('radio', { name: /Ganar peso/ })).toHaveAttribute('aria-checked', 'true');
    await expect(goals).toContainText(/Comiendo lo que se te propone subirías unos [\d,]+\skg a la semana/);
  });

  test('el foco no se pierde cuando el botón pulsado desaparece: fijar, cambiar el objetivo de salud y quitar', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    await expect(goals.getByRole('button', { name: 'Bajar peso objetivo' })).toBeFocused();

    await goals.getByRole('radio', { name: /Mantener peso/ }).click();
    await goals.getByRole('button', { name: 'Cambiar el objetivo de salud a «Perder peso»' }).click();
    await expect(goals.getByRole('radio', { name: /Perder peso/ })).toBeFocused();

    await goals.getByRole('button', { name: 'Quitar el peso objetivo' }).click();
    await expect(goals.getByRole('button', { name: 'Fijar un peso objetivo' })).toBeFocused();
  });

  test('se recuerda al volver a abrir la app, sale en el menú de perfil y en el gráfico de peso de Salud, y se puede quitar', async ({ page }) => {
    const { start } = await currentAndStart(page);
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    await expect(targetStepper(goals).getByRole('status')).toHaveText(kg(start));
    await page.keyboard.press('Escape'); // vuelve al menú
    await expect(goalsRow(page)).toContainText(`Perder peso · ${kg(start)}`);
    await page.keyboard.press('Escape');

    // El gráfico de peso lleva el objetivo: una línea fina con su etiqueta dentro de la banda, y el nombre del gráfico lo dice.
    await goTab(page, 'Salud');
    const chart = jointChart(page);
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAccessibleName(new RegExp(`peso objetivo, ${start} kg`));
    const notes = await jointPlot(page).locator('text.jc__ref').allTextContents();
    expect(notes.some((t) => new RegExp(`^([↓↑] )?Objetivo ${start}$`).test(t)), notes.join(' | ')).toBe(true);
    // Y la etiqueta de la banda de peso lleva solo el cambio, como siempre: el objetivo va dentro del trazado, no junto al título.
    expect(notes.some((t) => t.includes('·')), notes.join(' | ')).toBe(false);

    // Se recuerda al reabrir (los datos de la demostración se conservan con ?demo=keep).
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    const again = await openUserSection(page, 'Objetivos y medición');
    await expect(targetStepper(again).getByRole('status')).toHaveText(kg(start));

    // Quitarlo deja la sección como estaba, sin tocar el objetivo de salud, y el menú sin su peso.
    await again.getByRole('button', { name: 'Quitar el peso objetivo' }).click();
    await expect(again.getByRole('button', { name: 'Fijar un peso objetivo' })).toBeVisible();
    await expect(again.getByRole('radio', { name: /Perder peso/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(goalsRow(page)).toContainText('Perder peso');
    await expect(goalsRow(page)).not.toContainText(kg(start));
  });

  test('en un móvil estrecho (360 px) la etiqueta del objetivo queda dentro del gráfico y no pisa ningún título', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const { start } = await currentAndStart(page);
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    await expect(targetStepper(goals).getByRole('status')).toHaveText(kg(start));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await goTab(page, 'Salud');
    const chart = jointChart(page);
    await expect(chart).toBeVisible();
    const label = chart.locator('text.jc__ref', { hasText: new RegExp(`Objetivo ${start}$`) });
    await expect(label).toHaveCount(1);
    await label.scrollIntoViewIfNeeded();
    const box = await label.boundingBox();
    const svg = await chart.boundingBox();
    expect(box && svg && box.x >= svg.x && box.x + box.width <= svg.x + svg.width, 'la etiqueta cabe dentro del gráfico').toBe(true);
    // Ningún texto de título o de referencia se solapa con ella.
    const others = jointPlot(page).locator('text.jc__title, text.jc__ref');
    const boxes = await others.evaluateAll((nodes) => nodes.map((n) => ({ text: n.textContent ?? '', r: n.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number } })));
    const mine = boxes.find((b) => new RegExp(`Objetivo ${start}$`).test(b.text));
    expect(mine).toBeTruthy();
    for (const other of boxes) {
      if (other === mine || !mine) continue;
      const overlapX = Math.min(mine.r.x + mine.r.width, other.r.x + other.r.width) - Math.max(mine.r.x, other.r.x);
      const overlapY = Math.min(mine.r.y + mine.r.height, other.r.y + other.r.height) - Math.max(mine.r.y, other.r.y);
      expect(overlapX > 0.5 && overlapY > 0.5, `«${other.text}» no debe pisar a «${mine.text}»`).toBe(false);
    }
  });

  test('el peso objetivo se guarda en los ajustes (los mismos que viajan en la copia de seguridad)', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    const { start } = await currentAndStart(page);
    await expect(targetStepper(goals).getByRole('status')).toHaveText(kg(start));
    const settings = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const request = db.transaction('kv').objectStore('kv').get('settings');
        request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return value;
    });
    expect(settings?.targetWeightKg).toBe(start);
    expect(settings?.healthGoal).toBe('lose');
  });

  test('en Salud, bajo el gráfico, el objetivo de peso se ve dibujado (falta, camino y tres plazos) y sin botones; sin peso objetivo remite al perfil', async ({ page }) => {
    await goTab(page, 'Salud');
    const block = evolution(page).getByRole('group', { name: 'Objetivo de peso', exact: true });
    await expect(block).toBeVisible();
    await expect(block).toContainText('Fija tu peso objetivo en el perfil');
    await expect(block.getByRole('button')).toHaveCount(0); // el peso objetivo solo se cambia en el menú de perfil

    // Se fija en «Objetivos y medición», en el menú de perfil.
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    const { current, start } = await currentAndStart(page);
    await expect(targetStepper(goals).getByRole('status')).toHaveText(kg(start));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await expect(block.getByRole('heading', { name: 'Objetivo de peso' })).toBeVisible();
    await expect(block.locator('.hero-goal__target')).toHaveText(kg(start));
    // Cuánto falta, en grande, y el peso de hoy.
    await expect(block.locator('.wg-missing')).toContainText(new RegExp(`${(current - start).toLocaleString('es-ES', { maximumFractionDigits: 1 }).replace('.', ',')}\\skg por bajar`));
    await expect(block.locator('.wg-missing')).toContainText(`ahora ${kg(current)}`);
    // El camino recorrido, como barra de progreso.
    const progress = block.getByRole('progressbar', { name: 'Camino hacia el peso objetivo' });
    await expect(progress).toBeVisible();
    const percent = Number(await progress.getAttribute('aria-valuenow'));
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
    // Tres tarjetas: el plan que se propone, lo que se come y el ritmo real; cada una con una cifra grande y como mucho dos líneas cortas.
    const cards = block.getByRole('list', { name: 'Cuándo llegarías' }).getByRole('listitem');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Tu plan');
    await expect(cards.nth(0)).toContainText(/\d+ sem/);
    await expect(cards.nth(0)).toContainText(/hacia [a-zé]{3}/);
    await expect(cards.nth(1)).toContainText('Lo comido');
    await expect(cards.nth(2)).toContainText('Ritmo real');
    // Casi sin texto corrido: nada de párrafos largos ni botones.
    await expect(block.getByRole('button')).toHaveCount(0);
    expect(((await block.innerText()).match(/\S+/g) ?? []).length, 'el bloque es sobre todo visual').toBeLessThan(60);
  });

  test('si el objetivo de salud no lleva al peso objetivo, el bloque de Salud avisa en una línea y no ofrece cambiarlo (se hace en el perfil)', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await goals.getByRole('button', { name: 'Fijar un peso objetivo' }).click();
    await goals.getByRole('radio', { name: /Mantener peso/ }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await goTab(page, 'Salud');
    const block = evolution(page).getByRole('group', { name: 'Objetivo de peso', exact: true });
    await expect(block.locator('.wg-warn')).toContainText('«Mantener peso» no apunta a tu peso objetivo: cámbialo en el perfil.');
    await expect(block.getByRole('list', { name: 'Cuándo llegarías' }).getByRole('listitem').first()).toContainText('No llega');
    await expect(block.getByRole('button')).toHaveCount(0);
  });
});
